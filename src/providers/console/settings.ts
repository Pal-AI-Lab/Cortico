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
import { resolveLanguage, type Language } from '../../core/language.ts';
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

/** Probe budget: enough for a reasoning model to answer one word without an `incomplete` stop. */
const PROBE_MAX_OUTPUT_TOKENS = 256;

/** 密钥名拼入正则前统一转义,避免正则元字符被当作模式。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class ProviderSettings {
  /** Console language, resolved once from the deployment config and passed down as a value. */
  private readonly language: Language;
  constructor(
    private readonly config: CoreConfig,
    private readonly registry: ProviderRegistry,
    /** 这份部署的 config.json。现在只写"用哪个端点"这一个选择,不再写端点表。 */
    private readonly file: string,
    /** 全局端点表的根(`<部署根>/providers/`);端点的改动写进 `<它>/<端点名>/config.json`。 */
    private readonly providersDir: string,
    private readonly modules: readonly ProviderModule[] = providerModules,
  ) {
    this.language = resolveLanguage((config as { language?: unknown }).language);
    for (const [name, entry] of Object.entries(config.providers))
      config.providers[name] =
        this.modules
          .find((module) => module.id === entry.kind)
          ?.normalize?.(structuredClone(entry)) ?? entry;
  }

  private get text() {
    return text(this.language);
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
  private declaredGroups() {
    return this.modules.flatMap((module) =>
      this.entries(module).flatMap(({ name, entry }) =>
        (module.config?.(name, entry, this.language) ?? []).map((group) => ({ name, group })),
      ),
    );
  }
  groups(): ConfigGroup[] {
    return this.declaredGroups().map(({ group }) => group);
  }

  values(groupId: string): ConfigValues {
    const { name, group } = this.declaredGroups().find((value) => value.group.id === groupId)!;
    const prefix = `providers.${name}.`;
    return readGroupValues(this.config, group, (path) =>
      getByPath(
        this.config.providers[name] as unknown as Record<string, unknown>,
        path.slice(prefix.length),
      ),
    );
  }

  setConfig(groupId: string, values: ConfigValues): string {
    const declared = this.declaredGroups().find((value) => value.group.id === groupId);
    if (!declared) throw new Error(this.text.unknownGroup);
    const { name, group } = declared;
    const coerced = coerceGroupValues(group, values, this.language);
    if ('error' in coerced) throw new Error(coerced.error);
    const next = structuredClone(this.config.providers[name]);
    const prefix = `providers.${name}.`;
    for (const [path, value] of Object.entries(coerced.values)) {
      if (!path.startsWith(prefix)) throw new Error(this.text.groupOutOfScope);
      setByPath(next as unknown as Record<string, unknown>, path.slice(prefix.length), value);
    }
    this.persist(name, validateEntry(this.module(next.kind), next, this.language), this.config.activeProvider);
    return this.text.saved;
  }

  /**
   * 落一次盘。端点是**全局**的,写 `<providers>/<端点名>/config.json`;
   * `activeProvider`(这份部署用哪个端点)是这份部署自己的选择,仍写它的 config.json。
   */
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
  }

  save(name: string, entry: LLMProviderEntry): void {
    const module = this.module(entry.kind);
    const prior = this.config.providers[name];
    if (prior && prior.kind !== entry.kind && this.modules.some((m) => m.id === prior.kind))
      throw new Error(this.text.kindChange);
    this.persist(name, validateEntry(module, entry, this.language), this.config.activeProvider);
  }

  /**
   * 把某个实例设为当前端点。模型档整组归 Provider,所以启用的前提就是它自己
   * 有一份 —— 框架没有"Persona那份 baseline"可以拿来兜底了。
   */
  activate(name: string, spec?: ModelSpec): void {
    const entry = this.config.providers[name];
    if (!entry) throw new Error(this.text.unknownInstance);
    const requested = { ...entry, ...(spec ? { spec } : {}) };
    if (!requested.spec) throw new Error(this.text.specRequired);
    const next = validateEntry(this.module(entry.kind), requested, this.language);
    this.persist(name, next, name);
  }

  /** 删端点:它的目录整个走(config.json、密钥文件都归它)。当前端点不能删。 */
  delete(name: string): void {
    if (!this.config.providers[name]) throw new Error(this.text.unknownInstance);
    if (name === this.config.activeProvider) throw new Error(this.text.deleteActive);
    this.registry.invalidate(name);
    const { [name]: _dropped, ...rest } = this.config.providers;
    this.config.providers = rest;
    rmSync(join(this.providersDir, name), { recursive: true, force: true });
  }

  /** 密钥值的来源:进程环境 > 端点目录的 `.env`;没有变量名就谈不上来源。 */
  secretStatus(name: string, entry: LLMProviderEntry): SecretStatus {
    if (!entry.secret) return 'none';
    if (process.env[entry.secret]) return 'env';
    const file = join(this.providersDir, name, '.env');
    if (!existsSync(file)) return 'none';
    return new RegExp(`^\\s*${escapeRegExp(entry.secret)}\\s*=\\s*\\S+`, 'm').test(readFileSync(file, 'utf8')) ? 'file' : 'none';
  }

  /** 把密钥值写进端点目录的 `.env`(同名行覆盖),并让实例重建以读到它。 */
  setSecret(name: string, value: string): SecretStatus {
    const entry = this.config.providers[name];
    if (!entry) throw new Error(this.text.unknownInstance);
    if (!entry.secret) throw new Error(this.text.secretNameRequired);
    if (!value.trim() || /\s/.test(value)) throw new Error(this.text.secretValueInvalid);
    const dir = join(this.providersDir, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '.env');
    const line = `${entry.secret}=${value.trim()}`;
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const pattern = new RegExp(`^\\s*${escapeRegExp(entry.secret)}\\s*=.*$`, 'm');
    const next = pattern.test(current)
      ? current.replace(pattern, line)
      : current + (current && !current.endsWith('\n') ? '\n' : '') + line + '\n';
    writeFileSync(file, next, 'utf8');
    this.registry.invalidate(name);
    return this.secretStatus(name, entry);
  }

  private assertNewName(name: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error(this.text.nameFormat);
    const existing = this.config.providers[name];
    // 一个没有模块认领的旧条目(被删掉的 kind)可以被同名新建覆盖;它的目录与密钥文件留用。
    if (existing && this.modules.some((module) => module.id === existing.kind)) throw new Error(this.text.nameTaken);
  }

  /** 端点目录里除 `config.json` 外还有什么(密钥、授权状态),删前给操作者看。 */
  private directoryExtras(name: string): string[] {
    const dir = join(this.providersDir, name);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((file) => file !== 'config.json');
  }

  private async probe(name: string) {
    const S = this.text;
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
      contribute: () => this.contribute(module),
    })) satisfies ConsolePageSource[];
  }

  private contribute(module: ProviderModule): ConsolePageContribution {
    const S = this.text;
    const entries = this.entries(module);
    const host: ProviderConsoleHost = {
      language: this.language,
      entries: () => this.entries(module),
      instance: (name) => {
        if (!this.entries(module).some((value) => value.name === name))
          throw new Error(S.foreignInstance);
        return this.registry.resolve(name);
      },
      save: (name, entry) => {
        if (entry.kind !== module.id) throw new Error(S.foreignInstance);
        this.save(name, entry);
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
          // 端点表每一页长得一样,界面归控制台核心;这里只出数据面(下面的 invoke)。
          builtin: 'llm-settings',
        },
        ...(extra.panels ?? []),
      ],
      config: entries.flatMap(
        ({ name, entry }) => module.config?.(name, entry, this.language) ?? [],
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
          const localized = module.localize?.(this.language) ?? {};
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
          this.assertNewName(name);
          this.save(name, {
            kind: module.id,
            baseUrl: String(body.baseUrl || module.defaultBaseUrl || ''),
            pricing: defaultPricing(),
          });
          return { ok: true };
        }
        const entry = this.config.providers[name];
        if (!entry || entry.kind !== module.id) throw new Error(S.foreignInstance);
        if (method === 'activate') this.activate(name, body.spec as ModelSpec | undefined);
        else if (method === 'save') {
          if (!body.spec || typeof body.spec !== 'object' || Array.isArray(body.spec))
            throw new Error(S.specRequired);
          const next: LLMProviderEntry = {
            ...entry,
            spec: body.spec as ModelSpec,
            pricing: validatePrices(body.pricing, this.language),
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
          this.save(name, next);
        } else if (method === 'delete') {
          this.delete(name);
        } else if (method === 'duplicate') {
          if (typeof body.as !== 'string') throw new Error(S.nameRequired);
          this.assertNewName(body.as);
          this.save(body.as, structuredClone(entry));
        } else if (method === 'setSecret') {
          if (typeof body.value !== 'string') throw new Error(S.secretValueInvalid);
          return { secretConfigured: this.setSecret(name, body.value) };
        } else if (method === 'models') {
          const instance = this.registry.resolve(name);
          if (!instance.listModels) throw new Error(S.modelsUnsupported);
          return { models: await instance.listModels() };
        } else if (method === 'probe') {
          return this.probe(name);
        } else if (method === 'extras') {
          return { files: this.directoryExtras(name) };
        } else throw new Error(S.unknownMethod);
        return { ok: true };
      },
    };
  }
}
