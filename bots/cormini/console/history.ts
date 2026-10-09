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
import { workspaceText } from './strings.ts';

type Text = ReturnType<typeof workspaceText>;

interface HistoryState {
  status: MediumStatus;
  commits: Commit[];
  path: string;
}

export const historyPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const T = workspaceText(ctx.language);
    let path = '';
    autoload<HistoryState>(ctx, {
      loading: T.historyLoading,
      failed: T.historyFailed,
      load: () => ctx.invoke<HistoryState>('state', [path]),
      render: (st, reload) => [
        statusCard(ctx, T, st),
        commitsCard(ctx, T, st, (next) => { path = next; reload(); }),
      ],
    });
  },
};

function statusCard(ctx: ConsolePanelContext, T: Text, st: HistoryState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: T.mediumTitle,
    en: '.git',
    desc: T.mediumDesc,
  });
  const rows: Array<{ k: string; v: string | HTMLElement }> = [
    { k: T.rowStatus, v: ui.pill(gitLine(st.status, ctx.language), st.status.repo ? 'on' : 'off') },
    { k: 'HEAD', v: st.status.head ?? '—' },
    { k: T.rowWorkspace, v: st.status.dirty ? T.dirty : T.clean },
    { k: T.rowCheckpoints, v: st.status.tags.length ? T.names(st.status.tags) : T.noCheckpoints },
  ];
  const last = st.status.lastCommit;
  if (last) {
    rows.push({ k: T.rowLastCommit, v: `${last.hash} · ${last.author} · ${stamp(last.date)} · ${last.message}` });
  }
  card.body.appendChild(ui.kv(rows));
  return card.el;
}

function commitsCard(
  ctx: ConsolePanelContext,
  T: Text,
  st: HistoryState,
  setPath: (path: string) => void,
): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: T.logTitle,
    en: 'git log',
    desc: T.logDesc,
  });

  const filter = ui.input({
    value: st.path,
    cls: 'mono',
    placeholder: T.pathFilter,
    // 敲完再问一次服务端:逐次击键去发 git log 是白烧 CPU。
    onCommit: (v) => setPath(v.trim()),
  });
  const bar = ui.rowbar();
  bar.append(filter, ui.button(T.filter, { size: 'sm', onClick: () => setPath(filter.value.trim()) }));
  if (st.path) {
    bar.append(ui.button(T.clear, { size: 'sm', onClick: () => setPath('') }));
  }
  bar.append(ui.h('span', 'grow'), ui.chip(T.commitCount(st.commits.length)));
  card.body.appendChild(bar);

  if (!st.commits.length) {
    card.body.appendChild(ui.placeholder(
      st.status.repo ? T.noCommitsInRange : T.noRepoYet,
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
      detail.replaceChildren(ui.placeholder(T.loadingDiff));
      void ctx.invoke<{ diff: string }>('diff', [c.fullHash, st.path]).then(
        (d) => {
          if (ctx.signal.aborted) return;
          const tools = ui.rowbar();
          tools.append(
            ui.copyButton(() => d.diff, { label: T.copyDiff }),
            ui.h('span', 'grow'),
            ui.h('span', 'ct-dim', c.fullHash),
          );
          detail.replaceChildren(colorDiff(ctx, d.diff), tools);
        },
        (err: unknown) => {
          if (ctx.signal.aborted) return;
          detail.replaceChildren(ui.placeholder(T.diffFailed(errText(err))));
        },
      );
    }, { signal: ctx.signal });
    card.body.append(row, detail);
  }
  card.body.appendChild(dimLine(ctx, T.fullTextHint));
  return card.el;
}
