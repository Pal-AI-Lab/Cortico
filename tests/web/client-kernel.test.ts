/**
 * Lifecycle、Router、ConsolePageLoader 的行为测试。
 * 变量形式的动态 import 避免根 tsconfig 将 DOM 代码纳入 Node 检查；浏览器类型由 tsconfig.web.json 检查。
 * 夹具注入窗口和加载依赖，并接管 RAF 与定时器。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const LIFECYCLE_SPEC = '../../src/web/client/core/lifecycle.ts';
const ROUTER_SPEC = '../../src/web/client/core/router.ts';
const LOADER_SPEC = '../../src/web/client/console-pages/loader.ts';

type Any = any;

const { Lifecycle } = (await import(LIFECYCLE_SPEC)) as Any;
const { Router, parseHash, buildHash } = (await import(ROUTER_SPEC)) as Any;
const { ConsolePageLoader, PanelBundleError } = (await import(LOADER_SPEC)) as Any;

/** 断言抛错并把错误取回来（`rejects.toThrow` 拿不到自定义字段）。 */
async function catchErr(p: Promise<unknown>): Promise<Any> {
  try {
    await p;
  } catch (err) {
    return err as Any;
  }
  throw new Error('期望抛错，但成功返回了');
}

// ===========================================================================
// Lifecycle
// ===========================================================================

/** 手动 RAF；tick 推进当前回调，续帧留到下次。requested/cancelled 记录请求和取消。 */
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
      // 快照后清空：回调里续帧的那次请求排到下一轮，不在本轮跑（同真浏览器）
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

describe('Lifecycle —— 资源账本', () => {
  let raf: FakeRaf;

  beforeEach(() => {
    vi.useFakeTimers();
    // 顺序要紧：先 useFakeTimers 再装 RAF 桩，免得被 fake timers 覆盖掉
    raf = installFakeRaf();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('dispose 之后 signal 变成 aborted，且 abort 监听会被触发', () => {
    const lc = new Lifecycle();
    expect(lc.signal.aborted).toBe(false);
    expect(lc.disposed).toBe(false);

    let aborted = false;
    lc.signal.addEventListener('abort', () => { aborted = true; });

    lc.dispose();
    expect(lc.signal.aborted).toBe(true);
    expect(lc.disposed).toBe(true);
    expect(aborted).toBe(true);
  });

  it('own 登记的资源在 dispose 时被释放，own 原样返回传进来的对象', () => {
    const lc = new Lifecycle();
    const d = { dispose: vi.fn() };
    expect(lc.own(d)).toBe(d);
    expect(d.dispose).not.toHaveBeenCalled();

    lc.dispose();
    expect(d.dispose).toHaveBeenCalledTimes(1);
  });

  it('释放顺序是后进先出：后借的先还', () => {
    const order: string[] = [];
    const lc = new Lifecycle();
    lc.own({ dispose: () => order.push('a') });
    lc.own({ dispose: () => order.push('b') });
    lc.own({ dispose: () => order.push('c') });

    lc.dispose();
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('dispose 幂等：调两次，每个资源只释放一次', () => {
    const lc = new Lifecycle();
    const d1 = { dispose: vi.fn() };
    const d2 = { dispose: vi.fn() };
    lc.own(d1);
    lc.own(d2);

    lc.dispose();
    lc.dispose();
    lc.dispose();
    expect(d1.dispose).toHaveBeenCalledTimes(1);
    expect(d2.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose 之后再 own：立即释放并原样返回（防"await 回来时面板已经没了"）', () => {
    const lc = new Lifecycle();
    lc.dispose();

    const d = { dispose: vi.fn() };
    const back = lc.own(d);
    expect(back).toBe(d);
    expect(d.dispose).toHaveBeenCalledTimes(1);

    lc.dispose();
    expect(d.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose 之后再 own 的资源，其 dispose 抛错也走 onError 而不是冒泡', () => {
    const errs: unknown[] = [];
    const lc = new Lifecycle((e: unknown) => errs.push(e));
    lc.dispose();

    expect(() => lc.own({ dispose: () => { throw new Error('晚到的资源炸了'); } })).not.toThrow();
    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe('晚到的资源炸了');
  });

  it('dispose 之后 interval / timeout / frame 都不真的起定时器或请求帧', () => {
    const lc = new Lifecycle();
    lc.dispose();
    expect(vi.getTimerCount()).toBe(0);

    const fn = vi.fn();
    const d1 = lc.interval(fn, 10);
    const d2 = lc.timeout(fn, 10);
    const d3 = lc.frame(fn);

    expect(vi.getTimerCount()).toBe(0);
    expect(raf.requested).toBe(0);

    // 返回的仍是可安全 dispose 的空壳，调用方不必判空
    expect(() => { d1.dispose(); d2.dispose(); d3.dispose(); }).not.toThrow();

    vi.advanceTimersByTime(10_000);
    raf.tick(16);
    expect(fn).not.toHaveBeenCalled();
  });

  it('interval 正常轮询，dispose 之后不再触发', () => {
    const lc = new Lifecycle();
    const fn = vi.fn();
    lc.interval(fn, 100);

    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(2);

    lc.dispose();
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('interval 返回的 Disposable 可以提前手动停', () => {
    const lc = new Lifecycle();
    const fn = vi.fn();
    const d = lc.interval(fn, 100);

    vi.advanceTimersByTime(100);
    d.dispose();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('timeout 在 dispose 之后不触发', () => {
    const lc = new Lifecycle();
    const fn = vi.fn();
    lc.timeout(fn, 100);
    expect(vi.getTimerCount()).toBe(1);

    lc.dispose();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('timeout 到点正常触发一次', () => {
    const lc = new Lifecycle();
    const fn = vi.fn();
    lc.timeout(fn, 100);
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('某个资源 dispose 抛错，不挡住其余资源被释放，错误交给 onError', () => {
    const errs: unknown[] = [];
    const order: string[] = [];
    const lc = new Lifecycle((e: unknown) => errs.push(e));

    lc.own({ dispose: () => order.push('first') });
    lc.own({ dispose: () => { throw new Error('清理里再泄漏一次'); } });
    lc.own({ dispose: () => order.push('last') });

    expect(() => lc.dispose()).not.toThrow();
    // 后进先出，中间那个炸了也不影响两侧
    expect(order).toEqual(['last', 'first']);
    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe('清理里再泄漏一次');
  });

  it('interval 回调抛错 → 交给 onError，不冒泡（且轮询继续）', () => {
    const errs: unknown[] = [];
    const lc = new Lifecycle((e: unknown) => errs.push(e));
    lc.interval(() => { throw new Error('轮询炸了'); }, 50);

    expect(() => vi.advanceTimersByTime(120)).not.toThrow();
    // 抛错不会让 interval 自停：连着两拍都报了
    expect(errs).toHaveLength(2);
    expect((errs[0] as Error).message).toBe('轮询炸了');
  });

  it('timeout 回调抛错 → 交给 onError，不冒泡', () => {
    const errs: unknown[] = [];
    const lc = new Lifecycle((e: unknown) => errs.push(e));
    lc.timeout(() => { throw new Error('延时炸了'); }, 10);

    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe('延时炸了');
  });

  it('frame 回调抛错 → 交给 onError 并停掉循环，不冒泡', () => {
    const errs: unknown[] = [];
    const lc = new Lifecycle((e: unknown) => errs.push(e));
    const fn = vi.fn(() => { throw new Error('帧里炸了'); });
    lc.frame(fn);

    expect(() => raf.tick(16)).not.toThrow();
    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe('帧里炸了');

    // 炸过之后不再续帧
    expect(raf.pending.size).toBe(0);
    raf.tick(32);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('frame 回调返回 false 时循环自行结束，不再请求下一帧', () => {
    const lc = new Lifecycle();
    let n = 0;
    const fn = vi.fn(() => {
      n += 1;
      return n >= 2 ? false : undefined;
    });
    lc.frame(fn as Any);

    expect(raf.requested).toBe(1);
    raf.tick(10);
    expect(raf.requested).toBe(2); // 第一帧返回 undefined → 续帧
    raf.tick(20);
    expect(raf.requested).toBe(2); // 第二帧返回 false → 不续
    expect(raf.pending.size).toBe(0);

    raf.tick(30);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('frame 首帧 dtMs 为 0，之后是与上一帧的差值', () => {
    const lc = new Lifecycle();
    const dts: number[] = [];
    lc.frame((dt: number) => { dts.push(dt); });

    raf.tick(100);
    raf.tick(160);
    raf.tick(180.5);
    expect(dts).toEqual([0, 60, 20.5]);
  });

  it('frame 在 dispose 时停掉并调用 cancelAnimationFrame', () => {
    const lc = new Lifecycle();
    const fn = vi.fn();
    lc.frame(fn);
    raf.tick(10);
    expect(fn).toHaveBeenCalledTimes(1);
    // 此刻有一个已排队的续帧
    expect(raf.pending.size).toBe(1);

    lc.dispose();
    expect(raf.cancelled).toHaveLength(1);
    expect(raf.pending.size).toBe(0);

    raf.tick(20);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('frame 返回的 Disposable 可以提前手动停', () => {
    const lc = new Lifecycle();
    const fn = vi.fn();
    const d = lc.frame(fn);
    raf.tick(10);
    d.dispose();
    raf.tick(20);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('在 frame 回调里 dispose 整个 Lifecycle：回调不再被调到,且不留未决帧', () => {
    // dispose 发生在 fn 返回前，续帧发生在 fn 返回后；此时 cancel 正在执行的帧不能阻止续帧。
    // step 须在续帧前检查 stopped，确保 unmount 后未决帧数为零。
    const lc = new Lifecycle();
    const fn = vi.fn(() => { lc.dispose(); });
    lc.frame(fn);

    raf.tick(10);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(raf.pending.size).toBe(0);
    raf.tick(20);
    raf.tick(30);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('add(cleanup) 把清理函数包成 Disposable 并登记', () => {
    const lc = new Lifecycle();
    const cleanup = vi.fn();
    const d = lc.add(cleanup);
    expect(typeof d.dispose).toBe('function');
    expect(cleanup).not.toHaveBeenCalled();

    lc.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);

    // toDisposable 自带幂等：手动再 dispose 一次也不会重复跑
    d.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('dispose 之后 add 的清理函数立即执行', () => {
    const lc = new Lifecycle();
    lc.dispose();
    const cleanup = vi.fn();
    lc.add(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('默认 onError 吞掉错误：不传 onError 时 dispose 抛错也不冒泡', () => {
    const lc = new Lifecycle();
    lc.own({ dispose: () => { throw new Error('没人接'); } });
    expect(() => lc.dispose()).not.toThrow();
  });
});

// ===========================================================================
// Router
// ===========================================================================

/** 假窗口同步派发 hashchange；浏览器异步派发。相同 hash 不发事件，赋值归一化 hash；设置 hash 新增历史，replace 替换当前条目。 */
interface FakeWin {
  location: { hash: string; replace(url: string): void };
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  listenerCount(): number;
  setHashSilently(v: string): void;
  history(): string[];
}

function normalizeHash(v: string): string {
  if (v === '' || v === '#') return '';
  return v.startsWith('#') ? v : `#${v}`;
}

function makeWin(initialHash = ''): FakeWin {
  let hash = normalizeHash(initialHash);
  const entries: string[] = [hash];
  const listeners = new Set<() => void>();
  const write = (v: string, push: boolean): void => {
    const next = normalizeHash(v);
    if (next === hash) return; // 值没变 → 真浏览器不发事件
    hash = next;
    if (push) entries.push(next); else entries[entries.length - 1] = next;
    for (const fn of [...listeners]) fn();
  };
  return {
    location: {
      get hash(): string { return hash; },
      set hash(v: string) { write(v, true); },
      replace(url: string): void { write(url, false); },
    },
    addEventListener(type: string, fn: () => void): void {
      if (type === 'hashchange') listeners.add(fn);
    },
    removeEventListener(type: string, fn: () => void): void {
      if (type === 'hashchange') listeners.delete(fn);
    },
    listenerCount(): number { return listeners.size; },
    /** 改地址栏但不派发事件——用来人为造出"内部状态与地址栏脱节"。 */
    setHashSilently(v: string): void { hash = normalizeHash(v); },
    history(): string[] { return [...entries]; },
  };
}

/** 让挂起的 microtask 链跑完（`onHashChange` 是 async 的）。 */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('Router —— parseHash', () => {
  it('段被 decode：#/provider/world%3Achat/gate → provider / worlds:chat / gate', () => {
    const r = parseHash('#/provider/world%3Achat/gate');
    expect(r.segments).toEqual(['provider', 'world:chat', 'gate']);
    expect(r.query).toEqual({});
    expect(r.raw).toBe('/provider/world%3Achat/gate');
  });

  it('空段被过滤（重复斜杠、首尾斜杠都不产生空段）', () => {
    expect(parseHash('#//a///b/').segments).toEqual(['a', 'b']);
    expect(parseHash('/a/b').segments).toEqual(['a', 'b']);
  });

  it('query 正确切分与 decode：#/a?x=1&y=2', () => {
    const r = parseHash('#/a?x=1&y=2');
    expect(r.segments).toEqual(['a']);
    expect(r.query).toEqual({ x: '1', y: '2' });
    expect(r.raw).toBe('/a?x=1&y=2');
  });

  it('query：无 = 的键值为空串，多余的 & 被跳过，值里的 = 原样保留', () => {
    expect(parseHash('#/a?flag&&k=v=w').query).toEqual({ flag: '', 'k': 'v=w' });
  });

  it('query 的键值都会 decode（%20 → 空格，%3D → =）', () => {
    expect(parseHash('#/a?k%20e=v%3Dv').query).toEqual({ 'k e': 'v=v' });
  });

  it('坏编码不抛错，原样保留', () => {
    expect(parseHash('#/a%zz/b').segments).toEqual(['a%zz', 'b']);
    expect(parseHash('#/a?k%zz=v%zz').query).toEqual({ 'k%zz': 'v%zz' });
  });

  it('query 值解码失败时，键和值均保留编码形式', () => {
    // 值解码失败时整项赋值未完成，键和值均保留编码形式。
    expect(parseHash('#/a?k%20e=v%zz').query).toEqual({ 'k%20e': 'v%zz' });
  });

  it('空 hash / 只有一个 # → 空 segments', () => {
    expect(parseHash('').segments).toEqual([]);
    expect(parseHash('').raw).toBe('');
    expect(parseHash('#').segments).toEqual([]);
    expect(parseHash('#').raw).toBe('');
    expect(parseHash('#/').segments).toEqual([]);
  });

  it('只有 query 没有路径也不炸', () => {
    const r = parseHash('#?a=1');
    expect(r.segments).toEqual([]);
    expect(r.query).toEqual({ a: '1' });
  });
});

describe('Router —— buildHash', () => {
  it('段被 encode：worlds:chat → world%3Achat', () => {
    expect(buildHash(['provider', 'world:chat', 'gate'])).toBe('#/provider/world%3Achat/gate');
  });

  it('不带 query 时没有问号', () => {
    expect(buildHash(['a', 'b'])).toBe('#/a/b');
    expect(buildHash(['a'], {})).toBe('#/a');
    expect(buildHash([])).toBe('#/');
  });

  it('带 query 时键值都被 encode', () => {
    expect(buildHash(['a'], { x: '1', y: '2' })).toBe('#/a?x=1&y=2');
    expect(buildHash(['a'], { 'k e': 'v v' })).toBe('#/a?k%20e=v%20v');
  });

  it('与 parseHash 往返一致（含会破坏结构的字符）', () => {
    const segs = ['provider', 'world:chat', 'a/b', '中 文', '?&='];
    const query = { 'q k': 'v&v', z: '中文' };
    const round = parseHash(buildHash(segs, query));
    expect(round.segments).toEqual(segs);
    expect(round.query).toEqual(query);
  });
});

describe('Router —— 广播与订阅', () => {
  it('start() 立刻广播一次当前路由', () => {
    const win = makeWin('#/live');
    const router = new Router({ win, confirmLeave: async () => true });
    const seen: Any[] = [];
    router.onChange((r: Any) => seen.push(r));

    router.start();
    expect(seen).toHaveLength(1);
    expect(seen[0].segments).toEqual(['live']);
    expect(router.route.segments).toEqual(['live']);
  });

  it('start() 调用两次抛错', () => {
    const router = new Router({ win: makeWin('#/a'), confirmLeave: async () => true });
    router.start();
    expect(() => router.start()).toThrow(/已经启动/);
  });

  it('start() 返回的 Disposable 摘掉 hashchange 监听', async () => {
    const win = makeWin('#/a');
    const router = new Router({ win, confirmLeave: async () => true });
    const seen: Any[] = [];
    router.onChange((r: Any) => seen.push(r.raw));

    const stop = router.start();
    expect(win.listenerCount()).toBe(1);

    stop.dispose();
    expect(win.listenerCount()).toBe(0);

    win.location.hash = '#/b';
    await flush();
    expect(seen).toEqual(['/a']); // 摘掉之后不再广播
  });

  it('onChange 可订阅可退订', async () => {
    const win = makeWin('#/a');
    const router = new Router({ win, confirmLeave: async () => true });
    const a: string[] = [];
    const b: string[] = [];
    const offA = router.onChange((r: Any) => a.push(r.raw));
    router.onChange((r: Any) => b.push(r.raw));

    router.start();
    expect(a).toEqual(['/a']);
    expect(b).toEqual(['/a']);

    offA.dispose();
    router.navigate(['c']);
    await flush();
    expect(a).toEqual(['/a']);
    expect(b).toEqual(['/a', '/c']);
  });

  it('一个订阅者抛错不挡住其余订阅者，错误交给 onError', () => {
    const errs: unknown[] = [];
    const win = makeWin('#/a');
    const router = new Router({
      win,
      confirmLeave: async () => true,
      onError: (e: unknown) => errs.push(e),
    });
    const seen: string[] = [];
    router.onChange(() => { throw new Error('订阅者炸了'); });
    router.onChange((r: Any) => seen.push(r.raw));

    expect(() => router.start()).not.toThrow();
    expect(seen).toEqual(['/a']);
    expect(errs).toHaveLength(1);
  });
});

describe('Router — asynchronous editor decisions', () => {
  it('keeps the editor after cancellation and navigates only after a successful save decision', async () => {
    const win = makeWin('#/providers');
    const router = new Router({ win, confirmLeave: async () => true });
    router.start();
    let accept: (value: boolean) => void = () => {};
    router.addLeaveDecision(() => new Promise<boolean>(resolve => { accept = resolve; }));
    router.navigate(['live']); await flush();
    expect(router.route.segments).toEqual(['providers']);
    accept(false); await flush();
    expect(win.location.hash).toBe('#/providers');
    router.navigate(['live']); await flush();
    accept(true); await flush();
    expect(router.route.segments).toEqual(['live']);
  });
});

describe('Router —— navigate', () => {
  it('navigate 改 hash 并触发广播', async () => {
    const win = makeWin('#/a');
    const router = new Router({ win, confirmLeave: async () => true });
    const seen: string[] = [];
    router.onChange((r: Any) => seen.push(r.raw));
    router.start();

    router.navigate(['provider', 'world:chat', 'gate']);
    await flush();
    expect(win.location.hash).toBe('#/provider/world%3Achat/gate');
    expect(seen).toEqual(['/a', '/provider/world%3Achat/gate']);
    expect(router.route.segments).toEqual(['provider', 'world:chat', 'gate']);
  });

  it('navigate 带 query', async () => {
    const win = makeWin('#/a');
    const router = new Router({ win, confirmLeave: async () => true });
    router.start();

    router.navigate(['usage'], { span: 'week' });
    await flush();
    expect(win.location.hash).toBe('#/usage?span=week');
    expect(router.route.query).toEqual({ span: 'week' });
  });

  it('导航到与当前相同的路由不重复触发', async () => {
    const win = makeWin('#/a/b');
    const router = new Router({ win, confirmLeave: async () => true });
    const seen: string[] = [];
    router.onChange((r: Any) => seen.push(r.raw));
    router.start();

    router.navigate(['a', 'b']);
    router.navigate(['a', 'b']);
    await flush();
    expect(seen).toEqual(['/a/b']);
  });

  it('replace 改 hash 并广播,但换掉当前历史条目而不新增', async () => {
    const win = makeWin('');
    const router = new Router({ win, confirmLeave: async () => true });
    const seen: string[] = [];
    router.onChange((r: Any) => seen.push(r.raw));
    router.start();

    router.replace(['live']);
    await flush();
    expect(win.location.hash).toBe('#/live');
    expect(seen).toEqual(['', '/live']);
    expect(router.route.segments).toEqual(['live']);
    expect(win.history()).toEqual(['#/live']);

    router.navigate(['usage']);
    await flush();
    expect(win.history()).toEqual(['#/live', '#/usage']);
  });

  it('replace 到与地址栏相同的路由不重复广播', async () => {
    const win = makeWin('#/live');
    const router = new Router({ win, confirmLeave: async () => true });
    const seen: string[] = [];
    router.onChange((r: Any) => seen.push(r.raw));
    router.start();

    router.replace(['live']);
    await flush();
    expect(seen).toEqual(['/live']);
    expect(win.history()).toEqual(['#/live']);
  });
});

describe('Router —— 离开拦截', () => {
  it('guard 返回一句话 → 调 confirmLeave；用户确认 → 路由变更生效', async () => {
    const win = makeWin('#/edit');
    const confirmLeave = vi.fn(async () => true);
    const router = new Router({ win, confirmLeave });
    const seen: string[] = [];
    router.onChange((r: Any) => seen.push(r.raw));
    router.start();
    router.addLeaveGuard(() => '有未保存的改动，确定离开吗？');

    router.navigate(['live']);
    await flush();

    expect(confirmLeave).toHaveBeenCalledTimes(1);
    expect(confirmLeave).toHaveBeenCalledWith('有未保存的改动，确定离开吗？');
    expect(router.route.segments).toEqual(['live']);
    expect(seen).toEqual(['/edit', '/live']);
    expect(win.location.hash).toBe('#/live');
  });

  it('拒绝离开 → hash 被拨回原值、路由没变，且不会因为这次回拨再问一遍', async () => {
    const win = makeWin('#/edit');
    const confirmLeave = vi.fn(async () => false);
    const router = new Router({ win, confirmLeave });
    const seen: string[] = [];
    router.onChange((r: Any) => seen.push(r.raw));
    router.start();
    router.addLeaveGuard(() => '别走');

    router.navigate(['live']);
    await flush();

    expect(win.location.hash).toBe('#/edit');
    expect(router.route.segments).toEqual(['edit']);
    expect(seen).toEqual(['/edit']); // 回拨本身不算一次导航，不广播
    expect(confirmLeave).toHaveBeenCalledTimes(1); // 回拨没有再触发一遍拦截
  });

  it('拒绝一次之后，reverting 被正确消费：下一次导航照常工作', async () => {
    const win = makeWin('#/edit');
    let answer = false;
    const confirmLeave = vi.fn(async () => answer);
    const router = new Router({ win, confirmLeave });
    const seen: string[] = [];
    router.onChange((r: Any) => seen.push(r.raw));
    router.start();
    router.addLeaveGuard(() => '别走');

    router.navigate(['live']);
    await flush();
    expect(seen).toEqual(['/edit']);

    answer = true;
    router.navigate(['live']);
    await flush();
    expect(confirmLeave).toHaveBeenCalledTimes(2);
    expect(router.route.segments).toEqual(['live']);
    expect(seen).toEqual(['/edit', '/live']);
  });

  it('多个 guard 时第一个返回非 null 的生效，后面的不再被问', async () => {
    const win = makeWin('#/edit');
    const g1 = vi.fn(() => null);
    const g2 = vi.fn(() => '第二个拦的');
    const g3 = vi.fn(() => '第三个拦的');
    const confirmLeave = vi.fn(async () => true);
    const router = new Router({ win, confirmLeave });
    router.start();
    router.addLeaveGuard(g1);
    router.addLeaveGuard(g2);
    router.addLeaveGuard(g3);

    router.navigate(['live']);
    await flush();

    expect(confirmLeave).toHaveBeenCalledWith('第二个拦的');
    expect(g1).toHaveBeenCalledTimes(1);
    expect(g3).not.toHaveBeenCalled();
  });

  it('全部 guard 都放行 → 不问，直接导航', async () => {
    const win = makeWin('#/edit');
    const confirmLeave = vi.fn(async () => true);
    const router = new Router({ win, confirmLeave });
    router.start();
    router.addLeaveGuard(() => null);
    router.addLeaveGuard(() => null);

    router.navigate(['live']);
    await flush();
    expect(confirmLeave).not.toHaveBeenCalled();
    expect(router.route.segments).toEqual(['live']);
  });

  it('guard 抛错 → 交给 onError，不挡住导航', async () => {
    const errs: unknown[] = [];
    const win = makeWin('#/edit');
    const confirmLeave = vi.fn(async () => true);
    const router = new Router({ win, confirmLeave, onError: (e: unknown) => errs.push(e) });
    router.start();
    router.addLeaveGuard(() => { throw new Error('guard 炸了'); });

    router.navigate(['live']);
    await flush();

    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe('guard 炸了');
    expect(confirmLeave).not.toHaveBeenCalled();
    expect(router.route.segments).toEqual(['live']);
  });

  it('addLeaveGuard 返回的 Disposable 解除拦截', async () => {
    const win = makeWin('#/edit');
    const confirmLeave = vi.fn(async () => false);
    const router = new Router({ win, confirmLeave });
    router.start();
    const off = router.addLeaveGuard(() => '别走');

    off.dispose();
    router.navigate(['live']);
    await flush();

    expect(confirmLeave).not.toHaveBeenCalled();
    expect(router.route.segments).toEqual(['live']);
  });

  it('confirmLeave 自己抛错 → 视为不确认，错误交给 onError', async () => {
    const errs: unknown[] = [];
    const win = makeWin('#/edit');
    const confirmLeave = vi.fn(async () => { throw new Error('弹窗炸了'); });
    const router = new Router({ win, confirmLeave, onError: (e: unknown) => errs.push(e) });
    router.start();
    router.addLeaveGuard(() => '别走');

    router.navigate(['live']);
    await flush();

    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe('弹窗炸了');
    expect(router.route.segments).toEqual(['edit']);
    expect(win.location.hash).toBe('#/edit');
  });

  it('用户确认离开后拦截器仍在（归面板自己 unmount 时解除）', async () => {
    const win = makeWin('#/edit');
    const confirmLeave = vi.fn(async () => true);
    const router = new Router({ win, confirmLeave });
    router.start();
    router.addLeaveGuard(() => '别走');

    router.navigate(['live']);
    await flush();
    router.navigate(['usage']);
    await flush();

    expect(confirmLeave).toHaveBeenCalledTimes(2);
  });
});

describe('Router —— 与地址栏保持同步', () => {
  it('start() 重读地址栏,不用构造时的快照', () => {
    const win = makeWin('#/a');
    const router = new Router({ win, confirmLeave: async () => true });
    // 构造与 start 之间地址变了(异步 boot、加载中用户点了链接都会这样),
    // 此时还没有监听,这次变化无人接收
    win.location.hash = '#/b';

    const seen: string[] = [];
    router.onChange((r: Any) => seen.push(r.raw));
    router.start();

    expect(seen).toEqual(['/b']);
    expect(router.route.raw).toBe('/b');
  });

  it('内部状态若与地址栏脱节,navigate 到地址栏那个值仍能补上同步', async () => {
    const win = makeWin('#/a');
    const router = new Router({ win, confirmLeave: async () => true });
    const seen: string[] = [];
    router.onChange((r: Any) => seen.push(r.raw));
    router.start();
    // 绕过 router 直接改地址栏、且不派发事件,人为造出脱节
    win.setHashSilently('#/b');

    // 去重要跟地址栏比而不是跟 current 比:否则"写一个地址栏里已有的值"
    // 既不早退也不触发 hashchange,这个路由就永远到不了。
    router.navigate(['b']);
    await flush();
    expect(seen).toEqual(['/a', '/b']);
    expect(router.route.raw).toBe('/b');
  });

  it('两次导航同时被拦、双双拒绝后,下一次干净导航仍然生效', async () => {
    const win = makeWin('#/edit');
    let resolve1: (v: boolean) => void = () => {};
    let resolve2: (v: boolean) => void = () => {};
    const answers: Promise<boolean>[] = [
      new Promise<boolean>((r) => { resolve1 = r; }),
      new Promise<boolean>((r) => { resolve2 = r; }),
    ];
    let n = 0;
    const confirmLeave = vi.fn(() => answers[n++] ?? Promise.resolve(true));
    const router = new Router({ win, confirmLeave });
    const seen: string[] = [];
    router.onChange((r: Any) => seen.push(r.raw));
    router.start();
    const off = router.addLeaveGuard(() => '别走');

    // 第一次：去 /live，被拦，confirm 挂起
    win.location.hash = '#/live';
    await flush();
    // 第二次：确认框还开着，用户又把地址拨回 /edit。这次**不该叠第二个确认框**,
    // 直接拨回去即可——同时问两次"要走吗"没有意义。
    win.location.hash = '#/edit';
    await flush();
    expect(confirmLeave).toHaveBeenCalledTimes(1);

    resolve1(false);
    await flush();
    resolve2(false);
    await flush();

    // 写回相同 hash 不触发 hashchange，回拨状态需记录目标 hash。
    off.dispose();
    win.location.hash = '#/usage';
    await flush();

    expect(seen).toEqual(['/edit', '/usage']);
    expect(router.route.raw).toBe('/usage');
  });
});

// ===========================================================================
// ConsolePageLoader
// ===========================================================================

interface FakeLink {
  rel: string;
  href: string;
  dataset: Record<string, string>;
}

interface LoaderHarness {
  loader: Any;
  importModule: Any;
  createLink: Any;
  querySelector: Any;
  log: Any;
  appended: FakeLink[];
}

function makeLoader(importModule: Any): LoaderHarness {
  const appended: FakeLink[] = [];
  const createLink = vi.fn((): FakeLink => ({ rel: '', href: '', dataset: {} }));
  const querySelector = vi.fn(() => null);
  const log = vi.fn();
  const styleHost = {
    appendChild: (node: unknown) => { appended.push(node as FakeLink); },
    querySelector,
  };
  const loader = new ConsolePageLoader({ importModule, styleHost, createLink, log });
  return { loader, importModule, createLink, querySelector, log, appended };
}

const JS_URL = '/assets/worlds-chat.a1b2c3.js';
const CSS_URL = '/assets/worlds-chat.a1b2c3.css';

function makeBundle(...panelIds: string[]): Any {
  const panels: Record<string, Any> = {};
  for (const id of panelIds) panels[id] = { mount: vi.fn() };
  return { panels };
}

describe('ConsolePageLoader —— 加载与去重', () => {
  it('正常加载：拿到 default export 的扩展', async () => {
    const bundle = makeBundle('gate');
    const h = makeLoader(vi.fn(async () => ({ default: bundle })));

    const out = await h.loader.load('world:chat', { js: JS_URL });
    expect(out).toBe(bundle);
    expect(h.importModule).toHaveBeenCalledWith(JS_URL);
  });

  it('同一个 provider 只 import 一次', async () => {
    const bundle = makeBundle('gate');
    const h = makeLoader(vi.fn(async () => ({ default: bundle })));

    const a = await h.loader.load('world:chat', { js: JS_URL });
    const b = await h.loader.load('world:chat', { js: JS_URL });
    const c = await h.loader.resolvePanel('world:chat', 'gate', { js: JS_URL });
    expect(h.importModule).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(bundle.panels.gate);
  });

  it('并发调用去重：两个 load 同时发出，只 import 一次，且拿到同一个对象', async () => {
    const bundle = makeBundle('gate');
    let release: (v: unknown) => void = () => {};
    const importModule = vi.fn(() => new Promise((r) => { release = r; }));
    const h = makeLoader(importModule);

    const p1 = h.loader.load('world:chat', { js: JS_URL });
    const p2 = h.loader.load('world:chat', { js: JS_URL });
    expect(importModule).toHaveBeenCalledTimes(1);

    release({ default: bundle });
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(bundle);
    expect(b).toBe(a);
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it('并发调用同时失败：两个 promise 都 reject，之后仍可重试', async () => {
    const bundle = makeBundle('gate');
    const importModule = vi.fn()
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce({ default: bundle });
    const h = makeLoader(importModule);

    const p1 = h.loader.load('world:chat', { js: JS_URL });
    const p2 = h.loader.load('world:chat', { js: JS_URL });
    await expect(p1).rejects.toBeInstanceOf(PanelBundleError);
    await expect(p2).rejects.toBeInstanceOf(PanelBundleError);

    await expect(h.loader.load('world:chat', { js: JS_URL })).resolves.toBe(bundle);
  });

  it('失败不缓存：第一次 import 抛错，第二次会重新 import', async () => {
    // 加载失败不缓存，后续调用重新尝试。
    const bundle = makeBundle('gate');
    const importModule = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ default: bundle });
    const h = makeLoader(importModule);

    const err = await catchErr(h.loader.load('world:chat', { js: JS_URL }));
    expect(err).toBeInstanceOf(PanelBundleError);
    expect(err.pageId).toBe('world:chat');
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.message).toContain('boom');
    expect(h.loader.loadedPages).toEqual([]);

    await expect(h.loader.load('world:chat', { js: JS_URL })).resolves.toBe(bundle);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it('loadedPages 反映已加载集合，失败的不计入', async () => {
    const bundle = makeBundle('gate');
    const importModule = vi.fn(async (url: string) => {
      if (url.includes('bad')) throw new Error('nope');
      return { default: bundle };
    });
    const h = makeLoader(importModule);

    expect(h.loader.loadedPages).toEqual([]);
    await h.loader.load('world:chat', { js: JS_URL });
    expect(h.loader.loadedPages).toEqual(['world:chat']);

    await catchErr(h.loader.load('world:vtuber', { js: '/assets/bad.js' }));
    expect(h.loader.loadedPages).toEqual(['world:chat']);

    await h.loader.load('persona:demo', { js: '/assets/persona.js' });
    expect(h.loader.loadedPages).toEqual(['world:chat', 'persona:demo']);
  });
});

describe('ConsolePageLoader —— 拒绝的输入', () => {
  it('asset 为 undefined → PanelBundleError，消息里提到 pnpm build:web', async () => {
    const h = makeLoader(vi.fn());
    const err = await catchErr(h.loader.load('world:chat', undefined));
    expect(err).toBeInstanceOf(PanelBundleError);
    expect(err.pageId).toBe('world:chat');
    expect(err.message).toContain('pnpm build:web');
    expect(h.importModule).not.toHaveBeenCalled();
  });

  it('asset.js 不是合法 /assets/ 路径 → 拒绝，且 importModule 根本没被调用', async () => {
    const h = makeLoader(vi.fn());
    for (const js of [
      'http://evil/x.js',
      '//evil/x.js',
      '/assets/../../etc/passwd',
      '/assets/%2e%2e/x.js',
      'javascript:alert(1)',
      '/other/x.js',
    ]) {
      const err = await catchErr(h.loader.load('world:chat', { js }));
      expect(err).toBeInstanceOf(PanelBundleError);
      expect(err.message).toContain('不合法');
    }
    // 安全断言：闸门在 import 之前，一次都没放出去
    expect(h.importModule).not.toHaveBeenCalled();
    expect(h.createLink).not.toHaveBeenCalled();
  });

  it('default export 不是扩展 → PanelBundleError', async () => {
    for (const mod of [
      { default: 42 },
      { default: null },
      { default: { panels: [] } }, // 数组要排掉，否则诊断会误导成"缺这个面板"
      { default: {} },
      { default: { panels: 'x' } },
      {},
      null,
    ]) {
      const h = makeLoader(vi.fn(async () => mod));
      const err = await catchErr(h.loader.load('world:chat', { js: JS_URL }));
      expect(err).toBeInstanceOf(PanelBundleError);
      expect(err.message).toContain('default');
    }
  });
});

describe('ConsolePageLoader —— resolvePanel', () => {
  it('取到存在的面板', async () => {
    const bundle = makeBundle('gate', 'voice');
    const h = makeLoader(vi.fn(async () => ({ default: bundle })));
    const panel = await h.loader.resolvePanel('world:chat', 'voice', { js: JS_URL });
    expect(panel).toBe(bundle.panels.voice);
  });

  it('取不存在的面板 → 报错，消息里列出扩展实际提供的面板名', async () => {
    const bundle = makeBundle('gate', 'voice');
    const h = makeLoader(vi.fn(async () => ({ default: bundle })));
    const err = await catchErr(h.loader.resolvePanel('world:chat', 'nope', { js: JS_URL }));
    expect(err).toBeInstanceOf(PanelBundleError);
    expect(err.message).toContain('nope');
    expect(err.message).toContain('gate');
    expect(err.message).toContain('voice');
  });

  it('扩展一个面板都没有时，列表退化成 (无)', async () => {
    const h = makeLoader(vi.fn(async () => ({ default: { panels: {} } })));
    const err = await catchErr(h.loader.resolvePanel('world:chat', 'gate', { js: JS_URL }));
    expect(err.message).toContain('(无)');
  });

  it('panels[x] 存在但 mount 不是函数 → 同样报错', async () => {
    const h = makeLoader(vi.fn(async () => ({
      default: { panels: { gate: { mount: 'not a function' }, voice: { mount: () => {} } } },
    })));
    const err = await catchErr(h.loader.resolvePanel('world:chat', 'gate', { js: JS_URL }));
    expect(err).toBeInstanceOf(PanelBundleError);
    expect(err.message).toContain('gate');
  });
});

describe('ConsolePageLoader —— 样式注入', () => {
  it('有 asset.css 时创建 link，设好 rel/href/dataset.provider 并 append', async () => {
    const h = makeLoader(vi.fn(async () => ({ default: makeBundle('gate') })));
    await h.loader.load('world:chat', { js: JS_URL, css: CSS_URL });

    expect(h.createLink).toHaveBeenCalledTimes(1);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({
      rel: 'stylesheet',
      href: CSS_URL,
      dataset: { provider: 'world:chat' },
    });
    expect(h.querySelector).not.toHaveBeenCalled();
  });

  it('没有 asset.css 时不创建 link', async () => {
    const h = makeLoader(vi.fn(async () => ({ default: makeBundle('gate') })));
    await h.loader.load('world:chat', { js: JS_URL });
    expect(h.createLink).not.toHaveBeenCalled();
    expect(h.appended).toHaveLength(0);
  });

  it('同一 provider 重复加载只注入一次样式', async () => {
    // 加载成功会被缓存，第二次 load 压根进不了 loadOnce。要真的把 injectStyle
    // 跑两遍，得让第一次在 import 那步失败（失败不缓存 → 第二次重来）。
    const bundle = makeBundle('gate');
    const importModule = vi.fn()
      .mockRejectedValueOnce(new Error('还没 build'))
      .mockResolvedValueOnce({ default: bundle });
    const h = makeLoader(importModule);
    const asset = { js: JS_URL, css: CSS_URL };

    await catchErr(h.loader.load('world:chat', asset));
    await h.loader.load('world:chat', asset);

    expect(importModule).toHaveBeenCalledTimes(2);
    expect(h.createLink).toHaveBeenCalledTimes(1);
    expect(h.appended).toHaveLength(1);
  });

  it('asset.css 不合法 → 跳过注入并记一条日志，但不影响 js 加载成功', async () => {
    const bundle = makeBundle('gate');
    const h = makeLoader(vi.fn(async () => ({ default: bundle })));

    const out = await h.loader.load('world:chat', { js: JS_URL, css: 'https://cdn.evil/x.css' });
    expect(out).toBe(bundle);
    expect(h.createLink).not.toHaveBeenCalled();
    expect(h.appended).toHaveLength(0);
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(String(h.log.mock.calls[0][0])).toContain('不合法');
  });

  it('不同 provider 各注入各的', async () => {
    const h = makeLoader(vi.fn(async () => ({ default: makeBundle('gate') })));
    await h.loader.load('world:chat', { js: JS_URL, css: CSS_URL });
    await h.loader.load('world:vtuber', { js: '/assets/v.js', css: '/assets/v.css' });

    expect(h.appended).toHaveLength(2);
    expect(h.appended.map((l) => l.dataset.provider)).toEqual(['world:chat', 'world:vtuber']);
  });
});
