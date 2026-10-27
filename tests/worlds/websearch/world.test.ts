import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSearchWorld } from '../../../src/worlds/websearch/world.ts';
import type { ToolCallContext } from '../../../src/core/types.ts';
import { nullLogger } from '../../../src/core/util.ts';
import { type WebSearchConfigSection, WEBSEARCH_DEFAULTS, WEBSEARCH_SECRETS } from '../../../src/worlds/websearch/config.ts';

const ctx: ToolCallContext = { role: 'main', log: nullLogger() };

/** 密钥放在内存表里，模拟部署 .env:storeSecret 写进去，secret 立即读到。 */
function world(braveKey: string, patch: Partial<WebSearchConfigSection> = {}, env: Record<string, string> = {}) {
  const cfg: WebSearchConfigSection = { ...WEBSEARCH_DEFAULTS, ...patch };
  const secrets: Record<string, string> = { [WEBSEARCH_SECRETS.brave]: braveKey, ...env };
  const mod = new WebSearchWorld({ cfg, secret: (name) => secrets[name] ?? '', storeSecret: (name, value) => { secrets[name] = value; } });
  return Object.assign(mod, { cfg, secrets });
}

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

describe('WebSearchWorld', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('三要素:id/单一read工具', async () => {
    const mod = world('k');
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
    const mod = world('');
    const tool = mod.tools()[0];
    const out = await tool.handler({ q: '今天天气' }, ctx);
    expect(out).toContain('[tool failed]');
    expect(out).toContain('BRAVE_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('q为空(含纯空白)→ bad input,不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const mod = world('k');
    const out = await mod.tools()[0].handler({ q: '   ' }, ctx);
    expect(out).toContain('[bad input]');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('单个中文字也是合法查询(中文单字length=1,不应被当作太短拒绝)', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse({ web: { results: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = world('k');
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
    const mod = world('k');
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
    const mod = world('k');
    const out = await mod.tools()[0].handler({ q: '查无此事的东西' }, ctx);
    expect(out).toBe('(no results for "查无此事的东西")');
  });

  it('有结果时附带外部平台风险提醒', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      okResponse({ web: { results: [{ title: 'T', url: 'https://a.example', description: 'd' }] } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = world('k');
    const out = (await mod.tools()[0].handler({ q: '测试查询' }, ctx)) as string;
    expect(out).toContain('QQ');
    expect(out).toContain('banned');
    expect(out.trim().endsWith('Paraphrase and use judgment.')).toBe(true);
  });

  it('无结果时不附带风险提醒', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse({ web: { results: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = world('k');
    const out = await mod.tools()[0].handler({ q: '查无此事的东西' }, ctx);
    expect(out).not.toContain('banned');
  });

  it('mode非法值回退auto,n超界被夹到[1,6]', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse({ web: { results: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = world('k');
    await mod.tools()[0].handler({ q: '测试查询', mode: 'not-a-real-mode', n: 999 }, ctx);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/web/search?'); // auto→links→web/search
    expect(url).toContain('count=6');
  });

  it('请求失败 → [search failed]提示,不抛出', async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response('boom', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = world('k');
    const out = await mod.tools()[0].handler({ q: '测试查询' }, ctx);
    expect(out).toContain('[search failed]');
  });

  it('英文界面的 webUi() 展示文案不含中文', () => {
    for (const apiKey of ['k', '']) {
      const shown = JSON.stringify(world(apiKey).webUi('en'), (k, v) => (k === 'path' ? undefined : v));
      expect(shown).not.toMatch(/[一-鿿]/);
    }
  });
});

describe('WebSearchWorld 切到 DeepSeek', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('没有 DeepSeek 密钥时提示缺的是哪个变量，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await world('k', { provider: 'deepseek' }).tools()[0].handler({ q: '测试' }, ctx);
    expect(out).toContain(WEBSEARCH_SECRETS.deepseek);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('改配置里的 provider 后，同一实例的下一次搜索就走 DeepSeek', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      okResponse({ results: [{ title: 'D', url: 'https://d.example', snippet: 's', summary: 'long', date: '2026-10-01T00:00:00Z' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = world('k', {}, { [WEBSEARCH_SECRETS.deepseek]: 'ds' });
    mod.cfg.provider = 'deepseek';
    const out = await mod.tools()[0].handler({ q: '测试查询' }, ctx);
    expect(out).toContain('deepseek/search · 1 result(s)');
    expect(out).toContain('2026-10-01 · s');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('api.deepseek.com');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer ds' });
  });

  it('配置了 DeepSeek 地址时请求发往该地址,末尾斜杠不重复', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = world('k', { provider: 'deepseek', deepseekBaseUrl: 'https://proxy.example/deepseek/' }, { [WEBSEARCH_SECRETS.deepseek]: 'ds' });
    await mod.tools()[0].handler({ q: '测试查询' }, ctx);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://proxy.example/deepseek/v1/tools/search');
  });
});

describe('WebSearch 快速配置页签', () => {
  it('setKey 写进对应服务的密钥变量，state 只给打码后的样子，灯随之变绿', async () => {
    const mod = world('', { provider: 'deepseek' });
    const ui = mod.webUi();
    expect(ui.lamps?.[0].state).toBe('offline');
    const key = 'sk-0123456789abcdef';
    const st = (await ui.invoke!('setup', 'setKey', ['deepseek', `  ${key} `])) as { keys: Record<string, string | null> };
    expect(mod.secrets[WEBSEARCH_SECRETS.deepseek]).toBe(key);
    expect(st.keys.deepseek).not.toContain(key);
    expect(st.keys.brave).toBeNull();
    expect(mod.webUi().lamps?.[0].state).toBe('online');
    await ui.invoke!('setup', 'clearKey', ['deepseek']);
    expect(mod.webUi().lamps?.[0].state).toBe('offline');
  });

  it('空密钥、未知方法和未知面板都报错', async () => {
    const ui = world('').webUi();
    await expect(ui.invoke!('setup', 'setKey', ['brave', '  '])).rejects.toThrow();
    await expect(ui.invoke!('setup', 'nope', [])).rejects.toThrow('nope');
    await expect(ui.invoke!('nope', 'state', [])).rejects.toThrow('nope');
  });

  it('浏览器扩展导出的面板键与服务端声明一一对应', async () => {
    const entry = '../../../src/worlds/websearch/webui/client.ts';
    const bundle = ((await import(entry)) as { default: { panels: Record<string, { mount: unknown }> } }).default;
    const declared = (world('').webUi().panels ?? []).map((p) => p.id);
    expect(Object.keys(bundle.panels).sort()).toEqual([...declared].sort());
  });
});
