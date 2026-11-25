/** Append-only JSONL ledger with chunked async reads and queued retries on write failure. */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The ledger is read in chunks so its size is not bounded by V8's maximum string length. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Lines split at the newline byte, which never occurs inside a UTF-8 multibyte sequence.
 * A null follows each chunk; an asynchronous reader yields the event loop there.
 */
function* fileLines(file: string): Generator<string | null> {
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
      yield null;
    }
    if (rest.length) yield rest.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export interface JsonlLogOptions<T> {
  /** Prefix used in error reports (e.g. 'Usage ledger'). */
  label: string;
  /** Returns true when a parsed JSON value is a valid record for this ledger. */
  isValid: (value: unknown) => value is T;
  /** Deduplication key for a record; undefined disables deduplication for that row. */
  idOf: (record: T) => string | undefined;
  report?: (message: string) => void;
}

export class JsonlLog<T> {
  private pending: T[] = [];
  private error: string | null = null;
  private reconcile = false;
  /** Records on disk as of the last complete scan plus the appends since; null until a scan completes. */
  private diskCount: number | null = null;
  private counting: Promise<void> | null = null;
  /** Incremented by clear(); a scan that began before it does not set diskCount. */
  private cleared = 0;
  private readonly report: (message: string) => void;

  constructor(private readonly file: string, private readonly opts: JsonlLogOptions<T>) {
    this.report = opts.report ?? console.error;
  }

  append(record: T): void {
    this.pending.push(record);
    this.flush();
  }

  flush(): void {
    if (!this.pending.length) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (this.reconcile) {
        const ids = new Set<string>();
        for (const record of this.diskRecords()) {
          if (record === null) continue;
          const id = this.opts.idOf(record);
          if (id) ids.add(id);
        }
        this.pending = this.pending.filter(record => {
          const id = this.opts.idOf(record);
          return !id || !ids.has(id);
        });
        this.reconcile = false;
      }
      while (this.pending.length) {
        // A newline isolates a prior torn append; damaged lines remain available for inspection.
        appendFileSync(this.file, '\n' + JSON.stringify(this.pending[0]) + '\n', 'utf8');
        this.pending.shift();
        if (this.diskCount !== null) this.diskCount++;
      }
      this.error = null;
    } catch (error) {
      this.reconcile = true;
      this.diskCount = null;
      this.note(error);
    }
  }

  status(): { pending: number; error: string | null } {
    return { pending: this.pending.length, error: this.error };
  }

  private note(error: unknown): void {
    const message = `${this.opts.label} ${this.file}: ${String(error)}`;
    if (message !== this.error) this.report(message);
    this.error = message;
  }

  /** Valid records on disk, deduplicated by id; a null follows each chunk read. */
  private *diskRecords(): Generator<T | null> {
    if (!existsSync(this.file)) return;
    const seen = new Set<string>();
    let damaged = 0;
    for (const line of fileLines(this.file)) {
      if (line === null) { yield null; continue; }
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { damaged++; continue; }
      if (!this.opts.isValid(parsed)) { damaged++; continue; }
      const id = this.opts.idOf(parsed);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      yield parsed;
    }
    if (damaged) this.note(`${damaged} damaged ledger lines retained on disk`);
  }

  /**
   * Reads the ledger one chunk per event-loop turn. Appends are synchronous, so the file holds
   * only whole lines at every turn and the scan ends having read every record then on disk.
   * Resolves false when the file could not be read.
   */
  private async scan(each: (record: T) => void = () => {}): Promise<boolean> {
    const cleared = this.cleared;
    let count = 0;
    try {
      for (const record of this.diskRecords()) {
        if (record === null) await new Promise<void>(resolve => setImmediate(resolve));
        else { each(record); count++; }
      }
      if (cleared === this.cleared) this.diskCount = count;
      return true;
    } catch (error) {
      this.note(error);
      return false;
    }
  }

  /** Records on disk and still pending; with `keep`, only those it accepts are held. */
  async readAll(keep: (record: T) => boolean = () => true): Promise<T[]> {
    const records: T[] = [];
    if (!await this.scan(record => { if (keep(record)) records.push(record); })) records.length = 0;
    if (!this.pending.length) return records;
    const ids = new Set<string>();
    for (const record of records) {
      const id = this.opts.idOf(record);
      if (id) ids.add(id);
    }
    return [...records, ...this.pending.filter(record => {
      if (!keep(record)) return false;
      const id = this.opts.idOf(record);
      return !id || !ids.has(id);
    })];
  }

  /** Null until the first scan completes; asking starts that scan. */
  count(): number | null {
    if (this.diskCount !== null) return this.diskCount + this.pending.length;
    this.counting ??= this.scan().then(() => { this.counting = null; });
    return null;
  }

  async clear(): Promise<number> {
    const count = (await this.readAll()).length;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, '', 'utf8');
    this.pending = [];
    this.error = null;
    this.cleared++;
    this.diskCount = 0;
    return count;
  }
}
