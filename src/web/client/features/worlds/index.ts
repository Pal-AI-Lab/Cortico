/** Both World views keep the same avatar nodes and row geometry. */
import { pageIdFor } from '../../../shared/webui-protocol.ts';
import type { WebUiBadge, WebUiLamp, WebUiLink } from '../../../shared/webui-protocol.ts';
import { get, post } from '../../core/api.ts';
import { PROVIDER_ROUTE } from '../../webui-pages/host.ts';
import { markReturn, navHidden, setNavHidden } from '../../core/world-nav.ts';
import { problemPopover } from '../../ui/problem.ts';
import { brandMark, icon, type WebUiIconName } from '../../ui/icons.ts';
import { lampRow, subscribeLamps } from '../../ui/lamp.ts';
import { pageIntro } from '../../ui/page.ts';
import { pageTabs } from '../../ui/page-tabs.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { mountExtensionContent, iconUrl, type ExtensionView, type ExtensionController } from '../extensions/index.ts';
import { S as E } from '../extensions/strings.ts';
import { worldLibrary, needsRestart, type WorldLibraryItem } from './library.ts';
import { addGroup, arrangeLayout, groupToken, moveGroup, moveItem, readLayout, removeGroup, writeLayout, type WorldGroup, type WorldLayout } from './groups.ts';
import { S } from './strings.ts';
import { S as UI } from '../../ui/strings.ts';
import { measureReflow, prefersStill } from '../../core/motion.ts';
import { dragList, moveGap, settledBox } from '../../core/drag.ts';
import { foldText, searchTerms } from '../extensions/search.ts';

const worldPageId = (id: string) => pageIdFor('world', id);
/** The view switch's duration and curve, as `--world-duration` and `--world-easing` in styles.css. */
const VIEW_MS = 290;
const viewEasing = cubicBezier(.32, .72, 0, 1);
/** A CSS cubic-bezier timing function, solved for x by Newton's method with a bisection fallback. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  const slope = (a: number, b: number, s: number) => 3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s * s;
  return (x: number) => {
    if (x <= 0 || x >= 1) return x <= 0 ? 0 : 1;
    let s = x;
    for (let i = 0; i < 8; i++) { const d = slope(x1, x2, s); if (Math.abs(d) < 1e-6) break; s -= (at(x1, x2, s) - x) / d; }
    if (s < 0 || s > 1 || Math.abs(at(x1, x2, s) - x) > 1e-4) { let lo = 0, hi = 1; s = x; for (let i = 0; i < 30; i++) { if (at(x1, x2, s) < x) lo = s; else hi = s; s = (lo + hi) / 2; } }
    return at(y1, y2, s);
  };
}
/** Row controls, left to right. */
const ACTION_SLOTS = ['sidebar', 'remove', 'visibility', 'power'] as const;
/** Controls outside the action columns. */
type ControlSlot = typeof ACTION_SLOTS[number] | 'info';
type ActionSlot = typeof ACTION_SLOTS[number];
export interface WorldView {
  id: string;
  status: 'active' | 'inactive' | 'missing';
  /** World 自报的状态灯,一条链路一颗(仅 active 有意义)。 */
  lamps?: WebUiLamp[];
  /** 人类可读名;没有就退回 id。 */
  label?: string;
  /** Persona定义的渠道;false = 部署侧选配的外挂;undefined = 没说。 */
  declared?: boolean;
  /** 当前对 agent 可见(仅 active 有意义)。 */
  visible?: boolean;
  /** 可见性已改,但当前 system 前缀还是按旧的烘出来的。 */
  prefixDrifted?: boolean;
  /** 装不上的原因(missing),或启用了却没在运行的原因(inactive)。原样显示,这一页不改写措辞。 */
  reason?: string;
  workspace?: string;
  tools?: string[];
  badges?: WebUiBadge[];
  links?: WebUiLink[];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}


export function mountWorlds(ctx: FeatureContext): void {
  const { ui, root, signal, lifecycle, router } = ctx;
  const doc = root.ownerDocument, win = doc.defaultView!;
  const canToggleVisibility = ctx.capabilities.worldVisibility === true;
  const canActivate = ctx.capabilities.worldActivation === true;
  const canBrowse = ctx.capabilities.extensions === true;
  let worlds: WorldView[] = [], extensions: readonly ExtensionView[] = [];
  let selected = '', current = '', generation = 0, focusRequested = false;
  let market: ExtensionController | undefined;
  const recent: string[] = [];
  /** The package just installed from the market, landing in the rail on its next render. */
  let arrival: { key: string; from?: DOMRect } | undefined;
  let worldsReady = !ctx.capabilities.worlds, extensionsReady = !canBrowse;
  /** The extension list arrived, so a World without a package is built in. */
  let extensionsListed = false;
  /** Installed packages with an update, by name, as the market last reported them. */
  let updatable: ReadonlyMap<string, { installedVersion: string; latestVersion: string }> = new Map();
  const layoutKey = `cortico.world-layout:${win.location.origin}`;
  let savedLayout: { positions: [string, number][]; scroll: number; at: number } | undefined;
  try {
    const value = JSON.parse(win.sessionStorage.getItem(layoutKey) || 'null');
    win.sessionStorage.removeItem(layoutKey);
    if (value && Number.isFinite(value.at) && Date.now() - value.at < 120000 && Number.isFinite(value.scroll)
      && Array.isArray(value.positions) && value.positions.every((pair: unknown) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && Number.isFinite(pair[1]))) savedLayout = value;
  } catch { /* Storage may be unavailable. */ }

  const lampNodes = new Map<string, HTMLSpanElement>();
  const railNodes = new Map<string, HTMLButtonElement>();
  const movements = new Set<Animation>();
  lifecycle.add(() => { for (const animation of movements) animation.cancel(); });
  lifecycle.own(subscribeLamps(doc, lamps => {
    for (const [id, el] of lampNodes) paintSignals(el, lamps[id] ?? []);
  }));
  const intro = pageIntro(ui, S.introTitle); intro.classList.add('world-intro');
  const tabs = pageTabs(doc, signal, [
    { value: 'mine', label: S.myWorlds },
    ...(canBrowse ? [{ value: 'market', label: S.marketTab }] : []),
  ], { onSelect: value => router.navigate(['world'], value === 'market' ? { view: 'market' } : undefined) });
  intro.append(tabs.el);
  const workspace = ui.h('div', 'world-workspace');
  const rail = ui.h('section', 'world-library'); rail.setAttribute('aria-label', S.extensionList);
  const railList = ui.h('div', 'world-library-list');
  const pendingGroup = ui.h('div', 'world-pending-group');
  const pendingList = ui.h('div', 'world-pending-list');
  const restartRoot = ui.h('div', 'world-restart-footer');
  const readyList = ui.h('div', 'world-ready-list');
  const readyGroup = ui.h('div', 'world-ready-group');
  const restartRow = ui.h('div', 'world-restart-row'); restartRow.append(restartRoot, ui.h('span', 'world-restart-note', S.pendingNote));
  pendingGroup.append(ui.h('h2', 'world-library-heading', E.statePendingRestart), pendingList, restartRow); pendingGroup.hidden = true;
  const readyHeading = ui.h('h2', 'world-library-heading', S.extensionList);
  readyGroup.append(readyHeading, readyList);
  railList.append(pendingGroup, readyGroup);
  // My World's filter row and groups. Filtering, collapsing and dragging apply to the rows view;
  // the market view's rail shows every avatar in the user's order.
  let layout: WorldLayout | undefined = readLayout(win.localStorage);
  let filterText = '', filterState = 'all';
  const filtering = () => !!filterText.trim() || filterState !== 'all';
  const tools = ui.h('div', 'world-library-tools');
  const search = ui.input({ type: 'search', placeholder: S.filterByName, onInput: value => { filterText = value; applyFilter(true); } });
  search.setAttribute('aria-label', S.filterByName);
  const stateFilter = ui.select({ value: 'all', options: [
    { value: 'all', label: S.allStates }, { value: 'attached', label: S.modeAttached }, { value: 'running', label: S.modeRunning },
    { value: 'inactive', label: S.modeOff }, { value: 'pending', label: E.statePendingRestart }, { value: 'failed', label: E.stateFailed },
  ], onChange: value => { filterState = value; applyFilter(true); } });
  const newGroup = ui.button(S.newGroup, { size: 'sm', onClick: () => createGroup() });
  tools.append(search, stateFilter, newGroup);
  readyHeading.after(tools);
  const noMatches = ui.h('p', 'world-no-matches', S.noMatches); noMatches.hidden = true; readyGroup.append(noMatches);
  const groupNodes = new Map<string, { el: HTMLElement; head: HTMLElement; name: HTMLElement; count: HTMLElement; list: HTMLElement }>();
  const status = ui.h('div', 'world-workspace-status');
  const catalog = ui.h('div', 'world-pane world-market');
  const msg = ui.msgline(); msg.setAttribute('role', 'status');
  rail.append(railList);
  const feedback = ui.h('div', 'world-feedback'); feedback.append(msg);
  workspace.append(rail, catalog); root.append(intro, status, feedback, workspace);
  /** Name tag beside a rail avatar in the market view, where the rail shows avatars alone. */
  const dockTip = ui.h('div', 'u-tip world-dock-tip hidden'); dockTip.setAttribute('role', 'tooltip');
  doc.body.append(dockTip); lifecycle.add(() => dockTip.remove());
  const hideTip = () => dockTip.classList.add('hidden');
  function showTip(node: HTMLElement, item: WorldLibraryItem) {
    if (current !== 'market') return;
    dockTip.dataset.state = node.parentElement?.dataset.state ?? '';
    dockTip.replaceChildren(ui.h('b', '', item.label), ui.h('span', '', node.parentElement?.querySelector('.world-state')?.textContent ?? ''));
    dockTip.classList.remove('hidden');
    const target = node.querySelector('.world-avatar')!.getBoundingClientRect(), tip = dockTip.getBoundingClientRect();
    dockTip.style.left = `${target.right + 16}px`;
    dockTip.style.top = `${Math.max(8, Math.min(target.top + target.height / 2 - tip.height / 2, doc.documentElement.clientHeight - tip.height - 8))}px`;
  }
  doc.addEventListener('scroll', hideTip, { capture: true, passive: true, signal });
  const reduceMotion = () => prefersStill(win);
  let transition: Animation | undefined;
  let viewGeneration = 0;
  lifecycle.add(() => transition?.cancel());
  const show = () => {
    if (signal.aborted || router.route.segments[0] !== 'world') return;
    const next = canBrowse && router.route.query.view === 'market' ? 'market' : 'mine';
    if (next === current) return;
    const generation = ++viewGeneration;
    const previous = current; current = next;
    transition?.cancel();
    // Going to the market the rows shrink into the dock. Its scroll moves, on the rows' own curve, to
    // where the first row in view will sit, so a scrolled rail glides instead of snapping when it
    // gets shorter than its scroll position. Going back the rail only grows and needs no help.
    const listTop = railList.getBoundingClientRect().top;
    const anchor = previous && next === 'market' && !reduceMotion() ? [...railList.querySelectorAll<HTMLElement>('.world-library-entry:not(.motion-ghost)')].find(entry => entry.offsetParent && entry.getBoundingClientRect().bottom > listTop + 4) : undefined;
    const glideFrom = railList.scrollTop, anchorAt = anchor ? anchor.getBoundingClientRect().top - listTop : 0;
    workspace.dataset.view = next; hideTip();
    if (anchor) {
      const dock = dockLayout();
      const to = Math.max(0, Math.min((dock.tops.get(anchor) ?? 0) - anchorAt, dock.height - railList.clientHeight));
      // The scroll follows the anchor row's own height transition, which starts a frame or two after
      // the switch; the clock is the fallback when the row's height does not change.
      let start: number | undefined, seen = false;
      const glide = (now: number) => {
        if (signal.aborted || generation !== viewGeneration) return;
        start ??= now;
        const own = anchor.getAnimations?.().find(animation => (animation as CSSTransition).transitionProperty === 'height');
        if (own) seen = true;
        // Waiting for the transition to start holds still; once it has run and gone, the glide ends.
        const waited = now - start, clock = Math.min(1, Math.max(0, waited - 80) / VIEW_MS);
        const progress = own ? own.effect?.getComputedTiming().progress ?? 0 : seen ? 1 : viewEasing(clock);
        const done = !own && (seen || clock >= 1);
        railList.scrollTop = glideFrom + (to - glideFrom) * (done ? 1 : progress);
        if (!done) win.requestAnimationFrame(glide);
      };
      if (to !== glideFrom) win.requestAnimationFrame(glide);
    }
    tabs.setValue(next);
    catalog.inert = next !== 'market';
    for (const row of railList.querySelectorAll<HTMLElement>('.world-blade')) row.inert = next === 'market';
    tools.inert = next === 'market'; syncDraggable();
    for (const id of groupNodes.keys()) { const group = layout?.groups[id]; if (group) paintGroup(group); }
    if (next === 'mine' && catalog.contains(doc.activeElement)) tabs.el.querySelector<HTMLButtonElement>('[aria-current=page]')?.focus();
    if (next === 'mine' && focusRequested) focusSelected();
    // Entering, the market slides in over the rows shrinking into the dock. Leaving, it goes at once: the
    // rows take My World's layout straight away, and a market still sliding out behind them showed
    // through, for longer whenever the page was busy (a filter's reflow still running, say).
    catalog.hidden = next !== 'market';
    if (next === 'market' && previous && !reduceMotion() && catalog.animate)
      transition = catalog.animate([{ clipPath: 'inset(0 0 0 100%)' }, { clipPath: 'inset(0 0 0 0%)' }], { duration: 290, easing: 'cubic-bezier(.32,.72,0,1)' });
    if (next === 'market') market?.activate(transition?.playState === 'running' ? transition.finished : undefined);
  };
  lifecycle.own(router.onChange(show)); show();
  if (canBrowse) market = mountExtensionContent({ ...ctx, root: catalog }, 'world', {
    statusRoot: status, restartRoot,
    beforeReload: () => {
      try { win.sessionStorage.setItem(layoutKey, JSON.stringify({ positions: [...railNodes].filter(([, node]) => node.parentElement!.dataset.state === 'pending').map(([key, node]) => [key, node.parentElement!.getBoundingClientRect().top]), scroll: railList.scrollTop, at: Date.now() })); } catch { /* Storage may be unavailable. */ }
    },
    onChange: items => { extensions = items; extensionsReady = true; extensionsListed = true; void load(); },
    onLoadError: () => { extensionsReady = true; render(); },
    onUpdates: next => { updatable = next; render(); },
    reveal: name => { const item = worldLibrary(worlds, extensions, recent).find(entry => entry.key === name); if (item) reveal(item); },
    onAdded: (name, from) => { const previous = recent.indexOf(name); if (previous >= 0) recent.splice(previous, 1); recent.unshift(name); selected = name; arrival = { key: name, from }; railList.scrollTop = 0; },
  });
  else status.hidden = true;
  function setMsg(text: string, bad?: boolean): void {
    msg.textContent = text;
    msg.className = 'msgline' + (bad ? ' bad' : '');
  }

  async function reloadPrefix(id: string): Promise<void> {
    try {
      await post('/api/session/reload-prefix', undefined, { signal });
      if (!signal.aborted) await load();
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      const control = controlOf(id, 'visibility');
      if (control) problems.show(control, S.prefixReloadFailed(errText(err))); else setMsg(S.prefixReloadFailed(errText(err)), true);
    }
  }

  const problems = problemPopover(doc, signal);
  /** The row control an action on World `id` started from, as it is after the row re-renders. */
  const controlOf = (id: string, slotName: ActionSlot) => railList.querySelector(`.world-blade[data-world="${CSS.escape(id)}"] [data-slot="${slotName}"]`);
  const changingWorlds = new Set<string>();
  async function changeWorld(m: WorldView, action: 'activation' | 'visibility', value: boolean): Promise<void> {
    if (changingWorlds.has(m.id)) return;
    changingWorlds.add(m.id); setMsg(''); render();
    let drifted = false, problem: string | undefined;
    try {
      if (action === 'activation' && !value && (!await ui.confirm({ title: S.deactivateTitle(m.label || m.id), body: S.deactivateBody, danger: true }) || signal.aborted)) return;
      // Visibility is asked first too, so Cancel leaves it as it was.
      if (action === 'visibility' && (!await ui.confirm({ title: S.visibilityTitle(m.label || m.id, value), body: S.visibilityBody(value) }) || signal.aborted)) return;
      const out = await post<{ driftedWorlds?: string[] }>(`/api/worlds/${action}`, action === 'activation' ? { id: m.id, enabled: value } : { id: m.id, visible: value }, { signal });
      drifted = action === 'visibility' && !!out.driftedWorlds?.length;
      if (!signal.aborted) void ctx.refreshNav?.().catch(ctx.onError);
    } catch (error) {
      if (!isAbort(error) && !signal.aborted) problem = S.toggleFailed(errText(error));
    } finally {
      changingWorlds.delete(m.id);
      if (!signal.aborted) await load();
    }
    const control = problem === undefined ? null : controlOf(m.id, action === 'activation' ? 'power' : 'visibility');
    if (problem !== undefined) { if (control) problems.show(control, problem); else setMsg(problem, true); return; }
    // The confirmation said the current conversation takes the change at once.
    if (drifted && !signal.aborted) await reloadPrefix(m.id);
  }

  const slot = (name: ControlSlot, button: HTMLButtonElement) => { button.dataset.slot = name; return button; };
  function iconButton(
    name: WebUiIconName,
    label: string,
    cls: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = ui.h('button', `iobtn ${cls}`);
    btn.type = 'button';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.appendChild(icon(doc, name));
    btn.addEventListener('click', onClick, { signal: ctx.signal });
    return btn;
  }


  /** Packages without an icon, or whose icon fails to load, show the Cortico mark. */
  function avatar(item: WorldLibraryItem): HTMLElement {
    const box = ui.h('span', 'world-avatar');
    const fallback = () => { box.classList.add('is-default'); box.replaceChildren(brandMark(doc)); };
    if (item.extension?.icon) {
      const img = ui.h('img'); img.alt = ''; img.src = iconUrl(item.extension.name, item.extension.installedVersion ?? item.extension.version);
      img.addEventListener('error', fallback, { once: true, signal }); box.append(img);
    } else fallback();
    return box;
  }
  /** The new avatar flies from the market card into its rail slot, or pops in when it has no origin. */
  function land(node: HTMLElement, from?: DOMRect) {
    const entry = node.parentElement!, face = node.querySelector<HTMLElement>('.world-avatar')!;
    const height = entry.getBoundingClientRect().height;
    entry.animate?.([{ height: '0px', minHeight: '0px', marginBottom: '0px', opacity: 0 }, { height: `${height}px`, minHeight: `${height}px`, opacity: 1 }], { duration: 180, easing: 'cubic-bezier(.32,.72,0,1)' });
    const pop = () => face.animate?.([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1.12)', opacity: 1, offset: .6 }, { transform: 'scale(1)' }], { duration: 270, easing: 'cubic-bezier(.32,.72,0,1)' });
    if (!from || current !== 'market' || !face.animate) { pop(); return; }
    const to = face.getBoundingClientRect();
    const ghost = face.cloneNode(true) as HTMLElement; ghost.classList.add('world-avatar-ghost');
    Object.assign(ghost.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
    doc.body.append(ghost); face.style.opacity = '0';
    const dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2), scale = from.width / to.width;
    const flight = ghost.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 1 },
      { transform: `translate(${dx * .45}px, ${dy * .45 - 48}px) scale(${(scale + 1) / 2 * 1.08})`, offset: .45 },
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
    ], { duration: 450, easing: 'cubic-bezier(.45,.05,.25,1)' });
    const finish = () => { ghost.remove(); face.style.opacity = ''; if (!signal.aborted) face.animate?.([{ transform: 'scale(1.14)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'cubic-bezier(.32,.72,0,1)' }); };
    void flight.finished.then(finish, finish);
    lifecycle.add(() => ghost.remove());
  }
  /** In the market view a rail avatar opens its package's install information; elsewhere it shows the World's row. */
  function select(item: WorldLibraryItem) {
    if (current === 'market' && item.extension && market) market.details(item.extension.name); else reveal(item);
  }
  function reveal(item: WorldLibraryItem) {
    selected = item.key; focusRequested = true;
    router.navigate(['world']);
    for (const [key, node] of railNodes) node.setAttribute('aria-current', key === selected ? 'true' : 'false');
    if (current === 'mine') focusSelected();
  }
  function focusSelected() {
    focusRequested = false;
    const row = Array.from(railList.querySelectorAll<HTMLElement>('.world-blade')).find(row => row.dataset.key === selected);
    if (row) { row.scrollIntoView?.({ block: 'nearest', behavior: reduceMotion() ? 'instant' : 'smooth' }); row.focus({ preventScroll: true }); }
  }
  /**
   * Where each row's tile sits in the market view's dock, and the dock's height, from the dock's fixed
   * sizes in styles.css: 74px tiles, the pending group's 10px padding, 1px rule and 12px margin, a
   * group's 1px bottom border and the list's 24px bottom padding. Headings, filters and group headers
   * fold to nothing there.
   */
  function dockLayout(): { tops: Map<HTMLElement, number>; height: number } {
    const TILE = 74, PENDING_TAIL = 23, GROUP_TAIL = 1, LIST_TAIL = 24;
    const tops = new Map<HTMLElement, number>(); let y = 0;
    const place = (entry: HTMLElement) => { tops.set(entry, y); y += TILE; };
    if (!pendingGroup.hidden) { for (const entry of pendingList.querySelectorAll<HTMLElement>(':scope > .world-library-entry:not(.motion-ghost)')) place(entry); y += PENDING_TAIL; }
    if (!readyGroup.hidden) for (const child of readyList.children) {
      if (child.classList.contains('motion-ghost')) continue;
      if (child.classList.contains('world-library-entry')) place(child as HTMLElement);
      else if (child.classList.contains('world-group')) { for (const entry of child.querySelectorAll<HTMLElement>('.world-group-list > .world-library-entry:not(.motion-ghost)')) place(entry); y += GROUP_TAIL; }
    }
    return { tops, height: y + LIST_TAIL };
  }
  /** Orders `container`'s children as `nodes`, moving only what is out of place. */
  function placeChildren(container: HTMLElement, nodes: readonly HTMLElement[]) {
    let cursor = container.firstElementChild;
    for (const node of nodes) {
      while (cursor && cursor.classList.contains('placeholder')) cursor = cursor.nextElementSibling;
      if (node === cursor) { cursor = cursor.nextElementSibling; continue; }
      container.insertBefore(node, cursor);
    }
  }
  function groupNode(group: WorldGroup) {
    let node = groupNodes.get(group.id);
    if (!node) {
      const el = ui.h('section', 'world-group'); el.dataset.group = group.id;
      const head = ui.h('div', 'world-group-head');
      const toggle = ui.h('button', 'world-group-toggle') as HTMLButtonElement; toggle.type = 'button';
      const name = ui.h('span', 'world-group-name'), count = ui.h('span', 'world-group-count');
      toggle.append(ui.h('span', 'world-group-chevron'), name, count);
      toggle.addEventListener('click', () => { const own = layout?.groups[group.id]; if (!own || !layout) return; own.collapsed = !own.collapsed; writeLayout(win.localStorage, layout); paintGroup(own); syncDraggable(); }, { signal });
      head.append(toggle,
        iconButton('pencil', S.renameGroup, 'world-group-action', () => renameGroup(group.id)),
        iconButton('trash', S.deleteGroup, 'world-group-action', () => { if (!layout) return; removeGroup(layout, group.id); writeLayout(win.localStorage, layout); groupNodes.get(group.id)?.el.remove(); groupNodes.delete(group.id); reorder(); }));
      head.dataset.group = group.id;
      const list = ui.h('div', 'world-group-list');
      el.append(head, list);
      node = { el, head, name, count, list }; groupNodes.set(group.id, node);
    }
    return node;
  }
  function paintGroup(group: WorldGroup) {
    const node = groupNode(group);
    node.name.textContent = group.name; node.count.textContent = String(node.list.childElementCount);
    node.el.classList.toggle('is-collapsed', group.collapsed); node.list.inert = group.collapsed && current === 'mine';
    node.head.querySelector('.world-group-toggle')!.setAttribute('aria-expanded', String(!group.collapsed));
  }
  /** Places the ready rows and the groups by the saved layout, recording every row it places. */
  function placeReady(ready: readonly WorldLibraryItem[]) {
    const labels = new Map(ready.map(item => [item.key, item.label]));
    const arranged = arrangeLayout(layout, ready.map(item => item.key), key => labels.get(key) ?? key);
    layout = arranged.layout; writeLayout(win.localStorage, layout);
    const entryOf = (key: string) => railNodes.get(key)!.parentElement as HTMLElement;
    const live = new Set<string>();
    placeChildren(readyList, arranged.entries.map(entry => {
      if ('key' in entry) return entryOf(entry.key);
      live.add(entry.group.id);
      const node = groupNode(entry.group);
      placeChildren(node.list, entry.keys.map(entryOf));
      return node.el;
    }));
    // Counted once every row is placed: a row that left a group drawn earlier is out of its list by now.
    for (const entry of arranged.entries) if (!('key' in entry)) paintGroup(entry.group);
    for (const [id, node] of groupNodes) if (!live.has(id)) { node.el.remove(); groupNodes.delete(id); }
    applyFilter(); syncDraggable();
  }
  /** Re-renders after a layout change, sliding rows and groups from where they were, or from `from`. */
  function reorder(from?: ReadonlyMap<HTMLElement, number>) {
    const tracked = [...readyList.querySelectorAll<HTMLElement>('.world-library-entry:not(.motion-ghost), .world-group-head:not(.motion-ghost)')];
    const before = new Map(tracked.map(el => [el, from?.get(el) ?? el.getBoundingClientRect().top]));
    render();
    if (reduceMotion()) return;
    for (const [el, top] of before) {
      if (!el.isConnected) continue;
      const delta = top - el.getBoundingClientRect().top;
      if (delta) el.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.32,.72,0,1)' });
    }
  }
  function createGroup() {
    if (!layout) return;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    addGroup(layout, S.groupDefaultName, id); writeLayout(win.localStorage, layout);
    reorder(); renameGroup(id);
  }
  function renameGroup(id: string) {
    const group = layout?.groups[id], node = groupNodes.get(id);
    if (!group || !node || !layout) return;
    const own = layout;
    const input = ui.input({ value: group.name }); input.classList.add('world-group-rename'); input.setAttribute('aria-label', S.renameGroup);
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return; done = true;
      const name = input.value.trim();
      if (commit && name) { group.name = name; writeLayout(win.localStorage, own); }
      input.replaceWith(node.name); paintGroup(group);
    };
    input.addEventListener('keydown', event => { if (event.key === 'Enter') finish(true); else if (event.key === 'Escape') finish(false); event.stopPropagation(); }, { signal });
    input.addEventListener('blur', () => finish(true), { signal });
    input.addEventListener('click', event => event.stopPropagation(), { signal });
    node.name.replaceWith(input); input.focus(); input.select();
  }
  /** My World's rows, group headers, headings and restart row, for animating what a render or filter changes. */
  const RAIL_ITEMS = '.world-library-entry, .world-group-head, .world-library-heading, .world-restart-row';
  const railKey = (el: HTMLElement) => el.closest('.world-drag-copy') ? undefined : el.classList.contains('world-library-entry') ? `row:${el.dataset.key}`
    : el.classList.contains('world-group-head') ? `group:${el.closest<HTMLElement>('.world-group')?.dataset.group}`
    : el.classList.contains('world-restart-row') ? 'restart' : `heading:${el.closest('.world-pending-group') ? 'pending' : 'ready'}`;
  /** The market view's dock has its own motion; only the rows view reflows. */
  const measureRail = () => current === 'mine' ? measureReflow(railList, RAIL_ITEMS, railKey) : undefined;
  function applyFilter(animate = false) {
    const reflow = animate ? measureRail() : undefined;
    const terms = searchTerms(filterText), active = filtering();
    for (const entry of readyList.querySelectorAll<HTMLElement>('.world-library-entry')) {
      entry.classList.toggle('is-filtered-out', active && !(terms.every(term => entry.dataset.name?.includes(term)) && (filterState === 'all' || entry.dataset.state === filterState)));
    }
    for (const node of groupNodes.values()) node.el.classList.toggle('is-filtered-out', active && !node.list.querySelector('.world-library-entry:not(.is-filtered-out)'));
    noMatches.hidden = !active || !!readyList.querySelector('.world-library-entry:not(.is-filtered-out)');
    syncDraggable();
    reflow?.play();
  }
  /** Rows and groups can be moved in the rows view while no filter hides any of them. */
  function canMove() { return current === 'mine' && !filtering(); }
  function syncDraggable() {
    const on = canMove();
    for (const entry of readyList.querySelectorAll<HTMLElement>('.world-library-entry')) entry.classList.toggle('is-movable', on);
    for (const node of groupNodes.values()) node.head.classList.toggle('is-movable', on);
  }
  // Dragging (core/drag.ts). A row over a group's header joins the group at its top (the header
  // lights up); otherwise a row or group lands before or after the row under the pointer, by which half
  // the pointer is over.
  let dragging: { kind: 'item'; key: string } | { kind: 'group'; id: string } | undefined;
  let dropAt: { group: string | null; before: string | null; head?: HTMLElement } | undefined;
  let gap: HTMLElement | undefined;
  const tokenOf = (el: Element | null): string | null => !el ? null : el.classList.contains('world-group') ? groupToken((el as HTMLElement).dataset.group!) : (el as HTMLElement).dataset.key ?? null;
  const nextToken = (el: Element) => tokenOf(el.nextElementSibling);
  const elementOf = (token: string): HTMLElement | undefined => token.startsWith('group:') ? groupNodes.get(token.slice('group:'.length))?.el : railNodes.get(token)?.parentElement ?? undefined;
  function clearDrop() {
    dropAt = undefined;
    for (const node of groupNodes.values()) node.head.classList.remove('is-drop-target');
  }
  /** Where a drop at `y` would land; the empty place moves there. */
  function locateDrop(y: number) {
    if (!dragging) return;
    clearDrop();
    const shown = (el: Element): el is HTMLElement => (el as HTMLElement).offsetParent !== null && !el.classList.contains('is-dragging');
    if (dragging.kind === 'item') {
      const head = [...groupNodes.values()].map(node => node.head).find(el => { const r = settledBox(el); return y >= r.top && y <= r.bottom; });
      if (head && y < settledBox(head).top + head.offsetHeight / 3) { dropAt = { group: null, before: groupToken(head.dataset.group!) }; placeGap(); return; }
      const first = [...readyList.children].find(shown);
      if (!head && first && y < settledBox(first).top) { dropAt = { group: null, before: tokenOf(first) }; placeGap(); return; }
      if (head) { const group = layout?.groups[head.dataset.group!]; dropAt = { group: head.dataset.group!, before: group?.items.find(key => key !== (dragging as { key: string }).key) ?? null, head }; head.classList.add('is-drop-target'); placeGap(); return; }
      const rows = [...readyList.querySelectorAll<HTMLElement>('.world-library-entry:not(.motion-ghost)')].filter(el => shown(el) && !el.closest('.world-group.is-collapsed'));
      const over = rows.find(el => { const r = settledBox(el); return y >= r.top && y <= r.bottom; }) ?? rows.find(el => settledBox(el).top > y);
      if (!over) { dropAt = { group: null, before: null }; placeGap(); return; }
      const r = settledBox(over), after = y > r.top + r.height / 2 && y <= r.bottom;
      const groupEl = over.parentElement!.classList.contains('world-group-list') ? over.parentElement!.parentElement as HTMLElement : null;
      dropAt = { group: groupEl?.dataset.group ?? null, before: after ? nextToken(over) : over.dataset.key! };
      placeGap(); return;
    }
    const nodes = [...readyList.children].filter(shown).filter(el => !el.classList.contains('placeholder'));
    const over = nodes.find(el => { const r = settledBox(el); return y >= r.top && y <= r.bottom; }) ?? nodes.find(el => settledBox(el).top > y);
    if (!over) { dropAt = { group: null, before: null }; placeGap(); return; }
    const r = settledBox(over), after = y > r.top + r.height / 2 && y <= r.bottom;
    dropAt = { group: null, before: after ? nextToken(over) : tokenOf(over) };
    placeGap();
  }
  /** Moves the dragged element's empty place to the drop target. */
  function placeGap() {
    if (!gap || !dropAt || !dragging) return;
    const inGroup = dragging.kind === 'item' && dropAt.group ? groupNodes.get(dropAt.group) : undefined;
    const next = dropAt.before && !(inGroup && dropAt.before.startsWith('group:')) ? elementOf(dropAt.before) ?? null : null;
    moveGap(gap, inGroup ? inGroup.list : readyList, next, [...readyList.querySelectorAll<HTMLElement>('.world-library-entry:not(.motion-ghost), .world-group-head')]);
  }
  /** Ends a drag; the layout puts every row and group where it belongs, sliding them there. */
  function settleDrag(from?: ReadonlyMap<HTMLElement, number>) { dragging = undefined; gap = undefined; clearDrop(); reorder(from); }
  dragList(readyGroup, {
    pick(target) {
      if (!canMove()) return null;
      // A group moves by its header (its name toggles it on a plain click); a row by anywhere but its controls.
      const head = target.closest<HTMLElement>('.world-group-head');
      if (head ? target.closest('.world-group-action, input') : target.closest('button, a, input, select, textarea')) return null;
      return head ? head.parentElement : target.closest<HTMLElement>('.world-library-entry');
    },
    lifted(el) {
      gap = el; hideTip();
      dragging = el.classList.contains('world-group') ? { kind: 'group', id: el.dataset.group! } : { kind: 'item', key: el.dataset.key! };
    },
    locate: locateDrop,
    drop(el, copyTop) {
      if (!dragging || !dropAt || !layout) { settleDrag(); return; }
      if (dragging.kind === 'item') moveItem(layout, dragging.key, dropAt.group, dropAt.group ? (dropAt.before && !dropAt.before.startsWith('group:') ? dropAt.before : null) : dropAt.before);
      else moveGroup(layout, dragging.id, dropAt.before);
      writeLayout(win.localStorage, layout);
      // The dropped row or group slides into place from where its copy was.
      const moved = dragging.kind === 'group' ? el.querySelector<HTMLElement>('.world-group-head') ?? el : el;
      settleDrag(new Map([[moved, copyTop]]));
    },
    cancel: () => settleDrag(),
    layer: readyGroup, scroller: railList, copyClass: 'world-drag-copy',
  }, signal);

  function renderRail(items: readonly WorldLibraryItem[]) {
    const restored = worldsReady && extensionsReady ? savedLayout : undefined;
    const positions = new Map(restored?.positions);
    if (restored) savedLayout = undefined;
    // Rows that appear, go or change lists move as a reflow, unless the rail is restoring its layout
    // or landing an arrival, which move on their own. The first fill after the page opens is no change and stays still.
    const reflow = restored || arrival || !railNodes.size ? undefined : measureRail();
    pendingGroup.hidden = !items.some(needsRestart);
    for (const [key, node] of railNodes) if (!items.some(item => item.key === key)) { node.parentElement?.remove(); railNodes.delete(key); }
    const cursors = new Map<HTMLElement, Element | null>([[pendingList, pendingList.firstElementChild]]);
    for (const item of items) {
      let node = railNodes.get(item.key);
      if (!node) {
        node = ui.h('button', 'world-library-item'); node.type = 'button';
        node.append(avatar(item), ui.h('span', 'world-library-label'));
        const own = node;
        node.addEventListener('click', () => { hideTip(); const current = worldLibrary(worlds, extensions, recent).find(entry => entry.key === own.dataset.key); if (current) select(current); }, { signal });
        for (const event of ['pointerenter', 'focus']) node.addEventListener(event, () => showTip(own, worldLibrary(worlds, extensions, recent).find(entry => entry.key === own.dataset.key) ?? item), { signal });
        for (const event of ['pointerleave', 'blur']) node.addEventListener(event, hideTip, { signal });
        node.dataset.key = item.key; railNodes.set(item.key, node);
      }
      node.querySelector('.world-library-label')!.textContent = item.label.replace(/^cortico-world-/, '');
      node.setAttribute('aria-label', item.label); node.setAttribute('aria-current', item.key === selected ? 'true' : 'false');
      const row = worldRow(item); row.inert = current === 'market';
      let entry = node.parentElement;
      if (!entry) { entry = ui.h('div', 'world-library-entry'); entry.append(node, row); }
      else entry.querySelector('.world-blade')!.replaceWith(row);
      entry.dataset.state = row.dataset.state; entry.dataset.key = item.key;
      entry.dataset.name = foldText(`${item.label} ${item.key}`);
      if (!needsRestart(item)) { if (!entry.parentElement) readyList.append(entry); continue; }
      const cursor = cursors.get(pendingList)!;
      if (entry !== cursor) pendingList.insertBefore(entry, cursor);
      cursors.set(pendingList, entry.nextElementSibling);
    }
    placeReady(items.filter(item => !needsRestart(item)));
    if (restored) railList.scrollTop = restored.scroll;
    const landing = arrival && railNodes.get(arrival.key);
    if (landing && arrival) { const { from } = arrival; arrival = undefined; if (!reduceMotion()) land(landing, from); }
    for (const [key, node] of railNodes) {
      const before = positions.get(key), delta = before === undefined ? 0 : before - node.parentElement!.getBoundingClientRect().top;
      if (delta && node.parentElement!.dataset.state !== 'pending' && node.parentElement!.dataset.state !== 'failed' && !reduceMotion()) {
        const animation = node.parentElement!.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: 340, easing: 'cubic-bezier(.2,.7,.2,1)' });
        if (animation) { movements.add(animation); void animation.finished.then(() => movements.delete(animation), () => movements.delete(animation)); }
      }
    }
    reflow?.play();
  }
  function paintSignals(host: HTMLElement, lamps: readonly WebUiLamp[]): void {
    const signature = JSON.stringify(lamps);
    if (host.dataset.lamps === signature) return;
    host.dataset.lamps = signature;
    host.replaceChildren(...lamps.map(lamp => {
      const reading = ui.h('span', 'world-signal');
      const text = `${lamp.label} · ${lamp.hint || UI.lamp[lamp.state]}`;
      reading.title = text; reading.append(lampRow(doc, [lamp]), ui.h('span', '', text)); return reading;
    }));
    host.hidden = !lamps.length;
  }
  function worldRow(item: WorldLibraryItem): HTMLElement {
    const row = ui.h('article', 'world-blade'); row.dataset.key = item.key; row.tabIndex = -1;
    const { world: m, extension: pack } = item;
    const pending = pack?.state === 'pending-restart' || pack?.state === 'removed';
    const failed = pack?.state === 'failed' || m?.status === 'missing';
    row.dataset.state = pending ? 'pending' : failed ? 'failed' : m?.status === 'active' ? m.visible === false ? 'running' : 'attached' : 'inactive';
    const identity = ui.h('div', 'world-blade-identity');
    const heading = ui.h('h3');
    // The name opens the package's extension info, as the icon beside it does.
    if (pack && market) {
      const owner = market, details = ui.h('button', 'world-name', item.label) as HTMLButtonElement; details.type = 'button';
      details.addEventListener('click', () => owner.details(pack.name), { signal }); heading.append(details);
    } else heading.append(ui.h('span', 'world-name', item.label));
    // Extension info sits beside the name; a row click opens the World's settings.
    if (pack && market) {
      const owner = market, update = updatable.get(pack.name);
      heading.append(slot('info', iconButton('info', S.packageInfo, 'world-name-info', () => owner.details(pack.name))));
      // An available update shows beside it and opens the same page, where the update is.
      if (update) heading.append(iconButton('update', S.updateAvailable(update.installedVersion, update.latestVersion), 'world-name-update', () => owner.details(pack.name)));
    }
    identity.append(heading, ui.h('code', '', m?.id ?? pack?.name ?? item.key));
    const signals = ui.h('div', 'world-blade-signals');
    const state = pending ? pack?.state === 'removed' ? E.stateRemoved : E.statePendingRestart : failed ? E.stateFailed : m?.status === 'active' ? m.visible === false ? S.modeRunning : S.modeAttached : S.modeOff;
    if (m?.status === 'active') {
      const lamps = ui.h('span', 'world-signals'); paintSignals(lamps, m.lamps ?? []); signals.append(lamps); lampNodes.set(worldPageId(m.id), lamps);
    }
    if (m?.prefixDrifted) signals.append(ui.pill(S.prefixPending));
    // Left to right: sidebar, uninstall, agent visibility, power.
    const actions = ui.h('div', 'world-blade-actions');
    if (pack && market && m?.status === 'active') {
      // Whether the active World has its own entry in the sidebar; kept in this window's storage.
      const hidden = navHidden(win).has(worldPageId(m.id));
      actions.append(slot('sidebar', iconButton(hidden ? 'radio-off' : 'radio-on', hidden ? S.showInSidebar : S.hideFromSidebar, hidden ? '' : 'iobtn-visible', () => { setNavHidden(win, worldPageId(m.id), !hidden); render(); })));
    }
    // An unavailable uninstall stays visible, greyed, with the reason on hover.
    if (pack?.state !== 'removed') {
      const owner = market, key = item.key;
      const reason = !pack || pack.builtin ? E.builtinNote : pack.enabled ? E.removeInUse : !owner ? E.remove : '';
      const remove = slot('remove', iconButton('trash', E.remove, 'iobtn-remove', () => { if (!reason && pack && owner) void owner.remove(pack.name, () => railList.querySelector(`.world-blade[data-key="${CSS.escape(key)}"] .iobtn-remove`)); }));
      if (reason) { remove.setAttribute('aria-disabled', 'true'); remove.title = reason; remove.setAttribute('aria-label', `${E.remove}: ${reason}`); }
      actions.append(remove);
    }
    const configure = (id: string) => { markReturn(win, worldPageId(id)); router.navigate([PROVIDER_ROUTE, worldPageId(id)]); };
    if (m && !pending && !failed) {
      const runtime: HTMLButtonElement[] = [];
      // Built-in Worlds stay on and visible; their off switches are greyed with the reason.
      const builtin = pack ? !!pack.builtin : extensionsListed;
      const locked = (button: HTMLButtonElement) => { button.setAttribute('aria-disabled', 'true'); button.title = S.builtinAlwaysOn; button.setAttribute('aria-label', `${button.getAttribute('aria-label')}: ${S.builtinAlwaysOn}`); return button; };
      if (m.status === 'active' && builtin) {
        if (canToggleVisibility) runtime.push(m.visible === false
          ? slot('visibility', iconButton('eye-off', S.showToAgent, '', () => void changeWorld(m, 'visibility', true)))
          : slot('visibility', locked(iconButton('eye', S.hideFromAgent, 'iobtn-visible', () => {}))));
        if (canActivate) runtime.push(slot('power', locked(iconButton('power', S.deactivateWorld, 'iobtn-power is-on', () => {}))));
      } else if (m.status === 'active') {
        if (canToggleVisibility) runtime.push(slot('visibility', iconButton(m.visible === false ? 'eye-off' : 'eye', m.visible === false ? S.showToAgent : S.hideFromAgent, m.visible === false ? '' : 'iobtn-visible', () => void changeWorld(m, 'visibility', m.visible === false))));
        if (canActivate) runtime.push(slot('power', iconButton('power', S.deactivateWorld, 'iobtn-power is-on', () => void changeWorld(m, 'activation', false))));
      } else if (canActivate) runtime.push(slot('power', iconButton('power', S.activateWorld, 'iobtn-power', () => void changeWorld(m, 'activation', true))));
      if (changingWorlds.has(m.id)) for (const button of runtime) button.disabled = true;
      actions.append(...runtime);
    }
    // The controls keep their order and pack to the right, so a missing one leaves no gap at the row's end.
    const placed = [...actions.querySelectorAll<HTMLButtonElement>('button')].sort((x, y) => ACTION_SLOTS.indexOf(x.dataset.slot as ActionSlot) - ACTION_SLOTS.indexOf(y.dataset.slot as ActionSlot));
    placed.forEach((button, index) => { button.style.setProperty('--slot', String(ACTION_SLOTS.length - placed.length + index + 1)); });
    // A click on the row, outside its controls, opens the World's configuration page.
    if (m) {
      row.classList.add('is-configurable');
      row.dataset.world = m.id;
      row.addEventListener('click', event => { if (!(event.target as Element).closest('button, a')) configure(m.id); }, { signal });
    }
    // A load failure reads as its state; the reason opens in the error popover beside it.
    let stateNode: HTMLElement = ui.h('span', 'world-state', state);
    if (failed) {
      const reason = m?.reason || pack?.reason || S.missingReasonDefault;
      const button = ui.h('button', 'world-state world-state-problem') as HTMLButtonElement; button.type = 'button';
      button.append(icon(doc, 'alert'), ui.h('span', '', state)); button.setAttribute('aria-label', `${state}: ${reason}`);
      button.addEventListener('click', event => { event.stopPropagation(); problems.show(button, reason); }, { signal });
      stateNode = button;
    }
    row.append(identity, stateNode, signals, actions);
    if (!failed && m?.status === 'inactive' && !canActivate) row.append(ui.h('p', 'world-blade-note', S.inactiveNoteManual(m.id)));
    else if (!failed && !m && !pending) row.append(ui.h('p', 'world-blade-note', E.worldNotLoaded));
    return row;
  }
  function render(): void {
    if (!worldsReady || !extensionsReady || signal.aborted) return;
    // A row or group being dragged keeps the list as it is; the drop renders it again.
    if (readyList.querySelector('.is-dragging')) return;
    const items = worldLibrary(worlds, extensions, recent);
    readyList.querySelector('.placeholder')?.remove();
    lampNodes.clear(); renderRail(items);
    if (!items.length) readyList.replaceChildren(ui.placeholder(S.noWorlds));
    readyGroup.hidden = !!items.length && !items.some(item => !needsRestart(item));
  }
  async function load(): Promise<void> {
    if (!ctx.capabilities.worlds) { render(); return; }
    const own = ++generation;
    try {
      const data = await get<{ worlds: WorldView[] }>('/api/worlds', { signal });
      if (signal.aborted || own !== generation) return;
      worlds = data.worlds; worldsReady = true; render();
    } catch (error) {
      if (!signal.aborted && own === generation) { worldsReady = true; setMsg(S.listLoadFailed(errText(error)), true); render(); }
    }
  }
  readyList.append(ui.placeholder(S.loading));
  void load();
}

export const worldsFeature: FrameworkFeature = {
  route: 'world', label: S.navLabel, icon: 'boxes', navMode: 'world-root',
  needsAny: ['worlds', 'extensions'], mount: mountWorlds,
};
