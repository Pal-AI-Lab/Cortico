/** 使用模拟 DOM 与接口验证页面行为；浏览器源码由变量动态 import 加载，类型由 tsconfig.web.json 检查。 */

import { describe, expect, it, vi, afterEach } from 'vitest';

const MODULES = '../../src/web/client/features/worlds/index.ts';
const FEATURE = '../../src/web/client/features/feature.ts';
const UI = '../../src/web/client/ui/index.ts';
const LIFECYCLE = '../../src/web/client/core/lifecycle.ts';
const HANDOFF = '../../src/web/client/theme/handoff.ts';

type Any = any;

// ---------------------------------------------------------------------------
// 迷你 DOM 桩
// ---------------------------------------------------------------------------

type Listener = (ev: Any) => void;
interface ListenOptions { signal?: AbortSignal; once?: boolean }

class Listeners {
  private map = new Map<string, Listener[]>();
  add(type: string, fn: Listener, opts?: ListenOptions): void {
    if (opts?.signal?.aborted) return;
    const wrapped: Listener = opts?.once ? (ev) => { this.remove(type, wrapped); fn(ev); } : fn;
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
  count(type: string): number { return (this.map.get(type) ?? []).length; }
  total(): number {
    let n = 0;
    for (const arr of this.map.values()) n += arr.length;
    return n;
  }
}

class ClassList {
  constructor(private readonly el: FakeEl) {}
  private get parts(): string[] { return this.el.className.split(' ').filter((s) => s !== ''); }
  private set(parts: string[]): void { this.el.className = parts.join(' '); }
  contains(c: string): boolean { return this.parts.includes(c); }
  add(...cs: string[]): void {
    const p = this.parts;
    for (const c of cs) if (!p.includes(c)) p.push(c);
    this.set(p);
  }
  remove(...cs: string[]): void { this.set(this.parts.filter((c) => !cs.includes(c))); }
  toggle(c: string, force?: boolean): boolean {
    const on = force === undefined ? !this.contains(c) : force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
}

class FakeEl {
  readonly tagName: string;
  readonly ownerDocument: FakeDoc;
  readonly nodeType = 1;
  className = '';
  type = '';
  value = '';
  checked = false;
  disabled = false;
  placeholder = '';
  title = '';
  rows = 0;
  colSpan = 1;
  open = false;
  innerHTML = '';
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  listeners = new Listeners();
  ownText = '';
  readonly classList = new ClassList(this);

  constructor(tag: string, doc: FakeDoc) {
    this.tagName = tag;
    this.ownerDocument = doc;
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) { this.children = []; this.ownText = v; }
  get firstChild(): FakeEl | null { return this.children[0] ?? null; }
  get lastChild(): FakeEl | null { return this.children[this.children.length - 1] ?? null; }

  appendChild(node: FakeEl): FakeEl {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    this.children.push(node);
    return node;
  }
  append(...nodes: FakeEl[]): void { for (const n of nodes) this.appendChild(n); }
  replaceChildren(...nodes: FakeEl[]): void {
    for (const c of this.children.slice()) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  removeChild(node: FakeEl): FakeEl { node.remove(); return node; }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void {
    if (k === 'class') { this.className = v; return; }
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    if (k === 'class') return this.className;
    return this.attrs.get(k) ?? null;
  }
  focus(): void {}
  select(): void {}
  getBoundingClientRect(): { width: number; height: number } { return { width: 0, height: 0 }; }
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
  dispatchEvent(ev: Any): void {
    if (ev.target === undefined) ev.target = this;
    let node: FakeEl | null = this;
    while (node) { node.listeners.fire(ev.type, ev); node = node.parent; }
  }
  /** 这棵子树上一共挂着多少监听（卸载后应当归零）。 */
  countListenersDeep(): number {
    return this.listeners.total() + this.children.reduce((n, c) => n + c.countListenersDeep(), 0);
  }

  find(cls: string): FakeEl | null {
    for (const c of this.children) {
      if (c.classList.contains(cls)) return c;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
  findAll(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) {
      if (c.classList.contains(cls)) out.push(c);
      out.push(...c.findAll(cls));
    }
    return out;
  }
  findTag(tag: string): FakeEl | null {
    for (const c of this.children) {
      if (c.tagName === tag) return c;
      const hit = c.findTag(tag);
      if (hit) return hit;
    }
    return null;
  }
  findAllTag(tag: string): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) {
      if (c.tagName === tag) out.push(c);
      out.push(...c.findAllTag(tag));
    }
    return out;
  }
  /** 按文字或 aria-label 找按钮(卡角的图标键只有 aria-label)。只认 `<button>`。 */
  findButton(text: string): FakeEl | null {
    for (const b of this.findAllTag('button')) {
      if (b.textContent === text || b.getAttribute('aria-label') === text) return b;
    }
    return null;
  }
}

class FakeWindow {
  innerWidth = 1200;
  innerHeight = 800;
  listeners = new Listeners();
  vars: Record<string, string> = {};
  location = { reload: vi.fn() };
  opened: Array<[string, string, string]> = [];
  open(href: string, target: string, features: string): void {
    this.opened.push([href, target, features]);
  }
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
  dispatchEvent(ev: Any): void { this.listeners.fire(ev.type, ev); }
  getComputedStyle(): { getPropertyValue(k: string): string } {
    const vars = this.vars;
    return { getPropertyValue: (k: string): string => vars[k] ?? '' };
  }
}

class FakeDoc {
  listeners = new Listeners();
  body: FakeEl;
  documentElement: FakeEl;
  defaultView: Any;
  constructor() {
    this.body = new FakeEl('body', this);
    this.documentElement = new FakeEl('html', this);
    this.defaultView = new FakeWindow();
  }
  createElement(tag: string): FakeEl { return new FakeEl(tag, this); }
  createElementNS(_ns: string, tag: string): FakeEl { return new FakeEl(tag, this); }
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
  dispatchEvent(ev: Any): void { this.listeners.fire(ev.type, ev); }
}

function fakeMemo(): Any {
  const store: Record<string, unknown> = {};
  return {
    get<T>(k: string, d: T): T { return k in store ? (store[k] as T) : d; },
    set(k: string, v: unknown): void { store[k] = v; },
  };
}

// ---------------------------------------------------------------------------
// 假 fetch
// ---------------------------------------------------------------------------

interface Call { url: string; body: Any }
const calls: Call[] = [];

/** `routes` 的键按前缀匹配，先命中先算——所以更长的键要写在前面。 */
function stubFetch(routes: Record<string, unknown | (() => unknown)>, failing: string[] = []): void {
  vi.stubGlobal('fetch', (url: unknown, init: Any) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (failing.some((f) => u.startsWith(f))) {
      return Promise.resolve({
        ok: false, status: 500,
        text: () => Promise.resolve(JSON.stringify({ error: '服务端说不行' })),
      });
    }
    const key = Object.keys(routes).find((k) => u.startsWith(k));
    const raw = key === undefined ? {} : routes[key];
    const payload = typeof raw === 'function' ? (raw as () => unknown)() : raw;
    return Promise.resolve({
      ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)),
    });
  });
}

async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function mkCtx(caps: Record<string, boolean> = {}): Promise<Any> {
  const { createConsoleUi } = (await import(UI)) as Any;
  const { Lifecycle } = (await import(LIFECYCLE)) as Any;
  const doc = new FakeDoc();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  const lifecycle = new Lifecycle();
  const navigated: Array<{ segments: string[]; query?: Record<string, string> }> = [];
  const ui = createConsoleUi({
    memo: fakeMemo(), overlayHost: doc.body, doc, signal: lifecycle.signal,
  });
  const ctx = {
    root, lifecycle, signal: lifecycle.signal, ui,
    router: {
      navigate(segments: string[], query?: Record<string, string>) {
        navigated.push({ segments, query });
      },
      addLeaveGuard() { return { dispose: (): void => {} }; },
    },
    route: { segments: ['world'], query: {}, raw: '/worlds' },
    capabilities: caps,
    onError: vi.fn(),
    refreshNav: vi.fn(async (): Promise<void> => {}),
  };
  return { ctx, doc, root, lifecycle, navigated, ui, win: doc.defaultView as FakeWindow };
}

/** 答一次模态确认。`yes` 决定点哪一颗。 */
function answerConfirm(doc: FakeDoc, yes: boolean): void {
  const modal = doc.body.find('modal');
  if (!modal) throw new Error('没有弹出确认框');
  const btn = yes
    ? (modal.findButton('仍要继续') ?? modal.findButton('确认'))
    : modal.findButton('取消');
  if (!btn) throw new Error('确认框上找不到按钮');
  btn.dispatchEvent({ type: 'click' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  calls.length = 0;
});

// ---------------------------------------------------------------------------
// 夹具：三态各一，外加一个已隐藏的
// ---------------------------------------------------------------------------

/** 全部开关都挂着的 bot。 */
const ALL_CAPS = { worlds: true, worldVisibility: true, worldActivation: true };

const worlds = [
  {
    id: 'alpha', status: 'active', label: '甲渠道', declared: true, visible: true,
    workspace: 'worlds/alpha', tools: ['alpha_send', 'alpha_read'],
    badges: [{ label: '连接', value: '已连接', tone: 'on' }],
    panels: ['gate'],
    links: [{ label: '打开舞台', href: '/alpha/stage' }],
  },
  {
    id: 'beta', status: 'active', label: '乙渠道', declared: false, visible: false,
    prefixDrifted: true, workspace: 'worlds/beta', tools: [],
  },
  { id: 'gamma', status: 'inactive', label: '丙渠道', declared: false },
  { id: 'delta', status: 'missing', label: '丁渠道', declared: true, reason: '缺少依赖 xyz' },
];

const listRoute = { '/api/worlds': { worlds } };

async function mountWith(routes: Any, caps: Record<string, boolean> = ALL_CAPS): Promise<Any> {
  stubFetch(routes);
  const bag = await mkCtx(caps);
  const { mountWorlds } = (await import(MODULES)) as Any;
  mountWorlds(bag.ctx);
  await flush();
  return bag;
}

/** 按标题找那张卡（`h3` 的文字以 World 名打头）。 */
function cardOf(root: FakeEl, title: string): FakeEl {
  const hit = root.findAll('iocard').find((c) => c.findTag('h3')!.textContent.startsWith(title));
  if (!hit) throw new Error(`没有找到「${title}」的卡片`);
  return hit;
}

// ---------------------------------------------------------------------------
// 三态
// ---------------------------------------------------------------------------

describe('World 页的三态卡片', () => {
  it('三态各一张卡，顺序是已挂载 → 未激活 → 未安装', async () => {
    const { root } = await mountWith(listRoute);
    expect(root.findTag('h1')!.textContent).toBe('World');
    const cards = root.findAll('iocard');
    expect(cards.length).toBe(4);
    expect(cards.map((c: FakeEl) => c.findTag('h3')!.textContent.slice(0, 3)))
      .toEqual(['甲渠道', '乙渠道', '丙渠道', '丁渠道']);
    // 三态各有各的样子：未激活与未安装是两种虚线卡，已隐藏的那张压低
    expect(cards[2].classList.contains('iocard-inactive')).toBe(true);
    expect(cards[3].classList.contains('iocard-missing')).toBe(true);
    expect(cards[1].classList.contains('iocard-hidden')).toBe(true);
    expect(cards[0].classList.contains('iocard-hidden')).toBe(false);
  });

  it('已挂载： World 声明的徽标原样上卡，工具与工作区进 kv，可见性写在药丸上', async () => {
    const { root } = await mountWith(listRoute);
    const card = cardOf(root, '甲渠道');
    expect(card.findTag('h3')!.textContent).toContain('alpha · 2 个工具');
    const pills = card.findAll('pill').map((p: FakeEl) => p.textContent);
    expect(pills).toContain('连接 已连接');   // 徽标：控制台不解释语义，原样摆
    expect(pills).toContain('对 agent 可见');
    expect(pills).toContain('Persona定义');
    expect(card.find('kvtable')!.textContent).toContain('alpha_send、alpha_read');
    expect(card.find('kvtable')!.textContent).toContain('worlds/alpha');
  });

  it('已隐藏 + 前缀漂移：药丸换成「已隐藏」，另有一颗待重载与一行说明', async () => {
    const { root } = await mountWith(listRoute);
    const card = cardOf(root, '乙渠道');
    const pills = card.findAll('pill').map((p: FakeEl) => p.textContent);
    expect(pills).toContain('已隐藏');
    expect(pills).toContain('前缀待重载');
    expect(pills).toContain('选配外挂');
    expect(card.textContent).toContain('环境提示词与工具声明将在前缀重载后更新。');
    const body = card.find('sheetbody')!;
    expect(body.children[body.children.length - 1].classList.contains('actionbar')).toBe(true);
    // 没有工具的 World 照样有 kv，只是印「（无）」
    expect(card.find('kvtable')!.textContent).toContain('（无）');
  });

  it('不可用的 World 显示服务端 reason，且不提供操作按钮', async () => {
    const { root } = await mountWith(listRoute);
    const card = cardOf(root, '丁渠道');
    expect(card.findAll('pill').map((p: FakeEl) => p.textContent)).toContain('不可用');
    expect(card.find('msgline')!.textContent).toBe('缺少依赖 xyz');
    expect(card.find('msgline')!.classList.contains('bad')).toBe(true);
    expect(card.findAllTag('button').length).toBe(0);
  });

  it('不可用的 World 在缺少 reason 时显示默认说明', async () => {
    const { root } = await mountWith({
      '/api/worlds': { worlds: [{ id: 'epsilon', status: 'missing', label: '戊', declared: true }] },
    });
    expect(cardOf(root, '戊').textContent).toContain('无法加载这个 World。');
  });

  it('未激活：卡角只有一颗激活键；没接激活开关时改成一句怎么手改 config 的说明', async () => {
    const a = await mountWith(listRoute);
    const card = cardOf(a.root, '丙渠道');
    expect(card.findAll('pill').map((p: FakeEl) => p.textContent)).toContain('未激活');
    expect(card.findButton('激活 World')).not.toBeNull();
    expect(card.findButton('重启 World')).toBeNull();
    expect(card.findButton('停用 World')).toBeNull();

    const b = await mountWith(listRoute, { worlds: true });
    const card2 = cardOf(b.root, '丙渠道');
    expect(card2.findButton('激活 World')).toBeNull();
    expect(card2.textContent).toContain('worlds.gamma.enabled 改为 true');
  });

  it('已挂载：卡角依次是可见性、重启、停用三颗图标键，都在 iocorner 里', async () => {
    const { root } = await mountWith(listRoute);
    const card = cardOf(root, '甲渠道');
    const corner = card.find('iocorner')!;
    expect(corner.findAllTag('button').map((b: FakeEl) => b.getAttribute('aria-label')))
      .toEqual(['对 agent 隐藏', '重启 World', '停用 World']);
    // 图标键没有文字,只有图形
    for (const b of corner.findAllTag('button')) expect(b.textContent).toBe('');
    // 已隐藏的那张,第一颗写的是「对 agent 显示」
    expect(cardOf(root, '乙渠道').find('iocorner')!.findAllTag('button')[0].getAttribute('aria-label'))
      .toBe('对 agent 显示');
  });

  it('概览行按三态计数；空清单只留一句空态', async () => {
    const { root } = await mountWith(listRoute);
    const sum = root.find('sheet')!.findAll('pill').map((p: FakeEl) => p.textContent);
    expect(sum.slice(0, 4)).toEqual(['可见 1', '已隐藏 1', '未激活 1', '不可用 1']);

    const b = await mountWith({ '/api/worlds': { worlds: [] } });
    expect(b.root.find('iogrid')!.textContent).toContain('没有任何 World');
  });

  it('清单取不到 → 一句空态，不是一片白', async () => {
    stubFetch({}, ['/api/worlds']);
    const { ctx, root } = await mkCtx(ALL_CAPS);
    const { mountWorlds } = (await import(MODULES)) as Any;
    mountWorlds(ctx);
    await flush();
    expect(root.textContent).toContain('World 清单加载失败');
    expect(root.textContent).toContain('服务端说不行');
  });
});

// ---------------------------------------------------------------------------
// 可见性（热开关）
// ---------------------------------------------------------------------------

describe('可见性开关', () => {
  it('打 /api/worlds/visibility，载荷是 { id, visible }，完事重取清单', async () => {
    const { root } = await mountWith({
      '/api/worlds/visibility': { ok: true, result: '已隐藏', driftedWorlds: [] },
      ...listRoute,
    });
    calls.length = 0;
    cardOf(root, '甲渠道').findButton('对 agent 隐藏')!.dispatchEvent({ type: 'click' });
    await flush();

    expect(calls[0].url).toBe('/api/worlds/visibility');
    expect(calls[0].body).toEqual({ id: 'alpha', visible: false });
    expect(root.find('msgline')!.textContent).toBe('已隐藏');
    expect(calls.some((c) => c.url === '/api/worlds' && c.body === undefined)).toBe(true);
  });

  it('已隐藏的 World 上那颗写的是「对 agent 显示」，载荷 visible:true', async () => {
    const { root } = await mountWith({
      '/api/worlds/visibility': { ok: true, result: '已显示' },
      ...listRoute,
    });
    calls.length = 0;
    cardOf(root, '乙渠道').findButton('对 agent 显示')!.dispatchEvent({ type: 'click' });
    await flush();
    expect(calls[0].body).toEqual({ id: 'beta', visible: true });
  });

  it('服务端报了前缀漂移 → 问一句；答"是"才打重载端点，答"否"什么都不发', async () => {
    const routes = {
      '/api/worlds/visibility': { ok: true, result: '已隐藏', driftedWorlds: ['alpha'] },
      '/api/session/reload-prefix': { ok: true, result: '前缀已重载' },
      ...listRoute,
    };
    const no = await mountWith(routes);
    cardOf(no.root, '甲渠道').findButton('对 agent 隐藏')!.dispatchEvent({ type: 'click' });
    await flush();

    calls.length = 0;
    answerConfirm(no.doc, false);
    await flush();
    expect(calls.length).toBe(0);

    const yes = await mountWith(routes);
    cardOf(yes.root, '甲渠道').findButton('对 agent 隐藏')!.dispatchEvent({ type: 'click' });
    await flush();
    calls.length = 0;
    answerConfirm(yes.doc, true);
    await flush();
    expect(calls[0].url).toBe('/api/session/reload-prefix');
    expect(yes.root.find('msgline')!.textContent).toBe('前缀已重载');
  });

  it('切换失败 → 一行红字，按钮解禁（还能再点）', async () => {
    const { root } = await mountWith({ ...listRoute, '/api/worlds/visibility': {} });
    stubFetch({ ...listRoute }, ['/api/worlds/visibility']);
    const btn = cardOf(root, '甲渠道').findButton('对 agent 隐藏')!;
    btn.dispatchEvent({ type: 'click' });
    await flush();
    expect(root.find('msgline')!.textContent).toContain('服务端说不行');
    expect(root.find('msgline')!.classList.contains('bad')).toBe(true);
    expect(btn.disabled).toBe(false);
  });

  it('没接可见性开关时那颗根本不画（不是画出来等 503）', async () => {
    const { root } = await mountWith(listRoute, { worlds: true, worldActivation: true });
    expect(cardOf(root, '甲渠道').findButton('对 agent 隐藏')).toBeNull();
    expect(cardOf(root, '甲渠道').findButton('→ 详情')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 激活（重启式）
// ---------------------------------------------------------------------------

describe('激活 / 停用 / 重启（热生效）', () => {
  const routes = {
    '/api/worlds/activation': { ok: true, result: '已写回 config.json 并挂载' },
    '/api/worlds/restart': { ok: true, result: '已重启' },
    ...listRoute,
  };

  it('激活不问,直接打 activation 端点,载荷 { id, enabled:true },完事重取清单', async () => {
    const { root, doc } = await mountWith(routes);
    calls.length = 0;
    cardOf(root, '丙渠道').findButton('激活 World')!.dispatchEvent({ type: 'click' });
    await flush();
    expect(doc.body.find('modal')).toBeNull();
    expect(calls[0].url).toBe('/api/worlds/activation');
    expect(calls[0].body).toEqual({ id: 'gamma', enabled: true });
    expect(root.find('msgline')!.textContent).toBe('已写回 config.json 并挂载');
    expect(calls.some((c) => c.url === '/api/worlds' && c.body === undefined)).toBe(true);
    // 没有重启遮罩:进程没重启
    expect(doc.body.find('busy')).toBeNull();
  });

  it('停用先问一句;答"否"什么都不发,按钮解禁', async () => {
    const { root, doc } = await mountWith(routes);
    const btn = cardOf(root, '甲渠道').findButton('停用 World')!;
    btn.dispatchEvent({ type: 'click' });
    expect(doc.body.find('modal')!.textContent).toContain('worlds.alpha.enabled=false');
    calls.length = 0;
    answerConfirm(doc, false);
    await flush();
    expect(calls.length).toBe(0);
    expect(btn.disabled).toBe(false);
  });

  it('停用答"是"→ 载荷 enabled:false,完事重取清单', async () => {
    const { root, doc } = await mountWith(routes);
    calls.length = 0;
    cardOf(root, '甲渠道').findButton('停用 World')!.dispatchEvent({ type: 'click' });
    answerConfirm(doc, true);
    await flush();
    expect(calls[0].url).toBe('/api/worlds/activation');
    expect(calls[0].body).toEqual({ id: 'alpha', enabled: false });
    expect(calls.some((c) => c.url === '/api/worlds' && c.body === undefined)).toBe(true);
  });

  it('重启先问一句;答"是"打 restart 端点,载荷 { id }', async () => {
    const { root, doc } = await mountWith(routes);
    cardOf(root, '甲渠道').findButton('重启 World')!.dispatchEvent({ type: 'click' });
    expect(doc.body.find('modal')!.textContent).toContain('重启 World 生效');
    calls.length = 0;
    answerConfirm(doc, true);
    await flush();
    expect(calls[0].url).toBe('/api/worlds/restart');
    expect(calls[0].body).toEqual({ id: 'alpha' });
    expect(root.find('msgline')!.textContent).toBe('已重启');
  });

  it('激活/停用成功后各调一次 refreshNav 重排左栏;拒绝时不调', async () => {
    const bag = await mountWith(routes);
    bag.ctx.refreshNav.mockClear();
    cardOf(bag.root, '丙渠道').findButton('激活 World')!.dispatchEvent({ type: 'click' });
    await flush();
    expect(bag.ctx.refreshNav).toHaveBeenCalledTimes(1);

    bag.ctx.refreshNav.mockClear();
    cardOf(bag.root, '甲渠道').findButton('停用 World')!.dispatchEvent({ type: 'click' });
    answerConfirm(bag.doc, true);
    await flush();
    expect(bag.ctx.refreshNav).toHaveBeenCalledTimes(1);

    stubFetch({ ...listRoute }, ['/api/worlds/activation']);
    bag.ctx.refreshNav.mockClear();
    cardOf(bag.root, '丙渠道').findButton('激活 World')!.dispatchEvent({ type: 'click' });
    await flush();
    expect(bag.ctx.refreshNav).not.toHaveBeenCalled();
  });

  it('服务端拒绝(前置检查没过)→ 一行红字,按钮解禁', async () => {
    const { root } = await mountWith(routes);
    stubFetch({ ...listRoute }, ['/api/worlds/activation']);
    const btn = cardOf(root, '丙渠道').findButton('激活 World')!;
    btn.dispatchEvent({ type: 'click' });
    await flush();
    expect(root.find('msgline')!.textContent).toContain('服务端说不行');
    expect(root.find('msgline')!.classList.contains('bad')).toBe(true);
    expect(btn.disabled).toBe(false);
  });

  it('没接激活开关时重启与停用两颗都不画', async () => {
    const { root } = await mountWith(listRoute, { worlds: true, worldVisibility: true });
    const card = cardOf(root, '甲渠道');
    expect(card.findButton('停用 World')).toBeNull();
    expect(card.findButton('重启 World')).toBeNull();
    expect(card.findButton('对 agent 隐藏')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 详情入口与前缀重载
// ---------------------------------------------------------------------------

describe('详情入口', () => {
  it('详情链接使用 provider/world:<id> 路由', async () => {
    const { root, navigated } = await mountWith(listRoute);
    cardOf(root, '甲渠道').findButton('→ 详情')!.dispatchEvent({ type: 'click' });
    expect(navigated).toEqual([{ segments: ['provider', 'world:alpha'], query: undefined }]);

    cardOf(root, '乙渠道').findButton('→ 详情')!.dispatchEvent({ type: 'click' });
    expect(navigated[1].segments).toEqual(['provider', 'world:beta']);
  });

  it('World 声明的链接原样开新窗；没声明就没有那颗键', async () => {
    const { root, win } = await mountWith(listRoute);
    cardOf(root, '甲渠道').findButton('打开舞台')!.dispatchEvent({ type: 'click' });
    expect(win.opened).toEqual([['/alpha/stage', '_blank', 'noopener']]);
    expect(cardOf(root, '乙渠道').findButton('打开舞台')).toBeNull();
  });

  it('显式继承主题的链接在点击时带走当前配色，仍以 noopener 打开', async () => {
    const { root, doc, win } = await mountWith({
      '/api/worlds': {
        worlds: [{
          id: 'alpha', status: 'active', label: '甲渠道', declared: true,
          links: [{
            label: '打开编辑器',
            href: '/alpha/editor?room=7',
            inheritTheme: true,
          }],
        }],
      },
    });
    const { THEME_HANDOFF_FRAGMENT_KEY } = (await import(HANDOFF)) as Any;
    doc.documentElement.setAttribute('data-color-mode', 'dark');
    win.vars['--paper'] = '#112233';

    cardOf(root, '甲渠道').findButton('打开编辑器')!.dispatchEvent({ type: 'click' });
    expect(win.opened).toHaveLength(1);
    expect(win.opened[0][0]).toMatch(
      new RegExp(`^/alpha/editor\\?room=7#${THEME_HANDOFF_FRAGMENT_KEY}=[A-Za-z0-9_-]+$`, 'u'),
    );
    expect(win.opened[0].slice(1)).toEqual(['_blank', 'noopener']);
  });

  it('概览行上的重载键打 /api/session/reload-prefix 并重取清单', async () => {
    const { root } = await mountWith({
      '/api/session/reload-prefix': { ok: true, result: '前缀已重载' },
      ...listRoute,
    });
    calls.length = 0;
    root.findButton('↻ 重载系统前缀')!.dispatchEvent({ type: 'click' });
    await flush();
    expect(calls[0].url).toBe('/api/session/reload-prefix');
    expect(root.find('msgline')!.textContent).toBe('前缀已重载');
    expect(calls.some((c) => c.url === '/api/worlds')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// feature 契约与卸载
// ---------------------------------------------------------------------------

describe('feature 契约', () => {
  it('route 沿用 worlds（书签不断）、needsAny 是 worlds，缺了就整页不渲染', async () => {
    const { featureAvailable } = (await import(FEATURE)) as Any;
    const f = ((await import(MODULES)) as Any).worldsFeature;
    expect(f.route).toBe('world');
    expect(f.label).toBe('World 总览');
    expect(f.navMode).toBe('world-root');
    expect(f.needsAny).toEqual(['worlds']);
    expect(featureAvailable(f, {})).toBe(false);
    expect(featureAvailable(f, { worlds: false })).toBe(false);
    expect(featureAvailable(f, { worlds: true })).toBe(true);
  });

  it('卸载后定时器与监听都归零', async () => {
    vi.useFakeTimers();
    stubFetch({ ...listRoute });
    const { ctx, root, lifecycle } = await mkCtx(ALL_CAPS);
    const before = vi.getTimerCount();
    const { mountWorlds } = (await import(MODULES)) as Any;
    mountWorlds(ctx);
    await flush();
    // 卡上的键都挂着监听
    expect(root.countListenersDeep()).toBeGreaterThan(0);

    lifecycle.dispose();
    await flush();
    expect(vi.getTimerCount()).toBe(before);
    expect(root.countListenersDeep()).toBe(0);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.length).toBe(0); // 离开之后一个请求都不再发
  });

  it('源码里没有裸 setInterval / setTimeout，不碰 document.body 与 window.__，也不自己 fetch', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = 'src/web/client/features/worlds';
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      // 架构约束只检查可执行源码，忽略注释。
      const src = readFileSync(`${dir}/${name}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(src, name).not.toMatch(/(^|[^.\w])setInterval\s*\(/);
      expect(src, name).not.toMatch(/(^|[^.\w])setTimeout\s*\(/);
      expect(src, name).not.toMatch(/document\s*\.\s*body/);
      expect(src, name).not.toMatch(/window\s*\.\s*__/);
      expect(src, name).not.toMatch(/(^|[^.\w])fetch\s*\(/);
    }
  });
});
