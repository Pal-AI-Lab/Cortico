import { describe, expect, it } from 'vitest';
import { USAGE_RATES, USAGE_RATES_DATE } from '../../src/core/config.ts';
import { createUsageRates, RATE_FEEDS } from '../../src/core/usage-rates.ts';

const [ER_API, CURRENCY_API, CURRENCY_API_MIRROR] = RATE_FEEDS.map((feed) => feed.url);

/** 按 URL 回接口原样的 JSON;`null` 表示连不上。记下每次请求的 URL。 */
function fakeNet(bodies: Record<string, unknown>) {
  const seen: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const body = bodies[url];
    if (body === undefined || body === null) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, seen };
}

const erApi = (rates: Record<string, number>) => ({ result: 'success', time_last_update_unix: Date.UTC(2026, 9, 25) / 1000, rates: { USD: 1, ...rates } });

describe('createUsageRates', () => {
  it('接口给了的币种用实时汇率，没给的用内置值', async () => {
    const net = fakeNet({ [ER_API]: erApi({ CNY: 6.7 }) });
    const { rates, sources } = await createUsageRates({ fetch: net.impl }).resolve();
    expect(rates.CNY).toBe(6.7);
    expect(sources.CNY).toMatchObject({ kind: 'live', feed: RATE_FEEDS[0]!.name, date: '2026-10-25' });
    expect(rates.EUR).toBe(USAGE_RATES.EUR);
    expect(sources.EUR).toEqual({ kind: 'builtin', date: USAGE_RATES_DATE });
    expect(Object.keys(rates).sort()).toEqual(Object.keys(USAGE_RATES).sort());
  });

  it('前一个接口连不上或格式不对时换下一个', async () => {
    const net = fakeNet({
      [ER_API]: { result: 'error', 'error-type': 'unknown' },
      [CURRENCY_API]: null,
      [CURRENCY_API_MIRROR]: { date: '2026-10-24', usd: { cny: 6.68 } },
    });
    const { rates, sources } = await createUsageRates({ fetch: net.impl }).resolve();
    expect(rates.CNY).toBe(6.68);
    expect(sources.CNY).toMatchObject({ kind: 'live', feed: RATE_FEEDS[2]!.name, date: '2026-10-24' });
    expect(net.seen).toEqual([ER_API, CURRENCY_API, CURRENCY_API_MIRROR]);
  });

  it('请求次数：12 小时内复用实时汇率，过期后重取', async () => {
    let t = 0;
    const net = fakeNet({ [ER_API]: erApi({ CNY: 6.7 }) });
    const rates = createUsageRates({ fetch: net.impl, now: () => t });
    await rates.resolve();
    t = 11 * 3600_000;
    await rates.resolve();
    expect(net.seen).toHaveLength(1);
    t = 12 * 3600_000;
    await rates.resolve();
    expect(net.seen).toHaveLength(2);
  });

  it('请求次数：全部失败后 10 分钟内不再请求，期间沿用上一次的实时汇率', async () => {
    let t = 0;
    const bodies: Record<string, unknown> = { [ER_API]: erApi({ CNY: 6.7 }) };
    const net = fakeNet(bodies);
    const rates = createUsageRates({ fetch: net.impl, now: () => t });
    await rates.resolve();
    delete bodies[ER_API];
    t = 13 * 3600_000;
    expect((await rates.resolve()).rates.CNY).toBe(6.7);
    const afterFailure = net.seen.length;
    expect(afterFailure).toBe(1 + RATE_FEEDS.length);
    t += 9 * 60_000;
    await rates.resolve();
    expect(net.seen).toHaveLength(afterFailure);
    t += 60_000;
    await rates.resolve();
    expect(net.seen).toHaveLength(afterFailure + RATE_FEEDS.length);
  });

  it('同时到达的请求共用一次拉取', async () => {
    const net = fakeNet({ [ER_API]: erApi({ CNY: 6.7 }) });
    const rates = createUsageRates({ fetch: net.impl });
    await Promise.all([rates.resolve(), rates.resolve()]);
    expect(net.seen).toEqual([ER_API]);
  });
});
