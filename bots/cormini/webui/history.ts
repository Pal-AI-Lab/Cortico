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
        // 状态和提交流水同在一张卡里:第二段用同样的标题样式,中间不再隔一条线
        const card = statusCard(ctx, T, st);
        card.body.append(...commitsSection(ctx, T, st));
        return [card.el];
      },
    });
  },
};

/** 每页条数的选项;缺省 30。 */
const PAGE_SIZES = [15, 30, 60, 100] as const;

/** 仓库的几项事实并排成一行,最近一次提交单独一块。 */
function statusCard(ctx: WebUiPanelContext, T: Text, st: HistoryState): WebUiSheet {
  const { ui } = ctx;
  const card = ui.sheet({ title: T.mediumTitle, en: '.git', desc: T.mediumDesc });
  card.el.classList.add('ct-histsheet');
  const s = st.status;
  if (!s.available || !s.repo) {
    card.body.appendChild(ui.placeholder(gitLine(s, ctx.language)));
    return card;
  }
  const facts = ui.h('div', 'ct-facts');
  const fact = (k: string, v: string | HTMLElement, cls = ''): void => {
    const item = ui.h('div', 'ct-fact');
    const value = ui.h('div', ('ct-fact-v ' + cls).trim());
    value.append(v);
    item.append(ui.h('div', 'ct-fact-k', k), value);
    facts.appendChild(item);
  };
  fact('HEAD', s.head ?? '—', 'mono');
  fact(T.rowWorkspace, s.dirty ? T.dirty : T.clean, s.dirty ? 'is-warn' : '');
  fact(T.rowCheckpoints, s.tags.length ? T.names(s.tags) : T.noCheckpoints, s.tags.length ? '' : 'is-none');
  card.body.appendChild(facts);

  const last = s.lastCommit;
  if (last) {
    const box = ui.h('div', 'ct-lastcommit');
    const meta = ui.h('div', 'ct-commitmeta');
    meta.append(
      ui.h('span', 'hhash', last.hash),
      ui.h('span', '', last.author),
      ui.h('span', '', stamp(last.date)),
    );
    box.append(ui.h('div', 'ct-fact-k', T.rowLastCommit), ui.h('div', 'ct-commitmsg', last.message), meta);
    card.body.appendChild(box);
  }
  return card;
}

/**
 * 提交流水:上面是路径搜索和每页条数,中间是这一页的提交,下面是翻页。
 * 搜索边输入边查(停顿一下才发请求),只换列表,不重画输入框。
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
  if (!PAGE_SIZES.includes(size as typeof PAGE_SIZES[number])) size = 30;

  const search = ui.input({
    type: 'search',
    value: path,
    cls: 'mono',
    placeholder: T.pathFilter,
    onInput: (v) => schedule(v.trim()),
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

  const list = ui.h('div', 'ct-histlist');
  const pager = ui.rowbar();
  pager.classList.add('ct-pager');

  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  ctx.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  function schedule(next: string): void {
    clearTimeout(timer);
    // 停顿一下再问服务端:逐次击键去跑 git log 是白烧 CPU。
    timer = setTimeout(() => { void query(next); }, 300);
  }
  async function query(next: string): Promise<void> {
    if (next === path) return;
    const mine = ++seq;
    try {
      const res = await ctx.invoke<HistoryState>('state', [next]);
      if (mine !== seq || ctx.signal.aborted) return;
      commits = res.commits;
      path = res.path;
      page = 0;
      render();
    } catch (err) {
      if (mine !== seq || ctx.signal.aborted) return;
      list.replaceChildren(ui.placeholder(`${T.historyFailed}: ${errText(err)}`));
      pager.replaceChildren();
    }
  }

  function render(): void {
    list.replaceChildren();
    pager.replaceChildren();
    if (!commits.length) {
      list.appendChild(ui.placeholder(st.status.repo ? T.noCommitsInRange : T.noRepoYet));
      return;
    }
    const pages = Math.max(1, Math.ceil(commits.length / size));
    page = Math.min(page, pages - 1);
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
