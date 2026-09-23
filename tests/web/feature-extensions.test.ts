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
const { mountExtensions, parseInstallInput, arrangeHits, extensionsFeature } = (await import(EXTENSIONS)) as Any;

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
  return {
    ctx: {
      ui, root, lifecycle, signal: lifecycle.signal,
      capabilities: caps,
      route: { segments: ['extensions'] },
      router: new Router({ win: window, onError: () => {} }),
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
  const hit = [...root.querySelectorAll('.iocard')].find((c) => c.querySelector('h3')?.textContent?.startsWith(title));
  if (!hit) throw new Error(`没有「${title}」的卡`);
  return hit as HTMLElement;
};
/** 已安装区的分组:每条 section 标题配它后面那张网格里的卡名。 */
const groupsOf = (root: ParentNode): Array<{ title: string; cards: string[] }> =>
  [...root.querySelectorAll('.sectionhead')].map((head) => ({
    title: head.querySelector('h4')?.textContent ?? '',
    cards: [...(head.nextElementSibling?.querySelectorAll('.iocard') ?? [])]
      .map((c) => c.querySelector('h3')?.firstChild?.textContent?.trim() ?? ''),
  }));

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('已安装清单', () => {
  it('发现新版本时显示版本并可就地更新；检查失败不显示已是最新', async () => {
    stub({ updates: { updates: [{ name: 'alpha-mod', installedVersion: '1.0.0', latestVersion: '1.1.0', problems: [] }], errors: [{ name: 'beta-mod', error: 'registry unavailable' }] } });
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    expect(root.textContent).toContain('可更新 1 个扩展');
    expect(root.textContent).toContain('检查失败');
    const alpha = cardOf(root, '甲扩展');
    expect(alpha.textContent).toContain('1.0.0 → 1.1.0');
    button(alpha, '更新').click();
    await flush();
    expect(calls.find((c) => c.url === '/api/extensions/install')?.body).toEqual({ name: 'alpha-mod', version: '1.1.0' });
    answer(false);
  });

  it('新版契约不兼容时先显示原因并确认；整体检查失败不显示更新', async () => {
    stub({ updates: { updates: [{ name: 'alpha-mod', installedVersion: '1.0.0', latestVersion: '2.0.0', problems: ['扩展要求契约 v9'] }], errors: [] } });
    const a = mkCtx();
    mountExtensions(a.ctx);
    await flush();
    expect(cardOf(a.root, '甲扩展').textContent).toContain('扩展要求契约 v9');
    button(cardOf(a.root, '甲扩展'), '更新').click();
    await flush();
    expect(calls.some((c) => c.url === '/api/extensions/install')).toBe(false);
    answer(true);
    await flush();
    expect(calls.find((c) => c.url === '/api/extensions/install')?.body).toEqual({ name: 'alpha-mod', version: '2.0.0' });
    answer(false);

    document.body.replaceChildren();
    stub({ updateStatus: 502 });
    const b = mkCtx();
    mountExtensions(b.ctx);
    await flush();
    expect(b.root.textContent).toContain('更新检查失败');
    expect(b.root.textContent).not.toContain('可更新');
  });
  it('扩展卡片显示状态和失败原因，已卸载的扩展没有卸载按钮', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    expect(calls.map((c) => c.url)).toContain('/api/extensions');

    const alpha = cardOf(root, '甲扩展');
    expect(alpha.textContent).toContain('已加载');
    expect(alpha.textContent).toContain('World alpha');
    expect(buttons(alpha).map((b) => b.textContent)).toContain('卸载');

    const beta = cardOf(root, 'beta-mod');
    expect(beta.textContent).toContain('加载失败');
    expect(beta.textContent).toContain('默认导出不是 WorldDefinition');

    const gamma = cardOf(root, 'gamma-prov');
    expect(gamma.textContent).toContain('待重启');
    expect(gamma.textContent).toContain('丙');

    const delta = cardOf(root, 'delta-mod');
    expect(delta.textContent).toContain('已卸载,待重启');
    expect(buttons(delta).map((b) => b.textContent)).not.toContain('卸载');

    expect(root.textContent).toContain('已加载 1');
    expect(root.textContent).toContain('待重启 2');
    expect(root.textContent).toContain('加载失败 2');
    expect(root.textContent).toContain('C:/repo/extensions');
  });

  it('磁盘版本不同于运行版本时显示重启后将加载的版本', async () => {
    stub({ list: { dir: 'd', extensions: [{
      ...LIST.extensions[0], installedVersion: '1.2.0', state: 'pending-restart',
    }] } });
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    expect(cardOf(root, '甲扩展').textContent).toContain('磁盘版本 1.2.0，重启后加载');
  });

  it('按 kind 分三组,读不出 manifest 的包归「未识别」并把原因摆出来', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    expect(groupsOf(root)).toEqual([
      { title: 'World', cards: ['甲扩展', 'beta-mod', 'delta-mod'] },
      { title: 'LLM Provider', cards: ['gamma-prov'] },
      { title: '未识别', cards: ['epsilon-mod'] },
    ]);
    expect(cardOf(root, 'epsilon-mod').textContent).toContain('缺少 cortico 块');
  });

  it('bot 包自成一组:被引用的那个已加载,其余 idle 并说明原因;副标题按 kind 写 bot <id>', async () => {
    stub({ list: { dir: 'd', extensions: [
      { name: 'zeta-bot', spec: '^1.0.0', version: '1.0.0', kind: 'bot', api: 3, consoleClient: false, console: 'none', loaded: true, worldId: 'zeta', state: 'loaded' },
      { name: 'eta-bot', spec: '^1.0.0', version: '1.0.0', kind: 'bot', api: 3, consoleClient: false, console: 'none', loaded: false, state: 'idle' },
    ] } });
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    expect(groupsOf(root)).toEqual([{ title: 'Bot', cards: ['zeta-bot', 'eta-bot'] }]);
    expect(cardOf(root, 'zeta-bot').textContent).toContain('bot zeta');
    const eta = cardOf(root, 'eta-bot');
    expect(eta.textContent).toContain('已装,本部署未用');
    expect(root.textContent).toContain('已加载 1');
    expect(root.textContent).not.toContain('加载失败');
  });

  it('卡上带 kind 徽标、契约版本与浏览器端产物状态;none 不占位置', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    const alpha = cardOf(root, '甲扩展');
    expect(alpha.textContent).toContain('World');
    expect(alpha.textContent).toContain('v3');
    expect(alpha.textContent).toContain('自定义面板已加载');

    const beta = cardOf(root, 'beta-mod');
    expect(beta.textContent).not.toContain('自定义面板已加载');

    const gamma = cardOf(root, 'gamma-prov');
    expect(gamma.textContent).toContain('LLM Provider');
    expect(gamma.textContent).not.toContain('自定义面板');
    expect(gamma.textContent).not.toContain('浏览器端产物');
  });

  it('空清单一句空态;重启键跟 restart 能力位走', async () => {
    stub({ list: { dir: 'd', extensions: [] } });
    const a = mkCtx({ extensions: true });
    mountExtensions(a.ctx);
    await flush();
    expect(a.root.textContent).toContain('还没装任何扩展');
    expect(buttons(a.root).map((b) => b.textContent)).not.toContain('重启进程');
    document.body.replaceChildren();
    const b = mkCtx({ extensions: true, restart: true });
    mountExtensions(b.ctx);
    await flush();
    expect(buttons(b.root).map((b) => b.textContent)).toContain('重启进程');
  });

  it('卸载先问一句;答"是"打 uninstall 端点,载荷 { name },完事重取清单', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    button(cardOf(root, '甲扩展'), '卸载').click();
    await flush();
    expect(calls.some((c) => c.url === '/api/extensions/uninstall')).toBe(false);
    answer(true);
    await flush();
    const un = calls.find((c) => c.url === '/api/extensions/uninstall');
    expect(un?.method).toBe('POST');
    expect(un?.body).toEqual({ name: 'alpha-mod' });
    expect(calls.filter((c) => c.url === '/api/extensions').length).toBe(2);
  });

  it('确认后发送重启请求并显示逐项结果', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    button(root, '重启进程').click();
    await flush();
    answer(true);
    await flush();
    expect(calls.find((c) => c.url === '/api/run/restart')?.method).toBe('POST');
    // 回执摊在对话框里
    expect(document.body.textContent).toContain('✓ 按住事件投递');
  });

  it('未受监督的进程提示手动重新启动', async () => {
    stub();
    const { ctx, root } = mkCtx({ extensions: true, restart: true, supervised: false });
    mountExtensions(ctx);
    await flush();
    button(root, '重启进程').click();
    await flush();
    expect(document.querySelector('.modal')?.textContent).toContain('手动重新启动');
    answer(false);
    await flush();
    expect(calls.some((c) => c.url === '/api/run/restart')).toBe(false);
  });
});

describe('发现与安装', () => {
  /** 结果卡在搜索那张 sheet 里;已安装区的卡也带 .iocard,按可点开的那个类挑。 */
  const hitCards = (root: ParentNode): HTMLElement[] => [...root.querySelectorAll('.iocard-open')] as HTMLElement[];
  const hitNames = (root: ParentNode): string[] =>
    hitCards(root).map((c) => c.querySelector('h3')?.firstChild?.textContent?.trim() ?? '');
  const drawer = (): HTMLElement => {
    const el = document.querySelector('.modal .modalbody');
    if (!el) throw new Error('抽屉没开');
    return el as HTMLElement;
  };

  it('一进页就列出这一类的全部包,不必先点搜索;请求只带 kind', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    expect(calls.some((c) => c.url === '/api/extensions/search?kind=world')).toBe(true);
    expect(hitNames(root)).toContain('found-mod');
  });

  it('结果卡只放基础信息:没有按钮,整张可点;详情等点开才取', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    const found = hitCards(root).find((c) => c.querySelector('h3')?.textContent?.startsWith('found-mod'))!;
    expect(found.textContent).toContain('搜到的');
    expect(found.textContent).toContain('月下载 42');
    expect(found.textContent).toContain('MIT');
    expect(buttons(found)).toEqual([]);
    expect(found.getAttribute('role')).toBe('button');
    expect(calls.some((c) => c.url.startsWith('/api/extensions/package'))).toBe(false);

    found.click();
    await flush();
    expect(calls.some((c) => c.url === '/api/extensions/package?name=found-mod')).toBe(true);
    const body = drawer();
    expect(body.textContent).toContain('契约 v4');
    expect(body.textContent).toContain('自带控制台面板');
    expect(body.textContent).toContain('>=22');
    expect(body.textContent).toContain('200.0K');
    expect(body.textContent).toContain('3.1.0');
    expect(buttons(body).map((b) => b.textContent)).toEqual(expect.arrayContaining(['npm', '仓库', 'issues', '安装']));
  });

  it('详细页:契约版本对不上标红并给出理由;已安装的包安装键禁掉', async () => {
    stub({ detail: { manifest: undefined, problems: ['扩展要求契约 v9,本框架只到 v4:框架需要升级。'], installed: true, installedSpec: '^3.0.0' } });
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    hitCards(root)[0].click();
    await flush();
    const body = drawer();
    expect(body.textContent).toContain('不是可装载的扩展');
    expect(body.querySelector('.msgline.bad')?.textContent).toContain('v9');
    expect(body.textContent).toContain('已安装 ^3.0.0');
    expect(button(body, '已安装').disabled).toBe(true);
  });

  it('详细页取不到:抽屉里一行红字,不影响列表', async () => {
    stub({ detailStatus: 502 });
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    hitCards(root)[0].click();
    await flush();
    expect(drawer().querySelector('.msgline.bad')?.textContent).toContain('npm 没有这个包');
    expect(hitCards(root).length).toBeGreaterThan(0);
  });

  it('筛选按名字、描述、关键字匹配,计数跟着变;清空又回到全部', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    const all = hitNames(root).length;
    const filter = root.querySelector('input[type=search]') as HTMLInputElement;
    filter.value = 'chat';
    filter.dispatchEvent(new Event('input'));
    await flush();
    expect(hitNames(root)).toEqual(['found-mod']);
    expect(root.textContent).toContain('1 / 13 个包');
    filter.value = '已经装了';
    filter.dispatchEvent(new Event('input'));
    await flush();
    expect(hitNames(root)).toEqual(['alpha-mod']);
    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    await flush();
    expect(hitNames(root).length).toBe(all);
    // 筛选是本地的:一次都没再打 registry
    expect(calls.filter((c) => c.url.startsWith('/api/extensions/search')).length).toBe(1);
  });

  it('排序口径换了就重排;隐藏已安装把装过的那条去掉', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    const select = root.querySelector('select.field') as HTMLSelectElement;
    expect(hitNames(root)[0]).toBe('filler-10');
    select.value = 'date';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(hitNames(root)[0]).toBe('found-mod');
    select.value = 'name';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(hitNames(root)[0]).toBe('alpha-mod');

    const box = root.querySelector('label.check input[type=checkbox]') as HTMLInputElement;
    box.click();
    await flush();
    expect(hitNames(root)).not.toContain('alpha-mod');
  });

  it('一页 12 张,第 13 条在第二页;翻页键在两端各自禁掉', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    expect(hitNames(root).length).toBe(12);
    expect(root.textContent).toContain('1 / 2');
    expect(button(root, '‹ 上一页').disabled).toBe(true);
    button(root, '下一页 ›').click();
    await flush();
    expect(hitNames(root).length).toBe(1);
    expect(button(root, '下一页 ›').disabled).toBe(true);
    button(root, '‹ 上一页').click();
    await flush();
    expect(hitNames(root).length).toBe(12);
  });

  it('kind 分段控件默认 World;切到 provider 换关键字、清掉上一类的命中、按新 kind 重取', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    const seg = root.querySelector('.segwrap') as HTMLElement;
    expect([...seg.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['World', 'LLM Provider', 'Bot']);
    expect(seg.querySelector('.seg.active')?.textContent).toBe('World');
    expect(root.textContent).toContain('cortico-world');
    expect(root.textContent).not.toContain('cortico-provider');

    button(seg, 'LLM Provider').click();
    await flush();
    expect(root.textContent).toContain('cortico-provider');
    expect(calls.filter((c) => c.url.startsWith('/api/extensions/search')).map((c) => c.url)).toEqual([
      '/api/extensions/search?kind=world',
      '/api/extensions/search?kind=provider',
    ]);
  });

  it('这一类一个包都没有时说明是空的,不说"没有匹配"', async () => {
    stub({ hits: { hits: [] } });
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    expect(root.textContent).toContain('npm 上还没有这一类的包');
  });

  it('安装从详细页发出,载荷 { name, version };装完问要不要重启,答"否"就停在清单', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    hitCards(root)[0].click();
    await flush();
    button(drawer(), '安装').click();
    await flush();
    const inst = calls.find((c) => c.url === '/api/extensions/install');
    expect(inst?.method).toBe('POST');
    expect(inst?.body).toEqual({ name: 'found-mod', version: '3.1.0' });
    expect([...document.querySelectorAll('.modal')].pop()?.textContent).toContain('现在重启进程');
    answer(false);
    await flush();
    expect(calls.some((c) => c.url === '/api/run/restart')).toBe(false);
    expect(calls.filter((c) => c.url === '/api/extensions').length).toBe(2);
  });

  it('装完答"是" → 直接打 /api/run/restart,不再问第二遍', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    hitCards(root)[0].click();
    await flush();
    button(drawer(), '安装').click();
    await flush();
    answer(true);
    await flush();
    expect(calls.find((c) => c.url === '/api/run/restart')?.method).toBe('POST');
  });

  it('服务端拒绝 → 一行红字,不弹重启问句', async () => {
    stub({ installStatus: 400 });
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    hitCards(root)[0].click();
    await flush();
    button(drawer(), '安装').click();
    await flush();
    expect(root.querySelector('.msgline.bad')?.textContent).toContain('不是合法的 npm 包名');
    expect(document.querySelectorAll('.modal').length).toBe(1);
  });

  it('手动安装:包名走 { name, version },目录走 { path };空的不发', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    const input = root.querySelector('input.mono') as HTMLInputElement;
    button(root, '安装').click();
    await flush();
    expect(calls.some((c) => c.url === '/api/extensions/install')).toBe(false);
    input.value = '@acme/cortico-world-x@^1.2.0';
    button(root, '安装').click();
    await flush();
    expect(calls.find((c) => c.url === '/api/extensions/install')?.body).toEqual({ name: '@acme/cortico-world-x', version: '^1.2.0' });
    answer(false);
    await flush();
    input.value = '../my-module';
    button(root, '安装').click();
    await flush();
    expect(calls.filter((c) => c.url === '/api/extensions/install')[1]?.body).toEqual({ path: '../my-module' });
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

  it('四种排序各自的口径;并列时按名字', () => {
    const hits = [
      hit({ name: 'b', downloads: 5, dependents: 1, date: '2026-01-01T00:00:00.000Z' }),
      hit({ name: 'a', downloads: 5, dependents: 9, date: '2026-05-05T00:00:00.000Z' }),
      hit({ name: 'c', downloads: 90, dependents: 0 }),
    ];
    const names = (sort: string): string[] => arrangeHits(hits, opts({ sort, pageSize: 10 })).shown.map((h: Any) => h.name);
    expect(names('downloads')).toEqual(['c', 'a', 'b']);
    expect(names('dependents')).toEqual(['a', 'b', 'c']);
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

describe('parseInstallInput', () => {
  it('作用域包的第一个 @ 是名字;含路径分隔符或以 . 开头的当目录', () => {
    expect(parseInstallInput('')).toBeNull();
    expect(parseInstallInput('pkg')).toEqual({ name: 'pkg' });
    expect(parseInstallInput('pkg@1.0.0')).toEqual({ name: 'pkg', version: '1.0.0' });
    expect(parseInstallInput('@s/p')).toEqual({ name: '@s/p' });
    expect(parseInstallInput('@s/p@next')).toEqual({ name: '@s/p', version: 'next' });
    expect(parseInstallInput('./here')).toEqual({ path: './here' });
    expect(parseInstallInput('../up')).toEqual({ path: '../up' });
    expect(parseInstallInput('C:\\mods\\x')).toEqual({ path: 'C:\\mods\\x' });
    expect(parseInstallInput('/abs/dir')).toEqual({ path: '/abs/dir' });
  });
});

describe('feature 契约', () => {
  it('route 是 extensions,needsAny 是 extensions,进 Core 组', () => {
    expect(extensionsFeature.route).toBe('extensions');
    expect(extensionsFeature.needsAny).toEqual(['extensions']);
    expect(extensionsFeature.navGroup).toBe('Core');
  });

  it('卸载后不再发请求', async () => {
    stub();
    const { ctx, root, lifecycle } = mkCtx();
    mountExtensions(ctx);
    await flush();
    lifecycle.dispose();
    const before = calls.length;
    button(root, '↻ 刷新').click();
    await flush();
    expect(calls.length).toBe(before);
  });
});
