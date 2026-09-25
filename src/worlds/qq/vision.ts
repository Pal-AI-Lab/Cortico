/**
 * QQ 图片视觉服务。
 * 每个图片 ID 保存被动描述缓存与追问会话；主动追问沿用被动识图上下文。
 * 被动失败以事件报告，主动失败由 `ask` 抛出并由模块包装。
 *
 * registry 与图片字节持久化到 `{dataDir}/vision/`。重启时恢复计数器、描述与
 * 图片字节；追问轮次不持久化，首次追问从已保存描述重建首轮上下文。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Logger, LLMUsage } from '../../core/types.ts';
import type { VLMClient, VLMMessage } from './vlm.ts';
import { downloadImageBytes, MIME_EXT } from './image-download.ts';
import { shortTime, nullLogger } from '../../core/util.ts';
import { VISION_DEFAULT_PROMPT } from './vision-prompt.ts';

/** 一张图的持久化记录(registry.jsonl一行) */
interface ImageRecord {
  id: string;
  url: string;
  /** 图片所在QQ消息的平台message_id(register时未知,attachMessage后填) */
  messageId?: string;
  /** 保存的字节文件名(相对 {dataDir}/vision/) */
  file?: string;
  mime?: string;
  /** GIF动图:VLM只看得到第一帧,事件里据此提醒主agent(完整GIF支持以后再做) */
  gif?: boolean;
  /** 被动识图描述(成功后填) */
  desc?: string;
  /** 失败简短原因(下载/识别失败后填) */
  failedReason?: string;
  /** 图片字节sha256(下载成功后填,用于内容去重) */
  hash?: string;
  /** 与本图内容相同(sha256一致)的更早图片ID——命中时desc是从它那沿用的,不重复跑VLM */
  dupOf?: string;
  ts: string;
}

/** 一张图的内存运行态 */
interface ImageState {
  record: ImageRecord;
  /** clear() 后置 false，阻止已经在途的下载/VLM回写已清空的缓存。 */
  active: boolean;
  /** 图字节的data URL(下载后内存缓存;重启后惰性从文件重建) */
  dataUrl?: string;
  /** VLM session:[user([图,defaultPrompt]), assistant(desc), user(追问), assistant(答), ...] */
  session: VLMMessage[];
  /** 被动识图的promise(在跑/已跑);ask需等它闭合再继承上下文 */
  passivePromise?: Promise<void>;
  /** ask串行化链(同图并发追问排队,保护session顺序) */
  chain: Promise<void>;
  /** 图片字节下载的in-flight promise(去重并发调用;失败后清空允许重试) */
  bytesPromise?: Promise<{ buffer: Uint8Array; mime: string }>;
  /** "下载+去重判定"这一步的in-flight/已完成promise(precheckDup与runPassive共用,只算一次) */
  resolvePromise?: Promise<ResolveResult>;
}

/** resolveContent 结果:done=true 表示重复内容或下载失败,不进入 VLM。 */
type ResolveResult = { done: true; ok: boolean } | { done: false };

/** 被动识图完成的回调:text=完整事件正文,meta进事件信封 */
type VisionEmit = (text: string, meta: Record<string, unknown>) => void;

/**
 * 自带模型的用量上报出口。 World 自带的 LLM 不经 core 的 usageLog,
 * 归账是**自愿**的——不接这个出口,这些 token 就不会出现在成本页里。
 */
type VisionUsageSink = (usage: LLMUsage, model: string) => void;

/** World 自带辅助 VLM 的配置;模型选择与缓存均由 World 拥有。 */
export interface VisionConfig {
  /** 总开关;true且OPENROUTER_API_KEY存在 → capabilities.auxVLM=true */
  enabled: boolean;
  /** OpenAI兼容API根地址(OpenRouter) */
  baseUrl: string;
  model: string;
  /** 被动识图的固定prompt */
  defaultPrompt: string;
  maxTokens: number;
  timeoutMs: number;
  /** 每张图主动会话的消息数上限(含首轮被动识图问答;超出丢最早的追问对) */
  sessionMaxMessages: number;
  /** 被动识图VLM请求并发上限 */
  concurrency: number;
  /** 图片下载字节上限 */
  maxImageBytes: number;
  /**
   * 消息渲染前,内容去重预判(下载+算hash+查是否与已识别过的图相同)愿意等待的上限。
   * 命中或下载在此时限内失败 → 结果直接内联进消息,不再走占位+异步qq.vision事件。
   * 超时(下载慢,或是需要真正跑VLM的新内容)→ 照常显示占位符,转交现有的被动识图
   * 异步路径(不受此值影响,仍用timeoutMs)。
   */
  dedupPrecheckMs: number;
}
export const VISION_DEFAULTS: VisionConfig = {
  enabled: false,
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'bytedance-seed/seed-2.0-mini',
  defaultPrompt: VISION_DEFAULT_PROMPT,
  maxTokens: 1024,
  timeoutMs: 60000,
  sessionMaxMessages: 24,
  concurrency: 3,
  maxImageBytes: 10485760,
  dedupPrecheckMs: 2500,
};

interface VisionServiceDeps {
  vlm: VLMClient;
  cfg: VisionConfig;
  dataDir: string;
  timezone: string;
  log?: Logger;
  fetchImpl?: typeof fetch;
}

export class VisionService {
  private readonly vlm: VLMClient;
  private readonly cfg: VisionConfig;
  private readonly timezone: string;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly visionDir: string;
  private readonly registryPath: string;

  private readonly states = new Map<string, ImageState>();
  private counter = 0;
  /** 内容hash → 该内容首个成功识别的图片ID(内容去重索引;重启后从registry重建) */
  private readonly hashIndex = new Map<string, string>();

  /** 自带模型的用量上报出口(World 挂载时由 world.ts 接到 host.reportUsage) */
  private usageSink?: VisionUsageSink;

  /** 被动识图并发信号量 */
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(deps: VisionServiceDeps) {
    this.vlm = deps.vlm;
    this.cfg = deps.cfg;
    this.timezone = deps.timezone;
    this.log = deps.log ?? nullLogger();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.visionDir = join(deps.dataDir, 'vision');
    this.registryPath = join(this.visionDir, 'registry.jsonl');
    if (!existsSync(this.visionDir)) mkdirSync(this.visionDir, { recursive: true });
    this.load();
  }


  /**
   * 分配 IMG-N 并登记；消息游标稍后回填。
   * `opts.gif` 是基于 URL 后缀的初值，下载后以实际 MIME 类型为准。
   */
  registerImage(url: string, opts?: { gif?: boolean }): string {
    const id = `IMG-${++this.counter}`;
    const record: ImageRecord = { id, url, ts: shortTime(this.timezone) };
    if (opts?.gif) record.gif = true;
    this.states.set(id, { record, active: true, session: [], chain: Promise.resolve() });
    // 未落消息号前只在内存;attachMessage后才持久化(避免崩溃留孤儿行)
    return id;
  }

  /** 图片所在消息落库后回填它的平台message_id */
  attachMessage(id: string, messageId: number | string | undefined): void {
    const st = this.states.get(id);
    if (!st) return;
    if (messageId !== undefined) st.record.messageId = String(messageId);
    this.persist(st.record);
  }

  /** 接上用量上报出口(World 挂载时调一次;不接就不归账) */
  setUsageSink(sink: VisionUsageSink): void {
    this.usageSink = sink;
  }

  private reportUsage(usage: LLMUsage): void {
    try {
      this.usageSink?.(usage, this.cfg.model);
    } catch {
      /* 归账失败不影响识图本身 */
    }
  }

  /** 是否认识这个图片ID(qq_view_image用) */
  hasImage(id: string): boolean {
    return this.states.has(id);
  }

  /**
   * 取某图的原始字节+mime+扩展名(已下载则读本地文件,否则现下载并落盘)。
   * 找不到该id返回null;下载失败抛错。
   */
  async getImageBytes(
    id: string,
  ): Promise<{ buffer: Uint8Array; mime: string; ext: string } | null> {
    const st = this.states.get(id);
    if (!st) return null;
    const { buffer, mime } = await this.ensureBytes(st);
    return { buffer, mime, ext: MIME_EXT[mime] ?? 'img' };
  }

  /** 按字节内容找已识别过的描述:同一份字节无论从哪来(收藏、重发)都对得上 */
  descriptionByHash(hash: string): string | undefined {
    const id = this.hashIndex.get(hash);
    return id ? this.states.get(id)?.record.desc : undefined;
  }

  /** 已登记图片数(web存储面板用) */
  imageCount(): number {
    return this.states.size;
  }

  /**
   * 清空视觉缓存(web运维动作):内存注册表+session+磁盘(registry与图片字节)
   * 删除全部记录并将 ID 计数器归零。历史消息中的旧 IMG-N 此后无法解析。
   * 返回清掉的图片数。
   */
  clear(): number {
    const n = this.states.size;
    for (const state of this.states.values()) state.active = false;
    this.states.clear();
    this.hashIndex.clear();
    this.counter = 0;
    try {
      rmSync(this.visionDir, { recursive: true, force: true });
    } catch {
      /* 删除失败不致命,下次写入覆盖 */
    }
    if (!existsSync(this.visionDir)) mkdirSync(this.visionDir, { recursive: true });
    this.log.warn('视觉缓存已清空', { cleared: n });
    return n;
  }

  /**
   * 启动被动识图(fire-and-forget,并发受cfg.concurrency限制)。
   * 幂等:同一id重复调用不会重复跑。完成时emit成功或失败事件——
   * 无论成败都必须emit,不让"载入中"悬空。
   */
  startPassive(id: string, emit: VisionEmit): void {
    const st = this.states.get(id);
    if (!st || st.passivePromise) return;
    st.passivePromise = this.runPassive(st, emit).catch((e) => {
      // 顶层消费异常，维持 fire-and-forget 契约。
      this.log.error('被动识图未捕获异常', { id, err: String(e) });
    });
  }

  /**
   * 消息渲染前的有时限"内容去重预判":只做下载+算hash+查重复,不碰VLM、
   * 不占VLM并发槽(下载不是要限流的资源)。deadlineMs 内查完 → 命中去重或下载
   * 失败均为终态,结果回填进record,供调用方直接内联进消息文字,不再走占位+
   * 异步qq.vision事件。deadlineMs内没查完(下载慢,或是需要真正跑VLM的新内容)
   * → 返回null,调用方照常展示占位符,之后startPassive复用这里已开始的下载,
   * 不会重新发起。
   */
  async precheckDup(
    id: string,
  ): Promise<{ text: string; meta: Record<string, unknown> } | null> {
    const st = this.states.get(id);
    if (!st) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.cfg.dedupPrecheckMs);
    });
    const raced = await Promise.race([this.resolveContent(st), timeout]);
    if (timer) clearTimeout(timer);
    if (!st.active) return null;
    if (raced === 'timeout' || !raced.done) return null;
    return raced.ok
      ? { text: this.dupText(st.record, st.record.dupOf!), meta: this.metaOf(st.record, true) }
      : { text: this.failText(st.record), meta: this.metaOf(st.record, false) };
  }

  /**
   * 主动追问:在该图的VLM session里继续对话。
   * - 被动尚未闭合 → 先等被动完成(继承其上下文)
   * - session 已有内容 → 追加一条 user 消息
   * - session为空(被动失败/重启后首问) → 基于持久化desc重建首轮,
   *   无desc则以[图,prompt]起新session
   * 同图并发调用经chain串行化。找不到图不由此处判断(module先查hasImage)。
   */
  ask(id: string, prompt: string): Promise<string> {
    const st = this.states.get(id);
    if (!st) return Promise.reject(new Error(`未知图片 ${id}`));
    const p = st.chain.then(() => this.doAsk(st, prompt));
    // chain 只维持串行顺序;结果与异常由 p 返回给调用方。
    st.chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }


  private async runPassive(st: ImageState, emit: VisionEmit): Promise<void> {
    await this.acquire();
    try {
      if (!st.active) return;
      const resolved = await this.resolveContent(st);
      if (!st.active) return;
      if (resolved.done) {
        emit(
          resolved.ok
            ? this.dupText(st.record, st.record.dupOf!)
            : this.failText(st.record),
          this.metaOf(st.record, resolved.ok),
        );
        return;
      }

      st.session = [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: st.dataUrl! } },
            { type: 'text', text: this.cfg.defaultPrompt },
          ],
        },
      ];
      try {
        const { text, usage } = await this.vlm.chat(st.session);
        this.reportUsage(usage);
        if (!st.active) return;
        st.session.push({ role: 'assistant', content: text });
        st.record.desc = text;
        this.persist(st.record);
        this.hashIndex.set(st.record.hash!, st.record.id);
        emit(this.okText(st.record, text), this.metaOf(st.record, true));
      } catch (e) {
        if (!st.active) return;
        // VLM失败:图字节已在(dataUrl/文件),但session无有效被动轮 → 清空,
        // 允许日后ask基于图片重起新session
        st.session = [];
        st.record.failedReason = this.shortReason(e, '识别失败');
        this.persist(st.record);
        emit(this.failText(st.record), this.metaOf(st.record, false));
      }
    } finally {
      this.release();
    }
  }

  /**
   * 下载、哈希和内容去重共享同一 Promise，不占用 VLM 并发槽。
   * done=true 表示重复或下载失败终态；done=false 表示 dataUrl 已就绪的新内容。
   */
  private resolveContent(st: ImageState): Promise<ResolveResult> {
    if (!st.resolvePromise) st.resolvePromise = this.doResolveContent(st);
    return st.resolvePromise;
  }

  private async doResolveContent(st: ImageState): Promise<ResolveResult> {
    let buffer: Uint8Array, mime: string;
    try {
      ({ buffer, mime } = await this.ensureBytes(st));
    } catch (e) {
      if (!st.active) return { done: true, ok: false };
      st.record.failedReason = this.shortReason(e, '下载失败');
      this.persist(st.record);
      return { done: true, ok: false };
    }
    // 下载响应的 MIME 覆盖渲染阶段基于后缀推断的 GIF 标记。
    st.record.gif = mime === 'image/gif';
    st.dataUrl = this.toDataUrl(buffer, mime);
    const hash = (st.record.hash = this.hashOf(buffer));

    // 内容去重:字节与之前某张成功识别过的图相同 → 沿用其描述,不再跑VLM、
    // 也不把描述正文重复一遍(事件/内联文字只指向那张图的ID)
    const dupId = this.hashIndex.get(hash);
    const dupRec = dupId ? this.states.get(dupId)?.record : undefined;
    if (dupId && dupId !== st.record.id && dupRec?.desc) {
      st.record.desc = dupRec.desc;
      st.record.dupOf = dupId;
      this.persist(st.record);
      return { done: true, ok: true };
    }
    return { done: false };
  }


  private async doAsk(st: ImageState, prompt: string): Promise<string> {
    if (st.passivePromise) {
      try {
        await st.passivePromise;
      } catch {
        /* 被动失败不阻断主动;下面按session状态重建 */
      }
    }
    if (!st.active) throw new Error(`图片 ${st.record.id} 已从缓存清除`);
    const dataUrl = await this.ensureDataUrl(st);
    if (!st.active) throw new Error(`图片 ${st.record.id} 已从缓存清除`);

    if (st.session.length === 0) {
      if (st.record.desc) {
        // 重启后首问:用持久化desc重建被动首轮,再接追问
        st.session.push({
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: this.cfg.defaultPrompt },
          ],
        });
        st.session.push({ role: 'assistant', content: st.record.desc });
        st.session.push({ role: 'user', content: prompt });
      } else {
        // 无被动描述(被动失败/从未跑) → 以[图,prompt]起新session
        st.session.push({
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: prompt },
          ],
        });
      }
    } else {
      st.session.push({ role: 'user', content: prompt });
    }

    // 发送前修剪:保证每次发给VLM的消息都不超上限(丢最早追问对,留带图首轮)
    this.trimSession(st);
    const { text, usage } = await this.vlm.chat(st.session);
    this.reportUsage(usage);
    if (!st.active) throw new Error(`图片 ${st.record.id} 已从缓存清除`);
    st.session.push({ role: 'assistant', content: text });
    return text;
  }

  /**
   * session超容量时丢最早的追问对,永远保留首轮(带图的user + 首个assistant)。
   * 首轮的user消息是唯一携带图片字节的消息,丢了模型就看不见图了。
   */
  private trimSession(st: ImageState): void {
    const max = this.cfg.sessionMaxMessages;
    if (st.session.length <= max) return;
    const head = st.session.slice(0, 2);
    let tail = st.session.slice(2);
    while (head.length + tail.length > max && tail.length >= 2) {
      tail = tail.slice(2);
    }
    st.session = [...head, ...tail];
  }


  /**
   * 解析图像的原始字节与 MIME;本地文件缺失时下载并落盘。失败抛错。
   * in-flight去重:并发调用(比如precheckDup超时后runPassive接手同一张图)
   * 共享同一次下载,不会各发一次网络请求;失败后清空,允许下次重试。
   */
  private ensureBytes(st: ImageState): Promise<{ buffer: Uint8Array; mime: string }> {
    if (!st.bytesPromise) {
      st.bytesPromise = this.doEnsureBytes(st).catch((e) => {
        st.bytesPromise = undefined;
        throw e;
      });
    }
    return st.bytesPromise;
  }

  private async doEnsureBytes(st: ImageState): Promise<{ buffer: Uint8Array; mime: string }> {
    if (!st.active) throw new Error(`图片 ${st.record.id} 已从缓存清除`);
    const rec = st.record;
    if (rec.file) {
      const path = join(this.visionDir, rec.file);
      if (existsSync(path)) {
        return { buffer: readFileSync(path), mime: rec.mime ?? 'image/jpeg' };
      }
    }
    // 没有本地文件(下载曾失败/被清理)→ 现从url取
    const { buffer, mime } = await this.download(rec.url);
    if (!st.active) throw new Error(`图片 ${st.record.id} 已从缓存清除`);
    const file = this.saveImage(rec.id, buffer, mime);
    rec.file = file;
    rec.mime = mime;
    this.persist(rec);
    return { buffer, mime };
  }

  /** 返回 VLM 请求使用的 data URL;缓存未命中时通过 ensureBytes 解析。 */
  private async ensureDataUrl(st: ImageState): Promise<string> {
    if (st.dataUrl) return st.dataUrl;
    const { buffer, mime } = await this.ensureBytes(st);
    st.dataUrl = this.toDataUrl(buffer, mime);
    return st.dataUrl;
  }

  private async download(url: string): Promise<{ buffer: Uint8Array; mime: string }> {
    return downloadImageBytes(url, this.cfg, this.fetchImpl);
  }

  private saveImage(id: string, buffer: Uint8Array, mime: string): string {
    const ext = MIME_EXT[mime] ?? 'img';
    const file = `${id}.${ext}`;
    writeFileSync(join(this.visionDir, file), buffer);
    return file;
  }

  private toDataUrl(buffer: Uint8Array, mime: string): string {
    return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
  }


  /** GIF提醒:VLM只看得到第一帧,附在描述前(完整GIF支持以后再做) */
  private gifNote(rec: ImageRecord): string {
    return rec.gif ? '(GIF; the vision model sees only the first frame)' : '';
  }

  private okText(rec: ImageRecord, desc: string): string {
    return `[${shortTime(this.timezone)}] [vision] ${rec.id}(re #${rec.messageId ?? '?'}): ${this.gifNote(rec)}${desc}`;
  }

  private failText(rec: ImageRecord): string {
    return `[${shortTime(this.timezone)}] [vision] ${rec.id}(re #${rec.messageId ?? '?'}): ${this.gifNote(rec)}recognition failed — ${rec.failedReason ?? 'unknown reason'}`;
  }

  /** 内容去重命中:不复述描述正文,只指向沿用的那张图,让主agent知道是同一张 */
  private dupText(rec: ImageRecord, dupOf: string): string {
    return `[${shortTime(this.timezone)}] [vision] ${rec.id}(re #${rec.messageId ?? '?'}): ${this.gifNote(rec)}same image as ${dupOf} (identical content, already recognized there — not re-run, see ${dupOf}'s description)`;
  }

  private metaOf(rec: ImageRecord, ok: boolean): Record<string, unknown> {
    return {
      image_id: rec.id,
      of_message_id: rec.messageId,
      ok,
      ...(rec.dupOf ? { dup_of: rec.dupOf } : {}),
    };
  }

  /** 图片字节的sha256(内容去重键) */
  private hashOf(buffer: Uint8Array): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private shortReason(e: unknown, fallback: string): string {
    const msg = e instanceof Error ? e.message : String(e);
    return msg && msg.length <= 60 ? msg : fallback;
  }


  private async acquire(): Promise<void> {
    if (this.running < this.cfg.concurrency) {
      this.running++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.running++;
  }

  private release(): void {
    this.running--;
    const w = this.waiters.shift();
    if (w) w();
  }


  private persist(rec: ImageRecord): void {
    try {
      appendFileSync(this.registryPath, JSON.stringify(rec) + '\n', 'utf8');
    } catch (e) {
      this.log.warn('vision registry写入失败', { err: String(e) });
    }
  }

  /** 启动时从registry.jsonl重建:同id最新覆盖旧的,计数器接续 */
  private load(): void {
    if (!existsSync(this.registryPath)) return;
    let content: string;
    try {
      content = readFileSync(this.registryPath, 'utf8');
    } catch {
      return;
    }
    let maxN = 0;
    for (const line of content.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let rec: ImageRecord;
      try {
        rec = JSON.parse(s) as ImageRecord;
      } catch {
        continue;
      }
      if (!rec.id) continue;
      this.states.set(rec.id, {
        record: rec,
        active: true,
        session: [],
        chain: Promise.resolve(),
      });
      const n = Number(rec.id.replace(/^IMG-/, ''));
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
    this.counter = maxN;
    // 内容去重索引重建:只收canonical记录(有desc且不是dup),按最终状态,与写入顺序无关
    for (const st of this.states.values()) {
      const rec = st.record;
      if (rec.hash && rec.desc && !rec.dupOf && !this.hashIndex.has(rec.hash)) {
        this.hashIndex.set(rec.hash, rec.id);
      }
    }
    this.log.debug('vision registry重建完成', { images: this.states.size, counter: this.counter });
  }
}
