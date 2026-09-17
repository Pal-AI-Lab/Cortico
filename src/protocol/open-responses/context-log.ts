import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContextRecord } from './context.ts';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(row: unknown): row is ContextRecord {
  const r = row as ContextRecord | null;
  return !!r && r.version === 2 && !!r.item && typeof r.item === 'object' && !Array.isArray(r.item)
    && !!r.context && typeof r.context === 'object' && !Array.isArray(r.context);
}

/**
 * The repair `load()` applied to a final line that has no trailing newline: an append the process
 * did not finish. A line that does not parse is cut off; a complete record only gets its newline.
 */
export type ContextLoadRepair =
  | { kind: 'torn-tail'; bytes: number }
  | { kind: 'unterminated-tail' };

/** Immutable standard Items with runtime metadata stored in a separate field. */
export class ContextLog {
  private entries: readonly ContextRecord[] = Object.freeze([]);
  constructor(readonly file: string, private readonly stamp?: () => string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  get records(): readonly ContextRecord[] { return this.entries; }

  /** Any other damaged line throws and leaves the file untouched. */
  load(): ContextLoadRepair | null {
    if (!existsSync(this.file)) { this.entries = Object.freeze([]); return null; }
    const raw = readFileSync(this.file, 'utf8');
    let body = raw;
    let repair: ContextLoadRepair | null = null;
    if (raw.length > 0 && !raw.endsWith('\n')) {
      const cut = raw.lastIndexOf('\n') + 1;
      const tail = raw.slice(cut);
      let parsed: unknown = null;
      try { parsed = JSON.parse(tail); } catch { /* torn */ }
      if (isRecord(parsed)) repair = { kind: 'unterminated-tail' };
      else { body = raw.slice(0, cut); repair = { kind: 'torn-tail', bytes: Buffer.byteLength(tail, 'utf8') }; }
    }
    const rows = body.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
      let row: unknown;
      try { row = JSON.parse(line); }
      catch { throw new Error(`Invalid session JSON at ${this.file}:${index + 1}`); }
      if (!isRecord(row)) throw new Error(`Invalid context record at ${this.file}:${index + 1}`);
      return freeze(row);
    });
    // The file is repaired only once every kept line is known good, so a later append starts on a fresh line.
    if (repair?.kind === 'torn-tail') truncateSync(this.file, Buffer.byteLength(body, 'utf8'));
    else if (repair) appendFileSync(this.file, '\n');
    this.entries = Object.freeze(rows);
    return repair;
  }

  append(entry: ContextRecord): ContextRecord {
    const next = structuredClone(entry);
    if (this.stamp && next.context.ts === undefined) next.context.ts = this.stamp();
    appendFileSync(this.file, JSON.stringify(next) + '\n');
    this.entries = Object.freeze([...this.entries, freeze(next)]);
    return next;
  }

  reset(records: readonly ContextRecord[]): void {
    const next = records.map(entry => freeze(structuredClone(entry)));
    atomicContextWrite(this.file, next);
    this.entries = Object.freeze(next);
  }
}

function atomicContextWrite(path: string, records: readonly ContextRecord[]): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w');
  try {
    writeFileSync(fd, records.map(row => JSON.stringify(row)).join('\n') + (records.length ? '\n' : ''));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, path);
}
