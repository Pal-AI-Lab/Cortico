/** WorldActivityLog: 分钟级合并、跨分钟落盘、stop 刷盘、失败留队与清空。 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORLD_ACTIVITY_VERSION, WorldActivityLog } from '../../src/core/world-activity-log.ts';
import { nowIso } from '../../src/core/util.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'world-activity-'));
  file = join(dir, 'world-activity.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('WorldActivityLog', () => {
  it('同一分钟内合并为一行，保留首次计数时刻并在内存中可见', async () => {
    let now = new Date('2026-07-19T02:00:05Z'); // Asia/Shanghai 10:00:05
    const firstTs = nowIso('Asia/Shanghai', now);
    const log = new WorldActivityLog(file, { timezone: 'Asia/Shanghai', run: 'run-1', now: () => now });
    log.recordEvent('chat');
    now = new Date('2026-07-19T02:00:40Z'); // 仍在 10:00
    log.recordEvent('chat', 3);
    log.recordRound('chat');

    // 未跨分钟、未 flush 前尚未落盘，但 readAll 含内存当前桶。
    expect(existsSync(file)).toBe(false);
    const live = await log.readAll();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      version: WORLD_ACTIVITY_VERSION,
      run: 'run-1',
      world: 'chat',
      events: 4,
      rounds: 1,
    });
    expect(live[0]!.ts).toBe(firstTs);

    log.flush();
    const restored = new WorldActivityLog(file, { timezone: 'Asia/Shanghai', run: 'run-1' });
    const rows = await restored.readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      version: WORLD_ACTIVITY_VERSION,
      ts: firstTs,
      world: 'chat',
      events: 4,
      rounds: 1,
    });
  });

  it('跨分钟时将上一分钟落盘并开启新行', async () => {
    let now = new Date('2026-07-19T02:00:50Z'); // 10:00:50
    const firstTs = nowIso('Asia/Shanghai', now);
    const log = new WorldActivityLog(file, { timezone: 'Asia/Shanghai', run: 'run-1', now: () => now });
    log.recordEvent('chat', 2);
    log.recordRound('chat');

    now = new Date('2026-07-19T02:01:05Z'); // 10:01:05
    log.recordEvent('chat');

    // 上一分钟已自动落盘；当前分钟仍在内存。
    const onDiskBeforeFlush = await new WorldActivityLog(file, { timezone: 'Asia/Shanghai', run: 'run-1' }).readAll();
    expect(onDiskBeforeFlush).toHaveLength(1);
    expect(onDiskBeforeFlush[0]).toMatchObject({
      ts: firstTs,
      events: 2,
      rounds: 1,
    });

    log.flush();
    const all = await new WorldActivityLog(file, { timezone: 'Asia/Shanghai', run: 'run-1' }).readAll();
    expect(all).toHaveLength(2);
    expect(all.map((r) => [r.ts.slice(0, 16), r.events, r.rounds])).toEqual([
      ['2026-07-19T10:00', 2, 1],
      ['2026-07-19T10:01', 1, 0],
    ]);
  });

  it('写入失败后留在队列，目录恢复可写后 flush 补写且不重复', async () => {
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'occupied');
    const errors: string[] = [];
    const target = join(blocked, 'world-activity.jsonl');
    let now = new Date('2026-07-19T02:00:10Z');
    const log = new WorldActivityLog(target, {
      timezone: 'Asia/Shanghai',
      run: 'run-1',
      now: () => now,
      report: (message) => errors.push(message),
    });

    log.recordEvent('game', 5);
    log.flush();
    expect(log.status().pending).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(await log.readAll()).toHaveLength(1);

    rmSync(blocked);
    log.flush();
    log.flush();
    expect(log.status()).toEqual({ pending: 0, error: null });
    const rows = await new WorldActivityLog(target, { timezone: 'Asia/Shanghai', run: 'run-1' }).readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ world: 'game', events: 5, rounds: 0 });
  });

  it('clear 同时清空落盘行与内存当前分钟并返回总条数', async () => {
    let now = new Date('2026-07-19T02:00:10Z');
    const log = new WorldActivityLog(file, { timezone: 'Asia/Shanghai', run: 'run-1', now: () => now });
    log.recordEvent('chat');
    now = new Date('2026-07-19T02:01:10Z');
    log.recordEvent('chat');

    expect(await log.clear()).toBe(2);
    expect(await log.readAll()).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('');
  });
});
