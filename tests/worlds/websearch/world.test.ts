import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSearchWorld } from '../../../src/worlds/websearch/world.ts';
import type { ToolCallContext } from '../../../src/core/types.ts';
import { nullLogger } from '../../../src/core/util.ts';

const ctx: ToolCallContext = { role: 'main', log: nullLogger() };

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

describe('WebSearchWorld', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('三要素:id/单一read工具', async () => {
    const mod = new WebSearchWorld({ apiKey: 'k' });
    expect(mod.id).toBe('websearch');
    const tools = mod.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('web_search');
    expect(tools[0].tags).toEqual(['read']);
    expect(tools[0].parameters).toMatchObject({ required: ['q'] });
  });

  it('未配置apiKey → 每次调用都提示未配置,不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const mod = new WebSearchWorld({ apiKey: '' });
    const tool = mod.tools()[0];
    const out = await tool.handler({ q: '今天天气' }, ctx);
    expect(out).toContain('[tool failed]');
    expect(out).toContain('BRAVE_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('q为空(含纯空白)→ bad input,不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const mod = new WebSearchWorld({ apiKey: 'k' });
    const out = await mod.tools()[0].handler({ q: '   ' }, ctx);
    expect(out).toContain('[bad input]');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('单个中文字也是合法查询(中文单字length=1,不应被当作太短拒绝)', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse({ web: { results: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = new WebSearchWorld({ apiKey: 'k' });
    const out = await mod.tools()[0].handler({ q: '猫' }, ctx);
    expect(out).not.toContain('[bad input]');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('成功:格式化编号来源列表', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      okResponse({
        web: {
          results: [
            { title: '标题一', url: 'https://a.example', description: '摘要一' },
            { title: '标题二', url: 'https://b.example', description: '摘要二' },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = new WebSearchWorld({ apiKey: 'k' });
    const out = await mod.tools()[0].handler({ q: '检索测试' }, ctx);
    expect(out).toContain('web_search: "检索测试" · web/search · 2 result(s)');
    expect(out).toContain('1. 标题一');
    expect(out).toContain('   https://a.example');
    expect(out).toContain('   摘要一');
    expect(out).toContain('2. 标题二');
    expect(out).toContain('QQ');
    expect(out).toContain('banned');
  });

  it('无结果 → 友好提示', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse({ web: { results: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = new WebSearchWorld({ apiKey: 'k' });
    const out = await mod.tools()[0].handler({ q: '查无此事的东西' }, ctx);
    expect(out).toBe('(no results for "查无此事的东西")');
  });

  it('有结果时附带外部平台风险提醒', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      okResponse({ web: { results: [{ title: 'T', url: 'https://a.example', description: 'd' }] } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = new WebSearchWorld({ apiKey: 'k' });
    const out = (await mod.tools()[0].handler({ q: '测试查询' }, ctx)) as string;
    expect(out).toContain('QQ');
    expect(out).toContain('banned');
    expect(out.trim().endsWith('Paraphrase and use judgment.')).toBe(true);
  });

  it('无结果时不附带风险提醒', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse({ web: { results: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = new WebSearchWorld({ apiKey: 'k' });
    const out = await mod.tools()[0].handler({ q: '查无此事的东西' }, ctx);
    expect(out).not.toContain('banned');
  });

  it('mode非法值回退auto,n超界被夹到[1,6]', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse({ web: { results: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = new WebSearchWorld({ apiKey: 'k' });
    await mod.tools()[0].handler({ q: '测试查询', mode: 'not-a-real-mode', n: 999 }, ctx);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/web/search?'); // auto→links→web/search
    expect(url).toContain('count=6');
  });

  it('请求失败 → [search failed]提示,不抛出', async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response('boom', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = new WebSearchWorld({ apiKey: 'k' });
    const out = await mod.tools()[0].handler({ q: '测试查询' }, ctx);
    expect(out).toContain('[search failed]');
  });

  it('英文界面的 webUi() 展示文案不含中文', () => {
    for (const apiKey of ['k', '']) {
      const shown = JSON.stringify(new WebSearchWorld({ apiKey }).webUi('en'), (k, v) => (k === 'path' ? undefined : v));
      expect(shown).not.toMatch(/[一-鿿]/);
    }
  });
});
