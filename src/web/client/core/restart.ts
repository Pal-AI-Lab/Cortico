/**
 * 进程重启的浏览器侧等待。重启是"落下重启标志 + 规范关机",由启动器循环把子进程拉起来;
 * 旧进程退出后页面连不上,所以轮询 `/api/run/lifecycle`,直到同一部署换了 bootId 且就绪。
 */

import { get } from './api.ts';

/** `/api/run/lifecycle` 的回应:deployment 是数据目录摘要,bootId 每次启动都不同。 */
export interface Boot {
  deployment: string;
  bootId: string;
  ready: boolean;
}

/** 同一部署、换了 bootId 且就绪才算回来了。 */
export function restartOutcome(before: Boot, next: Boot): 'waiting' | 'ready' | 'wrong-deployment' {
  return next.deployment !== before.deployment
    ? 'wrong-deployment'
    : next.bootId !== before.bootId && next.ready ? 'ready' : 'waiting';
}

export interface RestartWaitOptions {
  /** 重启前的读数;之后认的是"换了 bootId"。 */
  before: Boot;
  signal: AbortSignal;
  /** 新进程就绪。 */
  onReady(): void;
  /** 同一端口上应答的是另一个部署。 */
  onWrongDeployment?(): void;
  intervalMs?: number;
}

/** 立刻查一次,之后按间隔重查;连不上就继续等。signal 中止即停。 */
export function waitForRestart(opts: RestartWaitOptions): void {
  if (opts.signal.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    opts.signal.removeEventListener('abort', stop);
  };
  opts.signal.addEventListener('abort', stop, { once: true });
  const check = async (): Promise<void> => {
    if (stopped) return;
    try {
      const next = await get<Boot>('/api/run/lifecycle', { signal: opts.signal });
      if (stopped) return;
      const outcome = restartOutcome(opts.before, next);
      if (outcome === 'wrong-deployment') { stop(); opts.onWrongDeployment?.(); return; }
      if (outcome === 'ready') { stop(); opts.onReady(); return; }
    } catch { /* 旧进程已退、新进程还没起:下一拍再试。 */ }
    if (!stopped) timer = setTimeout(() => void check(), opts.intervalMs ?? 1000);
  };
  void check();
}
