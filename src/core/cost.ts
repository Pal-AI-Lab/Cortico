/** Aggregate observed consumption and immutable Provider charges. */
import type { UsageRecord } from './types.ts';
import { billingBalances, recordCharges, type BillingBalance } from './billing.ts';
import { nowIso } from './util.ts';

/** 已解析的具体时间粒度(桶宽) */
export type UsageBucketUnit = 'minute' | 'hour' | 'day' | 'week' | 'month';
/** 请求粒度:具体粒度或 'auto'(按范围跨度自适应) */
export type UsageBucketOption = UsageBucketUnit | 'auto';
export type UsageGroupBy = 'role' | 'model' | 'none';

/**
 * 用量与费用合计，供时间序列及角色、模型分组使用。
 * cost = costCacheHit + costCacheMiss + costOutput + costOther。
 * reasoningTokens 是 completionTokens 的子集；费用采用记录内的 charges。
 */
export interface UsageAccum {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  cost: number;
  costCacheHit: number;
  costCacheMiss: number;
  costOutput: number;
  costOther: number;
  unclassifiedInputTokens: number;
  pricedCalls: number;
  unpricedCalls: number;
  unknownUsageCalls: number;
}

export interface UsageSeriesPoint extends UsageAccum {
  /** 本地时区前缀,如 2026-07-19T14:30、2026-07-19 或 2026-07。 */
  bucket: string;
  /** 本桶内按角色的子拆分(键=角色);用于堆叠"按角色"视图 */
  byRole: Record<string, UsageAccum>;
  /** 本桶内按模型的子拆分(键=模型);用于堆叠"按模型"视图 */
  byModel: Record<string, UsageAccum>;
  /** 按角色与模型交叉分组，键为 byRoleModel[role][model]。 */
  byRoleModel: Record<string, Record<string, UsageAccum>>;
}

/** 按 role / model 分组的合计 */
export interface UsageGroupStat extends UsageAccum {
  key: string;
  /** 声明方提供的 UsageRecord.label；与 key 相同时省略。缺失时显示 key，不推断角色名称。 */
  label?: string;
  cacheHitRate: number | null;
}

export interface UsageAggregate {
  currency: string;
  basis: 'marginal' | 'equivalent';
  balances: BillingBalance[];
  successful: UsageAccum;
  byInstance: UsageGroupStat[];
  /** 实际使用的粒度(auto 会被解析成具体值) */
  bucket: UsageBucketUnit;
  from: string | null;
  to: string | null;
  /** 日期范围与桶键所在的时区;调用方未给时为 null。 */
  timezone: string | null;
  /** 时间序列(按 bucket 升序)。有记录时首末桶之间连续,没有调用的桶各字段为 0。 */
  series: UsageSeriesPoint[];
  /** 全量合计 */
  totals: UsageGroupStat;
  /** 按角色分组(cost 降序) */
  byRole: UsageGroupStat[];
  /** 按模型分组(cost 降序) */
  byModel: UsageGroupStat[];
  /** Failed, aborted and discarded attempts are also included in totals. */
  failed: UsageAccum;
}

function zero(): UsageAccum {
  return {
    calls: 0, promptTokens: 0, completionTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0,
    cost: 0, costCacheHit: 0, costCacheMiss: 0, costOutput: 0, costOther: 0, unclassifiedInputTokens: 0,
    pricedCalls: 0, unpricedCalls: 0, unknownUsageCalls: 0,
  };
}

type MeasuredCost = { cacheHit: number; cacheMiss: number; output: number; total: number; priced: boolean };

function add(a: UsageAccum, r: UsageRecord, c: MeasuredCost): void {
  a.calls += 1;
  if (c.priced) a.pricedCalls++; else a.unpricedCalls++;
  if (r.attempt && (r.attempt.meters.input === null || r.attempt.meters.output === null || r.attempt.meters.cachedInput === null)) a.unknownUsageCalls++;
  a.promptTokens += r.promptTokens;
  a.completionTokens += r.completionTokens;
  a.cacheHitTokens += r.cacheHitTokens;
  a.cacheMissTokens += r.cacheMissTokens;
  a.reasoningTokens += r.reasoningTokens;
  a.cost += c.total;
  a.costCacheHit += c.cacheHit;
  a.costCacheMiss += c.cacheMiss;
  a.costOutput += c.output;
  a.costOther += c.total - c.cacheHit - c.cacheMiss - c.output;
  a.unclassifiedInputTokens += Math.max(0, r.promptTokens - r.cacheHitTokens - r.cacheMissTokens);
}

function upsert(m: Map<string, UsageAccum>, key: string, r: UsageRecord, c: MeasuredCost): void {
  let a = m.get(key);
  if (!a) { a = zero(); m.set(key, a); }
  add(a, r, c);
}

function mapToObj(m: Map<string, UsageAccum>): Record<string, UsageAccum> {
  const o: Record<string, UsageAccum> = {};
  for (const [k, v] of m) o[k] = v;
  return o;
}

function nestedMapToObj(m: Map<string, Map<string, UsageAccum>>): Record<string, Record<string, UsageAccum>> {
  const o: Record<string, Record<string, UsageAccum>> = {};
  for (const [k, inner] of m) o[k] = mapToObj(inner);
  return o;
}

function statOf(key: string, a: UsageAccum, label?: string): UsageGroupStat {
  const out: UsageGroupStat = { key, ...a, cacheHitRate: cacheHitRate(a) };
  if (label && label !== key) out.label = label;
  return out;
}

/** 一天 = 该日期(YYYY-MM-DD)所在 ISO 周的周一(用 UTC 计算,避免时区漂移) */
function weekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1));
  const dow = (dt.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

/** 取某条记录在给定粒度下的桶键(本地时区 ISO 前缀直接切,周单独算) */
function bucketKeyOf(ts: string, unit: UsageBucketUnit): string {
  switch (unit) {
    case 'minute': return ts.slice(0, 16); // YYYY-MM-DDTHH:MM
    case 'hour': return ts.slice(0, 13);   // YYYY-MM-DDTHH
    case 'day': return ts.slice(0, 10);    // YYYY-MM-DD
    case 'week': return weekStart(ts.slice(0, 10));
    case 'month': return ts.slice(0, 7);   // YYYY-MM
  }
}

/**
 * 桶键的下一个桶键。桶键是时区内的墙钟时间,按 UTC 日历做加法;夏令时跳过或重复的
 * 那一小时同样出现一次。
 */
function nextBucketKey(key: string, unit: UsageBucketUnit): string {
  const [y = 1970, mo = 1, d = 1] = key.slice(0, 10).split('-').map(Number);
  const h = unit === 'minute' || unit === 'hour' ? Number(key.slice(11, 13)) : 0;
  const mi = unit === 'minute' ? Number(key.slice(14, 16)) : 0;
  const dt = new Date(Date.UTC(y, mo - 1, unit === 'month' ? 1 : d, h, mi));
  if (unit === 'minute') dt.setUTCMinutes(dt.getUTCMinutes() + 1);
  else if (unit === 'hour') dt.setUTCHours(dt.getUTCHours() + 1);
  else if (unit === 'day') dt.setUTCDate(dt.getUTCDate() + 1);
  else if (unit === 'week') dt.setUTCDate(dt.getUTCDate() + 7);
  else dt.setUTCMonth(dt.getUTCMonth() + 1);
  return bucketKeyOf(dt.toISOString(), unit);
}

/** YYYY-MM-DD 往前数 n 天。 */
function daysBefore(day: string, n: number): string {
  const dt = new Date(`${day}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

/** from/to(YYYY-MM-DD,含端)之间的整天跨度(含首尾);任一为空→NaN */
function daySpan(from?: string | null, to?: string | null): number {
  if (!from || !to) return NaN;
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.abs(b - a) / 86400000 + 1;
}

/**
 * 自动粒度：跨度 ≤2 天用小时，≤62 天用天，≤366 天用周，其余用月。
 * 缺少 from/to 时用天；分钟需显式选择。
 */
export function resolveBucket(from?: string | null, to?: string | null): UsageBucketUnit {
  const span = daySpan(from, to);
  if (Number.isNaN(span)) return 'day';
  if (span <= 2) return 'hour';
  if (span <= 62) return 'day';
  if (span <= 366) return 'week';
  return 'month';
}

export interface UsageAggregateOptions {
  from?: string | null;
  to?: string | null;
  /** 含今天在内的最近 N 天;给了就覆盖 from/to。今天按 timezone 取。 */
  days?: number;
  bucket: UsageBucketOption;
  currency?: string;
  basis?: 'marginal' | 'equivalent';
  /** 记录 ts 所用的时区。给了才按它解析 days,并且不为当前时刻之后补空桶。 */
  timezone?: string;
  now?: Date;
}

/**
 * 按包含端点的日期范围筛选，按时间、角色和模型聚合用量。
 * 费用从记录内的 charges 按币种和计价基础选择，再按 meter 归入四类成本。
 */
export function aggregateUsage(records: UsageRecord[], opts: UsageAggregateOptions): UsageAggregate {
  const nowKeySource = opts.timezone ? nowIso(opts.timezone, opts.now) : null;
  const today = nowKeySource?.slice(0, 10) ?? null;
  const byDays = opts.days !== undefined && opts.days >= 1 && today !== null;
  const from = byDays ? daysBefore(today, opts.days! - 1) : (opts.from ?? null);
  const to = byDays ? today : (opts.to ?? null);
  const unit: UsageBucketUnit = opts.bucket === 'auto' ? resolveBucket(from, to) : opts.bucket;
  const series = new Map<string, { total: UsageAccum; roles: Map<string, UsageAccum>; models: Map<string, UsageAccum>; roleModels: Map<string, Map<string, UsageAccum>> }>();
  const roles = new Map<string, UsageAccum>();
  /** 同一 role 的 label 使用最后一条记录提供的值。 */
  const roleLabels = new Map<string, string>();
  const models = new Map<string, UsageAccum>();
  const totals = zero();
  const failed = zero();
  const successful = zero();
  const instances = new Map<string, UsageAccum>();
  const selected = records.filter(r => r && typeof r.ts === 'string' && (!from || r.ts.slice(0,10) >= from) && (!to || r.ts.slice(0,10) <= to));
  const balances = billingBalances(selected);
  const basis = opts.basis ?? 'marginal';
  const currency = opts.currency ?? balances.find(balance => balance.basis === basis)?.currency ?? 'USD';

  for (const r of selected) {
    const charge = recordCharges(r).find(charge => charge.quote.currency === currency && charge.quote.basis === basis);
    const cost: MeasuredCost = { cacheHit: 0, cacheMiss: 0, output: 0, total: charge?.knownAmount ?? 0, priced: charge?.amount != null };
    for (const line of charge?.lines ?? []) {
      if (line.meter === 'cachedInput') cost.cacheHit += line.amount ?? 0;
      if (line.meter === 'uncachedInput' || line.meter === 'input') cost.cacheMiss += line.amount ?? 0;
      if (line.meter === 'output') cost.output += line.amount ?? 0;
    }
    const outcome = r.attempt?.outcome;
    if (r.outcome !== undefined || (outcome !== undefined && outcome !== 'completed' && outcome !== 'incomplete')) add(failed, r, cost);
    else if (r.attempt?.purpose !== 'diagnostic') add(successful, r, cost);
    upsert(instances, r.attempt?.origin.instance ?? 'unknown', r, cost);
    const role = r.role ?? 'unknown';
    const model = r.model || 'unknown';
    const bk = bucketKeyOf(r.ts, unit);
    let bucketAcc = series.get(bk);
    if (!bucketAcc) { bucketAcc = { total: zero(), roles: new Map(), models: new Map(), roleModels: new Map() }; series.set(bk, bucketAcc); }
    add(bucketAcc.total, r, cost);
    upsert(bucketAcc.roles, role, r, cost);
    upsert(bucketAcc.models, model, r, cost);
    let rm = bucketAcc.roleModels.get(role);
    if (!rm) { rm = new Map(); bucketAcc.roleModels.set(role, rm); }
    upsert(rm, model, r, cost);
    upsert(roles, role, r, cost);
    if (r.label) roleLabels.set(role, r.label);
    upsert(models, model, r, cost);
    add(totals, r, cost);
  }

  const keys = [...series.keys()].sort();
  if (keys.length) {
    // 补齐范围内没有调用的桶:从 from(缺省首条记录)到 to(缺省末条记录),不越过当前时刻。
    let end = to ? bucketKeyOf(`${to}T23:59`, unit) : keys[keys.length - 1]!;
    if (nowKeySource) {
      const nowKey = bucketKeyOf(nowKeySource, unit);
      if (nowKey < end) end = nowKey;
    }
    if (keys[keys.length - 1]! > end) end = keys[keys.length - 1]!;
    let key = from ? bucketKeyOf(`${from}T00:00`, unit) : keys[0]!;
    if (keys[0]! < key) key = keys[0]!;
    for (; key <= end; key = nextBucketKey(key, unit)) {
      if (!series.has(key)) series.set(key, { total: zero(), roles: new Map(), models: new Map(), roleModels: new Map() });
    }
  }
  const seriesOut: UsageSeriesPoint[] = [...series.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([b, acc]) => ({ bucket: b, ...acc.total, byRole: mapToObj(acc.roles), byModel: mapToObj(acc.models), byRoleModel: nestedMapToObj(acc.roleModels) }));
  const groupOut = (m: Map<string, UsageAccum>, labels?: Map<string, string>): UsageGroupStat[] =>
    [...m.entries()].map(([k, a]) => statOf(k, a, labels?.get(k))).sort((x, y) => y.cost - x.cost);

  return {
    currency, basis, balances, successful, byInstance: groupOut(instances),
    bucket: unit,
    from,
    to,
    timezone: opts.timezone ?? null,
    series: seriesOut,
    totals: statOf('total', totals),
    byRole: groupOut(roles, roleLabels),
    byModel: groupOut(models),
    failed,
  };
}

export function cacheHitRate(u: { cacheHitTokens: number; cacheMissTokens: number }): number | null {
  const total = u.cacheHitTokens + u.cacheMissTokens;
  return total > 0 ? u.cacheHitTokens / total : null;
}
