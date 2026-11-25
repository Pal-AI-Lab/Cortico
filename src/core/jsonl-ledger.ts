import { appendFileSync, closeSync, constants, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDefaultHighWaterMark } from 'node:stream';

/**
 * Lines split at the newline byte, which never occurs inside a UTF-8 multibyte sequence.
 * A null follows each chunk; an asynchronous reader yields the event loop there.
 */
function* fileLines(file: string): Generator<string | null> {
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(getDefaultHighWaterMark(false));
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

interface JsonlLedgerOptions<Row> {
  label: string;
  isRecord(record: unknown): record is Row;
  recordId(record: Row): string | undefined;
  report?: (message: string) => void;
}

/** Append-only JSONL ledger. Failed writes remain queued and are reported to the operator. */
export class JsonlLedger<Row> {
  private pending: Row[] = [];
  private error: string | null = null;
  private reconcile = false;
  /** Records on disk as of the last complete scan plus the appends since; null until a scan completes. */
  private diskCount: number | null = null;
  private counting: Promise<void> | null = null;
  /** Incremented by clear(); a scan that began before it does not set diskCount. */
  private cleared = 0;
  constructor(private readonly file: string, private readonly options: JsonlLedgerOptions<Row>) {}

  protected appendRecords(records: Iterable<Row>): void {
    for (const record of records) this.pending.push(record);
    this.flush();
  }

  flush(): void {
    if (!this.pending.length) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (this.reconcile) {
        const ids = new Set<string | undefined>();
        for (const record of this.diskRecords()) {
          if (record !== null) ids.add(this.options.recordId(record));
        }
        this.pending = this.pending.filter(record => !ids.has(this.options.recordId(record)));
        this.reconcile = false;
      }
      while (this.pending.length) {
        // A newline isolates a prior torn append; damaged lines remain available for inspection.
        appendFileSync(this.file, '\n' + JSON.stringify(this.pending[0]) + '\n', 'utf8');
        this.pending.shift();
        if (this.diskCount !== null) this.diskCount++;
      }
      this.error = null;
    } catch (error) { this.reconcile = true; this.diskCount = null; this.note(error); }
  }

  status(): { pending: number; error: string | null } { return { pending: this.pending.length, error: this.error }; }

  private note(error: unknown): void {
    const message = `${this.options.label} ${this.file}: ${String(error)}`;
    if (message !== this.error) (this.options.report ?? console.error)(message);
    this.error = message;
  }

  /** Valid records on disk, deduplicated by id; a null follows each chunk read. */
  private *diskRecords(): Generator<Row | null> {
    if (!existsSync(this.file)) return;
    const seen = new Set<string>();
    let damaged = 0;
    for (const line of fileLines(this.file)) {
      if (line === null) { yield null; continue; }
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { damaged++; continue; }
      if (!this.options.isRecord(record)) { damaged++; continue; }
      const id = this.options.recordId(record);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      yield record;
    }
    if (damaged) this.note(`${damaged} damaged ledger lines retained on disk`);
  }

  /**
   * Reads the ledger one chunk per event-loop turn. Appends are synchronous, so the file holds
   * only whole lines at every turn and the scan ends having read every record then on disk.
   * Resolves false when the file could not be read.
   */
  private async scan(each: (record: Row) => void = () => {}): Promise<boolean> {
    const cleared = this.cleared;
    let count = 0;
    try {
      for (const record of this.diskRecords()) {
        if (record === null) await new Promise<void>(resolve => setImmediate(resolve));
        else { each(record); count++; }
      }
      if (cleared === this.cleared) this.diskCount = count;
      return true;
    } catch (error) { this.note(error); return false; }
  }

  /** Records on disk and still pending; with `keep`, only those it accepts are held. */
  async readAll(keep: (record: Row) => boolean = () => true): Promise<Row[]> {
    const records: Row[] = [];
    if (!await this.scan(record => { if (keep(record)) records.push(record); })) records.length = 0;
    if (!this.pending.length) return records;
    const ids = new Set(records.map(record => this.options.recordId(record)));
    return [...records, ...this.pending.filter(record => keep(record) && !ids.has(this.options.recordId(record)))];
  }

  /** Null until the first scan completes; asking starts that scan. */
  count(): number | null {
    if (this.diskCount !== null) return this.diskCount + this.pending.length;
    this.counting ??= this.scan().then(() => { this.counting = null; });
    return null;
  }

  clear(): Promise<number> {
    return JsonlLedger.clearTogether([this]);
  }

  /** Opens every ledger for writing before clearing any of them. */
  static async clearTogether(ledgers: readonly JsonlLedger<unknown>[]): Promise<number> {
    const counts = await Promise.all(ledgers.map(async ledger => (await ledger.readAll()).length));
    const files = new Map<number, JsonlLedger<unknown>>();
    try {
      for (const ledger of ledgers) {
        mkdirSync(dirname(ledger.file), { recursive: true });
        const fd = openSync(ledger.file, constants.O_WRONLY | constants.O_CREAT);
        files.set(fd, ledger);
        if (!fstatSync(fd).isFile()) throw new Error(`Ledger ${ledger.file} is not a regular file`);
      }
      for (const [fd, ledger] of files) {
        ftruncateSync(fd);
        ledger.resetAfterClear();
      }
    } finally {
      for (const fd of files.keys()) closeSync(fd);
    }
    return counts.reduce((sum, count) => sum + count, 0);
  }

  protected resetAfterClear(): void {
    this.pending = [];
    this.error = null;
    this.cleared++;
    this.diskCount = 0;
  }
}
