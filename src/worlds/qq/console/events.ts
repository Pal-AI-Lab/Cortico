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
  ConsolePanelContext,
  ConsolePanel,
} from '../../../web/shared/client-panel.ts';
import { autoload, type QQConvNames } from './client.ts';

/** 事件 type → 列表里那颗药丸上的字。不认识的 type 原样显示。 */
const TYPE_LABEL: Record<string, string> = {
  'qq.message': '消息',
  'qq.self': '我',
  'qq.recall': '撤回',
  'qq.member': '成员',
  'qq.emoji': '表情',
  'qq.poke': '戳一戳',
  'qq.vision': '识图',
  'qq.image': '图片附件',
  'qq.watch': '监听',
  'qq.forward': '转发',
  'qq.reply.uncaptured': '引用',
};

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

export const eventsPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    // `''` = 全部会话
    let conv = ctx.memo.get<string>('conv', '');
    let limit = ctx.memo.get<string>('limit', DEFAULT_LIMIT);

    autoload<EventsView>(ctx, {
      loading: '加载 QQ 事件…',
      failed: 'QQ 事件不可用',
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
        }),
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

function sheet(ctx: ConsolePanelContext, view: EventsView, ctl: Controls): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: 'QQ 事件',
    en: '分群 / 私聊',
    desc: `事件库里 source=qq 的历史,按会话查看(离线也能翻)。共 ${view.list.total} 条。`,
  });

  // 会话切换:与控制台画面板页签同一套做法(一行按钮,选中的那颗上主色)
  const tabs = ui.rowbar();
  const tab = (label: string, value: string): HTMLButtonElement =>
    ui.button(label, {
      size: 'sm',
      variant: ctl.conv === value ? 'primary' : 'plain',
      onClick: () => { if (ctl.conv !== value) ctl.pick(value); },
    });
  tabs.appendChild(tab('全部', ''));
  for (const c of view.list.conversations) {
    tabs.appendChild(tab(`${convName(view.names, c)} (${c.count})`, `${c.kind}:${c.id}`));
  }
  card.body.appendChild(tabs);

  const bar = ui.rowbar();
  bar.append(
    ui.h('span', 'grow'),
    ui.chip(`本页 ${view.list.events.length}`),
    ui.select({
      value: ctl.limit,
      options: LIMITS.map((n) => ({ value: n, label: `最近 ${n} 条` })),
      onInput: (v) => ctl.setLimit(v),
    }),
    ui.button('↻ 刷新', { size: 'sm', onClick: () => ctl.reload() }),
  );
  card.body.appendChild(bar);

  const table = ui.table({ head: ['#', '类型', '正文'], maxHeight: 'calc(100vh - 360px)' });
  if (!view.list.events.length) table.clear('(无事件)');
  for (const e of view.list.events) {
    table.addRow([
      { text: `#${e.cursor}`, cls: 'mono' },
      { el: ui.pill(TYPE_LABEL[e.type] ?? e.type, 'plain') },
      { text: e.text || '', cls: 'txt' },
    ]);
  }
  card.body.appendChild(table.el);
  return card.el;
}

/** 会话在页签上的名字:能查到就用群名/称呼,否则退回号码。 */
function convName(names: QQConvNames, c: QQConvSummary): string {
  if (c.kind === 'group') {
    const g = names.groups.find((x) => x.id === c.id);
    return `群 ${g?.name || c.id}`;
  }
  const p = names.privates.find((x) => x.id === c.id);
  return `私聊 ${p?.name || c.id}`;
}
