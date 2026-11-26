import { describe, expect, it } from 'vitest';
import { cacheHitRate, aggregateUsage, resolveBucket, usageRecordFilter, type UsageAggregateOptions, type UsageGroupStat } from '../../src/core/cost.ts';
import type { UsageRecord, UsageSources } from '../../src/core/types.ts';
import { priceUsage, unknownMeters, type Meter } from '../../src/core/generation.ts';
import { snapshotPrice } from '../../src/providers/pricebook.ts';

function charged(row: UsageRecord): UsageRecord {
  const rates = row.model.startsWith('free-') ? [0, 0, 0] : row.model === 'pro' ? [0.025, 3, 6] : [0.02, 1, 2];
  const quote = snapshotPrice({ models: [row.model], currency: 'USD', basis: 'marginal', source: 'test contract', rules: (['cachedInput', 'uncachedInput', 'output'] as const).map((meter, index) => ({ meter, perMillion: rates[index] })) }, { startedAt: row.ts, requestedServiceTier: null });
  return { ...row, version: 2, charges: priceUsage({ ...unknownMeters(), input: row.promptTokens, output: row.completionTokens, cachedInput: row.cacheHitTokens, uncachedInput: row.cacheMissTokens }, [quote]) };
}

/** 有调用的桶;补齐的空桶 calls 为 0。 */
const active = (a: ReturnType<typeof aggregateUsage>) => a.series.filter((s) => s.calls > 0);

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

  it('所选币种没有原价时按 1 USD 的汇率换算，可选币种随汇率出现', () => {
    const usd = aggregateUsage(recs, { from: '2026-07-18', to: '2026-07-19', bucket: 'day', rates: { CNY: 7, EUR: 0 } });
    const cny = aggregateUsage(recs, { from: '2026-07-18', to: '2026-07-19', bucket: 'day', currency: 'CNY', rates: { CNY: 7, EUR: 0 } });
    expect(usd.currencies).toEqual(['USD', 'CNY']);
    expect(cny.currency).toBe('CNY');
    expect(cny.totals.cost).toBeCloseTo(usd.totals.cost * 7, 6);
    expect(cny.totals.costOutput).toBeCloseTo(usd.totals.costOutput * 7, 6);
    expect(cny.totals.pricedCalls).toBe(usd.totals.pricedCalls);
    expect(aggregateUsage(recs, { from: '2026-07-18', to: '2026-07-19', bucket: 'day' }).currencies).toEqual(['USD']);
    expect(aggregateUsage(recs, { from: '2026-07-18', to: '2026-07-19', bucket: 'day', currency: 'EUR', rates: { EUR: 0 } }).totals.pricedCalls).toBe(0);
  });

  it('原价币种之间按各自的 1 USD 汇率换算，混合币种的合计相加', () => {
    const cnyPriced = (r: UsageRecord): UsageRecord => {
      const quote = snapshotPrice({ models: [r.model], currency: 'CNY', basis: 'marginal', source: 'test contract', rules: [{ meter: 'output', perMillion: 14 }] }, { startedAt: r.ts, requestedServiceTier: null });
      return { ...r, version: 2, charges: priceUsage({ ...unknownMeters(), input: r.promptTokens, output: r.completionTokens, cachedInput: r.cacheHitTokens, uncachedInput: r.cacheMissTokens }, [quote]) };
    };
    const cny = cnyPriced({ ts: '2026-07-18T10:00:00+08:00', sessionId: 'main', role: 'main', label: 'main', model: 'local', promptTokens: 0, completionTokens: 1_000_000, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0 });
    const rates = { CNY: 7, EUR: 0.9 };
    const range = { from: '2026-07-18', to: '2026-07-18', bucket: 'day' as const, rates };
    expect(aggregateUsage([cny], { ...range, currency: 'EUR' }).totals.cost).toBeCloseTo(14 * 0.9 / 7, 6);
    const usdOnly = aggregateUsage(recs, { ...range, currency: 'USD' }).totals.cost;
    expect(aggregateUsage([...recs, cny], { ...range, currency: 'USD' }).totals.cost).toBeCloseTo(usdOnly + 14 / 7, 6);
    expect(aggregateUsage([...recs, cny], { ...range, currency: 'CNY' }).totals.cost).toBeCloseTo(usdOnly * 7 + 14, 6);
  });

  it('按小时桶:同一天不同小时分开', () => {
    const a = aggregateUsage(recs, { from: '2026-07-18', to: '2026-07-18', bucket: 'hour' });
    expect(a.series).toHaveLength(24);
    expect(active(a).map((s) => s.bucket)).toEqual(['2026-07-18T09']);  // 两条都在 09 点
    expect(active(a)[0].calls).toBe(2);
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

  describe('按 World 分组', () => {
    const at = '2026-07-18T10:00:00+08:00';
    const range = { from: '2026-07-18', to: '2026-07-18', bucket: 'day' as const };
    type Rule = [Meter, number];
    /** 主循环一次请求：输入 1M(缓存命中 hit),输出 out(其中推理 reasoning),按 rules 每百万计价。 */
    const request = (o: { role?: string; hit: number; out: number; reasoning: number; rules: Rule[]; sources?: UsageSources }): UsageRecord => {
      const row: UsageRecord = {
        ts: at, sessionId: 'main', role: o.role ?? 'main', label: 'main', model: 'm',
        promptTokens: 1_000_000, completionTokens: o.out, cacheHitTokens: o.hit, cacheMissTokens: 1_000_000 - o.hit, reasoningTokens: o.reasoning,
        ...(o.sources ? { sources: o.sources } : {}),
      };
      const quote = snapshotPrice({ models: ['m'], currency: 'USD', basis: 'marginal', source: 'test contract', rules: o.rules.map(([meter, perMillion]) => ({ meter, perMillion })) }, { startedAt: at, requestedServiceTier: null });
      return { ...row, version: 2, charges: priceUsage({ ...unknownMeters(), input: row.promptTokens, output: row.completionTokens, cachedInput: row.cacheHitTokens, uncachedInput: row.cacheMissTokens, reasoning: row.reasoningTokens }, [quote]) };
    };
    const split: Rule[] = [['cachedInput', 1], ['uncachedInput', 10], ['output', 100]];

    it('输入、缓存与推理按新进上下文的估算 token 分;调用 World 工具的输出折成实际 token 记给那个 World,其余输出按输入比例分', () => {
      // 输入份额 qq 0.6、mc 0.2、未归属 0.2。推理以外的输出 100k 对应估算 50,mc 的工具调用估 20 折成 40k;
      // 余下 160k 按输入份额分，输出份额 qq 0.48、mc 0.2 + 0.16、未归属 0.16。
      const a = aggregateUsage([request({
        hit: 600_000, out: 200_000, reasoning: 100_000, rules: split,
        sources: { worlds: { qq: 300, mc: 100 }, other: 100, output: { total: 50, worldTools: { mc: 20 } } },
      })], range);
      const row = (g: UsageGroupStat) => [g.key, g.calls, g.promptTokens, g.cacheHitTokens, g.completionTokens, g.reasoningTokens];
      expect(a.byWorld.map(row)).toEqual([['qq', 1, 600_000, 360_000, 96_000, 60_000], ['mc', 1, 200_000, 120_000, 72_000, 20_000]]);
      expect(row(a.unattributed)).toEqual(['unattributed', 1, 200_000, 120_000, 32_000, 20_000]);
      // 缓存命中 0.6、未命中 4、输出 20。
      expect([...a.byWorld, a.unattributed].map((g) => g.cost)).toEqual([expect.closeTo(0.6 * 4.6 + 0.48 * 20, 9), expect.closeTo(0.2 * 4.6 + 0.36 * 20, 9), expect.closeTo(0.2 * 4.6 + 0.16 * 20, 9)]);
    });

    it('每次请求分给各 World 与未归属的 token 和各项费用，加起来等于这次请求的实付', () => {
      const rows = [
        request({ hit: 700_000, out: 300_000, reasoning: 120_000, rules: [...split, ['reasoning', 50]], sources: { worlds: { qq: 37, mc: 11, bilibili: 5 }, other: 13, output: { total: 90, worldTools: { mc: 31, qq: 7 } } } }),
        request({ hit: 0, out: 80_000, reasoning: 0, rules: split, sources: { worlds: {}, other: 0, output: { total: 40, worldTools: { mc: 40 } } } }),
        request({ hit: 300_000, out: 0, reasoning: 0, rules: split, sources: { worlds: { qq: 9 }, other: 4 } }),
        request({ hit: 500_000, out: 120_000, reasoning: 30_000, rules: [['total', 3]], sources: { worlds: { mc: 2 }, other: 1, output: { total: 12, worldTools: { mc: 5 } } } }),
        request({ hit: 200_000, out: 50_000, reasoning: 0, rules: split }),
        request({ role: 'worlds.qq', hit: 0, out: 10_000, reasoning: 0, rules: split }),
      ];
      for (const r of rows) {
        const a = aggregateUsage([r], range);
        const parts = [...a.byWorld, a.unattributed];
        const sum = (field: keyof UsageGroupStat) => parts.reduce((total, g) => total + (g[field] as number), 0);
        // token 各部分分别取整，误差不超过每部分半个 token。
        for (const field of ['promptTokens', 'completionTokens', 'cacheHitTokens', 'cacheMissTokens', 'reasoningTokens'] as const) {
          expect(Math.abs(sum(field) - a.totals[field])).toBeLessThanOrEqual(parts.length / 2);
        }
        for (const field of ['cost', 'costCacheHit', 'costCacheMiss', 'costOutput', 'costOther'] as const) {
          expect(sum(field)).toBeCloseTo(a.totals[field], 9);
        }
      }
    });

    it('每个时间桶的 World 份额加未归属等于这个桶，各桶同一 World 的份额加起来等于 byWorld', () => {
      const minute = (ts: string, r: UsageRecord): UsageRecord => ({ ...r, ts });
      const rows = [
        minute('2026-07-18T10:00:10+08:00', request({ hit: 700_000, out: 300_000, reasoning: 120_000, rules: split, sources: { worlds: { qq: 37, mc: 11 }, other: 13, output: { total: 90, worldTools: { mc: 31 } } } })),
        minute('2026-07-18T10:00:50+08:00', request({ role: 'worlds.qq', hit: 0, out: 10_000, reasoning: 0, rules: split })),
        minute('2026-07-18T10:02:00+08:00', request({ hit: 200_000, out: 50_000, reasoning: 0, rules: split })),
        minute('2026-07-18T10:03:00+08:00', request({ hit: 0, out: 80_000, reasoning: 0, rules: split, sources: { worlds: { mc: 3 }, other: 1 } })),
      ];
      const a = aggregateUsage(rows, { bucket: 'minute' });
      expect(a.series.map((p) => p.bucket.slice(11))).toEqual(['10:00', '10:01', '10:02', '10:03']);
      expect(a.series[1]!.byWorld).toEqual({});
      expect(a.series[1]!.unattributed).toBeUndefined();
      for (const p of a.series) {
        const parts = [...Object.values(p.byWorld), ...(p.unattributed ? [p.unattributed] : [])];
        expect(parts.reduce((sum, g) => sum + g.cost, 0)).toBeCloseTo(p.cost, 9);
        expect(Math.abs(parts.reduce((sum, g) => sum + g.promptTokens, 0) - p.promptTokens)).toBeLessThanOrEqual(parts.length / 2);
      }
      for (const g of a.byWorld) {
        expect(a.series.reduce((sum, p) => sum + (p.byWorld[g.key]?.cost ?? 0), 0)).toBeCloseTo(g.cost, 9);
      }
      expect(a.series.reduce((sum, p) => sum + (p.unattributed?.cost ?? 0), 0)).toBeCloseTo(a.unattributed.cost, 9);
    });
  });

  it('补齐范围内没有调用的桶,不越过部署时区的当前时刻;days 按部署时区取今天', () => {
    // 16:30Z 在东八区已是 07-20 00:30,在 UTC 仍是 07-19。
    const now = new Date('2026-07-19T16:30:00Z');
    const a = aggregateUsage(recs, { days: 2, bucket: 'hour', timezone: 'Asia/Shanghai', now });
    expect([a.from, a.to, a.timezone]).toEqual(['2026-07-19', '2026-07-20', 'Asia/Shanghai']);
    expect(a.series[0].bucket).toBe('2026-07-19T00');
    expect(a.series.at(-1)!.bucket).toBe('2026-07-20T00');
    expect(a.series).toHaveLength(25);
    expect(active(a).map((s) => s.bucket)).toEqual(['2026-07-19T14']);
  });

  it('dailyTokenDays:逐日 token 与同一窗口按天分桶的聚合一致，窗口从范围末日往前数，主聚合仍只算范围内', () => {
    // 美西夏令时 UTC-7:东八区 07-18 09:10 是 07-17 18:10,07-19 14:00 是 07-18 23:00。
    const tz = { timezone: 'America/Los_Angeles', now: new Date('2026-07-19T12:00:00Z') };
    const a = aggregateUsage(recs, { days: 2, bucket: 'hour', dailyTokenDays: 3, ...tz });
    const byDay = aggregateUsage(recs, { from: '2026-07-17', to: '2026-07-19', bucket: 'day', ...tz });
    expect(a.dailyTokens).toEqual(byDay.series.map((p) => ({ day: p.bucket, tokens: p.promptTokens + p.completionTokens })));
    expect(a.dailyTokens!.map((p) => p.day)).toEqual(['2026-07-17', '2026-07-18', '2026-07-19']);
    expect(a.totals.calls).toBe(1);
    // 范围比窗口长时从范围起点起
    expect(aggregateUsage(recs, { from: '2026-07-16', to: '2026-07-19', bucket: 'day', dailyTokenDays: 1, ...tz }).dailyTokens![0]!.day).toBe('2026-07-16');
    expect('dailyTokens' in aggregateUsage(recs, { days: 2, bucket: 'hour', ...tz })).toBe(false);
  });

  it('usageRecordFilter 只筛掉 aggregateUsage 用不到的记录：筛前筛后聚合相同，今天的查询不留两天前的记录', () => {
    // 偏移取两端:+14:00 与 −12:00 的墙钟日期离 UTC 日期最远;T25:00 读不出时刻，汇总按 ts 前缀归到 07-18。
    const rows = ['2026-07-15T12:00:00+08:00', '2026-07-17T00:30:00+14:00', '2026-07-17T23:30:00-12:00', '2026-07-18T00:10:00+08:00',
      '2026-07-18T25:00:00Z', '2026-07-19T23:50:00-05:00', '2026-07-20T09:00:00+08:00', '2026-07-23T09:00:00+08:00']
      .map((ts, i) => rec(ts, 'main', 'flash', 100 + i, 10));
    const now = new Date('2026-07-20T03:00:00Z');
    const cases: UsageAggregateOptions[] = [
      { bucket: 'day', from: '2026-07-18', to: '2026-07-19', timezone: 'Pacific/Kiritimati', now },
      { bucket: 'hour', from: '2026-07-16', to: '2026-07-17', timezone: 'Etc/GMT+12', now },
      { bucket: 'day', days: 1, timezone: 'Asia/Shanghai', now },
      { bucket: 'day', from: '2026-07-18', to: '2026-07-19', dailyTokenDays: 5, timezone: 'Asia/Shanghai', now },
      { bucket: 'day', from: '2026-07-18', to: '2026-07-19' },
    ];
    for (const opts of cases) expect(aggregateUsage(rows.filter(usageRecordFilter(opts)), opts)).toEqual(aggregateUsage(rows, opts));
    expect(rows.filter(usageRecordFilter(cases[2]!)).map((r) => r.ts))
      .toEqual(['2026-07-18T25:00:00Z', '2026-07-19T23:50:00-05:00', '2026-07-20T09:00:00+08:00']);
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
    expect(active(a).map((s) => s.bucket)).toEqual(['2026-07-20T14:03', '2026-07-20T14:59']);
    const p0 = active(a)[0];
    expect(p0.byRole.main.cost).toBeCloseTo(3, 6);
    expect(p0.costCacheMiss).toBeCloseTo(1, 6);
    expect(p0.costOutput).toBeCloseTo(2, 6);
    expect(p0.costCacheHit + p0.costCacheMiss + p0.costOutput).toBeCloseTo(p0.cost, 6);
    expect(active(a)[1].byModel.pro.costOutput).toBeCloseTo(6, 6);
  });

  it('week 桶:按 ISO 周一归并(2026-07-20 是周一,07-14 归到 07-13)', () => {
    const a = aggregateUsage(recs, { from: '2026-07-01', to: '2026-07-31', bucket: 'week' });
    expect(a.series.map((s) => s.bucket)).toEqual(['2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27']);
    expect(active(a).map((s) => s.bucket)).toEqual(['2026-07-13', '2026-07-20']);
  });

  it('month 桶:按 YYYY-MM 归并', () => {
    const a = aggregateUsage(recs, { from: '2026-07-01', to: '2026-07-31', bucket: 'month' });
    expect(a.series.map((s) => s.bucket)).toEqual(['2026-07']);
    expect(a.series[0].calls).toBe(3);
  });

  it('auto:单日范围解析成 hour,并把解析后的粒度回填到 bucket', () => {
    const a = aggregateUsage(recs, { from: '2026-07-20', to: '2026-07-20', bucket: 'auto' });
    expect(a.bucket).toBe('hour');
    expect(active(a).map((s) => s.bucket)).toEqual(['2026-07-20T14']);
    expect(active(a)[0].calls).toBe(2);
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
