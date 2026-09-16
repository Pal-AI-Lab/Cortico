/**
 * 工作区 Git 仓库的提交历史与 diff。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import {
  autoload, colorDiff, dimLine, errText, gitLine, stamp,
  type Commit, type MediumStatus,
} from './shared.ts';

interface HistoryState {
  status: MediumStatus;
  commits: Commit[];
  path: string;
}

export const historyPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    let path = '';
    autoload<HistoryState>(ctx, {
      loading: '读取提交历史…',
      failed: '版本历史不可用',
      load: () => ctx.invoke<HistoryState>('state', [path]),
      render: (st, reload) => [
        statusCard(ctx, st),
        commitsCard(ctx, st, (next) => { path = next; reload(); }),
      ],
    });
  },
};

function statusCard(ctx: ConsolePanelContext, st: HistoryState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '介质状态',
    en: '.git',
    desc: '工作区自己是一个 git 仓(与项目仓无关)。控制台的编辑立即提交(署名 operator)。',
  });
  const rows: Array<{ k: string; v: string | HTMLElement }> = [
    { k: '状态', v: ui.pill(gitLine(st.status), st.status.repo ? 'on' : 'off') },
    { k: 'HEAD', v: st.status.head ?? '—' },
    { k: '工作区', v: st.status.dirty ? '有未提交改动' : '干净' },
    { k: '存档点', v: st.status.tags.length ? st.status.tags.join('、') : '(还没有)' },
  ];
  const last = st.status.lastCommit;
  if (last) {
    rows.push({ k: '最近提交', v: `${last.hash} · ${last.author} · ${stamp(last.date)} · ${last.message}` });
  }
  card.body.appendChild(ui.kv(rows));
  return card.el;
}

function commitsCard(
  ctx: ConsolePanelContext,
  st: HistoryState,
  setPath: (path: string) => void,
): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '提交流水',
    en: 'git log',
    desc: '点一条展开它引入的 diff。最多 100 条;填路径可只看某个档案。',
  });

  const filter = ui.input({
    value: st.path,
    cls: 'mono',
    placeholder: '只看某个路径,如 CONSTITUTION.md',
    // 敲完再问一次服务端:逐次击键去发 git log 是白烧 CPU。
    onCommit: (v) => setPath(v.trim()),
  });
  const bar = ui.rowbar();
  bar.append(filter, ui.button('过滤', { size: 'sm', onClick: () => setPath(filter.value.trim()) }));
  if (st.path) {
    bar.append(ui.button('清除', { size: 'sm', onClick: () => setPath('') }));
  }
  bar.append(ui.h('span', 'grow'), ui.chip(`${st.commits.length} 条`));
  card.body.appendChild(bar);

  if (!st.commits.length) {
    card.body.appendChild(ui.placeholder(
      st.status.repo ? '这个范围里还没有提交' : '工作区还没有建仓',
    ));
    return card.el;
  }

  for (const c of st.commits) {
    const row = ui.h('div', 'histrow');
    const head = ui.h('div', 'hh');
    head.append(
      ui.h('span', 'hhash', c.hash),
      ui.h('span', 'hauthor', c.author),
      ui.h('span', 'hdate', stamp(c.date)),
    );
    row.append(head, ui.h('div', 'hmsg', c.message));
    const detail = ui.h('div');
    let open = false;
    row.addEventListener('click', () => {
      if (open) { detail.replaceChildren(); open = false; return; }
      open = true;
      detail.replaceChildren(ui.placeholder('加载 diff…'));
      void ctx.invoke<{ diff: string }>('diff', [c.fullHash, st.path]).then(
        (d) => {
          if (ctx.signal.aborted) return;
          const tools = ui.rowbar();
          tools.append(
            ui.copyButton(() => d.diff, { label: '复制 diff' }),
            ui.h('span', 'grow'),
            ui.h('span', 'ct-dim', c.fullHash),
          );
          detail.replaceChildren(colorDiff(ctx, d.diff), tools);
        },
        (err: unknown) => {
          if (ctx.signal.aborted) return;
          detail.replaceChildren(ui.placeholder(`diff 失败: ${errText(err)}`));
        },
      );
    }, { signal: ctx.signal });
    card.body.append(row, detail);
  }
  card.body.appendChild(dimLine(ctx, '想看某个版本的全文,去「工作区」打开那份档案再按「历史」。'));
  return card.el;
}
