/**
 * DeepSeekClient:DeepSeek Search API(`POST /v1/tools/search`)的最小客户端。
 * 只有网页搜索:各 mode 都打同一端点,answer 取给模型看的长摘要,其余取短摘要;fresh 折成
 * `after:` 查询运算符。408/429/5xx/超时退避重试,其余错误带服务端说明直抛。
 */
import type { Logger } from '../../core/types.ts';
import { nullLogger } from '../../core/util.ts';
import { cleanText, type Freshness, type SearchClient, type SearchOptions, type SearchOutcome } from './search.ts';

export interface DeepSeekClientConfig {
  apiKey: string;
  /** 请求发往 `<baseUrl>/v1/tools/search` */
  baseUrl: string;
  timeoutMs: number;
}

export class DeepSeekApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DeepSeekApiError';
    this.status = status;
  }
}

const ENDPOINT = 'deepseek/search';
/** 服务端对 query 的长度上限(Unicode 字符)。 */
const QUERY_MAX = 128;
const RETRY_DELAYS_MS = [1000, 3000];
const FRESH_DAYS: Record<Freshness, number | undefined> = { any: undefined, day: 1, week: 7, month: 31, year: 366 };

interface RawResult {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  date?: string | null;
}
interface SearchResponse { results?: RawResult[] }

const retryable = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/** 查询词加上 `after:` 后不超过服务端上限;按码点截断,不切开代理对。 */
export function deepSeekQuery(q: string, fresh: Freshness, now = new Date()): string {
  const days = FRESH_DAYS[fresh];
  const op = days === undefined ? '' : ` after:${new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)}`;
  return [...q].slice(0, QUERY_MAX - op.length).join('').trim() + op;
}

export class DeepSeekClient implements SearchClient {
  private readonly cfg: DeepSeekClientConfig;
  private readonly log: Logger;

  constructor(cfg: DeepSeekClientConfig, log: Logger = nullLogger()) {
    this.cfg = cfg;
    this.log = log;
  }

  async search(q: string, opts: SearchOptions): Promise<SearchOutcome> {
    const data = await this.post({ query: deepSeekQuery(q, opts.fresh), count: opts.n });
    const long = opts.mode === 'answer';
    const results = (data.results ?? []).slice(0, opts.n).map((r) => {
      const text = cleanText(long ? r.summary || r.snippet : r.snippet || r.summary, long ? 700 : 220);
      const date = typeof r.date === 'string' ? r.date.slice(0, 10) : '';
      return { title: cleanText(r.title, 120), url: String(r.url ?? ''), snippet: [date, text].filter(Boolean).join(' · ') };
    });
    return { endpoint: ENDPOINT, results };
  }

  private async post(body: Record<string, unknown>): Promise<SearchResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        this.log.warn(`DeepSeek 搜索请求重试 #${attempt},等待${delay}ms`, { err: String(lastErr) });
        await new Promise((r) => setTimeout(r, delay));
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
      try {
        const res = await fetch(`${this.cfg.baseUrl}/v1/tools/search`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          let detail = '';
          try {
            detail = cleanText((JSON.parse(text) as { error?: { message?: string } })?.error?.message, 200);
          } catch {
            /* 坏JSON body,不带说明 */
          }
          const err = new DeepSeekApiError(`DeepSeek API ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
          if (retryable(res.status)) {
            lastErr = err;
            continue;
          }
          throw err;
        }
        return JSON.parse(text) as SearchResponse;
      } catch (e) {
        if (e instanceof DeepSeekApiError && !retryable(e.status)) throw e;
        lastErr = e;
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastErr instanceof DeepSeekApiError) throw lastErr;
    throw new DeepSeekApiError(`DeepSeek 搜索请求失败(重试${RETRY_DELAYS_MS.length}次后放弃): ${String(lastErr)}`, 0);
  }
}
