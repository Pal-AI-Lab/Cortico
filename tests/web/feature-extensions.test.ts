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
const { mountExtensions, parseInstallInput, extensionsFeature } = (await import(EXTENSIONS)) as Any;

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
    { name: 'found-mod', version: '3.1.0', description: '搜到的', downloads: 42, publisher: 'someone', links: { npm: 'https://npm.example/found', repository: 'https://git.example/found' }, installed: false, kind: 'world' },
    { name: 'alpha-mod', version: '1.0.0', description: '已经装了', downloads: 7, links: {}, installed: true, kind: 'world' },
  ],
};

let calls: Array<{ url: string; method: string; body: Any }> = [];

function stub(over: { list?: unknown; installStatus?: number } = {}): void {
  vi.stubGlobal('fetch', (url: unknown, init: Any) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET');
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let status = 200;
    let body: unknown = {};
    if (u === '/api/extensions') body = over.list ?? LIST;
    else if (u.startsWith('/api/extensions/search')) body = HITS;
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
  const modal = document.querySelector('.modal');
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

describe('搜索与安装', () => {
  it('搜索打 /api/extensions/search?q=&kind=;命中各一张卡,已装的那颗键禁掉', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    const input = root.querySelector('input[type=search]') as HTMLInputElement;
    input.value = 'disc ord';
    button(root, '搜索').click();
    await flush();
    expect(calls.some((c) => c.url === '/api/extensions/search?q=disc%20ord&kind=world')).toBe(true);
    const found = cardOf(root, 'found-mod');
    expect(found.textContent).toContain('搜到的');
    expect(found.textContent).toContain('月下载 42');
    expect(buttons(found).map((b) => b.textContent)).toEqual(expect.arrayContaining(['npm', '仓库', '安装']));
    expect(button(found, '安装').disabled).toBe(false);
    const already = [...root.querySelectorAll('.iocard')].filter((c) => c.querySelector('h3')?.textContent?.startsWith('alpha-mod'));
    const hit = already[already.length - 1] as HTMLElement;
    expect(button(hit, '已安装').disabled).toBe(true);
    expect(found.textContent).toContain('World');
  });

  it('kind 分段控件默认 worlds;切到 provider 换关键字、清掉上一类的命中、请求带新 kind', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    const seg = root.querySelector('.segwrap') as HTMLElement;
    expect([...seg.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['World', 'LLM Provider', 'Bot']);
    expect(seg.querySelector('.seg.active')?.textContent).toBe('World');
    expect(root.textContent).toContain('cortico-world');
    expect(root.textContent).not.toContain('cortico-provider');

    button(root, '搜索').click();
    await flush();
    expect(cardOf(root, 'found-mod')).toBeTruthy();

    button(seg, 'LLM Provider').click();
    await flush();
    expect(root.textContent).toContain('cortico-provider');
    expect([...root.querySelectorAll('.iocard')].some((c) => c.querySelector('h3')?.textContent?.startsWith('found-mod'))).toBe(false);

    button(root, '搜索').click();
    await flush();
    expect(calls.filter((c) => c.url.startsWith('/api/extensions/search')).map((c) => c.url)).toEqual([
      '/api/extensions/search?q=&kind=world',
      '/api/extensions/search?q=&kind=provider',
    ]);
  });

  it('安装打 install 端点,载荷 { name, version };装完问要不要重启,答"否"就停在清单', async () => {
    stub();
    const { ctx, root } = mkCtx();
    mountExtensions(ctx);
    await flush();
    button(root, '搜索').click();
    await flush();
    button(cardOf(root, 'found-mod'), '安装').click();
    await flush();
    const inst = calls.find((c) => c.url === '/api/extensions/install');
    expect(inst?.method).toBe('POST');
    expect(inst?.body).toEqual({ name: 'found-mod', version: '3.1.0' });
    expect(document.querySelector('.modal')?.textContent).toContain('现在重启进程');
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
    button(root, '搜索').click();
    await flush();
    button(cardOf(root, 'found-mod'), '安装').click();
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
    button(root, '搜索').click();
    await flush();
    button(cardOf(root, 'found-mod'), '安装').click();
    await flush();
    expect(root.querySelector('.msgline.bad')?.textContent).toContain('不是合法的 npm 包名');
    expect(document.querySelector('.modal')).toBeNull();
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
