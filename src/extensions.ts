/**
 * 扩展是 extensions/ 下的 npm 包，manifest.kind 为 world、provider 或 bot。
 * 启动时读取直接依赖并分别校验 manifest、默认导出、id 命名空间与 WebUI 页前缀。
 * 单包失败不阻止其他包加载；安装或卸载后需重启进程，ESM 模块不会在运行时替换。
 * 仅导入 deployment.json 选定的 bot；其他 bot 包记为 idle，仓内同名 bot 优先。
 * 扩展包目录只读，避免修改 pnpm store 的硬链接文件；模板写入规则见 src/bot.ts。
 * 扩展提供包内相对产物路径，服务端校验后分配 URL，只提供已声明文件。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CoreConfig, Logger } from './core/types.ts';
import { LocalizedError, type Language } from './core/language.ts';
import type { BotDefinition } from './bot.ts';
import type { WorldDefinition, WorldSection } from './world.ts';
import type { ProviderModule } from './providers/base.ts';
import type {
  ExtensionInfo,
  ExtensionInstallTarget,
  ExtensionPackageDetail,
  ExtensionSearchHit,
  ExtensionUpdateResult,
} from './web/server.ts';
import {
  EXTENSION_API_VERSIONS,
  EXTENSION_KEYWORDS,
  ICON_TYPES,
  parseExtensionManifest,
  type ExtensionWebUiAsset,
  type ExtensionKind,
  type ExtensionPackageJson,
} from './extensions/manifest.ts';
import { registerFrameworkResolver } from './extensions/runtime.ts';
import { adaptBotDefinition, adaptProviderModule, adaptWorldDefinition, isPreviousContract } from './extensions/previous-contract.ts';
import { text } from './extensions/strings.ts';
import { repoRoot } from './paths.ts';
import { pageIdFor, type ContributingKind } from './web/shared/webui-protocol.ts';

export const EXTENSIONS_DIRNAME = 'extensions';

/** 每类扩展的 WebUI 页前缀。 */
export const EXTENSION_PAGE_KIND: Readonly<Record<ExtensionKind, ContributingKind>> = {
  world: 'world',
  provider: 'llm',
  bot: 'persona',
};

/** 一个已安装包在本进程启动时的加载结果。 */
export interface ExtensionRecord {
  name: string;
  /** extensions/package.json 里写的版本范围或 `link:` 路径。 */
  spec: string;
  /** 磁盘上的版本;node_modules 里没有这个包时为 null。 */
  version: string | null;
  description?: string;
  /** manifest 里的类别;package.json 解析不出 manifest 时缺席。 */
  kind?: ExtensionKind;
  /** 扩展声明的契约版本(`cortico.api`)。 */
  api?: number;
  /** `api` 是上一版契约,经 previous-contract.ts 加载。 */
  previousContract?: true;
  /** manifest 的 warning,按界面语言给。 */
  warnings?: (language: Language) => string[];
  /** 包声明了浏览器端产物(`cortico.webUiClient`)。 */
  webUiClient: boolean;
  /** 浏览器产物状态：none=未声明，served=文件可提供，missing=声明的文件不存在。 */
  webUi?: 'none' | 'served' | 'missing';
  loaded: boolean;
  /** bot 包装了但这份部署没引用它:没有 import,不算失败。 */
  idle?: true;
  /** 没装上的原因,按界面语言给。 */
  reason?: (language: Language) => string;
  /** 默认导出的 id:World id、provider id 或 bot id,按 kind 解释。 */
  worldId?: string;
  label?: string;
}

export interface ExtensionSet {
  dir: string;
  records: ExtensionRecord[];
  worlds: WorldDefinition<WorldSection>[];
  providers: ProviderModule[];
  /** 已加载的扩展里带浏览器端产物的那些;服务端据此分配 URL 并只发这几个文件。 */
  webUiAssets: ExtensionWebUiAsset[];
  /** 这份部署的 bot 来自扩展包时是它;仓内 bot 则缺席。 */
  bot?: ActiveBotPackage;
}

/** 启动器已经 import 过的那个 bot 包:包名与 `BotDefinition.id`。 */
export interface ActiveBotPackage {
  name: string;
  id: string;
}

/** 程序装在只读位置时(比如 macOS 的 .app),应用把它指到可写的目录。 */
export const EXTENSIONS_DIR_ENV = 'CORTICO_EXTENSIONS_DIR';

export function extensionsDir(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[EXTENSIONS_DIR_ENV] ?? '').trim();
  return raw ? resolve(raw) : join(repoRoot, EXTENSIONS_DIRNAME);
}

function readPackageJson(file: string): ExtensionPackageJson | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as ExtensionPackageJson;
}

/** 读取 extensions/package.json 的直接依赖；目录不存在时返回空列表。 */
export function readInstalled(dir: string): Array<{ name: string; spec: string }> {
  const pkg = readPackageJson(join(dir, 'package.json'));
  return Object.entries(pkg?.dependencies ?? {}).map(([name, spec]) => ({ name, spec }));
}

/**
 * 包的 ESM 入口:`exports`(字符串或 `.` 条目的 import/default)→ `module` → `main` → index.js。
 * 只认这几层;更复杂的 exports 条件表由包在 `main` 里给一个平坦入口。
 */
export function resolveExtensionEntry(pkgDir: string, pkg: ExtensionPackageJson): string {
  const pick = (v: unknown): string | null => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return pick(o['.'] ?? o.import ?? o.default ?? null);
    }
    return null;
  };
  const rel = pick(pkg.exports) ?? pkg.module ?? pkg.main ?? 'index.js';
  return join(pkgDir, rel);
}

export function isWorldDefinition(v: unknown): v is WorldDefinition<WorldSection> {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return typeof d.id === 'string' && d.id !== ''
    && typeof d.label === 'string'
    && typeof d.defaults === 'function'
    && typeof d.create === 'function';
}

export function isProviderModule(v: unknown): v is ProviderModule {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return typeof d.id === 'string' && d.id !== ''
    && typeof d.title === 'string'
    && Array.isArray(d.reasoningTiers)
    && Array.isArray(d.serviceTiers)
    && typeof d.create === 'function';
}

export function isBotDefinition(v: unknown): v is BotDefinition<CoreConfig> {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return typeof d.id === 'string' && d.id !== ''
    && typeof d.defaults === 'function'
    && typeof d.build === 'function';
}

const SHAPE_NEEDS: Readonly<Record<ExtensionKind, readonly [type: string, members: string]>> = {
  world: ['WorldDefinition', 'id / label / defaults() / create()'],
  provider: ['ProviderModule', 'id / title / reasoningTiers / serviceTiers / create()'],
  bot: ['BotDefinition', 'id / defaults() / build()'],
};

/** 默认导出与 `cortico.kind` 对不上时给作者的一句话。装载器与 `check:extension` 共用。 */
export function extensionShapeMismatch(kind: ExtensionKind, language: Language = 'zh'): string {
  return text(language).shapeMismatch(kind, ...SHAPE_NEEDS[kind]);
}

function extensionError(message: (t: ReturnType<typeof text>) => string, status?: number): LocalizedError {
  return new LocalizedError((language) => message(text(language)), status);
}

function errorText(err: unknown, language: Language): string {
  if (err instanceof LocalizedError) return err.describe(language);
  return err instanceof Error ? err.message : String(err);
}

/** 解析包内相对路径；超出包目录或文件不存在时返回 null。 */
export function extensionPackageFile(pkgDir: string, relative: string): string | null {
  const abs = resolve(pkgDir, relative);
  if (!abs.startsWith(resolve(pkgDir) + sep)) return null;
  return existsSync(abs) ? abs : null;
}

/** 包声明的图标文件:`cortico.icon` 解析得出且文件在包目录里;否则 null,WebUI 显示默认头像。 */
export function extensionIconFile(pkgDir: string, pkg: ExtensionPackageJson): { file: string; type: string } | null {
  const parsed = parseExtensionManifest(pkg);
  const icon = parsed.ok ? parsed.manifest.icon : undefined;
  const file = icon ? extensionPackageFile(pkgDir, icon) : null;
  if (!icon || !file) return null;
  return { file, type: ICON_TYPES[icon.slice(icon.lastIndexOf('.')).toLowerCase()] };
}

// bot 包:定位与 import(启动器在装载其它扩展之前做)

export type BotPackageLocation =
  | { source: 'tree'; pkgDir: string; entry: string }
  | { source: 'extension'; name: string; pkgDir: string; entry: string; previousContract: boolean };

/**
 * `deployment.json` 的 `bot` 字段是包标识,两处找,仓内赢:`treeDir`(`bots/<bot>/`)下有
 * `index.ts` 就是仓内包;否则 `extensions/package.json` 的 dependencies 里有这个名字,且它的
 * manifest 是 `kind: "bot"`。都没有就报错,两处路径都列出来。
 */
export function locateBotPackage(repoRoot: string, ref: string, treeDir: string): BotPackageLocation {
  const treeEntry = join(treeDir, 'index.ts');
  if (existsSync(treeEntry)) return { source: 'tree', pkgDir: treeDir, entry: treeEntry };
  const dir = extensionsDir(repoRoot);
  if (!readInstalled(dir).some((p) => p.name === ref)) {
    throw new Error(`找不到 bot 代码包「${ref}」:仓内没有 ${treeEntry},${dir} 下也没装叫这个名字的扩展。`);
  }
  const pkgDir = join(dir, 'node_modules', ...ref.split('/'));
  const pkg = readPackageJson(join(pkgDir, 'package.json'));
  if (!pkg) throw new Error(`扩展「${ref}」登记在 ${dir} 的 package.json 里,但 node_modules 里没有它;在 extensions/ 下重新安装一次。`);
  const parsed = parseExtensionManifest(pkg);
  if (!parsed.ok) throw new Error(`扩展「${ref}」装不上: ${parsed.reasons.join(';')}`);
  if (parsed.manifest.kind !== 'bot') {
    throw new Error(`「${ref}」是 ${parsed.manifest.kind} 类扩展,不是 bot 包;deployment.json 的 bot 字段要指向 cortico.kind 为 "bot" 的包。`);
  }
  return {
    source: 'extension', name: ref, pkgDir, entry: resolveExtensionEntry(pkgDir, pkg),
    previousContract: isPreviousContract(parsed.manifest.kind, parsed.manifest.api),
  };
}

/**
 * import 定位到的 bot 包并校验默认导出。扩展来源的 bot 其 id 不得与仓内 `bots/` 任一目录同名:
 * WebUI 按 `persona:<id>` 找面板产物,构建产物表里同 key 的仓内页优先,撞名会拿到仓内那份面板。
 */
export async function importBotDefinition(
  location: BotPackageLocation,
  opts: { treeHas: (id: string) => boolean },
): Promise<BotDefinition<CoreConfig>> {
  registerFrameworkResolver();
  const mod = (await import(pathToFileURL(location.entry).href)) as { default?: unknown };
  if (!isBotDefinition(mod.default)) {
    throw new Error(location.source === 'tree'
      ? `${location.entry} 没有默认导出一个 BotDefinition`
      : `扩展「${location.name}」${extensionShapeMismatch('bot')}`);
  }
  if (location.source === 'extension' && opts.treeHas(mod.default.id)) {
    throw new Error(`扩展「${location.name}」的 bot id「${mod.default.id}」与仓内 bots/${mod.default.id}/ 撞名;WebUI 面板产物按 persona:<id> 找,会拿到仓内那份。换一个 id。`);
  }
  return location.source === 'extension' && location.previousContract ? adaptBotDefinition(mod.default) : mod.default;
}

/**
 * 加载扩展 World 与 provider；id 与内建冲突时拒绝，扩展间重名时保留先加载项。
 * 两个 kind 使用独立命名空间。activeBot 已由启动器导入，此处只标记 loaded，其他 bot 记 idle。
 */
export async function loadExtensions(
  repoRoot: string,
  opts: { reserved?: Iterable<string>; reservedProviders?: Iterable<string>; activeBot?: ActiveBotPackage; log?: Logger } = {},
): Promise<ExtensionSet> {
  registerFrameworkResolver();
  const dir = extensionsDir(repoRoot);
  const taken: Record<Exclude<ExtensionKind, 'bot'>, Set<string>> = {
    world: new Set(opts.reserved ?? []),
    provider: new Set(opts.reservedProviders ?? []),
  };
  const records: ExtensionRecord[] = [];
  const worlds: WorldDefinition<WorldSection>[] = [];
  const providers: ProviderModule[] = [];
  const webUiAssets: ExtensionWebUiAsset[] = [];
  for (const { name, spec } of readInstalled(dir)) {
    const pkgDir = join(dir, 'node_modules', ...name.split('/'));
    const pkg = readPackageJson(join(pkgDir, 'package.json'));
    const record: ExtensionRecord = {
      name,
      spec,
      version: pkg?.version ?? null,
      webUiClient: false,
      loaded: false,
      ...(pkg?.description ? { description: pkg.description } : {}),
    };
    records.push(record);
    if (!pkg) {
      record.reason = (language) => text(language).notInNodeModules;
      continue;
    }
    const parsed = parseExtensionManifest(pkg);
    for (const warning of parsed.warnings) opts.log?.warn(`扩展 manifest: ${name} — ${warning}`);
    if (!parsed.ok) {
      record.reason = (language) => {
        const result = parseExtensionManifest(pkg, language);
        return result.ok ? '' : result.reasons.join(' ');
      };
      continue;
    }
    const { kind, api, webUiClient, webUiStyle } = parsed.manifest;
    record.kind = kind;
    record.api = api;
    const previousContract = isPreviousContract(kind, api);
    if (previousContract) record.previousContract = true;
    if (parsed.warnings.length) record.warnings = (language) => parseExtensionManifest(pkg, language).warnings;
    record.webUiClient = webUiClient !== undefined;

    // 缺少面板产物不阻止定义加载。
    const jsFile = webUiClient === undefined ? null : extensionPackageFile(pkgDir, webUiClient);
    record.webUi = webUiClient === undefined ? 'none' : jsFile ? 'served' : 'missing';
    if (webUiClient !== undefined && !jsFile) {
      opts.log?.warn(`扩展声明的 WebUI 产物不在: ${name} — ${webUiClient}`);
    }
    const cssFile = webUiStyle !== undefined && jsFile ? extensionPackageFile(pkgDir, webUiStyle) : null;
    if (webUiStyle !== undefined && jsFile && !cssFile) {
      opts.log?.warn(`扩展声明的 WebUI 样式不在,面板按无样式发: ${name} — ${webUiStyle}`);
    }

    const serveAsset = (id: string): void => {
      if (!jsFile) return;
      webUiAssets.push({
        pageId: pageIdFor(EXTENSION_PAGE_KIND[kind], id),
        packageName: name,
        version: pkg.version ?? '0',
        jsFile,
        ...(cssFile ? { cssFile } : {}),
      });
    };

    if (kind === 'bot') {
      if (opts.activeBot?.name !== name) {
        record.idle = true;
        continue;
      }
      record.worldId = opts.activeBot.id;
      record.loaded = true;
      serveAsset(opts.activeBot.id);
      continue;
    }

    const entry = resolveExtensionEntry(pkgDir, pkg);
    let exported: unknown;
    try {
      exported = ((await import(pathToFileURL(entry).href)) as { default?: unknown }).default;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      record.reason = (language) => text(language).importFailed(detail);
      opts.log?.warn(`扩展导入失败: ${name}`, { entry, error: detail });
      continue;
    }

    let id: string;
    if (kind === 'world') {
      if (!isWorldDefinition(exported)) {
        record.reason = (language) => extensionShapeMismatch('world', language);
        continue;
      }
      record.worldId = exported.id;
      if (taken.world.has(exported.id)) {
        const { id } = exported;
        record.reason = (language) => text(language).worldIdTaken(id);
        continue;
      }
      taken.world.add(exported.id);
      record.label = exported.label;
      worlds.push(previousContract ? adaptWorldDefinition(exported) : exported);
      id = exported.id;
    } else {
      if (!isProviderModule(exported)) {
        record.reason = (language) => extensionShapeMismatch('provider', language);
        continue;
      }
      record.worldId = exported.id;
      if (taken.provider.has(exported.id)) {
        const { id } = exported;
        record.reason = (language) => text(language).providerIdTaken(id);
        continue;
      }
      taken.provider.add(exported.id);
      record.label = exported.title;
      providers.push(previousContract ? await adaptProviderModule(exported) : exported);
      id = exported.id;
    }
    record.loaded = true;
    serveAsset(id);
  }
  const bot = opts.activeBot && records.some((r) => r.loaded && r.kind === 'bot') ? opts.activeBot : undefined;
  return { dir, records, worlds, providers, webUiAssets, ...(bot ? { bot } : {}) };
}

// 装卸与搜索(WebUI 那一面)

/** npm 包名。与 npm 自己的校验同形;不含任何 shell 元字符。 */
export const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/**
 * 版本或 dist-tag。`^` `~` `*` 之外的范围符号(`>=` `||`)不收:它们在 cmd.exe 里是
 * 重定向与管道,而 Windows 上 corepack 只能经 shell 起。
 */
const VERSION_SPEC = /^[0-9a-zA-Z.^~*+-]{1,64}$/;

/** 比较 npm 的标准 SemVer；无法比较时不猜测是否有更新。 */
function newerVersion(latest: string, installed: string): boolean | null {
  const parse = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  const a = parse(latest);
  const b = parse(installed);
  if (!a || !b) return null;
  for (let i = 1; i <= 3; i++) {
    const left = BigInt(a[i]);
    const right = BigInt(b[i]);
    if (left !== right) return left > right;
  }
  if (!a[4] && !b[4]) return false;
  if (!a[4]) return true;
  if (!b[4]) return false;
  const left = a[4].split('.');
  const right = b[4].split('.');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    const xNumeric = /^(0|[1-9]\d*)$/.test(left[i]);
    const yNumeric = /^(0|[1-9]\d*)$/.test(right[i]);
    if (xNumeric && yNumeric) return BigInt(left[i]) > BigInt(right[i]);
    if (xNumeric !== yNumeric) return !xNumeric;
    return left[i] > right[i];
  }
  return left.length > right.length;
}
/**
 * 一次失败的请求:`<主机>: <错误> (<cause 的错误码>: <cause 的说明>)`。undici 的错误文本固定是
 * `fetch failed`,出错的原因(证书不符、连接被拒、超时)只在 cause 里。
 */
export function fetchFailure(url: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err.cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code;
  const detail = cause instanceof Error ? [typeof code === 'string' ? code : '', cause.message].filter(Boolean).join(': ') : '';
  return `${new URL(url).host}: ${message}${detail ? ` (${detail})` : ''}`;
}

/** extensions/ 里的 npm 配置文件;`pnpm add` 与 `pnpm config get` 在这个目录跑,都读它。 */
const NPMRC = '.npmrc';
/**
 * 有它 pnpm 把 extensions/ 当作独立的工作区根:不并进外层仓库的工作区,读这里的 `allowBuilds` 与
 * pnpm 自己追加的 `minimumReleaseAgeExclude`。
 */
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
/** 构建脚本被跳过时 pnpm 照常退出 0;跳过的包由 `pendingBuilds()` 读出再处理。 */
const LENIENT_BUILDS = '--config.strict-dep-builds=false';

/** pnpm-workspace.yaml 顶层 `allowBuilds:` 下的各项与所在行号;作用域包名带引号。 */
function allowBuildsEntries(lines: readonly string[]): Array<{ line: number; indent: string; quote: string; name: string; value: string }> {
  const start = lines.findIndex((l) => /^allowBuilds:\s*$/.test(l));
  if (start < 0) return [];
  const entries = [];
  for (let i = start + 1; i < lines.length && /^\s/.test(lines[i]); i++) {
    const m = /^(\s+)(['"]?)(.+?)\2:\s*(.*?)\s*$/.exec(lines[i]);
    if (m) entries.push({ line: i, indent: m[1], quote: m[2], name: m[3], value: m[4] });
  }
  return entries;
}

/**
 * `allowBuilds` 里待定的值。pnpm 只在交互安装时给构建脚本被跳过的包写它;Cortico 起的 pnpm 不是交互的,
 * 由 `install()` 补写。
 */
const UNDECIDED_BUILD = 'set this to true or false';

/**
 * pnpm 在 node_modules/.modules.yaml(内容是 JSON)的 `ignoredBuilds` 里记下构建脚本被跳过的包,条目形如
 * `name@version`。文件缺失或读不出时为空。
 */
function ignoredBuilds(dir: string): string[] {
  const file = join(dir, 'node_modules', '.modules.yaml');
  if (!existsSync(file)) return [];
  let state: { ignoredBuilds?: unknown };
  try { state = JSON.parse(readFileSync(file, 'utf8')) as typeof state; } catch { return []; }
  if (!Array.isArray(state.ignoredBuilds)) return [];
  return state.ignoredBuilds.filter((e): e is string => typeof e === 'string').map((e) => /^(@?[^@]+)@/.exec(e)?.[1] ?? e);
}

/**
 * 构建脚本被跳过、还没定下的包名:`allowBuilds` 里值既不是 true 也不是 false 的,加上 `ignoredBuilds` 里
 * `allowBuilds` 还没有这一项的。
 */
function pendingBuilds(dir: string): string[] {
  const file = join(dir, WORKSPACE_FILE);
  const entries = existsSync(file) ? allowBuildsEntries(readFileSync(file, 'utf8').split(/\r?\n/)) : [];
  const undecided = entries.filter(({ value }) => value !== 'true' && value !== 'false').map(({ name }) => name);
  const unrecorded = ignoredBuilds(dir).filter((name) => !entries.some((e) => e.name === name));
  return [...new Set([...undecided, ...unrecorded])];
}

/** 把这些包在 `allowBuilds` 里的值写成 `value`,没有这一项的加上,其余行原样写回。 */
function setAllowBuilds(dir: string, names: readonly string[], value: string): void {
  if (!names.length) return;
  const file = join(dir, WORKSPACE_FILE);
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const entries = allowBuildsEntries(lines);
  for (const { line, indent, quote, name } of entries) {
    if (names.includes(name)) lines[line] = `${indent}${quote}${name}${quote}: ${value}`;
  }
  const indent = entries[0]?.indent ?? '  ';
  const added = names.filter((name) => !entries.some((e) => e.name === name))
    .map((name) => `${indent}${name.startsWith('@') ? `'${name}'` : name}: ${value}`);
  const start = lines.findIndex((l) => /^allowBuilds:\s*$/.test(l));
  if (start >= 0) {
    lines.splice(start + 1, 0, ...added);
  } else {
    while (lines.at(-1) === '') lines.pop();
    lines.push('allowBuilds:', ...added, '');
  }
  writeFileSync(file, lines.join(raw.includes('\r\n') ? '\r\n' : '\n'), 'utf8');
}
/** Cortico 自己 package.json 的 `packageManager`;发布到 npm 的 cortico 包没有这个字段。 */
function corticoPackageManager(): string | undefined {
  const { packageManager } = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as { packageManager?: unknown };
  return typeof packageManager === 'string' ? packageManager : undefined;
}
/** .npmrc 里设默认源的那一行;`@scope:registry=` 不算。 */
const REGISTRY_LINE = /^\s*registry\s*=(.*)$/;

/** 本地目录。排除 `%` `!` `"` 与重定向符,其余交给引号。 */
const LOCAL_PATH = /^[A-Za-z0-9_.\-/:\\ ~]{1,512}$/;

export type PackageManagerRunner = (args: string[], cwd: string) => Promise<{ code: number; output: string }>;

/** Windows 通过 shell 调用 corepack 的 .cmd 文件，参数逐个加引号。 */
export const runPnpm: PackageManagerRunner = (args, cwd) => new Promise((done, fail) => {
  const viaShell = process.platform === 'win32';
  const argv = ['pnpm', ...args].map((a) => (viaShell ? `"${a}"` : a));
  const child = spawn('corepack', argv, {
    cwd,
    shell: viaShell,
    windowsHide: true,
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.on('error', fail);
  child.on('close', (code) => done({ code: code ?? -1, output }));
});

interface RegistrySearchResponse {
  objects?: Array<{
    package?: {
      name?: string;
      version?: string;
      description?: string;
      keywords?: string[];
      date?: string;
      license?: string;
      links?: { npm?: string; homepage?: string; repository?: string };
      publisher?: { username?: string };
      maintainers?: Array<{ username?: string }>;
    };
    /** 被依赖的包数。热门包回字符串,新包回数字。 */
    dependents?: number | string;
    downloads?: { monthly?: number };
  }>;
  total?: number;
}

/** registry 的包文档(`GET /<name>`)。只列我们要读的字段。 */
interface RegistryPackument {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, ExtensionPackageJson & {
    license?: string;
    deprecated?: string;
    engines?: Record<string, string>;
    os?: string[];
    maintainers?: Array<{ username?: string; name?: string }>;
    _npmUser?: { name?: string };
    dist?: { unpackedSize?: number; fileCount?: number };
    homepage?: string;
    bugs?: { url?: string } | string;
    repository?: { url?: string } | string;
  }>;
  /** `created`、`modified` 和每个版本号各一条发布时间 */
  time?: Record<string, string>;
}

/** 一页取满 250:registry 的上限(传更大也只回 250)。 */
const SEARCH_PAGE_SIZE = 250;
/**
 * 最多翻四页。`keywords:` 过滤后的全集现在是个位数;真涨到一千条,说明关键字被滥用,
 * 再往后翻的也不是操作员要找的包。
 */
const SEARCH_MAX_HITS = 1000;

/**
 * npm 官方的下载统计。镜像 registry 没有这套数,不论安装走哪个 registry 都问这里。
 * 合批查询一次至多 128 个包、区间至多 365 天,且不收带 scope 的包名;单包查询的区间超过 18 个月会被截短。
 */
const DOWNLOADS_API = 'https://api.npmjs.org/downloads/point';
const DOWNLOADS_BULK_MAX = 128;
const DOWNLOADS_WINDOW_DAYS = 365;
/**
 * 搜索列表要等下载统计回来才出。实测一次统计请求 0.2–0.3 秒;连不上 api.npmjs.org 的机器
 * (registry 走镜像、npm 主站被挡)会卡到系统的连接超时,三秒没回就不要这一项。
 */
const DOWNLOADS_TIMEOUT_MS = 3000;
/** npm 下载统计的第一天,更早没有数据。 */
const DOWNLOADS_EPOCH = '2015-01-10';

/**
 * registry 给的仓库地址是 npm 规范化过的 `git+https://….git`:浏览器不认这个 scheme。
 * 收成可点的 https；认不出形状就原样返回，让操作员自己看。
 */
export function repositoryWebUrl(raw: string): string {
  let url = raw.trim().replace(/^git\+/, '').replace(/^git:\/\//, 'https://');
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(url);
  if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
  url = url.replace(/\.git$/, '');
  return /^https?:\/\//.test(url) ? url : raw;
}

/** `{ url }` 或裸串两种写法都收。 */
function urlOf(v: { url?: string } | string | undefined): string | undefined {
  const raw = typeof v === 'string' ? v : v?.url;
  return raw && raw.trim() ? raw.trim() : undefined;
}

/** package.json 的 author,只取名字。 */
export function packageAuthor(pkg: ExtensionPackageJson): string | undefined {
  // the string form is "Name <email> (url)"
  return (typeof pkg.author === 'string' ? pkg.author.match(/^[^(<]*/)![0].trim() : pkg.author?.name) || undefined;
}

/** 本机 package.json 里详情页显示的字段,与 npm 包文档同形;不联网就能给出。 */
export function packageMetadata(pkg: ExtensionPackageJson): Partial<ExtensionPackageDetail> {
  const parsed = parseExtensionManifest(pkg);
  const repository = urlOf(pkg.repository);
  const bugs = urlOf(pkg.bugs);
  return {
    ...(parsed.ok && parsed.manifest.displayName ? { displayName: parsed.manifest.displayName } : {}),
    ...(pkg.description ? { description: pkg.description } : {}),
    ...(pkg.license ? { license: pkg.license } : {}),
    ...(pkg.engines?.node ? { engines: pkg.engines.node } : {}),
    dependencies: Object.keys(pkg.dependencies ?? {}),
    ...(pkg.keywords?.length ? { keywords: pkg.keywords } : {}),
    links: {
      ...(repository ? { repository: repositoryWebUrl(repository) } : {}),
      ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
      ...(bugs ? { bugs } : {}),
    },
  };
}

export interface ExtensionManagerOptions {
  run?: PackageManagerRunner;
  /** 搜索、详情与检查更新用的 registry;缺省取 pnpm 安装时用的那个(`pnpm config get registry`)。 */
  registry?: string;
  fetchJson?: (url: string) => Promise<unknown>;
  /** 随框架提供的 World 与 provider,与已装的包列在一起;不能卸载。 */
  builtins?: (language: Language) => ExtensionInfo[];
  /** 补上本进程的运行状态(`enabled`、`hidden`)与 `language` 下的 World 名;已装包与内建条目都经过它。 */
  decorate?: (item: ExtensionInfo, language: Language) => ExtensionInfo;
}

/** 扩展管理接口；安装与卸载串行执行，避免并发修改同一依赖目录。 */
export class ExtensionManager {
  private readonly dir: string;
  private readonly run: PackageManagerRunner;
  /** 首次查询 registry 时解析,解析成功后本进程内不再变。 */
  private registryUrl: Promise<string> | null;
  private readonly fetchJson: (url: string) => Promise<unknown>;
  private busy = false;
  private readonly builtins?: (language: Language) => ExtensionInfo[];
  private readonly decorate?: (item: ExtensionInfo, language: Language) => ExtensionInfo;

  constructor(
    private readonly repoRoot: string,
    private readonly booted: ExtensionSet,
    opts: ExtensionManagerOptions = {},
  ) {
    this.dir = booted.dir;
    this.run = opts.run ?? runPnpm;
    this.builtins = opts.builtins;
    this.decorate = opts.decorate;
    this.registryUrl = opts.registry ? Promise.resolve(opts.registry.replace(/\/$/, '')) : null;
    this.fetchJson = opts.fetchJson ?? (async (url) => {
      let res: Response;
      try { res = await fetch(url); } catch (err) { throw new Error(fetchFailure(url, err)); }
      if (!res.ok) throw new Error(`${new URL(url).host}: ${res.status} ${res.statusText}`);
      // 读正文时断线报 `terminated`,原因同样只在 cause 里
      try { return await res.json(); } catch (err) { throw new Error(fetchFailure(url, err)); }
    });
  }

  /**
   * 安装走的 registry:和 `pnpm add` 同样在 extensions/ 里跑
   * `pnpm config get registry`,读的是 extensions/ 与用户的 .npmrc、`pnpm_config_registry`,没配时是 npm 官方的。
   * pnpm 失败或没给出地址时抛出它的退出码与输出,下次查询再问。解析结果缓存到 `setRegistry()` 改写
   * extensions/.npmrc 为止;在别处改了配置要重启进程。
   */
  private registry(): Promise<string> {
    if (this.registryUrl) return this.registryUrl;
    const args = ['config', 'get', 'registry'];
    const pending = this.run(args, this.prepareDir()).then(({ code, output }) => {
      const url = code === 0 ? output.split(/\r?\n/).map((line) => line.trim()).reverse().find((line) => /^https?:\/\/\S+$/.test(line)) : undefined;
      if (!url) throw extensionError((t) => t.registryUnreadable(`pnpm ${args.join(' ')}`, code, output.trim().split('\n').slice(-20).join('\n')), 502);
      return url.replace(/\/$/, '');
    });
    pending.catch(() => { if (this.registryUrl === pending) this.registryUrl = null; });
    this.registryUrl = pending;
    return pending;
  }

  /** extensions/.npmrc 里 `registry=` 行的值;没有这一行时 null。 */
  configuredRegistry(): string | null {
    const file = join(this.dir, NPMRC);
    if (!existsSync(file)) return null;
    const values = readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => REGISTRY_LINE.exec(line)?.[1].trim() ?? []);
    return values.at(-1) ?? null;
  }

  /**
   * 把 extensions/.npmrc 的 `registry=` 行换成 `url`,其余行原样保留;`url` 为空时删掉这一行,文件只剩空白时删掉文件。
   * 写入后检查更新、搜索、详情和 `pnpm add` 都用新的源。
   */
  setRegistry(url: string): void {
    const value = url.trim();
    if (value && !(/^https?:\/\/\S+$/i.test(value) && URL.canParse(value))) throw extensionError((t) => t.badRegistry(value));
    const file = join(this.prepareDir(), NPMRC);
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw ? raw.replace(/\r?\n$/, '').split(/\r?\n/) : [];
    const at = lines.findIndex((line) => REGISTRY_LINE.test(line));
    const kept = lines.filter((line) => !REGISTRY_LINE.test(line));
    if (value) kept.splice(at < 0 ? kept.length : at, 0, `registry=${value}`);
    if (kept.some((line) => line.trim())) writeFileSync(file, kept.join(eol) + eol, 'utf8');
    else if (existsSync(file)) unlinkSync(file);
    this.registryUrl = null;
  }

  /**
   * extensions/ 和其中的 package.json 与 pnpm-workspace.yaml,pnpm 以它为工作区根;返回目录。package.json 的
   * `packageManager` 与 Cortico 自己的不同时改成后者:corepack 与 pnpm 都按它选 pnpm 版本,旧版本建的目录随 Cortico 升级换版。
   */
  private prepareDir(): string {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const pkgFile = join(this.dir, 'package.json');
    const existing = existsSync(pkgFile);
    const pkg = existing
      ? JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown>
      : { name: 'cortico-extensions', private: true, dependencies: {} };
    const packageManager = corticoPackageManager();
    if (!existing || (packageManager && pkg.packageManager !== packageManager)) {
      writeFileSync(pkgFile, JSON.stringify(packageManager ? { ...pkg, packageManager } : pkg, null, 2) + '\n', 'utf8');
    }
    const workspaceFile = join(this.dir, WORKSPACE_FILE);
    if (!existsSync(workspaceFile)) writeFileSync(workspaceFile, '', 'utf8');
    return this.dir;
  }

  /** 已加载扩展的浏览器端产物。服务端据此把页 id 映到 URL 并只发这几个文件。 */
  /** 已装包的图标文件;没装、没声明或文件不合格时 null。 */
  icon(name: string): { file: string; type: string } | null {
    if (!PACKAGE_NAME.test(name) || !readInstalled(this.dir).some((p) => p.name === name)) return null;
    const pkgDir = join(this.dir, 'node_modules', ...name.split('/'));
    const pkg = readPackageJson(join(pkgDir, 'package.json'));
    return pkg ? extensionIconFile(pkgDir, pkg) : null;
  }

  webUiAssets(): readonly ExtensionWebUiAsset[] {
    return this.booted.webUiAssets;
  }

  /** 经上一版契约过渡层加载的扩展的 WebUI 页 id。 */
  previousContractPages(): ReadonlySet<string> {
    return new Set(this.booted.records.flatMap((r) => r.loaded && r.previousContract && r.kind && r.worldId
      ? [pageIdFor(EXTENSION_PAGE_KIND[r.kind], r.worldId)]
      : []));
  }

  /** 将启动时的加载结果与当前安装状态比较；不一致时标记待重启。 */
  list(language: Language = 'zh'): { dir: string; platform: NodeJS.Platform; extensions: ExtensionInfo[] } {
    const onDisk = new Map(readInstalled(this.dir).map((p) => [p.name, p.spec]));
    const packageAt = (name: string) => readPackageJson(join(this.dir, 'node_modules', ...name.split('/'), 'package.json'));
    const out: ExtensionInfo[] = [];
    for (const r of this.booted.records) {
      const spec = onDisk.get(r.name);
      onDisk.delete(r.name);
      const pkg = spec === undefined ? null : packageAt(r.name);
      const installedVersion = spec === undefined ? undefined : pkg?.version ?? null;
      const state: ExtensionInfo['state'] = spec === undefined ? 'removed'
        : spec !== r.spec || installedVersion !== r.version ? 'pending-restart'
        : r.loaded ? 'loaded' : r.idle ? 'idle' : 'failed';
      const author = pkg ? packageAuthor(pkg) : undefined;
      const pkgDir = join(this.dir, 'node_modules', ...r.name.split('/'));
      out.push({
        ...r,
        reason: r.reason?.(language),
        warnings: r.warnings?.(language),
        ...(pkg ? { metadata: packageMetadata(pkg) } : {}),
        ...(author ? { author } : {}),
        ...(pkg && extensionIconFile(pkgDir, pkg) ? { icon: true } : {}),
        ...(spec === undefined ? {} : { installedVersion }),
        state,
      });
    }
    // 新装包仅报告 manifest 声明，浏览器产物状态在下一次加载时确定。
    for (const [name, spec] of onDisk) {
      const pkg = packageAt(name);
      const parsed = pkg ? parseExtensionManifest(pkg, language) : null;
      const manifest = parsed?.ok ? parsed.manifest : null;
      out.push({
        name,
        spec,
        version: pkg?.version ?? null,
        installedVersion: pkg?.version ?? null,
        webUiClient: manifest?.webUiClient !== undefined,
        ...(manifest ? { kind: manifest.kind, api: manifest.api } : {}),
        ...(manifest && manifest.webUiClient === undefined ? { webUi: 'none' as const } : {}),
        ...(parsed?.warnings.length ? { warnings: parsed.warnings } : {}),
        loaded: false,
        state: 'pending-restart',
        ...(pkg?.description ? { description: pkg.description } : {}),
        ...(pkg ? { metadata: packageMetadata(pkg) } : {}),
        ...(pkg && packageAuthor(pkg) ? { author: packageAuthor(pkg) } : {}),
        ...(pkg && extensionIconFile(join(this.dir, 'node_modules', ...name.split('/')), pkg) ? { icon: true } : {}),
      });
    }
    const all = [...out, ...(this.builtins?.(language) ?? [])];
    return { dir: this.dir, platform: process.platform, extensions: this.decorate ? all.map((item) => this.decorate!(item, language)) : all };
  }

  /** 逐包检查 npm 的 latest，保留单包失败，跳过本机链接。 */
  async updates(language: Language = 'zh'): Promise<ExtensionUpdateResult> {
    const checks = readInstalled(this.dir)
      .filter(({ spec }) => !/^(?:link|file|workspace):/.test(spec))
      .map(async ({ name }) => {
        try {
          const installedVersion = readPackageJson(join(this.dir, 'node_modules', ...name.split('/'), 'package.json'))?.version;
          if (!installedVersion) throw extensionError((t) => t.localPackageMissing);
          const info = await this.packageInfo(name, undefined, language);
          const newer = newerVersion(info.version, installedVersion);
          if (newer === null) throw extensionError((t) => t.versionIncomparable(installedVersion, info.version));
          return newer ? { update: {
            name, installedVersion, latestVersion: info.version, problems: info.problems ?? [],
          } } : {};
        } catch (err) {
          return { error: { name, error: errorText(err, language) } };
        }
      });
    const results = await Promise.all(checks);
    return {
      updates: results.flatMap((result) => result.update ? [result.update] : []),
      errors: results.flatMap((result) => result.error ? [result.error] : []),
    };
  }

  /**
   * 列出 npm 上带这一类关键字的全部包。**不接文本查询**:registry 的 `text=` 在
   * `keywords:` 过滤之下只影响排序不缩小结果(实测 `keywords:cortico-world 任意词`
   * 仍返回同样 8 条),筛选交给 WebUI 在整份结果上做。
   * `keywords:` 查询一个包都没回时，再按关键字本身做文本搜索(不认 `keywords:` 的 registry 对它回空列表);
   * 两种查询的结果都只留带这个关键字的包。
   */
  private readonly partialSearch = new Map<ExtensionKind, boolean>();
  /** 最近一次这一类的搜索翻到了上限:后面可能还有包没列出来。 */
  searchPartial(kind: ExtensionKind = 'world'): boolean { return this.partialSearch.get(kind) ?? false; }

  /** 搜索与安装用的 registry 地址，见 `registry()`。 */
  npmRegistry(): Promise<string> { return this.registry(); }

  async search(kind: ExtensionKind = 'world'): Promise<ExtensionSearchHit[]> {
    this.partialSearch.set(kind, false);
    const keyword = EXTENSION_KEYWORDS[kind];
    const installed = new Set(readInstalled(this.dir).map((p) => p.name));
    const hits: ExtensionSearchHit[] = [];
    const seen = new Set<string>();
    const registry = await this.registry();
    /** 按 `query` 翻页收进带关键字的包；返回 registry 回了多少条(过滤前)。 */
    const collect = async (query: string): Promise<number> => {
      let received = 0;
      for (let from = 0; from < SEARCH_MAX_HITS; from += SEARCH_PAGE_SIZE) {
        const text = encodeURIComponent(query);
        const url = `${registry}/-/v1/search?text=${text}&size=${SEARCH_PAGE_SIZE}&from=${from}`;
        const data = (await this.fetchJson(url)) as RegistrySearchResponse;
        const objects = data.objects ?? [];
        received += objects.length;
        for (const obj of objects) {
          const p = obj.package;
          if (!p?.name || !p.version || !(p.keywords ?? []).includes(keyword)) continue;
          if (seen.has(p.name)) continue;
          seen.add(p.name);
          const repository = p.links?.repository;
          hits.push({
            name: p.name,
            version: p.version,
            description: p.description ?? '',
            kind,
            ...(p.date ? { date: p.date } : {}),
            ...(p.publisher?.username ? { publisher: p.publisher.username } : {}),
            ...(p.maintainers?.length ? { maintainers: p.maintainers.flatMap((m) => m.username ? [m.username] : []) } : {}),
            ...(p.license ? { license: p.license } : {}),
            ...(p.keywords?.length ? { keywords: p.keywords } : {}),
            downloads: { month: obj.downloads?.monthly ?? 0 },
            dependents: Number(obj.dependents) || 0,
            links: {
              ...(p.links?.npm ? { npm: p.links.npm } : {}),
              ...(repository ? { repository: repositoryWebUrl(repository) } : {}),
              ...(p.links?.homepage ? { homepage: p.links.homepage } : {}),
            },
            installed: installed.has(p.name),
          });
        }
        if (objects.length < SEARCH_PAGE_SIZE) break;
        if (from + SEARCH_PAGE_SIZE >= SEARCH_MAX_HITS) this.partialSearch.set(kind, true);
      }
      return received;
    };
    if (await collect(`keywords:${keyword}`) === 0) await collect(keyword);
    const stats = await this.downloadStats(hits.map((hit) => hit.name));
    for (const hit of hits) Object.assign(hit.downloads, stats.get(hit.name));
    return hits;
  }

  /**
   * 向 npm 下载统计问每个包的近 7 天、近 30 天与累计下载量。不带 scope 的合批问,带 scope 的逐个问。
   * 累计按 365 天一段往前加,一个包某段为 0 就不再往前问;中间有整年无下载的包因此少计更早的下载。
   * 某次请求失败,涉及的包就缺那一项;统计接口整个不可达时返回空表,列表照常出。
   */
  private async downloadStats(names: string[]): Promise<Map<string, Partial<ExtensionSearchHit['downloads']>>> {
    const point = async (period: string, batch: string[]): Promise<Map<string, number>> => {
      const plain = batch.filter((name) => !name.startsWith('@'));
      const groups = [
        ...Array.from({ length: Math.ceil(plain.length / DOWNLOADS_BULK_MAX) }, (_, i) => plain.slice(i * DOWNLOADS_BULK_MAX, (i + 1) * DOWNLOADS_BULK_MAX)),
        ...batch.filter((name) => name.startsWith('@')).map((name) => [name]),
      ];
      const counts = new Map<string, number>();
      await Promise.all(groups.map(async (group) => {
        let data: unknown;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), DOWNLOADS_TIMEOUT_MS); });
        try { data = await Promise.race([this.fetchJson(`${DOWNLOADS_API}/${period}/${group.join(',')}`), late]); } catch { return; } finally { clearTimeout(timer); }
        // 只问一个包时回的是那个包本身,问多个时按包名分开回,没有数据的包是 null
        const entries = group.length === 1 ? { [group[0]!]: data } : (data ?? {}) as Record<string, unknown>;
        for (const name of group) {
          const n = (entries[name] as { downloads?: unknown } | null | undefined)?.downloads;
          if (typeof n === 'number') counts.set(name, n);
        }
      }));
      return counts;
    };
    const day = (date: Date) => date.toISOString().slice(0, 10);
    const [week, month, total] = await Promise.all([point('last-week', names), point('last-month', names), (async () => {
      const sums = new Map<string, number>();
      let pending = names;
      for (let end = new Date(); pending.length && day(end) >= DOWNLOADS_EPOCH;) {
        const start = new Date(end.getTime() - (DOWNLOADS_WINDOW_DAYS - 1) * 86_400_000);
        const from = day(start) < DOWNLOADS_EPOCH ? DOWNLOADS_EPOCH : day(start);
        const counts = await point(`${from}:${day(end)}`, pending);
        // 有一段没问到,这个包的累计就不完整,整项不报
        for (const name of pending) {
          const n = counts.get(name);
          if (n === undefined) sums.delete(name); else sums.set(name, (sums.get(name) ?? 0) + n);
        }
        pending = pending.filter((name) => (counts.get(name) ?? 0) > 0);
        end = new Date(start.getTime() - 86_400_000);
      }
      return sums;
    })()]);
    return new Map(names.map((name) => [name, {
      ...(week.has(name) ? { week: week.get(name) } : {}),
      ...(month.has(name) ? { month: month.get(name) } : {}),
      ...(total.has(name) ? { total: total.get(name) } : {}),
    }]));
  }

  /**
   * 一个包的详情。WebUI 在操作员点开某张卡片时才调，因此这里取整份包文档
   * (`GET /<name>`，比搜索结果多出 cortico 声明、许可证、体积与版本史)。
   * readme 不回传：一份 30KB 以上的 markdown，WebUI 也不渲染它。
   */
  async packageInfo(name: string, version?: string, language: Language = 'zh'): Promise<ExtensionPackageDetail> {
    if (!PACKAGE_NAME.test(name)) throw extensionError((t) => t.badPackageName(name));
    const doc = (await this.fetchJson(`${await this.registry()}/${name.replace('/', '%2F')}`)) as RegistryPackument;
    const latest = version ? doc['dist-tags']?.[version] ?? version : doc['dist-tags']?.latest;
    const v = latest ? doc.versions?.[latest] : undefined;
    if (!latest || !v) throw extensionError((t) => t.registryNoVersion(name, version ?? 'latest'), 502);

    const parsed = parseExtensionManifest(v, language);
    const times = Object.keys(doc.versions ?? {}).map((version) => [version, doc.time?.[version] ?? ''] as const);
    const history = times
      .sort((a, b) => (a[1] < b[1] ? 1 : -1))
      .map(([version, date]) => {
        // 包文档的 versions 里每个版本都带完整 manifest
        const manifest = parseExtensionManifest(doc.versions![version], language);
        return {
          version, date,
          ...(manifest.ok ? {} : { problems: manifest.reasons }),
          ...(manifest.ok && manifest.warnings.length ? { warnings: manifest.warnings } : {}),
        };
      });
    const spec = readInstalled(this.dir).find((p) => p.name === name)?.spec;
    const repository = urlOf(v.repository);
    const bugs = urlOf(v.bugs);
    const author = packageAuthor(v);

    return {
      name,
      version: latest,
      ...(parsed.ok && parsed.manifest.displayName ? { displayName: parsed.manifest.displayName } : {}),
      ...(v.description ? { description: v.description } : {}),
      ...(v.license ? { license: v.license } : {}),
      ...(v.keywords?.length ? { keywords: v.keywords } : {}),
      ...(doc.time?.[latest] ? { published: doc.time[latest] } : {}),
      ...(doc.time?.created ? { created: doc.time.created } : {}),
      versionCount: times.length,
      history,
      ...(v.deprecated ? { deprecated: v.deprecated } : {}),
      ...(parsed.ok
        ? { manifest: parsed.manifest, frameworkApi: EXTENSION_API_VERSIONS[parsed.manifest.kind] }
        : { problems: parsed.reasons }),
      warnings: parsed.warnings,
      ...(v.engines?.node ? { engines: v.engines.node } : {}),
      ...(v.os?.length ? { os: v.os } : {}),
      ...(v.dist?.unpackedSize ? { unpackedSize: v.dist.unpackedSize } : {}),
      ...(v.dist?.fileCount ? { fileCount: v.dist.fileCount } : {}),
      dependencies: Object.keys(v.dependencies ?? {}),
      maintainers: (v.maintainers ?? []).map((m) => m.username ?? m.name ?? '').filter(Boolean),
      ...(author ? { author } : {}),
      ...(v._npmUser?.name ? { publisher: v._npmUser.name } : {}),
      links: {
        npm: `https://www.npmjs.com/package/${name}`,
        ...(repository ? { repository: repositoryWebUrl(repository) } : {}),
        ...(v.homepage ? { homepage: v.homepage } : {}),
        ...(bugs ? { bugs } : {}),
      },
      installed: spec !== undefined,
      ...(spec !== undefined ? { installedSpec: spec } : {}),
    };
  }

  /**
   * 装之前看一眼声明:本机目录读 package.json,npm 包读包文档。只解析 manifest,不导入包代码;
   * `expectedKind` 给了就要求类别一致。
   */
  async check(target: ExtensionInstallTarget, expectedKind?: ExtensionKind, language: Language = 'zh'): Promise<{ name: string; version: string; kind: ExtensionKind }> {
    const spec = this.installSpec(target);
    if ('path' in target) {
      const pkg = readPackageJson(join(spec, 'package.json'));
      const parsed = pkg ? parseExtensionManifest(pkg, language) : null;
      if (!pkg || !parsed) throw extensionError((t) => t.noPackageJson(spec));
      if (!parsed.ok) throw new Error(parsed.reasons.join('\n'));
      if (!pkg.name || !PACKAGE_NAME.test(pkg.name) || !pkg.version) throw extensionError((t) => t.noNameOrVersion);
      const { kind } = parsed.manifest;
      if (expectedKind && kind !== expectedKind) throw extensionError((t) => t.kindMismatch(kind));
      return { name: pkg.name, version: pkg.version, kind };
    }
    const info = await this.packageInfo(target.name.trim(), target.version?.trim() || undefined, language);
    if (info.problems?.length) throw new Error(info.problems.join('\n'));
    if (!info.manifest) throw extensionError((t) => t.manifestUnusable);
    const { kind } = info.manifest;
    if (expectedKind && kind !== expectedKind) throw extensionError((t) => t.kindMismatch(kind));
    return { name: info.name, version: info.version, kind };
  }

  /**
   * `pnpm add` 之后,构建脚本被跳过的包里是某个已装扩展直接依赖的,在 `allowBuilds` 里改成 true 并 `pnpm rebuild`:
   * 装扩展就是信任它和它列出的依赖。其余的仍不构建,在 `allowBuilds` 里写成待定值,回执列出包名与批准的命令。
   */
  async install(target: ExtensionInstallTarget, language: Language = 'zh'): Promise<string> {
    const spec = this.installSpec(target);
    this.prepareDir();
    return this.exclusive(async () => {
      const output = [text(language).installed(spec), await this.pnpm(['add', spec, LENIENT_BUILDS])];
      const skipped = pendingBuilds(this.dir);
      const direct = new Set(readInstalled(this.dir).flatMap(({ name }) =>
        Object.keys(readPackageJson(join(this.dir, 'node_modules', ...name.split('/'), 'package.json'))?.dependencies ?? {})));
      const approve = skipped.filter((name) => direct.has(name));
      const pending = skipped.filter((name) => !direct.has(name));
      setAllowBuilds(this.dir, approve, 'true');
      setAllowBuilds(this.dir, pending, UNDECIDED_BUILD);
      if (approve.length) output.push(await this.pnpm(['rebuild', ...approve]));
      if (pending.length) output.push(text(language).buildsPending(pending.join(' '), this.dir));
      return output.join('\n');
    });
  }

  async uninstall(name: string, language: Language = 'zh'): Promise<string> {
    if (!PACKAGE_NAME.test(name)) throw extensionError((t) => t.badPackageName(name));
    if (!readInstalled(this.dir).some((p) => p.name === name)) throw extensionError((t) => t.notInstalled(name));
    this.prepareDir();
    const output = await this.exclusive(() => this.pnpm(['remove', name, LENIENT_BUILDS]));
    return `${text(language).uninstalled(name)}\n${output}`;
  }

  private installSpec(target: ExtensionInstallTarget): string {
    if ('path' in target) {
      const raw = target.path.trim();
      if (!LOCAL_PATH.test(raw)) throw extensionError((t) => t.badPathChars);
      const abs = isAbsolute(raw) ? raw : resolve(this.repoRoot, raw);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) throw extensionError((t) => t.dirMissing(abs));
      if (!existsSync(join(abs, 'package.json'))) throw extensionError((t) => t.noPackageJson(abs));
      return abs;
    }
    const name = target.name.trim();
    if (!PACKAGE_NAME.test(name)) throw extensionError((t) => t.badPackageName(name));
    const version = target.version?.trim() ?? '';
    if (version && !VERSION_SPEC.test(version)) throw extensionError((t) => t.badVersion(version));
    return version ? `${name}@${version}` : name;
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw extensionError((t) => t.busy);
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }

  /** 在 extensions/ 里跑 pnpm,回输出的末 20 行;非零退出时抛出。 */
  private async pnpm(args: string[]): Promise<string> {
    const { code, output } = await this.run(args, this.dir);
    const tail = output.trim().split('\n').slice(-20).join('\n');
    if (code !== 0) throw extensionError((t) => t.pnpmFailed(args[0], code, tail));
    return tail;
  }
}
