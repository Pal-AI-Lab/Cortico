import type { FeatureContext } from '../feature.ts';
import { get, post } from '../../core/api.ts';
import { Lifecycle } from '../../core/lifecycle.ts';
import { configField, type ConfigGroup } from '../config/view.ts';
import { validateProviderName } from '../../../../providers/name.ts';
import { connectionPath, type Detail, type Editing, type Module } from './types.ts';
import { S } from './strings.ts';

export interface DetailController { dispose(): void; dirty(): boolean; leave(): Promise<boolean>; }
interface Options {
  ctx: FeatureContext; root: HTMLElement; modules: Module[]; saved: Detail | null; draft: Editing | null;
  changed(editing: Editing): void; onSaved(name: string): Promise<void>; cancelled(): Promise<void>;
  deleted(): Promise<void>; duplicate(editing: Editing): Promise<void>;
}
export async function mountDetail(options: Options): Promise<DetailController> {
  const { ctx, root, saved, modules } = options;
  const { ui } = ctx;
  const lifecycle = new Lifecycle(ctx.onError);
  const opts = { signal: lifecycle.signal };
  const editing: Editing = structuredClone(options.draft ?? { original: saved!.name, name: saved!.name, entry: saved!.entry, revision: saved!.revision, secretValue: '', raw: {} });
  let baseline = JSON.stringify(editing);
  const dirty = () => JSON.stringify(editing) !== baseline;
  const report = ui.msgline();
  const form = ui.h('div');
  root.append(form, report);
  const errors = new Map<string, () => boolean>();
  let rendering = 0;
  let panelHandle: { dispose(): void } | null = null;
  let panelHost: ReturnType<NonNullable<FeatureContext['consolePageHost']>> | null = null;
  const change = () => options.changed(editing);
  const run = (work: () => Promise<unknown>) => { void work().catch(error => { if (!lifecycle.disposed) report.textContent = String(error); }); };
  function field(body: HTMLElement, key: string, label: string, value: string, set: (value: string) => void, validate?: (value: string) => string | null, type = 'text') {
    const input = ui.input({ value, type: type as 'text' }); input.setAttribute('aria-label', label);
    const note = ui.h('div', 'field-error');
    const row = ui.h('div', 'connection-field'); row.append(ui.field(label + (validate ? ' *' : ''), input), note); body.append(row);
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
    input.addEventListener('input', () => { editing.raw[key] = input.value; check(); change(); }, opts);
  }
  function section(title: string, id?: string, open = false) {
    const card = id ? ui.foldSheet('connection-' + id, { title, defaultOpen: open }) : ui.sheet({ title });
    form.append(card.el); return card.body;
  }
  async function render() {
    const gen = ++rendering;
    panelHandle?.dispose(); panelHandle = null;
    errors.clear(); form.replaceChildren();
    const basic = section(S.basic);
    field(basic, 'name', S.name, editing.name, value => { editing.name = value; }, value => value === saved?.name ? null : validateProviderName(value) ? S.nameHint : null);
    basic.append(ui.msgline(S.nameHint));
    const selectedModule = modules.find(module => module.id === editing.entry.kind);
    if (saved) basic.append(ui.field(S.module, ui.h('span', '', selectedModule?.title ?? editing.entry.kind)), ui.msgline(S.fixedModule));
    else {
      const select = ui.select({ value: editing.entry.kind, options: [{ value: '', label: '—' }, ...modules.map(module => ({ value: module.id, label: module.title }))],
        onChange: kind => {
          const module = modules.find(module => module.id === kind);
          editing.entry = { kind, baseUrl: module?.defaultBaseUrl ?? '', spec: { model: '', thinking: module?.reasoningTiers[0]?.thinking ?? true, ...(module?.reasoningTiers[0]?.effort ? { reasoningEffort: module.reasoningTiers[0].effort } : {}) } };
          editing.raw = {}; change(); run(render);
        } });
      select.setAttribute('aria-label', S.module); basic.append(ui.field(S.module + ' *', select));
      errors.set('module', () => !!editing.entry.kind);
    }
    if (selectedModule) basic.append(ui.msgline(selectedModule.description), ui.h('small', 'muted', selectedModule.id));
    const connection = section(S.connection);
    field(connection, 'baseUrl', S.url, editing.entry.baseUrl, value => { editing.entry.baseUrl = value; }, value => {
      try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? null : S.required; } catch { return S.required; }
    });
    const key = field(connection, 'key', S.key, editing.secretValue, value => { editing.secretValue = value; }, undefined, 'password');
    key.placeholder = saved?.secretConfigured !== 'none' && saved ? S.keySet : S.keyEmpty;
    const test = ui.button(S.test, { onClick: () => run(async () => {
      if (!saved || dirty()) { report.textContent = S.savedFirst; return; }
      test.disabled = true;
      try {
        const result = await post<{ ok: boolean; status: number | null; elapsedMs: number; model?: string; error?: string; hint?: string }>(connectionPath(saved.name) + '/test', {}, opts);
        report.textContent = result.ok ? `${S.testOk} · HTTP ${result.status ?? '—'} · ${(result.elapsedMs / 1000).toFixed(1)}s · ${result.model ?? ''}` : `${S.testFailed}: ${result.hint ?? result.error ?? ''}`;
      } finally { test.disabled = false; }
    }) }); connection.append(test);
    if (saved?.readiness.reason) connection.append(ui.msgline(saved.readiness.reason, true));
    const model = section(S.modelSection, 'model', true);
    const spec = editing.entry.spec ??= { model: '', thinking: false };
    const modelInput = field(model, 'model', S.model, spec.model, value => { spec.model = value; }, value => value.trim() ? null : S.required);
    const catalog = ui.h('datalist'); catalog.id = 'connection-models-' + Math.random().toString(36).slice(2); modelInput.setAttribute('list', catalog.id); model.append(catalog);
    const fetch = ui.button(S.fetchModels, { onClick: () => run(async () => {
      if (!saved || dirty()) { report.textContent = S.savedFirst; return; }
      fetch.disabled = true;
      try { const result = await post<{ models: Array<{ id: string; contextWindow?: number }> }>(connectionPath(saved.name) + '/models', {}, opts);
        catalog.replaceChildren(...result.models.map(item => { const option = ui.h('option'); option.value = item.id; return option; }));
        modelInput.addEventListener('change', () => { const known = result.models.find(item => item.id === modelInput.value)?.contextWindow; if (known) { spec.contextWindow = known; change(); } }, opts);
      } finally { fetch.disabled = false; }
    }) }); model.append(fetch);
    const tiers = selectedModule?.reasoningTiers ?? [];
    if (tiers.length) {
      const select = ui.select({ value: tiers.find(tier => tier.thinking === spec.thinking && tier.effort === spec.reasoningEffort)?.id ?? '', options: tiers.map(tier => ({ value: tier.id, label: tier.label })), onChange: value => {
        const tier = tiers.find(tier => tier.id === value)!; spec.thinking = tier.thinking;
        if (tier.effort) spec.reasoningEffort = tier.effort; else delete spec.reasoningEffort; change();
      } }); select.setAttribute('aria-label', S.reasoning); model.append(ui.field(S.reasoning, select));
    } else field(model, 'reasoning', S.reasoning, !spec.thinking ? 'none' : spec.reasoningEffort ?? '', value => {
      spec.thinking = value !== 'none'; if (value && value !== 'none') spec.reasoningEffort = value; else delete spec.reasoningEffort;
    });
    for (const [name, label] of [['temperature', S.temperature], ['maxTokens', S.maxTokens], ['contextWindow', S.context]] as const) {
      field(model, name, label, editing.raw[name] ?? String(spec[name] ?? ''), value => {
        editing.raw[name] = value; if (!value) delete spec[name]; else spec[name] = Number(value);
      }, value => !value || Number.isFinite(Number(value)) && (name === 'temperature' ? Number(value) >= 0 && Number(value) <= 2 : Number.isInteger(Number(value)) && Number(value) > 0) ? null : 'Invalid number', 'number');
    }
    if (selectedModule?.serviceTiers.length) {
      const select = ui.select({ value: editing.entry.serviceTier ?? '', options: [{ value: '', label: '—' }, ...selectedModule.serviceTiers.map(tier => ({ value: tier.id, label: tier.label }))], onChange: value => { editing.entry.serviceTier = value; change(); } });
      select.setAttribute('aria-label', S.tier); model.append(ui.field(S.tier, select));
    }
    const images = ui.h('input'); images.type = 'checkbox'; images.checked = editing.entry.multimodal === true; images.setAttribute('aria-label', S.images);
    images.addEventListener('change', () => { editing.entry.multimodal = images.checked; change(); }, opts); model.append(ui.field(S.images, images));
    const moduleBody = section(S.moduleSection, 'module', true);
    const pricing = section(S.pricing, 'pricing'); pricing.append(ui.msgline(S.priceHint));
    jsonField(pricing, 'pricing', S.priceRules, editing.entry.pricing, true, value => { editing.entry.pricing = value as Detail['entry']['pricing']; });
    const advanced = section(S.advanced, 'advanced'); advanced.append(ui.msgline(S.advancedHint));
    field(advanced, 'secret', S.secret, editing.entry.secret ?? '', value => { if (value) editing.entry.secret = value; else delete editing.entry.secret; });
    form.append(ui.h('div', 'connection-shared', S.shared));
    const actions = ui.h('div', 'connection-actions');
    if (saved) {
      actions.append(ui.button(S.remove, { variant: 'danger', onClick: () => run(async () => {
        const current = await get<Detail>(connectionPath(saved.name), opts);
        if (current.references.length) { await ui.confirm({ title: S.remove, body: S.referenced + current.references.join(', ') }); return; }
        if (!(await ui.confirm({ title: S.remove, body: S.deleteConfirm, danger: true }))) return;
        await post(connectionPath(saved.name) + '/delete', { expectedRevision: saved.revision }, opts); baseline = JSON.stringify(editing); await options.deleted();
      }) }), ui.button(S.duplicate, { onClick: () => run(async () => {
        if (!(await leave())) return;
        await options.duplicate({ original: null, name: saved.name + '-Copy', entry: structuredClone(saved.entry), secretValue: '', raw: {} });
      }) }));
    }
    actions.append(ui.h('span', 'grow'), ui.button(S.cancel, { onClick: () => run(async () => { baseline = JSON.stringify(editing); await options.cancelled(); }) }), ui.button(S.save, { variant: 'primary', onClick: () => run(save) }));
    form.append(actions);
    if (!selectedModule) { moduleBody.append(ui.msgline(S.readiness['module-missing'])); return; }
    const identity = saved?.name ?? 'draft';
    const groups = await post<ConfigGroup[]>('/api/provider-modules/config', { name: identity, entry: editing.entry }, opts);
    if (gen !== rendering || lifecycle.disposed) return;
    for (const group of groups.filter(group => !group.id.endsWith('.connection'))) {
      for (const [path, property] of Object.entries(group.schema.properties ?? {})) {
        const suffix = path.slice(`providers.${identity}.`.length);
        if (['baseUrl', 'secret', 'multimodal'].includes(suffix) || property.type === 'object') continue;
        const parts = suffix.split('.');
        const getValue = () => parts.reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], editing.entry);
        const setValue = (value: unknown) => {
          let target = editing.entry as unknown as Record<string, unknown>;
          for (const part of parts.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>;
          target[parts.at(-1)!] = value;
        };
        const body = suffix.includes('endpointPath') || suffix.includes('extraHeaders') || suffix.includes('extraBody') ? advanced : moduleBody;
        const control = configField(ui, property, getValue(), () => { if (control.read) { setValue(control.read()); change(); } }, lifecycle.signal);
        control.node.setAttribute('aria-label', property.title ?? suffix);
        body.append(ui.field(property.title ?? suffix, control.node));
      }
    }
    if (ctx.consolePageHost) {
      const slot = ui.h('div'); moduleBody.append(slot);
      panelHost ??= ctx.consolePageHost({ root: slot, route: () => ['providers', saved?.name ?? ''] });
      await panelHost.load();
      if (gen !== rendering || lifecycle.disposed) return;
      panelHandle = await panelHost.mountConnection(`llm:${editing.entry.kind}`, slot, { instance: identity }, context => ({
        ...context,
        setConfig: async (_id, values) => {
          for (const [path, value] of Object.entries(values)) {
            const prefix = `providers.${identity}.`;
            if (!path.startsWith(prefix)) throw new Error('Foreign connection field');
            const parts = path.slice(prefix.length).split('.');
            let target = editing.entry as unknown as Record<string, unknown>;
            for (const part of parts.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>;
            target[parts.at(-1)!] = value;
          }
          change(); return S.unsaved;
        },
        invoke: async <T>(method: string, args?: unknown[]): Promise<T> => {
          const before = JSON.stringify(editing.entry);
          const reply = await post<{ result: T; entry: Detail['entry'] }>('/api/provider-modules/preview', { name: identity, entry: editing.entry, panel: context.panelId, method, args }, opts);
          if (before === JSON.stringify(editing.entry) && JSON.stringify(reply.entry) !== before) { if (reply.entry.spec) Object.assign(spec, reply.entry.spec); editing.entry = { ...reply.entry, spec }; change(); }
          return reply.result;
        },
        refresh: async () => {},
      }));
      if (gen !== rendering || lifecycle.disposed) panelHandle.dispose();
    }
    // Object-valued protocol fields remain JSON editors; their presence is declared by the module schema.
    for (const group of groups) for (const [path, property] of Object.entries(group.schema.properties ?? {})) {
      if (property.type !== 'object') continue;
      const suffix = path.slice(`providers.${identity}.options.`.length);
      const value = editing.entry.options?.[suffix];
      jsonField(advanced, suffix, property.title ?? suffix, value, false, value => { editing.entry.options ??= {}; if (value === undefined) delete editing.entry.options[suffix]; else editing.entry.options[suffix] = value; });
    }
  }
  async function save(): Promise<boolean> {
    if (![...errors.values()].map(check => check()).every(Boolean)) { report.textContent = S.readiness.invalid; return false; }
    try {
      const result = await post<Detail>(saved ? connectionPath(saved.name) + '/save' : '/api/providers', { name: editing.name, entry: editing.entry, expectedRevision: editing.revision, ...(editing.secretValue ? { secretValue: editing.secretValue } : {}) }, opts);
      baseline = JSON.stringify(editing); await options.onSaved(result.name); return true;
    } catch (error) { report.textContent = String(error); return false; }
  }
  async function leave(): Promise<boolean> { return !dirty() || await ui.confirm({ title: S.unsaved, body: S.discard }); }
  await render();
  return { dispose: () => { lifecycle.dispose(); panelHandle?.dispose(); panelHost?.unmount(); }, dirty, leave };
}
