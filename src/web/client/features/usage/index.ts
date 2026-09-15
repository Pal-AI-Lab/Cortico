/**
 * 用量与成本页读取跨重启保留的调用流水，按时段与范围统计 token、成本和请求次数，按各角色实际模型计价。
 * 状态属于本次 mount；定时器使用 lifecycle.interval，监听绑定 signal，tooltip 挂在本页 root。领域图表由 chart.ts 提供。
 */

import type { ConsoleUi, Disposable } from '../../../shared/client-panel.ts';
import { get } from '../../core/api.ts';
import { consoleFormat } from '../../ui/format.ts';
import { pageIntro } from '../../ui/page.ts';
import { getThemeStudio } from '../../theme/studio.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { bucketLabel, renderChart } from './chart.ts';
import { U_TYPES, themeColorResolver } from './labels.ts';
import { localDate, usageQuery, usageRange } from './range.ts';
import { createUsageState } from './state.ts';
import { S } from './strings.ts';
import { createUsageTip } from './tooltip.ts';
import type { UsageAccum, UsageAggregate, UsageBucketOption, UsageGroupStat, UsageMetric } from './types.ts';

/** 自动刷新的周期。 */
const LIVE_MS = 15_000;
/** 窗口尺寸变化后延迟重画图表，合并连续 resize 事件。 */
const RESIZE_DEBOUNCE_MS = 80;

const BUCKETS: ReadonlyArray<{ value: UsageBucketOption; label: string }> = [
  { value: 'auto', label: S.bucketAuto },
  { value: 'minute', label: S.bucketMinute },
  { value: 'hour', label: S.bucketHour },
  { value: 'day', label: S.bucketDay },
  { value: 'week', label: S.bucketWeek },
  { value: 'month', label: S.bucketMonth },
];

const PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '1', label: S.presetToday },
  { value: '3', label: S.preset3 },
  { value: '7', label: S.preset7 },
  { value: '30', label: S.preset30 },
  { value: '90', label: S.preset90 },
  { value: '0', label: S.presetCustom },
];

const METRICS: ReadonlyArray<{ value: UsageMetric; label: string }> = [
  { value: 'cost', label: S.metricCost },
  { value: 'tokens', label: 'token' },
];

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** abort 不是失败，是"这一页已经不在了"。 */
function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/** 一行工具条（`.usagebar`）。与 `ui.rowbar()` 的差别只在版式，这一页有自己的一套。 */
function usagebar(ui: ConsoleUi): HTMLDivElement {
  return ui.h('div', 'usagebar');
}

export function mountUsage(ctx: FeatureContext): void {
  const { ui, root, lifecycle } = ctx;
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const state = createUsageState();
  const color = themeColorResolver(doc);
  const tip = lifecycle.own(createUsageTip(doc, root));
  const intro = pageIntro(ui, S.pageTitle);

  // ---- 工具条 ---------------------------------------------------------------
  const bar1 = usagebar(ui);
  const presets = ui.segmented(PRESETS, {
    value: String(state.days),
    onSelect: (v) => {
      state.days = Number(v);
      customRange.classList.toggle('hidden', state.days !== 0);
      if (state.days === 0) {
        if (!state.from) state.from = localDate(6);
        if (!state.to) state.to = localDate(0);
        fromInput.value = state.from;
        toInput.value = state.to;
      }
      void load();
    },
  });
  const fromInput = ui.input({
    type: 'date',
    onChange: (v) => { state.from = v; if (state.days === 0) void load(); },
  });
  const toInput = ui.input({
    type: 'date',
    onChange: (v) => { state.to = v; if (state.days === 0) void load(); },
  });
  const customRange = ui.h('span', 'urange hidden');
  customRange.append(fromInput, ui.h('span', null, ' — '), toInput);
  const liveBox = ui.checkbox(S.liveRefresh, {
    title: S.liveRefreshTitle(LIVE_MS / 1000),
    onChange: (on) => setLive(on),
  });
  const refreshBtn = ui.button(S.refresh, { size: 'sm', onClick: () => void load() });
  bar1.append(presets.el, customRange, ui.h('span', 'grow'), liveBox.el, refreshBtn);

  const bar2 = usagebar(ui);
  const bucketSeg = ui.segmented(BUCKETS, {
    size: 'sm',
    value: state.bucket,
    onSelect: (v) => { state.bucket = v as UsageBucketOption; void load(); },
  });
  const bkHint = ui.h('span', 'ubkhint');
  const rangeHint = ui.h('span', 'urangehint');
  bar2.append(ui.h('span', 'ulabel', S.granularity), bucketSeg.el, bkHint, ui.h('span', 'grow'), rangeHint);
  let basis = 'marginal';
  let currency = '';
  const currencySelect = ui.select({ options: [{value:'',label:S.autoCurrency}], onChange: value => { currency = value; void load(); } });
  const basisSelect = ui.select({ options: [{value:'marginal',label:S.basisMarginal},{value:'equivalent',label:S.basisEquivalent}], onChange: value => { basis = value; void load(); } });
  bar2.append(ui.h('span', 'ulabel', S.ledger), basisSelect, currencySelect);
  const billingHint = ui.h('p', 'muted');
  const controls = ui.h('div', 'usagecontrols');
  controls.append(bar1, bar2, billingHint);

  // ---- 概览读数 -------------------------------------------------------------
  const cards = ui.statgrid();
  cards.classList.add('usagecards');

  // ---- 成本构成 -------------------------------------------------------------
  const compSheet = ui.sheet({ title: S.compTitle });
  const compBox = ui.h('div');
  compBox.id = 'u-comp';
  compSheet.body.appendChild(compBox);

  // ---- 主图 -----------------------------------------------------------------
  const mainSheet = ui.sheet({
    title: S.mainTitle,
    en: 'time series',
    desc: S.mainDesc,
  });
  const mainCtrls = ui.rowbar();
  const metricSeg = ui.segmented(METRICS, {
    size: 'sm',
    value: state.metric,
    onSelect: (v) => { state.metric = v as UsageMetric; renderMain(); },
  });
  mainCtrls.append(metricSeg.el, ui.h('span', 'ulabel', S.split));
  for (const [dim, label] of [['type', S.dimType], ['role', S.dimRole], ['model', S.dimModel]] as const) {
    mainCtrls.appendChild(ui.checkbox(label, {
      onChange: (on) => { state.splitDims[dim] = on; renderMain(); },
    }).el);
  }
  mainCtrls.appendChild(ui.h('span', 'grow'));
  mainCtrls.appendChild(ui.checkbox(S.sortByShare, {
    title: S.sortByShareTitle,
    onChange: (on) => { state.sortByShare = on; renderMain(); },
  }).el);
  const mainLegend = ui.h('div', 'chart-legend');
  const mainBox = ui.h('div');
  mainBox.id = 'usagechart';
  mainSheet.body.append(mainCtrls, mainLegend, mainBox);

  // ---- 调用图 ---------------------------------------------------------------
  const callSheet = ui.sheet({ title: S.callTitle, en: 'requests' });
  const callCtrls = ui.rowbar();
  callCtrls.appendChild(ui.h('span', 'ulabel', S.split));
  for (const [dim, label] of [['role', S.dimRole], ['model', S.dimModel]] as const) {
    callCtrls.appendChild(ui.checkbox(label, {
      onChange: (on) => { state.callDims[dim] = on; renderCalls(); },
    }).el);
  }
  callCtrls.appendChild(ui.h('span', 'grow'));
  callCtrls.appendChild(ui.checkbox(S.sortByShare, {
    title: S.sortByShareTitle,
    onChange: (on) => { state.callSortByShare = on; renderCalls(); },
  }).el);
  const callLegend = ui.h('div', 'chart-legend');
  const callBox = ui.h('div');
  callBox.id = 'usagecalls';
  callSheet.body.append(callCtrls, callLegend, callBox);

  // ---- 两张分组表 -----------------------------------------------------------
  const GROUP_HEAD = [S.headCalls, S.headInput, S.headOutput, S.headCache, S.headCost, S.headAvg];
  const roleSheet = ui.sheet({ title: S.byRole, en: 'by role' });
  const roleTable = ui.table({ head: [S.dimRole, ...GROUP_HEAD] });
  roleSheet.body.appendChild(roleTable.el);
  const modelSheet = ui.sheet({ title: S.byModel, en: 'by model' });
  const modelTable = ui.table({ head: [S.dimModel, ...GROUP_HEAD] });
  modelSheet.body.appendChild(modelTable.el);
  const tables = ui.h('div', 'usagetables');
  tables.append(roleSheet.el, modelSheet.el);

  root.append(intro, controls, cards, compSheet.el, mainSheet.el, callSheet.el, tables);

  // ---- 渲染 -----------------------------------------------------------------

  function renderMain(): void {
    if (!state.data) return;
    renderChart(
      { doc, ui, box: mainBox, legend: mainLegend, tip, color },
      state.data,
      { metric: state.metric, dims: state.splitDims, allowType: true, sort: state.sortByShare },
    );
  }

  function renderCalls(): void {
    if (!state.data) return;
    renderChart(
      { doc, ui, box: callBox, legend: callLegend, tip, color },
      state.data,
      { metric: 'calls', dims: state.callDims, allowType: false, sort: state.callSortByShare },
    );
  }

  function renderCards(d: UsageAggregate): void {
    const cur = d.currency || 'USD';
    const t: Partial<UsageGroupStat> = d.totals || {};
    const series = d.series || [];
    const calls = t.calls || 0;
    // 空范围整排清零的读数读起来像坏了;一句话说清"没数据"和"数据坏了"的分别。
    if (calls === 0) {
      cards.replaceChildren(ui.placeholder(S.noCalls));
      return;
    }
    const totTok = (t.promptTokens || 0) + (t.completionTokens || 0);
    const successful = d.successful ?? t;
    const avgCost = successful.calls ? (successful.cost || 0) / successful.calls : 0;
    const avgTok = calls ? totTok / calls : 0;
    const rShare = (t.completionTokens || 0) > 0
      ? (t.reasoningTokens || 0) / (t.completionTokens || 1)
      : null;
    let peak: (typeof series)[number] | null = null;
    for (const p of series) if (!peak || (p.cost || 0) > (peak.cost || 0)) peak = p;

    cards.replaceChildren();
    const items: Parameters<typeof ui.stat>[0][] = [
      { k: S.cardKnownCost, v: (t.pricedCalls || 0) === 0 && !t.cost && (t.unpricedCalls || 0) > 0 ? S.unknown : consoleFormat.money(t.cost, cur), accent: true },
      { k: S.cardCalls, v: calls.toLocaleString() },
      { k: S.cardAvgCost, v: consoleFormat.money(avgCost, cur), unit: S.approxTok(consoleFormat.count(Math.round(avgTok))) },
      { k: S.cardInput, v: consoleFormat.count(t.promptTokens || 0), unit: S.hitRate(consoleFormat.percent(t.cacheHitRate)) },
      { k: S.cardOutput, v: consoleFormat.count(t.completionTokens || 0), unit: S.reasoningShare(consoleFormat.percent(rShare)) },
      { k: S.cardCacheRate, v: consoleFormat.percent(t.cacheHitRate) },
      { k: S.cardCoverage, v: `${t.pricedCalls || 0} / ${calls}`, unit: S.unpriced(t.unpricedCalls || 0) },
      { k: S.cardPeak, v: peak ? consoleFormat.money(peak.cost, cur) : '—', unit: peak ? bucketLabel(peak.bucket, d.bucket || 'day') : '' },
    ];
    // 失败消耗是总消耗的子集。
    const f: Partial<UsageAccum> = d.failed || {};
    if ((f.calls || 0) > 0) {
      items.push({
        k: S.cardFailed, v: S.failedCalls((f.calls || 0).toLocaleString()),
        unit: S.burned(consoleFormat.count((f.promptTokens || 0) + (f.completionTokens || 0))),
      });
    }
    for (const item of items) cards.appendChild(ui.stat(item));
  }

  function renderComposition(d: UsageAggregate): void {
    compBox.replaceChildren();
    const cur = d.currency || 'USD';
    const t: Partial<UsageGroupStat> = d.totals || {};
    const total = t.cost || 0;
    if (!(total > 0)) {
      compBox.appendChild(ui.placeholder(S.noCostData));
      return;
    }
    const parts = [
      { label: S.partCacheHit, val: t.costCacheHit || 0, color: color(U_TYPES[0]!.color) },
      { label: S.partCacheMiss, val: t.costCacheMiss || 0, color: color(U_TYPES[1]!.color) },
      { label: S.partOutput, val: t.costOutput || 0, color: color(U_TYPES[2]!.color) },
    ];
    if (t.costOther) parts.push({ label: S.partOther, val: t.costOther, color: color('chart-4') });
    const bar = ui.h('div', 'compbar');
    for (const p of parts) {
      const seg = ui.h('div', 'compseg');
      seg.style.width = (p.val / total) * 100 + '%';
      seg.style.background = p.color;
      seg.title = `${p.label} ${consoleFormat.money(p.val, cur)}`;
      bar.appendChild(seg);
    }
    const leg = ui.h('div', 'compleg');
    for (const p of parts) {
      const it = ui.h('div', 'compitem');
      const sw = ui.h('span', 'compsw');
      sw.style.background = p.color;
      it.append(
        sw,
        ui.h('span', null, p.label),
        ui.h('span', 'compamt', consoleFormat.money(p.val, cur)),
        ui.h('span', 'comppct', `(${consoleFormat.percent(p.val / total)})`),
      );
      leg.appendChild(it);
    }
    compBox.append(bar, leg);
  }

  /**
   * 首列印的是**声明方给的名字**，给不出就印 id 原文。角色 id 由Persona定义、
   * 模型名由供应商定义，控制台两边都不认识，也就不为任何一边备一张翻译表。
   */
  function renderGroup(
    table: ReturnType<ConsoleUi['table']>,
    groups: readonly UsageGroupStat[],
    cur: string,
  ): void {
    table.clear(groups.length ? undefined : S.noData);
    if (!groups.length) return;
    for (const g of groups) {
      const avg = g.calls ? (g.cost || 0) / g.calls : 0;
      table.addRow([
        g.label || g.key,
        { text: g.calls || 0, cls: 'mono' },
        { text: consoleFormat.count(g.promptTokens), cls: 'mono' },
        { text: consoleFormat.count(g.completionTokens), cls: 'mono' },
        { text: consoleFormat.percent(g.cacheHitRate), cls: 'mono' },
        { text: consoleFormat.money(g.cost, cur), cls: 'mono' },
        { text: consoleFormat.money(avg, cur), cls: 'mono' },
      ]);
    }
  }

  function renderHints(d: UsageAggregate): void {
    const unit = d.bucket || 'day';
    bkHint.textContent = state.bucket === 'auto'
      ? S.autoBucket(BUCKETS.find((b) => b.value === unit)?.label ?? unit)
      : '';
    rangeHint.textContent = S.rangeHint(d.from || '—', d.to || '—', (d.series || []).length);
  }

  function renderAll(d: UsageAggregate): void {
    const currencies = [...new Set((d.balances ?? []).filter(balance => balance.basis === basis).map(balance => balance.currency))];
    currencySelect.replaceChildren(...['', ...currencies].map(value => {
      const option = doc.createElement('option');
      option.value = value;
      option.textContent = value || S.autoCurrency;
      return option;
    }));
    currencySelect.value = currency;
    billingHint.textContent = S.billingHint +
      (d.totals?.unknownUsageCalls ? S.unknownUsage(d.totals.unknownUsageCalls) : '');
    if (d.ledger?.error) billingHint.textContent += S.ledgerError(d.ledger.pending, d.ledger.error);
    renderCards(d);
    renderComposition(d);
    renderMain();
    renderCalls();
    renderGroup(roleTable, d.byRole || [], d.currency || 'USD');
    renderGroup(modelTable, d.byModel || [], d.currency || 'USD');
    renderHints(d);
  }

  // ---- 取数 -----------------------------------------------------------------

  async function load(): Promise<void> {
    const range = usageRange(state.days, { from: state.from, to: state.to });
    try {
      const d = await get<UsageAggregate>(
        `/api/usage?${usageQuery(state.bucket, range)}&basis=${basis}&currency=${encodeURIComponent(currency)}`,
        { signal: ctx.signal },
      );
      if (ctx.signal.aborted) return;
      state.data = d;
      renderAll(d);
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      cards.replaceChildren(ui.placeholder(S.loadFailed(errText(err))));
    }
  }

  // ---- 自动刷新 -------------------------------------------------------------

  let liveTimer: Disposable | null = null;
  function setLive(on: boolean): void {
    liveTimer?.dispose();
    liveTimer = on ? lifecycle.interval(() => void load(), LIVE_MS) : null;
  }

  // ---- 重画触发：主题换色 / 改窗宽 -------------------------------------------
  // 两者都只重画，不重取：数据没变，变的是画布与配色。

  /** 配色变了。图上的颜色是从 CSS 变量现读的，所以只能整张重画。 */
  function repaint(): void {
    tip.hide();
    if (!state.data) return;
    renderMain();
    renderCalls();
    renderComposition(state.data);
  }

  lifecycle.own(getThemeStudio({ doc }).onChange(() => repaint()));

  if (win) {
    let pending: Disposable | null = null;
    win.addEventListener('resize', () => {
      if (!state.data) return;
      pending?.dispose();
      pending = lifecycle.timeout(() => { renderMain(); renderCalls(); }, RESIZE_DEBOUNCE_MS);
    }, { signal: ctx.signal });
  }

  cards.appendChild(ui.placeholder(S.loading));
  void load();
}

export const usageFeature: FrameworkFeature = {
  route: 'usage',
  label: S.navLabel,
  icon: 'chart',
  navGroup: S.navGroup,
  needsAny: ['usage'],
  mount: mountUsage,
};
