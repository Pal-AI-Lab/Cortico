/**
 * 在临时部署中检查扩展构造与声明接口，不调用 start()。
 * World 使用默认配置、无密钥，检查 create、tools、envPromptVars、WebUI、工具名冲突与配置路径；
 * provider 使用测试端点 create 并检查配置路径，bot 使用测试部署 build。
 * World 构造失败为错误；provider 仅在绑定端点时构造，测试条目不完整导致的失败记为警告。
 * 临时文件位于 scratchDir，调用方负责创建与清理。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigGroup, CoreConfig, World } from '../core/types.ts';
import { MODULE_LAMP_MAX } from '../core/types.ts';
import type { LoadedConfig } from '../core/config.ts';
import { CORE_DEFAULTS } from '../core/config.ts';
import { getByPath, isConfigGroup } from '../core/config-schema.ts';
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

/**
 * 声明过的每个配置路径都要落在 prefix 指的段内;给了 `defaults` 时还要在里面有对应项。
 * 缺默认值时 WebUI 照样渲染旋钮、也照样写回 config.json,而读到的是代码里另一处的兜底值。
 * provider 的旋钮写进端点条目而不是 `defaults()`,所以只核对段。
 */
function configPathProblems(group: ConfigGroup, prefix: string, defaults?: Record<string, unknown>): string[] {
  if (!isConfigGroup(group)) {
    const fields = isPlainObject(group) ? Object.keys(group).join(', ') : typeof group;
    return [`A config group lacks id, owner or schema.properties (fields present: ${fields}); the WebUI skips it.`];
  }
  const problems: string[] = [];
  for (const path of Object.keys(group.schema.properties ?? {})) {
    if (!path.startsWith(prefix)) {
      problems.push(`Config group "${group.id}" declares "${path}" outside the ${prefix} section: writes follow the path, so the value lands in another owner's section.`);
      continue;
    }
    if (defaults && getByPath(defaults, path.slice(prefix.length)) === undefined) {
      problems.push(`Config group "${group.id}" declares "${path}" with no matching entry in defaults(): the WebUI can change it and write it to config.json, but the code still reads its fallback value.`);
    }
  }
  return problems;
}

/** 面板 id 的形状:WebUI 一页内的局部 id。 */
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
      for (const tool of def.create(fakeWorldContext(def, opts)).tools()) taken.set(tool.name, def.id);
    } catch (error) {
      skipped.push(`${def.id}: ${message(error)}`);
    }
  }
  return { taken, skipped };
}

export interface WorldDryMountOptions extends DryMountOptions {
  /** manifest 声明了浏览器端产物;声明了面板却没有产物只是警告。 */
  hasWebUiClient?: boolean;
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
    failures.push(`defaults() threw: ${message(error)}`);
    return report;
  }
  if (!isPlainObject(defaults)) {
    failures.push('defaults() did not return an object: it supplies the defaults of the worlds.<id> section.');
    return report;
  }
  if (defaults.enabled !== false) {
    warnings.push("defaults().enabled is not false: the bot's declares and the deployment decide whether a World is enabled, so the definition always sets false.");
  }
  ok.push('defaults() returns a config section.');

  let world: World;
  try {
    world = def.create(fakeWorldContext(def, opts));
  } catch (error) {
    failures.push(`create() threw with default config and no secrets: ${message(error)}. The assembly layer constructs every available definition, so create() must succeed with default config.`);
    return report;
  }
  if (world.id !== def.id) {
    failures.push(`Instance id "${world.id}" differs from definition id "${def.id}": the assembly layer finds the slot by the definition id and Core attributes tools and events by the instance id, so the two will not match.`);
  } else {
    ok.push(`create() returns a World instance, id = ${world.id}.`);
  }

  let tools: ReturnType<World['tools']>;
  try {
    tools = world.tools();
  } catch (error) {
    failures.push(`tools() threw: ${message(error)}`);
    return report;
  }
  if (!Array.isArray(tools)) {
    failures.push('tools() did not return an array.');
    return report;
  }
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = tool?.name;
    if (typeof name !== 'string' || name === '') {
      failures.push('A tool has no name.');
      continue;
    }
    if (seen.has(name)) failures.push(`Duplicate tool name: ${name}.`);
    seen.add(name);
    if (RESERVED_FRAME_NAMES.has(name)) failures.push(`Tool name "${name}" is a Core reserved frame name; the assembly layer refuses to mount it.`);
    const owner = opts.takenToolNames?.get(name);
    if (owner) failures.push(`Tool name "${name}" is already used by World "${owner}"; the assembly layer refuses to mount it.`);
    if (!isPlainObject(tool.parameters)) failures.push(`Tool "${name}" parameters is not an object: it is the JSON Schema sent to the model.`);
    if (typeof tool.handler !== 'function') failures.push(`Tool "${name}" has no handler.`);
    if (!Array.isArray(tool.tags)) failures.push(`Tool "${name}" has no tags array: an empty array means deliberately untagged, and the field is required.`);
    else if (tool.tags.length === 0) warnings.push(`Tool "${name}" has empty tags: tag-based tool selection never matches it, and mounting logs a warning.`);
    if (!TOOL_PREFIX.test(name)) warnings.push(`Tool name "${name}" has no prefix: the convention is <short id>_<verb phrase>, and tool names are unique across the whole bot.`);
  }
  if (!failures.length) ok.push(tools.length ? `tools(): ${tools.map((t) => t.name).join(', ')}` : 'tools(): no tools.');

  try {
    const vars = await world.envPromptVars();
    if (vars === null) ok.push('envPromptVars() returns null: this World adds no section to the prefix.');
    else if (isPlainObject(vars)) ok.push(`envPromptVars(): placeholder values: ${Object.keys(vars).length}.`);
    else failures.push('envPromptVars() must return an object or null.');
  } catch (error) {
    failures.push(`envPromptVars() threw: ${message(error)}`);
  }

  if (typeof world.webUi === 'function') {
    try {
      const decl = world.webUi(opts.language ?? 'zh');
      const panels = decl.panels ?? [];
      const panelIds = new Set<string>();
      for (const panel of panels) {
        if (!PANEL_ID.test(panel.id)) failures.push(`Panel id "${panel.id}" is malformed: it is local to one WebUI page and uses only [a-z0-9-].`);
        if (panelIds.has(panel.id)) failures.push(`Duplicate panel id: ${panel.id}.`);
        panelIds.add(panel.id);
      }
      if (panels.length && !opts.hasWebUiClient) {
        warnings.push(`webUi() declares panels (${panels.length}) but the manifest has no cortico.webUiClient; custom panels need a browser bundle.`);
      }
      if ((decl.lamps?.length ?? 0) > MODULE_LAMP_MAX) {
        warnings.push(`webUi().lamps has length ${decl.lamps?.length}; the WebUI draws at most ${MODULE_LAMP_MAX} lamps.`);
      }
      for (const group of decl.config ?? []) {
        if (group.owner !== `world:${def.id}`) warnings.push(`Config group "${group.id}" has owner "${group.owner}"; a World's config group owner must be world:${def.id}.`);
        failures.push(...configPathProblems(group, `worlds.${def.id}.`, defaults));
      }
      const keys = new Set<string>();
      for (const doc of decl.promptDocs ?? []) {
        if (keys.has(doc.key)) failures.push(`Duplicate promptDocs key: ${doc.key}.`);
        keys.add(doc.key);
        if (doc.role === 'envPrompt' && !existsSync(doc.path)) {
          warnings.push(`Env prompt template ${doc.path} does not exist: this World's section will be empty.`);
        }
      }
      ok.push(`webUi(): panels: ${panels.length}, config groups: ${decl.config?.length ?? 0}, prompt docs: ${decl.promptDocs?.length ?? 0}.`);
    } catch (error) {
      failures.push(`webUi() threw: ${message(error)}`);
    }
  } else {
    ok.push('No webUi(): the WebUI shows the generic page.');
  }
  return report;
}

export interface ProviderDryMountOptions extends DryMountOptions {
  hasWebUiClient?: boolean;
}

/** 假端点的名字;模块声明的配置路径按它组成 `providers.<端点名>.options.`。 */
const PROBE_ENDPOINT = 'check';

export function dryMountProvider(mod: ProviderModule, opts: ProviderDryMountOptions): DryMountReport {
  const report: DryMountReport = { ok: [], warnings: [], failures: [] };
  const { ok, warnings, failures } = report;
  const language = opts.language ?? 'zh';

  for (const [field, tiers] of [['reasoningTiers', mod.reasoningTiers], ['serviceTiers', mod.serviceTiers]] as const) {
    for (const tier of tiers) {
      if (typeof tier?.id !== 'string' || typeof tier.label !== 'string') {
        failures.push(`An entry in ${field} lacks id or label.`);
        break;
      }
    }
  }
  if (!failures.length) ok.push(`Tiers: reasoning: ${mod.reasoningTiers.length} (empty = open), service: ${mod.serviceTiers.length}.`);

  const raw = { kind: mod.id, baseUrl: mod.defaultBaseUrl ?? mod.baseUrlSuggestions?.[0] ?? 'http://127.0.0.1:0' };
  let entry = raw;
  try {
    entry = mod.normalize?.(structuredClone(raw)) ?? raw;
  } catch (error) {
    failures.push(`normalize() threw: ${message(error)}`);
    return report;
  }

  const stateDir = join(opts.scratchDir, 'providers', PROBE_ENDPOINT);
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
    const instance = mod.create(PROBE_ENDPOINT, entry, host);
    if (typeof instance?.client?.respond !== 'function') {
      failures.push('The instance returned by create() has no client.respond(): Core calls the model only through it.');
    } else {
      ok.push('create() returns an instance with client.respond().');
    }
  } catch (error) {
    warnings.push(`create() threw with a fake endpoint entry (only kind and baseUrl): ${message(error)}. A real endpoint entry may differ, so this is not a failure.`);
  }

  if (mod.config) {
    try {
      const groups = mod.config(PROBE_ENDPOINT, entry, language);
      if (!Array.isArray(groups)) failures.push('config() did not return an array.');
      else {
        for (const group of groups) {
          if (group.owner !== `provider:${mod.id}`) warnings.push(`Config group "${group.id}" has owner "${group.owner}"; a provider's config group owner must be provider:${mod.id}.`);
          // 写回的三道闸都只按 `providers.<端点名>.` 过滤:段外的路径改不动,段内 options 之外的
          // 路径覆盖框架自己编辑的字段(baseUrl、secret、multimodal、spec)。两类都拦在这里。
          failures.push(...configPathProblems(group, `providers.${PROBE_ENDPOINT}.options.`));
        }
        ok.push(`config(): config groups: ${groups.length}.`);
      }
    } catch (error) {
      failures.push(`config() threw: ${message(error)}`);
    }
  }

  if (mod.localize) {
    try {
      mod.localize(language);
      ok.push('localize() returned without error.');
    } catch (error) {
      failures.push(`localize() threw: ${message(error)}`);
    }
  }

  if (mod.webUi) {
    try {
      const contribution = mod.webUi({
        language,
        entries: () => [],
        instance: () => { throw new Error('The construction check has no real endpoint instance'); },
        save: () => {},
      });
      const panels = contribution.panels ?? [];
      for (const panel of panels) {
        if (!PANEL_ID.test(panel.id)) failures.push(`Panel id "${panel.id}" is malformed: use only [a-z0-9-].`);
      }
      if (panels.length && !opts.hasWebUiClient) {
        warnings.push(`webUi() declares panels (${panels.length}) but the manifest has no cortico.webUiClient; custom panels need a browser bundle.`);
      }
      ok.push(`webUi(): panels: ${panels.length}.`);
    } catch (error) {
      failures.push(`webUi() threw: ${message(error)}`);
    }
  }
  return report;
}

export interface BotDryMountOptions extends DryMountOptions {
  packageDir: string;
}

/** bot `build()` 的假部署:给定配置、空 Memory、没有密钥。 */
export function fakeLoadedConfig(config: CoreConfig, opts: BotDryMountOptions): LoadedConfig<CoreConfig> {
  const { botDir, dataDir, memoryDir } = deploymentDirs(opts);
  return {
    config,
    secret: () => '',
    rootDir: botDir,
    memoryDir,
    dataDir,
    packageDir: opts.packageDir,
    providersDir: join(botDir, 'providers'),
    repoRoot: opts.repoRoot ?? botDir,
  };
}

export function dryMountBot(def: BotDefinition<CoreConfig>, opts: BotDryMountOptions): DryMountReport {
  const report: DryMountReport = { ok: [], warnings: [], failures: [] };
  const { ok, warnings, failures } = report;

  let config: unknown;
  try {
    config = def.defaults();
  } catch (error) {
    failures.push(`defaults() threw: ${message(error)}`);
    return report;
  }
  if (!isPlainObject(config)) {
    failures.push('defaults() must return a config object.');
    return report;
  }
  (config as { worlds?: unknown }).worlds ??= {};
  ok.push('defaults() returns an object.');

  for (const decl of def.declares ?? []) {
    const shaped = typeof decl === 'string' ? decl !== '' : isPlainObject(decl) && typeof decl.id === 'string' && typeof decl.label === 'string';
    if (!shaped) failures.push(`An entry in declares is malformed: ${JSON.stringify(decl)} (expected a World id string or { id, label, reason? }).`);
  }
  if (def.declares?.length) ok.push(`declares: ${def.declares.map((d) => (typeof d === 'string' ? d : d.id)).join(', ')}`);

  const loaded = fakeLoadedConfig(config as unknown as CoreConfig, opts);
  let parts: ReturnType<typeof def.build>;
  try {
    parts = def.build(loaded, []);
  } catch (error) {
    failures.push(`build() threw in the fake deployment (default config, empty Memory, no secrets): ${message(error)}. build() must succeed with this config.`);
    return report;
  }
  const persona = parts?.persona as unknown;
  if (!isPlainObject(persona)) {
    failures.push('build() did not return a persona.');
    return report;
  }
  for (const method of ['systemSegments', 'attach', 'declareSessions'] as const) {
    if (typeof persona[method] !== 'function') failures.push(`persona lacks ${method}(), which the Persona contract requires.`);
  }
  if (typeof persona.memoryDir !== 'string') failures.push('persona.memoryDir is not a string: it must be the absolute path of the Memory directory.');
  const blobs = persona.blobs as Record<string, unknown> | undefined;
  if (!isPlainObject(blobs) || ['put', 'get', 'list'].some((m) => typeof blobs[m] !== 'function')) {
    failures.push('persona.blobs is not a BlobStore (put / get / list): mem: handles have no backend.');
  }
  if (!failures.length) ok.push('build() returns a Persona with every member the contract requires.');
  if (typeof def.memoryName !== 'string' || def.memoryName === '') {
    warnings.push('BotDefinition has no memoryName: the Memory page title falls back to the class name of persona.memory, then to "Memory".');
  }

  const prebuilt = parts.worlds ?? [];
  const ids = new Set<string>();
  for (const world of prebuilt) {
    if (ids.has(world.id)) failures.push(`Duplicate prebuilt World id: ${world.id}.`);
    ids.add(world.id);
  }
  if (prebuilt.length) ok.push(`Prebuilt Worlds: ${[...ids].join(', ')} (a restart reuses these instances).`);

  for (const group of parts.webUi?.configGroups ?? []) {
    if (group.owner !== 'persona') warnings.push(`Config group "${group.id}" has owner "${group.owner}"; a Persona's config group owner must be persona.`);
    failures.push(...configPathProblems(group, '', config));
  }
  return report;
}
