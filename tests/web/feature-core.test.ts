/**
 * core 核心页使用动态 import、迷你 DOM 和可控的 WebSocket/fetch 依赖。
 * 变量形式的 import 避免根 tsconfig 将浏览器 DOM 代码拉入 Node 类型检查。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UI_ENTRY = '../../src/web/client/ui/index.ts';
const LIFECYCLE_ENTRY = '../../src/web/client/core/lifecycle.ts';
const ROUTER_ENTRY = '../../src/web/client/core/router.ts';
const CORE_ENTRY = '../../src/web/client/features/core/index.ts';
const TOOLS_ENTRY = '../../src/web/client/features/core/tools.ts';
const PROMPTS_ENTRY = '../../src/web/client/features/prompts/view.ts';
const FEATURE_ENTRY = '../../src/web/client/features/feature.ts';

type Any = any;

const { createConsoleUi } = (await import(UI_ENTRY)) as Any;
const { Lifecycle } = (await import(LIFECYCLE_ENTRY)) as Any;
const { Router, parseHash } = (await import(ROUTER_ENTRY)) as Any;
const core = (await import(CORE_ENTRY)) as Any;
const toolsMod = (await import(TOOLS_ENTRY)) as Any;
const promptsMod = (await import(PROMPTS_ENTRY)) as Any;
const { featureAvailable } = (await import(FEATURE_ENTRY)) as Any;

// ---------------------------------------------------------------------------
// 迷你 DOM 桩
// ---------------------------------------------------------------------------

type Listener = (ev: Any) => void;
interface ListenOptions {
  signal?: AbortSignal;
  once?: boolean;
}

class Listeners {
  private map = new Map<string, Listener[]>();
  add(type: string, fn: Listener, opts?: ListenOptions): void {
    if (opts?.signal?.aborted) return;
    const wrapped: Listener = opts?.once
      ? (ev) => {
          this.remove(type, wrapped);
          fn(ev);
        }
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
  count(type: string): number {
    return (this.map.get(type) ?? []).length;
  }
  total(): number {
    let n = 0;
    for (const arr of this.map.values()) n += arr.length;
    return n;
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
  checked = false;
  rows = 0;
  colSpan = 1;
  disabled = false;
  placeholder = '';
  title = '';
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  listeners = new Listeners();
  ownText = '';
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
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
  replaceChildren(...nodes: FakeEl[]): void {
    for (const c of this.children.slice()) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, node);
    else this.children.push(node);
    return node;
  }
  replaceWith(node: FakeEl): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this.parent;
    this.parent.children.splice(i, 1, node);
    this.parent = null;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  focus(): void {}
  select(): void {}
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
  countListeners(type: string): number {
    return this.listeners.count(type);
  }
  /** 整棵子树上还挂着多少监听(测试自用) */
  totalListeners(): number {
    return this.children.reduce((n, c) => n + c.totalListeners(), this.listeners.total());
  }
  /** 递归找第一个 class 含某个词的后代 */
  find(cls: string): FakeEl | null {
    for (const c of this.children) {
      if (c.className.split(' ').includes(cls)) return c;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
  /** 递归找第一个某标签的后代 */
  findTag(tag: string): FakeEl | null {
    for (const c of this.children) {
      if (c.tagName === tag) return c;
      const hit = c.findTag(tag);
      if (hit) return hit;
    }
    return null;
  }
  /** 递归找所有某标签的后代 */
  findAllTag(tag: string, out: FakeEl[] = []): FakeEl[] {
    for (const c of this.children) {
      if (c.tagName === tag) out.push(c);
      c.findAllTag(tag, out);
    }
    return out;
  }
  /** 递归找所有 class 含某个词的后代 */
  findAll(cls: string, out: FakeEl[] = []): FakeEl[] {
    for (const c of this.children) {
      if (c.className.split(' ').includes(cls)) out.push(c);
      c.findAll(cls, out);
    }
    return out;
  }
}

class FakeDoc {
  listeners = new Listeners();
  body: FakeEl;
  title = '';
  defaultView: Any = undefined;
  constructor() {
    this.body = new FakeEl('body', this);
  }
  createElement(tag: string): FakeEl {
    return new FakeEl(tag, this);
  }
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.remove(type, fn);
  }
  countListeners(type: string): number {
    return this.listeners.count(type);
  }
}

// ---------------------------------------------------------------------------
// 假 WebSocket 环境
// ---------------------------------------------------------------------------

class FakeSocket {
  readyState = 0;
  closed = false;
  onopen: Any = null;
  onclose: Any = null;
  onerror: Any = null;
  onmessage: Any = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  /** 连上 */
  up(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  /** 推一帧 */
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** 推一段坏文本 */
  emitRaw(text: string): void {
    this.onmessage?.({ data: text });
  }
}

function fakeEnv() {
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, () => void>();
  let seq = 0;
  return {
    sockets,
    timers,
    env: {
      wsUrl: (p: string) => `ws://test${p}`,
      createSocket: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      setTimer: (fn: () => void) => {
        seq += 1;
        timers.set(seq, fn);
        return seq;
      },
      clearTimer: (id: number) => {
        timers.delete(id);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 假 fetch / 假 FeatureContext
// ---------------------------------------------------------------------------

const fetched: string[] = [];
/** 每次调用的方法与 body,验证"保存"与"暂停"发了什么 */
const calls: Array<{ url: string; method: string; body: Any }> = [];

function stubFetch(reply: (url: string) => unknown): void {
  vi.stubGlobal('fetch', (url: unknown, init: Any) => {
    fetched.push(String(url));
    calls.push({
      url: String(url),
      method: String(init?.method ?? 'GET'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const body = reply(String(url));
    return Promise.resolve(
      new Response(JSON.stringify(body ?? {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

function fakeWin(hash = '#/live'): Any {
  const listeners = new Listeners();
  return {
    location: { hash },
    addEventListener: (t: string, fn: Listener) => listeners.add(t, fn),
    removeEventListener: (t: string, fn: Listener) => listeners.remove(t, fn),
  };
}

interface Ctx {
  ctx: Any;
  doc: FakeDoc;
  root: FakeEl;
  lifecycle: Any;
  errors: unknown[];
  /** 地址栏(断言 feature 有没有把子页签写进路由) */
  win: Any;
  /** 这一页注册的离开拦截 */
  guards: Array<() => string | null>;
}

function mkCtx(capabilities: Record<string, boolean>, hash = '#/core'): Ctx {
  const doc = new FakeDoc();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  const errors: unknown[] = [];
  const lifecycle = new Lifecycle((e: unknown) => errors.push(e));
  const store: Record<string, unknown> = {};
  const memo = {
    get: <T,>(k: string, d: T): T => (k in store ? (store[k] as T) : d),
    set: (k: string, v: unknown): void => {
      store[k] = v;
    },
  };
  const ui = createConsoleUi({ memo, overlayHost: doc.body, doc, signal: lifecycle.signal });
  const win = fakeWin(hash);
  const router = new Router({ win, confirmLeave: async () => true });
  // 拦截器是真 Router 的,这里只在旁边记一份,好在测试里直接问它"现在拦不拦"。
  const guards: Array<() => string | null> = [];
  const addGuard = router.addLeaveGuard.bind(router);
  router.addLeaveGuard = (fn: () => string | null): Any => {
    guards.push(fn);
    return addGuard(fn);
  };
  const ctx = {
    root,
    lifecycle,
    signal: lifecycle.signal,
    ui,
    router,
    route: parseHash(hash),
    capabilities,
    onError: (e: unknown) => errors.push(e),
  };
  return { ctx, doc, root, lifecycle, errors, win, guards };
}

const ALL_CAPS = {
  debug: true,
  sessions: true,
  run: true,
  toolSchemas: true,
  prompts: true,
  storage: true,
  config: true,
};

/** 一份够用的假回应表。 */
function defaultReply(url: string): unknown {
  if (url.startsWith('/api/status')) return { displayName: '某某', loop: { estTokens: 1200 } };
  if (url.startsWith('/api/sessions')) return { sessions: [] };
  if (url.startsWith('/api/events')) return { latest: 2, events: [] };
  if (url.startsWith('/api/log?')) return [];
  if (url.startsWith('/api/runs')) return { current: null, runs: [] };
  if (url.startsWith('/api/tool-schemas')) return { tools: [] };
  if (url.startsWith('/api/prompts')) return { prompts: [] };
  if (url.startsWith('/api/run/')) return { ok: true, paused: true };
  return {};
}

/** 子页签那一排(`.seg` 按钮)。 */
const segs = (root: FakeEl): FakeEl[] => root.findAll('seg');

/**
 * 让挂起的 promise 链跑完。
 *
 * 用 `setImmediate` 而不是数几个微任务:`Response.text()` 那条链在 undici 里要过
 * 一趟宏任务,数微任务数不到头。所以下面的假时钟**故意不接管 `setImmediate`**——
 * 它是这里唯一还需要真的跑起来的那一档。
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  fetched.length = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});


// ===========================================================================
// 纯函数
// ===========================================================================

describe('工具 schema · 纯函数', () => {
  it('schemaTypeLabel:联合/枚举/组合都给一个能读的词', () => {
    expect(toolsMod.schemaTypeLabel(null)).toBe('—');
    expect(toolsMod.schemaTypeLabel({ type: 'string' })).toBe('string');
    expect(toolsMod.schemaTypeLabel({ type: ['string', 'null'] })).toBe('string | null');
    expect(toolsMod.schemaTypeLabel({ enum: ['a'] })).toBe('enum');
    expect(toolsMod.schemaTypeLabel({ oneOf: [] })).toBe('oneOf');
    expect(toolsMod.schemaTypeLabel({})).toBe('schema');
  });

  it('schemaParameterRows:递归展开嵌套与数组元素,必填从 required 来', () => {
    const rows = toolsMod.schemaParameterRows({
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: '要说的话' },
        opts: { type: 'object', properties: { loud: { type: 'boolean' } } },
        list: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' } } } },
      },
    });
    expect(rows.map((r: Any) => r.path)).toEqual(['text', 'opts', 'opts.loud', 'list', 'list[].id']);
    expect(rows[0]).toMatchObject({ type: 'string', required: true, description: '要说的话' });
    expect(rows[1].required).toBe(false);
    expect(toolsMod.schemaParameterRows(undefined)).toEqual([]);
  });

  it('groupTools:按后端给的 owner 分栏,前端不维护工具名单', () => {
    const groups = toolsMod.groupTools([
      { name: 'schedule_wake', owner: { kind: 'core' } },
      { name: 'read_file', owner: { kind: 'persona' } },
      { name: 'send', owner: { kind: 'world', id: 'x', label: '某 World' } },
      { name: 'look', owner: { kind: 'world', id: 'x', label: '某 World' } },
      { name: 'fork', tags: ['flow'] }, // 没有 owner 时按 tags 兜底
      { name: 'noop' },
    ]);
    expect(groups.map(([k]: Any) => k)).toEqual([
      '原生动作 · core',
      '记忆 / 文件工具 · Persona',
      'IO 工具 · 某 World',
    ]);
    expect(groups[0][1].map((t: Any) => t.name)).toEqual(['schedule_wake', 'fork']);
    expect(groups[1][1].map((t: Any) => t.name)).toEqual(['read_file', 'noop']);
    expect(groups[2][1].map((t: Any) => t.name)).toEqual(['send', 'look']);
  });
});

describe('模板占位符 · 提示与警告', () => {
  it('列出模板里用到的占位符,按出现序去重', () => {
    expect(promptsMod.usedVarNames('{{b}}\n{{a | 缺省}}\n{{b}}')).toEqual(['b', 'a']);
  });

  it('用了没声明的会原样进前缀;声明了没用的只是提示——两条都不阻止保存', () => {
    const vars = [{ name: 'qq.identity', description: '' }, { name: 'qq.roster', description: '' }];
    const warns = promptsMod.varWarnings('{{qq.identity}}{{qq.typo}}', vars);
    expect(warns.join('|')).toContain('{{qq.typo}}');
    expect(warns.join('|')).toContain('qq.roster');
  });

  it('对得上就没有警告', () => {
    expect(promptsMod.varWarnings('{{a}}', [{ name: 'a', description: '' }])).toEqual([]);
  });
});

// ===========================================================================
// feature 声明
// ===========================================================================

describe('core feature 声明', () => {
  it('认领 core 路由;不依赖任何可选表面,永远可用', () => {
    expect(core.coreFeature.route).toBe('core');
    expect(core.coreFeature.label).toBe('运行诊断');
    expect(core.coreFeature.navGroup).toBe('Core');
    expect(core.coreFeature.needsAny).toBe(undefined);
    expect(featureAvailable(core.coreFeature, {})).toBe(true);
  });
});


// ===========================================================================
// 子页签
// ===========================================================================

describe('core 子页签', () => {
  it('没挂的能力连页签都不出现', () => {
    stubFetch(defaultReply);
    const { env } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true });
    core.createCoreFeature({ env }).mount(ctx);
    expect(segs(root).map((s) => s.textContent)).toEqual(['运行', '事件流', '运行日志']);
  });

  it('全挂时七个都在,默认落在第一个(ORIENTATION 不在这——core 不持环境提示词)', () => {
    stubFetch(defaultReply);
    const { env } = fakeEnv();
    const { ctx, root } = mkCtx(ALL_CAPS);
    core.createCoreFeature({ env }).mount(ctx);
    expect(root.findTag('h1')!.textContent).toBe('运行诊断');
    expect(segs(root).map((s) => s.textContent)).toEqual([
      '运行',
      '会话统计',
      '事件流',
      '运行日志',
      '工具表',
      '数据',
      '参数',
    ]);
    expect(root.find('subtabs')).not.toBe(null);
    expect(segs(root)[0].className).toContain('active');
    expect(root.find('statgrid')).not.toBe(null);
  });

  it('数据子页只列 owner 是 core 的项,带一键清空;参数子页只画 owner 是 core 的组', async () => {
    stubFetch((u) => u.startsWith('/api/storage')
      ? { parts: [
        { key: 'events', owner: 'core', label: '事件库', kind: 'disk', stat: '1' },
        { key: 'ws', owner: 'memory', label: '工作区', kind: 'disk', stat: '2' },
      ] }
      : u.startsWith('/api/config')
        ? { groups: [
          { group: { id: 'core', owner: 'core', schema: { title: '主循环', properties: { 'a.b': { type: 'integer', title: '甲' } } } }, values: { 'a.b': 1 } },
          { group: { id: 'world:x', owner: 'world:x', schema: { title: 'X 的旋钮', properties: { 'x.n': { type: 'integer', title: '乙' } } } }, values: { 'x.n': 2 } },
        ] }
        : defaultReply(u));
    const { env } = fakeEnv();
    const { ctx, root } = mkCtx(ALL_CAPS, '#/core/data');
    core.createCoreFeature({ env }).mount(ctx);
    await flush();
    expect(root.findAll('strow').map((r) => r.find('stlabel')!.textContent)).toEqual(['事件库']);
    expect(root.textContent).toContain('⚠ 一键清空全部');

    const params = mkCtx(ALL_CAPS, '#/core/params');
    core.createCoreFeature({ env }).mount(params.ctx);
    await flush();
    expect(params.root.findAll('tsection').map((s) => s.textContent)).toEqual(['主循环']);
  });

  it('进来时按路由第二段落在对应子页', async () => {
    stubFetch(defaultReply);
    const { env } = fakeEnv();
    const { ctx, root } = mkCtx(ALL_CAPS, '#/core/events');
    core.createCoreFeature({ env }).mount(ctx);
    await flush();
    expect(segs(root)[2].className).toContain('active');
    expect(fetched.some((u) => u.startsWith('/api/events?limit=100'))).toBe(true);
  });

  it('路由第二段不认识时退回第一个子页,不留白页', () => {
    stubFetch(defaultReply);
    const { env } = fakeEnv();
    const { ctx, root } = mkCtx(ALL_CAPS, '#/core/根本没有这一页');
    core.createCoreFeature({ env }).mount(ctx);
    expect(segs(root)[0].className).toContain('active');
  });

  it('切页签把子页写进地址栏', () => {
    stubFetch(defaultReply);
    const { env } = fakeEnv();
    const { ctx, root, win } = mkCtx(ALL_CAPS);
    core.createCoreFeature({ env }).mount(ctx);
    segs(root)[3].dispatchEvent({ type: 'click' });
    expect(win.location.hash).toBe('#/core/runlog');
  });
});

// ===========================================================================
// 各子页
// ===========================================================================

describe('运行态', () => {
  it('八张读数卡,状态帧到了就重画', () => {
    stubFetch(defaultReply);
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx(ALL_CAPS);
    core.createCoreFeature({ env }).mount(ctx);
    sockets[0].up();
    sockets[0].emit({
      t: 'status',
      status: {
        eventCount: 7,
        terminalOnline: 2,
        loop: { estTokens: 12345, messageCount: 9, paused: true },
      },
    });
    const grid = root.find('statgrid') as FakeEl;
    expect(grid.children.length).toBe(8);
    expect(grid.textContent).toContain('12.3k');
    expect(grid.textContent).toContain('暂停');
  });

  // 暂停/继续与关机都不在这一页:它们在左栏右下角(shell),测试在 shell.test.ts。
});

describe('事件流', () => {
  it('铺出事件行,来源下拉由数据自己长出来', async () => {
    stubFetch((url) =>
      url.startsWith('/api/events')
        ? {
            latest: 2,
            events: [
              { cursor: 1, ts: '2026-08-12T10:00:00.000Z', source: 'a', type: 'msg', text: '一' },
              { cursor: 2, ts: '2026-08-12T10:00:01.000Z', source: 'b', type: 'msg', text: '二' },
            ],
          }
        : defaultReply(url),
    );
    const { env } = fakeEnv();
    const { ctx, root } = mkCtx(ALL_CAPS, '#/core/events');
    core.createCoreFeature({ env }).mount(ctx);
    await flush();
    const body = (root.find('tablewrap') as FakeEl).findTag('tbody') as FakeEl;
    expect(body.children.length).toBe(2);
    expect(body.textContent).toContain('10:00:00');
    const sel = root.findTag('select') as FakeEl;
    expect(sel.children.map((o) => o.textContent)).toEqual(['全部来源', 'a', 'b']);
  });

  it('有调试通道就不自己轮询;event 帧到了才追一次', async () => {
    stubFetch(defaultReply);
    const { env, sockets } = fakeEnv();
    const { ctx } = mkCtx(ALL_CAPS, '#/core/events');
    core.createCoreFeature({ env }).mount(ctx);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    fetched.length = 0;
    sockets[0].up();
    sockets[0].emit({ t: 'event' });
    await flush();
    expect(fetched.some((u) => u.startsWith('/api/events?from='))).toBe(true);
  });

  it('没有调试通道才退回轮询,离开子页即停', async () => {
    stubFetch(defaultReply);
    const { env } = fakeEnv();
    const { ctx, root, lifecycle } = mkCtx({ sessions: false }, '#/core/events');
    core.createCoreFeature({ env }).mount(ctx);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    segs(root)[0].dispatchEvent({ type: 'click' }); // 切到「运行」
    expect(vi.getTimerCount()).toBe(0);
    lifecycle.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('运行日志', () => {
  const ERROR_ROW = {
    ts: '2026-08-12T10:00:01.000+08:00',
    level: 'error',
    area: 'y',
    event: 'llm-failed',
    msg: '出事',
    data: { k: 1 },
    err: { name: 'Error', message: 'upstream 502' },
  };
  const ROWS = [
    { ts: '2026-08-12T10:00:00.000+08:00', level: 'debug', area: 'x', msg: '琐碎', repeat: 2 },
    ERROR_ROW,
  ];
  const RUNS = {
    current: 'r-b',
    runs: [
      { run: 'r-a', startedAt: '2026-08-11T10:00:00.000+08:00' },
      { run: 'r-b', startedAt: '2026-08-12T10:00:00.000+08:00' },
    ],
  };
  /** 服务端按 level 过滤;这里只认 error 一档,够钉住"参数发出去了、结果照单收" */
  const reply = (url: string): unknown => {
    if (url.startsWith('/api/log?')) return url.includes('level=error') ? [ERROR_ROW] : ROWS;
    if (url.startsWith('/api/runs')) return RUNS;
    return defaultReply(url);
  };
  const lastLogUrl = (): string => fetched.filter((u) => u.startsWith('/api/log?')).at(-1) ?? '';

  it('过滤参数发给服务端;区域带 event,正文带折叠计数、data 摘要与 err', async () => {
    stubFetch(reply);
    const { env } = fakeEnv();
    const { ctx, root } = mkCtx(ALL_CAPS, '#/core/runlog');
    core.createCoreFeature({ env }).mount(ctx);
    await flush();
    const body = (root.find('tablewrap') as FakeEl).findTag('tbody') as FakeEl;
    expect(body.children.length).toBe(2);
    expect(lastLogUrl()).toContain('level=debug');
    expect(lastLogUrl()).toContain('run=r-b');
    expect(body.children[0].textContent).toContain('×3');
    expect(body.children[1].textContent).toContain('y/llm-failed');
    expect(body.children[1].textContent).toContain('{"k":1}');
    expect(body.children[1].textContent).toContain('upstream 502');
    // 级别格与 err 段都是 .lv-error;err 段在正文格里,排在后面
    expect(body.children[1].findAll('lv-error').at(-1)?.textContent).toBe(' upstream 502');

    const [runSel, levelSel] = root.findAllTag('select');
    expect(runSel.children.map((o) => o.value)).toEqual(['r-b', 'r-a']);
    expect(runSel.children[0].textContent).toBe('r-b · 2026-08-12T10:00:00.000+08:00');
    expect(runSel.value).toBe('r-b');

    levelSel.value = 'error';
    levelSel.dispatchEvent({ type: 'change' });
    await flush();
    expect(lastLogUrl()).toContain('level=error');
    expect(body.children.length).toBe(1);
    expect(body.textContent).toContain('出事');

    runSel.value = 'r-a';
    runSel.dispatchEvent({ type: 'change' });
    await flush();
    expect(lastLogUrl()).toContain('run=r-a');
  });

  it('区域 / 正则 / 轮次输入去抖 300ms,回车立即查', async () => {
    stubFetch(reply);
    const { env } = fakeEnv();
    const { ctx, root } = mkCtx(ALL_CAPS, '#/core/runlog');
    core.createCoreFeature({ env }).mount(ctx);
    await flush();
    const before = fetched.filter((u) => u.startsWith('/api/log?')).length;
    const [areaIn, grepIn, roundIn] = root.findAllTag('input');
    expect(roundIn.type).toBe('number');

    areaIn.value = 'worlds.minecraft';
    areaIn.dispatchEvent({ type: 'input' });
    grepIn.value = '死|摔';
    grepIn.dispatchEvent({ type: 'input' });
    roundIn.value = '7';
    roundIn.dispatchEvent({ type: 'input' });
    await flush();
    expect(fetched.filter((u) => u.startsWith('/api/log?')).length).toBe(before);

    vi.advanceTimersByTime(300);
    await flush();
    expect(fetched.filter((u) => u.startsWith('/api/log?')).length).toBe(before + 1);
    expect(lastLogUrl()).toContain('area=worlds.minecraft');
    expect(lastLogUrl()).toContain(`grep=${encodeURIComponent('死|摔')}`);
    expect(lastLogUrl()).toContain('round=7');

    areaIn.value = 'worlds.vtuber';
    areaIn.dispatchEvent({ type: 'input' });
    areaIn.dispatchEvent({ type: 'keydown', key: 'Enter' });
    await flush();
    expect(fetched.filter((u) => u.startsWith('/api/log?')).length).toBe(before + 2);
    expect(lastLogUrl()).toContain('area=worlds.vtuber');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('工具表', () => {
  it('分栏渲染,筛选把不命中的卡与空栏都收起来', async () => {
    stubFetch((url) =>
      url.startsWith('/api/tool-schemas')
        ? {
            tools: [
              {
                name: 'schedule_wake',
                description: '定时唤醒',
                owner: { kind: 'core' },
                parameters: { type: 'object', properties: { at: { type: 'string' } } },
              },
              { name: 'read_file', description: '读文件', owner: { kind: 'persona' } },
            ],
          }
        : defaultReply(url),
    );
    const { env } = fakeEnv();
    const { ctx, root } = mkCtx(ALL_CAPS, '#/core/tools');
    core.createCoreFeature({ env }).mount(ctx);
    await flush();
    const cards = root.findAll('tool-schema-card');
    expect(cards.length).toBe(2);
    expect(root.findAll('schema-group').length).toBe(2);
    expect(cards[0].textContent).toContain('1 个参数');

    const search = root.findAllTag('input').find((i) => i.type === 'search') as FakeEl;
    search.value = 'read';
    search.dispatchEvent({ type: 'input' });
    expect(cards[0].className).toContain('hidden');
    expect(cards[1].className).not.toContain('hidden');
    expect(root.findAll('schema-group')[0].className).toContain('hidden');
  });
});


// ===========================================================================
// 卸载
// ===========================================================================

describe('core feature 卸载', () => {
  it('unmount:连接关掉、退避定时器清掉、轮询与监听归零', async () => {
    stubFetch(defaultReply);
    const { env, sockets, timers } = fakeEnv();
    const { ctx, root, lifecycle } = mkCtx(ALL_CAPS, '#/core/events');
    core.createCoreFeature({ env }).mount(ctx);
    await flush();
    const view = root.children[0];
    expect(view.totalListeners()).toBeGreaterThan(0);

    sockets[0].readyState = 3;
    sockets[0].onclose?.({});
    expect(timers.size).toBe(1);

    lifecycle.dispose();
    expect(timers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(view.totalListeners()).toBe(0);
  });
});
