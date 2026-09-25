/**
 * 按 WorldDefinition 构造实例，依据 worlds.<id>.enabled 挂载，并提供运行时激活、停用和重启。
 * 挂载状态与启动状态分开，实际启动由 Core 管理。定义实例在停用和重启时重新构造；
 * 预建实例重启时复用原对象。名称、标签与缺失原因来自定义或 bot 声明。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreConfig, World, WorldLifecycleEvent } from './core/types.ts';
import type { LoadedConfig } from './core/config.ts';
import type { BotDefinition } from './bot.ts';
import { updateJsonObject } from './config-file.ts';
import { pick, type Language } from './core/language.ts';

/** 装配层给控制台的回执与拒绝理由,按发起请求的界面语言取。 */
const ASSEMBLY_TEXT = {
  zh: {
    constructFailed: (detail: string) => `构造失败: ${detail}`,
    notImplemented: '本地没有找到这个 World 的实现。',
    unknownWorld: (id: string) => `未知 World: ${id}`,
    alreadyRunning: (label: string) => `${label} 已启用`,
    prebuilt: (label: string) => `${label} 是预建实例,不经装配层激活`,
    activated: (label: string, id: string) => `${label}（${id}）已启用`,
    deactivated: (label: string, id: string) => `${label}（${id}）已停用`,
    notActive: (label: string) => `${label} 未激活,没有可重启的实例`,
    restarted: (label: string) => `${label} 已重启`,
    toolClash: (other: string, names: string[]) => `工具名与 ${other} 撞名,拒绝挂载: ${names.join(', ')}`,
    toolReserved: (names: string[]) => `工具名已被 Core 或 Persona 占用,拒绝挂载: ${names.join(', ')}`,
    unbound: '装配层尚未绑定 core',
  },
  en: {
    constructFailed: (detail: string) => `Construction failed: ${detail}`,
    notImplemented: 'No implementation of this World was found locally.',
    unknownWorld: (id: string) => `Unknown World: ${id}`,
    alreadyRunning: (label: string) => `${label} is already enabled`,
    prebuilt: (label: string) => `${label} is a prebuilt instance and is not activated through assembly`,
    activated: (label: string, id: string) => `${label} (${id}) enabled`,
    deactivated: (label: string, id: string) => `${label} (${id}) disabled`,
    notActive: (label: string) => `${label} is not active, so there is no instance to restart`,
    restarted: (label: string) => `${label} restarted`,
    toolClash: (other: string, names: string[]) => `Tool names clash with ${other}, refusing to mount: ${names.join(', ')}`,
    toolReserved: (names: string[]) => `Tool names are taken by Core or the Persona, refusing to mount: ${names.join(', ')}`,
    unbound: 'The assembly layer is not bound to a core yet',
  },
};
const text = (language: Language) => pick(language, ASSEMBLY_TEXT);

/** 每个 World 配置段的最小形状。 */
export interface WorldSection {
  enabled: boolean;
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** 装配层提供给 World 构造函数的上下文。 */
export interface WorldContext<S extends WorldSection = WorldSection> {
  readonly id: string;
  /** worlds.<id> 的共享引用；每次读取的配置立即生效，构造时保存的值需重启实例。 */
  readonly cfg: S;
  readonly timezone: string;
  readonly botName: string;
  /** 部署目录，保存本机配置、密钥和部署资产覆盖。 */
  readonly botDir: string;
  /** bot 代码包目录，供包内模板与资产使用，可由多个部署共享。 */
  readonly packageDir: string;
  readonly dataDir: string;
  readonly repoRoot: string;
  secret(name: string): string;
  /** 将密钥写入部署 .env，并更新进程环境供 secret() 立即读取。 */
  storeSecret(name: string, value: string): void;
  /** 深合并进 `worlds.<id>` 段:活对象与 config.json 同步。数组整体替换。 */
  persist(patch: DeepPartial<S>): void;
  /** 按 cfg.enabled 同步状态：启用时激活或重启，禁用时停止。 */
  restart(): Promise<void>;
}

export interface WorldDefinition<S extends WorldSection = WorldSection> {
  id: string;
  label: string;
  /** World 配置默认值，每次返回新对象；enabled=false，由 bot 声明或部署配置启用。 */
  defaults(): S;
  /** 激活前置检查。抛错 = 不能激活,错误信息原样给操作者。 */
  preflight?(ctx: WorldContext<S>): void;
  /**
   * 返回 x-options 的完整选项表，包含按请求语言生成的固定项。
   * 未知 kind 返回空数组，框架继续查询其他 World；当前值不在表中时由控制台补入。
   * Persona 的选项由 Bot ConsoleContribution 提供。
   */
  configOptions?(kind: string, language: Language): Array<{ value: string; label: string }>;
  create(ctx: WorldContext<S>): World;
}

/**
 * bot 默认使用的 World 声明。字符串是 World id；对象还可提供标签与缺失原因。
 * 两种声明均允许本地缺少实现。
 */
export type WorldDeclaration = string | { id: string; label: string; reason?: string };

/** 各 World 的默认配置段；已声明的 id 默认启用。 */
export function worldDefaults(
  definitions: readonly WorldDefinition<WorldSection>[],
  declares: readonly WorldDeclaration[],
  overrides: Record<string, Record<string, unknown>> = {},
): Record<string, WorldSection> {
  const declared = new Set(declares.map((d) => (typeof d === 'string' ? d : d.id)));
  const worlds: Record<string, WorldSection> = {};
  for (const def of definitions) {
    worlds[def.id] = { ...def.defaults(), enabled: declared.has(def.id), ...(overrides[def.id] ?? {}) };
  }
  return worlds;
}

/**
 * 将可用 World 定义加入 bot。对 defaults() 中缺失的 World 段补充默认值，
 * 已声明的 id 默认启用，其余默认关闭；已有配置段保持原样。
 */
export function withWorlds<C extends CoreConfig>(
  definition: BotDefinition<C>,
  definitions: readonly WorldDefinition<WorldSection>[],
): BotDefinition<C> {
  const declared = new Set((definition.declares ?? []).map((d) => (typeof d === 'string' ? d : d.id)));
  return {
    ...definition,
    worlds: definitions,
    defaults: () => {
      const config = definition.defaults();
      const worlds = ((config as unknown as { worlds?: Record<string, WorldSection> }).worlds ??= {});
      for (const def of definitions) worlds[def.id] ??= { ...def.defaults(), enabled: declared.has(def.id) };
      return config;
    },
  };
}

export interface WorldSlot {
  readonly id: string;
  readonly label: string;
  /** bot 声明过的渠道;false = 部署侧选配。 */
  readonly declared: boolean;
  /** null = 预建实例(不能重建,只能停/起)。 */
  readonly definition: WorldDefinition<WorldSection> | null;
  instance: World;
  mounted: boolean;
}

export interface MissingWorld {
  readonly id: string;
  readonly label: string;
  /** 缺失的原因,按界面语言给;bot 声明里自带的理由不翻译。 */
  readonly reason: (language: Language) => string;
  /** Persona声明过的渠道。缺省 true:声明了却没实现的那类。 */
  readonly declared?: boolean;
}

export interface PrebuiltOptions {
  /** 控制台显示名;缺省用 id。 */
  labels?: Record<string, string>;
  /** 按 bot 声明的渠道算(缺省)还是按部署侧选配算。 */
  declared?: boolean;
}

/** Core 构造后绑定挂载与卸载方法。 */
export interface WorldMountHost {
  mount(mod: World): Promise<void>;
  unmount(id: string): Promise<void>;
  /** 装配层改了一个槽位的挂载状态(激活 / 停用 / 重启)。启动期的初始挂载不报。 */
  lifecycle?(event: WorldLifecycleEvent): void;
  /**
   * Core 保留帧与 Persona 自有工具的名称。绑定时检查已挂载实例，
   * 冲突实例移入 missing；后续激活、重启和添加预建实例同样检查。
   */
  reservedToolNames?(): readonly string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 就地深合并:叶子替换,沿途对象身份保持,数组整体替换。 */
function assignDeep(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = target[key];
    if (isPlainObject(value) && isPlainObject(current)) assignDeep(current, value);
    else target[key] = isPlainObject(value) ? structuredClone(value) : value;
  }
}

function writeEnvLine(envPath: string, name: string, value: string): void {
  const prev = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^[ \\t]*${name}\\s*=.*$`, 'm');
  const next = pattern.test(prev)
    ? prev.replace(pattern, line)
    : (prev.trimEnd() ? `${prev.trimEnd()}\n${line}\n` : `${line}\n`);
  writeFileSync(envPath, next, 'utf8');
}

export class WorldAssembly {
  /** 挂载表。与 core 共用同一个数组,激活/停用就地增删。 */
  readonly mounted: World[] = [];
  readonly slots: WorldSlot[] = [];
  get definitions(): readonly WorldDefinition<WorldSection>[] { return this.worlds; }
  readonly missing: MissingWorld[] = [];
  private host: WorldMountHost | null = null;
  private readonly cfgPath: string;

  constructor(
    private readonly loaded: LoadedConfig<CoreConfig>,
    private readonly worlds: readonly WorldDefinition<WorldSection>[],
    declares: readonly WorldDeclaration[],
  ) {
    this.cfgPath = join(loaded.rootDir, 'config.json');
    const declared = new Set<string>();
    for (const decl of declares) declared.add(typeof decl === 'string' ? decl : decl.id);
    const defined = new Set(worlds.map((m) => m.id));
    for (const def of worlds) {
      const section = this.section(def);
      let instance: World;
      try {
        instance = def.create(this.context(def));
      } catch (error) {
        // 单个定义构造失败记入 missing，继续构造其他 World。
        const detail = error instanceof Error ? error.message : String(error);
        this.missing.push({
          id: def.id,
          label: def.label,
          declared: declared.has(def.id),
          reason: (language) => text(language).constructFailed(detail),
        });
        continue;
      }
      const clash = section.enabled ? this.toolClash(instance, this.mounted) : null;
      if (clash) {
        this.missing.push({ id: def.id, label: def.label, declared: declared.has(def.id), reason: clash });
        continue;
      }
      const slot: WorldSlot = {
        id: def.id,
        label: def.label,
        declared: declared.has(def.id),
        definition: def,
        instance,
        mounted: false,
      };
      this.slots.push(slot);
      if (section.enabled) {
        slot.mounted = true;
        this.mounted.push(slot.instance);
      }
    }
    for (const decl of declares) {
      if (typeof decl === 'string') {
        if (!defined.has(decl)) this.missing.push({ id: decl, label: decl, reason: (language) => text(language).notImplemented });
        continue;
      }
      if (defined.has(decl.id)) continue;
      const given = decl.reason;
      this.missing.push({ id: decl.id, label: decl.label, reason: given ? () => given : (language) => text(language).notImplemented });
    }
  }

  /** 只有预建实例的槽位表(测试与开发态用):不读配置,不写 config.json。 */
  static ofInstances(instances: readonly World[], opts: PrebuiltOptions = {}): WorldAssembly {
    const loaded = {
      config: { worlds: {} } as unknown as CoreConfig,
      secret: () => '',
      rootDir: '',
      memoryDir: '',
      dataDir: '',
    } satisfies LoadedConfig<CoreConfig>;
    const assembly = new WorldAssembly(loaded, [], []);
    assembly.addPrebuilt(instances, opts);
    return assembly;
  }

  /** 预建实例初始挂载，重启复用原对象；同 id 时替换原定义实例。 */
  addPrebuilt(instances: readonly World[], opts: PrebuiltOptions = {}): void {
    for (const mod of instances) {
      const existing = this.slots.findIndex((s) => s.id === mod.id);
      if (existing >= 0) {
        const old = this.slots[existing];
        if (old.mounted) this.mounted.splice(this.mounted.indexOf(old.instance), 1);
        this.slots.splice(existing, 1);
      }
      const clash = this.toolClash(mod, this.mounted);
      if (clash) throw new Error(clash('zh'));
      this.slots.push({
        id: mod.id,
        label: opts.labels?.[mod.id] ?? mod.id,
        declared: opts.declared ?? true,
        definition: null,
        instance: mod,
        mounted: true,
      });
      this.mounted.push(mod);
    }
  }

  /** 绑定 Core 后检查保留名称，冲突的已挂载实例移入 missing。 */
  bind(host: WorldMountHost): void {
    this.host = host;
    for (const slot of [...this.slots]) {
      if (!slot.mounted) continue;
      const clash = this.toolClash(slot.instance, []);
      if (!clash) continue;
      this.mounted.splice(this.mounted.indexOf(slot.instance), 1);
      this.slots.splice(this.slots.indexOf(slot), 1);
      this.missing.push({ id: slot.id, label: slot.label, declared: slot.declared, reason: clash });
    }
  }

  slot(id: string, language: Language = 'zh'): WorldSlot {
    const slot = this.slots.find((s) => s.id === id);
    if (!slot) throw new Error(text(language).unknownWorld(id));
    return slot;
  }

  /** 所有槽位的实例(含未挂载的),给控制台拼面板、提示词文档与配置组用。 */
  instances(): World[] {
    return this.slots.map((s) => s.instance);
  }

  labelOf(id: string): string | undefined {
    return this.slots.find((s) => s.id === id)?.label;
  }

  /** 三个动作的回执与拒绝理由按 `language` 给;省略 = 中文。 */
  async activate(id: string, language: Language = 'zh'): Promise<string> {
    const t = text(language);
    const slot = this.slot(id, language);
    if (slot.mounted) return t.alreadyRunning(slot.label);
    const def = slot.definition;
    if (!def) throw new Error(t.prebuilt(slot.label));
    const ctx = this.context(def);
    def.preflight?.(ctx);
    const clash = this.toolClash(slot.instance, this.mounted);
    if (clash) throw new Error(clash(language));
    this.persist(id, { enabled: true });
    try {
      await this.mountHost().mount(slot.instance);
    } catch (error) {
      this.persist(id, { enabled: false });
      slot.instance = def.create(ctx);
      throw error;
    }
    slot.mounted = true;
    this.host?.lifecycle?.({ kind: 'mounted', id, label: slot.label });
    return t.activated(slot.label, id);
  }

  async deactivate(id: string, language: Language = 'zh'): Promise<string> {
    const slot = this.slot(id, language);
    const wasMounted = slot.mounted;
    if (wasMounted) await this.stopSlot(slot);
    this.persist(id, { enabled: false });
    if (wasMounted) this.host?.lifecycle?.({ kind: 'unmounted', id, label: slot.label });
    return text(language).deactivated(slot.label, id);
  }

  async restart(id: string, language: Language = 'zh'): Promise<string> {
    const slot = this.slot(id, language);
    if (!slot.mounted) throw new Error(text(language).notActive(slot.label));
    await this.stopSlot(slot);
    const clash = this.toolClash(slot.instance, this.mounted);
    if (clash) throw new Error(clash(language));
    await this.mountHost().mount(slot.instance);
    slot.mounted = true;
    this.host?.lifecycle?.({ kind: 'restarted', id, label: slot.label });
    return text(language).restarted(slot.label);
  }

  /** 按 worlds.<id>.enabled 同步状态，供 WorldContext.restart 调用。 */
  async sync(id: string): Promise<void> {
    const slot = this.slot(id);
    const enabled = (slot.definition ? this.section(slot.definition) : { enabled: true }).enabled;
    if (enabled) {
      if (slot.mounted) await this.restart(id);
      else await this.activate(id);
    } else if (slot.mounted) {
      await this.stopSlot(slot);
      this.host?.lifecycle?.({ kind: 'unmounted', id, label: slot.label });
    }
  }

  private async stopSlot(slot: WorldSlot): Promise<void> {
    await this.mountHost().unmount(slot.id);
    slot.mounted = false;
    if (slot.definition) slot.instance = slot.definition.create(this.context(slot.definition));
  }

  /** 工具名在 bot 内唯一。与保留名称或已挂载 World 工具冲突时拒绝挂载。 */
  private toolClash(mod: World, mounted: readonly World[]): ((language: Language) => string) | null {
    const names = new Set(mod.tools().map((t) => t.name));
    const reserved = (this.host?.reservedToolNames?.() ?? []).filter((n) => names.has(n));
    if (reserved.length) return (language) => text(language).toolReserved(reserved);
    for (const other of mounted) {
      const shared = other.tools().map((t) => t.name).filter((n) => names.has(n));
      if (shared.length) {
        const label = this.labelOf(other.id) ?? other.id;
        return (language) => text(language).toolClash(label, shared);
      }
    }
    return null;
  }

  private mountHost(): WorldMountHost {
    if (!this.host) throw new Error(text('zh').unbound);
    return this.host;
  }

  /** `worlds.<id>` 活引用;缺段时按定义默认值补一段。 */
  private section(def: WorldDefinition<WorldSection>): WorldSection {
    const worlds = ((this.loaded.config as unknown as { worlds?: Record<string, WorldSection> }).worlds ??= {});
    return (worlds[def.id] ??= def.defaults());
  }

  private persist(id: string, patch: Record<string, unknown>): void {
    const worlds = (this.loaded.config as unknown as { worlds: Record<string, Record<string, unknown>> }).worlds;
    assignDeep(worlds[id], patch);
    updateJsonObject(this.cfgPath, (raw) => {
      const rawIo = (raw.worlds ??= {}) as Record<string, Record<string, unknown>>;
      const section = (rawIo[id] ??= {});
      assignDeep(section, patch);
    });
  }

  private context<S extends WorldSection>(def: WorldDefinition<S>): WorldContext<S> {
    const { loaded } = this;
    const cfg = loaded.config;
    return {
      id: def.id,
      cfg: this.section(def as unknown as WorldDefinition<WorldSection>) as S,
      timezone: cfg.timezone,
      botName: cfg.displayName,
      botDir: loaded.rootDir,
      packageDir: loaded.packageDir ?? loaded.rootDir,
      dataDir: loaded.dataDir,
      repoRoot: loaded.repoRoot ?? loaded.rootDir,
      secret: (name) => loaded.secret(name),
      storeSecret: (name, value) => {
        writeEnvLine(join(loaded.rootDir, '.env'), name, value);
        process.env[name] = value;
      },
      persist: (patch) => this.persist(def.id, patch as Record<string, unknown>),
      restart: () => this.sync(def.id),
    };
  }
}
