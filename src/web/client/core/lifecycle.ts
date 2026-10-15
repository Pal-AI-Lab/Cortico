/**
 * 每次 WebUI 挂载的资源管理器。卸载时先 abort，再逐项 dispose。
 * 监听和 fetch 使用 signal；不接受 signal 的定时器、RAF、observer、AudioContext 与 ObjectURL 经 own、interval 或 frame 登记。
 */

import { toDisposable, type Disposable } from '../../shared/client-panel.ts';

export class Lifecycle {
  private readonly controller = new AbortController();
  /** 按后进先出顺序释放资源。 */
  private readonly owned: Disposable[] = [];
  private closed = false;
  private readonly onError: (err: unknown) => void;

  /** onError 接收释放错误；单项失败不阻止后续释放。 */
  constructor(onError: (err: unknown) => void = () => {}) {
    this.onError = onError;
  }

  /** unmount 时 abort。传给 `addEventListener` / `fetch` 即可自动清理。 */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get disposed(): boolean {
    return this.closed;
  }

  /** 登记资源；已 dispose 时立即释放并原样返回。 */
  own<T extends Disposable>(d: T): T {
    if (this.closed) {
      this.safely(() => d.dispose());
      return d;
    }
    this.owned.push(d);
    return d;
  }

  /** 包一个清理函数并登记。 */
  add(cleanup: () => void): Disposable {
    return this.own(toDisposable(cleanup));
  }

  /** 轮询。dispose 时自动停。 */
  interval(fn: () => void, ms: number): Disposable {
    if (this.closed) return toDisposable(() => {});
    const id = setInterval(() => {
      try {
        fn();
      } catch (err) {
        this.onError(err);
      }
    }, ms);
    return this.own(toDisposable(() => clearInterval(id)));
  }

  /** 一次性延时；触发后移除登记，dispose 时取消。 */
  timeout(fn: () => void, ms: number): Disposable {
    if (this.closed) return toDisposable(() => {});
    let handle: Disposable | undefined;
    const id = setTimeout(() => {
      if (handle) this.forget(handle);
      try {
        fn();
      } catch (err) {
        this.onError(err);
      }
    }, ms);
    handle = this.own(toDisposable(() => clearTimeout(id)));
    return handle;
  }

  private forget(d: Disposable): void {
    const i = this.owned.indexOf(d);
    if (i >= 0) this.owned.splice(i, 1);
  }

  /**
   * RAF 循环。`fn` 返回 `false` 即自行结束；dispose 时自动停。
   * `dtMs` 是距上一帧的毫秒数，首帧为 0。
   */
  frame(fn: (dtMs: number) => void | false): Disposable {
    if (this.closed) return toDisposable(() => {});
    let raf = 0;
    let last = 0;
    let stopped = false;
    const step = (now: number): void => {
      if (stopped) return;
      const dt = last === 0 ? 0 : now - last;
      last = now;
      let keep: void | false;
      try {
        keep = fn(dt);
      } catch (err) {
        this.onError(err);
        keep = false;
      }
      if (keep === false) {
        stopped = true;
        return;
      }
      // 回调可能已 dispose 当前生命周期，此时不再安排下一帧。
      if (stopped) return;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return this.own(toDisposable(() => {
      stopped = true;
      cancelAnimationFrame(raf);
    }));
  }

  /** 幂等释放：先 abort 取消请求与监听，再按后进先出顺序 dispose。 */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.safely(() => this.controller.abort());
    for (let i = this.owned.length - 1; i >= 0; i--) {
      const d = this.owned[i]!;
      this.safely(() => d.dispose());
    }
    this.owned.length = 0;
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.onError(err);
    }
  }
}
