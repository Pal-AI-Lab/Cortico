import { describe, expect, it } from 'vitest';
import { cacheHitRate, aggregateUsage, resolveBucket } from '../../src/core/cost.ts';
import type { UsageRecord } from '../../src/core/types.ts';
import { priceUsage, unknownMeters } from '../../src/core/generation.ts';
import { snapshotPrice } from '../../src/providers/pricebook.ts';

function charged(row: UsageRecord): UsageRecord {
  const rates = row.model.startsWith('free-') ? [0, 0, 0] : row.model === 'pro' ? [0.025, 3, 6] : [0.02, 1, 2];
  const quote = snapshotPrice({ models: [row.model], currency: 'USD', basis: 'marginal', source: 'test contract', rules: (['cachedInput', 'uncachedInput', 'output'] as const).map((meter, index) => ({ meter, perMillion: rates[index] })) }, { startedAt: row.ts, requestedServiceTier: null });
  return { ...row, version: 2, charges: priceUsage({ ...unknownMeters(), input: row.promptTokens, output: row.completionTokens, cachedInput: row.cacheHitTokens, uncachedInput: row.cacheMissTokens }, [quote]) };
}

it('缓存命中率按已知输入分布计算，无输入返回 null', () => {
  expect(cacheHitRate({ cacheHitTokens: 90, cacheMissTokens: 10 })).toBe(.9);
  expect(cacheHitRate({ cacheHitTokens: 0, cacheMissTokens: 0 })).toBeNull();
});

describe('分时段聚合 aggregateUsage', () => {
  const rec = (ts: string, role: string, model: string, miss: number, comp: number): UsageRecord => charged({
    ts, sessionId: role, role: role as UsageRecord['role'], label: role, model,
    promptTokens: miss, completionTokens: comp, cacheHitTokens: 0, cacheMissTokens: miss, reasoningTokens: 0,
  });
  const recs: UsageRecord[] = [
    rec('2026-07-18T09:10:00+08:00', 'main', 'flash', 1_000_000, 1_000_000),
    rec('2026-07-18T09:40:00+08:00', 'main', 'flash', 0, 500_000),
    rec('2026-07-19T14:00:00+08:00', 'dream', 'pro', 1_000_000, 0),
    rec('2026-07-17T23:00:00+08:00', 'main', 'flash', 0, 0),                   // 落在范围外
  ];

  it("按日期范围与天聚合，费用使用记录内 charges", () => {
    const a = aggregateUsage(recs, { from: '2026-07-18', to: '2026-07-19', bucket: 'day' });
    expect(a.series.map((s) => s.bucket)).toEqual(['2026-07-18', '2026-07-19']);
    expect(a.totals.calls).toBe(3);          // 07-17 那条被过滤
    expect(a.series[0].calls).toBe(2);
    expect(a.totals.cost).toBeCloseTo(3 + 1 + 3, 6);
    expect(a.currency).toBe('USD');
  });

  it('按小时桶:同一天不同小时分开', () => {
    const a = aggregateUsage(recs, { from: '2026-07-18', to: '2026-07-18', bucket: 'hour' });
    expect(a.series.map((s) => s.bucket)).toEqual(['2026-07-18T09']);  // 两条都在 09 点
    expect(a.series[0].calls).toBe(2);
  });

  it('按角色/模型分组,cost 降序', () => {
    const a = aggregateUsage(recs, { from: '2026-07-18', to: '2026-07-19', bucket: 'day' });
    const roleKeys = a.byRole.map((g) => g.key);
    expect(roleKeys).toContain('main');
    expect(roleKeys).toContain('dream');
    // main 成本 4 > dream 3 → main 在前
    expect(a.byRole[0].key).toBe('main');
    expect(a.byModel.find((g) => g.key === 'pro')?.cost).toBeCloseTo(3, 6);
  });

  it('空输入→空序列、总计为0', () => {
    const a = aggregateUsage([], { bucket: 'day' });
    expect(a.series).toEqual([]);
    expect(a.totals.calls).toBe(0);
    expect(a.totals.cost).toBe(0);
  });
});

describe('自适应粒度 resolveBucket', () => {
  it('按范围跨度挑桶宽:时/天/周/月', () => {
    expect(resolveBucket('2026-07-20', '2026-07-20')).toBe('hour'); // 单日
    expect(resolveBucket('2026-07-19', '2026-07-20')).toBe('hour'); // 2 天
    expect(resolveBucket('2026-07-01', '2026-07-20')).toBe('day');  // 20 天
    expect(resolveBucket('2026-05-01', '2026-07-20')).toBe('week'); // ~81 天
    expect(resolveBucket('2025-07-20', '2026-07-20')).toBe('week'); // 366 天(含端)
    expect(resolveBucket('2024-01-01', '2026-07-20')).toBe('month'); // 更长
  });
  it('范围开放(缺 from/to)保守用天', () => {
    expect(resolveBucket(null, null)).toBe('day');
    expect(resolveBucket('2026-07-01', null)).toBe('day');
  });
});

describe("aggregateUsage:时间粒度、分组与成本分项", () => {
  const rec = (ts: string, role: string, model: string, hit: number, miss: number, comp: number): UsageRecord => charged({
    ts, sessionId: role, role: role as UsageRecord['role'], label: role, model,
    promptTokens: hit + miss, completionTokens: comp, cacheHitTokens: hit, cacheMissTokens: miss, reasoningTokens: 0,
  });
  const recs: UsageRecord[] = [
    rec('2026-07-20T14:03:00+08:00', 'main', 'flash', 0, 1_000_000, 1_000_000),
    rec('2026-07-20T14:59:00+08:00', 'dream', 'pro', 0, 0, 1_000_000),
    rec('2026-07-14T10:00:00+08:00', 'main', 'flash', 1_000_000, 0, 0),
  ];

  it("按分钟聚合，结果包含 byRole、byModel 与成本分项", () => {
    const a = aggregateUsage(recs, { from: '2026-07-20', to: '2026-07-20', bucket: 'minute' });
    expect(a.bucket).toBe('minute');
    expect(a.series.map((s) => s.bucket)).toEqual(['2026-07-20T14:03', '2026-07-20T14:59']);
    const p0 = a.series[0];
    expect(p0.byRole.main.cost).toBeCloseTo(3, 6);
    expect(p0.costCacheMiss).toBeCloseTo(1, 6);
    expect(p0.costOutput).toBeCloseTo(2, 6);
    expect(p0.costCacheHit + p0.costCacheMiss + p0.costOutput).toBeCloseTo(p0.cost, 6);
    expect(a.series[1].byModel.pro.costOutput).toBeCloseTo(6, 6);
  });

  it('week 桶:按 ISO 周一归并(2026-07-20 是周一,07-14 归到 07-13)', () => {
    const a = aggregateUsage(recs, { from: '2026-07-01', to: '2026-07-31', bucket: 'week' });
    expect(a.series.map((s) => s.bucket)).toEqual(['2026-07-13', '2026-07-20']);
  });

  it('month 桶:按 YYYY-MM 归并', () => {
    const a = aggregateUsage(recs, { from: '2026-07-01', to: '2026-07-31', bucket: 'month' });
    expect(a.series.map((s) => s.bucket)).toEqual(['2026-07']);
    expect(a.series[0].calls).toBe(3);
  });

  it('auto:单日范围解析成 hour,并把解析后的粒度回填到 bucket', () => {
    const a = aggregateUsage(recs, { from: '2026-07-20', to: '2026-07-20', bucket: 'auto' });
    expect(a.bucket).toBe('hour');
    expect(a.series.map((s) => s.bucket)).toEqual(['2026-07-20T14']);
    expect(a.series[0].calls).toBe(2);
  });

  it("顶层分组成本等于记录中的费用之和", () => {
    const a = aggregateUsage(recs, { from: '2026-07-01', to: '2026-07-31', bucket: 'day' });
    for (const g of [...a.byRole, ...a.byModel, a.totals]) {
      expect(g.costCacheHit + g.costCacheMiss + g.costOutput).toBeCloseTo(g.cost, 6);
    }
  });

  it('桶内 byRoleModel 交叉子拆分:role×model 可寻址,支持任意维度组合', () => {
    const a = aggregateUsage(recs, { from: '2026-07-01', to: '2026-07-31', bucket: 'month' });
    const p = a.series[0];
    // 交叉寻址:main×flash / dream×pro 存在
    expect(p.byRoleModel.main.flash).toBeTruthy();
    expect(p.byRoleModel.dream.pro.costOutput).toBeCloseTo(6, 6);
    // 交叉合计自洽:sum(byRoleModel[r][m]) 的 cost = 桶总 cost
    let cross = 0;
    for (const r of Object.keys(p.byRoleModel)) for (const m of Object.keys(p.byRoleModel[r])) cross += p.byRoleModel[r][m].cost;
    expect(cross).toBeCloseTo(p.cost, 6);
    // 每个角色的费用等于该角色下各模型费用之和。
    expect(p.byRoleModel.main.flash.cost + (p.byRoleModel.main.pro ? p.byRoleModel.main.pro.cost : 0)).toBeCloseTo(p.byRole.main.cost, 6);
  });
});

/**
 * 失败流的用量单独入账，不混入成功统计。
 */
describe('aggregateUsage:失败流单列', () => {
  const base = {
    sessionId: 'main', role: 'main', label: '主', model: 'flash',
    promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 0,
    cacheMissTokens: 1_000_000, reasoningTokens: 0,
  };
  const recs: UsageRecord[] = [
    { ...base, ts: '2026-08-23T00:50:00+08:00' },
    { ...base, ts: '2026-08-23T00:55:00+08:00', outcome: 'failed' as const, failedAfterMs: 46200, status: 0 },
    { ...base, ts: '2026-08-23T00:56:00+08:00', outcome: 'failed' as const, failedAfterMs: 44100, status: 0 },
  ].map(charged);

  it('失败行进入全部消耗,并可从 failed 和 successful 分开核对', () => {
    const a = aggregateUsage(recs, { from: '2026-08-23', to: '2026-08-23', bucket: 'day' });
    expect(a.totals.calls).toBe(3);
    expect(a.series[0].calls).toBe(3);
    expect(a.byRole[0].calls).toBe(3);
    expect(a.byModel[0].calls).toBe(3);
    expect(a.successful.calls).toBe(1);
    expect(a.failed.calls).toBe(2);
    expect(a.failed.promptTokens).toBe(2_000_000);
    expect(a.failed.cost).toBeCloseTo(2, 6);
  });

  it("零价目下失败调用的成本为 0，token 用量仍保留", () => {
    const freeRecs: UsageRecord[] = recs
      .filter((r) => r.outcome === 'failed')
      .map((r) => charged({ ...r, model: 'free-1' }));
    const a = aggregateUsage(freeRecs, { bucket: 'day' });
    expect(a.failed.cost).toBe(0);
    expect(a.failed.promptTokens).toBe(2_000_000);
  });

  it("没有失败记录时仍返回全零的 failed 统计", () => {
    const a = aggregateUsage([recs[0]], { bucket: 'day' });
    expect(a.failed.calls).toBe(0);
    expect(a.failed.cost).toBe(0);
  });
});
