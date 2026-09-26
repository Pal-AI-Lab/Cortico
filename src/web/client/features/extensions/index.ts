/**
 * 扩展管理页。按类别分页签(路由第二段),每类是已安装、扩展市场与手动安装。
 * 扩展信息与运行状态由服务端提供；安装、卸载后需重启进程才能生效，重启后本页等新进程就绪再刷新。
 */

import { get, post, pickPath } from '../../core/api.ts';
import { brandMark } from '../../ui/icons.ts';
import { pageIntro } from '../../ui/page.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { S } from './strings.ts';

/** 扩展类别。与 `ExtensionKind` 同形;这一页只用它分组与选关键字。 */
export type ExtensionKindView = 'world' | 'provider' | 'bot';

/** 与 `src/web/server.ts` 的 `ExtensionInfo` 同形。 */
export interface ExtensionView {
  metadata?: Partial<PackageDetailView>;
  builtin?: boolean;
  location?: string;
  name: string;
  spec: string;
  version: string | null;
  installedVersion?: string | null;
  author?: string;
  description?: string;
  kind?: ExtensionKindView;
  api?: number;
  consoleClient: boolean;
  console?: 'none' | 'served' | 'missing';
  loaded: boolean;
  reason?: string;
  worldId?: string;
  label?: string;
  enabled?: boolean;
  hidden?: boolean;
  state: 'loaded' | 'failed' | 'pending-restart' | 'removed' | 'idle';
}

interface UpdateView {
  name: string;
  installedVersion: string;
  latestVersion: string;
  problems: string[];
}

interface UpdateResultView {
  updates: UpdateView[];
  errors: Array<{ name: string; error: string }>;
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

/** 与 `ExtensionPackageDetail` 同形。 */
export interface PackageDetailView {
  displayName?: string;
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
  links: { npm?: string; repository?: string; homepage?: string; bugs?: string };
  installed: boolean;
  installedSpec?: string;
}

/** 结果的排序口径。npm 自己的相关度不在其中:同一关键字下的包它给的分全是 0。 */
export type HitSort = 'downloads' | 'date' | 'name';
export const HIT_SORTS: readonly HitSort[] = ['name', 'date', 'downloads'];

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
      default: return a.name.localeCompare(b.name);
    }
  });
  const pages = Math.max(1, Math.ceil(matched.length / opts.pageSize));
  const page = Math.min(Math.max(opts.page, 0), pages - 1);
  return { matched: matched.length, pages, page, shown: matched.slice(page * opts.pageSize, (page + 1) * opts.pageSize) };
}

type Target = { name: string; version?: string } | { path: string };
interface Life { deployment: string; bootId: string; ready: boolean }
interface PowerReport { result?: string; error?: string; steps?: Array<{ label: string; ok: boolean; elapsedMs: number; detail?: string }> }
/** 重启后轮询到的进程:同一部署、换了 bootId 且就绪才算回来了。 */
export function restartOutcome(before: Life, next: Life): 'waiting' | 'ready' | 'wrong-deployment' {
  return next.deployment !== before.deployment ? 'wrong-deployment' : next.bootId !== before.bootId && next.ready ? 'ready' : 'waiting';
}
/** 每个类别页签各自记住的筛选、分页与滚动位置。操作结果不跨刷新保存。 */
interface CategoryState {
  installedFilter: string; installedSize: number; marketSize: number;
  filter: string; sort: HitSort; hide: boolean; page: number; installedPage: number; scroll: number;
  hits: SearchHitView[]; fetched: boolean; generation: number; messages: Record<string, { text: string; bad: boolean }>;
  source: 'npm' | 'local'; input: string;
}
export const HITS_PER_PAGE = 12;
/** 卡片网格的列数,按内容区宽度取。 */
export function extensionColumns(width: number): number { return width >= 1000 ? 3 : width >= 660 ? 2 : 1; }
/** 手动安装的 npm 输入:包名,可带 `@` 精确版本或 dist-tag。 */
export function parseInstallInput(raw: string): Target | null {
  const match = /^((?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*)(?:@([a-zA-Z0-9][a-zA-Z0-9._-]*))?$/.exec(raw.trim());
  return match ? { name: match[1], ...(match[2] ? { version: match[2] } : {}) } : null;
}
const categories: ExtensionKindView[] = ['world', 'provider', 'bot'];
const stateLabels = { loaded: S.disabled, failed: S.stateFailed, 'pending-restart': S.statePendingRestart, removed: S.stateRemoved, idle: S.template };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function mountExtensions(ctx: FeatureContext): void {
  const { root, ui, lifecycle, signal, router } = ctx;
  const win = root.ownerDocument.defaultView!;
  const canRestart = ctx.capabilities.restart === true;
  const supervised = ctx.capabilities.supervised === true;
  const storageKey = 'cortico.extensions.v3:' + win.location.origin;
  const states = Object.fromEntries(categories.map(kind => [kind, {
    installedFilter: '', installedSize: 0, marketSize: 0,
    filter: '', sort: 'name', hide: false, page: 0, installedPage: 0, scroll: 0, hits: [], fetched: false, generation: 0,
    messages: {}, source: 'npm', input: '',
  } satisfies CategoryState])) as unknown as Record<ExtensionKindView, CategoryState>;
  try {
    const saved = JSON.parse(win.sessionStorage.getItem(storageKey) ?? '{}');
    for (const kind of categories) if (saved[kind]) Object.assign(states[kind], saved[kind], { hits: [], fetched: false, generation: 0, messages: {} });
  } catch { /* Storage can be disabled by the browser. */ }
  let kind: ExtensionKindView = categories.includes(router.route.segments[1] as ExtensionKindView) ? router.route.segments[1] as ExtensionKindView : 'world';
  let columns = extensionColumns(root.clientWidth);
  let installed: ExtensionView[] = [];
  let updates = new Map<string, UpdateView>();
  let directory = '';
  let loadGeneration = 0;
  let installedFetched = false;
  let restoringScroll = true;
  const restoreScroll = () => {
    if (!restoringScroll || !installedFetched || !states[kind].fetched) return;
    root.scrollTop = states[kind].scroll;
    restoringScroll = false;
  };
  /** 正在安装或删除的包;同一个包的第二次操作等前一次回来。 */
  const busy = new Set<string>();
  const intro = pageIntro(ui, S.introTitle, S.scope);
  const tabs = ui.h('div', 'extension-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', S.introTitle);
  const indicator = ui.h('span', 'extension-tab-indicator'); indicator.setAttribute('aria-hidden', 'true'); tabs.append(indicator);
  const panel = ui.h('div', 'extension-category'); panel.setAttribute('role', 'tabpanel'); panel.id = 'extension-category';
  const tabButtons = categories.map((value, index) => {
    const button = ui.button(S.tabs[value], { onClick: () => router.navigate(['extensions', value]) });
    button.id = 'extension-tab-' + value; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
    button.addEventListener('keydown', event => {
      const target = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
      if (target >= 0) { event.preventDefault(); tabButtons.forEach((b, i) => b.tabIndex = i === target ? 0 : -1); tabButtons[target].focus(); }
    }, { signal }); tabs.append(button); return button;
  });
  root.append(intro, tabs, panel);
  let installedGrid: HTMLElement, marketGrid: HTMLElement, installedPager: HTMLElement, marketPager: HTMLElement;
  let messageNodes: Record<string, HTMLElement> = {};
  const save = () => {
    if (!restoringScroll) states[kind].scroll = root.scrollTop;
    try {
      win.sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(categories.map(k => {
        const { hits: _hits, fetched: _fetched, generation: _gen, messages: _messages, ...s } = states[k];
        return [k, s];
      }))));
    } catch { /* Optional browser state. */ }
  };
  root.addEventListener('scroll', save, { signal, passive: true }); lifecycle.add(save);
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) root.addEventListener(event, () => { restoringScroll = false; }, { signal, passive: true });
  function message(owner: ExtensionKindView, area: string, text: string, bad = false) {
    states[owner].messages[area] = { text, bad };
    if (owner === kind && messageNodes[area]) { messageNodes[area].textContent = text; messageNodes[area].className = 'msgline' + (bad ? ' bad' : ''); }
  }
  const pageSize = (area: 'installed' | 'market', owner = kind) => area === 'installed' ? states[owner].installedSize || columns * 2 : states[owner].marketSize || columns * 4;
  function sizePicker(area: 'installed' | 'market') {
    const state = states[kind], key = area === 'installed' ? 'installedSize' : 'marketSize';
    const label = ui.h('label', 'extension-size'); label.dataset.area = area; label.append(ui.h('span', '', S.perPage));
    label.append(ui.select({ value: String(state[key]), options: [0, 3, 6, 12, 24, 48].map(value => ({ value: String(value), label: value ? String(value) : S.automaticCount(columns * (area === 'installed' ? 2 : 4)) })), onChange: value => {
      state[key] = Number(value); (area === 'installed' ? installedGrid : marketGrid).style.minHeight = ''; if (area === 'installed') { state.installedPage = 0; renderInstalled(); } else { state.page = 0; renderMarket(); } save();
    } })); return label;
  }
  function stabilizeGrid(grid: HTMLElement, total: number, size: number) {
    const rows = Math.ceil(Math.min(total, size) / columns);
    grid.style.gridTemplateRows = rows ? `repeat(${rows}, minmax(206px, auto))` : '';
  }
  function pager(node: HTMLElement, total: number, page: number, size: number, change: (page: number) => void) {
    node.classList.add('extension-pager');
    node.replaceChildren(ui.h('span', 'muted', S.shown(total ? page * size + 1 : 0, Math.min(total, (page + 1) * size), total)), ui.h('span', 'grow'));
    const pages = Math.max(1, Math.ceil(total / size)); if (pages === 1) return;
    const prev = ui.button(S.prevPage, { onClick: () => change(page - 1) }); prev.disabled = page === 0;
    const next = ui.button(S.nextPage, { onClick: () => change(page + 1) }); next.disabled = page === pages - 1;
    node.append(prev, ui.h('span', '', S.pageOf(page + 1, pages)), next);
  }
  /** 包文档按 name@version 缓存,失败的也留着:registry 连不上时翻页、筛选不会反复重发。 */
  const detailsCache = new Map<string, Promise<PackageDetailView>>();
  function fetchDetail(name: string, version?: string) {
    const key = name + '@' + (version ?? 'latest');
    let request = detailsCache.get(key);
    if (!request) {
      request = get<PackageDetailView>('/api/extensions/package?name=' + encodeURIComponent(name) + (version ? '&version=' + encodeURIComponent(version) : ''), { signal });
      detailsCache.set(key, request);
      void request.catch(() => { /* The rejection is kept for this page's lifetime. */ });
    }
    return request;
  }
  function showLocal(item: ExtensionView) {
    const box = ui.h('div', 'extension-detail');
    ui.drawer(item.metadata?.displayName ?? item.label ?? item.name, box);
    const hit = states[kind].hits.find(hit => hit.name === item.name);
    const local: PackageDetailView = { name: item.name, version: item.installedVersion ?? item.version ?? '—', versionCount: 0, history: [], warnings: [], frameworkApi: item.api ?? 0, dependencies: [], maintainers: [], links: {}, installed: true, ...item.metadata, description: item.description ?? item.metadata?.description, publisher: item.author };
    renderDetail(box, local, kind, hit, item);
    if (!item.builtin && !/^(link:|file:)/.test(item.spec) && item.state !== 'removed') {
      void fetchDetail(item.name).then(data => {
        if (!signal.aborted && box.isConnected) renderDetail(box, data, kind, hit, item);
      }).catch(error => { if (!signal.aborted && box.isConnected) box.append(ui.msgline(errorText(error), true)); });
    }
  }
  function installedCard(item: ExtensionView) {
    const card = ui.h('article', 'extension-card' + (item.enabled ? ' is-enabled' : ''));
    const heading = ui.h('div', 'extension-card-heading');
    if (item.kind === 'bot') { const avatar = ui.h('span', 'extension-avatar'); avatar.append(brandMark(root.ownerDocument)); heading.append(avatar); }
    const title = ui.button(item.metadata?.displayName ?? item.label ?? item.name, { onClick: () => showLocal(item) }); title.className = 'extension-card-title'; title.title = item.label ?? item.name;
    heading.append(title); if (item.enabled) heading.append(ui.pill(item.kind === 'provider' ? S.alreadyInstalled : item.kind === 'bot' ? S.adopted : S.stateLoaded, 'on'));
    card.append(heading);
    const text = item.state === 'removed' || item.state === 'pending-restart' || item.state === 'failed' ? stateLabels[item.state] : item.kind === 'provider' ? S.alreadyInstalled : item.enabled ? (item.kind === 'bot' ? S.adopted : S.enabled) : stateLabels[item.state];
    const failed = item.state === 'failed';
    const symbol = failed ? '!' : item.state === 'pending-restart' ? '◷' : item.enabled ? '●' : '○';
    const author = states[kind].hits.find(hit => hit.name === item.name)?.publisher ?? item.author ?? S.unknownAuthor;
    card.append(ui.h('div', 'extension-meta', [item.builtin ? S.builtin : '', S.version(item.installedVersion ?? item.version ?? '—'), S.author(author)].filter(Boolean).join(' · ')));
    card.append(ui.h('div', 'extension-status' + (failed ? ' bad' : item.enabled ? ' on' : ' off'), `${symbol} ${text}`));
    if (item.description) card.append(ui.h('p', 'extension-description', item.description));
    const version = ui.h('div', 'extension-secondary');
    const update = updates.get(item.name);
    if (update) {
      version.classList.add('extension-update');
      const alert = ui.h('span', 'extension-update-icon', '!'); alert.setAttribute('aria-hidden', 'true');
      version.append(alert, ui.h('span', '', S.updateVersions(update.installedVersion, update.latestVersion)));
      const button = ui.button(S.updateAction, { size: 'sm', onClick: () => void operate('install', { name: item.name, version: update.latestVersion }, 'management', kind) });
      button.disabled = !!update.problems.length || busy.has(item.name); button.title = update.problems.join('\n'); version.append(button);
    } else version.textContent = item.hidden ? S.hidden : item.installedVersion && item.version !== item.installedVersion ? S.runtimeVersion(item.version ?? '—') : '';
    if (version.hasChildNodes()) card.append(version);
    for (const problem of update?.problems ?? []) card.append(ui.msgline(problem, true));
    const actions = ui.h('div', 'extension-card-actions');
    const owner = kind;
    if (item.state !== 'removed') {
      if (item.kind === 'bot') actions.append(ui.button(S.create, { onClick: () => { const box = ui.h('div'); box.append(ui.h('p', '', S.createBody), ui.h('pre', '', 'pnpm start --new')); ui.drawer(item.name, box); } }));
      else if (item.state === 'pending-restart' && canRestart) actions.append(ui.button(S.restartProcess, { onClick: () => void restart() }));
      else if (item.kind === 'world' && item.enabled && item.worldId) actions.append(ui.button(S.manage, { onClick: () => router.navigate(['provider', 'world:' + item.worldId]) }));
      else actions.append(ui.button(S.details, { onClick: () => showLocal(item) }));
      const remove = ui.button(S.remove, { variant: 'danger', onClick: async () => { if (await ui.confirm({ title: item.name, body: S.removeBody, danger: true })) void operate('delete', { name: item.name }, 'management', owner); } });
      if (item.builtin) { remove.disabled = true; remove.title = S.builtinNote; }
      else if (item.enabled && item.kind !== 'provider') { remove.disabled = true; remove.title = S.removeInUse; }
      else remove.disabled = busy.has(item.name);
      actions.append(remove);
    }
    card.append(actions); return card;
  }
  function renderInstalled() {
    if (!installedGrid) return;
    const needle = states[kind].installedFilter.trim().toLowerCase();
    const mine = installed.filter(p => (p.kind === kind || !p.kind && kind === 'world') && (!needle || [p.label, p.name, p.description, p.worldId].some(value => value?.toLowerCase().includes(needle)))).sort((a, b) => a.name.localeCompare(b.name));
    const state = states[kind], size = pageSize('installed'); if (installedFetched) state.installedPage = Math.min(state.installedPage, Math.max(0, Math.ceil(mine.length / size) - 1));
    installedGrid.replaceChildren(...mine.slice(state.installedPage * size, (state.installedPage + 1) * size).map(installedCard));
    stabilizeGrid(installedGrid, mine.length, size);
    if (!mine.length) installedGrid.append(ui.placeholder(S.noExtensions));
    pager(installedPager, mine.length, state.installedPage, size, page => { installedGrid.style.minHeight = `${installedGrid.getBoundingClientRect().height}px`; state.installedPage = page; renderInstalled(); save(); });
  }
  function renderMarket() {
    const state = states[kind];
    const hits = state.hits.map(h => ({ ...h, installed: installed.some(p => p.name === h.name && p.state !== 'removed') }));
    const result = arrangeHits(hits, { filter: state.filter, sort: state.sort, hideInstalled: state.hide, page: state.page, pageSize: pageSize('market') }); if (state.fetched) state.page = result.page;
    marketGrid.replaceChildren(...result.shown.map(hit => {
      const card = ui.h('article', 'extension-card extension-market-card' + (hit.installed ? ' is-installed' : ''));
      const owner = kind; card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', hit.name);
      card.addEventListener('click', () => openDetail(hit, owner), { signal });
      card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(hit, owner); } }, { signal });
      const heading = ui.h('div', 'extension-card-heading'); const local = installed.find(item => item.name === hit.name);
      const title = ui.h('span', 'extension-card-title', local?.metadata?.displayName ?? local?.label ?? hit.name); title.title = title.textContent ?? hit.name;
      void fetchDetail(hit.name, hit.version).then(data => { if (!signal.aborted && data.displayName) title.textContent = title.title = data.displayName; }).catch(() => { /* Search results remain usable when package metadata is unavailable. */ });
      heading.append(title); if (hit.installed) heading.append(ui.pill(S.alreadyInstalled));
      const metadata = ui.h('div', 'extension-card-info');
      metadata.append(ui.h('div', 'extension-meta', S.labelled(S.packageName, hit.name)), ui.h('div', 'extension-meta', `${S.version(hit.version)}${hit.publisher ? S.metaSeparator + S.author(hit.publisher) : ''}`));
      card.append(heading, metadata, ui.h('p', 'extension-description', hit.description));
      const info = ui.rowbar(); info.classList.add('extension-tags');
      if (hit.license) info.append(ui.pill(hit.license));
      if (hit.date) info.append(ui.pill(hit.date.slice(0, 10)));
      info.append(ui.pill(S.downloadsPerMonth(ui.fmt.count(hit.downloads)))); card.append(info); return card;
    }));
    stabilizeGrid(marketGrid, result.matched, pageSize('market'));
    if (!result.matched) marketGrid.append(ui.placeholder(state.fetched ? state.hits.length ? S.noHits : S.noPackages : S.searching));
    pager(marketPager, result.matched, result.page, pageSize('market'), page => { marketGrid.style.minHeight = `${marketGrid.getBoundingClientRect().height}px`; state.page = page; renderMarket(); save(); });
  }
  async function load(): Promise<boolean> {
    if (signal.aborted) return false;
    const generation = ++loadGeneration;
    try {
      const data = await get<{ dir: string; extensions: ExtensionView[] }>('/api/extensions', { signal });
      if (signal.aborted || generation !== loadGeneration) return !signal.aborted;
      installed = data.extensions; installedFetched = true; directory = data.dir; const dirNode = root.querySelector('.extension-directory'); if (dirNode) dirNode.textContent = S.labelled(S.directory, directory); renderInstalled(); renderMarket(); restoreScroll(); return true;
    } catch (error) { if (!signal.aborted) { installedFetched = true; message(kind, 'management', S.listLoadFailed(errorText(error)), true); restoreScroll(); } return false; }
  }
  async function checkUpdates() {
    if (signal.aborted) return;
    try { const data = await get<UpdateResultView>('/api/extensions/updates', { signal }); if (signal.aborted) return; updates = new Map(data.updates.map(u => [u.name, u])); renderInstalled(); if (data.errors.length) message(kind, 'management', S.updateCheckFailed(data.errors.map(e => `${e.name}: ${e.error}`).join('; ')), true); }
    catch (error) { if (!signal.aborted) message(kind, 'management', S.updateCheckFailed(errorText(error)), true); }
  }
  async function search(owner: ExtensionKindView) {
    const state = states[owner], generation = ++state.generation;
    message(owner, 'market', S.searching);
    try {
      const data = await get<{ hits: SearchHitView[]; partial?: boolean }>(`/api/extensions/search?kind=${owner}`, { signal });
      if (signal.aborted || state.generation !== generation) return;
      state.hits = data.hits; state.fetched = true; message(owner, 'market', data.partial ? S.partial : ''); if (owner === kind) { renderInstalled(); renderMarket(); restoreScroll(); }
    } catch (error) { if (!signal.aborted && state.generation === generation) { state.fetched = true; message(owner, 'market', S.searchFailed(errorText(error)), true); if (owner === kind) { renderMarket(); restoreScroll(); } } }
  }
  /** 安装先按当前类别检查声明再装;删除直接卸。两者都改磁盘,重启进程后生效。 */
  async function operate(action: 'install' | 'delete', target: Target, area: string, owner: ExtensionKindView) {
    const identity = 'name' in target ? target.name : target.path; if (busy.has(identity)) return;
    const actionLabel = action === 'delete' ? S.deletedAction : installed.some(item => item.name === identity) ? S.updatedAction : S.installedAction;
    busy.add(identity); renderInstalled(); message(owner, area, S.progress(actionLabel, identity));
    try {
      let name = identity, version: string | undefined, resultKind: string | undefined;
      if (action === 'install') {
        const checked = await post<{ name: string; version: string; kind: string }>('/api/extensions/check', { target, kind: owner }, { signal });
        ({ name, version, kind: resultKind } = checked);
        await post('/api/extensions/install', 'path' in target ? target : { name: checked.name, version: checked.version }, { signal });
      } else {
        await post('/api/extensions/uninstall', { name: identity }, { signal });
      }
      if (signal.aborted) return;
      const restartHint = action === 'delete' || resultKind !== 'bot' ? ' ' + S.restartNeeded : '';
      message(owner, area, `${S.completed(actionLabel, name)}${version ? ' ' + S.version(version) : ''}${restartHint}`);
      updates.delete(name);
      if (!await load()) message(owner, area, S.completed(actionLabel, name) + ' ' + S.syncedFailed, true);
    } catch (error) { if (!signal.aborted) message(owner, area, errorText(error), true); }
    finally { busy.delete(identity); if (!signal.aborted) renderInstalled(); }
  }
  function renderDetail(box: HTMLElement, data: PackageDetailView, owner: ExtensionKindView, hit?: SearchHitView, item?: ExtensionView) {
      const title = box.closest('.modalcard')?.querySelector('.modaltitle');
      if (title) title.textContent = data.displayName ?? item?.metadata?.displayName ?? item?.label ?? data.name;
      box.replaceChildren(ui.h('h4', '', S.introduction), ui.h('p', '', item?.builtin ? [item.description, S.builtinNote].filter(Boolean).join(' ') : data.description ?? '—'));
      if (item?.reason) box.append(ui.msgline(item.reason, true));
      if (item?.console === 'missing') box.append(ui.msgline(S.noteConsoleMissing, true));
      for (const text of [...data.problems ?? [], ...data.warnings]) box.append(ui.msgline(text, true));
      if (data.deprecated) box.append(ui.msgline(S.deprecated(data.deprecated), true));
      const rows = [
        { k: S.packageName, v: data.name },
        { k: S.authorLabel, v: item?.author ?? data.publisher ?? hit?.publisher ?? S.unknownAuthor },
        ...(item ? [{ k: S.fieldInstalledVersion, v: item.installedVersion ?? item.version ?? '—' }, { k: S.directory, v: item.location ?? directory }] : []),
        { k: item?.builtin ? S.runtime : S.fieldVersion, v: data.version }, { k: S.fieldLicense, v: data.license ?? '—' },
        { k: S.released, v: data.published?.slice(0, 10) ?? '—' },
        { k: S.fieldReleases, v: data.versionCount ? S.releaseCount(data.versionCount, data.created?.slice(0, 10) ?? '') : '—' },
        { k: S.fieldSize, v: data.unpackedSize === undefined ? '—' : S.sizeAndFiles(ui.fmt.bytes(data.unpackedSize), data.fileCount ?? 0) },
        { k: S.fieldMaintainers, v: data.maintainers.join(S.listSeparator) || '—' },
        { k: S.fieldNode, v: data.engines ?? '—' }, { k: S.fieldDeps, v: data.dependencies.join(S.listSeparator) || S.none },
        { k: S.fieldKeywords, v: data.keywords?.join(S.listSeparator) || '—' },
        { k: S.fieldDownloads, v: hit ? S.downloadsPerMonth(ui.fmt.count(hit.downloads)) : '—' }, { k: S.fieldDependents, v: hit ? String(hit.dependents) : '—' },
      ];
      box.append(ui.h('h4', '', S.information), ui.kv(rows));
      {
        const releases = ui.h('details', 'extension-releases');
        const summary = ui.h('summary', '', S.fieldHistory);
        summary.addEventListener('click', () => {
          const card = box.closest<HTMLElement>('.modalcard');
          if (card && !card.style.height) card.style.height = `${card.getBoundingClientRect().height}px`;
        });
        releases.append(summary);
        const history = ui.h('div', 'extension-history');
        for (const release of data.history) { const row = ui.h('div'); row.append(ui.h('code', '', release.version), ui.h('time', 'muted', release.date.slice(0, 10))); history.append(row); }
        releases.append(data.history.length ? history : ui.h('p', 'muted', S.noHistory)); box.append(releases);
      }
      const actions = ui.rowbar(); actions.classList.add('extension-detail-actions');
      for (const [name, href] of Object.entries(data.links)) if (href && /^https?:\/\//i.test(href)) { const a = ui.h('a', 'btn secondary', S.linkNames[name as keyof typeof S.linkNames]); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; actions.append(a); }
      if (!item) {
        const isInstalled = installed.some(item => item.name === data.name && item.state !== 'removed');
        const button = ui.button(isInstalled ? S.alreadyInstalled : S.install, { variant: 'primary', onClick: () => { button.disabled = true; void operate('install', { name: data.name, version: data.version }, 'market', owner).finally(() => { if (box.isConnected) button.disabled = installed.some(item => item.name === data.name && item.state !== 'removed'); }); } });
        button.disabled = isInstalled || !data.manifest || !!data.problems?.length || data.manifest.kind !== owner; actions.append(ui.h('span', 'grow'), button);
      }
      if (actions.hasChildNodes()) box.append(actions);
  }
  function openDetail(hit: SearchHitView, owner: ExtensionKindView) {
    const box = ui.h('div', 'extension-detail'); box.append(ui.placeholder(S.loadingDetail));
    const item = installed.find(item => item.name === hit.name && item.state !== 'removed');
    ui.drawer(item?.metadata?.displayName ?? item?.label ?? hit.name, box);
    void fetchDetail(hit.name, hit.version).then(data => {
      if (!signal.aborted && box.isConnected) renderDetail(box, data, owner, hit);
    }).catch(error => { if (!signal.aborted && box.isConnected) box.replaceChildren(ui.msgline(errorText(error), true)); });
  }

  /**
   * 重启 = 落标志 + 规范关机,之后轮询 lifecycle 等同一部署的新进程就绪再刷新页面。
   * 关机步骤有没完成的,回执摊在对话框里。
   */
  async function restart() {
    if (!canRestart) return;
    if (!await ui.confirm({ title: supervised ? S.restartConfirmTitle : S.restartNoLoopTitle, body: supervised ? S.restartConfirmBody : S.restartNoLoopBody, danger: !supervised })) return;
    try {
      const before = await get<Life>('/api/run/lifecycle', { signal });
      save(); win.sessionStorage.setItem(storageKey + ':restart', JSON.stringify(before));
      message(kind, 'management', supervised ? S.reloadWait : S.restartManual);
      let report: PowerReport | undefined;
      try { report = await post<PowerReport>('/api/run/restart', undefined, { signal }); } catch (error) {
        if ((error as { status?: number }).status) { win.sessionStorage.removeItem(storageKey + ':restart'); throw error; }
      }
      if (report?.error) { win.sessionStorage.removeItem(storageKey + ':restart'); throw new Error(report.error); }
      const incomplete = (report?.steps ?? []).filter(step => !step.ok);
      if (report && incomplete.length) {
        void ui.confirm({
          title: supervised ? S.doneRestartSupervised : S.doneRestart,
          body: [report.result ?? S.resultDefault, '', ...incomplete.map(step => `✗ ${step.label} · ${step.detail ?? S.stepIncomplete}`)].join('\n'),
        });
      }
      watchRestart(before);
    } catch (error) { if (!signal.aborted) message(kind, 'management', errorText(error), true); }
  }
  function watchRestart(before: Life) {
    const deadline = Date.now() + 120_000;
    const check = async () => {
      if (signal.aborted) return;
      try {
        const next = await get<Life>('/api/run/lifecycle', { signal });
        if (restartOutcome(before, next) === 'wrong-deployment') { win.sessionStorage.removeItem(storageKey + ':restart'); message(kind, 'management', S.otherBot, true); return; }
        if (restartOutcome(before, next) === 'ready') { win.sessionStorage.removeItem(storageKey + ':restart'); save(); win.location.reload(); return; }
      } catch { /* Wait while the listener is unavailable. */ }
      if (Date.now() >= deadline) { message(kind, 'management', S.reloadTimeout, true); messageNodes.management?.append(ui.button(S.retry, { onClick: () => watchRestart(before) })); return; }
      lifecycle.timeout(() => void check(), 1000);
    }; void check();
  }
  function render() {
    const state = states[kind]; tabs.style.setProperty('--tab-index', String(categories.indexOf(kind)));
    tabButtons.forEach((button, i) => { const active = categories[i] === kind; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }); panel.setAttribute('aria-labelledby', 'extension-tab-' + kind);
    panel.replaceChildren(); messageNodes = {};
    const managed = ui.sheet({ title: S.installedTitle });
    const bar = ui.rowbar(); bar.classList.add('extension-toolbar');
    managed.el.querySelector('h3')!.append(ui.h('span', 'extension-directory', S.labelled(S.directory, directory)));
    const installedFilters = ui.input({ type: 'search', value: state.installedFilter, placeholder: S.installedFilter, onInput: value => { state.installedFilter = value; state.installedPage = 0; renderInstalled(); save(); } });
    installedFilters.setAttribute('aria-label', S.installedFilter); bar.append(installedFilters, sizePicker('installed'));
    if (canRestart) { const button = ui.button(S.restartProcess, { onClick: () => void restart() }); button.classList.add('extension-restart'); bar.append(button); }
    bar.append(ui.button(S.refresh, { onClick: () => { void load(); void checkUpdates(); } }));
    messageNodes.management = ui.msgline(kind === 'bot' ? S.createBody : kind === 'provider' ? S.providerManagement : S.idleManagement); messageNodes.management.setAttribute('role', 'status'); installedGrid = ui.h('div', 'extension-grid'); installedPager = ui.rowbar();
    managed.body.append(bar, messageNodes.management, installedGrid, installedPager);
    const marketSheet = ui.sheet({ title: S.market }); messageNodes.market = ui.msgline(); messageNodes.market.setAttribute('role', 'status');
    const filters = ui.rowbar(); filters.classList.add('extension-toolbar');
    filters.append(ui.input({ type: 'search', value: state.filter, placeholder: S.filterPlaceholder, onInput: value => { state.filter = value; state.page = 0; renderMarket(); save(); } }), ui.select({ value: state.sort, options: HIT_SORTS.map(value => ({ value, label: S.sortLabel[value] })), onChange: value => { state.sort = value as HitSort; state.page = 0; renderMarket(); save(); } }), ui.checkbox(S.hideInstalled, { checked: state.hide, onChange: value => { state.hide = value; state.page = 0; renderMarket(); save(); } }).el, sizePicker('market'), ui.button(S.refresh, { onClick: () => void search(kind) }));
    marketGrid = ui.h('div', 'extension-grid'); marketPager = ui.rowbar(); marketSheet.body.append(filters, messageNodes.market, marketGrid, marketPager);
    const manual = ui.sheet({ title: S.manual }); messageNodes.manual = ui.msgline(); messageNodes.manual.setAttribute('role', 'status');
    const source = ui.segmented([{ value: 'npm', label: S.npm }, { value: 'local', label: S.local }], { value: state.source, onSelect: value => { state.source = value as 'npm' | 'local'; state.input = ''; render(); save(); } });
    const manualBar = ui.rowbar(); const input = ui.input({ value: state.input, placeholder: state.source === 'npm' ? `@scope/cortico-${kind}-demo@1.2.3` : '', onInput: value => { state.input = value; } });
    input.setAttribute('aria-label', state.source === 'npm' ? S.packageLabel : S.pathLabel); manualBar.append(input);
    if (state.source === 'local') manualBar.append(ui.button(S.folder, { onClick: async () => { try { const path = await pickPath({ kind: 'directory', currentPath: input.value }, { signal }); if (path) { state.input = input.value = path; } } catch (error) { message(kind, 'manual', errorText(error), true); } } }));
    const target = (): Target => { if (state.source === 'local' && state.input.trim()) return { path: state.input.trim() }; const value = parseInstallInput(state.input); if (!value) throw new Error(S.invalidInput); return value; };
    const owner = kind;
    const check = ui.button(S.check, { onClick: async () => { const lock = ui.disable(check); try { const data = await post<{ name: string; version: string; kind: string }>('/api/extensions/check', { target: target(), kind: owner }, { signal }); message(owner, 'manual', `${S.checkOk} · ${data.name}@${data.version} · ${data.kind}`); } catch (error) { message(owner, 'manual', errorText(error), true); } finally { lock.dispose(); } } });
    const install = ui.button(S.install, { variant: 'primary', onClick: () => { try { void operate('install', target(), 'manual', owner); } catch (error) { message(owner, 'manual', errorText(error), true); } } });
    const manualActions = ui.rowbar(); manualActions.classList.add('extension-manual-actions'); manualActions.append(check, install, messageNodes.manual);
    manual.body.append(ui.h('p', 'sh-desc extension-install-help', state.source === 'npm' ? S.npmHelp : S.localHelp), source.el, manualBar, manualActions);
    panel.append(managed.el, marketSheet.el, manual.el); root.style.setProperty('--extension-columns', String(columns));
    for (const [area, value] of Object.entries(state.messages)) if (messageNodes[area]) { messageNodes[area].textContent = value.text; messageNodes[area].className = 'msgline' + (value.bad ? ' bad' : ''); }
    renderInstalled(); renderMarket();
  }
  lifecycle.own(router.onChange(route => {
    const next = route.segments[1] as ExtensionKindView; if (!categories.includes(next) || next === kind || route.segments[0] !== 'extensions') return;
    save(); kind = next; restoringScroll = true; render(); restoreScroll(); if (!states[kind].fetched) void search(kind);
  }));
  if (typeof win.ResizeObserver === 'function') { const observer = new win.ResizeObserver(() => {
    const next = extensionColumns(panel.clientWidth); if (next === columns) return;
    for (const state of Object.values(states)) { if (!state.installedSize) state.installedPage = Math.floor(state.installedPage * columns / next); if (!state.marketSize) state.page = Math.floor(state.page * columns / next); }
    columns = next; installedGrid.style.minHeight = ''; marketGrid.style.minHeight = '';
    for (const label of panel.querySelectorAll<HTMLElement>('.extension-size')) { const option = label.querySelector('option[value="0"]'); if (option) option.textContent = S.automaticCount(columns * (label.dataset.area === 'installed' ? 2 : 4)); }
    root.style.setProperty('--extension-columns', String(columns)); renderInstalled(); renderMarket();
  }); observer.observe(panel); lifecycle.add(() => observer.disconnect()); }
  render();
  if (!categories.includes(router.route.segments[1] as ExtensionKindView)) router.replace(['extensions', kind]);
  void load(); void checkUpdates(); void search(kind);
  try { const marker = win.sessionStorage.getItem(storageKey + ':restart'); if (marker) { message(kind, 'management', S.reloadWait); watchRestart(JSON.parse(marker)); } } catch { /* Invalid recovery marker. */ }
}
export const extensionsFeature: FrameworkFeature = { route: 'extensions', label: S.navLabel, icon: 'download', navGroup: S.navGroup, needsAny: ['extensions'], mount: mountExtensions };
