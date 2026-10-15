/**
 * 数据表、键值表与概览读数复用现存 .tablewrap、table.data、table.kvtable、.statgrid 样式。table 返回 clear/addRow 句柄供增量刷新，单元格使用 textContent，不把名称或正文解析为 HTML。
 */

import type {
  WebUiCell,
  WebUiKvRow,
  WebUiProgress,
  WebUiProgressOptions,
  WebUiStat,
  WebUiTable,
  WebUiTableOptions,
} from '../../shared/client-panel.ts';
import { h } from './dom.ts';
import { webUiFormat } from './format.ts';

/** 一格 → `<td>`。 */
function cell(doc: Document, spec: WebUiCell): HTMLTableCellElement {
  const td = h(doc, 'td');
  if (spec == null) return td;
  if (typeof spec === 'string' || typeof spec === 'number') {
    td.textContent = String(spec);
    return td;
  }
  // 节点直接放进去(pill / 按钮 / 链接这类)
  if (!isCellSpec(spec)) {
    td.appendChild(spec);
    return td;
  }
  if (spec.cls) td.className = spec.cls;
  if (spec.el) td.appendChild(spec.el);
  else if (spec.text != null) td.textContent = String(spec.text);
  return td;
}

/**
 * 分辨"描述对象"与"现成节点"。
 *
 * 不用 `instanceof HTMLElement`：这个模块在 node 里被测（没有那个全局），而且未来若
 * 换到离屏文档/iframe，跨 realm 的 `instanceof` 本来就会假阴性。改按结构判断——
 * 描述对象是纯字面量，不会有 `nodeType`。
 */
function isCellSpec(
  v: HTMLElement | { text?: string | number | null; el?: HTMLElement; cls?: string },
): v is { text?: string | number | null; el?: HTMLElement; cls?: string } {
  return (v as { nodeType?: number }).nodeType === undefined;
}

/** 数据表。 */
export function table(doc: Document, opts?: WebUiTableOptions): WebUiTable {
  const head = opts?.head ?? [];
  const el = h(doc, 'div', 'tablewrap');
  // 外框限高才会滚,表头的 position:sticky 也才有意义;不给就让它自然铺开
  if (opts?.maxHeight) el.setAttribute('style', 'max-height:' + opts.maxHeight + ';overflow:auto');
  const tbl = h(doc, 'table', 'data');
  if (head.length) {
    const thead = h(doc, 'thead');
    const tr = h(doc, 'tr');
    for (const t of head) tr.appendChild(h(doc, 'th', null, t));
    thead.appendChild(tr);
    tbl.appendChild(thead);
  }
  const body = h(doc, 'tbody');
  tbl.appendChild(body);
  el.appendChild(tbl);

  return {
    el,
    body,
    addRow(cells) {
      const tr = h(doc, 'tr');
      for (const c of cells) tr.appendChild(cell(doc, c));
      body.appendChild(tr);
      return tr;
    },
    clear(empty) {
      while (body.children.length) body.children[0].remove();
      if (empty == null) return;
      const tr = h(doc, 'tr');
      const td = h(doc, 'td', 'placeholder');
      td.colSpan = Math.max(1, head.length);
      td.textContent = empty;
      tr.appendChild(td);
      body.appendChild(tr);
    },
  };
}

/** 键值表无表头；tr 直接挂在 table 下。 */
export function kv(doc: Document, rows: readonly WebUiKvRow[]): HTMLTableElement {
  const el = h(doc, 'table', 'kvtable');
  for (const row of rows) {
    const tr = h(doc, 'tr');
    tr.appendChild(h(doc, 'td', null, row.k));
    const td = h(doc, 'td');
    const v = row.v;
    if (v == null) td.textContent = '';
    else if (typeof v === 'string' || typeof v === 'number') td.textContent = String(v);
    else td.appendChild(v);
    tr.appendChild(td);
    el.appendChild(tr);
  }
  return el;
}

/** 概览读数。`.k` 小标题 + `.v` 大数字（`unit` 落成 `.v` 里的 `<small>`）。 */
export function stat(doc: Document, item: WebUiStat): HTMLDivElement {
  const el = h(doc, 'div', item.accent ? 'stat accent' : 'stat');
  el.appendChild(h(doc, 'div', 'k', item.k));
  const v = h(doc, 'div', 'v');
  if (typeof item.v === 'string' || typeof item.v === 'number') v.textContent = String(item.v);
  else v.appendChild(item.v);
  if (item.unit) v.appendChild(h(doc, 'small', null, item.unit));
  el.appendChild(v);
  return el;
}

/** 读数网格。`items` 可以不给（先建空网格，之后自己往里 append）。 */
export function statgrid(doc: Document, items?: readonly WebUiStat[]): HTMLDivElement {
  const el = h(doc, 'div', 'statgrid');
  for (const it of items ?? []) el.appendChild(stat(doc, it));
  return el;
}

/**
 * 满值归一。0 与非有限数一律当 1——除数是 0 的话读数会印成 `NaN%`，
 * 而"总量还不知道"恰恰是进度条最常见的初始状态。
 */
function normMax(m: number | undefined): number {
  return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 1;
}

/** 填充比例，夹在 0..1。读数用的是原始 value，只有条的宽度被夹。 */
function fillRatio(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/** 占比条通过 role=progressbar 与 aria-value* 提供无障碍读数。 */
export function progress(doc: Document, opts?: WebUiProgressOptions): WebUiProgress {
  const o = opts ?? {};
  const cls =
    o.tone === 'warn' ? 'progress warnc' : o.tone === 'accent' ? 'progress dreamc' : 'progress';
  const el = h(doc, 'div', cls);
  el.setAttribute('role', 'progressbar');
  const head = h(doc, 'div', 'progresshead');
  const label = h(doc, 'span', 'progresslabel', o.label ?? '');
  const num = h(doc, 'span', 'progressnum');
  head.append(label, num);
  const track = h(doc, 'div', 'progresstrack');
  const fill = h(doc, 'div', 'progressfill');
  track.appendChild(fill);
  el.append(head, track);

  let max = normMax(o.max);
  let value = Number.isFinite(o.value) ? (o.value as number) : 0;
  const fmt = o.format ?? ((v: number, m: number): string => webUiFormat.percent(v / m));

  const paint = (): void => {
    fill.setAttribute('style', 'width:' + (fillRatio(value, max) * 100).toFixed(1) + '%');
    num.textContent = fmt(value, max);
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', String(max));
    el.setAttribute('aria-valuenow', String(value));
  };
  paint();

  return {
    el,
    get value(): number {
      return value;
    },
    get max(): number {
      return max;
    },
    setValue(v: number, m?: number): void {
      if (m !== undefined) max = normMax(m);
      value = Number.isFinite(v) ? v : 0;
      paint();
    },
    setLabel(text: string): void {
      label.textContent = text;
    },
  };
}
