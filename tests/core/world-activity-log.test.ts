import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nowIso } from '../../src/core/util.ts';
import {
  WORLD_ACTIVITY_LOG_FILE, WORLD_ACTIVITY_MINUTE_MS, WORLD_ACTIVITY_RECORD_VERSION, WorldActivityLog,
} from '../../src/core/world-activity-log.ts';
import { makeTmpDir } from './helpers.ts';

const timezone = 'Pacific/Chatham';
const run = 'fixture-run';
const first = new Date('2026-07-19T11:14:37.500Z');
const next = new Date(Math.floor(first.getTime() / WORLD_ACTIVITY_MINUTE_MS + 1) * WORLD_ACTIVITY_MINUTE_MS);

describe('WorldActivityLog', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let file: string;
  let log: WorldActivityLog;

  function open(path = file, report?: (message: string) => void): WorldActivityLog {
    return new WorldActivityLog(path, { run, timezone: () => timezone, report });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(first);
    tmp = makeTmpDir();
    file = join(tmp.dir, WORLD_ACTIVITY_LOG_FILE);
    log = open();
  });

  afterEach(() => {
    log.stop();
    vi.useRealTimers();
    tmp.cleanup();
  });

  it('combines a World’s counters into one row at its first count in the deployment minute', async () => {
    log.start();
    log.record('sample', 'events');
    await vi.advanceTimersByTimeAsync(1_000);
    log.record('sample', 'rounds');
    log.record('sample', 'events');
    log.record('other', 'rounds');
    const active = await log.readAll();
    expect(active).toEqual([
      { version: WORLD_ACTIVITY_RECORD_VERSION, recordId: expect.any(String), run, world: 'sample',
        ts: nowIso(timezone, first), events: 2, rounds: 1 },
      { version: WORLD_ACTIVITY_RECORD_VERSION, recordId: expect.any(String), run, world: 'other',
        ts: nowIso(timezone), events: 0, rounds: 1 },
    ]);
    expect(existsSync(file)).toBe(false);
    await vi.advanceTimersByTimeAsync(next.getTime() - Date.now());
    expect(readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)).toHaveLength(active.length);
    expect(await open().readAll()).toEqual(active);
  });

  it('writes the preceding minute when a count crosses the boundary and flushes the active minute on stop', async () => {
    log.record('sample', 'events');
    vi.setSystemTime(next);
    log.record('sample', 'rounds');
    const active = await log.readAll();
    expect(await open().readAll()).toEqual(active.slice(0, 1));
    expect(active.map(row => row.ts)).toEqual([nowIso(timezone, first), nowIso(timezone, next)]);
    log.stop();
    expect(await open().readAll()).toEqual(active);
  });

  it('keeps failed rows readable and retries them after the write path is restored', async () => {
    const blocked = join(tmp.dir, 'blocked');
    writeFileSync(blocked, 'file occupying the parent directory');
    const errors: string[] = [];
    const path = join(blocked, WORLD_ACTIVITY_LOG_FILE);
    log = open(path, message => errors.push(message));
    log.start();
    log.record('sample', 'events');
    await vi.advanceTimersByTimeAsync(next.getTime() - Date.now());
    const pending = await log.readAll();
    expect(pending).toEqual([expect.objectContaining({ world: 'sample', events: 1 })]);
    expect(log.status()).toEqual({ pending: pending.length, error: expect.stringContaining(path) });
    expect(errors).toContain(log.status().error);

    rmSync(blocked);
    await vi.advanceTimersByTimeAsync(WORLD_ACTIVITY_MINUTE_MS);
    expect(await open(path).readAll()).toEqual(pending);
    expect(log.status()).toEqual({ pending: 0, error: null });
  });

  it('clears persisted and active counts before recording again in the same minute', async () => {
    log.record('sample', 'events');
    vi.setSystemTime(next);
    log.record('sample', 'events');
    const before = await log.readAll();
    expect(await log.clear()).toBe(before.length);
    expect(await log.readAll()).toEqual([]);
    log.record('sample', 'rounds');
    log.stop();
    expect(await open().readAll()).toEqual([expect.objectContaining({ world: 'sample', events: 0, rounds: 1 })]);
  });
});
