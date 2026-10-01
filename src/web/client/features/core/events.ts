/**
 * 事件库翻查界面，按 from/to 游标区间分页：追新从已显示的最后一条之后按页往后取，直到服务端说没有更多；
 * 翻旧使用 earliest−1。调试通道可用时由 event 帧触发追新，不可用时回落轮询。
 * 换来源或归档开关即开新一代查询，上一代在途的回应不再写表；同一代里追新串行，期间到达的触发合并成下一轮。
 * 来源框可输入任意来源；候选项取自已加载的事件，不代表事件库里的全部来源。
 */

import type { ConsoleUi, ConsoleTable, Disposable } from '../../../shared/client-panel.ts';
import { get } from '../../core/api.ts';
import type { Lifecycle } from '../../core/lifecycle.ts';
import { shouldStick } from '../../ui/index.ts';
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

const PAGE = 100;
/** 没有推送时的轮询间隔。 */
const EVENT_POLL_MS = 3000;
/** 距底多少像素之内仍算贴着底。 */
const STICK_PX = 60;

export interface EventsViewDeps {
  ui: ConsoleUi;
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
  let earliest: number | null = null;
  /** 已经消费到的游标:之前的记录要么显示了,要么被当前过滤条件排除。 */
  let latest = 0;
  let inited = false;
  /** 查询代号。init 自增;回应到达时代号已变就丢弃。 */
  let generation = 0;
  let polling = false;
  let pollAgain = false;
  let poller: Disposable | null = null;

  const bar = ui.rowbar();
  const desc = ui.h('span', 'pagedesc grow', S.eventsDesc);
  // `<datalist>` 靠全局 id 绑定,每次挂载各用一个。
  const listId = `ev-sources-${Math.random().toString(36).slice(2, 8)}`;
  const sourceList = ui.h('datalist');
  sourceList.id = listId;
  const pickSource = (v: string): void => {
    const next = v.trim();
    if (next === source) return;
    source = next;
    void view.init();
  };
  const sourceIn = ui.input({
    type: 'search',
    cls: 'mono',
    placeholder: S.allSources,
    // 清除按钮只派发 input,清空即回到全部来源。
    onInput: (v) => { if (v === '') pickSource(''); },
    onChange: pickSource,
    onCommit: pickSource,
  });
  sourceIn.setAttribute('list', listId);
  sourceIn.title = S.sourceTitle;
  // 默认过滤 archiveOnly 记录；启用归档选项后同时显示未直接投递的记录。
  const archiveToggle = ui.checkbox(S.showArchive, {
    title: S.showArchiveTitle,
    onChange: (on) => {
      archive = on;
      void view.init();
    },
  });
  const more = ui.button(S.loadEarlier, { size: 'sm', onClick: () => void loadEarlier() });
  bar.append(desc, sourceIn, sourceList, archiveToggle.el, more);

  const table: ConsoleTable = ui.table({
    head: ['#', S.evHeadTime, S.evHeadSource, S.evHeadType, S.evHeadText],
    maxHeight: 'calc(100vh - 300px)',
  });

  const el = ui.h('div');
  el.append(bar, table.el);

  const rowCells = (e: EventRow): Parameters<ConsoleTable['addRow']>[0] => [
    { text: `#${e.cursor}`, cls: 'mono' },
    { text: ui.fmt.clock(e.ts), cls: 'mono' },
    { text: e.source, cls: 'mono' },
    { text: e.type, cls: 'mono' },
    { text: e.text, cls: 'txt' },
  ];

  const noteSources = (events: readonly EventRow[]): void => {
    for (const e of events) {
      if (!e.source || sources.has(e.source)) continue;
      sources.add(e.source);
      const op = ui.h('option');
      op.value = e.source;
      sourceList.appendChild(op);
    }
  };

  const query = (extra: string): string => {
    const src = source ? `&source=${encodeURIComponent(source)}` : '';
    return `/api/events?${extra}${src}${archive ? '&archive=1' : ''}`;
  };

  const stuck = (): boolean =>
    shouldStick(table.el.scrollTop, table.el.scrollHeight, table.el.clientHeight, STICK_PX);
  const toEnd = (): void => {
    table.el.scrollTop = table.el.scrollHeight;
  };

  const failed = (err: unknown): void => {
    if ((err as { name?: string } | null)?.name === 'AbortError') return;
    deps.onNet(false);
    deps.onError(err);
  };

  async function loadEarlier(): Promise<void> {
    if (earliest === null || earliest <= 1) return;
    const mine = generation;
    try {
      const d = await get<EventPage>(query(`to=${earliest - 1}&limit=${PAGE}`), {
        signal: deps.signal,
      });
      if (mine !== generation) return;
      const events = d?.events ?? [];
      if (!events.length) return;
      const before = table.el.scrollHeight;
      const first = table.body.children[0] ?? null;
      for (const e of events) {
        const tr = table.addRow(rowCells(e));
        table.body.insertBefore(tr, first);
      }
      // 往上插会把已有内容顶下去,补回同样多的滚动量,视野里的那一行才不动。
      table.el.scrollTop += table.el.scrollHeight - before;
      earliest = events[0].cursor;
      noteSources(events);
    } catch (err) {
      failed(err);
    }
  }

  const view: EventsView = {
    el,
    async init() {
      const mine = ++generation;
      inited = false;
      polling = false;
      pollAgain = false;
      earliest = null;
      latest = 0;
      try {
        const d = await get<EventPage>(query(`limit=${PAGE}`), { signal: deps.signal });
        if (mine !== generation) return;
        const events = d?.events ?? [];
        table.clear(events.length ? undefined : S.noEvents);
        for (const e of events) table.addRow(rowCells(e));
        earliest = events.length ? events[0].cursor : null;
        latest = Math.max(d?.latest ?? 0, events.length ? events[events.length - 1].cursor : 0);
        inited = true;
        noteSources(events);
        deps.onNet(true);
        toEnd();
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
          const d = await get<EventPage>(query(`from=${latest + 1}&limit=${PAGE}`), { signal: deps.signal });
          if (mine !== generation) return;
          const events = d?.events ?? [];
          if (events.length) {
            const wasStuck = stuck();
            if (earliest === null) table.clear();
            for (const e of events) table.addRow(rowCells(e));
            if (earliest === null) earliest = events[0].cursor;
            noteSources(events);
            if (wasStuck) toEnd();
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
