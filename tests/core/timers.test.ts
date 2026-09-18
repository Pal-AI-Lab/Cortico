import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** renameSync 的旁观钩子:node 内建模块的属性不可重定义,只能整module代理一次。 */
const fsHooks = vi.hoisted(() => ({ onRename: null as null | ((from: string, to: string) => void) }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    renameSync: (from: string, to: string) => {
      fsHooks.onRename?.(from, to);
      return actual.renameSync(from, to);
    },
  };
});
import { TimerStore } from '../../src/core/timers.ts';
import type { TimerEntry } from '../../src/core/types.ts';
import { makeTmpDir } from './helpers.ts';

describe('TimerStore', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  beforeEach(() => {
    vi.useFakeTimers();
    tmp = makeTmpDir();
  });
  afterEach(() => {
    vi.useRealTimers();
    tmp.cleanup();
  });

  it('set→到期回调持有方并从落盘移除;payload 原样带回', async () => {
    const due: TimerEntry[] = [];
    const ts = new TimerStore(tmp.dir);
    ts.onDue((e) => due.push(e));
    ts.start();
    const r = ts.set(new Date(Date.now() + 60).toISOString(), { note: '提醒阿明还书' });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(tmp.dir, 'timers.json'), 'utf8')).toContain('提醒阿明还书');
    await vi.advanceTimersByTimeAsync(59);
    expect(due).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    ts.stop();
    expect(due).toHaveLength(1);
    expect(due[0].payload).toEqual({ note: '提醒阿明还书' });
    expect(JSON.parse(readFileSync(join(tmp.dir, 'timers.json'), 'utf8'))).toEqual([]);
  });

  it('拒绝无法解析的时间,返回错误不抛异常', () => {
    const ts = new TimerStore(tmp.dir);
    const r = ts.set('明晚八点', {});
    expect(r.ok).toBe(false);
    expect(ts.list()).toHaveLength(0);
  });

  it('cancel 取消定时并落盘;clearAll 全清', async () => {
    const due: TimerEntry[] = [];
    const ts = new TimerStore(tmp.dir);
    ts.onDue((e) => due.push(e));
    ts.start();
    const a = ts.set(new Date(Date.now() + 60).toISOString(), { note: 'a' });
    ts.set(new Date(Date.now() + 3600_000).toISOString(), { note: 'b' });
    expect(a.ok && ts.cancel(a.id)).toBe(true);
    expect(ts.list()).toHaveLength(1);
    expect(ts.clearAll()).toBe(1);
    await vi.advanceTimersByTimeAsync(3600_000);
    ts.stop();
    expect(due).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(tmp.dir, 'timers.json'), 'utf8'))).toEqual([]);
  });

  it('构造即读盘(attach 阶段能 list);start 才布防:未到期重新arm,已过期立即回调', async () => {
    writeFileSync(
      join(tmp.dir, 'timers.json'),
      JSON.stringify([
        { id: 'wk1', atIso: new Date(Date.now() - 10_000).toISOString(), payload: { note: '早该响了' } },
        { id: 'wk2', atIso: new Date(Date.now() + 3600_000).toISOString(), payload: { note: '还早' } },
      ]),
      'utf8',
    );
    const due: TimerEntry[] = [];
    const ts = new TimerStore(tmp.dir);
    expect(ts.list()).toHaveLength(2); // start 前就读得到
    ts.onDue((e) => due.push(e));
    await vi.advanceTimersByTimeAsync(50);
    expect(due).toHaveLength(0); // start 前不触发
    ts.start();
    ts.stop();
    expect(due.map((e) => e.payload.note)).toEqual(['早该响了']);
    const left = JSON.parse(readFileSync(join(tmp.dir, 'timers.json'), 'utf8'));
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe('wk2');
  });

  // 定时器文件替换期间必须保留原文件,避免崩溃后闹钟全部丢失。
  it('落盘期间任何一刻定时器文件都在盘上(rename 直接覆盖,不先删)', () => {
    const file = join(tmp.dir, 'timers.json');
    const ts = new TimerStore(tmp.dir);
    ts.set(new Date(Date.now() + 3600_000).toISOString(), { note: 'a' });

    const seen: boolean[] = [];
    fsHooks.onRename = () => { seen.push(existsSync(file)); };
    try {
      ts.set(new Date(Date.now() + 7200_000).toISOString(), { note: 'b' });
    } finally {
      fsHooks.onRename = null;
    }
    expect(seen).toEqual([true]);
    expect(new TimerStore(tmp.dir).list().map((e) => e.payload.note)).toEqual(['a', 'b']);
  });

  it('rename 失败时旧定时器文件原样留在盘上', () => {
    const file = join(tmp.dir, 'timers.json');
    const ts = new TimerStore(tmp.dir);
    ts.set(new Date(Date.now() + 3600_000).toISOString(), { note: 'a' });

    fsHooks.onRename = () => { throw new Error('盘满'); };
    try {
      expect(() => ts.set(new Date(Date.now() + 7200_000).toISOString(), { note: 'b' })).toThrow('盘满');
    } finally {
      fsHooks.onRename = null;
    }
    expect(existsSync(file)).toBe(true);
    expect(new TimerStore(tmp.dir).list().map((e) => e.payload.note)).toEqual(['a']);
  });

  it("没有 handler 的到期项记录日志后丢弃", async () => {
    const ts = new TimerStore(tmp.dir);
    ts.set(new Date(Date.now() + 40).toISOString(), {});
    ts.start();
    await vi.advanceTimersByTimeAsync(40);
    ts.stop();
    expect(ts.list()).toHaveLength(0);
  });

  it('set 一个已过去的时间:回调在 set 返回之后,持有方先拿到 id;返回前 cancel 则不回调', async () => {
    const due: TimerEntry[] = [];
    const ts = new TimerStore(tmp.dir);
    ts.onDue((e) => due.push(e));
    ts.start();
    const r = ts.set(new Date(Date.now() - 1000).toISOString(), { note: '早就该响' });
    expect(r.ok).toBe(true);
    expect(due).toHaveLength(0);
    expect(ts.list().map((e) => e.id)).toEqual([r.ok ? r.id : '']);
    await vi.advanceTimersByTimeAsync(0);
    expect(due.map((e) => e.id)).toEqual([r.ok ? r.id : '']);
    expect(ts.list()).toHaveLength(0);

    const cancelled = ts.set(new Date(Date.now() - 1000).toISOString(), { note: '立刻撤回' });
    expect(cancelled.ok && ts.cancel(cancelled.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    ts.stop();
    expect(due).toHaveLength(1);
  });
});
