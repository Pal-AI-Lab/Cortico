/**
 * session 卡条 —— 终端页顶上那一排"主意识 + 各 fork"。
 *
 * 一张卡就是一个可点的入口:点谁,时间线就切去看谁。数据来自 `/ws/debug` 的
 * `sessions` 帧;调试通道没挂时由 `/ws/sessions` 顶上(见 `index.ts`)。
 *
 * 卡面上的 `r-<role>` 是**服务端给的角色字符串**,不是前端认识的名单——各角色的
 * 圆点配色写在 `styles.css` 里,前端这边一个角色名都不写死。
 */

import type { ConsoleUi } from '../../../shared/client-panel.ts';
import type { SessionStat } from './protocol.ts';
import { S } from './strings.ts';

export interface SessionBandDeps {
  ui: ConsoleUi;
  /**
   * 本次挂载的 signal，统一管理卡片监听，unmount 后解除。
   */
  signal: AbortSignal;
  /** 点了某张卡。切不切、怎么切由调用方决定。 */
  onPick(id: string, label: string): void;
}

export interface SessionBand {
  el: HTMLElement;
  /** 重画。`currentId` 决定哪张卡带选中框。 */
  render(sessions: readonly SessionStat[], currentId: string): void;
}

export function createSessionBand(deps: SessionBandDeps): SessionBand {
  const { ui } = deps;
  const el = ui.h('div', 'sesscards');
  el.title = S.sessionBandTitle;

  return {
    el,
    render(sessions, currentId) {
      while (el.children.length) el.children[0].remove();
      for (const s of sessions) {
        const running = s.endedAt == null;
        const cls = [
          'sesscard',
          running ? 'running' : '',
          `r-${s.role}`,
          s.id === currentId ? 'sel' : '',
        ]
          .filter((c) => c !== '')
          .join(' ');
        const card = ui.h('button', cls);
        card.type = 'button';
        card.appendChild(ui.h('span', 'sdot'));
        const info = ui.h('span');
        info.appendChild(ui.h('b', null, s.label));
        info.appendChild(ui.h('span', null, ` ↑${ui.fmt.count(s.promptTokens)} `));
        info.appendChild(ui.h('span', 'shr', S.sessionCache(ui.fmt.percent(s.cacheHitRate))));
        card.appendChild(info);
        card.title = S.sessionCardTitle(
          s.label,
          s.id,
          running,
          running ? '' : ui.fmt.clock(s.endedAt),
          s.promptTokens,
          s.completionTokens,
          s.cacheHitTokens,
        );
        card.addEventListener('click', () => deps.onPick(s.id, s.label), { signal: deps.signal });
        el.appendChild(card);
      }
    },
  };
}
