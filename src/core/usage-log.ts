/** Append-only usage ledger. Failed writes remain queued and are reported to the operator. */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UsageRecord } from './types.ts';
import type { UsageAggregate, UsageAggregateOptions } from './cost.ts';
import { queryUsage } from './usage-query.ts';

/** The ledger is read in chunks so its size is not bounded by V8's maximum string length. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** Lines split at the newline byte, which never occurs inside a UTF-8 multibyte sequence. */
function* fileLines(file: string): Generator<string> {
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let rest = Buffer.alloc(0);
    for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) {
      const buf = rest.length ? Buffer.concat([rest, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let start = 0;
      for (let end = buf.indexOf(10); end !== -1; end = buf.indexOf(10, start)) {
        yield buf.toString('utf8', start, end);
        start = end + 1;
      }
      rest = Buffer.from(buf.subarray(start));
    }
    if (rest.length) yield rest.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export class UsageLog {
  private pending: UsageRecord[] = [];
  private error: string | null = null;
  private reconcile = false;
  private queryAbort = new AbortController();
  private queryQueue: Promise<unknown> = Promise.resolve();
  private queries = new Map<string, Promise<UsageAggregate>>();
  constructor(private readonly file: string, private readonly report: (message: string) => void = console.error) {}

  append(rec: UsageRecord): void {
    this.pending.push(structuredClone({ ...rec, version: 2, recordId: rec.recordId ?? rec.attempt?.id ?? crypto.randomUUID() }));
    this.flush();
  }

  flush(): void {
    if (!this.pending.length) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (this.reconcile) {
        const ids = new Set(this.readDisk().map(record => record.recordId ?? record.attempt?.id));
        this.pending = this.pending.filter(record => !ids.has(record.recordId));
        this.reconcile = false;
      }
      while (this.pending.length) {
        // A newline isolates a prior torn append; damaged lines remain available for inspection.
        appendFileSync(this.file, '\n' + JSON.stringify(this.pending[0]) + '\n', 'utf8');
        this.pending.shift();
      }
      this.error = null;
    } catch (error) { this.reconcile = true; this.note(error); }
  }

  status(): { pending: number; error: string | null } { return { pending: this.pending.length, error: this.error }; }

  private note(error: unknown): void {
    const message = `Usage ledger ${this.file}: ${String(error)}`;
    if (message !== this.error) this.report(message);
    this.error = message;
  }

  private readDisk(): UsageRecord[] {
    if (!existsSync(this.file)) return [];
    const out: UsageRecord[] = [];
    const seen = new Set<string>();
    let damaged = 0;
    for (const line of fileLines(this.file)) {
      if (!line.trim()) continue;
      let record: UsageRecord;
      try { record = JSON.parse(line) as UsageRecord; } catch { damaged++; continue; }
      if (!record || record.version !== 2 || typeof record.ts !== 'string') { damaged++; continue; }
      const id = record.recordId ?? record.attempt?.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(record);
    }
    if (damaged) this.note(`${damaged} damaged ledger lines retained on disk`);
    return out;
  }

  readAll(options: { strict?: boolean } = {}): UsageRecord[] {
    let records: UsageRecord[] = [];
    try { records = this.readDisk(); } catch (error) {
      this.note(error);
      if (options.strict) throw error;
    }
    const ids = new Set(records.map(record => record.recordId ?? record.attempt?.id));
    return [...records, ...this.pending.filter(record => !ids.has(record.recordId))];
  }

  count(): number { return this.readAll().length; }

  /** Concurrent identical queries share one scan; different queries scan serially. */
  aggregate(options: UsageAggregateOptions): Promise<UsageAggregate> {
    const key = JSON.stringify(options);
    const existing = this.queries.get(key);
    if (existing) return existing;
    const query = this.queryQueue.then(async () => {
      const result = await queryUsage({ file: this.file, pending: structuredClone(this.pending), options }, this.queryAbort.signal);
      if (result.error) {
        if (result.error !== this.error) this.report(result.error);
        this.error = result.error;
      }
      return result.aggregate;
    }).catch(error => {
      if (!this.queryAbort.signal.aborted) this.note(error);
      throw error;
    });
    this.queries.set(key, query);
    this.queryQueue = query.then(() => { this.queries.delete(key); }, () => { this.queries.delete(key); });
    return query;
  }

  /** Pending WebUI scans must not delay engine shutdown. The ledger remains intact. */
  stopQueries(): void { this.queryAbort.abort(new Error('Usage queries stopped')); }

  clear(): number {
    const count = this.count();
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, '', 'utf8');
    this.pending = [];
    this.error = null;
    return count;
  }
}
