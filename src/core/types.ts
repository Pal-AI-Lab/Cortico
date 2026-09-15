import type { PriceDefinition } from '../providers/pricebook.ts';
import type { ContextRecord, Item } from '../protocol/open-responses/context.ts';
import type { StreamEvent } from '../protocol/open-responses/index.ts';
import type { ResponseClient, ProviderAttempt } from './generation.ts';
import type { ConfigGroup } from './config-schema.ts';
import type { Language } from './language.ts';

export type { ConfigGroup, ConfigProperty, ConfigValues } from './config-schema.ts';

/** Core、Persona 与 World 的共享契约；session id 对 Core 不透明。 */

/**
 * 事件的上下文分区。internal 正文进入 user 消息；external 正文按 SessionDecl.eventDelivery 投递。
 * 两类事件共用总线、批次、投递闸门和事件库。
 */
export type EventOrigin = 'external' | 'internal';

/**
 * 事件分类标签，由消费方决定保留方式。
 * - snapshot：当前状态；交接记录按 source/type 仅保留最后一条。
 * - speak：对外发言的播放结果；交接记录仅保留最近一段。
 * 标签不改变事件的 type；状态与结果需要不同的保留方式时应使用不同 type。
 */
export type EventTag = 'snapshot' | 'speak';

/**
 * 持久化事件记录。cursor 是落库时分配的全局递增序号。
 * CoreApi 不暴露事件库；Persona 通过 World 历史工具查询外部事件。
 */
export interface EventEnvelope {
  cursor: number;
  /** 事件所属的 run 分片；cursor 跨 run 递增。 */
  run?: string;
  /** 产生方定义的事件类型。 */
  type: string;
  /** ISO 8601 带时区偏移 */
  ts: string;
  /** 产生方 id：World id、core 或 persona。 */
  source: string;
  /** World 未指定时由 Core 填入 external。 */
  origin: EventOrigin;
  tags?: readonly EventTag[];
  /**
   * 是否可进入模型上下文；缺省为 deliver。
   * archive-only 由候选处理结果承载投递；水位之后且未被结果引用的外部原始事件可在重启时补投。
   */
  contextDelivery?: 'deliver' | 'archive-only';
  /**
   * 产生方生成的正文，直接进入上下文。
   * Core 不改写正文；事件库 cursor 不属于正文，平台消息 id 由 World 自行标注。
   */
  text: string;
  /** 产生方定义的稳定过滤键。 */
  senderKey?: string;
  /** 产生方私有数据，不渲染进模型上下文。 */
  meta?: Record<string, unknown>;
  /**
   * 随事件保存的附件；BlobInput 落库时转为 BlobRef，fallbackText 附在正文后。
   * 投递时按模型接受的 MIME 类型附加内容。
   */
  blobs?: BlobRef[];
  /**
   * 在下一批投递时从 session 移除；事件库记录保留。
   * 仅在整批内部项均为 ephemeral 且无外部正文时生效。
   */
  ephemeral?: true;
}

/**
 * 延迟到投递时渲染的事件。render 读取现有状态，不执行长时间采样。
 * 返回 null、抛错或超过投递期限时，不落库、不投递。
 * 游标和时间戳在投递时分配；排队项不持久化，不参与重启补投。
 */
export interface DeferredEventSpec {
  type: string;
  source: string;
  origin: EventOrigin;
  senderKey?: string;
  meta?: Record<string, unknown>;
  tags?: readonly EventTag[];
  render: () => DeferredRendered | null | Promise<DeferredRendered | null>;
}

export type DeferredRendered = string | { text: string; blobs?: BlobInput[] };

/** 候选的原始事件；宿主补全来源、游标并以 archive-only 保存。 */
export type CandidateSourceEvent = Omit<
  EventEnvelope,
  'cursor' | 'source' | 'origin' | 'contextDelivery'
>;

/** 候选处理生成的事件；时间戳和游标在投递时分配。 */
export type CandidateProjectionEvent = Omit<CandidateSourceEvent, 'ts'>;

/** 一次候选处理的输出；candidateIndexes 指向输入候选数组中被此事件引用的项。 */
export interface CandidateProjection {
  candidateIndexes: readonly number[];
  event: CandidateProjectionEvent;
}

export interface CandidateEventSpec {
  source: string;
  origin: EventOrigin;
  /** 该候选引用的原始归档，按到达顺序排列。 */
  sourceEvents: readonly EventEnvelope[];
  /** 仅供投递闸门做字面关键词匹配，不渲染进上下文。 */
  gateText: string;
  /** World 的候选数据；Core 不解释其内容。 */
  value: unknown;
  project: CandidateProjector;
}

/** 每批按来源和 project 函数分组调用一次，选择或合并候选。 */
export type CandidateProjector = (
  candidates: readonly CandidateEventSpec[],
) => readonly CandidateProjection[];

export interface CandidatePushSpec {
  /** 每条源事件单独归档。 */
  sourceEvents: readonly CandidateSourceEvent[];
  gateText: string;
  value: unknown;
  project: CandidateProjector;
  origin?: EventOrigin;
}

/** 总线项包括已落库事件、待渲染事件和候选。事件生成方式与 TriggerMode 相互独立。 */
export type WakeItem =
  | { event: EventEnvelope; deferred?: undefined; candidate?: undefined }
  | { event?: undefined; deferred: DeferredEventSpec; candidate?: undefined }
  | { event?: undefined; deferred?: undefined; candidate: CandidateEventSpec };

export interface EventRangeQuery {
  /** 游标区间(含端点) */
  fromCursor?: number;
  toCursor?: number;
  /** ISO时间区间(含端点) */
  fromTs?: string;
  toTs?: string;
  senderKey?: string;
  source?: string;
  origin?: EventOrigin;
  /** 从区间末尾取至多 limit 条事件。 */
  limit?: number;
}

export interface EventGrepQuery {
  /** 不区分大小写的纯文本包含匹配。 */
  keyword: string;
  /** 每个命中附带前后各 context 条事件。 */
  context: number;
  senderKey?: string;
  source?: string;
  origin?: EventOrigin;
  fromTs?: string;
  toTs?: string;
  /** 最多返回的命中组数。 */
  limit?: number;
}

export interface EventGrepHit {
  hitCursor: number;
  /** 命中事件与相邻上下文,按游标升序。 */
  events: EventEnvelope[];
}

export interface EventStoreReader {
  get(cursor: number): EventEnvelope | undefined;
  latestCursor(): number;
  range(q: EventRangeQuery): EventEnvelope[];
  /** 返回前 before 条、自身及后 after 条事件。 */
  around(cursor: number, before: number, after: number): EventEnvelope[];
  grep(q: EventGrepQuery): EventGrepHit[];
}

export interface EventStore extends EventStoreReader {
  /** 保存事件并分配游标；不触发投递。 */
  append(e: Omit<EventEnvelope, 'cursor'>): EventEnvelope;
}

/** 发给模型 API 的函数工具定义。 */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema 对象 */
  parameters: Record<string, unknown>;
}

/**
 * 工具分类标签，供装配和上下文处理使用，不发送给模型。
 * - read：不改变外部状态或持久状态；不保证无成本、无需排队或可并发执行。
 * - write：修改 Memory 或 World 的内部记录。
 * - speak：对外发言及对自身输出通道的控制。
 * - act：改变外部状态，但不发言。
 * - flow：控制 session、调度或认知流程。
 * - snapshot：回执描述当前状态，可与其他标签并用；交接记录按工具名仅保留最后一次。
 * 执行屏障和结束行为由 ToolDef 的字段声明。
 */
export type ToolTag = 'read' | 'write' | 'speak' | 'act' | 'flow' | 'snapshot';

export interface ToolCallContext {
  /** Persona 定义的 session id；Core 仅用于查询、用量统计和日志关联。 */
  role: string;
  log: Logger;
  /**
   * 将工具执行期间取得的外部事件交给主循环，在本轮工具结果之后投递。
   * 仅主循环提供；其他调用方可省略。
   */
  queueExternalEvents?: (events: EventEnvelope[]) => void;
  /** session 内的 tool_call id，用于关联输出流和后续结果事件。直接调用工具时可省略。 */
  callId?: string;
  /**
   * 主循环轮次，进程内递增；同轮工具调用共用此值。
   * 仅主循环提供；缺省时消费方不能施加基于轮次的限制。
   */
  round?: number;
  /**
   * 宿主放弃本次调用时触发，跨进程代理超时也会触发。
   * 耗时工具必须在提交外部副作用前检查此信号。
   */
  signal?: AbortSignal;
}

/**
 * 工具结果；字符串返回值等价于 { text }。
 * 附件随回执保存，句柄由 Core 分配，文本说明附在正文后。
 */
export interface ToolOutcome {
  text: string;
  blobs?: BlobInput[];
  /** 执行失败；工具调用记录据此标记 failed。 */
  failed?: true;
}

/** handler 异常由 Core 转为失败回执。 */
export interface ToolDef extends ToolSchema {
  /** 装配层按标签筛选。空数组表示不分类，组装主工具表时会告警。 */
  tags: readonly ToolTag[];
  /**
   * 模型读取本工具结果后才可继续执行动作。
   * 同一条 assistant 输出中排在它后面的工具调用会被跳过。
   */
  barrierAfter?: boolean;
  /**
   * 工具完成后结束本次唤醒，不再调用下一轮模型；期间到达的事件退回总线。
   * 通常同时设置 barrierAfter，使同一条输出中的后续调用得到未执行回执。
   */
  endsTurn?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolOutcome>;
}

/** 供 Persona 绑定 handler 的工具声明。 */
export type ToolSpec = ToolSchema & { usage?: string; tags: readonly ToolTag[] };

/**
 * Persona 提供的 Memory 二进制存储。句柄以 mem: 开头，其余格式由后端定义。
 * nameHint 仅供参考，最终句柄由后端决定。
 */
export interface BlobStore {
  put(nameHint: string, bytes: Uint8Array, mime: string): string;
  get(handle: string): { bytes: Uint8Array; mime: string } | null;
  list(prefix?: string): Array<{ handle: string; mime: string; size: number }>;
}

/**
 * 已保存附件的引用。log: 由 Core 按内容分配，mem: 由 Persona 的 BlobStore 解析。
 * 模型接受该 MIME 类型时附加内容，否则只发送 fallbackText。
 */
export interface BlobRef {
  handle: string;
  mime: string;
  name?: string;
  /** 附件在 session 中的文本说明。 */
  fallbackText: string;
}

/**
 * 待保存的附件；可提供新字节或已有的 log:/mem: 句柄。
 * 两种形式均须提供 fallbackText，供上下文使用。
 */
export type BlobInput =
  | { bytes: Uint8Array; mime: string; name?: string; fallbackText: string }
  | { handle: string; fallbackText: string };

/** 上下文记录中的事件索引；正文位置为 content.slice(start, start + chars)。 */
export interface FrameEventRef {
  cursor: number;
  ts: string;
  type: string;
  source: string;
  tags?: readonly EventTag[];
  start: number;
  chars: number;
}

export interface ModelSpec {
  model: string;
  /** 是否请求推理；启用时强度由 reasoningEffort 指定。具体请求字段由 provider 映射。 */
  thinking: boolean;
  /**
   * 仅 thinking=true 时有效；缺省使用端点默认值。
   * provider 声明 reasoningTiers 时须使用表内值，开放模块接受任意非空字符串。
   */
  reasoningEffort?: string;
  /** 缺省时不发送温度参数，使用端点默认值。 */
  temperature?: number;
  maxTokens?: number;
  /**
   * 手动设置的上下文窗口上限（token）；与 provider 探测值取较小者。
   * 两者均未知时，Core 不按窗口大小裁剪上下文。
   */
  contextWindow?: number;
}

/**
 * provider 的推理选项，将 thinking 和 reasoningEffort 合并为一次选择。
 * 空选项表允许操作者填写任意非空 effort；provider 可提供建议值。
 */
export interface ReasoningTier {
  /** provider 内唯一的选项 id。 */
  id: string;
  label: string;
  thinking: boolean;
  effort?: string;
  /** 该选项的使用限制或说明。 */
  note?: string;
}

/** provider 支持的 service_tier 选项。 */
export interface ServiceTier {
  /** 发送给端点的 service_tier 值。 */
  id: string;
  label: string;
  /** 该选项的使用限制或说明。 */
  note?: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens?: number;
}

/** 单次模型调用的持久记录，保存于 data/usage.jsonl。 */
export interface UsageRecord {
  recordId?: string;
  version?: 2;
  run?: string;
  /** 主循环轮次；fork 和 World 自报用量不提供。 */
  round?: number;
  attempt?: ProviderAttempt;
  /** World 自报费用，不归属于当前 provider。 */
  charges?: import('./generation.ts').Charge[];
  /** 部署时区的 ISO 时间戳，格式由 nowIso 定义。 */
  ts: string;
  /** 常驻 session 使用声明 id；fork 实例 id 由声明 id 和序号派生。 */
  sessionId: string;
  /** Persona 定义的 session 声明 id，用于分类统计。 */
  role: string;
  label: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  /**
   * 缺省表示成功。failed 表示无可用结果；discarded 表示已返回结果因关机或运行代次变更而丢弃。
   * 两者的实际用量均计入总消耗，并在 UsageAggregate.failed 中单列。
   */
  outcome?: 'failed' | 'discarded';
  /** 请求前缀 SHA 指纹的前 12 位，用于判断前缀是否变化。 */
  prefixHash?: string;
  /** 失败调用从开流到失败的耗时（ms）。 */
  failedAfterMs?: number;
  /** 失败调用的上游请求 id。 */
  requestId?: string;
  /** 失败调用的 LLMError.status；0 表示流内失败。 */
  status?: number;
}

/** 单个 session 的轮数上限：soft 追加提示，hard 结束循环。 */
export interface RoundCaps {
  soft: number;
  hard: number;
  /** 第 soft 轮最后一条工具回执末尾的提示，由 Persona 提供；缺省或返回 null 时不追加。 */
  softHint?: () => string | null;
}

/**
 * Persona 注册的 session 声明。id 对 Core 不透明。
 * rounds 和 tools 在使用时读取，支持配置热改；模型配置来自当前 provider。
 */
export interface SessionDecl {
  id: string;
  /** 控制台与日志中的显示名。 */
  label: string;
  rounds: () => RoundCaps;
  /** 是否持久化；false 用于临时 fork。 */
  persistent: boolean;
  receivesEvents: boolean;
  /**
   * 外部事件在上下文中的位置，运行中不变。
   * - tool（默认）：进入保留的 external_event_frame 调用/回执对；模型生成的同名调用会被丢弃。
   * - user：进入 user 消息，排在内部文本之后。
   * 内部文本由 Persona.onDelivery 注入；Core 不添加说明。
   */
  eventDelivery?: 'tool' | 'user';
  /** 生成期间向此接收器转发输出增量；运行中不变。 */
  outputTap?: OutputTap;
  tools: () => ToolDef[];
}

/** 接收模型输出流；Core 不解释增量中的语义。 */
export interface OutputTap {
  onEvent(event: StreamEvent): void;
  /** 返回 true 表示增量已产生外部输出，此后主循环不再允许抢占该轮。 */
  externalizes?(event: StreamEvent): boolean;
  onRoundEnd?(): void;
  onAbort?(reason: string): void;
}

export interface ForkOptions {
  /** 已声明的 session id；默认工具和轮数上限来自该声明，模型来自当前 provider。 */
  id: string;
  /** 完整的初始上下文，由 Persona 构造。 */
  messages: ContextRecord[];
  tools?: ToolDef[];
  /** 每次工具执行后检查；返回 true 时结束循环。 */
  stopWhen?: () => boolean;
  /** 追加到收尾轮工具结果后的提示；轮次按 rounds().soft 设置，限制在 1 至 max(1, rounds().hard - 1)。 */
  wrapUpHint?: string;
  /** 循环达到硬上限时，追加到返回正文末尾的说明。 */
  capNote?: string;
  /**
   * 模型输出未满足要求时的补充提示 fallback。
   * 循环结束后，若 stopWhen 未满足且 when(最后正文) 为真，追加 user 提示并再运行一轮。
   */
  nudge?: { when: (lastContent: string) => boolean; message: string };
}

/** Persona 可查询的 session 状态。 */
export interface SessionInfo {
  id: string;
  /** 此声明当前运行的实例数。 */
  running: number;
  /** 接收事件的常驻 session 的请求上下文快照；其他 session 返回 null。 */
  snapshot: ContextRecord[] | null;
  /**
   * 下一次请求的输入 token 估计：最近的上游计数加新增内容估算；无上游计数时估算全部内容。
   * 仅接收事件的常驻 session 提供；其他 session 为 null。
   */
  estTokens: number | null;
  /**
   * 输入 token 上限：模型上下文窗口减生成上限，最低为 0；超过时 Core 强制交接。
   * 窗口未知或非接收事件的常驻 session 时为 null。
   */
  hardTokens: number | null;
}

/** Persona 返回的上下文交接结果。 */
export interface ContextHandoffResult {
  /** 不含 system 前缀的保留上下文；null 表示由 Core 从当前上下文选择。 */
  tail: ContextRecord[] | null;
  /**
   * 声明返回内容可由 Core 按剩余 token 预算裁剪，预算扣除 system 前缀与合成开头。
   * 未设置此项时，超限内容仍会被裁剪，但同时记录告警。
   */
  trim?: boolean;
}

/** Persona 访问 Core 的接口。 */
export interface CoreApi {
  /** 向接收事件的 session 注入内部事件；立即落库，正文由 Persona 提供。 */
  injectInternal(text: string, kind?: string): void;
  /** 注入内部事件，在投递时调用 render；渲染与持久化规则见 DeferredEventSpec。 */
  injectDeferred(kind: string, render: () => string | null | Promise<string | null>): void;
  /**
   * 将 Persona 提供的正文作为外部事件投递，source=persona、origin=external。
   * 正文位置由 SessionDecl.eventDelivery 决定。
   */
  injectExternal(text: string, kind?: string): void;
  /** 在安全轮次边界请求上下文交接；已有请求待处理时返回 false。 */
  requestContextHandoff(): boolean;
  /** 运行临时 session 的工具循环，返回最后一段正文。 */
  spawnFork(opts: ForkOptions): Promise<string>;
  sessionInfo(id: string): SessionInfo;
  /** 记录用量并支持重试的模型客户端。 */
  llm: ResponseClient;
  /** 跨重启恢复的定时器；载荷对 Core 不透明。 */
  timers: TimersApi;
  /** 按 FIFO 顺序扣留和放行唤醒项；安装、解除与到期策略由 Persona 定义。 */
  deliveryGate: DeliveryGateApi;
  /**
   * 返回共享的 Persona 状态对象；修改后须调用 savePersonaState 原子保存。
   * Core 不解释其内容。
   */
  personaState(): Record<string, unknown>;
  savePersonaState(): void;
  /** 当前主 session 工具表中带有指定标签的工具名。 */
  toolsTagged(tag: ToolTag): ReadonlySet<string>;
  /** 解析 log:/mem: 句柄；规则与 WorldHost.blob 相同。 */
  blob(handle: string): { bytes: Uint8Array; mime: string } | null;
  log: Logger;
}

/** 持久定时器条目；payload 对 Core 不透明。 */
export interface TimerEntry {
  id: string;
  /** 到期时刻；保留设定方提供的 ISO 字符串。 */
  atIso: string;
  payload: Record<string, unknown>;
}

/** 跨重启恢复的定时器。 */
export interface TimersApi {
  set(atIso: string, payload?: Record<string, unknown>): { ok: true; id: string } | { ok: false; error: string };
  cancel(id: string): boolean;
  list(): ReadonlyArray<TimerEntry>;
  /** 清除全部条目，返回删除数量。 */
  clearAll(): number;
  /** 注册唯一的到期处理器；调用时该条目已从表中移除。 */
  onDue(handler: (entry: TimerEntry) => void): void;
}

/**
 * 扣留全部唤醒项；解除、关键词命中或积压溢出时，可按 FIFO 顺序放行整批。
 * 关键词是否放行由回调决定；溢出时先授予整批放行许可，再调用回调。操作者暂停的优先级更高。
 */
export interface DeliveryGate {
  id: string;
  /** 区分大小写的字面子串；匹配外部事件正文或候选 gateText。 */
  keyword?: string;
  /** 被扣留的外部即时事件和候选数超过此值时，通知回调并临时放行一批；不计 piggyback 项。 */
  overflowLimit: number;
  onKeyword: () => void;
  onOverflow: () => void;
}

export interface DeliveryGateApi {
  /** 安装或替换闸门；此前无闸门时，已积压内容获准放行一次。 */
  set(gate: DeliveryGate): void;
  /** 只解除匹配 id 的闸门；deliverQueued=false 时不立即投递积压。 */
  clear(id: string, deliverQueued?: boolean): boolean;
  isBlocked(): boolean;
}

/** 运行时查询当前模型的名称、MIME 支持和上下文窗口；配置热改后读取新值。 */
export interface ModelFacts {
  model(): string;
  accepts(mime: string): boolean;
  /** provider 探测值与手动配置取较小者，单位 token；两者均未知时返回 undefined。 */
  contextWindow(): number | undefined;
}

/** 事件的投递触发方式，由产生方选择；与事件的渲染时机独立。 */
export type TriggerMode =
  /** 立即投递整批，并请求取消尚未产生外部输出的在途模型轮；是否可取消由主循环判断。 */
  | 'preempt'
  /** 立即投递整批积压。 */
  | 'flush'
  /** 按 quietGapMs、minBatchAgeMs、maxBatchAgeMs 和 maxBatchSize 合批。 */
  | 'debounce'
  /** 只入队，不触发投递或刷新计时器，随下一批唤醒一起投递。 */
  | 'piggyback';

export interface PushOptions {
  /** false 表示仅落库，不投递；默认 true。 */
  deliver?: boolean;
  /** 缺省时外部事件使用 debounce，内部事件使用 flush。 */
  trigger?: TriggerMode;
}

/**
 * World 向 Persona 请求认知任务。World 提供任务说明和本 World 的工具名；
 * Persona 决定上下文、轮数、token 预算、超时及是否受理，模型配置来自当前 provider。
 * Core 校验请求工具、转交请求方身份并统计并发数。World 自带模型的调用不经过此接口。
 */
export interface CognitionRequest {
  /** 任务说明；不指定身份、模型或执行预算。 */
  brief: string;
  /**
   * 仅可引用请求方 World.tools() 中的工具；越界请求以 error 返回，不交给 Persona。
   * 缺省为空；Persona 仍可自行提供 Memory 等自有工具。
   */
  tools?: string[];
  /** 供 Persona 参考的任务规模；不强制执行。 */
  hint?: {
    /** 建议的工具循环轮数。 */
    rounds?: number;
  };
}

/** 认知结果或失败原因；World 应将结果如实报告给模型。 */
export type CognitionResult = { text: string } | { error: string };

/** World 可用的认知接口；Persona 未实现或关闭此能力时不可用。 */
export interface CognitionHost {
  /** 所有失败均通过 error 返回，包括校验失败和 Persona 实现抛错。 */
  request(req: CognitionRequest): Promise<CognitionResult>;
}

/** Core 提供的请求方身份、已校验工具和并发数。 */
export interface CognitionContext {
  worldId: string;
  /** req.tools 对应的已校验定义；未指定工具时为空。 */
  tools: ToolDef[];
  /** 该 World 的在途请求数，包含本次请求；并发限制由 Persona 决定。 */
  running: number;
}

/** Persona 的认知实现；未提供时 WorldHost 不提供 cognition。 */
export interface PersonaCognition {
  /** 每次读取 WorldHost.cognition 时查询；false 时返回 undefined，缺省为启用。 */
  enabled?(): boolean;
  /**
   * 处理请求；上下文、预算和引导语由 Persona 定义。
   * Core 将抛出的异常转为 error 结果。
   */
  request(req: CognitionRequest, ctx: CognitionContext): Promise<CognitionResult>;
}

/** Core 提供给 World 的宿主接口；事件写入、队列消费和认知请求支持跨进程异步实现。 */
export interface WorldHost {
  /**
   * 保存事件并分配游标，按 opts 投递；返回已保存记录。origin 缺省为 external。
   * internal 仅用于内部机制或已认证操作员通道，不得用于来源未经认证的外部内容。
   */
  pushEvent(
    e: Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery' | 'blobs'> & { origin?: EventOrigin; blobs?: BlobInput[] },
    opts?: PushOptions,
  ): Promise<EventEnvelope>;
  /**
   * 渲染与持久化规则见 DeferredEventSpec；origin 缺省为 external。
   * 隐藏 World 或已失效宿主的项直接丢弃；其他项按 trigger 入队。
   */
  pushDeferred(
    e: Pick<DeferredEventSpec, 'type' | 'senderKey' | 'meta' | 'tags' | 'render'> & { origin?: EventOrigin },
    opts?: { trigger?: TriggerMode },
  ): void;
  /**
   * 立即归档原始事件，将候选加入总线。project 在投递时处理同来源、同函数的整批候选。
   * 生成的事件在当前批的即时事件之后保存并投递。
   */
  pushCandidate?(
    spec: CandidatePushSpec,
    opts?: { trigger?: TriggerMode },
  ): Promise<readonly EventEnvelope[]>;
  store: EventStoreReader;
  /**
   * 按 filter 取走尚未投递的外部即时事件，保持原序且不等待。
   * 取走后不会在后续批次重复投递。
   */
  drainPendingEvents(filter: (e: EventEnvelope) => boolean): Promise<EventEnvelope[]>;
  /** 当前模型的能力；渲染层据 MIME 支持决定是否附加二进制内容。 */
  modelFacts: ModelFacts;
  /**
   * 解析 log:/mem: 句柄；无效或内容不存在时返回 null。
   * 保存新附件须通过事件或工具回执的 blobs 字段。
   */
  blob(handle: string): { bytes: Uint8Array; mime: string } | null;
  /**
   * 记录 World 自有模型的用量，写入 session 统计和 usage.jsonl。
   * 仅记录主动上报的用量；Core 不管理 World 自有模型的运行时。
   */
  reportUsage(usage: LLMUsage, opts?: { model?: string; label?: string; charges?: import('./generation.ts').Charge[] }): void;
  /**
   * 最近 withinMs 毫秒内 Core 模型调用失败或流中断的次数。
   * 未接入此查询的宿主可省略。
   */
  llmStalls?(withinMs: number): Promise<number>;
  /** Persona 未实现、全局关闭或宿主未接入时为 undefined。 */
  cognition?: CognitionHost;
  log: Logger;
}

/** 可清除的磁盘或内存存储单元。 */
export interface StoragePart {
  key: string;
  label: string;
  kind: 'disk' | 'memory';
  /** 存储页的分组名；缺省为框架存储，World 填写自己的名称。 */
  group?: string;
  /** 磁盘位置说明；内存存储省略。 */
  location?: string;
  /** 清除不可恢复的记录时设置；控制台要求额外确认。 */
  danger?: boolean;
  /** 清除后果。 */
  note?: string;
  /** 批量清除时的升序执行顺序，默认 0；session 使用 10，清除后重建前缀。 */
  order?: number;
  /** 当前存储规模（条数或大小）的实时说明。 */
  stat(): string;
  /** 返回清除结果；抛错表示失败。 */
  clear(): Promise<string> | string;
}

/**
 * 须与 src/web/shared/console-protocol.ts 的 ConsolePanelDecl 保持结构和字段语义一致。
 * 类型分别定义以保持 Core 的依赖方向。id 在页面内唯一。
 */
export interface WorldPanelDecl {
  /** 本页内唯一，使用 [a-z0-9-]，不带 World 前缀。 */
  id: string;
  title: string;
  description?: string;
  /** 允许经 HTTP GET 调用的方法；省略时本面板只接受 POST。 */
  getMethods?: readonly string[];
}

/** 提示词模板占位符；控制台展示声明及当前展开值。 */
export interface PromptVarDecl {
  /** 包含命名空间的占位符名称。 */
  name: string;
  /** 占位符对应的运行时内容。 */
  description: string;
  /**
   * 值是否可能换行；控制台据此建议独占一行。
   * 模板渲染不对续行追加缩进或列表符号。
   */
  multiline?: boolean;
}

/**
 * 可编辑的提示词模板；框架负责读取、revision 校验和原子保存。
 * 绝对路径不发送到浏览器。
 */
export interface PromptDocDecl {
  /** 全局唯一，惯例为 worlds.<World>.<名> 或 persona.<名>。 */
  key: string;
  title: string;
  description: string;
  /** 读取路径；文件不存在时读作空，首次保存时创建。 */
  path: string;
  /**
   * 部署覆盖文件的写入路径；声明方通过 path 指定当前读取的模板。
   * 缺省时读写均使用 path。
   */
  deploymentPath?: string;
  /**
   * envPrompt 为 World 环境模板，prefix 为 Persona 总装模板。
   * 未指定时仅作为可编辑文件。
   */
  role?: 'envPrompt' | 'prefix';
  /** 模板支持的占位符，须与运行时提供的变量一致。 */
  vars?: PromptVarDecl[];
}

/**
 * World 自报的组件可用状态。
 * - online：功能可用，包括当前空闲。
 * - loading：正在连接、启动或预热。
 * - error：已启用但无法工作。
 * - offline：未启用或缺少配置。
 * 控制台按 state 显示，不从其他状态标签推断。
 */
export interface WorldLamp {
  /** 组件名称，用于悬停说明。 */
  label: string;
  state: 'online' | 'loading' | 'error' | 'offline';
  /** 悬停时显示的状态详情。 */
  hint?: string;
}

/** 每个 World 在导航中最多显示的状态灯数量，超出部分截断。 */
export const MODULE_LAMP_MAX = 7;

/** World 提供的控制台页面内容，按声明的面板 id 路由。 */
export interface WorldConsoleDecl {
  /**
   * 按 console(language) 生成的显示名；缺省使用 WorldDefinition.label。
   * 装配层状态和操作结果仍使用定义中的 label。
   */
  label?: string;
  /** 按声明顺序显示，至多 MODULE_LAMP_MAX 个；缺省时不显示。 */
  lamps?: WorldLamp[];
  badges?: Array<{ label: string; value: string | number; tone?: 'on' | 'off' | 'plain' }>;
  panels?: WorldPanelDecl[];
  /**
   * 处理本页的 panel/method/args 请求，默认返回 JSON。
   * 返回 { $binary: { mime, base64 } } 时响应为二进制；未实现时返回 503。
   */
  invoke?(panel: string, method: string, args: unknown[]): Promise<unknown>;
  /**
   * 每条推送连接调用一次；多连接广播由 World 实现。
   * 未实现时拒绝对应的 WebSocket 握手。
   */
  stream?(panel: string, socket: WorldStreamSocket): void;
  /** World 的提示词模板；role=envPrompt 的模板用 envPromptVars() 渲染。 */
  promptDocs?: PromptDocDecl[];
  /** World 的可清除存储，单独列在存储页。 */
  storage?: StoragePart[];
  /**
   * 独立页面链接；inheritTheme 表示打开时附带当前主题快照。
   * 控制台不解释 href 的路径语义。
   */
  links?: Array<{ label: string; href: string; inheritTheme?: boolean }>;
  config?: ConfigGroup[];
}

export type ShutdownVerificationStatus = 'verified-ended' | 'still-live' | 'unknown';

/** World 在 stop() 内完成并缓存的外部状态检查；汇总层不重新访问外部系统。 */
export interface ShutdownExternalCheck {
  key: string;
  label: string;
  status: ShutdownVerificationStatus;
  detail: string;
  /** 未验证结束时由操作者执行的动作。 */
  manualAction: string;
}

/** World 的环境描述、事件和工具契约。 */
export interface World {
  id: string;
  /**
   * 环境模板的当前变量值；文本来自 role=envPrompt 的 promptDocs 模板。
   * 返回 null 时省略该 World 的环境段；返回空对象时保留无变量的模板全文。
   * 每次前缀重建（包括上下文交接）时重新调用。
   */
  envPromptVars(): Record<string, string> | null | Promise<Record<string, string> | null>;
  /** 工具定义和用法由 World 提供；使用时机与跨工具指导写入环境提示词。 */
  tools(): ToolDef[];
  /**
   * 每次控制台请求按浏览器 language 生成声明和响应文案，省略时为中文。
   * 语言不缓存，不影响发给模型的文本；未实现时仅显示通用信息。
   */
  console?(language?: Language): WorldConsoleDecl;
  /** 主 session 的输出流接收器；装配层合并已挂载 World 的接收器，随挂载变化更新。 */
  outputTap?(): OutputTap;
  /** 挂载时接收宿主并开始连接平台、推送事件。 */
  start(host: WorldHost): Promise<void>;
  stop(): Promise<void>;
  /**
   * 新前缀和保留上下文已装入 session，总线尚未恢复投递时调用。
   * 此时推送的事件进入新 session 的第一批；隐藏 World 不接收通知。
   */
  onHandoffEnded?(): void;
  /**
   * assistant 自然结束、LLM 失败或轮数达到硬上限时调用，用于清理本轮暂态。
   * 隐藏 World 不接收通知。
   */
  onTurnEnded?(): void;
  /**
   * stop() 完成后返回外部状态检查的同步只读快照。
   * 网络检查须在 stop() 的既有期限内完成并缓存。
   */
  shutdownVerification?(): readonly ShutdownExternalCheck[];
}

/** text 按序拼入 system 前缀；title 仅用于显示。 */
export interface PrefixSegment {
  title: string;
  text: string;
  /** 来源模板的 promptDoc key；缺省时控制台只读。 */
  sourceKey?: string;
}

export interface WorldPrefixContext {
  id: string;
  /** 框架使用模板和变量渲染的环境描述。 */
  envPrompt: string;
  /** 来源模板 key，传递至 PrefixSegment.sourceKey。 */
  sourceKey?: string;
}

/** Core 在构造 system 前缀时提供的上下文。 */
export interface SystemPrefixContext {
  now: Date;
  timezone: string;
  /** 按 World id 排序 */
  worlds: WorldPrefixContext[];
}

export type SessionOpeningReason = 'new' | 'restarted' | 'cleared';

export interface MemoryAssemblyContext {
  now: Date;
  timezone: string;
}

/** 一个 World 的挂载或可见状态被装配层改变。`label` 是控制台显示名。 */
export type WorldLifecycleEvent =
  | { kind: 'mounted' | 'unmounted' | 'restarted'; id: string; label: string }
  | { kind: 'visibility'; id: string; label: string; visible: boolean };

/**
 * Persona 定义上下文内容、session 和 Memory 操作。Core 在生命周期边界调用可选钩子。
 * 文本通过 CoreApi 的注入方法或有文本返回值的钩子提供；Core 不生成语义内容。
 */
export interface Persona {
  /** system 前缀的有序段；Core 按序拼接 text。 */
  systemSegments(ctx: SystemPrefixContext): Promise<PrefixSegment[]>;
  /** 控制台预览使用的模板变量当前值；未实现时仅显示占位符声明。 */
  promptVarValues?(ctx: { now: Date; timezone: string }):
    | Record<string, string>
    | Promise<Record<string, string>>;
  /** session 新建、重启恢复或清空后调用；可通过 injectInternal 注入开场文本。 */
  onOpening?(ctx: { reason: SessionOpeningReason }): void;
  /**
   * 一批事件已渲染并分配游标、尚未进入上下文时调用；events 按投递序包含内部和外部事件。
   * injectInternal 在此钩子内注入的内容加入当前批，排在已有内部行之后、外部正文之前；钩子阻塞投递。
   */
  onDelivery?(ctx: { events: EventEnvelope[] }): void;
  /**
   * 一批事件处理结束时调用；Persona 可查询 sessionInfo 并决定是否请求交接。
   * Core 在超过 hardTokens 时强制交接。
   */
  onBatchEnd?(): void;
  /** assistant 自然结束、LLM 失败或轮数达到硬上限时调用。 */
  onTurnEnded?(): void;
  /** 一批处理结束且总线没有非 piggyback 的即时事件或候选时调用。 */
  onIdle?(): void | Promise<void>;
  /** 连续模型调用失败后恢复时调用；返回待注入文本，null 表示不注入。 */
  onStallsRecovered?(info: { count: number; quietMs: number }): string | null;
  /** World 被激活、停用、重启或可见性改变时调用；启动期初始挂载不通知。 */
  onWorldLifecycle?(event: WorldLifecycleEvent): void;
  /**
   * Persona 的工具名，用于拒绝重名 World。
   * 未提供时，重名仅在组装工具表时告警并保留先加入的工具。
   */
  ownToolNames?(): string[];
  /**
   * session 的合成开头:每次请求置于 system 前缀之后、持久历史之前,不写入 session,交接时
   * 不进保留内容。Core 每次出请求前调用一次,丢弃 system 与 developer 项,补齐工具配对,
   * 计入 hardTokens。内容只应随 Persona 自己的输入变化;每次不同就每次打穿前缀缓存。
   */
  sessionHead?(): Item[];
  /** Memory 目录的绝对路径。 */
  memoryDir: string;
  /** mem: 句柄的后端，由 Persona 解释和保存二进制内容。 */
  blobs: BlobStore;
  /** 在 declareSessions 之前接收 CoreApi。 */
  attach(core: CoreApi): void;
  /** 必须恰有一个 receivesEvents=true 且 persistent=true 的声明。 */
  declareSessions(): SessionDecl[];
  /**
   * 在稳定轮次边界、投递已暂停且快照已取时调用；返回新上下文，tail=null 时由 Core 选择。
   * Core 校验工具配对，并将前缀与保留上下文限制在 hardTokens 内；保留比例由 Persona 决定。
   * 钩子内注入的事件在重建完成后投递。
   */
  onHandoff?(snapshot: ContextRecord[], ctx: { hardTokens: number | null }): Promise<ContextHandoffResult>;
  /**
   * 认知任务实现；上下文和预算归 Persona，模型配置归当前 provider。
   * 未实现时，WorldHost 不提供 cognition。
   */
  cognition?: PersonaCognition;
  /**
   * Persona 的控制台页面声明；Memory 和认知操作归此接口，跨组件部署操作归装配层。
   * 面板 id 在页内唯一、不带前缀；page id 由装配层生成。language 与 World.console 相同。
   */
  console?(language?: Language): PersonaConsoleDecl;
}

/**
 * 与 src/web/shared/console-protocol.ts 的 ConsoleStream 保持结构和语义一致。
 * 类型分别定义以保持 Core 的依赖方向，修改时须同步。
 */
export interface WorldStreamSocket {
  /** 连接已关闭时忽略发送，不抛错。 */
  send(data: string): void;
  /** 关闭连接；reason 原样发送给对端。 */
  close(reason?: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  readonly open: boolean;
}

export interface PersonaConsoleDecl {
  badges?: Array<{ label: string; value: string | number; tone?: 'on' | 'off' | 'plain' }>;
  panels?: WorldPanelDecl[];
  invoke?(panel: string, method: string, args: unknown[]): Promise<unknown>;
  promptDocs?: PromptDocDecl[];
  storage?: StoragePart[];
  config?: ConfigGroup[];
}

/**
 * 日志级别：
 * - error：功能不可用或需要人工处理；附带 err 或 data，并生成事故记录。
 * - warn：异常已通过重试、降级等方式处理，或观测结果与预期不符。
 * - info：生命周期和任务状态变化。
 * - debug：诊断所需的中间状态；数值写入 data。
 * - trace：高频状态变化，默认不写入日志。
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVEL_RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

export interface LogError {
  name: string;
  message: string;
  stack?: string;
}

/** 日志关联字段；显式值覆盖异步上下文中的值。 */
export interface LogAnchorFields {
  sess?: string;
  round?: number;
  resp?: string;
  call?: string;
  ev?: number;
  task?: number;
}

/** `data/runs/<run>/log.jsonl` 一行。 */
export interface LogRecord extends LogAnchorFields {
  /** 部署时区的 ISO 时间戳，精度为毫秒。 */
  ts: string;
  run: string;
  /** 当前日志流内递增的序号。 */
  seq: number;
  level: LogLevel;
  /** 子系统路径。 */
  area: string;
  /** 区域内的事件类型标识。 */
  event?: string;
  /** 可独立理解的中文说明。 */
  msg: string;
  durMs?: number;
  /** 折叠窗口内相同 area 和 event/msg 的重复次数，仅出现在汇总行。 */
  repeat?: number;
  data?: unknown;
  err?: LogError;
}

/** 写入日志的条目；sink 分配 ts/run/seq，子进程可提供自身时间戳和关联字段。 */
export interface LogInput extends LogAnchorFields {
  level: LogLevel;
  area: string;
  msg: string;
  event?: string;
  durMs?: number;
  data?: unknown;
  err?: unknown;
  ts?: string;
}

export interface LogEmitOptions extends LogAnchorFields {
  event?: string;
  durMs?: number;
  data?: unknown;
  err?: unknown;
  ts?: string;
}

export interface Logger {
  trace(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  /** data 为 Error 或包含 err/error 时，将栈写入 err 字段。 */
  error(msg: string, data?: unknown): void;
  emit(level: LogLevel, msg: string, opts?: LogEmitOptions): void;
  child(area: string): Logger;
}

/** 模型服务端点配置；由 activeProvider 选择当前端点。 */
export interface LLMProviderEntry {
  options?: Record<string, unknown>;
  /** 端点的模型配置。缺省表示尚未选择模型，不能启用或执行调用。 */
  spec?: ModelSpec;
  serviceTier?: string;
  pricing?: PriceDefinition[];
  /** 已注册的 provider 模块 id。 */
  kind: string;
  baseUrl: string;
  /** 密钥环境变量名；未指定时不要求鉴权。 */
  secret?: string;
  /** 图像输入的手动开关；provider 可通过 accepts 提供具体的 MIME 支持判断。 */
  multimodal?: boolean;
}

/**
 * Core 的运行配置；部署层合并各组件的配置段。
 * 模型设置归 provider，session 轮数及上下文阶段预算归 Persona。
 */
export interface CoreConfig {
  /** 控制台和终端使用的显示名。 */
  displayName: string;
  timezone: string;
  /**
   * 进程启动时确定的控制台默认语言；缺省按环境变量或系统区域选择。
   * 浏览器可单独保存语言选择，不影响模型文本。
   */
  language?: 'zh' | 'en';
  /** 以端点名为键的共享模型服务配置。 */
  providers: Record<string, LLMProviderEntry>;
  /** providers 中的端点名；新模型调用读取当前值。 */
  activeProvider: string;
  /** provider 配置格式版本，保存配置时写入。 */
  providerSchemaVersion?: number;
  context: {
    /** 是否在请求中保留 provider 支持回传的历史推理内容；不改变已保存的 session。 */
    keepPastThinking: boolean;
  };
  batching: {
    /** debounce 批距末次事件到达的等待时间。 */
    quietGapMs: number;
    /** debounce 批距首次事件到达的最短等待时间。 */
    minBatchAgeMs: number;
    /** debounce 批距首次事件到达的最长等待时间。 */
    maxBatchAgeMs: number;
    /** 积压外部即时事件和候选达到此数时立即投递；不计 piggyback 项。 */
    maxBatchSize: number;
  };
  web: { port: number };
  paths: {
    /** 相对部署目录或绝对路径；目录名由 Persona 指定。 */
    memory: string;

    data: string;
  };
  logging: {
    /** 低于此级别的记录不写入 log.jsonl。 */
    file: LogLevel;
    /** stdout 日志的最低级别。 */
    console: LogLevel;
    /** 逗号分隔的 area=level；区域可带 * 后缀，按最长前缀匹配。 */
    areas: string;
  };
}
