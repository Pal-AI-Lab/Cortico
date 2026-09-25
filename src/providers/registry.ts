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

interface ModulePolicy { enabled: (kind: string) => boolean; leases: Map<string, number>; registries: Set<ProviderRegistry> }

export class ProviderRegistry {
  private readonly instances = new Map<string, { key: string; value: ProviderInstance }>();
  private readonly resources = new Map<string, unknown>();
  constructor(
    private readonly entries: () => Record<string, LLMProviderEntry>,
    private readonly host: ProviderHostBase,
    private readonly modules: readonly ProviderModule[] = providerModules,
    /** Secrets read before the process environment and the endpoint `.env`; preview registries carry the typed, unsaved key here. */
    private readonly secretOverrides: Readonly<Record<string, string>> = {},
    private readonly policy: ModulePolicy = { enabled: () => true, leases: new Map(), registries: new Set() },
  ) { this.policy.registries.add(this); }

  setModulePolicy(enabled: (kind: string) => boolean): void { this.policy.enabled = enabled; }
  isModuleEnabled(kind: string): boolean { return this.policy.enabled(kind); }
  assertModuleEnabled(kind: string): void {
    if (!this.isModuleEnabled(kind)) throw new Error(`供应商模块未加载到本 Bot: ${kind}`);
  }
  async moduleTask<T>(kind: string, run: () => Promise<T>): Promise<T> {
    this.assertModuleEnabled(kind);
    this.policy.leases.set(kind, this.moduleUsage(kind) + 1);
    try { return await run(); } finally { this.policy.leases.set(kind, this.moduleUsage(kind) - 1); }
  }
  moduleUsage(kind: string): number { return this.policy.leases.get(kind) ?? 0; }
  async stopModule(kind: string): Promise<void> {
    if (this.moduleUsage(kind)) throw new Error(`供应商模块仍有绑定任务: ${kind}`);
    for (const registry of this.policy.registries) {
      for (const [name, instance] of registry.instances) {
        if (registry.entries()[name]?.kind !== kind) continue;
        await instance.value.stop?.();
        registry.instances.delete(name);
      }
      for (const key of registry.resources.keys()) if (JSON.parse(key)[0] === kind) registry.resources.delete(key);
    }
  }

  private module(kind: string): ProviderModule {
    this.assertModuleEnabled(kind);
    const module = this.modules.find((module) => module.id === kind);
    if (!module) throw new Error(`Unknown provider module: ${kind}`);
    return module;
  }

  /**
   * A registry over one detached entry. Its instances never enter the live cache; `secrets`
   * are the values the console holds but has not written to the endpoint's `.env`.
   */
  previewRegistry(name: string, entry: LLMProviderEntry, secrets: Readonly<Record<string, string>> = {}): ProviderRegistry {
    return new ProviderRegistry(() => ({ [name]: entry }), this.host, this.modules, secrets, this.policy);
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
    // 密钥在实例创建时定格,`.env` 的内容指纹进缓存键:文件变更后下一次解析重建实例。
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
    const originalRespond = value.client.respond.bind(value.client);
    value.client.respond = async (request, options) => {
      this.assertModuleEnabled(entry.kind);
      this.policy.leases.set(entry.kind, this.moduleUsage(entry.kind) + 1);
      try { return await originalRespond(request, options); }
      finally { this.policy.leases.set(entry.kind, this.moduleUsage(entry.kind) - 1); }
    };
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
    this.policy.leases.set(entry.kind, this.moduleUsage(entry.kind) + 1);
    let released = false;
    const client: ResponseClient = {
      release: () => { if (!released) { released = true; this.policy.leases.set(entry.kind, this.moduleUsage(entry.kind) - 1); } },
      bind: () => client,
      respond: (request, options) => {
        this.assertModuleEnabled(entry.kind);
        if (released) throw new Error("Provider binding has been released.");
        return instance.client.respond(request, {
          ...options,
          quote: (at) => quotePrices(entry, request, at, module.prices?.(entry, request, at) ?? []),
          origin: {
            instance: name,
            module: entry.kind,
            model: request.model ?? '',
            compatibilityDomain: domain(),
          },
        });
      },
    };
    return client;
  }

  /** Drop the cached instance so the next resolve rebuilds it; `host.resource` objects survive. */
  invalidate(name: string): void {
    this.instances.delete(name);
  }

  async start(name: string): Promise<unknown> {
    return this.resolve(name).start?.();
  }
  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.values()].map((instance) => instance.value.stop?.()));
    this.instances.clear(); this.resources.clear();
    this.policy.registries.delete(this);
  }
}
