/**
 * 档案卡与几个行内小件。
 *
 * 视觉全部复用 `src/web/public/styles.css` 里的共享 class。`sheetbody` 是卡片内部
 * 布局的稳定挂点，供等高卡片把动作区压到下沿。
 */

import type { WebUiBadge } from '../../shared/webui-protocol.ts';
import type {
  WebUiChipTone,
  WebUiMemo,
  WebUiSheet,
  WebUiSheetOptions,
} from '../../shared/client-panel.ts';
import { h } from './dom.ts';

function heading(doc: Document, title: string, en?: string): HTMLHeadingElement {
  const head = h(doc, 'h3', null, title);
  if (en) head.appendChild(h(doc, 'span', 'en', en));
  return head;
}

/** 有 desc 时将说明行作为 body 的首个子节点，以匹配折叠卡选择器。 */
function descLine(doc: Document, body: HTMLElement, text?: string): HTMLElement | null {
  if (!text) return null;
  const el = h(doc, 'div', 'sh-desc', text);
  body.appendChild(el);
  return el;
}

/** 档案卡。WebUI 的基本视觉单元。 */
export function sheet(doc: Document, opts: WebUiSheetOptions): WebUiSheet {
  const el = h(doc, 'div', 'sheet tabbed');
  const note = h(doc, 'span', 'foldnote hidden');
  const body = h(doc, 'div', 'sheetbody');
  const head = heading(doc, opts.title, opts.en);
  // note 照样进 DOM(带 .hidden),这样 `sheet()` 与 `foldSheet()` 的节点关系一致:
  // 扩展往 note 里写字在两种卡上都是合法操作,只是不折叠的卡看不见它。
  head.appendChild(note);
  el.append(head, body);
  return { el, body, note, desc: descLine(doc, body, opts.desc) };
}

/** 折叠状态通过面板 memo 存取，键由面板命名空间隔离。 */
export function foldSheet(
  doc: Document,
  memo: WebUiMemo,
  signal: AbortSignal,
  id: string,
  opts: WebUiSheetOptions & { defaultOpen?: boolean },
): WebUiSheet {
  const el = h(doc, 'details', 'sheet tabbed fold');
  el.open = memo.get<boolean>(foldKey(id), !!opts.defaultOpen);
  const sum = h(doc, 'summary');
  const note = h(doc, 'span', 'foldnote');
  sum.append(heading(doc, opts.title, opts.en), note);
  const body = h(doc, 'div', 'foldbody');
  el.append(sum, body);
  // 卡片本身随 root 一起被丢弃,监听本不至于泄漏;仍挂 signal 是因为 memo 可能比
  // 面板活得久——面板都卸了还回写折叠状态,那是拿旧值盖新值。
  el.addEventListener('toggle', () => memo.set(foldKey(id), el.open), { signal });
  return { el, body, note, desc: descLine(doc, body, opts.desc) };
}

/** memo 里的键。加前缀是为了不跟扩展自己的键撞。 */
function foldKey(id: string): string {
  return 'fold:' + id;
}

/** 一行按钮/状态条。 */
export function rowbar(doc: Document): HTMLDivElement {
  return h(doc, 'div', 'rowbar');
}

/** 卡片内一个独立内容组的标题。 */
export function section(doc: Document, title: string, description?: string): HTMLDivElement {
  const el = h(doc, 'div', 'sectionhead');
  el.appendChild(h(doc, 'h4', null, title));
  if (description) el.appendChild(h(doc, 'div', 'sectiondesc', description));
  return el;
}

/** 提交、保存与破坏性操作所在的卡片脚栏。 */
export function actions(doc: Document): HTMLDivElement {
  return h(doc, 'div', 'rowbar actionbar');
}

export function button(
  doc: Document,
  signal: AbortSignal,
  label: string,
  opts?: {
    variant?: 'plain' | 'primary' | 'danger';
    size?: 'sm' | 'md';
    onClick?: (ev: MouseEvent) => void;
  },
): HTMLButtonElement {
  // class 顺序与既有前端一致:`btn sm primary`
  let cls = 'btn';
  if (opts?.size === 'sm') cls += ' sm';
  if (opts?.variant === 'primary' || opts?.variant === 'danger') cls += ' ' + opts.variant;
  const el = h(doc, 'button', cls, label);
  el.type = 'button';
  if (opts?.onClick) el.addEventListener('click', opts.onClick, { signal });
  return el;
}

/**
 * 药丸。三态各有配色：`on` 用 `--ok`，`off` 用 `--ink-dim`（比中性态更淡的"关闭/静默"），
 * `plain` 与不给 tone 一样落中性 `.pill`。
 */
export function pill(doc: Document, text: string, tone?: WebUiBadge['tone']): HTMLSpanElement {
  const cls = tone === 'on' ? 'pill on' : tone === 'off' ? 'pill off' : 'pill';
  return h(doc, 'span', cls, text);
}

/** 筹码。等宽小字的读数标签，`warn` / `accent` 对应既有的 `warnc` / `dreamc` 两个配色。 */
export function chip(doc: Document, text: string, tone?: WebUiChipTone): HTMLSpanElement {
  const cls = tone === 'warn' ? 'chip warnc' : tone === 'accent' ? 'chip dreamc' : 'chip';
  return h(doc, 'span', cls, text);
}

/** 一行消息（保存结果、错误）。`bad` 走警示配色。 */
export function msgline(doc: Document, text?: string, bad?: boolean): HTMLDivElement {
  return h(doc, 'div', bad ? 'msgline bad' : 'msgline', text ?? '');
}

/** 空态。居中灰字，占一片版面——"这里本该有东西，但现在没有"。 */
export function placeholder(doc: Document, text: string): HTMLDivElement {
  return h(doc, 'div', 'placeholder', text);
}
