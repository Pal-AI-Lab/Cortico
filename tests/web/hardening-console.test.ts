/**
 * 扩展失败须隔离为该面板的错误卡；涵盖同步抛错、异步 reject、无效导出和面板缺失。
 * 卸载须释放定时器、动画帧、observer、监听、fetch、音频、ObjectURL、流通道、离开拦截和浮层；重复挂卸十次检查资源是否累积。
 * 未访问的 provider 不 import，已访问的只 import 一次，加载失败不能缓存。
 * 动态 import 隔离 Node/DOM 类型检查。迷你 DOM 实现 signal/once；RAF、ResizeObserver、AudioContext、ObjectURL、fetch、WebSocket 夹具均可计数。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const HOST_SPEC = '../../src/web/client/console-pages/host.ts';
const LOADER_SPEC = '../../src/web/client/console-pages/loader.ts';
const CONTEXT_SPEC = '../../src/web/client/console-pages/context.ts';
const BUNDLE_SPEC = '../../src/web/shared/client-panel.ts';
const HANDOFF_SPEC = '../../src/web/client/theme/handoff.ts';

type Any = any;

const { ConsolePageHost } = (await import(HOST_SPEC)) as Any;
const { ConsolePageLoader } = (await import(LOADER_SPEC)) as Any;
const { namespacedMemo } = (await import(CONTEXT_SPEC)) as Any;
const { toDisposable, ConsoleInvokeError } = (await import(BUNDLE_SPEC)) as Any;
const { THEME_HANDOFF_FRAGMENT_KEY } = (await import(HANDOFF_SPEC)) as Any;

// ---------------------------------------------------------------------------
// 迷你 DOM
// ---------------------------------------------------------------------------

type Listener = (ev: Any) => void;
interface ListenOptions { signal?: AbortSignal; once?: boolean }

class Listeners {
  private map = new Map<string, Listener[]>();

  add(type: string, fn: Listener, opts?: ListenOptions): void {
    if (opts?.signal?.aborted) return;
    const wrapped: Listener = opts?.once
      ? (ev) => { this.remove(type, wrapped); fn(ev); }
      : fn;
    const arr = this.map.get(type) ?? [];
    arr.push(wrapped);
    this.map.set(type, arr);
    opts?.signal?.addEventListener('abort', () => this.remove(type, wrapped), { once: true });
  }

  remove(type: string, fn: Listener): void {
    const arr = this.map.get(type) ?? [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
    this.map.set(type, arr);
  }

  fire(type: string, ev: Any): void {
    for (const fn of (this.map.get(type) ?? []).slice()) fn(ev);
  }

  /** 全部类型加起来还挂着几条——"归零"要数的是这个，不是某一种。 */
  total(): number {
    let n = 0;
    for (const arr of this.map.values()) n += arr.length;
    return n;
  }

  count(type: string): number {
    return (this.map.get(type) ?? []).length;
  }
}

class FakeEl {
  readonly tagName: string;
  readonly ownerDocument: FakeDoc;
  readonly nodeType = 1;
  className = '';
  type = '';
  open = false;
  value = '';
  disabled = false;
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  listeners = new Listeners();
  ownText = '';

  constructor(tag: string, doc: FakeDoc) {
    this.tagName = tag;
    this.ownerDocument = doc;
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.ownText = v;
  }

  appendChild(node: FakeEl): FakeEl {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    this.children.push(node);
    return node;
  }
  append(...nodes: FakeEl[]): void {
    for (const n of nodes) this.appendChild(n);
  }
  /** host 靠它换掉整块内容（页头 / 面板槽）。 */
  replaceChildren(...nodes: FakeEl[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    for (const n of nodes) this.appendChild(n);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  focus(): void {}
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.remove(type, fn);
  }
  dispatchEvent(ev: Any): void {
    if (ev.target === undefined) ev.target = this;
    let node: FakeEl | null = this;
    while (node) {
      node.listeners.fire(ev.type, ev);
      node = node.parent;
    }
  }
}

class FakeDoc {
  listeners = new Listeners();
  body: FakeEl;
  defaultView: Any = undefined;
  constructor() { this.body = new FakeEl('body', this); }
  createElement(tag: string): FakeEl { return new FakeEl(tag, this); }
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
  dispatchEvent(ev: Any): void { this.listeners.fire(ev.type, ev); }
}

// ---------------------------------------------------------------------------
// 可计数的全局假件
// ---------------------------------------------------------------------------

interface FakeRaf {
  pending: Map<number, (now: number) => void>;
  requested: number;
  cancelled: number[];
  tick(now: number): void;
}

function installFakeRaf(): FakeRaf {
  let seq = 0;
  const pending = new Map<number, (now: number) => void>();
  const state: FakeRaf = {
    pending,
    requested: 0,
    cancelled: [],
    tick(now: number) {
      const batch = [...pending.values()];
      pending.clear();
      for (const cb of batch) cb(now);
    },
  };
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void): number => {
    state.requested += 1;
    seq += 1;
    pending.set(seq, cb);
    return seq;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    state.cancelled.push(id);
    pending.delete(id);
  });
  return state;
}

/** 造了几个、还活着几个——泄漏测试真正的度量。 */
interface Census { created: number; live: number }

function installFakeResizeObserver(): Census {
  const census: Census = { created: 0, live: 0 };
  class FakeResizeObserver {
    private done = false;
    constructor(_cb: unknown) { census.created += 1; census.live += 1; }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      if (this.done) return;
      this.done = true;
      census.live -= 1;
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return census;
}

function installFakeAudioContext(): Census {
  const census: Census = { created: 0, live: 0 };
  class FakeAudioContext {
    private done = false;
    state = 'running';
    constructor() { census.created += 1; census.live += 1; }
    async close(): Promise<void> {
      if (this.done) return;
      this.done = true;
      this.state = 'closed';
      census.live -= 1;
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return census;
}

function installFakeObjectUrl(): Census {
  const census: Census = { created: 0, live: 0 };
  let seq = 0;
  const live = new Set<string>();
  vi.stubGlobal('__objectUrl', {
    create(): string {
      census.created += 1;
      census.live += 1;
      seq += 1;
      const u = `blob:test/${seq}`;
      live.add(u);
      return u;
    },
    revoke(u: string): void {
      if (!live.delete(u)) return;
      census.live -= 1;
    },
  });
  return census;
}

/** ObjectURL 的取用口。真实扩展写 `URL.createObjectURL`，这里换成同形状的假件。 */
function objectUrl(): { create(): string; revoke(u: string): void } {
  return (globalThis as Any).__objectUrl;
}

interface FetchCensus {
  started: number;
  live: number;
  aborted: number;
  /** 每次请求带没带 signal——扩展绕过 ctx 自己 fetch 的话这里会露馅。 */
  withSignal: number;
}

function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

/** 永不 resolve 的 fetch：只有 abort 能让它结束。挂起的请求就该这么模拟。 */
function installPendingFetch(): FetchCensus {
  const census: FetchCensus = { started: 0, live: 0, aborted: 0, withSignal: 0 };
  vi.stubGlobal('fetch', (_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      census.started += 1;
      census.live += 1;
      const signal = init?.signal;
      if (signal) census.withSignal += 1;
      const bail = (): void => {
        census.live -= 1;
        census.aborted += 1;
        reject(abortError());
      };
      if (signal?.aborted) { bail(); return; }
      signal?.addEventListener('abort', bail, { once: true });
    }));
  return census;
}

class FakeSocket {
  readyState = 0;
  closed = false;
  onopen: Any = null;
  onclose: Any = null;
  onerror: Any = null;
  onmessage: Any = null;
  sent: string[] = [];
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
}

// ---------------------------------------------------------------------------
// 舞台：一个真 ConsolePageHost + 真 ConsolePageLoader，只有 import 与网络是假的
// ---------------------------------------------------------------------------

interface PanelDecl { id: string; title: string }
interface ProviderDecl {
  id: string;
  kind?: string;
  label: string;
  panels?: PanelDecl[];
  client?: { js: string; css?: string };
  badges?: { label: string; value: string | number; tone?: string }[];
  links?: Array<{ label: string; href: string; inheritTheme?: boolean }>;
  /** 这个 provider 认领的配置组 id(归属),参数页据此只画自己那几组。 */
  configGroups?: string[];
  /** 这个 provider 声明的存储项 key,数据页签据此只画自己那几项。 */
  storageKeys?: string[];
}

interface Stage {
  doc: FakeDoc;
  root: FakeEl;
  overlayHost: FakeEl;
  host: Any;
  loader: Any;
  importModule: Any;
  errors: unknown[];
  guards: Set<unknown>;
  sockets: FakeSocket[];
  navigated: string[][];
  /** 页头容器（第 0 格）与面板槽（第 1 格）。host 建好之前是 undefined。 */
  chrome(): FakeEl | undefined;
  slot(): FakeEl | undefined;
  text(): string;
  slotText(): string;
}

function fakeMemo(): Any {
  const store: Record<string, unknown> = {};
  return {
    get<T>(key: string, fallback: T): T { return key in store ? (store[key] as T) : fallback; },
    set(key: string, value: unknown): void { store[key] = value; },
  };
}

/**
 * `worlds` 是 URL → 模块工厂。工厂可以正常返回、可以抛（= 加载失败）、
 * 也可以返回 promise（= 网络慢）。`ConsolePageLoader` 本身是真的。
 */
function makeStage(
  providers: ProviderDecl[],
  worlds: Record<string, () => unknown>,
  protocolVersion = 1,
): Stage {
  const doc = new FakeDoc();
  const root = doc.createElement('div');
  const overlayHost = doc.createElement('div');
  doc.body.append(root, overlayHost);

  const errors: unknown[] = [];
  const importModule = vi.fn(async (url: string) => {
    const make = worlds[url];
    if (!make) throw new Error(`404 ${url}`);
    return await make();
  });
  const loader = new ConsolePageLoader({
    importModule,
    styleHost: { appendChild: () => {} },
    createLink: () => ({ rel: '', href: '', dataset: {} as Record<string, string> }),
  });

  const guards = new Set<unknown>();
  const navigated: string[][] = [];
  const router = {
    addLeaveGuard(fn: unknown) {
      guards.add(fn);
      return { dispose: () => { guards.delete(fn); } };
    },
    navigate(segs: string[]) { navigated.push(segs); },
  };

  const sockets: FakeSocket[] = [];
  const host = new ConsolePageHost({
    doc,
    root,
    overlayHost,
    loader,
    router,
    fetchManifest: async () => ({
      protocolVersion,
      providers: providers.map((p) => ({ kind: 'world', availability: 'active', ...p })),
      framework: { capabilities: {} },
    }),
    memo: fakeMemo(),
    createSocket: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    wsUrl: (path: string) => `ws://test${path}`,
    onError: (err: unknown) => { errors.push(err); },
  });

  return {
    doc, root, overlayHost, host, loader, importModule, errors, guards, sockets, navigated,
    chrome: () => root.children[0],
    slot: () => root.children[1],
    text: () => root.textContent,
    slotText: () => root.children[1]?.textContent ?? '',
  };
}

const JS = (name: string): string => `/assets/${name}.a1b2c3.js`;

function buttonWithText(root: FakeEl | undefined, text: string): FakeEl | undefined {
  if (!root) return undefined;
  if (root.tagName === 'button' && root.textContent === text) return root;
  for (const child of root.children) {
    const found = buttonWithText(child, text);
    if (found) return found;
  }
  return undefined;
}

/** 在 fake timers 下推进微任务，完成 import、mount 与 abort 的异步链。 */
async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** 一个最简单的能挂的扩展：往 root 里写一句话。 */
function helloBundle(mark: string, onMount?: (ctx: Any) => void): Any {
  return {
    default: {
      panels: {
        one: {
          mount(ctx: Any) {
            ctx.root.appendChild(ctx.ui.msgline(`${mark}:one 挂上了`));
            onMount?.(ctx);
          },
        },
        two: {
          mount(ctx: Any) {
            ctx.root.appendChild(ctx.ui.msgline(`${mark}:two 挂上了`));
            onMount?.(ctx);
          },
        },
      },
    },
  };
}

describe('provider 独立页面入口', () => {
  it('显式继承主题的链接使用点击时快照，并保留 noopener', async () => {
    const stage = makeStage([{
      id: 'world:a',
      label: 'A World',
      links: [{
        label: '打开编辑器',
        href: 'http://127.0.0.1:9000/editor?room=7',
        inheritTheme: true,
      }],
    }], {});
    const documentElement = new FakeEl('html', stage.doc);
    documentElement.setAttribute('data-color-mode', 'light');
    (stage.doc as Any).documentElement = documentElement;
    const opened: Array<[string, string, string]> = [];
    stage.doc.defaultView = {
      getComputedStyle: () => ({
        getPropertyValue: (name: string) => name === '--accent' ? '#abcdef' : '',
      }),
      open: (href: string, target: string, features: string) => {
        opened.push([href, target, features]);
      },
    };

    await stage.host.load();
    await stage.host.show('world:a');
    buttonWithText(stage.chrome(), '打开编辑器')!.dispatchEvent({ type: 'click' });

    expect(opened).toHaveLength(1);
    expect(opened[0][0]).toMatch(
      new RegExp(
        `^http://127\\.0\\.0\\.1:9000/editor\\?room=7#${THEME_HANDOFF_FRAGMENT_KEY}=[A-Za-z0-9_-]+$`,
        'u',
      ),
    );
    expect(opened[0].slice(1)).toEqual(['_blank', 'noopener']);
  });
});

const TWO_PANELS: PanelDecl[] = [{ id: 'one', title: '第一格' }, { id: 'two', title: '第二格' }];

// ===========================================================================
// ===========================================================================

describe('扩展失败隔离', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeRaf();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** 造一个只有 A 一个 provider 的舞台，A 的扩展由调用方给。 */
  function solo(mod: () => unknown, panels: PanelDecl[] = TWO_PANELS): Stage {
    return makeStage(
      [{ id: 'world:a', label: 'A World', panels, client: { js: JS('a') } }],
      { [JS('a')]: mod },
    );
  }

  it('mount 同步抛错 → 那一格变错误卡，页头照常，框架其余部分不受影响', async () => {
    const stage = solo(() => ({
      default: { panels: { one: { mount() { throw new Error('扩展在 mount 里炸了'); } } } },
    }));
    await stage.host.load();
    await stage.host.show('world:a', 'one');

    // 那一格：错误卡，写着面板名与原因
    expect(stage.slotText()).toContain('第一格');
    expect(stage.slotText()).toContain('扩展在 mount 里炸了');
    // 页头照常：provider 的名字、id 都还在
    expect(stage.chrome()?.textContent).toContain('A World');
    expect(stage.chrome()?.textContent).toContain('world:a');
    // 框架拿到了诊断，不是静默吞掉
    expect(stage.errors).toHaveLength(1);
    // 结构没塌：页头 + 面板槽两个容器都在
    expect(stage.root.children).toHaveLength(2);
  });

  it('mount 返回的 promise reject → 同样是错误卡，不是空白', async () => {
    const stage = solo(() => ({
      default: {
        panels: { one: { mount: async () => { throw new Error('异步 mount 失败了'); } } },
      },
    }));
    await stage.host.load();
    await stage.host.show('world:a', 'one');

    expect(stage.slotText()).toContain('异步 mount 失败了');
    expect(stage.slot()?.children.length).toBeGreaterThan(0);
    expect(stage.errors).toHaveLength(1);
  });

  it('bundle 本身 import 失败（404 / 语法错）→ 错误卡里带上原始错误', async () => {
    const stage = solo(() => { throw new Error('Unexpected token'); });
    await stage.host.load();
    await stage.host.show('world:a', 'one');

    expect(stage.slotText()).toContain('加载失败');
    expect(stage.slotText()).toContain('Unexpected token');
  });

  it('default export 不是扩展（数字 / 数组 / 缺 default / 整个模块是 null）→ 明确报错而不是空白', async () => {
    const bad: [string, unknown][] = [
      ['数字', { default: 42 }],
      ['字符串', { default: 'extension' }],
      ['null', { default: null }],
      ['panels 是数组', { default: { panels: [] } }],
      ['panels 是字符串', { default: { panels: 'x' } }],
      ['空对象', { default: {} }],
      ['缺 default', { panels: { one: { mount() {} } } }],
      ['模块是 null', null],
    ];
    for (const [name, mod] of bad) {
      const stage = solo(() => mod);
      await stage.host.load();
      await stage.host.show('world:a', 'one');
      expect([name, stage.slot()?.children.length ?? 0]).toEqual([name, 1]);
      expect([name, stage.slotText().includes('default')]).toEqual([name, true]);
      expect([name, stage.slotText().includes('world:a')]).toEqual([name, true]);
    }
  });

  it('声明了 panel 但扩展里没有那个键 → 错误信息列出它实际提供的面板名', async () => {
    const stage = makeStage(
      [{
        id: 'world:a',
        label: 'A World',
        panels: [{ id: 'ghost', title: '幽灵面板' }],
        client: { js: JS('a') },
      }],
      {
        [JS('a')]: () => ({
          default: { panels: { one: { mount() {} }, two: { mount() {} } } },
        }),
      },
    );
    await stage.host.load();
    await stage.host.show('world:a', 'ghost');

    const txt = stage.slotText();
    expect(txt).toContain('ghost');
    expect(txt).toContain('one');
    expect(txt).toContain('two');
  });

  it('扩展一个面板都没有时，列表退化成「(无)」而不是一句空话', async () => {
    const stage = solo(() => ({ default: { panels: {} } }), [{ id: 'one', title: '第一格' }]);
    await stage.host.load();
    await stage.host.show('world:a', 'one');
    expect(stage.slotText()).toContain('(无)');
  });

  it('mount 不是函数时报告无效的面板实现', async () => {
    const stage = solo(() => ({
      default: { panels: { one: { mount: 'not a function' }, two: { mount() {} } } },
    }));
    await stage.host.load();
    await stage.host.show('world:a', 'one');

    const txt = stage.slotText();
    expect(txt).toContain('mount');
    expect(txt).not.toContain('可用面板');
  });

  it('面板值缺少 mount 函数时报告实现错误', async () => {
    for (const impl of [[], 'x', { mounted: true }, 42, { mount: null }]) {
      const stage = solo(() => ({ default: { panels: { one: impl, two: { mount() {} } } } }));
      await stage.host.load();
      await stage.host.show('world:a', 'one');
      const txt = stage.slotText();
      expect([String(impl), txt.includes('mount')]).toEqual([String(impl), true]);
    }
  });

  it('面板键存在但值为假值时报告实现错误', async () => {
    for (const impl of [null, undefined, 0, '', false]) {
      const stage = solo(() => ({ default: { panels: { one: impl, two: { mount() {} } } } }));
      await stage.host.load();
      await stage.host.show('world:a', 'one');
      const txt = stage.slotText();
      expect([String(impl), txt.includes('mount')]).toEqual([String(impl), true]);
      expect([String(impl), txt.includes('没有面板「one」')]).toEqual([String(impl), false]);
    }
  });

  it('一个 provider 的扩展加载失败，另一个 provider 照常（重点）', async () => {
    const stage = makeStage(
      [
        { id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js: JS('a') } },
        { id: 'world:b', label: 'B World', panels: TWO_PANELS, client: { js: JS('b') } },
      ],
      {
        [JS('a')]: () => { throw new Error('A 的 bundle 坏了'); },
        [JS('b')]: () => helloBundle('B'),
      },
    );
    await stage.host.load();

    await stage.host.show('world:a', 'one');
    expect(stage.slotText()).toContain('A 的 bundle 坏了');

    // 换到 B：照常挂载，看不到 A 的任何残迹
    await stage.host.show('world:b', 'one');
    expect(stage.slotText()).toContain('B:one 挂上了');
    expect(stage.slotText()).not.toContain('A 的 bundle');
    expect(stage.chrome()?.textContent).toContain('B World');

    // 反向也成立：先进好的，再进坏的，好的那次不受牵连
    await stage.host.show('world:a', 'one');
    expect(stage.slotText()).toContain('A 的 bundle 坏了');
    await stage.host.show('world:b', 'two');
    expect(stage.slotText()).toContain('B:two 挂上了');

    expect(stage.loader.loadedPages).toEqual(['world:b']);
  });

  it('同一 provider 内：一个面板炸了，它的另一个面板照常挂', async () => {
    const stage = solo(() => ({
      default: {
        panels: {
          one: { mount() { throw new Error('第一格炸了'); } },
          two: { mount(ctx: Any) { ctx.root.appendChild(ctx.ui.msgline('第二格好好的')); } },
        },
      },
    }));
    await stage.host.load();
    await stage.host.show('world:a', 'one');
    expect(stage.slotText()).toContain('第一格炸了');

    await stage.host.show('world:a', 'two');
    expect(stage.slotText()).toContain('第二格好好的');
    expect(stage.slotText()).not.toContain('第一格炸了');
  });

  it('mount 抛错前登记的资源被释放：错误卡不该留下一屋子定时器', async () => {
    const raf = installFakeRaf();
    const stage = solo(() => ({
      default: {
        panels: {
          one: {
            mount(ctx: Any) {
              ctx.interval(() => {}, 100);
              ctx.timeout(() => {}, 100);
              ctx.frame(() => {});
              ctx.own({ dispose: () => {} });
              throw new Error('登记完才炸');
            },
          },
        },
      },
    }));
    await stage.host.load();
    await stage.host.show('world:a', 'one');

    expect(stage.slotText()).toContain('登记完才炸');
    expect(vi.getTimerCount()).toBe(0);
    expect(raf.pending.size).toBe(0);
  });

  it('挂坏一格之后 host.refresh() 照常工作：框架没被带死', async () => {
    const stage = solo(() => ({
      default: { panels: { one: { mount() { throw new Error('炸'); } } } },
    }));
    await stage.host.load();
    await stage.host.show('world:a', 'one');

    await expect(stage.host.refresh()).resolves.toBeUndefined();
    expect(stage.chrome()?.textContent).toContain('A World');
    // refresh 只刷页头，不重挂面板——错误卡还在原地
    expect(stage.slotText()).toContain('炸');
  });

  it('provider 声明了面板但整个没构建出扩展 → 错误卡指路 pnpm build:web', async () => {
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: TWO_PANELS }], // 没有 client
      {},
    );
    await stage.host.load();
    await stage.host.show('world:a', 'one');
    expect(stage.slotText()).toContain('pnpm build:web');
    expect(stage.importModule).not.toHaveBeenCalled();
  });

  it('manifest 里的 client.js 不合法 → 拒绝加载，且 importModule 一次都没被调用（安全断言）', async () => {
    for (const js of [
      'http://evil.example/x.js',
      '//evil.example/x.js',
      '/assets/../../etc/passwd',
      '/assets/%2e%2e/x.js',
      'javascript:alert(1)',
      'file:///C:/x.js',
      '/other/x.js',
    ]) {
      const stage = makeStage(
        [{ id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js } }],
        { [js]: () => helloBundle('A') }, // 就算真有这么个模块也不许拿
      );
      await stage.host.load();
      await stage.host.show('world:a', 'one');
      expect([js, stage.slotText().includes('不合法')]).toEqual([js, true]);
      expect([js, stage.importModule.mock.calls.length]).toEqual([js, 0]);
    }
  });

  it('协议版本不匹配时拒绝渲染并报告版本错误', async () => {
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js: JS('a') } }],
      { [JS('a')]: () => helloBundle('A') },
      999, // 一个前端"不认识"的协议版本
    );
    await stage.host.load();

    expect(stage.host.pages).toEqual([]);
    expect(stage.errors.map(String).join()).toContain('协议版本');
    expect(stage.errors.map(String).join()).toContain('999');
  });

  it('provider 不存在 / 面板 id 不存在 → 各自一张写清楚的卡，不是空白', async () => {
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js: JS('a') } }],
      { [JS('a')]: () => helloBundle('A') },
    );
    await stage.host.load();

    await stage.host.show('world:nope', 'one');
    expect(stage.text()).toContain('控制台页面不存在');
    expect(stage.text()).toContain('world:nope');

    await stage.host.show('world:a', 'nope');
    expect(stage.slotText()).toContain('没有面板');
    expect(stage.slotText()).toContain('one / two');
    expect(stage.importModule).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// ===========================================================================

describe('memo 的命名空间隔离', () => {
  function backing(): Any {
    const store: Record<string, unknown> = {};
    return {
      store,
      get<T>(k: string, fb: T): T { return k in store ? (store[k] as T) : fb; },
      set(k: string, v: unknown): void { store[k] = v; },
    };
  }

  it('两个 provider 用同一个 panel id、同一个键：互不顶掉', () => {
    const back = backing();
    const a = namespacedMemo(back, 'world:chat', 'gate');
    const b = namespacedMemo(back, 'world:vtuber', 'gate');
    a.set('fold:x', 'A 的值');
    b.set('fold:x', 'B 的值');
    expect(a.get('fold:x', null)).toBe('A 的值');
    expect(b.get('fold:x', null)).toBe('B 的值');
    // 同一 provider 的两个面板之间同样隔离
    const a2 = namespacedMemo(back, 'world:chat', 'voice');
    expect(a2.get('fold:x', '缺省')).toBe('缺省');
  });

  it('provider id 互为前缀时也不撞车（分隔符必须真的在）', () => {
    const back = backing();
    const one = namespacedMemo(back, 'world:abc', 'd');
    const two = namespacedMemo(back, 'world:ab', 'cd');
    one.set('k', '来自 worlds:abc/d');
    expect(two.get('k', null)).toBeNull();
    two.set('k', '来自 worlds:ab/cd');
    expect(one.get('k', null)).toBe('来自 worlds:abc/d');
    // 键本身也在命名空间之内：不同键不会因为拼接而互相变成对方
    one.set('a', 1);
    expect(namespacedMemo(back, 'world:abc', 'd').get('a', null)).toBe(1);
    expect(Object.keys(back.store)).toHaveLength(3);
  });
});

// ===========================================================================
// ===========================================================================

/** "什么都借"的扩展借到手的东西，测试从这里读回来。 */
interface Borrowed {
  ticks: number;
  lateTimeouts: number;
  frames: number;
  events: number;
  invokeErrors: unknown[];
  ctx: Any;
  /** mount 返回的 Disposable 被调过没有 */
  returnedDisposed: number;
}

interface Greedy {
  mod: () => unknown;
  rec: Borrowed;
}

function greedyBundle(): Greedy {
  const rec: Borrowed = {
    ticks: 0,
    lateTimeouts: 0,
    frames: 0,
    events: 0,
    invokeErrors: [],
    ctx: null,
    returnedDisposed: 0,
  };
  const mod = (): unknown => ({
    default: {
      panels: {
        one: {
          mount(ctx: Any) {
            rec.ctx = ctx;

            ctx.interval(() => { rec.ticks += 1; }, 100);
            ctx.timeout(() => { rec.lateTimeouts += 1; }, 5000);
            ctx.frame(() => { rec.frames += 1; });

            const ro = new (globalThis as Any).ResizeObserver(() => {});
            ro.observe(ctx.root);
            ctx.own(toDisposable(() => ro.disconnect()));

            const audio = new (globalThis as Any).AudioContext();
            ctx.own(toDisposable(() => { void audio.close(); }));

            const url = objectUrl().create();
            ctx.own(toDisposable(() => objectUrl().revoke(url)));

            // 原生认识 signal 的两样：监听与 fetch，直接把 ctx.signal 传下去
            ctx.root.ownerDocument.addEventListener(
              'visibilitychange',
              () => { rec.events += 1; },
              { signal: ctx.signal },
            );
            void ctx.invoke('slow').catch((err: unknown) => { rec.invokeErrors.push(err); });

            ctx.stream({ message: () => {} });
            ctx.guardLeave(() => '有未保存的改动');
            ctx.ui.drawer('看一眼', '一段内容');
            ctx.ui.toast('挂上了', 'ok');

            ctx.root.appendChild(ctx.ui.msgline('贪心面板'));
            return { dispose: () => { rec.returnedDisposed += 1; } };
          },
        },
      },
    },
  });
  return { mod, rec };
}

describe('生命周期泄漏', () => {
  let raf: FakeRaf;
  let observers: Census;
  let audios: Census;
  let urls: Census;
  let fetches: FetchCensus;

  beforeEach(() => {
    vi.useFakeTimers();
    raf = installFakeRaf();
    observers = installFakeResizeObserver();
    audios = installFakeAudioContext();
    urls = installFakeObjectUrl();
    fetches = installPendingFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function greedyStage(): { stage: Stage; rec: Borrowed } {
    const { mod, rec } = greedyBundle();
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: [{ id: 'one', title: '第一格' }], client: { js: JS('a') } }],
      { [JS('a')]: mod },
    );
    return { stage, rec };
  }

  it('挂上之后确实借到了每一样（对照组：不然"归零"是因为压根没借）', async () => {
    const { stage, rec } = greedyStage();
    await stage.host.load();
    await stage.host.show('world:a', 'one');

    expect(vi.getTimerCount()).toBeGreaterThan(0); // interval + timeout + toast
    expect(raf.pending.size).toBe(1);
    expect(observers.live).toBe(1);
    expect(audios.live).toBe(1);
    expect(urls.live).toBe(1);
    expect(stage.doc.listeners.count('visibilitychange')).toBe(1);
    expect(fetches.live).toBe(1);
    expect(fetches.withSignal).toBe(1);
    expect(stage.sockets).toHaveLength(1);
    expect(stage.guards.size).toBe(1);
    expect(stage.overlayHost.children.length).toBeGreaterThan(0);
    expect(rec.ctx).toBeTruthy();

    // 借来的东西真的在跑
    vi.advanceTimersByTime(250);
    expect(rec.ticks).toBe(2);
    raf.tick(16);
    expect(rec.frames).toBe(1);
    stage.doc.dispatchEvent({ type: 'visibilitychange' });
    expect(rec.events).toBe(1);
  });

  it('unmount 之后逐项归零：定时器 / 帧 / observer / 监听 / fetch / 音频 / ObjectURL / 流 / 拦截 / 浮层', async () => {
    const { stage, rec } = greedyStage();
    await stage.host.load();
    await stage.host.show('world:a', 'one');

    stage.host.unmount();
    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(0);
    expect(raf.pending.size).toBe(0);
    expect(raf.cancelled).toHaveLength(1);
    expect(observers.live).toBe(0);
    expect(audios.live).toBe(0);
    expect(urls.live).toBe(0);
    expect(stage.doc.listeners.total()).toBe(0);
    expect(fetches.live).toBe(0);
    expect(fetches.aborted).toBe(1);
    expect(stage.sockets[0]?.closed).toBe(true);
    expect(stage.guards.size).toBe(0);
    expect(stage.overlayHost.children).toHaveLength(0);
    // root 被清空，mount 返回的 Disposable 也被调过
    expect(stage.root.children).toHaveLength(0);
    expect(rec.returnedDisposed).toBe(1);

    // 再推时间 / 推帧 / 派事件，一个回调都不该再响
    vi.advanceTimersByTime(60_000);
    raf.tick(999);
    stage.doc.dispatchEvent({ type: 'visibilitychange' });
    expect([rec.ticks, rec.lateTimeouts, rec.frames, rec.events]).toEqual([0, 0, 0, 0]);
  });

  it('导航到另一个面板（不是显式 unmount）同样归零', async () => {
    const { mod, rec } = greedyBundle();
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js: JS('a') } },
       { id: 'world:b', label: 'B World', panels: TWO_PANELS, client: { js: JS('b') } }],
      { [JS('a')]: mod, [JS('b')]: () => helloBundle('B') },
    );
    await stage.host.load();
    await stage.host.show('world:a', 'one');
    expect(observers.live).toBe(1);

    await stage.host.show('world:b', 'one');
    expect(vi.getTimerCount()).toBe(0);
    expect(raf.pending.size).toBe(0);
    expect(observers.live).toBe(0);
    expect(audios.live).toBe(0);
    expect(urls.live).toBe(0);
    expect(fetches.live).toBe(0);
    expect(stage.doc.listeners.total()).toBe(0);
    expect(stage.guards.size).toBe(0);
    expect(stage.overlayHost.children).toHaveLength(0);
    expect(rec.returnedDisposed).toBe(1);
    expect(stage.slotText()).toContain('B:one 挂上了');
  });

  it('反复 mount → unmount 十次：造了十次，活着的恒为零，账本不累积', async () => {
    const { mod, rec } = greedyBundle();
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: [{ id: 'one', title: '第一格' }], client: { js: JS('a') } }],
      { [JS('a')]: mod },
    );
    await stage.host.load();

    for (let i = 0; i < 10; i++) {
      await stage.host.show('world:a', 'one');
      vi.advanceTimersByTime(120);
      raf.tick(16 * (i + 1));
      stage.host.unmount();
      await flush();

      expect([i, vi.getTimerCount()]).toEqual([i, 0]);
      expect([i, raf.pending.size]).toEqual([i, 0]);
      expect([i, observers.live]).toEqual([i, 0]);
      expect([i, audios.live]).toEqual([i, 0]);
      expect([i, urls.live]).toEqual([i, 0]);
      expect([i, fetches.live]).toEqual([i, 0]);
      expect([i, stage.doc.listeners.total()]).toEqual([i, 0]);
      expect([i, stage.guards.size]).toEqual([i, 0]);
      expect([i, stage.overlayHost.children.length]).toEqual([i, 0]);
    }

    expect([observers.created, audios.created, urls.created]).toEqual([10, 10, 10]);
    expect([fetches.started, fetches.aborted]).toEqual([10, 10]);
    expect(stage.sockets).toHaveLength(10);
    expect(stage.sockets.every((s) => s.closed)).toBe(true);
    expect(rec.returnedDisposed).toBe(10);
    expect(stage.importModule).toHaveBeenCalledTimes(1);
    expect(rec.invokeErrors).toHaveLength(10);
    expect(rec.invokeErrors.every((e) => (e as Error).name === 'AbortError')).toBe(true);
  });

  it('mount 返回前已卸载时，后登记的资源立即释放', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const late = { entered: false, disposedReturn: 0 };

    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: [{ id: 'one', title: '第一格' }], client: { js: JS('a') } }],
      {
        [JS('a')]: () => ({
          default: {
            panels: {
              one: {
                async mount(ctx: Any) {
                  late.entered = true;
                  await gate; // 用户在这中间走掉了
                  ctx.interval(() => {}, 100);
                  ctx.timeout(() => {}, 100);
                  ctx.frame(() => {});
                  const ro = new (globalThis as Any).ResizeObserver(() => {});
                  ctx.own(toDisposable(() => ro.disconnect()));
                  const audio = new (globalThis as Any).AudioContext();
                  ctx.own(toDisposable(() => { void audio.close(); }));
                  const url = objectUrl().create();
                  ctx.own(toDisposable(() => objectUrl().revoke(url)));
                  ctx.root.appendChild(ctx.ui.msgline('迟到的面板'));
                  return { dispose: () => { late.disposedReturn += 1; } };
                },
              },
            },
          },
        }),
      },
    );
    await stage.host.load();

    const pending = stage.host.show('world:a', 'one');
    // 先让 import 走完、mount 真的进到那句 await 里——否则卸载发生在 mount 之前，
    // 验的就成了"用户在 import 期间走掉"（那是另一条路，下一条用例专门验）
    await flush();
    expect(late.entered).toBe(true);
    stage.host.unmount();
    release();
    await pending;

    // 登记的那一刻就该被释放，而不是挂进一个再也没人 dispose 的账本
    expect(observers.created).toBe(1);
    expect(observers.live).toBe(0);
    expect(audios.live).toBe(0);
    expect(urls.live).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(raf.pending.size).toBe(0);
    expect(late.disposedReturn).toBe(1);
    // 而且这块 DOM 不该被贴回页面（它属于一个已经不存在的面板）
    expect(stage.root.children).toHaveLength(0);
  });

  it('异步 mount 期间用户切走：迟到的面板不会顶掉新面板', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const entered = { a: false };
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js: JS('a') } },
       { id: 'world:b', label: 'B World', panels: TWO_PANELS, client: { js: JS('b') } }],
      {
        [JS('a')]: () => ({
          default: {
            panels: {
              one: {
                async mount(ctx: Any) {
                  entered.a = true;
                  await gate;
                  ctx.root.appendChild(ctx.ui.msgline('迟到的 A'));
                },
              },
            },
          },
        }),
        [JS('b')]: () => helloBundle('B'),
      },
    );
    await stage.host.load();

    const pending = stage.host.show('world:a', 'one');
    await flush();
    expect(entered.a).toBe(true); // A 的 mount 已经在跑了，这才叫"切走"
    await stage.host.show('world:b', 'one');
    release();
    await pending;

    expect(stage.slotText()).toContain('B:one 挂上了');
    expect(stage.text()).not.toContain('迟到的 A');
  });

  it('ctx.frame 的回调里 dispose：不留未决帧（自停与整面板卸载两种写法都验）', async () => {
    const seen = { self: 0, whole: 0 };
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js: JS('a') } }],
      {
        [JS('a')]: () => ({
          default: {
            panels: {
              // 回调里把自己那条 frame dispose 掉
              one: {
                mount(ctx: Any) {
                  const handle: Any = ctx.frame(() => { seen.self += 1; handle.dispose(); });
                },
              },
              // 回调里把整个面板卸掉（"面板自己决定收工"）
              two: {
                mount(ctx: Any) {
                  ctx.frame(() => { seen.whole += 1; ctx.own(toDisposable(() => {})); });
                  ctx.interval(() => {}, 100);
                },
              },
            },
          },
        }),
      },
    );
    await stage.host.load();

    await stage.host.show('world:a', 'one');
    expect(raf.pending.size).toBe(1);
    raf.tick(16);
    expect(seen.self).toBe(1);
    expect(raf.pending.size).toBe(0); // 没有留下一条谁也取消不了的帧
    raf.tick(32);
    expect(seen.self).toBe(1);

    // 第二种：帧回调跑到一半，host 把整个面板卸了
    await stage.host.show('world:a', 'two');
    expect(raf.pending.size).toBe(1);
    stage.host.unmount();
    expect(raf.pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    raf.tick(48);
    expect(seen.whole).toBe(0);
  });

  it('挂起的 ctx.invoke 在 unmount 后 abort，抛的是 AbortError 而不是被包装过的错误', async () => {
    const { stage, rec } = greedyStage();
    await stage.host.load();
    await stage.host.show('world:a', 'one');
    expect(rec.invokeErrors).toHaveLength(0);

    stage.host.unmount();
    await flush();

    expect(rec.invokeErrors).toHaveLength(1);
    const err = rec.invokeErrors[0] as Error;
    // 面板卸载 ≠ 请求失败：包成 ConsoleInvokeError 的话，每次切面板都会闪一张假错误卡
    expect(err.name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(ConsoleInvokeError);
  });

  it('扩展偷偷留住 ctx：unmount 之后再借，一律借不出来（也不炸）', async () => {
    const { stage, rec } = greedyStage();
    await stage.host.load();
    await stage.host.show('world:a', 'one');
    stage.host.unmount();
    await Promise.resolve();

    const ctx = rec.ctx;
    expect(ctx.signal.aborted).toBe(true);

    const after = { ticks: 0, late: 0, frames: 0 };
    const d1 = ctx.interval(() => { after.ticks += 1; }, 10);
    const d2 = ctx.timeout(() => { after.late += 1; }, 10);
    const d3 = ctx.frame(() => { after.frames += 1; });
    const disposed = { n: 0 };
    ctx.own(toDisposable(() => { disposed.n += 1; }));
    ctx.ui.toast('还在喊');
    ctx.ui.drawer('还在开', '内容');
    const closes: boolean[] = [];
    ctx.stream({ message: () => {}, close: (willRetry: boolean) => closes.push(willRetry) });
    ctx.guardLeave(() => '还想拦');

    // 流：不建新连接、不排重连；拦截：登记即刻解除
    expect(stage.sockets).toHaveLength(1);
    expect(closes).toEqual([]);
    expect(stage.guards.size).toBe(0);

    expect(vi.getTimerCount()).toBe(0);
    expect(raf.pending.size).toBe(0);
    // 卸载后登记立即释放。
    expect(disposed.n).toBe(1);
    // 浮层静默不显示：面板都没了，弹一个没人认领的窗只会误导
    expect(stage.overlayHost.children).toHaveLength(0);

    vi.advanceTimersByTime(10_000);
    raf.tick(16);
    expect([after.ticks, after.late, after.frames]).toEqual([0, 0, 0]);
    // 返回的仍是可安全 dispose 的空壳
    expect(() => { d1.dispose(); d2.dispose(); d3.dispose(); }).not.toThrow();
  });

  it('扩展 mount 返回坏 Disposable / 不返回，都不影响归零', async () => {
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js: JS('a') } }],
      {
        [JS('a')]: () => ({
          default: {
            panels: {
              one: {
                mount(ctx: Any) {
                  ctx.interval(() => {}, 50);
                  return { dispose: () => { throw new Error('清理里再泄漏一次'); } };
                },
              },
              two: {
                mount(ctx: Any) {
                  ctx.interval(() => {}, 50);
                  return 'not a disposable';
                },
              },
            },
          },
        }),
      },
    );
    await stage.host.load();

    await stage.host.show('world:a', 'one');
    expect(() => stage.host.unmount()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(stage.errors).toHaveLength(1); // 清理失败走 onError，不冒泡

    await stage.host.show('world:a', 'two');
    stage.host.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('timeout 触发后自己从账本里摘掉：反复防抖不会攒成无界数组', async () => {
    const disposes = { n: 0 };
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js: JS('a') } }],
      {
        [JS('a')]: () => ({
          default: {
            panels: {
              one: {
                mount(ctx: Any) {
                  for (let i = 0; i < 50; i++) ctx.timeout(() => {}, 10);
                  ctx.own(toDisposable(() => { disposes.n += 1; }));
                },
              },
            },
          },
        }),
      },
    );
    await stage.host.load();
    await stage.host.show('world:a', 'one');
    expect(vi.getTimerCount()).toBe(50);

    vi.advanceTimersByTime(50);
    expect(vi.getTimerCount()).toBe(0);

    stage.host.unmount();
    expect(disposes.n).toBe(1);
  });
});

// ===========================================================================
// ===========================================================================

describe('懒加载', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeRaf();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function threeProviders(): Stage {
    return makeStage(
      [
        { id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js: JS('a') } },
        { id: 'world:b', label: 'B World', panels: TWO_PANELS, client: { js: JS('b') } },
        { id: 'persona:c', label: 'C 人格', panels: TWO_PANELS, client: { js: JS('c') } },
      ],
      {
        [JS('a')]: () => helloBundle('A'),
        [JS('b')]: () => helloBundle('B'),
        [JS('c')]: () => helloBundle('C'),
      },
    );
  }

  it('只取 manifest、不进任何面板 → 一个 bundle 都不 import', async () => {
    const stage = threeProviders();
    await stage.host.load();
    await stage.host.refresh();
    expect(stage.importModule).not.toHaveBeenCalled();
    expect(stage.loader.loadedPages).toEqual([]);
  });

  it('只进 A 的面板，B 与 C 的 bundle 一次都没被 import', async () => {
    const stage = threeProviders();
    await stage.host.load();
    await stage.host.show('world:a', 'one');
    await stage.host.show('world:a', 'two');

    expect(stage.importModule.mock.calls.map((c: Any[]) => c[0])).toEqual([JS('a')]);
    expect(stage.loader.loadedPages).toEqual(['world:a']);
  });

  it('进到哪个才拉哪个：A → C 之后仍然没碰过 B', async () => {
    const stage = threeProviders();
    await stage.host.load();
    await stage.host.show('world:a', 'one');
    await stage.host.show('persona:c', 'one');

    expect(stage.importModule.mock.calls.map((c: Any[]) => c[0])).toEqual([JS('a'), JS('c')]);
    expect(stage.loader.loadedPages).toEqual(['world:a', 'persona:c']);
    expect(stage.slotText()).toContain('C:one 挂上了');
  });

  it('同一 provider 反复进出（含在两个面板之间来回）只 import 一次', async () => {
    const stage = threeProviders();
    await stage.host.load();
    for (const [p, panel] of [
      ['world:a', 'one'], ['world:a', 'two'], ['world:b', 'one'],
      ['world:a', 'one'], ['world:a', 'two'], ['world:a', 'one'],
    ] as const) {
      await stage.host.show(p, panel);
    }
    const urls = stage.importModule.mock.calls.map((c: Any[]) => c[0]);
    expect(urls).toEqual([JS('a'), JS('b')]);
  });

  it('加载失败不缓存：失败之后再进会重新 import（"还没 build"是常态）', async () => {
    let attempt = 0;
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js: JS('a') } }],
      {
        [JS('a')]: () => {
          attempt += 1;
          if (attempt === 1) throw new Error('还没 build');
          return helloBundle('A');
        },
      },
    );
    await stage.host.load();

    await stage.host.show('world:a', 'one');
    expect(stage.slotText()).toContain('还没 build');
    expect(stage.loader.loadedPages).toEqual([]);

    // 第二次进：必须重新 import，而不是拿着上次的失败继续报错
    await stage.host.show('world:a', 'one');
    expect(stage.importModule).toHaveBeenCalledTimes(2);
    expect(stage.slotText()).toContain('A:one 挂上了');
    expect(stage.loader.loadedPages).toEqual(['world:a']);

    // 成功之后才开始缓存
    await stage.host.show('world:a', 'two');
    expect(stage.importModule).toHaveBeenCalledTimes(2);
  });

  it('mount 抛错不影响 bundle 的缓存：扩展是好的，坏的是那一次渲染', async () => {
    let mounts = 0;
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js: JS('a') } }],
      {
        [JS('a')]: () => ({
          default: {
            panels: {
              one: {
                mount() {
                  mounts += 1;
                  throw new Error('这一次渲染炸了');
                },
              },
              two: { mount(ctx: Any) { ctx.root.appendChild(ctx.ui.msgline('好的那格')); } },
            },
          },
        }),
      },
    );
    await stage.host.load();
    await stage.host.show('world:a', 'one');
    await stage.host.show('world:a', 'one');
    await stage.host.show('world:a', 'two');

    expect(mounts).toBe(2);
    expect(stage.importModule).toHaveBeenCalledTimes(1);
    expect(stage.slotText()).toContain('好的那格');
  });

  it('并发进同一个 provider 的两个面板：只 import 一次，且最后落地的是后进的那个', async () => {
    let release: (v: unknown) => void = () => {};
    const stage = makeStage(
      [{ id: 'world:a', label: 'A World', panels: TWO_PANELS, client: { js: JS('a') } }],
      { [JS('a')]: () => new Promise((r) => { release = r; }) },
    );
    await stage.host.load();

    const p1 = stage.host.show('world:a', 'one');
    const p2 = stage.host.show('world:a', 'two');
    expect(stage.importModule).toHaveBeenCalledTimes(1);

    release(helloBundle('A'));
    await Promise.all([p1, p2]);

    expect(stage.importModule).toHaveBeenCalledTimes(1);
    expect(stage.slotText()).toContain('A:two 挂上了');
    expect(stage.slotText()).not.toContain('A:one 挂上了');
  });
});

// ---------------------------------------------------------------------------
// 归属页：provider 自己声明的参数，画在它自己那一页上
// ---------------------------------------------------------------------------

describe('provider 归属页的参数', () => {
  /** 全量清单：一组属于 world:a，一组是框架的。 */
  const CONFIG_PAYLOAD = {
    groups: [
      {
        group: {
          id: 'g.mine',
          owner: 'world:a',
          schema: { title: 'A 的旋钮', properties: { 'a.n': { type: 'integer', title: '条数' } } },
        },
        values: { 'a.n': 3 },
      },
      {
        group: {
          id: 'g.framework',
          owner: 'core',
          schema: { title: '框架的旋钮', properties: { 'h.n': { type: 'integer', title: '别人的' } } },
        },
        values: { 'h.n': 1 },
      },
    ],
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(CONFIG_PAYLOAD)),
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const withConfig = (extra: Partial<ProviderDecl> = {}): ProviderDecl => ({
    id: 'world:a', label: 'A World', configGroups: ['g.mine'], ...extra,
  });

  it('只画自己认领的那几组，全量清单里别人的一律不画', async () => {
    const stage = makeStage([withConfig()], {});
    await stage.host.load();
    await stage.host.show('world:a', '~config');
    await flush();

    expect(stage.slotText()).toContain('A 的旋钮');
    expect(stage.slotText()).toContain('条数');
    expect(stage.slotText()).not.toContain('框架的旋钮');
    expect(stage.slotText()).not.toContain('别人的');
  });

  it('页签上多一颗「参数」；没声明的 provider 上没有这颗', async () => {
    const withPanel = makeStage([withConfig({ panels: [{ id: 'one', title: '面板一' }] })], {});
    await withPanel.host.load();
    await withPanel.host.show('world:a', 'one');
    await flush();
    expect(withPanel.chrome()!.textContent).toContain('参数');

    const plain = makeStage([{ id: 'world:b', label: 'B World', panels: [{ id: 'one', title: '面板一' }, { id: 'two', title: '面板二' }] }], {});
    await plain.host.load();
    await plain.host.show('world:b', 'one');
    await flush();
    expect(plain.chrome()!.textContent).not.toContain('参数');
  });

  it('只有参数、没有面板的 provider：不带页签进来就落在参数页（不是一张"没有面板"的空卡）', async () => {
    const stage = makeStage([withConfig()], {});
    await stage.host.load();
    await stage.host.show('world:a');
    await flush();

    expect(stage.slotText()).toContain('A 的旋钮');
    expect(stage.slotText()).not.toContain('没有声明任何面板');
  });

  it('点不存在的页签：错误卡把 ~config 一起列进"它提供的是"', async () => {
    const stage = makeStage([withConfig()], {});
    await stage.host.load();
    await stage.host.show('world:a', 'nope');
    await flush();

    expect(stage.slotText()).toContain('没有面板「nope」');
    expect(stage.slotText()).toContain('~config');
  });

  it('参数页也归生命周期管：离开之后节点与监听不留', async () => {
    const stage = makeStage([withConfig()], {});
    await stage.host.load();
    await stage.host.show('world:a', '~config');
    await flush();
    expect(stage.slotText()).toContain('A 的旋钮');

    stage.host.unmount();
    expect(stage.root.textContent).toBe('');
  });
});

describe('参数页与 capabilities', () => {
  it('部署没挂 /api/config：页签不出现，直接进 ~config 也只是一张"没有这个面板"的卡', async () => {
    const doc = new FakeDoc();
    const root = doc.createElement('div');
    const overlayHost = doc.createElement('div');
    doc.body.append(root, overlayHost);
    const host = new ConsolePageHost({
      doc,
      root,
      overlayHost,
      loader: new ConsolePageLoader({
        importModule: async () => ({}),
        styleHost: { appendChild: () => {} },
        createLink: () => ({ rel: '', href: '', dataset: {} as Record<string, string> }),
      }),
      router: { addLeaveGuard: () => ({ dispose: () => {} }), navigate: () => {} },
      fetchManifest: async () => ({
        protocolVersion: 1,
        providers: [{
          id: 'world:a', kind: 'world', label: 'A World', availability: 'active',
          panels: [{ id: 'one', title: '面板一' }],
          configGroups: ['g.mine'],
        }],
        framework: { capabilities: { config: false } },
      }),
      memo: fakeMemo(),
      createSocket: () => new FakeSocket('ws://test'),
      wsUrl: (p: string) => `ws://test${p}`,
      onError: () => {},
    });

    await host.load();
    await host.show('world:a', '~config');
    await flush();
    expect(root.textContent).toContain('没有面板「~config」');
    expect(root.textContent).not.toContain('~config / ');
  });
});

describe('数据页签', () => {
  const STORAGE_PARTS = {
    parts: [
      { key: 'a-log', owner: 'world:a', label: 'A 日志', kind: 'disk', stat: '3 条' },
      { key: 'events', owner: 'core', label: '事件库', kind: 'disk', stat: '9 条' },
    ],
  };
  beforeEach(() => {
    vi.stubGlobal('fetch', (url: unknown) => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(String(url).startsWith('/api/storage') ? STORAGE_PARTS : {})),
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('只画 manifest 里点名的那几项;页签上多一颗「数据」', async () => {
    const stage = makeStage([{ id: 'world:a', label: 'A World', storageKeys: ['a-log'], panels: [{ id: 'one', title: '面板一' }] }], {});
    await stage.host.load();
    await stage.host.show('world:a', '~storage');
    await flush();
    expect(stage.chrome()!.textContent).toContain('数据');
    expect(stage.slotText()).toContain('A 日志');
    expect(stage.slotText()).not.toContain('事件库');
  });

  it('没声明存储项的页没有这颗页签,直接进 ~storage 是一张"没有这个面板"的卡', async () => {
    const stage = makeStage([{ id: 'world:b', label: 'B World', panels: [{ id: 'one', title: '面板一' }, { id: 'two', title: '面板二' }] }], {});
    await stage.host.load();
    await stage.host.show('world:b', '~storage');
    await flush();
    expect(stage.chrome()!.textContent).not.toContain('数据');
    expect(stage.slotText()).toContain('没有面板「~storage」');
  });
});
