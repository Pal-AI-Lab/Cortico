/**
 * 从 Mojang 版本 JSON 生成客户端 Java 命令，支持 inheritsFrom 继承。
 * client.ts 管理进程生命周期。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface Rule {
  action?: 'allow' | 'disallow';
  os?: { name?: string; arch?: string; version?: string };
  features?: Record<string, boolean>;
}

interface Artifact {
  path?: string;
  url?: string;
}

interface LibraryEntry {
  name?: string;
  rules?: Rule[];
  downloads?: { artifact?: Artifact };
}

type ArgEntry = string | { rules?: Rule[]; value?: string | string[] };

interface VersionJson {
  id?: string;
  inheritsFrom?: string;
  jar?: string;
  mainClass?: string;
  assetIndex?: { id?: string };
  arguments?: { game?: ArgEntry[]; jvm?: ArgEntry[] };
  libraries?: LibraryEntry[];
  type?: string;
}

interface ClientLaunchInput {
  /** .minecraft 目录 */
  gameDir: string;
  /** versions/<id>/<id>.json 的 id;空 = 目录里唯一那个版本 */
  versionId: string;
  javaPath: string;
  username: string;
  /** 额外 JVM 参数(内存等),空格分隔 */
  jvmArgs?: string[];
  width: number;
  height: number;
  /** 进游戏直连的服务器;null = 停在主菜单 */
  joinServer?: { host: string; port: number } | null;
  /** natives 解压目录;缺省 <gameDir>/natives/<versionId> */
  nativesDir?: string;
  os?: NodeJS.Platform;
  arch?: string;
}

interface ClientLaunch {
  command: string;
  args: string[];
  cwd: string;
  nativesDir: string;
  mainClass: string;
  /** 需要解压 dll 的 jar 绝对路径(client.ts 启动前处理) */
  nativeJars: string[];
  /** 实际用到的版本 id 链,child → root */
  versionChain: string[];
  /** 版本 JSON 点名、但 libraries 目录里没有的条目,相对 libraries 目录。类路径里少了它们。 */
  missingLibraries: string[];
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'windows',
  darwin: 'osx',
  linux: 'linux',
};

/** 离线账号 UUID：以 OfflinePlayer:<名字> 的 MD5 生成版本 3 UUID。 */
export function offlineUuid(username: string): string {
  const h = createHash('md5').update(`OfflinePlayer:${username}`).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** maven 坐标 → libraries 下的相对路径(Fabric 的库常常只给名字不给 downloads) */
export function mavenPath(name: string): string {
  const [coords, ext = 'jar'] = name.split('@');
  const parts = coords.split(':');
  const [group, artifact, version, classifier] = parts;
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return [...group.split('.'), artifact, version, file].join('/');
}

export function rulesAllow(
  rules: Rule[] | undefined,
  ctx: { os: string; arch: string; features: Record<string, boolean> },
): boolean {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let match = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== ctx.os) match = false;
      if (rule.os.arch && rule.os.arch !== ctx.arch) match = false;
      // os.version 是 osx 专用的正则,windows 上一律不匹配
      if (rule.os.version && ctx.os !== 'osx') match = false;
    }
    if (rule.features) {
      for (const [key, want] of Object.entries(rule.features)) {
        if (Boolean(ctx.features[key]) !== want) match = false;
      }
    }
    if (match) allowed = (rule.action ?? 'allow') === 'allow';
  }
  return allowed;
}

function flattenArgs(
  entries: ArgEntry[] | undefined,
  ctx: { os: string; arch: string; features: Record<string, boolean> },
): string[] {
  const out: string[] = [];
  for (const entry of entries ?? []) {
    if (typeof entry === 'string') { out.push(entry); continue; }
    if (!rulesAllow(entry.rules, ctx)) continue;
    if (typeof entry.value === 'string') out.push(entry.value);
    else if (Array.isArray(entry.value)) out.push(...entry.value);
  }
  return out;
}

function substitute(arg: string, vars: Record<string, string>): string {
  return arg.replace(/\$\{([\w.]+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

/** child → root 的版本 JSON 链;循环继承与缺文件都当错误 */
function loadVersionChain(gameDir: string, versionId: string): VersionJson[] | { error: string } {
  const chain: VersionJson[] = [];
  const seen = new Set<string>();
  let id = versionId;
  while (id) {
    if (seen.has(id)) return { error: `版本继承成环: ${[...seen].join(' → ')} → ${id}` };
    seen.add(id);
    const file = join(gameDir, 'versions', id, `${id}.json`);
    if (!existsSync(file)) return { error: `找不到版本文件 ${file}` };
    let json: VersionJson;
    try {
      json = JSON.parse(readFileSync(file, 'utf8')) as VersionJson;
    } catch (err) {
      return { error: `版本文件解析失败 ${file}: ${(err as Error).message}` };
    }
    chain.push(json);
    id = json.inheritsFrom ?? '';
  }
  return chain;
}

/** 只装了一个版本时不必填版本号 */
export function soleVersionId(gameDir: string): string | null {
  const dir = join(gameDir, 'versions');
  if (!existsSync(dir)) return null;
  // 目录名即版本 id;有 <id>.json 的才算装好了
  const ids = readdirSync(dir).filter((name) => existsSync(join(dir, name, `${name}.json`)));
  return ids.length === 1 ? ids[0] : null;
}

export function buildClientLaunch(input: ClientLaunchInput): ClientLaunch | { error: string } {
  const { gameDir } = input;
  if (!gameDir) return { error: '未配置客户端游戏目录(worlds.minecraft.client.gameDir)' };
  if (!existsSync(gameDir)) return { error: `客户端游戏目录不存在: ${gameDir}` };
  const versionId = input.versionId || soleVersionId(gameDir) || '';
  if (!versionId) {
    return { error: `${join(gameDir, 'versions')} 下不是恰好一个版本,请在 worlds.minecraft.client.versionId 里指定` };
  }
  const chain = loadVersionChain(gameDir, versionId);
  if ('error' in chain) return chain;

  const os = OS_NAMES[input.os ?? process.platform] ?? 'linux';
  const arch = (input.arch ?? process.arch) === 'ia32' ? 'x86' : (input.arch ?? process.arch);
  const features: Record<string, boolean> = {
    is_demo_user: false,
    has_custom_resolution: true,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: Boolean(input.joinServer),
    is_quick_play_realms: false,
  };
  const ctx = { os, arch, features };

  // child 在前:mainClass / assetIndex 取最先声明的那个,classpath 也让 loader 排在前面
  const pick = <K extends keyof VersionJson>(key: K): VersionJson[K] | undefined =>
    chain.find((v) => v[key] !== undefined)?.[key];
  const mainClass = pick('mainClass');
  if (!mainClass) return { error: `版本 ${versionId} 没有 mainClass` };
  const root = chain[chain.length - 1];
  const jarId = pick('jar') ?? root.id ?? versionId;
  const versionJar = join(gameDir, 'versions', jarId, `${jarId}.jar`);
  if (!existsSync(versionJar)) return { error: `找不到版本主 jar: ${versionJar}` };
  const assetIndexId = pick('assetIndex')?.id;
  if (!assetIndexId) return { error: `版本 ${versionId} 没有 assetIndex` };

  const librariesDir = join(gameDir, 'libraries');
  const classpath: string[] = [];
  const nativeJars: string[] = [];
  const missingLibraries: string[] = [];
  const seenPaths = new Set<string>();
  for (const version of chain) {
    for (const lib of version.libraries ?? []) {
      if (!rulesAllow(lib.rules, ctx)) continue;
      const rel = lib.downloads?.artifact?.path ?? (lib.name ? mavenPath(lib.name) : null);
      if (!rel) continue;
      const abs = join(librariesDir, rel);
      if (seenPaths.has(abs)) continue;
      seenPaths.add(abs);
      if (!existsSync(abs)) {
        missingLibraries.push(rel);
        continue;
      }
      if (/natives/i.test(rel)) nativeJars.push(abs);
      classpath.push(abs);
    }
  }
  classpath.push(versionJar);

  const nativesDir = input.nativesDir ?? join(gameDir, 'natives', versionId);
  const separator = os === 'windows' ? ';' : ':';
  const vars: Record<string, string> = {
    auth_player_name: input.username,
    // 加载器版本靠 `-DignoreList=...,${version_name}.jar` 把主 jar 挡在模块路径外,名字对不上时它
    // 变成自动模块,和 client-extra 导出同一个包,JVM 在建模块层时就崩。继承链上的版本没有自己的
    // jar,借的是 jarId 那个,所以这里给的是 jarId 而非版本目录名。
    version_name: jarId,
    game_directory: gameDir,
    assets_root: join(gameDir, 'assets'),
    game_assets: join(gameDir, 'assets'),
    assets_index_name: assetIndexId,
    auth_uuid: offlineUuid(input.username),
    auth_access_token: '0',
    auth_session: '0',
    clientid: '',
    auth_xuid: '',
    user_type: 'msa',
    user_properties: '{}',
    version_type: pick('type') ?? 'release',
    resolution_width: String(input.width),
    resolution_height: String(input.height),
    natives_directory: nativesDir,
    launcher_name: 'cortico',
    launcher_version: '1',
    classpath: classpath.join(separator),
    classpath_separator: separator,
    library_directory: librariesDir,
    quickPlayMultiplayer: input.joinServer ? `${input.joinServer.host}:${input.joinServer.port}` : '',
    quickPlayPath: '',
  };

  /** 继承链均未声明 JVM 参数时，使用默认的三项参数。 */
  const jvmEntries = chain.flatMap((v) => flattenArgs(v.arguments?.jvm, ctx));
  const jvmArgs = jvmEntries.length > 0
    ? jvmEntries
    : ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'];
  const gameEntries = chain.flatMap((v) => flattenArgs(v.arguments?.game, ctx));

  const args = [
    ...jvmArgs.map((a) => substitute(a, vars)),
    ...(input.jvmArgs ?? []),
    mainClass,
    ...gameEntries.map((a) => substitute(a, vars)),
  ];
  return {
    command: input.javaPath || 'java',
    args,
    cwd: gameDir,
    nativesDir,
    mainClass,
    nativeJars,
    versionChain: chain.map((v, i) => v.id ?? (i === 0 ? versionId : '?')),
    missingLibraries,
  };
}
