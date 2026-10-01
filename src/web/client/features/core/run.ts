/**
 * 运行态概览。只读——暂停/继续那颗按钮在顶栏,这里不重复一份。
 */

import type { ConsoleUi } from '../../../shared/client-panel.ts';
import { loopOf, type StatusSnapshot } from '../live/protocol.ts';
import { S } from './strings.ts';

export interface RunViewDeps {
  ui: ConsoleUi;
}

export interface RunView {
  el: HTMLElement;
  render(st: StatusSnapshot | null): void;
}

export function createRunView(deps: RunViewDeps): RunView {
  const { ui } = deps;
  const sheet = ui.sheet({
    title: S.runTitle,
    en: 'context · cache · batches',
  });
  const grid = ui.statgrid();
  sheet.body.appendChild(grid);

  return {
    el: sheet.el,
    render(st) {
      while (grid.children.length) grid.children[0].remove();
      if (!st) {
        grid.appendChild(ui.placeholder(S.noStatus));
        return;
      }
      const loop = loopOf(st);
      const u = loop.lastUsage ?? {};
      const cache =
        u.promptTokens ? ui.fmt.percent((u.cacheHitTokens || 0) / u.promptTokens) : '—';
      const connection = st.modelConnection;
      // 先列决定 bot 能否响应的状态,累计统计排在后面。
      const cards = [
        {
          k: S.statRun,
          v: loop.paused ? S.runPaused : loop.scheduleBlocked ? S.runBlocked : S.runRunning,
          accent: !!(loop.paused || loop.scheduleBlocked),
        },
        { k: S.statBehind, v: loop.behind ?? '—', accent: !!loop.behind },
        { k: S.statDelivered, v: loop.lastDeliveredCursor ?? '—', unit: `/ ${st.latestEventCursor ?? '—'}` },
        { k: S.statTruncating, v: loop.truncating ? S.truncatingOn : S.truncatingOff, accent: !!loop.truncating },
        { k: S.statProvider, v: connection ? connection.name : '—', unit: connection?.model ?? '' },
        { k: S.statContext, v: ui.fmt.count(loop.estTokens), unit: 'tok' },
        { k: S.statCache, v: cache },
        { k: S.statMessages, v: loop.messageCount ?? '—', unit: S.unitMsgs },
        { k: S.statRounds, v: loop.roundsLastBatch ?? '—' },
        { k: S.statBatches, v: loop.batchesHandled ?? '—' },
        { k: S.statOnline, v: st.terminalOnline ?? '—', unit: S.unitPeople },
      ];
      for (const c of cards) grid.appendChild(ui.stat(c));
    },
  };
}
