/** 每次面板挂载创建 WebUi，绑定 memo 命名空间、signal 与浮层宿主。 */

import type { WebUiMemo, WebUi, Disposable } from '../../shared/client-panel.ts';
import { esc, h } from './dom.ts';
import { webUiFormat } from './format.ts';
import { kv, progress, statgrid, stat, table } from './data.ts';
import { checkbox, field, input, segmented, select, textarea } from './fields.ts';
import { copyButton, disable } from './actions.ts';
import { log } from './log.ts';
import { promptInput } from './prompt-input.tsx';
import {
  actions,
  button,
  chip,
  foldSheet,
  msgline,
  pill,
  placeholder,
  rowbar,
  section,
  sheet,
} from './sheet.ts';
import type { Overlay, OverlayEnv } from './overlay.ts';
import { busy, confirm, drawer, lightbox, noopDisposable, toast } from './overlay.ts';

export interface WebUiDeps {
  /** 面板局部持久化。`foldSheet` 的展开状态存这儿。 */
  memo: WebUiMemo;
  /**
   * toast / confirm / drawer 的挂载点。host 传 `document.body` 或一个专用容器。
   * **不能是面板的 `root`**——那个在 unmount 时会被清空。
   */
  overlayHost: HTMLElement;
  /** 面板的 ctx.signal，用于取消弹窗与释放资源。 */
  signal: AbortSignal;
  /** 缺省为 overlayHost.ownerDocument。 */
  doc?: Document;
}

export function createWebUi(deps: WebUiDeps): WebUi {
  const doc = deps.doc ?? deps.overlayHost.ownerDocument;
  const signal = deps.signal;
  const env: OverlayEnv = { doc, host: deps.overlayHost, signal };
  // 同一实例只留一条 toast:后来的顶掉前面的,免得叠成一摞
  let liveToast: Overlay | null = null;
  // 抽出来是因为 copyButton 也要弹 toast,而"只留一条"这条规矩记在上面那个闭包里
  const showToast = (text: string, tone?: 'ok' | 'bad'): Disposable => {
    liveToast = toast(env, text, tone, liveToast);
    // abort 之后 toast 不显示,但仍要给回一个句柄:调用方 `.dispose()` 不该炸
    return liveToast ?? noopDisposable;
  };

  return {
    h: (tag, cls, text) => h(doc, tag, cls, text),
    esc,
    sheet: (opts) => sheet(doc, opts),
    foldSheet: (id, opts) => foldSheet(doc, deps.memo, signal, id, opts),
    rowbar: () => rowbar(doc),
    section: (title, description) => section(doc, title, description),
    actions: () => actions(doc),
    button: (label, opts) => button(doc, signal, label, opts),
    copyButton: (text, opts) => copyButton(env, showToast, text, opts),
    pill: (text, tone) => pill(doc, text, tone),
    chip: (text, tone) => chip(doc, text, tone),
    msgline: (text, bad) => msgline(doc, text, bad),
    placeholder: (text) => placeholder(doc, text),
    input: (opts) => input(doc, signal, opts),
    select: (opts) => select(doc, signal, opts),
    textarea: (opts) => textarea(doc, signal, opts),
    promptInput: (opts) => promptInput(doc, signal, opts),
    checkbox: (label, opts) => checkbox(doc, signal, label, opts),
    field: (label, control) => field(doc, label, control),
    segmented: (items, opts) => segmented(doc, signal, items, opts),
    table: (opts) => table(doc, opts),
    kv: (rows) => kv(doc, rows),
    log: (opts) => log(doc, signal, opts),
    stat: (item) => stat(doc, item),
    statgrid: (items) => statgrid(doc, items),
    progress: (opts) => progress(doc, opts),
    toast: showToast,
    confirm: (opts) => confirm(env, opts),
    drawer: (title, body) => drawer(env, title, body),
    lightbox: (src, alt) => lightbox(env, src, alt),
    busy: (title, text) => busy(env, title, text),
    disable: (...els) => disable(els),
    fmt: webUiFormat,
  };
}

export { LOG_STICK_PX, shouldStick } from './log.ts';
