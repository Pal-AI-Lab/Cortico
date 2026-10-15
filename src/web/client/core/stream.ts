/**
 * 面板的 WebSocket 流客户端。断线后退避重连，CONNECTING 期间的 send 排队；unmount 关闭连接并取消待执行的重连定时器。
 */

import type { WebUiStreamHandle, WebUiStreamHandlers } from '../../shared/client-panel.ts';

/** 只用到 WebSocket 的这几样；注入假件即可测。 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: ((this: unknown, ev: unknown) => unknown) | null;
  onclose: ((this: unknown, ev: unknown) => unknown) | null;
  onerror: ((this: unknown, ev: unknown) => unknown) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => unknown) | null;
}

export interface StreamOptions {
  url: string;
  handlers: WebUiStreamHandlers;
  /** 面板的 signal。abort = 连同重连一起停。 */
  signal: AbortSignal;
  createSocket(url: string): SocketLike;
  /** 退避定时器；注入以便测试用假时钟。 */
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
  onError?(err: unknown): void;
}

const OPEN = 1;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 15_000;

export function openStream(opts: StreamOptions): WebUiStreamHandle {
  /** 连上之前攒着的帧。 */
  const outbox: string[] = [];
  let socket: SocketLike | null = null;
  let timer: number | null = null;
  let backoff = BACKOFF_START_MS;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      opts.clearTimer(timer);
      timer = null;
    }
    const s = socket;
    socket = null;
    if (s) {
      // 先摘回调再关:close() 会同步触发 onclose,那时候不该再排重连。
      s.onopen = null;
      s.onclose = null;
      s.onerror = null;
      s.onmessage = null;
      try {
        s.close();
      } catch (err) {
        opts.onError?.(err);
      }
    }
    outbox.length = 0;
  };

  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      opts.onError?.(err);
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || timer !== null) return;
    // 全额抖动:退避上限内均匀取一点,避免多个面板同时重连撞在一起。
    const wait = Math.round(backoff * (0.5 + Math.random() * 0.5));
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    timer = opts.setTimer(() => {
      timer = null;
      connect();
    }, wait);
  };

  function connect(): void {
    if (stopped) return;
    let s: SocketLike;
    try {
      s = opts.createSocket(opts.url);
    } catch (err) {
      opts.onError?.(err);
      scheduleReconnect();
      return;
    }
    socket = s;

    s.onopen = () => {
      if (stopped) return;
      backoff = BACKOFF_START_MS; // 连上了才算数,否则一直翻倍
      const queued = outbox.splice(0, outbox.length);
      for (const text of queued) {
        safely(() => s.send(text));
      }
      if (opts.handlers.open) safely(() => opts.handlers.open!());
    };

    s.onmessage = (ev) => {
      if (stopped) return;
      const data = ev?.data;
      safely(() => opts.handlers.message(typeof data === 'string' ? data : String(data)));
    };

    s.onerror = (err) => {
      opts.onError?.(err);
      // 不在这里重连:onerror 之后浏览器一定还会给一次 onclose。
    };

    s.onclose = () => {
      if (socket === s) socket = null;
      if (stopped) return;
      if (opts.handlers.close) safely(() => opts.handlers.close!(true));
      scheduleReconnect();
    };
  }

  if (opts.signal.aborted) {
    stopped = true;
  } else {
    opts.signal.addEventListener('abort', () => {
      const wasRunning = !stopped;
      stop();
      if (wasRunning && opts.handlers.close) safely(() => opts.handlers.close!(false));
    }, { once: true });
    connect();
  }

  const handle: WebUiStreamHandle = {
    send(text: string): void {
      if (stopped) return;
      const s = socket;
      if (s && s.readyState === OPEN) {
        safely(() => s.send(text));
      } else {
        outbox.push(text);
      }
    },
    get open(): boolean {
      return !stopped && socket?.readyState === OPEN;
    },
    dispose(): void {
      const wasRunning = !stopped;
      stop();
      if (wasRunning && opts.handlers.close) safely(() => opts.handlers.close!(false));
    },
  };
  return handle;
}
