/**
 * 用量页的堆叠柱图，包含 byRoleModel 与 byWorld 寻址、成本档位、类型→角色/World→模型层级和「其他」合并，归用量 feature 所有。
 * 组合、取值、配色、格式化和桶标签均为独立导出的纯函数；renderChart 仅操作自身创建的 SVG。
 */

import type { WebUi } from '../../../shared/client-panel.ts';
import { webUiFormat } from '../../ui/format.ts';
import { esc } from '../../ui/dom.ts';
import { clampNumber, hexToHsl, hslCss } from '../../theme/palette.ts';
import { U_PALETTE, U_TYPES } from './labels.ts';
import { S } from './strings.ts';
import type {
  ColorResolver,
  UsageAccum,
  UsageAggregate,
  UsageBucketUnit,
  UsageCompPart,
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

/** World 维里未归属一格的键;World id 不会是空串。 */
export const UNATTRIBUTED_KEY = '';

function isUnattributed(part: UsageCompPart): boolean {
  return part.dim === 'world' && part.key === UNATTRIBUTED_KEY;
}
/** 「其他」一格的键，取 U+241E,键里不会出现。 */
export const FOLD_KEY = '␞';

/** 某个维度在这份数据里的分组表,World 维末尾是未归属。`type` 不是分组，走 `U_TYPES`。 */
function dimGroups(d: UsageAggregate, dim: UsageDim): readonly UsageGroupStat[] {
  if (dim === 'role') return d.byRole || [];
  if (dim === 'model') return d.byModel || [];
  if (dim !== 'world') return [];
  const rest = d.unattributed ? [{ ...d.unattributed, key: UNATTRIBUTED_KEY, label: S.unattributed }] : [];
  return [...(d.byWorld || []), ...rest];
}

/**
 * 一个维度在图上分成的各格。类型按 `U_TYPES`;其余按范围内的读数降序，键数超过调色板的颜色数时，前面比颜色数少一个的
 * 键各占一格，其余(至少两个)合成「其他」一格。未归属单独一格。「其他」与未归属用中性色，不占调色板。范围内读数为 0 的
 * 键不出现。
 */
export function dimParts(d: UsageAggregate, dim: UsageDim, metric: UsageMetric): UsageCompPart[] {
  if (dim === 'type') {
    return U_TYPES
      .filter(t => t.key !== 'other' || (d.totals?.costOther || 0) > 0 || (d.totals?.unclassifiedInputTokens || 0) > 0)
      .map(t => ({ dim, key: t.key }));
  }
  const groups = dimGroups(d, dim).filter(g => uMetricVal(g, metric) > 0);
  const residue = groups.filter(g => isUnattributed({ dim, key: g.key }));
  const ranked = groups
    .filter(g => !residue.includes(g))
    .sort((a, b) => uMetricVal(b, metric) - uMetricVal(a, metric) || (a.key < b.key ? -1 : 1));
  const seats = U_PALETTE.length;
  const kept = ranked.length > seats ? ranked.slice(0, seats - 1) : ranked;
  const parts: UsageCompPart[] = kept.map(g => ({ dim, key: g.key }));
  if (ranked.length > seats) parts.push({ dim, key: FOLD_KEY, keys: ranked.slice(seats - 1).map(g => g.key) });
  for (const g of residue) parts.push({ dim, key: g.key });
  return parts;
}

/** 显示 UsageGroupStat.label；缺少 label 时显示原 id。 */
export function dimKeyLabel(d: UsageAggregate, dim: UsageDim, key: string): string {
  if (dim === 'type') return U_TYPES.find((t) => t.key === key)?.label ?? key;
  return dimGroups(d, dim).find((g) => g.key === key)?.label || key;
}

function partLabel(d: UsageAggregate, part: UsageCompPart): string {
  return part.keys ? S.foldLabel(part.keys.length) : dimKeyLabel(d, part.dim, part.key);
}

/** FNV-1a,给键挑首选色位。 */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * 给一组键分配调色板颜色：键按字典序依次取哈希选出的色位，色位已被占用就取下一个。键数不超过调色板时颜色各不相同；
 * 增减一个键时，只有字典序在它之后、因色位被占而顺延的键会换色。
 */
export function paletteSeats(keys: readonly string[]): Map<string, string> {
  const taken = new Set<number>();
  const out = new Map<string, string>();
  for (const key of [...new Set(keys)].sort()) {
    let i = hashKey(key) % U_PALETTE.length;
    for (let tries = 0; taken.has(i) && tries < U_PALETTE.length; tries++) i = (i + 1) % U_PALETTE.length;
    taken.add(i);
    out.set(key, U_PALETTE[i]!);
  }
  return out;
}

/** 这一格是否占调色板的颜色：类型有固定色，「其他」与未归属用中性色。 */
function seated(part: UsageCompPart): boolean {
  return part.dim !== 'type' && !part.keys && !isUnattributed(part);
}

/** 一格的基色:`seats` 是 `paletteSeats` 给占调色板的各格分好的颜色。 */
function partBaseColor(part: UsageCompPart, seats: ReadonlyMap<string, string>, color: ColorResolver): string {
  if (part.dim === 'type') return color(U_TYPES.find((t) => t.key === part.key)?.color ?? U_PALETTE[0]);
  if (part.keys) return color('ink-dim');
  if (isUnattributed(part)) return color('line-strong');
  return color(seats.get(part.key) ?? U_PALETTE[0]);
}

/**
 * 勾选状态 → 有序维度列表，顺序即嵌套序：类型 > 角色 > World > 模型。调用次数没有类型分量；一次请求的次数会记给
 * 它分到份额的每个 World,叠起来超过合计，所以也不按 World 拆。
 */
export function activeDims(dims: UsageDimFlags, metric: UsageMetric): UsageDim[] {
  const calls = metric === 'calls';
  const out: UsageDim[] = [];
  if (!calls && dims.type) out.push('type');
  if (dims.role) out.push('role');
  if (!calls && dims.world) out.push('world');
  if (dims.model) out.push('model');
  return out;
}

/** 各维度各格的笛卡尔积。无维度 → `[[]]`（一根合计柱），不是 `[]`。 */
export function buildComposites(d: UsageAggregate, dimsList: readonly UsageDim[], metric: UsageMetric): UsageComposite[] {
  let combos: UsageComposite[] = [[]];
  for (const dim of dimsList) {
    const parts = dimParts(d, dim, metric);
    const nx: UsageComposite[] = [];
    for (const c of combos) for (const part of parts) nx.push(c.concat([part]));
    combos = nx;
  }
  return combos;
}

/** 把含「其他」的组合展开成它合并的各键的组合。 */
export function expandComposite(comp: UsageComposite): UsageComposite[] {
  let out: UsageComposite[] = [[]];
  for (const part of comp) {
    const keys = part.keys ?? [part.key];
    out = out.flatMap((c) => keys.map((key) => c.concat([{ dim: part.dim, key }])));
  }
  return out;
}

/** 组合的稳定 id。分隔符取 U+241F（单元分隔符的可见形），键里不会出现。 */
export function compId(comp: UsageComposite): string {
  return comp.map((c) => c.dim + ':' + c.key).join('␟');
}

/** 组合的显示名。要 `d` 是因为角色/模型的人话名只能从数据里取（见 `dimKeyLabel`）。 */
export function compLabel(d: UsageAggregate, comp: UsageComposite): string {
  return comp.length ? comp.map((c) => partLabel(d, c)).join(' · ') : S.total;
}

/**
 * 组合 → 桶里对应的那个累计单元。
 *
 * "类型"不参与寻址（它是同一个 accum 内部的分量），所以只看 World / role / model：World 或 role 与 model 同在时
 * 走对应的交叉表，只有一维走单维表，都没有就是整个桶。未归属走 unattributed 与 unattributedByModel。组合里不能有「其他」,先用
 * `expandComposite` 展开。
 */
export function compScopeAccum(p: UsagePoint, comp: UsageComposite): UsageAccum | undefined {
  const world = comp.find((c) => c.dim === 'world');
  const role = comp.find((c) => c.dim === 'role');
  const model = comp.find((c) => c.dim === 'model');
  if (world && model) return isUnattributed(world) ? p.unattributedByModel?.[model.key] : p.byWorldModel?.[world.key]?.[model.key];
  if (world) return isUnattributed(world) ? p.unattributed : (p.byWorld || {})[world.key];
  if (role && model) return (p.byRoleModel || {})[role.key]?.[model.key];
  if (role) return (p.byRole || {})[role.key];
  if (model) return (p.byModel || {})[model.key];
  return p;
}

export function compVal(p: UsagePoint, comp: UsageComposite, metric: UsageMetric): number {
  if (comp.some((c) => c.keys)) return expandComposite(comp).reduce((sum, c) => sum + compVal(p, c, metric), 0);
  const acc = compScopeAccum(p, comp);
  if (!acc) return 0;
  const type = comp.find((c) => c.dim === 'type');
  return type ? uTypeVal(acc, type.key as UsageTypeKey, metric) : uMetricVal(acc, metric);
}

/** 最外层维度决定色系，同色系按位次调整明度；排序不改色。 */
export function compositeColors(
  composites: readonly UsageComposite[],
  dimsList: readonly UsageDim[],
  color: ColorResolver,
): Record<string, string> {
  const colorOf: Record<string, string> = {};
  if (!dimsList.length) {
    colorOf[compId([])] = 'var(--accent-2)';
    return colorOf;
  }
  const seats = paletteSeats(composites.map((comp) => comp[0]!).filter(seated).map((part) => part.key));
  const fam = new Map<string, UsageComposite[]>();
  for (const comp of composites) {
    const fk = comp[0]!.key;
    if (!fam.has(fk)) fam.set(fk, []);
    fam.get(fk)!.push(comp);
  }
  for (const members of fam.values()) {
    const base = partBaseColor(members[0]![0]!, seats, color);
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
  if (metric === 'cost') return webUiFormat.money(v, cur);
  if (metric === 'calls') return Math.round(v).toLocaleString() + S.callsUnit;
  return webUiFormat.count(Math.round(v)) + ' tok';
}

/** 纵轴刻度：比读数短一截，不带单位。 */
export function fmtAxis(v: number, metric: UsageMetric): string {
  if (metric === 'cost') return v.toFixed(2);
  if (metric === 'calls') return String(Math.round(v));
  return webUiFormat.count(Math.round(v));
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
    // 「其他」一行下面逐个列出它合并的键，与普通行共用行数上限。
    rows: for (const comp of order) {
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
      if (!comp.some((c) => c.keys)) continue;
      const members = expandComposite(comp)
        .map((m) => ({ m, v: compVal(p, m, o.metric) }))
        .filter((x) => x.v > 0)
        .sort((a, b) => b.v - a.v);
      for (const { m, v: mv } of members) {
        if (shown++ >= TIP_ROWS_MAX) {
          s += `<div class="tt-extra">${S.restOmitted}</div>`;
          break rows;
        }
        s += `<div class="tt-row tt-sub"><span></span><span class="tt-l">${esc(compLabel(d, m))}</span>`
          + `<span class="tt-v">${fmtMetric(mv, o.metric, o.cur)} · ${pctOf(mv)}%</span></div>`;
      }
    }
  }
  s += `<div class="tt-extra">${S.tipFoot(
    p.calls || 0,
    webUiFormat.percent(cacheRateOf(p)),
    webUiFormat.count(p.reasoningTokens || 0),
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
  ui: WebUi;
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
  /** 按占比降序统一堆叠；关掉则按 `activeDims` 的嵌套序。 */
  sort?: boolean;
}

const PAD_L = 52;
const PAD_R = 8;
const PAD_B = 26;
const PAD_T = 12;
const CHART_H = 240;
/** 每个横轴刻度标签至少占的宽度，按 stride 抽稀。 */
const XLABEL_W = 72;

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

  let dimsList = activeDims(opts.dims, metric);
  let composites = buildComposites(d, dimsList, metric);
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
  const colorOf = compositeColors(composites, dimsList, color);
  const order = (stacked && opts.sort)
    ? composites.slice().sort((a, b) => (tot[compId(b)] || 0) - (tot[compId(a)] || 0))
    : composites;

  if (stacked) {
    for (const comp of order) {
      const it = ui.h('span', 'legitem');
      const sw = ui.h('span', 'legsw');
      sw.style.background = colorOf[compId(comp)] ?? '';
      it.append(sw, ui.h('span', 'leglbl', compLabel(d, comp)));
      if (comp.some((c) => c.keys)) it.title = expandComposite(comp).map((c) => compLabel(d, c)).join('\n');
      legend.appendChild(it);
    }
  }

  // 画布与图区同宽：桶多时柱子变窄，不出现横向滚动。
  const W = Math.max(240, box.clientWidth || 700);
  const H = CHART_H;
  const chartH = H - PAD_T - PAD_B;
  const step = (W - PAD_L - PAD_R) / series.length;
  const bw = Math.max(1, Math.min(40, step * 0.6));
  let max = 0;
  for (const p of series) {
    const t = uMetricVal(p, metric);
    if (t > max) max = t;
  }
  if (!(max > 0)) max = 1;
  // Four intervals need at least one cent each to keep two-decimal labels distinct.
  if (metric === 'cost') max = Math.max(max, 0.04);

  const svg = mkSvgEl(doc, 'svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  const defs = mkSvgEl(doc, 'defs', {});
  svg.appendChild(defs);
  const clipPrefix = (box.id || 'usage-chart').replace(/[^a-zA-Z0-9_-]/g, '-');
  for (let i = 0; i <= 4; i++) {
    const y = PAD_T + chartH * (1 - i / 4);
    svg.appendChild(mkSvgEl(doc, 'line', {
      x1: PAD_L, y1: y, x2: W - PAD_R, y2: y, class: 'axis', opacity: i === 0 ? 0.9 : 0.35,
    }));
    svg.appendChild(mkSvgEl(doc, 'text', {
      x: PAD_L - 6, y: y + 3, 'text-anchor': 'end', class: 'vlabel',
    }, fmtAxis((max * i) / 4, metric)));
  }

  const sep = stacked && order.length > 1;
  const stride = Math.max(1, Math.ceil(series.length / Math.max(1, Math.floor((W - PAD_L - PAD_R) / XLABEL_W))));
  series.forEach((p, i) => {
    const cx = PAD_L + i * step;                       // 列起点
    const bx = cx + (step - bw) / 2;                   // 柱体居中
    const g = mkSvgEl(doc, 'g', { class: 'barg' });
    // 全宽透明感应块：整列都归这个桶，相邻列平铺无缝隙，移动不断档
    g.appendChild(mkSvgEl(doc, 'rect', {
      x: cx, y: PAD_T, width: step, height: chartH,
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
      y: H - PAD_B - totalH,
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
      const y = H - PAD_B - acc - segH;
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
        x: bx + bw / 2, y: H - PAD_B + 16, 'text-anchor': 'middle', class: 'glabel',
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
