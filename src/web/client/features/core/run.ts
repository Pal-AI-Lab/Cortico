/**
 * 运行态读数栏:左边与控制台顶栏共用读数(live/status.ts),右边另加投递水位、本批轮数与当前模型供应商。
 * 只读:暂停与继续在侧栏底部。
 */

import type { WebUi } from '../../../shared/client-panel.ts';
import { loopOf, type SessionStat, type StatusSnapshot } from '../live/protocol.ts';
import { chipOf, createConnectionButton, createStatusBand } from '../live/status.ts';
import { S } from './strings.ts';

export interface RunViewDeps {
  ui: WebUi;
  /** 点了模型供应商:去它的设置页;没有选中的供应商时是 null。 */
  openProvider(name: string | null): void;
}

export interface RunView {
  el: HTMLElement;
  render(st: StatusSnapshot | null, sessions: readonly SessionStat[]): void;
}

export function createRunView(deps: RunViewDeps): RunView {
  const { ui } = deps;
  const el = ui.h('div', 'live-summary core-summary');
  const band = createStatusBand(ui);
  const right = ui.h('div', 'live-summary-right');
  el.append(band.el, right);

  const connection = createConnectionButton(ui, deps.openProvider);

  return {
    el,
    render(st, sessions) {
      band.render(st, sessions.find((s) => s.id === 'main') ?? null);
      right.replaceChildren();
      if (!st) return;
      const loop = loopOf(st);
      const chips = ui.h('div', 'chips');
      chips.appendChild(chipOf(ui, [S.chipDelivered, { b: loop.lastDeliveredCursor ?? '-' }, ` / ${st.latestEventCursor ?? '-'}`]));
      if (loop.roundsLastBatch != null) chips.appendChild(chipOf(ui, [S.chipRoundsPre, { b: loop.roundsLastBatch }, S.chipRoundsPost]));
      connection.render(st);
      right.append(chips, connection.el);
    },
  };
}
