/**
 * 管理观察者或玩家客户端进程。Windows 通过 ownerPid 的可见窗口判断就绪，其他平台使用 stdout 标记。
 * 进服后的附身和传送由 world.ts 编排；窗口标题按账号名设置，并在直连加载后重设一次。
 */
import { logLines } from '../../core/ipc-logger.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../core/types.ts';
import { buildClientLaunch, soleVersionId } from './client-launch.ts';
import { applyChatVisible, applyLaunchOptions, applySpectatorPlusConfig } from './client-options.ts';
import { applySkins } from './client-skins.ts';
import { findWindow, setWindowTitle } from './window.ts';

type ClientPhase = 'stopped' | 'starting' | 'running' | 'error';

export interface ClientState {
  phase: ClientPhase;
  /** 配置里开着(World 启动时会自动拉起);关着也仍可在面板里手动启停 */
  enabled: boolean;
  detail: string | null;
  pid: number | null;
  /** 已检测到窗口就绪。 */
  windowReady: boolean;
  /** 当前进程所用目录；停机时为下一次启动的配置目录。 */
  gameDir: string;
  versionId: string;
  username: string;
  /** 游戏目录与版本齐备 */
  configured: boolean;
  /** 供控制台预览的命令行;解析失败时为 null。 */
  command: string | null;
}

export interface GameClientOptions {
  /** 日志与状态里怎么称呼这一份客户端(「观察者客户端」/「玩家客户端」) */
  label: string;
  enabled: () => boolean;
  gameDir: () => string;
  versionId: () => string;
  javaPath: () => string;
  /** 额外 JVM 参数,空格分隔 */
  jvmArgs: () => string;
  username: () => string;
  width: () => number;
  height: () => number;
  /** 进游戏直连服务器 */
  autoJoin: () => boolean;
  server: () => { host: string; port: number };
  /**
   * 启动前调整该游戏目录的设置:关 pauseOnLostFocus(切走时不弹暂停菜单),
   * 并按 syncGui 写 SpectatorPlus 的同步屏幕开关。
   */
  noPauseOnLostFocus: () => boolean;
  /** 启动前写入 SpectatorPlus 的 GUI 同步开关；未指定时关闭，重启客户端生效。 */
  syncGui?: () => boolean;
  /** 启动前将 chatVisibility 设为 FULL，用于与观察者共用 gameDir 的玩家客户端。 */
  chatUsable: () => boolean;
  /** 启动前将所选账号皮肤写入客户端目录，由 CustomSkinLoader 读取。 */
  skins?: () => Array<{ username: string; bytes: Buffer }>;
  /** 异常退出后的自动重启上限；0 或省略时不重启。人为 stop() 永不重启。 */
  restartMax?: () => number;
  /** 第一次重启前等多久,之后逐次加倍 */
  restartBackoffMs?: number;
  /** 相邻异常退出间隔超过此值时，重启计数归零。 */
  restartWindowMs?: number;
  /** 非预期退出时通知；attempt 为重启序号，0 表示不再重启。 */
  onCrash?: (info: { detail: string; attempt: number; max: number; delayMs: number }) => void;
  /** World 是否正在关闭。关闭期的 Ctrl+C 按正常退出处理，不报故障或安排重启；省略时视为未关闭。 */
  shuttingDown?: () => boolean;
  log: Logger;
  /** 窗口出现(自动重启后再次就绪也会来) */
  onReady?: () => void;
  /** 测试注入:替换 spawn 目标,跳过版本 JSON 解析 */
  commandOverride?: { command: string; args: string[] };
  windowPollMs?: number;
  windowTimeoutMs?: number;
  /** 直连加载后延迟重设窗口标题的时间。 */
  titleSettleMs?: number;
  /** 测试注入:窗口是否已出现 */
  findWindow?: (opts: { ownerPid: number }) => Promise<boolean>;
  /** 测试注入:改标题 */
  setWindowTitle?: (opts: { ownerPid: number; title: string; log?: Logger }) => Promise<boolean>;
}

/** OBS 用来区分两份客户端的窗口标题:账号名。空名字不改。 */
export function clientWindowTitle(username: string): string | null {
  const title = username.trim();
  return title || null;
}

/** 将 Windows 32 位 NTSTATUS 退出码格式化为十六进制及已知含义。 */
const NATIVE_EXIT_REASONS: Record<number, string> = {
  0xc0000005: '原生访问违例',
  0xc0000017: '内存不足',
  0xc000013a: '控制台 Ctrl+C 或关窗',
  0xc0000409: '栈缓冲区溢出',
};

/** 控制台 Ctrl+C / 关窗的原生退出码。关机流程里收到它不算崩 */
const CTRL_C_EXIT = 0xc000013a;

/** 非 Windows 平台通过 stdout 中的建窗标记判断就绪；Windows 使用 ownerPid 匹配窗口。 */
const WINDOW_READY_LINE = /Backend library: LWJGL/;

/** 保存标记两倍长度的尾部，以匹配跨 stdout chunk 的标记。 */
const WINDOW_SCAN_CARRY = 64;

/** 逐段扫描 stdout，保留上段尾部用于跨段匹配。 */
export function scanWindowReady(carry: string, chunk: string): { seen: boolean; carry: string } {
  const scanned = carry + chunk;
  if (WINDOW_READY_LINE.test(scanned)) return { seen: true, carry: '' };
  return { seen: false, carry: scanned.slice(-WINDOW_SCAN_CARRY) };
}

export function explainExit(code: number | null): string {
  if (code === null) return '进程已退出(没有退出码)';
  if (code <= 0xffff) return `code=${code}`;
  const reason = NATIVE_EXIT_REASONS[code];
  return `code=${code}(0x${code.toString(16).toUpperCase()})${reason ? `,${reason}` : ''}`;
}

/** 将 natives jar 中的 DLL 解压到 natives 根目录,满足 LWJGL2 加载约定。 */
function prepareNatives(nativeJars: string[], nativesDir: string, log: Logger): void {
  if (nativeJars.length === 0) return;
  mkdirSync(nativesDir, { recursive: true });
  for (const jar of nativeJars) {
    try {
      // Windows 自带的 bsdtar 认 zip;jar 就是 zip
      const proc = spawn('tar', ['-xf', jar, '-C', nativesDir, '*.dll'], { windowsHide: true });
      proc.on('error', () => undefined);
    } catch {
      /** 解压失败时保留 classpath 加载路径。 */
    }
  }
  // 解出来的 dll 可能带着 windows/x64/... 的路径,摊平到根下
  const flatten = (dir: string, depth: number): void => {
    if (depth > 6 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      try {
        if (statSync(abs).isDirectory()) flatten(abs, depth + 1);
        else if (entry.toLowerCase().endsWith('.dll') && dir !== nativesDir) {
          renameSync(abs, join(nativesDir, entry));
        }
      } catch (err) {
        log.debug?.(`natives 摊平跳过 ${abs}: ${(err as Error).message}`);
      }
    }
  };
  setTimeout(() => flatten(nativesDir, 0), 1_500);
}

export class GameClient {
  private phase: ClientPhase = 'stopped';
  private detail: string | null = null;
  private proc: ChildProcess | null = null;
  private windowReady = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private titleTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** 相邻异常退出计数及上次时刻。 */
  private crashCount = 0;
  private lastCrashAt = 0;
  private logTail = '';
  /** 非 Windows 的就绪判定:{@link WINDOW_READY_LINE} 在 stdout 上出现过没有。 */
  private windowLineSeen = false;
  /** 跨 chunk 的接缝:锚点那行可能被切成两段送来。只留够拼回一行的长度。 */
  private windowScanCarry = '';
  /** 当前进程启动时使用的目录；配置改动在停止后生效。 */
  private activeGameDir: string | null = null;

  constructor(private readonly opts: GameClientOptions) {}

  /** 当前已就绪进程的 PID，供帧源匹配窗口；未就绪时为 null。 */
  windowHint(): { pid: number } | null {
    const pid = this.proc?.pid;
    return this.windowReady && pid !== undefined ? { pid } : null;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  directory(): string {
    return this.activeGameDir ?? this.opts.gameDir();
  }

  async state(): Promise<ClientState> {
    const gameDir = this.directory();
    const versionId = this.opts.versionId() || (gameDir ? soleVersionId(gameDir) ?? '' : '');
    const launch = this.resolveLaunch(gameDir);
    const broken = 'error' in launch ? launch.error : null;
    return {
      phase: this.phase,
      enabled: this.opts.enabled(),
      detail: this.detail ?? broken,
      pid: this.proc?.pid ?? null,
      windowReady: this.windowReady,
      gameDir,
      versionId,
      username: this.opts.username(),
      configured: broken === null,
      command: 'error' in launch ? null : [launch.command, ...launch.args].join(' '),
    };
  }

  async start(): Promise<ClientState> {
    if (this.phase === 'starting' || this.phase === 'running') return this.state();
    const gameDir = this.opts.gameDir();
    const launch = this.resolveLaunch(gameDir);
    if ('error' in launch) {
      this.phase = 'error';
      this.detail = launch.error;
      return this.state();
    }
    this.activeGameDir = gameDir;
    if ('missingLibraries' in launch && launch.missingLibraries.length > 0) {
      this.opts.log.warn(`${this.opts.label}版本 JSON 点名的 ${launch.missingLibraries.length} 个库`
        + `不在 libraries 目录,类路径里没有它们:${launch.missingLibraries.join(' ')}`);
    }
    if ('nativeJars' in launch) prepareNatives(launch.nativeJars, launch.nativesDir, this.opts.log);
    if (!this.opts.commandOverride) {
      if (this.opts.noPauseOnLostFocus()) {
        applyLaunchOptions(gameDir, this.opts.log);
        applySpectatorPlusConfig(gameDir, this.opts.log, this.opts.syncGui?.() ?? false);
      }
      if (this.opts.chatUsable()) applyChatVisible(gameDir, this.opts.log);
      const skins = this.opts.skins?.();
      if (skins) applySkins(gameDir, skins, this.opts.log);
    }
    this.logTail = '';
    const proc = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
    this.proc = proc;
    this.phase = 'starting';
    this.windowReady = false;
    this.windowLineSeen = false;
    this.windowScanCarry = '';
    this.detail = '客户端启动中';
    const tail = (chunk: Buffer) => {
      const text = chunk.toString();
      this.logTail = (this.logTail + text).slice(-2000);
      if (this.windowLineSeen) return;
      const scan = scanWindowReady(this.windowScanCarry, text);
      this.windowLineSeen = scan.seen;
      this.windowScanCarry = scan.carry;
    };
    proc.stdout?.on('data', tail);
    proc.stderr?.on('data', tail);
    logLines(proc.stdout, this.opts.log.child('client'), 'debug', 'stdout');
    logLines(proc.stderr, this.opts.log.child('client'), 'debug', 'stderr');
    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      this.fail(`进程启动失败: ${err.message}`);
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.windowReady = false;
      if (this.phase === 'stopped') return; // 人为停止、正常退出及关闭期的 Ctrl+C 均不触发故障重启。
      if (code === 0 || (code === CTRL_C_EXIT && this.opts.shuttingDown?.())) {
        this.clearTimer();
        this.phase = 'stopped';
        this.detail = null;
        this.activeGameDir = null;
        this.opts.log.info(`${this.opts.label}正常退出(${explainExit(code)}),不重启`);
        return;
      }
      const detail = `客户端退出 ${explainExit(code)};完整日志 ${this.gameLogPath()};stdout 末尾: ${this.logTail.slice(-400)}`;
      this.opts.log.emit('error', `${this.opts.label}进程退出`, { event: 'exit', data: { exitCode: code, gameLog: this.gameLogPath() } });
      this.fail(detail);
      /** 仅进程非预期退出触发自动重启；spawn 失败和窗口就绪超时不重启。 */
      this.scheduleRestart(detail);
    });
    this.opts.log.info(`${this.opts.label}启动中 pid=${proc.pid}`);
    this.beginWindowPolling();
    return this.state();
  }

  async stop(): Promise<ClientState> {
    this.clearTimer();
    this.phase = 'stopped';
    this.detail = null;
    this.windowReady = false;
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      try { proc.kill(); } catch { /* 已退出 */ }
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
          resolve();
        }, 5_000);
        proc.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
      });
      this.opts.log.info(`${this.opts.label}已关闭`);
    }
    this.activeGameDir = null;
    return this.state();
  }

  private resolveLaunch(gameDir = this.directory()): ReturnType<typeof buildClientLaunch> | { command: string; args: string[]; cwd: string | undefined } {
    if (this.opts.commandOverride) {
      return { command: this.opts.commandOverride.command, args: this.opts.commandOverride.args, cwd: undefined };
    }
    const server = this.opts.server();
    return buildClientLaunch({
      gameDir,
      versionId: this.opts.versionId(),
      javaPath: this.opts.javaPath(),
      username: this.opts.username(),
      jvmArgs: this.opts.jvmArgs().split(/\s+/).filter(Boolean),
      width: this.opts.width(),
      height: this.opts.height(),
      joinServer: this.opts.autoJoin() ? server : null,
    });
  }

  private beginWindowPolling(): void {
    this.clearTimer();
    const interval = this.opts.windowPollMs ?? 4_000;
    const deadline = Date.now() + (this.opts.windowTimeoutMs ?? 180_000);
    this.pollTimer = setInterval(async () => {
      const pid = this.proc?.pid;
      if (this.phase !== 'starting' || pid === undefined) {
        this.clearTimer();
        return;
      }
      const seen = await this.windowSeen(pid);
      if (seen) {
        if (this.phase !== 'starting') return;
        this.phase = 'running';
        this.detail = null;
        this.windowReady = true;
        this.clearTimer();
        this.opts.log.info(`${this.opts.label}窗口已就绪`);
        if (process.platform !== 'win32') {
          this.opts.log.warn(`${this.opts.label}窗口标题改不了(只有 Windows 那条路能改),`
            + 'OBS 里要靠人自己选窗口,不能按账号名认。');
        }
        void this.applyWindowTitle();
        if (this.opts.autoJoin()) {
          const settle = this.opts.titleSettleMs ?? 8_000;
          this.titleTimer = setTimeout(() => { void this.applyWindowTitle(); }, settle);
        }
        this.opts.onReady?.();
        return;
      }
      if (Date.now() > deadline) {
        const waited = process.platform === 'win32'
          ? '等窗口超时'
          : `等窗口超时(本平台按 stdout 上的「${WINDOW_READY_LINE.source}」判定)`;
        this.fail(`${waited};完整日志 ${this.gameLogPath()};stdout 末尾: ${this.logTail.slice(-400)}`);
      }
    }, interval);
  }

  /** Windows 查询 ownerPid 对应的可见窗口；其他平台要求进程仍运行且已读到建窗标记。 */
  private async windowSeen(pid: number): Promise<boolean> {
    if (this.opts.findWindow) return this.opts.findWindow({ ownerPid: pid });
    if (process.platform === 'win32') return findWindow({ ownerPid: pid, log: this.opts.log });
    return this.proc?.exitCode === null && this.windowLineSeen;
  }

  /** 客户端日志文件路径。 */
  private gameLogPath(): string {
    return join(this.directory(), 'logs', 'latest.log');
  }

  private async applyWindowTitle(): Promise<void> {
    const title = clientWindowTitle(this.opts.username());
    const pid = this.proc?.pid;
    if (!title || pid === undefined) return;
    const set = this.opts.setWindowTitle ?? setWindowTitle;
    const ok = await set({ ownerPid: pid, title, log: this.opts.log });
    if (ok) this.opts.log.info(`${this.opts.label}窗口标题已设为 ${title}`);
  }

  /** 异常退出按配置指数退避重启；相邻崩溃间隔超过 restartWindowMs 时重置计数，超过重启上限后停止重试并报告。 */
  private scheduleRestart(detail: string): void {
    const max = this.opts.restartMax?.() ?? 0;
    const windowMs = this.opts.restartWindowMs ?? 600_000;
    const now = Date.now();
    if (this.lastCrashAt > 0 && now - this.lastCrashAt > windowMs) this.crashCount = 0;
    this.lastCrashAt = now;
    this.crashCount += 1;
    if (max <= 0 || this.crashCount > max) {
      this.opts.onCrash?.({ detail, attempt: 0, max, delayMs: 0 });
      return;
    }
    const delayMs = (this.opts.restartBackoffMs ?? 30_000) * 2 ** (this.crashCount - 1);
    this.opts.onCrash?.({ detail, attempt: this.crashCount, max, delayMs });
    this.opts.log.info(`${this.opts.label}将在 ${Math.round(delayMs / 1000)} 秒后自动重启(第 ${this.crashCount}/${max} 次)`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.phase === 'stopped') return;
      void this.start();
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private clearTimer(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.titleTimer) clearTimeout(this.titleTimer);
    this.titleTimer = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private fail(detail: string): void {
    this.clearTimer();
    this.phase = 'error';
    this.detail = detail;
    this.windowReady = false;
    if (this.proc === null) this.activeGameDir = null;
    // 观察者窗口中断影响播出画面，按 error 记录。
    this.opts.log.error(`${this.opts.label}异常: ${detail}`);
  }
}
