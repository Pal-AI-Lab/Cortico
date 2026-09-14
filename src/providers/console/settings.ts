import type {
  CoreConfig,
  LLMProviderEntry,
  ModelSpec,
  ConfigGroup,
  ConfigValues,
} from '../../core/types.ts';
import {
  coerceGroupValues,
  getByPath,
  readGroupValues,
  setByPath,
} from '../../core/config-schema.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateJsonObject } from '../../config-file.ts';
import type { Language } from '../../core/language.ts';
import type { ConsolePageContribution } from '../../web/shared/console-protocol.ts';
import type { ConsolePageSource } from '../../web/console-pages.ts';
import { providerModules, type ProviderRegistry } from '../registry.ts';
import type { ProviderModule } from '../base.ts';
import { validateEntry } from '../configuration.ts';
import { quotePrices, validatePrices, type PriceDefinition } from '../pricebook.ts';
import { GenerationError } from '../../core/generation.ts';
import { responseRequest } from '../../protocol/open-responses/context-helpers.ts';
import { record } from '../../protocol/open-responses/context.ts';
import { text } from './strings.ts';
import type { ProviderConsoleHost } from './types.ts';

export type SecretStatus = 'env' | 'file' | 'none';

/** A console-created instance starts explicitly free in USD; the operator fills the real rates. */
export function defaultPricing(): PriceDefinition[] {
  return [{
    models: ['*'],
    currency: 'USD',
    basis: 'marginal',
    source: 'console',
    rules: [
      { meter: 'cachedInput', perMillion: 0 },
      { meter: 'uncachedInput', perMillion: 0 },
      { meter: 'output', perMillion: 0 },
    ],
  }];
}

/** Output token limit used by the connectivity probe. */
const PROBE_MAX_OUTPUT_TOKENS = 256;

/** Console entry points receive the request language; callers that omit it use Chinese. */
export class ProviderSettings {
  constructor(
    private readonly config: CoreConfig,
    private readonly registry: ProviderRegistry,
    /** 当前部署的 config.json，用于保存 activeProvider。 */
    private readonly file: string,
    /** 共享端点目录，配置写入各端点的 config.json。 */
    private readonly providersDir: string,
    private readonly modules: readonly ProviderModule[] = providerModules,
  ) {
    for (const [name, entry] of Object.entries(config.providers))
      config.providers[name] =
        this.modules
          .find((module) => module.id === entry.kind)
          ?.normalize?.(structuredClone(entry)) ?? entry;
  }

  private module(kind: string): ProviderModule {
    const module = this.modules.find((module) => module.id === kind);
    if (!module) throw new Error(`Unknown provider module: ${kind}`);
    return module;
  }

  private entries(module: ProviderModule) {
    return Object.entries(this.config.providers)
      .filter(([, entry]) => entry.kind === module.id)
      .map(([name, entry]) => ({ name, entry }));
  }
  private declaredGroups(language: Language) {
    return this.modules.flatMap((module) =>
      this.entries(module).flatMap(({ name, entry }) =>
        (module.config?.(name, entry, language) ?? []).map((group) => ({ name, group })),
      ),
    );
  }
  groups(language: Language = 'zh'): ConfigGroup[] {
    return this.declaredGroups(language).map(({ group }) => group);
  }

  values(groupId: string, language: Language = 'zh'): ConfigValues {
    const { name, group } = this.declaredGroups(language).find((value) => value.group.id === groupId)!;
    const prefix = `providers.${name}.`;
    return readGroupValues(this.config, group, (path) =>
      getByPath(
        this.config.providers[name] as unknown as Record<string, unknown>,
        path.slice(prefix.length),
      ),
    );
  }

  setConfig(groupId: string, values: ConfigValues, language: Language = 'zh'): string {
    const S = text(language);
    const declared = this.declaredGroups(language).find((value) => value.group.id === groupId);
    if (!declared) throw new Error(S.unknownGroup);
    const { name, group } = declared;
    const coerced = coerceGroupValues(group, values, language);
    if ('error' in coerced) throw new Error(coerced.error);
    const next = structuredClone(this.config.providers[name]);
    const prefix = `providers.${name}.`;
    for (const [path, value] of Object.entries(coerced.values)) {
      if (!path.startsWith(prefix)) throw new Error(S.groupOutOfScope);
      setByPath(next as unknown as Record<string, unknown>, path.slice(prefix.length), value);
    }
    this.persist(name, validateEntry(this.module(next.kind), next, language), this.config.activeProvider);
    return S.saved;
  }

  /** 端点配置写入共享目录；activeProvider 写入当前部署的 config.json。 */
  private persist(name: string, entry: LLMProviderEntry, activeProvider: string): void {
    const next = structuredClone(entry);
    updateJsonObject(this.file, (raw) => {
      raw.activeProvider = activeProvider;
      raw.providerSchemaVersion = 3;
    });
    const dir = join(this.providersDir, name);
    mkdirSync(dir, { recursive: true });
    updateJsonObject(join(dir, 'config.json'), (raw) => {
      for (const key of Object.keys(raw)) delete raw[key];
      for (const [key, value] of Object.entries(next)) raw[key] = value;
    });
    this.config.providers = { ...this.config.providers, [name]: next };
    this.config.activeProvider = activeProvider;
    this.config.providerSchemaVersion = 3;
    // 端点 .env 的内容按 provider 实例缓存。
    this.registry.invalidate(name);
  }

  save(name: string, entry: LLMProviderEntry, language: Language = 'zh'): void {
    const module = this.module(entry.kind);
    const prior = this.config.providers[name];
    if (prior && prior.kind !== entry.kind && this.modules.some((m) => m.id === prior.kind))
      throw new Error(text(language).kindChange);
    this.persist(name, validateEntry(module, entry, language), this.config.activeProvider);
  }

  /** 设为当前端点前，要求端点具有有效的模型配置。 */
  activate(name: string, spec?: ModelSpec, language: Language = 'zh'): void {
    const S = text(language);
    const entry = this.config.providers[name];
    if (!entry) throw new Error(S.unknownInstance);
    const requested = { ...entry, ...(spec ? { spec } : {}) };
    if (!requested.spec) throw new Error(S.specRequired);
    const next = validateEntry(this.module(entry.kind), requested, language);
    this.persist(name, next, name);
  }

  /** 删除端点及其整个目录；当前活跃端点不能删除。 */
  delete(name: string, language: Language = 'zh'): void {
    const S = text(language);
    if (!this.config.providers[name]) throw new Error(S.unknownInstance);
    if (name === this.config.activeProvider) throw new Error(S.deleteActive);
    this.registry.invalidate(name);
    const { [name]: _dropped, ...rest } = this.config.providers;
    this.config.providers = rest;
    rmSync(join(this.providersDir, name), { recursive: true, force: true });
  }

  /** 密钥值优先来自进程环境，其次为端点 .env；未配置变量名时没有来源。 */
  secretStatus(name: string, entry: LLMProviderEntry): SecretStatus {
    if (!entry.secret) return 'none';
    if (process.env[entry.secret]) return 'env';
    const file = join(this.providersDir, name, '.env');
    if (!existsSync(file)) return 'none';
    return new RegExp(`^\\s*${entry.secret}\\s*=\\s*\\S+`, 'm').test(readFileSync(file, 'utf8')) ? 'file' : 'none';
  }

  /** 把密钥值写进端点目录的 `.env`(同名行覆盖),并让实例重建以读到它。 */
  setSecret(name: string, value: string, language: Language = 'zh'): SecretStatus {
    const S = text(language);
    const entry = this.config.providers[name];
    if (!entry) throw new Error(S.unknownInstance);
    if (!entry.secret) throw new Error(S.secretNameRequired);
    if (!value.trim() || /\s/.test(value)) throw new Error(S.secretValueInvalid);
    const dir = join(this.providersDir, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '.env');
    const line = `${entry.secret}=${value.trim()}`;
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const pattern = new RegExp(`^\\s*${entry.secret}\\s*=.*$`, 'm');
    const next = pattern.test(current)
      ? current.replace(pattern, line)
      : current + (current && !current.endsWith('\n') ? '\n' : '') + line + '\n';
    writeFileSync(file, next, 'utf8');
    this.registry.invalidate(name);
    return this.secretStatus(name, entry);
  }

  private assertNewName(name: string, language: Language): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error(text(language).nameFormat);
    const existing = this.config.providers[name];
    // kind 未注册的条目可被同名新端点覆盖，沿用现有目录和密钥。
    if (existing && this.modules.some((module) => module.id === existing.kind)) throw new Error(text(language).nameTaken);
  }

  /** 端点目录里除 `config.json` 外还有什么(密钥、授权状态),删前给操作者看。 */
  private directoryExtras(name: string): string[] {
    const dir = join(this.providersDir, name);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((file) => file !== 'config.json');
  }

  private async probe(name: string, language: Language) {
    const S = text(language);
    const entry = this.config.providers[name];
    if (!entry) throw new Error(S.unknownInstance);
    if (!entry.spec) throw new Error(S.specRequired);
    const request = {
      ...responseRequest(entry.spec, [record({ type: 'message', role: 'user', content: 'ping' })]),
      max_output_tokens: Math.min(entry.spec.maxTokens ?? PROBE_MAX_OUTPUT_TOKENS, PROBE_MAX_OUTPUT_TOKENS),
    };
    const started = Date.now();
    try {
      const generation = await this.registry.bind(name).respond(request, { diagnostic: true, nativeSpec: entry.spec, role: 'probe' });
      const attempt = generation.attempts.at(-1);
      return {
        ok: true,
        status: attempt?.status ?? null,
        elapsedMs: attempt?.elapsedMs ?? Date.now() - started,
        model: generation.response.model,
        usage: attempt ? {
          input: attempt.meters.input, cachedInput: attempt.meters.cachedInput,
          output: attempt.meters.output, reasoning: attempt.meters.reasoning,
        } : undefined,
        encryptedReasoning: generation.response.output.some((item) => item.type === 'reasoning' && Boolean(item.encrypted_content)),
        charges: (attempt?.charges ?? []).map((charge) => ({ currency: charge.quote.currency, amount: charge.amount })),
      };
    } catch (error) {
      const status = error instanceof GenerationError ? error.status : null;
      const hint = status === 404 ? S.probeNoResponses
        : status === 401 || status === 403 ? S.probeAuth
        : status === 0 || status === null ? S.probeUnreachable
        : undefined;
      return {
        ok: false,
        status,
        elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        ...(hint ? { hint } : {}),
      };
    }
  }

  sources() {
    return this.modules.map((module) => ({
      id: `llm:${module.id}`,
      contribute: (language) => this.contribute(module, language),
    })) satisfies ConsolePageSource[];
  }

  private contribute(module: ProviderModule, language: Language): ConsolePageContribution {
    const S = text(language);
    const entries = this.entries(module);
    const host: ProviderConsoleHost = {
      language,
      entries: () => this.entries(module),
      instance: (name) => {
        if (!this.entries(module).some((value) => value.name === name))
          throw new Error(S.foreignInstance);
        return this.registry.resolve(name);
      },
      save: (name, entry) => {
        if (entry.kind !== module.id) throw new Error(S.foreignInstance);
        this.save(name, entry, language);
      },
    };
    const extra = module.console?.(host) ?? {};
    return {
      ...extra,
      id: `llm:${module.id}`,
      kind: 'llm',
      label: module.title,
      availability: 'active',
      lamps: [
        {
          label: S.activeInstanceLamp,
          state: entries.some((value) => value.name === this.config.activeProvider)
            ? 'online'
            : 'offline',
        },
        ...(extra.lamps ?? []),
      ],
      badges: [{ label: S.instancesBadge, value: String(entries.length) }, ...(extra.badges ?? [])],
      panels: [
        {
          id: 'settings',
          title: S.settingsPanel,
          description: S.settingsPanelDescription,
          getMethods: ['state'],
          // 使用控制台内建端点面板，操作由下方 invoke 提供。
          builtin: 'llm-settings',
        },
        ...(extra.panels ?? []),
      ],
      config: entries.flatMap(
        ({ name, entry }) => module.config?.(name, entry, language) ?? [],
      ),
      invoke: async (panel, method, args) => {
        if (panel !== 'settings') {
          if (!extra.invoke) throw new Error(S.unknownPanel);
          return extra.invoke(panel, method, args);
        }
        const at = {
          startedAt: new Date().toISOString(),
          requestedServiceTier: null as string | null,
        };
        if (method === 'state') {
          const localized = module.localize?.(language) ?? {};
          return {
            active: this.config.activeProvider,
            reasoningTiers: localized.reasoningTiers ?? module.reasoningTiers,
            serviceTiers: localized.serviceTiers ?? module.serviceTiers,
            temperatureNote: localized.temperatureNote ?? module.temperatureNote,
            baseUrlSuggestions: module.baseUrlSuggestions ?? [],
            effortSuggestions: module.reasoningTiers.length ? [] : module.effortSuggestions ?? [],
            instances: this.entries(module).map(({ name, entry }) => ({
              name,
              entry,
              secretConfigured: this.secretStatus(name, entry),
              quotes: (entry.spec ? [entry.spec] : []).map((spec) => ({
                model: spec.model,
                quotes: quotePrices(
                  entry,
                  { model: spec.model },
                  { ...at, requestedServiceTier: entry.serviceTier ?? null },
                  module.prices?.(
                    entry,
                    { model: spec.model },
                    { ...at, requestedServiceTier: entry.serviceTier ?? null },
                  ) ?? [],
                ),
              })),
            })),
          };
        }
        const [raw] = args;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw new Error(S.bodyRequired);
        const body = raw as Record<string, unknown>;
        if (typeof body.name !== 'string') throw new Error(S.nameRequired);
        const name = body.name;
        if (method === 'create') {
          this.assertNewName(name, language);
          this.save(name, {
            kind: module.id,
            baseUrl: String(body.baseUrl || module.defaultBaseUrl || ''),
            pricing: defaultPricing(),
          }, language);
          return { ok: true };
        }
        const entry = this.config.providers[name];
        if (!entry || entry.kind !== module.id) throw new Error(S.foreignInstance);
        if (method === 'activate') this.activate(name, body.spec as ModelSpec | undefined, language);
        else if (method === 'save') {
          if (!body.spec || typeof body.spec !== 'object' || Array.isArray(body.spec))
            throw new Error(S.specRequired);
          const next: LLMProviderEntry = {
            ...entry,
            spec: body.spec as ModelSpec,
            pricing: validatePrices(body.pricing, language),
            serviceTier: typeof body.serviceTier === 'string' ? body.serviceTier : entry.serviceTier,
          };
          if (typeof body.baseUrl === 'string') next.baseUrl = body.baseUrl.trim();
          if (typeof body.secret === 'string') {
            if (body.secret.trim()) next.secret = body.secret.trim();
            else delete next.secret;
          }
          if (typeof body.multimodal === 'boolean') next.multimodal = body.multimodal;
          if (body.options !== undefined) {
            if (!body.options || typeof body.options !== 'object' || Array.isArray(body.options))
              throw new Error(S.optionsObject);
            next.options = body.options as Record<string, unknown>;
          }
          this.save(name, next, language);
        } else if (method === 'delete') {
          this.delete(name, language);
        } else if (method === 'duplicate') {
          if (typeof body.as !== 'string') throw new Error(S.nameRequired);
          this.assertNewName(body.as, language);
          this.save(body.as, structuredClone(entry), language);
        } else if (method === 'setSecret') {
          if (typeof body.value !== 'string') throw new Error(S.secretValueInvalid);
          return { secretConfigured: this.setSecret(name, body.value, language) };
        } else if (method === 'models') {
          const instance = this.registry.resolve(name);
          if (!instance.listModels) throw new Error(S.modelsUnsupported);
          return { models: await instance.listModels() };
        } else if (method === 'probe') {
          return this.probe(name, language);
        } else if (method === 'extras') {
          return { files: this.directoryExtras(name) };
        } else throw new Error(S.unknownMethod);
        return { ok: true };
      },
    };
  }
}
