import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { LOG_LEVEL_RANK, type LogLevel, type LogRecord } from '../core/types.ts';

const TAIL_CHUNK = 512 * 1024;
/** 过滤查询从文件尾部向前最多扫这么多字节 */
const SCAN_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 从文件尾部向前按块扫,收满 limit 条通过 pred 的记录即停;最多扫 SCAN_MAX_BYTES。
 * 返回按文件顺序(升序)。文件不存在→[]。
 */
export function readTailRecordsWhere<T>(file: string, limit: number, pred: (record: T) => boolean): T[] {
  let descriptor: number;
  try {
    descriptor = openSync(file, 'r');
  } catch {
    return [];
  }
  const out: T[] = [];
  try {
    const size = fstatSync(descriptor).size;
    let end = size;
    let carry = '';
    let scanned = 0;
    while (end > 0 && out.length < limit && scanned < SCAN_MAX_BYTES) {
      const start = Math.max(0, end - TAIL_CHUNK);
      const buffer = Buffer.alloc(end - start);
      readSync(descriptor, buffer, 0, end - start, start);
      scanned += end - start;
      const text = buffer.toString('utf8') + carry;
      const lines = text.split(/\r?\n/);
      // 块首的半行留给下一块拼
      carry = start > 0 ? lines.shift() ?? '' : '';
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let record: T;
        try { record = JSON.parse(line) as T; } catch { continue; }
        if (pred(record)) out.push(record);
      }
      end = start;
    }
  } finally {
    closeSync(descriptor);
  }
  return out.reverse();
}

export interface LogQuery {
  /** 最低级别 */
  level?: string;
  /** 区域前缀(worlds.x 命中 worlds.x 与 worlds.x.*) */
  area?: string;
  event?: string;
  /** 正则(不区分大小写),匹配 msg 与 data */
  grep?: string;
  /** ISO 前缀比较:ts >= since */
  since?: string;
  round?: number;
  call?: string;
}

export function logPredicate(q: LogQuery): (record: LogRecord) => boolean {
  const min = q.level && q.level in LOG_LEVEL_RANK ? LOG_LEVEL_RANK[q.level as LogLevel] : 0;
  let re: RegExp | null = null;
  if (q.grep) {
    try { re = new RegExp(q.grep, 'i'); } catch { re = new RegExp(q.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  }
  const area = q.area?.replace(/\.?\*$/, '');
  return (r) => {
    if (!r || typeof r !== 'object' || typeof r.level !== 'string') return false;
    if ((LOG_LEVEL_RANK[r.level] ?? 0) < min) return false;
    if (area && r.area !== area && !r.area.startsWith(`${area}.`)) return false;
    if (q.event && r.event !== q.event) return false;
    if (q.since && r.ts < q.since) return false;
    if (q.round !== undefined && r.round !== q.round) return false;
    if (q.call && r.call !== q.call) return false;
    if (re && !re.test(r.msg) && !(r.data !== undefined && re.test(JSON.stringify(r.data)))) return false;
    return true;
  };
}

export interface RunIndexRow {
  run: string;
  startedAt?: string;
  endedAt?: string;
  bot?: string;
  gitSha?: string | null;
  previousRun?: string | null;
  lastCursor?: number;
  complete?: boolean | null;
  reason?: string;
}

/** runs/index.jsonl 按 run 合并开机行与关机行,按开机先后。 */
export function readRunsIndex(file: string): RunIndexRow[] {
  if (!existsSync(file)) return [];
  const byRun = new Map<string, RunIndexRow>();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: RunIndexRow;
    try { row = JSON.parse(line) as RunIndexRow; } catch { continue; }
    if (typeof row.run !== 'string') continue;
    byRun.set(row.run, { ...byRun.get(row.run), ...row });
  }
  return [...byRun.values()];
}
