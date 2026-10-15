/**
 * 面板 `events` —— 事件库里 `source=qq` 的历史,按会话翻。
 *
 * 只读面板:选会话、翻记录、改条数上限、刷新。离线(协议端没连上)也能看,
 * 因为它读的是事件库而不是协议端。
 *
 * 选中的会话与条数上限记在 `ctx.memo` 里(按 `provider:panel` 命名空间隔离),
 * 所以离开面板再回来还在原处。
 */

import type {
  WebUiPanelContext,
  WebUiPanel,
} from '../../../web/shared/client-panel.ts';
import { autoload, type QQConvNames } from './client.ts';
import { qqPanelText } from './strings.ts';

type Text = ReturnType<typeof qqPanelText>;

/** 服务端把它夹在 1..2000 之间,这里只给几个常用挡位。 */
const LIMITS = ['100', '300', '1000', '2000'] as const;
const DEFAULT_LIMIT = '300';

interface QQConvSummary {
  kind: 'group' | 'private';
  id: number;
  count: number;
  lastTs: string;
}

interface QQLeanEvent {
  cursor: number;
  type: string;
  ts: string;
  text: string;
  senderKey: string;
  senderName: string;
  conv: { kind?: string; id?: number } | null;
}

interface QQEventList {
  conversations: QQConvSummary[];
  events: QQLeanEvent[];
  total: number;
}

interface EventsView {
  list: QQEventList;
  names: QQConvNames;
}

const NO_NAMES: QQConvNames = { groups: [], privates: [] };

export const eventsPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const T = qqPanelText(ctx.language);
    // `''` = 全部会话
    let conv = ctx.memo.get<string>('conv', '');
    let limit = ctx.memo.get<string>('limit', DEFAULT_LIMIT);

    autoload<EventsView>(ctx, {
      loading: T.eventsLoading,
      failed: T.eventsFailed,
      load: async () => ({
        list: await ctx.invoke<QQEventList>('list', [{ conv, limit: Number(limit) }]),
        names: await ctx.invoke<QQConvNames>('names').catch(() => NO_NAMES),
      }),
      render: (view, reload) => [
        sheet(ctx, view, {
          conv,
          limit,
          pick: (next) => { conv = next; ctx.memo.set('conv', next); reload(); },
          setLimit: (next) => { limit = next; ctx.memo.set('limit', next); reload(); },
          reload,
        }, T),
      ],
    });
  },
};

interface Controls {
  conv: string;
  limit: string;
  pick(conv: string): void;
  setLimit(limit: string): void;
  reload(): void;
}

function sheet(ctx: WebUiPanelContext, view: EventsView, ctl: Controls, T: Text): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: T.eventsTitle,
    en: T.eventsEn,
    desc: T.eventsDesc(view.list.total),
  });

  // 会话切换:与 WebUI 画面板页签同一套做法(一行按钮,选中的那颗上主色)
  const tabs = ui.rowbar();
  const tab = (label: string, value: string): HTMLButtonElement =>
    ui.button(label, {
      size: 'sm',
      variant: ctl.conv === value ? 'primary' : 'plain',
      onClick: () => { if (ctl.conv !== value) ctl.pick(value); },
    });
  tabs.appendChild(tab(T.all, ''));
  for (const c of view.list.conversations) {
    tabs.appendChild(tab(`${convName(view.names, c, T)} (${c.count})`, `${c.kind}:${c.id}`));
  }
  card.body.appendChild(tabs);

  const bar = ui.rowbar();
  bar.append(
    ui.h('span', 'grow'),
    ui.chip(T.pageCount(view.list.events.length)),
    ui.select({
      value: ctl.limit,
      options: LIMITS.map((n) => ({ value: n, label: T.recent(n) })),
      onInput: (v) => ctl.setLimit(v),
    }),
    ui.button(T.refresh, { size: 'sm', onClick: () => ctl.reload() }),
  );
  card.body.appendChild(bar);

  const table = ui.table({ head: ['#', T.colType, T.colText], maxHeight: 'calc(100vh - 360px)' });
  if (!view.list.events.length) table.clear(T.noEvents);
  for (const e of view.list.events) {
    table.addRow([
      { text: `#${e.cursor}`, cls: 'mono' },
      { el: ui.pill(T.typeLabels[e.type] ?? e.type, 'plain') },
      { text: e.text || '', cls: 'txt' },
    ]);
  }
  card.body.appendChild(table.el);
  return card.el;
}

/** 会话在页签上的名字:能查到就用群名/称呼,否则退回号码。 */
function convName(names: QQConvNames, c: QQConvSummary, T: Text): string {
  if (c.kind === 'group') {
    const g = names.groups.find((x) => x.id === c.id);
    return T.groupTab(String(g?.name || c.id));
  }
  const p = names.privates.find((x) => x.id === c.id);
  return T.privateTab(String(p?.name || c.id));
}
