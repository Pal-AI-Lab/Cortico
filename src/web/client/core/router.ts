/**
 * Hash 路由集中读写 location.hash，提供解析、变更通知与离开拦截。路由只解析路径段；各段的业务含义由 host 解释。
 */

import { toDisposable, type Disposable } from '../../shared/client-panel.ts';

export interface Route {
  /** 路径段，已 decode。`#/provider/world%3Achat/gate` → `['provider','world:chat','gate']` */
  segments: string[];
  /** 查询参数（`?a=1`），已 decode */
  query: Record<string, string>;
  /** 原始 hash（不含前导 `#`），用于回滚 */
  raw: string;
}

/** 返回一句话 = 拦下并让用户确认；返回 null = 放行。 */
export type LeaveGuard = () => string | null;

export interface RouterDeps {
  win: Window;
  /** 拦截时问用户。返回 true 表示确认离开。 */
  confirmLeave(message: string): Promise<boolean>;
  onError?(err: unknown): void;
}

export function parseHash(raw: string): Route {
  const hash = raw.startsWith('#') ? raw.slice(1) : raw;
  const qIdx = hash.indexOf('?');
  const path = qIdx >= 0 ? hash.slice(0, qIdx) : hash;
  const query: Record<string, string> = {};
  if (qIdx >= 0) {
    for (const pair of hash.slice(qIdx + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = eq >= 0 ? pair.slice(0, eq) : pair;
      const v = eq >= 0 ? pair.slice(eq + 1) : '';
      try {
        query[decodeURIComponent(k)] = decodeURIComponent(v);
      } catch {
        query[k] = v; // 坏编码不该让整页打不开
      }
    }
  }
  const segments = path.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { segments, query, raw: hash };
}

/** 比较两个 hash 是否指向同一处，忽略前导 `#`（`''` / `'#'` 都算空）。 */
function sameHash(a: string, b: string): boolean {
  const norm = (h: string): string => (h.startsWith('#') ? h.slice(1) : h);
  return norm(a) === norm(b);
}

export function buildHash(segments: readonly string[], query?: Record<string, string>): string {
  const path = segments.map((s) => encodeURIComponent(s)).join('/');
  const entries = Object.entries(query ?? {});
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `#/${path}${qs ? `?${qs}` : ''}`;
}

export class Router {
  private readonly deps: RouterDeps;
  private readonly listeners = new Set<(route: Route) => void>();
  private readonly guards = new Set<LeaveGuard>();
  private readonly decisions = new Set<() => Promise<boolean>>();
  private current: Route;
  /** 待处理的回拨 hash；写入相同 hash 不触发 hashchange，因此按目标值识别回拨。 */
  private pendingRevert: string | null = null;
  /** 确认框是否已经开着。开着时再来的变更直接拨回，不叠第二个框。 */
  private confirming = false;
  private started = false;

  constructor(deps: RouterDeps) {
    this.deps = deps;
    this.current = parseHash(deps.win.location.hash);
  }

  get route(): Route {
    return this.current;
  }

  start(): Disposable {
    if (this.started) throw new Error('Router 已经启动');
    this.started = true;
    // start 时重新读取地址，构造后的地址可能已变化。
    this.current = parseHash(this.deps.win.location.hash);
    const handler = (): void => { void this.onHashChange(); };
    this.deps.win.addEventListener('hashchange', handler);
    this.emit();
    return toDisposable(() => this.deps.win.removeEventListener('hashchange', handler));
  }

  onChange(cb: (route: Route) => void): Disposable {
    this.listeners.add(cb);
    return toDisposable(() => this.listeners.delete(cb));
  }

  /** 登记离开拦截；返回的 Disposable 必须随面板卸载释放。 */
  addLeaveGuard(guard: LeaveGuard): Disposable {
    this.guards.add(guard);
    return toDisposable(() => this.guards.delete(guard));
  }

  addLeaveDecision(decide: () => Promise<boolean>): Disposable {
    this.decisions.add(decide);
    return toDisposable(() => this.decisions.delete(decide));
  }

  navigate(segments: readonly string[], query?: Record<string, string>): void {
    this.go(buildHash(segments, query), (hash) => { this.deps.win.location.hash = hash; });
  }

  /** 替换当前历史条目，不新增条目。 */
  replace(segments: readonly string[], query?: Record<string, string>): void {
    this.go(buildHash(segments, query), (hash) => this.deps.win.location.replace(hash));
  }

  private go(next: string, write: (hash: string) => void): void {
    // 按地址栏判重；写入相同 hash 不触发 hashchange。
    if (sameHash(this.deps.win.location.hash, next)) {
      if (!sameHash(this.current.raw, next)) {
        this.current = parseHash(next);
        this.emit();
      }
      return;
    }
    write(next);
  }

  /** 回拨地址；当前地址已相同则不写入。 */
  private revertTo(raw: string): void {
    const target = `#${raw}`;
    if (sameHash(this.deps.win.location.hash, target)) {
      this.pendingRevert = null;
      return;
    }
    this.pendingRevert = target;
    this.deps.win.location.hash = target;
  }

  private firstBlock(): string | null {
    for (const g of this.guards) {
      let msg: string | null = null;
      try {
        msg = g();
      } catch (err) {
        this.deps.onError?.(err);
      }
      if (msg) return msg;
    }
    return null;
  }

  private async onHashChange(): Promise<void> {
    const win = this.deps.win;
    // 这次变更是我们自己拨回去造成的,不算一次导航。
    if (this.pendingRevert !== null && sameHash(win.location.hash, this.pendingRevert)) {
      this.pendingRevert = null;
      return;
    }
    // 已经在问用户了:再来的变更一律先拨回去,不叠第二个确认框。
    if (this.confirming) {
      this.revertTo(this.current.raw);
      return;
    }

    if (this.decisions.size) {
      this.confirming = true;
      let allowed = true;
      try {
        for (const decide of this.decisions) if (!(await decide())) { allowed = false; break; }
      } catch (error) { allowed = false; this.deps.onError?.(error); }
      finally { this.confirming = false; }
      if (!allowed) { this.revertTo(this.current.raw); return; }
    }
    const block = this.firstBlock();
    if (block) {
      this.confirming = true;
      let ok = false;
      try {
        ok = await this.deps.confirmLeave(block);
      } catch (err) {
        this.deps.onError?.(err); // 问不出结果就当没同意
      } finally {
        this.confirming = false;
      }
      if (!ok) {
        this.revertTo(this.current.raw);
        return;
      }
      // 用户确认离开：拦截器归它自己的面板所有，unmount 时会解除,这里不动它。
    }
    this.current = parseHash(win.location.hash);
    this.emit();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(this.current);
      } catch (err) {
        this.deps.onError?.(err);
      }
    }
  }
}
