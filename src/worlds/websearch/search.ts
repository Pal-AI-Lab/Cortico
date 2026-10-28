/** 各家搜索客户端共用的形状:按 web_search 工具的参数搜,统一映射成带编号来源的证据。 */

export type SearchMode = 'auto' | 'answer' | 'links' | 'news' | 'images' | 'videos';
export type Freshness = 'any' | 'day' | 'week' | 'month' | 'year';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  mode: SearchMode;
  fresh: Freshness;
  /** 期望条数(1-6,由工具层校验范围) */
  n: number;
}

export interface SearchOutcome {
  /** 实际打的端点,降级时如实标注 */
  endpoint: string;
  results: SearchResult[];
}

export interface SearchClient {
  search(q: string, opts: SearchOptions): Promise<SearchOutcome>;
}

/** 去掉<strong>高亮标记、压缩空白、按长度截断(工具描述承诺"精简") */
export function cleanText(s: unknown, max = 220): string {
  const t = (typeof s === 'string' ? s : '').replace(/<\/?strong>/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
