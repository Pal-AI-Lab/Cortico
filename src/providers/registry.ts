import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import type { LLMProviderEntry } from '../core/types.ts';
import type { ProviderHostBase, ProviderInstance, ProviderModule } from './base.ts';
import { quotePrices } from './pricebook.ts';
import { createHash } from 'node:crypto';
import { secretReader } from '../core/secrets.ts';
import type { ResponseClient } from '../core/generation.ts';

/** Modules are discovered from providers/<module>/index.ts. */
export async function discoverProviderModules(
  root = fileURLToPath(new URL('.', import.meta.url)),
): Promise<ProviderModule[]> {
  const modules: ProviderModule[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!dir.isDirectory()) continue;
    const entry = join(root, dir.name, 'index.ts');
    if (!existsSync(entry)) continue;
    const module = (await import(pathToFileURL(entry).href)).default as ProviderModule;
    if (module.id !== dir.name)
      throw new Error(`Provider module ID must match directory: ${dir.name}`);
    modules.push(module);
  }
  return modules;
}

export const providerModules = await discoverProviderModules();
const byId = new Map(providerModules.map((module) => [module.id, module]));

/**
 * 追加扩展带来的 provider 模块。就地改这一个数组,不换引用:`ProviderRegistry` 与
 * `ProviderSettings` 的默认参数引用的就是它,而两者都在启动器注册完之后才构造。
 * id 撞车直接抛:一个 kind 对应哪份实现不能有歧义。
 */
export function registerProviderModules(extra: readonly ProviderModule[]): void {
  for (const module of extra) {
    if (byId.has(module.id)) throw new Error(`Provider module id 已被占用: ${module.id}`);
    byId.set(module.id, module);
    providerModules.push(module);
  }
}

export function providerModule(kind: string): ProviderModule {
  const module = byId.get(kind);
  if (!module) throw new Error(`Unknown provider module: ${kind}`);
  return module;
}

export class ProviderRegistry {
  private readonly instances = new Map<string, { key: string; value: ProviderInstance }>();
  private readonly resources = new Map<string, unknown>();
  constructor(
    private readonly entries: () => Record<string, LLMProviderEntry>,
    private readonly host: ProviderHostBase,
    private readonly modules: readonly ProviderModule[] = providerModules,
    /** Secrets read before the process environment and the endpoint `.env`; preview registries carry the typed, unsaved key here. */
    private readonly secretOverrides: Readonly<Record<string, string>> = {},
  ) {}

  private module(kind: string): ProviderModule {
    const module = this.modules.find((module) => module.id === kind);
    if (!module) throw new Error(`Unknown provider module: ${kind}`);
    return module;
  }

  /**
   * A registry over one detached entry. Its instances never enter the live cache; `secrets`
   * are the values the console holds but has not written to the endpoint's `.env`.
   */
  previewRegistry(name: string, entry: LLMProviderEntry, secrets: Readonly<Record<string, string>> = {}): ProviderRegistry {
    return new ProviderRegistry(() => ({ [name]: entry }), this.host, this.modules, secrets);
  }

  preview(name: string, entry: LLMProviderEntry): ProviderInstance {
    return this.previewRegistry(name, entry).resolve(name);
  }

  resolve(name: string): ProviderInstance {
    const raw = this.entries()[name];
    if (!raw) throw new Error(`没有这个 LLM provider: ${name}`);
    const module = this.module(raw.kind);
    const entry = module.normalize?.(structuredClone(raw)) ?? structuredClone(raw);
    const { pricing: _pricing, spec: _spec, ...transportEntry } = entry;
    // 密钥在实例创建时定格,`.env` 的内容指纹进缓存键:文件变更后下一次解析重建实例,
    // 手工改写或另一进程的控制台写入不需要本进程先 invalidate。
    const stateDir = join(this.host.stateRoot, name);
    const envFile = join(stateDir, '.env');
    const fingerprint = existsSync(envFile) ? createHash('sha256').update(readFileSync(envFile)).digest('hex') : '';
    const key = JSON.stringify([transportEntry, fingerprint]);
    const previous = this.instances.get(name);
    if (previous?.key === key) return previous.value;
    // 按端点名分岔的两样在这里填:模块自己的目录,与只读那个目录的密钥链。
    const { stateRoot: _stateRoot, ...base } = this.host;
    const stored = secretReader(envFile);
    const value = module.create(name, entry, {
      ...base,
      stateDir,
      secret: (key) => this.secretOverrides[key] ?? stored(key),
      currentEntry: () =>
        module.normalize?.(structuredClone(this.entries()[name])) ?? this.entries()[name],
      resource: <T>(resource: string, create: () => T): T => {
        const id = JSON.stringify([module.id, name, resource]);
        if (!this.resources.has(id)) this.resources.set(id, create());
        return this.resources.get(id) as T;
      },
    });
    this.instances.set(name, { key, value });
    return value;
  }

  bind(name: string): ResponseClient {
    const raw = this.entries()[name];
    if (!raw) throw new Error(`没有这个 LLM provider: ${name}`);
    const module = this.module(raw.kind);
    const entry = module.normalize?.(structuredClone(raw)) ?? structuredClone(raw);
    const instance = this.resolve(name);
    const domain = () =>
      createHash('sha256')
        .update(JSON.stringify([entry.kind, entry.baseUrl, instance.compatibilityKey?.() ?? null]))
        .digest('hex');
    const client: ResponseClient = {
      bind: () => client,
      respond: (request, options) =>
        instance.client.respond(request, {
          ...options,
          quote: (at) => quotePrices(entry, request, at, module.prices?.(entry, request, at) ?? []),
          origin: {
            instance: name,
            module: entry.kind,
            model: request.model ?? '',
            compatibilityDomain: domain(),
          },
        }),
    };
    return client;
  }

  /**
   * Drop the cached instance so the next resolve rebuilds it; `host.resource` objects
   * survive. Secrets are read once per instance, so a key written to the endpoint's `.env`
   * takes effect only through this.
   */
  invalidate(name: string): void {
    this.instances.delete(name);
  }

  async start(name: string): Promise<unknown> {
    return this.resolve(name).start?.();
  }
  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.values()].map((instance) => instance.value.stop?.()));
  }
}
