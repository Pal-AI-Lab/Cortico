import type { FeatureContext } from '../feature.ts';
import { get, post } from '../../core/api.ts';
import { Lifecycle } from '../../core/lifecycle.ts';
import { configField, type ConfigGroup } from '../config/view.ts';
import { validateProviderName } from '../../../../providers/name.ts';
import { connectionPath, type Detail, type Editing, type Module } from './types.ts';
import { LANGUAGE } from '../../core/language.ts';
import { pricingEditor } from '../../console-pages/builtins/llm-settings/pricing-panel.ts';
import type { Disposable } from '../../../shared/client-panel.ts';
import { S } from './strings.ts';

export interface DetailController { dispose(): void; }
interface Options {
  ctx: FeatureContext; root: HTMLElement; modules: Module[]; saved: Detail | null; draft: Editing | null;
  /** Every edit; `dirty` is false when the form again equals the saved connection. */
  changed(editing: Editing, invalid: boolean, dirty: boolean): void;
  onSaved(name: string, select?: boolean): Promise<void>; cancelled(): Promise<void>;
  deleted(): Promise<void>; duplicate(editing: Editing): Promise<void>;
}
type Section = Module['sections'][number];
type Spec = NonNullable<Detail['entry']['spec']>;
/** What a save would write; `raw` only carries field text and never reaches the server. */
const snapshot = (editing: Editing) => JSON.stringify({ name: editing.name, entry: editing.entry, secretValue: editing.secretValue });
/** Protocol knobs the editor keeps under the protocol block; the rest of a module's scalars belong to its own sections. */
const PROTOCOL_FIELDS = ['endpointPath', 'extraHeaders', 'extraBody'];
/**
 * One connection's editor: the identity card (name and type) on top, then the module's sections in
 * the order it declared them. Blocks the editor draws itself are named by `section.builtin`; the
 * rest are the module's own panels, mounted with their edits staged into `editing`.
 */
export async function mountDetail(options: Options): Promise<DetailController> {
  const { ctx, root, saved, modules } = options;
  const { ui } = ctx;
  const lifecycle = new Lifecycle(ctx.onError);
  const opts = { signal: lifecycle.signal };
  const persisted: Editing | null = saved ? { original: saved.name, name: saved.name, entry: saved.entry, revision: saved.revision, secretValue: '', raw: {} } : null;
  const editing: Editing = structuredClone(options.draft ?? persisted!);
  editing.entry.spec ??= { model: '', thinking: false };
  if (persisted) (persisted.entry.spec ??= { model: '', thinking: false });
  const dirty = () => !persisted || snapshot(editing) !== snapshot(persisted);
  const report = ui.msgline();
  const form = ui.h('div');
  root.append(form, report);
  const errors = new Map<string, () => boolean>();
  let rendering = 0;
  let saving = false;
  const panelHandles: Disposable[] = [];
  let panelHost: ReturnType<NonNullable<FeatureContext['consolePageHost']>> | null = null;
  /** The model block's way of showing a spec a module panel changed. */
  let syncSpec: (() => void) | null = null;
  const change = () => options.changed(editing, !!form.querySelector('[aria-invalid="true"]'), dirty());
  const run = (work: () => Promise<unknown>) => { void work().catch(error => { if (!lifecycle.disposed) report.textContent = String(error); }); };
  /** Preview name for an unsaved connection; the server resolves secrets by it. */
  const identity = saved?.name ?? 'draft';
  /** The probe and the model list run on what the form holds, key included, before anything is saved. */
  const draftBody = () => ({ entry: editing.entry, ...(editing.secretValue ? { secretValue: editing.secretValue } : {}) });
  const disposePanels = () => { for (const handle of panelHandles.splice(0)) handle.dispose(); };
  function field(body: HTMLElement, key: string, label: string, value: string, set: (value: string) => void, validate?: (value: string) => string | null, type = 'text') {
    const input = ui.input({ value, type: type as 'text' }); input.setAttribute('aria-label', label);
    const note = ui.h('div', 'field-error');
    const row = ui.h('div', 'connection-field'); row.append(ui.field(label + (['name', 'baseUrl', 'model'].includes(key) ? ' *' : ''), input), note); body.append(row);
    const check = () => { const error = validate?.(input.value); note.textContent = error ?? ''; input.setAttribute('aria-invalid', String(!!error)); return !error; };
    errors.set(key, check);
    input.addEventListener('input', () => { set(input.value); check(); change(); }, opts);
    return input;
  }
  function jsonField(body: HTMLElement, key: string, label: string, value: unknown, array: boolean, set: (value: unknown) => void) {
    const input = ui.textarea({ rows: 4, value: editing.raw[key] ?? (value === undefined ? '' : JSON.stringify(value, null, 2)), cls: 'mono' });
    input.setAttribute('aria-label', label);
    const error = ui.h('div', 'field-error'); body.append(ui.field(label, input), error);
    const check = () => {
      try {
        const parsed: unknown = input.value.trim() ? JSON.parse(input.value) : undefined;
        if (parsed !== undefined && (array ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error();
        set(parsed); error.textContent = ''; input.setAttribute('aria-invalid', 'false'); return true;
      } catch { error.textContent = array ? S.jsonArray : S.jsonObject; input.setAttribute('aria-invalid', 'true'); return false; }
    };
    errors.set(key, check);
    if (editing.raw[key] !== undefined) check();
    input.addEventListener('input', () => { editing.raw[key] = input.value; check(); change(); }, opts);
  }
  /** A section's card; folded ones remember their state per section id. */
  function block(box: HTMLElement, section: Section, fold = false) {
    const card = fold ? ui.foldSheet('connection-' + section.id, { title: section.title, desc: section.description }) : ui.sheet({ title: section.title, desc: section.description });
    box.append(card.el); return card.body;
  }
  /** Reads a dotted path under the entry; writes create the objects on the way. */
  const entryPath = (suffix: string) => {
    const parts = suffix.split('.');
    return {
      get: () => parts.reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], editing.entry),
      set: (value: unknown) => {
        let target = editing.entry as unknown as Record<string, unknown>;
        for (const part of parts.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>;
        if (value === undefined) delete target[parts.at(-1)!]; else target[parts.at(-1)!] = value;
      },
    };
  };
  function endpointBlock(box: HTMLElement, section: Section) {
    const body = block(box, section);
    field(body, 'baseUrl', S.url, editing.entry.baseUrl, value => { editing.entry.baseUrl = value; }, value => {
      try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? null : S.required; } catch { return S.required; }
    });
    const key = field(body, 'key', S.key, editing.secretValue, value => { editing.secretValue = value; }, undefined, 'password');
    key.placeholder = saved?.secretConfigured !== 'none' && saved ? S.keySet : S.keyEmpty;
    const test = ui.button(S.test, { onClick: () => run(async () => {
      test.disabled = true;
      try {
        const result = await post<{ ok: boolean; status: number | null; elapsedMs: number; model?: string; error?: string; hint?: string }>(connectionPath(identity) + '/test', draftBody(), opts);
        report.textContent = result.ok ? `${S.testOk} · HTTP ${result.status ?? '—'} · ${(result.elapsedMs / 1000).toFixed(1)}s · ${result.model ?? ''}` : `${S.testFailed}: ${result.hint ?? result.error ?? ''}`;
      } finally { test.disabled = false; }
    }) }); body.append(test);
    if (saved?.readiness.reason) body.append(ui.msgline(saved.readiness.reason, true));
  }
  function modelBlock(box: HTMLElement, section: Section, module: Module, spec: Spec) {
    const body = block(box, section);
    const modelInput = field(body, 'model', S.model, spec.model, value => { spec.model = value; }, value => value.trim() ? null : S.required);
    const catalog = ui.h('datalist'); catalog.id = 'connection-models-' + Math.random().toString(36).slice(2); modelInput.setAttribute('list', catalog.id); body.append(catalog);
    let listedModels: Array<{ id: string; contextWindow?: number }> = [];
    let contextInput: HTMLInputElement | null = null;
    modelInput.addEventListener('change', () => {
      const known = listedModels.find(item => item.id === modelInput.value)?.contextWindow;
      if (known && contextInput) { spec.contextWindow = known; contextInput.value = String(known); delete editing.raw.contextWindow; change(); }
    }, opts);
    const fetch = ui.button(S.fetchModels, { onClick: () => run(async () => {
      fetch.disabled = true;
      try { const result = await post<{ models: Array<{ id: string; contextWindow?: number }> }>(connectionPath(identity) + '/models', draftBody(), opts);
        catalog.replaceChildren(...result.models.map(item => { const option = ui.h('option'); option.value = item.id; return option; }));
        listedModels = result.models;
      } finally { fetch.disabled = false; }
    }) }); body.append(fetch);
    const tiers = module.reasoningTiers;
    if (tiers.length) {
      const select = ui.select({ value: tiers.find(tier => tier.thinking === spec.thinking && tier.effort === spec.reasoningEffort)?.id ?? '', options: tiers.map(tier => ({ value: tier.id, label: tier.label })), onChange: value => {
        const tier = tiers.find(tier => tier.id === value)!; spec.thinking = tier.thinking;
        if (tier.effort) spec.reasoningEffort = tier.effort; else delete spec.reasoningEffort; change();
      } }); select.setAttribute('aria-label', S.reasoning); body.append(ui.field(S.reasoning, select));
    } else field(body, 'reasoning', S.reasoning, !spec.thinking ? 'none' : spec.reasoningEffort ?? '', value => {
      spec.thinking = value !== 'none'; if (value && value !== 'none') spec.reasoningEffort = value; else delete spec.reasoningEffort;
    });
    for (const [name, label] of [['temperature', S.temperature], ['maxTokens', S.maxTokens], ['contextWindow', S.context]] as const) {
      const input = field(body, name, label, editing.raw[name] ?? String(spec[name] ?? ''), value => {
        editing.raw[name] = value; if (!value) delete spec[name]; else spec[name] = Number(value);
      }, value => !value || Number.isFinite(Number(value)) && (name === 'temperature' ? Number(value) >= 0 && Number(value) <= 2 : Number.isInteger(Number(value)) && Number(value) > 0) ? null : S.invalidNumber, 'number');
      if (name === 'contextWindow') contextInput = input;
    }
    if (module.serviceTiers.length) {
      const select = ui.select({ value: editing.entry.serviceTier ?? '', options: [{ value: '', label: '—' }, ...module.serviceTiers.map(tier => ({ value: tier.id, label: tier.label }))], onChange: value => { editing.entry.serviceTier = value; change(); } });
      select.setAttribute('aria-label', S.tier); body.append(ui.field(S.tier, select));
    }
    const images = ui.h('input'); images.type = 'checkbox'; images.checked = editing.entry.multimodal === true; images.setAttribute('aria-label', S.images);
    images.addEventListener('change', () => { editing.entry.multimodal = images.checked; change(); }, opts); body.append(ui.field(S.images, images));
    syncSpec = () => { modelInput.value = spec.model; errors.get('model')?.(); if (contextInput && spec.contextWindow !== undefined) contextInput.value = String(spec.contextWindow); };
  }
  function pricingBlock(box: HTMLElement, section: Section) {
    const body = block(box, section, true);
    const prices = pricingEditor(ui, editing.entry.pricing ?? [], saved?.quotes ?? [], value => {
      editing.entry.pricing = value as Detail['entry']['pricing']; change();
    }, LANGUAGE, { raw: editing.raw.pricing, onRaw: value => { editing.raw.pricing = value; change(); } });
    body.append(prices.body);
    errors.set('pricing', prices.validate);
  }
  /** Module scalars the editor renders itself: declared fields of a module that ships no sections of its own. */
  function groupBlock(box: HTMLElement, group: ConfigGroup) {
    const scalars = Object.entries(group.schema.properties ?? {}).filter(([path, property]) => property.type !== 'object' && !PROTOCOL_FIELDS.some(name => path.endsWith('.' + name)));
    if (!scalars.length) return;
    const body = block(box, { id: group.id, title: group.schema.title ?? group.id, description: group.schema.description });
    for (const [path, property] of scalars) {
      const at = entryPath(path.slice(`providers.${identity}.`.length));
      const control = configField(ui, property, at.get(), () => { if (control.read) { at.set(control.read()); change(); } }, lifecycle.signal);
      control.node.setAttribute('aria-label', property.title ?? path);
      body.append(ui.field(property.title ?? path, control.node));
      if (property.description) body.append(ui.h('p', 'tdesc', property.description));
    }
  }
  function protocolBlock(box: HTMLElement, section: Section, groups: ConfigGroup[]) {
    const body = block(box, section, true);
    field(body, 'secret', S.secret, editing.entry.secret ?? '', value => { if (value) editing.entry.secret = value; else delete editing.entry.secret; });
    for (const group of groups) for (const [path, property] of Object.entries(group.schema.properties ?? {})) {
      const suffix = path.slice(`providers.${identity}.`.length);
      const at = entryPath(suffix);
      if (property.type === 'object') { jsonField(body, path, property.title ?? suffix.split('.').at(-1)!, at.get(), false, at.set); continue; }
      if (!PROTOCOL_FIELDS.some(name => suffix.endsWith(name))) continue;
      const control = configField(ui, property, at.get(), () => { if (control.read) { at.set(control.read()); change(); } }, lifecycle.signal);
      control.node.setAttribute('aria-label', property.title ?? suffix);
      body.append(ui.field(property.title ?? suffix, control.node));
      if (property.description) body.append(ui.h('p', 'tdesc', property.description));
    }
  }
  async function render() {
    const gen = ++rendering;
    disposePanels(); syncSpec = null;
    errors.clear(); form.replaceChildren();
    const identityCard = ui.sheet({ title: S.basic }); identityCard.el.classList.add('connection-identity'); form.append(identityCard.el);
    const basic = identityCard.body;
    field(basic, 'name', S.name, editing.name, value => { editing.name = value; }, value => value === saved?.name ? null : validateProviderName(value) ? S.nameHint : null)
      .placeholder = S.newName;
    basic.append(ui.msgline(S.nameHint));
    const selectedModule = modules.find(module => module.id === editing.entry.kind);
    if (saved) {
      const module = ui.select({ value: editing.entry.kind, options: [{ value: editing.entry.kind, label: selectedModule?.title ?? editing.entry.kind }], disabled: true });
      module.setAttribute('aria-label', S.module); module.classList.add('connection-module-readonly');
      basic.append(ui.field(S.module, module), ui.msgline(S.fixedModule));
    }
    else {
      const select = ui.select({ value: editing.entry.kind, options: [{ value: '', label: '—' }, ...modules.map(module => ({ value: module.id, label: module.title }))],
        onChange: kind => {
          const module = modules.find(module => module.id === kind);
          editing.entry = { kind, baseUrl: module?.defaultBaseUrl ?? '', spec: { model: '', thinking: module?.reasoningTiers[0]?.thinking ?? true, ...(module?.reasoningTiers[0]?.effort ? { reasoningEffort: module.reasoningTiers[0].effort } : {}) } };
          editing.raw = {}; change(); run(render);
        } });
      select.setAttribute('aria-label', S.module); basic.append(ui.field(S.module + ' *', select));
      const required = ui.h('div', 'field-error'); basic.append(required);
      errors.set('module', () => { required.textContent = editing.entry.kind ? '' : S.required; select.setAttribute('aria-invalid', String(!editing.entry.kind)); return !!editing.entry.kind; });
    }
    if (selectedModule) basic.append(ui.h('p', 'field-note', S.moduleNote(selectedModule.description, selectedModule.id)));
    const flow = ui.h('div', 'connection-flow'); form.append(flow);
    const spec = editing.entry.spec ??= { model: '', thinking: false };
    const actions = ui.h('div', 'connection-actions');
    if (saved) {
      actions.append(ui.button(S.remove, { variant: 'danger', onClick: () => run(async () => {
        const current = await get<Detail>(connectionPath(saved.name), opts);
        if (current.references.length) { await ui.confirm({ title: S.remove, body: S.referenced + current.references.join(', ') }); return; }
        if (!(await ui.confirm({ title: S.remove, body: S.deleteConfirm, danger: true }))) return;
        await post(connectionPath(saved.name) + '/delete', { expectedRevision: saved.revision }, opts); await options.deleted();
      }) }), ui.button(S.duplicate, { onClick: () => run(() => options.duplicate({ original: null, copyFrom: { name: saved.name, revision: saved.revision }, name: (validateProviderName(saved.name) ? 'Connection' : saved.name) + '-Copy', entry: structuredClone(saved.entry), secretValue: '', raw: {} })) }));
    }
    actions.append(ui.h('span', 'grow'), ui.button(S.cancel, { onClick: () => run(() => options.cancelled()) }), ui.button(S.save, { variant: 'primary', onClick: () => run(() => save()) }));
    form.append(actions, ui.h('div', 'connection-shared', S.shared), ui.h('div', 'connection-shared', S.draftNote));
    if (!selectedModule) { flow.append(ui.msgline(saved ? S.readiness['module-missing'] : S.chooseModule)); return; }
    const groups = (await post<ConfigGroup[]>('/api/provider-modules/config', { name: identity, entry: editing.entry }, opts)).filter(group => !group.id.endsWith('.connection'));
    if (gen !== rendering || lifecycle.disposed) return;
    const ownSections = selectedModule.sections.some(section => !section.builtin);
    const pending: Array<{ section: Section; box: HTMLElement }> = [];
    for (const section of selectedModule.sections) {
      const box = ui.h('div', 'connection-step'); flow.append(box);
      switch (section.builtin) {
        case 'connection-endpoint': endpointBlock(box, section); break;
        case 'connection-model':
          modelBlock(box, section, selectedModule, spec);
          if (!ownSections) for (const group of groups) groupBlock(box, group);
          break;
        case 'connection-pricing': pricingBlock(box, section); break;
        case 'connection-protocol': protocolBlock(box, section, groups); break;
        default: pending.push({ section, box });
      }
    }
    if (!pending.length || !ctx.consolePageHost) return;
    panelHost ??= ctx.consolePageHost({ root: ui.h('div'), route: () => ['providers', saved?.name ?? ''] });
    await panelHost.load();
    if (gen !== rendering || lifecycle.disposed) return;
    for (const { section, box } of pending) {
      const handle = await panelHost.mountConnection(`llm:${editing.entry.kind}`, section.id, box, { instance: identity }, context => ({
        ...context,
        setConfig: async (_id, values) => {
          for (const [path, value] of Object.entries(values)) {
            const prefix = `providers.${identity}.`;
            if (!path.startsWith(prefix)) throw new Error('Foreign connection field');
            entryPath(path.slice(prefix.length)).set(value);
          }
          change(); return S.unsaved;
        },
        invoke: async <T>(method: string, args?: unknown[]): Promise<T> => {
          const before = JSON.stringify(editing.entry);
          const reply = await post<{ result: T; entry: Detail['entry'] }>('/api/provider-modules/preview', { name: identity, entry: editing.entry, panel: context.panelId, method, args }, opts);
          if (before === JSON.stringify(editing.entry) && JSON.stringify(reply.entry) !== before) {
            if (reply.entry.spec) Object.assign(spec, reply.entry.spec);
            editing.entry = { ...reply.entry, spec }; syncSpec?.(); change();
          }
          return reply.result;
        },
        refresh: async () => {},
      }));
      if (gen !== rendering || lifecycle.disposed) { handle.dispose(); return; }
      panelHandles.push(handle);
    }
  }
  async function save(select = true): Promise<boolean> {
    if (saving) return false;
    const valid = [...errors.values()].map(check => check()).every(Boolean); change();
    if (!valid) { report.textContent = S.readiness.invalid; return false; }
    saving = true;
    try {
      const result = await post<Detail>(saved ? connectionPath(saved.name) + '/save' : '/api/providers', { name: editing.name, entry: editing.entry, expectedRevision: editing.revision, copyFrom: editing.copyFrom, ...(editing.secretValue ? { secretValue: editing.secretValue } : {}) }, opts);
      await options.onSaved(result.name, select); return true;
    } catch (error) { report.textContent = String(error); return false; }
    finally { saving = false; }
  }
  await render(); change();
  return { dispose: () => { lifecycle.dispose(); disposePanels(); panelHost?.unmount(); } };
}
