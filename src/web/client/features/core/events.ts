/**
 * 事件库翻查界面，按 from/to 游标区间取：追新从已载入的最后一条之后按批往后取，直到服务端说没有更多；
 * 取更早的用 earliest−1。调试通道可用时由 event 帧触发追新，不可用时回落轮询。
 * 换来源或归档开关即开新一代查询，上一代在途的回应不再写表；同一代里追新串行，期间到达的触发合并成下一轮。
 * 来源框可输入任意来源；候选项取自已载入的事件，不代表事件库里的全部来源。
 *
 * 表格分页、新的在前:第一页是最新的几条,追新时停在第一页就看得到新来的。翻到已载入的最后一页
 * 而库里还有更早的,「下一页」照样能点,点了先取一批更早的再翻过去。
 */

import type { WebUi, WebUiTable, Disposable } from '../../../shared/client-panel.ts';
import { get } from '../../core/api.ts';
import type { Lifecycle } from '../../core/lifecycle.ts';
import { createPager } from './pager.ts';
import { S } from './strings.ts';

/** 事件库的一条。字段是服务端 `EventEnvelope` 的子集。 */
export interface EventRow {
  cursor: number;
  ts: string;
  source: string;
  type: string;
  text: string;
}

interface EventPage {
  latest: number;
  events: EventRow[];
  /** 只在带 from 不带 to 的追新查询里出现:区间里还有排在本页之后的记录。 */
  hasMore?: boolean;
}

/** 每次向服务端取多少条。 */
const BATCH = 100;
/** 没有推送时的轮询间隔。 */
const EVENT_POLL_MS = 3000;

export interface EventsViewDeps {
  ui: WebUi;
  lifecycle: Lifecycle;
  signal: AbortSignal;
  /** 网络状态回报(与调试通道共用同一处显示) */
  onNet(online: boolean): void;
  onError(err: unknown): void;
}

export interface EventsView {
  el: HTMLElement;
  /** 首次进入/换来源时的全量拉取 */
  init(): Promise<void>;
  /** 追新(推送到了、或轮询到点) */
  poll(): Promise<void>;
  /** 这一页开始/停止自己轮询(没有推送时才需要) */
  setPolling(on: boolean): void;
}

export function createEventsView(deps: EventsViewDeps): EventsView {
  const { ui } = deps;
  const sources = new Set<string>();
  let source = '';
  let archive = false;
  /** 已载入的事件,旧的在前。 */
  let rows: EventRow[] = [];
  /** 分页算的是 rows 的前 shown 条。不在第一页时追到的新事件不算进来,当前页才不整体错位;回到第一页再补上。 */
  let shown = 0;
  let earliest: number | null = null;
  /** 已经消费到的游标:之前的记录要么显示了,要么被当前过滤条件排除。 */
  let latest = 0;
  let inited = false;
  /** 查询代号。init 自增;回应到达时代号已变就丢弃。 */
  let generation = 0;
  let polling = false;
  let pollAgain = false;
  let poller: Disposable | null = null;

  const sheet = ui.sheet({ title: S.sectionEvents, desc: S.eventsDesc });
  const bar = ui.rowbar();
  bar.classList.add('core-filters');
  // 下拉的候选取自已载入的事件。不用原生 `<datalist>`:它的弹层在部分浏览器外壳里画得离输入框很远。
  const sourceSel = ui.select({
    cls: 'mono',
    options: [{ value: '', label: S.allSources }],
    onChange: (v) => {
      if (v === source) return;
      source = v;
      void view.init();
    },
  });
  sourceSel.title = S.sourceTitle;
  sourceSel.classList.add('core-filter-source');
  // 默认过滤 archiveOnly 记录；启用归档选项后同时显示未直接投递的记录。
  const archiveToggle = ui.checkbox(S.showArchive, {
    title: S.showArchiveTitle,
    onChange: (on) => {
      archive = on;
      void view.init();
    },
  });
  bar.append(sourceSel, archiveToggle.el);

  const table: WebUiTable = ui.table({
    head: ['#', S.evHeadTime, S.evHeadSource, S.evHeadType, S.evHeadText],
  });
  const pager = createPager(ui, {
    key: 'events',
    sizes: [10, 20, 50, 100],
    defaultSize: 20,
    onChange: (beyond) => { if (beyond) void loadEarlier(); else paint(); },
  });
  sheet.body.append(bar, table.el, pager.el);

  const rowCells = (e: EventRow): Parameters<WebUiTable['addRow']>[0] => [
    { text: `#${e.cursor}`, cls: 'mono' },
    { text: ui.fmt.clock(e.ts), cls: 'mono' },
    { text: e.source, cls: 'mono' },
    { text: e.type, cls: 'mono' },
    { text: e.text, cls: 'txt' },
  ];

  /** 库里比已载入的更早的还有没有。 */
  const hasEarlier = (): boolean => earliest !== null && earliest > 1;

  /** 画当前页:新的在前。 */
  function paint(): void {
    if (pager.page === 0) shown = rows.length;
    pager.render(shown, hasEarlier());
    const [from, to] = pager.slice(shown);
    const newestFirst = rows.slice(shown - to, shown - from).reverse();
    table.clear(shown ? undefined : S.noEvents);
    for (const e of newestFirst) table.addRow(rowCells(e));
  }

  const noteSources = (events: readonly EventRow[]): void => {
    for (const e of events) {
      if (!e.source || sources.has(e.source)) continue;
      sources.add(e.source);
      const op = ui.h('option', null, e.source);
      op.value = e.source;
      sourceSel.appendChild(op);
    }
  };

  const query = (extra: string): string => {
    const src = source ? `&source=${encodeURIComponent(source)}` : '';
    return `/api/events?${extra}${src}${archive ? '&archive=1' : ''}`;
  };

  const failed = (err: unknown): void => {
    if ((err as { name?: string } | null)?.name === 'AbortError') return;
    deps.onNet(false);
    deps.onError(err);
  };

  async function loadEarlier(): Promise<void> {
    if (!hasEarlier()) { paint(); return; }
    const mine = generation;
    try {
      const d = await get<EventPage>(query(`to=${earliest! - 1}&limit=${BATCH}`), {
        signal: deps.signal,
      });
      if (mine !== generation) return;
      const events = d?.events ?? [];
      if (events.length) {
        rows = [...events, ...rows];
        shown += events.length;
        earliest = events[0].cursor;
        noteSources(events);
      } else {
        // 更早的都被过滤条件排除了:当作到头
        earliest = 1;
      }
      paint();
    } catch (err) {
      failed(err);
      paint();
    }
  }

  const view: EventsView = {
    el: sheet.el,
    async init() {
      const mine = ++generation;
      inited = false;
      polling = false;
      pollAgain = false;
      earliest = null;
      latest = 0;
      rows = [];
      pager.reset();
      try {
        const d = await get<EventPage>(query(`limit=${BATCH}`), { signal: deps.signal });
        if (mine !== generation) return;
        const events = d?.events ?? [];
        rows = events;
        earliest = events.length ? events[0].cursor : null;
        latest = Math.max(d?.latest ?? 0, events.length ? events[events.length - 1].cursor : 0);
        inited = true;
        noteSources(events);
        deps.onNet(true);
        paint();
      } catch (err) {
        failed(err);
      }
    },
    async poll() {
      if (!inited) return;
      if (polling) {
        pollAgain = true;
        return;
      }
      polling = true;
      const mine = generation;
      try {
        let more = true;
        while (more && mine === generation) {
          pollAgain = false;
          const d = await get<EventPage>(query(`from=${latest + 1}&limit=${BATCH}`), { signal: deps.signal });
          if (mine !== generation) return;
          const events = d?.events ?? [];
          if (events.length) {
            rows = [...rows, ...events];
            if (earliest === null) earliest = events[0].cursor;
            noteSources(events);
            paint();
          }
          // 还有下一页时只推进到本页末条;否则区间内剩下的都被过滤条件排除,推进到库尾。
          latest = d?.hasMore && events.length ? events[events.length - 1].cursor : Math.max(d?.latest ?? 0, latest);
          more = (d?.hasMore === true && events.length > 0) || pollAgain;
        }
      } catch (err) {
        failed(err);
      } finally {
        if (mine === generation) polling = false;
      }
    },
    setPolling(on) {
      poller?.dispose();
      poller = null;
      if (on) poller = deps.lifecycle.interval(() => void view.poll(), EVENT_POLL_MS);
    },
  };
  return view;
}
