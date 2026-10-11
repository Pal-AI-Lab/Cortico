import { coerceGroupValues, getByPath, setByPath } from '../../core/config-schema.ts';
/** Connection configuration transactions serialize writers across deployments and roll back all touched files on failure. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CoreConfig, LLMProviderEntry } from '../../core/types.ts';
import { LocalizedError, type Language } from '../../core/language.ts';
import { readJsonObject, updateJsonObject } from '../../config-file.ts';
import { readTextFile } from '../../core/util.ts';
import type { ProviderModule } from '../base.ts';
import { validateEntry, withContextWindows } from '../configuration.ts';
import { validateProviderName, defaultSecretName } from '../name.ts';
import { providerModules, type ProviderRegistry } from '../registry.ts';
import type { ProviderSettings } from './settings.ts';
import { quotePrices } from '../pricebook.ts';
import { connectionGroup } from './config.ts';
import { instanceIsRunning } from '../../core/instance-lock.ts';
import { CORE_DEFAULTS } from '../../core/config.ts';
import { text } from './strings.ts';

function hubError(message: (S: ReturnType<typeof text>) => string, status?: number): LocalizedError {
  return new LocalizedError((language) => message(text(language)), status);
}
export interface ConnectionSave {
  name: string;
  copyFrom?: { name: string; revision: string };
  entry: LLMProviderEntry;
  expectedRevision?: string;
  secretValue?: string;
}
export class ProviderHub {
  private readonly revisions = new Map<string, string>();
  constructor(private readonly config: CoreConfig, private readonly registry: ProviderRegistry,
    private readonly settings: ProviderSettings, private readonly file: string,
    private readonly root: string, private readonly modules: readonly ProviderModule[] = providerModules) {}

  private path(name: string): string {
    const path = resolve(this.root, name);
    if (!name || dirname(path) !== resolve(this.root)) throw hubError(S => S.invalidIdentifier);
    return path;
  }
  private revision(name: string): string {
    const dir = this.path(name);
    return createHash('sha256').update(['config.json', '.env'].map(file =>
      existsSync(join(dir, file)) ? readFileSync(join(dir, file)).toString('base64') : '').join(':')).digest('hex');
  }
  private refresh(): void {
    const entries: Record<string, LLMProviderEntry> = Object.create(null);
    if (existsSync(this.root)) for (const dir of readdirSync(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory() || (dir.name === '.write-lock' || dir.name.startsWith('.transaction-') || dir.name.startsWith('.deleted-'))) continue;
      const file = join(this.root, dir.name, 'config.json');
      if (existsSync(file)) entries[dir.name] = JSON.parse(readTextFile(file));
    }
    for (const name of new Set([...Object.keys(entries), ...Object.keys(this.config.providers)])) {
      const revision = entries[name] ? this.revision(name) : '';
      if (JSON.stringify(entries[name]) !== JSON.stringify(this.config.providers[name]) || this.revisions.get(name) !== revision) this.registry.invalidate(name);
      this.revisions.set(name, revision);
    }
    this.config.providers = entries;
    const disk = readJsonObject(this.file);
    if (typeof disk.activeProvider === 'string') this.config.activeProvider = disk.activeProvider;
  }
  moduleList(language: Language) {
    return this.modules.map(module => ({ id: module.id, title: module.localize?.(language)?.title ?? module.title,
      description: module.localize?.(language)?.description ?? module.description ?? module.title, defaultBaseUrl: module.defaultBaseUrl ?? '',
      reasoningTiers: module.localize?.(language)?.reasoningTiers ?? module.reasoningTiers,
      effortSuggestions: module.effortSuggestions ?? [], serviceTiers: module.localize?.(language)?.serviceTiers ?? module.serviceTiers,
      temperatureNote: module.localize?.(language)?.temperatureNote ?? module.temperatureNote,
      sections: this.sections(module.id, language),
    }));
  }
  /** The editor's sections for one module, in order: the page's panels minus the endpoint table. */
  private moduleTitle(kind: string, language: Language): string {
    const module = this.modules.find(m => m.id === kind);
    return module ? module.localize?.(language)?.title ?? module.title : kind;
  }
  private sections(kind: string, language: Language) {
    const source = this.settings.sources().find(source => source.id === `llm:${kind}`);
    return (source?.contribute(language).panels ?? []).filter(panel => panel.id !== 'settings')
      .map(({ id, title, description, builtin, defaultOpen }) => ({ id, title, ...(description ? { description } : {}), ...(builtin ? { builtin } : {}), ...(defaultOpen !== undefined ? { defaultOpen } : {}) }));
  }
  private readiness(name: string, entry: LLMProviderEntry, language: Language) {
    const module = this.modules.find(m => m.id === entry.kind);
    const S = text(language);
    if (!module) return { state: 'module-missing', reason: S.moduleMissing };
    try { validateEntry(module, entry, language); }
    catch (error) { return { state: 'invalid', reason: String(error) }; }
    if (!entry.spec?.model || (entry.secret && this.settings.secretStatus(name, entry) === 'none'))
      return { state: 'needs-setup', reason: !entry.spec?.model ? S.modelMissing : S.apiKeyMissing };
    const available = module.availability?.(name, entry, language);
    if (available && !available.ready) return { state: 'runtime-unavailable', reason: available.reason };
    return { state: 'ready' };
  }
  current(language: Language) {
    const name = this.config.activeProvider;
    const entry = this.config.providers[name];
    return entry ? { name, model: entry.spec?.model ?? null, module: entry.kind,
      moduleTitle: this.moduleTitle(entry.kind, language),
      baseUrl: entry.baseUrl, ready: this.readiness(name, entry, language).state === 'ready' } : null;
  }
  list(language: Language) {
    this.refresh();
    return { scope: createHash('sha256').update(resolve(this.file)).digest('hex'), active: this.config.activeProvider, providers: Object.entries(this.config.providers).map(([name, entry]) => ({
      id: name, name, module: entry.kind, moduleTitle: this.moduleTitle(entry.kind, language),
      model: entry.spec?.model ?? null, baseUrl: entry.baseUrl, active: name === this.config.activeProvider,
      readiness: this.readiness(name, entry, language), revision: this.revision(name),
      usage: this.references(name).filter(file => resolve(file) !== resolve(this.file)).map(file => {
        const config = readJsonObject(file);
        const paths = config.paths as { data?: string } | undefined;
        return { name: basename(dirname(file)), running: instanceIsRunning(resolve(dirname(file), paths?.data ?? CORE_DEFAULTS.paths.data)) };
      }),
    })) };
  }
  detail(name: string, language: Language) {
    this.refresh();
    const entry = this.config.providers[name];
    if (!entry) throw hubError(S => S.unknownInstance, 404);
    return { name, entry: structuredClone(entry), revision: this.revision(name),
      secretConfigured: this.settings.secretStatus(name, entry), readiness: this.readiness(name, entry, language),
      references: this.references(name).map(file => dirname(file).split(/[\\/]/).at(-1)),
      config: this.groups(name, entry, language),
      quotes: entry.spec ? [{ model: entry.spec.model, quotes: this.quotes(entry) }] : [],
    };
  }
  private quotes(entry: LLMProviderEntry) {
    const module = this.modules.find(module => module.id === entry.kind);
    const request = { model: entry.spec?.model };
    const at = { startedAt: new Date().toISOString(), requestedServiceTier: entry.serviceTier ?? null };
    return quotePrices(entry, request, at, module?.prices?.(entry, request, at) ?? []);
  }
  groups(name: string, entry: LLMProviderEntry, language: Language) {
    const module = this.modules.find(m => m.id === entry.kind);
    return [connectionGroup(name, entry, language), ...(module?.config?.(name, entry, language) ?? [])];
  }
  async preview(name: string, entry: LLMProviderEntry, panel: string, method: string, args: unknown[], language: Language) {
    this.path(name);
    const module = this.modules.find(module => module.id === entry.kind);
    if (!module?.console) throw hubError(S => S.modulePanelMissing);
    this.refresh();
    const current = this.config.providers[name];
    const persisted = !!current && JSON.stringify(current) === JSON.stringify(entry);
    let draft = structuredClone(entry);
    const contribution = module.console({ language, editing: !persisted,
      entries: () => [{ name, entry: draft }],
      instance: requested => {
        if (requested !== name) throw hubError(S => S.foreignRequest);
        return persisted ? this.registry.resolve(name) : this.registry.preview(name, draft);
      },
      save: (requested, next) => {
        if (requested !== name || next.kind !== entry.kind) throw hubError(S => S.foreignRequest);
        draft = structuredClone(next);
      },
    });
    const result = await contribution.invoke?.(panel, method, args);
    return { result, entry: draft };
  }
  private references(name: string): string[] {
    const files = new Set([this.file]);
    const parent = dirname(this.root);
    for (const dir of readdirSync(parent, { withFileTypes: true })) {
      if (!dir.isDirectory() || resolve(parent, dir.name) === resolve(this.root)) continue;
      const file = join(parent, dir.name, 'config.json');
      if (existsSync(file) && existsSync(join(parent, dir.name, 'deployment.json'))) files.add(file);
    }
    return [...files].filter(file => readJsonObject(file).activeProvider === name);
  }
  private locked<T>(work: () => T): T {
    mkdirSync(this.root, { recursive: true });
    const lock = join(this.root, '.write-lock');
    try { mkdirSync(lock); } catch { throw hubError(S => S.busy, 409); }
    try { this.refresh(); return work(); } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  private checkRevision(name: string, expected: unknown): void {
    if (typeof expected !== 'string' || expected !== this.revision(name))
      throw hubError(S => S.changedElsewhere, 409);
  }
  save(original: string | null, input: ConnectionSave, language: Language) {
    return this.locked(() => {
      const { name } = input;
      if (typeof name !== 'string') throw hubError(S => S.nameRequired);
      const prior = original ? this.config.providers[original] : undefined;
      if (original && !prior) throw hubError(S => S.unknownInstance, 404);
      if (original) this.checkRevision(original, input.expectedRevision);
      if (name !== original) {
        const problem = validateProviderName(name);
        if (problem) throw hubError(S => problem === 'shape' ? S.nameShape : S.nameReserved);
        if (readdirSync(this.root).some(value => value.toLowerCase() === name.toLowerCase()))
          throw hubError(S => S.nameTaken, 409);
      }
      if (!input.entry || typeof input.entry !== 'object') throw hubError(S => S.bodyRequired);
      if (prior && prior.kind !== input.entry.kind) throw hubError(S => S.kindChange);
      const module = this.modules.find(m => m.id === input.entry.kind);
      if (!module) throw hubError(S => S.moduleMissing);
      const requested = withTypedSecret(name, structuredClone(input.entry), input.secretValue);
      if (!requested.spec?.model) throw hubError(S => S.modelMissing);
      const entry = validateEntry(module, requested, language);
      const prefix = `providers.${name}.`;
      for (const group of this.groups(name, entry, language)) {
        const values = Object.fromEntries(Object.keys(group.schema.properties).filter(path => path.startsWith(prefix))
          .map(path => [path, getByPath(entry as unknown as Record<string, unknown>, path.slice(prefix.length))])
          .filter(([, value]) => value !== undefined));
        const result = coerceGroupValues(group, values, language);
        if ('error' in result) { const { error } = result; throw new LocalizedError(() => error); }
        for (const [path, value] of Object.entries(result.values)) setByPath(entry as unknown as Record<string, unknown>, path.slice(prefix.length), value);
      }
      validateEntry(module, entry, language);
      let copiedSecret: Buffer | null = null;
      let credentialSource = original;
      if (!original && input.copyFrom) {
        const source = this.config.providers[input.copyFrom.name];
        if (!source) throw hubError(S => S.copySourceGone, 409);
        this.checkRevision(input.copyFrom.name, input.copyFrom.revision);
        if (source.secret === entry.secret) {
          credentialSource = input.copyFrom.name;
          const file = join(this.path(input.copyFrom.name), '.env');
          if (existsSync(file)) copiedSecret = readFileSync(file);
        }
      }
      if (entry.secret && !input.secretValue && (!credentialSource || this.settings.secretStatus(credentialSource, entry) === 'none'))
        throw hubError(S => S.apiKeyMissing);
      const target = this.path(name);
      const source = original ? this.path(original) : null;
      const stage = join(this.root, `.transaction-${randomUUID()}`);
      const refs = original && name !== original ? this.references(original) : [];
      const backups = new Map<string, Buffer | null>();
      for (const file of [...refs, ...(source ? [join(source, 'config.json'), join(source, '.env')] : [])])
        backups.set(file, existsSync(file) ? readFileSync(file) : null);
      let moved = false;
      try {
        if (!source) mkdirSync(stage);
        const dir = source ?? stage;
        updateJsonObject(join(dir, 'config.json'), raw => { for (const key of Object.keys(raw)) delete raw[key]; Object.assign(raw, entry); });
        if (copiedSecret) writeFileSync(join(dir, '.env'), copiedSecret);
        if (input.secretValue) {
          const file = join(dir, '.env');
          const lines = (existsSync(file) ? readTextFile(file) : '').split(/\r?\n/).filter(line => line.split('=')[0]?.trim() !== entry.secret);
          lines.push(`${entry.secret}=${input.secretValue}`);
          writeFileSync(file, lines.filter(Boolean).join('\n') + '\n');
        }
        if (source !== target) { renameSync(dir, target); moved = true; }
        for (const file of refs) updateJsonObject(file, raw => { raw.activeProvider = name; });
      } catch (error) {
        if (moved) renameSync(target, source ?? stage);
        for (const [file, contents] of backups) {
          if (contents === null) rmSync(file, { force: true }); else writeFileSync(file, contents);
        }
        throw error;
      } finally { if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); }
      if (original) this.registry.invalidate(original);
      this.registry.invalidate(name);
      this.refresh();
      return this.detail(name, language);
    });
  }
  activate(name: string, language: Language): void {
    this.locked(() => {
      const entry = this.config.providers[name];
      if (!entry) throw hubError(S => S.unknownInstance, 404);
      const readiness = this.readiness(name, entry, language);
      if (readiness.state !== 'ready') { const reason = readiness.reason ?? readiness.state; throw new LocalizedError(() => reason); }
      updateJsonObject(this.file, raw => { raw.activeProvider = name; });
      this.config.activeProvider = name;
    });
  }
  delete(name: string, revision: string): void {
    this.locked(() => {
      if (!this.config.providers[name]) throw hubError(S => S.unknownInstance, 404);
      this.checkRevision(name, revision);
      const refs = this.references(name);
      if (this.config.activeProvider === name || refs.length)
        throw hubError(S => refs.length ? S.inUse(refs.map(file => dirname(file).split(/[\\/]/).at(-1)).join(', ')) : S.deleteActive, 409);
      const tomb = join(this.root, `.deleted-${randomUUID()}`);
      renameSync(this.path(name), tomb);
      this.registry.invalidate(name);
      delete this.config.providers[name];
      rmSync(tomb, { recursive: true, force: true });
    });
  }
  /**
   * Probe (`test`) or list models (`models`). With `draft`, the request goes through an instance
   * built from the browser's entry and typed key; nothing is written, and `name` may not exist yet.
   */
  async action(name: string, action: 'test' | 'models', language: Language, draft?: { entry: LLMProviderEntry; secretValue?: string }) {
    this.refresh();
    if (!draft) {
      const entry = this.config.providers[name];
      if (!entry) throw hubError(S => S.unknownInstance, 404);
      const source = this.settings.sources().find(source => source.id === `llm:${entry.kind}`);
      if (!source) throw hubError(S => S.moduleMissing);
      return source.contribute(language).invoke!('settings', action === 'test' ? 'probe' : 'models', [{ name }]);
    }
    this.path(name);
    if (!draft.entry || typeof draft.entry !== 'object') throw hubError(S => S.bodyRequired);
    const module = this.modules.find(m => m.id === draft.entry.kind);
    if (!module) throw hubError(S => S.moduleMissing);
    const entry = validateEntry(module, withTypedSecret(name, draft.entry, draft.secretValue), language);
    const registry = this.registry.previewRegistry(name, entry, entry.secret && draft.secretValue ? { [entry.secret]: draft.secretValue } : {});
    if (action === 'models') {
      const instance = registry.resolve(name);
      if (!instance.listModels) throw hubError(S => S.modelsUnsupported);
      const models = await instance.listModels();
      // llamacpp 的 contextWindow(id) 按模型向服务发 /props 探测;它的列表已带探测过的窗口。
      return { models: entry.kind === 'llamacpp' ? models : withContextWindows(instance, models) };
    }
    if (!entry.spec) throw hubError(S => S.modelMissing);
    return this.settings.probeClient(registry.bind(name), entry.spec, language);
  }
}

/** A typed key with no variable name declared is stored under the name derived from the endpoint name. */
function withTypedSecret(name: string, entry: LLMProviderEntry, secretValue: string | undefined): LLMProviderEntry {
  if (secretValue !== undefined && (typeof secretValue !== 'string' || !secretValue || /\s/.test(secretValue)))
    throw hubError(S => S.secretValueInvalid);
  return secretValue && !entry.secret ? { ...entry, secret: defaultSecretName(name) } : entry;
}
