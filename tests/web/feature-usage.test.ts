/**
 * 用量、成本与定价页验证组合展开、寻址、配色分级和格式化。
 * 变量形式的动态 import 避免根 tsconfig 纳入 DOM 代码；浏览器类型由 tsconfig.web.json 检查。
 * 迷你 DOM 支持图表与 tooltip 所需的 classList、style、createElementNS；DOM 用例覆盖渲染、capabilities 门控以及卸载后的定时器和浮层释放。
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

const CHART = '../../src/web/client/features/usage/chart.ts';
const RANGE = '../../src/web/client/features/usage/range.ts';
const LABELS = '../../src/web/client/features/usage/labels.ts';
const TOOLTIP = '../../src/web/client/features/usage/tooltip.ts';
const STATE = '../../src/web/client/features/usage/state.ts';
const USAGE = '../../src/web/client/features/usage/index.ts';
const FEATURE = '../../src/web/client/features/feature.ts';
const UI = '../../src/web/client/ui/index.ts';
const LIFECYCLE = '../../src/web/client/core/lifecycle.ts';
const THEME = '../../src/web/client/theme/studio.ts';
const PALETTE = '../../src/web/client/theme/palette.ts';

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
  count(type: string): number {
    return (this.map.get(type) ?? []).length;
  }
}

/** class 列表。桩里就是 `className` 那根字符串的读写视图。 */
class ClassList {
  constructor(private readonly el: FakeEl) {}
  private get parts(): string[] {
    return this.el.className.split(' ').filter((s) => s !== '');
  }
  private set(parts: string[]): void {
    this.el.className = parts.join(' ');
  }
  contains(c: string): boolean { return this.parts.includes(c); }
  add(...cs: string[]): void {
    const p = this.parts;
    for (const c of cs) if (!p.includes(c)) p.push(c);
    this.set(p);
  }
  remove(...cs: string[]): void {
    this.set(this.parts.filter((c) => !cs.includes(c)));
  }
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
  /** 元素上的自由属性（`type` / `value` / `min` / `step` …）在桩里就是普通字段。 */
  type = '';
  value = '';
  checked = false;
  disabled = false;
  placeholder = '';
  title = '';
  rows = 0;
  colSpan = 1;
  spellcheck = true;
  min = '';
  max = '';
  step = '';
  open = false;
  innerHTML = '';
  /** 布局：桩里没有真实布局，测试自己写死 */
  clientWidth = 0;
  /** `style.left = …` 与 `style.setProperty('--x', …)` 两种写法都要认（后者是主题在用）。 */
  style: Any = {
    setProperty(this: Any, k: string, v: string): void { this[k] = v; },
    removeProperty(this: Any, k: string): void { delete this[k]; },
  };
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  /** `data-*` 的对侧。主题工作室往根元素上写 `dataset.colorMode`。 */
  dataset: Record<string, string> = {};
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
  set textContent(v: string) {
    this.children = [];
    this.ownText = v;
  }
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
  /** `class` 与 `className` 是同一份真相（SVG 那边只能走 setAttribute）。 */
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
  getBoundingClientRect(): { width: number; height: number } { return { width: 120, height: 60 }; }
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
  dispatchEvent(ev: Any): void {
    if (ev.target === undefined) ev.target = this;
    let node: FakeEl | null = this;
    while (node) { node.listeners.fire(ev.type, ev); node = node.parent; }
  }
  countListeners(type: string): number { return this.listeners.count(type); }

  /** 递归找第一个 class 含某个词的后代 */
  find(cls: string): FakeEl | null {
    for (const c of this.children) {
      if (c.classList.contains(cls)) return c;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
  /** 递归收集所有 class 含某个词的后代 */
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
  /**
   * 按文字找一颗按钮。**不能用"文本等于某串的第一个后代"**：包着按钮的
   * `.rowbar` 文本也等于那串，而事件是往上冒的，点在包装上什么都不会发生。
   */
  findButton(text: string): FakeEl | null {
    for (const b of this.findAllTag('button')) if (b.textContent === text) return b;
    return null;
  }
}

class FakeWindow {
  innerWidth = 1200;
  innerHeight = 800;
  listeners = new Listeners();
  /** 主题变量表。`themeColor` 读的就是它。 */
  vars: Record<string, string> = { '--chart-1': '#336699', '--ink-dim': '#777777' };
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
  dispatchEvent(ev: Any): void { this.listeners.fire(ev.type, ev); }
  countListeners(type: string): number { return this.listeners.count(type); }
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
  constructor(view: Any = new FakeWindow()) {
    this.body = new FakeEl('body', this);
    this.documentElement = new FakeEl('html', this);
    this.defaultView = view;
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

interface Routes { [prefix: string]: unknown }

const seen: string[] = [];

function stubFetch(routes: Routes, fail?: string): void {
  vi.stubGlobal('fetch', (url: unknown) => {
    const u = String(url);
    seen.push(u);
    if (fail && u.startsWith(fail)) {
      return Promise.resolve({
        ok: false, status: 500,
        text: () => Promise.resolve(JSON.stringify({ error: '炸了' })),
      });
    }
    const hit = Object.keys(routes).find((k) => u.startsWith(k));
    return Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify(hit ? routes[hit] : {})),
    });
  });
}

/** 让所有已 resolve 的微任务跑完（假 fetch 全是微任务，不用等真时钟）。 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// 造一份 FeatureContext
// ---------------------------------------------------------------------------

async function mkCtx(caps: Record<string, boolean> = {}): Promise<Any> {
  const { createConsoleUi } = (await import(UI)) as Any;
  const { Lifecycle } = (await import(LIFECYCLE)) as Any;
  const doc = new FakeDoc();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  const lifecycle = new Lifecycle();
  const guards: Array<() => string | null> = [];
  const ui = createConsoleUi({
    memo: fakeMemo(), overlayHost: doc.body, doc, signal: lifecycle.signal,
  });
  const ctx = {
    root, lifecycle, signal: lifecycle.signal, ui,
    router: {
      addLeaveGuard(fn: () => string | null) {
        guards.push(fn);
        return { dispose: (): void => { guards.splice(guards.indexOf(fn), 1); } };
      },
    },
    route: { segments: [], query: {}, raw: '' },
    capabilities: caps,
    onError: vi.fn(),
  };
  return { ctx, doc, root, lifecycle, guards, win: doc.defaultView as FakeWindow };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  seen.length = 0;
  // 主题工作室是进程级单例；每条用例给它一份干净的，免得互相看见对方的假文档
  const { disposeThemeStudio } = (await import(THEME)) as Any;
  disposeThemeStudio();
});

// ---------------------------------------------------------------------------
// 样本数据
// ---------------------------------------------------------------------------

const accum = (o: Partial<Record<string, number>> = {}): Any => ({
  calls: 0, promptTokens: 0, completionTokens: 0,
  cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0,
  cost: 0, costCacheHit: 0, costCacheMiss: 0, costOutput: 0, ...o,
});

/** 两个桶 × 两个角色 × 两个模型，数字都挑得能一眼验算。 */
function sample(): Any {
  const p1 = {
    bucket: '2026-08-01',
    ...accum({
      calls: 4, promptTokens: 1000, completionTokens: 200, cacheHitTokens: 800,
      cacheMissTokens: 200, reasoningTokens: 50, cost: 3,
      costCacheHit: 1, costCacheMiss: 1, costOutput: 1,
    }),
    byRole: {
      alpha: accum({ calls: 3, cost: 2, costCacheHit: 1, costOutput: 1, cacheHitTokens: 600, completionTokens: 150 }),
      beta: accum({ calls: 1, cost: 1, costCacheMiss: 1, cacheMissTokens: 200, completionTokens: 50 }),
    },
    byModel: {
      'm-big': accum({ calls: 3, cost: 2.5 }),
      'm-small': accum({ calls: 1, cost: 0.5 }),
    },
    byRoleModel: {
      alpha: { 'm-big': accum({ calls: 3, cost: 2, costCacheHit: 1, costOutput: 1 }) },
      beta: { 'm-small': accum({ calls: 1, cost: 1, costCacheMiss: 1 }) },
    },
  };
  const p2 = {
    bucket: '2026-08-02',
    ...accum({ calls: 2, promptTokens: 500, completionTokens: 100, cacheHitTokens: 400, cacheMissTokens: 100, cost: 1, costCacheHit: 0.5, costOutput: 0.5 }),
    byRole: { alpha: accum({ calls: 2, cost: 1, costCacheHit: 0.5, costOutput: 0.5 }) },
    byModel: { 'm-big': accum({ calls: 2, cost: 1 }) },
    byRoleModel: { alpha: { 'm-big': accum({ calls: 2, cost: 1 }) } },
  };
  return {
    currency: 'USD',
    bucket: 'day',
    from: '2026-08-01',
    to: '2026-08-02',
    series: [p1, p2],
    totals: {
      key: 'total',
      ...accum({
        calls: 6, promptTokens: 1500, completionTokens: 300, cacheHitTokens: 1200,
        cacheMissTokens: 300, reasoningTokens: 50, cost: 4,
        costCacheHit: 1.5, costCacheMiss: 1, costOutput: 1.5,
      }),
      cacheHitRate: 0.8,
    },
    byRole: [
      { key: 'alpha', label: '甲', ...accum({ calls: 5, cost: 3 }), cacheHitRate: 0.9 },
      { key: 'beta', ...accum({ calls: 1, cost: 1 }), cacheHitRate: null },
    ],
    byModel: [
      { key: 'm-big', ...accum({ calls: 5, cost: 3.5 }), cacheHitRate: 0.8 },
      { key: 'm-small', ...accum({ calls: 1, cost: 0.5 }), cacheHitRate: 0.1 },
    ],
  };
}

// ---------------------------------------------------------------------------
// 纯函数：取值归一
// ---------------------------------------------------------------------------

describe('取值归一', () => {
  it('uMetricVal：token 是输入+输出，空对象一律 0（不是 NaN）', async () => {
    const c = (await import(CHART)) as Any;
    const o = accum({ cost: 1.5, calls: 3, promptTokens: 10, completionTokens: 4 });
    expect(c.uMetricVal(o, 'cost')).toBe(1.5);
    expect(c.uMetricVal(o, 'calls')).toBe(3);
    expect(c.uMetricVal(o, 'tokens')).toBe(14);
    expect(c.uMetricVal(null, 'cost')).toBe(0);
    expect(c.uMetricVal({}, 'tokens')).toBe(0);
  });

  it('uTypeVal：cost 走三档成本，其余走三档 token（输出档是 completionTokens）', async () => {
    const c = (await import(CHART)) as Any;
    const o = accum({
      costCacheHit: 1, costCacheMiss: 2, costOutput: 3,
      cacheHitTokens: 10, cacheMissTokens: 20, completionTokens: 30,
    });
    expect([c.uTypeVal(o, 'cacheHit', 'cost'), c.uTypeVal(o, 'cacheMiss', 'cost'), c.uTypeVal(o, 'output', 'cost')])
      .toEqual([1, 2, 3]);
    expect([c.uTypeVal(o, 'cacheHit', 'tokens'), c.uTypeVal(o, 'cacheMiss', 'tokens'), c.uTypeVal(o, 'output', 'tokens')])
      .toEqual([10, 20, 30]);
  });

  it('cacheRateOf：分母为 0 给 null，不是 0——"没有输入"与"一次没命中"不是一回事', async () => {
    const c = (await import(CHART)) as Any;
    expect(c.cacheRateOf(accum({ cacheHitTokens: 3, cacheMissTokens: 1 }))).toBe(0.75);
    expect(c.cacheRateOf(accum({ cacheHitTokens: 0, cacheMissTokens: 5 }))).toBe(0);
    expect(c.cacheRateOf(accum())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 纯函数：组合展开与寻址
// ---------------------------------------------------------------------------

describe('buildComposites / compVal', () => {
  it('无维度 → 一根合计柱（[[]]，不是空数组）', async () => {
    const c = (await import(CHART)) as Any;
    const combos = c.buildComposites(sample(), []);
    expect(combos).toEqual([[]]);
    expect(c.compId([])).toBe('');
    expect(c.compLabel(sample(), [])).toBe('合计');
  });

  it('三维全开 → 笛卡尔积，且顺序恒为 类型 > 角色 > 模型', async () => {
    const c = (await import(CHART)) as Any;
    const d = sample();
    const dims = c.activeDims({ type: true, role: true, model: true }, true);
    expect(dims).toEqual(['type', 'role', 'model']);
    const combos = c.buildComposites(d, dims);
    expect(combos.length).toBe(3 * 2 * 2);
    expect(combos[0].map((x: Any) => x.dim)).toEqual(['type', 'role', 'model']);
    // 勾选顺序不影响嵌套序
    expect(c.activeDims({ model: true, role: true }, true)).toEqual(['role', 'model']);
    // 调用图没有类型档：allowType=false 时 type 被忽略
    expect(c.activeDims({ type: true, role: true }, false)).toEqual(['role']);
  });

  it('compScopeAccum：角色+模型走交叉表，单维走单维表，无维度就是整个桶', async () => {
    const c = (await import(CHART)) as Any;
    const p = sample().series[0];
    expect(c.compScopeAccum(p, []).calls).toBe(4);
    expect(c.compScopeAccum(p, [{ dim: 'role', key: 'alpha' }]).calls).toBe(3);
    expect(c.compScopeAccum(p, [{ dim: 'model', key: 'm-small' }]).calls).toBe(1);
    expect(c.compScopeAccum(p, [{ dim: 'role', key: 'alpha' }, { dim: 'model', key: 'm-big' }]).calls).toBe(3);
    // 交叉格里没有的组合 → undefined（而不是掉回单维表，那会把值算重）
    expect(c.compScopeAccum(p, [{ dim: 'role', key: 'alpha' }, { dim: 'model', key: 'm-small' }])).toBeUndefined();
  });

  it('compVal：类型维只改"取哪一档"，不改寻址；寻址落空给 0', async () => {
    const c = (await import(CHART)) as Any;
    const p = sample().series[0];
    expect(c.compVal(p, [], 'cost')).toBe(3);
    expect(c.compVal(p, [{ dim: 'type', key: 'cacheHit' }], 'cost')).toBe(1);
    expect(c.compVal(p, [{ dim: 'type', key: 'output' }, { dim: 'role', key: 'alpha' }], 'cost')).toBe(1);
    expect(c.compVal(p, [{ dim: 'role', key: 'ghost' }], 'cost')).toBe(0);
  });

  it('compId 用不会出现在键里的分隔符，两段拼不出同一个 id', async () => {
    const c = (await import(CHART)) as Any;
    const a = c.compId([{ dim: 'role', key: 'a' }, { dim: 'model', key: 'b' }]);
    const b = c.compId([{ dim: 'role', key: 'a:model' }, { dim: 'model', key: 'b' }]);
    expect(a).not.toBe(b);
    expect(a.includes('␟')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 纯函数：标签与配色（这里钉的是"框架不认识任何角色名"）
// ---------------------------------------------------------------------------

describe('标签与配色', () => {
  it('角色/模型的显示名只来自数据里的 label，给不出就原样显示 id', async () => {
    const c = (await import(CHART)) as Any;
    const d = sample();
    expect(c.dimKeyLabel(d, 'role', 'alpha')).toBe('甲');   // 声明方给了
    expect(c.dimKeyLabel(d, 'role', 'beta')).toBe('beta');  // 没给 → id 原文
    expect(c.dimKeyLabel(d, 'role', 'never-seen')).toBe('never-seen');
    expect(c.dimKeyLabel(d, 'model', 'm-big')).toBe('m-big');
    // 三档成本分量是框架自己的记账口径，有固定中文名
    expect(c.dimKeyLabel(d, 'type', 'cacheHit')).toBe('命中缓存');
  });

  it('调色板位次按键的字典序取：成本排名变了颜色也不跟着换位置', async () => {
    const c = (await import(CHART)) as Any;
    const keys = ['zeta', 'alpha', 'mid'];
    const seats = keys.map((k) => c.paletteSeat(keys, k));
    expect(c.paletteSeat(keys, 'alpha')).toBe('chart-1');
    expect(c.paletteSeat(keys, 'mid')).toBe('chart-2');
    expect(c.paletteSeat(keys, 'zeta')).toBe('chart-3');
    // 换一个出现顺序，落座不变
    expect(['mid', 'zeta', 'alpha'].map((k) => c.paletteSeat(['mid', 'zeta', 'alpha'], k)))
      .toEqual(['chart-2', 'chart-3', 'chart-1']);
    expect(new Set(seats).size).toBe(3);
    // 不认识的键落回首色而不是 undefined
    expect(c.paletteSeat(keys, 'ghost')).toBe('chart-1');
  });

  it('hexToHsl：三位简写展开，灰色的饱和度是 0', async () => {
    const c = (await import(PALETTE)) as Any;
    expect(c.hexToHsl('#ffffff')).toEqual({ h: 0, s: 0, l: 100 });
    expect(c.hexToHsl('#000000')).toEqual({ h: 0, s: 0, l: 0 });
    expect(c.hexToHsl('#808080').s).toBe(0);
    expect(c.hexToHsl('#f00')).toEqual(c.hexToHsl('#ff0000'));
    const red = c.hexToHsl('#ff0000');
    expect(Math.round(red.h)).toBe(0);
    expect(Math.round(red.s)).toBe(100);
    expect(Math.round(c.hexToHsl('#00ff00').h)).toBe(120);
    expect(Math.round(c.hexToHsl('#0000ff').h)).toBe(240);
  });

  it('compositeColors：无维度给一个 CSS 变量；同色系内按位次分明度，且钳在可读区间', async () => {
    const c = (await import(CHART)) as Any;
    const d = sample();
    const flat = c.compositeColors(d, [[]], [], () => '#336699');
    expect(flat['']).toBe('var(--accent-2)');

    const dims = ['role', 'model'];
    const combos = c.buildComposites(d, dims);
    const colors = c.compositeColors(d, combos, dims, () => '#336699');
    const vals = Object.values(colors) as string[];
    expect(vals.length).toBe(4);
    // 每个色系两员 → 都走 hsl 分级，且没有 NaN
    for (const v of vals) {
      expect(v.startsWith('hsl(')).toBe(true);
      expect(v.includes('NaN')).toBe(false);
    }
    // 明度钳在 24–82
    for (const v of vals) {
      const l = Number(/,(\d+)%\)$/.exec(v)![1]);
      expect(l).toBeGreaterThanOrEqual(24);
      expect(l).toBeLessThanOrEqual(82);
    }
    // 单员色系原样用基色（不做无意义的分级）
    const one = c.compositeColors(d, [[{ dim: 'role', key: 'alpha' }]], ['role'], () => '#336699');
    expect(one['role:alpha']).toBe('#336699');
  });

  it('themeColor：读 --token；不是合法 hex 就退 --ink-dim；再不行给一个确定的兜底色', async () => {
    const { themeColor } = (await import(LABELS)) as Any;
    const doc = new FakeDoc();
    const win = doc.defaultView as FakeWindow;
    expect(themeColor(doc, 'chart-1')).toBe('#336699');
    // 变量没定义 → 退 ink-dim
    expect(themeColor(doc, 'chart-9')).toBe('#777777');
    // ink-dim 也不是 hex → 兜底必须仍是合法 hex，否则 hexToHsl 会算出 NaN
    win.vars['--ink-dim'] = 'rgb(1,2,3)';
    const fallback = themeColor(doc, 'chart-9');
    expect(/^#[0-9a-f]{6}$/i.test(fallback)).toBe(true);
    // 没有 defaultView（离屏文档）也不炸
    expect(/^#[0-9a-f]{6}$/i.test(themeColor(new FakeDoc(undefined), 'chart-1'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 纯函数：格式化与桶标签
// ---------------------------------------------------------------------------

describe('格式化', () => {
  it('fmtMetric：成本带币种、调用带次、token 走 k 口径', async () => {
    const c = (await import(CHART)) as Any;
    expect(c.fmtMetric(0.5, 'cost')).toBe('$0.5000');
    expect(c.fmtMetric(12.345, 'cost')).toBe('$12.35');
    expect(c.fmtMetric(1.5, 'cost', 'EUR')).toBe('EUR 1.50');
    expect(c.fmtMetric(3.7, 'calls')).toBe('4 次');
    expect(c.fmtMetric(9999, 'tokens')).toBe('9999 tok');
    expect(c.fmtMetric(12345, 'tokens')).toBe('12.3k tok');
  });

  it('fmtAxis：比读数短一截，不带单位；成本 <1 保三位', async () => {
    const c = (await import(CHART)) as Any;
    expect(c.fmtAxis(0.125, 'cost')).toBe('0.125');
    expect(c.fmtAxis(2.5, 'cost')).toBe('2.5');
    expect(c.fmtAxis(3.6, 'calls')).toBe('4');
    expect(c.fmtAxis(12345, 'tokens')).toBe('12.3k');
  });

  it('bucketLabel / bucketFull：五种粒度各切各的位置', async () => {
    const c = (await import(CHART)) as Any;
    expect(c.bucketLabel('2026-08-12T14:30', 'minute')).toBe('14:30');
    expect(c.bucketLabel('2026-08-12T14', 'hour')).toBe('14h');
    expect(c.bucketLabel('2026-08-12', 'day')).toBe('08-12');
    expect(c.bucketLabel('2026-08-10', 'week')).toBe('08-10周');
    expect(c.bucketLabel('2026-08', 'month')).toBe('2026-08');

    expect(c.bucketFull('2026-08-12T14:30', 'minute')).toBe('2026-08-12 14:30');
    expect(c.bucketFull('2026-08-12T14', 'hour')).toBe('2026-08-12 14:00');
    expect(c.bucketFull('2026-08-12', 'day')).toBe('2026-08-12');
    expect(c.bucketFull('2026-08-10', 'week')).toBe('2026-08-10 起 · 周');
    expect(c.bucketFull('2026-08', 'month')).toBe('2026-08 · 月');
  });

  it('uTipHtml：外来文本转义，超过 16 行就"其余从略"', async () => {
    const c = (await import(CHART)) as Any;
    const d = sample();
    const p = { ...d.series[0], bucket: '<img src=x>' };
    const html = c.uTipHtml(d, p, [[]], { '': '#000' }, {
      metric: 'cost', stacked: false, cur: 'USD', unit: 'day', curId: null,
    });
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('调用 4');

    // 20 个组合、每个都有值 → 只列 16 行
    const many = Array.from({ length: 20 }, (_, i) => [{ dim: 'role', key: 'r' + i }]);
    const bigPoint = {
      bucket: '2026-08-01',
      ...accum({ cost: 20 }),
      byRole: Object.fromEntries(many.map((_, i) => ['r' + i, accum({ cost: 1 })])),
    };
    const big = c.uTipHtml(d, bigPoint, many, {}, {
      metric: 'cost', stacked: true, cur: 'USD', unit: 'day', curId: null,
    });
    expect((big.match(/class="tt-row/g) ?? []).length).toBe(16);
    expect(big).toContain('其余从略');
  });
});

// ---------------------------------------------------------------------------
// 纯函数：时间范围
// ---------------------------------------------------------------------------

describe('时间范围', () => {
  const NOW = Date.parse('2026-08-12T09:00:00Z');

  it('localDate 走本地时区的年月日，不走 toISOString', async () => {
    const { localDate } = (await import(RANGE)) as Any;
    const d = new Date(NOW);
    const p = (n: number): string => String(n).padStart(2, '0');
    expect(localDate(0, NOW)).toBe(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
    const back = new Date(NOW - 6 * 86400000);
    expect(localDate(6, NOW)).toBe(`${back.getFullYear()}-${p(back.getMonth() + 1)}-${p(back.getDate())}`);
  });

  it('usageRange：近 N 天含今天（起点是 N-1 天前）；0 档读自定义框，空串算不限', async () => {
    const { usageRange, localDate } = (await import(RANGE)) as Any;
    expect(usageRange(7, { from: '', to: '' }, NOW))
      .toEqual({ from: localDate(6, NOW), to: localDate(0, NOW) });
    expect(usageRange(1, { from: '', to: '' }, NOW))
      .toEqual({ from: localDate(0, NOW), to: localDate(0, NOW) });
    expect(usageRange(0, { from: '2026-01-01', to: '2026-02-01' }, NOW))
      .toEqual({ from: '2026-01-01', to: '2026-02-01' });
    expect(usageRange(0, { from: '', to: '' }, NOW)).toEqual({ from: null, to: null });
  });

  it('usageQuery：空的 from/to 不出现在 URL 里', async () => {
    const { usageQuery } = (await import(RANGE)) as Any;
    expect(usageQuery('auto', { from: null, to: null })).toBe('bucket=auto');
    expect(usageQuery('day', { from: '2026-01-01', to: null })).toBe('bucket=day&from=2026-01-01');
  });
});

// ---------------------------------------------------------------------------
// 状态：每次挂载一份
// ---------------------------------------------------------------------------

describe('视图状态', () => {
  it('createUsageState 每次给一份新的，改一份不影响另一份（没有模块级单例）', async () => {
    const { createUsageState } = (await import(STATE)) as Any;
    const a = createUsageState();
    const b = createUsageState();
    a.metric = 'tokens';
    a.splitDims.role = true;
    expect(b.metric).toBe('cost');
    expect(b.splitDims.role).toBe(false);
    expect(a.splitDims).not.toBe(b.splitDims);
  });
});

// ---------------------------------------------------------------------------
// tooltip
// ---------------------------------------------------------------------------

describe('tooltip', () => {
  it('建在给的宿主里（不是 document.body），dispose 后节点消失', async () => {
    const { createUsageTip } = (await import(TOOLTIP)) as Any;
    const doc = new FakeDoc();
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const tip = createUsageTip(doc, host);
    expect(host.children.length).toBe(1);
    expect(tip.el.classList.contains('viewport-overlay')).toBe(true);
    expect(doc.body.children.length).toBe(1); // 只有 host 自己
    tip.dispose();
    expect(host.children.length).toBe(0);
  });

  it('同一个 key 不重写正文；hide 顺带清掉高亮', async () => {
    const { createUsageTip } = (await import(TOOLTIP)) as Any;
    const doc = new FakeDoc();
    const host = doc.createElement('div');
    const tip = createUsageTip(doc, host);
    tip.show('<b>a</b>', 'k1');
    expect(tip.el.innerHTML).toBe('<b>a</b>');
    tip.show('<b>b</b>', 'k1'); // 同 key → 不重写
    expect(tip.el.innerHTML).toBe('<b>a</b>');
    tip.show('<b>c</b>', 'k2');
    expect(tip.el.innerHTML).toBe('<b>c</b>');

    const rect = doc.createElement('rect');
    tip.setHi(rect);
    expect(rect.classList.contains('seghi')).toBe(true);
    const other = doc.createElement('rect');
    tip.setHi(other); // 换一个 → 前一个必须先摘
    expect(rect.classList.contains('seghi')).toBe(false);
    expect(other.classList.contains('seghi')).toBe(true);
    tip.hide();
    expect(other.classList.contains('seghi')).toBe(false);
    expect(tip.el.classList.contains('hidden')).toBe(true);
  });

  it('贴到视口右下角时翻到鼠标另一侧，且不越出左上', async () => {
    const { createUsageTip } = (await import(TOOLTIP)) as Any;
    const doc = new FakeDoc();
    const win = doc.defaultView as FakeWindow;
    const tip = createUsageTip(doc, doc.createElement('div'));
    tip.move({ clientX: 10, clientY: 10 });
    expect(tip.el.style.left).toBe('24px');
    tip.move({ clientX: win.innerWidth - 5, clientY: win.innerHeight - 5 });
    expect(Number.parseFloat(tip.el.style.left)).toBeLessThan(win.innerWidth - 5);
    expect(Number.parseFloat(tip.el.style.top)).toBeLessThan(win.innerHeight - 5);
    tip.move({ clientX: -500, clientY: -500 });
    expect(tip.el.style.left).toBe('4px');
    expect(tip.el.style.top).toBe('4px');
  });
});

// ---------------------------------------------------------------------------
// feature 装配
// ---------------------------------------------------------------------------

describe('feature 声明', () => {
  it('用量页声明路由和对应 capability', async () => {
    const usage = ((await import(USAGE)) as Any).usageFeature;
    expect(usage.route).toBe('usage');
    expect(usage.navGroup).toBe('系统');
    expect(usage.needsAny).toEqual(['usage']);
  });

  it('capabilities 里没挂 → featureAvailable 为假，这一页根本不出现在导航里', async () => {
    const { featureAvailable } = (await import(FEATURE)) as Any;
    const usage = ((await import(USAGE)) as Any).usageFeature;
    expect(featureAvailable(usage, {})).toBe(false);
    expect(featureAvailable(usage, { usage: false })).toBe(false);
    expect(featureAvailable(usage, { usage: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 用量页挂载
// ---------------------------------------------------------------------------

describe('用量页挂载', () => {
  it('取数一次，画出概览卡、构成条、两张图与两张分组表', async () => {
    stubFetch({ '/api/usage': sample() });
    const { ctx, root } = await mkCtx({ usage: true });
    const { mountUsage } = (await import(USAGE)) as Any;
    mountUsage(ctx);
    await flush();

    expect(seen.filter((u) => u.startsWith('/api/usage')).length).toBe(1);
    expect(seen[0]).toContain('bucket=auto');
    expect(root.findTag('h1')!.textContent).toBe('用量与成本');
    expect(root.find('usagecontrols')!.findAll('usagebar').length).toBe(2);

    // 八张概览卡
    expect(root.find('usagecards')!.classList.contains('statgrid')).toBe(true);
    expect(root.findAll('stat').length).toBe(8);
    expect(root.textContent).toContain('已知费用小计');
    expect(root.textContent).toContain('$4.00');

    // 成本构成：三段 + 三条图例
    expect(root.findAll('compseg').length).toBe(3);
    expect(root.findAll('compitem').length).toBe(3);

    // 两张图各一棵 svg，柱子数 = 桶数
    const svgs = root.findAllTag('svg');
    expect(svgs.length).toBe(2);
    expect(svgs[0].findAll('barg').length).toBe(2);
    // 每根堆叠柱由一枚圆角 clipPath 约束外轮廓，内部拆分不再露直角顶边。
    expect(svgs[0].findAllTag('clipPath').length).toBe(2);
    expect(svgs[0].findAllTag('clipPath')[0].findTag('rect')!.getAttribute('rx')).not.toBe(null);

    // 分组表：首列印 label（有就用），没有就印 id
    const rows = root.findAllTag('tbody').flatMap((b: Any) => b.children);
    const firstCells = rows.map((r: Any) => r.children[0].textContent);
    expect(firstCells).toContain('甲');
    expect(firstCells).toContain('beta');
    expect(firstCells).toContain('m-big');
    expect(root.textContent).not.toContain('无数据');

    // 范围提示
    expect(root.textContent).toContain('2026-08-01 ~ 2026-08-02 · 2 桶');
  });

  it('空 series → 读数卡整排换成占位句,图里铺空态而不是一张空白画布', async () => {
    stubFetch({ '/api/usage': { currency: 'USD', bucket: 'day', from: null, to: null, series: [], totals: null, byRole: [], byModel: [] } });
    const { ctx, root } = await mkCtx({ usage: true });
    const { mountUsage } = (await import(USAGE)) as Any;
    mountUsage(ctx);
    await flush();
    expect(root.findAll('stat').length).toBe(0);
    expect(root.find('usagecards')!.findAll('placeholder').length).toBe(1);
    expect(root.findAllTag('svg').length).toBe(0);
    expect(root.textContent).toContain('这个范围内没有调用记录');
    expect(root.textContent).toContain('暂无成本数据');
    expect(root.textContent).toContain('无数据');
  });

  it('取数失败 → 概览位置铺一行失败说明，带服务端措辞', async () => {
    stubFetch({}, '/api/usage');
    const { ctx, root } = await mkCtx({ usage: true });
    const { mountUsage } = (await import(USAGE)) as Any;
    mountUsage(ctx);
    await flush();
    expect(root.textContent).toContain('用量加载失败');
    expect(root.textContent).toContain('炸了');
  });

  it('勾上拆分维度 → 重画但不重取（数据没变，变的是画法）', async () => {
    stubFetch({ '/api/usage': sample() });
    const { ctx, root } = await mkCtx({ usage: true });
    const { mountUsage } = (await import(USAGE)) as Any;
    mountUsage(ctx);
    await flush();
    const before = seen.length;
    const legendBefore = root.find('chart-legend')!.children.length;
    expect(legendBefore).toBe(0);

    // 「角色」那颗勾选框（主图控件里的第二颗 check）
    const checks = root.findAll('check');
    const roleCheck = checks.find((c: Any) => c.textContent.includes('角色'))!;
    const box = roleCheck.findTag('input')!;
    box.checked = true;
    box.dispatchEvent({ type: 'change' });

    expect(seen.length).toBe(before); // 一次都没再取
    expect(root.find('chart-legend')!.children.length).toBeGreaterThan(0);
  });

  it('换粒度 / 点刷新 → 重新取数，且 bucket 跟着走', async () => {
    stubFetch({ '/api/usage': sample() });
    const { ctx, root } = await mkCtx({ usage: true });
    const { mountUsage } = (await import(USAGE)) as Any;
    mountUsage(ctx);
    await flush();
    seen.length = 0;

    const hourBtn = root.findAll('seg').find((b: Any) => b.textContent === '时')!;
    hourBtn.dispatchEvent({ type: 'click' });
    await flush();
    expect(seen.some((u) => u.includes('bucket=hour'))).toBe(true);

    seen.length = 0;
    root.findButton('刷新')!.dispatchEvent({ type: 'click' });
    await flush();
    expect(seen.length).toBe(1);
  });

  it('切到「自定义」时以预填日期发起查询', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T09:00:00Z'));
    stubFetch({ '/api/usage': sample() });
    const { ctx, root } = await mkCtx({ usage: true });
    const { mountUsage } = (await import(USAGE)) as Any;
    mountUsage(ctx);
    await flush();
    const range = root.find('urange')!;
    expect(range.classList.contains('hidden')).toBe(true);

    root.findAll('seg').find((b: Any) => b.textContent === '自定义')!.dispatchEvent({ type: 'click' });
    await flush();
    expect(range.classList.contains('hidden')).toBe(false);
    const dates = range.findAllTag('input');
    expect(dates.length).toBe(2);
    expect(dates[0].value).toBe('2026-08-07');
    expect(dates[1].value).toBe('2026-08-13');
    expect(seen.at(-1)).toContain('from=2026-08-07');
    expect(seen.at(-1)).toContain('to=2026-08-13');
  });

  it('自动刷新：勾上才有表，取消即停；离开这一页一根都不剩', async () => {
    vi.useFakeTimers();
    stubFetch({ '/api/usage': sample() });
    const { ctx, root, lifecycle } = await mkCtx({ usage: true });
    const { mountUsage } = (await import(USAGE)) as Any;
    mountUsage(ctx);
    await flush();

    const base = vi.getTimerCount();
    const live = root.findAll('check').find((c: Any) => c.textContent.includes('自动刷新'))!;
    const box = live.findTag('input')!;
    box.checked = true;
    box.dispatchEvent({ type: 'change' });
    expect(vi.getTimerCount()).toBe(base + 1);

    // 反复拨动不该攒出第二根表
    box.checked = false;
    box.dispatchEvent({ type: 'change' });
    expect(vi.getTimerCount()).toBe(base);
    box.checked = true;
    box.dispatchEvent({ type: 'change' });
    box.checked = true;
    box.dispatchEvent({ type: 'change' });
    expect(vi.getTimerCount()).toBe(base + 1);

    // 到点会真的重取
    seen.length = 0;
    vi.advanceTimersByTime(15_000);
    await flush();
    expect(seen.length).toBe(1);

    lifecycle.dispose();
    expect(vi.getTimerCount()).toBe(base);
  });

  it('卸载后：window 监听、定时器、tooltip 节点全部归零', async () => {
    vi.useFakeTimers();
    stubFetch({ '/api/usage': sample() });
    const { ctx, root, lifecycle, win } = await mkCtx({ usage: true });
    const { mountUsage } = (await import(USAGE)) as Any;
    mountUsage(ctx);
    await flush();

    expect(win.countListeners('resize')).toBe(1);
    expect(root.find('u-tip')).not.toBeNull();

    // 开着自动刷新再卸载：最坏情况也要归零
    const box = root.findAll('check').find((c: Any) => c.textContent.includes('自动刷新'))!.findTag('input')!;
    box.checked = true;
    box.dispatchEvent({ type: 'change' });

    const base = vi.getTimerCount();
    lifecycle.dispose();
    expect(win.countListeners('resize')).toBe(0);
    expect(vi.getTimerCount()).toBe(base - 1);
    expect(root.find('u-tip')).toBeNull();

    // 卸载之后再来一次 resize，不该有任何动静（也不该抛）
    seen.length = 0;
    win.dispatchEvent({ type: 'resize' });
    await flush();
    expect(seen.length).toBe(0);
  });

  it('改窗宽经防抖后只重画一次、不重取', async () => {
    vi.useFakeTimers();
    stubFetch({ '/api/usage': sample() });
    const { ctx, root, win } = await mkCtx({ usage: true });
    const { mountUsage } = (await import(USAGE)) as Any;
    mountUsage(ctx);
    await flush();
    seen.length = 0;

    const svgMid = root.findAllTag('svg')[0];
    win.dispatchEvent({ type: 'resize' });
    win.dispatchEvent({ type: 'resize' });
    win.dispatchEvent({ type: 'resize' });
    expect(root.findAllTag('svg')[0]).toBe(svgMid); // 还在防抖窗口里
    vi.advanceTimersByTime(200);
    expect(root.findAllTag('svg')[0]).not.toBe(svgMid);
    expect(seen.length).toBe(0);
  });

  it('主题工作室换肤也重画（长期只剩这一条来路，不能只接 legacy 事件）', async () => {
    stubFetch({ '/api/usage': sample() });
    const { ctx, root, doc, lifecycle } = await mkCtx({ usage: true });
    const { mountUsage } = (await import(USAGE)) as Any;
    mountUsage(ctx);
    await flush();
    seen.length = 0;

    const { getThemeStudio } = (await import(THEME)) as Any;
    const studio = getThemeStudio({ doc });
    const before = root.findAllTag('svg')[0];
    studio.setMode('dark');
    expect(root.findAllTag('svg')[0]).not.toBe(before); // 真重画了
    expect(seen.length).toBe(0);                        // 但没重取

    // 卸载后再换肤，这一页不该再有反应
    lifecycle.dispose();
    const after = root.findAllTag('svg')[0];
    studio.setMode('light');
    expect(root.findAllTag('svg')[0]).toBe(after);
  });

  it('鼠标压在色块上 → tooltip 出正文并高亮该块；移出图即收起', async () => {
    stubFetch({ '/api/usage': sample() });
    const { ctx, root } = await mkCtx({ usage: true });
    const { mountUsage } = (await import(USAGE)) as Any;
    mountUsage(ctx);
    await flush();

    const svg = root.findAllTag('svg')[0];
    const seg = svg.findAll('bseg')[0];
    seg.dispatchEvent({ type: 'mousemove', target: seg, clientX: 100, clientY: 100 });
    const tip = root.find('u-tip')!;
    expect(tip.classList.contains('hidden')).toBe(false);
    expect(tip.innerHTML).toContain('2026-08-01');

    svg.dispatchEvent({ type: 'mouseleave', target: svg });
    expect(tip.classList.contains('hidden')).toBe(true);
    expect(svg.findAll('seghi').length).toBe(0);
  });
});
