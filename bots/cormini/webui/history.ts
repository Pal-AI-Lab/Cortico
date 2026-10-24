/**
 * 工作区 Git 仓库的提交历史与 diff。
 */

import type {
  WebUiPanelContext,
  WebUiPanel,
  WebUiSheet,
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

export const historyPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const T = workspaceText(ctx.language);
    autoload<HistoryState>(ctx, {
      loading: T.historyLoading,
      failed: T.historyFailed,
      load: () => ctx.invoke<HistoryState>('state', ['']),
      render: (st) => {
        const card = statusCard(ctx, T, st);
        if (st.status.available && st.status.repo) card.body.append(...commitsSection(ctx, T, st));
        return [card.el];
      },
    });
  },
};

const PAGE_SIZES = [15, 30, 60, 100];

function statusCard(ctx: WebUiPanelContext, T: Text, st: HistoryState): WebUiSheet {
  const { ui } = ctx;
  const card = ui.sheet({ title: T.rowLastCommit, en: 'HEAD' });
  card.el.classList.add('ct-histsheet');
  const s = st.status;
  if (!s.available || !s.repo) {
    card.body.appendChild(ui.placeholder(gitLine(s, ctx.language)));
    return card;
  }
  const last = s.lastCommit;
  if (last) {
    const box = ui.h('div', 'ct-lastcommit');
    const meta = ui.h('div', 'ct-commitmeta');
    meta.append(
      ui.h('span', 'hhash', last.hash),
      ui.h('span', '', last.author),
      ui.h('span', '', stamp(last.date)),
    );
    box.append(ui.h('div', 'ct-commitmsg', last.message), meta);
    card.body.appendChild(box);
  }
  return card;
}

/**
 * 路径过滤在回车时向服务端查一次:git log 在 bot 进程里同步执行,大仓一次要几百毫秒到几秒。
 * 服务端一次给最近若干条,翻页在前端做。
 */
function commitsSection(ctx: WebUiPanelContext, T: Text, st: HistoryState): HTMLElement[] {
  const { ui } = ctx;
  const title = ui.h('h3', 'ct-logtitle', T.logTitle);
  title.appendChild(ui.h('span', 'en', 'git log'));
  const desc = ui.h('div', 'sh-desc', T.logDesc);

  let commits = st.commits;
  let path = st.path;
  let page = 0;
  let size = ctx.memo.get<number>('hist.pageSize', 30);

  const search = ui.input({
    value: path,
    cls: 'mono',
    placeholder: T.pathFilter,
    onCommit: (v) => { void query(v.trim()); },
  });
  search.classList.add('ct-histsearch');
  const sizeLabel = ui.h('label', 'ct-pagesize');
  sizeLabel.append(
    ui.h('span', '', T.perPage),
    ui.select({
      value: String(size),
      options: PAGE_SIZES.map((n) => String(n)),
      onChange: (v) => { size = Number(v); ctx.memo.set('hist.pageSize', size); page = 0; render(); },
    }),
  );
  const top = ui.rowbar();
  top.classList.add('ct-histbar');
  top.append(search, ui.h('span', 'grow'), sizeLabel);

  const list = ui.h('div');
  const pager = ui.rowbar();
  pager.classList.add('ct-pager');

  async function query(next: string): Promise<void> {
    try {
      const res = await ctx.invoke<HistoryState>('state', [next]);
      if (ctx.signal.aborted) return;
      commits = res.commits;
      path = res.path;
      page = 0;
      render();
    } catch (err) {
      if (ctx.signal.aborted) return;
      list.replaceChildren(ui.placeholder(`${T.historyFailed}: ${errText(err)}`));
      pager.replaceChildren();
    }
  }

  function render(): void {
    list.replaceChildren();
    pager.replaceChildren();
    if (!commits.length) {
      list.appendChild(ui.placeholder(T.noCommitsInRange));
      return;
    }
    const pages = Math.ceil(commits.length / size);
    const from = page * size;
    const shown = commits.slice(from, from + size);
    for (const c of shown) list.append(...commitRow(ctx, T, c, path));

    pager.append(ui.h('span', 'ct-dim', T.shown(from + 1, from + shown.length, commits.length)), ui.h('span', 'grow'));
    if (pages > 1) {
      const prev = ui.button(T.prevPage, { size: 'sm', onClick: () => { page -= 1; render(); } });
      const next = ui.button(T.nextPage, { size: 'sm', onClick: () => { page += 1; render(); } });
      prev.disabled = page === 0;
      next.disabled = page === pages - 1;
      pager.append(prev, ui.h('span', 'ct-pageof', T.pageOf(page + 1, pages)), next);
    }
  }
  render();
  return [title, desc, top, list, pager, dimLine(ctx, T.fullTextHint)];
}

/** 一条提交和它下面展开 diff 的位置。 */
function commitRow(ctx: WebUiPanelContext, T: Text, c: Commit, path: string): HTMLElement[] {
  const { ui } = ctx;
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
    void ctx.invoke<{ diff: string }>('diff', [c.fullHash, path]).then(
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
  return [row, detail];
}
