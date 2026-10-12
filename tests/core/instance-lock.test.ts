/**
 * 单实例守卫拒绝同一实例的并发启动。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireInstanceLock, INSTANCE_LOCK_FILE, InstanceLockedError } from '../../src/core/instance-lock.ts';
import { nullLogger } from '../../src/core/util.ts';
import { makeTmpDir } from './helpers.ts';

function spyLogger() {
  const base = nullLogger();
  const calls: Array<{ level: string; msg: string; data?: unknown }> = [];
  const mk = (level: string) => (msg: string, data?: unknown) => { calls.push({ level, msg, data }); };
  return {
    calls,
    log: { ...base, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), child: () => base },
  };
}

/** 找一个当下确实不存在的 pid(Windows 上 pid 是 4 的倍数,挑个大的往下试)。 */
function deadPid(): number {
  for (let pid = 999_000; pid > 1000; pid -= 4) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('找不到一个空闲 pid');
}

describe('acquireInstanceLock', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  const held: Array<{ release(): void }> = [];
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => {
    for (const lock of held.splice(0)) lock.release();
    tmp.cleanup();
  });

  it('第一个实例拿到锁,锁文件里记着自己的 pid', () => {
    const lock = acquireInstanceLock(tmp.dir);
    held.push(lock);
    expect(existsSync(lock.file)).toBe(true);
    expect(JSON.parse(readFileSync(lock.file, 'utf8')).pid).toBe(process.pid);
  });

  it('同一个 dataDir 起第二个:拒绝启动,错误里带第一个的 pid', () => {
    held.push(acquireInstanceLock(tmp.dir));
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(new RegExp(String(process.pid)));
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(InstanceLockedError);
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(/锁记录指向运行中的进程/);
  });

  it('陈旧锁(写锁的进程已经不在)自动接管并 warn', () => {
    const stale = deadPid();
    writeFileSync(join(tmp.dir, INSTANCE_LOCK_FILE), JSON.stringify({
      pid: stale, startedAt: '2026-08-27T13:19:00.000Z', argv: ['old'],
    }), 'utf8');
    const spy = spyLogger();
    const lock = acquireInstanceLock(tmp.dir, { log: spy.log });
    held.push(lock);
    expect(JSON.parse(readFileSync(lock.file, 'utf8')).pid).toBe(process.pid);
    const warns = spy.calls.filter((c) => c.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].data).toMatchObject({ stalePid: stale });
  });

  it("--force-second-instance 允许继续启动并记录 error", () => {
    held.push(acquireInstanceLock(tmp.dir));
    const spy = spyLogger();
    const second = acquireInstanceLock(tmp.dir, { force: true, log: spy.log });
    held.push(second);
    const errors = spy.calls.filter((c) => c.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].data).toMatchObject({ otherPid: process.pid });
  });


  describe('同一实例的并发启动与锁所有权边界', () => {
    it('锁文件是排他创建的:抢锁的那一刻文件已存在就走判活分支,不覆盖', () => {
      // 排他创建(wx)使并发启动的后到者收到 EEXIST，再按锁内进程判活。
      const spy = spyLogger();
      held.push(acquireInstanceLock(tmp.dir, { log: spy.log }));
      // 第二次:文件在、pid 活着 ⇒ 必拒,且不得把锁文件改成自己的
      const before = readFileSync(join(tmp.dir, INSTANCE_LOCK_FILE), 'utf8');
      expect(() => acquireInstanceLock(tmp.dir)).toThrow(/锁记录指向运行中的进程/);
      expect(readFileSync(join(tmp.dir, INSTANCE_LOCK_FILE), 'utf8')).toBe(before);
    });

    it("force 不取得锁所有权，释放时保留原锁", () => {
      const first = acquireInstanceLock(tmp.dir);
      held.push(first);
      const forced = acquireInstanceLock(tmp.dir, { force: true, log: nullLogger() });
      // 锁文件仍记着第一个实例;force 只是放行,不夺权
      expect(JSON.parse(readFileSync(first.file, 'utf8')).pid).toBe(process.pid);
      expect(forced.owns).toBe(false);
      forced.release();
      // 活进程持有的锁不能被 force 覆写或在另一个进程退出时删除。
      expect(existsSync(first.file)).toBe(true);
      expect(() => acquireInstanceLock(tmp.dir)).toThrow(/锁记录指向运行中的进程/);
    });

    it('陈旧锁的启动时刻早于本机开机时刻:即便 pid 恰好被复用也按陈旧锁接管', () => {
      // 即使 PID 存在，早于本机开机时刻的锁记录也已失效。
      writeFileSync(join(tmp.dir, INSTANCE_LOCK_FILE), JSON.stringify({
        pid: process.pid, // 一定活着
        startedAt: '1999-01-01T00:00:00.000Z', // 早于任何一次开机
        argv: ['old'],
      }), 'utf8');
      const spy = spyLogger();
      const lock = acquireInstanceLock(tmp.dir, { log: spy.log });
      held.push(lock);
      expect(JSON.parse(readFileSync(lock.file, 'utf8')).pid).toBe(process.pid);
      expect(spy.calls.some((c) => c.level === 'warn' && c.msg.includes('接管'))).toBe(true);
    });

    it('PID 被别的程序复用(可执行文件名与锁里记的不同):按陈旧锁接管', () => {
      writeFileSync(join(tmp.dir, INSTANCE_LOCK_FILE), JSON.stringify({
        pid: process.pid, // 活着、开机后启动，但可执行文件不是锁里记的那个
        startedAt: new Date().toISOString(),
        argv: ['old'],
        execPath: join(tmp.dir, 'another-app.exe'),
      }), 'utf8');
      const lock = acquireInstanceLock(tmp.dir, { log: nullLogger() });
      held.push(lock);
      expect(lock.owns).toBe(true);
      expect(JSON.parse(readFileSync(lock.file, 'utf8'))).toMatchObject({ pid: process.pid, execPath: process.execPath });
    });
  });

  it('释放之后可以再取;只删自己写的那把锁', () => {
    const first = acquireInstanceLock(tmp.dir);
    first.release();
    expect(existsSync(join(tmp.dir, INSTANCE_LOCK_FILE))).toBe(false);
    const second = acquireInstanceLock(tmp.dir);
    held.push(second);
    // 释放时仅删除仍属于当前 PID 的锁。
    writeFileSync(second.file, JSON.stringify({ pid: deadPid(), startedAt: 'x', argv: [] }), 'utf8');
    second.release();
    expect(existsSync(second.file)).toBe(true);
  });
});
