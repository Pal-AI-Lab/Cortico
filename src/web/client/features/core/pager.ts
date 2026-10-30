/**
 * 运行诊断里表格的翻页条:左边「显示 a–b，共 N 条」,右边每页条数、上一页、页码、下一页。
 * 样子与扩展页的翻页一致。每页条数按 `key` 记在 localStorage,下次打开照旧。
 * `more` 表示已载入的之外还有更早的:最后一页的「下一页」照样能点,由调用方去取。
 */

import type { WebUi } from '../../../shared/client-panel.ts';
import { S } from './strings.ts';

export interface Pager {
  el: HTMLElement;
  /** 当前页(从 0 起)。 */
  readonly page: number;
  readonly size: number;
  /** 本页在全部行里的起止下标 `[from, to)`。先 `render` 再取,页码才已按总数收好。 */
  slice(total: number): [number, number];
  /** 按总条数重画;页码超出时退到最后一页。 */
  render(total: number, more?: boolean): void;
  /** 回到第一页(换了筛选条件时)。 */
  reset(): void;
}

export interface PagerOptions {
  /** 记每页条数用的键。 */
  key: string;
  sizes: readonly number[];
  defaultSize: number;
  /** 页码或每页条数变了;调用方重画表格并再调 `render`。`beyond` = 在最后一页点了下一页而 `more` 为真。 */
  onChange(beyond: boolean): void;
}

const storeKey = (key: string): string => `cortico.core.pageSize.${key}`;

function readSize(key: string, sizes: readonly number[], fallback: number): number {
  let n = NaN;
  try { n = Number(localStorage.getItem(storeKey(key))); } catch { /* 读不到存储时用缺省 */ }
  return sizes.includes(n) ? n : fallback;
}

export function createPager(ui: WebUi, opts: PagerOptions): Pager {
  let page = 0;
  let size = readSize(opts.key, opts.sizes, opts.defaultSize);
  let pages = 1;
  let hasMore = false;

  const el = ui.rowbar();
  el.classList.add('core-pager');
  const shown = ui.h('span', 'core-pager-shown');
  const sizeLabel = ui.h('label', 'core-pager-size');
  sizeLabel.append(
    ui.h('span', null, S.perPage),
    ui.select({
      value: String(size),
      options: opts.sizes.map((n) => String(n)),
      onChange: (v) => {
        size = Number(v);
        try { localStorage.setItem(storeKey(opts.key), String(size)); } catch { /* 存不下就只用于本次 */ }
        page = 0;
        opts.onChange(false);
      },
    }),
  );
  const prev = ui.button(S.prevPage, { size: 'sm', onClick: () => { page = Math.max(0, page - 1); opts.onChange(false); } });
  const pageOf = ui.h('span', 'core-pager-of');
  const next = ui.button(S.nextPage, {
    size: 'sm',
    onClick: () => {
      if (page < pages - 1) {
        page += 1;
        opts.onChange(false);
      } else if (hasMore) {
        page += 1;
        opts.onChange(true);
      }
    },
  });
  el.append(shown, ui.h('span', 'grow'), sizeLabel, prev, pageOf, next);

  return {
    el,
    get page() { return page; },
    get size() { return size; },
    slice(total) {
      return [Math.min(page * size, total), Math.min(total, (page + 1) * size)];
    },
    render(total, more = false) {
      hasMore = more;
      pages = Math.max(1, Math.ceil(total / size));
      if (page > pages - 1) page = pages - 1;
      const from = total ? page * size + 1 : 0;
      const to = Math.min(total, (page + 1) * size);
      shown.textContent = S.shown(from, to, total, more);
      pageOf.textContent = S.pageOf(page + 1, pages, more);
      prev.disabled = page === 0;
      next.disabled = page >= pages - 1 && !more;
      // 一页就装得下、也没有更早的:翻页键没有用处,只留计数和每页条数
      prev.hidden = next.hidden = pageOf.hidden = pages <= 1 && !more;
    },
    reset() {
      page = 0;
    },
  };
}
