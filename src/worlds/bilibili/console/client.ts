/**
 * B 站直播间 World 的浏览器扩展。
 *
 * `log` 保留直播间入站诊断。Overlay 编辑器由 World 的回环服务独立承载，
 * 控制台只暴露入口链接。
 *
 * 轮询 state,按 total 差值追加事件。服务端响应类型在浏览器端声明,避免导入 Node 模块。
 */

import type { ConsoleClientBundle, ConsolePanelContext, ConsolePanel } from '../../../web/shared/client-panel.ts';
import { logText } from './strings.ts';

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 服务端 `BilibiliWorld.console().invoke('log', 'state')` 的返回形状
// ---------------------------------------------------------------------------

interface BilibiliLiveStatus {
  /** `stopped` / `connecting` / `connected` / `retrying` */
  phase: string;
  /** 配置里填的房间号(可能是短号) */
  roomId: number;
  /** 换算出的真实房间号;还没握手完就是 null */
  realRoomId: number | null;
  title: string | null;
  living: boolean;
  /** 登录凭证对应的自己的 uid;匿名接入时为 0 */
  selfUid: number;
  lastError: string | null;
}

/** 待投递的观众统计;计数项累加,其余字段保留最新值。 */
interface BilibiliAggregate {
  enter: number;
  like: number;
  freeGift: number;
  watched: number | null;
  online: number | null;
  popularity: number | null;
  fans: number | null;
  likeTotal: number | null;
}

interface BilibiliLogState {
  status: BilibiliLiveStatus | null;
  /** 最近一窗弹幕均缺少有效 uid。 */
  desensitized: boolean;
  aggregate: BilibiliAggregate;
  /** 最近事件的文本，按时间倒序排列。 */
  recent: string[];
  /** 记过的总条数(含已被上限挤掉的) */
  total: number;
  /** cmd → 条数,按条数降序;没进白名单也没进黑名单的 cmd 也在里面 */
  counts: Array<[string, number]>;
  audienceAdmission: {
    trackedViewers: number;
    qualifiedViewers: number;
    crowd: { onlineRankCount: number | null; signalFresh: boolean; active: boolean };
    totals: { input: number; selected: number; dropped: number; limitedBatches: number };
    lastBatch: { limitingActive: boolean; input: number; selected: number } | null;
    persistenceError: string | null;
  };
}

const POLL_MS = 2000;
/** 与服务端 RECENT_CAP 一致。 */
const KEEP = 200;

const logPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const { ui, root } = ctx;
    const T = logText(ctx.language);
    const card = ui.sheet({ title: T.sheetTitle, en: 'bilibili live', desc: T.sheetDesc });
    root.appendChild(card.el);

    const err = ui.msgline();
    const info = ui.h('div');
    const gauges = ui.statgrid();
    const view = ui.log({ max: KEEP, maxHeight: '320px', empty: T.logEmpty });
    const counts = ui.table({ head: ['cmd', T.colCount] });
    const btnEnd = ui.button(T.scrollToEnd, { size: 'sm', onClick: () => view.scrollToEnd() });
    const bar = ui.rowbar();
    bar.append(ui.h('span', 'grow'), btnEnd);
    card.body.append(err, info, gauges, bar, view.el, counts.el);

    let shown = 0;

    const setError = (text: string | null): void => {
      err.textContent = text ?? '';
      err.className = text ? 'msgline bad' : 'msgline';
      err.hidden = !text;
    };
    setError(null);

    const drawInfo = (st: BilibiliLogState): void => {
      const s = st.status;
      const room = s?.realRoomId
        ? s.roomId && s.roomId !== s.realRoomId ? T.roomWithShort(s.realRoomId, s.roomId) : String(s.realRoomId)
        : s?.roomId
          ? T.roomUnresolved(s.roomId)
          : T.roomUnset;
      info.replaceChildren(ui.kv([
        { k: T.kFeed, v: T.phase[s?.phase ?? 'stopped'] ?? s?.phase ?? T.phase.stopped },
        { k: T.kRoom, v: room },
        { k: T.kTitle, v: s?.title || '—' },
        { k: T.kLive, v: ui.pill(s?.living ? T.live : T.offline, s?.living ? 'on' : 'off') },
        {
          k: T.kIdentity,
          v: st.desensitized
            ? ui.pill(T.identityMasked, 'off')
            : ui.pill(s?.selfUid ? T.loggedIn(s.selfUid) : T.identityPending, s?.selfUid ? 'on' : 'plain'),
        },
        ...(s?.lastError ? [{ k: T.kLastError, v: s.lastError }] : []),
      ]));
    };

    /** 服务端在生成投递正文后清零聚合计数。 */
    const drawGauges = (agg: BilibiliAggregate, admission: BilibiliLogState['audienceAdmission']): void => {
      const num = (v: number | null): string => (v === null ? '—' : ui.fmt.count(v));
      const last = admission.lastBatch;
      const limiter = admission.crowd.active
        ? last?.limitingActive
          ? T.crowdKept(last.selected, last.input)
          : T.crowd
        : last?.limitingActive
          ? T.notLimitedKept(last.selected, last.input)
          : T.notLimited;
      gauges.replaceChildren(
        ui.stat({ k: T.statEnter, v: agg.enter, unit: T.unitPeople }),
        ui.stat({ k: T.statLike, v: agg.like, unit: T.unitTimes }),
        ui.stat({ k: T.statFreeGift, v: agg.freeGift, unit: T.unitGifts }),
        ui.stat({ k: T.statOnlineRank, v: num(admission.crowd.onlineRankCount ?? agg.online), unit: T.unitPeople }),
        ui.stat({ k: T.statFilter, v: limiter }),
        ui.stat({ k: T.statImportant, v: admission.qualifiedViewers, unit: T.unitPeople }),
        ui.stat({ k: T.statDropped, v: admission.totals.dropped, unit: T.unitItems }),
        ui.stat({ k: T.statWatched, v: num(agg.watched) }),
        ui.stat({ k: T.statPopularity, v: num(agg.popularity) }),
        ui.stat({ k: T.statFans, v: num(agg.fans) }),
      );
    };

    const drawCounts = (rows: BilibiliLogState['counts']): void => {
      counts.clear(rows.length ? undefined : T.countsEmpty);
      for (const [cmd, n] of rows) counts.addRow([cmd, n]);
    };

    const appendNew = (st: BilibiliLogState): void => {
      const fresh = Math.min(st.total - shown, st.recent.length);
      if (fresh <= 0) {
        shown = st.total;
        return;
      }
      const chronological = [...st.recent].reverse();
      for (const line of chronological.slice(chronological.length - fresh)) view.append(line);
      shown = st.total;
    };

    let polling = false;
    const poll = (): void => {
      if (polling) return;
      polling = true;
      void ctx.invoke<BilibiliLogState>('state').then(
        (st) => {
          polling = false;
          if (ctx.signal.aborted) return;
          setError(null);
          drawInfo(st);
          drawGauges(st.aggregate, st.audienceAdmission);
          drawCounts(st.counts);
          appendNew(st);
        },
        (e: unknown) => {
          polling = false;
          if (ctx.signal.aborted) return;
          setError(T.stateFailed(errText(e)));
        },
      );
    };

    ctx.interval(poll, POLL_MS);
    poll();
  },
};

const bundle: ConsoleClientBundle = {
  // 键是**局部** panel id,与服务端 `console().panels[].id` 一一对应。
  panels: {
    log: logPanel,
  },
};

export default bundle;
