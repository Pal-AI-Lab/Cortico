import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLedger, snapshotLedger, hashFile, digest, distribution, FIXED_NOW } from '../../scripts/usage-benchmark/fixture.ts';
import { UsageLog } from '../../src/core/usage-log.ts';
import { aggregateUsage } from '../../src/core/cost.ts';

const dirs: string[] = [];
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'usage-benchmark-')); dirs.push(dir); return dir; }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('usage benchmark fixtures', () => {
  it('generates repeatable UTF-8 ledgers whose independent totals match real aggregation', async () => {
    const dir = await temp();
    const a = await generateLedger(join(dir, 'a'), 120000);
    const b = await generateLedger(join(dir, 'b'), 120000);
    expect(a).toEqual(b);
    const log = new UsageLog(join(dir, 'a'));
    const report = aggregateUsage(await log.readAll(), { bucket: 'day', timezone: 'UTC', now: new Date(FIXED_NOW) });
    expect(report.totals.calls).toBe(a.records);
    expect(report.totals.promptTokens).toBe(a.promptTokens);
    expect(report.totals.completionTokens).toBe(a.completionTokens);
    expect(report.totals.pricedCalls).toBe(a.records);
    expect(await hashFile(join(dir, 'a'))).toEqual({ sha256: a.sha256, bytes: a.bytes });
    await expect(generateLedger(join(dir, 'a'), 1)).rejects.toThrow();
  });
  it('captures a fixed prefix and never follows subsequent source appends or overwrites output', async () => {
    const dir = await temp(), source = join(dir, 'source'), dest = join(dir, 'copy');
    await writeFile(source, '甲\n乙\n');
    const result = await snapshotLedger(source, dest, Buffer.byteLength('甲\n'));
    await appendFile(source, '丙\n');
    expect(await readFile(dest, 'utf8')).toBe('甲\n');
    expect(result.endsWithNewline).toBe(true);
    expect((await hashFile(dest)).sha256).toBe(result.sha256);
    await expect(snapshotLedger(source, dest)).rejects.toThrow();
    await expect(snapshotLedger(source, join(dir, 'bad'), 10000)).rejects.toThrow();
  });
  it('fingerprints nested object key order without discarding array order and reports missing samples as null', () => {
    expect(digest({ a: 1, b: { c: 2, d: 3 } })).toBe(digest({ b: { d: 3, c: 2 }, a: 1 }));
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
    expect(distribution([])).toEqual({ samples: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null });
    expect(distribution([3, 1, 2]).maxMs).toBe(3);
  });
});
