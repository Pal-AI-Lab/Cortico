/**
 * ConsolePanelContext 组装入口，为扩展提供调用、UI、流与资源管理。signal、interval、frame、own、guardLeave 及 UI 资源均绑定本次面板挂载的生命周期。
 */

import {
  type ConsoleMemo,
  type ConsolePanelContext,
  type ConsoleStreamHandle,
  type ConsoleStreamHandlers,
  type Disposable,
} from '../../shared/client-panel.ts';
import { panelStreamRoute } from '../../shared/console-protocol.ts';
import {
  invokePanel,
  invokePanelBinary,
  pickPath as pickHostPath,
  setConfig as writeConfig,
} from '../core/api.ts';
import { LANGUAGE } from '../core/language.ts';
import { Lifecycle } from '../core/lifecycle.ts';
import { openStream, type SocketLike } from '../core/stream.ts';
import { createConsoleUi } from '../ui/index.ts';

export interface PanelContextDeps {
  pageId: string;
  panelId: string;
  root: HTMLElement;
  /** 该面板的资源账本。host 建、host 在 unmount 时 dispose。 */
  lifecycle: Lifecycle;
  /** 浮层宿主。**不能是 `root`**——那个 unmount 时会被清空。 */
  overlayHost: HTMLElement;
  /** 重取 manifest 刷新 host 那部分（徽标 / 导航 / 三态）。 */
  refresh(): Promise<void>;
  /** 注册离开拦截，返回解除函数。由 router 提供。 */
  addLeaveGuard(fn: () => string | null): Disposable;
  /** 持久化后端。host 给一个按 `page:panel` 命名空间隔离过的实现。 */
  memo: ConsoleMemo;
  /** WS 构造。注入以便测试。 */
  createSocket(url: string): SocketLike;
  /** 绝对化 WS 地址（`/ws/...` → `ws://host/ws/...`）。 */
  wsUrl(path: string): string;
  onError(err: unknown): void;
  doc?: Document;
  /** 宿主面板挂载本面板时给的作用域；自己占一个页签时为空对象。 */
  scope?: Readonly<Record<string, string>>;
  /** 把本页声明到某插槽的面板挂进容器。host 提供实现。 */
  mountSlot(
    slot: string,
    host: HTMLElement,
    scope: Readonly<Record<string, string>>,
  ): Promise<Disposable>;
}

/**
 * memo 按 page:panel 隔离，命名空间由 context 加入，避免不同面板的同名键互相覆盖。
 */
export function namespacedMemo(
  backing: ConsoleMemo,
  pageId: string,
  panelId: string,
): ConsoleMemo {
  const prefix = `${pageId}${panelId}`;
  return {
    get: (key, fallback) => backing.get(prefix + key, fallback),
    set: (key, value) => backing.set(prefix + key, value),
  };
}

export function createPanelContext(deps: PanelContextDeps): ConsolePanelContext {
  const { pageId, panelId, lifecycle } = deps;
  const signal = lifecycle.signal;

  const ui = createConsoleUi({
    memo: deps.memo,
    overlayHost: deps.overlayHost,
    signal,
    ...(deps.doc ? { doc: deps.doc } : {}),
  });

  return {
    pageId,
    panelId,
    language: LANGUAGE,
    root: deps.root,
    signal,

    invoke: <T>(method: string, args?: unknown[]): Promise<T> =>
      invokePanel<T>(pageId, panelId, method, args, { signal }),

    invokeBinary: (method: string, args?: unknown[]): Promise<Blob> =>
      invokePanelBinary(pageId, panelId, method, args, { signal }),

    notifyOnUnmount(method: string, args?: unknown[]): void {
      signal.addEventListener('abort', () => {
        void invokePanel(pageId, panelId, method, args, { keepalive: true }).catch(deps.onError);
      }, { once: true });
    },

    scope: deps.scope ?? {},

    mountSlot: (slot, host, scope) => deps.mountSlot(slot, host, scope ?? {}),

    pickPath: (options) => pickHostPath(options, { signal }),

    setConfig: (groupId, values) => writeConfig(groupId, values, { signal }),

    stream(handlers: ConsoleStreamHandlers): ConsoleStreamHandle {
      const handle = openStream({
        url: deps.wsUrl(panelStreamRoute(pageId, panelId)),
        handlers,
        signal,
        createSocket: deps.createSocket,
        setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
        clearTimer: (id) => clearTimeout(id),
        onError: deps.onError,
      });
      // openStream 自己听 signal 收场;再登记一次是为了让"提前 dispose"也走同一条路。
      lifecycle.own(handle);
      return handle;
    },

    interval: (fn, ms) => lifecycle.interval(fn, ms),
    timeout: (fn, ms) => lifecycle.timeout(fn, ms),
    frame: (fn) => lifecycle.frame(fn),
    own: (d) => lifecycle.own(d),

    memo: deps.memo,

    guardLeave: (fn) => lifecycle.own(deps.addLeaveGuard(fn)),

    ui,

    refresh: () => deps.refresh(),
  };
}
