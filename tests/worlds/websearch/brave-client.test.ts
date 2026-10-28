import { afterEach, describe, expect, it, vi } from 'vitest';
import { BraveApiError, BraveClient } from '../../../src/worlds/websearch/brave-client.ts';
import { WEBSEARCH_DEFAULTS } from '../../../src/worlds/websearch/config.ts';

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

function makeClient(): BraveClient {
  return new BraveClient({
    apiKey: 'test-key',
    baseUrl: WEBSEARCH_DEFAULTS.braveBaseUrl,
    country: 'CN',
    searchLang: 'zh-hans',
    uiLang: 'zh-CN',
    safesearch: 'moderate',
    timeoutMs: 5000,
  });
}

describe('BraveClient.search', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('mode=auto/links → web/search,鉴权头+基础参数正确,描述去<strong>标记', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        web: {
          results: [
            { title: 'A', url: 'https://a.example', description: '<strong>关键词</strong>命中' },
            { title: 'B', url: 'https://b.example', description: '纯文本' },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().search('OpenAI', { mode: 'auto', fresh: 'any', n: 4 });
    expect(out.endpoint).toBe('web/search');
    expect(out.results).toEqual([
      { title: 'A', url: 'https://a.example', snippet: '关键词命中' },
      { title: 'B', url: 'https://b.example', snippet: '纯文本' },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${WEBSEARCH_DEFAULTS.braveBaseUrl}/web/search?`);
    expect(url).toContain('q=OpenAI');
    expect(url).toContain('country=CN');
    expect(url).toContain('count=4');
    expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('test-key');
  });

  it('fresh映射:week→pw,any不发freshness参数', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse({ web: { results: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    await makeClient().search('q1', { mode: 'links', fresh: 'week', n: 4 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('freshness=pw');

    await makeClient().search('q2', { mode: 'links', fresh: 'any', n: 4 });
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('freshness=');
  });

  it('mode=news → news/search', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ results: [{ title: 'N', url: 'https://n.example', description: 'd' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await makeClient().search('q', { mode: 'news', fresh: 'day', n: 2 });
    expect(out.endpoint).toBe('news/search');
    expect(out.results).toEqual([{ title: 'N', url: 'https://n.example', snippet: 'd' }]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/news/search?');
  });

  it('mode=videos → videos/search,附带时长/发布方', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        results: [
          {
            title: 'V',
            url: 'https://v.example',
            description: '介绍',
            video: { duration: '12:22', publisher: 'YouTube' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await makeClient().search('q', { mode: 'videos', fresh: 'any', n: 2 });
    expect(out.endpoint).toBe('videos/search');
    expect(out.results[0].snippet).toBe('介绍 — 12:22 · YouTube');
  });

  it('mode=images → images/search,safesearch=moderate映射为strict', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        results: [
          { title: 'I', url: 'https://page.example', source: 'example.com', properties: { url: 'https://img.example/1.png' } },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await makeClient().search('q', { mode: 'images', fresh: 'any', n: 2 });
    expect(out.endpoint).toBe('images/search');
    expect(out.results[0]).toEqual({
      title: 'I',
      url: 'https://page.example',
      snippet: 'source: example.com · image: https://img.example/1.png',
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('safesearch=strict');
  });

  it('mode=answer → llm/context,取grounding.generic+sources标题回填', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        grounding: {
          generic: [{ url: 'https://s.example', snippets: ['片段1', '片段2', '片段3', '片段4'] }],
        },
        sources: { 'https://s.example': { title: '来源标题' } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await makeClient().search('q', { mode: 'answer', fresh: 'any', n: 3 });
    expect(out.endpoint).toBe('llm/context');
    expect(out.results).toEqual([
      { title: '来源标题', url: 'https://s.example', snippet: '片段1 … 片段2 … 片段3' },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/llm/context?');
  });

  it('mode=answer遇OPTION_NOT_IN_PLAN → 降级web/search', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'OPTION_NOT_IN_PLAN', detail: 'not subscribed' } }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(okResponse({ web: { results: [{ title: 'W', url: 'https://w.example', description: 'd' }] } }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().search('q', { mode: 'answer', fresh: 'any', n: 3 });
    expect(out.endpoint).toBe('web/search (llm/context not in plan)');
    expect(out.results).toEqual([{ title: 'W', url: 'https://w.example', snippet: 'd' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/web/search?');
  });

  it('429退避重试后成功', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(okResponse({ web: { results: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const p = makeClient().search('q', { mode: 'links', fresh: 'any', n: 4 });
    await vi.advanceTimersByTimeAsync(1000);
    const out = await p;
    expect(out.results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('400(非429/5xx)直抛BraveApiError,不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR' } }), { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeClient().search('q', { mode: 'links', fresh: 'any', n: 4 })).rejects.toMatchObject({
      name: 'BraveApiError',
      status: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('重试次数耗尽后仍失败 → 抛最后一次的BraveApiError', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const p = makeClient().search('q', { mode: 'links', fresh: 'any', n: 4 });
    const assertion = expect(p).rejects.toBeInstanceOf(BraveApiError);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3); // 首次 + 2次重试
  });
});
