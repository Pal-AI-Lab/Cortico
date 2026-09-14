import { message, record, functionCall, functionResult, responseRecords, itemText, withText, type ContextRecord } from '../protocol/open-responses/context.ts';
import { hasRole, textOf, withoutPastReasoning, responseRequest, usageCounters } from '../protocol/open-responses/context-helpers.ts';
import type { Response, StreamEvent } from '../protocol/open-responses/index.ts';
import { GenerationError, type ResponseClient, type TokenMeters } from './generation.ts';
/**
 * MainLoop:接收事件投递的那个常驻session的循环(Persona声明里
 * receivesEvents=true 的那一个)。
 *
 * 内部系统文本(boot/tick/闹钟/Persona注入)一律走 user 消息。外部正文落在哪个区
 * 由 session 声明的 eventDelivery 决定,两种都在 deliverBatch 里:
 *  - `tool`(默认):补一对伪造的 external_event_frame 调用/回执,正文落在回执里。
 *    user 区因此只装内部系统文本;外部正文无法进入 system role。
 *  - `user`:正文当场打包进同一条 user 消息(Persona显式放弃上面那条边界)。
 *
 * 没有tool_calls的assistant响应自然结束回合,主循环挂起等下一批;声明了
 * endsTurn 的工具执行完同样结束回合——显式收工(工具由Persona自行声明)。
 *
 * 上下文交接在这里只保留机械半:物理钳制(估算越过预算即强制交接)、
 * 稳定回合边界取快照、事务期间不投递、尾部配对修复与预算钳制、原子重写、
 * 并发请求合并为单次事务。压力预警与"何时主动交接"是Persona在 onBatchEnd
 * 时机里的裁量;"在那个边界上做什么"由 persona.onHandoff 决定。
 */
import type {
  CandidateEventSpec,
  CandidateProjector,
  CandidateProjectionEvent,
  CoreConfig,
  ContextHandoffResult,
  DeferredEventSpec,
  EventEnvelope,
  FrameEventRef,
  EventStore,
  BlobInput,
  BlobRef,
  DeferredRendered,
  World,
  LLMUsage,
  Logger,
  ModelSpec,
  Persona,
  SessionDecl,
  SessionOpeningReason,
  ToolCallContext,
  ToolDef,
  ToolOutcome,
  ToolSchema,
  ToolTag,
  WakeItem,
} from './types.ts';
import type { WakeBus } from './bus.ts';
import type { SessionLog } from './session.ts';
import type { CoreState } from './state.ts';
import type { SessionHandle, SessionTracker } from './sessions.ts';
import { assembleSystem, type EnvPromptDirs } from './prefix.ts';
import { recordToolCall, type ToolCallLog } from './tool-log.ts';
import type { Transcript } from './transcript.ts';
import { setAnchors, withAnchors } from './log-context.ts';
import { withBlobLines } from './blobs.ts';
import {
  MISSING_RESULT_RESTART,
  NOT_EXECUTED_BARRIER,
  NOT_EXECUTED_INCOMPLETE,
  NOT_EXECUTED_LOOP_STOPPED,
  NOT_EXECUTED_STREAM_ABORTED,
  SHUTDOWN_INTERRUPTED,
  TOOL_FAILED_BAD_ARGS,
  UNKNOWN_TOOL,
  eventFrameHeader,
  toolFailed,
} from './markers.ts';
import { fixPairing, rebuildTail } from './truncate.ts';

import { nowIso, prefixFingerprint, renderEventLines } from './util.ts';


/**
 * 已挂载 World 的实时视图。
 *
 * 可见性只关系到**对 agent 的三要素**(前缀环境提示词 / 工具 / 事件投递),不关系到
 * World 进不进程——被隐藏的 World 照常运行,连接和自带 loop 都不断。
 *
 * 前两项同属每次请求的**缓存前缀**,必须在重建前缀时一起更新。单独移除工具会使
 * 前缀继续描述已不存在的工具。
 * 第三项(投递)不进请求,立即生效且没有缓存代价。
 */
export interface WorldView {
  /** 全部已挂载 World(含被隐藏的) */
  all(): World[];
  /** 当前对 agent 可见的 World */
  visible(): World[];
}

/** 一个 World 此刻交出的工具名(前缀漂移的判据之一) */
function toolSignature(mod: World): string {
  return mod
    .tools()
    .map((t) => t.name)
    .join(',');
}

/**
 * 主 session 的上下文事实与计数口径。由 core 按当前 provider 现读——模型与端点
 * 都可热改,不做启动期快照。
 */
export interface ContextFacts {
  /**
   * 一次请求能收的输入上限(token):生效窗口减单轮生成上限。窗口未知则 null,
   * 此时没有物理钳制,只剩上游拒绝请求那一道兜底。
   */
  hardTokens(): number | null;
  /** 上游还没数过的条目的本地估算(Provider 模块的估算函数,缺席时为字数比例估算)。 */
  estimateTokens(records: readonly ContextRecord[]): number;
  /** 上游拒绝请求的原因是输入超过模型上下文。 */
  contextOverflow(error: GenerationError): boolean;
}

export interface MainLoopDeps {
  cfg: CoreConfig;
  llm: ResponseClient;
  persona: Persona;
  /** 本循环所跑的那个session声明(轮数上限/工具集都从这里实时读) */
  decl: SessionDecl;
  /** 当前活跃端点的模型档。模型归 Provider,不按 session 分岔;每轮现读。 */
  spec: () => ModelSpec;
  context: ContextFacts;
  /** 记录落库刻的附件内部化(新字节进日志附件库、已有句柄补 mime);core 提供 */
  blobs: { intern(inputs: readonly (BlobInput | BlobRef)[] | undefined): BlobRef[] | undefined };
  /** 已挂载 World 的**实时**视图(可见性可被运维改;见 WorldView) */
  worlds: WorldView;
  /** bot 目录:bot 侧的环境提示词覆盖文件在这下面找(见 prefix.ts)。 */
  /** 环境提示词的两个覆盖层(包 / 部署);缺席 = 只用 World 自带的模板。 */
  dirs?: EnvPromptDirs;
  bus: WakeBus;
  session: SessionLog;
  store: EventStore;
  state: CoreState;
  log: Logger;
  /** session观察注册表(web面板数据源;可选,不接不影响主循环) */
  tracker?: SessionTracker;
  /** 模型工具调用流水(可选;不接则不落盘) */
  toolLog?: ToolCallLog;
  /** 主 session 的只追加副本;交接、清空、前缀重载在这里留边界记录 */
  transcript?: Transcript;
  /** 工具归属的 World id(工具流水的 mod 列);认不出的是Persona自己的工具 */
  toolOwner?: (name: string) => string | undefined;
  /** 同一唤醒批内 LLM 失败后的续拍预算;缺席用 DEFAULT_RESUBMIT。 */
  resubmit?: ResubmitPolicy;
}

/**
 * 同一唤醒批内 LLM 失败后的续拍预算。续拍 = 已落库的 partial 与机械回执之后再采一次,
 * 上下文不重写,模型看着自己的半句话接着说。可续拍的失败:流内失败与空闲超时(status 0)、
 * 429、5xx;上游说输入超长走交接,其余 4xx、抢占、关机与硬轮数上限不续拍。
 */
export interface ResubmitPolicy {
  /** 连续失败到第几次仍续拍:2 = 第 1、2 次失败后各续拍一次,第 3 次失败收束本批。 */
  maxConsecutive: number;
  /** 一批内的续拍总数上限。 */
  maxPerBatch: number;
  /** 第 n 次连续失败后的等待毫秒数,超出长度取最后一档。 */
  backoffMs: readonly number[];
}
export const DEFAULT_RESUBMIT: ResubmitPolicy = { maxConsecutive: 2, maxPerBatch: 4, backoffMs: [2_000, 10_000] };

/** 单条工具回执超过此长度记 warn。体积归 World 管,core 只观测,不截断。 */
const LARGE_RESULT_WARN_CHARS = 8_000;

export interface LoopStatus {
  running: boolean;
  /** 正在执行上下文交接事务(取快照 → Persona策略 → 重建 → 唤醒)。 */
  truncating: boolean;
  messageCount: number;
  /** 下一次请求的输入 token 数(上游计数锚点 + 新增条目估算;无锚点时整份估算)。 */
  estTokens: number;
  context: {
    /** 一次请求能收的输入上限;窗口未知时 null。 */
    hardTokens: number | null;
    /** estTokens 里上游数过的那部分;整份估算时 0。 */
    countedTokens: number;
    keepPastThinking: boolean;
  };
  batchesHandled: number;
  roundsLastBatch: number;
  lastTruncateAt: string | null;
  /** 人工暂停中(控制台;事件照常落库排队,不投递) */
  paused: boolean;
  /** schedule_wake(block=true) 的临时投递闸门正在生效。 */
  scheduleBlocked: boolean;
  lastUsage: LLMUsage | null;
  /** 投递水位：最后一条已投递或已了结事件的位置游标。 */
  lastDeliveredCursor: number;
  /** 水位之后该进上下文却还没投递的外部事件数。 */
  behind: number;
}

/**
 * 外部正文所挂的保留帧名。core 合成的投递帧用它;它不是工具、没有 schema、
 * 不进工具表。模型看着满屏合成帧难免仿造一次——仿造的调用在落 session 前被整个
 * 丢弃,只按名字判,参数与 id 一概不看。
 */
const EXTERNAL_EVENT_FRAME = 'external_event_frame';
/** 卡住时刻表的保留窗口:够静默提醒(最长一级 600s)问,也够恢复告知用 */
const STALL_WINDOW_MS = 3_600_000;
/**
 * LLM 连续失败达到此次数时报告 error，恢复后解除告警。该阈值仅控制告警，不改变重试节奏。
 */
const STALL_ALERT_THRESHOLD = 5;
/** 保留帧名集合:这些名字不能被注册成工具,模型仿造的同名调用也不落 session。 */
export const RESERVED_FRAME_NAMES = new Set<string>([EXTERNAL_EVENT_FRAME]);

/**
 * 帧 sidecar:每条事件在正文里的位置。正文是 renderEventLines 的产物(各事件 text 用
 * 换行拼接),base 是事件块在整条正文里的起点。
 */
function frameEventRefs(events: EventEnvelope[], base: number): FrameEventRef[] {
  let start = base;
  return events.map((e) => {
    const ref: FrameEventRef = { cursor: e.cursor, ts: e.ts, type: e.type, source: e.source, start, chars: e.text.length };
    if (e.tags?.length) ref.tags = e.tags;
    start += e.text.length + 1;
    return ref;
  });
}

/** 一批事件携带的媒体引用,按事件顺序拼接;事件正文的顺序就是分片的顺序。 */
function eventBlobs(events: readonly EventEnvelope[]): BlobRef[] {
  return events.flatMap((e) => e.blobs ?? []);
}

/**
 * 重启补投的入队条数上限。超限时保留最近事件，更早事件按上一世代已了结推进水位。
 */
const MAX_REQUEUE = 200;

/**
 * 运行期水位自检周期；检查只报告停滞事实，不自动修复。
 */
const WATERMARK_AUDIT_INTERVAL_MS = 120_000;
/**
 * 水位停滞阈值为 5 分钟，为当前模型轮与分钟级工具执行留出时间。配合 2 分钟巡查周期，发现延迟最多约 7 分钟。
 */
const WATERMARK_STALL_MS = 300_000;
/**
 * 同一投递水位的停滞告警，在首报后 15 分钟和 1 小时各重报一次。
 */
const WATERMARK_RESTATE_MS = [15 * 60_000, 60 * 60_000] as const;

/** 投递成文渲染的 deadline;超时按蒸发处理。IPC 现拿快照是毫秒级,3s 已很宽。 */
const RENDER_DEADLINE_MS = 3000;
/** renderDeferred 超时哨兵(render 合法返回 null,不能拿 null 当超时信号) */
const RENDER_TIMED_OUT = Symbol('render-timed-out');

interface PreparedCandidateProjection {
  source: string;
  origin: EventEnvelope['origin'];
  event: CandidateProjectionEvent;
  sourceCursors: number[];
}

export class MainLoop {
  private d: MainLoopDeps;
  private running = false;
  private stopFn: (() => void) | null = null;
  private toolDefs: ToolDef[] = [];
  private batchesHandled = 0;
  private roundsLastBatch = 0;
  /** 跨唤醒批次单调递增的轮序号;每建一份工具 ctx 加一,透传给 ToolCallContext.round */
  private roundSeq = 0;
  private lastUsage: LLMUsage | null = null;
  /** 主session的观察句柄(tracker未接线时null) */
  private mainTrack: SessionHandle | null = null;
  /** 截断是单实例事务；手动触发和阈值检查并发时复用同一个Promise。 */
  private truncatePromise: Promise<void> | null = null;
  /** 截断与前缀重载共用的维护串行链，避免两个 session.reset 互相覆盖。 */
  private maintenanceChain: Promise<void> = Promise.resolve();
  private prefixReloadPromise: Promise<void> | null = null;
  /** 在一轮处理中请求重载时，等自然回合边界再释放。 */
  private releasePrefixReload: (() => void) | null = null;
  /** 当前正在处理一个事件批；手动交接必须等到该批自然结束，不能重置半轮session。 */
  private processingBatch = false;
  private handoffRequested = false;
  /**
   * onDelivery 钩子执行期的注入收编器:非 null 时,injectInternal 的即时项进这里
   * 而不是总线,随本批原子投递。
   */
  private deliveryCollector: EventEnvelope[] | null = null;
  /** 已投递但前面仍有外部缺口的游标；水位只越过连续前缀。 */
  private readonly deliveredCursors = new Set<number>();
  /**
   * 已被 projector 处理的原始归档位置游标，包括被投影引用和被策略丢弃的候选。
   * 未处理的 archive-only 必须挡住连续水位；该集合仅存内存，重启时由 requeueUndelivered 按投影引用重建。
   */
  private readonly settledArchives = new Set<number>();
  /**
   * 最近一小时的 LLM 失败时刻，单位为毫秒。账本保存在 state.data.llmStall，跨重启保留；恢复时通知Persona， World 可按窗口查询。
   */
  private get stallAt(): number[] { return this.d.state.data.llmStall.at; }
  /** 当前这串连续失败的第一次发生时刻;0 = 此刻没在失败串里 */
  private get stallSince(): number { return this.d.state.data.llmStall.since; }
  private set stallSince(at: number) { this.d.state.data.llmStall.since = at; }
  /** 当前这串连败是否已发过操作员告警;true 期间不重复响,恢复时发解除 */
  private stallAlarmActive = false;
  /** 水位自检的巡查定时;run() 布防、stop() 撤防。 */
  private watermarkAudit: ReturnType<typeof setInterval> | null = null;
  /**
   * 已经报过停滞的那个水位值;-1 = 此刻没在报过的停滞里。用水位值做节流键:
   * 水位没动 = 同一次停滞;水位动了 = 上一次已解除。同一次停滞不再是永久静音,
   * 按 WATERMARK_RESTATE_MS 退避重报。
   */
  private watermarkStallAt = -1;
  /** 当前这次停滞的首报时刻(退避重报的基准) */
  private watermarkStallSince = 0;
  /** 首报时的落后量(重报带增量:「停滞越久越该说话」的证据) */
  private watermarkStallBehind = 0;
  /** 同一次停滞已报次数(首报计 1) */
  private watermarkStallReports = 0;
  /**
   * 上游计数锚点:上一发成功调用的输入加输出 token 数,覆盖到 session 的前
   * `records` 条(含那一发的 assistant 输出)。之后新增的条目只能本地估算,
   * 下一发成功即重锚。session 整体重写(交接/清空/前缀重载)后作废。
   */
  private anchor: { records: number; tokens: number; reasoningTokens: number } | null = null;
  /** 当前 system 前缀和工具表采用的可见 World 集合。 */
  private appliedVisibleWorlds: Set<string> | null = null;
  /** 当前前缀中各可见 World 的工具签名，用于检测工具表漂移。 */
  private appliedWorldTools = new Map<string, string>();
  /**
   * 合成首轮对话(风格锚)的消息缓存。随 system 前缀一起刷新(编辑→重载生效),
   * 请求间字节恒定——它紧跟 system,是缓存前缀的自然延长。
   */
  private firstTurnMsgs: ContextRecord[] = [];
  /** 当前模型轮；非 reasoning 增量一旦外流，本轮不再接受自动抢占。 */
  private currentRound: {
    controller: AbortController;
    externalized: boolean;
    abortReason: 'preempt' | 'shutdown' | null;
  } | null = null;
  /** 每次 stop 都使此前捕获的异步 continuation 永久失效。 */
  private generation = 0;
  private stopped = false;
  /** 主循环退出或 drain 超时后封住持久化出口，迟到的 provider/tool promise 只能在内存中结束。 */
  private sealed = false;
  /** 已落库、但尚未配齐结果的当前 assistant 工具调用。 */
  private pendingToolCalls = new Set<string>();
  /** 续拍退避等待的提前唤醒;stop() 调它,等待立即结束并由 active() 判定退出。 */
  private backoffWake: (() => void) | null = null;
  /**
   * 关机信号:stop() 触发一次。工具 ctx.signal 由它与本轮 flight 信号合成——flight 只在
   * 尚未外化时被抢占取消,那时没有工具在跑;工具执行期间能触发 abort 的只有关机与换代。
   */
  private readonly shutdown = new AbortController();

  constructor(deps: MainLoopDeps) {
    this.d = deps;
    deps.session.onReset(() => { this.anchor = null; });
  }

  private active(generation: number): boolean {
    return !this.stopped && !this.sealed && this.generation === generation;
  }

  private activeNow(): boolean {
    return this.active(this.generation);
  }

  /** 取消仍处于思考/prefill 阶段的模型轮。返回 false 表示没有免费抢占窗口。 */
  abortCurrentRound(): boolean {
    if (!this.activeNow()) return false;
    const round = this.currentRound;
    if (!round || round.externalized) return false;
    round.abortReason = 'preempt';
    round.controller.abort(new Error('模型轮被新输入抢占'));
    return true;
  }

  /**
   * session 声明是 schema 与 handler 的权威来源。core 仅执行去重、稳定排序和
   * 隐藏 World 过滤。
   *
   * 摘除按**工具名**做:World 工具名同时承担归属标记。
   * World 之间、World 与 Persona 自有工具(`Persona.ownToolNames`)或保留帧名的重名由
   * 装配层拒绝挂载(`WorldAssembly`);Persona 不报自有工具名时这里留先到的并告警。
   */
  private assembleTools(hiddenToolNames: Set<string>): void {
    const { decl, log } = this.d;
    const defs: ToolDef[] = [];
    const seen = new Set<string>();
    for (const def of decl.tools()) {
      if (RESERVED_FRAME_NAMES.has(def.name)) {
        // 保留帧名不许被注册成真工具:同名调用会在落 session 前被丢弃逻辑误吃
        log.warn(`工具名与保留帧撞名,拒绝注册: ${def.name}`);
        continue;
      }
      if (hiddenToolNames.has(def.name)) continue;
      if (seen.has(def.name)) {
        log.warn(`工具重名,跳过后者: ${def.name}`);
        continue;
      }
      if (def.tags.length === 0 && !this.warnedUntagged.has(def.name)) {
        this.warnedUntagged.add(def.name);
        log.warn(`工具未分类(tags为空,不参与任何tag过滤): ${def.name}`);
      }
      seen.add(def.name);
      defs.push(def);
    }
    this.toolDefs = defs;
  }

  /** 空tags只提醒一次,别在每次前缀重建时刷屏 */
  private readonly warnedUntagged = new Set<string>();

  /**
   * 把当前可见性烘进工具表,并记下烘的是哪一组。重启恢复不重建前缀,
   * 仍通过此步骤按可见性装配工具表。
   */
  private bindWorlds(): World[] {
    const { worlds } = this.d;
    const visible = worlds.visible();
    const visibleIds = new Set(visible.map((m) => m.id));
    const hiddenToolNames = new Set(
      worlds
        .all()
        .filter((m) => !visibleIds.has(m.id))
        .flatMap((m) => m.tools().map((t) => t.name)),
    );
    this.assembleTools(hiddenToolNames);
    this.appliedVisibleWorlds = visibleIds;
    this.appliedWorldTools = new Map(visible.map((m) => [m.id, toolSignature(m)]));
    return visible;
  }

  /**
   * 组装 system 前缀,并在同一时刻换成匹配的工具表。两者同属请求缓存前缀,
   * 必须同步更新。
   */
  private async buildSystem(): Promise<ContextRecord> {
    const { persona, cfg, dirs } = this.d;
    const content = await assembleSystem({
      persona,
      worlds: this.bindWorlds(),
      now: new Date(),
      timezone: cfg.timezone,
      dirs,
    });
    this.refreshFirstTurn();
    return message('system', content);
  }

  /** 重读合成首轮对话内容。user 或 reply 为空白的轮次机械跳过。 */
  private refreshFirstTurn(): void {
    const { persona, log } = this.d;
    const out: ContextRecord[] = [];
    try {
      for (const round of persona.firstTurn?.() ?? []) {
        const user = round.user.trim();
        const reply = round.reply.trim();
        const thinking = round.thinking?.trim();
        if (!user || !reply) continue;
        out.push(message('user', user, { firstTurn: true }));
        if (thinking) out.push(record({ type: 'reasoning', id: `rs_first_${out.length}`, summary: [], content: [{ type: 'reasoning_text', text: thinking }] }, { firstTurn: true }));
        out.push(message('assistant', reply, { firstTurn: true }));
      }
    } catch (e) {
      log.warn('firstTurn内容读取失败,本次不注入', { err: e });
    }
    this.firstTurnMsgs = out;
  }

  /**
   * 出线态:落盘态(session.records)在 system 头之后插入合成首轮对话。
   * 发请求、Persona拿到的快照都是这个口径——继承快照的 fork 因此与主 session
   * 字节前缀一致,前缀缓存照蹭。开关关或内容空时与落盘态相同(总是复制)。
   */
  outboundMessages(): ContextRecord[] {
    const msgs = this.d.session.records;
    const first = this.activeFirstTurn();
    if (first.length === 0) return [...msgs];
    let head = 0;
    while (head < msgs.length && hasRole(msgs[head], 'system')) head++;
    return [...msgs.slice(0, head), ...first, ...msgs.slice(head)];
  }

  /** 当前生效的合成首轮对话(开关关或内容空=空数组)。控制台的出线态标注用它。 */
  activeFirstTurn(): ContextRecord[] {
    if (!this.d.cfg.context.firstTurn) return [];
    return [...this.firstTurnMsgs];
  }

  /**
   * 当前前缀与 World 现状是否不一致。控制台据此提示人工重载;
   * 每次重载丢一次前缀缓存。
   *
   * 两种漂移:运维改了可见性,或 World 自己开关掉了一部分功能(工具名变了)。
   * 后者按工具名判定——一个 World 撤下工具时,它的环境提示词一般同时改,而工具名是
   * 同步可读的,环境提示词不是。
   */
  modulePrefixDrift(): string[] {
    const applied = this.appliedVisibleWorlds;
    if (!applied) return [];
    const visible = new Map(this.d.worlds.visible().map((m) => [m.id, m]));
    return this.d.worlds
      .all()
      .map((m) => m.id)
      .filter((id) => {
        const mod = visible.get(id);
        if (applied.has(id) !== !!mod) return true;
        return !!mod && this.appliedWorldTools.get(id) !== toolSignature(mod);
      });
  }

  /** 工具回执落库:附件内部化,每份的文本形态接在正文后。 */
  private toolResult(callId: string, out: ToolOutcome): ContextRecord {
    const blobs = this.d.blobs.intern(out.blobs);
    return functionResult(callId, withBlobLines(out.text, blobs), blobs ? { blobs } : {});
  }

  /** 时机:一轮自然收束。先Persona,再可见 World(World 用它清理只在本轮有效的暂态)。 */
  private finishTurn(): void {
    if (!this.activeNow()) return;
    const { persona, worlds, log } = this.d;
    try {
      persona.onTurnEnded?.();
    } catch (e) {
      log.warn('onTurnEnded钩子异常', { err: e });
    }
    for (const m of worlds.visible()) {
      try {
        m.onTurnEnded?.();
      } catch (e) {
        log.warn('World 回合收束钩子异常', { id: m.id, err: e });
      }
    }
  }

  /** 外部正文落在上下文的哪个区(声明里没写=工具回执区)。 */
  private eventDelivery(): 'tool' | 'user' {
    return this.d.decl.eventDelivery ?? 'tool';
  }

  /**
   * 一批唤醒项进入主session。
   *
   * 投递成文项与候选投影在此刻落库，固定排在即时项之后。projector 先看到
   * 当前批的全部同源票据，选中项与 deferred 再按源票据顺序成文。
   *
   * 成文完毕后触发 onDelivery 时机钩子:Persona看到本批全部信封,钩子期间
   * 注入的即时项收编进本批(排在既有内部行之后、外部正文之前)。抬头、回忆
   * 这类话语都是它在钩子里注入的——core 一个字不写。
   *
   * 内部项的文本合成一条 user 消息;外部正文按声明落在哪个区:`tool` 模式下
   * 紧跟着补一对伪造的 external_event_frame 调用/回执(user 区因此只装内部
   * 系统文本),`user` 模式下正文并进同一条 user 消息。
   */
  private async deliverBatch(batch: WakeItem[], generation: number): Promise<boolean> {
    if (!this.active(generation)) return false;
    const { session, persona, store, cfg, log } = this.d;
    const projections = this.prepareCandidateProjections(batch, generation);
    if (!this.active(generation)) return false;
    // projector 已经过过手的候选一律记为了结:选中的马上就有投影引用它,没选中的
    // 是 World 按自己的策略丢的,两种都不必再等。没过手的(还在批窗口里)不在这里,
    // 水位也就跨不过去。
    for (const item of batch) {
      for (const event of item.candidate?.sourceEvents ?? []) this.settledArchives.add(event.cursor);
    }
    const delivered: EventEnvelope[] = [];
    for (const item of batch) {
      if (item.event) delivered.push(item.event);
    }
    for (let index = 0; index < batch.length; index++) {
      for (const projection of projections.get(index) ?? []) {
        delivered.push(store.append({
          ...projection.event,
          ts: nowIso(cfg.timezone),
          source: projection.source,
          origin: projection.origin,
          contextDelivery: 'deliver',
          meta: {
            ...projection.event.meta,
            sourceCursors: projection.sourceCursors,
          },
        }));
      }
      const deferred = batch[index].deferred;
      if (!deferred) continue;
      const rendered = await this.renderDeferred(deferred, generation);
      if (!this.active(generation)) return false;
      if (rendered === null) continue; // 蒸发:不落库不投递
      const body = typeof rendered === 'string' ? { text: rendered } : rendered;
      const blobs = this.d.blobs.intern(body.blobs);
      delivered.push(store.append({
        type: deferred.type,
        ts: nowIso(cfg.timezone),
        source: deferred.source,
        origin: deferred.origin,
        contextDelivery: 'deliver',
        text: withBlobLines(body.text, blobs),
        ...(blobs ? { blobs } : {}),
        senderKey: deferred.senderKey,
        meta: deferred.meta,
        tags: deferred.tags,
      }));
    }
    if (!this.active(generation)) return false;
    if (delivered.length > 0) {
      // 时机钩子:钩子体内的即时注入进收编器,不进总线(scoped 捕获,并发到达的
      // 无关项不会被误收进本批)。
      const injected: EventEnvelope[] = [];
      this.deliveryCollector = injected;
      try {
        persona.onDelivery?.({ events: [...delivered] });
      } catch (e) {
        log.warn('onDelivery钩子异常', { err: e });
      } finally {
        this.deliveryCollector = null;
      }
      delivered.push(...injected);
    }
    const lines: string[] = [];
    const events: EventEnvelope[] = [];
    const internals: EventEnvelope[] = [];
    let ephemeralCount = 0;
    for (const e of delivered) {
      if (e.origin === 'internal') {
        lines.push(e.text);
        internals.push(e);
        if (e.ephemeral) ephemeralCount++;
      } else events.push(e);
    }
    const inUser = this.eventDelivery() === 'user';
    // World 写好的正文原样进来,core 一个字都不加
    if (events.length > 0 && inUser) lines.push(renderEventLines(events));
    // 整批都是自消解项才整条标记:混批时宁可多留一次,也不连累同批的正经内容
    const ephemeral = ephemeralCount > 0 && ephemeralCount === internals.length && events.length === 0;
    if (!this.active(generation)) return false;
    this.dropEphemeral(generation);
    if (lines.length > 0) {
      const msg: ContextRecord = message('user', lines.join('\n'));
      if (ephemeral) msg.context.ephemeral = true;
      // user 模式下事件块接在内部行后面:sidecar 的位置从那一段之后起算
      if (events.length > 0 && inUser) {
        const base = lines.slice(0, -1).reduce((n, l) => n + l.length + 1, 0);
        msg.context.frame = { events: frameEventRefs(events, base) };
      }
      const blobs = eventBlobs(inUser ? [...internals, ...events] : internals);
      if (blobs.length > 0) msg.context.blobs = blobs;
      session.append(msg);
    }
    if (events.length > 0 && !inUser) this.appendEventFrame(events, generation);
    this.noteHandled(delivered, generation);
    const changed = lines.length > 0 || events.length > 0;
    if (changed) this.batchesHandled++;
    return changed;
  }

  /** 候选策略属于来源 World；主循环只组批、校验引用并收编输出。 */
  private prepareCandidateProjections(
    batch: readonly WakeItem[],
    generation: number,
  ): Map<number, PreparedCandidateProjection[]> {
    const groups: Array<{
      source: string;
      origin: EventEnvelope['origin'];
      project: CandidateProjector;
      entries: Array<{ batchIndex: number; candidate: CandidateEventSpec }>;
    }> = [];
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex++) {
      const candidate = batch[batchIndex].candidate;
      if (!candidate) continue;
      let group = groups.find((value) =>
        value.source === candidate.source &&
        value.origin === candidate.origin &&
        value.project === candidate.project);
      if (!group) {
        group = { source: candidate.source, origin: candidate.origin, project: candidate.project, entries: [] };
        groups.push(group);
      }
      group.entries.push({ batchIndex, candidate });
    }

    const prepared = new Map<number, PreparedCandidateProjection[]>();
    for (const group of groups) {
      try {
        const projected = group.project(group.entries.map((entry) => entry.candidate));
        if (!this.active(generation)) return new Map();
        const claimed = new Set<number>();
        for (const projection of projected) {
          const indexes = [...new Set(projection.candidateIndexes)].sort((a, b) => a - b);
          const invalid = indexes.length === 0 || indexes.some((index) =>
            !Number.isInteger(index) || index < 0 || index >= group.entries.length || claimed.has(index));
          if (invalid) {
            this.d.log.warn('候选投影含无效或重复源引用,已跳过整条投影', { source: group.source });
            continue;
          }
          for (const index of indexes) claimed.add(index);
          const anchor = group.entries[indexes[0]].batchIndex;
          const sourceCursors = indexes.flatMap((index) =>
            group.entries[index].candidate.sourceEvents.map((event) => event.cursor));
          const list = prepared.get(anchor) ?? [];
          list.push({
            source: group.source,
            origin: group.origin,
            event: projection.event,
            sourceCursors,
          });
          prepared.set(anchor, list);
        }
      } catch (error) {
        this.d.log.warn('候选投影失败,本批候选只保留归档', {
          source: group.source,
          err: error,
        });
      }
    }
    return prepared;
  }

  /**
   * 抹掉还留在 session 里的自消解项(见 EventEnvelope.ephemeral)。每批唤醒
   * 投递前清一次,所以同时在场的最多是一批。
   *
   * 按落盘态的标记找,不按对象引用找——重启读回的陈旧项一样会被清掉。
   */
  private dropEphemeral(generation: number): void {
    if (!this.active(generation)) return;
    const { session } = this.d;
    if (!session.records.some((m) => m.context.ephemeral)) return;
    const kept = session.records.filter((m) => !m.context.ephemeral);
    const dropped = session.records.length - kept.length;
    session.reset(kept);
    this.d.transcript?.boundary('ephemeral-drop', { dropped });
  }

  /**
   * 投递成文渲染,带 deadline。契约(DeferredEventSpec):render 只该读现成
   * 状态,慢渲染视同没渲染出来——超时与异常都按蒸发处理,只记日志。
   */
  private async renderDeferred(spec: DeferredEventSpec, generation: number): Promise<DeferredRendered | null> {
    if (!this.active(generation)) return null;
    const { log } = this.d;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<typeof RENDER_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(RENDER_TIMED_OUT), RENDER_DEADLINE_MS);
      });
      const out = await Promise.race([Promise.resolve(spec.render()), timeout]);
      if (!this.active(generation)) return null;
      if (out === RENDER_TIMED_OUT) {
        log.warn('投递成文渲染超时,该项蒸发', { type: spec.type, source: spec.source });
        return null;
      }
      return out;
    } catch (e) {
      log.warn('投递成文渲染失败,该项蒸发', { type: spec.type, source: spec.source, err: e });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 外部正文通过一对合成的 external_event_frame 调用和回执进入上下文。
   *
   * 调用与回执均由 core 合成,agent 并没有真的动手。user 消息只承载内部
   * 系统文本;外部正文留在工具回执区,且不增加一轮模型调用。
   */
  private appendEventFrame(events: EventEnvelope[], generation: number): void {
    if (!this.active(generation)) return;
    const { session } = this.d;
    const id = `evf_${events[events.length - 1].cursor}`;
    session.append(functionCall(id, EXTERNAL_EVENT_FRAME, '{}'));
    const header = eventFrameHeader(events.length);
    const blobs = eventBlobs(events);
    session.append(functionResult(id, [header, renderEventLines(events)].join('\n'), {
      frame: { events: frameEventRefs(events, header.length + 1) },
      ...(blobs.length > 0 ? { blobs } : {}),
    }));
  }

  /**
   * 摘除模型仿造的保留帧调用。只按名字丢:参数伪造、id 仿造一概不看
   * 内容,同样丢弃。丢干净后没有剩余调用的消息不带 tool_calls 字段——本轮就
   * 按"无调用"自然结束;混着合法调用时只丢保留的那部分,其余照常执行。
   * 仿造这件事本身记日志,供核算场统计。
   */
  private dropReservedCalls(records: ContextRecord[]): ContextRecord[] {
    return records.filter(entry => {
      const item = entry.item;
      if (item.type !== 'function_call' || !RESERVED_FRAME_NAMES.has(item.name)) return true;
      this.d.log.info('模型仿造保留帧调用,已丢弃', { name: item.name, callId: item.call_id });
      return false;
    });
  }

  /**
   * 投递水位仅推进已了结事件的连续前缀，不跨越未投递外部事件。遍历和推进均使用存储位置游标，不使用信封自报的 cursor。
   */
  private noteHandled(delivered: readonly EventEnvelope[], generation: number): void {
    if (!this.active(generation)) return;
    const { state, store } = this.d;
    for (const event of delivered) this.deliveredCursors.add(event.cursor);
    let top = state.data.lastDeliveredCursor;
    const latest = store.latestCursor();
    for (let c = top + 1; c <= latest; c++) {
      const next = store.get(c);
      if (!next) break;
      // archive-only 不是无条件可跳过:它只在 projector 已经过过手时才算了结
      // (见 settledArchives)。还在批窗口里等发车的原文一旦被水位跨过去,重启
      // 补投从 lastDeliveredCursor+1 起算就再也看不见它。
      const skippable = next.origin === 'internal'
        || (next.contextDelivery === 'archive-only' && this.settledArchives.has(c));
      // 集合记录存储位置；装载期重排保证 next.cursor === c。
      if (!skippable && !this.deliveredCursors.has(c)) break;
      this.deliveredCursors.delete(c);
      this.settledArchives.delete(c);
      top = c;
    }
    if (top === state.data.lastDeliveredCursor) return;
    state.data.lastDeliveredCursor = top;
    state.save();
  }

  /** 时机:session 开场。开场白由Persona在钩子里注入(不注入=这次开场沉默)。 */
  private pushOpening(reason: SessionOpeningReason): void {
    const { persona, log } = this.d;
    try {
      persona.onOpening?.({ reason });
    } catch (e) {
      log.warn('onOpening钩子异常', { err: e });
    }
  }

  /**
   * 重启时补投水位之后的外部事件；内部事件不跨重启投递。
   * archive-only 已被投影引用则不重复投递，未被引用则按原文补投。超过条数上限时只入队最近一段，更早事件结清水位。
   */
  private requeueUndelivered(): void {
    const { bus, state, store, log } = this.d;
    // 先记下起点、再从盘面回填"哪些原始归档已被投影引用过",最后才结水位:
    // noteHandled 的 archive-only 分诊靠 settledArchives,那张表是进程内内存,
    // 重启后为空;不回填就会让上一世代已了结的归档把水位永远钉在原地。
    const from = state.data.lastDeliveredCursor + 1;
    if (from > store.latestCursor()) {
      this.noteHandled([], this.generation);
      return;
    }
    const after = store.range({ fromCursor: from });
    const referenced = new Set<number>();
    for (const event of after) {
      if (event.contextDelivery !== 'deliver') continue;
      const cursors = (event.meta as { sourceCursors?: unknown } | undefined)?.sourceCursors;
      if (!Array.isArray(cursors)) continue;
      for (const c of cursors) if (typeof c === 'number') referenced.add(c);
    }
    for (const c of referenced) this.settledArchives.add(c);
    this.noteHandled([], this.generation);
    const pending = after.filter((event) => event.origin === 'external'
      && (event.contextDelivery !== 'archive-only' || !referenced.has(event.cursor)));
    if (pending.length === 0) return;

    const skipped = Math.max(0, pending.length - MAX_REQUEUE);
    const kept = skipped > 0 ? pending.slice(skipped) : pending;
    if (skipped > 0) {
      const stale = pending.slice(0, skipped);
      state.data.lastDeliveredCursor = Math.max(state.data.lastDeliveredCursor, kept[0].cursor - 1);
      state.save();
      log.warn('重启补投超过上限,更早的一段按上一世代结清,不进上下文', {
        skipped,
        requeued: kept.length,
        max: MAX_REQUEUE,
        earliestTs: stale[0].ts,
        latestTs: stale[stale.length - 1].ts,
      });
    }
    for (const event of kept) bus.push({ event }, { trigger: 'piggyback' });
    log.info('重启补投:水位之后还没进过 session 的外部事件已重新入队', {
      count: kept.length,
      fromCursor: kept[0].cursor,
    });
    const originals = kept.filter((event) => event.contextDelivery === 'archive-only');
    if (originals.length > 0) {
      log.warn('补投里有没等到投影的原始归档,按原文补投', {
        count: originals.length,
        sources: [...new Set(originals.map((event) => event.source))],
        earliestTs: originals[0].ts,
        latestTs: originals[originals.length - 1].ts,
      });
    }
  }

  private async bootstrap(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    const { session, log } = this.d;
    // 恢复持久化的连败账，清除窗口外记录；窗口内失败可在重启后首次成功时报告。
    if (this.pruneStalls()) this.d.state.save();
    if (this.stallSince !== 0) {
      const carried = this.stallAt.filter((t) => t >= this.stallSince).length;
      log.warn('上一进程的 LLM 连败账未结,跨重启带回', {
        since: new Date(this.stallSince).toISOString(),
        count: carried,
      });
      // 带回的账已够阈值就直接进"已告警"态:不重复响一遍,但恢复时照发解除
      this.stallAlarmActive = carried >= STALL_ALERT_THRESHOLD;
    }
    this.requeueUndelivered();
    // 重启恢复不重建前缀,首轮对话缓存单独补上(全新session由buildSystem刷新)。
    this.refreshFirstTurn();
    if (session.records.length === 0) {
      const system = await this.buildSystem();
      if (!this.active(generation)) return;
      session.append(system);
      this.pushOpening('new');
      log.info('bootstrap:全新session');
      return;
    }

    const unanswered = new Set<string>();
    for (const { item } of session.records) {
      if (item.type === 'function_call') unanswered.add(item.call_id);
      if (item.type === 'function_call_output') unanswered.delete(item.call_id);
    }
    for (const id of unanswered) session.append(functionResult(id, MISSING_RESULT_RESTART));

    this.pushOpening('restarted');
    log.info('bootstrap:重启恢复');
  }

  async run(): Promise<void> {
    if (!this.activeNow()) return;
    const generation = this.generation;
    const { bus, log, persona, decl } = this.d;
    this.running = true;
    try {
      this.mainTrack = this.d.tracker?.open(decl.id, decl.label, {
        id: decl.id,
        messagesRef: () => this.d.session.records,
      }) ?? null;
      this.bindWorlds();
      await this.bootstrap(generation);
      if (!this.active(generation)) return;

      const stopSignal = new Promise<'stop'>((resolve) => {
        this.stopFn = () => resolve('stop');
      });

      // 水位自检的巡查。unref:它不是活儿,不该拖着进程不让退。
      this.watermarkAudit = setInterval(() => {
        try {
          this.auditDeliveryWatermark();
        } catch (e) {
          log.warn('水位自检异常', { err: e });
        }
      }, WATERMARK_AUDIT_INTERVAL_MS);
      this.watermarkAudit.unref?.();

      while (this.running) {
        const got = await Promise.race([bus.nextBatch(), stopSignal]);
        if (got === 'stop' || !this.running) break;
        const batch = got;

        // 空闲时由控制台触发的截断/前缀重载可能仍在收尾；新 batch 等维护完成再投递。
        await this.maintenanceChain;
        if (!this.active(generation)) break;
        this.processingBatch = true;
        try {
          const changed = await this.deliverBatch(batch, generation);
          if (!this.active(generation)) break;
          if (changed) {
            await this.rounds(generation);
            if (!this.active(generation)) break;
            // 回合期间(工具/运维)登记的交接请求先兑现,再走批末时机钩子与物理钳制。
            await this.flushRequestedHandoff(generation);
            if (!this.active(generation)) break;
            await this.batchEndCheck(generation);
            if (!this.active(generation)) break;
          }

          // 停放中的投递成文项不算积压:只看即时项,别让一条挂着的观察压死空闲期。
          if (bus.pendingImmediate() === 0 && persona.onIdle) {
            try {
              await persona.onIdle();
            } catch (e) {
              log.warn('onIdle钩子异常', { err: e });
            }
            if (!this.active(generation)) break;
          }
          // 手动请求也可能在onIdle的人格Git提交期间到达。
          await this.flushRequestedHandoff(generation);
        } finally {
          this.processingBatch = false;
        }
        // 异常退出由 stop 释放排队请求；只有正常批次边界执行重载。
        await this.flushRequestedPrefixReload(generation);
      }
    } finally {
      this.stop();
      this.seal();
    }
  }

  /** 整个唤醒批的推理轮都在 sess 锚点作用域里跑;每轮再改写 round / resp / call。 */
  private rounds(generation: number): Promise<void> {
    return withAnchors({ sess: this.d.decl.id }, () => this.roundsInScope(generation));
  }

  private async roundsInScope(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    const { llm, session, log, bus, decl } = this.d;
    const schemas = this.getToolSchemas();
    const caps = decl.rounds();
    this.roundsLastBatch = 0;
    // 输出旁路:声明了 tap 就以流式调用并转发增量。tap 的异常只记日志——
    // 旁路的消费方坏掉不该毁掉本轮推理。
    const tap = decl.outputTap;
    const resubmit = this.d.resubmit ?? DEFAULT_RESUBMIT;
    let consecutiveFailures = 0;
    let resubmits = 0;

    for (let round = 1; ; round++) {
      if (!this.active(generation)) return;
      this.roundsLastBatch = round;
      const spec = this.d.spec();
      // 物理钳制的轮边界版:工具回执与事件把计数推过上限时,不再发请求去撞上游拒绝,
      // 本批在此收束,交接由批末的 batchEndCheck 执行。首轮不查:上一批末已经钳过,
      // 本批刚投递的事件必须得到回应。
      if (round > 1) {
        const hard = this.d.context.hardTokens();
        if (hard !== null && this.estTokens() > hard) {
          log.warn('计数越过模型上下文上限,本批在轮边界收束,批末交接', { round, estTokens: this.estTokens(), hardTokens: hard });
          this.finishTurn();
          return;
        }
      }

      const queuedEvents: EventEnvelope[] = [];
      const roundNo = ++this.roundSeq;
      setAnchors({ round: roundNo, resp: undefined, call: undefined });
      const flight: NonNullable<MainLoop['currentRound']> = {
        controller: new AbortController(), externalized: false, abortReason: null,
      };
      this.currentRound = flight;
      const ctx: ToolCallContext = {
        role: decl.id,
        log,
        round: roundNo,
        // 关机或换代撤销本轮时随之 abort;抢占不取消工具(DESIGN §4.1)。
        signal: AbortSignal.any([flight.controller.signal, this.shutdown.signal]),
        queueExternalEvents: (events) => {
          if (this.active(generation)) queuedEvents.push(...events);
        },
      };
      // 提前派发:流里一个 tool_call 闭合就立刻执行它的 handler,不等整条
      // 消息收完。闭合顺序等于消息内顺序,屏障语义(barrierAfter)照常成立。
      const eager = tap
        ? new EagerDispatch(
            () => this.toolDefs, ctx, log, decl.id, this.d.toolLog,
            () => this.active(generation) && !flight.controller.signal.aborted,
            (name) => this.d.toolOwner?.(name),
          )
        : null;
      // 轮级观测:首个内容事件的延迟、模型往返、工具阻塞,一轮一条 debug 记录(event=round)。
      const roundStart = Date.now();
      let ttftMs: number | null = null;
      let llmMs: number | null = null;
      let toolMs = 0;
      const noteRound = (outcome: string, extra: Record<string, unknown> = {}): void => {
        log.emit('debug', '一轮收束', { event: 'round', data: {
          round: roundNo, outcome, llmMs, ttftMs, outputTokens: meters?.output ?? null, toolMs, ...extra,
        } });
      };
      const tapEvents = tap ? {
        onEvent: (event: StreamEvent): void => {
          if (!this.active(generation) || flight.controller.signal.aborted) return;
          if (event.type === 'response.created') setAnchors({ resp: event.response.id });
          if (ttftMs === null && ('delta' in event || event.type === 'response.output_item.added')) ttftMs = Date.now() - roundStart;
          const tappedEffect = tap.externalizes ? tap.externalizes(event)
            : event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta'
              || (event.type === 'response.output_item.added' && event.item?.type === 'function_call');
          if (tappedEffect || (event.type === 'response.output_item.done' && event.item?.type === 'function_call' && event.item.status === 'completed')) flight.externalized = true;
          eager?.onEvent(event);
          try { tap.onEvent(event); } catch (error) { log.warn('outputTap.onEvent异常', { err: error }); }
        },
      } : undefined;
      let assistant: ContextRecord[];
      let meters: TokenMeters | null = null;
      const outbound = this.outboundMessages();
      const prefixHash = prefixFingerprint(outbound);
      try {
        // role 只进故障指纹(同一模型上主角色全灭、梦角色同期成功是实测过的形状),
        // 不进请求体。
        const llmStart = Date.now();
        let res: Awaited<ReturnType<typeof llm.respond>>;
        try {
          res = await llm.respond(responseRequest(spec, outbound, schemas), {
            context: outbound, nativeSpec: spec,
            ...(tapEvents ?? {}),
            role: decl.id,
            sessionId: this.mainTrack?.id,
            signal: flight.controller.signal,
          });
        } finally {
          llmMs = Date.now() - llmStart;
        }
        assistant = responseRecords(res.response, res.origin);
        setAnchors({ resp: res.response.id });
        if (!this.active(generation) || flight.controller.signal.aborted) {
          // 关机或换代丢弃已成功返回的结果时，仍记录这次调用的实际用量。
          this.mainTrack?.recordAttempts(res.attempts, undefined, { outcome: 'discarded', prefixHash });
          try {
            tap?.onAbort?.('core 正在关机');
          } catch (tapErr) {
            log.warn('outputTap.onAbort异常', { err: tapErr });
          }
          noteRound('discarded');
          this.finishTurn();
          return;
        }
        meters = res.attempts[res.attempts.length - 1].meters;
        this.lastUsage = usageCounters(meters);
        this.mainTrack?.recordAttempts(res.attempts, undefined, { prefixHash });
        this.noteStallsRecovered();
        consecutiveFailures = 0;
      } catch (e) {
        if (flight.controller.signal.aborted) {
          this.recordFailedUsage(e, prefixHash);
          try {
            tap?.onAbort?.(flight.abortReason === 'shutdown' ? 'core 正在关机' : '模型轮被新输入抢占');
          } catch (tapErr) {
            log.warn('outputTap.onAbort异常', { err: tapErr });
          }
          log.info(flight.abortReason === 'shutdown' ? '模型轮随关机终止' : '尚未外化的模型轮已被新输入抢占');
          noteRound(flight.abortReason === 'shutdown' ? 'shutdown' : 'preempted');
          this.finishTurn();
          return;
        }
        this.recordFailedUsage(e, prefixHash);
        if (tap && e instanceof GenerationError && e.partial) {
          // 增量已外流(可能已被外部消费):session必须记下实际外流的部分,
          // 否则记忆与外部世界永久分叉。已提前派发的调用用真实结果配对。
          await this.recordAbortedStream(responseRecords(e.partial, e.origin), eager, generation);
          if (!this.active(generation)) {
            try {
              tap.onAbort?.('core 正在关机');
            } catch (tapErr) {
              log.warn('outputTap.onAbort异常', { err: tapErr });
            }
            return;
          }
          try {
            tap.onAbort?.(e.message);
          } catch (tapErr) {
            log.warn('outputTap.onAbort异常', { err: tapErr });
          }
        }
        // 提前派发的 handler 可能已把事件从总线取走(queueExternalEvents)。退回总线:
        // 续拍前经 takeIfReady 接回,不续拍则随下一批投递。
        for (const event of queuedEvents) {
          bus.push({ event }, { trigger: 'flush' });
        }
        // 上游说输入超长是唯一准确的越线信号:不算卡住,本批收束后立即交接。
        if (e instanceof GenerationError && this.d.context.contextOverflow(e)) {
          log.warn('上游拒绝:输入超过模型上下文,本批结束即交接', { estTokens: this.estTokens(), hardTokens: this.d.context.hardTokens() });
          this.handoffRequested = true;
          noteRound('overflow');
          this.finishTurn();
          return;
        }
        this.noteStalled();
        consecutiveFailures++;
        const detail = {
          err: e,
          // 4xx 的响应正文是唯一的诊断线索(如"Model Not Exist"),截断进日志。
          // 流内失败时这里装的是整条原始失败事件(见 llmResponses 的 response.failed 分支)。
          ...(e instanceof GenerationError && e.body ? { body: e.body.slice(0, 500) } : {}),
          ...(e instanceof GenerationError ? { status: e.status } : {}),
          attempt: consecutiveFailures,
        };
        // 可续拍的失败类别见 ResubmitPolicy;已落库的 partial 与回执就是模型接着说的依据。
        const retryable = e instanceof GenerationError && (e.status === 0 || e.status === 429 || e.status >= 500);
        if (retryable && consecutiveFailures <= resubmit.maxConsecutive && resubmits < resubmit.maxPerBatch && round < caps.hard) {
          resubmits++;
          const delayMs = resubmit.backoffMs[Math.min(consecutiveFailures, resubmit.backoffMs.length) - 1] ?? 0;
          log.warn('LLM调用失败,退避后在本批内续拍', { ...detail, resubmits, delayMs });
          noteRound('failed', { resubmit: true, delayMs });
          await this.backoff(delayMs);
          if (!this.active(generation)) return;
          // 退避期间到齐的事件(含刚退回的)先进上下文,续拍看到的是此刻的世界。
          const ready = bus.takeIfReady();
          if (ready) {
            await this.deliverBatch(ready, generation);
            if (!this.active(generation)) return;
          }
          continue;
        }
        log.error('LLM调用失败,本轮自然结束', detail);
        noteRound('failed', { resubmit: false });
        this.finishTurn();
        return;
      } finally {
        if (this.currentRound === flight) this.currentRound = null;
      }
      if (!this.active(generation)) return;
      assistant = this.dropReservedCalls(assistant);
      const calls = assistant.flatMap(entry => entry.item.type === 'function_call' ? [entry.item] : []);
      this.pendingToolCalls = new Set(calls.map((call) => call.call_id));
      for (const entry of assistant) session.append(entry);
      if (meters && meters.input !== null && meters.output !== null) {
        this.anchor = { records: session.records.length, tokens: meters.input + meters.output, reasoningTokens: meters.reasoning ?? 0 };
      }
      if (!this.active(generation)) return;
      if (tap) {
        try {
          tap.onRoundEnd?.();
        } catch (e) {
          log.warn('outputTap.onRoundEnd异常', { err: e });
        }
      }

      if (calls.length === 0) {
        noteRound('completed');
        this.finishTurn();
        return;
      }

      const results: ContextRecord[] = [];
      let barrierHit = false;
      // endsTurn 工具真正执行过(没被屏障跳过、参数合法)才算数
      let turnEnded = false;
      const toolsStart = Date.now();

      for (const call of calls) {
        if (!this.active(generation)) return;
        if (call.status !== 'completed') {
          results.push(functionResult(call.call_id, NOT_EXECUTED_INCOMPLETE));
          barrierHit = true;
          continue;
        }
        if (barrierHit) {
          results.push(functionResult(call.call_id, NOT_EXECUTED_BARRIER));
          continue;
        }

        let out: ToolOutcome;
        const def = this.toolDefs.find((t) => t.name === call.name);
        if (!def) {
          out = { text: UNKNOWN_TOOL };
          withAnchors({ call: call.call_id }, () => recordToolCall(this.d.toolLog, decl.id, call.name, null, Date.now(), out));
        } else {
          const eagerOut = eager?.take(call.call_id);
          if (eagerOut !== undefined) {
            out = await eagerOut;
            if (!this.active(generation)) return;
          } else {
            const args = parseToolArgs(call.arguments);
            if (args === null) {
              out = { text: TOOL_FAILED_BAD_ARGS, failed: true };
              withAnchors({ call: call.call_id }, () =>
                recordToolCall(this.d.toolLog, decl.id, def.name, null, Date.now(), out, this.d.toolOwner?.(def.name)));
              results.push(functionResult(call.call_id, out.text));
              if (def.barrierAfter) barrierHit = true;
              continue;
            }
            out = await runToolHandler(
              def, args, ctx, call.call_id, decl.id, this.d.toolLog,
              () => this.active(generation), this.d.toolOwner?.(def.name),
            );
            if (!this.active(generation)) return;
          }
          if (def.barrierAfter) barrierHit = true;
          if (def.endsTurn) turnEnded = true;
        }
        if (out.text.length > LARGE_RESULT_WARN_CHARS) {
          log.warn('工具回执过长,体积归 World 管', { tool: call.name, chars: out.text.length, limit: LARGE_RESULT_WARN_CHARS });
        }
        results.push(this.toolResult(call.call_id, out));
      }
      toolMs = Date.now() - toolsStart;

      if (!this.active(generation)) return;
      if (round === caps.soft && results.length > 0) {
        const hint = caps.softHint?.();
        if (hint) results[results.length - 1] = withText(results[results.length - 1], `${textOf(results[results.length - 1])}\n${hint}`);
      }
      for (const result of results) session.append(result);
      this.pendingToolCalls.clear();

      // 工具执行期间消费或达到投递标准的事件接在本轮工具结果之后。
      const arrived: WakeItem[] = queuedEvents.map((event) => ({ event }));
      if (round < caps.hard && !turnEnded) {
        const ready = bus.takeIfReady();
        if (ready) arrived.push(...ready);
      }
      if (arrived.length > 0) {
        if (round >= caps.hard || turnEnded) {
          // 不在无人继续推理的情况下把session停在user消息；退回总线，
          // 外层下一回合再正常投递。
          for (const item of arrived) bus.push(item, { trigger: 'flush' });
        } else {
          await this.deliverBatch(arrived, generation);
          if (!this.active(generation)) return;
        }
      }

      // 显式收工(endsTurn工具):与自然结束同一出口,事件已退回总线成下一批。
      if (turnEnded) {
        noteRound('ended', { toolCalls: calls.length, arrived: arrived.length });
        this.finishTurn();
        return;
      }
      if (round >= caps.hard) {
        log.warn('硬上限强制结束本次唤醒', { round });
        noteRound('hard-cap', { toolCalls: calls.length, arrived: arrived.length });
        this.finishTurn();
        return;
      }
      noteRound('continue', { toolCalls: calls.length, arrived: arrived.length });
    }
  }

  /** 续拍前的退避等待;stop() 经 backoffWake 提前结束它。 */
  private backoff(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.backoffWake = null; resolve(); }, ms);
      this.backoffWake = () => { clearTimeout(timer); this.backoffWake = null; resolve(); };
    });
  }

  /**
   * 断流一致性:把已外流的部分消息追加进 session。已提前派发过的调用用真实
   * 执行结果配对(它确实跑了);其余从未执行,补机械回执保持配对——下一轮
   * 请求才不会缺 tool result。
   */
  private async recordAbortedStream(
    partial: ContextRecord[],
    eager: EagerDispatch | null,
    generation: number,
  ): Promise<void> {
    if (!this.active(generation)) return;
    const { session } = this.d;
    // 断流的 partial 里同样丢保留帧调用:不落库,也不补机械回执
    partial = this.dropReservedCalls(partial);
    const calls = partial.flatMap(entry => entry.item.type === 'function_call' ? [entry.item] : []);
    this.pendingToolCalls = new Set(calls.map((call) => call.call_id));
    for (const entry of partial) session.append(entry);
    for (const call of calls) {
      const ran = eager?.take(call.call_id);
      const out = ran !== undefined ? await ran : { text: NOT_EXECUTED_STREAM_ABORTED };
      if (!this.active(generation)) return;
      session.append(this.toolResult(call.call_id, out));
      this.pendingToolCalls.delete(call.call_id);
    }
    this.pendingToolCalls.clear();
  }

  /** 运维显式丢弃的即时事件也结清水位，但不写入 session。 */
  acknowledgeDiscarded(events: readonly EventEnvelope[]): void {
    this.noteHandled(events, this.generation);
  }

  /** 出线视图的本地估算:历史思维链丢弃时不计入。 */
  private estimateOutbound(msgs: readonly ContextRecord[]): number {
    const view = this.d.cfg.context.keepPastThinking ? msgs : withoutPastReasoning(msgs);
    return this.d.context.estimateTokens(view);
  }

  /**
   * 下一次请求的输入 token 数。有锚点时 = 上游数过的那一份 + 锚点之后新增条目的
   * 估算;历史思维链丢弃时锚点那一发的推理不再进下一发,按上游报的推理量扣掉。
   * 没有锚点时整份本地估算(出线态口径:合成首轮对话也占上下文)。
   */
  estTokens(): number {
    const { anchor } = this;
    const records = this.d.session.records;
    if (anchor && records.length >= anchor.records) {
      const keep = this.d.cfg.context.keepPastThinking;
      return anchor.tokens - (keep ? 0 : anchor.reasoningTokens) + this.estimateOutbound(records.slice(anchor.records));
    }
    return this.estimateOutbound(this.outboundMessages());
  }

  /** estTokens 里上游数过的部分(整份估算时 0);控制台按它区分真值与估算。 */
  private countedTokens(): number {
    const { anchor } = this;
    if (!anchor || this.d.session.records.length < anchor.records) return 0;
    return anchor.tokens - (this.d.cfg.context.keepPastThinking ? 0 : anchor.reasoningTokens);
  }

  /** 主 session 的计数与物理上限(sessionInfo 查询面的数据源)。 */
  contextGauge(): { estTokens: number; hardTokens: number | null } {
    return { estTokens: this.estTokens(), hardTokens: this.d.context.hardTokens() };
  }

  /**
   * 时机:一批处理完、回合循环收束。压力预警与主动交接是Persona在钩子里的
   * 裁量(经 sessionInfo 查数、经 requestContextHandoff 行动);core 只留
   * 一条物理钳制——计数越过模型上限即强制交接,机器不能等人格慌了才救火。
   */
  private async batchEndCheck(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    const { persona, log } = this.d;
    try {
      persona.onBatchEnd?.();
    } catch (e) {
      log.warn('onBatchEnd钩子异常', { err: e });
    }
    if (await this.flushRequestedHandoff(generation)) return;
    if (!this.active(generation)) return;
    const hard = this.d.context.hardTokens();
    if (hard !== null && this.estTokens() > hard) {
      log.warn('计数越过模型上下文上限,强制交接', { estTokens: this.estTokens(), hardTokens: hard, model: this.d.spec().model });
      await this.handoffContext();
    }
  }

  /**
   * 统一交接入口。事务是单实例的:阈值触发与运维手动请求复用同一个
   * Promise,Persona的策略因此不会被重复拉起。
   */
  handoffContext(): Promise<void> {
    const generation = this.generation;
    if (!this.active(generation)) return Promise.resolve();
    if (this.truncatePromise) return this.truncatePromise;
    let tracked: Promise<void>;
    tracked = this.enqueueMaintenance(() => this.performHandoff(generation), generation).finally(() => {
      if (this.truncatePromise === tracked) this.truncatePromise = null;
    });
    this.truncatePromise = tracked;
    return tracked;
  }

  private enqueueMaintenance(task: () => Promise<void>, generation: number): Promise<void> {
    const guarded = (): Promise<void> => this.active(generation) ? task() : Promise.resolve();
    const run = this.maintenanceChain.then(guarded, guarded);
    this.maintenanceChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 运维入口：在安全回合边界强制一次交接。正在处理批次时只登记请求，
   * 由run()在assistant自然结束后兑现；空闲时可立即开始。
   */
  requestContextHandoff(): boolean {
    if (!this.activeNow()) return false;
    if (this.truncatePromise || this.handoffRequested) return false;
    if (this.processingBatch) {
      this.handoffRequested = true;
      return true;
    }
    void this.handoffContext().catch((error) => {
      this.d.log.error('手动上下文交接失败', { err: error });
    });
    return true;
  }

  private async flushRequestedHandoff(generation: number): Promise<boolean> {
    if (!this.active(generation)) return false;
    if (!this.handoffRequested) return false;
    this.handoffRequested = false;
    await this.handoffContext();
    return this.active(generation);
  }

  /**
   * persona.onHandoff 提供动态尾;醒来消息由它在钩子内注入(事务期间总线
   * 不投递,注入项落在新 session 第一批)。策略失败或越界时使用默认重建结果,
   * 确保已触发的截断继续完成。
   */
  private async performHandoff(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    const { cfg, session, state, log, persona } = this.d;
    // 出线态快照:交接策略里开的继承型 fork 才能与主 session 字节前缀一致。
    // 落盘防线在 clampTail——firstTurn 标记的消息不进重建后的动态尾。
    const snapshot = this.outboundMessages();
    const before = this.estTokens();
    // Persona没有交接策略时按机械默认重建(null 尾)。
    let result: ContextHandoffResult = { tail: null };
    try {
      if (persona.onHandoff) result = await persona.onHandoff(snapshot, { hardTokens: this.d.context.hardTokens() });
    } catch (e) {
      log.error('上下文交接策略失败,继续机械重建', { err: e });
    }
    if (!this.active(generation)) return;

    // system 前缀在交接策略可能改写人格工作区之后重建。
    const sysMsg = await this.buildSystem();
    if (!this.active(generation)) return;
    const newTail = this.clampTail(result, snapshot, [sysMsg, ...this.activeFirstTurn()]);
    session.reset([sysMsg, ...newTail]);
    for (const m of this.d.worlds.visible()) {
      try {
        m.onHandoffEnded?.();
      } catch (e) {
        log.warn('World 交接钩子异常', { id: m.id, err: e });
      }
    }
    state.data.lastTruncateAt = nowIso(cfg.timezone);
    state.save();
    const summary = { beforeTokens: before, afterTokens: this.estTokens(), kept: newTail.length, dropped: Math.max(0, snapshot.length - newTail.length) };
    this.d.transcript?.boundary('handoff', summary);
    log.emit('info', '上下文交接完成', { event: 'handoff', data: summary });
  }

  /**
   * 动态尾必须满足工具调用配对与物理上限:新前缀加尾巴不得越过 hardTokens。
   * null 尾按同一上限从快照末尾机械重建;上限未知时只修配对。Persona带 trim
   * 交回的整段候选走同一条重建路径,只是不再当作它出错。
   */
  private clampTail(result: ContextHandoffResult, snapshot: ContextRecord[], prefix: readonly ContextRecord[]): ContextRecord[] {
    const { log, context } = this.d;
    const { tail } = result;
    const hard = context.hardTokens();
    const budget = hard === null ? null : Math.max(0, hard - context.estimateTokens(prefix));
    const estimate = (records: readonly ContextRecord[]): number => context.estimateTokens(records);
    if (tail === null) {
      let start = 0;
      while (start < snapshot.length && hasRole(snapshot[start], 'system')) start++;
      const candidate = snapshot.slice(start).filter((m) => !m.context.firstTurn);
      return budget === null ? fixPairing(candidate) : rebuildTail(candidate, budget, estimate);
    }
    // 合成首轮对话与 system 同款过滤:它只活在出线态,落盘即污染真实历史。
    const paired = fixPairing(tail.filter((m) => !hasRole(m, 'system') && !m.context.firstTurn));
    if (budget === null || estimate(paired) <= budget) return paired;
    // trim:Persona声明这是"整段候选材料",越过上限是预期,不是它出错。
    if (!result.trim) log.warn('交接策略返回的动态尾越过模型上下文上限,按机械默认裁剪', { budget });
    return rebuildTail(paired, budget, estimate);
  }

  /**
   * 主session清空重开(web运维动作):只保留新system前缀，boot作为下一条user消息
   * 重新开启回合。事件库不动，旧经历仍可通过历史工具找回。
   */
  async clearSession(): Promise<void> {
    const generation = this.generation;
    if (!this.active(generation)) return;
    const { session, log } = this.d;
    const sysMsg = await this.buildSystem();
    if (!this.active(generation)) return;
    session.reset([sysMsg]);
    this.d.transcript?.boundary('clear', {});
    this.finishTurn();
    this.pushOpening('cleared');
    log.emit('warn', 'session已清空重开', { event: 'session-cleared' });
  }

  /**
   * 重新读取 ORIENTATION / CONSTITUTION / IO 环境提示词并只替换当前 session
   * 的 system 前缀。既有 user / assistant / tool 消息全部保留。
   */
  reloadSystemPrefix(): Promise<void> {
    const generation = this.generation;
    if (!this.active(generation)) return Promise.resolve();
    if (this.prefixReloadPromise) return this.prefixReloadPromise;
    const safeBoundary = this.processingBatch
      ? new Promise<void>((resolve) => { this.releasePrefixReload = resolve; })
      : Promise.resolve();
    let tracked: Promise<void>;
    tracked = safeBoundary
      .then(() => this.enqueueMaintenance(() => this.performSystemPrefixReload(generation), generation))
      .finally(() => {
        if (this.prefixReloadPromise === tracked) this.prefixReloadPromise = null;
      });
    this.prefixReloadPromise = tracked;
    return tracked;
  }

  private async flushRequestedPrefixReload(_generation: number): Promise<boolean> {
    const release = this.releasePrefixReload;
    if (!release) return false;
    // 先捕获引用再 release:release 触发的 chain 可能在 await 前就把
    // this.prefixReloadPromise 置 null(reloadSystemPrefixReload 的 finally),
    // 此时 await null 直接 resolve,调用方误以为重载已完成。
    const pending = this.prefixReloadPromise;
    this.releasePrefixReload = null;
    release();
    await pending;
    return true;
  }

  private async performSystemPrefixReload(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    const { session, log } = this.d;
    const sysMsg = await this.buildSystem();
    if (!this.active(generation)) return;
    const snapshot = [...session.records];
    let tailStart = 0;
    while (tailStart < snapshot.length && hasRole(snapshot[tailStart], 'system')) tailStart++;
    session.reset([sysMsg, ...snapshot.slice(tailStart)]);
    this.d.transcript?.boundary('prefix-reload', { keptMessages: snapshot.length - tailStart });
    log.emit('warn', '当前session系统前缀已重载', { event: 'prefix-reload', data: { keptMessages: snapshot.length - tailStart } });
  }

  /** 每次已发出的 HTTP 尝试均记账；未报告的 token 维度保留为未知。 */
  private recordFailedUsage(error: unknown, prefixHash?: string): void {
    if (error instanceof GenerationError) this.mainTrack?.recordAttempts(error.attempts, undefined, { prefixHash });
  }

  /** 一次调用失败:进时刻表,并记下这串失败是什么时候开始的。落盘,重启不丢账。 */
  private noteStalled(): void {
    const now = Date.now();
    if (this.stallSince === 0) this.stallSince = now;
    this.stallAt.push(now);
    this.pruneStalls(now);
    this.d.state.save();
    // 连败到阈值:发一条操作员口径的告警(见 STALL_ALERT_THRESHOLD 注释)。
    // 同一串只响一次;只报事实,不改重试行为。
    if (!this.stallAlarmActive && this.stallSince !== 0) {
      const count = this.stallAt.filter((t) => t >= this.stallSince).length;
      if (count >= STALL_ALERT_THRESHOLD) {
        this.stallAlarmActive = true;
        this.d.log.error(
          `[告警] LLM 已连续失败 ${count} 次,零成功——成串的失败不会自愈,去看上游;恢复时会另发解除`,
          {
            count,
            since: new Date(this.stallSince).toISOString(),
            threshold: STALL_ALERT_THRESHOLD,
          },
        );
      }
    }
  }

  /**
   * 丢掉窗口外的失败时刻。窗口里一条都不剩时连 `stallSince` 一并清零——否则
   * 停机一整天后的第一次成功会把一串早已过期的账当成"刚恢复"报出来。
   */
  private pruneStalls(now = Date.now()): boolean {
    const stall = this.d.state.data.llmStall;
    const cutoff = now - STALL_WINDOW_MS;
    const before = stall.at.length;
    while (stall.at.length > 0 && stall.at[0] < cutoff) stall.at.shift();
    const cleared = stall.at.length === 0 && stall.since !== 0;
    if (cleared) stall.since = 0;
    return before !== stall.at.length || cleared;
  }

  /**
   * 一次调用成功:如果刚才卡过,把这串失败的机械事实交给Persona成文。
   * 整串失败只问一次(问完清零),不在失败期间问——失败期间她根本收不到。
   *
   * core 不写面向 agent 的散文:说不说(一次抖动值不值得占一条上下文)、
   * 怎么说(「卡住」还是别的词、提不提观众),全是 onStallsRecovered 钩子的事;
   * 没有钩子或钩子返回 null 就什么都不注入。
   */
  private noteStallsRecovered(): void {
    this.pruneStalls();
    if (this.stallSince === 0) {
      // 连败账已被窗口清空(如长时间停摆后的重启):挂着的告警一并解除,别让它永久卡响
      if (this.stallAlarmActive) {
        this.stallAlarmActive = false;
        this.d.log.warn('[解除] LLM 连败告警解除:失败串已超出统计窗口');
      }
      return;
    }
    const count = this.stallAt.filter((t) => t >= this.stallSince).length;
    const quietMs = Date.now() - this.stallSince;
    this.stallSince = 0;
    this.d.state.save();
    if (this.stallAlarmActive) {
      this.stallAlarmActive = false;
      this.d.log.warn('[解除] LLM 连败告警解除:调用已恢复成功', { count, quietMs });
    }
    const text = this.d.persona.onStallsRecovered?.({ count, quietMs });
    if (!text) return;
    this.d.bus.push(this.internalItem('core', 'core.stall', text));
  }

  /** 水位积压扫描:该进上下文却还没投递的外部事件计数与最老一条(巡查与状态面共用)。 */
  private watermarkBacklog(): { behind: number; oldest: EventEnvelope | null } {
    const { state, store } = this.d;
    const latest = store.latestCursor();
    let behind = 0;
    let oldest: EventEnvelope | null = null;
    for (let c = state.data.lastDeliveredCursor + 1; c <= latest; c++) {
      const e = store.get(c);
      if (!e) continue;
      if (e.origin !== 'external' || e.contextDelivery === 'archive-only') continue;
      behind++;
      if (!oldest) oldest = e;
    }
    return { behind, oldest };
  }

  /**
   * 最老的待投递外部事件等待超过 WATERMARK_STALL_MS 时报告 error，不自动修复。
   * 人工暂停或投递 gate 生效时不告警；仅含内部事件或 archive-only 原文的积压不触发该告警。等待 projector 的原文仍须由连续水位规则保护。
   * 公开入口供巡查、测试与控制台调用。
   */
  auditDeliveryWatermark(): void {
    if (!this.activeNow()) return;
    const { bus, state, store, log } = this.d;
    const watermark = state.data.lastDeliveredCursor;
    if (bus.isPaused() || bus.isDeliveryBlocked()) return;

    const latest = store.latestCursor();
    const { behind, oldest } = this.watermarkBacklog();
    const stalledForMs = oldest ? Date.now() - Date.parse(oldest.ts) : 0;
    const stalled = oldest !== null && Number.isFinite(stalledForMs) && stalledForMs > WATERMARK_STALL_MS;

    if (!stalled) {
      if (this.watermarkStallAt >= 0 && this.watermarkStallAt !== watermark) {
        log.warn('投递水位停滞已解除:水位又开始推进了', {
          stalledAtCursor: this.watermarkStallAt,
          lastDeliveredCursor: watermark,
          caughtUp: watermark - this.watermarkStallAt,
        });
        this.watermarkStallAt = -1;
      }
      return;
    }
    if (oldest === null) return; // stalled 为真时 backlog 非空，此处分支用于类型收窄。同一水位按退避表重报告警，并带上落后增量。
    if (this.watermarkStallAt === watermark) {
      const idx = this.watermarkStallReports - 1;
      if (idx >= WATERMARK_RESTATE_MS.length) return;
      const sinceFirstReportMs = Date.now() - this.watermarkStallSince;
      if (sinceFirstReportMs < WATERMARK_RESTATE_MS[idx]) return;
      this.watermarkStallReports++;
      log.error('投递水位仍在停滞:同一水位持续未推进', {
        behind,
        behindDelta: behind - this.watermarkStallBehind,
        sinceFirstReportMs,
        stalledForMs,
        lastDeliveredCursor: watermark,
        latestCursor: latest,
        report: this.watermarkStallReports,
      });
      return;
    }
    this.watermarkStallAt = watermark;
    this.watermarkStallSince = Date.now();
    this.watermarkStallBehind = behind;
    this.watermarkStallReports = 1;
    log.error('投递水位停滞:有该进上下文的外部事件长时间没被投递,水位没有推进', {
      behind,
      stalledForMs,
      thresholdMs: WATERMARK_STALL_MS,
      lastDeliveredCursor: watermark,
      latestCursor: latest,
      oldestCursor: oldest.cursor,
      oldestTs: oldest.ts,
      oldestSource: oldest.source,
      oldestText: oldest.text.slice(0, 200),
    });
  }

  /** 最近 withinMs 毫秒内卡住的次数。 World 问"这段安静里有多少是卡住的"用它。 */
  llmStalls(withinMs: number): number {
    const from = Date.now() - Math.max(0, withinMs);
    return this.stallAt.filter((t) => t >= from).length;
  }

  /**
   * 投递Persona已渲染的内部唤醒文本(即时成文);core 不解释语义。
   * onDelivery 时机钩子执行期间的注入收编进当前在途批(同批原子到达);
   * 其余时刻照常进总线。
   */
  injectInternal(text: string, kind = 'notice'): void {
    if (!this.activeNow()) return;
    const item = this.internalItem('persona', kind, text);
    if (this.deliveryCollector) {
      this.deliveryCollector.push(item.event);
      return;
    }
    this.d.bus.push(item);
  }

  /**
   * 投递Persona已渲染的外部事件(即时成文):source 记 persona,origin external,
   * 投递侧按 origin 进事件帧。交接笔记走这条路——它记的是发生过的事,不是提示语。
   */
  injectExternal(text: string, kind = 'note'): void {
    if (!this.activeNow()) return;
    const { store, cfg } = this.d;
    const event = store.append({
      type: kind,
      ts: nowIso(cfg.timezone),
      source: 'persona',
      origin: 'external',
      contextDelivery: 'deliver',
      text,
    });
    this.d.bus.push({ event });
  }

  /**
   * 投递成文的内部唤醒项:发车刻渲染并落库,投出的文本就是库里记的文本。
   * 心跳这类"报此刻状态"的项走这条路。
   */
  injectDeferred(kind: string, render: () => string | null | Promise<string | null>): void {
    if (!this.activeNow()) return;
    this.d.bus.push({ deferred: { type: kind, source: 'persona', origin: 'internal', render } });
  }

  /**
   * 内部项持久化并取得游标后，由调用方安排总线投递。
   *
   * 内部项与外部事件共用事件库和游标序列，`origin` 区分两者。
   * source 记的是产生方:Persona注入的记 `persona`(开场/预警/交接唤醒都是它
   * 在时机钩子里注入的),World 自报的内部事件经 pushEvent 记 World id。
   */
  private internalItem(source: string, type: string, text: string): WakeItem & { event: EventEnvelope } {
    const { store, cfg } = this.d;
    const event = store.append({
      type,
      ts: nowIso(cfg.timezone),
      source,
      origin: 'internal',
      text,
    });
    return { event };
  }

  /**
   * 当前工具表schema(web调试界面和模型调用共用;run()前为空数组)。
   * 带上 tags:控制台据此把 core 原语与其余工具分开陈列。
   */
  getToolSchemas(): Array<ToolSchema & { tags: readonly ToolTag[] }> {
    return this.toolDefs.map(({ name, description, parameters, tags }) => ({
      name, description, parameters, tags,
    }));
  }

  getStatus(): LoopStatus {
    return {
      running: this.running,
      truncating: this.truncatePromise !== null || this.handoffRequested,
      messageCount: this.d.session.records.length,
      estTokens: this.estTokens(),
      context: {
        hardTokens: this.d.context.hardTokens(),
        countedTokens: this.countedTokens(),
        keepPastThinking: this.d.cfg.context.keepPastThinking,
      },
      batchesHandled: this.batchesHandled,
      roundsLastBatch: this.roundsLastBatch,
      lastTruncateAt: this.d.state.data.lastTruncateAt,
      paused: this.d.bus.isPaused(),
      scheduleBlocked: this.d.bus.isDeliveryBlocked(),
      lastUsage: this.lastUsage,
      lastDeliveredCursor: this.d.state.data.lastDeliveredCursor,
      behind: this.watermarkBacklog().behind,
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.running = false;
    this.stopped = true;
    this.generation++;
    if (this.watermarkAudit) clearInterval(this.watermarkAudit);
    this.watermarkAudit = null;
    this.completePendingToolCallsForShutdown();
    this.backoffWake?.();
    if (!this.shutdown.signal.aborted) this.shutdown.abort(new Error('core 正在关机'));
    this.handoffRequested = false;
    const releasePrefixReload = this.releasePrefixReload;
    this.releasePrefixReload = null;
    releasePrefixReload?.();
    this.stopFn?.();
    const round = this.currentRound;
    if (round && !round.controller.signal.aborted) {
      round.abortReason = 'shutdown';
      round.controller.abort(new Error('core 正在关机'));
    }
  }

  /** 主循环已退出或 drain 超时；阻止迟到异步链继续写 session、工具账或结束钩子。 */
  seal(): void {
    this.sealed = true;
  }

  /** stop 的同步边界闭合已经落库的工具调用；异步 handler 的迟到结果一律丢弃。 */
  private completePendingToolCallsForShutdown(): void {
    const failed: string[] = [];
    for (const callId of this.pendingToolCalls) {
      try {
        this.d.session.append(functionResult(callId, SHUTDOWN_INTERRUPTED));
      } catch {
        failed.push(callId);
      }
    }
    this.pendingToolCalls.clear();
    if (failed.length > 0) {
      this.d.log.error('关机时工具调用配对落盘失败；重启恢复会补齐', { callIds: failed });
    }
  }
}

/** 工具参数解析:非法 JSON 返回 null(两条执行路径共用,回执措辞由调用方给) */
function parseToolArgs(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 执行一次 tool handler,异常就地转回执文本。常规派发与提前派发共用这一份,
 * 两条路径的回执措辞不会静默分叉,工具调用流水也只有这一个落点。
 */
function runToolHandler(
  def: ToolDef,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
  callId: string,
  role: string,
  toolLog?: ToolCallLog,
  canRecord: () => boolean = () => true,
  mod?: string,
): Promise<ToolOutcome> {
  const startedAt = Date.now();
  return withAnchors({ call: callId }, () => Promise.resolve()
    .then(() => def.handler(args, { ...ctx, callId }))
    .then((out): ToolOutcome => (typeof out === 'string' ? { text: out } : out))
    .catch((e: unknown): ToolOutcome => ({
      text: toolFailed(e instanceof Error ? e.message : String(e)),
      failed: true,
    }))
    .then((out): ToolOutcome => {
      if (canRecord()) recordToolCall(toolLog, role, def.name, args, startedAt, out, mod);
      return out;
    }));
}

/**
 * 提前派发:tap 会话在 tool_call 流式闭合时立即执行。
 * LLM 层保证闭合顺序等于消息内顺序:
 *  - 屏障语义成立:一个 barrierAfter 工具闭合后,后续闭合的调用不再提前派发
 *    (它们在消息落定后拿"[not executed]"回执,与非流式路径一致);
 *  - 结果按 call id 暂存,消息落定后由 rounds() 按序取走配对;
 *  - 参数不是合法 JSON 的调用不派发,落回非流式路径的机械回执。
 * handler 异常在这里就地转成回执文本,与非流式路径同一措辞。
 */
class EagerDispatch {
  private readonly ready = new Map<number, import('../protocol/open-responses/index.ts').OutputItem>();
  private readonly results = new Map<string, Promise<ToolOutcome>>();
  private chain: Promise<void> = Promise.resolve();
  private barrierHit = false;
  private nextIndex = 0;
  constructor(
    private readonly defs: () => ToolDef[],
    private readonly ctx: ToolCallContext,
    private readonly log: Logger,
    private readonly role: string,
    private readonly toolLog?: ToolCallLog,
    private readonly active: () => boolean = () => true,
    private readonly owner: (name: string) => string | undefined = () => undefined,
  ) {}


  onEvent(event: StreamEvent): void {
    if (!this.active()) return;
    if (event.type === 'response.created') { this.ready.clear(); this.nextIndex = 0; return; }
    if (event.type !== 'response.output_item.done' || !event.item) return;
    this.ready.set(event.output_index, event.item);
    while (this.ready.has(this.nextIndex)) {
      const item = this.ready.get(this.nextIndex)!;
      this.ready.delete(this.nextIndex++);
      if (item.type !== 'function_call') continue;
      if (item.status !== 'completed') { this.barrierHit = true; continue; }
      this.dispatch({ id: item.call_id, name: item.name, args: item.arguments });
    }
  }

  private dispatch(call: { id: string; name: string; args: string }): void {
    if (!this.active()) return;
    if (this.barrierHit) return;
    // 保留帧不派发:消息落定后整个调用会被丢弃(不依赖"恰好没注册"这一层)
    if (RESERVED_FRAME_NAMES.has(call.name)) return;
    if (!call.id) {
      // 上游没给 call id 时无法在消息落定后配对(空串键会互相覆盖);
      // 跳过提前派发,落回消息落定后的执行路径
      this.log.warn('tool_call 缺 id,跳过提前派发', { name: call.name });
      return;
    }
    const def = this.defs().find((t) => t.name === call.name);
    if (!def) return;
    // 屏障工具本身可以提前执行(屏障约束的是"后面的调用要等模型读过它的结果")
    if (def.barrierAfter) this.barrierHit = true;
    const args = parseToolArgs(call.args);
    if (args === null) return; // 落回非流式路径的"arguments are not valid JSON"回执
    // 串行执行:前一个 handler 完成才启动下一个(非流式路径也是逐个 await)。
    // "打断当前台词,紧接着说新话"这类组合依赖这条顺序保证。
    const run = this.chain.then(() => this.active()
      ? runToolHandler(def, args, this.ctx, call.id, this.role, this.toolLog, this.active, this.owner(def.name))
      : { text: NOT_EXECUTED_LOOP_STOPPED });
    this.chain = run.then(() => undefined);
    this.results.set(call.id, run);
  }

  /** 取走某次调用的执行结果;没提前派发过返回 undefined(一次性,防重复配对) */
  take(callId: string): Promise<ToolOutcome> | undefined {
    const p = this.results.get(callId);
    this.results.delete(callId);
    return p;
  }
}
