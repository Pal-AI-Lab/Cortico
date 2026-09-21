import { pageIntro } from '../../ui/page.ts';
import { icon } from '../../ui/icons.ts';
import { NEW_DRAFT_ID, providerDrafts } from './drafts.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { get, post } from '../../core/api.ts';
import { LANGUAGE } from '../../core/language.ts';
import { panel } from '../../console-pages/builtins/llm-settings/strings.ts';
import { probeCard, type ProbeResult } from '../../console-pages/builtins/llm-settings/panel.ts';
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
  interface CardNode {
    el: HTMLElement; title: HTMLElement; model: HTMLElement; url: HTMLElement; status: HTMLElement; secondary: HTMLElement;
    kind: HTMLElement; activate: HTMLButtonElement; erase: HTMLButtonElement; probe: HTMLButtonElement; probePanel: HTMLElement; probeBody: HTMLElement;
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
        // Field name and value in one chip, the same shape the terminal gives a tool call's fields.
        const facts = ui.h('div', 'connection-facts');
        const fact = (key: string) => { const box = ui.h('span', `kv kv-${key}`); const value = ui.h('span', 'kv-v'); box.append(ui.h('span', 'kv-k', key), value); facts.append(box); return value; };
        const kind = fact('kind'); const model = fact('model'); const url = fact('baseUrl');
        const status = ui.h('div', 'connection-status'); const secondary = ui.h('div', 'connection-secondary');
        const actions = ui.rowbar();
        const configure = ui.button(S.configure, { size: 'sm', onClick: () => run(() => select(identity)) });
        const activate = ui.button(S.activate, { size: 'sm', onClick: () => run(async () => {
          activate.disabled = true;
          try { await post(connectionPath(identity) + '/activate', {}, opts); state.active = identity; paint(); }
          finally { activate.disabled = false; }
        }) });
        const probePanel = ui.h('div', 'connection-probe');
        const probeBody = ui.h('div', 'connection-probe-body');
        probePanel.append(probeBody);
        const probe = ui.button(S.probe, { size: 'sm', onClick: () => run(() => runProbe(identity)) });
        probe.classList.add('connection-probe-btn'); probe.append(ui.h('span', 'connection-spin'));
        const erase = eraseButton(identity);
        actions.append(configure, probe, activate); el.append(erase, title, facts, status, secondary, actions, probePanel);
        el.addEventListener('click', event => { if (!(event.target as Element).closest('button')) run(() => select(identity)); }, opts);
        if (identity === NEW_DRAFT_ID) cards.prepend(el); else cards.append(el);
        node = { el, title, kind, model, url, status, secondary, activate, erase, probe, probePanel, probeBody }; nodes.set(identity, node);
      }
      const active = identity === state.active;
      node.el.classList.toggle('is-active', active); node.el.classList.toggle('is-selected', identity === selected);
      node.title.textContent = identity === NEW_DRAFT_ID ? newDraft?.name || S.newName : identity;
      node.title.title = node.title.textContent;
      node.kind.textContent = item.moduleTitle; node.kind.title = item.moduleTitle;
      node.model.textContent = item.model || '—'; node.url.textContent = item.baseUrl || '—';
      node.model.title = item.model ?? ''; node.url.title = item.baseUrl ?? '';
      const readiness = invalid.has(identity) && identity !== NEW_DRAFT_ID ? 'invalid' : item.readiness.state;
      node.status.textContent = active ? S.active : S.readiness[readiness];
      node.secondary.textContent = active && readiness !== 'ready' ? S.readiness[readiness] : identity !== NEW_DRAFT_ID && drafts.has(identity) ? S.readiness.draft : '';
      node.activate.hidden = active || identity === NEW_DRAFT_ID;
      node.activate.disabled = item.readiness.state !== 'ready';
      node.probe.hidden = identity === NEW_DRAFT_ID;
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
  /** 探活结果挂在卡片下面,与模块页上的那份同一种呈现。 */
  async function runProbe(identity: string): Promise<void> {
    const node = nodes.get(identity);
    if (!node || node.probe.disabled) return;
    node.probe.disabled = true; node.probe.classList.add('is-busy');
    try {
      const result = await post<ProbeResult>(connectionPath(identity) + '/test', {}, opts);
      if (ctx.signal.aborted) return;
      const close = ui.button(S.probeClose, { size: 'sm', onClick: () => node.probePanel.classList.remove('is-open') });
      node.probeBody.replaceChildren(probeCard(ui, LANGUAGE === 'en' ? panel.en : panel.zh, result), close);
      node.probePanel.classList.add('is-open');
    } finally { node.probe.disabled = false; node.probe.classList.remove('is-busy'); }
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
  paint();
  const wanted = ctx.route.segments[1] ?? (newDraft ? NEW_DRAFT_ID : undefined);
  await select(wanted && (wanted === NEW_DRAFT_ID || state.providers.some(item => item.name === wanted)) ? wanted : state.providers.find(item => item.name === state.active)?.name ?? state.providers[0]?.name ?? '', true);
}
export const providersFeature: FrameworkFeature = { route: 'providers', label: S.navLabel, icon: 'cpu', navGroup: S.navGroup, mount: mountProviders };
