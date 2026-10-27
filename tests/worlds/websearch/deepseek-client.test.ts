import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekApiError, DeepSeekClient, deepSeekQuery } from '../../../src/worlds/websearch/deepseek-client.ts';
import { WEBSEARCH_DEFAULTS } from '../../../src/worlds/websearch/config.ts';

const client = () => new DeepSeekClient({ apiKey: 'test-key', baseUrl: WEBSEARCH_DEFAULTS.deepseekBaseUrl, timeoutMs: 5000 });
const body = (fetchMock: ReturnType<typeof vi.fn>, i = 0) => JSON.parse(String((fetchMock.mock.calls[i][1] as RequestInit).body));

describe('deepSeekQuery', () => {
  it('fresh 折成 after: 日期，整串不超过 128 个字符', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    expect(deepSeekQuery('猫', 'week', now)).toBe('猫 after:2026-10-18');
    expect(deepSeekQuery('猫', 'any', now)).toBe('猫');
    const long = deepSeekQuery('字'.repeat(200), 'day', now);
    expect([...long]).toHaveLength(128);
    expect(long.endsWith(' after:2026-10-24')).toBe(true);
  });
});

describe('DeepSeekClient.search', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('answer 取长摘要，其余取短摘要;条数按 n 截', async () => {
    const results = [1, 2, 3].map((i) => ({ title: `T${i}`, url: `https://${i}.example`, snippet: `short${i}`, summary: `long${i}` }));
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({ results }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const answer = await client().search('q', { mode: 'answer', fresh: 'any', n: 2 });
    expect(answer.results.map((r) => r.snippet)).toEqual(['long1', 'long2']);
    expect(body(fetchMock)).toEqual({ query: 'q', count: 2 });
    const links = await client().search('q', { mode: 'links', fresh: 'any', n: 3 });
    expect(links.results.map((r) => r.snippet)).toEqual(['short1', 'short2', 'short3']);
  });

  it('402 不重试，报错带服务端说明', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const err = await client().search('q', { mode: 'links', fresh: 'any', n: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(DeepSeekApiError);
    expect(err.message).toContain('402');
    expect(err.message).toContain('Insufficient Balance');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 退避后重试成功(调用次数即重试行为)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Response('{}', { status: 429 }))
      .mockImplementationOnce(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = client().search('q', { mode: 'links', fresh: 'any', n: 3 });
    await vi.runAllTimersAsync();
    expect((await pending).results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
