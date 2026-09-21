import { pageIntro } from '../../ui/page.ts';
import { icon } from '../../ui/icons.ts';
import { NEW_DRAFT_ID, providerDrafts } from './drafts.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { get, post } from '../../core/api.ts';
import { S } from './strings.ts';
import { connectionPath, type HubState, type Connection, type Module, type Detail, type Editing } from './types.ts';
import { mountDetail, type DetailController } from './detail.ts';

/** How often the card list re-reads other deployments' usage. */
const USAGE_REFRESH_MS = 5000;
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
  interface CardNode {
    el: HTMLElement; title: HTMLElement; model: HTMLElement; url: HTMLElement; status: HTMLElement; secondary: HTMLElement;
    kind: HTMLElement; activate: HTMLButtonElement; erase: HTMLButtonElement;
  }
  const nodes = new Map<string, CardNode>();
  const rows = new Map<string, Connection>();
  const doc = root.ownerDocument;
  const run = (work: () => Promise<unknown>) => { void work().catch(error => { if (!ctx.signal.aborted) report.textContent = String(error); }); };
  // 同时只有一张卡处在「确认删除」态。
  let armed: (() => void) | null = null;
  const disarm = () => { armed?.(); armed = null; };
  const fallback = () => state.providers.find(item => item.name === state.active)?.name || state.providers[0]?.name || '';
  function paint() {
    report.textContent = state.active && !state.providers.some(item => item.name === state.active) ? S.missing + state.active : '';
    const all: Array<Connection | { name: string; moduleTitle: string; model: string | null; baseUrl: string; readiness: { state: string } }> = [...state.providers];
    if (newDraft) all.unshift({ name: NEW_DRAFT_ID, moduleTitle: moduleName(newDraft.entry.kind), model: newDraft.entry.spec?.model ?? null, baseUrl: newDraft.entry.baseUrl, readiness: { state: 'draft' } });
    for (const [name, node] of nodes) if (!all.some(item => item.name === name)) { node.el.remove(); nodes.delete(name); }
    for (const item of all) {
      const identity = item.name;
      let node = nodes.get(identity);
      if (!node) {
        const el = ui.h('article', 'connection-card'); el.dataset.provider = identity;
        const title = ui.h('div', 'connection-name');
        const facts = ui.h('div', 'connection-facts');
        const fact = (key: string) => { const box = ui.h('span', `kv kv-${key}`); const value = ui.h('span', 'kv-v'); box.append(ui.h('span', 'kv-k', key), value); facts.append(box); return value; };
        const kind = fact('kind'); const model = fact('model'); const url = fact('baseUrl');
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
        node = { el, title, kind, model, url, status, secondary, activate, erase }; nodes.set(identity, node);
      }
      const active = identity === state.active;
      node.el.classList.toggle('is-active', active); node.el.classList.toggle('is-selected', identity === selected);
      node.title.textContent = identity === NEW_DRAFT_ID ? newDraft?.name || S.newName : identity;
      node.title.title = node.title.textContent;
      const draft = identity === NEW_DRAFT_ID ? null : drafts.get(identity);
      const model = draft?.entry.spec?.model || item.model || '—'; const url = draft?.entry.baseUrl || item.baseUrl || '—';
      node.kind.textContent = item.moduleTitle; node.kind.title = item.moduleTitle;
      node.model.textContent = model; node.url.textContent = url;
      node.model.title = model; node.url.title = url;
      const readiness = invalid.has(identity) && identity !== NEW_DRAFT_ID ? 'invalid' : item.readiness.state;
      const users = 'usage' in item ? item.usage : [];
      const running = users.filter(user => user.running).map(user => user.name);
      const stopped = users.filter(user => !user.running).map(user => user.name);
      const tone = active || running.length ? 'active' : readiness === 'draft' ? 'draft' : readiness === 'ready' ? 'ready' : 'error';
      node.status.dataset.tone = tone;
      node.status.textContent = `${{ active: '●', ready: '✓', error: '!', draft: '✎' }[tone]} ${active ? S.active : running.length ? S.inUse(running.join('、')) : S.readiness[readiness]}`;
      const notes: string[] = [];
      if ((active || running.length) && readiness !== 'ready') notes.push('! ' + S.readiness[readiness]);
      if (identity !== NEW_DRAFT_ID && drafts.has(identity)) notes.push('✎ ' + S.readiness.draft);
      if (active && running.length) notes.push(S.inUse(running.join('、')));
      if (stopped.length) notes.push(S.selectedBy(stopped.join('、')));
      node.secondary.textContent = notes.join(' · ');
      node.secondary.dataset.tone = (active || running.length) && readiness !== 'ready' ? 'error' : 'draft';
      node.activate.parentElement!.hidden = active || identity === NEW_DRAFT_ID || readiness !== 'ready' || running.length > 0;
      if (identity === NEW_DRAFT_ID) rows.delete(identity); else rows.set(identity, item as Connection);
    }
  }
  /** 删除按钮先伸成「确认删除」,第二次点击才动手;点别处或 Esc 收回。 */
  function eraseButton(identity: string): HTMLButtonElement {
    const el = ui.h('button', 'connection-erase') as HTMLButtonElement;
    el.type = 'button';
    const text = ui.h('span', 'connection-erase-text'); text.append(ui.h('span', '', S.eraseConfirm));
    el.append(icon(doc, 'trash'), text);
    const label = (armedNow: boolean) => { const name = armedNow ? S.eraseConfirm : S.remove; el.title = name; el.setAttribute('aria-label', name); };
    label(false);
    el.addEventListener('click', event => {
      event.stopPropagation();
      const wasArmed = el.classList.contains('is-armed');
      disarm();
      if (wasArmed) { run(() => remove(identity)); return; }
      el.classList.add('is-armed'); label(true);
      armed = () => { el.classList.remove('is-armed'); label(false); };
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
    if (gen !== renderId || ctx.signal.aborted) mounted.dispose(); else controller = mounted;
  }
  async function create() {
    if (newDraft) return select(NEW_DRAFT_ID);
    newDraft = { original: null, name: '', entry: { kind: '', baseUrl: '' }, secretValue: '', raw: {} };
    drafts.set(newDraft);
    await select(NEW_DRAFT_ID, true);
  }
  const moduleName = (kind: string) => modules.find(module => module.id === kind)?.title ?? kind;
  doc.addEventListener('click', event => { if (!(event.target as Element).closest('.connection-erase')) disarm(); }, opts);
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') disarm(); }, opts);
  const creator = ui.h('div', 'connection-create');
  creator.append(ui.button(S.create, { variant: 'primary', onClick: () => run(create) }), ui.h('p', 'connection-create-hint', S.createHint));
  index.append(creator, cards);
  ctx.lifecycle.own({ dispose: () => { renderId++; controller?.dispose(); } });
  ctx.lifecycle.own(ctx.router.onChange(route => {
    if (route.segments[0] === 'providers' && route.segments[1]) run(() => select(route.segments[1]));
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
