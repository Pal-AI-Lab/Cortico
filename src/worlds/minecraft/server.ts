/** 管理本地 Minecraft 服务器进程、stdin 指令及 TCP 连通性检测。停止时先发送 save-all flush 和 stop，超时后强制终止。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { connect } from 'node:net';
import type { Logger } from '../../core/types.ts';
import {
  loadProperties, readProperty, saveProperties, settingsFrom, writeProperty,
} from './server-config.ts';
import { readLevelDat } from './level-dat.ts';

export type MinecraftServerPhase = 'stopped' | 'starting' | 'running' | 'error';

export interface MinecraftServerState {
  enabled: boolean;
  phase: MinecraftServerPhase;
  address: string;
  detail: string | null;
  pid: number | null;
  /** TCP 检测只确认端口可连接。 */
  reachable: boolean;
  /** 当前托管进程所用目录；停机时为下一次启动的配置目录。 */
  serverDir: string;
  /** 路径配置是否齐备(不齐时前端提示去配置) */
  configured: boolean;
}

interface MinecraftServerOptions {
  enabled?: () => boolean;
  /** 含 server.jar 的目录(启动前读取配置;'' = 未配置) */
  serverDir: () => string;
  /** java 路径;'' = 自动(serverDir 邻近 jdk → PATH 上的 java) */
  javaPath: () => string;
  /** JVM 参数(内存等),空格分隔 */
  jvmArgs: () => string;
  /** bot 要连的地址(托管只对本机地址有意义,探测也用它) */
  host: () => string;
  port: () => number;
  log: Logger;
  /** 测试注入:替换 spawn 目标 */
  commandOverride?: { command: string; args: string[] };
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  /** 测试注入:低频存档周期 */
  autoSaveMs?: number;
  onPhase?: (phase: MinecraftServerPhase, detail: string | null) => void;
  /**
   * 就绪之后回读一次实际难度的结果(每次 running 一次)。见 `queryDifficulty`。
   * `difficulty: null` = 问了但没问出来(服务端没在期限内回话、或回的话认不出来)。
   */
  onDifficulty?: (fact: MinecraftDifficultyFact) => void;
  /** 测试注入:难度回读的等待上限 */
  difficultyTimeoutMs?: number;
}

/** 回读到的难度事实。全是读数,怎么措辞由消费方决定。 */
export interface MinecraftDifficultyFact {
  /** 规范化后的难度名(peaceful/easy/normal/hard);认不出来 = null */
  difficulty: 'peaceful' | 'easy' | 'normal' | 'hard' | null;
  /** 服务端回的那一行原文(截断);没回话 = null */
  raw: string | null;
  /** 同一刻 server.properties 里的 difficulty=;读不到 = null */
  properties: string | null;
}

const PROGRESS_RE = /Preparing (start region|spawn area)/;
/** 原版启动完成行:「Done (12.345s)! For help, type "help"」 */
const READY_RE = /\bDone \([\d.]+s\)!/;
/** 每见一次进度行给的宽限 */
const PROGRESS_GRACE_MS = 60_000;
/**
 * `difficulty` 查询的回应行。
 *
 * 原版专用服务端控制台打的是 en_us(`commands.difficulty.query` = "The difficulty is %s"),
 * 但服务端换语言包、或第三方核心自带中文的情况都有过,拿不准就两套都认:
 *
 *   en  「The difficulty is Easy」 / 设置后「The difficulty has been set to Easy」
 *   zh  「难度为简单」/「游戏难度为简单」 / 设置后「难度已设置为简单」
 *
 * 行首还有日志前缀(`[12:34:56] [Server thread/INFO]: `),所以不锚定行首。
 */
const DIFFICULTY_REPLY_RE =
  /(?:The difficulty (?:is|has been set to)|(?:游戏)?难度(?:为|已设(?:置|定)为|已设为))\s*([A-Za-z_]+|和平|简单|普通|困难)/;
const DIFFICULTY_TIMEOUT_MS = 10_000;

function normalizeDifficulty(raw: string): MinecraftDifficultyFact['difficulty'] {
  const zh: Record<string, MinecraftDifficultyFact['difficulty']> = {
    和平: 'peaceful', 简单: 'easy', 普通: 'normal', 困难: 'hard',
  };
  if (zh[raw]) return zh[raw];
  const en = raw.toLowerCase();
  return en === 'peaceful' || en === 'easy' || en === 'normal' || en === 'hard' ? en : null;
}

/** 从服务端一段 stdout 里认出难度回应;认不出返回 null。 */
export function parseDifficultyReply(text: string): { difficulty: MinecraftDifficultyFact['difficulty']; raw: string } | null {
  const m = DIFFICULTY_REPLY_RE.exec(text);
  if (!m) return null;
  return { difficulty: normalizeDifficulty(m[1]), raw: m[0] };
}
/**
 * 按主世界对齐各维度的 keepInventory；Paper/Bukkit 为每个维度独立存储规则。
 * 其余 gamerule 保留各维度设置。
 */
const WORLD_WIDE_GAME_RULES = ['keepInventory'] as const;

/** 待对齐的一个副维度:`id` 给 `execute in` 用,`dir` 是报给人看的目录名 */
interface DimensionRules {
  id: 'minecraft:the_nether' | 'minecraft:the_end';
  dir: string;
  rules: Record<string, string> | null;
}

/** 以主世界保存的 GameRules 为目标，为其他维度生成修改指令。 */
export function planGameRuleAlignment(
  overworld: Record<string, string> | null,
  others: readonly DimensionRules[],
): { commands: string[]; drift: string[] } {
  const commands: string[] = [];
  const drift: string[] = [];
  for (const rule of WORLD_WIDE_GAME_RULES) {
    const want = overworld?.[rule];
    if (want === undefined) continue;
    for (const other of others) {
      if (other.rules === null) {
        drift.push(`${other.dir} 的 ${rule} 读不到`);
        continue;
      }
      const has = other.rules[rule];
      if (has === want) continue;
      drift.push(`${other.dir} 的 ${rule}=${has ?? '(没写)'},主世界是 ${want}`);
      commands.push(`execute in ${other.id} run gamerule ${rule} ${want}`);
    }
  }
  return { commands, drift };
}

/** 定期发送 save-all flush。 */
const AUTO_SAVE_MS = 90_000;
/** 停止指令后等待的毫秒数；超时强制终止进程。 */
const GRACEFUL_EXIT_MS = 15_000;
const HARD_SIGNALS: NodeJS.Signals[] = process.platform === 'win32'
  ? ['SIGHUP', 'SIGBREAK']
  : ['SIGHUP'];

/** java 可执行文件的文件名。Windows 上带 `.exe`,别处不带。 */
export const JAVA_BINARY = process.platform === 'win32' ? 'java.exe' : 'java';

/** serverDir 邻近的便携 JDK:<serverDir>/../jdk/<任意版本>/bin/<java 可执行文件> */
function findAdjacentJava(serverDir: string): string | null {
  const jdkRoot = join(serverDir, '..', 'jdk');
  if (!existsSync(jdkRoot)) return null;
  for (const entry of readdirSync(jdkRoot)) {
    const candidate = join(jdkRoot, entry, 'bin', JAVA_BINARY);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 世界身份(realm):存档目录里的 cortico-realm.json
// ---------------------------------------------------------------------------

/** 存档身份写入存档目录的标记文件；目录改名或复制保留该身份。 */
export const REALM_MARKER_FILE = 'cortico-realm.json';

/** 落在存档目录里的那份 JSON。 */
interface RealmMarker {
  /** 机器层的稳定键:首次纳管时随机发一次,之后只读不改 */
  uuid: string;
  /** 首次纳管时的目录名；当前存档名取自 server.properties 的 level-name。 */
  levelName: string;
  /** 首次纳管时刻(ISO) */
  createdAt: string;
}

/** 本地存档优先使用标记文件中的 UUID；无法读取或写入时使用地址和 level-name 生成临时键。外部服务器不在此推断存档身份。 */
interface MinecraftRealm {
  /** 受管世界的稳定 uuid;marker 读写不成时为 null */
  uuid: string | null;
  /** 当下的存档目录名(server.properties 的 level-name);对她只说这个 */
  levelName: string;
}

function realmMarkerPath(worldDir: string): string {
  return join(worldDir, REALM_MARKER_FILE);
}

export function readRealmMarker(worldDir: string): RealmMarker | null {
  const file = realmMarkerPath(worldDir);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const { uuid, levelName, createdAt } = parsed as Record<string, unknown>;
    if (typeof uuid !== 'string' || !uuid.trim()) return null;
    return {
      uuid,
      levelName: typeof levelName === 'string' ? levelName : '',
      createdAt: typeof createdAt === 'string' ? createdAt : '',
    };
  } catch {
    return null;
  }
}

/** 目录中已有标记时复用；否则创建标记。写入失败返回临时身份。 */
function ensureRealmMarker(worldDir: string, levelName: string): RealmMarker {
  const existing = readRealmMarker(worldDir);
  if (existing) return existing;
  const marker: RealmMarker = { uuid: randomUUID(), levelName, createdAt: new Date().toISOString() };
  mkdirSync(worldDir, { recursive: true });
  writeFileSync(realmMarkerPath(worldDir), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  return marker;
}

export class MinecraftServerManager {
  private phase: MinecraftServerPhase = 'stopped';
  private detail: string | null = null;
  private proc: ChildProcess | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private logTail = '';

  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private healthDeadline = 0;
  /** 已装上的硬信号兜底监听;没有托管进程时为 null(不占监听位) */
  private hardSignalHook: (() => void) | null = null;
  private realmCache: { worldDir: string; realm: MinecraftRealm } | null = null;
  /** 托管进程使用的目录；运行期间配置改动留到下次启动。 */
  private activeServerDir: string | null = null;
  private realmWarned = false;
  /** 正在穿过启动探针的生命周期代次；stop 会使该代次立即失效。 */
  private startingGeneration: number | null = null;
  private lifecycleGeneration = 0;
  private difficultyWait: { proc: ChildProcess; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly opts: MinecraftServerOptions) {}

  get address(): string {
    return `${this.opts.host()}:${this.opts.port()}`;
  }

  directory(): string {
    return this.activeServerDir ?? this.opts.serverDir();
  }

  async state(): Promise<MinecraftServerState> {
    const serverDir = this.directory();
    const enabled = this.opts.enabled?.() ?? true;
    return {
      enabled,
      phase: this.phase,
      address: this.address,
      detail: enabled ? this.detail : '受管服务器开关已关闭',
      pid: this.proc?.pid ?? null,
      reachable: enabled ? await this.probe() : false,
      serverDir,
      configured: serverDir !== '' && existsSync(join(serverDir, 'server.jar')),
    };
  }

  /** 首次查询本地存档身份时可能创建标记文件。 */
  realm(): MinecraftRealm | null {
    const serverDir = this.directory();
    if (!serverDir || !existsSync(serverDir)) return null;
    let levelName: string;
    try {
      levelName = settingsFrom(loadProperties(serverDir)).levelName;
    } catch (err) {
      this.warnRealmOnce(`读 server.properties 认不出存档名: ${String(err)}`);
      return null;
    }
    const worldDir = join(serverDir, levelName);
    const hit = this.realmCache;
    if (hit && hit.worldDir === worldDir && existsSync(realmMarkerPath(worldDir))) return hit.realm;
    let uuid: string | null = null;
    try {
      uuid = ensureRealmMarker(worldDir, levelName).uuid;
    } catch (err) {
      this.warnRealmOnce(`写不进 ${join(levelName, REALM_MARKER_FILE)}(${String(err)});这个世界只能按弱身份算`);
    }
    const realm: MinecraftRealm = { uuid, levelName };
    this.realmCache = uuid ? { worldDir, realm } : null;
    return realm;
  }

  private warnRealmOnce(detail: string): void {
    if (this.realmWarned) return;
    this.realmWarned = true;
    this.opts.log.warn(`MC 世界身份不可用: ${detail}`);
  }

  async start(): Promise<MinecraftServerState> {
    if (!(this.opts.enabled?.() ?? true)) return this.state();
    if (this.startingGeneration !== null || this.phase === 'starting' || this.phase === 'running') {
      return this.state();
    }
    const generation = ++this.lifecycleGeneration;
    this.startingGeneration = generation;
    try {
      return await this.spawnServer(generation);
    } finally {
      if (this.startingGeneration === generation) this.startingGeneration = null;
    }
  }

  private async spawnServer(generation: number): Promise<MinecraftServerState> {
    if (await this.probe()) {
      if (generation !== this.lifecycleGeneration || !(this.opts.enabled?.() ?? true)) return this.state();
      this.detail = '端口已可连接，未启动托管进程';
      return this.state();
    }
    if (generation !== this.lifecycleGeneration || !(this.opts.enabled?.() ?? true)) return this.state();
    const launch = this.resolveLaunch();
    if ('error' in launch) {
      this.setPhase('error', launch.error);
      return this.state();
    }
    this.activeServerDir = launch.cwd ?? this.opts.serverDir();
    const portFix = this.opts.commandOverride ? null : this.alignServerPort();
    if (portFix) this.opts.log.warn(`MC 服务器端口纠偏: ${portFix}`);
    const realm = this.realm();
    if (realm) {
      this.opts.log.info(`MC 世界纳管: 存档「${realm.levelName}」${realm.uuid ? '' : '(无身份标记,按弱身份算)'}`);
    }
    this.logTail = '';
    const proc = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    // 对端退出后再写 stdin,EPIPE 从流上异步冒出来,write 外面的 try/catch 接不住。
    proc.stdin?.on('error', (err) => this.opts.log.debug('MC 服务器 stdin 写入失败', { err }));
    this.setPhase('starting', portFix ? `世界加载中(${portFix})` : '世界加载中');
    const tail = (chunk: Buffer) => {
      const text = chunk.toString();
      this.logTail = (this.logTail + text).slice(-2000);
      this.consumeDifficultyReply(proc, text);
      if (this.proc !== proc || this.phase !== 'starting') return;
      if (PROGRESS_RE.test(text)) this.healthDeadline = Date.now() + PROGRESS_GRACE_MS;
      if (READY_RE.test(text)) {
        this.setPhase('running', null);
        this.clearHealthTimer();
        this.beginAutoSave();
        this.queryDifficulty();
        this.alignGameRules();
        this.opts.log.info(`MC 服务器就绪 ${this.address}(服务端自报 Done)`);
      }
    };
    proc.stdout?.on('data', tail);
    proc.stderr?.on('data', tail);
    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      this.fail(`进程启动失败: ${err.message}`);
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.clearDifficultyWait();
      this.removeHardSignalHook();
      if (this.phase === 'stopped') return;
      const detail = `进程退出 code=${code};日志尾部: ${this.logTail.slice(-400)}`;
      this.finish(code === 0 ? 'stopped' : 'error', detail);
    });
    this.installHardSignalHook();
    this.opts.log.info(`MC 服务器启动中 pid=${proc.pid} ${this.address}`);
    this.beginHealthPolling();
    return this.state();
  }

  async stop(): Promise<MinecraftServerState> {
    ++this.lifecycleGeneration;
    this.startingGeneration = null;
    this.clearHealthTimer();
    this.clearSaveTimer();
    this.clearDifficultyWait();
    this.removeHardSignalHook();
    this.setPhase('stopped', null);
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      await this.gracefulKill(proc);
      this.opts.log.info('MC 服务器已停止');
    }
    this.activeServerDir = null;
    return this.state();
  }

  /** 仅在托管进程存在时监听终止信号，收到信号后尝试向 stdin 写入存档和停止指令。 */
  private installHardSignalHook(): void {
    if (this.hardSignalHook) return;
    const hook = (): void => this.saveOnHardSignal();
    for (const sig of HARD_SIGNALS) process.on(sig, hook);
    this.hardSignalHook = hook;
  }

  private removeHardSignalHook(): void {
    const hook = this.hardSignalHook;
    if (!hook) return;
    this.hardSignalHook = null;
    for (const sig of HARD_SIGNALS) process.removeListener(sig, hook);
  }

  /** 信号回调只写入指令，不等待退出。 */
  private saveOnHardSignal(): void {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    this.opts.log.warn('收到硬关信号:先给 MC 服务器补一次 save-all + stop(兜底,正门是控制台关机键)');
    this.command('save-all flush');
    this.command('stop');
  }

  /** 发送 save-all flush 和 stop 后等待进程退出，超时强制终止；未核验存档结果。 */
  private async gracefulKill(proc: ChildProcess): Promise<void> {
    try {
      proc.stdin?.write('save-all flush\n');
      proc.stdin?.write('stop\n');
    } catch {
      /* stdin 已关 */
    }
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
        resolve();
      }, GRACEFUL_EXIT_MS);
      proc.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
    });
  }


  private beginAutoSave(): void {
    this.clearSaveTimer();
    this.saveTimer = setInterval(() => {
      if (this.phase !== 'running') { this.clearSaveTimer(); return; }
      this.command('save-all');
    }, this.opts.autoSaveMs ?? AUTO_SAVE_MS);
    this.saveTimer.unref?.();
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = null;
  }

  /**
   * 服务端就绪后用无参 difficulty 查询启动时实际难度。
   * 仅自管服务器有 stdin 可查询；已发送而未收到答复时报告，运行期变更不在此监听。
   */
  private queryDifficulty(): void {
    this.clearDifficultyWait();
    const proc = this.proc;
    if (!proc || !this.command('difficulty')) return;
    const timer = setTimeout(() => {
      if (this.difficultyWait?.proc !== proc) return;
      this.difficultyWait = null;
      this.opts.log.warn('MC 难度回读:服务端没有在期限内回话');
      this.reportDifficulty({ difficulty: null, raw: null, properties: this.propertiesDifficulty() });
    }, this.opts.difficultyTimeoutMs ?? DIFFICULTY_TIMEOUT_MS);
    timer.unref?.();
    this.difficultyWait = { proc, timer };
  }

  private consumeDifficultyReply(proc: ChildProcess, text: string): void {
    if (this.difficultyWait?.proc !== proc) return;
    const hit = parseDifficultyReply(text);
    if (!hit) return;
    this.clearDifficultyWait();
    this.reportDifficulty({
      difficulty: hit.difficulty,
      raw: hit.raw,
      properties: this.propertiesDifficulty(),
    });
  }

  private reportDifficulty(fact: MinecraftDifficultyFact): void {
    this.opts.log.info(
      `MC 难度回读: ${fact.difficulty ?? '没认出来'}` +
      `${fact.raw ? `(服务端原话「${fact.raw}」)` : ''}` +
      `${fact.properties ? `;server.properties 写的是 ${fact.properties}` : ''}`,
    );
    this.opts.onDifficulty?.(fact);
  }

  private clearDifficultyWait(): void {
    if (this.difficultyWait) clearTimeout(this.difficultyWait.timer);
    this.difficultyWait = null;
  }

  /** 读取配置中的难度；无法读取返回 null。 */
  private propertiesDifficulty(): string | null {
    const dir = this.directory();
    if (!dir) return null;
    try {
      const value = readProperty(loadProperties(dir), 'difficulty');
      return value?.trim() || null;
    } catch {
      return null;
    }
  }

  /** 使用 level.dat 中最近保存的主世界 GameRules；运行中尚未保存的更改不在此快照中。 */
  private alignGameRules(): void {
    const serverDir = this.directory();
    if (!serverDir || !existsSync(serverDir)) return;
    let levelName: string;
    try {
      levelName = settingsFrom(loadProperties(serverDir)).levelName;
    } catch {
      return;
    }
    const rulesOf = (dir: string): Record<string, string> | null =>
      readLevelDat(join(serverDir, dir, 'level.dat'))?.gameRules ?? null;
    const plan = planGameRuleAlignment(rulesOf(levelName), [
      { id: 'minecraft:the_nether', dir: `${levelName}_nether`, rules: rulesOf(`${levelName}_nether`) },
      { id: 'minecraft:the_end', dir: `${levelName}_the_end`, rules: rulesOf(`${levelName}_the_end`) },
    ]);
    if (plan.drift.length === 0) return;
    const sent = plan.commands.length > 0 && plan.commands.every((line) => this.command(line));
    this.opts.log.warn(
      `MC gamerule 各维度对不上:${plan.drift.join(';')}`
      + (plan.commands.length === 0
        ? ''
        : sent
          ? `；已发送 ${plan.commands.length} 条 gamerule 修改指令`
          : `；无法写入 stdin，请手动执行:${plan.commands.join(' / ')}`),
    );
  }

  /** 仅向受托管服务器的 stdin 写入指令；外部服务器返回 false。 */
  command(line: string): boolean {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || !proc.stdin?.writable) return false;
    try {
      proc.stdin.write(`${line}\n`);
      return true;
    } catch {
      return false;
    }
  }

  probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = connect({ host: this.opts.host(), port: this.opts.port(), timeout: 1500 });
      const done = (ok: boolean) => {
        sock.destroy();
        resolve(ok);
      };
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    });
  }

  private resolveLaunch():
    | { command: string; args: string[]; cwd: string | undefined }
    | { error: string } {
    if (this.opts.commandOverride) {
      return { command: this.opts.commandOverride.command, args: this.opts.commandOverride.args, cwd: undefined };
    }
    const serverDir = this.opts.serverDir();
    if (!serverDir) {
      return { error: '未配置服务器目录:在本 World 配置里填 worlds.minecraft.local.serverDir(含 server.jar 的目录)' };
    }
    const jar = join(serverDir, 'server.jar');
    if (!existsSync(jar)) return { error: `找不到 ${jar};确认 worlds.minecraft.local.serverDir 配置` };
    let java = this.opts.javaPath();
    if (!java) {
      java = findAdjacentJava(serverDir) ?? 'java';
    } else if (!existsSync(java)) {
      return { error: `找不到 java: ${java};确认 worlds.minecraft.local.javaPath 配置` };
    }
    return {
      command: java,
      args: [...this.opts.jvmArgs().split(/\s+/).filter(Boolean), '-jar', 'server.jar', 'nogui'],
      cwd: serverDir,
    };
  }

  /** 启动前将 server.properties 的 server-port 写为配置端口。 */
  private alignServerPort(): string | null {
    const serverDir = this.directory();
    if (!serverDir) return null;
    try {
      const lines = loadProperties(serverDir);
      if (lines.length === 0) return null;
      const want = String(this.opts.port());
      const got = (readProperty(lines, 'server-port') ?? '').trim();
      if (got === want) return null;
      saveProperties(serverDir, writeProperty(lines, 'server-port', want));
      return `server.properties 里的 server-port 是 ${got || '(空)'},已改回 ${want}`;
    } catch (err) {
      this.opts.log.warn(`读写 server.properties 失败: ${String(err)}`);
      return null;
    }
  }

  private beginHealthPolling(): void {
    this.clearHealthTimer();
    const interval = this.opts.healthIntervalMs ?? 2_000;
    const proc = this.proc;
    this.healthDeadline = Date.now() + (this.opts.healthTimeoutMs ?? 120_000);
    this.healthTimer = setInterval(async () => {
      if (this.phase !== 'starting') {
        this.clearHealthTimer();
        return;
      }
      const reachable = await this.probe();
      if (this.phase !== 'starting' || this.proc !== proc) return;
      if (reachable) {
        this.setPhase('running', null);
        this.clearHealthTimer();
        this.beginAutoSave();
        this.queryDifficulty();
        this.alignGameRules();
        this.opts.log.info(`MC 服务器就绪 ${this.address}`);
        return;
      }
      if (Date.now() > this.healthDeadline) {
        const orphan = this.proc;
        this.proc = null;
        this.fail('启动超时(世界生成过久或端口不对)');
        if (orphan) void this.gracefulKill(orphan);
      }
    }, interval);
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private fail(detail: string): void {
    this.finish('error', detail);
  }

  /** 清理进程引用、定时器及待处理的难度查询。 */
  private finish(phase: 'error' | 'stopped', detail: string): void {
    this.clearHealthTimer();
    this.clearSaveTimer();
    this.removeHardSignalHook();
    if (this.proc === null) this.activeServerDir = null;
    this.setPhase(phase, detail);
    if (phase === 'error') this.opts.log.error(`MC 服务器异常: ${detail}`);
    else this.opts.log.info(`MC 服务器已退出: ${detail}`);
  }

  private setPhase(next: MinecraftServerPhase, detail: string | null): void {
    const changed = this.phase !== next;
    this.phase = next;
    this.detail = detail;
    if (changed) this.opts.onPhase?.(next, detail);
  }
}
