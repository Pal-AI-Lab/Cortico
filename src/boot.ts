/**
 * 向 bin/cortico.mjs 请求重启。先写标志文件，再发 IPC 消息，文件作为通知中断时的 fallback。
 * 仅在 CORTICO_SUPERVISED 启用时使用 IPC；其他宿主可能将同一通道用于自己的协议。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RESTART_FLAG_FILE = '.restart-request';

/** 表示进程由支持重启的启动器监管。 */
export const SUPERVISED_ENV = 'CORTICO_SUPERVISED';

/** 与 bin/cortico.mjs 的 RESTART_MESSAGE 保持一致。 */
export const RESTART_MESSAGE = 'cortico:restart';
/** 上报 data 目录；与 bin/cortico.mjs 的 READY_MESSAGE 保持一致。 */
export const READY_MESSAGE = 'cortico:ready';

export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SUPERVISED_ENV] === '1' || env[SUPERVISED_ENV] === 'true';
}

/**
 * 启动时是否暂停事件投递。每一轮受监管的启动拿到同一份环境和同一串参数，
 * 所以这个值也是重启后的状态。
 */
export function startsPaused(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): boolean {
  return env.CORTICO_START_PAUSED === '1' || env.CORTICO_START_PAUSED === 'true' || argv.includes('--paused');
}

function notifyLauncher(message: { type: string; dataDir?: string }, env = process.env): void {
  if (!isSupervised(env)) return;
  process.send?.(message);
}

export function announceDataDir(dataDir: string, env = process.env): void {
  notifyLauncher({ type: READY_MESSAGE, dataDir }, env);
}

/** 请求重启后，由调用方执行关机。 */
export function requestRestart(dataDir: string, env = process.env): void {
  writeFileSync(join(dataDir, RESTART_FLAG_FILE), new Date().toISOString() + '\n', 'utf8');
  notifyLauncher({ type: RESTART_MESSAGE }, env);
}

export function consumeBootFlags(dataDir: string): void {
  const restartFlag = join(dataDir, RESTART_FLAG_FILE);
  if (existsSync(restartFlag)) {
    try {
      rmSync(restartFlag);
    } catch {
      // 启动器也会删除此标志；直接启动时残留文件不触发重启。
    }
  }
}

export function listensOnEveryInterface(bound: string | null): boolean {
  return bound === '0.0.0.0' || bound === '::';
}

/** 本机打得开的控制台地址:监听所有网卡时给回环地址,IPv6 加方括号。 */
export function consoleUrlOf(bound: string | null, port: number): string {
  const host = bound === null || listensOnEveryInterface(bound) ? '127.0.0.1' : bound.includes(':') ? `[${bound}]` : bound;
  return `http://${host}:${port}/`;
}
