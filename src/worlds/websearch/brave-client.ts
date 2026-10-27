/**
 * BraveClient:Brave Search API的最小客户端(docs/Brave_Search_API.md)。
 * 按 web_search 工具的 mode 分派到不同端点,统一映射成"带编号来源的证据"
 * (title/url/snippet);answer 遇 OPTION_NOT_IN_PLAN 降级到 web/search 并在 endpoint 上标注。retry/timeout骨架:429/5xx/超时退避重试,其余错误直抛。
 */
import type { Logger } from '../../core/types.ts';
import { nullLogger } from '../../core/util.ts';
import { cleanText, type Freshness, type SearchClient, type SearchOptions, type SearchOutcome, type SearchResult } from './search.ts';

export type SafeSearch = 'off' | 'moderate' | 'strict';

export interface BraveClientConfig {
  apiKey: string;
  /** 请求发往 `<baseUrl>/web/search` 等路径 */
  baseUrl: string;
  country: string;
  searchLang: string;
  uiLang: string;
  safesearch: SafeSearch;
  timeoutMs: number;
}

export class BraveApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'BraveApiError';
    this.status = status;
    this.code = code;
  }
}

/** HTTP 429 的有限退避间隔。 */
const RETRY_DELAYS_MS = [1000, 3000];

const FRESH_MAP: Record<Freshness, string | undefined> = {
  any: undefined,
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};


interface RawWebResult { title?: string; url?: string; description?: string }
interface WebSearchResponse { web?: { results?: RawWebResult[] } }
interface NewsSearchResponse { results?: RawWebResult[] }
interface RawVideoResult extends RawWebResult { video?: { duration?: string; publisher?: string } }
interface VideoSearchResponse { results?: RawVideoResult[] }
interface RawImageResult { title?: string; url?: string; source?: string; properties?: { url?: string } }
interface ImageSearchResponse { results?: RawImageResult[] }
interface RawGrounding { url?: string; title?: string; snippets?: string[] }
interface LlmContextResponse {
  grounding?: { generic?: RawGrounding[] };
  sources?: Record<string, { title?: string }>;
}

export class BraveClient implements SearchClient {
  private readonly cfg: BraveClientConfig;
  private readonly log: Logger;

  constructor(cfg: BraveClientConfig, log: Logger = nullLogger()) {
    this.cfg = cfg;
    this.log = log;
  }

  async search(q: string, opts: SearchOptions): Promise<SearchOutcome> {
    const mode = opts.mode === 'auto' ? 'links' : opts.mode;
    switch (mode) {
      case 'answer':
        try {
          return { endpoint: 'llm/context', results: await this.llmContext(q, opts.n, opts.fresh) };
        } catch (e) {
          if (e instanceof BraveApiError && e.code === 'OPTION_NOT_IN_PLAN') {
            this.log.warn('llm/context不在套餐内,降级web/search');
            return {
              endpoint: 'web/search (llm/context not in plan)',
              results: await this.webSearch(q, opts.n, opts.fresh),
            };
          }
          throw e;
        }
      case 'news':
        return { endpoint: 'news/search', results: await this.newsSearch(q, opts.n, opts.fresh) };
      case 'images':
        return { endpoint: 'images/search', results: await this.imageSearch(q, opts.n) };
      case 'videos':
        return { endpoint: 'videos/search', results: await this.videoSearch(q, opts.n, opts.fresh) };
      case 'links':
      default:
        return { endpoint: 'web/search', results: await this.webSearch(q, opts.n, opts.fresh) };
    }
  }


  private async webSearch(q: string, n: number, fresh: Freshness): Promise<SearchResult[]> {
    const p = this.commonParams(q, n, fresh);
    p.set('text_decorations', 'false');
    p.set('spellcheck', 'true');
    const data = await this.get<WebSearchResponse>('web/search', p);
    const items = data.web?.results ?? [];
    return items.map((r) => ({ title: cleanText(r.title), url: String(r.url ?? ''), snippet: cleanText(r.description) }));
  }

  private async newsSearch(q: string, n: number, fresh: Freshness): Promise<SearchResult[]> {
    const p = this.commonParams(q, n, fresh);
    p.set('spellcheck', 'true');
    const data = await this.get<NewsSearchResponse>('news/search', p);
    const items = data.results ?? [];
    return items.map((r) => ({ title: cleanText(r.title), url: String(r.url ?? ''), snippet: cleanText(r.description) }));
  }

  private async videoSearch(q: string, n: number, fresh: Freshness): Promise<SearchResult[]> {
    const p = this.commonParams(q, n, fresh);
    p.set('spellcheck', 'true');
    const data = await this.get<VideoSearchResponse>('videos/search', p);
    const items = data.results ?? [];
    return items.map((r) => {
      const extra = [r.video?.duration, r.video?.publisher].filter(Boolean).join(' · ');
      const desc = cleanText(r.description);
      return {
        title: cleanText(r.title),
        url: String(r.url ?? ''),
        snippet: [desc, extra].filter(Boolean).join(' — '),
      };
    });
  }

  private async imageSearch(q: string, n: number): Promise<SearchResult[]> {
    // Image Search 将 safesearch 归一为 off 或 strict，不发送 moderate。
    const p = new URLSearchParams();
    p.set('q', q);
    p.set('country', this.cfg.country);
    p.set('search_lang', this.cfg.searchLang);
    p.set('count', String(n));
    p.set('safesearch', this.cfg.safesearch === 'off' ? 'off' : 'strict');
    p.set('spellcheck', 'true');
    const data = await this.get<ImageSearchResponse>('images/search', p);
    const items = data.results ?? [];
    return items.map((r) => {
      const snippet = [
        r.source ? `source: ${r.source}` : '',
        r.properties?.url ? `image: ${r.properties.url}` : '',
      ].filter(Boolean).join(' · ');
      return { title: cleanText(r.title), url: String(r.url ?? ''), snippet };
    });
  }

  /** 为 LLM 提供 grounding 上下文，通过结果数、token 与 URL 上限约束响应规模。 */
  private async llmContext(q: string, n: number, fresh: Freshness): Promise<SearchResult[]> {
    const p = new URLSearchParams();
    p.set('q', q);
    p.set('country', this.cfg.country);
    p.set('search_lang', this.cfg.searchLang);
    p.set('count', '8');
    p.set('maximum_number_of_urls', String(Math.min(Math.max(n, 1), 5)));
    p.set('maximum_number_of_tokens', '2048');
    p.set('context_threshold_mode', 'balanced');
    const fr = FRESH_MAP[fresh];
    if (fr) p.set('freshness', fr);
    const data = await this.get<LlmContextResponse>('llm/context', p);
    const generic = data.grounding?.generic ?? [];
    const sources = data.sources ?? {};
    return generic.slice(0, n).map((g) => {
      const url = String(g.url ?? '');
      const title = cleanText(g.title || sources[url]?.title || url, 120);
      const snippet = cleanText((g.snippets ?? []).slice(0, 3).join(' … '), 260);
      return { title, url, snippet };
    });
  }


  private commonParams(q: string, n: number, fresh: Freshness): URLSearchParams {
    const p = new URLSearchParams();
    p.set('q', q);
    p.set('country', this.cfg.country);
    p.set('search_lang', this.cfg.searchLang);
    p.set('ui_lang', this.cfg.uiLang);
    p.set('count', String(n));
    p.set('safesearch', this.cfg.safesearch);
    const fr = FRESH_MAP[fresh];
    if (fr) p.set('freshness', fr);
    return p;
  }

  /** GET + 鉴权头 + 超时 + 429/5xx/超时退避重试;其余错误(含OPTION_NOT_IN_PLAN)直抛 */
  private async get<T>(path: string, params: URLSearchParams): Promise<T> {
    const url = `${this.cfg.baseUrl}/${path}?${params.toString()}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        this.log.warn(`Brave请求重试 #${attempt},等待${delay}ms`, { path, err: String(lastErr) });
        await new Promise((r) => setTimeout(r, delay));
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
      try {
        const res = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': this.cfg.apiKey,
          },
          signal: ac.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          let code: string | undefined;
          try {
            code = (JSON.parse(text) as { error?: { code?: string } })?.error?.code;
          } catch {
            /* 坏JSON body,code留空 */
          }
          const err = new BraveApiError(`Brave API ${res.status}${code ? ` (${code})` : ''}`, res.status, code);
          if (res.status === 429 || res.status >= 500) {
            lastErr = err;
            continue;
          }
          throw err;
        }
        return JSON.parse(text) as T;
      } catch (e) {
        if (e instanceof BraveApiError && e.status !== 429 && e.status < 500) throw e;
        // 网络错误/超时(AbortError)/可重试的BraveApiError
        lastErr = e;
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastErr instanceof BraveApiError) throw lastErr;
    throw new BraveApiError(`Brave请求失败(重试${RETRY_DELAYS_MS.length}次后放弃): ${String(lastErr)}`, 0);
  }
}
