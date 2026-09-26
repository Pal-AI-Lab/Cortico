/** 浮层挂载到调用方提供的 host，并随面板 signal 关闭。confirm 取消或 abort 时返回 false；abort 后不显示新浮层。 */

import type { Disposable } from '../../shared/client-panel.ts';
import { h } from './dom.ts';
import { button, rowbar } from './sheet.ts';
import { S } from './strings.ts';

/** 浮层的生存环境：文档、挂载点、面板生命周期。 */
export interface OverlayEnv {
  doc: Document;
  /** 浮层挂在这里。**不能是面板的 `root`**——那个在 unmount 时会被清空。 */
  host: HTMLElement;
  /** 面板的 `ctx.signal`。abort = 面板没了，浮层必须跟着消失。 */
  signal: AbortSignal;
}

/**
 * 一层浮层。`close()` 幂等。
 * `dispose` 与 `close` 是同一个函数：对外（扩展手里的 `Disposable`）叫 dispose，
 * 对内叫 close——不为了统一名字去改契约里那个通用的资源名。
 */
export interface Overlay extends Disposable {
  el: HTMLElement;
  close(): void;
  /** 本层的生命周期：`close()` 即 abort。层内的监听全挂它。 */
  signal: AbortSignal;
}

/** 面板已经 abort 之后的调用返回它：拿到的是个不会爆的空句柄。 */
export const noopDisposable: Disposable = { dispose() {} };

/**
 * 铺一层浮层：进 DOM，接上"面板 abort 就关"。
 *
 * 面板那条 abort 监听自己也挂着本层的 signal（`once` + `signal`），所以浮层先被关掉时
 * 它当场摘掉——不会在面板的 signal 上攒一串已经没用的闭包（那是个真泄漏：一个面板
 * 弹一百次 toast 就攒一百条）。
 */
function openLayer(env: OverlayEnv, el: HTMLElement, onClose?: () => void): Overlay {
  const ac = new AbortController();
  const close = (): void => {
    if (ac.signal.aborted) return;
    ac.abort();
    el.remove();
    onClose?.();
  };
  env.signal.addEventListener('abort', close, { once: true, signal: ac.signal });
  env.host.appendChild(el);
  return { el, close, signal: ac.signal, dispose: close };
}

/**
 * 铺一层 `.modal` 遮罩，接好"点遮罩 / 按 Esc 关闭"。
 * `onClose` 只会被调一次；重复调用 `close()` 是安全的。
 */
function openModal(env: OverlayEnv, onClose: () => void): Overlay {
  const el = h(env.doc, 'div', 'modal');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  const layer = openLayer(env, el, onClose);

  env.doc.addEventListener(
    'keydown',
    (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') layer.close();
    },
    { signal: layer.signal },
  );
  // 按下位置决定是否关闭，卡片内开始的拖选不关闭弹窗。
  el.addEventListener(
    'mousedown',
    (ev: MouseEvent) => {
      if (ev.target === el) layer.close();
    },
    { signal: layer.signal },
  );
  return layer;
}

/** toast 停留多久（与 `@keyframes toast` 的 1.9s 对齐，留一点余量再摘节点）。 */
const TOAST_MS = 2000;

/**
 * 瞬时提示。`prev` 是上一条 toast（同一个 ui 实例只留一条，后来的顶掉前面的，
 * 与既有前端 `sendToast` 的行为一致）。返回新的一层，面板 abort 后返回 `null`。
 */
export function toast(
  env: OverlayEnv,
  text: string,
  tone: 'ok' | 'bad' | undefined,
  prev: Overlay | null,
): Overlay | null {
  prev?.close();
  if (env.signal.aborted) return null;
  const el = h(env.doc, 'div', tone === 'bad' ? 'toast bad' : 'toast', text);
  const layer = openLayer(env, el);
  const timer = setTimeout(() => layer.close(), TOAST_MS);
  // 提前关掉(被下一条顶掉、或面板卸载)时把定时器也撤了,免得留一个空转的回调
  layer.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return layer;
}

/** 模态确认。resolve 之后 DOM 与监听都已清干净。 */
export function confirm(
  env: OverlayEnv,
  opts: { title: string; body?: string; danger?: boolean },
): Promise<boolean> {
  // 面板已经卸了:不弹窗,直接按"没答应"收场
  if (env.signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    // 默认答案就是 false,所以**任何**关闭路径(取消键 / Esc / 点遮罩 / 面板 abort)
    // 都会 resolve false,不必各自记得去 settle。
    let answer = false;
    const modal = openModal(env, () => resolve(answer));
    const settle = (v: boolean): void => {
      answer = v;
      modal.close();
    };

    const doc = env.doc;
    const card = h(doc, 'div', 'modalcard confirm-card');
    card.setAttribute('style', 'width:min(460px,92vw)');
    const head = h(doc, 'div', 'modalhead');
    head.appendChild(h(doc, 'span', 'modaltitle', opts.title));
    const body = h(doc, 'div', 'modalbody');
    if (opts.body) body.appendChild(h(doc, 'div', null, opts.body));

    const bar = rowbar(doc);
    bar.appendChild(h(doc, 'span', 'grow'));
    bar.appendChild(
      button(doc, modal.signal, S.cancel, { size: 'sm', onClick: () => settle(false) }),
    );
    const ok = button(doc, modal.signal, opts.danger ? S.proceedAnyway : S.confirm, {
      size: 'sm',
      variant: opts.danger ? 'danger' : 'primary',
      onClick: () => settle(true),
    });
    bar.appendChild(ok);
    body.appendChild(bar);

    card.append(head, body);
    modal.el.appendChild(card);
    ok.focus?.();
  });
}

/** busy 不响应 Esc、遮罩或关闭按钮；由返回的 Disposable 或面板 abort 关闭。 */
export function busy(env: OverlayEnv, title: string, text?: string): Disposable {
  if (env.signal.aborted) return noopDisposable;
  const doc = env.doc;
  const el = h(doc, 'div', 'modal busy');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-busy', 'true');
  const layer = openLayer(env, el);
  const card = h(doc, 'div', 'modalcard');
  card.setAttribute('style', 'width:min(460px,92vw)');
  const head = h(doc, 'div', 'modalhead');
  head.appendChild(h(doc, 'span', 'modaltitle', title));
  const body = h(doc, 'div', 'modalbody');
  if (text) body.appendChild(h(doc, 'div', 'busytext', text));
  card.append(head, body);
  el.appendChild(card);
  return layer;
}

/** 可关闭的抽屉；字符串正文显示为 pre.mono，节点正文直接挂入 modalbody。 */
export function drawer(env: OverlayEnv, title: string, body: string | HTMLElement): Disposable {
  if (env.signal.aborted) return noopDisposable;
  const doc = env.doc;
  const modal = openModal(env, () => {});
  const card = h(doc, 'div', 'modalcard');
  const head = h(doc, 'div', 'modalhead');
  head.append(
    h(doc, 'span', 'modaltitle', title),
    button(doc, modal.signal, S.close, { size: 'sm', onClick: () => modal.close() }),
  );
  const bodyEl = h(doc, 'div', 'modalbody');
  // 字符串走 pre.mono 保持现状观感;节点直接进,抽屉不必知道里面是什么
  bodyEl.appendChild(typeof body === 'string' ? h(doc, 'pre', 'mono', body) : body);
  card.append(head, bodyEl);
  modal.el.appendChild(card);
  return modal;
}
