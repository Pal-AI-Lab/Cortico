/**
 * 启动器菜单的数据：每份部署的代码包、展示名与配色，以及可选的 bot 代码包清单。
 * 颜色在这里解析成 `#rrggbb`，启动器只负责画；配色取部署的 theme.json，没有则取 web.theme。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { normalizeStoredTheme, resolvePalette, type ThemeAppearance } from './web/shared/theme.ts';
import { THEME_FILE } from './web/theme-store.ts';

/** 菜单一行用得到的几个颜色。 */
export interface RowColors {
  /** bot id */
  accent: string;
  /** 展示名 */
  accent2: string;
  /** 选中行的路径 */
  ink: string;
  /** 未选中行的路径 */
  inkDim: string;
  /** 读不出代码包时的那行原因 */
  danger: string;
}

export interface DeploymentRow {
  name: string;
  /** 相对部署根的路径,菜单里就显示它。 */
  dir: string;
  /** deployment.json 引用的代码包。 */
  bot: string;
  displayName: string;
  colors: RowColors;
  /** 代码包读不出来时的原因;这一行仍然列出,选中它启动会得到同样的错。 */
  problem?: string;
}

export interface BotPackageRow {
  id: string;
  source: 'tree' | 'extension';
  displayName: string;
  colors: RowColors;
}

export interface LauncherListing {
  /** 部署根的绝对路径,菜单顶上打一行。 */
  root: string;
  deployments: DeploymentRow[];
  packages: BotPackageRow[];
}

/** 一个 bot 代码包的默认值里，菜单要用的那两项。 */
export interface BotDefaults {
  displayName: string;
  /** 代码包选的配色方案 id。 */
  scheme: string;
}

export interface ListingSource {
  root: string;
  deployments: readonly string[];
  packages: readonly { id: string; source: 'tree' | 'extension' }[];
  /** 读代码包的默认值；包不在或读不出就抛，原因进那一行。 */
  defaultsOf(bot: string): Promise<BotDefaults>;
}

/** 命令行按深色底算；部署把明暗钉在浅色时才取浅色那份。 */
function appearanceOf(mode: string): ThemeAppearance {
  return mode === 'light' ? 'light' : 'dark';
}

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 颜色：WebUI 存过的那套赢过代码包与部署配置里的默认方案 id；认不出的方案 id 落到框架
 * 默认方案。dir 为 null = 还没有部署目录（新建流程里的代码包），只看方案 id。
 */
export function colorsOf(dir: string | null, defaultScheme: string): RowColors {
  const stored = dir === null ? null : readJson(resolve(dir, THEME_FILE));
  const state = stored
    ? normalizeStoredTheme(stored)
    : normalizeStoredTheme({ selectedId: defaultScheme, mode: 'system', custom: [] });
  const palette = resolvePalette(state, appearanceOf(state.mode));
  return {
    accent: palette.accent,
    accent2: palette['accent-2'],
    ink: palette.ink,
    inkDim: palette['ink-dim'],
    danger: palette.danger,
  };
}

/** 部署配置里的 displayName 与 web.theme；文件不在或读不出就当没写。 */
function deploymentConfig(dir: string): { displayName?: string; scheme?: string } {
  const raw = readJson(resolve(dir, 'config.json'));
  const web = raw?.web as { theme?: unknown } | undefined;
  return {
    ...(typeof raw?.displayName === 'string' ? { displayName: raw.displayName } : {}),
    ...(typeof web?.theme === 'string' ? { scheme: web.theme } : {}),
  };
}

export async function buildListing(source: ListingSource): Promise<LauncherListing> {
  const cache = new Map<string, Promise<BotDefaults>>();
  const defaultsOf = (bot: string): Promise<BotDefaults> => {
    const hit = cache.get(bot);
    if (hit) return hit;
    const pending = source.defaultsOf(bot);
    cache.set(bot, pending);
    return pending;
  };

  const deployments: DeploymentRow[] = [];
  for (const name of source.deployments) {
    const dir = resolve(source.root, name);
    const manifest = readJson(resolve(dir, 'deployment.json'));
    const bot = typeof manifest?.bot === 'string' ? manifest.bot : '';
    const config = deploymentConfig(dir);
    let defaults: BotDefaults | null = null;
    let problem: string | undefined;
    try {
      defaults = await defaultsOf(bot);
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    deployments.push({
      name,
      dir: `${basename(source.root)}/${name}`,
      bot,
      displayName: config.displayName ?? defaults?.displayName ?? '',
      colors: colorsOf(dir, config.scheme ?? defaults?.scheme ?? ''),
      ...(problem ? { problem } : {}),
    });
  }

  const packages: BotPackageRow[] = [];
  for (const pkg of source.packages) {
    let defaults: BotDefaults;
    try {
      defaults = await defaultsOf(pkg.id);
    } catch {
      // 装不上的包不能拿来建部署。
      continue;
    }
    packages.push({
      id: pkg.id,
      source: pkg.source,
      displayName: defaults.displayName,
      colors: colorsOf(null, defaults.scheme),
    });
  }

  return { root: source.root, deployments, packages };
}
