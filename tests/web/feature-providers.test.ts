/**
 * @vitest-environment jsdom
 * 使用模拟 DOM 与接口验证页面行为；浏览器源码由变量动态 import 加载，类型由 tsconfig.web.json 检查。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const UI = '../../src/web/client/ui/index.ts';
const LIFECYCLE = '../../src/web/client/core/lifecycle.ts';
const ROUTER = '../../src/web/client/core/router.ts';
const PROVIDERS = '../../src/web/client/features/providers/index.ts';

type Any = any;

const { createConsoleUi } = (await import(UI)) as Any;
const { Lifecycle } = (await import(LIFECYCLE)) as Any;
const { Router, parseHash } = (await import(ROUTER)) as Any;
const { mountProviders, providersFeature } = (await import(PROVIDERS)) as Any;

const flush = async (n = 20): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };
/** jsdom 的 hashchange 是下一个宏任务才到;等它到了再冲一遍微任务。 */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flush();
};

const MANIFEST = [
  { id: 'llm:alpha', kind: 'llm', label: '甲供应', availability: 'active', lamps: [{ label: '当前供应实例', state: 'online' }] },
  { id: 'llm:beta', kind: 'llm', label: '乙供应', availability: 'active', lamps: [{ label: '当前供应实例', state: 'offline' }] },
  { id: 'world:sample', kind: 'world', label: '样例 World', availability: 'active' },
  { id: 'persona:demo', kind: 'persona', label: '样例人格', availability: 'active' },
];

interface Fake {
  shown: Array<[string, string | undefined]>;
  hosts: Array<{ root: HTMLElement; route: (id: string, panel: string) => readonly string[] }>;
  unmounted: number;
}

/** 每个用例自己的 router 监听,用完拆掉——window 是所有用例共用的。 */
const routers: Array<{ dispose(): void }> = [];

async function mk(hash = '#/providers', manifest: unknown[] = MANIFEST): Promise<{ ctx: Any; root: HTMLElement; fake: Fake; router: Any }> {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ lamps: {} }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })));
  const root = document.createElement('div');
  document.body.appendChild(root);
  const lifecycle = new Lifecycle(() => {});
  const ui = createConsoleUi({
    memo: { get: (_k: string, d: unknown) => d, set: () => {} },
    overlayHost: document.body, signal: lifecycle.signal, doc: document,
  });
  window.location.hash = hash;
  // 写地址栏会排一个 hashchange 任务;等它过去,router 才不会把它当成一次导航
  await settle();
  const router = new Router({ win: window, onError: () => {} });
  routers.push(router.start());
  const fake: Fake = { shown: [], hosts: [], unmounted: 0 };
  const ctx = {
    ui, root, lifecycle, signal: lifecycle.signal,
    capabilities: {},
    route: parseHash(hash),
    router,
    onError: (err: unknown) => { throw err; },
    consolePageHost: (opts: Any) => {
      fake.hosts.push(opts);
      return {
        pages: manifest,
        load: async () => {},
        find: (id: string) => manifest.find((p: Any) => p.id === id),
        show: async (id: string, panel?: string) => {
          fake.shown.push([id, panel]);
          opts.root.replaceChildren();
          const chrome = document.createElement('div');
          chrome.className = 'providerchrome';
          chrome.textContent = `${id}/${panel ?? ''}`;
          opts.root.appendChild(chrome);
        },
        unmount: () => { fake.unmounted++; opts.root.replaceChildren(); },
      };
    },
  };
  return { ctx, root, fake, router };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const r of routers.splice(0)) r.dispose();
  document.body.replaceChildren();
  window.location.hash = '';
});

describe('语言模型页', () => {
  it('左栏只占一条:在「系统」组里,带图标,永远可用', () => {
    expect(providersFeature.route).toBe('providers');
    expect(providersFeature.label).toBe('语言模型');
    expect(providersFeature.navGroup).toBe('Core');
    expect(providersFeature.icon).toBe('cpu');
    expect(providersFeature.needsAny).toBeUndefined();
  });

  it('次级菜单只列 llm 类 provider,带灯;缺省选第一个并让宿主画它的首个面板', async () => {
    const { ctx, root, fake } = await mk();
    await mountProviders(ctx);
    await flush();
    const jumps = [...root.querySelectorAll('.settings-jump')] as HTMLButtonElement[];
    expect(jumps.map((j) => j.querySelector('.lbl')!.textContent)).toEqual(['甲供应', '乙供应']);
    expect(jumps.map((j) => j.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(jumps[0].querySelector('.navlamps .navdot')).not.toBeNull();
    expect(root.textContent).not.toContain('样例 World');
    expect(fake.shown).toEqual([['llm:alpha', undefined]]);
    // 宿主挂在这一页的内容区里,页签路由留在本页的前缀下
    expect(fake.hosts).toHaveLength(1);
    expect(fake.hosts[0].root.classList.contains('settings-content')).toBe(true);
    expect(fake.hosts[0].route('llm:beta', 'auth')).toEqual(['providers', 'llm:beta', 'auth']);
    expect(root.querySelector('.providerchrome')!.textContent).toBe('llm:alpha/');
  });

  it('路由第二、三段选模块与面板;点菜单项走 router,切换后高亮跟着走', async () => {
    const { ctx, root, fake, router } = await mk('#/providers/llm:beta/auth');
    await mountProviders(ctx);
    await flush();
    expect(fake.shown).toEqual([['llm:beta', 'auth']]);
    const jumps = [...root.querySelectorAll('.settings-jump')] as HTMLButtonElement[];
    expect(jumps.map((j) => j.classList.contains('active'))).toEqual([false, true]);

    jumps[0].click();
    await settle();
    expect(router.route.segments).toEqual(['providers', 'llm:alpha']);
    expect(fake.shown.at(-1)).toEqual(['llm:alpha', undefined]);
    expect(jumps.map((j) => j.classList.contains('active'))).toEqual([true, false]);

    // 不认识的模块 id 退回第一个,而不是空白
    router.navigate(['providers', 'llm:nope']);
    await settle();
    expect(fake.shown.at(-1)).toEqual(['llm:alpha', undefined]);
    // 离开这一页的路由变化不归它管
    router.navigate(['usage']);
    await settle();
    expect(fake.shown).toHaveLength(3);
  });

  it('manifest 里没有 llm provider → 占位说明,宿主不画任何面板', async () => {
    const { ctx, root, fake } = await mk('#/providers', MANIFEST.filter((p) => p.kind !== 'llm'));
    await mountProviders(ctx);
    await flush();
    expect(root.querySelectorAll('.settings-jump')).toHaveLength(0);
    expect(root.textContent).toContain('没有已注册的供应模块');
    expect(fake.shown).toEqual([]);
  });

  it('没有宿主(内核之外挂载)只给一句说明,不抛', async () => {
    const { ctx, root } = await mk();
    delete ctx.consolePageHost;
    await mountProviders(ctx);
    expect(root.textContent).toContain('语言模型设置不可用');
  });

  it('离开页面:宿主卸载,路由监听不再触发', async () => {
    const { ctx, fake, router } = await mk();
    await mountProviders(ctx);
    await flush();
    ctx.lifecycle.dispose();
    expect(fake.unmounted).toBe(1);
    router.navigate(['providers', 'llm:beta']);
    await settle();
    expect(fake.shown).toEqual([['llm:alpha', undefined]]);
  });
});
