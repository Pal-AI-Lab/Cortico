import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLog } from '../../src/core/usage-log.ts';
import { aggregateUsage } from '../../src/core/cost.ts';
import type { UsageRecord } from '../../src/core/types.ts';

let dir: string;
let file: string;
const logs: UsageLog[] = [];
const row = (id: string): UsageRecord => ({ version: 2, recordId: id, ts: '2026-01-02T12:00:00Z',
  sessionId: 'test', role: 'main', label: '测试', model: 'test-model', promptTokens: 100,
  completionTokens: 10, cacheHitTokens: 50, cacheMissTokens: 50, reasoningTokens: 3 });
const options = { bucket: 'day' as const, now: new Date('2026-01-02T13:00:00Z') };
function log(path = file, report = (_message: string) => {}) {
  const value = new UsageLog(path, report); logs.push(value); return value;
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'usage-query-')); file = join(dir, 'usage.jsonl'); });
afterEach(() => { for (const value of logs.splice(0)) value.stopQueries(); rmSync(dir, { recursive: true, force: true }); });

describe('UsageLog.aggregate', () => {
  it('matches the existing accounting, preserves corrupt lines and deduplicates record ids', async () => {
    const records = [row('a'), row('b')];
    const raw = records.map(record => JSON.stringify(record)).join('\n') + '\nbroken\n' + JSON.stringify(records[0]) + '\n';
    writeFileSync(file, raw);
    const errors: string[] = [];
    const usage = log(file, error => errors.push(error));
    expect(await usage.aggregate(options)).toEqual(aggregateUsage(records, options));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('1 damaged ledger lines');
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });

  it('leaves the main event loop available while a large query is pending', async () => {
    const record = JSON.stringify({ ...row('large'), label: '资料'.repeat(1200) });
    writeFileSync(file, (record + '\n').repeat(2200));
    const usage = log();
    let settled = false;
    const query = usage.aggregate(options).finally(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    usage.append(row('new'));
    expect((await query).totals.calls).toBeGreaterThanOrEqual(1);
    expect((await usage.aggregate(options)).totals.calls).toBe(2);
  });

  it('shares simultaneous identical scans and refreshes after an append', async () => {
    const usage = log(); usage.append(row('a'));
    const first = usage.aggregate(options);
    expect(usage.aggregate(options)).toBe(first);
    expect((await first).totals.calls).toBe(1);
    usage.append(row('b'));
    expect((await usage.aggregate(options)).totals.calls).toBe(2);
  });

  it('includes queued appends and does not count an already persisted retry twice', async () => {
    const parent = join(dir, 'blocked'); writeFileSync(parent, 'occupied');
    const target = join(parent, 'usage.jsonl');
    const usage = log(target); usage.append(row('a')); usage.append(row('b'));
    rmSync(parent); mkdirSync(parent);
    appendFileSync(target, JSON.stringify(row('a')) + '\n');
    expect((await usage.aggregate(options)).totals.calls).toBe(2);
    expect(usage.status().pending).toBe(2);
  });

  it('reports read failures instead of returning an empty successful report', async () => {
    mkdirSync(file);
    await expect(log().aggregate(options)).rejects.toThrow();
  });

  it('cancels both active and queued scans when the engine stops', async () => {
    const usage = log(); usage.append(row('a'));
    const first = usage.aggregate(options);
    const second = usage.aggregate({ ...options, bucket: 'hour' });
    const results = Promise.allSettled([first, second]);
    await new Promise<void>(resolve => setImmediate(resolve));
    usage.stopQueries();
    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(readFileSync(file, 'utf8')).toContain('"recordId":"a"');
  });
});
