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
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { updateJsonObject } from '../../config-file.ts';
import type { Language } from '../../core/language.ts';
import { isConnectionEditorBlock, type WebUiLamp, type WebUiPageContribution } from '../../web/shared/webui-protocol.ts';
import type { WebUiPageSource } from '../../web/webui-pages.ts';
import { providerModules, type ProviderRegistry } from '../registry.ts';
import type { ProviderAvailability, ProviderModule } from '../base.ts';
import { endpointAvailability, validateEntry } from '../configuration.ts';
import { GenerationError, type ResponseClient } from '../../core/generation.ts';
import { readTextFile } from '../../core/util.ts';
import { responseRequest } from '../../protocol/open-responses/context-helpers.ts';
import { record } from '../../protocol/open-responses/context.ts';
import { ResponseProtocolError } from '../../protocol/open-responses/stream.ts';
import { text } from './strings.ts';
import { PROBE_MAX_OUTPUT_TOKENS, type ProviderWebUiHost } from './types.ts';
import { connectionBlocks, connectionGroup } from './config.ts';

/** Where the OpenAI error code `unsupported_country_region_territory` sends the reader. */
const SUPPORTED_REGIONS_URL = 'https://developers.openai.com/api/docs/supported-countries';

export type SecretStatus = 'env' | 'file' | 'none';

/** 密钥变量名由操作员自由填写,也可能是直接写在磁盘上的任意名字,拼进正则前按字面转义。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** WebUI entry points receive the request language; callers that omit it use Chinese. */
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
        [connectionGroup(name, entry, language), ...(module.config?.(name, entry, language) ?? [])]
          .map((group) => ({ name, group })),
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
    this.persist(name, validateEntry(this.module(next.kind), next, language));
    return S.saved;
  }

  /** 端点配置写入共享目录；activeProvider 写入当前部署的 config.json。 */
  private persist(name: string, entry: LLMProviderEntry): void {
    const next = structuredClone(entry);
    updateJsonObject(this.file, (raw) => {
      raw.activeProvider = this.config.activeProvider;
      raw.providerSchemaVersion = 3;
    });
    const dir = join(this.providersDir, name);
    mkdirSync(dir, { recursive: true });
    updateJsonObject(join(dir, 'config.json'), (raw) => {
      for (const key of Object.keys(raw)) delete raw[key];
      for (const [key, value] of Object.entries(next)) raw[key] = value;
    });
    this.config.providers = { ...this.config.providers, [name]: next };
    this.config.providerSchemaVersion = 3;
    // 端点 .env 的内容按 provider 实例缓存。
    this.registry.invalidate(name);
  }

  save(name: string, entry: LLMProviderEntry, language: Language = 'zh'): void {
    const module = this.module(entry.kind);
    const prior = this.config.providers[name];
    if (prior && prior.kind !== entry.kind && this.modules.some((m) => m.id === prior.kind))
      throw new Error(text(language).kindChange);
    this.persist(name, validateEntry(module, entry, language));
  }

  /** 密钥值优先来自进程环境，其次为端点 .env；未配置变量名时没有来源。 */
  secretStatus(name: string, entry: LLMProviderEntry): SecretStatus {
    if (!entry.secret) return 'none';
    if (process.env[entry.secret]) return 'env';
    const file = join(this.providersDir, name, '.env');
    if (!existsSync(file)) return 'none';
    return new RegExp(`^[ \\t]*${escapeRegExp(entry.secret)}[ \\t]*=[ \\t]*\\S+`, 'm').test(readTextFile(file)) ? 'file' : 'none';
  }

  /** One streaming diagnostic request through `client`; the receipt carries status, latency, usage and charges, or the failure and a hint. */
  async probeClient(client: ResponseClient, spec: ModelSpec, language: Language) {
    const S = text(language);
    const request = {
      ...responseRequest(spec, [record({ type: 'message', role: 'user', content: 'ping' })]),
      max_output_tokens: Math.min(spec.maxTokens ?? PROBE_MAX_OUTPUT_TOKENS, PROBE_MAX_OUTPUT_TOKENS),
    };
    const started = Date.now();
    try {
      const generation = await client.respond(request, { diagnostic: true, nativeSpec: spec, role: 'probe', onEvent: () => {} });
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
      // A 2xx body that does not parse is an answer in another format; the GenerationError status stays 0.
      const cause = error instanceof GenerationError ? error.cause : undefined;
      const incompatible = cause instanceof ResponseProtocolError || cause instanceof SyntaxError;
      const hint = status === 404 ? S.probeNoResponses
        : status === 403 && error instanceof GenerationError && error.body.includes('unsupported_country_region_territory') ? S.probeRegion(SUPPORTED_REGIONS_URL)
        : status === 401 || status === 403 ? S.probeAuth
        : incompatible ? S.probeIncompatible
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
      contribute: (language) => this.modules.includes(module) ? this.contribute(module, language) : null,
    })) satisfies WebUiPageSource[];
  }

  /** 端点能不能用:通用条件由框架查,模块自己的条件由模块答。 */
  availability(name: string, language: Language = 'zh'): ProviderAvailability {
    const entry = this.config.providers[name];
    if (!entry) return { ready: false, reason: text(language).unknownInstance };
    return endpointAvailability(
      this.module(entry.kind),
      name,
      entry,
      this.secretStatus(name, entry) !== 'none',
      language,
    );
  }

  /**
   * 这批端点里有没有一个能用。灯亮=有;悬停说明给出第一个可用的端点名,
   * 或者最后一个端点的不可用原因。
   */
  private availableLamp(
    entries: ReadonlyArray<{ name: string }>,
    language: Language,
  ): WebUiLamp {
    const S = text(language);
    let reason = S.availableLampNone;
    for (const { name } of entries) {
      const state = this.availability(name, language);
      if (state.ready) {
        return { label: S.availableLamp, state: 'online', hint: S.availableLampReady(name) };
      }
      if (state.reason) reason = `${name}: ${state.reason}`;
    }
    return { label: S.availableLamp, state: 'offline', hint: reason };
  }

  /** 所有模块合起来有没有一个可用端点。WebUI 左栏「模型提供商」那一行点的就是它。 */
  providersLamp(language: Language = 'zh'): WebUiLamp {
    return this.availableLamp(
      this.modules.flatMap((module) => this.entries(module)),
      language,
    );
  }

  private contribute(module: ProviderModule, language: Language): WebUiPageContribution {
    const S = text(language);
    const entries = this.entries(module);
    const host: ProviderWebUiHost = {
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
    const extra = module.webUi?.(host) ?? {};
    // A module that places none of the editor's blocks gets the default order, its own sections between model and pricing.
    const declared = extra.panels ?? [];
    const blocks = connectionBlocks(language);
    const sections = declared.some((panel) => isConnectionEditorBlock(panel.builtin))
      ? declared
      : [blocks.endpoint, blocks.model, ...declared, blocks.pricing, blocks.protocol];
    return {
      ...extra,
      id: `llm:${module.id}`,
      kind: 'llm',
      label: module.localize?.(language)?.title ?? module.title,
      availability: 'active',
      lamps: [],
      badges: [{ label: S.instancesBadge, value: String(entries.length) }, ...(extra.badges ?? [])],
      panels: sections,
      config: extra.config ?? entries.flatMap(
        ({ name, entry }) => module.config?.(name, entry, language) ?? [],
      ),
      invoke: async (panel, method, args) => {
        this.module(module.id);
        if (!extra.invoke) throw new Error(S.unknownPanel);
        return extra.invoke(panel, method, args);
      },
    };
  }
}
