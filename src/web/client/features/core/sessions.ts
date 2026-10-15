/**
 * 主 session 与 fork 本次运行的 token、缓存统计。数据来自 /ws/debug 的 sessions 帧或 /api/sessions；表格经 ui.table.addRow 写入文本，不将 session label 解析为 HTML。
 */

import type { WebUi } from '../../../shared/client-panel.ts';
import type { SessionStat } from '../live/protocol.ts';
import { S } from './strings.ts';

export interface SessionTable {
  el: HTMLElement;
  render(list: readonly SessionStat[]): void;
}

export function createSessionTable(ui: WebUi): SessionTable {
  const sheet = ui.sheet({
    title: S.sessionsTitle,
    en: 'usage / cache',
    desc: S.sessionsDesc,
  });
  const table = ui.table({
    head: [
      'session',
      S.sesHeadStatus,
      S.sesHeadCalls,
      S.sesHeadInput,
      S.sesHeadCache,
      S.sesHeadOutput,
      S.sesHeadMsgs,
    ],
  });
  sheet.body.appendChild(table.el);

  return {
    el: sheet.el,
    render(list) {
      table.clear(list.length ? undefined : S.noSessions);
      for (const s of list) {
        const name = ui.h('span');
        name.appendChild(ui.h('b', null, s.label));
        name.appendChild(ui.h('span', 'data-extra', ` ${s.id}`));
        table.addRow([
          name,
          { text: s.endedAt == null ? S.running : S.ended, cls: 'mono' },
          { text: s.calls, cls: 'mono' },
          { text: ui.fmt.count(s.promptTokens), cls: 'mono' },
          { text: ui.fmt.percent(s.cacheHitRate), cls: 'mono' },
          { text: ui.fmt.count(s.completionTokens), cls: 'mono' },
          { text: s.messageCount, cls: 'mono' },
        ]);
      }
    },
  };
}
