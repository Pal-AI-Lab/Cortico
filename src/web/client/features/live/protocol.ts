/**
 * 调试帧与 /api/status 的前端读取形状。服务端 contribution 可提供可选字段，视图按字段是否存在决定展示；保留服务端键名，集中读取当前状态字段。
 */

export interface ToolOwner {
  kind?: string;
  id?: string;
  label?: string;
}

/** `/api/tool-schemas` 与 debug hello 里的工具表条目。 */
export interface ToolSchemaDoc {
  name: string;
  description?: string;
  parameters?: unknown;
  owner?: ToolOwner | null;
  tags?: readonly string[];
}

/** `/api/sessions` 的一行(主意识与各 fork)。 */
export interface SessionStat {
  id: string;
  label: string;
  role: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheHitRate: number | null;
  messageCount: number;
  /** null = 还在跑 */
  endedAt?: string | null;
}

export interface UsageSnapshot {
  promptTokens?: number;
  cacheHitTokens?: number;
}

/**
 * 上下文预算。两个来源合成一份:core 在 `loop.context` 报物理上限、上游数过的
 * 部分与摘除思维链开关;Persona在顶层 `context` 报自己的阶段预算与软预警线。
 */
export interface ContextBudget {
  /** Persona的阶段预算(圈的分母);没报时分母退到 hardTokens */
  maxTokens?: number;
  softRatio?: number;
  keepPastThinking?: boolean;
  /** 模型一次请求能收的输入上限;窗口未知时 null */
  hardTokens?: number | null;
  /** estTokens 里上游数过的部分;整份估算时 0 */
  countedTokens?: number;
}

export interface LoopStatus {
  estTokens?: number | null;
  messageCount?: number | null;
  lastUsage?: UsageSnapshot | null;
  batchesHandled?: number | null;
  roundsLastBatch?: number | null;
  paused?: boolean;
  scheduleBlocked?: boolean;
  truncating?: boolean;
  context?: ContextBudget | null;
}

/** Persona自报的一枚状态筹码。框架照文本渲染,不解释里面说的是什么。 */
export interface StatusChip {
  label: string;
  tone?: 'plain' | 'warn' | 'accent';
}

export interface StatusSnapshot {
  displayName?: string;
  loop?: LoopStatus | null;
  /**
   * Persona自报的状态筹码(「梦中」这类)。框架不认识任何一个人格概念,只把
   * 文本按 tone 画出来——这是人格概念上状态条的**唯一**出口。
   */
  chips?: StatusChip[] | null;
  eventCount?: number | null;
  /** 部署目录里还挂着开场引导的标记。 */
  onboardingPending?: boolean;
  terminalOnline?: number | null;
  context?: ContextBudget | null;
  [key: string]: unknown;
}

export function loopOf(st: StatusSnapshot | null): LoopStatus {
  return st?.loop ?? {};
}

/** 上下文预算:`status.loop.context`(core)与 `status.context`(Persona)合成,后者的键覆盖前者。 */
export function contextOf(st: StatusSnapshot | null): ContextBudget {
  if (!st) return {};
  const inLoop = loopOf(st).context;
  const own = st.context;
  return {
    ...(inLoop && typeof inLoop === 'object' ? inLoop : {}),
    ...(own && typeof own === 'object' ? own : {}),
  };
}

/** 一个字符串字段,不是字符串就当没有。 */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 一个数组字段,不是数组就当空。 */
export function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Persona自报的状态筹码;形状不对的条目丢掉,坏数据不该让状态条整条消失。 */
export function chipsOf(st: StatusSnapshot | null): StatusChip[] {
  return arr<unknown>(st?.chips).flatMap((c) => {
    if (!c || typeof c !== 'object') return [];
    const { label, tone } = c as { label?: unknown; tone?: unknown };
    if (typeof label !== 'string' || !label) return [];
    return [{ label, ...(tone === 'warn' || tone === 'accent' ? { tone } : {}) }];
  });
}
