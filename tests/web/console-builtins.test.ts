/** 内置面板通过 registry 解析，不要求贡献方提供浏览器产物。 */
import { describe, expect, it, vi } from 'vitest';

const HOST = '../../src/web/client/console-pages/host.ts';
const LOADER = '../../src/web/client/console-pages/loader.ts';
const BUILTINS = '../../src/web/client/console-pages/builtins.ts';
const JSDOM_MODULE = 'jsdom';

type Any = any;

const { ConsolePageHost } = (await import(HOST)) as Any;
const { ConsolePageLoader } = (await import(LOADER)) as Any;
const { BUILTIN_PANELS } = (await import(BUILTINS)) as Any;
const { JSDOM } = (await import(JSDOM_MODULE)) as Any;

const dom = new JSDOM('<!doctype html><body></body>');
vi.stubGlobal('AbortController', dom.window.AbortController);

/** 插槽里的面板被结束时记一笔,供断言宿主确实收了场。 */
const slotDisposals: string[] = [];

const FAKE_BUILTINS = {
  'demo-settings': {
    mount: (ctx: Any) => { ctx.root.appendChild(ctx.ui.msgline('内置面板挂上了')); },
  },
  'slot-host': {
    mount: async (ctx: Any) => {
      const box = ctx.ui.h('div');
      ctx.root.append(ctx.ui.msgline('宿主面板挂上了'), box);
      const handle = await ctx.mountSlot('instance', box, { instance: 'primary' });
      ctx.root.appendChild(ctx.ui.button('收起段落', { onClick: () => handle.dispose() }));
    },
  },
};

const BUNDLE_JS = '/assets/providers/llm-beta-A1B2.js';

/** 全是内置面板,**没有** client:这一页压根没构建出浏览器产物。 */
const ALL_BUILTIN = {
  id: 'llm:alpha', kind: 'llm', label: '甲端点', availability: 'active',
  panels: [{ id: 'settings', title: '实例与模型', builtin: 'demo-settings' }],
};
/** 内置 + 自有各一块,两条路在同一页上并存。 */
const MIXED = {
  id: 'llm:beta', kind: 'llm', label: '乙端点', availability: 'active',
  panels: [
    { id: 'settings', title: '实例与模型', builtin: 'demo-settings' },
    { id: 'own', title: '自有面板' },
  ],
  client: { js: BUNDLE_JS },
};
/** 宿主面板开一个插槽,页面自己的面板挂进去,不占页签。 */
const SLOTTED = {
  id: 'llm:delta', kind: 'llm', label: '丁端点', availability: 'active',
  panels: [
    { id: 'settings', title: '实例与模型', builtin: 'slot-host' },
    { id: 'runtime', title: '运行时', slot: 'instance' },
  ],
  client: { js: BUNDLE_JS },
};
/** 内核不认识的名字。 */
const UNKNOWN_BUILTIN = {
  id: 'llm:gamma', kind: 'llm', label: '丙端点', availability: 'active',
  panels: [{ id: 'settings', title: '实例与模型', builtin: 'nope' }],
};

function stage(pages: unknown[]) {
  const doc = dom.window.document as Any;
  doc.body.replaceChildren();
  const root = doc.createElement('div');
  const overlayHost = doc.createElement('div');
  doc.body.append(root, overlayHost);
  const imported: string[] = [];
  const errors: unknown[] = [];
  const loader = new ConsolePageLoader({
    importModule: async (url: string) => {
      imported.push(url);
      return {
        default: {
          panels: {
            own: { mount: (ctx: Any) => { ctx.root.appendChild(ctx.ui.msgline('自有面板挂上了')); } },
            runtime: {
              mount: (ctx: Any) => {
                ctx.root.appendChild(ctx.ui.msgline(`段落挂上了:${ctx.scope.instance}`));
                return { dispose: () => slotDisposals.push(ctx.panelId) };
              },
            },
          },
        },
      };
    },
    styleHost: { appendChild: () => {} },
    createLink: () => ({ rel: '', href: '', dataset: {} }),
  });
  const host = new ConsolePageHost({
    doc,
    root,
    overlayHost,
    loader,
    builtins: FAKE_BUILTINS,
    router: { addLeaveGuard: () => ({ dispose: () => {} }), navigate: () => {} },
    fetchManifest: async () => ({
      protocolVersion: 1, providers: pages, framework: { capabilities: {} },
    }),
    memo: { get: (_k: string, fb: unknown): unknown => fb, set: () => {} },
    createSocket: () => ({ close: () => {}, send: () => {} }),
    wsUrl: (p: string) => `ws://test${p}`,
    onError: (err: unknown) => { errors.push(err); },
  });
  return { host, imported, errors, root, text: (): string => root.textContent };
}

describe('内置面板的挂载', () => {
  it('全是内置面板的页没有 client 也照常挂上,加载器一次都没被调到', async () => {
    const s = stage([ALL_BUILTIN]);
    await s.host.load();
    await s.host.show('llm:alpha', 'settings');
    expect(s.text()).toContain('内置面板挂上了');
    expect(s.imported).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it('同一页里内置与自有面板各走各的路', async () => {
    const s = stage([MIXED]);
    await s.host.load();
    await s.host.show('llm:beta', 'settings');
    expect(s.text()).toContain('内置面板挂上了');
    expect(s.imported).toEqual([]);

    await s.host.show('llm:beta', 'own');
    expect(s.text()).toContain('自有面板挂上了');
    expect(s.imported).toEqual([BUNDLE_JS]);
  });

  it('未知内置面板显示可用面板列表，其他页面仍可挂载', async () => {
    const s = stage([UNKNOWN_BUILTIN, MIXED]);
    await s.host.load();
    await expect(s.host.show('llm:gamma', 'settings')).resolves.toBeUndefined();
    expect(s.text()).toContain('内置面板「nope」不存在');
    expect(s.text()).toContain('demo-settings');
    expect(s.errors).toHaveLength(1);
    expect(s.imported).toEqual([]);

    await s.host.show('llm:beta', 'settings');
    expect(s.text()).toContain('内置面板挂上了');
    expect(s.text()).not.toContain('nope');
  });
});

describe('面板插槽', () => {
  it('带 slot 的面板挂进宿主给的容器,拿到宿主给的作用域,且不出现在页签上', async () => {
    slotDisposals.length = 0;
    const s = stage([SLOTTED]);
    await s.host.load();
    await s.host.show('llm:delta');
    expect(s.text()).toContain('宿主面板挂上了');
    expect(s.text()).toContain('段落挂上了:primary');
    expect(s.imported).toEqual([BUNDLE_JS]);
    // 只剩一块独立面板,页签整条不画
    expect(s.root.querySelector('.providerchrome button')).toBeNull();
  });

  it('宿主结束插槽时段落跟着结束;离开这一页也一样', async () => {
    slotDisposals.length = 0;
    const s = stage([SLOTTED, MIXED]);
    await s.host.load();
    await s.host.show('llm:delta');
    (s.root.querySelector('button') as Any).click();
    expect(slotDisposals).toEqual(['runtime']);

    await s.host.show('llm:delta');
    expect(s.text()).toContain('段落挂上了:primary');
    await s.host.show('llm:beta', 'settings');
    expect(slotDisposals).toEqual(['runtime', 'runtime']);
  });
});

describe('内核自带的那张表', () => {
  it('端点表面板在表里,键就是服务端声明的那个名字', () => {
    expect(Object.keys(BUILTIN_PANELS)).toContain('llm-settings');
    expect(typeof BUILTIN_PANELS['llm-settings'].mount).toBe('function');
  });
});
