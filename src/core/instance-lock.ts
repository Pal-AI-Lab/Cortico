/**
 * 单实例锁按 dataDir 隔离，防止同一数据目录被多个进程并发写入。
 * 使用 wx 排他创建；陈旧锁通过临时文件、rename 和读回核对接管，竞争失败则拒绝启动。
 * force 仅放行当前进程，不取得锁所有权，退出时不删除其他实例的锁。
 * PID 复用:锁 startedAt 早于本机开机时刻，或该 PID 现在的可执行文件名与锁里记的 execPath 不同，都按陈旧锁处理。
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { uptime } from 'node:os';
import { basename, join } from 'node:path';
import type { Logger } from './types.ts';
import { nullLogger } from './util.ts';

export const INSTANCE_LOCK_FILE = 'instance.lock';

interface LockPayload {
  pid: number;
  startedAt: string;
  argv: string[];
  /** 写锁进程的 process.execPath;旧版本写的锁没有这一项。 */
  execPath?: string;
}

/** 未取得锁且没有 force:锁记录指向运行中的进程，或接管时被另一进程抢先。 */
export class InstanceLockedError extends Error {
  constructor(
    message: string,
    /** 当前锁记录的 PID;锁文件读不出时 null。 */
    readonly pid: number | null,
    readonly file: string,
  ) {
    super(message);
    this.name = 'InstanceLockedError';
  }
}

export interface InstanceLock {
  /** 锁文件路径(诊断用) */
  readonly file: string;
  /** 使用 force 跳过占用检查时不取得锁所有权。 */
  readonly owns: boolean;
  /** 释放:只删自己写的那把锁 */
  release(): void;
}

/** signal 0 检查进程存在性和权限，不发送实际信号。 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM 说明进程存在，但当前进程无权向其发送信号。
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** PID 对应进程的可执行文件名(小写);进程不在或查不到时 null。 */
function imageName(pid: number): string | null {
  if (process.platform === 'win32') {
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
    const row = /^"([^"]+)","(\d+)"/m.exec(out);
    return row && Number(row[2]) === pid ? row[1].toLowerCase() : null;
  }
  if (process.platform === 'linux') {
    try {
      // 程序文件在进程运行期间被替换时，链接目标带 " (deleted)" 后缀
      return basename(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '')).toLowerCase();
    } catch {
      return null;
    }
  }
  const out = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).stdout?.trim();
  return out ? basename(out).toLowerCase() : null;
}

/**
 * 同号 PID 存活时，启动时刻早于本机开机时刻、或可执行文件名与锁里记的不同，都不视为原锁所有者。
 * 启动时刻无法解析时跳过开机时刻比较；锁里没有 execPath 或查不到进程文件名时跳过文件名比较。
 */
function ownerStillRunning(p: LockPayload): boolean {
  if (!isAlive(p.pid)) return false;
  const startedAt = Date.parse(p.startedAt);
  if (!Number.isNaN(startedAt) && startedAt < Date.now() - uptime() * 1000) return false;
  if (p.execPath === undefined) return true;
  const image = imageName(p.pid);
  return image === null || image === basename(p.execPath).toLowerCase();
}

function readPayload(file: string): LockPayload | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockPayload>;
    if (!Number.isInteger(raw.pid)) return null;
    return {
      pid: raw.pid as number,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '(未记录)',
      argv: Array.isArray(raw.argv) ? raw.argv.map(String) : [],
      ...(typeof raw.execPath === 'string' ? { execPath: raw.execPath } : {}),
    };
  } catch {
    return null;
  }
}

/** 只读检查数据目录的锁是否仍对应存活进程。 */
export function instanceIsRunning(dataDir: string): boolean {
  const payload = readPayload(join(dataDir, INSTANCE_LOCK_FILE));
  return payload !== null && ownerStillRunning(payload);
}

/** 排他创建；仅 EEXIST 返回 false，其他错误抛出。 */
function createExclusive(file: string, payload: LockPayload): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(payload, null, 2), null, 'utf8');
  } finally {
    closeSync(fd);
  }
  return true;
}

/** 通过临时文件替换陈旧锁；读回 PID 核对所有权，替换或核对失败返回 false。 */
function takeOver(file: string, payload: LockPayload): boolean {
  const tmp = `${file}.${payload.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    try { rmSync(tmp); } catch { /* 临时文件删不掉不影响判定 */ }
    return false;
  }
  return readPayload(file)?.pid === payload.pid;
}

/**
 * 占用锁对应的进程仍存在时拒绝启动，错误包含 PID 与启动时刻。
 * force 可跳过检查并记录错误；该进程不取得锁所有权，退出时不删除锁。
 */
export function acquireInstanceLock(
  dataDir: string,
  opts: { force?: boolean; log?: Logger } = {},
): InstanceLock {
  const log = opts.log ?? nullLogger();
  const file = join(dataDir, INSTANCE_LOCK_FILE);
  const mine: LockPayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(1),
    execPath: process.execPath,
  };

  let owns = createExclusive(file, mine);
  if (!owns) {
    const existing = readPayload(file);
    if (existing && ownerStillRunning(existing)) {
      if (!opts.force) {
        throw new InstanceLockedError(
          `数据目录的锁记录指向运行中的进程(pid ${existing.pid}${existing.execPath ? `,可执行文件 ${basename(existing.execPath)}` : ''},记录的启动时刻 ${existing.startedAt})。` +
          `请检查锁记录及对应进程；需跳过占用检查时使用 --force-second-instance。锁文件:${file}`,
          existing.pid,
          file,
        );
      }
      log.error("锁记录对应的进程仍存在；已按 --force-second-instance 跳过检查，未取得锁所有权", {
        otherPid: existing.pid,
        otherStartedAt: existing.startedAt,
        file,
      });
    } else {
      // 锁无法读取，或其记录不满足存活所有者条件。
      owns = takeOver(file, mine);
      if (owns) {
        log.warn("已接管无法读取或已失效的实例锁", {
          stalePid: existing?.pid ?? null,
          staleStartedAt: existing?.startedAt ?? null,
          unreadable: existing === null,
          file,
        });
      } else {
        // 替换或读回核对失败，当前进程未获得锁所有权。
        const winner = readPayload(file);
        if (!opts.force) {
          throw new InstanceLockedError(
            `未取得数据目录的锁所有权(当前锁记录 PID: ${winner?.pid ?? '未知'})。` +
            `请检查锁记录及对应进程；需跳过占用检查时使用 --force-second-instance。锁文件:${file}`,
            winner?.pid ?? null,
            file,
          );
        }
        log.error("获取实例锁失败；已按 --force-second-instance 跳过检查，未取得锁所有权", {
          otherPid: winner?.pid ?? null,
          file,
        });
      }
    }
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    // 释放时移除退出钩子，避免重复获取锁时累积监听器。
    process.off('exit', release);
    if (!owns) return;
    // 仅删除仍记录当前 PID 的锁。
    const now = existsSync(file) ? readPayload(file) : null;
    if (now?.pid !== mine.pid) return;
    try {
      rmSync(file);
    } catch {
      // 删除失败后由下次启动检查该锁。
    }
  };
  process.on('exit', release);
  return { file, owns, release };
}
