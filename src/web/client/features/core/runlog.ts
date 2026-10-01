/**
 * 运行日志不进入 agent 上下文。/api/log?run&level&area&grep&round&limit 按条件从
 * log.jsonl 尾部查满 limit 条；run 默认当前运行，清单取自 /api/runs。
 * 文本输入去抖 300 ms，Enter 立即查询。
 * 实时日志帧只在查看当前 run 时触发重查；重查在途时到达的帧合并成结束后的一次。
 */

import type { ConsoleUi } from '../../../shared/client-panel.ts';
import { get } from '../../core/api.ts';
import { shouldStick } from '../../ui/index.ts';
import { S } from './strings.ts';

export interface RunlogEntry {
  ts: string;
  level: string;
  area: string;
  event?: string;
  msg: string;
  /** 折叠汇总行代表的重复条数 */
  repeat?: number;
  data?: unknown;
  err?: { name: string; message: string; stack?: string };
}

interface RunRow {
  run: string;
  startedAt?: string;
}

interface RunsReply {
  current: string | null;
  runs: RunRow[];
}

const TAIL = 200;
/** `data` 摘要最多印多少字。 */
const DATA_MAX = 300;
const DEBOUNCE_MS = 300;
/** 距底多少像素之内仍算贴着底。 */
const STICK_PX = 60;

function truncate(s: string, n: number): string {
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
}

export interface RunlogViewDeps {
  ui: ConsoleUi;
  signal: AbortSignal;
  onNet(online: boolean): void;
  onError(err: unknown): void;
}

export interface RunlogView {
  el: HTMLElement;
  refresh(): Promise<void>;
  /** 当前 run 写了新日志。 */
  noteLive(): void;
}

export function createRunlogView(deps: RunlogViewDeps): RunlogView {
  const { ui } = deps;
  const q = { run: '', level: 'debug', area: '', grep: '', round: '' };
  let runsLoaded = false;
  let currentRun = '';
  /** 查询代号:只有最新一次查询的结果写表。 */
  let generation = 0;
  let busy = false;
  let liveAgain = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
  };
  const later = (): void => {
    cancel();
    debounce = setTimeout(() => {
      debounce = null;
      void view.refresh();
    }, DEBOUNCE_MS);
  };
  const now = (): void => {
    cancel();
    void view.refresh();
  };
  deps.signal.addEventListener('abort', cancel, { once: true });

  const bar = ui.rowbar();
  const runSel = ui.select({
    cls: 'mono',
    options: [{ value: '', label: S.currentRun }],
    onChange: (v) => {
      q.run = v;
      now();
    },
  });
  const levelSel = ui.select({
    options: [
      { value: 'debug', label: S.allLevels },
      { value: 'info', label: 'info+' },
      { value: 'warn', label: 'warn+' },
      { value: 'error', label: 'error' },
    ],
    value: q.level,
    onChange: (v) => {
      q.level = v;
      now();
    },
  });
  const areaIn = ui.input({
    type: 'search',
    cls: 'mono',
    placeholder: S.areaPlaceholder,
    onInput: (v) => {
      q.area = v.trim();
      later();
    },
    onCommit: now,
  });
  const grepIn = ui.input({
    type: 'search',
    placeholder: S.grepPlaceholder,
    onInput: (v) => {
      q.grep = v.trim();
      later();
    },
    onCommit: now,
  });
  const roundIn = ui.input({
    type: 'number',
    cls: 'mono',
    placeholder: S.roundPlaceholder,
    onInput: (v) => {
      q.round = v.trim();
      later();
    },
    onCommit: now,
  });
  const refreshBtn = ui.button(S.refresh, {
    size: 'sm',
    onClick: () => {
      runsLoaded = false;
      now();
    },
  });
  bar.append(
    ui.h('span', 'pagedesc grow', S.runlogDesc),
    runSel,
    levelSel,
    areaIn,
    grepIn,
    ui.field(S.roundField, roundIn),
    refreshBtn,
  );

  const table = ui.table({
    head: [S.logHeadTime, S.logHeadLevel, S.logHeadArea, S.logHeadMsg],
    maxHeight: 'calc(100vh - 300px)',
  });
  const el = ui.h('div');
  el.append(bar, table.el);

  const query = (): string => {
    const p = new URLSearchParams({ limit: String(TAIL), level: q.level });
    if (q.run) p.set('run', q.run);
    if (q.area) p.set('area', q.area);
    if (q.grep) p.set('grep', q.grep);
    if (q.round) p.set('round', q.round);
    return `/api/log?${p.toString()}`;
  };

  /** 重画 run 下拉;已选的 run 还在就保留,否则回到当前 run。 */
  const loadRuns = async (): Promise<void> => {
    const d = await get<RunsReply>('/api/runs', { signal: deps.signal });
    const runs = [...(d?.runs ?? [])].reverse();
    const options = runs.map((r) => {
      const op = ui.h('option', null, r.startedAt ? `${r.run} · ${r.startedAt}` : r.run);
      op.value = r.run;
      return op;
    });
    runSel.replaceChildren(...options);
    const keep = runs.some((r) => r.run === q.run) ? q.run : (d?.current ?? '');
    q.run = runs.some((r) => r.run === keep) ? keep : '';
    runSel.value = q.run;
    currentRun = d?.current ?? '';
    runsLoaded = true;
  };

  /** 展开着的行。重查后按这把键重新展开,跟随新日志时不被收起。 */
  const openRows = new Set<string>();
  const rowKey = (en: RunlogEntry): string => `${en.ts}|${en.area}|${en.event ?? ''}|${en.msg}`;

  /** 正文格:msg,折叠计数,`data` 摘要,err.message 走警示色;带 data 或 err 的行可展开看全文与堆栈。 */
  const bodyCell = (en: RunlogEntry): HTMLElement => {
    const line = ui.h('span');
    line.appendChild(ui.h('span', null, en.msg));
    if (en.repeat) line.appendChild(ui.h('span', 'data-extra', ` ×${en.repeat + 1}`));
    if (en.data !== undefined) {
      line.appendChild(ui.h('span', 'data-extra', ` ${truncate(JSON.stringify(en.data), DATA_MAX)}`));
    }
    if (en.err) line.appendChild(ui.h('span', 'lv-error', ` ${en.err.message}`));
    if (en.data === undefined && !en.err) return line;
    const box = ui.h('details', 'logdetail');
    const key = rowKey(en);
    box.open = openRows.has(key);
    box.addEventListener('toggle', () => {
      if (box.open) openRows.add(key);
      else openRows.delete(key);
    }, { signal: deps.signal });
    const summary = ui.h('summary');
    summary.appendChild(line);
    const full = ui.h('pre', 'mono', JSON.stringify({ msg: en.msg, data: en.data, err: en.err }, null, 2));
    box.append(summary, full, ui.copyButton(() => JSON.stringify(en, null, 2), { label: S.copyEntry }));
    return box;
  };

  const view: RunlogView = {
    el,
    async refresh() {
      const mine = ++generation;
      busy = true;
      try {
        if (!runsLoaded) await loadRuns();
        const entries = await get<RunlogEntry[]>(query(), { signal: deps.signal });
        if (mine !== generation) return;
        const rows = Array.isArray(entries) ? entries : [];
        const wasStuck = shouldStick(table.el.scrollTop, table.el.scrollHeight, table.el.clientHeight, STICK_PX);
        table.clear(rows.length ? undefined : S.noLog);
        for (const en of rows) {
          table.addRow([
            { text: ui.fmt.clock(en.ts), cls: 'mono' },
            { text: en.level, cls: `lv lv-${en.level}` },
            { text: en.event ? `${en.area}/${en.event}` : en.area, cls: 'mono' },
            { el: bodyCell(en), cls: 'txt' },
          ]);
        }
        if (wasStuck) table.el.scrollTop = table.el.scrollHeight;
        deps.onNet(true);
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') return;
        deps.onNet(false);
        deps.onError(err);
      } finally {
        if (mine === generation) {
          busy = false;
          if (liveAgain) {
            liveAgain = false;
            void view.refresh();
          }
        }
      }
    },
    noteLive() {
      if (!runsLoaded || (q.run !== '' && q.run !== currentRun)) return;
      if (busy) {
        liveAgain = true;
        return;
      }
      void view.refresh();
    },
  };
  return view;
}
