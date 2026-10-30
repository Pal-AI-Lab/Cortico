// @vitest-environment jsdom
/**
 * The World and provider pages against a faked WebUI API. Its strings are picked when the
 * modules load, so the window language is set to zh before they are imported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Any = any;
/** 查询结果按 Any 用:测试里节点必在,缺了就让断言或调用直接失败。 */
const $ = (sel: string, from: ParentNode = document): Any => from.querySelector(sel);
const $$ = (sel: string, from: ParentNode = document): Any[] => [...from.querySelectorAll(sel)];

localStorage.setItem('cortico.webui.language', 'zh');
const { createWebUi } = (await import('../../src/web/client/ui/index.ts')) as Any;
const { Lifecycle } = (await import('../../src/web/client/core/lifecycle.ts')) as Any;
const { Router } = (await import('../../src/web/client/core/router.ts')) as Any;
const { mountExtensionContent, parseInstallInput, arrangeHits, restartOutcome, osAllowed } = (await import('../../src/web/client/features/extensions/index.ts')) as Any;
const { mountWorlds } = (await import('../../src/web/client/features/worlds/index.ts')) as Any;
const { worldLibrary } = (await import('../../src/web/client/features/worlds/library.ts')) as Any;
const { mountProviders } = (await import('../../src/web/client/features/providers/index.ts')) as Any;
const { S: extensionStrings } = (await import('../../src/web/client/features/extensions/strings.ts')) as Any;
const { S: providerStrings } = (await import('../../src/web/client/features/providers/strings.ts')) as Any;
const flush = async (n: Any = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const LIST = {
  dir: 'C:/repo/extensions',
  extensions: [
    { name: 'alpha-mod', spec: '^1.0.0', version: '1.0.0', kind: 'world', api: 3, webUiClient: true, webUi: 'served', loaded: true, worldId: 'alpha', label: '甲扩展', state: 'loaded' },
    { name: 'beta-mod', spec: '^1.0.0', version: '1.0.0', kind: 'world', api: 3, webUiClient: true, webUi: 'missing', loaded: false, reason: '默认导出不是 WorldDefinition', state: 'failed' },
    { name: 'gamma-prov', spec: '^2.0.0', version: '2.0.0', kind: 'provider', api: 3, webUiClient: false, webUi: 'none', loaded: false, state: 'pending-restart', description: '丙' },
    { name: 'delta-mod', spec: '^1.0.0', version: '1.0.0', kind: 'world', api: 3, webUiClient: false, webUi: 'none', loaded: true, worldId: 'delta', state: 'removed' },
    { name: 'epsilon-mod', spec: '^1.0.0', version: '1.0.0', webUiClient: false, loaded: false, reason: 'package.json 缺少 cortico 块(至少要 kind 与 api)。', state: 'failed' },
  ],
};
const HITS = {
  hits: [
    { name: 'found-mod', version: '3.1.0', description: '搜到的', downloads: { total: 130, month: 42, week: 9 }, dependents: 2, publisher: 'someone', license: 'MIT', date: '2026-09-18T00:00:00.000Z', keywords: ['cortico-world', 'chat'], links: { npm: 'https://npm.example/found', repository: 'https://git.example/found' }, installed: false, kind: 'world' },
    { name: 'alpha-mod', version: '1.0.0', description: '已经装了', downloads: { month: 7 }, dependents: 0, date: '2026-01-02T00:00:00.000Z', links: {}, installed: true, kind: 'world' },
    ...Array.from({ length: 11 }, (_: Any, i: Any) => ({
      name: `filler-${i}`, version: '0.1.0', description: '凑数的', downloads: { month: 100 + i }, dependents: 0,
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
  manifest: { kind: 'world', api: 4, webUiClient: 'dist/webui.js' },
  warnings: [],
  frameworkApi: 4,
  engines: '>=22',
  unpackedSize: 204800,
  fileCount: 12,
  dependencies: ['ws'],
  maintainers: ['someone'],
  author: 'someone',
  publisher: 'someone',
  links: { npm: 'https://npm.example/found', repository: 'https://git.example/found', bugs: 'https://git.example/found/issues' },
  installed: false,
};
const LIFE = { deployment: 'this-deployment', bootId: 'boot-1', ready: true };
let calls: Any[] = [];
function stub(over: Any = {}) {
  vi.stubGlobal('fetch', (url: Any, init: Any) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET');
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let status = 200;
    let body: Any = {};
    if (u === '/api/worlds') body = { worlds: over.worlds ?? [{ id: 'alpha', label: '甲扩展', status: 'active', visible: true }, { id: 'builtin', label: 'Builtin', status: 'inactive' }] };
    else if (u === '/api/worlds/visibility') body = { driftedWorlds: over.driftedWorlds ?? [] };
    else if (u === '/api/providers') body = { scope: 'test-provider-tabs', active: over.active ?? '', providers: over.providers ?? [] };
    else if (u.startsWith('/api/providers/') && u.endsWith('/delete')) { over.onDelete?.(u); body = { ok: true }; }
    else if (u.startsWith('/api/providers/')) { const name = decodeURIComponent(u.slice('/api/providers/'.length)); body = { name, revision: 'r1', references: over.references?.[name] ?? [], entry: { kind: 'openai', baseUrl: 'https://example.invalid', spec: { model: 'm' } }, secret: null }; }
    else if (u === '/api/provider-modules') body = [];
    else if (u === '/api/extensions') { status = over.listStatus ?? 200; body = status === 200 ? over.list ?? LIST : { error: 'Unavailable' }; }
    else if (u === '/api/extensions/updates') {
      status = over.updateStatus ?? 200;
      body = status === 200 ? over.updates ?? { updates: [], errors: [] } : { error: 'npm unavailable' };
    }
    else if (u.startsWith('/api/extensions/package')) {
      status = over.detailStatus ?? 200;
      body = status === 200 ? { ...DETAIL, ...(over.detail ?? {}) } : { error: 'npm 没有这个包' };
    }
    else if (u.startsWith('/api/extensions/search'))
      body = over.hits ?? (u.includes('kind=provider') ? { hits: [] } : HITS);
    else if (u === '/api/extensions/check') {
      const payload = JSON.parse(init.body);
      status = over.checkStatus ?? 200;
      body = status === 200 ? { name: payload.target.name ?? 'local-mod', version: payload.target.version ?? '1.0.0', kind: payload.kind } : { error: '扩展实际类型为 provider，请切换到对应分类。' };
    }
    else if (u === '/api/extensions/install') {
      status = over.installStatus ?? 200;
      if (status === 200)
        over.onInstall?.(JSON.parse(init.body));
      body = status === 200 ? { ok: true, result: '已安装 x。重启进程后加载。\n+ x 1.0.0' } : { error: 'pnpm add 退出码 1' };
    }
    else if (u === '/api/extensions/uninstall') {
      over.onUninstall?.(JSON.parse(init.body));
      body = { ok: true, result: '已卸载 x。' };
    }
    else if (u === '/api/run/lifecycle')
      body = LIFE;
    else if (u === '/api/run/restart')
      body = over.restart ?? { ok: true, result: '本地关机完成,进程即将退出', steps: [{ label: '按住事件投递', ok: true, elapsedMs: 2 }] };
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  });
}
function mkCtx(caps: Any = { extensions: true, restart: true, supervised: true }, root: Any = document.createElement('div')) {
  document.body.appendChild(root);
  const lifecycle = new Lifecycle(() => { });
  const ui = createWebUi({
    memo: { get: () => null, set: () => { } },
    overlayHost: document.body,
    signal: lifecycle.signal,
    doc: document,
  });
  const router = new Router({ win: window, confirmLeave: async () => true, onError: () => { } });
  lifecycle.own(router.start());
  return {
    ctx: {
      ui, root, lifecycle, signal: lifecycle.signal,
      capabilities: caps,
      route: router.route,
      router,
      onError: () => { },
    },
    root,
    lifecycle,
  };
}
const buttons = (el: Any) => $$('button', el);
const button = (el: Any, text: Any) => {
  const hit = buttons(el).find((b: Any) => b.textContent?.trim() === text);
  if (!hit)
    throw new Error(`没有「${text}」这颗键`);
  return hit;
};
/** 答一次模态确认:danger 模式的确认键写的是「仍要继续」,普通模式是「确认」。 */
function answer(yes: Any) {
  // 抽屉也是一层 .modal:确认框是后铺上去的那一层
  const layers = $$('.modal');
  const modal = layers[layers.length - 1];
  if (!modal)
    throw new Error('没有弹出确认框');
  const want = yes ? ['仍要继续', '确认'] : ['取消'];
  const btn = buttons(modal).find((b: Any) => want.includes(b.textContent?.trim() ?? ''));
  if (!btn)
    throw new Error('确认框上找不到按钮');
  btn.click();
}
const cardOf = (root: Any, title: Any) => {
  const hit = $$('.extension-card', root).find((c: Any) => $('.extension-card-title', c)?.textContent?.startsWith(title));
  if (!hit)
    throw new Error(`没有「${title}」的卡`);
  return hit;
};
const lives: Any[] = [];
function mount(caps: Any = { extensions: true, restart: true, supervised: true }) { window.history.replaceState(null, '', '#/world?view=market'); const context = mkCtx({ worlds: true, ...caps }); lives.push(context.lifecycle); mountWorlds(context.ctx); return context; }
const WIDTH = 1100;
beforeEach(() => { calls = []; window.sessionStorage.clear(); window.history.replaceState(null, '', '#/extensions/world'); Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => WIDTH }); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { lives.splice(0).forEach((life: Any) => life.dispose()); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const marketCards = (root: Any) => $('.world-catalog-scroll > .extension-grid', root);
const installedInfo = (root: Any, name: Any) => $$('.world-blade', root).find((row: Any) => $('.world-name', row)?.textContent === name).querySelector('.world-name-info');
const switchTo = async (ctx: Any, kind: Any) => {
  ctx.lifecycle.dispose();
  ctx.root.replaceChildren();
  const next = mkCtx(ctx.capabilities, ctx.root);
  Object.assign(ctx, next.ctx);
  lives.push(next.lifecycle);
  mountExtensionContent(ctx, kind);
  await flush();
};
const filterMarket = (root: Any, value: Any) => { const input = $('.world-catalog input[type=search]', root); input.value = value; input.dispatchEvent(new Event('input')); };
describe('package authors', () => {
  const detailAuthor = () => $$('.extension-detail .kvtable tr')
    .find((row: Any) => row.children[0].textContent === '作者')?.children[1].textContent;
  it.each([
    { author: 'Local author', registryAuthor: 'Registry author', expected: 'Local author' },
    { author: undefined, registryAuthor: undefined, expected: '未提供' },
  ])('keeps the installed author after searching and loading registry details ($expected)', async ({ author, registryAuthor, expected }) => {
    const publisher = 'Automated publisher';
    stub({
      list: { dir: LIST.dir, extensions: [{ ...LIST.extensions[0], author }] },
      hits: { hits: [{ ...HITS.hits[1], publisher }] },
      detail: { author: registryAuthor, publisher },
    });
    const { root } = mount();
    await flush();
    installedInfo(root, '甲扩展').click();
    await flush();
    expect(detailAuthor()).toBe(expected);
  });
  it.each([
    { author: 'Example author', expected: 'Example author' },
    { author: undefined, expected: '未提供' },
  ])('uses package author on the market card and detail, or marks it missing ($expected)', async ({ author, expected }) => {
    const publisher = 'Automated publisher';
    stub({ hits: { hits: [{ ...HITS.hits[0], publisher }] }, detail: { author, publisher } });
    const { root } = mount();
    await flush();
    const card = $('.extension-card', marketCards(root));
    const byline = $('.extension-card-byline', card);
    // 没填 author 时署名写 npm@账号,没有悬停
    expect(byline.textContent).toContain(author ?? `npm@${publisher}`);
    expect(byline.getAttribute('aria-description')).toBe(author ? `npm: @${publisher}` : null);
    card.click();
    await flush();
    expect(detailAuthor()).toBe(expected);
  });
});
describe('installation feedback', () => {
  it('starts another page at the top of the list, holding no height from the last', async () => {
    stub();
    const { root } = mount(); await flush();
    const size = $('.extension-size select', root);
    size.value = '10'; size.dispatchEvent(new Event('change', { bubbles: true }));
    const grid = marketCards(root);
    const scroller = $('.world-catalog-scroll', root);
    scroller.scrollTop = 900;
    button($('.extension-pager', root), extensionStrings.nextPage).click();
    expect(scroller.scrollTop).toBe(0);
    expect(grid.style.minHeight).toBe('');
  });
  async function detail(root: Any) {
    filterMarket(root, 'found');
    $('[aria-label="found-mod"]', marketCards(root)).click();
    await flush();
    return $('.modal');
  }
  /** The detail page's install control, the market card's own. */
  const detailControl = (box: Any) => $('.extension-detail-control .extension-get', box);
  it('installs the exact version from the detail page with the market card\'s control', async () => {
    const list: Any = { ...LIST, extensions: [...LIST.extensions] };
    stub({ list, onInstall: (target: Any) => list.extensions.push({ name: target.name, version: target.version, kind: 'world', state: 'pending-restart' }) });
    const { root } = mount();
    await flush();
    const box = await detail(root);
    expect(detailControl(box).getAttribute('aria-label')).toBe(extensionStrings.addToLibrary);
    detailControl(box).click();
    await flush();
    expect(calls.find((c: Any) => c.url === '/api/extensions/check')?.body).toEqual({ target: { name: 'found-mod', version: '3.1.0' }, kind: 'world' });
    expect(calls.find((c: Any) => c.url === '/api/extensions/install')?.body).toEqual({ name: 'found-mod', version: '3.1.0' });
    expect(calls.filter((c: Any) => c.url === '/api/extensions').length).toBe(2);
    // Like the card: no status line, the control itself reads installed afterwards.
    expect($('.world-workspace-status', root).textContent).not.toContain('安装成功');
    await vi.waitFor(() => expect(detailControl(box).getAttribute('aria-label')).toBe('已安装'));
  });
  it('a refused check stops before installing and shows the reason only in the originating section', async () => {
    stub({ checkStatus: 400 });
    const { root } = mount();
    await flush();
    detailControl(await detail(root)).click();
    await flush();
    expect(calls.some((c: Any) => c.url === '/api/extensions/install')).toBe(false);
    expect($('.extension-problem:not(.hidden)')?.textContent).toContain('请切换到对应分类');
    expect($('.world-workspace-status .msgline.bad', root)).toBeNull();
  });
  it('shows the install progress ring in the detail page while the install runs', async () => {
    stub(); let finish: Any;
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: Any, init: Any) => String(url) === '/api/extensions/check' ? new Promise((resolve: Any) => { finish = () => resolve(fetch(url, init)); }) : fetch(url, init));
    const { root } = mount(); await flush();
    const box = await detail(root);
    detailControl(box).click(); await flush();
    expect(detailControl(box).classList.contains('is-working')).toBe(true);
    expect($('.extension-get-ring', detailControl(box))).not.toBeNull();
    finish();
    await vi.waitFor(() => expect(detailControl(box).classList.contains('is-working')).toBe(false));
  });
  it('an install failure from the detail page opens beside its control', async () => {
    stub({ installStatus: 400 });
    const { root } = mount();
    await flush();
    detailControl(await detail(root)).click();
    await flush();
    expect($('.extension-problem:not(.hidden)')?.textContent).toContain('pnpm add 退出码 1');
  });
  it('offers an available update in the detail page and beside the name in My World', async () => {
    const update = (name: Any, from: Any, to: Any) => ({ name, installedVersion: from, latestVersion: to, problems: [] });
    const list: Any = { ...LIST, extensions: [...LIST.extensions, { name: 'found-mod', spec: '^3.0.0', version: '3.0.0', installedVersion: '3.0.0', kind: 'world', api: 3, state: 'loaded' }] };
    stub({ list, updates: { updates: [update('found-mod', '3.0.0', '3.1.0'), update('alpha-mod', '1.0.0', '1.2.0')], errors: [] } });
    const { root, ctx } = mount();
    await flush();
    const box = await detail(root);
    expect(detailControl(box).classList.contains('is-update')).toBe(true);
    expect(detailControl(box).getAttribute('aria-label')).toContain('3.0.0 → 3.1.0');
    $('.modalhead .btn', box)?.click();
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    const row = $$('.world-blade', root).find((item: Any) => item.dataset.key === 'alpha-mod');
    const badge = $('.world-name-info + .world-name-update', row);
    expect(badge.getAttribute('aria-label')).toContain('1.0.0 → 1.2.0');
    badge.click(); await flush();
    expect($('.modal .modaltitle')?.textContent).toBeTruthy();
  });
  it('blocks incompatible detail installation and dangerous links', async () => {
    stub({ detail: { problems: ['incompatible'], links: { npm: 'javascript:alert(1)' } } });
    const { root } = mount();
    await flush();
    const box = await detail(root);
    expect(detailControl(box).disabled).toBe(true);
    expect($('a', box)).toBeNull();
  });
  it('a market detail that fails to load shows the error in the drawer and leaves the list intact', async () => {
    stub({ detailStatus: 502 });
    const { root } = mount();
    await flush();
    await detail(root);
    expect($('.modal .msgline.bad')?.textContent).toContain('npm 没有这个包');
    expect($$('.extension-card', marketCards(root)).length).toBeGreaterThan(0);
  });
  it('failed package documents are not requested again while filtering', async () => {
    stub({ detailStatus: 502 });
    const { root } = mount();
    await flush();
    const first = calls.filter((c: Any) => c.url.startsWith('/api/extensions/package')).length;
    filterMarket(root, 'alpha');
    filterMarket(root, 'filler');
    filterMarket(root, '');
    await flush();
    expect(calls.filter((c: Any) => c.url.startsWith('/api/extensions/package')).length).toBe(first);
  });
  it('ignores an old manual check after the source or input changes', async () => {
    stub(); const fetch = globalThis.fetch; let finish: Any;
    vi.stubGlobal('fetch', (url: Any, init: Any) => String(url) === '/api/extensions/check' ? new Promise((resolve: Any) => { finish = resolve; }) : fetch(url, init));
    const { root } = mount(); await flush();
    const input = $('.world-manual input', root); input.value = 'example-world'; input.dispatchEvent(new Event('input'));
    button(root, '检查有效性').click(); await flush();
    button(root, '从本机目录安装').click();
    finish(new Response(JSON.stringify({ name: 'example-world', version: '1.0.0', kind: 'world' }), { status: 200 })); await flush();
    expect($('.extension-manual-actions .msgline', root).textContent).toBe('');
    expect(button(root, '检查有效性').disabled).toBe(false);
    expect(input.getAttribute('aria-label')).toBe('扩展项目目录');
  });
  it('keeps keyboard focus on the catalog card throughout installation', async () => {
    const list: Any = { ...LIST, extensions: [...LIST.extensions] }; let finish: Any;
    stub({ list, hits: { hits: [HITS.hits[0]] }, onInstall: (target: Any) => list.extensions.push({ name: target.name, version: target.version, kind: 'world', state: 'pending-restart' }) });
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: Any, init: Any) => String(url) === '/api/extensions/check' ? new Promise((resolve: Any) => { finish = () => resolve(fetch(url, init)); }) : fetch(url, init));
    const { root } = mount(); await flush();
    const control = $('.extension-get', root); control.focus(); control.click(); await flush();
    expect((document.activeElement as Any).classList.contains('extension-market-card')).toBe(true);
    // The install settles through a chain of requests whose length in microtask turns differs between
    // Node versions, so wait for the outcome instead of counting turns.
    finish();
    await vi.waitFor(() => expect($('.extension-get', root).getAttribute('aria-label')).toBe('已安装'));
    expect((document.activeElement as Any).dataset.name).toBe('found-mod');
  });
  it('an empty category says there are no packages yet', async () => {
    stub({ hits: { hits: [] } });
    const { root } = mount();
    await flush();
    expect(marketCards(root).textContent).toContain('npm 上还没有这一类的包');
  });
  it('manual npm input rejects paths and URLs; local source checks and installs the directory', async () => {
    stub();
    const { root } = mount();
    await flush();
    const input = $('input[aria-label="包名与版本"]', root);
    input.value = 'https://example.com';
    input.dispatchEvent(new Event('input'));
    button(root, '安装').click();
    await flush();
    expect(calls.some((c: Any) => c.url === '/api/extensions/check' || c.url === '/api/extensions/install')).toBe(false);
    button(root, '从本机目录安装').click();
    await flush();
    const path = $('input[aria-label="扩展项目目录"]', root);
    expect(root.textContent).toContain('运行 Cortico 的电脑');
    path.value = 'C:/work/my-world';
    path.dispatchEvent(new Event('input'));
    button(root, '安装').click();
    await flush();
    expect(calls.find((c: Any) => c.url === '/api/extensions/check')?.body).toEqual({ target: { path: 'C:/work/my-world' }, kind: 'world' });
    expect(calls.find((c: Any) => c.url === '/api/extensions/install')?.body).toEqual({ path: 'C:/work/my-world' });
  });

});
describe('package avatars', () => {
  it('a declared icon is shown; without one, or when it fails to load, the Cortico mark is shown', async () => {
    stub({ hits: { hits: [{ ...HITS.hits[0], name: 'pictured-world', displayName: 'Pictured', icon: '/api/extensions/icon?name=pictured-world&v=1.2.0' }, { ...HITS.hits[0], name: 'cortico-world-plain' }] } });
    const { root } = mount();
    await flush();
    const pictured = cardOf(root, 'Pictured');
    const image = $('.extension-avatar img', pictured);
    expect(image.getAttribute('src')).toBe('/api/extensions/icon?name=pictured-world&v=1.2.0');
    expect($('.extension-avatar-default', pictured).hidden).toBe(true);
    image.dispatchEvent(new Event('error'));
    expect($('.extension-avatar img', pictured)).toBeNull();
    expect($('.extension-avatar-default', pictured).hidden).toBe(false);
    const plain = cardOf(root, 'cortico-world-plain');
    expect($('.extension-avatar img', plain)).toBeNull();
    expect($('.brandmark', plain)).not.toBeNull();
    expect($('.extension-avatar-default', plain)?.textContent).toBe('');
  });
  it('market cards of packages not installed show the default avatar', async () => {
    stub();
    const { root } = mount();
    await flush();
    filterMarket(root, 'found');
    const card = $('.extension-card', marketCards(root));
    expect($('.brandmark', card)).not.toBeNull();
    expect($('.extension-avatar-default', card)?.textContent).toBe('');
  });
});
describe('npm input', () => {
  it('accepts names, scoped names and exact versions or tags only', () => {
    expect(parseInstallInput('@scope/example@1.2.3')).toEqual({ name: '@scope/example', version: '1.2.3' });
    expect(parseInstallInput('@scope/example@next')).toEqual({ name: '@scope/example', version: 'next' });
    for (const value of ['', './path', 'C:\\path', 'https://example.com', 'name; cmd', 'name@^1.0'])
      expect(parseInstallInput(value)).toBeNull();
  });
});
describe('npm os field', () => {
  it('follows npm: a negation excludes, a positive list restricts, nothing means everywhere', () => {
    expect(osAllowed(undefined, 'darwin')).toBe(true);
    expect(osAllowed(['win32'], 'win32')).toBe(true);
    expect(osAllowed(['win32'], 'darwin')).toBe(false);
    expect(osAllowed(['!win32'], 'linux')).toBe(true);
    expect(osAllowed(['!win32'], 'win32')).toBe(false);
    expect(osAllowed(['linux', '!linux'], 'linux')).toBe(false);
  });
});
describe('arrangeHits', () => {
  const hit = (over: Any) => ({ name: 'x', version: '1.0.0', description: '', downloads: { month: 0 }, dependents: 0, links: {}, installed: false, ...over });
  const opts = (over: Any) => ({ filter: '', hideInstalled: false, sort: 'downloads', page: 0, pageSize: 2, ...over });
  it('月下载量未知的排在 0 之后,设了最低下载量时不列出', () => {
    const hits = [
      hit({ name: 'a-unknown', downloads: {} }),
      hit({ name: 'z-zero', downloads: { month: 0 } }),
      hit({ name: 'b-unknown', downloads: {} }),
      hit({ name: 'positive', downloads: { month: 5 } }),
    ];
    const sorted = arrangeHits(hits, opts({ pageSize: 10 })).shown.map((h: Any) => h.name);
    expect(sorted).toEqual(['positive', 'z-zero', 'a-unknown', 'b-unknown']);
    expect(arrangeHits(hits, opts({ minDownloads: 1 })).shown.map((h: Any) => h.name)).toEqual(['positive']);
  });
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
      hit({ name: 'b', downloads: { month: 5 }, dependents: 1, date: '2026-01-01T00:00:00.000Z' }),
      hit({ name: 'a', downloads: { month: 5 }, dependents: 9, date: '2026-05-05T00:00:00.000Z' }),
      hit({ name: 'c', downloads: { month: 90 }, dependents: 0 }),
    ];
    const names = (sort: Any) => arrangeHits(hits, opts({ sort, pageSize: 10 })).shown.map((h: Any) => h.name);
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
describe('market search', () => {
  const SEARCH_HITS = {
    hits: [
      { name: 'other-mod', version: '1.0.0', description: 'Works with qq too', downloads: { month: 900 }, dependents: 0, links: {}, installed: false, kind: 'world' },
      { name: 'cortico-world-qq', displayName: 'QQ 群聊', version: '1.0.0', description: 'OneBot 适配器', downloads: { month: 5 }, dependents: 0, links: {}, installed: false, kind: 'world', tags: ['voice'] },
    ],
    index: { tags: { voice: { label: '语音' } } },
  };
  const names = (root: Any) => $$('.extension-market-card', marketCards(root)).map((card: Any) => card.dataset.name);
  it('matches every word anywhere, tag names included, and ranks name hits first', async () => {
    stub({ hits: SEARCH_HITS });
    const { root } = mount(); await flush();
    filterMarket(root, '语音 QQ');
    expect(names(root)).toEqual(['cortico-world-qq']);
    expect($('.extension-card-title mark', marketCards(root)).textContent).toBe('QQ');
    filterMarket(root, 'qq');
    expect(names(root)).toEqual(['cortico-world-qq', 'other-mod']);
    filterMarket(root, 'cortico world');
    expect(names(root)).toEqual(['cortico-world-qq']);
  });
  it('offers to clear the other filters when only they hide the query\'s matches', async () => {
    stub({ hits: SEARCH_HITS });
    const { root } = mount(); await flush();
    button($('.world-catalog-filters', root), extensionStrings.alreadyInstalled).click();
    filterMarket(root, 'qq');
    expect(names(root)).toEqual([]);
    const empty = $('.extension-hits-elsewhere', marketCards(root));
    expect(empty.textContent).toContain(extensionStrings.hitsElsewhere(2));
    button(empty, extensionStrings.clearOtherFilters).click();
    expect(names(root)).toEqual(['cortico-world-qq', 'other-mod']);
    expect($('.world-catalog input[type=search]', root).value).toBe('qq');
  });
  it('finds a package by the name its installed World shows', async () => {
    stub();
    const { root } = mount(); await flush();
    filterMarket(root, '甲扩展');
    expect(names(root)).toEqual(['alpha-mod']);
  });
  it('waits for the input method to finish a word before filtering', async () => {
    stub({ hits: SEARCH_HITS });
    const { root } = mount(); await flush();
    const input = $('.world-catalog input[type=search]', root);
    input.value = 'yuyin'; input.dispatchEvent(new InputEvent('input', { isComposing: true }));
    expect(names(root)).toHaveLength(2);
    input.value = '语音'; input.dispatchEvent(new CompositionEvent('compositionend'));
    expect(names(root)).toEqual(['cortico-world-qq']);
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
    const { root } = mount();
    await flush();
    button($('.world-restart-footer', root), '重启进程').click();
    await flush();
    expect(calls.some((c: Any) => c.url === '/api/run/restart')).toBe(false);
    answer(true);
    await flush();
    expect(calls.find((c: Any) => c.url === '/api/run/restart')?.method).toBe('POST');
    expect(calls.some((c: Any) => c.url === '/api/run/lifecycle')).toBe(true);
    expect(document.body.textContent).toContain('✗ 外部直播平台 · 需手动结束');
    expect($('.extension-restart', root).disabled).toBe(true);
  });
  it('allows retrying a rejected restart and removes its recovery marker', async () => {
    stub({ restart: { error: 'shutdown rejected' } });
    const { root } = mount(); await flush();
    button($('.world-restart-footer', root), '重启进程').click(); await flush(); answer(true); await flush();
    expect($('.extension-restart', root).disabled).toBe(false);
    expect($('.world-workspace-status', root).textContent).toContain('shutdown rejected');
    expect(sessionStorage.getItem('cortico.extensions.v3:' + location.origin + ':restart')).toBeNull();
    button($('.world-restart-footer', root), '重启进程').click(); await flush();
    expect($('.modal')).not.toBeNull(); answer(false); await flush();
  });
  it('an unsupervised process asks for a manual start', async () => {
    stub();
    const { root } = mount({ extensions: true, restart: true, supervised: false });
    await flush();
    button($('.world-restart-footer', root), '重启进程').click();
    await flush();
    expect($('.modal')?.textContent).toContain('需要手动启动');
    answer(false);
    await flush();
    expect(calls.some((c: Any) => c.url === '/api/run/restart')).toBe(false);
  });
  it('without the restart capability there is no restart button and pending cards offer details', async () => {
    stub();
    const { ctx, root } = mount({ extensions: true });
    await flush();
    await switchTo(ctx, 'provider');
    expect(buttons(root).map((b: Any) => b.textContent)).not.toContain('重启进程');
    cardOf(root, 'gamma-prov').click();
    await flush();
    expect($('.extension-detail')).toBeTruthy();
  });

});
describe('extension review interactions', () => {

  it('opens market details from the card and restores metadata and release rows', async () => {
    stub();
    const { root } = mount();
    await flush();
    filterMarket(root, 'found');
    const card = $('article', marketCards(root));
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    const detail = $('.extension-detail');
    expect(detail.textContent).toContain('维护者');
    expect(detail.textContent).toContain('200.0K');
    expect($$('.extension-history > div', detail)).toHaveLength(2);
    expect($('details', detail)?.open).toBe(false);
    expect($('summary', detail)?.textContent).toBe('历史版本');
    expect($$('a', detail).map((link: Any) => link.textContent)).toContain('源代码仓库');
    const byline = $('.extension-card-byline', card)?.textContent;
    expect(byline).toContain('someone');
    expect(byline).toContain('3.1.0');
    const downloads = $('.extension-stat-downloads', card);
    expect(downloads.textContent).toBe('42');
    expect(downloads.getAttribute('aria-description')).toBe('累计 130 · 30 天 42 · 7 天 9');
  });
  it('keeps installed metadata available when registry details fail', async () => {
    stub({ detailStatus: 503, list: { dir: LIST.dir, extensions: [{ ...LIST.extensions[0], metadata: { license: 'MIT', dependencies: ['example-dependency'], links: { repository: 'https://git.example/module' } } }] } });
    const { root } = mount();
    await flush();
    installedInfo(root, '甲扩展').click();
    await flush();
    const detail = $('.extension-detail');
    expect($$('h4', detail).map((node: Any) => node.textContent)).toEqual(['简介', '信息']);
    expect(detail.textContent).toContain('MIT');
    expect(detail.textContent).toContain('example-dependency');
    expect($('a', detail)?.href).toBe('https://git.example/module');
  });
});

describe('feature contract', () => {

  it('sends no requests after dispose', async () => {
    stub();
    const { root, lifecycle } = mount();
    await flush();
    lifecycle.dispose();
    const before = calls.length;
    $('[aria-label=刷新]', root).click();
    await flush();
    expect(calls.length).toBe(before);
  });
});
describe('extension card and history controls', () => {

  async function installedHistory(options: Any = {}) {
    stub({ ...options, detail: { ...DETAIL, name: 'alpha-mod', version: '2.0.0', history: [
          { version: '2.0.0', date: '2026-03-01' },
          { version: '1.0.0', date: '2026-02-01' },
          { version: '0.9.0', date: '2026-01-01' },
        ], ...options?.detail } });
    const { root } = mount();
    await flush();
    installedInfo(root, '甲扩展').click();
    await flush();
    return $('.extension-detail');
  }
  const historyRow = (detail: Any, version: Any) => $$('.extension-history > div', detail).find((row: Any) => $('code', row)?.textContent === version);
  it('puts package problems below Information and disables the installed release', async () => {
    const detail = await installedHistory({ detail: { problems: ['invalid manifest'] } });
    const headings = $$('h4', detail);
    const problem = $$('.msgline.bad', detail).find((node: Any) => node.textContent === 'invalid manifest');
    expect(headings[1].compareDocumentPosition(problem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button(historyRow(detail, '1.0.0'), '当前版本').disabled).toBe(true);
    expect(button(historyRow(detail, '0.9.0'), '安装此版本').disabled).toBe(false);
  });
  it('installing a release goes through check and install, then refreshes the drawer', async () => {
    const current = { ...LIST, extensions: LIST.extensions.map((item: Any) => ({ ...item })) };
    const detail = await installedHistory({ list: current, onInstall: (payload: Any) => {
        const item = current.extensions.find((entry: Any) => entry.name === payload.name);
        item.installedVersion = payload.version;
        item.state = 'pending-restart';
      } });
    $('details', detail).open = true;
    button(historyRow(detail, '0.9.0'), '安装此版本').click();
    await flush();
    expect(document.body.textContent).toContain('1.0.0 → 0.9.0');
    answer(true);
    await vi.waitFor(() => expect($('.extension-operation-feedback', detail)?.textContent).toContain('成功'));
    expect(calls.find((call: Any) => call.url === '/api/extensions/check')?.body).toEqual({ target: { name: 'alpha-mod', version: '0.9.0' }, kind: 'world' });
    expect(calls.find((call: Any) => call.url === '/api/extensions/install')?.body).toEqual({ name: 'alpha-mod', version: '0.9.0' });
    expect(calls.slice(calls.findIndex((call: Any) => call.url === '/api/extensions/install')).some((call: Any) => call.url === '/api/extensions/updates')).toBe(true);
    expect($('details', detail)?.open).toBe(true);
    expect(button(historyRow(detail, '0.9.0'), '当前版本').disabled).toBe(true);
    const installedRow = $$('tr', detail).find((row: Any) => row.textContent?.includes('已安装版本'));
    expect(installedRow.textContent).toContain('0.9.0');
    expect($('.world-pending-group').textContent).toContain('待生效');
  });
  it('a failed release install keeps the error in the drawer and re-enables the row', async () => {
    const detail = await installedHistory({ installStatus: 400 });
    button(historyRow(detail, '0.9.0'), '安装此版本').click();
    await flush();
    answer(true);
    await vi.waitFor(() => expect($('.extension-operation-feedback.bad', detail)?.textContent).toContain('pnpm add 退出码 1'));
    expect(button(historyRow(detail, '0.9.0'), '安装此版本').disabled).toBe(false);
  });
  it('a package installed from a local link offers no npm release install', async () => {
    stub({ list: { ...LIST, extensions: [{ ...LIST.extensions[0], spec: 'link:../local' }] }, detail: { ...DETAIL, name: 'alpha-mod' } });
    const { root } = mount();
    await flush();
    cardOf(marketCards(root), '甲扩展').click();
    await flush();
    const actions = $$('.extension-version-action');
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action: Any) => action.disabled)).toBe(true);
  });
});

describe('provider connection cards', () => {
  const connection = (name: Any) => ({ name, moduleTitle: 'OpenAI', module: 'openai', model: 'm', revision: 'r1', readiness: { state: 'ready' }, usage: [] });
  async function openConnections(over: Any = {}) {
    stub({ providers: ['a', 'b', 'c'].map(connection), ...over });
    window.history.replaceState(null, '', '#/providers');
    const page = mkCtx({ extensions: true });
    lives.push(page.lifecycle);
    mountProviders(page.ctx);
    await flush(60);
    return page;
  }
  const order = (root: Any) => $$('.connection-cards > .connection-card', root).map((card: Any) => card.dataset.provider);
  it('asks before deleting a connection, and refuses one a Bot uses', async () => {
    const deleted: Any[] = [];
    const { root } = await openConnections({ references: { b: ['main'] }, onDelete: (url: Any) => deleted.push(url) });
    const trash = (name: Any) => $(`.connection-card[data-provider="${name}"] .connection-erase`, root);
    trash('b').click(); await flush();
    expect($('.modal').textContent).toContain('main');
    answer(true); await flush();
    expect(deleted).toEqual([]);
    trash('a').click(); await flush();
    answer(false); await flush();
    expect(deleted).toEqual([]);
    trash('a').click(); await flush();
    answer(true); await flush(60);
    expect(deleted).toEqual(['/api/providers/a/delete']);
  });
  it('reorders the cards by dragging and keeps the order for the next visit', async () => {
    window.localStorage.clear();
    const { root } = await openConnections();
    expect(order(root)).toEqual(['a', 'b', 'c']);
    const pointer = (type: Any, target: Any, y: Any) => { const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: y }); Object.defineProperty(event, 'pointerId', { value: 3 }); target.dispatchEvent(event); };
    const first = $('.connection-card[data-provider="a"] .connection-name', root);
    pointer('pointerdown', first, 5); pointer('pointermove', window, 300);
    expect($('.connection-drag-copy', root)).not.toBeNull();
    pointer('pointerup', window, 300); await flush();
    // jsdom lays nothing out, so the drop lands after the last card.
    expect(order(root)).toEqual(['b', 'c', 'a']);
    expect($('.connection-drag-copy', root)).toBeNull();
    lives.splice(0).forEach((life: Any) => life.dispose()); document.body.replaceChildren();
    const again = await openConnections();
    expect(order(again.root)).toEqual(['b', 'c', 'a']);
  });
});

describe('provider page tabs', () => {
  async function openProviders(caps: Any = { extensions: true }) {
    window.history.replaceState(null, '', '#/providers');
    const page = mkCtx(caps);
    lives.push(page.lifecycle);
    mountProviders(page.ctx);
    await flush();
    return page;
  }
  async function navigate(ctx: Any, view?: Any) {
    ctx.router.navigate(['providers'], view ? { view } : undefined);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flush();
  }
  it('keeps settings and market filters when switching tabs and returning through history', async () => {
    stub();
    const { ctx, root } = await openProviders();
    expect($$('h1', root)).toHaveLength(1);
    expect($('.provider-market', root).hidden).toBe(true);
    expect(calls.some((call: Any) => call.url.startsWith('/api/extensions'))).toBe(false);
    await navigate(ctx, 'market');
    const market = $('.provider-market', root);
    expect($('.provider-settings', root).hidden).toBe(true);
    expect($('.world-catalog', market)).not.toBeNull();
    expect($('.world-library', market)).toBeNull();
    expect($('.extension-installed-grid', market)).toBeNull();
    expect(market.textContent).toContain('gamma-prov');
    expect(calls.some((call: Any) => call.url.includes('/api/extensions/search?') && call.url.includes('kind=provider'))).toBe(true);
    const search = $('input[type=search]', market);
    search.value = 'keep this query'; search.dispatchEvent(new Event('input'));
    await navigate(ctx);
    await navigate(ctx, 'market');
    expect($('input[type=search]', market).value).toBe('keep this query');
    expect($$('.extension-category', root)).toHaveLength(1);
    expect($('.pagetab.active', root).textContent).toBe(providerStrings.marketTab);
  });
  it('keeps local providers manageable and exposes pending restart without a World dock', async () => {
    const list: Any = { ...LIST, extensions: [{ ...LIST.extensions[2], spec: 'file:C:/fixtures/gamma' }] };
    stub({ list, hits: { hits: [] }, onUninstall: () => { list.extensions[0].state = 'removed'; } });
    const { ctx, root } = await openProviders({ extensions: true, restart: true, supervised: true });
    await navigate(ctx, 'market');
    const market = $('.provider-market', root);
    expect($('.extension-restart', market).hidden).toBe(false);
    const card = $('.extension-market-card', market);
    expect(card.textContent).toContain('gamma-prov');
    $('.extension-get', card).click(); await flush();
    expect($('.extension-detail').textContent).toContain('2.0.0');
    const drawer = $('.extension-detail');
    button(drawer, '删除扩展').click(); await flush(); answer(false); await flush();
    expect($('.extension-market-card', market)).not.toBeNull();
    button(drawer, '删除扩展').click(); await flush(); answer(true); await flush();
    expect($('.extension-market-card', market)).toBeNull();
    expect($('.extension-detail')).toBeNull();
    expect($('.extension-restart', market).hidden).toBe(false);
  });
  it('installs a provider from a catalog card and shows it under the installed filter', async () => {
    const hit = { ...HITS.hits[0], kind: 'provider', name: 'found-provider' };
    const list: Any = { ...LIST, extensions: [] };
    stub({ list, hits: { hits: [hit] }, onInstall: (target: Any) => list.extensions.push({ name: target.name, version: target.version, kind: 'provider', state: 'pending-restart' }) });
    const { ctx, root } = await openProviders({ extensions: true, restart: true });
    await navigate(ctx, 'market');
    const market = $('.provider-market', root);
    $('.extension-get', market).click(); await flush();
    expect(calls.find((call: Any) => call.url === '/api/extensions/check').body.kind).toBe('provider');
    button($('.world-catalog-installation', market), '已安装').click(); await flush();
    expect($$('.extension-market-card', market)).toHaveLength(1);
    expect($('.extension-get', market).getAttribute('aria-label')).toBe('已安装');
    expect($('.extension-restart', market).hidden).toBe(false);
  });
  it('restores the catalog scroll when search finishes while Settings is visible', async () => {
    stub(); const fetch = globalThis.fetch; let finish: Any;
    vi.stubGlobal('fetch', (url: Any, init: Any) => String(url).startsWith('/api/extensions/search') ? new Promise((resolve: Any) => { finish = resolve; }) : fetch(url, init));
    sessionStorage.setItem('cortico.extensions.v3:' + location.origin, JSON.stringify({ provider: { scroll: 240 } }));
    const { ctx, root } = await openProviders(); await navigate(ctx, 'market'); await navigate(ctx);
    finish(new Response(JSON.stringify({ hits: [] }), { status: 200 })); await flush();
    const scroller = $('.world-catalog-scroll', root);
    expect(scroller.scrollTop).toBe(0);
    await navigate(ctx, 'market'); expect(scroller.scrollTop).toBe(240);
  });
  it('hides the market without the extensions capability, including a direct URL', async () => {
    stub();
    const { ctx, root } = await openProviders({});
    await navigate(ctx, 'market');
    expect($$('.pagetab', root)).toHaveLength(1);
    expect($('.provider-settings', root).hidden).toBe(false);
    expect(calls.some((call: Any) => call.url.startsWith('/api/extensions'))).toBe(false);
  });
});

describe('World library and catalog', () => {
  async function openWorlds(over: Any = {}, caps: Any = { worlds: true, extensions: true, worldActivation: true, restart: true, supervised: true }) {
    stub(over); window.localStorage.removeItem('cortico.world-groups.v1');
    window.history.replaceState(null, '', '#/world?view=market');
    const context = mkCtx(caps); lives.push(context.lifecycle);
    mountWorlds(context.ctx); await flush(); return context;
  }
  it('merges runtime Worlds with packages and puts recent pending downloads first', () => {
    const worlds = [{ id: 'alpha', status: 'active' }, { id: 'builtin', status: 'inactive' }];
    const old = { name: 'older', state: 'pending-restart', kind: 'world' };
    const latest = { name: 'newest', state: 'pending-restart', kind: 'world' };
    const items = worldLibrary(worlds, [...LIST.extensions, old, latest], ['newest']);
    expect(items.map((item: Any) => item.key)).toEqual(['newest', 'delta-mod', 'older', 'alpha-mod', 'world:builtin', 'beta-mod', 'epsilon-mod']);
    expect(items.find((item: Any) => item.key === 'alpha-mod').world).toBe(worlds[0]);
    expect(items[0].world).toBeUndefined();
  });
  it('keeps the same avatars and scroll position when the library expands into management rows', async () => {
    const { root, ctx } = await openWorlds();
    const rail = $('.world-library', root);
    const railItems = $$('.world-library-item', rail);
    const libraryScroll = $('.world-library-list', rail); libraryScroll.scrollTop = 25;
    expect($$('.world-library-item .navdot, .world-library-item .navlamps', rail)).toHaveLength(0);
    const search = $('.world-market input[type=search]', root);
    search.value = 'found'; search.dispatchEvent(new Event('input', { bubbles: true }));
    const scroll = $('.world-catalog-scroll', root); scroll.scrollTop = 40;
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    expect($('.world-market', root).hidden).toBe(true);
    expect(rail.hidden).toBe(false);
    expect($('.world-workspace', root).dataset.view).toBe('mine');
    ctx.router.navigate(['world'], { view: 'market' }); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    expect($('.world-library', root)).toBe(rail);
    expect(rail.hidden).toBe(false);
    expect(libraryScroll.scrollTop).toBe(25);
    expect($$('.world-blade .world-avatar', root)).toHaveLength(0);
    expect($$('.world-library-item', rail)).toEqual(railItems);
    expect(search.value).toBe('found'); expect(scroll.scrollTop).toBe(40);
    railItems.find((item: Any) => item.getAttribute('aria-label') === '甲扩展').click(); await flush();
    expect($('.world-workspace', root).dataset.view).toBe('market');
    expect($('.extension-detail')).not.toBeNull();
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    railItems.find((item: Any) => item.getAttribute('aria-label') === '甲扩展').click(); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    expect($('.world-workspace', root).dataset.view).toBe('mine');
    expect((document.activeElement as Any).dataset.key).toBe('alpha-mod');
    expect($('[aria-current=true]', rail).getAttribute('aria-label')).toBe('甲扩展');
  });
  it('keeps catalog metadata beside the title and links an installed package to its row', async () => {
    const hit = { ...HITS.hits[1], summary: { tools: 3, events: 2 } };
    const { root } = await openWorlds({ hits: { hits: [hit] } });
    const card = $('.world-catalog .extension-market-card', root);
    const heading = $('.extension-card-titleline', card);
    expect($('.extension-card-byline', heading).textContent).toContain('v1.0.0');
    expect(heading.textContent).not.toContain('已安装');
    expect($('.extension-card-spec', card)).toBeNull();
    const control = $('.extension-get', card);
    expect(control.classList.contains('is-installed')).toBe(true);
    control.click(); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    expect($('.world-workspace', root).dataset.view).toBe('mine');
    expect((document.activeElement as Any).dataset.key).toBe(hit.name);
  });
  it('offers an installed package\'s update from its market card', async () => {
    const hit = HITS.hits[1];
    const { root } = await openWorlds({ hits: { hits: [hit] }, updates: { updates: [{ name: hit.name, installedVersion: '0.9.0', latestVersion: '1.0.0', problems: [] }], errors: [] } });
    const control = $('.world-catalog .extension-market-card .extension-get', root);
    expect(control.classList.contains('is-update')).toBe(true);
    control.click(); await flush(100);
    expect(calls.find((call: Any) => call.url === '/api/extensions/install').body).toEqual({ name: hit.name, version: '1.0.0' });
  });
  it('blocks incompatible updates in the actual market and explains the reason', async () => {
    const { root } = await openWorlds({ updates: { updates: [{ name: 'alpha-mod', installedVersion: '1.0.0', latestVersion: '2.0.0', problems: ['Unsupported API'] }], errors: [] } });
    const control = $('.extension-market-card[data-name="alpha-mod"] .extension-get', root);
    expect(control.disabled).toBe(true);
    expect(control.getAttribute('aria-description')).toContain('Unsupported API');
    control.click(); await flush(); expect(calls.some((call: Any) => call.url === '/api/extensions/install')).toBe(false);
  });
  it('reports a failed install beside its control and leaves the status line empty', async () => {
    const { root } = await openWorlds({ hits: { hits: HITS.hits.slice(0, 1) }, installStatus: 500 });
    $('.world-catalog .extension-market-card .extension-get', root).click(); await flush(100);
    const problem = $('.extension-problem');
    expect(problem.classList.contains('hidden')).toBe(false);
    expect(problem.textContent).toContain('pnpm add 退出码 1');
    expect($('.world-workspace-status', root).textContent).toBe('');
    expect($('.world-catalog .extension-get', root).getAttribute('aria-label')).toBe('添加到我的 World');
    $('.extension-problem-close', problem).click();
    expect(problem.classList.contains('hidden')).toBe(true);
  });
  it('uninstalls an inactive package from its World row after confirmation', async () => {
    const { root, ctx } = await openWorlds();
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    const row = $$('.world-blade', root).find((item: Any) => item.dataset.key === 'beta-mod');
    $('.iobtn-remove', row).click(); await flush();
    expect(calls.some((call: Any) => call.url === '/api/extensions/uninstall')).toBe(false);
    answer(true); await flush(100);
    expect(calls.find((call: Any) => call.url === '/api/extensions/uninstall').body).toEqual({ name: 'beta-mod' });
  });
  it('adds from the catalog without opening details, then exposes pending restart in management', async () => {
    const list: Any = structuredClone(LIST);
    const { root } = await openWorlds({ list, hits: { hits: HITS.hits.slice(0, 2) }, onInstall: () => list.extensions.push({ name: 'found-mod', kind: 'world', version: '3.1.0', state: 'pending-restart', loaded: false, webUiClient: true }) });
    const card = cardOf(root, 'found-mod');
    $('.extension-get', card).click(); await flush(100);
    expect($('.modal')).toBeNull();
    expect($('.world-workspace-status', root).textContent).toBe('');
    expect($('.world-library-item', root).getAttribute('aria-label')).toBe('found-mod');
    const group = $('.world-pending-group', root);
    expect($$('.world-library-entry', group)).toHaveLength(2);
    expect(group.lastElementChild.className).toBe('world-restart-row');
    expect($('.world-restart-footer .extension-restart', group.lastElementChild)).not.toBeNull();
    expect($('.world-ready-list .world-blade', root).dataset.state).toBe('attached');
    button(root, '我的 World').click(); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    const pending = $('.world-blade', root);
    expect(pending.dataset.state).toBe('pending');
    expect(pending.textContent).toContain('待生效');
    expect(buttons(pending).some((item: Any) => item.textContent === '激活 World')).toBe(false);
    $('.world-blade [aria-label="扩展信息"]', root).click(); await flush();
    expect($('.extension-detail').textContent).toContain('found-mod');
  });
  it('shows live readings and changes mode only after confirmation', async () => {
    const worlds = [{ id: 'alpha', status: 'active', visible: true, tools: ['read'], lamps: [{ label: 'Link', state: 'online', hint: '2 clients' }] }];
    const { root } = await openWorlds({ worlds }, { worlds: true, worldVisibility: true, worldActivation: true });
    const row = $('.world-blade', root);
    expect(row.textContent).toContain('Link · 2 clients');
    expect($('.world-modes', row)).toBeNull();
    $('[aria-label="停用 World"]', row).click(); await flush();
    expect(calls.some((call: Any) => call.url === '/api/worlds/activation')).toBe(false);
    answer(false); await flush();
    expect(calls.some((call: Any) => call.url === '/api/worlds/activation')).toBe(false);
    $('[aria-label="对 agent 隐藏"]', root).click(); await flush();
    // Hiding asks first; cancelling leaves the World as it was.
    expect($('.modal').textContent).toContain('对 agent 隐藏');
    expect(calls.some((call: Any) => call.url === '/api/worlds/visibility')).toBe(false);
    answer(false); await flush();
    expect(calls.some((call: Any) => call.url === '/api/worlds/visibility')).toBe(false);
    $('[aria-label="对 agent 隐藏"]', root).click(); await flush();
    answer(true); await flush();
    expect(calls.find((call: Any) => call.url === '/api/worlds/visibility').body).toEqual({ id: 'alpha', visible: false });
    expect($('.world-feedback', root).textContent).toBe('');
  });
  it('applies a confirmed visibility change to the current conversation without asking again', async () => {
    const { root } = await openWorlds({ driftedWorlds: ['alpha'] }, { worlds: true, worldVisibility: true });
    $('[aria-label="对 agent 隐藏"]', root).click(); await flush(100);
    expect(calls.some((call: Any) => call.url === '/api/session/reload-prefix')).toBe(false);
    answer(true); await flush(100);
    expect(calls.some((call: Any) => call.url === '/api/session/reload-prefix')).toBe(true);
    expect($('.modal')).toBeNull();
    expect($('.world-feedback', root).textContent).toBe('');
    expect($('.world-management-toolbar', root)).toBeNull();
  });
  it('keeps runtime Worlds available when the extension list fails to load', async () => {
    const { root } = await openWorlds({ listStatus: 503 });
    expect($$('.world-blade', root)).toHaveLength(2);
    expect($('.world-workspace-status', root).textContent).toContain('Unavailable');
  });
  it('puts packages new after a restart at the top of the list without replacing avatars', async () => {
    const list: Any = { extensions: [{ name: 'last', worldId: 'last', kind: 'world', state: 'pending-restart' }] };
    const worlds = [{ id: 'builtin', status: 'active' }];
    const { root } = await openWorlds({ list, worlds });
    const pending = $('.world-pending-list .world-library-item', root);
    list.extensions[0].state = 'loaded'; worlds.push({ id: 'last', status: 'inactive' });
    $('.world-market [aria-label="刷新"]', root).click(); await flush(100);
    expect($('.world-pending-group', root).hidden).toBe(true);
    expect($('.world-ready-list .world-library-item', root)).toBe(pending);
  });
  it('does not animate entries during ordinary loading or catalog refresh', async () => {
    const original = Element.prototype.animate;
    const animated: Any[] = [];
    (Element.prototype as Any).animate = function() { animated.push(this); return { cancel() {}, finished: Promise.resolve() }; };
    try {
      const { root } = await openWorlds();
      $('.world-market [aria-label="刷新"]', root).click(); await flush(100);
      expect(animated.filter((el: Any) => el.classList.contains('world-library-entry'))).toHaveLength(0);
      expect($('.world-management-toolbar', root)).toBeNull();
      expect($$('.world-library-heading', root).map((el: Any) => el.textContent)).toEqual(['待生效', '扩展列表']);
    } finally { if (original) (Element.prototype as Any).animate = original; else delete (Element.prototype as Any).animate; }
  });
  it('restores positions once after reload and waits for both lists', async () => {
    const key = `cortico.world-layout:${window.location.origin}`;
    window.sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), scroll: 12, positions: [['alpha-mod', 90]] }));
    const animations: Any[] = [];
    const original = Element.prototype.animate;
    (Element.prototype as Any).animate = function(this: Any, frames: Any) { animations.push({ element: this, frames }); return { cancel() {}, finished: Promise.resolve() }; };
    try {
      const { root } = await openWorlds();
      expect(window.sessionStorage.getItem(key)).toBeNull();
      expect($('.world-library-list', root).scrollTop).toBe(12);
      expect(animations.some((a: Any) => a.element.classList.contains('world-library-entry') && a.frames[0].transform === 'translateY(90px)')).toBe(true);
    } finally { if (original) (Element.prototype as Any).animate = original; else delete (Element.prototype as Any).animate; }
  });
  it('hides the market at once when leaving it, and slides it in when entering', async () => {
    const original = Element.prototype.animate;
    const animations: Any[] = [];
    (Element.prototype as Any).animate = function(this: Any, frames: Any) {
      let finish: Any;
      const animation = { cancel() {}, playState: 'running', finished: new Promise((resolve: Any) => { finish = resolve; }) };
      if (this.classList.contains('world-market')) animations.push({ frames, animation, finish });
      return animation;
    };
    try {
      const { root, ctx } = await openWorlds();
      const market = $('.world-market', root);
      // Leaving: gone at once, with nothing animating it out to show through the rows.
      ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
      expect(market.hidden).toBe(true);
      expect(animations).toHaveLength(0);
      // Entering: shown and slid in; finishing late changes nothing.
      ctx.router.navigate(['world'], { view: 'market' }); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
      expect(market.hidden).toBe(false);
      expect(animations).toHaveLength(1);
      expect(animations[0].frames.at(-1)).toEqual({ clipPath: 'inset(0 0 0 0%)' });
      animations[0].finish(); await flush();
      expect(market.hidden).toBe(false);
      expect(market.inert).toBe(false);
    } finally { if (original) (Element.prototype as Any).animate = original; else delete (Element.prototype as Any).animate; }
  });
  it('filters the catalog by installation state and resets it with clear filters', async () => {
    const { root } = await openWorlds({ hits: { hits: HITS.hits.slice(0, 2) } });
    const segment = (label: Any) => $$('.world-catalog-installation button', root).find((item: Any) => item.textContent === label);
    segment('已安装').click(); await flush();
    expect($$('.world-catalog .extension-market-card', root).map((card: Any) => card.dataset.name)).toEqual([HITS.hits[1].name]);
    segment('未安装').click(); await flush();
    expect($$('.world-catalog .extension-market-card', root).map((card: Any) => card.dataset.name)).toEqual([HITS.hits[0].name]);
    $('.world-market [aria-label="清除筛选"]', root).click(); await flush();
    expect($$('.world-catalog .extension-market-card', root)).toHaveLength(2);
  });
  it('groups the catalog by function tags and lists the remaining tags under their group', async () => {
    const index = { tags: { game: { label: '游戏' }, im: { label: '即时通讯' }, experimental: { label: '实验性', style: 'notice' } } };
    const hits = [{ ...HITS.hits[0], tags: ['im', 'experimental'] }, { ...HITS.hits[1], tags: ['game'] }];
    const { root } = await openWorlds({ hits: { hits, index } });
    const category = (id: Any) => $(`.world-catalog-categories [data-category="${id}"]`, root);
    expect($('.extension-tag-count', category('game')).textContent).toBe('1');
    expect(category('streaming').hidden).toBe(true);
    const sidebarTags = $$('.world-catalog-filters .extension-tagbar .extension-tag', root).map((tag: Any) => tag.textContent);
    expect(sidebarTags.some((text: Any) => text.startsWith('游戏') || text.startsWith('即时通讯'))).toBe(false);
    expect($$('.world-catalog-filters .extension-tagbar-label', root).map((label: Any) => label.textContent)).toContain('注意事项');
    category('game').click(); await flush();
    expect($$('.world-catalog .extension-market-card', root).map((card: Any) => card.dataset.name)).toEqual([HITS.hits[1].name]);
    $('.world-market [aria-label="清除筛选"]', root).click(); await flush();
    expect($$('.world-catalog .extension-market-card', root)).toHaveLength(2);
    expect(category('all').getAttribute('aria-pressed')).toBe('true');
  });
  it.each(['world', 'provider'])('keeps %s market nodes, focus and scrolling when the install source changes', async (kind: Any) => {
    const { root, ctx } = await openWorlds();
    if (kind === 'provider') await switchTo(ctx, kind);
    const fold = $('.world-manual', root); fold.open = true; fold.dispatchEvent(new Event('toggle'));
    const scroll = $('.world-catalog-scroll', root); scroll.scrollTop = 60;
    const firstCard = $('.extension-market-card', root);
    const input = $('input', fold);
    for (const [label, field, placeholder] of [['从本机目录安装', '扩展项目目录', ''], ['从 npm 安装', '包名与版本', `@scope/cortico-${kind}-demo@1.2.3`]]) {
      input.value = 'old input'; input.dispatchEvent(new Event('input'));
      const choice = button(fold, label); choice.focus(); choice.click(); await flush();
      expect(document.activeElement).toBe(choice);
      expect($('.world-manual', root)).toBe(fold);
      expect(fold.open).toBe(true);
      expect($('.extension-market-card', root)).toBe(firstCard);
      expect(scroll.scrollTop).toBe(60);
      expect($('input', fold)).toBe(input);
      expect(input.getAttribute('aria-label')).toBe(field);
      expect(input.placeholder).toBe(placeholder);
      expect(input.value).toBe('');
      expect($('.extension-manual-folder', fold).disabled).toBe(label === '从 npm 安装');
      expect($$('.extension-install-help>[aria-hidden=false]', fold)).toHaveLength(1);
    }
  });
  it('shows a restart in progress as a spinner beside the button without a status line', async () => {
    const list: Any = { extensions: [{ name: 'late', kind: 'world', state: 'pending-restart' }] };
    const { root } = await openWorlds({ list });
    $('.world-restart-footer .extension-restart', root).click(); await flush();
    answer(true); await flush(100);
    expect($('.world-restart-footer', root).classList.contains('is-restarting')).toBe(true);
    expect($('.world-restart-footer .extension-restart', root).disabled).toBe(true);
    expect($('.world-workspace-status', root).textContent).toBe('');
  });
  it('orders row controls from the sidebar switch to power and opens configuration on a row click', async () => {
    const { root, ctx } = await openWorlds({}, { worlds: true, extensions: true, worldActivation: true, worldVisibility: true, restart: true, supervised: true });
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    const row = $$('.world-blade', root).find((item: Any) => item.dataset.key === 'alpha-mod');
    expect($$('.world-blade-actions button', row).map((item: Any) => item.getAttribute('aria-label'))).toEqual(['左栏隐藏', '删除扩展', '对 agent 隐藏', '停用 World']);
    expect($('.world-blade-identity h3 [aria-label="扩展信息"]', row)).not.toBeNull();
    // Rows with fewer controls pack them to the right, with no gap at the end.
    const slots = (item: Any) => $$('.world-blade-actions button', item).map((button: Any) => button.style.getPropertyValue('--slot'));
    expect(slots(row)).toEqual(['1', '2', '3', '4']);
    const failed = $$('.world-blade', root).find((item: Any) => item.dataset.key === 'beta-mod');
    expect(slots(failed).at(-1)).toBe('4');
    $('.world-blade-identity code', row).click(); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    expect(decodeURIComponent(window.location.hash)).toBe('#/provider/world:alpha');
  });
  it('filters My World by name and state, and keeps a named, collapsed group across reloads', async () => {
    const { root, ctx } = await openWorlds();
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    const visible = () => $$('.world-ready-list .world-library-entry:not(.is-filtered-out)', root).map((entry: Any) => entry.dataset.key);
    const search = $('.world-library-tools input[type=search]', root);
    search.value = '甲'; search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(visible()).toEqual(['alpha-mod']);
    expect($('.world-library-entry', root).classList.contains('is-movable')).toBe(false);
    expect($('.world-no-matches', root).hidden).toBe(true);
    search.value = '不存在的名字'; search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(visible()).toEqual([]);
    expect($('.world-no-matches', root).hidden).toBe(false);
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
    expect($('.world-ready-list .world-library-entry', root).classList.contains('is-movable')).toBe(true);
    button($('.world-library-tools', root), '新建分组').click(); await flush();
    const rename = $('.world-group-rename', root);
    rename.value = '聊天'; rename.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    $('.world-group-toggle', root).click();
    const saved = JSON.parse(window.localStorage.getItem('cortico.world-groups.v1')!);
    expect(Object.values(saved.groups)).toEqual([expect.objectContaining({ name: '聊天', collapsed: true, items: [] })]);
    expect(saved.top[0]).toMatch(/^group:/);
  });
  it('drags a row with the pointer: a lifted copy, no cursor, and the click after the drop opens nothing', async () => {
    const { root, ctx } = await openWorlds();
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    const order = () => $$('.world-ready-list .world-library-entry', root).map((entry: Any) => entry.dataset.key);
    const [first, ...rest] = order();
    expect(rest.length).toBeGreaterThan(0);
    const pointer = (type: Any, target: Any, y: Any) => { const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: y }); Object.defineProperty(event, 'pointerId', { value: 1 }); target.dispatchEvent(event); };
    const row = $(`.world-ready-list .world-library-entry[data-key="${first}"] .world-blade-state, .world-ready-list .world-library-entry[data-key="${first}"] .world-blade`, root);
    const hash = window.location.hash;
    pointer('pointerdown', row, 10);
    pointer('pointermove', window, 12);
    expect($('.world-drag-copy', root)).toBeNull();
    pointer('pointermove', window, 400);
    expect($('.world-drag-copy', root)).not.toBeNull();
    expect(document.documentElement.classList.contains('is-list-dragging')).toBe(true);
    expect($(`.world-library-entry[data-key="${first}"]`, root).classList.contains('is-dragging')).toBe(true);
    pointer('pointerup', window, 400);
    // The drop re-renders the rows; the click lands on the live one.
    $(`.world-ready-list .world-library-entry[data-key="${first}"] .world-blade`, root).click(); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    expect(window.location.hash).toBe(hash);
    expect($('.world-drag-copy', root)).toBeNull();
    expect(document.documentElement.classList.contains('is-list-dragging')).toBe(false);
    // jsdom lays nothing out, so the drop lands after the last row.
    expect(order()).toEqual([...rest, first]);
  });
  it('keeps a built-in World on and visible: its hide and power controls are greyed', async () => {
    const worlds = [{ id: 'core', label: 'Core', status: 'active', visible: true }];
    const { root, ctx } = await openWorlds({ worlds }, { worlds: true, extensions: true, worldActivation: true, worldVisibility: true, restart: true, supervised: true });
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    const row = $$('.world-blade', root).find((item: Any) => item.dataset.key === 'world:core');
    for (const slot of ['visibility', 'power']) expect($(`[data-slot="${slot}"]`, row).getAttribute('aria-disabled')).toBe('true');
    $('[data-slot="power"]', row).click(); await flush();
    expect($('.modal')).toBeNull();
    expect(calls.some((call: Any) => call.url === '/api/worlds/activation')).toBe(false);
  });
  it('recounts a group after one of its rows moves out', async () => {
    window.localStorage.setItem('cortico.world-groups.v1', JSON.stringify({ top: ['group:g', 'world:builtin'], groups: { g: { name: 'G', collapsed: false, items: ['alpha-mod', 'delta-mod'] } } }));
    stub({}); window.history.replaceState(null, '', '#/world');
    const context = mkCtx({ worlds: true, extensions: true, worldActivation: true, restart: true, supervised: true }); lives.push(context.lifecycle);
    mountWorlds(context.ctx); await flush();
    const root = context.root;
    expect($('.world-group-count', root).textContent).toBe(String($$('.world-group-list .world-library-entry', root).length));
  });
  it('hides an active World from the sidebar and remembers it', async () => {
    window.localStorage.removeItem('cortico.world-nav-hidden.v1');
    const { root, ctx } = await openWorlds({}, { worlds: true, extensions: true, worldActivation: true, worldVisibility: true, restart: true, supervised: true });
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    let fired = 0; window.addEventListener('cortico:world-nav-hidden', () => fired++, { once: true });
    $('.world-blade[data-world="alpha"] [data-slot="sidebar"]', root).click(); await flush();
    expect(JSON.parse(window.localStorage.getItem('cortico.world-nav-hidden.v1')!)).toEqual(['world:alpha']);
    expect(fired).toBe(1);
    expect($('.world-blade[data-world="alpha"] [data-slot="sidebar"]', root).getAttribute('aria-label')).toBe('左栏显示');
    window.localStorage.removeItem('cortico.world-nav-hidden.v1');
  });
  it('shows a failed switch beside its control instead of a status line', async () => {
    const { root, ctx } = await openWorlds({ worlds: [{ id: 'alpha', label: '甲扩展', status: 'inactive' }] }, { worlds: true, extensions: true, worldActivation: true, restart: true, supervised: true });
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    vi.stubGlobal('fetch', (url: Any, init: Any) => Promise.resolve(String(url) === '/api/worlds/activation' ? new Response(JSON.stringify({ error: 'World 启动失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } }) : new Response(JSON.stringify(String(url) === '/api/worlds' ? { worlds: [{ id: 'alpha', label: '甲扩展', status: 'inactive' }] } : { extensions: LIST.extensions, dir: '' }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    $('.world-blade[data-world="alpha"] [data-slot="power"]', root).click(); await flush(100);
    const problem = $$('.extension-problem').find((el: Any) => !el.classList.contains('hidden'));
    expect(problem.textContent).toContain('World 启动失败');
    expect($('.world-feedback', root).textContent).toBe('');
  });
  it('keeps a load failure to its state and opens the reason in the error popover', async () => {
    const { root, ctx } = await openWorlds();
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    const row = $$('.world-blade', root).find((item: Any) => item.dataset.key === 'beta-mod');
    expect($('.world-blade-note', row)).toBeNull();
    $('.world-state-problem', row).click();
    const problem = $$('.extension-problem').find((el: Any) => !el.classList.contains('hidden'));
    expect(problem.textContent).toContain('默认导出不是 WorldDefinition');
  });
  it("opens extension info from a World's name", async () => {
    const { root, ctx } = await openWorlds();
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    $('button.world-name', $$('.world-blade', root).find((item: Any) => item.dataset.key === 'alpha-mod')).click(); await flush();
    expect($('.extension-detail')).not.toBeNull();
  });
  it('greys out an unavailable uninstall and names the reason', async () => {
    const { root, ctx } = await openWorlds();
    ctx.router.navigate(['world']); window.dispatchEvent(new HashChangeEvent('hashchange')); await flush();
    const remove = $('.iobtn-remove', $$('.world-blade', root).find((item: Any) => item.dataset.key === 'world:builtin'));
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(remove.title).toBe('随 Cortico 提供，不能单独删除。');
    remove.click(); await flush();
    expect($('.modal')).toBeNull();
  });
  it('excludes caution tags for good, lists them above the cards and lets them back from there', async () => {
    const key = 'cortico.extensions.exclusions.v1:' + location.origin;
    localStorage.removeItem(key);
    try {
      const index = { tags: { unsafe: { label: '不安全', style: 'warning' }, game: { label: '游戏' } } };
      const hits = [{ ...HITS.hits[0], tags: ['unsafe', 'game'] }, { ...HITS.hits[1], tags: ['game'] }];
      const cards = (root: Any) => $$('.world-catalog .extension-market-card', root).map((card: Any) => card.dataset.name);
      const first = await openWorlds({ hits: { hits, index } });
      $('.world-market [aria-label="隐藏带警示标签的扩展"]', first.root).click(); await flush();
      expect(cards(first.root)).toEqual([HITS.hits[1].name]);
      // A new session still excludes it, and the sidebar keeps its row so it can be let back.
      window.sessionStorage.clear();
      const { root } = await openWorlds({ hits: { hits, index } });
      expect(cards(root)).toEqual([HITS.hits[1].name]);
      expect($$('.world-catalog-filters .extension-tag.is-excluded', root).map((tag: Any) => tag.textContent)).toEqual(['不安全1']);
      expect($('.extension-active-row .extension-active-note', root).textContent).toBe('隐藏了 1 个');
      $('.extension-active-item.is-excluded', root).click(); await flush();
      expect(cards(root)).toHaveLength(2);
      expect($('.extension-active-filters', root).hidden).toBe(true);
    } finally { localStorage.removeItem(key); }
  });
  it('adds a tag clicked on a card to the selection, within the current category', async () => {
    const index = { tags: { game: { label: '游戏' } } };
    const { root } = await openWorlds({ hits: { hits: [{ ...HITS.hits[0], tags: ['game'] }, HITS.hits[1]], index } });
    $('.world-catalog .extension-market-card .extension-tag', root).click(); await flush();
    expect($('.world-catalog-categories [data-category="all"]', root).getAttribute('aria-pressed')).toBe('true');
    expect($$('.extension-active-row .extension-active-item', root).map((item: Any) => item.textContent)).toEqual(['游戏']);
    expect($$('.world-catalog .extension-market-card', root)).toHaveLength(1);
  });
  it('keeps runtime controls available when the catalog capability is absent', async () => {
    const { root } = await openWorlds({}, { worlds: true, worldActivation: true });
    expect($('.world-workspace', root).dataset.view).toBe('mine');
    expect($$('.pagetab', root)).toHaveLength(1);
    expect($('.world-blade', root).classList.contains('is-configurable')).toBe(true);
    $('[aria-label="激活 World"]', root).click(); await flush();
    expect(calls.find((call: Any) => call.url === '/api/worlds/activation').body).toEqual({ id: 'builtin', enabled: true });
    expect(calls.some((call: Any) => call.url.startsWith('/api/extensions'))).toBe(false);
  });
});
