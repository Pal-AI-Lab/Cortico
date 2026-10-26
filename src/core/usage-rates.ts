/**
 * 用量报告的汇率:1 USD 合多少该币种。每个币种取公开接口的实时汇率，接口没给的用 USAGE_RATES。
 * 实时汇率按 RATE_FEEDS 顺序请求，第一个能用的结果缓存 12 小时;全部失败后 10 分钟内不再请求，
 * 沿用上一次拿到的实时汇率。
 */
import { USAGE_RATES, USAGE_RATES_DATE } from './config.ts';

/** 一个币种汇率的出处。`live` 带接口名、主页和接口给的日期。 */
export type UsageRateSource =
  | { kind: 'live'; feed: string; site: string; date: string }
  | { kind: 'builtin'; date: string };

export interface ResolvedUsageRates {
  rates: Record<string, number>;
  sources: Record<string, UsageRateSource>;
}

interface RateFeed {
  name: string;
  site: string;
  url: string;
  /** 取出 USAGE_RATES 里各币种的汇率与日期;格式不符时返回 null。 */
  parse(body: unknown): { rates: Record<string, number>; date: string } | null;
}

function pickRates(table: unknown, key: (code: string) => string): Record<string, number> {
  if (typeof table !== 'object' || table === null) return {};
  const out: Record<string, number> = {};
  for (const code of Object.keys(USAGE_RATES)) {
    const rate = (table as Record<string, unknown>)[key(code)];
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) out[code] = rate;
  }
  return out;
}

const EXCHANGE_RATE_API = { name: 'ExchangeRate-API', site: 'https://www.exchangerate-api.com' };
const CURRENCY_API = { name: 'currency-api', site: 'https://github.com/fawazahmed0/exchange-api' };

function parseCurrencyApi(body: unknown): { rates: Record<string, number>; date: string } | null {
  const b = body as { date?: unknown; usd?: unknown } | null;
  if (typeof b?.date !== 'string') return null;
  return { rates: pickRates(b.usd, (code) => code.toLowerCase()), date: b.date };
}

export const RATE_FEEDS: readonly RateFeed[] = [
  {
    ...EXCHANGE_RATE_API,
    url: 'https://open.er-api.com/v6/latest/USD',
    parse(body) {
      const b = body as { result?: unknown; time_last_update_unix?: unknown; rates?: unknown } | null;
      if (b?.result !== 'success' || typeof b.time_last_update_unix !== 'number') return null;
      return { rates: pickRates(b.rates, (code) => code), date: new Date(b.time_last_update_unix * 1000).toISOString().slice(0, 10) };
    },
  },
  { ...CURRENCY_API, url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.min.json', parse: parseCurrencyApi },
  { ...CURRENCY_API, url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json', parse: parseCurrencyApi },
];

const FRESH_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3000;

export interface UsageRatesOptions {
  fetch?: typeof fetch;
  feeds?: readonly RateFeed[];
  now?: () => number;
}

export interface UsageRates {
  /** USAGE_RATES 里每个币种的汇率与出处。 */
  resolve(): Promise<ResolvedUsageRates>;
}

export function createUsageRates(options: UsageRatesOptions = {}): UsageRates {
  const fetchImpl = options.fetch ?? fetch;
  const feeds = options.feeds ?? RATE_FEEDS;
  const now = options.now ?? Date.now;
  let live: { rates: Record<string, number>; source: UsageRateSource; at: number } | null = null;
  let failedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  async function load(): Promise<void> {
    for (const feed of feeds) {
      try {
        const res = await fetchImpl(feed.url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!res.ok) continue;
        const parsed = feed.parse(await res.json());
        if (!parsed || Object.keys(parsed.rates).length === 0) continue;
        live = { rates: parsed.rates, source: { kind: 'live', feed: feed.name, site: feed.site, date: parsed.date }, at: now() };
        return;
      } catch {
        // 超时、断网或正文不是 JSON:换下一个接口。
      }
    }
    failedAt = now();
  }

  return {
    async resolve() {
      const t = now();
      if ((!live || t - live.at >= FRESH_MS) && t - failedAt >= RETRY_MS) {
        inflight ??= load().finally(() => { inflight = null; });
        await inflight;
      }
      const rates: Record<string, number> = {};
      const sources: Record<string, UsageRateSource> = {};
      for (const code of Object.keys(USAGE_RATES)) {
        if (live && code in live.rates) {
          rates[code] = live.rates[code]!;
          sources[code] = live.source;
        } else {
          rates[code] = USAGE_RATES[code]!;
          sources[code] = { kind: 'builtin', date: USAGE_RATES_DATE };
        }
      }
      return { rates, sources };
    },
  };
}
