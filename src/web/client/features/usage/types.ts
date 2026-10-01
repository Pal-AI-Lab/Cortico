/**
 * /api/usage 的线上 JSON 形状。usage 未挂载时允许空 series、null totals 和缺失字段，因此与服务端聚合器内部必填类型分开定义；数值由 uMetricVal/uTypeVal 集中归一。
 */

/** 一个累计单元：总量 + 成本三档拆分。桶点、子拆分、分组合计共用此形。 */
export interface UsageAccum {
  calls?: number;
  promptTokens?: number;
  completionTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  reasoningTokens?: number;
  cost?: number;
  costCacheHit?: number;
  costCacheMiss?: number;
  costOutput?: number;
  costOther?: number;
  unclassifiedInputTokens?: number;
  pricedCalls?: number;
  unpricedCalls?: number;
  unknownUsageCalls?: number;
}

/** 时间序列上的一个桶。三张子拆分表是"任意维度交叉堆叠"的寻址面。 */
export interface UsagePoint extends UsageAccum {
  /** 本地时区前缀，如 `2026-07-19T14:30` / `2026-07-19` / `2026-07` */
  bucket: string;
  byRole?: Record<string, UsageAccum>;
  byModel?: Record<string, UsageAccum>;
  /** `byRoleModel[role][model]`：角色×模型的交叉格 */
  byRoleModel?: Record<string, Record<string, UsageAccum>>;
}

/**
 * 按 role / model 分组的合计。
 *
 * `key` 是不透明 id（角色 id 由Persona定义，模型名由供应商定义），
 * `label` 是**声明方随数据给的人话名**。控制台不为任何一个 id 备一张中文名表——
 * 备了就等于把某个具体 bot 的角色集写进了框架。给不出 label 时原样显示 `key`。
 */
export interface UsageGroupStat extends UsageAccum {
  key: string;
  /** 声明方给的显示名；缺省时用 `key`。 */
  label?: string;
  cacheHitRate?: number | null;
}

/** 已解析的具体粒度。 */
export type UsageBucketUnit = 'minute' | 'hour' | 'day' | 'week' | 'month';
/** 请求粒度：具体粒度或 `auto`（按跨度自适应）。 */
export type UsageBucketOption = UsageBucketUnit | 'auto';

export interface UsageAggregate {
  ledger?: { pending: number; error: string | null };
  currency?: string;
  basis?: 'marginal' | 'equivalent';
  balances?: Array<{ currency: string; basis: 'marginal' | 'equivalent'; knownAmount: number; pricedCalls: number; partialCalls: number }>;
  successful?: UsageAccum;
  bucket?: UsageBucketUnit;
  from?: string | null;
  to?: string | null;
  /** from/to 与桶键所在的部署时区。 */
  timezone?: string | null;
  /** 首末桶之间连续,没有调用的桶也在。 */
  series?: UsagePoint[];
  /** `usage` 未挂载时为 null。 */
  totals?: UsageGroupStat | null;
  byRole?: UsageGroupStat[];
  byModel?: UsageGroupStat[];
  /** 按发起调用的模型连接(Provider 实例)分组;同一模型走不同连接时分开。 */
  byInstance?: UsageGroupStat[];
  /** 失败、丢弃和中断均计入 totals；此字段用于核对失败消耗。 */
  failed?: UsageAccum;
}

/** 图上纵轴画的是什么。`calls` 只出现在下面那张调用图。 */
export type UsageMetric = 'cost' | 'tokens' | 'calls';

/** 可拆分的三个维度。优先级（嵌套序）恒为 类型 > 角色 > 模型。 */
export type UsageDim = 'type' | 'role' | 'model';

/** 成本/token 的三档分量。与 `U_TYPES` 的 key 对应。 */
export type UsageTypeKey = 'cacheHit' | 'cacheMiss' | 'output' | 'other';

/** 一段组合里的一格：某个维度取了某个键。 */
export interface UsageCompPart {
  dim: UsageDim;
  key: string;
}

/**
 * 一个堆叠段的身份 = 各维度取值的笛卡尔积中的一项。
 * 空数组表示"不拆分"（整根柱子就是合计）。
 */
export type UsageComposite = UsageCompPart[];

/** 拆分维度的勾选状态。调用图没有 `type` 档，所以逐个可选。 */
export type UsageDimFlags = Partial<Record<UsageDim, boolean>>;

/** 颜色解析器：把主题 token（`chart-1` / `chart-hit`）解析成一个具体颜色。 */
export type ColorResolver = (token: string) => string;
