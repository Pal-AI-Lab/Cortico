/**
 * 外挂视觉测试:VisionService直测(被动/主动/继承/失败/重启/并发) +
 * QQWorld接线(占位渲染、qq.vision异步事件、qq_view_image工具、降级与多模态门)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { LLMUsage, ToolCallContext } from '../../../src/core/types.ts';
import type { VLMClient, VLMMessage } from '../../../src/worlds/qq/vlm.ts';
import type { VisionConfig } from '../../../src/worlds/qq/vision.ts';
import { nullLogger } from '../../../src/core/util.ts';
import { VisionService } from '../../../src/worlds/qq/vision.ts';
import { MockOneBot } from '../../helpers/mock-onebot.ts';
import { QQWorld } from '../../../src/worlds/qq/world.ts';
import { FakeHost, waitUntil } from './helpers.ts';

const TZ = 'Asia/Shanghai';
const toolCtx: ToolCallContext = { role: 'main', log: nullLogger() };
const ZERO_USAGE: LLMUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
};

function visionCfg(over: Partial<VisionConfig> = {}): VisionConfig {
  return {
    enabled: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'test-vlm',
    defaultPrompt: '描述这张图',
    maxTokens: 512,
    timeoutMs: 5000,
    sessionMaxMessages: 24,
    concurrency: 3,
    maxImageBytes: 10_485_760,
    dedupPrecheckMs: 200,
    ...over,
  };
}

class FakeVLM implements VLMClient {
  calls: VLMMessage[][] = [];
  /** auto回应器(messages,callIndex)→文本或Error;null=manual模式 */
  auto: ((messages: VLMMessage[], i: number) => string | Error) | null = (_m, i) =>
    `描述#${i}`;
  private pending: Array<{
    resolve: (v: { text: string; usage: LLMUsage }) => void;
    reject: (e: unknown) => void;
  }> = [];

  chat(messages: VLMMessage[]): Promise<{ text: string; usage: LLMUsage }> {
    const i = this.calls.length;
    this.calls.push(structuredClone(messages));
    if (this.auto) {
      const r = this.auto(messages, i);
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve({ text: r, usage: ZERO_USAGE });
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve: (v) => resolve(v), reject });
    });
  }

  resolveNext(text: string): void {
    const p = this.pending.shift();
    if (!p) throw new Error('没有待决VLM调用');
    p.resolve({ text, usage: ZERO_USAGE });
  }

  rejectNext(err: unknown): void {
    const p = this.pending.shift();
    if (!p) throw new Error('没有待决VLM调用');
    p.reject(err);
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

/** 可控fetch:默认回一小段PNG字节;可切换成失败 */
function makeFetch(opts: { fail?: boolean; contentType?: string; bytes?: Uint8Array } = {}) {
  const bytes = opts.bytes ?? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const fn = async (): Promise<Response> => {
    if (opts.fail) throw new Error('下载失败(网络)');
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': opts.contentType ?? 'image/png' },
    });
  };
  return fn as unknown as typeof fetch;
}

/** 按url分发不同字节的fetch(测试"不同图内容互不去重"场景用) */
function makeFetchByUrl(bytesByUrl: Record<string, Uint8Array>) {
  const fn = async (url: string): Promise<Response> => {
    const bytes = bytesByUrl[url] ?? new Uint8Array([1]);
    return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  return fn as unknown as typeof fetch;
}

/** 手动放行的fetch:调用即挂起,resolveNext才返回——测"下载慢"场景用 */
function makeManualFetch() {
  let n = 0;
  const pending: Array<(res: Response) => void> = [];
  const fetchImpl = (async () => {
    n++;
    return new Promise<Response>((resolve) => pending.push(resolve));
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    callCount: () => n,
    resolveNext(bytes: Uint8Array, contentType = 'image/png') {
      const r = pending.shift();
      if (!r) throw new Error('没有待决fetch');
      r(new Response(bytes, { status: 200, headers: { 'content-type': contentType } }));
    },
  };
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'vision-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeService(vlm: VLMClient, dataDir: string, cfg = visionCfg()): VisionService {
  return new VisionService({
    vlm,
    cfg,
    dataDir,
    timezone: TZ,
    log: nullLogger(),
    fetchImpl: makeFetch(),
  });
}


describe('VisionService 被动识图', () => {
  it('成功:emit的正文含IMG-N/见#C/描述;session落被动首轮', async () => {
    const vlm = new FakeVLM();
    const svc = makeService(vlm, tmpDir());
    const id = svc.registerImage('http://img/1.png');
    expect(id).toBe('IMG-1');
    svc.attachMessage(id, 7);

    const emits: Array<{ text: string; meta: Record<string, unknown> }> = [];
    svc.startPassive(id, (text, meta) => emits.push({ text, meta }));
    await waitUntil(() => emits.length === 1, '被动完成emit');

    expect(emits[0].text).toMatch(/\[vision\] IMG-1\(re #7\): 描述#0/);
    expect(emits[0].meta).toEqual({ image_id: 'IMG-1', of_message_id: '7', ok: true });

    // 被动调VLM时,首条消息是[图, defaultPrompt]
    expect(vlm.calls).toHaveLength(1);
    const first = vlm.calls[0][0];
    expect(first.role).toBe('user');
    expect(Array.isArray(first.content)).toBe(true);
    const parts = first.content as Array<Record<string, unknown>>;
    expect(parts[0].type).toBe('image_url');
    expect(parts[1]).toEqual({ type: 'text', text: '描述这张图' });
  });

  it('VLM失败:emit识别失败事件,不让载入悬空', async () => {
    const vlm = new FakeVLM();
    vlm.auto = () => new Error('VLM挂了');
    const svc = makeService(vlm, tmpDir());
    const id = svc.registerImage('http://img/1.png');
    svc.attachMessage(id, 3);

    const emits: Array<{ text: string; meta: Record<string, unknown> }> = [];
    svc.startPassive(id, (t, m) => emits.push({ text: t, meta: m }));
    await waitUntil(() => emits.length === 1, '失败emit');

    expect(emits[0].text).toMatch(/\[vision\] IMG-1\(re #3\): recognition failed — /);
    expect(emits[0].meta.ok).toBe(false);
  });

  it('GIF(mime判定):事件提醒VLM只看得到第一帧,meta带gif', async () => {
    const vlm = new FakeVLM();
    const svc = new VisionService({
      vlm,
      cfg: visionCfg(),
      dataDir: tmpDir(),
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: makeFetch({ contentType: 'image/gif' }),
    });
    const id = svc.registerImage('http://img/anim'); // url无.gif后缀,靠mime认定
    svc.attachMessage(id, 8);
    const emits: Array<{ text: string; meta: Record<string, unknown> }> = [];
    svc.startPassive(id, (t, m) => emits.push({ text: t, meta: m }));
    await waitUntil(() => emits.length === 1, '被动完成');
    expect(emits[0].text).toContain('(GIF; the vision model sees only the first frame)');
  });

  it('非GIF(mime判定):覆盖渲染时的.gif误判', async () => {
    const vlm = new FakeVLM();
    const svc = new VisionService({
      vlm,
      cfg: visionCfg(),
      dataDir: tmpDir(),
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: makeFetch({ contentType: 'image/png' }),
    });
    // 渲染时误判成gif(比如url带.gif但实际是png),下载后应校正
    const id = svc.registerImage('http://img/fake.gif', { gif: true });
    svc.attachMessage(id, 1);
    const emits: Array<{ text: string; meta: Record<string, unknown> }> = [];
    svc.startPassive(id, (t, m) => emits.push({ text: t, meta: m }));
    await waitUntil(() => emits.length === 1, '被动完成');
    expect(emits[0].text).not.toContain('GIF');
  });

  it('下载失败:同样emit识别失败事件', async () => {
    const vlm = new FakeVLM();
    const svc = new VisionService({
      vlm,
      cfg: visionCfg(),
      dataDir: tmpDir(),
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: makeFetch({ fail: true }),
    });
    const id = svc.registerImage('http://img/x.png');
    svc.attachMessage(id, 5);
    const emits: string[] = [];
    svc.startPassive(id, (t) => emits.push(t));
    await waitUntil(() => emits.length === 1, '下载失败emit');
    expect(emits[0]).toContain('recognition failed — ');
    expect(vlm.calls).toHaveLength(0); // 没走到VLM
  });

  it('startPassive幂等:重复调用只跑一次', async () => {
    const vlm = new FakeVLM();
    const svc = makeService(vlm, tmpDir());
    const id = svc.registerImage('http://img/1.png');
    svc.attachMessage(id, 1);
    let count = 0;
    svc.startPassive(id, () => count++);
    svc.startPassive(id, () => count++);
    await waitUntil(() => count >= 1, '首次emit');
    await new Promise((r) => setTimeout(r, 30));
    expect(count).toBe(1);
    expect(vlm.calls).toHaveLength(1);
  });
});

describe('VisionService 内容去重(相同图片走缓存)', () => {
  it('字节相同(不同URL):第二张不再跑VLM,事件指向第一张,不复述描述正文', async () => {
    const vlm = new FakeVLM();
    vlm.auto = (_m, i) => `第${i}次识别的描述`;
    const svc = new VisionService({
      vlm,
      cfg: visionCfg(),
      dataDir: tmpDir(),
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: makeFetchByUrl({
        'http://img/1.png': new Uint8Array([9, 9, 9]),
        'http://img/1-repost.png': new Uint8Array([9, 9, 9]), // 内容与上面一致
      }),
    });
    const id1 = svc.registerImage('http://img/1.png');
    svc.attachMessage(id1, 1);
    const emits: Array<{ text: string; meta: Record<string, unknown> }> = [];
    svc.startPassive(id1, (text, meta) => emits.push({ text, meta }));
    await waitUntil(() => emits.length === 1, '第一张完成');
    expect(vlm.calls).toHaveLength(1);

    const id2 = svc.registerImage('http://img/1-repost.png');
    svc.attachMessage(id2, 2);
    svc.startPassive(id2, (text, meta) => emits.push({ text, meta }));
    await waitUntil(() => emits.length === 2, '第二张(去重)完成');

    // 没有第二次VLM调用
    expect(vlm.calls).toHaveLength(1);
    expect(emits[1].text).toMatch(/\[vision\] IMG-2\(re #2\): same image as IMG-1/);
    expect(emits[1].text).not.toContain('第0次识别的描述'); // 不重复输入描述正文
    expect(emits[1].meta).toEqual({ image_id: 'IMG-2', of_message_id: '2', ok: true, dup_of: 'IMG-1' });
    expect(svc.descriptionByHash(createHash('sha256').update(new Uint8Array([9, 9, 9])).digest('hex')))
      .toBe('第0次识别的描述');
  });

  it('字节不同:各自正常跑VLM,互不去重', async () => {
    const vlm = new FakeVLM();
    const svc = new VisionService({
      vlm,
      cfg: visionCfg(),
      dataDir: tmpDir(),
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: makeFetchByUrl({
        'http://img/a.png': new Uint8Array([1, 2, 3]),
        'http://img/b.png': new Uint8Array([4, 5, 6]),
      }),
    });
    const id1 = svc.registerImage('http://img/a.png');
    const id2 = svc.registerImage('http://img/b.png');
    svc.attachMessage(id1, 1);
    svc.attachMessage(id2, 2);
    const emits: Array<Record<string, unknown>> = [];
    svc.startPassive(id1, (_t, m) => emits.push(m));
    svc.startPassive(id2, (_t, m) => emits.push(m));
    await waitUntil(() => emits.length === 2, '两张各自完成');
    expect(vlm.calls).toHaveLength(2);
    expect(emits.every((m) => m.dup_of === undefined)).toBe(true);
  });

  it('第一张识别失败:未登记为canonical,内容相同的第二张仍正常跑VLM', async () => {
    const vlm = new FakeVLM();
    let n = 0;
    vlm.auto = () => (n++ === 0 ? new Error('VLM挂了') : '这次识别成功');
    const svc = new VisionService({
      vlm,
      cfg: visionCfg(),
      dataDir: tmpDir(),
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: makeFetchByUrl({
        'http://img/1.png': new Uint8Array([7, 7, 7]),
        'http://img/2.png': new Uint8Array([7, 7, 7]),
      }),
    });
    const id1 = svc.registerImage('http://img/1.png');
    const id2 = svc.registerImage('http://img/2.png');
    svc.attachMessage(id1, 1);
    svc.attachMessage(id2, 2);
    const emits: Array<Record<string, unknown>> = [];
    svc.startPassive(id1, (_t, m) => emits.push(m));
    await waitUntil(() => emits.length === 1, '第一张失败');
    expect(emits[0].ok).toBe(false);

    svc.startPassive(id2, (_t, m) => emits.push(m));
    await waitUntil(() => emits.length === 2, '第二张完成');
    expect(vlm.calls).toHaveLength(2); // 第一张失败不算canonical,第二张正常跑了VLM
    expect(emits[1].ok).toBe(true);
    expect(emits[1].dup_of).toBeUndefined();
  });

  it('去重后仍可qq_view_image追问(用自己的图字节+沿用的描述续session)', async () => {
    const vlm = new FakeVLM();
    vlm.auto = (_m, i) => (i === 0 ? '一只红色方块' : '追问答复');
    const svc = new VisionService({
      vlm,
      cfg: visionCfg(),
      dataDir: tmpDir(),
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: makeFetchByUrl({
        'http://img/1.png': new Uint8Array([3, 3, 3]),
        'http://img/2.png': new Uint8Array([3, 3, 3]),
      }),
    });
    const id1 = svc.registerImage('http://img/1.png');
    svc.attachMessage(id1, 1);
    svc.startPassive(id1, () => {});
    await waitUntil(() => vlm.calls.length === 1, '第一张完成');

    const id2 = svc.registerImage('http://img/2.png');
    svc.attachMessage(id2, 2);
    const emits: Array<Record<string, unknown>> = [];
    svc.startPassive(id2, (_t, m) => emits.push(m));
    await waitUntil(() => emits.length === 1, '第二张去重完成');
    expect(emits[0].dup_of).toBe('IMG-1');

    const ans = await svc.ask(id2, '看清楚点');
    expect(ans).toBe('追问答复');
    expect(vlm.calls).toHaveLength(2); // 被动只有IMG-1那1次,追问是第2次
    const askCall = vlm.calls[1];
    expect(askCall[1]).toEqual({ role: 'assistant', content: '一只红色方块' }); // 沿用的描述
    expect(askCall[2]).toEqual({ role: 'user', content: '看清楚点' });
  });

  it('重启后:去重索引从registry重建,新实例里内容相同仍不重跑VLM', async () => {
    const dir = tmpDir();
    const vlm1 = new FakeVLM();
    vlm1.auto = () => '持久化的描述';
    const svc1 = new VisionService({
      vlm: vlm1,
      cfg: visionCfg(),
      dataDir: dir,
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: makeFetchByUrl({ 'http://img/1.png': new Uint8Array([2, 4, 6]) }),
    });
    const id1 = svc1.registerImage('http://img/1.png');
    svc1.attachMessage(id1, 1);
    svc1.startPassive(id1, () => {});
    await waitUntil(() => vlm1.calls.length === 1, '重启前完成');

    const vlm2 = new FakeVLM();
    const svc2 = new VisionService({
      vlm: vlm2,
      cfg: visionCfg(),
      dataDir: dir,
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: makeFetchByUrl({ 'http://img/2.png': new Uint8Array([2, 4, 6]) }),
    });
    const id2 = svc2.registerImage('http://img/2.png');
    expect(id2).toBe('IMG-2');
    svc2.attachMessage(id2, 2);
    const emits: Array<Record<string, unknown>> = [];
    svc2.startPassive(id2, (_t, m) => emits.push(m));
    await waitUntil(() => emits.length === 1, '重启后去重完成');
    expect(vlm2.calls).toHaveLength(0); // 没跑新实例的VLM
    expect(emits[0].dup_of).toBe('IMG-1');
    expect(svc2.descriptionByHash(createHash('sha256').update(new Uint8Array([2, 4, 6])).digest('hex')))
      .toBe('持久化的描述');
  });
});

describe('VisionService.precheckDup(消息渲染前的有时限去重预判)', () => {
  it('命中去重:直接返回内联结果,不用等到deadline也不跑VLM', async () => {
    const vlm = new FakeVLM();
    const svc = new VisionService({
      vlm,
      cfg: visionCfg({ dedupPrecheckMs: 5000 }), // 故意设很长,验证不需要等到期
      dataDir: tmpDir(),
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: makeFetchByUrl({
        'http://img/1.png': new Uint8Array([1, 1, 1]),
        'http://img/2.png': new Uint8Array([1, 1, 1]),
      }),
    });
    const id1 = svc.registerImage('http://img/1.png');
    svc.attachMessage(id1, 1);
    svc.startPassive(id1, () => {});
    await waitUntil(() => vlm.calls.length === 1, '第一张完成');

    const id2 = svc.registerImage('http://img/2.png');
    svc.attachMessage(id2, 2);
    const result = await svc.precheckDup(id2);
    expect(result).not.toBeNull();
    expect(result!.meta.dup_of).toBe('IMG-1');
    expect(result!.text).toMatch(/same image as IMG-1/);
    expect(vlm.calls).toHaveLength(1); // 没有第二次VLM调用
  });

  it('下载在deadline内失败:也直接返回失败结果', async () => {
    const vlm = new FakeVLM();
    const svc = new VisionService({
      vlm,
      cfg: visionCfg(),
      dataDir: tmpDir(),
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: makeFetch({ fail: true }),
    });
    const id = svc.registerImage('http://img/bad.png');
    svc.attachMessage(id, 1);
    const result = await svc.precheckDup(id);
    expect(result).not.toBeNull();
    expect(result!.meta.ok).toBe(false);
    expect(result!.text).toContain('recognition failed');
  });

  it('全新内容(非重复):即使下载完成得很快也返回null,不碰VLM,交给正常异步路径', async () => {
    const vlm = new FakeVLM();
    const svc = makeService(vlm, tmpDir());
    const id = svc.registerImage('http://img/new.png');
    svc.attachMessage(id, 1);
    const result = await svc.precheckDup(id);
    expect(result).toBeNull();
    expect(vlm.calls).toHaveLength(0);

    const emits: Array<Record<string, unknown>> = [];
    svc.startPassive(id, (_t, m) => emits.push(m));
    await waitUntil(() => emits.length === 1, '正常识别完成');
    expect(vlm.calls).toHaveLength(1);
    expect(emits[0].ok).toBe(true);
  });

  it('下载慢:达到deadline就返回null不挂住;之后startPassive复用同一次下载(不重复下载)', async () => {
    const vlm = new FakeVLM();
    vlm.auto = () => '识别结果';
    const manual = makeManualFetch();
    const svc = new VisionService({
      vlm,
      cfg: visionCfg({ dedupPrecheckMs: 20 }),
      dataDir: tmpDir(),
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: manual.fetchImpl,
    });
    const id = svc.registerImage('http://img/slow.png');
    svc.attachMessage(id, 1);

    const result = await svc.precheckDup(id);
    expect(result).toBeNull(); // 20ms内下载还没完成
    expect(manual.callCount()).toBe(1); // 已经发起了下载

    const emits: Array<Record<string, unknown>> = [];
    svc.startPassive(id, (_t, m) => emits.push(m));
    manual.resolveNext(new Uint8Array([1, 2, 3])); // 放行下载
    await waitUntil(() => emits.length === 1, '下载完成后识别完成');
    expect(manual.callCount()).toBe(1); // 全程只下载了一次(precheck的下载被复用)
    expect(vlm.calls).toHaveLength(1);
    expect(emits[0].ok).toBe(true);
  });
});

describe('VisionService 主动追问(view session继承)', () => {
  it('被动闭合后追问:第二次VLM看到[图,defaultPrompt]+被动desc+追问', async () => {
    const vlm = new FakeVLM();
    vlm.auto = (_m, i) => (i === 0 ? '一张红色方块' : '主要是红色');
    const svc = makeService(vlm, tmpDir());
    const id = svc.registerImage('http://img/1.png');
    svc.attachMessage(id, 2);
    svc.startPassive(id, () => {});
    await waitUntil(() => vlm.calls.length === 1, '被动完成');

    const ans = await svc.ask(id, '图里主要颜色是什么?');
    expect(ans).toBe('主要是红色');
    expect(vlm.calls).toHaveLength(2);

    const second = vlm.calls[1];
    expect(second).toHaveLength(3);
    expect(second[0].role).toBe('user'); // [图, defaultPrompt]
    expect(Array.isArray(second[0].content)).toBe(true);
    expect(second[1]).toEqual({ role: 'assistant', content: '一张红色方块' });
    expect(second[2]).toEqual({ role: 'user', content: '图里主要颜色是什么?' });

    // 后续追问继续扩展同一 session。
    const ans2 = await svc.ask(id, '有文字吗?');
    expect(vlm.calls).toHaveLength(3);
    expect(vlm.calls[2]).toHaveLength(5);
    expect(vlm.calls[2][4]).toEqual({ role: 'user', content: '有文字吗?' });
    expect(ans2).toBe('主要是红色'); // auto对i≥1恒返回此句
  });

  it('被动未闭合时追问:先等被动完成再继承上下文', async () => {
    const vlm = new FakeVLM();
    vlm.auto = null; // manual
    const svc = makeService(vlm, tmpDir());
    const id = svc.registerImage('http://img/1.png');
    svc.attachMessage(id, 9);
    svc.startPassive(id, () => {});
    await waitUntil(() => vlm.pendingCount === 1, '被动VLM在途');

    // 被动还没闭合就追问
    let answered = false;
    const askP = svc.ask(id, '看清楚点').then((a) => {
      answered = true;
      return a;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(answered).toBe(false); // 在等被动
    expect(vlm.pendingCount).toBe(1); // 还没发出追问

    vlm.resolveNext('被动描述'); // 被动闭合
    await waitUntil(() => vlm.pendingCount === 1, '追问VLM发出');
    vlm.resolveNext('追问答复');
    expect(await askP).toBe('追问答复');
    expect(answered).toBe(true);

    // 追问看到了被动上下文
    const askCall = vlm.calls[1];
    expect(askCall[1]).toEqual({ role: 'assistant', content: '被动描述' });
    expect(askCall[2]).toEqual({ role: 'user', content: '看清楚点' });
  });

  it('被动失败后追问:以[图,prompt]起新session(无被动desc)', async () => {
    const vlm = new FakeVLM();
    let n = 0;
    vlm.auto = () => (n++ === 0 ? new Error('被动失败') : '主动看清了');
    const svc = makeService(vlm, tmpDir());
    const id = svc.registerImage('http://img/1.png');
    svc.attachMessage(id, 4);
    svc.startPassive(id, () => {});
    await waitUntil(() => vlm.calls.length === 1, '被动失败');

    const ans = await svc.ask(id, '这是什么');
    expect(ans).toBe('主动看清了');
    const askCall = vlm.calls[1];
    expect(askCall).toHaveLength(1); // 新session:只有[图,prompt]一条
    const parts = askCall[0].content as Array<Record<string, unknown>>;
    expect(parts[0].type).toBe('image_url');
    expect(parts[1]).toEqual({ type: 'text', text: '这是什么' });
  });

  it('同图并发追问被串行化(session顺序不乱)', async () => {
    const vlm = new FakeVLM();
    vlm.auto = (_m, i) => `答${i}`;
    const svc = makeService(vlm, tmpDir());
    const id = svc.registerImage('http://img/1.png');
    svc.attachMessage(id, 1);
    svc.startPassive(id, () => {});
    await waitUntil(() => vlm.calls.length === 1, '被动完成');

    const [a, b] = await Promise.all([svc.ask(id, 'Q1'), svc.ask(id, 'Q2')]);
    expect(vlm.calls).toHaveLength(3);
    // 第二个追问必须看到第一个追问的问答(串行)
    const secondAsk = vlm.calls[2];
    expect(secondAsk.some((m) => m.role === 'user' && m.content === 'Q1')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('VisionService session容量修剪', () => {
  it('超上限丢最早追问对,永远保留带图首轮', async () => {
    const vlm = new FakeVLM();
    vlm.auto = (_m, i) => `a${i}`;
    // 上限6:首轮2条 + 最多2对追问
    const svc = makeService(vlm, tmpDir(), visionCfg({ sessionMaxMessages: 6 }));
    const id = svc.registerImage('http://img/1.png');
    svc.attachMessage(id, 1);
    svc.startPassive(id, () => {});
    await waitUntil(() => vlm.calls.length === 1, '被动完成');

    await svc.ask(id, 'Q1');
    await svc.ask(id, 'Q2');
    await svc.ask(id, 'Q3'); // 触发修剪
    const lastCall = vlm.calls[vlm.calls.length - 1];
    // 首条仍是带图user
    expect(Array.isArray(lastCall[0].content)).toBe(true);
    const parts = lastCall[0].content as Array<Record<string, unknown>>;
    expect(parts[0].type).toBe('image_url');
    // 最早的Q1应已被修掉
    const hasQ1 = lastCall.some((m) => m.content === 'Q1');
    expect(hasQ1).toBe(false);
  });
});

describe('VisionService 持久化与重启重建', () => {
  it('同dataDir新实例:计数器接续、qq_view_image基于持久化desc可用', async () => {
    const dir = tmpDir();
    const vlm1 = new FakeVLM();
    vlm1.auto = () => '持久描述';
    const svc1 = makeService(vlm1, dir);
    const id = svc1.registerImage('http://img/1.png');
    svc1.attachMessage(id, 11);
    svc1.startPassive(id, () => {});
    await waitUntil(() => vlm1.calls.length === 1, '被动落库');

    // 新实例(模拟重启):同dataDir
    const vlm2 = new FakeVLM();
    vlm2.auto = () => '重启后主动答复';
    const svc2 = makeService(vlm2, dir);
    expect(svc2.hasImage('IMG-1')).toBe(true);
    // 计数器接续:新登记从IMG-2起
    expect(svc2.registerImage('http://img/2.png')).toBe('IMG-2');

    // 基于持久化desc重建首轮再追问
    const ans = await svc2.ask('IMG-1', '还记得吗');
    expect(ans).toBe('重启后主动答复');
    const askCall = vlm2.calls[0];
    expect(askCall[0].role).toBe('user'); // 重建的[图,defaultPrompt]
    expect(askCall[1]).toEqual({ role: 'assistant', content: '持久描述' });
    expect(askCall[2]).toEqual({ role: 'user', content: '还记得吗' });
  });

  it('图片字节落盘到 vision/ 目录', async () => {
    const dir = tmpDir();
    const vlm = new FakeVLM();
    const svc = makeService(vlm, dir);
    const id = svc.registerImage('http://img/1.png');
    svc.attachMessage(id, 1);
    svc.startPassive(id, () => {});
    await waitUntil(() => vlm.calls.length === 1, '被动完成');
    const files = readdirSync(join(dir, 'vision'));
    expect(files.some((f) => f.startsWith('IMG-1.'))).toBe(true);
    expect(existsSync(join(dir, 'vision', 'registry.jsonl'))).toBe(true);
  });
});

describe('VisionService 清空与在途任务', () => {
  it('clear后在途下载不回写旧IMG-N，也不影响复用后的同名ID', async () => {
    const manual = makeManualFetch();
    const vlm = new FakeVLM();
    const dir = tmpDir();
    const svc = new VisionService({
      vlm,
      cfg: visionCfg(),
      dataDir: dir,
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: manual.fetchImpl,
    });
    const staleEmits: string[] = [];
    const oldId = svc.registerImage('http://img/old.png');
    svc.attachMessage(oldId, 1);
    svc.startPassive(oldId, (text) => staleEmits.push(text));
    await waitUntil(() => manual.callCount() === 1, '旧图开始下载');

    expect(svc.clear()).toBe(1);
    const freshId = svc.registerImage('http://img/fresh.png');
    svc.attachMessage(freshId, 2);
    expect(freshId).toBe('IMG-1');

    manual.resolveNext(new Uint8Array([1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(staleEmits).toEqual([]);
    expect(readdirSync(join(dir, 'vision'))).not.toContain('IMG-1.png');

    const freshEmits: string[] = [];
    svc.startPassive(freshId, (text) => freshEmits.push(text));
    await waitUntil(() => manual.callCount() === 2, '新图开始下载');
    manual.resolveNext(new Uint8Array([4, 5, 6]));
    await waitUntil(() => freshEmits.length === 1, '新图识别完成');
    expect(freshEmits[0]).toContain('IMG-1');
  });

  it('clear后在途VLM结果不会再产生视觉事件', async () => {
    const vlm = new FakeVLM();
    vlm.auto = null;
    const svc = makeService(vlm, tmpDir());
    const emits: string[] = [];
    const id = svc.registerImage('http://img/1.png');
    svc.attachMessage(id, 1);
    svc.startPassive(id, (text) => emits.push(text));
    await waitUntil(() => vlm.pendingCount === 1, 'VLM请求已发出');

    svc.clear();
    vlm.resolveNext('过期描述');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(emits).toEqual([]);
    expect(svc.hasImage(id)).toBe(false);
  });
});

describe('VisionService 并发上限', () => {
  it('concurrency=1时被动任务串行(第二个等第一个)', async () => {
    const vlm = new FakeVLM();
    vlm.auto = null; // manual
    // 两张图内容不同,避免去重让第二张跳过VLM,干扰并发串行的测试目标
    const svc = new VisionService({
      vlm,
      cfg: visionCfg({ concurrency: 1 }),
      dataDir: tmpDir(),
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: makeFetchByUrl({
        'http://img/1.png': new Uint8Array([1, 2, 3, 4]),
        'http://img/2.png': new Uint8Array([5, 6, 7, 8, 9]),
      }),
    });
    const id1 = svc.registerImage('http://img/1.png');
    const id2 = svc.registerImage('http://img/2.png');
    svc.attachMessage(id1, 1);
    svc.attachMessage(id2, 2);
    svc.startPassive(id1, () => {});
    svc.startPassive(id2, () => {});

    await waitUntil(() => vlm.pendingCount === 1, '第一个占用唯一槽');
    await new Promise((r) => setTimeout(r, 30));
    expect(vlm.calls).toHaveLength(1); // 第二个还没轮到

    vlm.resolveNext('图1描述'); // 第一个完成,释放槽
    await waitUntil(() => vlm.calls.length === 2, '第二个接棒');
    vlm.resolveNext('图2描述');
  });
});


describe('QQWorld 外挂视觉接线', () => {
  const GROUP = 424242;
  const SELF = 5000;
  let mock: MockOneBot;
  let host: FakeHost;
  let mod: QQWorld;
  let vlm: FakeVLM;
  let svc: VisionService;

  async function startWith(opts: {
    withVision: boolean;
    multimodal?: boolean;
    autoDesc?: string;
    fetchImpl?: typeof fetch;
    visionCfgOverride?: Partial<VisionConfig>;
  }): Promise<void> {
    mock = new MockOneBot({
      port: 0,
      groupId: GROUP,
      selfId: SELF,
      selfNickname: 'bot',
      selfCard: 'botcard',
      groupName: '深夜食堂',
    });
    const port = await mock.start();
    host = new FakeHost(tmpDir());
    if (opts.multimodal) {
      host.modelFacts = { model: () => 'fake-vlm', accepts: () => true, contextWindow: () => undefined };
    }
    vlm = new FakeVLM();
    if (opts.autoDesc) vlm.auto = () => opts.autoDesc!;
    svc = new VisionService({
      vlm,
      cfg: visionCfg(opts.visionCfgOverride),
      dataDir: tmpDir(),
      timezone: TZ,
      log: nullLogger(),
      fetchImpl: opts.fetchImpl ?? makeFetch(),
    });
    mod = new QQWorld(
      { wsUrl: `ws://127.0.0.1:${port}`, groups: [GROUP], privates: [], token: '' },
      opts.withVision ? { vision: svc } : undefined,
    );
    await mod.start(host);
    await mod.waitReady();
  }

  afterEach(async () => {
    await mod?.stop();
    await mock?.close();
  });

  function imageSeg(url: string) {
    return { type: 'image', data: { url, file: 'x.png' } };
  }

  function jsonCardSeg(prompt: string, previewUrl?: string) {
    return {
      type: 'json',
      data: {
        data: JSON.stringify({
          prompt,
          ...(previewUrl ? { meta: { detail_1: { preview: previewUrl } } } : {}),
        }),
      },
    };
  }

  it('被动开启:占位含IMG-N+载入中;VLM闭合后到达qq.vision事件', async () => {
    await startWith({ withVision: true, autoDesc: '一只猫' });
    mock.emitGroupMessage({
      user_id: 1001,
      nickname: '阿明',
      segments: [imageSeg('http://img/cat.png'), { type: 'text', data: { text: '看这个' } }],
    });
    await waitUntil(() => host.pushed.length >= 1, '消息入库');

    const msgEvent = host.pushed[0].event;
    expect(msgEvent.type).toBe('qq.message');
    expect(msgEvent.text).toContain('[图片 IMG-1 正在载入VLM理解中...]');
    expect(msgEvent.text).toContain('看这个');

    // 异步qq.vision事件延迟到达
    await waitUntil(
      () => host.pushed.some((p) => p.event.type === 'qq.vision'),
      'qq.vision到达',
    );
    const vis = host.pushed.find((p) => p.event.type === 'qq.vision')!;
    // (re #<message_id>):视觉事件指向它所属的那条QQ消息
    expect(vis.event.text).toContain(`IMG-1(re #${msgEvent.meta?.message_id}): 一只猫`);
    expect(vis.event.meta?.image_id).toBe('IMG-1');
    expect(vis.opts?.trigger ?? 'debounce').toBe('debounce');
  });

  it('json卡片:封面图接入外挂视觉——占位含prompt+IMG-N+载入中;VLM闭合后到达qq.vision事件', async () => {
    await startWith({ withVision: true, autoDesc: '游戏宣传图' });
    mock.emitGroupMessage({
      user_id: 1001,
      nickname: '阿明',
      segments: [jsonCardSeg('[分享]《怪物猎人荒野》宣传片', 'http://img/cover.png')],
    });
    await waitUntil(() => host.pushed.length >= 1, '消息入库');

    const msgEvent = host.pushed[0].event;
    expect(msgEvent.text).toContain('[分享:[分享]《怪物猎人荒野》宣传片]');
    expect(msgEvent.text).toContain('[封面 IMG-1 正在载入VLM理解中...]');

    await waitUntil(
      () => host.pushed.some((p) => p.event.type === 'qq.vision'),
      'qq.vision到达',
    );
    const vis = host.pushed.find((p) => p.event.type === 'qq.vision')!;
    expect(vis.event.text).toContain(`IMG-1(re #${msgEvent.meta?.message_id}): 游戏宣传图`);
  });

  it('json卡片:无封面图字段时只有prompt,不注册图片', async () => {
    await startWith({ withVision: true });
    mock.emitGroupMessage({
      user_id: 1001,
      segments: [jsonCardSeg('[分享]纯文字卡片')],
    });
    await waitUntil(() => host.pushed.length >= 1, '消息入库');

    const msgEvent = host.pushed[0].event;
    expect(msgEvent.text).toContain('[分享:[分享]纯文字卡片]');
    expect(msgEvent.text).not.toContain('封面');
  });

  it('内容去重预判命中:消息本身直接内联"同一张图",不出现loading占位,也不产生额外qq.vision事件', async () => {
    await startWith({
      withVision: true,
      fetchImpl: makeFetchByUrl({
        'http://img/cat.png': new Uint8Array([9, 9, 9]),
        'http://img/cat-repost.png': new Uint8Array([9, 9, 9]),
      }),
    });
    mock.emitGroupMessage({ user_id: 1001, segments: [imageSeg('http://img/cat.png')] });
    await waitUntil(
      () => host.pushed.some((p) => p.event.type === 'qq.vision'),
      '第一张被动完成',
    );

    mock.emitGroupMessage({ user_id: 1002, segments: [imageSeg('http://img/cat-repost.png')] });
    await waitUntil(
      () => host.pushed.filter((p) => p.event.type === 'qq.message').length === 2,
      '第二条消息入库',
    );

    const secondMsg = host.pushed.filter((p) => p.event.type === 'qq.message')[1].event;
    expect(secondMsg.text).toContain('IMG-2');
    expect(secondMsg.text).toContain('与 IMG-1 是同一张图');
    expect(secondMsg.text).not.toContain('正在载入');

    // 已经内联进消息本身,不会再走占位+异步事件那一套
    await new Promise((r) => setTimeout(r, 50));
    expect(host.pushed.filter((p) => p.event.type === 'qq.vision')).toHaveLength(1);
  });

  it('消息处理严格按到达顺序(即使前一条图片的去重预判还在等待下载)', async () => {
    const manual = makeManualFetch();
    await startWith({
      withVision: true,
      fetchImpl: manual.fetchImpl,
      visionCfgOverride: { dedupPrecheckMs: 20 },
    });

    mock.emitGroupMessage({ user_id: 1001, segments: [imageSeg('http://img/slow.png')] });
    mock.emitGroupMessage({
      user_id: 1002,
      segments: [{ type: 'text', data: { text: '第二条' } }],
    });

    await waitUntil(
      () => host.pushed.filter((p) => p.event.type === 'qq.message').length >= 2,
      '两条消息都入库',
    );
    const msgs = host.pushed.filter((p) => p.event.type === 'qq.message');
    expect(msgs[0].event.text).toContain('IMG-1'); // 带图的第一条确实排在前面
    expect(msgs[1].event.text).toContain('第二条'); // 没有因为precheck等待而被抢先落库

    manual.resolveNext(new Uint8Array([1])); // 放行下载,避免悬挂
    await waitUntil(
      () => host.pushed.some((p) => p.event.type === 'qq.vision'),
      '悬挂的识别最终收尾',
    );
  });

  it('qq_view_image:继承被动描述,在同一session追问', async () => {
    await startWith({ withVision: true, autoDesc: '一只黑猫' });
    mock.emitGroupMessage({
      user_id: 1001,
      nickname: '阿明',
      segments: [imageSeg('http://img/cat.png')],
    });
    await waitUntil(
      () => host.pushed.some((p) => p.event.type === 'qq.vision'),
      '被动完成',
    );

    vlm.auto = () => '猫是黑色的';
    const view = mod.tools().find((t) => t.name === 'qq_view_image')!;
    expect(view).toBeDefined();
    const res = await view.handler({ image_id: 'IMG-1', prompt: '猫什么颜色' }, toolCtx);
    expect(res).toBe('猫是黑色的');
    // 最后一次VLM调用继承了被动描述
    const lastCall = vlm.calls[vlm.calls.length - 1];
    expect(lastCall.some((m) => m.role === 'assistant' && m.content === '一只黑猫')).toBe(true);
  });

  it('GIF消息(.gif后缀):占位带(GIF·仅首帧)标记', async () => {
    await startWith({ withVision: true, autoDesc: '一只跳动的猫' });
    mock.emitGroupMessage({
      user_id: 1001,
      nickname: '阿明',
      segments: [{ type: 'image', data: { url: 'http://img/cat.gif', file: 'cat.gif' } }],
    });
    await waitUntil(() => host.pushed.length >= 1, '消息入库');
    const msg = host.pushed[0].event;
    // 渲染时靠.gif后缀即时标记(GIF事件正文的mime权威判定见服务级测试)
    expect(msg.text).toContain('[图片 IMG-1(GIF·仅首帧) 正在载入VLM理解中...]');
  });

  it('qq_view_image:未知ID → 参数错误(可读)', async () => {
    await startWith({ withVision: true, autoDesc: 'x' });
    const view = mod.tools().find((t) => t.name === 'qq_view_image')!;
    const res = await view.handler({ image_id: 'IMG-99', prompt: '看看' }, toolCtx);
    expect(res).toContain('image IMG-99 not found');
  });

  it('qq_view_image:ID宽松归一化(img1/3 → IMG-N)', async () => {
    await startWith({ withVision: true, autoDesc: 'x' });
    mock.emitGroupMessage({
      user_id: 1001,
      segments: [imageSeg('http://img/1.png')],
    });
    await waitUntil(
      () => host.pushed.some((p) => p.event.type === 'qq.vision'),
      '被动完成',
    );
    vlm.auto = () => '答复';
    const view = mod.tools().find((t) => t.name === 'qq_view_image')!;
    expect(await view.handler({ image_id: '1', prompt: 'q' }, toolCtx)).toBe('答复');
    expect(await view.handler({ image_id: 'img-1', prompt: 'q' }, toolCtx)).toBe('答复');
  });

  it('一条消息两张图 → IMG-1/IMG-2各自事件', async () => {
    await startWith({ withVision: true, autoDesc: '图' });
    mock.emitGroupMessage({
      user_id: 1001,
      segments: [imageSeg('http://img/a.png'), imageSeg('http://img/b.png')],
    });
    await waitUntil(
      () => host.pushed.filter((p) => p.event.type === 'qq.vision').length === 2,
      '两张图各自事件',
    );
    const visions = host.pushed.filter((p) => p.event.type === 'qq.vision');
    const ids = visions.map((v) => v.event.meta?.image_id).sort();
    expect(ids).toEqual(['IMG-1', 'IMG-2']);
    const msg = host.pushed[0].event;
    expect(msg.text).toContain('IMG-1');
    expect(msg.text).toContain('IMG-2');
  });

  it('主模型也吃图片时,被动识图照样跑(描述本身就是记忆)', async () => {
    // 图片本身在截断后就从上下文消失,描述才是那条经历可检索的部分。
    await startWith({ withVision: true, multimodal: true, autoDesc: '图' });
    mock.emitGroupMessage({
      user_id: 1001,
      segments: [imageSeg('http://img/1.png')],
    });
    await waitUntil(
      () => host.pushed.some((p) => p.event.type === 'qq.vision'),
      '被动识图照样产生qq.vision',
    );
    expect(host.pushed[0].event.text).toContain('IMG-1');
    expect(vlm.calls.length).toBeGreaterThanOrEqual(1);

    // qq_view_image仍可用
    vlm.auto = () => '主动看图结果';
    const view = mod.tools().find((t) => t.name === 'qq_view_image')!;
    expect(view).toBeDefined();
    expect(await view.handler({ image_id: 'IMG-1', prompt: '认字' }, toolCtx)).toBe('主动看图结果');
  });

  it('自带模型的用量自愿上报进 core 的账', async () => {
    await startWith({ withVision: true, autoDesc: '一只猫' });
    mock.emitGroupMessage({ user_id: 1001, segments: [imageSeg('http://img/1.png')] });
    await waitUntil(
      () => host.pushed.some((p) => p.event.type === 'qq.vision'),
      '被动识图完成',
    );
    await waitUntil(() => host.reportedUsage.length >= 1, '用量上报到 host');
    expect(host.reportedUsage[0].model).toBe('test-vlm');
    expect(host.reportedUsage[0].label).toContain('辅助视觉');
  });

  it('收到的图随 qq.vision 事件落库:她拿到 log: 句柄,正文接一行文本形态', async () => {
    await startWith({ withVision: true, autoDesc: '一只橘猫在睡觉' });
    mock.emitGroupMessage({ user_id: 1001, segments: [imageSeg('http://img/cat.png')] });
    await waitUntil(() => host.pushed.some((p) => p.event.type === 'qq.vision'), '被动完成');
    const vis = host.pushed.find((p) => p.event.type === 'qq.vision')!.event;
    expect(vis.blobs).toHaveLength(1);
    const blob = vis.blobs![0];
    expect(blob.handle).toMatch(/^log:/);
    expect(blob.mime).toBe('image/png');
    expect(blob.name).toBe('IMG-1');
    expect(vis.text).toContain(`[blob ${blob.handle} image/png IMG-1] 图片 IMG-1`);
    // 字节真的在附件库里
    expect(host.blob(blob.handle)).not.toBeNull();
    // World 自己没有存图工具:收藏是Persona的 save_blob 的事
    expect(mod.tools().find((t) => t.name === 'save_image')).toBeUndefined();
  });

  it('去重预判已拿到字节的图直接随消息落库(第二次发同一张)', async () => {
    await startWith({ withVision: true, autoDesc: '一只橘猫' });
    mock.emitGroupMessage({ user_id: 1001, segments: [imageSeg('http://img/cat.png')] });
    await waitUntil(() => host.pushed.some((p) => p.event.type === 'qq.vision'), '第一张被动完成');
    mock.emitGroupMessage({ user_id: 1002, segments: [imageSeg('http://img/cat.png')] });
    await waitUntil(() => host.pushed.filter((p) => p.event.type === 'qq.message').length >= 2, '第二条消息入库');
    const second = host.pushed.filter((p) => p.event.type === 'qq.message')[1].event;
    expect(second.text).toContain('与 IMG-1 是同一张图');
    expect(second.blobs?.map((b) => b.name)).toEqual(['IMG-2']);
  });

  it('draft带image(句柄):按字节内容弹出识别缓存preview;confirm(send)编译image段(base64://),只发图无text段', async () => {
    await startWith({ withVision: true, autoDesc: '一只橘猫' });
    mock.emitGroupMessage({ user_id: 1001, segments: [imageSeg('http://img/cat.png')] });
    await waitUntil(() => host.pushed.some((p) => p.event.type === 'qq.vision'), '被动完成');
    const seen = host.pushed.find((p) => p.event.type === 'qq.vision')!.event.blobs![0];
    // 她把看见的图存进了记忆(Persona的事);这里直接用同一份字节造一个 mem: 句柄
    const kept = host.putBlob(host.blob(seen.handle)!.bytes, 'image/png', 'mem:external/qq/images/橘猫.png');

    const draft = mod.tools().find((t) => t.name === 'qq_draft')!;
    const confirm = mod.tools().find((t) => t.name === 'qq_confirm')!;
    const d = (await draft.handler({ to: `group:${GROUP}`, image: kept }, toolCtx)) as string;
    expect(d).toContain('will send image');
    expect(d).toContain('cached description: 一只橘猫'); // 同一份字节,描述按内容哈希对上

    const c = (await confirm.handler({ decision: 'send' }, toolCtx)) as string;
    expect(c).toContain('sent #');
    const sent = mock.outbox.find((o) => o.action === 'send_group_msg')!;
    const segs = sent.params.message as Array<{ type: string; data: { file?: string } }>;
    const imgSeg = segs.find((s) => s.type === 'image');
    expect(imgSeg).toBeDefined();
    expect(String(imgSeg!.data.file)).toMatch(/^base64:\/\//);
    expect(segs.some((s) => s.type === 'text')).toBe(false); // 只发图不带字
    // 自己发的图在历史里可见,并按句柄附在自己那条记录上
    const self = host.pushed.find((p) => p.event.type === 'qq.self')!;
    expect(self.event.text).toContain(`[图片: ${kept}]`);
    expect(self.event.blobs?.[0].handle).toBe(kept);
  });

  it('draft 直接用看见过的 log: 句柄也能发;没有的句柄 → 失败,不暂存', async () => {
    await startWith({ withVision: true, autoDesc: 'x' });
    mock.emitGroupMessage({ user_id: 1001, segments: [imageSeg('http://img/cat.png')] });
    await waitUntil(() => host.pushed.some((p) => p.event.type === 'qq.vision'), '被动完成');
    const seen = host.pushed.find((p) => p.event.type === 'qq.vision')!.event.blobs![0];
    const draft = mod.tools().find((t) => t.name === 'qq_draft')!;
    const confirm = mod.tools().find((t) => t.name === 'qq_confirm')!;
    expect(await draft.handler({ to: `group:${GROUP}`, image: seen.handle }, toolCtx)).toContain('will send image');
    await confirm.handler({ decision: 'cancel' }, toolCtx);
    const d = (await draft.handler({ to: `group:${GROUP}`, image: 'mem:external/qq/images/不存在.png' }, toolCtx)) as string;
    // 拒绝理由需说明可用的句柄形式
    expect(d).toContain('no blob for mem:external/qq/images/不存在.png');
    expect(d).toContain('log: handle');
    expect(await confirm.handler({ decision: 'send' }, toolCtx)).toContain('no draft to confirm');
  });

  it('无视觉服务:降级[图片]占位、无qq_view_image工具(零回归)', async () => {
    await startWith({ withVision: false });
    expect(mod.tools().find((t) => t.name === 'qq_view_image')).toBeUndefined();
    mock.emitGroupMessage({
      user_id: 1001,
      segments: [imageSeg('http://img/1.png'), { type: 'text', data: { text: 'hi' } }],
    });
    await waitUntil(() => host.pushed.length >= 1, '消息入库');
    const msg = host.pushed[0].event;
    expect(msg.text).toContain('[图片]');
    expect(msg.text).not.toContain('IMG-');
    expect(msg.meta?.images).toBeUndefined();
  });
});
