import { coerceGroupValues, getByPath, setByPath } from '../../core/config-schema.ts';
/** Connection configuration transactions serialize writers across deployments and roll back all touched files on failure. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CoreConfig, LLMProviderEntry } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import { readJsonObject, updateJsonObject } from '../../config-file.ts';
import { readTextFile } from '../../core/util.ts';
import type { ProviderModule } from '../base.ts';
import { validateEntry } from '../configuration.ts';
import { validateProviderName } from '../name.ts';
import { providerModules, type ProviderRegistry } from '../registry.ts';
import type { ProviderSettings } from './settings.ts';
import { quotePrices } from '../pricebook.ts';
import { connectionGroup } from './config.ts';

export class ProviderHubError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
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
    if (!name || dirname(path) !== resolve(this.root)) throw new ProviderHubError('Invalid provider identifier.');
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
    return this.modules.map(module => ({ id: module.id, title: module.title,
      description: module.localize?.(language)?.description ?? module.description ?? module.title, defaultBaseUrl: module.defaultBaseUrl ?? '',
      reasoningTiers: module.localize?.(language)?.reasoningTiers ?? module.reasoningTiers,
      effortSuggestions: module.effortSuggestions ?? [], serviceTiers: module.localize?.(language)?.serviceTiers ?? module.serviceTiers,
      temperatureNote: module.localize?.(language)?.temperatureNote ?? module.temperatureNote,
    }));
  }
  private readiness(name: string, entry: LLMProviderEntry, language: Language) {
    const module = this.modules.find(m => m.id === entry.kind);
    if (!module) return { state: 'module-missing', reason: language === 'zh' ? '供应商模块不可用。' : 'Provider module is unavailable.' };
    try { validateEntry(module, entry, language); }
    catch (error) { return { state: 'invalid', reason: String(error) }; }
    if (!entry.spec?.model || (entry.secret && this.settings.secretStatus(name, entry) === 'none'))
      return { state: 'needs-setup', reason: !entry.spec?.model ? (language === 'zh' ? '请选择模型。' : 'Model is required.') : (language === 'zh' ? '请配置 API Key。' : 'API Key is required.') };
    const available = module.availability?.(name, entry, language);
    if (available && !available.ready) return { state: 'runtime-unavailable', reason: available.reason };
    return { state: 'ready' };
  }
  current(language: Language) {
    const name = this.config.activeProvider;
    const entry = this.config.providers[name];
    return entry ? { name, model: entry.spec?.model ?? null, module: entry.kind,
      moduleTitle: this.modules.find(module => module.id === entry.kind)?.title ?? entry.kind,
      baseUrl: entry.baseUrl, ready: this.readiness(name, entry, language).state === 'ready' } : null;
  }
  list(language: Language) {
    this.refresh();
    return { scope: createHash('sha256').update(resolve(this.file)).digest('hex'), active: this.config.activeProvider, providers: Object.entries(this.config.providers).map(([name, entry]) => ({
      id: name, name, module: entry.kind, moduleTitle: this.modules.find(m => m.id === entry.kind)?.title ?? entry.kind,
      model: entry.spec?.model ?? null, baseUrl: entry.baseUrl, active: name === this.config.activeProvider,
      readiness: this.readiness(name, entry, language), revision: this.revision(name),
    })) };
  }
  detail(name: string, language: Language) {
    this.refresh();
    const entry = this.config.providers[name];
    if (!entry) throw new ProviderHubError('Provider does not exist.', 404);
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
    if (!module?.console) throw new ProviderHubError('Module panel unavailable.');
    this.refresh();
    const current = this.config.providers[name];
    const persisted = !!current && JSON.stringify(current) === JSON.stringify(entry);
    let draft = structuredClone(entry);
    const contribution = module.console({ language, editing: !persisted,
      entries: () => [{ name, entry: draft }],
      instance: requested => {
        if (requested !== name) throw new ProviderHubError('Foreign provider.');
        return persisted ? this.registry.resolve(name) : this.registry.preview(name, draft);
      },
      save: (requested, next) => {
        if (requested !== name || next.kind !== entry.kind) throw new ProviderHubError('Foreign provider.');
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
    try { mkdirSync(lock); } catch { throw new ProviderHubError('Another provider transaction is in progress. Retry after it completes.', 409); }
    try { this.refresh(); return work(); } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  private checkRevision(name: string, expected: unknown): void {
    if (typeof expected !== 'string' || expected !== this.revision(name))
      throw new ProviderHubError('Configuration changed in another page or bot. Reload before saving.', 409);
  }
  save(original: string | null, input: ConnectionSave, language: Language) {
    return this.locked(() => {
      const { name } = input;
      if (typeof name !== 'string') throw new ProviderHubError('Provider name is required.');
      const prior = original ? this.config.providers[original] : undefined;
      if (original && !prior) throw new ProviderHubError('Provider does not exist.', 404);
      if (original) this.checkRevision(original, input.expectedRevision);
      if (name !== original) {
        const problem = validateProviderName(name);
        if (problem) throw new ProviderHubError(problem);
        if (readdirSync(this.root).some(value => value.toLowerCase() === name.toLowerCase()))
          throw new ProviderHubError('Provider name or directory already exists.', 409);
      }
      if (!input.entry || typeof input.entry !== 'object') throw new ProviderHubError('Provider configuration is required.');
      if (prior && prior.kind !== input.entry.kind) throw new ProviderHubError('Provider module cannot be changed.');
      const module = this.modules.find(m => m.id === input.entry.kind);
      if (!module) throw new ProviderHubError('Provider module is unavailable.');
      const requested = structuredClone(input.entry);
      if (!requested.spec?.model) throw new ProviderHubError('Model is required.');
      if (input.secretValue !== undefined && (typeof input.secretValue !== 'string' || !input.secretValue || /\s/.test(input.secretValue)))
        throw new ProviderHubError('API Key must be nonempty and contain no whitespace.');
      if (input.secretValue && !requested.secret) requested.secret = 'CORTICO_PROVIDER_API_KEY';
      const entry = validateEntry(module, requested, language);
      const prefix = `providers.${name}.`;
      for (const group of this.groups(name, entry, language)) {
        const values = Object.fromEntries(Object.keys(group.schema.properties).filter(path => path.startsWith(prefix))
          .map(path => [path, getByPath(entry as unknown as Record<string, unknown>, path.slice(prefix.length))])
          .filter(([, value]) => value !== undefined));
        const result = coerceGroupValues(group, values, language);
        if ('error' in result) throw new ProviderHubError(result.error);
        for (const [path, value] of Object.entries(result.values)) setByPath(entry as unknown as Record<string, unknown>, path.slice(prefix.length), value);
      }
      validateEntry(module, entry, language);
      let copiedSecret: Buffer | null = null;
      let credentialSource = original;
      if (!original && input.copyFrom) {
        const source = this.config.providers[input.copyFrom.name];
        if (!source) throw new ProviderHubError('Copy source no longer exists.', 409);
        this.checkRevision(input.copyFrom.name, input.copyFrom.revision);
        if (source.secret === entry.secret) {
          credentialSource = input.copyFrom.name;
          const file = join(this.path(input.copyFrom.name), '.env');
          if (existsSync(file)) copiedSecret = readFileSync(file);
        }
      }
      if (entry.secret && !input.secretValue && (!credentialSource || this.settings.secretStatus(credentialSource, entry) === 'none'))
        throw new ProviderHubError('API Key is required.');
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
      if (!entry) throw new ProviderHubError('Provider does not exist.', 404);
      const readiness = this.readiness(name, entry, language);
      if (readiness.state !== 'ready') throw new ProviderHubError(readiness.reason ?? readiness.state);
      updateJsonObject(this.file, raw => { raw.activeProvider = name; });
      this.config.activeProvider = name;
    });
  }
  delete(name: string, revision: string): void {
    this.locked(() => {
      if (!this.config.providers[name]) throw new ProviderHubError('Provider does not exist.', 404);
      this.checkRevision(name, revision);
      const refs = this.references(name);
      if (this.config.activeProvider === name || refs.length)
        throw new ProviderHubError(`Provider is used by: ${refs.map(file => dirname(file).split(/[\\/]/).at(-1)).join(', ') || 'current bot'}`, 409);
      const tomb = join(this.root, `.deleted-${randomUUID()}`);
      renameSync(this.path(name), tomb);
      this.registry.invalidate(name);
      delete this.config.providers[name];
      rmSync(tomb, { recursive: true, force: true });
    });
  }
  async action(name: string, action: string, language: Language) {
    this.refresh();
    const entry = this.config.providers[name];
    if (!entry) throw new ProviderHubError('Provider does not exist.', 404);
    const source = this.settings.sources().find(source => source.id === `llm:${entry.kind}`);
    if (!source) throw new ProviderHubError('Provider module is unavailable.');
    return source.contribute(language).invoke!('settings', action === 'test' ? 'probe' : 'models', [{ name }]);
  }
}
