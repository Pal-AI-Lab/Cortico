/**
 * 工作区、人物档案与宪法的记忆概览。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import { autoload, dimLine } from '../../cormini/console/shared.ts';

export interface ViewerArchive {
  source: string;
  path: string;
  summary: string;
}

export interface MemoryState {
  workspaceFiles: number;
  topLevel: string[];
  constitutionChars: number;
  viewers: {
    total: number;
    bySource: Array<{ source: string; count: number }>;
    archives: ViewerArchive[];
    truncated: boolean;
  };
  note: string;
}

export const memoryPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    autoload<MemoryState>(ctx, {
      loading: '读取记忆概览…',
      failed: 'Memory 视图不可用',
      load: () => ctx.invoke<MemoryState>('state'),
      render: (st) => [overviewCard(ctx, st), viewersCard(ctx, st), noteCard(ctx, st)],
    });
  },
};

function overviewCard(ctx: ConsolePanelContext, st: MemoryState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '工作区',
    en: 'workspace/',
    desc: '她自己写的记忆文件。人物档案在 viewers/ 下按来源分目录;宪法是长期原则。',
  });
  card.body.appendChild(ui.statgrid([
    { k: '文件', v: st.workspaceFiles, unit: '个', accent: true },
    { k: '人物档案', v: st.viewers.total, unit: '份' },
    { k: '宪法', v: st.constitutionChars, unit: '字' },
  ]));
  if (st.topLevel.length) {
    const box = ui.h('div', 'ct-chips');
    for (const name of st.topLevel) box.appendChild(ui.chip(name));
    card.body.appendChild(box);
  } else {
    card.body.appendChild(ui.placeholder('workspace/ 是空的'));
  }
  return card.el;
}

function viewersCard(ctx: ConsolePanelContext, st: MemoryState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '人物档案',
    en: 'viewers/<来源>/<ID>.md',
    desc: '首行是一句话摘要,本 session 首次出现时会自动唤起。点开「工作区」可以改任何一份。',
  });
  if (st.viewers.bySource.length) {
    card.body.appendChild(ui.statgrid(
      st.viewers.bySource.map((s) => ({ k: s.source, v: s.count, unit: '份' })),
    ));
  }
  if (!st.viewers.archives.length) {
    card.body.appendChild(ui.placeholder('还没有人物档案'));
    return card.el;
  }
  const table = ui.table({ head: ['档案', '首行摘要'] });
  for (const a of st.viewers.archives) {
    table.addRow([
      { text: a.path, cls: 'mono' },
      { text: a.summary || '(空)', cls: 'txt' },
    ]);
  }
  card.body.appendChild(table.el);
  if (st.viewers.truncated) {
    card.body.appendChild(dimLine(ctx, `只列出前 ${st.viewers.archives.length} 份;全量在工作区树里。`));
  }
  return card.el;
}

function noteCard(ctx: ConsolePanelContext, st: MemoryState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '记忆约定',
    en: 'prefix note',
    desc: '前缀里那一段机制说明,不是花名册。',
  });
  card.body.appendChild(ui.h('pre', 'ct-note', st.note));
  return card.el;
}
