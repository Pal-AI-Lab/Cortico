/**
 * 扩展是 extensions/ 下的 npm 包，manifest.kind 为 world、provider 或 bot。
 * 启动时读取直接依赖并分别校验 manifest、默认导出、id 命名空间与控制台页前缀。
 * 单包失败不阻止其他包加载；新增供应商可运行时注册，已导入的 ESM 代码更新需重启进程。
 * 仅导入 deployment.json 选定的 bot；其他 bot 包记为 idle，仓内同名 bot 优先。
 * 扩展包目录只读，避免修改 pnpm store 的硬链接文件；模板写入规则见 src/bot.ts。
 * 扩展提供包内相对产物路径，服务端校验后分配 URL，只提供已声明文件。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExtensionPackageStore, installedEnvironment, type PackageOperation } from './extensions/package-store.ts';
import { validatePackage, type ValidatedPackage } from './extensions/validate.ts';
import { pathToFileURL } from 'node:url';
import type { CoreConfig, Logger } from './core/types.ts';
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
  parseExtensionManifest,
  type ExtensionConsoleAsset,
  type ExtensionKind,
  type ExtensionPackageJson,
} from './extensions/manifest.ts';
import { registerFrameworkResolver } from './extensions/runtime.ts';
import { pageIdFor, type ContributingKind } from './web/shared/console-protocol.ts';

export const EXTENSIONS_DIRNAME = 'extensions';

/** 每类扩展的控制台页前缀。 */
export const EXTENSION_PAGE_KIND: Readonly<Record<ExtensionKind, ContributingKind>> = {
  world: 'world',
  provider: 'llm',
  bot: 'persona',
};
const NPM_REGISTRY = 'https://registry.npmjs.org';

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
  /** 包声明了浏览器端产物(`cortico.consoleClient`)。 */
  consoleClient: boolean;
  /** 浏览器产物状态：none=未声明，served=文件可提供，missing=声明的文件不存在。 */
  console?: 'none' | 'served' | 'missing';
  loaded: boolean;
  /** bot 包装了但这份部署没引用它:没有 import,不算失败。 */
  idle?: true;
  reason?: string;
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
  consoleAssets: ExtensionConsoleAsset[];
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

export function packageMetadata(pkg: ExtensionPackageJson): Partial<ExtensionPackageDetail> {
  const parsed = parseExtensionManifest(pkg);
  const repository = urlOf(pkg.repository), bugs = urlOf(pkg.bugs);
  return {
    ...(parsed.ok && parsed.manifest.displayName ? { displayName: parsed.manifest.displayName } : {}),
    description: pkg.description, license: pkg.license, engines: pkg.engines?.node,
    dependencies: Object.keys(pkg.dependencies ?? {}), keywords: pkg.keywords,
    publisher: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name,
    links: { ...(repository ? { repository: repositoryWebUrl(repository) } : {}), ...(pkg.homepage ? { homepage: pkg.homepage } : {}), ...(bugs ? { bugs } : {}) },
  };
}

/** 读取 extensions/package.json 的直接依赖；目录不存在时返回空列表。 */
export function readInstalled(dir: string): Array<{ name: string; spec: string }> {
  const pkg = readPackageJson(join(installedEnvironment(dir), 'package.json'));
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

const SHAPE_NEEDS: Readonly<Record<ExtensionKind, string>> = {
  world: 'WorldDefinition 的 id / label / defaults() / create()',
  provider: 'ProviderModule 的 id / title / reasoningTiers / serviceTiers / create()',
  bot: 'BotDefinition 的 id / defaults() / build()',
};

/** 默认导出与 `cortico.kind` 对不上时给作者的一句话。装载器与 `check:extension` 共用。 */
export function extensionShapeMismatch(kind: ExtensionKind): string {
  return `声明是 ${kind} 类,但默认导出缺 ${SHAPE_NEEDS[kind]}。`;
}

/** 解析包内相对路径；超出包目录或文件不存在时返回 null。 */
export function extensionPackageFile(pkgDir: string, relative: string): string | null {
  const abs = resolve(pkgDir, relative);
  if (!abs.startsWith(resolve(pkgDir) + sep)) return null;
  return existsSync(abs) ? abs : null;
}

// bot 包:定位与 import(启动器在装载其它扩展之前做)

export type BotPackageLocation =
  | { source: 'tree'; pkgDir: string; entry: string }
  | { source: 'extension'; name: string; pkgDir: string; entry: string };

/**
 * `deployment.json` 的 `bot` 字段是包标识,两处找,仓内赢:`treeDir`(`bots/<bot>/`)下有
 * `index.ts` 就是仓内包;否则 `extensions/package.json` 的 dependencies 里有这个名字,且它的
 * manifest 是 `kind: "bot"`。都没有就报错,两处路径都列出来。
 */
export function locateBotPackage(repoRoot: string, ref: string, treeDir: string): BotPackageLocation {
  const treeEntry = join(treeDir, 'index.ts');
  if (existsSync(treeEntry)) return { source: 'tree', pkgDir: treeDir, entry: treeEntry };
  const dir = extensionsDir(repoRoot);
  new ExtensionPackageStore(dir).recoverInterrupted();
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
  return { source: 'extension', name: ref, pkgDir, entry: resolveExtensionEntry(pkgDir, pkg) };
}

/**
 * import 定位到的 bot 包并校验默认导出。扩展来源的 bot 其 id 不得与仓内 `bots/` 任一目录同名:
 * 控制台按 `persona:<id>` 找面板产物,构建产物表里同 key 的仓内页优先,撞名会拿到仓内那份面板。
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
    throw new Error(`扩展「${location.name}」的 bot id「${mod.default.id}」与仓内 bots/${mod.default.id}/ 撞名;控制台面板产物按 persona:<id> 找,会拿到仓内那份。换一个 id。`);
  }
  return mod.default;
}

/**
 * 加载扩展 World 与 provider；id 与内建冲突时拒绝，扩展间重名时保留先加载项。
 * 两个 kind 使用独立命名空间。activeBot 已由启动器导入，此处只标记 loaded，其他 bot 记 idle。
 */
export async function loadExtensions(
  repoRoot: string,
  opts: { names?: readonly string[]; reserved?: Iterable<string>; reservedProviders?: Iterable<string>; activeBot?: ActiveBotPackage; log?: Logger } = {},
): Promise<ExtensionSet> {
  registerFrameworkResolver();
  const dir = extensionsDir(repoRoot);
  new ExtensionPackageStore(dir).recoverInterrupted();
  const taken: Record<Exclude<ExtensionKind, 'bot'>, Set<string>> = {
    world: new Set(opts.reserved ?? []),
    provider: new Set(opts.reservedProviders ?? []),
  };
  const records: ExtensionRecord[] = [];
  const worlds: WorldDefinition<WorldSection>[] = [];
  const providers: ProviderModule[] = [];
  const consoleAssets: ExtensionConsoleAsset[] = [];
  for (const { name, spec } of readInstalled(dir)) {
    if (opts.names && !opts.names.includes(name)) continue;
    const pkgDir = join(dir, 'node_modules', ...name.split('/'));
    let pkg: ExtensionPackageJson | null;
    try { pkg = readPackageJson(join(pkgDir, 'package.json')); }
    catch (error) { records.push({ name, spec, version: null, consoleClient: false, loaded: false, reason: String(error) }); continue; }
    const record: ExtensionRecord = {
      name,
      spec,
      version: pkg?.version ?? null,
      consoleClient: false,
      loaded: false,
      ...(pkg?.description ? { description: pkg.description } : {}),
    };
    records.push(record);
    if (!pkg) {
      record.reason = 'node_modules 里没有这个包;在 extensions/ 下重新安装一次。';
      continue;
    }
    const parsed = parseExtensionManifest(pkg);
    for (const warning of parsed.warnings) opts.log?.warn(`扩展 manifest: ${name} — ${warning}`);
    if (!parsed.ok) {
      record.reason = parsed.reasons.join(';');
      continue;
    }
    const { kind, api, consoleClient, consoleStyle } = parsed.manifest;
    record.kind = kind;
    record.api = api;
    record.consoleClient = consoleClient !== undefined;

    // 缺少面板产物不阻止定义加载。
    const jsFile = consoleClient === undefined ? null : extensionPackageFile(pkgDir, consoleClient);
    record.console = consoleClient === undefined ? 'none' : jsFile ? 'served' : 'missing';
    if (consoleClient !== undefined && !jsFile) {
      opts.log?.warn(`扩展声明的控制台产物不在: ${name} — ${consoleClient}`);
    }
    const cssFile = consoleStyle !== undefined && jsFile ? extensionPackageFile(pkgDir, consoleStyle) : null;
    if (consoleStyle !== undefined && jsFile && !cssFile) {
      opts.log?.warn(`扩展声明的控制台样式不在,面板按无样式发: ${name} — ${consoleStyle}`);
    }

    const serveAsset = (id: string): void => {
      if (!jsFile) return;
      consoleAssets.push({
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
      record.reason = `导入失败: ${error instanceof Error ? error.message : String(error)}`;
      opts.log?.warn(`扩展导入失败: ${name}`, { entry, error: record.reason });
      continue;
    }

    let id: string;
    if (kind === 'world') {
      if (!isWorldDefinition(exported)) {
        record.reason = extensionShapeMismatch('world');
        continue;
      }
      record.worldId = exported.id;
      if (taken.world.has(exported.id)) {
        record.reason = `World id「${exported.id}」已被内建 World 或先加载的扩展占用。`;
        continue;
      }
      taken.world.add(exported.id);
      record.label = exported.label;
      worlds.push(exported);
      id = exported.id;
    } else {
      if (!isProviderModule(exported)) {
        record.reason = extensionShapeMismatch('provider');
        continue;
      }
      record.worldId = exported.id;
      if (taken.provider.has(exported.id)) {
        record.reason = `provider id「${exported.id}」已被内建 provider 或先加载的扩展占用。`;
        continue;
      }
      taken.provider.add(exported.id);
      record.label = exported.title;
      providers.push(exported);
      id = exported.id;
    }
    record.loaded = true;
    serveAsset(id);
  }
  const bot = opts.activeBot && records.some((r) => r.loaded && r.kind === 'bot') ? opts.activeBot : undefined;
  return { dir, records, worlds, providers, consoleAssets, ...(bot ? { bot } : {}) };
}

// 装卸与搜索(控制台那一面)

/** npm 包名。与 npm 自己的校验同形;不含任何 shell 元字符。 */
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** Explicit version or dist-tag; dependency ranges are not installation targets. */
const VERSION_SPEC = /^[0-9a-zA-Z][0-9a-zA-Z._+-]{0,63}$/;

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
/** Local directory names are passed as process arguments, never shell text. */
const LOCAL_PATH = /^[^\x00-\x1f"<>|]{1,4096}$/u;

export type PackageManagerRunner = (args: string[], cwd: string) => Promise<{ code: number; output: string }>;

/** Invoke a Node package-manager entry directly so Unicode paths never enter a shell. */
export const runPnpm: PackageManagerRunner = (args, cwd) => new Promise((done, fail) => {
  const candidates = [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)]
    .flatMap(base => [join(base, 'node_modules/corepack/dist/pnpm.js'), join(base, 'node_modules/pnpm/bin/pnpm.cjs')]);
  const entry = candidates.find(file => existsSync(file));
  if (process.platform === 'win32' && !entry) { fail(new Error('找不到可直接运行的 pnpm/corepack Node 入口。')); return; }
  const child = spawn(entry ? process.execPath : 'corepack', entry ? [entry, ...args] : ['pnpm', ...args], {
    cwd,
    shell: false,
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

export interface ExtensionManagerOptions {
  refresh?: () => Promise<void>;
  onCommitted?: (operation: PackageOperation) => Promise<void>;
  run?: PackageManagerRunner;
  registry?: string;
  fetchJson?: (url: string) => Promise<unknown>;
  validate?: (dir: string) => Promise<ValidatedPackage>;
  references?: (name: string) => Promise<string[]>;
  builtins?: () => ExtensionInfo[];
  decorate?: (item: ExtensionInfo) => ExtensionInfo;
  activation?: (name: string, enabled: boolean, afterRestart: boolean) => Promise<void>;
}

/** 扩展管理接口；安装与卸载串行执行，避免并发修改同一依赖目录。 */
export class ExtensionManager {
  private readonly dir: string;
  private readonly run: PackageManagerRunner;
  private readonly registry: string;
  private readonly fetchJson: (url: string) => Promise<unknown>;
  private busy = false;
  private readonly store: ExtensionPackageStore;
  private readonly validate: (dir: string) => Promise<ValidatedPackage>;

  constructor(
    private readonly repoRoot: string,
    private readonly booted: ExtensionSet,
    opts: ExtensionManagerOptions = {},
  ) {
    this.store = new ExtensionPackageStore(booted.dir);
    this.dir = this.store.dir;
    this.validate = opts.validate ?? validatePackage;
    this.references = opts.references;
    this.decorate = opts.decorate;
    this.builtins = opts.builtins;
    this.activation = opts.activation;
    this.onCommitted = opts.onCommitted;
    this.refresh = opts.refresh;
    this.run = opts.run ?? runPnpm;
    this.registry = (opts.registry ?? NPM_REGISTRY).replace(/\/$/, '');
    this.fetchJson = opts.fetchJson ?? (async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    });
  }
  private readonly builtins?: () => ExtensionInfo[];
  private readonly onCommitted?: (operation: PackageOperation) => Promise<void>;
  readonly refresh?: () => Promise<void>;
  private readonly decorate?: (item: ExtensionInfo) => ExtensionInfo;
  readonly activation?: (name: string, enabled: boolean, afterRestart: boolean) => Promise<void>;
  private readonly references?: (name: string) => Promise<string[]>;
  get operationBusy(): boolean { return this.busy || this.store.busy; }
  operation(id: string): PackageOperation | null { return this.store.operation(id); }

  /** 已加载扩展的浏览器端产物。服务端据此把页 id 映到 URL 并只发这几个文件。 */
  consoleAssets(): readonly ExtensionConsoleAsset[] {
    return this.booted.consoleAssets;
  }

  /** 将启动时的加载结果与当前安装状态比较；不一致时标记待重启。 */
  list(): { dir: string; extensions: ExtensionInfo[] } {
    const directory = installedEnvironment(this.dir);
    const packageAt = (name: string) => { try { return readPackageJson(join(directory, 'node_modules', ...name.split('/'), 'package.json')); } catch { return null; } };
    const onDisk = new Map(readInstalled(directory).map((p) => [p.name, p.spec]));
    const out: ExtensionInfo[] = [];
    for (const r of this.booted.records) {
      const spec = onDisk.get(r.name);
      onDisk.delete(r.name);
      const pkg = spec === undefined ? null : packageAt(r.name);
      const installedVersion = spec === undefined ? undefined : pkg?.version ?? null;
      const state: ExtensionInfo['state'] = spec === undefined ? 'removed'
        : spec !== r.spec || installedVersion !== r.version ? 'pending-restart'
        : r.loaded ? 'loaded' : r.idle ? 'idle' : 'failed';
      out.push({ ...r, metadata: pkg ? packageMetadata(pkg) : undefined, author: typeof pkg?.author === 'string' ? pkg.author : pkg?.author?.name, ...(spec === undefined ? {} : { installedVersion }), state });
    }
    // 新装包仅报告 manifest 声明，浏览器产物状态在下一次加载时确定。
    for (const [name, spec] of onDisk) {
      const pkg = packageAt(name);
      const parsed = pkg ? parseExtensionManifest(pkg) : null;
      const manifest = parsed?.ok ? parsed.manifest : null;
      out.push({
        name,
        spec,
        version: pkg?.version ?? null,
        installedVersion: pkg?.version ?? null,
        metadata: pkg ? packageMetadata(pkg) : undefined,
        author: typeof pkg?.author === 'string' ? pkg.author : pkg?.author?.name,
        consoleClient: manifest?.consoleClient !== undefined,
        ...(manifest ? { kind: manifest.kind, api: manifest.api } : {}),
        ...(manifest && manifest.consoleClient === undefined ? { console: 'none' as const } : {}),
        loaded: false,
        state: manifest?.kind === 'bot' ? 'idle' : manifest ? 'pending-restart' : 'failed',
        ...(!manifest ? { reason: parsed && !parsed.ok ? parsed.reasons.join('; ') : 'package.json 缺失或损坏' } : {}),
        ...(pkg?.description ? { description: pkg.description } : {}),
      });
    }
    return { dir: this.dir, extensions: [...out, ...(this.builtins?.() ?? [])].map(item => this.decorate?.(item) ?? item) };
  }

  /** 逐包检查 npm 的 latest，保留单包失败，跳过本机链接。 */
  async updates(): Promise<ExtensionUpdateResult> {
    const checks = readInstalled(this.dir)
      .filter(({ spec }) => !/^(?:link|file|workspace):/.test(spec))
      .map(async ({ name }) => {
        try {
          const installedVersion = readPackageJson(join(this.dir, 'node_modules', ...name.split('/'), 'package.json'))?.version;
          if (!installedVersion) throw new Error('本机包缺失');
          const info = await this.packageInfo(name);
          const newer = newerVersion(info.version, installedVersion);
          if (newer === null) throw new Error(`无法比较版本 ${installedVersion} 与 ${info.version}`);
          return newer ? { update: {
            name, installedVersion, latestVersion: info.version, problems: info.problems ?? [],
          } } : {};
        } catch (err) {
          return { error: { name, error: err instanceof Error ? err.message : String(err) } };
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
   * 仍返回同样 8 条),筛选交给控制台在整份结果上做。
   */
  private readonly partialSearch = new Map<ExtensionKind, boolean>();
  searchPartial(kind: ExtensionKind = 'world'): boolean { return this.partialSearch.get(kind) ?? false; }
  async search(kind: ExtensionKind = 'world'): Promise<ExtensionSearchHit[]> {
    const keyword = EXTENSION_KEYWORDS[kind];
    const installed = new Set(readInstalled(this.dir).map((p) => p.name));
    const hits: ExtensionSearchHit[] = [];
    const seen = new Set<string>();
    this.partialSearch.set(kind, false);
    for (let from = 0; from < SEARCH_MAX_HITS; from += SEARCH_PAGE_SIZE) {
      const text = encodeURIComponent(`keywords:${keyword}`);
      const url = `${this.registry}/-/v1/search?text=${text}&size=${SEARCH_PAGE_SIZE}&from=${from}`;
      const data = (await this.fetchJson(url)) as RegistrySearchResponse;
      const objects = data.objects ?? [];
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
          ...(p.license ? { license: p.license } : {}),
          ...(p.keywords?.length ? { keywords: p.keywords } : {}),
          downloads: obj.downloads?.monthly ?? 0,
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
    return hits;
  }

  /**
   * 一个包的详情。市场卡片和详情弹窗读取整份包文档
   * (`GET /<name>`，比搜索结果多出 cortico 声明、许可证、体积与版本史)。
   * readme 不回传：一份 30KB 以上的 markdown，控制台也不渲染它。
   */
  async packageInfo(name: string, version?: string): Promise<ExtensionPackageDetail> {
    if (!PACKAGE_NAME.test(name)) throw new Error(`不是合法的 npm 包名: ${name}`);
    const doc = (await this.fetchJson(`${this.registry}/${name.replace('/', '%2F')}`)) as RegistryPackument;
    const latest = version ? doc['dist-tags']?.[version] ?? version : doc['dist-tags']?.latest;
    const v = latest ? doc.versions?.[latest] : undefined;
    if (!latest || !v) throw new Error(`registry 没有给出 ${name} 的 latest 版本`);

    const parsed = parseExtensionManifest(v);
    const times = Object.entries(doc.time ?? {}).filter(([k]) => k !== 'created' && k !== 'modified');
    const history = times
      .sort((a, b) => (a[1] < b[1] ? 1 : -1))
      .slice(0, 6)
      .map(([version, date]) => ({ version, date }));
    const spec = readInstalled(this.dir).find((p) => p.name === name)?.spec;
    const repository = urlOf(v.repository);
    const bugs = urlOf(v.bugs);

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
      ...(v.dist?.unpackedSize ? { unpackedSize: v.dist.unpackedSize } : {}),
      ...(v.dist?.fileCount ? { fileCount: v.dist.fileCount } : {}),
      dependencies: Object.keys(v.dependencies ?? {}),
      maintainers: (v.maintainers ?? []).map((m) => m.username ?? m.name ?? '').filter(Boolean),
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

  async validateInstalled(name: string): Promise<ValidatedPackage> {
    if (!PACKAGE_NAME.test(name) || !readInstalled(this.dir).some(p => p.name === name)) throw new Error('扩展未安装。');
    return this.validate(join(this.dir, 'node_modules', ...name.split('/')));
  }

  async install(target: ExtensionInstallTarget): Promise<string> {
    const result = await this.perform(randomUUID(), 'install', target);
    if (result.phase !== 'committed') throw new Error(result.error);
    return `已安装 ${result.name}@${result.version}。${result.kind === 'bot' ? '可创建新实例。' : '重启进程后可加载。'}\n${result.output ?? ''}`;
  }

  async uninstall(name: string): Promise<string> {
    if (!PACKAGE_NAME.test(name)) throw new Error(`不是合法的包名: ${name}`);
    if (!readInstalled(this.dir).some((p) => p.name === name)) throw new Error(`没有安装这个包: ${name}`);
    const result = await this.perform(randomUUID(), 'delete', { name });
    if (result.phase !== 'committed') throw new Error(result.error);
    return `已删除 ${name}。重启进程后完成清理。\n${result.output ?? ''}`;
  }

  async check(target: ExtensionInstallTarget, expectedKind?: ExtensionKind): Promise<{ name: string; version: string; kind: ExtensionKind }> {
    this.installSpec(target);
    if ('path' in target) {
      const dir = resolve(this.repoRoot, target.path.trim());
      const pkg = readPackageJson(join(dir, 'package.json'))!;
      const parsed = parseExtensionManifest(pkg);
      if (!parsed.ok) throw new Error(parsed.reasons.join('\n'));
      if (!pkg.name || !PACKAGE_NAME.test(pkg.name) || !pkg.version) throw new Error('扩展缺少有效包名或版本。');
      if (expectedKind && parsed.manifest.kind !== expectedKind) throw new Error(`扩展实际类型为 ${parsed.manifest.kind}，请切换到对应分类。`);
      await this.validate(dir);
      return { name: pkg.name, version: pkg.version, kind: parsed.manifest.kind };
    }
    const info = await this.packageInfo(target.name.trim(), target.version?.trim());
    if (!info.manifest || info.problems?.length) throw new Error(info.problems?.join('\n') ?? '扩展声明不可用。');
    if (expectedKind && info.manifest.kind !== expectedKind) throw new Error(`扩展实际类型为 ${info.manifest.kind}，请切换到对应分类。`);
    return { name: info.name, version: info.version, kind: info.manifest.kind };
  }

  async perform(id: string, action: 'install' | 'delete', target: ExtensionInstallTarget, kind?: ExtensionKind): Promise<PackageOperation> {
    if ('name' in target && this.builtins?.().some(item => item.name === target.name)) throw new Error('内置扩展随 Cortico 提供，不能单独安装或删除。');
    this.installSpec(target);
    const fingerprint = JSON.stringify({ target, kind });
    const prior = this.store.operation(id);
    if (prior) {
      if (prior.action !== action || prior.target !== fingerprint) throw new Error('Operation ID already belongs to another request.');
      return prior;
    }
    if (this.busy) throw new Error('已有一个扩展操作在进行。');
    this.busy = true;
    try {
      const result = await this.store.transact({ id, action, target: fingerprint, phase: 'preparing' }, async (stage, progress) => {
        let validated: Partial<ValidatedPackage> = {};
        const manifestFile = join(stage, 'package.json');
        const environmentManifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
        environmentManifest.packageManager = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).packageManager;
        writeFileSync(manifestFile, JSON.stringify(environmentManifest, null, 2));
        const flags = ['--ignore-workspace', '--config.engine-strict=true', '--config.virtual-store-dir=' + this.store.virtualStoreDir];
        const execute = async (args: string[]) => {
          const { code, output } = await this.run([...args, ...flags], stage);
          const tail = output.trim().split('\n').slice(-20).join('\n');
          if (code !== 0) throw new Error(`pnpm ${args[0]} 退出码 ${code}:\n${tail}`);
          return tail;
        };
        let output: string;
        if (action === 'install') {
          const checked = await this.check(target, kind);
          const spec = 'path' in target ? 'link:' + resolve(this.repoRoot, target.path.trim()) : `${checked.name}@${checked.version}`;
          output = await execute(['add', spec]);
          progress('validating');
          validated = await this.validate(join(stage, 'node_modules', ...checked.name.split('/')));
          if (validated.name !== checked.name || validated.version !== checked.version || validated.kind !== checked.kind) throw new Error('已安装包的身份与预检不一致。');
          if (this.booted.records.some(record => record.name !== checked.name && record.kind === validated.kind && record.worldId === validated.moduleId)) throw new Error('扩展模块 ID 与已注册扩展冲突。');
          for (const other of readInstalled(this.dir)) {
            if (other.name === checked.name || this.booted.records.some(record => record.name === other.name && record.loaded)) continue;
            const directory = join(this.dir, 'node_modules', ...other.name.split('/'));
            const manifest = readPackageJson(join(directory, 'package.json'));
            const parsed = manifest && parseExtensionManifest(manifest);
            if (!parsed?.ok || parsed.manifest.kind !== validated.kind) continue;
            const identity = await this.validate(directory);
            if (identity.moduleId === validated.moduleId) throw new Error('扩展模块 ID 与已安装扩展冲突: ' + other.name);
          }
        } else {
          if (!('name' in target) || !readInstalled(this.dir).some(p => p.name === target.name)) throw new Error('没有安装这个包。');
          const references = await this.references?.(target.name) ?? [];
          if (references.length) throw new Error('扩展仍被引用：\n' + references.join('\n'));
          const pkgFile = join(stage, 'package.json');
          const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
          delete pkg.dependencies[target.name];
          writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
          output = await execute(['install', '--no-frozen-lockfile']);
          validated = { name: target.name };
        }
        return { ...validated, output };
      });
      if (result.phase === 'committed') await this.onCommitted?.(result);
      return result;
    } finally { this.busy = false; }
  }

  private installSpec(target: ExtensionInstallTarget): string {
    if ('path' in target) {
      const raw = target.path.trim();
      if (!LOCAL_PATH.test(raw)) throw new Error('路径含有不接受的字符。');
      const abs = isAbsolute(raw) ? raw : resolve(this.repoRoot, raw);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`目录不存在: ${abs}`);
      if (!existsSync(join(abs, 'package.json'))) throw new Error(`目录里没有 package.json: ${abs}`);
      return abs;
    }
    const name = target.name.trim();
    if (!PACKAGE_NAME.test(name)) throw new Error(`不是合法的 npm 包名: ${name}`);
    const version = target.version?.trim() ?? '';
    if (version && !VERSION_SPEC.test(version)) throw new Error(`不是合法的版本: ${version}`);
    return version ? `${name}@${version}` : name;
  }

}
