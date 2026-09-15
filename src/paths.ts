/**
 * repoRoot() 返回当前代码检出目录，mainRepoRoot() 返回所属主仓库目录。
 * deploymentRoot() 解析运行数据根；每份部署的 deployment.json 指定 bot 代码包，
 * 同一代码包可供多个部署使用。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readTextFile } from './core/util.ts';

/** 默认部署目录，相对主仓库根；该目录不纳入版本控制。 */
const DEFAULT_DEPLOYMENT_DIRNAME = 'deployments';

/** 仓内 bot 代码包目录名，相对主仓库根；不受 CORTICO_HOME 影响。 */
const PACKAGES_DIRNAME = 'bots';

/** 共享端点目录名，相对部署根；没有 deployment.json，因此不列为部署。 */
const PROVIDERS_DIRNAME = 'providers';

/** 外部运行程序与模型文件的共享目录名，相对部署根。 */
const RUNTIMES_DIRNAME = 'runtimes';
const MODELS_DIRNAME = 'models';

/** 部署根的环境变量名。进程环境与仓库根 `.env` 用同一个名字。 */
export const DEPLOYMENT_ROOT_ENV = 'CORTICO_HOME';

let repoRootCache: string | null = null;
let mainRepoRootCache: string | null = null;
let deploymentRootCache: string | null = null;

/** 这份代码包所在的检出根(src/ 的上一级)。 */
export function repoRoot(): string {
  if (repoRootCache === null) repoRootCache = resolve(import.meta.dirname, '..');
  return repoRootCache;
}

/**
 * 根据 git --git-common-dir 解析主仓库根；worktree 使用共享 .git 的父目录。
 * Git 不可用或目录不属于仓库时返回 from。
 */
export function resolveMainRepoRoot(from: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: from,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return from;
    return dirname(isAbsolute(out) ? resolve(out) : resolve(from, out));
  } catch {
    return from;
  }
}

/** 主仓库的根。worktree 里指回主检出,不是当前 worktree。 */
export function mainRepoRoot(): string {
  if (mainRepoRootCache === null) mainRepoRootCache = resolveMainRepoRoot(repoRoot());
  return mainRepoRootCache;
}

/** 读取当前检出根 .env 中的 CORTICO_HOME，支持引号与包含空格的路径。 */
function readDeploymentRootFromEnvFile(checkoutRoot: string): string {
  const file = resolve(checkoutRoot, '.env');
  if (!existsSync(file)) return '';
  const m = new RegExp(`^[ \\t]*${DEPLOYMENT_ROOT_ENV}[ \\t]*=[ \\t]*(.*)$`, 'm').exec(
    readTextFile(file),
  );
  const raw = m ? m[1].trim() : '';
  return raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'")) && raw.endsWith(raw[0])
    ? raw.slice(1, -1).trim()
    : raw;
}

/**
 * 依次使用进程 CORTICO_HOME、当前检出根 .env、默认目录名。
 * 相对路径以主仓库根为基准，绝对路径规范化后使用。
 */
export function resolveDeploymentRoot(
  env: NodeJS.ProcessEnv,
  checkoutRoot: string,
  mainRoot: string,
): string {
  const raw = (env[DEPLOYMENT_ROOT_ENV] ?? '').trim() || readDeploymentRootFromEnvFile(checkoutRoot);
  if (!raw) return resolve(mainRoot, DEFAULT_DEPLOYMENT_DIRNAME);
  return isAbsolute(raw) ? resolve(raw) : resolve(mainRoot, raw);
}

/** 部署根:所有部署目录的父目录。进程内解析一次。 */
export function deploymentRoot(): string {
  if (deploymentRootCache === null) {
    deploymentRootCache = resolveDeploymentRoot(process.env, repoRoot(), mainRepoRoot());
  }
  return deploymentRootCache;
}

/** 部署目录，包含 deployment.json、配置、密钥和运行数据。 */
export function deploymentDir(name: string): string {
  return resolve(deploymentRoot(), name);
}

/** 同一部署根下共用的 provider 端点目录。 */
export function providersRoot(): string {
  return resolve(deploymentRoot(), PROVIDERS_DIRNAME);
}

/**
 * 端点目录以 config.providers 的键命名；同一 provider 模块可有多个端点。
 * 目录内部结构由 provider 管理。
 */
export function providerDir(name: string): string {
  return resolve(providersRoot(), name);
}

/**
 * 运行时根:`<部署根>/runtimes/<运行时 id>/<版本>/`,一个版本一个目录,可并存。
 * 目录内部的布局归下载它的那个模块。
 */
export function runtimesRoot(): string {
  return resolve(deploymentRoot(), RUNTIMES_DIRNAME);
}

/** 模型文件根:`<部署根>/models/<owner>/`,owner 是 provider id 或 World id。 */
export function modelsRoot(): string {
  return resolve(deploymentRoot(), MODELS_DIRNAME);
}

/** 仓内 bot 代码包目录；扩展包由扩展装载器另行定位。 */
export function packageDir(bot: string): string {
  return resolve(mainRepoRoot(), PACKAGES_DIRNAME, bot);
}

/** 一份部署的 `deployment.json`。 */
export interface DeploymentManifest {
  /** 这份部署引用哪个 bot 代码包。 */
  bot: string;
}

/**
 * 读一份部署的 `deployment.json`。文件不在回 null;文件在而读不成一个带 `bot` 的对象就抛,
 * 消息里带上是哪一步不成。
 */
export function readDeploymentManifest(name: string): DeploymentManifest | null {
  const file = resolve(deploymentDir(name), 'deployment.json');
  if (!existsSync(file)) return null;
  let raw: { bot?: unknown };
  try {
    raw = JSON.parse(readTextFile(file)) as { bot?: unknown };
  } catch (err) {
    throw new Error(`${file} 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw.bot !== 'string' || !raw.bot.trim()) {
    throw new Error(`${file} 没有 bot 字段`);
  }
  return { bot: raw.bot.trim() };
}
