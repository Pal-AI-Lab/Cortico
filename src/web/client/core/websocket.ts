/**
 * 框架 /ws/debug 与 /ws/sessions 的 JSON WebSocket 入口，复用 core/stream 的退避、发送排队和生命周期取消。
 * 按页面协议选择 ws/wss；文本帧解析为 JSON，坏帧报告 onError 后丢弃；网络状态通过回调交给调用方呈现。
 */

import type { WebUiStreamHandle } from '../../shared/client-panel.ts';
import { withLanguage } from './language.ts';
import type { Lifecycle } from './lifecycle.ts';
import { openStream, type SocketLike } from './stream.ts';

export interface SocketEnv {
  /** `/ws/debug` → 绝对地址 */
  wsUrl(path: string): string;
  createSocket(url: string): SocketLike;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
}

export interface LocationLike {
  protocol: string;
  host: string;
}

/** HTTPS 页面使用 WSS。 */
export function wsUrlOf(loc: LocationLike, path: string): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}${path}`;
}

/** typeof globalThis 提供 WebSocket 构造器类型。 */
export function browserSocketEnv(win: Window & typeof globalThis): SocketEnv {
  return {
    wsUrl: (path) => wsUrlOf(win.location, withLanguage(path)),
    createSocket: (url) => new win.WebSocket(url) as unknown as SocketLike,
    setTimer: (fn, ms) => win.setTimeout(fn, ms),
    clearTimer: (id) => win.clearTimeout(id),
  };
}

export interface FrameworkSocketOptions {
  /** `/ws/debug` / `/ws/sessions` */
  path: string;
  /** abort 停止连接与重连；句柄登记在该 lifecycle。 */
  lifecycle: Lifecycle;
  /** 一帧(已解析)。非对象的帧(数组、裸字符串)不会送到这儿。 */
  onFrame(frame: Readonly<Record<string, unknown>>): void;
  /** 连接和断线通知；主动关闭不报告断线。 */
  onNet?(online: boolean): void;
  onError?(err: unknown): void;
  env: SocketEnv;
}

/** 返回的通道句柄已登记在 lifecycle，可提前 dispose。 */
export function openFrameworkSocket(opts: FrameworkSocketOptions): WebUiStreamHandle {
  const { env } = opts;
  const handle = openStream({
    url: env.wsUrl(opts.path),
    signal: opts.lifecycle.signal,
    createSocket: env.createSocket,
    setTimer: env.setTimer,
    clearTimer: env.clearTimer,
    ...(opts.onError ? { onError: opts.onError } : {}),
    handlers: {
      open: () => opts.onNet?.(true),
      close: (willRetry) => {
        if (willRetry) opts.onNet?.(false);
      },
      message: (text) => {
        let frame: unknown;
        try {
          frame = JSON.parse(text);
        } catch (err) {
          opts.onError?.(err);
          return;
        }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
        opts.onFrame(frame as Record<string, unknown>);
      },
    },
  });
  return opts.lifecycle.own(handle);
}
