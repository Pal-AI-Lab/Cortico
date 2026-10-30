/**
 * 各测试手写的迷你 DOM 共用的补充：WebUI 用到、但只影响布局与动效的接口。
 * 布局读数一律为 0，动画立即结束，观察器不回调；行为断言不依赖这些。
 */
type Any = any;

interface MiniNode {
  className: string;
  tagName: string;
  children: MiniNode[];
  parent: MiniNode | null;
  attrs: Map<string, string>;
}

function matches(node: MiniNode, selector: string): boolean {
  return selector.split(',').some((one) => {
    const part = one.trim().split(/\s+/).pop() ?? '';
    const m = /^([a-zA-Z0-9-]*)((?:\.[\w-]+)*)$/.exec(part.replace(/^:scope\s*>\s*/, ''));
    if (!m) return false;
    const [, tag, classes] = m;
    if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    const own = node.className.split(/\s+/);
    return classes.split('.').filter(Boolean).every((c) => own.includes(c));
  });
}

function walk(node: MiniNode, out: MiniNode[] = []): MiniNode[] {
  for (const c of node.children) { out.push(c); walk(c, out); }
  return out;
}

/** 给迷你 DOM 的元素类补上缺的接口；已有的不覆盖。 */
export function extendMiniElement(cls: { prototype: Any }): void {
  const proto = cls.prototype;
  const define = (name: string, desc: PropertyDescriptor): void => {
    if (!(name in proto)) Object.defineProperty(proto, name, { configurable: true, ...('value' in desc ? { writable: true } : {}), ...desc });
  };
  define('classList', {
    get(this: MiniNode) {
      const list = (): string[] => this.className.split(/\s+/).filter(Boolean);
      const write = (names: string[]): void => { this.className = names.join(' '); };
      return {
        add: (...names: string[]) => write([...new Set([...list(), ...names])]),
        remove: (...names: string[]) => write(list().filter((n) => !names.includes(n))),
        contains: (name: string) => list().includes(name),
        toggle: (name: string, force?: boolean) => {
          const on = force ?? !list().includes(name);
          write(on ? [...new Set([...list(), name])] : list().filter((n) => n !== name));
          return on;
        },
      };
    },
  });
  const lazy = (name: string, make: () => unknown): void => define(name, {
    get(this: Any) { const key = `__${name}`; return (this[key] ??= make()); },
    set(this: Any, v: unknown) { this[`__${name}`] = v; },
  });
  lazy('dataset', () => ({}));
  lazy('style', () => ({ setProperty(): void {}, removeProperty(): void {}, getPropertyValue: () => '' }));
  define('hidden', { get(this: Any) { return this.__hidden ?? false; }, set(this: Any, v: boolean) { this.__hidden = v; } });
  define('removeAttribute', { value(this: MiniNode, k: string) { this.attrs.delete(k); } });
  define('hasAttribute', { value(this: MiniNode, k: string) { return this.attrs.has(k); } });
  define('toggleAttribute', { value(this: MiniNode, k: string, force?: boolean) {
    const on = force ?? !this.attrs.has(k);
    if (on) this.attrs.set(k, ''); else this.attrs.delete(k);
    return on;
  } });
  define('getBoundingClientRect', { value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) });
  define('getClientRects', { value: () => [] });
  define('animate', { value: () => ({ finished: Promise.resolve(), cancel(): void {}, finish(): void {}, onfinish: null, addEventListener(): void {} }) });
  define('getAnimations', { value: () => [] });
  define('contains', { value(this: MiniNode, other: MiniNode | null) {
    for (let n = other; n; n = n.parent) if (n === this) return true;
    return false;
  } });
  define('matches', { value(this: MiniNode, sel: string) { return matches(this, sel); } });
  define('closest', { value(this: MiniNode, sel: string) {
    for (let n: MiniNode | null = this; n; n = n.parent) if (matches(n, sel)) return n;
    return null;
  } });
  define('querySelectorAll', { value(this: MiniNode, sel: string) { return walk(this).filter((n) => matches(n, sel)); } });
  define('querySelector', { value(this: MiniNode, sel: string) { return walk(this).find((n) => matches(n, sel)) ?? null; } });
  define('getContext', { value: () => null });
  define('scrollTo', { value(): void {} });
  define('scrollBy', { value(): void {} });
  define('setPointerCapture', { value(): void {} });
  define('releasePointerCapture', { value(): void {} });
  define('blur', { value(): void {} });
  // 容器默认够宽：按宽度收起溢出项的地方(会话卡、徽标行)照常全部摆出。
  for (const [name, dflt] of [['offsetWidth', 0], ['offsetHeight', 0], ['offsetTop', 0], ['offsetLeft', 0], ['clientWidth', 10_000], ['scrollWidth', 0], ['scrollLeft', 0]] as const) {
    define(name, { get(this: Any) { return this[`__${name}`] ?? dflt; }, set(this: Any, v: number) { this[`__${name}`] = v; } });
  }
  define('firstElementChild', { get(this: MiniNode) { return this.children[0] ?? null; } });
  define('lastElementChild', { get(this: MiniNode) { return this.children[this.children.length - 1] ?? null; } });
  define('parentElement', { get(this: MiniNode) { return this.parent; } });
  define('nextElementSibling', { get(this: MiniNode) {
    const sib = this.parent?.children; return sib ? sib[sib.indexOf(this) + 1] ?? null : null;
  } });
  define('previousElementSibling', { get(this: MiniNode) {
    const sib = this.parent?.children; return sib ? sib[sib.indexOf(this) - 1] ?? null : null;
  } });
}

class MiniStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}

/** 迷你 DOM 用的窗口：监听登记、存储与观察器桩，布局查询返回中性值。 */
export function miniWindow(extra: Record<string, unknown> = {}): Any {
  const listeners = new Map<string, Set<Any>>();
  return {
    addEventListener(type: string, fn: Any) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
    removeEventListener(type: string, fn: Any) { listeners.get(type)?.delete(fn); },
    dispatchEvent(ev: Any) { for (const fn of listeners.get(ev.type) ?? []) fn(ev); return true; },
    matchMedia: () => ({ matches: false, addEventListener(): void {}, removeEventListener(): void {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '', position: 'static', display: 'block' }),
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: (id: Any) => clearTimeout(id),
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: Any) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (id: Any) => clearInterval(id),
    localStorage: new MiniStorage(),
    sessionStorage: new MiniStorage(),
    ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} },
    MutationObserver: class { observe(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } },
    IntersectionObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} },
    location: { origin: 'http://127.0.0.1', hash: '', href: 'http://127.0.0.1/' },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    ...extra,
  };
}
