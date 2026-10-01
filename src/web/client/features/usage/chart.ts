/**
 * 用量页的堆叠柱图，包含 byRoleModel 寻址、成本档位和类型→角色→模型层级，归用量 feature 所有。
 * 组合、取值、配色、格式化和桶标签均为独立导出的纯函数；renderChart 仅操作自身创建的 SVG。
 */

import type { ConsoleUi } from '../../../shared/client-panel.ts';
import { consoleFormat } from '../../ui/format.ts';
import { esc } from '../../ui/dom.ts';
import { clampNumber, hexToHsl, hslCss } from '../../theme/palette.ts';
import { U_PALETTE, U_TYPES } from './labels.ts';
import { S } from './strings.ts';
import type {
  ColorResolver,
  UsageAccum,
  UsageAggregate,
  UsageBucketUnit,
  UsageComposite,
  UsageDim,
  UsageDimFlags,
  UsageGroupStat,
  UsageMetric,
  UsagePoint,
  UsageTypeKey,
} from './types.ts';
import type { UsageTip } from './tooltip.ts';

// ---------------------------------------------------------------------------
// 取值归一
// ---------------------------------------------------------------------------

/** 一个累计单元在某个指标下的总量。 */
export function uMetricVal(o: UsageAccum | null | undefined, metric: UsageMetric): number {
  if (!o) return 0;
  if (metric === 'cost') return o.cost || 0;
  if (metric === 'calls') return o.calls || 0;
  return (o.promptTokens || 0) + (o.completionTokens || 0);
}

/**
 * 三档分量。`o` 可以是桶点，也可以是任一子拆分 accum——两者同形，
 * 所以"类型"这一维可以和角色/模型任意交叉。
 */
export function uTypeVal(
  o: UsageAccum | null | undefined,
  key: UsageTypeKey,
  metric: UsageMetric,
): number {
  if (!o) return 0;
  if (key === 'other') return metric === 'cost' ? o.costOther || 0 : o.unclassifiedInputTokens || 0;
  if (metric === 'cost') {
    return key === 'cacheHit' ? (o.costCacheHit || 0)
      : key === 'cacheMiss' ? (o.costCacheMiss || 0)
        : (o.costOutput || 0);
  }
  return key === 'cacheHit' ? (o.cacheHitTokens || 0)
    : key === 'cacheMiss' ? (o.cacheMissTokens || 0)
      : (o.completionTokens || 0);
}

// ---------------------------------------------------------------------------
// 维度 → 组合
// ---------------------------------------------------------------------------

/** 某个维度在这份数据里的分组表。`type` 不是分组，走 `U_TYPES`。 */
function dimGroups(d: UsageAggregate, dim: UsageDim): readonly UsageGroupStat[] {
  return (dim === 'role' ? d.byRole : d.byModel) || [];
}

function dimKeys(d: UsageAggregate, dim: UsageDim): string[] {
  if (dim === 'type') return U_TYPES.filter(t => t.key !== 'other' || (d.totals?.costOther || 0) > 0 || (d.totals?.unclassifiedInputTokens || 0) > 0).map(t => t.key);
  return dimGroups(d, dim).map((g) => g.key);
}

/** 显示 UsageGroupStat.label；缺少 label 时显示原 id。 */
export function dimKeyLabel(d: UsageAggregate, dim: UsageDim, key: string): string {
  if (dim === 'type') return U_TYPES.find((t) => t.key === key)?.label ?? key;
  return groupLabel(dimGroups(d, dim), key);
}

/** 一条分组的人话名：声明方给了就用，没给就用 id。 */
function groupLabel(groups: readonly UsageGroupStat[], key: string): string {
  return groups.find((g) => g.key === key)?.label || key;
}

/** 按键的字典序分配颜色，使同一键集的颜色不随成本排序变化。 */
export function paletteSeat(keys: readonly string[], key: string): string {
  const sorted = [...keys].sort();
  const i = sorted.indexOf(key);
  return U_PALETTE[(i < 0 ? 0 : i) % U_PALETTE.length];
}

function dimBaseColor(
  d: UsageAggregate,
  dim: UsageDim,
  key: string,
  color: ColorResolver,
): string {
  if (dim === 'type') return color(U_TYPES.find((t) => t.key === key)?.color ?? U_PALETTE[0]);
  return color(paletteSeat(dimKeys(d, dim), key));
}

/** 勾选状态 → 有序维度列表。顺序即嵌套序：类型 > 角色 > 模型。 */
export function activeDims(dims: UsageDimFlags, allowType: boolean): UsageDim[] {
  const out: UsageDim[] = [];
  if (allowType && dims.type) out.push('type');
  if (dims.role) out.push('role');
  if (dims.model) out.push('model');
  return out;
}

/** 各维度键集的笛卡尔积。无维度 → `[[]]`（一根合计柱），不是 `[]`。 */
export function buildComposites(d: UsageAggregate, dimsList: readonly UsageDim[]): UsageComposite[] {
  let combos: UsageComposite[] = [[]];
  for (const dim of dimsList) {
    const keys = dimKeys(d, dim);
    const nx: UsageComposite[] = [];
    for (const c of combos) for (const k of keys) nx.push(c.concat([{ dim, key: k }]));
    combos = nx;
  }
  return combos;
}

/** 组合的稳定 id。分隔符取 U+241F（单元分隔符的可见形），键里不会出现。 */
export function compId(comp: UsageComposite): string {
  return comp.map((c) => c.dim + ':' + c.key).join('␟');
}

/** 组合的显示名。要 `d` 是因为角色/模型的人话名只能从数据里取（见 `dimKeyLabel`）。 */
export function compLabel(d: UsageAggregate, comp: UsageComposite): string {
  return comp.length ? comp.map((c) => dimKeyLabel(d, c.dim, c.key)).join(' · ') : S.total;
}

/**
 * 组合 → 桶里对应的那个累计单元。
 *
 * "类型"不参与寻址（它是同一个 accum 内部的分量），所以只看 role / model：
 * 两者都有走交叉表，只有一个走单维表，都没有就是整个桶。
 */
export function compScopeAccum(p: UsagePoint, comp: UsageComposite): UsageAccum | undefined {
  const role = comp.find((c) => c.dim === 'role');
  const model = comp.find((c) => c.dim === 'model');
  if (role && model) return (p.byRoleModel || {})[role.key]?.[model.key];
  if (role) return (p.byRole || {})[role.key];
  if (model) return (p.byModel || {})[model.key];
  return p;
}

export function compVal(p: UsagePoint, comp: UsageComposite, metric: UsageMetric): number {
  const acc = compScopeAccum(p, comp);
  if (!acc) return 0;
  const type = comp.find((c) => c.dim === 'type');
  return type ? uTypeVal(acc, type.key as UsageTypeKey, metric) : uMetricVal(acc, metric);
}

/** 最外层维度决定色系，同色系按位次调整明度；排序不改色。 */
export function compositeColors(
  d: UsageAggregate,
  composites: readonly UsageComposite[],
  dimsList: readonly UsageDim[],
  color: ColorResolver,
): Record<string, string> {
  const colorOf: Record<string, string> = {};
  if (!dimsList.length) {
    colorOf[compId([])] = 'var(--accent-2)';
    return colorOf;
  }
  const fam = new Map<string, UsageComposite[]>();
  for (const comp of composites) {
    const fk = comp[0]!.key;
    if (!fam.has(fk)) fam.set(fk, []);
    fam.get(fk)!.push(comp);
  }
  for (const [fk, members] of fam) {
    const base = dimBaseColor(d, dimsList[0]!, fk, color);
    const hsl = hexToHsl(base);
    const n = members.length;
    members.forEach((comp, i) => {
      let col = base;
      if (n > 1) {
        // 明度在 24–82 之间铺开：再深就黑成一片，再浅就白得看不见分界。
        const l = clampNumber(hsl.l - 12 + (i / (n - 1)) * 30, 24, 82);
        col = hslCss({ h: hsl.h, s: clampNumber(hsl.s, 18, 72), l });
      }
      colorOf[compId(comp)] = col;
    });
  }
  return colorOf;
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

/** 读数：成本带币种、调用带"次"、token 带 "tok"。 */
export function fmtMetric(v: number, metric: UsageMetric, cur?: string): string {
  if (metric === 'cost') return consoleFormat.money(v, cur);
  if (metric === 'calls') return Math.round(v).toLocaleString() + S.callsUnit;
  return consoleFormat.count(Math.round(v)) + ' tok';
}

/** 纵轴刻度：比读数短一截，不带单位。 */
export function fmtAxis(v: number, metric: UsageMetric): string {
  if (metric === 'cost') return v < 1 ? v.toFixed(3) : v.toFixed(1);
  if (metric === 'calls') return String(Math.round(v));
  return consoleFormat.count(Math.round(v));
}

/** 缓存命中率。分母为 0 时是 `null`（不是 0）——"没有输入"与"一次没命中"不是一回事。 */
export function cacheRateOf(p: UsageAccum): number | null {
  const d = (p.cacheHitTokens || 0) + (p.cacheMissTokens || 0);
  return d > 0 ? (p.cacheHitTokens || 0) / d : null;
}

/** 横轴上的短标签。 */
export function bucketLabel(bucket: string, unit: UsageBucketUnit): string {
  if (unit === 'minute') return bucket.slice(11, 16);
  if (unit === 'hour') return bucket.slice(11, 13) + 'h';
  if (unit === 'week') return S.weekShort(bucket.slice(5));
  if (unit === 'month') return bucket.slice(0, 7);
  return bucket.slice(5);
}

/** tooltip 抬头上的完整标签。 */
export function bucketFull(bucket: string, unit: UsageBucketUnit): string {
  if (unit === 'minute') return bucket.replace('T', ' ');
  if (unit === 'hour') return bucket.replace('T', ' ') + ':00';
  if (unit === 'week') return S.weekFull(bucket);
  if (unit === 'month') return S.monthFull(bucket);
  return bucket;
}

// ---------------------------------------------------------------------------
// tooltip 正文（纯函数：进去一个桶，出来一段 HTML）
// ---------------------------------------------------------------------------

export interface UsageTipOptions {
  metric: UsageMetric;
  stacked: boolean;
  cur?: string;
  unit: UsageBucketUnit;
  /** 鼠标此刻压着的那个段；空 = 压在整列的感应块上。 */
  curId: string | null;
}

/** tooltip 里最多列几行明细，再多就"其余从略"。 */
const TIP_ROWS_MAX = 16;

export function uTipHtml(
  d: UsageAggregate,
  p: UsagePoint,
  order: readonly UsageComposite[],
  colorOf: Record<string, string>,
  o: UsageTipOptions,
): string {
  const total = uMetricVal(p, o.metric);
  const pctOf = (v: number): number => (total > 0 ? Math.round((v / total) * 100) : 0);
  let s = `<div class="tt-h">${esc(bucketFull(p.bucket, o.unit))}</div>`;
  // 鼠标当前所指的块：醒目单列出来，回答"这块是什么"
  if (o.stacked && o.curId) {
    const comp = order.find((c) => compId(c) === o.curId);
    if (comp) {
      const v = compVal(p, comp, o.metric);
      s += `<div class="tt-cur"><span class="tt-sw" style="background:${colorOf[o.curId]}"></span>`
        + `<span class="tt-l">▸ ${esc(compLabel(d, comp))}</span>`
        + `<span class="tt-v">${fmtMetric(v, o.metric, o.cur)} · ${pctOf(v)}%</span></div>`;
    }
  }
  s += `<div class="tt-tot">${o.stacked ? S.totalPrefix : ''}${fmtMetric(total, o.metric, o.cur)}</div>`;
  if (o.stacked) {
    let shown = 0;
    for (const comp of order) {
      const v = compVal(p, comp, o.metric);
      if (v <= 0) continue;
      if (shown++ >= TIP_ROWS_MAX) {
        s += `<div class="tt-extra">${S.restOmitted}</div>`;
        break;
      }
      const cid = compId(comp);
      const cur = o.curId && cid === o.curId ? ' cur' : '';
      s += `<div class="tt-row${cur}"><span class="tt-sw" style="background:${colorOf[cid]}"></span>`
        + `<span class="tt-l">${esc(compLabel(d, comp))}</span>`
        + `<span class="tt-v">${fmtMetric(v, o.metric, o.cur)} · ${pctOf(v)}%</span></div>`;
    }
  }
  s += `<div class="tt-extra">${S.tipFoot(
    p.calls || 0,
    consoleFormat.percent(cacheRateOf(p)),
    consoleFormat.count(p.reasoningTokens || 0),
  )}</div>`;
  if (o.metric === 'cost' && (p.unpricedCalls || 0) > 0) s += `<div class="tt-extra">${S.tipUnpriced(p.unpricedCalls || 0)}</div>`;
  return s;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

const SVGNS = 'http://www.w3.org/2000/svg';

/** SVG 元素使用 SVG namespace。 */
function mkSvgEl(
  doc: Document,
  tag: string,
  attrs: Record<string, string | number>,
  text?: string,
): SVGElement {
  const e = doc.createElementNS(SVGNS, tag) as SVGElement;
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (text != null) e.textContent = text;
  return e;
}

export interface ChartDeps {
  doc: Document;
  ui: ConsoleUi;
  /** 图画在这里。宽度取它的 `clientWidth`。 */
  box: HTMLElement;
  /** 图例容器；不拆分时清空后留白。 */
  legend: HTMLElement;
  tip: UsageTip;
  color: ColorResolver;
}

export interface ChartOptions {
  metric: UsageMetric;
  dims: UsageDimFlags;
  /** 调用图没有"类型"这一维（次数没有三档分量可分）。 */
  allowType?: boolean;
  /** 按占比降序统一堆叠；关掉则按 类型>角色>模型 的嵌套序。 */
  sort?: boolean;
}

const PAD_L = 52;
const PAD_B = 46;
const PAD_T = 12;
const CHART_H = 248;
/** 横轴最多印几个刻度标签，超了按 stride 抽稀。 */
const XLABEL_MAX = 18;

/** 成本、token 与调用次数的堆叠柱图；SVG 统一处理 hover 与离开事件。 */
export function renderChart(deps: ChartDeps, d: UsageAggregate, opts: ChartOptions): void {
  const { doc, ui, box, legend, tip, color } = deps;
  box.replaceChildren();
  tip.clearHi();
  legend.replaceChildren();

  const series = d.series || [];
  const unit: UsageBucketUnit = d.bucket || 'day';
  const cur = d.currency || 'USD';
  const metric = opts.metric;
  if (!series.length) {
    box.appendChild(ui.placeholder(S.noCalls));
    return;
  }

  let dimsList = activeDims(opts.dims, opts.allowType !== false);
  let composites = buildComposites(d, dimsList);
  const tot: Record<string, number> = {};
  for (const c of composites) tot[compId(c)] = 0;
  for (const p of series) for (const c of composites) tot[compId(c)] += compVal(p, c, metric);
  if (dimsList.length) {
    // 丢掉整段全 0 的组合，减少图例/色块噪声
    composites = composites.filter((c) => (tot[compId(c)] || 0) > 0);
    // 该指标在范围内处处为 0(有调用但都未计价时成本即如此):没有可拆的段，画合计柱。
    if (!composites.length) {
      dimsList = [];
      composites = [[]];
    }
  }
  const stacked = dimsList.length > 0;
  const colorOf = compositeColors(d, composites, dimsList, color);
  const order = (stacked && opts.sort)
    ? composites.slice().sort((a, b) => (tot[compId(b)] || 0) - (tot[compId(a)] || 0))
    : composites;

  if (stacked) {
    for (const comp of order) {
      const it = ui.h('span', 'legitem');
      const sw = ui.h('span', 'legsw');
      sw.style.background = colorOf[compId(comp)] ?? '';
      it.append(sw, ui.h('span', 'leglbl', compLabel(d, comp)));
      legend.appendChild(it);
    }
  }

  const chartH = CHART_H - PAD_T - PAD_B;
  const avail = Math.max(320, box.getBoundingClientRect().width || box.clientWidth || 700);
  let step = Math.floor((avail - PAD_L - 22) / series.length);
  step = Math.max(18, Math.min(72, step));
  const W = Math.max(avail, series.length * step + PAD_L + 24);
  const bw = Math.max(6, Math.min(40, step - 6));
  let max = 0;
  for (const p of series) {
    const t = uMetricVal(p, metric);
    if (t > max) max = t;
  }
  if (!(max > 0)) max = 1;

  const svg = mkSvgEl(doc, 'svg', { viewBox: `0 0 ${W} ${CHART_H}`, width: W, height: CHART_H });
  const defs = mkSvgEl(doc, 'defs', {});
  svg.appendChild(defs);
  const clipPrefix = (box.id || 'usage-chart').replace(/[^a-zA-Z0-9_-]/g, '-');
  for (let i = 0; i <= 4; i++) {
    const y = PAD_T + chartH * (1 - i / 4);
    svg.appendChild(mkSvgEl(doc, 'line', {
      x1: PAD_L, y1: y, x2: W - 8, y2: y, class: 'axis', opacity: i === 0 ? 0.9 : 0.35,
    }));
    svg.appendChild(mkSvgEl(doc, 'text', {
      x: PAD_L - 6, y: y + 3, 'text-anchor': 'end', class: 'vlabel',
    }, fmtAxis((max * i) / 4, metric)));
  }

  const sep = stacked && order.length > 1;
  const stride = Math.ceil(series.length / XLABEL_MAX);
  series.forEach((p, i) => {
    const cx = PAD_L + i * step;                       // 列起点
    const bx = cx + Math.max(1, (step - bw) / 2);      // 柱体居中
    const g = mkSvgEl(doc, 'g', { class: 'barg' });
    // 全宽透明感应块：整列都归这个桶，相邻列平铺无缝隙，移动不断档
    g.appendChild(mkSvgEl(doc, 'rect', {
      x: cx, y: PAD_T, width: step, height: CHART_H - PAD_T - PAD_B,
      fill: 'transparent', class: 'bhit', 'data-i': i,
    }));
    const shownTotal = stacked
      ? order.reduce((sum, comp) => sum + compVal(p, comp, metric), 0)
      : uMetricVal(p, metric);
    const totalH = chartH * (shownTotal / max);
    const clipId = `${clipPrefix}-bar-${i}`;
    const clip = mkSvgEl(doc, 'clipPath', { id: clipId });
    clip.appendChild(mkSvgEl(doc, 'rect', {
      x: bx,
      y: CHART_H - PAD_B - totalH,
      width: bw,
      height: Math.max(0.6, totalH),
      rx: Math.min(4, bw / 2, Math.max(0.3, totalH / 2)),
    }));
    defs.appendChild(clip);
    const stack = mkSvgEl(doc, 'g', { 'clip-path': `url(#${clipId})` });
    let acc = 0;
    for (const comp of order) {
      const v = compVal(p, comp, metric);
      if (v <= 0) continue;
      const cid = compId(comp);
      const segH = chartH * (v / max);
      const y = CHART_H - PAD_B - acc - segH;
      const at: Record<string, string | number> = {
        x: bx, y, width: bw, height: Math.max(0.6, segH),
        fill: colorOf[cid] ?? '', class: 'bseg', 'data-i': i,
      };
      if (stacked) at['data-cid'] = cid;
      if (sep) {
        at.stroke = 'var(--sheet)';
        at['stroke-opacity'] = 0.55;
        at['stroke-width'] = 0.5;
      }
      stack.appendChild(mkSvgEl(doc, 'rect', at));
      acc += segH;
    }
    g.appendChild(stack);
    svg.appendChild(g);
    if (i % stride === 0) {
      svg.appendChild(mkSvgEl(doc, 'text', {
        x: bx + bw / 2, y: CHART_H - PAD_B + 14, 'text-anchor': 'middle', class: 'glabel',
      }, bucketLabel(p.bucket, unit)));
    }
  });

  const tipHtmlFor = (i: number, curId: string | null): string =>
    uTipHtml(d, series[i]!, order, colorOf, { metric, stacked, cur, unit, curId });
  // 监听挂在这棵刚造出来的 svg 上：整棵树下次重画时被丢弃，监听随之消失。
  // 点按与悬停同一处理:触屏没有悬停,点一下柱子即显示明细,点空白处收起。
  const point = (ev: Event): void => {
    const t = ev.target as Element | null;
    const cl = t?.classList;
    if (stacked && cl?.contains('bseg')) {
      const i = Number(t!.getAttribute('data-i'));
      const cid = t!.getAttribute('data-cid') || '';
      tip.setHi(t!);
      tip.show(tipHtmlFor(i, cid), `${i}|${cid}`);
      tip.move(ev as MouseEvent);
    } else if (cl && (cl.contains('bhit') || cl.contains('bseg'))) {
      const i = Number(t!.getAttribute('data-i'));
      tip.clearHi();
      tip.show(tipHtmlFor(i, null), `${i}|`);
      tip.move(ev as MouseEvent);
    } else {
      tip.hide();
    }
  };
  svg.addEventListener('mousemove', point);
  svg.addEventListener('click', point);
  svg.addEventListener('mouseleave', () => tip.hide());
  box.appendChild(svg);
}
