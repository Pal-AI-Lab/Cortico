/**
 * 在临时部署中检查扩展构造与声明接口，不调用 start()。
 * World 使用默认配置、无密钥，检查 create、tools、envPromptVars、console 与工具名冲突；
 * provider 使用测试端点 create，bot 使用测试部署 build。
 * World 构造失败为错误；provider 仅在绑定端点时构造，测试条目不完整导致的失败记为警告。
 * 临时文件位于 scratchDir，调用方负责创建与清理。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreConfig, World } from '../core/types.ts';
import { MODULE_LAMP_MAX } from '../core/types.ts';
import type { LoadedConfig } from '../core/config.ts';
import { CORE_DEFAULTS } from '../core/config.ts';
import { RESERVED_FRAME_NAMES } from '../core/loop.ts';
import { nullLogger } from '../core/util.ts';
import type { Language } from '../core/language.ts';
import type { BotDefinition } from '../bot.ts';
import type { WorldContext, WorldDefinition, WorldSection } from '../world.ts';
import type { ProviderModule } from '../providers/base.ts';

export interface DryMountReport {
  ok: string[];
  warnings: string[];
  failures: string[];
}

export interface DryMountOptions {
  /** 假部署与假端点目录的根。 */
  scratchDir: string;
  /** 扩展包目录;bot 的 `packageDir` 与 World 的 `packageDir` 都指它。缺省用假部署目录。 */
  packageDir?: string;
  repoRoot?: string;
  language?: Language;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 面板 id 的形状:控制台一页内的局部 id。 */
const PANEL_ID = /^[a-z0-9-]+$/;
/** 工具名带前缀:`<短名>_` 起头。 */
const TOOL_PREFIX = /^[a-z0-9]+_/;

function deploymentDirs(opts: DryMountOptions): { botDir: string; dataDir: string; memoryDir: string } {
  const botDir = join(opts.scratchDir, 'deployment');
  const dataDir = join(botDir, 'data');
  const memoryDir = join(botDir, 'memory');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  return { botDir, dataDir, memoryDir };
}

/** 装配层给 `create()` 的上下文的假件:默认配置、没有密钥、写回都是空操作。 */
export function fakeWorldContext<S extends WorldSection>(def: WorldDefinition<S>, opts: DryMountOptions): WorldContext<S> {
  const cfg = def.defaults();
  const { botDir, dataDir } = deploymentDirs(opts);
  return {
    id: def.id,
    cfg,
    timezone: CORE_DEFAULTS.timezone,
    botName: CORE_DEFAULTS.displayName,
    botDir,
    packageDir: opts.packageDir ?? botDir,
    dataDir,
    repoRoot: opts.repoRoot ?? botDir,
    secret: () => '',
    storeSecret: () => {},
    persist: (patch) => { Object.assign(cfg as object, patch); },
    restart: async () => {},
  };
}

/**
 * 收集工具名称及所属定义，用于冲突检查；无法构造的定义列入 skipped，
 * 调用方应说明冲突检查未覆盖这些定义。
 */
export function collectToolNames(
  defs: readonly WorldDefinition<WorldSection>[],
  opts: DryMountOptions,
): { taken: Map<string, string>; skipped: string[] } {
  const taken = new Map<string, string>();
  const skipped: string[] = [];
  for (const def of defs) {
    try {
      for (const tool of def.create(fakeWorldContext(def, opts)).tools()) taken.set(tool.name, def.label);
    } catch (error) {
      skipped.push(`${def.label}: ${message(error)}`);
    }
  }
  return { taken, skipped };
}

export interface WorldDryMountOptions extends DryMountOptions {
  /** manifest 声明了浏览器端产物;声明了面板却没有产物只是警告。 */
  hasConsoleClient?: boolean;
  /** 已被别的 World 占用的工具名 → 占用者。 */
  takenToolNames?: ReadonlyMap<string, string>;
}

export async function dryMountWorld(def: WorldDefinition<WorldSection>, opts: WorldDryMountOptions): Promise<DryMountReport> {
  const report: DryMountReport = { ok: [], warnings: [], failures: [] };
  const { ok, warnings, failures } = report;

  let defaults: unknown;
  try {
    defaults = def.defaults();
  } catch (error) {
    failures.push(`defaults() 抛错: ${message(error)}`);
    return report;
  }
  if (!isPlainObject(defaults)) {
    failures.push('defaults() 没有返回对象:它是 worlds.<id> 段的默认值。');
    return report;
  }
  if (defaults.enabled !== false) {
    warnings.push('defaults().enabled 不是 false:启用与否由 bot 的 declares 与部署决定,定义里恒为 false。');
  }
  ok.push('defaults() 返回配置段。');

  let world: World;
  try {
    world = def.create(fakeWorldContext(def, opts));
  } catch (error) {
    failures.push(`create() 在默认配置、无密钥下抛错: ${message(error)}。装配层会构造所有可用定义，默认配置下也必须能完成构造。`);
    return report;
  }
  if (world.id !== def.id) {
    failures.push(`实例的 id「${world.id}」与定义的 id「${def.id}」不同:装配层按定义找槽位,Core 按实例归属工具与事件,两边会对不上。`);
  } else {
    ok.push(`create() 返回 World 实例,id = ${world.id}。`);
  }

  let tools: ReturnType<World['tools']>;
  try {
    tools = world.tools();
  } catch (error) {
    failures.push(`tools() 抛错: ${message(error)}`);
    return report;
  }
  if (!Array.isArray(tools)) {
    failures.push('tools() 没有返回数组。');
    return report;
  }
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = tool?.name;
    if (typeof name !== 'string' || name === '') {
      failures.push('有一个工具没有 name。');
      continue;
    }
    if (seen.has(name)) failures.push(`工具名重复: ${name}。`);
    seen.add(name);
    if (RESERVED_FRAME_NAMES.has(name)) failures.push(`工具名「${name}」是 Core 的保留帧名,装配层拒绝挂载。`);
    const owner = opts.takenToolNames?.get(name);
    if (owner) failures.push(`工具名「${name}」与 ${owner} 撞名,装配层拒绝挂载。`);
    if (!isPlainObject(tool.parameters)) failures.push(`工具「${name}」的 parameters 不是对象:它是发给模型的 JSON Schema。`);
    if (typeof tool.handler !== 'function') failures.push(`工具「${name}」没有 handler。`);
    if (!Array.isArray(tool.tags)) failures.push(`工具「${name}」没有 tags 数组:空数组表示明确不分类,缺席不行。`);
    else if (tool.tags.length === 0) warnings.push(`工具「${name}」的 tags 为空，按标签选择工具时不会匹配；挂载时记录警告。`);
    if (!TOOL_PREFIX.test(name)) warnings.push(`工具名「${name}」没有前缀:惯例是 <短名>_<动词短语>,工具名在整个 bot 里唯一。`);
  }
  if (!failures.length) ok.push(tools.length ? `tools(): ${tools.map((t) => t.name).join(', ')}` : 'tools(): 没有工具。');

  try {
    const vars = await world.envPromptVars();
    if (vars === null) ok.push('envPromptVars() 返回 null:这个 World 的段不进前缀。');
    else if (isPlainObject(vars)) ok.push(`envPromptVars(): ${Object.keys(vars).length} 个占位符值。`);
    else failures.push('envPromptVars() 要返回对象或 null。');
  } catch (error) {
    failures.push(`envPromptVars() 抛错: ${message(error)}`);
  }

  if (typeof world.console === 'function') {
    try {
      const decl = world.console(opts.language ?? 'zh');
      const panels = decl.panels ?? [];
      const panelIds = new Set<string>();
      for (const panel of panels) {
        if (!PANEL_ID.test(panel.id)) failures.push(`面板 id「${panel.id}」不合形状:控制台一页内的局部 id,只用 [a-z0-9-]。`);
        if (panelIds.has(panel.id)) failures.push(`面板 id 重复: ${panel.id}。`);
        panelIds.add(panel.id);
      }
      if (panels.length && !opts.hasConsoleClient) {
        warnings.push(`console() 声明了 ${panels.length} 个面板，未声明 cortico.consoleClient；使用自定义面板时需提供浏览器产物。`);
      }
      if ((decl.lamps?.length ?? 0) > MODULE_LAMP_MAX) {
        warnings.push(`console().lamps 有 ${decl.lamps?.length} 颗,控制台最多画 ${MODULE_LAMP_MAX} 颗。`);
      }
      for (const group of decl.config ?? []) {
        if (group.owner !== `world:${def.id}`) warnings.push(`配置组「${group.id}」的 owner 是「${group.owner}」,World 的配置组 owner 应为 world:${def.id}。`);
      }
      const keys = new Set<string>();
      for (const doc of decl.promptDocs ?? []) {
        if (keys.has(doc.key)) failures.push(`promptDocs key 重复: ${doc.key}。`);
        keys.add(doc.key);
        if (doc.role === 'envPrompt' && !existsSync(doc.path)) {
          warnings.push(`环境提示词模板 ${doc.path} 不在:这个 World 的段会是空的。`);
        }
      }
      ok.push(`console(): ${panels.length} 个面板,${decl.config?.length ?? 0} 个配置组,${decl.promptDocs?.length ?? 0} 份提示词文档。`);
    } catch (error) {
      failures.push(`console() 抛错: ${message(error)}`);
    }
  } else {
    ok.push('没有 console():控制台按通用信息显示。');
  }
  return report;
}

export interface ProviderDryMountOptions extends DryMountOptions {
  hasConsoleClient?: boolean;
}

export function dryMountProvider(mod: ProviderModule, opts: ProviderDryMountOptions): DryMountReport {
  const report: DryMountReport = { ok: [], warnings: [], failures: [] };
  const { ok, warnings, failures } = report;
  const language = opts.language ?? 'zh';

  for (const [field, tiers] of [['reasoningTiers', mod.reasoningTiers], ['serviceTiers', mod.serviceTiers]] as const) {
    for (const tier of tiers) {
      if (typeof tier?.id !== 'string' || typeof tier.label !== 'string') {
        failures.push(`${field} 里有一项缺 id 或 label。`);
        break;
      }
    }
  }
  if (!failures.length) ok.push(`档位表: ${mod.reasoningTiers.length} 档推理(空表 = 开放),${mod.serviceTiers.length} 档服务。`);

  const raw = { kind: mod.id, baseUrl: mod.defaultBaseUrl ?? mod.baseUrlSuggestions?.[0] ?? 'http://127.0.0.1:0' };
  let entry = raw;
  try {
    entry = mod.normalize?.(structuredClone(raw)) ?? raw;
  } catch (error) {
    failures.push(`normalize() 抛错: ${message(error)}`);
    return report;
  }

  const stateDir = join(opts.scratchDir, 'providers', 'check');
  mkdirSync(stateDir, { recursive: true });
  const resources = new Map<string, unknown>();
  const host = {
    stateDir,
    repoRoot: opts.repoRoot ?? opts.scratchDir,
    resource: <T>(key: string, create: () => T): T => {
      if (!resources.has(key)) resources.set(key, create());
      return resources.get(key) as T;
    },
    currentEntry: () => entry,
    secret: () => '',
    readBlob: () => null,
    keepThinking: () => false,
    log: nullLogger(),
  };
  try {
    const instance = mod.create('check', entry, host);
    if (typeof instance?.client?.respond !== 'function') {
      failures.push('create() 返回的实例没有 client.respond():Core 只经它调模型。');
    } else {
      ok.push('create() 返回实例,client.respond() 在。');
    }
  } catch (error) {
    warnings.push(`create() 在假端点条目(只有 kind 与 baseUrl)下抛错: ${message(error)}。真实端点条目可能不同,这一项不算失败。`);
  }

  if (mod.config) {
    try {
      const groups = mod.config('check', entry, language);
      if (!Array.isArray(groups)) failures.push('config() 没有返回数组。');
      else {
        for (const group of groups) {
          if (group.owner !== `provider:${mod.id}`) warnings.push(`配置组「${group.id}」的 owner 是「${group.owner}」,provider 的配置组 owner 应为 provider:${mod.id}。`);
        }
        ok.push(`config(): ${groups.length} 个配置组。`);
      }
    } catch (error) {
      failures.push(`config() 抛错: ${message(error)}`);
    }
  }

  if (mod.localize) {
    try {
      mod.localize(language);
      ok.push("localize() 调用成功。");
    } catch (error) {
      failures.push(`localize() 抛错: ${message(error)}`);
    }
  }

  if (mod.console) {
    try {
      const contribution = mod.console({
        language,
        entries: () => [],
        instance: () => { throw new Error("构造检查不提供实际端点实例"); },
        save: () => {},
      });
      const panels = contribution.panels ?? [];
      for (const panel of panels) {
        if (!PANEL_ID.test(panel.id)) failures.push(`面板 id「${panel.id}」不合形状:只用 [a-z0-9-]。`);
      }
      if (panels.length && !opts.hasConsoleClient) {
        warnings.push(`console() 声明了 ${panels.length} 个面板，未声明 cortico.consoleClient；使用自定义面板时需提供浏览器产物。`);
      }
      ok.push(`console(): ${panels.length} 个面板。`);
    } catch (error) {
      failures.push(`console() 抛错: ${message(error)}`);
    }
  }
  return report;
}

export interface BotDryMountOptions extends DryMountOptions {
  packageDir: string;
}

export function dryMountBot(def: BotDefinition<CoreConfig>, opts: BotDryMountOptions): DryMountReport {
  const report: DryMountReport = { ok: [], warnings: [], failures: [] };
  const { ok, warnings, failures } = report;

  let config: unknown;
  try {
    config = def.defaults();
  } catch (error) {
    failures.push(`defaults() 抛错: ${message(error)}`);
    return report;
  }
  if (!isPlainObject(config)) {
    failures.push("defaults() 必须返回配置对象。");
    return report;
  }
  (config as { worlds?: unknown }).worlds ??= {};
  ok.push('defaults() 返回对象。');

  for (const decl of def.declares ?? []) {
    const shaped = typeof decl === 'string' ? decl !== '' : isPlainObject(decl) && typeof decl.id === 'string' && typeof decl.label === 'string';
    if (!shaped) failures.push(`declares 里有一项不合形状: ${JSON.stringify(decl)}(World id 字符串,或 { id, label, reason? })。`);
  }
  if (def.declares?.length) ok.push(`declares: ${def.declares.map((d) => (typeof d === 'string' ? d : d.id)).join(', ')}`);

  const { botDir, dataDir, memoryDir } = deploymentDirs(opts);
  const loaded: LoadedConfig<CoreConfig> = {
    config: config as unknown as CoreConfig,
    secret: () => '',
    rootDir: botDir,
    memoryDir,
    dataDir,
    packageDir: opts.packageDir,
    providersDir: join(botDir, 'providers'),
    repoRoot: opts.repoRoot ?? botDir,
  };
  let parts: ReturnType<typeof def.build>;
  try {
    parts = def.build(loaded, []);
  } catch (error) {
    failures.push(`build() 在假部署(默认配置、空 Memory、无密钥)下抛错: ${message(error)}。build() 必须能在该配置下完成构造。`);
    return report;
  }
  const persona = parts?.persona as unknown;
  if (!isPlainObject(persona)) {
    failures.push('build() 没有返回 persona。');
    return report;
  }
  for (const method of ['systemSegments', 'attach', 'declareSessions'] as const) {
    if (typeof persona[method] !== 'function') failures.push(`persona 缺 ${method}():Persona 契约的必填项。`);
  }
  if (typeof persona.memoryDir !== 'string') failures.push('persona.memoryDir 不是字符串:Memory 目录的绝对路径。');
  const blobs = persona.blobs as Record<string, unknown> | undefined;
  if (!isPlainObject(blobs) || ['put', 'get', 'list'].some((m) => typeof blobs[m] !== 'function')) {
    failures.push('persona.blobs 不是 BlobStore(put / get / list):mem: 句柄没有后端。');
  }
  if (!failures.length) ok.push('build() 返回 Persona,契约必填项都在。');
  if (typeof def.memoryName !== 'string' || def.memoryName === '') {
    warnings.push('BotDefinition 没有 memoryName:Memory 页标题回落到 persona.memory 的类名,再缺省是「Memory」。');
  }

  const prebuilt = parts.worlds ?? [];
  const ids = new Set<string>();
  for (const world of prebuilt) {
    if (ids.has(world.id)) failures.push(`预建 World id 重复: ${world.id}。`);
    ids.add(world.id);
  }
  if (prebuilt.length) ok.push(`预建 World: ${[...ids].join(', ')}（预建实例重启时复用原对象）。`);

  for (const group of parts.console?.configGroups ?? []) {
    if (group.owner !== 'persona') warnings.push(`配置组「${group.id}」的 owner 是「${group.owner}」,Persona 的配置组 owner 应为 persona。`);
  }
  return report;
}
