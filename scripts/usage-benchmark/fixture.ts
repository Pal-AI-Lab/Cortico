import { createHash } from 'node:crypto';
import { open, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { UsageRecord } from '../../src/core/types.ts';

export const FIXED_NOW = '2026-01-31T12:00:00.000Z';

export function fixtureRecord(i: number): UsageRecord {
  return {
    version: 2, recordId: `fixture-${i}`, sessionId: `session-${i % 4}`,
    ts: new Date(Date.parse(FIXED_NOW) - (i % 90) * 86400000 - (i % 24) * 3600000).toISOString(),
    role: `role-${i % 4}`, label: `角色 ${i % 4}`, model: `model-${i % 3}`,
    promptTokens: 100 + i % 31, completionTokens: 10 + i % 7,
    cacheHitTokens: i % 2 ? 50 : 0, cacheMissTokens: 100 + i % 31 - (i % 2 ? 50 : 0),
    reasoningTokens: i % 5, ...(i % 13 === 0 ? { outcome: 'failed' as const } : {}),
    charges: [{
      quote: { id: 'fixture-price', currency: 'USD', basis: 'marginal', rules: [], source: 'fixture', capturedAt: FIXED_NOW },
      amount: 0.001, knownAmount: 0.001, missing: [], lines: [],
    }],
  };
}

/** Deterministic records, Unicode labels and opaque provider detail at a realistic row size. */
export async function generateLedger(file: string, bytes: number, rowBytes = 2560) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(rowBytes) || rowBytes < 768) {
    throw new Error('bytes must be positive; rowBytes must be at least 768');
  }
  await mkdir(dirname(file), { recursive: true });
  const fd = await open(file, 'wx');
  const hash = createHash('sha256');
  let written = 0, records = 0, promptTokens = 0, completionTokens = 0;
  try {
    while (written < bytes) {
      const batch: string[] = [];
      for (let j = 0; j < 256 && written < bytes; j++) {
        const rec = fixtureRecord(records++);
        const bare = JSON.stringify({ ...rec, providerDetail: '' });
        const line = JSON.stringify({ ...rec, providerDetail: 'x'.repeat(Math.max(0, rowBytes - Buffer.byteLength(bare) - 1)) }) + '\n';
        batch.push(line); written += Buffer.byteLength(line);
        promptTokens += rec.promptTokens; completionTokens += rec.completionTokens;
      }
      const data = Buffer.from(batch.join(''));
      await fd.writeFile(data); hash.update(data);
      await yieldTurn();
    }
  } finally { await fd.close(); }
  return { kind: 'synthetic', bytes: written, records, rowBytes, sha256: hash.digest('hex'), promptTokens, completionTokens };
}

/** Captures a fixed byte prefix without modifying the input or following later appends. */
export async function snapshotLedger(input: string, output: string, limit?: number) {
  const source = await open(input, 'r');
  const before = await source.stat();
  const bytes = limit ?? before.size;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > before.size) {
    await source.close(); throw new Error('snapshot bytes must be within the source file');
  }
  await mkdir(dirname(output), { recursive: true });
  let dest: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(4 * 1024 * 1024);
  let copied = 0, lastByte: number | null = null;
  try {
    dest = await open(output, 'wx');
    while (copied < bytes) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, bytes - copied), copied);
      if (!bytesRead) throw new Error('source truncated during snapshot');
      const chunk = buffer.subarray(0, bytesRead);
      await dest.writeFile(chunk); hash.update(chunk); copied += bytesRead; lastByte = chunk.at(-1)!;
    }
    const after = await source.stat();
    if (after.size < before.size || after.ino !== before.ino) throw new Error('source replaced or truncated during snapshot');
    return { kind: 'private-snapshot', bytes: copied, sha256: hash.digest('hex'),
      sourceBytesAtStart: before.size, sourceBytesAtEnd: after.size, endsWithNewline: lastByte === 10,
      boundary: 'Fixed prefix; concurrent rewrites cannot be excluded without an immutable source. Raw data stays in the output directory.' };
  } finally { await source.close(); await dest?.close(); }
}

export async function hashFile(file: string) {
  const fd = await open(file, 'r');
  const hash = createHash('sha256');
  try {
    for await (const chunk of fd.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally { await fd.close(); }
  return { sha256: hash.digest('hex'), bytes: (await stat(file)).size };
}

export function digest(value: unknown): string {
  const canonical = (x: unknown): unknown => Array.isArray(x) ? x.map(canonical)
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : x;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: sorted.at(-1) ?? null };
}
