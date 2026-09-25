/** 扩展管理页。扩展信息与运行状态由服务端提供；安装、卸载后需重启进程才能生效。 */

import { get, post, pickPath } from '../../core/api.ts';
import { brandMark } from '../../ui/icons.ts';
import { pageIntro } from '../../ui/page.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { V } from './v2-strings.ts';
import { S } from './strings.ts';

/** 扩展类别。与 `ExtensionKind` 同形;这一页只用它分组与选关键字。 */
export type ExtensionKindView = 'world' | 'provider' | 'bot';

/** 与 `src/web/server.ts` 的 `ExtensionInfo` 同形。 */
export interface ExtensionView {
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
  inUse?: boolean;
  hidden?: boolean;
  disableReason?: string;
  activationError?: string;
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
interface Operation { action?: 'install' | 'delete'; id: string; phase: string; name?: string; version?: string; kind?: ExtensionKindView; error?: string; output?: string }
interface Life { deployment: string; bootId: string; ready: boolean }
export function restartOutcome(before: Life, next: Life): 'waiting' | 'ready' | 'wrong-deployment' {
  return next.deployment !== before.deployment ? 'wrong-deployment' : next.bootId !== before.bootId && next.ready ? 'ready' : 'waiting';
}
interface CategoryState {
  installedFilter: string; installedSize: number; marketSize: number;
  filter: string; sort: HitSort; hide: boolean; page: number; installedPage: number; scroll: number;
  hits: SearchHitView[]; fetched: boolean; generation: number; messages: Record<string, { text: string; bad: boolean }>;
  source: 'npm' | 'local'; input: string;
}
export const HITS_PER_PAGE = 12;
export function extensionColumns(width: number): number { return width >= 1000 ? 3 : width >= 660 ? 2 : 1; }
export function parseInstallInput(raw: string): Target | null {
  const match = /^((?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*)(?:@([a-zA-Z0-9][a-zA-Z0-9._-]*))?$/.exec(raw.trim());
  return match ? { name: match[1], ...(match[2] ? { version: match[2] } : {}) } : null;
}
const categories: ExtensionKindView[] = ['world', 'provider', 'bot'];
const stateLabels = { loaded: V.disabled, failed: S.stateFailed, 'pending-restart': S.statePendingRestart, removed: S.stateRemoved, idle: V.template };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function mountExtensions(ctx: FeatureContext): void {
  const { root, ui, lifecycle, signal, router } = ctx;
  const win = root.ownerDocument.defaultView!;
  const storageKey = 'cortico.extensions.v3:' + win.location.origin;
  const states = Object.fromEntries(categories.map(kind => [kind, {
    installedFilter: '', installedSize: 0, marketSize: 0,
    filter: '', sort: 'name', hide: false, page: 0, installedPage: 0, scroll: 0, hits: [], fetched: false, generation: 0,
    messages: {}, source: 'npm', input: '',
  } satisfies CategoryState])) as unknown as Record<ExtensionKindView, CategoryState>;
  try {
    const saved = JSON.parse(win.sessionStorage.getItem(storageKey) ?? '{}');
    for (const kind of categories) if (saved[kind]) Object.assign(states[kind], saved[kind], { hits: [], fetched: false, generation: 0 });
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
  const busy = new Set<string>();
  const pendingOperations = new Map<string, { id: string; kind: ExtensionKindView; area: string }>();
  try { for (const [identity, pending] of JSON.parse(win.sessionStorage.getItem(storageKey + ':operations') ?? '[]')) { pendingOperations.set(identity, pending); busy.add(identity); } } catch { /* Invalid saved operation state. */ }
  const saveOperations = () => { try { win.sessionStorage.setItem(storageKey + ':operations', JSON.stringify([...pendingOperations])); } catch { /* Optional browser storage. */ } };
  const intro = pageIntro(ui, S.introTitle, V.scope);
  const tabs = ui.h('div', 'extension-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', S.introTitle);
  const indicator = ui.h('span', 'extension-tab-indicator'); indicator.setAttribute('aria-hidden', 'true'); tabs.append(indicator);
  const panel = ui.h('div', 'extension-category'); panel.setAttribute('role', 'tabpanel'); panel.id = 'extension-category';
  const tabButtons = categories.map((value, index) => {
    const button = ui.button(V.tabs[value], { onClick: () => router.navigate(['extensions', value]) });
    button.id = 'extension-tab-' + value; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
    button.addEventListener('keydown', event => {
      const target = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
      if (target >= 0) { event.preventDefault(); tabButtons.forEach((b, i) => b.tabIndex = i === target ? 0 : -1); tabButtons[target].focus(); }
    }, { signal }); tabs.append(button); return button;
  });
  root.append(intro, tabs, panel);
  let management: HTMLElement, market: HTMLElement, installedGrid: HTMLElement, marketGrid: HTMLElement, installedPager: HTMLElement, marketPager: HTMLElement;
  let messageNodes: Record<string, HTMLElement> = {};
  const save = () => {
    if (!restoringScroll) states[kind].scroll = root.scrollTop;
    try { win.sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(categories.map(k => { const { hits: _hits, fetched: _fetched, generation: _gen, ...s } = states[k]; return [k, s]; })))); } catch { /* Optional browser state. */ }
  };
  root.addEventListener('scroll', save, { signal, passive: true }); lifecycle.add(save);
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) root.addEventListener(event, () => { restoringScroll = false; }, { signal, passive: true });
  function message(owner: ExtensionKindView, area: string, text: string, bad = false) {
    states[owner].messages[area] = { text, bad };
    if (owner === kind && messageNodes[area]) { messageNodes[area].textContent = text; messageNodes[area].className = 'msgline' + (bad ? ' bad' : ''); }
    save();
  }
  const pageSize = (area: 'installed' | 'market', owner = kind) => area === 'installed' ? states[owner].installedSize || columns * 2 : states[owner].marketSize || columns * 4;
  function sizePicker(area: 'installed' | 'market') {
    const state = states[kind], key = area === 'installed' ? 'installedSize' : 'marketSize';
    const label = ui.h('label', 'extension-size'); label.dataset.area = area; label.append(ui.h('span', '', V.perPage));
    label.append(ui.select({ value: String(state[key]), options: [0, 3, 6, 12, 24, 48].map(value => ({ value: String(value), label: value ? String(value) : `${V.automatic}（${columns * (area === 'installed' ? 2 : 4)}）` })), onChange: value => {
      state[key] = Number(value); (area === 'installed' ? installedGrid : marketGrid).style.minHeight = ''; if (area === 'installed') { state.installedPage = 0; renderInstalled(); } else { state.page = 0; renderMarket(); } save();
    } })); return label;
  }
  function stabilizeGrid(grid: HTMLElement, total: number, size: number) {
    const rows = Math.ceil(Math.min(total, size) / columns);
    grid.style.gridTemplateRows = rows ? `repeat(${rows}, minmax(206px, auto))` : '';
  }
  function pager(node: HTMLElement, total: number, page: number, size: number, change: (page: number) => void) {
    node.classList.add('extension-pager');
    node.replaceChildren(ui.h('span', 'muted', V.shown(total ? page * size + 1 : 0, Math.min(total, (page + 1) * size), total)), ui.h('span', 'grow'));
    const pages = Math.max(1, Math.ceil(total / size)); if (pages === 1) return;
    const prev = ui.button(S.prevPage, { onClick: () => change(page - 1) }); prev.disabled = page === 0;
    const next = ui.button(S.nextPage, { onClick: () => change(page + 1) }); next.disabled = page === pages - 1;
    node.append(prev, ui.h('span', '', S.pageOf(page + 1, pages)), next);
  }
  function showLocal(item: ExtensionView) {
    const box = ui.h('div', 'extension-detail');
    box.append(ui.kv([{ k: V.packageLabel, v: item.name }, { k: S.fieldVersion, v: item.installedVersion ?? item.version ?? '—' }, { k: V.directory, v: item.location ?? directory }, ...(item.builtin || item.api === undefined ? [] : [{ k: S.apiPill(item.api), v: item.console ?? 'none' }])]));
    if (item.builtin) box.append(ui.h('p', 'sh-desc', V.builtinNote));
    if (item.description) box.append(ui.h('p', '', item.description));
    if (item.reason || item.activationError) box.append(ui.msgline(item.activationError ?? item.reason, true));
    if (item.console === 'missing') box.append(ui.msgline(S.noteConsoleMissing, true));
    ui.drawer(item.label ?? item.name, box);
  }
  function installedCard(item: ExtensionView) {
    const card = ui.h('article', 'extension-card' + (item.enabled ? ' is-enabled' : ''));
    const heading = ui.h('div', 'extension-card-heading');
    if (item.kind === 'bot') { const avatar = ui.h('span', 'extension-avatar'); avatar.append(brandMark(root.ownerDocument)); heading.append(avatar); }
    const title = ui.button(item.label ?? item.name, { onClick: () => showLocal(item) }); title.className = 'extension-card-title'; title.title = item.label ?? item.name;
    heading.append(title); if (item.enabled) heading.append(ui.pill(item.kind === 'bot' ? V.adopted : S.stateLoaded, 'on'));
    card.append(heading);
    const text = item.activationError ? S.stateFailed : item.state === 'removed' || item.state === 'pending-restart' || item.state === 'failed' ? stateLabels[item.state] : item.enabled ? (item.kind === 'bot' ? V.adopted : V.enabled) : stateLabels[item.state];
    const failed = !!item.activationError || item.state === 'failed';
    const symbol = failed ? '!' : item.state === 'pending-restart' ? '◷' : item.enabled ? '●' : '○';
    card.append(ui.h('div', 'extension-status' + (failed ? ' bad' : ''), `${symbol} ${text}`));
    const author = states[kind].hits.find(hit => hit.name === item.name)?.publisher ?? item.author ?? V.unknownAuthor;
    card.append(ui.h('div', 'extension-meta', [item.builtin ? V.builtin : '', V.version(item.installedVersion ?? item.version ?? '—'), V.author(author)].filter(Boolean).join(' · ')));
    if (item.description) card.append(ui.h('p', 'extension-description', item.description));
    const version = ui.h('div', 'extension-secondary');
    const update = updates.get(item.name);
    if (update) {
      version.append(ui.h('span', '', S.updateVersions(update.installedVersion, update.latestVersion)));
      const button = ui.button(S.updateAction, { size: 'sm', onClick: () => void operate('install', { name: item.name, version: update.latestVersion }, 'management', kind) });
      button.disabled = !!update.problems.length || busy.has(item.name); button.title = update.problems.join('\n'); version.append(button);
    } else version.textContent = item.hidden ? V.hidden : item.installedVersion && item.version !== item.installedVersion ? V.runtimeVersion(item.version ?? '—') : '';
    if (version.hasChildNodes()) card.append(version);
    const actions = ui.h('div', 'extension-card-actions');
    const owner = kind;
    if (item.state !== 'removed') {
      if (item.kind === 'bot') actions.append(ui.button(V.create, { onClick: () => { const box = ui.h('div'); box.append(ui.h('p', '', V.createBody), ui.h('pre', '', 'pnpm start --new')); ui.drawer(item.name, box); } }));
      else if (item.state === 'pending-restart' && !item.enabled) actions.append(ui.button(V.loadRestart, { onClick: () => void activate(item, owner, true) }));
      else if (item.loaded) {
        const toggle = ui.button(item.enabled ? V.unload : V.load, { onClick: () => void activate(item, owner) }); toggle.disabled = !!item.inUse || busy.has(item.name); toggle.title = item.disableReason ?? ''; actions.append(toggle);
      } else actions.append(ui.button(V.details, { onClick: () => showLocal(item) }));
      if (item.kind === 'world' && item.loaded && item.worldId) actions.append(ui.button(V.manage, { onClick: () => router.navigate(['provider', 'world:' + item.worldId]) }));
      if (!item.builtin) {
      const remove = ui.button(V.remove, { variant: 'danger', onClick: async () => { if (await ui.confirm({ title: item.name, body: V.removeBody, danger: true })) void operate('delete', { name: item.name }, 'management', owner); } });
      remove.disabled = !!item.enabled || !!item.inUse || busy.has(item.name); actions.append(remove);
      } else { const remove = ui.button(V.remove, { variant: 'danger' }); remove.disabled = true; remove.title = V.builtinNote; actions.append(remove); }
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
      const heading = ui.h('div', 'extension-card-heading'); const title = ui.h('span', 'extension-card-title', hit.name); title.title = hit.name;
      heading.append(title); if (hit.installed) heading.append(ui.pill(S.alreadyInstalled));
      card.append(heading, ui.h('div', 'extension-meta', `${V.version(hit.version)}${hit.publisher ? '　' + V.author(hit.publisher) : ''}`), ui.h('p', 'extension-description', hit.description));
      const info = ui.rowbar(); info.classList.add('extension-tags');
      if (hit.license) info.append(ui.pill(hit.license));
      if (hit.date) info.append(ui.pill(hit.date.slice(0, 10)));
      info.append(ui.pill(V.downloads(ui.fmt.count(hit.downloads)))); card.append(info); return card;
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
      if (signal.aborted || generation !== loadGeneration) return false;
      installed = data.extensions; installedFetched = true; directory = data.dir; const dirNode = root.querySelector('.extension-directory'); if (dirNode) dirNode.textContent = `${V.directory}：${directory}`; renderInstalled(); renderMarket(); restoreScroll(); return true;
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
      state.hits = data.hits; state.fetched = true; message(owner, 'market', data.partial ? V.partial : ''); if (owner === kind) { renderInstalled(); renderMarket(); restoreScroll(); }
    } catch (error) { if (!signal.aborted && state.generation === generation) { state.fetched = true; message(owner, 'market', S.searchFailed(errorText(error)), true); if (owner === kind) { renderMarket(); restoreScroll(); } } }
  }
  async function operate(action: 'install' | 'delete', target: Target, area: string, owner: ExtensionKindView) {
    const identity = 'name' in target ? target.name : target.path; if (busy.has(identity)) return;
    const actionLabel = action === 'delete' ? V.deletedAction : installed.some(item => item.name === identity) ? V.updatedAction : V.installedAction;
    busy.add(identity); renderInstalled(); message(owner, area, V.progress(actionLabel, identity));
    const id = win.crypto.randomUUID(); pendingOperations.set(identity, { id, kind: owner, area }); saveOperations();
    let finished = false;
    const wait = () => new Promise<void>(resolve => lifecycle.timeout(resolve, 1000));
    try {
      let result: Operation | undefined;
      try { result = await post<Operation>('/api/extensions/operations', { id, action, target, kind: owner }, { signal }); }
      catch (error) {
        if (signal.aborted) return;
        if ((error as { status?: number }).status) { finished = true; throw error; }
        message(owner, area, V.unknown);
        try { result = await get<Operation>('/api/extensions/operations/' + id, { signal }); }
        catch { throw new Error(V.unknown + '\n' + errorText(error) + '\n' + id); }
      }
      const deadline = Date.now() + 120_000;
      while (!signal.aborted && ['preparing', 'validating', 'committing'].includes(result.phase) && Date.now() < deadline) { await wait(); result = await get<Operation>('/api/extensions/operations/' + id, { signal }); }
      if (signal.aborted) return;
      finished = ['committed', 'rolled-back', 'repair-required'].includes(result.phase);
      if (result.phase !== 'committed') throw new Error((result.phase === 'rolled-back' ? V.rolledBack : result.phase === 'repair-required' ? V.repair : V.unknown) + '\n' + (result.error ?? ''));
      message(owner, area, `${V.completed(actionLabel, result.name ?? identity)}${result.version ? ' ' + V.version(result.version) : ''}${action === 'install' && result.kind !== 'bot' ? ' ' + V.restartNeeded : ''}`);
      if (result.name) updates.delete(result.name);
      if (!await load()) message(owner, area, V.completed(actionLabel, result.name ?? identity) + ' ' + V.syncedFailed, true);
    } catch (error) { if (!signal.aborted) message(owner, area, errorText(error), true); }
    finally { if (finished) { busy.delete(identity); pendingOperations.delete(identity); saveOperations(); } else if (!signal.aborted) void recoverStored(identity, { id, kind: owner, area }); if (!signal.aborted) renderInstalled(); }
  }
  async function recoverStored(identity: string, pending: { id: string; kind: ExtensionKindView; area: string }) {
    const deadline = Date.now() + 120_000;
    const query = async () => {
      if (signal.aborted) return;
      try {
        const result = await get<Operation>('/api/extensions/operations/' + pending.id, { signal });
        if (['committed', 'rolled-back', 'repair-required'].includes(result.phase)) {
          pendingOperations.delete(identity); busy.delete(identity); saveOperations();
          message(pending.kind, pending.area, result.phase === 'committed' ? V.completed(result.action === 'delete' ? V.deletedAction : V.installedAction, result.name ?? identity) : (result.phase === 'rolled-back' ? V.rolledBack : V.repair) + '\n' + (result.error ?? ''), result.phase !== 'committed');
          await load(); return;
        }
      } catch { /* Query an existing ID; never repeat the write automatically. */ }
      if (Date.now() >= deadline) { message(pending.kind, pending.area, V.unknown + '\n' + pending.id, true); if (pending.kind === kind) messageNodes[pending.area]?.append(ui.button(V.retry, { onClick: () => void recoverStored(identity, pending) })); return; }
      lifecycle.timeout(() => void query(), 1000);
    };
    message(pending.kind, pending.area, V.unknown); await query();
  }
  async function activate(item: ExtensionView, owner: ExtensionKindView, afterRestart = false) {
    if (busy.has(item.name)) return;
    if ((!item.enabled || await ui.confirm({ title: V.unload, body: V.unloadBody })) && !signal.aborted) {
      if (afterRestart && !await ui.confirm({ title: V.loadRestart, body: ctx.capabilities.supervised ? S.restartConfirmBody : S.restartNoLoopBody })) return;
      busy.add(item.name); renderInstalled();
      try {
        await post('/api/extensions/activation', { name: item.name, enabled: !item.enabled, afterRestart }, { signal });
        message(owner, 'management', afterRestart ? `${V.pendingEnable}：${item.label ?? item.name}` : V.completed(item.enabled ? V.disabledAction : V.enabledAction, item.label ?? item.name));
        if (afterRestart) await restart(true); else { await load(); await ctx.refreshNav?.(); }
      } catch (error) { if (!signal.aborted) message(owner, 'management', errorText(error), true); }
      finally { busy.delete(item.name); if (!signal.aborted) renderInstalled(); }
    }
  }
  function openDetail(hit: SearchHitView, owner: ExtensionKindView) {
    const box = ui.h('div', 'extension-detail'); box.append(ui.placeholder(S.loadingDetail)); ui.drawer(hit.name, box);
    void get<PackageDetailView>(`/api/extensions/package?name=${encodeURIComponent(hit.name)}&version=${encodeURIComponent(hit.version)}`, { signal }).then(data => {
      if (signal.aborted) return; box.replaceChildren(ui.h('h4', '', V.introduction), ui.h('p', '', data.description ?? '—'));
      for (const text of [...data.problems ?? [], ...data.warnings]) box.append(ui.msgline(text, true));
      if (data.deprecated) box.append(ui.msgline(S.deprecated(data.deprecated), true));
      const rows = [
        { k: S.fieldVersion, v: data.version }, { k: S.fieldLicense, v: data.license ?? '—' },
        { k: V.released, v: data.published?.slice(0, 10) ?? '—' },
        { k: S.fieldReleases, v: S.releaseCount(data.versionCount, data.created?.slice(0, 10) ?? '') },
        { k: S.fieldSize, v: data.unpackedSize === undefined ? '—' : S.sizeAndFiles(ui.fmt.bytes(data.unpackedSize), data.fileCount ?? 0) },
        { k: S.fieldMaintainers, v: data.maintainers.join('、') || '—' },
        { k: S.fieldNode, v: data.engines ?? '—' }, { k: S.fieldDeps, v: data.dependencies.join('、') || S.none },
        { k: S.fieldKeywords, v: data.keywords?.join('、') || '—' },
        { k: S.fieldDownloads, v: V.downloads(ui.fmt.count(hit.downloads)) }, { k: S.fieldDependents, v: String(hit.dependents) },
      ];
      box.append(ui.h('h4', '', V.information), ui.kv(rows));
      if (data.history.length) {
        const releases = ui.h('details', 'extension-releases');
        releases.append(ui.h('summary', '', S.fieldHistory));
        const history = ui.h('div', 'extension-history');
        for (const release of data.history) { const row = ui.h('div'); row.append(ui.h('code', '', release.version), ui.h('time', 'muted', release.date.slice(0, 10))); history.append(row); }
        releases.append(history); box.append(releases);
      }
      const actions = ui.rowbar(); actions.classList.add('extension-detail-actions');
      for (const [name, href] of Object.entries(data.links)) if (href && /^https?:\/\//i.test(href)) { const a = ui.h('a', 'btn secondary', V.linkNames[name as keyof typeof V.linkNames]); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; actions.append(a); }
      const button = ui.button(data.installed ? S.alreadyInstalled : S.install, { variant: 'primary', onClick: () => { button.disabled = true; void operate('install', { name: data.name, version: data.version }, 'market', owner).finally(() => { if (box.isConnected) button.disabled = installed.some(item => item.name === data.name); }); } });
      button.disabled = data.installed || !data.manifest || !!data.problems?.length || data.manifest.kind !== owner; actions.append(ui.h('span', 'grow'), button); box.append(actions);
    }).catch(error => { if (!signal.aborted) box.replaceChildren(ui.msgline(errorText(error), true)); });
  }

  async function restart(confirmed = false) {
    if (!confirmed && !await ui.confirm({ title: S.restartConfirmTitle, body: ctx.capabilities.supervised ? S.restartConfirmBody : S.restartNoLoopBody })) return;
    try {
      const before = await get<Life>('/api/run/lifecycle', { signal });
      save(); win.sessionStorage.setItem(storageKey + ':restart', JSON.stringify(before));
      message(kind, 'management', ctx.capabilities.supervised ? V.reloadWait : V.restartManual);
      try { await post('/api/run/restart', undefined, { signal }); } catch (error) {
        if ((error as { status?: number }).status) { win.sessionStorage.removeItem(storageKey + ':restart'); throw error; }
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
        if (restartOutcome(before, next) === 'wrong-deployment') { win.sessionStorage.removeItem(storageKey + ':restart'); message(kind, 'management', V.otherBot, true); return; }
        if (restartOutcome(before, next) === 'ready') { win.sessionStorage.removeItem(storageKey + ':restart'); save(); win.location.reload(); return; }
      } catch { /* Wait while the listener is unavailable. */ }
      if (Date.now() >= deadline) { message(kind, 'management', V.reloadTimeout, true); messageNodes.management.append(ui.button(V.retry, { onClick: () => watchRestart(before) })); return; }
      lifecycle.timeout(() => void check(), 1000);
    }; void check();
  }
  function render() {
    const state = states[kind]; tabs.style.setProperty('--tab-index', String(categories.indexOf(kind)));
    tabButtons.forEach((button, i) => { const active = categories[i] === kind; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }); panel.setAttribute('aria-labelledby', 'extension-tab-' + kind);
    panel.replaceChildren(); messageNodes = {};
    const managed = ui.sheet({ title: S.installedTitle }); management = managed.el;
    const bar = ui.rowbar(); bar.classList.add('extension-toolbar');
    managed.el.querySelector('h3')!.append(ui.h('span', 'extension-directory', `${V.directory}：${directory}`));
    const installedFilters = ui.input({ type: 'search', value: state.installedFilter, placeholder: V.installedFilter, onInput: value => { state.installedFilter = value; state.installedPage = 0; renderInstalled(); save(); } });
    installedFilters.setAttribute('aria-label', V.installedFilter); bar.append(installedFilters, sizePicker('installed'));
    if (ctx.capabilities.restart) { const button = ui.button(S.restartProcess, { onClick: () => void restart() }); button.classList.add('extension-restart'); bar.append(button); }
    bar.append(ui.button(S.refresh, { onClick: () => { void load(); void checkUpdates(); } }));
    messageNodes.management = ui.msgline(kind === 'bot' ? V.createBody : V.idleManagement); messageNodes.management.setAttribute('role', 'status'); installedGrid = ui.h('div', 'extension-grid'); installedPager = ui.rowbar();
    managed.body.append(bar, messageNodes.management, installedGrid, installedPager);
    const marketSheet = ui.sheet({ title: V.market }); market = marketSheet.el; messageNodes.market = ui.msgline(); messageNodes.market.setAttribute('role', 'status');
    const filters = ui.rowbar(); filters.classList.add('extension-toolbar');
    filters.append(ui.input({ type: 'search', value: state.filter, placeholder: S.filterPlaceholder, onInput: value => { state.filter = value; state.page = 0; renderMarket(); save(); } }), ui.select({ value: state.sort, options: HIT_SORTS.map(value => ({ value, label: S.sortLabel[value] })), onChange: value => { state.sort = value as HitSort; state.page = 0; renderMarket(); save(); } }), ui.checkbox(S.hideInstalled, { checked: state.hide, onChange: value => { state.hide = value; state.page = 0; renderMarket(); save(); } }).el, sizePicker('market'), ui.button(S.refresh, { onClick: () => void search(kind) }));
    marketGrid = ui.h('div', 'extension-grid'); marketPager = ui.rowbar(); marketSheet.body.append(filters, messageNodes.market, marketGrid, marketPager);
    const manual = ui.sheet({ title: V.manual }); messageNodes.manual = ui.msgline(); messageNodes.manual.setAttribute('role', 'status');
    const source = ui.segmented([{ value: 'npm', label: V.npm }, { value: 'local', label: V.local }], { value: state.source, onSelect: value => { state.source = value as 'npm' | 'local'; state.input = ''; render(); save(); } });
    const manualBar = ui.rowbar(); const input = ui.input({ value: state.input, placeholder: state.source === 'npm' ? `@scope/cortico-${kind}-demo@1.2.3` : '', onInput: value => { state.input = value; } });
    input.setAttribute('aria-label', state.source === 'npm' ? V.packageLabel : V.pathLabel); manualBar.append(input);
    if (state.source === 'local') manualBar.append(ui.button(V.folder, { onClick: async () => { try { const path = await pickPath({ kind: 'directory', currentPath: input.value }, { signal }); if (path) { state.input = input.value = path; } } catch (error) { message(kind, 'manual', errorText(error), true); } } }));
    const target = (): Target => { if (state.source === 'local' && state.input.trim()) return { path: state.input.trim() }; const value = parseInstallInput(state.input); if (!value) throw new Error(V.invalidInput); return value; };
    const owner = kind;
    const check = ui.button(V.check, { onClick: async () => { const lock = ui.disable(check); try { const data = await post<{ name: string; version: string; kind: string }>('/api/extensions/check', { target: target(), kind: owner }, { signal }); message(owner, 'manual', `${V.checkOk} · ${data.name}@${data.version} · ${data.kind}`); } catch (error) { message(owner, 'manual', errorText(error), true); } finally { lock.dispose(); } } });
    const install = ui.button(S.install, { variant: 'primary', onClick: () => { try { void operate('install', target(), 'manual', owner); } catch (error) { message(owner, 'manual', errorText(error), true); } } });
    const manualActions = ui.rowbar(); manualActions.classList.add('extension-manual-actions'); manualActions.append(check, install, messageNodes.manual);
    manual.body.append(ui.h('p', 'sh-desc extension-install-help', state.source === 'npm' ? V.npmHelp : V.localHelp), source.el, manualBar, manualActions);
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
    for (const label of panel.querySelectorAll<HTMLElement>('.extension-size')) { const option = label.querySelector('option[value="0"]'); if (option) option.textContent = `${V.automatic}（${columns * (label.dataset.area === 'installed' ? 2 : 4)}）`; }
    root.style.setProperty('--extension-columns', String(columns)); renderInstalled(); renderMarket();
  }); observer.observe(panel); lifecycle.add(() => observer.disconnect()); }
  render();
  if (!categories.includes(router.route.segments[1] as ExtensionKindView)) router.replace(['extensions', kind]);
  void load(); void checkUpdates(); void search(kind);
  for (const [identity, pending] of pendingOperations) void recoverStored(identity, pending);
  try { const marker = win.sessionStorage.getItem(storageKey + ':restart'); if (marker) { message(kind, 'management', V.reloadWait); watchRestart(JSON.parse(marker)); } } catch { /* Invalid recovery marker. */ }
}
export const extensionsFeature: FrameworkFeature = { route: 'extensions', label: S.navLabel, icon: 'download', navGroup: S.navGroup, needsAny: ['extensions'], mount: mountExtensions };
