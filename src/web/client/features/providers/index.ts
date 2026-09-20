import { pageIntro } from '../../ui/page.ts';
import { NEW_DRAFT_ID, providerDrafts } from './drafts.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { get, post } from '../../core/api.ts';
import { S } from './strings.ts';
import { connectionPath, type HubState, type Connection, type Module, type Detail, type Editing } from './types.ts';
import { mountDetail, type DetailController } from './detail.ts';

export async function mountProviders(ctx: FeatureContext): Promise<void> {
  const { ui, root } = ctx;
  root.append(pageIntro(ui, S.pageTitle));
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
  const nodes = new Map<string, { el: HTMLElement; title: HTMLElement; model: HTMLElement; url: HTMLElement; status: HTMLElement; secondary: HTMLElement; activate: HTMLButtonElement }>();
  const run = (work: () => Promise<unknown>) => { void work().catch(error => { if (!ctx.signal.aborted) report.textContent = String(error); }); };
  function paint() {
    report.textContent = state.active && !state.providers.some(item => item.name === state.active) ? S.missing + state.active : '';
    const all: Array<Connection | { name: string; model: string | null; baseUrl: string; readiness: { state: string } }> = [...state.providers];
    if (newDraft) all.unshift({ name: NEW_DRAFT_ID, model: newDraft.entry.spec?.model ?? null, baseUrl: newDraft.entry.baseUrl, readiness: { state: 'draft' } });
    for (const [name, node] of nodes) if (!all.some(item => item.name === name)) { node.el.remove(); nodes.delete(name); }
    for (const item of all) {
      const identity = item.name;
      let node = nodes.get(identity);
      if (!node) {
        const el = ui.h('article', 'connection-card'); el.dataset.provider = identity;
        const title = ui.h('div', 'connection-name'); const model = ui.h('div', 'connection-model'); const url = ui.h('div', 'connection-url');
        const status = ui.h('div', 'connection-status'); const secondary = ui.h('div', 'connection-secondary');
        const actions = ui.rowbar();
        const configure = ui.button(S.configure, { size: 'sm', onClick: () => run(() => select(identity)) });
        const activate = ui.button(S.activate, { size: 'sm', onClick: () => run(async () => {
          activate.disabled = true;
          try { await post(connectionPath(identity) + '/activate', {}, opts); state.active = identity; paint(); }
          finally { activate.disabled = false; }
        }) });
        actions.append(configure, activate); el.append(title, model, url, status, secondary, actions);
        el.addEventListener('click', event => { if (!(event.target as Element).closest('button')) run(() => select(identity)); }, opts);
        if (identity === NEW_DRAFT_ID) cards.prepend(el); else cards.append(el); node = { el, title, model, url, status, secondary, activate }; nodes.set(identity, node);
      }
      const active = identity === state.active;
      node.el.classList.toggle('is-active', active); node.el.classList.toggle('is-selected', identity === selected);
      node.title.textContent = identity === NEW_DRAFT_ID ? newDraft?.name || S.newName : identity;
      node.model.textContent = item.model || '—'; node.url.textContent = item.baseUrl || '—';
      const readiness = invalid.has(identity) && identity !== NEW_DRAFT_ID ? 'invalid' : item.readiness.state;
      node.status.textContent = active ? S.active : S.readiness[readiness];
      node.secondary.textContent = active && readiness !== 'ready' ? S.readiness[readiness] : identity !== NEW_DRAFT_ID && drafts.has(identity) ? S.readiness.draft : '';
      node.activate.hidden = active || identity === NEW_DRAFT_ID;
      node.activate.disabled = item.readiness.state !== 'ready';
    }
  }
  async function refresh() { state = await get<HubState>('/api/providers', opts); paint(); }
  async function select(identity: string, force = false): Promise<void> {
    if (!force && identity === selected) return;
    if (!force && controller && !(await controller.leave())) return;
    const gen = ++renderId;
    controller?.dispose(); controller = null;
    selected = identity; paint(); detailRoot.replaceChildren();
    if (!identity) {
      detailRoot.append(ui.h('h3', '', S.empty), ui.msgline(S.emptyHint), ui.button(S.create, { onClick: () => run(create) }));
      return;
    }
    const saved = identity === NEW_DRAFT_ID ? null : await get<Detail>(connectionPath(identity), opts);
    if (gen !== renderId || ctx.signal.aborted) return;
    const detailView = ui.h('div'); detailRoot.replaceChildren(detailView);
    const mounted = await mountDetail({ ctx, root: detailView, modules, saved, draft: identity === NEW_DRAFT_ID ? newDraft : drafts.get(identity),
      discarded: () => { invalid.delete(identity); if (identity === NEW_DRAFT_ID) newDraft = drafts.get(NEW_DRAFT_ID); paint(); },
      saveDraft: editing => { drafts.set(editing); paint(); },
      changed: (editing, hasErrors) => { if (hasErrors) invalid.add(identity); else invalid.delete(identity); if (identity === NEW_DRAFT_ID) newDraft = editing; paint(); },
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
    if (gen !== renderId || ctx.signal.aborted) mounted.dispose(); else controller = mounted;
  }
  async function create() {
    if (newDraft) return select(NEW_DRAFT_ID);
    if (controller && !(await controller.leave())) return;
    newDraft = { original: null, name: '', entry: { kind: '', baseUrl: '' }, secretValue: '', raw: {} };
    await select(NEW_DRAFT_ID, true);
  }
  index.append(ui.button(S.create, { variant: 'primary', onClick: () => run(create) }), cards);
  ctx.lifecycle.own({ dispose: () => { renderId++; controller?.dispose(); } });
  ctx.lifecycle.own(ctx.router.addLeaveDecision(async () => controller ? controller.leave() : true));
  ctx.lifecycle.own(ctx.router.onChange(route => {
    if (route.segments[0] === 'providers' && route.segments[1]) run(() => select(route.segments[1]));
  }));
  paint();
  const wanted = ctx.route.segments[1] ?? (newDraft ? NEW_DRAFT_ID : undefined);
  await select(wanted && (wanted === NEW_DRAFT_ID || state.providers.some(item => item.name === wanted)) ? wanted : state.providers.find(item => item.name === state.active)?.name ?? state.providers[0]?.name ?? '', true);
}
export const providersFeature: FrameworkFeature = { route: 'providers', label: S.navLabel, icon: 'cpu', navGroup: S.navGroup, mount: mountProviders };
