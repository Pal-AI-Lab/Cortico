import { message, record, functionCall, functionResult, responseRecords, itemText, withText, type ContextRecord, type Item } from '../protocol/open-responses/context.ts';
import { hasRole, textOf, withoutPastReasoning, responseRequest, usageCounters } from '../protocol/open-responses/context-helpers.ts';
import type { Response, StreamEvent } from '../protocol/open-responses/index.ts';
import { GenerationError, type ResponseClient, type TokenMeters } from './generation.ts';
/**
 * MainLoop 执行 receivesEvents=true 的常驻 session。
 * 内部文本进入 user 消息；外部正文按 eventDelivery 进入合成工具回执（默认）
 * 或同一条 user 消息，不进入 system role。无工具调用的响应或已执行的 endsTurn 工具结束本轮。
 * 交接在稳定回合边界取快照，期间不投递事件；并发交接请求共用事务。
 * Persona 提供交接内容与主动触发策略；Core 在超过模型容量时强制交接，
 * 修复工具配对、限制保留内容大小并重写上下文。
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
 * 已挂载 World 的当前状态。隐藏不停止 World；事件投递立即停止，
 * 环境前缀与工具表在前缀重建时一同更新，避免保留已不可用工具的说明。
 */
export interface WorldView {
  /** 全部已挂载 World(含被隐藏的) */
  all(): World[];
  /** 当前对 agent 可见的 World */
  visible(): World[];
}

/** 当前工具名称，用于检查工具表是否需要重建。 */
function toolSignature(mod: World): string {
  return mod
    .tools()
    .map((t) => t.name)
    .join(',');
}

/** 按当前活跃端点读取上下文容量与计数，支持模型和端点热更新。 */
export interface ContextFacts {
  /** 输入容量为模型窗口减单轮生成上限；窗口未知时返回 null，Core 不据此限制输入。 */
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
  /** 当前活跃端点的模型配置，每轮读取。 */
  spec: () => ModelSpec;
  context: ContextFacts;
  /** 记录落库刻的附件内部化(新字节进日志附件库、已有句柄补 mime);core 提供 */
  blobs: { intern(inputs: readonly (BlobInput | BlobRef)[] | undefined): BlobRef[] | undefined };
  /** 已挂载 World 的**实时**视图(可见性可被运维改;见 WorldView) */
  worlds: WorldView;
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
  /** 同一批内模型失败后重新请求的预算，缺省使用 DEFAULT_RESUBMIT。 */
  resubmit?: ResubmitPolicy;
}

/**
 * 同一批内模型失败后的重新请求策略，沿用已保存的部分输出与工具回执。
 * 仅状态 0、429、5xx 可重新请求；输入超限触发交接，其他 4xx、抢占、
 * 关机和达到轮数上限均结束本批。
 */
export interface ResubmitPolicy {
  /** 允许重新请求的连续失败次数；例如 2 表示第三次连续失败结束本批。 */
  maxConsecutive: number;
  /** 一批内重新请求的总次数上限。 */
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
  /** 下次请求的输入 token 数：上游计数覆盖部分加新增条目估算；无上游计数时全部估算。 */
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
  /** 当前是否安装了 DeliveryGate。 */
  scheduleBlocked: boolean;
  lastUsage: LLMUsage | null;
  /** 投递水位：最后一条已投递或已了结事件的位置游标。 */
  lastDeliveredCursor: number;
  /** 水位之后该进上下文却还没投递的外部事件数。 */
  behind: number;
}

/**
 * 合成外部投递帧使用的保留名称，不注册为工具。
 * 模型返回的同名调用在写入 session 前丢弃，不检查其参数或 id。
 */
const EXTERNAL_EVENT_FRAME = 'external_event_frame';
/** 失败时刻的保留窗口，供 World 查询与恢复通知使用。 */
const STALL_WINDOW_MS = 3_600_000;
/**
 * LLM 连续失败达到此次数时报告 error，恢复后解除告警。该阈值仅控制告警，不改变重试节奏。
 */
const STALL_ALERT_THRESHOLD = 5;
/** 不能注册为工具的名称；模型返回的同名调用不写入 session。 */
export const RESERVED_FRAME_NAMES = new Set<string>([EXTERNAL_EVENT_FRAME]);

/** 事件正文的位置元数据；各事件 text 用换行拼接，base 是事件块在整条正文中的起点。 */
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

/** 重启补投的数量上限；仅补投最近事件，更早的事件标记已处理并推进水位。 */
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

/** 延迟渲染期限；超时项不归档、不投递。 */
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
  /** onDelivery 同步执行期间，injectInternal 的即时项加入当前批，不经过总线。 */
  private deliveryCollector: EventEnvelope[] | null = null;
  /** 已投递但前面仍有外部缺口的游标；水位只越过连续前缀。 */
  private readonly deliveredCursors = new Set<number>();
  /**
   * 已由候选处理函数处理的原始归档位置，包含选中及丢弃项。
   * 未处理的归档项阻止水位越过；该集合不持久化，重启时根据已生成事件的来源引用恢复。
   */
  private readonly settledArchives = new Set<number>();
  /**
   * 窗口内的 LLM 失败时刻，单位为毫秒。保存在 state.data.llmStall，
   * 跨重启保留；恢复时通知 Persona，World 可按时间窗口查询。
   */
  private get stallAt(): number[] { return this.d.state.data.llmStall.at; }
  /** 当前这串连续失败的第一次发生时刻;0 = 此刻没在失败串里 */
  private get stallSince(): number { return this.d.state.data.llmStall.since; }
  private set stallSince(at: number) { this.d.state.data.llmStall.since = at; }
  /** 当前连续失败是否已告警；恢复后解除，同一串不重复告警。 */
  private stallAlarmActive = false;
  /** run() 启动水位巡查，stop() 取消。 */
  private watermarkAudit: ReturnType<typeof setInterval> | null = null;
  /**
   * 已报告停滞的水位，-1 表示未报告。水位推进后重置；
   * 同一水位按 WATERMARK_RESTATE_MS 间隔再次报告。
   */
  private watermarkStallAt = -1;
  /** 当前这次停滞的首报时刻(退避重报的基准) */
  private watermarkStallSince = 0;
  /** 首报时的积压量，后续报告据此计算增长量。 */
  private watermarkStallBehind = 0;
  /** 同一次停滞已报次数(首报计 1) */
  private watermarkStallReports = 0;
  /**
   * 最近成功请求的输入与输出 token 总数，覆盖前 records 条（含响应）。
   * 新增条目使用本地估算，下次成功后更新计数；上下文整体重写后失效。
   */
  private anchor: { records: number; tokens: number; reasoningTokens: number } | null = null;
  /** 当前 system 前缀和工具表采用的可见 World 集合。 */
  private appliedVisibleWorlds: Set<string> | null = null;
  /** 当前前缀中各可见 World 的工具签名，用于检测工具表漂移。 */
  private appliedWorldTools = new Map<string, string>();
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
  /** stop() 提前结束重试等待，由 active() 决定退出。 */
  private backoffWake: (() => void) | null = null;
  /**
   * 工具信号合并关机信号与当前模型调用信号。
   * 自动抢占仅发生在没有外部输出、尚未执行工具时；工具执行期间仅关机或循环换代会取消。
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

  /** 尝试取消尚未输出的当前模型调用；无可取消调用时返回 false。 */
  abortCurrentRound(): boolean {
    if (!this.activeNow()) return false;
    const round = this.currentRound;
    if (!round || round.externalized) return false;
    round.abortReason = 'preempt';
    round.controller.abort(new Error('模型轮被新输入抢占'));
    return true;
  }

  /**
   * 工具 schema 与 handler 来自 session 声明；此处去重、稳定排序并按名称过滤隐藏 World 工具。
   * World 之间、与 Persona 声明的自有工具及保留帧重名时，装配层拒绝挂载。
   * Persona 未声明自有工具名时，此处保留先注册项并告警。
   */
  private assembleTools(hiddenToolNames: Set<string>): void {
    const { decl, log } = this.d;
    const defs: ToolDef[] = [];
    const seen = new Set<string>();
    for (const def of decl.tools()) {
      if (RESERVED_FRAME_NAMES.has(def.name)) {
        // 保留帧名称不能注册为工具，同名模型调用会被丢弃。
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

  /** 空 tags 只报告一次。 */
  private readonly warnedUntagged = new Set<string>();

  /** 按当前可见性重建工具表并记录所用 World 集合；重启恢复前缀时也执行。 */
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
    return message('system', content);
  }

  /**
   * 在持久上下文的 system 消息后插入合成开头，生成请求与快照使用的副本。
   * 继承快照的 fork 保留相同的请求前缀；开头为空时仅复制原上下文。
   */
  outboundMessages(): ContextRecord[] {
    const msgs = this.d.session.records;
    const head = this.sessionHead();
    if (head.length === 0) return [...msgs];
    let at = 0;
    while (at < msgs.length && hasRole(msgs[at], 'system')) at++;
    return [...msgs.slice(0, at), ...head, ...msgs.slice(at)];
  }

  /**
   * Persona 的合成开头,每次现取:system 与 developer 项丢弃,工具配对补齐,全部带不落盘标记。
   * Persona 没提供或抛错时为空。
   */
  sessionHead(): ContextRecord[] {
    const { persona, log } = this.d;
    let items: Item[];
    try {
      items = persona.sessionHead?.() ?? [];
    } catch (e) {
      log.warn('sessionHead 读取失败,本次不注入', { err: e });
      return [];
    }
    const kept = items.filter((item) => !(item.type === 'message' && (item.role === 'system' || item.role === 'developer')));
    if (kept.length !== items.length) log.warn('sessionHead 里的 system/developer 项已丢弃', { dropped: items.length - kept.length });
    return fixPairing(kept.map((item) => record(item, { head: true })))
      .map((entry) => (entry.context.head ? entry : { ...entry, context: { ...entry.context, head: true as const } }));
  }

  /**
   * 比较当前 World 可见性及工具名称与构建前缀时的记录，供控制台提示重载。
   * 工具名可同步读取，因此用它检测 World 功能变化，不直接读取异步环境模板。
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

  /** 一轮结束时先通知 Persona，再通知可见 World。 */
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
   * 将一批事件写入主 session。即时事件在前，候选生成内容与延迟渲染内容在后。
   * 候选按 source、origin 和处理函数分组，再按来源项在批次中的顺序生成正文。
   * 正文归档后调用 onDelivery；同步注入的内部项追加到内部行末尾、外部正文之前。
   * 内部行合成一条 user 消息；外部正文按 eventDelivery 进入合成工具回执或同一条 user 消息。
   */
  private async deliverBatch(batch: WakeItem[], generation: number): Promise<boolean> {
    if (!this.active(generation)) return false;
    const { session, persona, store, cfg, log } = this.d;
    const projections = this.prepareCandidateProjections(batch, generation);
    if (!this.active(generation)) return false;
    // 已调用候选处理函数的原始事件均标记已处理，含选中与丢弃项。
    // 尚未交给处理函数的候选继续阻止水位推进。
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
      if (rendered === null) continue; // 未生成正文，不归档、不投递。
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
      // 仅捕获同步钩子内的即时注入；退出钩子后恢复总线投递。
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
    if (events.length > 0 && inUser) lines.push(renderEventLines(events));
    // 仅当整条消息都可清除时标记 ephemeral，混合消息需保留其他内容。
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

  /** 候选选择由来源 World 决定；Core 组批、校验来源引用并收集输出。 */
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

  /** 每批投递前删除带 ephemeral 标记的旧消息；重启读回的标记同样有效。 */
  private dropEphemeral(generation: number): void {
    if (!this.active(generation)) return;
    const { session } = this.d;
    if (!session.records.some((m) => m.context.ephemeral)) return;
    const kept = session.records.filter((m) => !m.context.ephemeral);
    const dropped = session.records.length - kept.length;
    session.reset(kept);
    this.d.transcript?.boundary('ephemeral-drop', { dropped });
  }

  /** 延迟渲染应读取当前状态；null、超时或异常均不归档、不投递，超时与异常记录日志。 */
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
        log.warn("延迟渲染超时，该项未归档、未投递", { type: spec.type, source: spec.source });
        return null;
      }
      return out;
    } catch (e) {
      log.warn("延迟渲染失败，该项未归档、未投递", { type: spec.type, source: spec.source, err: e });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 以合成调用及回执承载外部正文，不新增模型请求。
   * 该模式下 user 消息仅承载内部文本。
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
   * 丢弃模型返回的保留帧调用并记录日志，其余调用照常执行。
   * 删除后没有工具调用的响应按自然结束处理。
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
      // 未处理的 archive-only 项必须保留在水位之后，重启才会补投。
      // 已处理项由 settledArchives 标识。
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

  /** session 开场时调用 Persona 钩子；未注入时不添加开场文本。 */
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
    // 推进水位前，先从已生成事件的引用恢复 settledArchives。
    // 否则重启前已处理的原始归档仍会阻止水位推进。
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
    // 恢复窗口内的失败记录，供重启后的首次成功报告。
    if (this.pruneStalls()) this.d.state.save();
    if (this.stallSince !== 0) {
      const carried = this.stallAt.filter((t) => t >= this.stallSince).length;
      log.warn('已恢复上一进程的 LLM 连续失败记录', {
        since: new Date(this.stallSince).toISOString(),
        count: carried,
      });
      // 已达到阈值的持久记录不重复告警，恢复时仍报告解除。
      this.stallAlarmActive = carried >= STALL_ALERT_THRESHOLD;
    }
    this.requeueUndelivered();
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

      // unref 避免巡查定时器阻止进程退出。
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
            // 先执行本批登记的交接请求，再运行批末钩子与容量检查。
            await this.flushRequestedHandoff(generation);
            if (!this.active(generation)) break;
            await this.batchEndCheck(generation);
            if (!this.active(generation)) break;
          }

          // 延迟渲染和 piggyback 项不阻止进入空闲钩子。
          if (bus.pendingImmediate() === 0 && persona.onIdle) {
            try {
              await persona.onIdle();
            } catch (e) {
              log.warn('onIdle钩子异常', { err: e });
            }
            if (!this.active(generation)) break;
          }
          // onIdle 等待期间也可能收到手动交接请求。
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

  /** 本批模型调用共享 sess 关联字段；每轮更新 round、resp 和 call。 */
  private rounds(generation: number): Promise<void> {
    return withAnchors({ sess: this.d.decl.id }, () => this.roundsInScope(generation));
  }

  private async roundsInScope(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    const { llm, session, log, bus, decl } = this.d;
    const schemas = this.getToolSchemas();
    const caps = decl.rounds();
    this.roundsLastBatch = 0;
    // tap 接收流式增量；其异常只记日志，不中断模型调用。
    const tap = decl.outputTap;
    const resubmit = this.d.resubmit ?? DEFAULT_RESUBMIT;
    let consecutiveFailures = 0;
    let resubmits = 0;

    for (let round = 1; ; round++) {
      if (!this.active(generation)) return;
      this.roundsLastBatch = round;
      const spec = this.d.spec();
      // 后续轮输入超限时结束本批，由批末检查执行交接。
      // 首轮仍处理本批新投递的事件；上一批的容量检查已在批末执行。
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
        // 关机或循环换代取消工具；自动抢占不取消工具。
        signal: AbortSignal.any([flight.controller.signal, this.shutdown.signal]),
        queueExternalEvents: (events) => {
          if (this.active(generation)) queuedEvents.push(...events);
        },
      };
      // 工具调用闭合后可提前执行；协议层保证闭合顺序与消息内顺序一致。
      // barrierAfter 阻止之后的调用提前执行。
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
        // role 仅用于故障分类，不写入请求体。
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
          // 已向外发送的部分输出必须保存；已执行的工具调用使用真实结果配对。
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
        // 提前执行的工具可能已消费队列；失败后将这些事件退回总线。
        // 重试前重新接收已就绪事件，否则随下一批投递。
        for (const event of queuedEvents) {
          bus.push({ event }, { trigger: 'flush' });
        }
        // 上游报告输入超限时，不记入连续失败，结束本批后交接。
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
          // 4xx 正文截断后记录；流内失败保留协议层提供的失败事件。
          ...(e instanceof GenerationError && e.body ? { body: e.body.slice(0, 500) } : {}),
          ...(e instanceof GenerationError ? { status: e.status } : {}),
          attempt: consecutiveFailures,
        };
        // 按 ResubmitPolicy 重试，沿用已保存的部分输出与工具回执。
        const retryable = e instanceof GenerationError && (e.status === 0 || e.status === 429 || e.status >= 500);
        if (retryable && consecutiveFailures <= resubmit.maxConsecutive && resubmits < resubmit.maxPerBatch && round < caps.hard) {
          resubmits++;
          const delayMs = resubmit.backoffMs[Math.min(consecutiveFailures, resubmit.backoffMs.length) - 1] ?? 0;
          log.warn('LLM 调用失败，退避后在本批内重试', { ...detail, resubmits, delayMs });
          noteRound('failed', { resubmit: true, delayMs });
          await this.backoff(delayMs);
          if (!this.active(generation)) return;
          // 重试前先投递等待期间已就绪的事件。
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
          // 不再执行模型请求时，事件退回总线随下一批投递。
          for (const item of arrived) bus.push(item, { trigger: 'flush' });
        } else {
          await this.deliverBatch(arrived, generation);
          if (!this.active(generation)) return;
        }
      }

      // endsTurn 与自然结束使用同一出口；事件已退回总线。
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

  /** 重新请求前等待；stop() 通过 backoffWake 提前结束等待。 */
  private backoff(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.backoffWake = null; resolve(); }, ms);
      this.backoffWake = () => { clearTimeout(timer); this.backoffWake = null; resolve(); };
    });
  }

  /**
   * 保存已经发送的部分响应。已执行调用使用实际结果；
   * 未执行调用补充未执行标记，保持后续请求的工具配对。
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

  /** 按请求内容估算，排除不会回传的历史推理。 */
  private estimateOutbound(msgs: readonly ContextRecord[]): number {
    const view = this.d.cfg.context.keepPastThinking ? msgs : withoutPastReasoning(msgs);
    return this.d.context.estimateTokens(view);
  }

  /**
   * 使用上次成功请求的 token 计数，加上此后新增条目的本地估算。
   * 禁用历史推理时扣除上次输出中的推理量；无上游计数时估算完整请求，含合成首轮对话。
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

  /** 上游已计数的部分；全部由本地估算时为 0。 */
  private countedTokens(): number {
    const { anchor } = this;
    if (!anchor || this.d.session.records.length < anchor.records) return 0;
    return anchor.tokens - (this.d.cfg.context.keepPastThinking ? 0 : anchor.reasoningTokens);
  }

  /** 主 session 的计数与物理上限(sessionInfo 查询面的数据源)。 */
  contextGauge(): { estTokens: number; hardTokens: number | null } {
    return { estTokens: this.estTokens(), hardTokens: this.d.context.hardTokens() };
  }

  /** 一批结束后调用 Persona 钩子，再检查是否超过模型容量；超限时强制交接。 */
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
   * Persona.onHandoff 提供保留内容；事务期间停止投递，钩子注入项进入新 session 的首批。
   * 策略失败或返回内容越界时使用默认重建结果。
   */
  private async performHandoff(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    const { cfg, session, state, log, persona } = this.d;
    // 快照包含合成开头，继承它的 fork 保留相同请求前缀；clampTail 把它排除在持久上下文外。
    const snapshot = this.outboundMessages();
    const before = this.estTokens();
    let result: ContextHandoffResult = { tail: null };
    try {
      if (persona.onHandoff) result = await persona.onHandoff(snapshot, { hardTokens: this.d.context.hardTokens() });
    } catch (e) {
      log.error('上下文交接策略失败,继续机械重建', { err: e });
    }
    if (!this.active(generation)) return;

    // 策略执行后重建前缀，读取其可能更新的内容。
    const sysMsg = await this.buildSystem();
    if (!this.active(generation)) return;
    const newTail = this.clampTail(result, snapshot, [sysMsg, ...this.sessionHead()]);
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
   * 修复保留内容的工具配对，并将新前缀与保留内容限制在 hardTokens 内。
   * null 从快照末尾重建；上限未知时仅修复配对。trim 表示候选内容允许超限后裁剪。
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
      const candidate = snapshot.slice(start).filter((m) => !m.context.head);
      return budget === null ? fixPairing(candidate) : rebuildTail(candidate, budget, estimate);
    }
    // system 和合成开头不属于持久化的保留内容。
    const paired = fixPairing(tail.filter((m) => !hasRole(m, 'system') && !m.context.head));
    if (budget === null || estimate(paired) <= budget) return paired;
    // trim 表示允许 Core 从候选内容裁剪，无需报告策略越界。
    if (!result.trim) log.warn('交接策略返回的动态尾越过模型上下文上限,按机械默认裁剪', { budget });
    return rebuildTail(paired, budget, estimate);
  }

  /** 清空主 session，重建 system 前缀并调用 Persona 开场钩子；事件库保留。 */
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
   * 通过 Persona.systemSegments 和 World 环境模板重建 system 前缀。
   * 只替换 system 消息，保留既有 user、assistant 和工具记录。
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
    this.releasePrefixReload = null;
    release();
    await this.prefixReloadPromise;
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

  /** 记录失败时刻与连续失败起点，并持久化。 */
  private noteStalled(): void {
    const now = Date.now();
    if (this.stallSince === 0) this.stallSince = now;
    this.stallAt.push(now);
    this.pruneStalls(now);
    this.d.state.save();
    // 同一串连续失败达到阈值时仅告警一次，不改变重试策略。
    if (!this.stallAlarmActive && this.stallSince !== 0) {
      const count = this.stallAt.filter((t) => t >= this.stallSince).length;
      if (count >= STALL_ALERT_THRESHOLD) {
        this.stallAlarmActive = true;
        this.d.log.error(
          `[告警] LLM 连续失败 ${count} 次；请检查请求错误与上游状态`,
          {
            count,
            since: new Date(this.stallSince).toISOString(),
            threshold: STALL_ALERT_THRESHOLD,
          },
        );
      }
    }
  }

  /** 清除窗口外的失败时刻；窗口内已无失败记录时同时清除连续失败起点。 */
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
   * 首次成功后将连续失败次数与时长交给 Persona.onStallsRecovered，并清除起点。
   * 未提供钩子或未返回正文时不注入恢复通知。
   */
  private noteStallsRecovered(): void {
    this.pruneStalls();
    if (this.stallSince === 0) {
      // 失败记录超出窗口时解除现有告警。
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

  /** 查询最近 withinMs 毫秒内的模型失败次数。 */
  llmStalls(withinMs: number): number {
    const from = Date.now() - Math.max(0, withinMs);
    return this.stallAt.filter((t) => t >= from).length;
  }

  /** 注入 Persona 提供的内部文本。onDelivery 同步执行期间加入当前批，其余时刻进入总线。 */
  injectInternal(text: string, kind = 'notice'): void {
    if (!this.activeNow()) return;
    const item = this.internalItem('persona', kind, text);
    if (this.deliveryCollector) {
      this.deliveryCollector.push(item.event);
      return;
    }
    this.d.bus.push(item);
  }

  /** 注入 Persona 提供的外部正文；source=persona、origin=external，按 eventDelivery 投递。 */
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

  /** 内部项在投递时渲染并归档；投递正文与归档正文一致。 */
  injectDeferred(kind: string, render: () => string | null | Promise<string | null>): void {
    if (!this.activeNow()) return;
    this.d.bus.push({ deferred: { type: kind, source: 'persona', origin: 'internal', render } });
  }

  /**
   * 内部项与外部事件共用事件库和游标，origin 标记为 internal；调用方决定投递时机。
   * source 记录生产方。
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

  /** 当前工具 schema，供模型与控制台使用；run() 前为空。tags 保留声明方的分类。 */
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
      this.d.log.error('关机时工具调用配对记录写入失败', { callIds: failed });
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

/** 普通执行与流式提前执行共用工具处理及日志记录；异常转换为失败回执。 */
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
 * 工具调用在流中闭合后可提前执行，闭合顺序由协议层保证。
 * barrierAfter 阻止后续调用提前执行；其后调用在响应结束时记为未执行。
 * 结果按 call id 暂存，rounds() 按消息顺序取回配对；无效 JSON 留待常规路径生成错误回执。
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
    // 保留帧调用不执行，也不写入 session。
    if (RESERVED_FRAME_NAMES.has(call.name)) return;
    if (!call.id) {
      // 上游没给 call id 时无法在消息落定后配对(空串键会互相覆盖);
      // 跳过提前派发,落回消息落定后的执行路径
      this.log.warn('tool_call 缺 id,跳过提前派发', { name: call.name });
      return;
    }
    const def = this.defs().find((t) => t.name === call.name);
    if (!def) return;
    // 屏障工具自身可提前执行，后续调用不能提前执行。
    if (def.barrierAfter) this.barrierHit = true;
    const args = parseToolArgs(call.args);
    if (args === null) return; // 落回非流式路径的"arguments are not valid JSON"回执
    // handler 按调用顺序串行执行。
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
