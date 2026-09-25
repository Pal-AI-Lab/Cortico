/**
 * @vitest-environment jsdom
 * 使用模拟 DOM 与接口验证页面行为；浏览器源码由变量动态 import 加载，类型由 tsconfig.web.json 检查。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UI = '../../src/web/client/ui/index.ts';
const LIFECYCLE = '../../src/web/client/core/lifecycle.ts';
const ROUTER = '../../src/web/client/core/router.ts';
const EXTENSIONS = '../../src/web/client/features/extensions/index.ts';

type Any = any;

const { createConsoleUi } = (await import(UI)) as Any;
const { Lifecycle } = (await import(LIFECYCLE)) as Any;
const { Router } = (await import(ROUTER)) as Any;
const { mountExtensions, parseInstallInput, arrangeHits, extensionsFeature, restartOutcome } = (await import(EXTENSIONS)) as Any;

const flush = async (n = 30): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const LIST = {
  dir: 'C:/repo/extensions',
  extensions: [
    { name: 'alpha-mod', spec: '^1.0.0', version: '1.0.0', kind: 'world', api: 3, consoleClient: true, console: 'served', loaded: true, worldId: 'alpha', label: '甲扩展', state: 'loaded' },
    { name: 'beta-mod', spec: '^1.0.0', version: '1.0.0', kind: 'world', api: 3, consoleClient: true, console: 'missing', loaded: false, reason: '默认导出不是 WorldDefinition', state: 'failed' },
    { name: 'gamma-prov', spec: '^2.0.0', version: '2.0.0', kind: 'provider', api: 3, consoleClient: false, console: 'none', loaded: false, state: 'pending-restart', description: '丙' },
    { name: 'delta-mod', spec: '^1.0.0', version: '1.0.0', kind: 'world', api: 3, consoleClient: false, console: 'none', loaded: true, worldId: 'delta', state: 'removed' },
    { name: 'epsilon-mod', spec: '^1.0.0', version: '1.0.0', consoleClient: false, loaded: false, reason: 'package.json 缺少 cortico 块(至少要 kind 与 api)。', state: 'failed' },
  ],
};

const HITS = {
  hits: [
    { name: 'found-mod', version: '3.1.0', description: '搜到的', downloads: 42, dependents: 2, publisher: 'someone', license: 'MIT', date: '2026-09-18T00:00:00.000Z', keywords: ['cortico-world', 'chat'], links: { npm: 'https://npm.example/found', repository: 'https://git.example/found' }, installed: false, kind: 'world' },
    { name: 'alpha-mod', version: '1.0.0', description: '已经装了', downloads: 7, dependents: 0, date: '2026-01-02T00:00:00.000Z', links: {}, installed: true, kind: 'world' },
    // 填够 13 条:一页放 12 张,第 13 条只会出现在第二页
    ...Array.from({ length: 11 }, (_, i) => ({
      name: `filler-${i}`, version: '0.1.0', description: '凑数的', downloads: 100 + i, dependents: 0,
      date: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, links: {}, installed: false, kind: 'world',
    })),
  ],
};

const DETAIL = {
  name: 'found-mod',
  version: '3.1.0',
  description: '搜到的',
  license: 'MIT',
  keywords: ['cortico-world', 'chat'],
  published: '2026-09-18T00:00:00.000Z',
  created: '2025-12-01T00:00:00.000Z',
  versionCount: 4,
  history: [{ version: '3.1.0', date: '2026-09-18T00:00:00.000Z' }, { version: '3.0.0', date: '2026-07-01T00:00:00.000Z' }],
  manifest: { kind: 'world', api: 4, consoleClient: 'dist/console.js' },
  warnings: [],
  frameworkApi: 4,
  engines: '>=22',
  unpackedSize: 204800,
  fileCount: 12,
  dependencies: ['ws'],
  maintainers: ['someone'],
  publisher: 'someone',
  links: { npm: 'https://npm.example/found', repository: 'https://git.example/found', bugs: 'https://git.example/found/issues' },
  installed: false,
};

let calls: Array<{ url: string; method: string; body: Any }> = [];

function stub(over: { list?: unknown; updates?: unknown; updateStatus?: number; installStatus?: number; hits?: unknown; detail?: Any; detailStatus?: number } = {}): void {
  vi.stubGlobal('fetch', (url: unknown, init: Any) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET');
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let status = 200;
    let body: unknown = {};
    if (u === '/api/extensions') body = over.list ?? LIST;
    else if (u === '/api/extensions/updates') { status = over.updateStatus ?? 200; body = status === 200 ? over.updates ?? { updates: [], errors: [] } : { error: 'npm unavailable' }; }
    else if (u.startsWith('/api/extensions/package')) {
      status = over.detailStatus ?? 200;
      body = status === 200 ? { ...DETAIL, ...(over.detail ?? {}) } : { error: 'npm 没有这个包' };
    } else if (u.startsWith('/api/extensions/search')) body = over.hits ?? HITS;
    else if (u === '/api/extensions/operations') { const payload = JSON.parse(init.body); body = { id: payload.id, phase: over.installStatus ? 'rolled-back' : 'committed', name: payload.target.name, version: payload.target.version, error: over.installStatus ? 'invalid package' : undefined }; }
    else if (u === '/api/extensions/install') { status = over.installStatus ?? 200; body = status === 200 ? { ok: true, result: '已安装 x。重启进程后加载。\n+ x 1.0.0' } : { error: '不是合法的 npm 包名: x' }; }
    else if (u === '/api/extensions/uninstall') body = { ok: true, result: '已卸载 x。' };
    else if (u === '/api/run/restart') body = { ok: true, result: '本地关机完成,进程即将退出', steps: [{ label: '按住事件投递', ok: true, ms: 2 }] };
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  });
}

function mkCtx(caps: Record<string, boolean> = { extensions: true, restart: true, supervised: true }): Any {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const lifecycle = new Lifecycle(() => {});
  const ui = createConsoleUi({
    memo: { get: () => null, set: () => {} },
    overlayHost: document.body,
    signal: lifecycle.signal,
    doc: document,
  });
  const router = new Router({ win: window, confirmLeave: async () => true, onError: () => {} });
  lifecycle.own(router.start());
  return {
    ctx: {
      ui, root, lifecycle, signal: lifecycle.signal,
      capabilities: caps,
      route: { segments: ['extensions'] },
      router,
      onError: () => {},
    },
    root,
    lifecycle,
  };
}

const buttons = (el: ParentNode): HTMLButtonElement[] => [...el.querySelectorAll('button')] as HTMLButtonElement[];
const button = (el: ParentNode, text: string): HTMLButtonElement => {
  const hit = buttons(el).find((b) => b.textContent?.trim() === text);
  if (!hit) throw new Error(`没有「${text}」这颗键`);
  return hit;
};
/** 答一次模态确认:danger 模式的确认键写的是「仍要继续」,普通模式是「确认」。 */
function answer(yes: boolean): void {
  // 抽屉也是一层 .modal:确认框是后铺上去的那一层
  const layers = [...document.querySelectorAll('.modal')];
  const modal = layers[layers.length - 1];
  if (!modal) throw new Error('没有弹出确认框');
  const want = yes ? ['仍要继续', '确认'] : ['取消'];
  const btn = buttons(modal).find((b) => want.includes(b.textContent?.trim() ?? ''));
  if (!btn) throw new Error('确认框上找不到按钮');
  btn.click();
}
const cardOf = (root: ParentNode, title: string): HTMLElement => {
  const hit = [...root.querySelectorAll('.extension-card')].find((c) => c.querySelector('.extension-card-title')?.textContent?.startsWith(title));
  if (!hit) throw new Error(`没有「${title}」的卡`);
  return hit as HTMLElement;
};
const lives: Any[] = [];
function mount(caps: Record<string, boolean> = {}) { const context = mkCtx(caps); lives.push(context.lifecycle); mountExtensions(context.ctx); return context; }
beforeEach(() => { calls = []; window.sessionStorage.clear(); window.history.replaceState(null, '', '#/extensions/world'); Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1100 }); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { lives.splice(0).forEach(life => life.dispose()); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const installedCards = (root: HTMLElement) => root.querySelector('.extension-grid')!;
const marketCards = (root: HTMLElement) => root.querySelectorAll('.extension-grid')[1];
const switchTo = async (ctx: Any, kind: string) => { ctx.router.replace(['extensions', kind]); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush(); };

describe('extension categories', () => {
  it('isolates installed categories and preserves each market filter across routes', async () => {
    stub(); const { ctx, root } = mount(); await flush();
    expect(installedCards(root).textContent).toContain('甲扩展'); expect(installedCards(root).textContent).not.toContain('gamma-prov');
    const input = root.querySelectorAll('input[type=search]')[1] as HTMLInputElement; input.value = 'found'; input.dispatchEvent(new Event('input')); await flush();
    await switchTo(ctx, 'provider'); expect(installedCards(root).textContent).toContain('gamma-prov'); expect(installedCards(root).textContent).not.toContain('甲扩展');
    await switchTo(ctx, 'world'); expect((root.querySelectorAll('input[type=search]')[1] as HTMLInputElement).value).toBe('found');
    expect(marketCards(root).querySelectorAll('.extension-card')).toHaveLength(1);
  });
  it('uses keyboard focus without activating a category until Enter or click', async () => {
    stub(); const { root } = mount(); await flush(); const tabs = root.querySelectorAll('[role=tab]') as NodeListOf<HTMLButtonElement>;
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabs[1]); expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); expect(document.activeElement).toBe(tabs[2]);
  });
  it('caps installed cards at two rows and market at four rows at all widths', async () => {
    const many = { ...LIST, extensions: Array.from({ length: 15 }, (_, i) => ({ ...LIST.extensions[0], name: `item-${String(i).padStart(2, '0')}`, label: `Item ${i}` })) };
    for (const [width, count] of [[1100, 6], [800, 4], [500, 2]]) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width }); stub({ list: many });
      const { root, lifecycle } = mount(); await flush();
      expect(installedCards(root).querySelectorAll('.extension-card')).toHaveLength(count);
      expect(marketCards(root).querySelectorAll('.extension-card')).toHaveLength(count * 2);
      button(root.querySelector('.extension-category > .sheet')!, '下一页 ›').click(); expect(installedCards(root).textContent).toContain(`Item ${count}`);
      lifecycle.dispose(); root.remove(); window.sessionStorage.clear();
    }
  });
  it('retains installed records if refresh fails', async () => {
    stub(); const { root } = mount(); await flush(); vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    button(root, '↻ 刷新').click(); await flush(); expect(installedCards(root).textContent).toContain('甲扩展'); expect(root.textContent).toContain('offline');
  });
  it('keeps Bot templates free of load/unload actions and shows creation instructions', async () => {
    stub({ list: { ...LIST, extensions: [{ ...LIST.extensions[0], name: 'sample-template', kind: 'bot', enabled: true }] } });
    const { ctx, root } = mount(); await flush(); await switchTo(ctx, 'bot');
    expect(installedCards(root).textContent).toContain('当前 Bot 正在采用'); expect(button(root, '创建实例说明')).toBeTruthy();
    expect(button(root, '删除扩展').disabled).toBe(true); button(root, '创建实例说明').click(); expect(document.body.textContent).toContain('pnpm start --new');
  });
  it('preserves version updates and disables incompatible releases', async () => {
    stub({ updates: { updates: [{ name: 'alpha-mod', installedVersion: '1.0.0', latestVersion: '2.0.0', problems: ['incompatible'] }], errors: [] } });
    const { root } = mount(); await flush(); expect(root.textContent).toContain('1.0.0 → 2.0.0'); expect(button(root, '更新').disabled).toBe(true);
  });
});
describe('installation feedback', () => {
  async function detail(root: HTMLElement) {
    const input = root.querySelectorAll('input[type=search]')[1] as HTMLInputElement; input.value = 'found'; input.dispatchEvent(new Event('input'));
    (marketCards(root).querySelector('[aria-label="found-mod"]') as HTMLElement).click(); await flush(); return document.querySelector('.modal')!;
  }
  it('installs an exact version with an operation ID and leaves feedback in the market', async () => {
    stub(); const { root } = mount(); await flush(); const box = await detail(root); button(box, '安装').click(); await flush();
    expect(calls.find(c => c.url === '/api/extensions/operations')?.body).toMatchObject({ action: 'install', target: { name: 'found-mod', version: '3.1.0' }, kind: 'world' });
    expect(root.querySelectorAll('.extension-category > .sheet')[1].textContent).toContain('安装成功');
    expect(root.querySelectorAll('.extension-category > .sheet')[0].textContent).not.toContain('安装成功');
  });
  it('shows rollback failures only in the originating section', async () => {
    stub({ installStatus: 400 }); const { root } = mount(); await flush(); button(await detail(root), '安装').click(); await flush();
    expect(root.querySelectorAll('.extension-category > .sheet')[1].querySelector('.msgline.bad')?.textContent).toContain('恢复原安装状态');
  });
  it('blocks incompatible detail installation and dangerous links', async () => {
    stub({ detail: { problems: ['incompatible'], links: { npm: 'javascript:alert(1)' } } }); const { root } = mount(); await flush(); const box = await detail(root);
    expect(button(box, '安装').disabled).toBe(true); expect(box.querySelector('a')).toBeNull();
  });
  it('manual npm input rejects paths and URLs; local source is explicit', async () => {
    stub(); const { root } = mount(); await flush();
    const input = root.querySelector('input[aria-label="包名与版本"]') as HTMLInputElement; input.value = 'https://example.com'; input.dispatchEvent(new Event('input')); button(root, '安装').click(); await flush();
    expect(calls.some(c => c.url === '/api/extensions/operations')).toBe(false);
    button(root, '从本机目录安装').click(); expect(root.querySelector('input[aria-label="扩展项目目录"]')).not.toBeNull(); expect(root.textContent).toContain('运行 Cortico 的电脑');
  });
});
describe('npm input', () => {
  it('accepts names, scoped names and exact versions or tags only', () => {
    expect(parseInstallInput('@scope/example@1.2.3')).toEqual({ name: '@scope/example', version: '1.2.3' });
    expect(parseInstallInput('@scope/example@next')).toEqual({ name: '@scope/example', version: 'next' });
    for (const value of ['', './path', 'C:\\path', 'https://example.com', 'name; cmd', 'name@^1.0']) expect(parseInstallInput(value)).toBeNull();
  });
});
describe('arrangeHits', () => {
  const hit = (over: Any): Any => ({ name: 'x', version: '1.0.0', description: '', downloads: 0, dependents: 0, links: {}, installed: false, ...over });
  const opts = (over: Any): Any => ({ filter: '', hideInstalled: false, sort: 'downloads', page: 0, pageSize: 2, ...over });

  it('筛选看名字、描述与关键字;隐藏已安装是另一道', () => {
    const hits = [
      hit({ name: 'alpha', description: '甲' }),
      hit({ name: 'beta', description: '乙', keywords: ['chat'] }),
      hit({ name: 'gamma', description: '丙', installed: true }),
    ];
    expect(arrangeHits(hits, opts({ filter: 'chat' })).shown.map((h: Any) => h.name)).toEqual(['beta']);
    expect(arrangeHits(hits, opts({ filter: '丙' })).shown.map((h: Any) => h.name)).toEqual(['gamma']);
    expect(arrangeHits(hits, opts({ filter: 'ALPHA' })).shown.map((h: Any) => h.name)).toEqual(['alpha']);
    expect(arrangeHits(hits, opts({ hideInstalled: true })).matched).toBe(2);
  });

  it('三种排序各自的口径;并列时按名字', () => {
    const hits = [
      hit({ name: 'b', downloads: 5, dependents: 1, date: '2026-01-01T00:00:00.000Z' }),
      hit({ name: 'a', downloads: 5, dependents: 9, date: '2026-05-05T00:00:00.000Z' }),
      hit({ name: 'c', downloads: 90, dependents: 0 }),
    ];
    const names = (sort: string): string[] => arrangeHits(hits, opts({ sort, pageSize: 10 })).shown.map((h: Any) => h.name);
    expect(names('downloads')).toEqual(['c', 'a', 'b']);
    expect(names('name')).toEqual(['a', 'b', 'c']);
    // 没有发布时间的排在最后
    expect(names('date')).toEqual(['a', 'b', 'c']);
  });

  it('页码超出范围收回最后一页;一条都没有时仍是一页', () => {
    const hits = [hit({ name: 'a' }), hit({ name: 'b' }), hit({ name: 'c' })];
    expect(arrangeHits(hits, opts({ page: 9 }))).toMatchObject({ page: 1, pages: 2 });
    expect(arrangeHits(hits, opts({ page: -3 })).page).toBe(0);
    expect(arrangeHits([], opts({}))).toMatchObject({ matched: 0, pages: 1, page: 0, shown: [] });
  });
});



describe('restart identity', () => {
  it('waits for a new ready process of the same deployment', () => {
    const before = { deployment: 'same', bootId: 'old', ready: true };
    expect(restartOutcome(before, before)).toBe('waiting');
    expect(restartOutcome(before, { ...before, bootId: 'new', ready: false })).toBe('waiting');
    expect(restartOutcome(before, { ...before, bootId: 'new' })).toBe('ready');
    expect(restartOutcome(before, { ...before, deployment: 'other', bootId: 'new' })).toBe('wrong-deployment');
  });
});

describe('asynchronous ownership', () => {
  it('a late World search cannot replace the Provider market', async () => {
    stub(); const original = fetch; let release!: (response: Response) => void;
    vi.stubGlobal('fetch', (url: unknown, init: Any) => String(url).includes('search?kind=world') ? new Promise<Response>(resolve => release = resolve)
      : String(url).includes('search?kind=provider') ? Promise.resolve(new Response(JSON.stringify({ hits: [{ ...HITS.hits[0], name: 'provider-result', kind: 'provider' }] }))) : original(url as string, init));
    const { ctx, root } = mount(); await flush(); await switchTo(ctx, 'provider');
    expect(marketCards(root).textContent).toContain('provider-result'); release(new Response(JSON.stringify(HITS))); await flush();
    expect(marketCards(root).textContent).toContain('provider-result'); expect(marketCards(root).textContent).not.toContain('found-mod');
  });
  it('queries the existing operation after a lost response without submitting another write', async () => {
    stub(); const original = fetch; let writes = 0, queries = 0;
    vi.stubGlobal('fetch', (url: unknown, init: Any) => {
      if (String(url) === '/api/extensions/operations') { writes++; return Promise.reject(new Error('connection lost')); }
      if (String(url).startsWith('/api/extensions/operations/')) { queries++; return Promise.resolve(new Response(JSON.stringify({ phase: 'committed', name: 'sample', version: '1.0.0' }))); }
      return original(url as string, init);
    });
    const { root } = mount(); await flush(); const input = root.querySelector('input[aria-label="包名与版本"]') as HTMLInputElement;
    input.value = 'sample@1.0.0'; input.dispatchEvent(new Event('input')); button(root, '安装').click(); await flush(80);
    expect(writes).toBe(1); expect(queries).toBe(1); expect(root.querySelectorAll('.extension-category > .sheet')[2].textContent).toContain('安装成功');
  });
});

describe('extension review interactions', () => {
  it('keeps stopping the running version available during an update and protects built-ins', async () => {
    stub({ list: { dir: LIST.dir, extensions: [
      { ...LIST.extensions[0], enabled: true, installedVersion: '2.0.0', state: 'pending-restart' },
      { ...LIST.extensions[0], name: 'builtin:world:example', builtin: true, label: 'Built-in example' },
    ] } });
    const { root } = mount(); await flush(); const cards = installedCards(root).querySelectorAll('.extension-card');
    expect(button(cards[0], '停用').disabled).toBe(false);
    expect(cards[0].querySelector('.extension-card-heading')?.textContent).toContain('已加载');
    expect(cards[0].textContent).not.toContain('重启并启用');
    expect(button(cards[1], '删除扩展').disabled).toBe(true);
  });
  it('filters installed modules independently and lets users override each page capacity', async () => {
    stub({ list: { dir: LIST.dir, extensions: Array.from({length: 8}, (_, i) => ({ ...LIST.extensions[0], name: `module-${i}`, label: `模块 ${i}` })) } });
    const { root } = mount(); await flush();
    const sizes = root.querySelectorAll('.extension-size select') as NodeListOf<HTMLSelectElement>;
    sizes[0].value = '3'; sizes[0].dispatchEvent(new Event('change')); expect(installedCards(root).children).toHaveLength(3);
    sizes[1].value = '6'; sizes[1].dispatchEvent(new Event('change')); expect(marketCards(root).children).toHaveLength(6);
    const filter = root.querySelector('input[type=search]') as HTMLInputElement; filter.value = 'module-7'; filter.dispatchEvent(new Event('input'));
    expect(installedCards(root).children).toHaveLength(1); expect(installedCards(root).textContent).toContain('模块 7'); expect(marketCards(root).children).toHaveLength(6);
    expect(root.querySelector('.extension-directory')?.textContent).toContain('安装位置：');
  });
  it('opens market details from the card and restores metadata and release rows', async () => {
    stub(); const { root } = mount(); await flush();
    const filter = root.querySelectorAll('input[type=search]')[1] as HTMLInputElement; filter.value = 'found'; filter.dispatchEvent(new Event('input'));
    const card = marketCards(root).querySelector('article') as HTMLElement; card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush();
    const detail = document.querySelector('.extension-detail')!;
    expect(detail.textContent).toContain('维护者'); expect(detail.textContent).toContain('200.0K');
    expect(detail.querySelectorAll('.extension-history > div')).toHaveLength(2);
    expect(detail.querySelector('details')?.open).toBe(false);
    expect(detail.querySelector('summary')?.textContent).toBe('历史版本');
    expect([...detail.querySelectorAll('a')].map(link => link.textContent)).toContain('源代码仓库');
    expect(card.textContent).toContain('版本：3.1.0'); expect(card.textContent).toContain('作者：someone'); expect(card.textContent).toContain('下载量：42/月');
  });
  it('keeps installed metadata available when registry details fail', async () => {
    stub({ detailStatus: 503, list: { dir: LIST.dir, extensions: [{ ...LIST.extensions[0], metadata: { license: 'MIT', dependencies: ['example-dependency'], links: { repository: 'https://git.example/module' } } }] } });
    const { root } = mount(); await flush(); button(root, '甲扩展').click(); await flush();
    const detail = document.querySelector('.extension-detail')!;
    expect([...detail.querySelectorAll('h4')].map(node => node.textContent)).toEqual(['简介', '信息']);
    expect(detail.textContent).toContain('MIT'); expect(detail.textContent).toContain('example-dependency');
    expect(detail.querySelector('a')?.href).toBe('https://git.example/module');
    expect(detail.querySelector('summary')?.textContent).toBe('历史版本');
  });
});

it('keeps the installed grid height and scroll position when the last page has one card', async () => {
  stub({ list: { dir: LIST.dir, extensions: Array.from({length: 7}, (_, i) => ({ ...LIST.extensions[0], name: `page-${i}` })) } });
  const { root } = mount(); await flush(); const grid = installedCards(root) as HTMLElement;
  vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue({ height: 576 } as DOMRect);
  root.scrollTop = 200; const pager = root.querySelector('.extension-pager');
  button(pager, '下一页 ›').click();
  expect(grid.children).toHaveLength(1); expect(grid.style.minHeight).toBe('576px'); expect(root.scrollTop).toBe(200);
  expect(pager.textContent).toContain('2 / 2');
  button(pager, '‹ 上一页').click(); expect(grid.children).toHaveLength(6); expect(root.scrollTop).toBe(200);
});
