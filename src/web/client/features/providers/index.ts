import { pageIntro } from '../../ui/page.ts';
import { pageTabs } from '../../ui/page-tabs.ts';
import { mountExtensionContent, type ExtensionController } from '../extensions/index.ts';
import { icon } from '../../ui/icons.ts';
import { notice } from '../../ui/index.ts';
import { NEW_DRAFT_ID, providerDrafts } from './drafts.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { get, post } from '../../core/api.ts';
import { S } from './strings.ts';
import { connectionPath, type HubState, type Connection, type Module, type Detail, type Editing } from './types.ts';
import { mountDetail, type DetailController } from './detail.ts';
import { dragList, moveGap, settledBox } from '../../core/drag.ts';
import { measureReflow, prefersStill } from '../../core/motion.ts';

/** How often the card list re-reads other deployments' usage. */
const USAGE_REFRESH_MS = 5000;
export function mountProviders(ctx: FeatureContext): void {
  const { root, ui, router, signal } = ctx;
  const intro = pageIntro(ui, S.pageTitle);
  const settings = ui.h('div', 'provider-settings');
  const market = ui.h('div', 'provider-market');
  const panes = { settings, market };
  const started = new Set<string>();
  let catalog: ExtensionController | undefined;
  let current: 'settings' | 'market' | undefined;
  const tabs = pageTabs(root.ownerDocument, signal, [
    { value: 'settings', label: S.settingsTab },
    ...(ctx.capabilities.extensions ? [{ value: 'market', label: S.marketTab }] : []),
  ], { onSelect: value => router.navigate(router.route.segments, value === 'market' ? { view: 'market' } : undefined) });
  intro.classList.add('provider-intro');
  intro.append(tabs.el);
  root.append(intro, settings, market);
  const show = () => {
    if (signal.aborted || router.route.segments[0] !== 'providers') return;
    const next = router.route.query.view === 'market' && ctx.capabilities.extensions ? 'market' : 'settings';
    if (current === next) return;
    current = next;
    settings.hidden = next !== 'settings';
    market.hidden = next !== 'market';
    tabs.setValue(next);
    if (next === 'market') catalog?.activate();
    if (started.has(next)) return;
    started.add(next);
    const child = { ...ctx, root: panes[next], route: router.route };
    if (next === 'market') catalog = mountExtensionContent(child, 'provider');
    else void mountConnections(child).catch(error => {
      if (!signal.aborted) settings.replaceChildren(ui.msgline(String(error), true));
    });
  };
  ctx.lifecycle.own(router.onChange(show));
  show();
}

async function mountConnections(ctx: FeatureContext): Promise<void> {
  const { ui, root } = ctx;
  const report = ui.msgline();
  const layout = ui.h('div', 'connection-hub');
  const index = ui.h('div', 'connection-index');
  const cards = ui.h('div', 'connection-cards');
  const detailRoot = ui.h('div', 'connection-detail');
  layout.append(index, detailRoot); root.append(report, layout);
  const opts = { signal: ctx.signal };
  let state = await get<HubState>('/api/providers', opts);
  state.providers.sort((a, b) => Number(b.name === state.active) - Number(a.name === state.active));
  const modules = await get<Module[]>('/api/provider-modules', opts);
  if (ctx.signal.aborted) return;
  const drafts = providerDrafts(root.ownerDocument.defaultView!.localStorage, state.scope);
  let selected = '';
  let newDraft: Editing | null = drafts.get(NEW_DRAFT_ID);
  const invalid = new Set<string>();
  let controller: DetailController | null = null;
  let renderId = 0;
  interface CardNode {
    el: HTMLElement; title: HTMLElement; model: HTMLElement; status: HTMLElement; secondary: HTMLElement;
    kind: HTMLElement; activate: HTMLButtonElement; erase: HTMLButtonElement;
  }
  const nodes = new Map<string, CardNode>();
  const rows = new Map<string, Connection>();
  const doc = root.ownerDocument;
  const run = (work: () => Promise<unknown>) => { void work().catch(error => { if (!ctx.signal.aborted) report.textContent = String(error); }); };
  // 卡片的先后由用户拖动决定，按部署记在本机；没排过时沿用列表本来的顺序。
  const orderKey = `cortico.provider-order.v1:${state.scope}`;
  const storage = root.ownerDocument.defaultView!.localStorage;
  const readOrder = (): string[] | null => { try { const saved = JSON.parse(storage.getItem(orderKey) ?? 'null'); return Array.isArray(saved) ? saved.filter((name): name is string => typeof name === 'string') : null; } catch { return null; } };
  const writeOrder = (names: readonly string[]) => { try { storage.setItem(orderKey, JSON.stringify(names)); } catch { /* Storage may be unavailable. */ } };
  /** The card being dragged, which stays put while the list repaints. */
  let dragged: HTMLElement | null = null;
  const fallback = () => state.providers.find(item => item.name === state.active)?.name || state.providers[0]?.name || '';
  /** Cards that appear or go reflow like the World lists (see measureReflow); a card's lifted copy is not a card. */
  const cardKey = (el: HTMLElement) => el.classList.contains('connection-drag-copy') ? undefined : el.dataset.provider;
  function paint() {
    const reflow = measureReflow(cards, ':scope > .connection-card', cardKey);
    paintCards(); placeCards();
    reflow.play();
  }
  /** Puts the cards in the saved order, the draft first; cards new to it keep their place after the rest. */
  function placeCards() {
    const order = readOrder();
    if (!order || dragged) return;
    const rank = new Map(order.map((name, index) => [name, index]));
    const all = [...cards.querySelectorAll<HTMLElement>(':scope > .connection-card:not(.connection-drag-copy)')];
    const sorted = [...all].sort((a, b) => (a.dataset.provider === NEW_DRAFT_ID ? -1 : 0) - (b.dataset.provider === NEW_DRAFT_ID ? -1 : 0)
      || (rank.get(a.dataset.provider!) ?? order.length + all.indexOf(a)) - (rank.get(b.dataset.provider!) ?? order.length + all.indexOf(b)));
    let cursor = cards.firstElementChild;
    for (const el of sorted) { if (el === cursor) { cursor = cursor.nextElementSibling; continue; } cards.insertBefore(el, cursor); }
  }
  function paintCards() {
    report.textContent = state.active && !state.providers.some(item => item.name === state.active) ? S.missing + state.active : '';
    const all: Array<Connection | { name: string; moduleTitle: string; model: string | null; readiness: { state: string } }> = [...state.providers];
    if (newDraft) all.unshift({ name: NEW_DRAFT_ID, moduleTitle: moduleName(newDraft.entry.kind), model: newDraft.entry.spec?.model ?? null, readiness: { state: 'draft' } });
    for (const [name, node] of nodes) if (!all.some(item => item.name === name)) { node.el.remove(); nodes.delete(name); }
    for (const item of all) {
      const identity = item.name;
      let node = nodes.get(identity);
      if (!node) {
        const el = ui.h('article', 'connection-card'); el.dataset.provider = identity;
        const title = ui.h('div', 'connection-name');
        const facts = ui.h('div', 'connection-facts');
        const fact = (key: string) => { const box = ui.h('span', `kv kv-${key}`); const value = ui.h('span', 'kv-v'); box.append(ui.h('span', 'kv-k', key), value); facts.append(box); return value; };
        const kind = fact('kind'); const model = fact('model');
        const status = ui.h('div', 'connection-status'); const secondary = ui.h('div', 'connection-secondary');
        const activate = ui.button('⇄', { size: 'sm', onClick: () => run(async () => {
          activate.disabled = true;
          try { await post(connectionPath(identity) + '/activate', {}, opts); state.active = identity; paint(); }
          finally { activate.disabled = false; }
        }) });
        activate.classList.add('connection-activate');
        activate.setAttribute('aria-label', S.activate); activate.title = S.activate;
        const connect = ui.h('div', 'connection-connect'); connect.append(activate, ui.h('span', 'connection-connect-label', S.connect));
        const erase = eraseButton(identity);
        el.append(erase, title, facts, status, secondary, connect);
        el.tabIndex = 0;
        el.addEventListener('keydown', event => { if (event.target === el && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); run(() => select(identity)); } }, opts);
        el.addEventListener('click', event => { if (!(event.target as Element).closest('button')) run(() => select(identity)); }, opts);
        if (identity === NEW_DRAFT_ID) cards.prepend(el); else cards.append(el);
        node = { el, title, kind, model, status, secondary, activate, erase }; nodes.set(identity, node);
      }
      const active = identity === state.active;
      node.el.classList.toggle('is-active', active); node.el.classList.toggle('is-selected', identity === selected);
      node.title.textContent = identity === NEW_DRAFT_ID ? newDraft?.name || S.newName : identity;
      node.title.title = node.title.textContent;
      const draft = identity === NEW_DRAFT_ID ? null : drafts.get(identity);
      const model = draft?.entry.spec?.model || item.model || '—';
      node.kind.textContent = item.moduleTitle; node.kind.title = item.moduleTitle;
      node.model.textContent = model;
      node.model.title = model;
      const readiness = invalid.has(identity) && identity !== NEW_DRAFT_ID ? 'invalid' : item.readiness.state;
      const users = 'usage' in item ? item.usage : [];
      const running = users.filter(user => user.running).map(user => user.name);
      const stopped = users.filter(user => !user.running).map(user => user.name);
      const tone = active || running.length ? 'active' : readiness === 'draft' ? 'draft' : readiness === 'ready' ? 'ready' : 'error';
      node.status.dataset.tone = tone;
      node.status.textContent = `${{ active: '●', ready: '✓', error: '!', draft: '✎' }[tone]} ${active ? S.active : running.length ? S.inUse(S.names(running)) : S.readiness[readiness]}`;
      const notes: string[] = [];
      if ((active || running.length) && readiness !== 'ready') notes.push('! ' + S.readiness[readiness]);
      if (identity !== NEW_DRAFT_ID && drafts.has(identity)) notes.push('✎ ' + S.readiness.draft);
      if (active && running.length) notes.push(S.inUse(S.names(running)));
      if (stopped.length) notes.push(S.selectedBy(S.names(stopped)));
      node.secondary.textContent = notes.join(' · ');
      node.secondary.dataset.tone = (active || running.length) && readiness !== 'ready' ? 'error' : 'draft';
      node.activate.parentElement!.hidden = active || identity === NEW_DRAFT_ID || readiness !== 'ready' || running.length > 0;
      if (identity === NEW_DRAFT_ID) rows.delete(identity); else rows.set(identity, item as Connection);
    }
  }
  /**
   * 删除先弹窗确认，与供应商详情里的删除、World 的停用一样：正被 Bot 使用的连接说明不能删；
   * 没保存过的新实例问是否放弃。
   */
  function eraseButton(identity: string): HTMLButtonElement {
    const el = ui.h('button', 'connection-erase') as HTMLButtonElement;
    el.type = 'button'; el.title = S.remove; el.setAttribute('aria-label', S.remove);
    el.append(icon(doc, 'trash'));
    el.addEventListener('click', event => {
      event.stopPropagation();
      run(async () => {
        if (identity === NEW_DRAFT_ID) { if (await ui.confirm({ title: S.cancel, danger: true })) await remove(identity); return; }
        const current = await get<Detail>(connectionPath(identity), opts);
        if (current.references.length) { await notice(ui, { title: S.remove, body: S.referenced + current.references.join(', ') }); return; }
        if (await ui.confirm({ title: S.remove, body: S.deleteConfirm, danger: true })) await remove(identity);
      });
    }, opts);
    return el;
  }
  async function remove(identity: string): Promise<void> {
    if (identity === NEW_DRAFT_ID) {
      drafts.remove(NEW_DRAFT_ID); newDraft = null; invalid.delete(identity);
      if (selected === NEW_DRAFT_ID) await select(fallback(), true); else paint();
      return;
    }
    await post(connectionPath(identity) + '/delete', { expectedRevision: rows.get(identity)?.revision }, opts);
    drafts.remove(identity); invalid.delete(identity);
    await refresh();
    if (selected === identity) await select(fallback(), true);
  }
  async function refresh() { state = await get<HubState>('/api/providers', opts); paint(); }
  async function select(identity: string, force = false): Promise<void> {
    if (!force && identity === selected) return;
    const scrollTop = identity === selected ? detailRoot.scrollTop : 0;
    const gen = ++renderId;
    controller?.dispose(); controller = null;
    // The disposed editor stays visible until its replacement is ready and takes no input meanwhile.
    detailRoot.toggleAttribute('inert', true);
    selected = identity; paint();
    if (!identity) {
      detailRoot.toggleAttribute('inert', false);
      detailRoot.replaceChildren(ui.h('h3', '', S.empty), ui.msgline(S.emptyHint), ui.button(S.create, { onClick: () => run(create) }));
      return;
    }
    try { await openDetail(identity, gen, scrollTop); } catch (error) {
      if (gen === renderId) { detailRoot.replaceChildren(); detailRoot.toggleAttribute('inert', false); }
      throw error;
    }
  }
  async function openDetail(identity: string, gen: number, scrollTop: number): Promise<void> {
    const saved = identity === NEW_DRAFT_ID ? null : await get<Detail>(connectionPath(identity), opts);
    if (gen !== renderId || ctx.signal.aborted) return;
    const detailView = ui.h('div');
    const mounted = await mountDetail({ ctx, root: detailView, modules, saved, draft: identity === NEW_DRAFT_ID ? newDraft : drafts.get(identity),
      // Edits persist as a browser draft as they happen; a form back at its saved state drops the draft.
      changed: (editing, hasErrors, dirty) => {
        if (hasErrors) invalid.add(identity); else invalid.delete(identity);
        if (identity === NEW_DRAFT_ID) { newDraft = editing; drafts.set(editing); }
        else if (dirty) drafts.set(editing); else drafts.remove(identity);
        paint();
      },
      onSaved: async (name, show = true) => { drafts.remove(identity); invalid.delete(identity); if (identity === NEW_DRAFT_ID) newDraft = null; await refresh(); if (show) await select(name, true); },
      cancelled: async () => { drafts.remove(identity); invalid.delete(identity); if (identity === NEW_DRAFT_ID) newDraft = null; await select(identity === NEW_DRAFT_ID ? state.providers.find(item => item.name === state.active)?.name || state.providers[0]?.name || '' : identity, true); },
      deleted: async () => { drafts.remove(identity); invalid.delete(identity); await refresh(); await select(state.providers.find(item => item.name === state.active)?.name || state.providers[0]?.name || '', true); },
      duplicate: async editing => {
        if (newDraft) { await select(NEW_DRAFT_ID); return; }
        const used = new Set(state.providers.map(item => item.name.toLowerCase()));
        const base = editing.name.slice(0, 56); let candidate = base; let number = 2;
        while (used.has(candidate.toLowerCase())) candidate = `${base}-${number++}`;
        editing.name = candidate; newDraft = editing; await select(NEW_DRAFT_ID, true);
      },
    });
    if (gen !== renderId || ctx.signal.aborted) mounted.dispose();
    else {
      detailRoot.replaceChildren(detailView);
      detailRoot.toggleAttribute('inert', false);
      detailRoot.scrollTop = scrollTop;
      controller = mounted;
    }
  }
  async function create() {
    if (newDraft) return select(NEW_DRAFT_ID);
    newDraft = { original: null, name: '', entry: { kind: '', baseUrl: '' }, secretValue: '', raw: {} };
    drafts.set(newDraft);
    await select(NEW_DRAFT_ID, true);
  }
  const moduleName = (kind: string) => modules.find(module => module.id === kind)?.title ?? kind;
  // Dragging a card up or down sets the order (core/drag.ts); the new instance stays first.
  const movable = () => [...cards.querySelectorAll<HTMLElement>(':scope > .connection-card:not(.connection-drag-copy)')].filter(el => el.dataset.provider !== NEW_DRAFT_ID);
  let before: HTMLElement[] = [];
  dragList(cards, {
    pick(target) {
      if (target.closest('button, a, input, select, textarea')) return null;
      const card = target.closest<HTMLElement>('.connection-card');
      return card && card.dataset.provider !== NEW_DRAFT_ID ? card : null;
    },
    lifted(el) { dragged = el; before = movable(); },
    locate(y) {
      if (!dragged) return;
      const others = movable().filter(el => el !== dragged);
      const over = others.find(el => { const box = settledBox(el); return y >= box.top && y <= box.bottom; }) ?? others.find(el => settledBox(el).top > y);
      const next = !over ? null : y > settledBox(over).top + settledBox(over).height / 2 && y <= settledBox(over).bottom ? over.nextElementSibling : over;
      moveGap(dragged, cards, next, movable());
    },
    drop(el, copyTop) {
      dragged = null;
      writeOrder(movable().map(card => card.dataset.provider!));
      // The card slides into its place from where its copy was.
      const delta = copyTop - el.getBoundingClientRect().top;
      if (delta && !prefersStill(doc.defaultView)) el.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.32,.72,0,1)' });
    },
    cancel() {
      const gap = dragged; dragged = null;
      // Back where it was: the cards it passed slide back too.
      if (gap) moveGap(gap, cards, before[before.indexOf(gap) + 1] ?? null, movable());
    },
    layer: cards, scroller: cards, copyClass: 'connection-drag-copy',
  }, ctx.signal);
  const creator = ui.h('div', 'connection-create');
  creator.append(ui.button(S.create, { variant: 'primary', onClick: () => run(create) }), ui.h('p', 'connection-create-hint', S.createHint));
  index.append(creator, cards);
  ctx.lifecycle.own({ dispose: () => { renderId++; controller?.dispose(); } });
  let routeName = ctx.route.segments[1];
  ctx.lifecycle.own(ctx.router.onChange(route => {
    if (ctx.signal.aborted || route.segments[0] !== 'providers' || route.query.view === 'market') return;
    const name = route.segments[1];
    if (name && name !== routeName) run(() => select(name));
    routeName = name;
  }));
  // Other deployments' selections and liveness change without this page; the detail form is left alone.
  let refreshing = false;
  ctx.lifecycle.interval(() => {
    if (refreshing) return;
    refreshing = true;
    run(async () => { try { await refresh(); } finally { refreshing = false; } });
  }, USAGE_REFRESH_MS);
  paint();
  const wanted = ctx.route.segments[1] ?? (newDraft ? NEW_DRAFT_ID : undefined);
  await select(wanted && (wanted === NEW_DRAFT_ID || state.providers.some(item => item.name === wanted)) ? wanted : state.providers.find(item => item.name === state.active)?.name ?? state.providers[0]?.name ?? '', true);
}
export const providersFeature: FrameworkFeature = { route: 'providers', label: S.navLabel, icon: 'cpu', navGroup: S.navGroup, mount: mountProviders };
