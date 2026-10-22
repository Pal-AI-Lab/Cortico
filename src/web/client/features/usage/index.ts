/**
 * 用量与成本页读取跨重启保留的调用流水，按时段与范围统计 token、成本和请求次数，按各角色实际模型计价。
 * 页头下方的时间范围作用于整页；其下分为总览、Token 活跃度、用量时间序列与分组明细四节。
 * 状态属于本次 mount；定时器使用 lifecycle.interval，监听绑定 signal，tooltip 挂在本页 root。
 * 柱图由 chart.ts 提供，活跃度格子图由 activity.ts 提供。
 */

import type { WebUi, WebUiSheet, Disposable } from '../../../shared/client-panel.ts';
import { get, setConfig } from '../../core/api.ts';
import { esc } from '../../ui/dom.ts';
import { webUiFormat } from '../../ui/format.ts';
import { getThemeStudio } from '../../theme/studio.ts';
import { pageIntro } from '../../ui/page.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { ACTIVITY_CONTEXT_DAYS, renderActivity } from './activity.ts';
import { bucketLabel, renderChart } from './chart.ts';
import { U_TYPES, themeColorResolver } from './labels.ts';
import { usageQuery } from './range.ts';
import { createUsageState } from './state.ts';
import { S } from './strings.ts';
import { createUsageTip } from './tooltip.ts';
import type { UsageAccum, UsageAggregate, UsageBucketOption, UsageDailyTokens, UsageDim, UsageGroupStat, UsageMetric } from './types.ts';

/** 自动刷新的周期。 */
const LIVE_MS = 15_000;
/** 图区变宽变窄后延迟重画图表，合并连续的尺寸变化。 */
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
  { value: 'tokens', label: 'Token' },
  { value: 'calls', label: S.cardCalls },
];

const SPLITS: ReadonlyArray<{ dim: UsageDim; label: string }> = [
  { dim: 'type', label: S.dimType },
  { dim: 'role', label: S.dimRole },
  { dim: 'model', label: S.dimModel },
];

/** 已知金额。全部未计价为「未知」;部分未计价时金额是下限,后缀标出。 */
function costText(amount: number, a: Partial<UsageAccum>, cur: string): string {
  const unpriced = a.unpricedCalls || 0;
  if (unpriced > 0 && !(a.pricedCalls || 0) && !amount) return S.unknown;
  return webUiFormat.money(amount, cur) + (unpriced > 0 ? S.partialMark : '');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** abort 不是失败，是"这一页已经不在了"。 */
function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/** 节标题右侧放这一节的切换控件。 */
function headActions(ui: WebUi, sheet: WebUiSheet, ...actions: HTMLElement[]): void {
  const title = sheet.el.querySelector('h3')!;
  const head = ui.h('div', 'usec-head');
  title.replaceWith(head);
  head.append(title, ...actions);
}

/** 控件条里的一组：小标签加它管的控件。 */
function group(ui: WebUi, label: string, ...controls: HTMLElement[]): HTMLSpanElement {
  const el = ui.h('span', 'ugroup');
  el.append(ui.h('span', 'ulabel', label), ...controls);
  return el;
}

export function mountUsage(ctx: FeatureContext): void {
  const { ui, root, lifecycle } = ctx;
  const doc = root.ownerDocument;
  const state = createUsageState();
  const color = themeColorResolver(doc);
  const tip = lifecycle.own(createUsageTip(doc, root));

  // ---- 页头：刷新 -----------------------------------------------------------
  const liveBox = ui.checkbox(S.liveRefresh, {
    title: S.liveRefreshTitle(LIVE_MS / 1000),
    onChange: (on) => setLive(on),
  });
  const refreshBtn = ui.button(S.refresh, { size: 'sm', onClick: () => void load() });
  const intro = pageIntro(ui, S.pageTitle);
  const introActs = ui.h('div', 'uintroacts');
  introActs.append(liveBox.el, refreshBtn);
  intro.appendChild(introActs);

  // ---- 时间范围：页头第二行，随页头吸顶 --------------------------------------
  // 日期框一直在：预设档显示它算出的范围，改日期即切到自定义档，切换时这一行不变形。
  const presets = ui.segmented(PRESETS, {
    size: 'sm',
    value: String(state.days),
    onSelect: (v) => {
      state.days = Number(v);
      if (state.days === 0) {
        state.from = fromInput.value;
        state.to = toInput.value;
      }
      void load();
    },
  });
  presets.el.classList.add('uswitch');
  const pickDate = (): void => {
    state.days = 0;
    state.from = fromInput.value;
    state.to = toInput.value;
    presets.setValue('0');
    void load();
  };
  const fromInput = ui.input({ type: 'date', onChange: pickDate });
  const toInput = ui.input({ type: 'date', onChange: pickDate });
  // 统计按部署时区分日，这里只显示，与日期框同样式。
  const timezone = ui.input({ type: 'text' });
  timezone.readOnly = true;
  timezone.tabIndex = -1;
  timezone.classList.add('utz');
  const dates = ui.h('span', 'udates');
  dates.append(fromInput, ui.h('span', 'ulabel', '—'), toInput, timezone);
  /** 取数失败、账目存储异常与汇率保存失败；没有时整行不占位。 */
  const notice = ui.msgline('', true);
  notice.classList.add('unotice');
  const rangeBar = ui.h('div', 'urangebar');
  rangeBar.append(presets.el, dates);
  intro.append(rangeBar, notice);

  // ---- 总览：读数、成本构成与计费口径 -----------------------------------------
  const overview = ui.sheet({ title: S.sectionOverview });
  let basis = 'marginal';
  let currency = '';
  const currencySelect = ui.select({ options: [{value:'',label:S.autoCurrency}], onChange: value => { currency = value; void load(); } });
  const basisSelect = ui.select({ options: [{value:'marginal',label:S.basisMarginal},{value:'equivalent',label:S.basisEquivalent}], onChange: value => { basis = value; void load(); } });
  basisSelect.setAttribute('aria-label', S.ledger);
  // 换算币种的汇率：写回 Core 配置
  const rateInput = ui.input({ type: 'number' });
  rateInput.min = '0';
  rateInput.step = 'any';
  rateInput.title = S.rateHint;
  rateInput.setAttribute('aria-label', S.rateHint);
  const rateCode = ui.h('span', 'ulabel');
  const rateBox = ui.h('span', 'urate');
  rateBox.append(ui.h('span', 'ulabel', '1 USD ='), rateInput, rateCode);
  rateBox.hidden = true;
  let rateNote = '';
  rateInput.addEventListener('change', () => {
    const code = rateCode.textContent ?? '';
    const value = Number(rateInput.value);
    if (!code || !(value > 0)) { rateInput.value = rateInput.dataset.saved ?? ''; return; }
    void setConfig('core', { [`usage.rates.${code}`]: value }, { signal: ctx.signal }).then(() => {
      rateInput.dataset.saved = String(value);
      rateNote = '';
      return load();
    }, (err) => {
      if (isAbort(err) || ctx.signal.aborted) return;
      rateInput.value = rateInput.dataset.saved ?? '';
      rateNote = S.rateSaveFailed(errText(err));
      renderNotes();
    });
  }, { signal: ctx.signal });
  const ledger = ui.h('span', 'uledger');
  ledger.append(ui.h('span', 'ulabel', S.ledger), basisSelect, currencySelect, rateBox);
  headActions(ui, overview, ledger);
  const cards = ui.h('div', 'ukpis');
  const compBox = ui.h('div', 'ucomp');
  const billingNote = ui.h('p', 'muted ufoot');
  overview.body.append(cards, compBox, billingNote);

  // ---- Token 活跃度 ---------------------------------------------------------
  const activity = ui.sheet({ title: S.sectionActivity });
  const activityBox = ui.h('div');
  activity.body.appendChild(activityBox);
  /** 最近一次的按天数据与它对应的页面范围；改窗宽时用它重画。 */
  let activityData: { daily: readonly UsageDailyTokens[]; from: string; to: string } | null = null;

  // ---- 用量时间序列 ---------------------------------------------------------
  const trend = ui.sheet({ title: S.mainTitle });
  const metricSeg = ui.segmented(METRICS, {
    size: 'sm',
    value: state.metric,
    onSelect: (v) => { state.metric = v as UsageMetric; renderMain(); },
  });
  metricSeg.el.classList.add('uswitch');
  headActions(ui, trend, metricSeg.el);
  const bucketSeg = ui.segmented(BUCKETS, {
    size: 'sm',
    value: state.bucket,
    onSelect: (v) => { state.bucket = v as UsageBucketOption; void load(); },
  });
  bucketSeg.el.classList.add('uswitch');
  // 拆分维度可多选：同一组按钮，按下的高亮。
  const splitWrap = ui.h('div', 'segwrap sm umulti');
  const splitBtns = SPLITS.map(({ dim, label }) => {
    const btn = ui.h('button', 'seg', label);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      state.splitDims[dim] = !state.splitDims[dim];
      btn.classList.toggle('active', !!state.splitDims[dim]);
      btn.setAttribute('aria-pressed', String(!!state.splitDims[dim]));
      renderMain();
    }, { signal: ctx.signal });
    splitWrap.appendChild(btn);
    return { dim, btn };
  });
  const sortBox = ui.checkbox(S.sortByShare, {
    title: S.sortByShareTitle,
    onChange: (on) => { state.sortByShare = on; renderMain(); },
  });
  const mainLegend = ui.h('div', 'chart-legend');
  const mainBox = ui.h('div', 'uchart');
  const mainNote = ui.h('p', 'muted unote');
  const chartCtrls = ui.h('div', 'uctrls');
  chartCtrls.append(group(ui, S.granularity, bucketSeg.el), group(ui, S.split, splitWrap, sortBox.el));
  trend.body.append(chartCtrls, mainLegend, mainBox, mainNote);

  // ---- 分组明细：同一时刻显示一张 -------------------------------------------
  const breakdown = ui.sheet({ title: S.sectionBreakdown });
  const GROUP_HEAD = [S.headCalls, S.headInput, S.headOutput, S.headCache, S.headCost, S.headAvg];
  const groupTables = {
    role: ui.table({ head: [S.dimRole, ...GROUP_HEAD] }),
    model: ui.table({ head: [S.dimModel, ...GROUP_HEAD] }),
    instance: ui.table({ head: [S.dimInstance, ...GROUP_HEAD] }),
  };
  type GroupKey = keyof typeof groupTables;
  const tableBox = ui.h('div');
  /**
   * 换成较短的表时，先按旧表高度撑住，免得页面贴底时被浏览器上拉；多出的空白滚出视口下方后再放开，
   * 那时收回它看不见。
   */
  const releaseHold = (): void => {
    const held = parseFloat(tableBox.style.minHeight);
    if (!held) return;
    const extra = held - (tableBox.firstElementChild as HTMLElement).offsetHeight;
    if (extra <= 0 || root.scrollTop + root.clientHeight <= root.scrollHeight - extra) tableBox.style.minHeight = '';
  };
  root.addEventListener('scroll', releaseHold, { passive: true, signal: ctx.signal });
  const showGroup = (key: GroupKey): void => {
    const before = tableBox.offsetHeight;
    tableBox.replaceChildren(groupTables[key].el);
    tableBox.style.minHeight = before ? `${before}px` : '';
    releaseHold();
  };
  const groupSeg = ui.segmented([
    { value: 'role', label: S.byRole },
    { value: 'model', label: S.byModel },
    { value: 'instance', label: S.byInstance },
  ], { size: 'sm', value: 'role', onSelect: (v) => showGroup(v as GroupKey) });
  groupSeg.el.classList.add('uswitch');
  headActions(ui, breakdown, groupSeg.el);
  breakdown.body.appendChild(tableBox);
  showGroup('role');

  const results = ui.h('div', 'uresults');
  results.append(overview.el, activity.el, trend.el, breakdown.el);
  root.append(intro, results);

  // ---- 渲染 -----------------------------------------------------------------

  function renderMain(): void {
    const calls = state.metric === 'calls';
    for (const { dim, btn } of splitBtns) if (dim === 'type') btn.disabled = calls;
    if (!state.data) return;
    const unpriced = state.data.totals?.unpricedCalls || 0;
    mainNote.textContent = state.metric === 'cost' && unpriced > 0 ? S.compUnpriced(unpriced) : '';
    renderChart(
      { doc, ui, box: mainBox, legend: mainLegend, tip, color },
      state.data,
      { metric: state.metric, dims: state.splitDims, allowType: !calls, sort: state.sortByShare },
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
    // 均价与平均 token 同取成功调用。
    const successful = d.successful ?? t;
    const okCalls = successful.calls || 0;
    const avgCost = okCalls ? (successful.cost || 0) / okCalls : 0;
    const avgTok = okCalls ? ((successful.promptTokens || 0) + (successful.completionTokens || 0)) / okCalls : 0;
    const rShare = (t.completionTokens || 0) > 0
      ? (t.reasoningTokens || 0) / (t.completionTokens || 1)
      : null;
    let peak: (typeof series)[number] | null = null;
    for (const p of series) if ((p.cost || 0) > 0 && (!peak || (p.cost || 0) > (peak.cost || 0))) peak = p;
    // 失败消耗是总消耗的子集。
    const f: Partial<UsageAccum> = d.failed || {};
    const failed = f.calls || 0;
    const unpriced = t.unpricedCalls || 0;

    const items: Parameters<typeof ui.stat>[0][] = [
      {
        k: S.cardKnownCost, v: costText(t.cost || 0, t, cur), accent: true,
        unit: unpriced > 0 ? S.unpriced(unpriced) : `${S.cardCoverage} ${t.pricedCalls || 0} / ${calls}`,
      },
      {
        k: S.cardCalls, v: calls.toLocaleString(),
        unit: failed > 0
          ? `${S.cardFailed} ${S.failedCalls(failed.toLocaleString())} · ${S.burned(webUiFormat.count((f.promptTokens || 0) + (f.completionTokens || 0)))}`
          : '',
      },
      { k: S.cardInput, v: webUiFormat.count(t.promptTokens || 0), unit: S.hitRate(webUiFormat.percent(t.cacheHitRate)) },
      { k: S.cardOutput, v: webUiFormat.count(t.completionTokens || 0), unit: S.reasoningShare(webUiFormat.percent(rShare)) },
      { k: S.cardAvgCost, v: okCalls ? costText(avgCost, successful, cur) : '—', unit: okCalls ? S.approxTok(webUiFormat.count(Math.round(avgTok))) : '' },
      { k: S.cardPeak, v: peak ? costText(peak.cost || 0, peak, cur) : '—', unit: peak ? bucketLabel(peak.bucket, d.bucket || 'day') : '' },
    ];
    cards.replaceChildren(...items.map((item) => {
      const el = ui.stat(item);
      // 窄窗口里副行会截断，悬停可看全文。
      if (item.unit) el.title = item.unit;
      return el;
    }));
  }

  /** 一条横条加图例；没有已知成本时整行收起，原因写在图下。 */
  function renderComposition(d: UsageAggregate): void {
    compBox.replaceChildren();
    const cur = d.currency || 'USD';
    const t: Partial<UsageGroupStat> = d.totals || {};
    const total = t.cost || 0;
    compBox.hidden = !(total > 0);
    if (compBox.hidden) return;
    const parts = [
      { label: S.partCacheHit, val: t.costCacheHit || 0, color: color(U_TYPES[0]!.color) },
      { label: S.partCacheMiss, val: t.costCacheMiss || 0, color: color(U_TYPES[1]!.color) },
      { label: S.partOutput, val: t.costOutput || 0, color: color(U_TYPES[2]!.color) },
    ];
    if (t.costOther) parts.push({ label: S.partOther, val: t.costOther, color: color('chart-4') });
    const bar = ui.h('div', 'compbar');
    const leg = ui.h('div', 'compleg');
    // 横条的一段与它的图例互相联动：悬停任一个，两者一起高亮，其余淡出。
    const focus = (seg: HTMLElement | null, it: HTMLElement | null): void => {
      compBox.classList.toggle('is-focus', !!seg);
      for (const el of compBox.querySelectorAll('.is-hi')) el.classList.remove('is-hi');
      seg?.classList.add('is-hi');
      it?.classList.add('is-hi');
    };
    for (const p of parts) {
      const seg = ui.h('div', 'compseg');
      seg.style.width = (p.val / total) * 100 + '%';
      seg.style.background = p.color;
      const it = ui.h('span', 'compitem');
      const tipHtml = `<div class="tt-h">${esc(p.label)}</div><div class="tt-tot">${webUiFormat.money(p.val, cur)} · ${webUiFormat.percent(p.val / total)}</div>`;
      seg.addEventListener('mouseenter', () => { focus(seg, it); tip.show(tipHtml, p.label); }, { signal: ctx.signal });
      seg.addEventListener('mousemove', (ev) => tip.move(ev), { signal: ctx.signal });
      seg.addEventListener('mouseleave', () => { focus(null, null); tip.hide(); }, { signal: ctx.signal });
      it.addEventListener('mouseenter', () => focus(seg, it), { signal: ctx.signal });
      it.addEventListener('mouseleave', () => focus(null, null), { signal: ctx.signal });
      bar.appendChild(seg);
      const sw = ui.h('span', 'compsw');
      sw.style.background = p.color;
      it.append(
        sw,
        ui.h('span', null, p.label),
        ui.h('span', 'compamt', webUiFormat.money(p.val, cur)),
        ui.h('span', 'comppct', webUiFormat.percent(p.val / total)),
      );
      leg.appendChild(it);
    }
    compBox.append(ui.h('span', 'ulabel', S.compTitle), bar, leg);
  }

  /**
   * 首列印的是**声明方给的名字**，后面跟 id 原文；给不出名字就只印 id。角色 id 由Persona定义、
   * 模型名由供应商定义，WebUI 两边都不认识，也就不为任何一边备一张翻译表。
   */
  function renderGroup(
    table: ReturnType<WebUi['table']>,
    groups: readonly UsageGroupStat[],
    cur: string,
  ): void {
    table.clear(groups.length ? undefined : S.noData);
    if (!groups.length) return;
    for (const g of groups) {
      const avg = g.calls ? (g.cost || 0) / g.calls : 0;
      const name = ui.h('span', null, g.label || g.key);
      if (g.label && g.label !== g.key) name.appendChild(ui.h('span', 'data-extra', ` ${g.key}`));
      table.addRow([
        name,
        { text: g.calls || 0, cls: 'mono' },
        { text: webUiFormat.count(g.promptTokens), cls: 'mono' },
        { text: webUiFormat.count(g.completionTokens), cls: 'mono' },
        { text: webUiFormat.percent(g.cacheHitRate), cls: 'mono' },
        { text: costText(g.cost || 0, g, cur), cls: 'mono' },
        { text: costText(avg, g, cur), cls: 'mono' },
      ]);
    }
  }

  /** 预设档时日期框显示服务端算出的范围；正在编辑的框不覆盖。 */
  function renderRange(d: UsageAggregate): void {
    if (doc.activeElement !== fromInput) fromInput.value = d.from ?? '';
    if (doc.activeElement !== toInput) toInput.value = d.to ?? '';
    timezone.value = d.timezone ?? '';
    timezone.hidden = !timezone.value;
  }

  /** 顶部提示行只放需要处理的问题；统计口径写在总览下方。 */
  let staleNote = '';
  function renderNotes(): void {
    const d = state.data;
    const ledgerError = d?.ledger?.error ? S.ledgerError(d.ledger.pending, d.ledger.error).trim() : '';
    notice.textContent = [staleNote, ledgerError, rateNote].filter(Boolean).join(' ');
    notice.hidden = !notice.textContent;
  }

  function renderAll(d: UsageAggregate): void {
    const currencies = d.currencies ?? [];
    currencySelect.replaceChildren(...['', ...currencies].map(value => {
      const option = doc.createElement('option');
      option.value = value;
      option.textContent = value || S.autoCurrency;
      return option;
    }));
    currencySelect.value = currency;
    const shown = d.currency || 'USD';
    const rate = shown === 'USD' ? undefined : d.rates?.[shown];
    rateBox.hidden = rate === undefined;
    rateCode.textContent = shown;
    if (rate !== undefined && doc.activeElement !== rateInput) {
      rateInput.value = String(rate);
      rateInput.dataset.saved = rateInput.value;
    }
    billingNote.textContent = S.billingHint +
      (d.totals?.unknownUsageCalls ? S.unknownUsage(d.totals.unknownUsageCalls) : '');
    renderRange(d);
    renderNotes();
    renderCards(d);
    renderComposition(d);
    if (d.dailyTokens && d.from && d.to) {
      const prev = activityData;
      activityData = { daily: d.dailyTokens, from: d.from, to: d.to };
      const moved = prev && (prev.from !== d.from || prev.to !== d.to);
      renderActivity({ ui, box: activityBox, tip }, d.dailyTokens, activityData, !prev ? 'enter' : moved ? prev : null);
    }
    const cur = d.currency || 'USD';
    renderGroup(groupTables.role, d.byRole || [], cur);
    renderGroup(groupTables.model, d.byModel || [], cur);
    renderGroup(groupTables.instance, d.byInstance || [], cur);
    renderMain();
  }

  // ---- 取数 -----------------------------------------------------------------

  /** 每次取数自增;只有最新一次的结果或失败能落到页面上。 */
  let generation = 0;
  let loadedAt = '';

  /** 一次请求取回整页数据：主数据按所选粒度分桶，活跃度格子图用同一次聚合附带的逐日 token 合计。 */
  async function load(): Promise<void> {
    const mine = ++generation;
    const extra = `&basis=${basis}&currency=${encodeURIComponent(currency)}&dailyTokenDays=${ACTIVITY_CONTEXT_DAYS}`;
    try {
      const d = await get<UsageAggregate>(
        `/api/usage?${usageQuery(state.bucket, state.days, { from: state.from, to: state.to })}${extra}`,
        { signal: ctx.signal },
      );
      if (ctx.signal.aborted || mine !== generation) return;
      state.data = d;
      loadedAt = ui.fmt.clock(new Date().toISOString());
      staleNote = '';
      results.classList.remove('u-stale');
      renderAll(d);
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted || mine !== generation) return;
      if (!state.data) {
        cards.replaceChildren(ui.placeholder(S.loadFailed(errText(err))));
        return;
      }
      // 保留上一次的结果,整块标为过期,并写明取回时刻。
      staleNote = S.stale(errText(err), loadedAt);
      renderNotes();
      results.classList.add('u-stale');
    }
  }

  // ---- 自动刷新 -------------------------------------------------------------

  let liveTimer: Disposable | null = null;
  function setLive(on: boolean): void {
    liveTimer?.dispose();
    liveTimer = on ? lifecycle.interval(() => void load(), LIVE_MS) : null;
  }

  // ---- 重画触发：主题换色 / 页面宽度变化 -------------------------------------
  // 两者都只重画，不重取：数据没变，变的是画布与配色。

  /** 配色变了。图上的颜色是从 CSS 变量现读的，所以只能整张重画。 */
  function repaint(): void {
    tip.hide();
    if (!state.data) return;
    renderMain();
    renderComposition(state.data);
  }

  lifecycle.own(getThemeStudio({ doc }).onChange(() => repaint()));

  const view = doc.defaultView;
  if (view) {
    let pending: Disposable | null = null;
    let width = 0;
    const observer = new view.ResizeObserver(() => {
      if (!state.data || mainBox.clientWidth === width) return;
      width = mainBox.clientWidth;
      pending?.dispose();
      pending = lifecycle.timeout(() => {
        renderMain();
        if (activityData) renderActivity({ ui, box: activityBox, tip }, activityData.daily, activityData, null);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(mainBox);
    ctx.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  }

  renderNotes();
  compBox.hidden = true;
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
