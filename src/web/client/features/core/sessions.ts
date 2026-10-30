/**
 * 主 session 与 fork 本次运行的 token、缓存统计。数据来自 /ws/debug 的 sessions 帧或 /api/sessions；表格经 ui.table.addRow 写入文本，不将 session label 解析为 HTML。
 * 「运行」页里的一节:标题、一句说明、表格、翻页。
 */

import type { WebUi } from '../../../shared/client-panel.ts';
import type { SessionStat } from '../live/protocol.ts';
import { createPager } from './pager.ts';
import { S } from './strings.ts';

export interface SessionTable {
  el: HTMLElement;
  render(list: readonly SessionStat[]): void;
}

export function createSessionTable(ui: WebUi): SessionTable {
  const sheet = ui.sheet({ title: S.sectionSessions, desc: S.sessionsDesc });
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
  let last: readonly SessionStat[] = [];
  const pager = createPager(ui, { key: 'sessions', sizes: [5, 10, 20], defaultSize: 10, onChange: () => paint() });
  sheet.body.append(table.el, pager.el);

  function paint(): void {
    pager.render(last.length);
    const [from, to] = pager.slice(last.length);
    table.clear(last.length ? undefined : S.noSessions);
    for (const s of last.slice(from, to)) {
      const name = ui.h('span');
      name.appendChild(ui.h('b', null, s.label));
      name.appendChild(ui.h('span', 'data-extra', ` ${s.id}`));
      table.addRow([
        name,
        { text: s.endedAt == null ? S.running : S.ended, cls: 'mono' },
        { text: s.calls, cls: 'mono' },
        { text: ui.fmt.count(s.promptTokens), cls: 'mono' },
        { text: s.cacheHitRate == null ? '-' : ui.fmt.percent(s.cacheHitRate), cls: 'mono' },
        { text: ui.fmt.count(s.completionTokens), cls: 'mono' },
        { text: s.messageCount, cls: 'mono' },
      ]);
    }
  }

  return {
    el: sheet.el,
    render(list) {
      last = list;
      paint();
    },
  };
}
