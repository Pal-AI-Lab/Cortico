/**
 * QQ World。
 *
 * 仅监听配置名单中的群与私聊,名单可通过 Web 热更新。其他会话与请求不落盘。
 * 每条消息渲染带会话标签(`[群「X」HH:MM]` / `[私聊 HH:MM]`),事件 meta.conv
 * 记录归属,发送/回复据此路由。
 *
 * 发送使用起草-确认门:draft 暂存单槽草稿并形成一次推理屏障。起草期间已经
 * 到达的会话消息会作为新的 user 事件紧随其后投递；下一次推理可确认或取消。
 */
import { createHash } from 'node:crypto';
import type {
  ConfigGroup,
  EventEnvelope,
  WorldConsoleDecl,
  World,
  WorldHost,
  Logger,
  StoragePart,
  ToolDef,
  BlobInput,
} from '../../core/types.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nowIso, shortTime, nullLogger } from '../../core/util.ts';
import {
  eventInConversation,
  parseConversationAddress,
  sameConversation,
  type Conv,
} from './conversation.ts';
import { OneBotDriver, type OneBotEvent } from './driver.ts';
import { createHistoryTools } from './history-tools.ts';
import {
  buildOutgoing,
  makeImagePolicy,
  parseJsonCard,
  renderIncoming,
  renderSegmentsPlain,
  type ImageRenderPolicy,
  type JsonCardRenderPolicy,
  type OneBotGroupMessage,
  type Segment,
} from './normalize.ts';
import type { VisionService } from './vision.ts';
import { QQ_DEFAULTS, QQ_SECRETS, QQ_CONFIG_GROUP, type QQRosterEntry } from './config.ts';

export type { Conv } from './conversation.ts';
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** QQ在查不到账号资料时返回的昵称占位,等于「没有名字」。 */
const PLACEHOLDER_NICKNAME = 'QQ用户';



export function enabledRosterIds(entries: QQRosterEntry[]): number[] {
  return entries.filter((e) => e.enabled).map((e) => e.id);
}



interface QQWorldConfig {
  wsUrl: string;
  /** 监听的群号集合 */
  groups: number[];
  /** 监听的私聊QQ号集合 */
  privates: number[];
  token: string;
  /** Event rendering timezone. */
  timezone?: string;
  /** 重连退避参数透传(测试用短退避) */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  apiTimeoutMs?: number;
}

/**
 * 「QQ 接入」面板的装配数据面。装配层管理 roster、enabled、持久化与重启；
 * World 管理面板语义和校验。缺少该依赖时 gate/roster 面板不可用。
 */
interface QQGatePanelDeps {
  /** config.worlds.qq.enabled(当前进程装配态;改它要重启才生效) */
  enabled(): boolean;
  wsUrl(): string;
  /** 是否已配置 access token(只报有无,不回明文) */
  tokenSet(): boolean;
  /** 完整监听名单,包含未进入 World 监听集合的 disabled 条目。 */
  roster(): { groups: QQRosterEntry[]; privates: QQRosterEntry[] };
  /** 整体替换名单并写回 config.json;返回一句结果描述 */
  setRoster(groups: QQRosterEntry[], privates: QQRosterEntry[]): string;
  /** 持久化 worlds.qq.enabled;本身不重启,重启由调用方另行触发 */
  setEnabled(enabled: boolean): void;
  /** 持久化 NapCat 连接(wsUrl + token);token 空串=保持原值不动 */
  setConnection(wsUrl: string, token: string): void;
  /** 落重启标志并让进程退出(启动器重新拉起,回来是暂停态) */
  restart(): void;
}

interface QQWorldDeps {
  vision?: VisionService;
  gate?: QQGatePanelDeps;
}

/** 暂存的草稿(单槽,一进一出;不确认到本轮末即作废) */
interface PendingDraft {
  target: Conv;
  text: string;
  /** 引用回复的平台message_id(已从游标解析好) */
  replyMessageId?: number | string;
  /** 要发送的图片的句柄(`log:` 她看见过的 / `mem:` 她收藏的);无=纯文本 */
  imageRef?: string;
  /** 要发送的语音的句柄;语音条独占一条消息,与 text、imageRef 互斥 */
  voiceRef?: string;
}

interface ForwardNode {
  line: string;
  /** 正文(不带发言人前缀),身份塌掉时重新渲染用 */
  body: string;
  /** 协议给了可用的发言人名字(不是空、也不是「QQ用户」占位) */
  named: boolean;
  time?: number;
  userId?: string;
  messageType?: string;
}

export class QQWorld implements World {
  readonly id = 'qq';

  private readonly cfg: QQWorldConfig;
  private readonly timezone: string;
  private host?: WorldHost;
  private driver?: OneBotDriver;
  private log: Logger = nullLogger();
  private imagePolicy: ImageRenderPolicy = () => '[图片]';

  /** 外挂视觉(注入=auxVLM生效);null=无,一切保持[图片]占位现状 */
  private readonly vision?: VisionService;

  /** 监听集合(可web端热改) */
  private watchedGroups: Set<number>;
  private watchedPrivates: Set<number>;

  /**
   * 已记录的 QQ 消息:平台 message_id → 所在会话与时间(内存索引,启动时从store重建)。
   * QQ 消息身份即平台自身的 message_id,不使用 core 事件游标。
   */
  private knownMessages = new Map<string, { conv: Conv; ts: string }>();
  /** QQ号 → 最近见到的显示名(撤回/入退群/私聊寻址渲染用;同样从store重建) */
  private nameByUserId = new Map<string, string>();

  /** 单槽草稿(起草-确认门) */
  private pendingDraft: PendingDraft | null = null;


  /** 最近一次成功组装的动态账号/会话事实(断线期间沿用；不缓存可编辑固定文本) */
  private cachedDynamicContext?: string;

  /**
   * 消息处理串行链:所有消息严格按到达顺序处理。图片去重预判(precheckDup)
   * 是每条消息内部的异步等待点,不排队会导致连续到达的消息乱序落库。
   */
  private msgChain: Promise<void> = Promise.resolve();

  constructor(cfg: QQWorldConfig, deps?: QQWorldDeps) {
    this.cfg = cfg;
    this.timezone = cfg.timezone ?? 'Asia/Shanghai';
    this.vision = deps?.vision;
    this.gate = deps?.gate;
    this.watchedGroups = new Set(cfg.groups);
    this.watchedPrivates = new Set(cfg.privates);
  }

  private readonly gate?: QQGatePanelDeps;

  /** 被动识图在视觉服务可用时启用；识图描述写入事件库作为可检索记忆。 */
  private passiveEnabled(): boolean {
    return !!this.vision;
  }

  /**
   * 去重预判在消息渲染前就有结果时,直接内联进这条消息(不走占位+异步事件)。
   * meta 来自 VisionService.precheckDup：dup_of 表示命中去重，ok=false 表示下载失败。
   */
  private inlineVisionText(
    id: string,
    gifMark: string,
    meta: Record<string, unknown>,
    label = '图片',
  ): string {
    if (meta.dup_of) {
      return `[${label} ${id}${gifMark}，与 ${meta.dup_of} 是同一张图，已识别过(沿用其描述)]`;
    }
    return `[${label} ${id}${gifMark} 识别失败]`;
  }


  /** 当前监听集合(web面板读取用) */
  getWatched(): { groups: number[]; privates: number[] } {
    return { groups: [...this.watchedGroups], privates: [...this.watchedPrivates] };
  }

  /**
   * 连接与身份快照(web「QQ 接入」控制台的连接状态卡数据源)。
   * 断线期间 connected=false,但 selfId/群名沿用上次身份;私聊名字随消息填充。
   */
  getConnection(): {
    connected: boolean;
    selfId: number | null;
    nickname: string;
    groups: Array<{ id: number; name: string; card: string }>;
    privates: Array<{ id: number; name: string }>;
  } {
    const idn = this.driver?.identity;
    return {
      connected: this.driver?.connected ?? false,
      selfId: idn?.selfId ?? null,
      nickname: idn?.nickname ?? '',
      groups: [...this.watchedGroups].map((id) => {
        const g = idn?.groups.get(id);
        return { id, name: g?.groupName ?? String(id), card: g?.card ?? '' };
      }),
      privates: [...this.watchedPrivates].map((id) => ({
        id,
        name: this.nameByUserId.get(String(id)) ?? '',
      })),
    };
  }

  /**
   * 热改监听集合(roster 里 enabled 的子集)。新群的身份在下次重连(或已连接时
   * 的后台刷新)时补齐;私聊名字随后续消息自然填充。进入/离开监听的每个 id
   * 各推一条 qq.watch 事件——监听名单变化属于环境事件,不静默修改。
   */
  setWatched(groups: number[], privates: number[]): void {
    const oldGroups = this.watchedGroups;
    const oldPrivates = this.watchedPrivates;
    const newGroups = new Set(groups.filter((g) => Number.isFinite(g)));
    const newPrivates = new Set(privates.filter((p) => Number.isFinite(p)));

    this.watchedGroups = newGroups;
    this.watchedPrivates = newPrivates;
    this.cachedDynamicContext = undefined;
    this.driver?.setGroups([...newGroups]);
    this.log.info('监听配置已更新', {
      groups: [...newGroups],
      privates: [...newPrivates],
    });

    this.announceWatchDiff('group', oldGroups, newGroups);
    this.announceWatchDiff('private', oldPrivates, newPrivates);
  }

  /** 推送监听集合的差集通知:每个进入/离开监听的id各一条qq.watch事件 */
  private announceWatchDiff(kind: 'group' | 'private', before: Set<number>, after: Set<number>): void {
    if (!this.host) return;
    for (const id of after) if (!before.has(id)) this.pushWatchEvent(kind, id, true);
    for (const id of before) if (!after.has(id)) this.pushWatchEvent(kind, id, false);
  }

  private pushWatchEvent(kind: 'group' | 'private', id: number, joined: boolean): void {
    const host = this.host!;
    const label = kind === 'group' ? `群(群号${id})` : `私聊(QQ号${id})`;
    host.pushEvent({
      type: 'qq.watch',
      ts: nowIso(this.timezone),
      source: this.id,
      text: `[系统] ${label} ${joined ? '已加入监听' : '已从监听移除'}`,
      senderKey: String(id),
      meta: { conv: { kind, id } },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }


  /**
   * 会话清单与自身账号两个洞。措辞(含"下面是你正在参与的会话:"那句和两条降级
   * 文案)全在 ENV_PROMPT.md 里,这里只算值。
   *
   * 三态,中间那态是有意的:**掉线时沿用断线前的群名快照**。若把群名换成"未知",
   * 整段前缀内容就变了,前缀缓存全部失效、下一次调用要重新 prefill 一整份 system。
   * 为省这个钱才留着旧快照——别当成可以顺手简化掉的分支。
   */
  envPromptVars(): Record<string, string> {
    const idn = this.driver?.identity;
    if (!idn && this.cachedDynamicContext !== undefined) {
      return { 'qq.conversations': this.cachedDynamicContext, 'qq.identity': '' };
    }
    const lines: string[] = [];
    for (const gid of this.watchedGroups) {
      const g = idn?.groups.get(gid);
      lines.push(
        g
          ? `- 群「${g.groupName}」(群号${gid});你在这个群的昵称是「${g.card}」`
          : `- 群(群号${gid});群信息尚未就绪`,
      );
    }
    if (this.watchedPrivates.size > 0) {
      const names = [...this.watchedPrivates].map((uid) => {
        const n = this.nameByUserId.get(String(uid));
        return n ? `${n}(${uid})` : String(uid);
      });
      lines.push(`- 私聊:${names.join('、')}`);
    }
    const conversations = lines.join('\n');
    if (idn) this.cachedDynamicContext = conversations;
    return {
      'qq.conversations': conversations,
      'qq.identity': idn ? `你的QQ号是${idn.selfId}。` : '',
    };
  }

  /**
   * 控制台里露出什么:连接状态徽标 + 本 World 的三个专用面板 + 视觉旋钮。
   * 控制台不认识 'qq' 这个 id,它只照这份声明渲染。
   */
  console(): WorldConsoleDecl {
    const conn = this.getConnection();
    return {
      // 两条链路各一颗:协议端连着没有、监听名单空不空。
      //
      // 接入门关着 = 灰(拨下来的);开着却连不上协议端 = 红:这个渠道存在的全部意义
      // 就是连着那个协议端,连不上就是她在 QQ 上失联了。名单空着不算故障,但那时候
      // 连着也收不到任何消息——所以它值一颗自己的灯。
      lamps: [
        {
          label: '协议端',
          ...(this.gate?.enabled() === false
            ? { state: 'offline' as const, hint: '接入门关闭' }
            : conn.connected
              ? { state: 'online' as const, hint: conn.nickname || String(conn.selfId ?? '') }
              : { state: 'error' as const, hint: '未连接' }),
        },
        {
          label: '监听',
          ...(conn.groups.length + conn.privates.length > 0
            ? {
                state: 'online' as const,
                hint: `群 ${conn.groups.length} · 私聊 ${conn.privates.length}`,
              }
            : { state: 'offline' as const, hint: '名单为空' }),
        },
      ],
      badges: [
        {
          label: '协议端',
          value: conn.connected ? `已连接 ${conn.nickname || conn.selfId || ''}`.trim() : '未连接',
          tone: conn.connected ? 'on' : 'off',
        },
        { label: '监听', value: `群 ${conn.groups.length} · 私聊 ${conn.privates.length}` },
      ],
      // 局部 id + 真标题(控制台把 title 画成面板切换页签);渲染在
      // src/worlds/qq/console/ 的自有浏览器扩展里,中央前端不认识这三个名字。
      panels: [
        { id: 'gate', title: '接入门', description: '接入开关、连接状态与 NapCat 地址。' },
        { id: 'roster', title: '监听名单', description: '监听哪些群、哪些私聊;改动热生效。' },
        { id: 'events', title: '事件', description: '事件库里 source=qq 的历史,按会话翻。' },
      ],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
      promptDocs: [
        {
          key: 'worlds.qq.envPrompt',
          title: 'QQ · 环境提示词',
          description: 'QQ 渠道的常驻事实(消息形态、起草确认门、图片)。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            {
              name: 'qq.conversations',
              description: '当前监听的群与私聊清单,每行一条:群名、群号、你在该群的昵称。',
              multiline: true,
            },
            {
              name: 'qq.identity',
              description: '你自己的 QQ 号;未连接协议端时为空(此时用缺省文案)。',
            },
          ],
        },
      ],
      config: [QQ_CONFIG_GROUP],
      ...(this.vision ? { storage: [this.visionStorage(this.vision)] } : {}),
    };
  }

  /** 辅助视觉的缓存(图片字节 + 被动描述 + 追问 session)作为可清除存储上报。 */
  private visionStorage(vision: VisionService): StoragePart {
    return {
      key: 'vision',
      label: '外挂视觉缓存(图片+描述+追问session)',
      kind: 'disk',
      location: 'data/vision/',
      note: '图片字节/被动描述/追问轮次全部抹除,IMG计数器归零;历史消息里旧IMG-N此后查不到',
      stat: () => `${vision.imageCount()}张图`,
      clear: () => `已清除${vision.clear()}张图的视觉缓存`,
    };
  }

  /**
   * 面板调用按 (panel, method, args) 透传；panel 为 console() 声明中的局部 id。
   */
  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel === 'gate') return this.invokeGate(method, args);
    if (panel === 'roster') return this.invokeRoster(method, args);
    if (panel === 'events') return this.invokeEvents(method, args);
    throw new Error(`未知面板: ${panel}`);
  }

  /**
   * 会话名字快照(群名/我的群昵称/私聊称呼)。roster 与 events 两个面板都要拿它
   * 把号码渲染成人看得懂的名字,而 `ctx.invoke` 只能打到**本面板**——所以两边
   * 各开一个 `names`,而不是让它们去借 gate 的 `state`。
   */
  private convNames(): {
    groups: Array<{ id: number; name: string; card: string }>;
    privates: Array<{ id: number; name: string }>;
  } {
    const conn = this.getConnection();
    return { groups: conn.groups, privates: conn.privates };
  }

  private async invokeGate(method: string, args: unknown[]): Promise<unknown> {
    const gate = this.gate;
    if (!gate) throw new Error('QQ 接入控制不可用(装配层没提供 gate 数据面)');
    if (method === 'state') {
      const conn = this.getConnection();
      const roster = gate.roster();
      return {
        enabled: gate.enabled(),
        wsUrl: gate.wsUrl(),
        tokenSet: gate.tokenSet(),
        connected: conn.connected,
        selfId: conn.selfId,
        nickname: conn.nickname,
        groups: conn.connected || conn.groups.length > 0
          ? conn.groups
          : enabledRosterIds(roster.groups).map((id) => ({ id, name: String(id), card: '' })),
        privates: conn.connected || conn.privates.length > 0
          ? conn.privates
          : enabledRosterIds(roster.privates).map((id) => ({ id, name: '' })),
      };
    }
    if (method === 'setEnabled') {
      const enabled = args[0];
      if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔');
      gate.setEnabled(enabled);
      this.log.warn('QQ 接入开关已改,即将重启', { enabled });
      this.scheduleGateRestart(gate);
      return { ok: true, restarting: true, enabled };
    }
    if (method === 'setConnection') {
      const wsUrl = typeof args[0] === 'string' ? args[0].trim() : '';
      const token = typeof args[1] === 'string' ? args[1] : '';
      if (!/^wss?:\/\/.+/i.test(wsUrl)) throw new Error('wsUrl 必须是 ws:// 或 wss:// 地址');
      gate.setConnection(wsUrl, token);
      this.log.warn('NapCat 连接配置已改,即将重启', { wsUrl, tokenChanged: token !== '' });
      this.scheduleGateRestart(gate);
      return { ok: true, restarting: true };
    }
    throw new Error(`未知面板方法: gate.${method}`);
  }

  /** HTTP 响应冲刷后再写重启标志并退出进程。 */
  private scheduleGateRestart(gate: QQGatePanelDeps): void {
    setTimeout(() => {
      try { gate.restart(); } catch (err) { this.log.error('触发重启失败', { error: String(err) }); }
    }, 300);
  }

  private async invokeRoster(method: string, args: unknown[]): Promise<unknown> {
    // 名字快照不依赖装配层的 gate 数据面:名单读不出来的时候,至少还能显示名字
    if (method === 'names') return this.convNames();
    const gate = this.gate;
    if (!gate) throw new Error('QQ 监听配置不可用(装配层没提供 gate 数据面)');
    if (method === 'get') return gate.roster();
    if (method === 'set') {
      const coerce = (raw: unknown, field: string): QQRosterEntry[] => {
        if (raw === undefined || raw === null) return [];
        if (!Array.isArray(raw)) throw new Error(`${field}必须是数组`);
        const out: QQRosterEntry[] = [];
        const seen = new Set<number>();
        for (const item of raw) {
          if (!item || typeof item !== 'object') throw new Error(`${field}的每一项必须是{id,enabled}对象`);
          const id = Number((item as Record<string, unknown>).id);
          if (!Number.isInteger(id) || id <= 0) {
            throw new Error(`${field}的每一项id必须是>0的整数,收到: ${String((item as Record<string, unknown>).id)}`);
          }
          if (seen.has(id)) throw new Error(`${field}里号码${id}重复`);
          seen.add(id);
          out.push({ id, enabled: (item as Record<string, unknown>).enabled !== false });
        }
        return out;
      };
      const groups = coerce(args[0], 'groups');
      const privates = coerce(args[1], 'privates');
      const result = gate.setRoster(groups, privates);
      this.log.warn('QQ监听配置已修改', { groups, privates });
      return { ok: true, result, config: gate.roster() };
    }
    throw new Error(`未知面板方法: roster.${method}`);
  }

  /** 事件历史按会话分组(读事件库 source=qq;World 未启动时不可用) */
  private async invokeEvents(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'names') return this.convNames();
    if (method !== 'list') throw new Error(`未知面板方法: events.${method}`);
    const store = this.host?.store;
    if (!store) throw new Error('QQ World 未启动,事件历史不可用');
    const opts = (args[0] ?? {}) as { conv?: unknown; limit?: unknown };
    const all = store.range({ source: this.id });
    const convMap = new Map<string, { kind: string; id: number; count: number; lastTs: string }>();
    for (const e of all) {
      const c = e.meta?.conv as { kind?: string; id?: number } | undefined;
      if (!c || (c.kind !== 'group' && c.kind !== 'private') || c.id === undefined) continue;
      const key = `${c.kind}:${Number(c.id)}`;
      const cur = convMap.get(key);
      if (cur) { cur.count++; cur.lastTs = e.ts; }
      else convMap.set(key, { kind: c.kind, id: Number(c.id), count: 1, lastTs: e.ts });
    }
    const conversations = [...convMap.values()].sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));

    const convRaw = typeof opts.conv === 'string' ? opts.conv.trim() : '';
    let events = all;
    const m = convRaw ? /^(group|private):(\d+)$/i.exec(convRaw) : null;
    if (convRaw && !m) {
      events = [];
    } else if (m) {
      const kind = m[1].toLowerCase();
      const id = Number(m[2]);
      events = all.filter((e) => {
        const c = e.meta?.conv as { kind?: string; id?: number } | undefined;
        return !!c && c.kind === kind && Number(c.id) === id;
      });
    }
    const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 300));
    if (events.length > limit) events = events.slice(events.length - limit);
    const lean = events.map((e) => ({
      cursor: e.cursor,
      type: e.type,
      ts: e.ts,
      text: e.text,
      senderKey: e.senderKey,
      senderName: (e.meta?.sender_name as string | undefined) ?? '',
      conv: e.meta?.conv ?? null,
    }));
    return { conversations, events: lean, total: all.length };
  }


  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.log = host.log;
    // 主模型支持 image/png 或 World 配置了视觉模型时启用取图。
    this.imagePolicy = makeImagePolicy(!!this.vision || host.modelFacts.accepts('image/png'));
    // 外挂视觉的用量自愿上报进 core 的成本账(不报就在成本页看不到)
    this.vision?.setUsageSink((usage, model) =>
      host.reportUsage(usage, { model, label: 'QQWorld·辅助视觉' }),
    );
    this.rebuildMaps();

    const driver = new OneBotDriver({
      wsUrl: this.cfg.wsUrl,
      groups: [...this.watchedGroups],
      token: this.cfg.token,
      log: this.log.child('driver'),
      reconnectBaseMs: this.cfg.reconnectBaseMs,
      reconnectMaxMs: this.cfg.reconnectMaxMs,
      apiTimeoutMs: this.cfg.apiTimeoutMs,
    });
    this.driver = driver;
    driver.onEvent((ev) => this.handleEvent(ev));
    driver.onReady(() => {
      this.envPromptVars(); // 为副作用调用:趁 identity 在,把群名快照存进缓存
      this.log.info('身份就绪', { context: this.cachedDynamicContext });
    });
    await driver.start();
  }

  async stop(): Promise<void> {
    await this.driver?.stop();
  }

  /** 测试/联调辅助:等驱动连接并完成身份初始化 */
  waitReady(timeoutMs = 10000): Promise<void> {
    if (!this.driver) return Promise.reject(new Error('World 未启动'));
    return this.driver.waitReady(timeoutMs);
  }

  /** 每轮起点调用:上一轮未确认的草稿作废(起草-确认门的"默认擦除") */
  /** 一轮自然收束:未确认的草稿只在本轮内有效。draft 屏障后紧接的 user 事件仍属同一轮,不在这里作废。 */
  onTurnEnded(): void {
    this.discardPendingDraft();
  }

  discardPendingDraft(): void {
    if (this.pendingDraft) {
      this.log.debug('未确认的草稿已作废');
      this.pendingDraft = null;
    }
  }


  private handleEvent(ev: OneBotEvent): void {
    const host = this.host;
    if (!host) return;

    if (ev.post_type === 'message') {
      if (ev.message_type === 'group' && ev.group_id !== undefined) {
        if (this.watchedGroups.has(Number(ev.group_id))) {
          this.enqueueMessage(ev as unknown as OneBotGroupMessage, {
            kind: 'group',
            id: Number(ev.group_id),
          });
        }
        return;
      }
      if (ev.message_type === 'private' && ev.user_id !== undefined) {
        if (this.watchedPrivates.has(Number(ev.user_id))) {
          this.enqueueMessage(ev as unknown as OneBotGroupMessage, {
            kind: 'private',
            id: Number(ev.user_id),
          });
        }
        return;
      }
      return; // 其他消息类型丢弃
    }

    if (ev.post_type === 'notice') {
      // 群通知仅处理监听中的群;私聊/名单外一律丢弃
      if (ev.group_id === undefined || !this.watchedGroups.has(Number(ev.group_id))) return;
      const gid = Number(ev.group_id);
      switch (ev.notice_type) {
        case 'group_recall':
          this.handleRecall(ev, gid);
          return;
        case 'group_increase':
          this.handleMemberChange(ev, gid, 'join');
          return;
        case 'group_decrease':
          this.handleMemberChange(ev, gid, 'leave');
          return;
        case 'group_msg_emoji_like':
          this.handleEmojiLike(ev, gid);
          return;
        case 'notify':
          if (ev.sub_type === 'poke') this.handlePoke(ev, gid);
          return;
        default:
          return;
      }
    }
    // request(好友/加群请求)/meta_event(心跳)全部丢弃
  }

  /**
   * 入队一条消息:严格按到达顺序处理(见msgChain字段注释)。单条消息内部
   * 出错不冲垮后续消息——记录日志,链继续往下走。
   */
  private enqueueMessage(msg: OneBotGroupMessage, conv: Conv): void {
    this.msgChain = this.msgChain.then(() => this.handleMessage(msg, conv)).catch((e) => {
      this.log.error('消息处理异常', { err: String(e) });
    });
  }

  private async handleMessage(msg: OneBotGroupMessage, conv: Conv): Promise<void> {
    const host = this.host!;
    const idn = this.driver?.identity;
    const selfId = idn?.selfId ?? -1;

    // 自己账号的回声消息丢弃(自己说的话由 confirm(send) 回录 qq.self)
    if (Number(msg.user_id) === selfId) return;

    const senderKey = String(msg.user_id);
    const displayName = msg.sender?.card || msg.sender?.nickname || senderKey;
    this.nameByUserId.set(senderKey, displayName);

    // 图片渲染策略(外挂视觉,群/私聊同处理)。被动开启时,每张图先做一次限时的
    // 内容去重预判(下载+算hash+查重复,不跑VLM);时限内出结果(命中或下载失败)
    // 则直接内联进消息,跳过占位与异步qq.vision事件,否则显示占位符。
    const collected: Array<{ id: string; url: string }> = [];
    const earlyResolved: Array<{ text: string; meta: Record<string, unknown> } | null> = [];
    let renderImage: ImageRenderPolicy;
    let renderJsonCard: JsonCardRenderPolicy;

    if (this.vision) {
      const vision = this.vision;
      const passive = this.passiveEnabled();
      const items = (msg.message ?? [])
        .filter((seg) => seg.type === 'image')
        .map((seg) => {
          const data = seg.data ?? {};
          const url = extractImageUrl(data);
          const gif = looksLikeGif(data);
          return { url, gif, id: vision.registerImage(url, { gif }) };
        });
      const precheck =
        passive && items.length
          ? await Promise.all(items.map((it) => vision.precheckDup(it.id)))
          : items.map(() => null);

      let idx = 0;
      renderImage = () => {
        const it = items[idx];
        const early = precheck[idx];
        idx++;
        collected.push({ id: it.id, url: it.url });
        earlyResolved.push(early);
        const gifMark = it.gif ? '(GIF·仅首帧)' : '';
        if (early) return this.inlineVisionText(it.id, gifMark, early.meta);
        return passive
          ? `[图片 ${it.id}${gifMark} 正在载入VLM理解中...]`
          : `[图片 ${it.id}${gifMark}]`;
      };

      // JSON 卡片封面复用图片的去重预判与被动识图路径；下载失败由识别失败分支呈现。
      const cardItems = (msg.message ?? [])
        .filter((seg) => seg.type === 'json')
        .map((seg) => {
          const info = parseJsonCard(seg.data ?? {});
          return {
            ...info,
            id: info.previewUrl ? vision.registerImage(info.previewUrl, { gif: false }) : undefined,
          };
        });
      const cardPrecheck =
        passive && cardItems.some((it) => it.id)
          ? await Promise.all(cardItems.map((it) => (it.id ? vision.precheckDup(it.id) : null)))
          : cardItems.map(() => null);

      let cIdx = 0;
      renderJsonCard = () => {
        const it = cardItems[cIdx];
        const early = cardPrecheck[cIdx];
        cIdx++;
        const promptText = it.prompt ? `[分享:${it.prompt}]` : '[json]';
        if (!it.id) return promptText;
        collected.push({ id: it.id, url: it.previewUrl! });
        earlyResolved.push(early);
        if (early) return `${promptText} ${this.inlineVisionText(it.id, '', early.meta, '封面')}`;
        return passive
          ? `${promptText} [封面 ${it.id} 正在载入VLM理解中...]`
          : `${promptText} [封面 ${it.id}]`;
      };
    } else {
      renderImage = this.imagePolicy;
      renderJsonCard = (info) =>
        !info.prompt
          ? '[json]'
          : info.previewUrl
            ? `[分享:${info.prompt}] ${this.imagePolicy({ url: info.previewUrl })}`
            : `[分享:${info.prompt}]`;
    }

    const selfName =
      conv.kind === 'group'
        ? idn?.groups.get(conv.id)?.card || idn?.nickname || '你'
        : idn?.nickname || '你';

    const { text, mentionedSelf } = renderIncoming(msg, {
      selfId,
      selfName,
      timezone: this.timezone,
      convLabel: this.convLabel(conv),
      knowsMessage: (mid) => this.knownMessages.has(String(mid)),
      nameOf: (qq) => this.nameByUserId.get(qq),
      renderImage,
      renderJsonCard,
    });

    const when =
      typeof msg.time === 'number' ? new Date(msg.time * 1000) : new Date();
    // 去重预判阶段已经拿到字节的图随这条消息落库(她因此有句柄可以存、可以转发);
    // 还在下载/识别中的图随稍后的 qq.vision 事件落库。
    const blobs: BlobInput[] = [];
    if (this.vision) {
      for (let i = 0; i < collected.length; i++) {
        if (!earlyResolved[i]) continue;
        const got = await this.vision.getImageBytes(collected[i].id).catch(() => null);
        if (got) blobs.push({ bytes: got.buffer, mime: got.mime, name: collected[i].id, fallbackText: `图片 ${collected[i].id}` });
      }
    }
    // 私聊照常合批;群里被@立即投递
    const trigger = conv.kind === 'group' && mentionedSelf ? 'flush' as const : 'debounce' as const;
    const env = await host.pushEvent(
      {
        type: 'qq.message',
        ts: nowIso(this.timezone, when),
        source: this.id,
        text,
        senderKey,
        meta: {
          message_id: msg.message_id,
          user_id: msg.user_id,
          sender_name: displayName,
          conv,
        },
        ...(blobs.length ? { blobs } : {}),
      },
      { trigger },
    );
    this.knownMessages.set(String(msg.message_id), { conv, ts: env.ts });

    // 图片:回填所属消息号,被动识图(理解闭合后作为qq.vision事件延迟到达)。
    // 已经被上面的去重预判内联进消息本身的图,不用再走这条异步路径。
    if (this.vision && collected.length) {
      collected.forEach((img, i) => {
        this.vision!.attachMessage(img.id, msg.message_id);
        if (this.passiveEnabled() && !earlyResolved[i]) {
          this.vision!.startPassive(img.id, (visionText, visionMeta) => {
            void this.vision!.getImageBytes(img.id).catch(() => null).then((got) => host.pushEvent({
              type: 'qq.vision',
              ts: nowIso(this.timezone),
              source: this.id,
              text: visionText,
              meta: { ...visionMeta, conv },
              ...(got ? { blobs: [{ bytes: got.buffer, mime: got.mime, name: img.id, fallbackText: `图片 ${img.id}` }] } : {}),
            })).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
          });
        }
      });
    }

    // 引用回复指向的消息不在索引里(未被记录):异步取原文,不阻塞当前投递
    const replySeg = msg.message.find((s) => s.type === 'reply');
    if (replySeg) {
      const rid = String(replySeg.data?.id ?? '');
      if (rid && !this.knownMessages.has(rid)) {
        this.lookupUncapturedReply(rid, conv, msg.message_id);
      }
    }

    // 转发的聊天记录:异步展开内容,不阻塞当前投递(同一套延迟到达风格)
    const forwardSeg = msg.message.find((s) => s.type === 'forward');
    if (forwardSeg) {
      const resId = String(forwardSeg.data?.id ?? '');
      if (resId) this.lookupForward(resId, conv, msg.message_id);
    }
  }

  /**
   * 引用回复的原消息不在 knownMessages 里(可能发生在开始关注这个会话
   * 之前,或跨重启丢失):尽力用标准动作 get_msg 取回原文。取到与否都追加一条
   * 系统事件说明情况;不在当前消息处理里同步等待,避免打乱事件的到达顺序
   * (与被动识图的延迟到达是同一套非阻塞风格)。
   */
  private lookupUncapturedReply(rid: string, conv: Conv, ofMessageId: number | string): void {
    const host = this.host;
    const driver = this.driver;
    if (!host || !driver) return;
    const midNum = Number(rid);
    void driver
      .callApi('get_msg', { message_id: Number.isFinite(midNum) ? midNum : rid })
      .then(
        (data) => {
          const d = data as {
            sender?: { nickname?: string; card?: string; user_id?: number };
            message?: Segment[] | string;
          };
          const uid = d?.sender?.user_id;
          const name = d?.sender?.card || d?.sender?.nickname || (uid !== undefined ? String(uid) : rid);
          const body = typeof d?.message === 'string' ? d.message : renderSegmentsPlain(d?.message ?? []);
          host.pushEvent({
            type: 'qq.reply.uncaptured',
            ts: nowIso(this.timezone),
            source: this.id,
            text: `[系统] #${ofMessageId} 引用的消息不在你的记录里(未被捕获);查到的原文是 ${name}${uid !== undefined ? `(${uid})` : ''}: ${body}`,
            meta: { conv, message_id: rid },
          }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
        },
        (err) => {
          host.pushEvent({
            type: 'qq.reply.uncaptured',
            ts: nowIso(this.timezone),
            source: this.id,
            text: `[系统] #${ofMessageId} 引用的消息不在你的记录里(未被捕获),原文也没能取到:${err instanceof Error ? err.message : String(err)}`,
            meta: { conv, message_id: rid },
          }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
        },
      );
  }

  /** 转发消息的单个节点(发言人+内容),兼容NapCat记录与OneBot标准node段。 */
  private renderForwardNode(value: unknown): ForwardNode {
    const outer =
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
    const data = outer.data;
    const n =
      outer.type === 'node' && data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)
        : outer;
    const sender =
      n.sender !== null && typeof n.sender === 'object'
        ? (n.sender as Record<string, unknown>)
        : {};
    const uidValue = sender.user_id ?? n.user_id;
    const uid =
      typeof uidValue === 'string' || typeof uidValue === 'number'
        ? uidValue
        : undefined;
    const nicknameValue = sender.nickname ?? sender.card ?? n.nickname;
    const nickname =
      typeof nicknameValue === 'string' && nicknameValue && nicknameValue !== PLACEHOLDER_NICKNAME
        ? nicknameValue
        : undefined;
    const isSelf =
      uid !== undefined && String(uid) === String(this.driver?.identity?.selfId);
    const name = isSelf ? '你' : (nickname ?? (uid !== undefined ? String(uid) : '?'));
    const raw = n.content ?? n.message ?? n.raw_message;
    const body =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? renderSegmentsPlain(raw as Segment[])
          : '';
    return {
      line: `${name}${uid !== undefined ? `(${uid})` : ''}: ${body}`,
      body,
      named: isSelf || nickname !== undefined,
      time: typeof n.time === 'number' ? n.time : undefined,
      userId: uid !== undefined ? String(uid) : undefined,
      messageType: typeof n.message_type === 'string' ? n.message_type : undefined,
    };
  }

  /**
   * NapCat 对「私聊合并转发被转发进群」只提供协议兼容路径:该路径下所有节点的
   * 发言人一律填成转发者本人、昵称落回「QQ用户」占位,身份信息实质丢失。命中时
   * 调用方去掉发言人前缀只留正文,并在标题注明身份未取到,避免把多人对话误读
   * 成一个人的独白。
   */
  private forwardIdentityCollapsed(nodes: ForwardNode[]): boolean {
    if (nodes.length < 2 || nodes.some((n) => n.named)) return false;
    const ids = new Set(nodes.map((n) => n.userId));
    return ids.size === 1 && !ids.has(undefined);
  }

  private forwardMessages(data: unknown): unknown[] {
    if (data === null || typeof data !== 'object') return [];
    const response = data as Record<string, unknown>;
    if (Array.isArray(response.messages)) return response.messages;
    return Array.isArray(response.message) ? response.message : [];
  }

  /**
   * NapCat目前会把私聊合并转发中bot自己的节点全部漏掉。事件库已经捕获了这些
   * qq.self消息；只在协议结果完全没有自身节点时，按同一私聊和紧邻时间补回。
   */
  private recoverForwardSelfNodes(nodes: ForwardNode[]): ForwardNode[] {
    const host = this.host;
    const selfId = this.driver?.identity?.selfId;
    if (!host || selfId === undefined || nodes.some((n) => n.userId === String(selfId))) {
      return [];
    }
    const timed = nodes.filter(
      (n): n is ForwardNode & { time: number } =>
        n.messageType === 'private' && n.time !== undefined,
    );
    if (timed.length !== nodes.length || timed.length === 0) return [];
    const peerIds = new Set(
      timed.map((n) => n.userId).filter((id): id is string => Boolean(id)),
    );
    peerIds.delete(String(selfId));
    if (peerIds.size !== 1) return [];
    const peerId = Number([...peerIds][0]);
    if (!Number.isSafeInteger(peerId)) return [];

    const recoveryWindowSeconds = 120;
    const from = Math.min(...timed.map((n) => n.time));
    const to = Math.max(...timed.map((n) => n.time)) + recoveryWindowSeconds;
    return host.store
      .range({
        source: this.id,
        senderKey: String(selfId),
      })
      .filter(
        (event) =>
          event.type === 'qq.self' &&
          eventInConversation(event, { kind: 'private', id: peerId }) &&
          Date.parse(event.ts) / 1000 >= from &&
          Date.parse(event.ts) / 1000 <= to,
      )
      .filter((event) => {
        const eventTime = Date.parse(event.ts) / 1000;
        return timed.some(
          (node) =>
            eventTime >= node.time &&
            eventTime <= node.time + recoveryWindowSeconds,
        );
      })
      .map((event) => {
        const marker = '] 你: ';
        const markerAt = event.text.indexOf(marker);
        const body = markerAt >= 0 ? event.text.slice(markerAt + marker.length) : event.text;
        return {
          line: `你(${selfId}): ${body} [本地记录补回]`,
          body: `${body} [本地记录补回]`,
          named: true,
          time: Date.parse(event.ts) / 1000,
          userId: String(selfId),
          messageType: 'private',
        };
      });
  }

  /**
   * 转发(合并转发)消息:异步用扩展动作 get_forward_msg 取具体内容,取到与否都
   * 追加一条系统事件;不阻塞当前消息投递(同上,非阻塞延迟到达风格)。
   */
  private lookupForward(resId: string, conv: Conv, ofMessageId: number | string): void {
    const host = this.host;
    const driver = this.driver;
    if (!host || !driver) return;
    void driver.callApi('get_forward_msg', { message_id: resId }).then(
      (data) => {
        const nodes = this.forwardMessages(data).map((m) => this.renderForwardNode(m));
        const collapsed = this.forwardIdentityCollapsed(nodes);
        const recovered = this.recoverForwardSelfNodes(nodes);
        const lines = [...nodes, ...recovered]
          .map((node, order) => ({ node, order }))
          .sort((a, b) =>
            a.node.time !== undefined && b.node.time !== undefined
              ? a.node.time - b.node.time || a.order - b.order
              : a.order - b.order,
          )
          .map(({ node }) => (collapsed && !node.named ? node.body : node.line));
        const body = lines.length ? lines.join('\n') : '(转发记录是空的)';
        const header = collapsed
          ? `[系统] #${ofMessageId} 引用的转发消息展开如下(里面的发言人身份没能取到,可能是多个人在说话):`
          : `[系统] #${ofMessageId} 引用的转发消息展开如下:`;
        host.pushEvent({
          type: 'qq.forward',
          ts: nowIso(this.timezone),
          source: this.id,
          text: `${header}\n${body}`,
          meta: { conv, forward_id: resId },
        }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
      },
      (err) => {
        host.pushEvent({
          type: 'qq.forward',
          ts: nowIso(this.timezone),
          source: this.id,
          text: `[系统] #${ofMessageId} 转发的消息没能展开:${err instanceof Error ? err.message : String(err)}`,
          meta: { conv, forward_id: resId },
        }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
      },
    );
  }

  private handleRecall(ev: OneBotEvent, gid: number): void {
    const host = this.host!;
    const conv: Conv = { kind: 'group', id: gid };
    const userId = String(ev.user_id ?? '');
    const name = this.nameByUserId.get(userId) ?? userId;
    const mid = String(ev.message_id ?? '');
    const t = shortTime(this.timezone);
    const tail = this.knownMessages.has(mid) ? `一条消息(#${mid})` : '一条消息';
    host.pushEvent({
      type: 'qq.recall',
      ts: nowIso(this.timezone),
      source: this.id,
      text: `[${this.convLabel(conv)} ${t}] ${name}(${userId}) 撤回了${tail}`,
      senderKey: userId,
      meta: { message_id: ev.message_id, conv },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  private handleMemberChange(ev: OneBotEvent, gid: number, kind: 'join' | 'leave'): void {
    const host = this.host!;
    const conv: Conv = { kind: 'group', id: gid };
    const userId = String(ev.user_id ?? '');
    const name = this.nameByUserId.get(userId) ?? userId;
    const verb = kind === 'join' ? '加入了群' : '退出了群';
    host.pushEvent({
      type: 'qq.member',
      ts: nowIso(this.timezone),
      source: this.id,
      text: `[${this.convLabel(conv)} 系统] ${name}(${userId})${verb}`,
      senderKey: userId,
      meta: { user_id: ev.user_id, conv },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  private handleEmojiLike(ev: OneBotEvent, gid: number): void {
    const host = this.host!;
    const conv: Conv = { kind: 'group', id: gid };
    const userId = String(ev.user_id ?? '');
    const name = this.nameByUserId.get(userId) ?? userId;
    const mid = String(ev.message_id ?? '');
    const t = shortTime(this.timezone);
    const tail = this.knownMessages.has(mid) ? `给#${mid}贴了个表情` : '给一条消息贴了个表情';
    host.pushEvent({
      type: 'qq.emoji',
      ts: nowIso(this.timezone),
      source: this.id,
      text: `[${this.convLabel(conv)} ${t}] ${name}(${userId}) ${tail}`,
      senderKey: userId,
      meta: { message_id: ev.message_id, conv },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  /**
   * 尽力从NapCat戳一戳notify的raw_info里拼出动作文案(如"戳了戳"/"拍了拍");
   * 不同协议端/版本这个字段形状不保证,取不到就退回通用"戳了戳"(防御性解析)。
   */
  private extractPokeAction(rawInfo: unknown): string {
    if (Array.isArray(rawInfo)) {
      const texts = rawInfo
        .map((seg) => (seg && typeof seg === 'object' ? (seg as Record<string, unknown>).txt : undefined))
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
      if (texts.length > 0) return texts.join('').trim();
    }
    return '戳了戳';
  }

  private handlePoke(ev: OneBotEvent, gid: number): void {
    const host = this.host!;
    const conv: Conv = { kind: 'group', id: gid };
    const idn = this.driver?.identity;
    const selfId = idn?.selfId ?? -1;
    const userId = String(ev.user_id ?? '');
    const targetId = String(ev.target_id ?? '');
    const name = this.nameByUserId.get(userId) ?? userId;
    const targetLabel =
      Number(targetId) === selfId
        ? `${idn?.nickname ?? '你'}(你)`
        : `${this.nameByUserId.get(targetId) ?? targetId}(${targetId})`;
    const action = this.extractPokeAction(ev.raw_info);
    const t = shortTime(this.timezone);
    host.pushEvent({
      type: 'qq.poke',
      ts: nowIso(this.timezone),
      source: this.id,
      text: `[${this.convLabel(conv)} ${t}] ${name}(${userId}) ${action} ${targetLabel}`,
      senderKey: userId,
      meta: { user_id: ev.user_id, conv },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  /** 启动时从事件库meta重建 已记录消息索引 与 QQ号→称呼 映射 */
  private rebuildMaps(): void {
    const host = this.host!;
    const events = host.store.range({ source: this.id });
    for (const e of events) {
      const mid = e.meta?.message_id;
      const conv = e.meta?.conv as Conv | undefined;
      if (mid !== undefined && conv && (conv.kind === 'group' || conv.kind === 'private')) {
        this.knownMessages.set(String(mid), {
          conv: { kind: conv.kind, id: Number(conv.id) },
          ts: e.ts,
        });
      }
      const uid = e.meta?.user_id;
      const name = e.meta?.sender_name;
      if (uid !== undefined && typeof name === 'string') {
        this.nameByUserId.set(String(uid), name);
      }
    }
    this.log.debug('映射重建完成', {
      messages: this.knownMessages.size,
      names: this.nameByUserId.size,
    });
  }


  private groupName(gid: number): string {
    return this.driver?.identity?.groups.get(gid)?.groupName ?? String(gid);
  }

  private convLabel(conv: Conv): string {
    return conv.kind === 'group' ? `群「${this.groupName(conv.id)}」` : '私聊';
  }

  private targetDesc(t: Conv): string {
    if (t.kind === 'group') return `群「${this.groupName(t.id)}」`;
    const n = this.nameByUserId.get(String(t.id));
    return n ? `私聊 ${n}` : `私聊 ${t.id}`;
  }

  /**
   * 解析发送目标:显式 to("group:群号"/"private:QQ号",数字寻址,不支持按群名/好友
   * 名匹配——昵称/群名可被随意改,QQ号才是稳定标识),或 to 省略时从 reply_to 引用
   * 的消息推断其所在会话(查 World 自己的消息索引,不经事件库)。
   */
  private resolveTarget(
    toArg: string | undefined,
    replyToMessageId: string | undefined,
  ): Conv | { error: string } {
    if (!toArg && replyToMessageId !== undefined) {
      const known = this.knownMessages.get(replyToMessageId);
      if (known) {
        const t = known.conv;
        // 会话可能已被移出监听名单,不能再往里发
        const watched =
          t.kind === 'group' ? this.watchedGroups.has(t.id) : this.watchedPrivates.has(t.id);
        if (!watched) {
          return { error: `the conversation of #${replyToMessageId} is no longer on the watch list` };
        }
        return t;
      }
      return { error: `no conversation found for #${replyToMessageId}; specify a recipient with to` };
    }
    if (!toArg) {
      return { error: 'specify a recipient: to="group:<id>" or "private:<id>", or use reply_to' };
    }
    const s = toArg.trim();
    const target = parseConversationAddress(s);
    if (target?.kind === 'group') {
      if (!this.watchedGroups.has(target.id)) {
        return { error: `group ${target.id} is not on the watch list` };
      }
      return target;
    }
    if (target?.kind === 'private') {
      if (!this.watchedPrivates.has(target.id)) {
        return { error: `QQ ${target.id} is not on the private watch list` };
      }
      return target;
    }
    return { error: `"${s}" is not a valid target; use to="group:<id>" or "private:<id>" (numeric QQ group/user id, not a name)` };
  }

  /**
   * 校验 reply_to 的平台 message_id 已被记录;是则原样用于引用回复。
   * 消息行首的 `#<message_id>` 直接表示该平台标识。
   */
  private resolveReplyMessageId(replyTo: unknown): { mid?: string } | { error: string } {
    if (replyTo === undefined || replyTo === null || replyTo === '') return {};
    const mid = String(replyTo).trim().replace(/^#/, '');
    if (!this.knownMessages.has(mid)) {
      return { error: `no recorded QQ message with id #${mid}; cannot quote-reply` };
    }
    return { mid };
  }

  /** 实际发送到目标会话,回录 qq.self,返回回执文本 */
  private async sendToTarget(
    target: Conv,
    opts: {
      text: string;
      replyMessageId?: number | string;
      imageRef?: string;
      imageBytes?: Uint8Array;
      voiceRef?: string;
      voiceBytes?: Uint8Array;
    },
  ): Promise<string> {
    const host = this.host!;
    const driver = this.driver!;
    let imageBase64: string | undefined;
    if (opts.imageBytes) {
      imageBase64 = Buffer.from(opts.imageBytes).toString('base64');
    }
    const message = buildOutgoing({
      text: opts.text,
      reply_to_message_id: opts.replyMessageId,
      image_base64: imageBase64,
      ...(opts.voiceBytes ? { record_base64: Buffer.from(opts.voiceBytes).toString('base64') } : {}),
    });
    const action = target.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params =
      target.kind === 'group'
        ? { group_id: target.id, message }
        : { user_id: target.id, message };
    const data = (await driver.callApi(action, params)) as { message_id?: number };
    const messageId = data?.message_id;

    // 回录正文:文字 + (如有)图片标记,保证自己发的图在历史里也可见。
    // 行首保留平台消息号,使历史查询结果可引用自身消息。
    const imgMark = opts.imageRef ? `[图片: ${opts.imageRef}]` : '';
    const voiceMark = opts.voiceRef ? `[语音: ${opts.voiceRef}]` : '';
    const selfBody = [opts.text, imgMark, voiceMark].filter(Boolean).join(' ');
    const selfBlob = opts.imageRef
      ? { handle: opts.imageRef, fallbackText: '你发出的图片' }
      : opts.voiceRef
        ? { handle: opts.voiceRef, fallbackText: '你发出的语音' }
        : null;
    const idTag = messageId !== undefined ? `#${messageId} ` : '';
    const env = await host.pushEvent(
      {
        type: 'qq.self',
        ts: nowIso(this.timezone),
        source: this.id,
        text: `${idTag}[${this.convLabel(target)} ${shortTime(this.timezone)}] 你: ${selfBody}`,
        // 发出去的图和语音按句柄附在自己这条记录上:时间线与吃这些类型的模型都看得到发了什么
        ...(selfBlob ? { blobs: [selfBlob] } : {}),
        senderKey: String(driver.identity?.selfId ?? 'self'),
        meta: {
          message_id: messageId,
          user_id: driver.identity?.selfId,
          sender_name: driver.identity?.nickname,
          conv: target,
        },
      },
      { deliver: false },
    );
    // 自己发出去的也进索引:可以引用回复自己刚说过的话
    if (messageId !== undefined) {
      this.knownMessages.set(String(messageId), { conv: target, ts: env.ts });
    }
    return `[sent${messageId !== undefined ? ` #${messageId}` : ''} → ${this.targetDesc(target)}]`;
  }


  tools(): ToolDef[] {
    const list = [
      this.draftTool(),
      this.confirmTool(),
      ...createHistoryTools({ source: this.id, host: () => this.host }),
    ];
    // 看图追问依赖 IMG-N(外挂视觉),随视觉出现/消失
    if (this.vision) list.push(this.viewImageTool());
    return list;
  }

  private draftTool(): ToolDef {
    return {
      name: 'qq_draft',
      description:
        'Stage a QQ message without sending. This ends the current tool sequence so you can review the draft and any newly arrived user events once before calling confirm (send or cancel). An unconfirmed draft is discarded at end of turn.',
      tags: ['speak'],
      barrierAfter: true,
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'Target conversation: "group:<id>" or "private:<id>" (numeric QQ group/user id, not a name). Optional when reply_to is given (taken from the quoted message).',
          },
          text: { type: 'string', description: 'Message text. Optional if image is given.' },
          image: {
            type: 'string',
            description:
              'Optional. An image to send, given by handle: a log: handle from a [blob ...] line you saw, '
              + 'or a mem: handle of one kept in your workspace.',
          },
          voice: {
            type: 'string',
            description:
              'Optional. Audio to send as a QQ voice bar, given by handle the same way as image. '
              + 'A voice bar is a message of its own: leave text, image and reply_to out. '
              + 'The protocol end converts the audio it accepts (wav, mp3) to what QQ plays.',
          },
          reply_to: {
            type: 'string',
            description:
              'Optional. The QQ message id to quote-reply — the `#<id>` shown at the start of that message line.',
          },
        },
        required: [],
      },
      handler: async (args, ctx) => {
        const host = this.host;
        const driver = this.driver;
        if (!host || !driver) return '[tool failed] QQ module not started';
        const rawText = typeof args.text === 'string' ? args.text : '';
        const imageArg =
          typeof args.image === 'string' && args.image.trim() ? args.image.trim() : undefined;
        const voiceArg =
          typeof args.voice === 'string' && args.voice.trim() ? args.voice.trim() : undefined;
        if (!rawText.trim() && !imageArg && !voiceArg) return '[bad input] provide at least one of text, image or voice';
        if (voiceArg && (rawText.trim() || imageArg || (args.reply_to !== undefined && args.reply_to !== null && String(args.reply_to) !== ''))) {
          return '[bad input] a voice bar is a message of its own; it carries no text, image or quote-reply';
        }
        // 纯空白正文视为不带字(避免只发图时混进一个空白 text 段)
        const text = rawText.trim() ? rawText : '';

        const toArg = typeof args.to === 'string' && args.to.trim() ? args.to.trim() : undefined;
        const replyToId =
          args.reply_to !== undefined && args.reply_to !== null && String(args.reply_to) !== ''
            ? String(args.reply_to).trim().replace(/^#/, '')
            : undefined;

        const target = this.resolveTarget(toArg, replyToId);
        if ('error' in target) return `[send failed] ${target.error}`;

        const rep = this.resolveReplyMessageId(args.reply_to);
        if ('error' in rep) return `[send failed] ${rep.error}`;

        // 引用回复必须与发送目标同会话(否则 reply 段带的是别会话的 message_id)
        if (replyToId !== undefined) {
          const replyConv = this.knownMessages.get(replyToId)?.conv;
          if (replyConv && !sameConversation(replyConv, target)) {
            return `[send failed] #${replyToId} is not in ${this.targetDesc(target)}; cannot quote-reply across conversations`;
          }
        }

        // 图片:按句柄确认取得到,并按字节内容弹出已有的识别描述作为preview(省一次qq_view_image)
        let imageRef: string | undefined;
        let previewLine = '';
        if (imageArg) {
          const got = host.blob(imageArg);
          if (!got) return `[send failed] no blob for ${imageArg}; use a log: handle from a [blob ...] line or a mem: handle from your workspace`;
          if (!got.mime.startsWith('image/')) return `[send failed] ${imageArg} is ${got.mime}, not an image`;
          imageRef = imageArg;
          const desc = this.vision?.descriptionByHash(createHash('sha256').update(got.bytes).digest('hex'));
          previewLine = desc
            ? `[will send image: ${imageArg} — cached description: ${desc}]`
            : `[will send image: ${imageArg}]`;
        }

        // 语音:同样按句柄确认取得到,MIME 必须是音频
        let voiceRef: string | undefined;
        if (voiceArg) {
          const got = host.blob(voiceArg);
          if (!got) return `[send failed] no blob for ${voiceArg}; use a log: handle from a [blob ...] line or a mem: handle from your workspace`;
          if (!got.mime.startsWith('audio/')) return `[send failed] ${voiceArg} is ${got.mime}, not audio`;
          voiceRef = voiceArg;
          previewLine = `[will send voice: ${voiceArg}]`;
        }

        this.pendingDraft = { target, text, replyMessageId: rep.mid, imageRef, voiceRef };

        // 排出当下已积、尚未投递的QQ会话事件(consume-once)。正文不能伪装成
        // draft 工具结果:交回 loop 按常规投递,本轮下一次推理前它们就在眼前,
        // 要不要据此改口由 agent 决定。
        const drained = await host.drainPendingEvents((e) => e.source === this.id);
        ctx.queueExternalEvents?.(drained);

        const lines = [`[draft staged → ${this.targetDesc(target)}]`];
        lines.push(text.trim() ? `Text: ${text}` : voiceRef ? '(voice bar, no text)' : '(image only, no text)');
        if (previewLine) lines.push(previewLine);
        lines.push(
          '',
          drained.length > 0
            ? `${drained.length} message(s) arrived while staging; they are queued for delivery.`
            : 'No messages arrived while staging.',
          'Review once, then call confirm(decision="send") to send or confirm(decision="cancel") to discard. An unconfirmed draft is dropped at end of turn.',
        );
        return lines.join('\n');
      },
    };
  }

  private confirmTool(): ToolDef {
    return {
      name: 'qq_confirm',
      description:
        'Act on the last draft: decision="send" sends it, decision="cancel" discards it. Only the most recent draft can be confirmed.',
      tags: ['speak'],
      parameters: {
        type: 'object',
        properties: {
          decision: {
            type: 'string',
            enum: ['send', 'cancel'],
            description: '"send" or "cancel".',
          },
        },
        required: ['decision'],
      },
      handler: async (args) => {
        const host = this.host;
        const driver = this.driver;
        if (!host || !driver) return '[tool failed] QQ module not started';
        const draft = this.pendingDraft;
        if (!draft) return '[no draft to confirm; draft one first]';

        if (args.decision === 'cancel') {
          this.pendingDraft = null;
          return `[draft discarded (${this.targetDesc(draft.target)})]`;
        }
        if (args.decision === 'send') {
          try {
            // 发送时才把字节取回来(草稿只记引用;取消的草稿一次都不读)
            let imageBytes: Uint8Array | undefined;
            if (draft.imageRef) {
              const got = host.blob(draft.imageRef);
              if (!got) return `[send failed] blob ${draft.imageRef} is gone (draft kept)`;
              imageBytes = got.bytes;
            }
            let voiceBytes: Uint8Array | undefined;
            if (draft.voiceRef) {
              const got = host.blob(draft.voiceRef);
              if (!got) return `[send failed] blob ${draft.voiceRef} is gone (draft kept)`;
              voiceBytes = got.bytes;
            }
            const receipt = await this.sendToTarget(draft.target, {
              text: draft.text,
              replyMessageId: draft.replyMessageId,
              imageRef: draft.imageRef,
              imageBytes,
              voiceRef: draft.voiceRef,
              voiceBytes,
            });
            this.pendingDraft = null; // 成功才清;失败保留草稿,可再 confirm 重试
            return receipt;
          } catch (e) {
            return `[send failed] ${e instanceof Error ? e.message : String(e)} (draft kept; confirm again to retry or cancel)`;
          }
        }
        return '[bad input] decision must be send or cancel';
      },
    };
  }

  private viewImageTool(): ToolDef {
    return {
      name: 'qq_view_image',
      description: 'Ask the auxiliary vision model a specific question about an image.',
      tags: ['read'],
      parameters: {
        type: 'object',
        properties: {
          image_id: { type: 'string', description: 'Image id, e.g. IMG-3.' },
          prompt: { type: 'string', description: 'Your question about the image.' },
        },
        required: ['image_id', 'prompt'],
      },
      handler: async (args) => {
        const vision = this.vision;
        if (!vision) return '[tool failed] auxiliary vision not configured';
        const id = normalizeImageId(String(args.image_id ?? ''));
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        if (!prompt) return '[bad input] prompt must not be empty';
        if (!vision.hasImage(id)) {
          return `[bad input] image ${id} not found (may be from an earlier run or cleared)`;
        }
        try {
          return await vision.ask(id, prompt);
        } catch (e) {
          return `[tool failed] ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    };
  }
}

function extractImageUrl(data: Record<string, unknown>): string {
  if (typeof data.url === 'string' && data.url) return data.url;
  if (typeof data.file === 'string' && data.file) return data.file;
  return '';
}

/** 渲染阶段的 GIF 提示仅依据 url/file 的 .gif 后缀。 */
function looksLikeGif(data: Record<string, unknown>): boolean {
  const gifExt = /\.gif(\?|#|$)/i;
  const url = typeof data.url === 'string' ? data.url : '';
  const file = typeof data.file === 'string' ? data.file : '';
  return gifExt.test(url) || gifExt.test(file);
}

/** 归一化主agent写的图片ID:"IMG-3"/"img3"/"3" → "IMG-3" */
function normalizeImageId(raw: string): string {
  const m = raw.match(/(\d+)/);
  return m ? `IMG-${m[1]}` : raw.trim();
}
