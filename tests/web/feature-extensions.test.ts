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
const { mountExtensions, parseInstallInput, arrangeHits, extensionsFeature, restartOutcome, extensionColumns, avatarInitial } = (await import(EXTENSIONS)) as Any;

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

const LIFE = { deployment: 'this-deployment', bootId: 'boot-1', ready: true };

let calls: Array<{ url: string; method: string; body: Any }> = [];

function stub(over: {
  list?: unknown; updates?: unknown; updateStatus?: number; installStatus?: number; checkStatus?: number;
  hits?: unknown; detail?: Any; detailStatus?: number; restart?: unknown;
} = {}): void {
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
    else if (u === '/api/extensions/check') {
      const payload = JSON.parse(init.body);
      status = over.checkStatus ?? 200;
      body = status === 200 ? { name: payload.target.name ?? 'local-mod', version: payload.target.version ?? '1.0.0', kind: payload.kind } : { error: '扩展实际类型为 provider，请切换到对应分类。' };
    }
    else if (u === '/api/extensions/install') { status = over.installStatus ?? 200; body = status === 200 ? { ok: true, result: '已安装 x。重启进程后加载。\n+ x 1.0.0' } : { error: 'pnpm add 退出码 1' }; }
    else if (u === '/api/extensions/uninstall') body = { ok: true, result: '已卸载 x。' };
    else if (u === '/api/run/lifecycle') body = LIFE;
    else if (u === '/api/run/restart') body = over.restart ?? { ok: true, result: '本地关机完成,进程即将退出', steps: [{ label: '按住事件投递', ok: true, elapsedMs: 2 }] };
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
function mount(caps: Record<string, boolean> = { extensions: true, restart: true, supervised: true }) { const context = mkCtx(caps); lives.push(context.lifecycle); mountExtensions(context.ctx); return context; }
const WIDTH = 1100;
beforeEach(() => { calls = []; window.sessionStorage.clear(); window.history.replaceState(null, '', '#/extensions/world'); Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => WIDTH }); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { lives.splice(0).forEach(life => life.dispose()); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const installedCards = (root: HTMLElement) => root.querySelector('.extension-grid')!;
const marketCards = (root: HTMLElement) => root.querySelectorAll('.extension-grid')[1];
const sheets = (root: HTMLElement) => root.querySelectorAll('.extension-category > .sheet');
const switchTo = async (ctx: Any, kind: string) => { ctx.router.replace(['extensions', kind]); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush(); };
const filterMarket = (root: HTMLElement, value: string) => { const input = root.querySelectorAll('input[type=search]')[1] as HTMLInputElement; input.value = value; input.dispatchEvent(new Event('input')); };

describe('extension categories', () => {
  it('isolates installed categories and preserves each market filter across routes', async () => {
    stub(); const { ctx, root } = mount(); await flush();
    expect(installedCards(root).textContent).toContain('甲扩展'); expect(installedCards(root).textContent).not.toContain('gamma-prov');
    filterMarket(root, 'found'); await flush();
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
  it('caps installed cards at two rows and market at four rows at every column count', async () => {
    const many = { ...LIST, extensions: Array.from({ length: 15 }, (_, i) => ({ ...LIST.extensions[0], name: `item-${String(i).padStart(2, '0')}`, label: `Item ${i}` })) };
    for (const width of [1100, 800, 500]) {
      const perRow = extensionColumns(width);
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width }); stub({ list: many });
      const { root, lifecycle } = mount(); await flush();
      expect(installedCards(root).querySelectorAll('.extension-card')).toHaveLength(perRow * 2);
      expect(marketCards(root).querySelectorAll('.extension-card')).toHaveLength(perRow * 4);
      button(sheets(root)[0], '下一页 ›').click(); expect(installedCards(root).textContent).toContain(`Item ${perRow * 2}`);
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
  it('disables incompatible updates and states the reason on the card', async () => {
    stub({ updates: { updates: [{ name: 'alpha-mod', installedVersion: '1.0.0', latestVersion: '2.0.0', problems: ['扩展要求契约 v9'] }], errors: [] } });
    const { root } = mount(); await flush();
    const alpha = cardOf(root, '甲扩展');
    expect(alpha.textContent).toContain('1.0.0 → 2.0.0'); expect(button(alpha, '更新').disabled).toBe(true);
    expect(alpha.querySelector('.msgline.bad')?.textContent).toContain('扩展要求契约 v9');
  });
  it('the update check failure is reported; a compatible update checks and installs the latest version', async () => {
    stub({ updates: { updates: [{ name: 'alpha-mod', installedVersion: '1.0.0', latestVersion: '1.1.0', problems: [] }], errors: [{ name: 'beta-mod', error: 'registry unavailable' }] } });
    const { root } = mount(); await flush();
    expect(root.textContent).toContain('更新检查失败');
    button(cardOf(root, '甲扩展'), '更新').click(); await flush();
    expect(calls.find(c => c.url === '/api/extensions/check')?.body).toEqual({ target: { name: 'alpha-mod', version: '1.1.0' }, kind: 'world' });
    expect(calls.find(c => c.url === '/api/extensions/install')?.body).toEqual({ name: 'alpha-mod', version: '1.1.0' });
    expect(sheets(root)[0].textContent).toContain('更新成功');
  });
  it('shows failed and pending states; a package without a manifest is listed under World', async () => {
    stub(); const { ctx, root } = mount(); await flush();
    expect(cardOf(root, 'beta-mod').querySelector('.extension-status.bad')?.textContent).toContain('加载失败');
    expect(cardOf(root, 'epsilon-mod').textContent).toContain('加载失败');
    expect(buttons(cardOf(root, 'delta-mod')).map(b => b.textContent)).not.toContain('删除扩展');
    await switchTo(ctx, 'provider');
    expect(cardOf(root, 'gamma-prov').textContent).toContain('待重启');
    expect(button(cardOf(root, 'gamma-prov'), '重启进程')).toBeTruthy();
  });
});

describe('installation feedback', () => {
  async function detail(root: HTMLElement) {
    filterMarket(root, 'found');
    (marketCards(root).querySelector('[aria-label="found-mod"]') as HTMLElement).click(); await flush(); return document.querySelector('.modal')!;
  }
  it('checks the category, installs the exact version and leaves feedback in the market', async () => {
    stub(); const { root } = mount(); await flush(); const box = await detail(root); button(box, '安装').click(); await flush();
    expect(calls.find(c => c.url === '/api/extensions/check')?.body).toEqual({ target: { name: 'found-mod', version: '3.1.0' }, kind: 'world' });
    expect(calls.find(c => c.url === '/api/extensions/install')?.body).toEqual({ name: 'found-mod', version: '3.1.0' });
    expect(sheets(root)[1].textContent).toContain('安装成功');
    expect(sheets(root)[1].textContent).toContain('重启进程后生效');
    expect(sheets(root)[0].textContent).not.toContain('安装成功');
    expect(calls.filter(c => c.url === '/api/extensions').length).toBe(2);
  });
  it('a refused check stops before installing and shows the reason only in the originating section', async () => {
    stub({ checkStatus: 400 }); const { root } = mount(); await flush(); button(await detail(root), '安装').click(); await flush();
    expect(calls.some(c => c.url === '/api/extensions/install')).toBe(false);
    expect(sheets(root)[1].querySelector('.msgline.bad')?.textContent).toContain('请切换到对应分类');
    expect(sheets(root)[0].querySelector('.msgline.bad')).toBeNull();
  });
  it('an install failure reports the server error', async () => {
    stub({ installStatus: 400 }); const { root } = mount(); await flush(); button(await detail(root), '安装').click(); await flush();
    expect(sheets(root)[1].querySelector('.msgline.bad')?.textContent).toContain('pnpm add 退出码 1');
  });
  it('blocks incompatible detail installation and dangerous links', async () => {
    stub({ detail: { problems: ['incompatible'], links: { npm: 'javascript:alert(1)' } } }); const { root } = mount(); await flush(); const box = await detail(root);
    expect(button(box, '安装').disabled).toBe(true); expect(box.querySelector('a')).toBeNull();
  });
  it('a market detail that fails to load shows the error in the drawer and leaves the list intact', async () => {
    stub({ detailStatus: 502 }); const { root } = mount(); await flush(); await detail(root);
    expect(document.querySelector('.modal .msgline.bad')?.textContent).toContain('npm 没有这个包');
    expect(marketCards(root).querySelectorAll('.extension-card').length).toBeGreaterThan(0);
  });
  it('failed package documents are not requested again while filtering', async () => {
    stub({ detailStatus: 502 }); const { root } = mount(); await flush();
    const first = calls.filter(c => c.url.startsWith('/api/extensions/package')).length;
    filterMarket(root, 'alpha'); filterMarket(root, 'filler'); filterMarket(root, ''); await flush();
    expect(calls.filter(c => c.url.startsWith('/api/extensions/package')).length).toBe(first);
  });
  it('an empty category says there are no packages yet', async () => {
    stub({ hits: { hits: [] } }); const { root } = mount(); await flush();
    expect(marketCards(root).textContent).toContain('npm 上还没有这一类的包');
  });
  it('manual npm input rejects paths and URLs; local source checks and installs the directory', async () => {
    stub(); const { root } = mount(); await flush();
    const input = root.querySelector('input[aria-label="包名与版本"]') as HTMLInputElement; input.value = 'https://example.com'; input.dispatchEvent(new Event('input')); button(root, '安装').click(); await flush();
    expect(calls.some(c => c.url === '/api/extensions/check' || c.url === '/api/extensions/install')).toBe(false);
    button(root, '从本机目录安装').click(); await flush();
    const path = root.querySelector('input[aria-label="扩展项目目录"]') as HTMLInputElement; expect(root.textContent).toContain('运行 Cortico 的电脑');
    path.value = 'C:/work/my-world'; path.dispatchEvent(new Event('input')); button(root, '安装').click(); await flush();
    expect(calls.find(c => c.url === '/api/extensions/check')?.body).toEqual({ target: { path: 'C:/work/my-world' }, kind: 'world' });
    expect(calls.find(c => c.url === '/api/extensions/install')?.body).toEqual({ path: 'C:/work/my-world' });
  });
  it('deleting asks first, then uninstalls by name and reloads the list', async () => {
    stub(); const { root } = mount(); await flush();
    button(cardOf(root, 'beta-mod'), '删除扩展').click(); await flush();
    expect(calls.some(c => c.url === '/api/extensions/uninstall')).toBe(false);
    answer(true); await flush();
    expect(calls.find(c => c.url === '/api/extensions/uninstall')?.body).toEqual({ name: 'beta-mod' });
    expect(calls.filter(c => c.url === '/api/extensions').length).toBe(2);
    expect(sheets(root)[0].textContent).toContain('删除成功');
  });
});

describe('package avatars', () => {
  it('a declared icon is shown; without one, or when it fails to load, the Coo mark carries the initial', async () => {
    stub({ list: { dir: LIST.dir, extensions: [
      { ...LIST.extensions[0], name: 'pictured-world', label: 'Pictured', icon: true, installedVersion: '1.2.0' },
      { ...LIST.extensions[0], name: 'cortico-world-plain', label: undefined },
    ] } });
    const { root } = mount(); await flush();
    const pictured = cardOf(root, 'Pictured');
    const image = pictured.querySelector('.extension-avatar img') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('/api/extensions/icon?name=pictured-world&v=1.2.0');
    expect((pictured.querySelector('.extension-avatar-default') as HTMLElement).hidden).toBe(true);
    image.dispatchEvent(new Event('error'));
    expect(pictured.querySelector('.extension-avatar img')).toBeNull();
    expect((pictured.querySelector('.extension-avatar-default') as HTMLElement).hidden).toBe(false);
    const plain = cardOf(root, 'cortico-world-plain');
    expect(plain.querySelector('.extension-avatar img')).toBeNull();
    expect(plain.querySelector('.coomark')).not.toBeNull();
    expect(plain.querySelector('.extension-avatar-initial')?.textContent).toBe('P');
  });
  it('market cards of packages not installed show the default avatar', async () => {
    stub(); const { root } = mount(); await flush();
    filterMarket(root, 'found');
    const card = marketCards(root).querySelector('.extension-card')!;
    expect(card.querySelector('.coomark')).not.toBeNull();
    expect(card.querySelector('.extension-avatar-initial')?.textContent).toBe('F');
  });
  it('the initial drops the scope and the cortico kind prefix', () => {
    expect(avatarInitial('@acme/cortico-provider-zeta')).toBe('Z');
    expect(avatarInitial('cortico-bot-example')).toBe('E');
    expect(avatarInitial('终端')).toBe('终');
    expect(avatarInitial('')).toBe('?');
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

describe('restart', () => {
  it('waits for a new ready process of the same deployment', () => {
    const before = { deployment: 'same', bootId: 'old', ready: true };
    expect(restartOutcome(before, before)).toBe('waiting');
    expect(restartOutcome(before, { ...before, bootId: 'new', ready: false })).toBe('waiting');
    expect(restartOutcome(before, { ...before, bootId: 'new' })).toBe('ready');
    expect(restartOutcome(before, { ...before, deployment: 'other', bootId: 'new' })).toBe('wrong-deployment');
  });
  it('confirms, reads the process identity, requests the restart and shows incomplete shutdown steps', async () => {
    stub({ restart: { ok: true, result: '本地关机完成', steps: [{ label: '按住事件投递', ok: true, elapsedMs: 2 }, { label: '外部直播平台', ok: false, elapsedMs: 5000, detail: '需手动结束' }] } });
    const { root } = mount(); await flush();
    button(sheets(root)[0], '重启进程').click(); await flush();
    expect(calls.some(c => c.url === '/api/run/restart')).toBe(false);
    answer(true); await flush();
    expect(calls.find(c => c.url === '/api/run/restart')?.method).toBe('POST');
    expect(calls.some(c => c.url === '/api/run/lifecycle')).toBe(true);
    expect(document.body.textContent).toContain('✗ 外部直播平台 · 需手动结束');
    expect(sheets(root)[0].textContent).toContain('等待当前 Bot 的新进程就绪');
  });
  it('an unsupervised process asks for a manual start', async () => {
    stub(); const { root } = mount({ extensions: true, restart: true, supervised: false }); await flush();
    button(sheets(root)[0], '重启进程').click(); await flush();
    expect(document.querySelector('.modal')?.textContent).toContain('需要手动启动');
    answer(false); await flush();
    expect(calls.some(c => c.url === '/api/run/restart')).toBe(false);
  });
  it('without the restart capability there is no restart button and pending cards offer details', async () => {
    stub(); const { ctx, root } = mount({ extensions: true }); await flush(); await switchTo(ctx, 'provider');
    expect(buttons(root).map(b => b.textContent)).not.toContain('重启进程');
    expect(button(cardOf(root, 'gamma-prov'), '详情')).toBeTruthy();
  });
  it('a remount shows the category help, not the result of an earlier operation', async () => {
    stub(); const first = mount(); await flush();
    button(cardOf(first.root, 'beta-mod'), '删除扩展').click(); await flush(); answer(true); await flush();
    expect(sheets(first.root)[0].textContent).toContain('删除成功');
    first.lifecycle.dispose(); first.root.remove();
    const second = mount(); await flush();
    expect(sheets(second.root)[0].textContent).not.toContain('删除成功');
    expect(sheets(second.root)[0].textContent).toContain('在 World 页启用或停用 World');
  });
});

describe('extension review interactions', () => {
  it('an enabled World awaiting restart offers the restart; built-ins and enabled Worlds cannot be deleted', async () => {
    stub({ list: { dir: LIST.dir, extensions: [
      { ...LIST.extensions[0], enabled: true, installedVersion: '2.0.0', state: 'pending-restart' },
      { ...LIST.extensions[0], name: 'builtin:world:example', builtin: true, label: 'Built-in example' },
      { ...LIST.extensions[0], name: 'running-world', label: 'Running', enabled: true },
    ] } });
    const { root } = mount(); await flush(); const cards = installedCards(root).querySelectorAll('.extension-card');
    expect(cards[0].querySelector('.extension-card-heading')?.textContent).toContain('已加载');
    expect(button(cards[0], '重启进程')).toBeTruthy();
    expect(button(cards[1], '删除扩展').disabled).toBe(true);
    const running = cardOf(root, 'Running');
    expect(button(running, '管理 World')).toBeTruthy();
    expect(button(running, '删除扩展').disabled).toBe(true);
    expect(button(running, '删除扩展').title).toContain('停用后才能删除');
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
    filterMarket(root, 'found');
    const card = marketCards(root).querySelector('article') as HTMLElement; card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush();
    const detail = document.querySelector('.extension-detail')!;
    expect(detail.textContent).toContain('维护者'); expect(detail.textContent).toContain('200.0K');
    expect(detail.querySelectorAll('.extension-history > div')).toHaveLength(2);
    expect(detail.querySelector('details')?.open).toBe(false);
    expect(detail.querySelector('summary')?.textContent).toBe('最近版本');
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
  });
});

it('keeps the installed grid height and scroll position when the last page has one card', async () => {
  stub({ list: { dir: LIST.dir, extensions: Array.from({length: 7}, (_, i) => ({ ...LIST.extensions[0], name: `page-${i}` })) } });
  const { root } = mount(); await flush(); const grid = installedCards(root) as HTMLElement;
  const measured = 576;
  vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue({ height: measured } as DOMRect);
  root.scrollTop = 200; const pager = root.querySelector('.extension-pager')!;
  button(pager, '下一页 ›').click();
  expect(grid.children).toHaveLength(1); expect(grid.style.minHeight).toBe(`${measured}px`); expect(root.scrollTop).toBe(200);
  expect(pager.textContent).toContain('2 / 2');
  button(pager, '‹ 上一页').click(); expect(grid.children).toHaveLength(extensionColumns(WIDTH) * 2); expect(root.scrollTop).toBe(200);
});

describe('feature contract', () => {
  it('route is extensions, needsAny is extensions, grouped under Core', () => {
    expect(extensionsFeature.route).toBe('extensions');
    expect(extensionsFeature.needsAny).toEqual(['extensions']);
    expect(extensionsFeature.navGroup).toBe('Core');
  });
  it('sends no requests after dispose', async () => {
    stub(); const { root, lifecycle } = mount(); await flush();
    lifecycle.dispose();
    const before = calls.length;
    button(root, '↻ 刷新').click(); await flush();
    expect(calls.length).toBe(before);
  });
});
