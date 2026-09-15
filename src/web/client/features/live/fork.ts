import type { ContextRecord } from '../../../../protocol/open-responses/context.ts';
/**
 * fork 视图选择当前显示的 session。主 session 使用调试推送；其他 session 通过 GET /api/sessions/messages?id= 轮询。
 * 轮询受 lifecycle 管理，session 结束或离开视图时停止；内容变化才重画，并保留用户滚动位置。
 */

import type { ConsoleUi, Disposable } from '../../../shared/client-panel.ts';
import { get } from '../../core/api.ts';
import type { Lifecycle } from '../../core/lifecycle.ts';
import type { SessionStat } from './protocol.ts';
import { S } from './strings.ts';
import type { TimelineView } from './timeline.ts';

/** 主 session 的固定 id 与显示名(服务端 `/ws/debug` 推的就是这一份)。 */
export const MAIN_ID = 'main';
export const MAIN_LABEL = S.mainLabel;

const FORK_POLL_MS = 3000;

/** 同一 Response 的多个 Item 可以交错增长。 */
function messageRevision(messages: readonly ContextRecord[]): string {
  return JSON.stringify(messages);
}

export interface ForkDeps {
  ui: ConsoleUi;
  lifecycle: Lifecycle;
  signal: AbortSignal;
  timeline: TimelineView;
  /** 主 session 的消息(切回主视图时重画用) */
  mainMessages(): readonly ContextRecord[];
  /** 主 session 的合成开头(切回主视图时把标注块画回来) */
  mainHead?(): readonly ContextRecord[];
  /** 当前 session 列表(判断 fork 是否已结束) */
  sessions(): readonly SessionStat[];
  /** 当前观察目标变了(卡条要重画选中态) */
  onChange(): void;
  onError(err: unknown): void;
}

export interface ForkView {
  readonly id: string;
  readonly label: string;
  /** 切去看某个 session。`MAIN_ID` 回主视图。 */
  switchTo(id: string, label: string): void;
  /** 主 session 的消息变了(实时帧):在主视图时才需要动。 */
  isMain(): boolean;
  /** session 列表更新后调一次:目标已结束就停轮询。 */
  noteSessions(): void;
}

export function createForkView(deps: ForkDeps): ForkView {
  const { ui, timeline } = deps;
  let id = MAIN_ID;
  let label = MAIN_LABEL;
  let lastRevision = '';
  let poll: Disposable | null = null;

  const stopPolling = (): void => {
    poll?.dispose();
    poll = null;
  };

  /** 目标 session 已结束就不必再轮。 */
  const maybeStop = (): void => {
    const st = deps.sessions().find((x) => x.id === id);
    if (st && st.endedAt != null) stopPolling();
  };

  const banner = (count: number, estTokens: number): HTMLElement => {
    const bar = ui.h('div', 'forkbanner');
    const st = deps.sessions().find((x) => x.id === id);
    const ended = !!st && st.endedAt != null;
    const info = ui.h('span');
    info.appendChild(ui.h('span', null, S.forkViewing));
    info.appendChild(ui.h('b', null, label));
    info.appendChild(ui.h('span', 'meta2', ` (${id})`));
    info.appendChild(
      ui.h(
        'span',
        null,
        S.forkInfo(count, ui.fmt.count(estTokens || 0), ended, Math.round(FORK_POLL_MS / 1000)),
      ),
    );
    const back = ui.button(S.forkBack, {
      size: 'sm',
      onClick: () => view.switchTo(MAIN_ID, MAIN_LABEL),
    });
    bar.append(info, back);
    return bar;
  };

  const refresh = async (force: boolean): Promise<void> => {
    const asked = id;
    if (asked === MAIN_ID) return;
    try {
      const data = await get<{ messages: ContextRecord[]; estTokens?: number }>(
        `/api/sessions/messages?id=${encodeURIComponent(asked)}`,
        { signal: deps.signal },
      );
      if (id !== asked) return; // 期间用户又切了,这份回应已经过期
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      const revision = messageRevision(messages);
      if (!force && revision === lastRevision) {
        maybeStop();
        return;
      }
      lastRevision = revision;
      timeline.rebuild(messages, {
        banner: banner(messages.length, data?.estTokens ?? 0),
        empty: S.forkEmpty,
        keepScroll: !force,
      });
      maybeStop();
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return; // 页面走了,不是失败
      if (id !== asked) return;
      deps.onError(err);
      timeline.rebuild([], {
        banner: banner(0, 0),
        empty: S.forkFetchFailed(String((err as Error)?.message ?? err)),
      });
      stopPolling();
    }
  };

  const view: ForkView = {
    get id(): string {
      return id;
    },
    get label(): string {
      return label;
    },
    switchTo(next, nextLabel) {
      if (id === next) return;
      stopPolling();
      id = next;
      label = nextLabel;
      lastRevision = '';
      deps.onChange();
      if (next === MAIN_ID) {
        timeline.rebuild(deps.mainMessages(), { head: deps.mainHead?.() ?? null });
        return;
      }
      void refresh(true);
      poll = deps.lifecycle.interval(() => void refresh(false), FORK_POLL_MS);
    },
    isMain() {
      return id === MAIN_ID;
    },
    noteSessions() {
      maybeStop();
    },
  };
  return view;
}
