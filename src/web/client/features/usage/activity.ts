/**
 * Token 活跃度：按天的格子图，一列一周（周一在上），颜色深浅分五档，悬停显示日期与当天 token 数。
 * 格子铺满节宽，以页面时间范围的末日为终点向前排；范围内的日子着色，范围外的灰色淡显作对照。
 * 范围长于一行能放下的周数时格子缩小，不横向滚动。
 */

import type { WebUi } from '../../../shared/client-panel.ts';
import { LANGUAGE } from '../../core/language.ts';
import { S } from './strings.ts';
import type { UsageTip } from './tooltip.ts';
import type { UsageAggregate } from './types.ts';

const DAY_MS = 86_400_000;
/** 格子边长与间距（px），与 src/web/public/styles.css 中 .uactivity 的 --cell / --gap 一致。 */
const CELL = 12;
const GAP = 3;
/** 范围之外最多向前补多少天作对照；取数时按这个长度取。 */
const ACTIVITY_CONTEXT_DAYS = 371;
/** 月份标签之间至少隔几列，避免挤在一起。 */
const MONTH_GAP = 3;
/** 换范围时着色/褪色依次扫过各列，每列的延迟与整段扫过的上限（ms）。 */
const SWEEP_STEP_MS = 18;
const SWEEP_MAX_MS = 600;
/** 单个格子着色/褪色的时长，与 src/web/public/styles.css 中 .ugrid .ucell 的 opacity / filter 过渡一致。 */
const SWEEP_FADE_MS = 240;

export interface ActivityDeps {
  ui: WebUi;
  box: HTMLElement;
  tip: UsageTip;
}

/** 页面时间范围，`YYYY-MM-DD`，含两端。 */
export interface ActivityRange {
  from: string;
  to: string;
}

const dayMs = (day: string): number => Date.parse(day + 'T00:00:00Z');
const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** 取格子图数据的起始日：范围起点与终点前 ACTIVITY_CONTEXT_DAYS 天中较早的一个。 */
export function activityFrom(range: ActivityRange): string {
  return dayKey(Math.min(dayMs(range.from), dayMs(range.to) - (ACTIVITY_CONTEXT_DAYS - 1) * DAY_MS));
}

/** 0 = 没有用量；1–4 按当天 token 占最大值的比例分档。 */
function level(value: number, max: number): number {
  return value > 0 ? Math.min(4, Math.ceil((value / max) * 4)) : 0;
}

/**
 * 动效：`'enter'` 格子按列依次出现，用于页面首次画出；给出上一个范围时，进入范围的日子从右往左依次
 * 着色，离开范围的从左往右依次褪色；`null` 直接画出（刷新、改窗宽）。
 */
export type ActivityMotion = 'enter' | ActivityRange | null;

/** `daily` 是按天分桶、覆盖 `activityFrom(range)` 到 `range.to` 的数据。 */
export function renderActivity(deps: ActivityDeps, daily: UsageAggregate, range: ActivityRange, motion: ActivityMotion): void {
  const { ui, box, tip } = deps;
  box.replaceChildren();
  const series = daily.series || [];
  if (!series.length) {
    box.appendChild(ui.placeholder(S.noCalls));
    return;
  }
  const tokens = new Map(series.map((p) => [p.bucket.slice(0, 10), (p.promptTokens || 0) + (p.completionTokens || 0)]));
  const dataFrom = series[0]!.bucket.slice(0, 10);
  const toMs = dayMs(range.to);
  const end = toMs + (6 - ((new Date(toMs).getUTCDay() + 6) % 7)) * DAY_MS;
  const rangeCols = Math.ceil((end - dayMs(range.from) + DAY_MS) / DAY_MS / 7);
  const dataCols = Math.ceil((end - dayMs(dataFrom) + DAY_MS) / DAY_MS / 7);
  const fitCols = Math.floor(((box.clientWidth || 720) + GAP) / (CELL + GAP));
  const cols = Math.max(rangeCols, Math.min(fitCols, dataCols));
  const start = end - (cols * 7 - 1) * DAY_MS;
  // 深浅按整张图上的最大值分档，范围内外可直接比较。
  const first = dayKey(start);
  let max = 1;
  for (const [day, value] of tokens) if (day >= first && value > max) max = value;

  const grid = ui.h('div', motion === 'enter' ? 'ugrid is-entering' : 'ugrid');
  const prev = motion && motion !== 'enter' ? motion : null;
  /** 范围内外状态变了的格子：先按旧状态画，挂上页面后再切到新状态。 */
  const shifts: Array<{ cell: HTMLElement; col: number; dim: boolean }> = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < 7; r++) {
      const day = dayKey(start + (c * 7 + r) * DAY_MS);
      const cell = ui.h('span', 'ucell');
      cell.style.setProperty('--i', String(c));
      if (day < dataFrom || day > range.to) {
        cell.classList.add('is-out');
      } else {
        const value = tokens.get(day) ?? 0;
        cell.dataset.day = day;
        cell.dataset.value = String(value);
        cell.dataset.level = String(level(value, max));
        const dim = day < range.from;
        const wasDim = prev ? day < prev.from || day > prev.to : dim;
        cell.classList.toggle('is-dim', wasDim);
        if (wasDim !== dim) shifts.push({ cell, col: c, dim });
      }
      grid.appendChild(cell);
    }
  }

  const monthName = new Intl.DateTimeFormat(LANGUAGE, { month: 'short', timeZone: 'UTC' });
  const months = ui.h('div', 'umonths');
  let lastLabel = -MONTH_GAP;
  let lastMonth = -1;
  for (let c = 0; c < cols; c++) {
    const at = new Date(start + c * 7 * DAY_MS);
    if (at.getUTCMonth() === lastMonth) continue;
    lastMonth = at.getUTCMonth();
    if (c - lastLabel < MONTH_GAP) continue;
    lastLabel = c;
    const label = ui.h('span', null, monthName.format(at));
    label.style.gridColumn = `${c + 1} / span ${MONTH_GAP}`;
    months.appendChild(label);
  }

  const legend = ui.h('div', 'ulegend');
  legend.append(ui.h('span', null, S.less));
  for (let i = 0; i <= 4; i++) {
    const sw = ui.h('span', 'ucell');
    sw.dataset.level = String(i);
    legend.appendChild(sw);
  }
  legend.append(ui.h('span', null, S.more));

  const point = (ev: MouseEvent): void => {
    const cell = (ev.target as Element | null)?.closest<HTMLElement>('.ucell[data-day]');
    if (!cell) { tip.hide(); return; }
    const value = Number(cell.dataset.value).toLocaleString();
    tip.show(`<div class="tt-h">${cell.dataset.day}</div><div class="tt-tot">${value} token</div>`, cell.dataset.day!);
    tip.move(ev);
  };
  grid.addEventListener('mousemove', point);
  grid.addEventListener('mouseleave', () => tip.hide());

  const wrap = ui.h('div', 'uactivity');
  wrap.style.setProperty('--cols', String(cols));
  wrap.append(grid, months, legend);
  box.appendChild(wrap);
  if (!shifts.length) return;
  const gain = shifts.filter((s) => !s.dim).map((s) => s.col);
  const lose = shifts.filter((s) => s.dim).map((s) => s.col);
  const step = (span: number): number => Math.min(SWEEP_STEP_MS, SWEEP_MAX_MS / Math.max(1, span));
  const gainStep = step(Math.max(...gain, 0) - Math.min(...gain, 0));
  const loseStep = step(Math.max(...lose, 0) - Math.min(...lose, 0));
  void grid.offsetWidth; // 旧状态先落到屏幕上，下面的切换才有过渡
  let longest = 0;
  for (const { cell, col, dim } of shifts) {
    const delay = Math.round(dim ? (col - Math.min(...lose)) * loseStep : (Math.max(...gain) - col) * gainStep);
    longest = Math.max(longest, delay);
    cell.style.transitionDelay = `${delay}ms`;
    cell.classList.toggle('is-dim', dim);
  }
  // 延迟只给这一次切换；扫完后清掉，悬停的过渡照常立即开始。
  box.ownerDocument.defaultView?.setTimeout(() => {
    for (const { cell } of shifts) cell.style.transitionDelay = '';
  }, longest + SWEEP_FADE_MS);
}
