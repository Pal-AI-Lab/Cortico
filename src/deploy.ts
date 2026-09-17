/**
 * 部署配置按顺序深合并：BotDefinition.defaults()、包内 World 覆盖、共享端点表、部署 config.json。
 * 部署文件中的 providers 字段不参与合并。Core、Persona 与 World 的默认值由各自所有者提供。
 * 运行时共享合并后的配置对象，控制台和调参工具原位更新。
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { CoreConfig, LLMProviderEntry } from './core/types.ts';
import { deepMerge, type LoadedConfig } from './core/config.ts';
import { secretReader } from './core/secrets.ts';
import { readTextFile } from './core/util.ts';
import { deploymentRoot, repoRoot as codeRepoRoot } from './paths.ts';

export type { LoadedConfig } from './core/config.ts';

/** 部署根下每个含 deployment.json 的目录就是一份可启动的部署。 */
export function listBots(root = deploymentRoot()): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => {
      const dir = resolve(root, name);
      return statSync(dir).isDirectory() && existsSync(resolve(dir, 'deployment.json'));
    })
    .sort();
}

/** 部署根下一份部署都没有时自建的那份，以及它引用的 bot 代码包。 */
export const DEFAULT_DEPLOYMENT = { name: 'mybot', bot: 'cormini' } as const;

/**
 * 开场引导的一次性标记，放在部署目录下。自建部署时写入，控制台见到它才给引导，操作员
 * 开口或按下那颗按钮后删除。手动建的部署没有这个文件，也就不会看到引导。
 */
export const ONBOARDING_FLAG_FILE = '.onboarding';

/** 部署根下另有用途的目录名，不能拿来当部署名。 */
const RESERVED_DEPLOYMENT_NAMES: readonly string[] = ['providers', 'runtimes', 'models'];

/** 部署目录名不合用的原因；合用时为 null。这个名字就是目录名，也出现在命令行上。 */
export function deploymentNameProblem(name: string, taken: readonly string[]): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return '只能用字母、数字、- . _，且以字母或数字开头。';
  }
  if (RESERVED_DEPLOYMENT_NAMES.includes(name)) return `${name} 是部署根下的固定目录。`;
  if (taken.includes(name)) return `${name} 已经有了。`;
  return null;
}

/**
 * 建一份空白部署：`deployment.json` 指向代码包，加上开场引导的标记；给了展示名就写一份
 * 只有 `displayName` 的 `config.json`。端点与其余设置在控制台里配。
 */
export function createDeployment(
  options: { name: string; bot: string; displayName?: string; root?: string },
): string {
  const root = options.root ?? deploymentRoot();
  const problem = deploymentNameProblem(options.name, listBots(root));
  if (problem) throw new Error(problem);
  const dir = resolve(root, options.name);
  mkdirSync(dir, { recursive: true });
  writeJson(resolve(dir, 'deployment.json'), { bot: options.bot });
  if (options.displayName) writeJson(resolve(dir, 'config.json'), { displayName: options.displayName });
  writeFileSync(resolve(dir, ONBOARDING_FLAG_FILE), '', 'utf8');
  return options.name;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** 返回一个可启动的部署名；部署根下一份都没有时先建 DEFAULT_DEPLOYMENT。 */
export function ensureDeployment(root = deploymentRoot()): string {
  const existing = listBots(root);
  if (existing.length > 0) return existing[0];
  return createDeployment({ ...DEFAULT_DEPLOYMENT, root });
}

export interface DeploymentSource<C extends CoreConfig> {
  /** 每次返回独立的合并默认值。 */
  defaults(): C;
}

/**
 * 读取 <部署根>/providers/<端点名>/config.json，供同一部署根下的部署共享。
 * 同名条目覆盖 Core 默认端点；目录内的密钥与其他状态由 provider 管理。
 */
function globalProviders(providersDir: string): Record<string, LLMProviderEntry> {
  if (!existsSync(providersDir)) return {};
  const table: Record<string, LLMProviderEntry> = {};
  for (const name of readdirSync(providersDir)) {
    const file = resolve(providersDir, name, 'config.json');
    if (!existsSync(file)) continue;
    try {
      table[name] = JSON.parse(readTextFile(file)) as LLMProviderEntry;
    } catch (err) {
      throw new Error(`${file} 解析失败:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return table;
}

/**
 * 代码包在 worlds/<id>/config.json 提供 World 配置覆盖；部署 config.json 可继续覆盖。
 * 路径、设备与端口等本机配置由部署提供。
 */
function packageWorldOverrides(pkgDir: string): Record<string, unknown> {
  const ioDir = resolve(pkgDir, 'worlds');
  if (!existsSync(ioDir)) return {};
  const worlds: Record<string, unknown> = {};
  for (const id of readdirSync(ioDir)) {
    const file = resolve(ioDir, id, 'config.json');
    if (!existsSync(file)) continue;
    try {
      worlds[id] = JSON.parse(readTextFile(file));
    } catch (err) {
      throw new Error(`${file} 解析失败:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return Object.keys(worlds).length ? { worlds } : {};
}

/**
 * 加载部署并解析目录：
 * botDir 是部署目录，config.json、.env 及相对 memory/data 路径以它为基准。
 * repoRoot 是代码检出目录，用于扩展与代码信息。
 * pkgDir 是代码包目录，供模板和包内资产使用；缺省为 botDir。
 * providersDir 是共享端点目录；缺省为 <botDir>/providers。
 */
export function loadDeployment<C extends CoreConfig>(
  source: DeploymentSource<C>,
  botDir: string,
  repoRoot: string = codeRepoRoot(),
  pkgDir: string = botDir,
  providersDir: string = resolve(botDir, 'providers'),
): LoadedConfig<C> {
  const dir = resolve(botDir);
  const root = resolve(repoRoot);
  const providers = resolve(providersDir);
  const cfgPath = resolve(dir, 'config.json');
  const raw: Partial<C> & Record<string, unknown> = existsSync(cfgPath)
    ? (JSON.parse(readTextFile(cfgPath)) as Partial<C> & Record<string, unknown>)
    : {};
  // 部署文件不能覆盖共享端点表。
  delete raw.providers;
  // source.defaults() 已包含各所有者默认值，后续层依次覆盖。
  const config = deepMerge(
    deepMerge(
      deepMerge(source.defaults(), packageWorldOverrides(resolve(pkgDir)) as Partial<C>),
      { providers: globalProviders(providers) } as Partial<C>,
    ),
    raw,
  );

  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(dir, p));
  return {
    config,
    secret: secretReader(resolve(dir, '.env')),
    rootDir: dir,
    packageDir: resolve(pkgDir),
    providersDir: providers,
    repoRoot: root,
    memoryDir: abs(config.paths.memory),
    dataDir: abs(config.paths.data),
  };
}
