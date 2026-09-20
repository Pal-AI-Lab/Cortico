/** 扩展管理页。扩展信息与运行状态由服务端提供；安装、卸载后需重启进程才能生效。 */

import { get, post } from '../../core/api.ts';
import { pageIntro } from '../../ui/page.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { S } from './strings.ts';

/** 扩展类别。与 `ExtensionKind` 同形;这一页只用它分组与选关键字。 */
export type ExtensionKindView = 'world' | 'provider' | 'bot';

/** 与 `src/web/server.ts` 的 `ExtensionInfo` 同形。 */
export interface ExtensionView {
  name: string;
  spec: string;
  version: string | null;
  description?: string;
  kind?: ExtensionKindView;
  api?: number;
  consoleClient: boolean;
  console?: 'none' | 'served' | 'missing';
  loaded: boolean;
  reason?: string;
  worldId?: string;
  label?: string;
  state: 'loaded' | 'failed' | 'pending-restart' | 'removed' | 'idle';
}

/** 与 `ExtensionSearchHit` 同形。 */
export interface SearchHitView {
  name: string;
  version: string;
  description: string;
  date?: string;
  publisher?: string;
  license?: string;
  keywords?: string[];
  downloads: number;
  dependents: number;
  links: { npm?: string; repository?: string; homepage?: string };
  installed: boolean;
  kind?: ExtensionKindView;
}

/** 与 `ExtensionPackageDetail` 同形。点开一张结果卡时才取。 */
export interface PackageDetailView {
  name: string;
  version: string;
  description?: string;
  license?: string;
  keywords?: string[];
  published?: string;
  created?: string;
  versionCount: number;
  history: Array<{ version: string; date: string }>;
  deprecated?: string;
  manifest?: { kind: ExtensionKindView; api: number; consoleClient?: string; consoleStyle?: string };
  problems?: string[];
  warnings: string[];
  frameworkApi: number;
  engines?: string;
  unpackedSize?: number;
  fileCount?: number;
  dependencies: string[];
  maintainers: string[];
  publisher?: string;
  links: { npm: string; repository?: string; homepage?: string; bugs?: string };
  installed: boolean;
  installedSpec?: string;
}

/** 结果的排序口径。npm 自己的相关度不在其中:同一关键字下的包它给的分全是 0。 */
export type HitSort = 'downloads' | 'date' | 'name' | 'dependents';
export const HIT_SORTS: readonly HitSort[] = ['downloads', 'date', 'name', 'dependents'];

/** 一页放几张卡。 */
export const HITS_PER_PAGE = 12;

export interface ArrangeOptions {
  filter: string;
  hideInstalled: boolean;
  sort: HitSort;
  page: number;
  pageSize: number;
}

/**
 * 在整份结果上筛选、排序、切页。registry 的搜索端点在 `keywords:` 过滤下不按文本
 * 缩小结果,所以文本匹配在这里做:包名、描述、关键字任一命中即算。
 * `page` 超出范围时收回最后一页,返回值里的 `page` 是实际用的那一页。
 */
export function arrangeHits(
  hits: readonly SearchHitView[],
  opts: ArrangeOptions,
): { matched: number; pages: number; page: number; shown: SearchHitView[] } {
  const needle = opts.filter.trim().toLowerCase();
  const matched = hits.filter((h) => {
    if (opts.hideInstalled && h.installed) return false;
    if (!needle) return true;
    return h.name.toLowerCase().includes(needle)
      || h.description.toLowerCase().includes(needle)
      || (h.keywords ?? []).some((k) => k.toLowerCase().includes(needle));
  });
  matched.sort((a, b) => {
    switch (opts.sort) {
      case 'downloads': return b.downloads - a.downloads || a.name.localeCompare(b.name);
      // 发布时间是 ISO 串,按串比就是按时间比;没有日期的排在最后
      case 'date': return (b.date ?? '').localeCompare(a.date ?? '') || a.name.localeCompare(b.name);
      case 'dependents': return b.dependents - a.dependents || a.name.localeCompare(b.name);
      default: return a.name.localeCompare(b.name);
    }
  });
  const pages = Math.max(1, Math.ceil(matched.length / opts.pageSize));
  const page = Math.min(Math.max(opts.page, 0), pages - 1);
  return { matched: matched.length, pages, page, shown: matched.slice(page * opts.pageSize, (page + 1) * opts.pageSize) };
}

interface PowerReport {
  ok?: boolean;
  localComplete?: boolean;
  result?: string;
  error?: string;
  steps?: Array<{ label: string; ok: boolean; elapsedMs: number; detail?: string }>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/**
 * 手动安装框里的一行:含路径分隔符或以 `.` 开头的当本机目录,其余按 `name[@version]`
 * 拆(作用域包的第一个 `@` 是名字的一部分)。
 */
export function parseInstallInput(raw: string): { name: string; version?: string } | { path: string } | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('.') || text.includes('/') && !text.startsWith('@') || text.includes('\\') || /^[A-Za-z]:/.test(text)) {
    return { path: text };
  }
  const at = text.indexOf('@', 1);
  if (at < 0) return { name: text };
  return { name: text.slice(0, at), version: text.slice(at + 1) };
}

const STATE_LABEL: Record<ExtensionView['state'], string> = {
  loaded: S.stateLoaded,
  failed: S.stateFailed,
  'pending-restart': S.statePendingRestart,
  removed: S.stateRemoved,
  idle: S.stateIdle,
};

const KIND_LABEL: Record<ExtensionKindView, string> = {
  world: 'World',
  provider: 'LLM Provider',
  bot: 'Bot',
};

/** 卡片副标题里 id 前面的那个词。 */
const KIND_NOUN: Record<ExtensionKindView, string> = {
  world: 'World',
  provider: 'provider',
  bot: 'bot',
};

/** npm 上按类发现用的关键字。与 `src/extensions/manifest.ts` 的 `EXTENSION_KEYWORDS` 对齐。 */
const KIND_KEYWORD: Record<ExtensionKindView, string> = {
  world: 'cortico-world',
  provider: 'cortico-provider',
  bot: 'cortico-bot',
};

/** 已安装清单的分组。`kind` 为 null 的一组收所有读不出 manifest 的包。 */
const GROUPS: ReadonlyArray<{ kind: ExtensionKindView | null; title: string; desc: string }> = [
  { kind: 'world', title: KIND_LABEL.world, desc: S.groupWorldDesc },
  { kind: 'provider', title: KIND_LABEL.provider, desc: S.groupProviderDesc },
  { kind: 'bot', title: KIND_LABEL.bot, desc: S.groupBotDesc },
  { kind: null, title: S.groupUnknownTitle, desc: S.groupUnknownDesc },
];

export function mountExtensions(ctx: FeatureContext): void {
  const { ui, root } = ctx;
  const view = root.ownerDocument?.defaultView ?? null;
  const canRestart = ctx.capabilities.restart === true;
  const supervised = ctx.capabilities.supervised === true;

  const intro = pageIntro(ui, S.introTitle, S.introDesc);

  // -------------------------------------------------------------------------
  // 已安装
  // -------------------------------------------------------------------------

  const installedSheet = ui.sheet({
    title: S.installedTitle,
    en: 'extensions/',
  });
  const sumBar = ui.rowbar();
  const msg = ui.msgline();
  const refreshBtn = ui.button(S.refresh, { size: 'sm', onClick: () => void load() });
  const restartBtn = ui.button(S.restartProcess, {
    size: 'sm',
    variant: 'primary',
    onClick: (ev) => void restartProcess(ev.currentTarget as HTMLButtonElement),
  });
  installedSheet.body.append(sumBar, msg);
  /** 分组容器:每组一条 section 标题 + 一张 `.iogrid`。 */
  const installedGroups = ui.h('div');

  function setMsg(text: string, bad?: boolean): void {
    msg.textContent = text;
    msg.className = 'msgline' + (bad ? ' bad' : '');
  }

  /**
   * 重启 = 落标志 + 规范关机。没有启动器循环时它就是一次关机,确认框上说清楚。
   * `confirmed` = 调用方已经问过一遍(装完那一问),不再重复。
   */
  async function restartProcess(btn?: HTMLButtonElement, confirmed = false): Promise<void> {
    if (!canRestart) return;
    if (!confirmed) {
      const ok = await ui.confirm({
        title: supervised ? S.restartConfirmTitle : S.restartNoLoopTitle,
        body: supervised ? S.restartConfirmBody : S.restartNoLoopBody,
        danger: !supervised,
      });
      if (!ok || ctx.signal.aborted) return;
    }
    const lock = btn ? ui.disable(btn) : null;
    const hold = ui.toast(S.finishingToast);
    try {
      const out = await post<PowerReport>('/api/run/restart', undefined, { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      if (out?.error) throw new Error(out.error);
      const lines = (out?.steps ?? []).map((s) =>
        `${s.ok ? '✓' : '✗'} ${s.label} · ${(s.elapsedMs / 1000).toFixed(1)}s${s.ok ? '' : ` — ${s.detail ?? S.stepIncomplete}`}`);
      void ui.confirm({
        title: supervised ? S.doneRestartSupervised : S.doneRestart,
        body: [out?.result ?? S.resultDefault, '', ...lines].join('\n'),
      });
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      // 连接在收尾途中断掉是预期之一:进程退出得比回执快。
      ui.toast(S.noReceipt(errText(err)), 'bad');
    } finally {
      hold.dispose();
      lock?.dispose();
    }
  }

  async function uninstall(p: ExtensionView, btn: HTMLButtonElement): Promise<void> {
    const ok = await ui.confirm({
      title: S.uninstallTitle(p.label || p.name),
      body: S.uninstallBody(p.name),
      danger: true,
    });
    if (!ok || ctx.signal.aborted) return;
    const lock = ui.disable(btn);
    const hold = ui.toast(S.uninstalling);
    try {
      const out = await post<{ result?: string }>('/api/extensions/uninstall', { name: p.name }, { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      setMsg(out?.result?.split('\n')[0] || S.uninstalled);
      markHit(p.name, false);
      await load();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      setMsg(S.uninstallFailed(errText(err)), true);
    } finally {
      hold.dispose();
      lock.dispose();
    }
  }

  /** 装完问一句要不要顺手重启;答"否"也留在清单里标「待重启」。 */
  /** 返回值是"装上了没有":搜索结果与详细页按它更新自己的已安装标记。 */
  async function install(target: { name: string; version?: string } | { path: string }, btn?: HTMLButtonElement): Promise<boolean> {
    const lock = btn ? ui.disable(btn) : null;
    const hold = ui.toast(S.installing);
    let result = '';
    try {
      const out = await post<{ result?: string }>('/api/extensions/install', target, { signal: ctx.signal });
      if (ctx.signal.aborted) return false;
      result = out?.result ?? S.installed;
      setMsg(result.split('\n')[0]);
      if ('name' in target) markHit(target.name, true);
      await load();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return false;
      setMsg(S.installFailed(errText(err)), true);
      return false;
    } finally {
      hold.dispose();
      lock?.dispose();
    }
    if (!canRestart) return true;
    const go = await ui.confirm({
      title: S.installedRestartTitle,
      body: result + '\n\n' + (supervised ? S.installedRestartNote : S.installedNoLoopNote),
      danger: !supervised,
    });
    if (!go || ctx.signal.aborted) return true;
    await restartProcess(undefined, true);
    return true;
  }

  function extensionCard(p: ExtensionView): HTMLElement {
    const en = `${p.name}@${p.version ?? '?'}${p.worldId && p.kind ? ` · ${KIND_NOUN[p.kind]} ${p.worldId}` : ''}`;
    const card = ui.sheet({ title: p.label || p.name, en });
    card.el.classList.add('iocard');
    if (p.state !== 'loaded') card.el.classList.add('iocard-inactive');
    const bar = ui.rowbar();
    bar.append(ui.pill(STATE_LABEL[p.state], p.state === 'loaded' ? 'on' : 'off'));
    if (p.kind) bar.appendChild(ui.pill(KIND_LABEL[p.kind]));
    if (p.api !== undefined) bar.appendChild(ui.chip(`v${p.api}`));
    if (p.console === 'served') bar.appendChild(ui.pill(S.panelLoaded, 'on'));
    card.body.appendChild(bar);
    if (p.description) card.body.appendChild(ui.msgline(p.description));
    if (p.reason) card.body.appendChild(ui.msgline(p.reason, true));
    if (p.state === 'idle') card.body.appendChild(ui.msgline(S.noteIdle));
    if (p.console === 'missing') card.body.appendChild(ui.msgline(S.noteConsoleMissing, true));
    if (p.state !== 'removed') {
      const actions = ui.actions();
      actions.appendChild(ui.button(S.uninstall, {
        size: 'sm',
        variant: 'danger',
        onClick: (ev) => void uninstall(p, ev.currentTarget as HTMLButtonElement),
      }));
      card.body.appendChild(actions);
    }
    return card.el;
  }

  function renderInstalled(extensions: readonly ExtensionView[], dir: string): void {
    sumBar.replaceChildren();
    installedGroups.replaceChildren();
    const loaded = extensions.filter((p) => p.state === 'loaded').length;
    const pending = extensions.filter((p) => p.state === 'pending-restart' || p.state === 'removed').length;
    const failed = extensions.filter((p) => p.state === 'failed').length;
    sumBar.appendChild(ui.pill(S.sumLoaded(loaded), 'on'));
    if (pending > 0) sumBar.appendChild(ui.pill(S.sumPending(pending), 'off'));
    if (failed > 0) sumBar.appendChild(ui.pill(S.sumFailed(failed), 'off'));
    sumBar.appendChild(ui.chip(dir));
    sumBar.append(ui.h('span', 'grow'), refreshBtn);
    if (canRestart) sumBar.appendChild(restartBtn);
    if (extensions.length === 0) {
      installedGroups.appendChild(ui.placeholder(S.noExtensions));
      return;
    }
    for (const g of GROUPS) {
      const mine = extensions.filter((p) => (p.kind ?? null) === g.kind);
      if (mine.length === 0) continue;
      const grid = ui.h('div', 'iogrid');
      for (const p of mine) grid.appendChild(extensionCard(p));
      installedGroups.append(ui.section(g.title, g.desc), grid);
    }
  }

  async function load(): Promise<void> {
    try {
      const data = await get<{ dir?: string; extensions?: ExtensionView[] }>('/api/extensions', { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      renderInstalled(Array.isArray(data?.extensions) ? data.extensions : [], data?.dir ?? '');
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      installedGroups.replaceChildren(ui.placeholder(S.listLoadFailed(errText(err))));
    }
  }

  // -------------------------------------------------------------------------
  // 搜索 npm
  // -------------------------------------------------------------------------

  const searchSheet = ui.sheet({
    title: S.searchTitle,
    en: 'npm registry',
    desc: S.searchDesc,
  });
  let searchKind: ExtensionKindView = 'world';
  /** 当前这一类在 npm 上的全部包。筛选、排序、分页都在它上面做,不再往 registry 跑。 */
  let allHits: SearchHitView[] = [];
  let filter = '';
  let sort: HitSort = 'downloads';
  let hideInstalled = false;
  let page = 0;

  const searchBar = ui.rowbar();
  const kindSeg = ui.segmented(
    [
      { value: 'world', label: KIND_LABEL.world },
      { value: 'provider', label: KIND_LABEL.provider },
      { value: 'bot', label: KIND_LABEL.bot },
    ],
    {
      size: 'sm',
      value: searchKind,
      onSelect: (v) => {
        searchKind = v as ExtensionKindView;
        paintKeyword();
        void search();
      },
    },
  );
  const filterInput = ui.input({
    type: 'search',
    placeholder: S.filterPlaceholder,
    onInput: (v) => {
      filter = v;
      page = 0;
      renderHits();
    },
  });
  const sortSelect = ui.select({
    value: sort,
    options: HIT_SORTS.map((value) => ({ value, label: S.sortLabel[value] })),
    onChange: (v) => {
      sort = v as HitSort;
      page = 0;
      renderHits();
    },
  });
  const hideBox = ui.checkbox(S.hideInstalled, {
    checked: hideInstalled,
    onChange: (on) => {
      hideInstalled = on;
      page = 0;
      renderHits();
    },
  });
  const searchBtn = ui.button(S.refresh, { size: 'sm', onClick: () => void search() });
  searchBar.append(kindSeg.el, filterInput, sortSelect, hideBox.el);
  // 关键字说明与重取键共一行:上面那行控件已经占满,刷新键挤下去会单独占一行
  const keywordBar = ui.rowbar();
  const keywordLine = ui.msgline();
  function paintKeyword(): void {
    keywordLine.textContent = S.searchKeywordNote(KIND_KEYWORD[searchKind]);
  }
  paintKeyword();
  keywordBar.append(keywordLine, ui.h('span', 'grow'), searchBtn);
  const searchMsg = ui.msgline();
  const resultGrid = ui.h('div', 'iogrid');
  const pager = ui.rowbar();
  searchSheet.body.append(searchBar, keywordBar, searchMsg, resultGrid, pager);

  function openLink(href: string): void {
    view?.open(href, '_blank', 'noopener');
  }

  /** 结果卡只放搜索端点给得起的那几项；契约版本、体积、版本史等着操作员点开再取。 */
  function hitCard(h: SearchHitView): HTMLElement {
    const card = ui.sheet({ title: h.name, en: S.hitMeta(h.version, ui.fmt.count(h.downloads), h.publisher) });
    card.el.classList.add('iocard', 'iocard-open');
    if (h.installed) card.el.classList.add('is-installed');
    card.el.tabIndex = 0;
    card.el.setAttribute('role', 'button');
    card.el.title = S.openDetail;
    // 描述走中性灰(与 provider 卡一致),msgline 的绿留给状态
    if (h.description) card.body.appendChild(ui.h('div', 'tdesc', h.description));
    const bar = ui.rowbar();
    if (h.installed) bar.appendChild(ui.pill(S.alreadyInstalled, 'on'));
    if (h.license) bar.appendChild(ui.chip(h.license));
    if (h.date) bar.appendChild(ui.chip(h.date.slice(0, 10)));
    if (h.dependents > 0) bar.appendChild(ui.chip(S.dependents(h.dependents)));
    card.body.appendChild(bar);
    const open = (): void => openDetail(h);
    card.el.addEventListener('click', open, { signal: ctx.signal });
    card.el.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    }, { signal: ctx.signal });
    return card.el;
  }

  /** 筛选、排序、翻页一次画完,含结果计数与页脚。 */
  function renderHits(): void {
    const arranged = arrangeHits(allHits, { filter, hideInstalled, sort, page, pageSize: HITS_PER_PAGE });
    page = arranged.page;
    resultGrid.replaceChildren();
    for (const h of arranged.shown) resultGrid.appendChild(hitCard(h));
    if (arranged.matched === 0) {
      resultGrid.appendChild(ui.placeholder(allHits.length === 0 ? S.noPackages : S.noHits));
    }
    searchMsg.className = 'msgline';
    searchMsg.textContent = arranged.matched === allHits.length
      ? S.hitCount(allHits.length)
      : S.hitCountFiltered(arranged.matched, allHits.length);

    pager.replaceChildren();
    if (arranged.pages <= 1) return;
    const prev = ui.button(S.prevPage, { size: 'sm', onClick: () => { page -= 1; renderHits(); } });
    const next = ui.button(S.nextPage, { size: 'sm', onClick: () => { page += 1; renderHits(); } });
    prev.disabled = arranged.page === 0;
    next.disabled = arranged.page >= arranged.pages - 1;
    pager.append(prev, ui.chip(S.pageOf(arranged.page + 1, arranged.pages)), next);
  }

  /** 装完、卸完之后就地更新这一份结果里的已安装标记,不必再往 registry 跑一趟。 */
  function markHit(name: string, installed: boolean): void {
    let touched = false;
    for (const h of allHits) if (h.name === name && h.installed !== installed) { h.installed = installed; touched = true; }
    if (touched) renderHits();
  }

  async function search(): Promise<void> {
    const lock = ui.disable(searchBtn);
    searchMsg.textContent = S.searching;
    searchMsg.className = 'msgline';
    // 换了类就换了关键字:上一类的命中留在屏幕上会被当成这一类的结果
    resultGrid.replaceChildren();
    pager.replaceChildren();
    allHits = [];
    page = 0;
    try {
      const data = await get<{ hits?: SearchHitView[] }>(
        `/api/extensions/search?kind=${searchKind}`,
        { signal: ctx.signal },
      );
      if (ctx.signal.aborted) return;
      allHits = Array.isArray(data?.hits) ? data.hits : [];
      renderHits();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      searchMsg.textContent = S.searchFailed(errText(err));
      searchMsg.className = 'msgline bad';
    } finally {
      lock.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 一个包的详细页
  // -------------------------------------------------------------------------

  /** 抽屉正文。契约版本、体积、依赖、版本史只有这里有,来自 /api/extensions/package。 */
  function detailBody(d: PackageDetailView, hit: SearchHitView): HTMLElement {
    const box = ui.h('div');
    const bar = ui.rowbar();
    if (d.manifest) {
      bar.appendChild(ui.pill(KIND_LABEL[d.manifest.kind]));
      bar.appendChild(ui.pill(S.apiPill(d.manifest.api), d.manifest.api === d.frameworkApi ? 'on' : 'off'));
      if (d.manifest.consoleClient) bar.appendChild(ui.pill(S.hasPanel, 'on'));
    } else {
      bar.appendChild(ui.pill(S.notLoadable, 'off'));
    }
    if (d.installed) bar.appendChild(ui.pill(d.installedSpec ? S.installedSpec(d.installedSpec) : S.alreadyInstalled, 'on'));
    box.appendChild(bar);

    if (d.description) box.appendChild(ui.h('div', 'tdesc', d.description));
    if (d.deprecated) box.appendChild(ui.msgline(S.deprecated(d.deprecated), true));
    for (const p of d.problems ?? []) box.appendChild(ui.msgline(p, true));
    for (const w of d.warnings ?? []) box.appendChild(ui.msgline(w));

    const rows: Array<{ k: string; v: string }> = [
      { k: S.fieldVersion, v: `${d.version}${d.published ? ` · ${d.published.slice(0, 10)}` : ''}` },
      { k: S.fieldReleases, v: S.releaseCount(d.versionCount, d.created ? d.created.slice(0, 10) : '') },
    ];
    if (d.history.length > 1) {
      rows.push({ k: S.fieldHistory, v: d.history.map((h) => `${h.version} ${h.date.slice(0, 10)}`).join('   ') });
    }
    if (d.license) rows.push({ k: S.fieldLicense, v: d.license });
    if (d.unpackedSize) rows.push({ k: S.fieldSize, v: S.sizeAndFiles(ui.fmt.bytes(d.unpackedSize), d.fileCount ?? 0) });
    if (d.engines) rows.push({ k: S.fieldNode, v: d.engines });
    rows.push({ k: S.fieldDeps, v: d.dependencies.length ? d.dependencies.join(', ') : S.none });
    rows.push({ k: S.fieldDownloads, v: S.perMonth(ui.fmt.count(hit.downloads)) });
    if (hit.dependents > 0) rows.push({ k: S.fieldDependents, v: String(hit.dependents) });
    if (d.maintainers.length) rows.push({ k: S.fieldMaintainers, v: d.maintainers.join(', ') });
    if (d.keywords?.length) rows.push({ k: S.fieldKeywords, v: d.keywords.join(', ') });
    box.appendChild(ui.kv(rows));

    const actions = ui.actions();
    const links: Array<[string, string | undefined]> = [
      ['npm', d.links.npm],
      [S.linkRepo, d.links.repository],
      [S.linkHome, d.links.homepage],
      [S.linkBugs, d.links.bugs],
    ];
    for (const [label, href] of links) {
      if (href) actions.appendChild(ui.button(label, { size: 'sm', onClick: () => openLink(href) }));
    }
    actions.appendChild(ui.h('span', 'grow'));
    // 契约版本对不上还是可以装(操作员也许就是要先装上再升级框架),但按钮按危险样式给
    const loadable = d.manifest !== undefined && d.manifest.api === d.frameworkApi;
    const installBtn = ui.button(d.installed ? S.alreadyInstalled : S.install, {
      size: 'sm',
      variant: loadable ? 'primary' : 'danger',
      onClick: async (ev) => {
        const ok = await install({ name: d.name, version: d.version }, ev.currentTarget as HTMLButtonElement);
        if (!ok) return;
        installBtn.disabled = true;
        installBtn.textContent = S.alreadyInstalled;
      },
    });
    installBtn.disabled = d.installed;
    actions.appendChild(installBtn);
    box.appendChild(actions);
    return box;
  }

  /** 点开一张卡:先开抽屉再取详情,registry 慢的时候抽屉里是"读取中"而不是空白。 */
  function openDetail(hit: SearchHitView): void {
    const box = ui.h('div');
    box.appendChild(ui.placeholder(S.loadingDetail));
    ui.drawer(hit.name, box);
    void (async () => {
      try {
        const d = await get<PackageDetailView>(
          `/api/extensions/package?name=${encodeURIComponent(hit.name)}`,
          { signal: ctx.signal },
        );
        if (ctx.signal.aborted) return;
        box.replaceChildren(detailBody(d, hit));
      } catch (err) {
        if (isAbort(err) || ctx.signal.aborted) return;
        box.replaceChildren(ui.msgline(S.detailFailed(errText(err)), true));
      }
    })();
  }

  // -------------------------------------------------------------------------
  // 手动安装
  // -------------------------------------------------------------------------

  const manualSheet = ui.sheet({
    title: S.manualTitle,
    en: 'name@version · ./path',
    desc: S.manualDesc,
  });
  const manualBar = ui.rowbar();
  const manualInput = ui.input({ cls: 'mono', placeholder: S.manualPlaceholder });
  const manualBtn = ui.button(S.install, {
    size: 'sm',
    variant: 'primary',
    onClick: (ev) => {
      const target = parseInstallInput(manualInput.value);
      if (!target) { setMsg(S.manualEmpty, true); return; }
      void install(target, ev.currentTarget as HTMLButtonElement);
    },
  });
  manualBar.append(manualInput, manualBtn);
  manualSheet.body.append(manualBar);

  root.append(intro, installedSheet.el, installedGroups, searchSheet.el, manualSheet.el);
  installedGroups.appendChild(ui.placeholder(S.loading));
  void load();
  // 这一类在 npm 上的包一进页就列出来:筛选与排序都在整份结果上做,没有「先搜一下」这一步
  void search();
}

export const extensionsFeature: FrameworkFeature = {
  route: 'extensions',
  label: S.navLabel,
  icon: 'download',
  navGroup: S.navGroup,
  needsAny: ['extensions'],
  mount: mountExtensions,
};
