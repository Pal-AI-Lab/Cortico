/** UsageLog:追加/读取/清空,坏行跳过。 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLog } from '../../src/core/usage-log.ts';
import type { UsageRecord } from '../../src/core/types.ts';

let dir: string;
let file: string;
const rec = (n: number): UsageRecord => ({
  ts: `2026-07-19T1${n}:00:00+08:00`, sessionId: 'main', role: 'main', label: '主意识',
  model: 'deepseek-v4-flash', promptTokens: 100 * n, completionTokens: 10 * n,
  cacheHitTokens: 90 * n, cacheMissTokens: 10 * n, reasoningTokens: n,
});

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'usagelog-')); file = join(dir, 'usage.jsonl'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('UsageLog', () => {
  it('append 后 readAll 拿到全部,顺序保留', () => {
    const log = new UsageLog(file);
    log.append(rec(1)); log.append(rec(2)); log.append(rec(3));
    const all = log.readAll();
    expect(all.length).toBe(3);
    expect(all.map((r) => r.promptTokens)).toEqual([100, 200, 300]);
    expect(log.count()).toBe(3);
  });

  it('文件不存在→空数组', () => {
    expect(new UsageLog(join(dir, 'nope.jsonl')).readAll()).toEqual([]);
  });

  it('reads current records across restart and excludes old rows without rewriting the ledger', () => {
    writeFileSync(file, JSON.stringify(rec(1)) + '\n');
    const log = new UsageLog(file);
    log.append(rec(2));
    const raw = readFileSync(file, 'utf8');
    const errors: string[] = [];
    const restored = new UsageLog(file, error => errors.push(error));
    expect(restored.readAll()).toEqual([expect.objectContaining({ version: 2, promptTokens: 200 })]);
    expect(restored.status().error).toContain('1 damaged ledger lines');
    expect(errors).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });

  it('账本跨多个读取块时每行完整读出,多字节字符落在块边界上也不损坏', () => {
    const label = '主意识'.repeat(700);
    const lines = Array.from({ length: 1400 }, (_, i) => JSON.stringify({ ...rec(1), version: 2, recordId: `r${i}`, label }));
    writeFileSync(file, lines.join('\r\n') + '\n');
    expect(readFileSync(file).byteLength).toBeGreaterThan(8 * 1024 * 1024);
    const errors: string[] = [];
    const all = new UsageLog(file, error => errors.push(error)).readAll();
    expect(all.map(r => r.recordId)).toEqual(lines.map((_, i) => `r${i}`));
    expect(all.every(r => r.label === label)).toBe(true);
    expect(errors).toEqual([]);
  });

  it('坏行跳过,不影响其它行', () => {
    const log = new UsageLog(file);
    log.append(rec(1));
    appendFileSync(file, '这不是json\n', 'utf8');
    log.append(rec(2));
    expect(log.readAll().map((r) => r.promptTokens)).toEqual([100, 200]);
  });

  it('clear 清空并返回条数', () => {
    const log = new UsageLog(file);
    log.append(rec(1)); log.append(rec(2));
    expect(log.clear()).toBe(2);
    expect(log.readAll()).toEqual([]);
  });

  it('retains failed appends and flushes them once the directory becomes writable', () => {
    const blocked = join(dir,'blocked');
    writeFileSync(blocked,'file occupying directory');
    const errors:string[]=[];
    const log=new UsageLog(join(blocked,'usage.jsonl'),error=>errors.push(error));
    log.append(rec(1)); log.append(rec(2));
    expect(log.status().pending).toBe(2);
    expect(log.readAll().map(row=>row.promptTokens)).toEqual([100,200]);
    expect(errors.length).toBeGreaterThan(0);
    rmSync(blocked);
    log.flush(); log.flush();
    expect(log.status()).toEqual({pending:0,error:null});
    expect(new UsageLog(join(blocked,'usage.jsonl')).count()).toBe(2);
  });
});
