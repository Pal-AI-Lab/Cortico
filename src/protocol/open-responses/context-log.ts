import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { retryBusy, retryBusyAsync } from '../../core/fs-busy.ts';
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
 * The repair `load()` applied to a final line that has no trailing newline. A line that does not
 * parse is cut off; a complete record only gets its newline.
 */
export type ContextLoadRepair =
  | { kind: 'torn-tail'; bytes: number }
  | { kind: 'unterminated-tail' };

/** Immutable standard Items with runtime metadata stored in a separate field. */
export class ContextLog {
  private entries: readonly ContextRecord[] = Object.freeze([]);
  private revision = 0;
  private fileBytes = 0;
  constructor(readonly file: string, private readonly stamp?: () => string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  get records(): readonly ContextRecord[] { return this.entries; }

  /** Any other damaged line throws and leaves the file untouched. */
  load(): ContextLoadRepair | null {
    this.revision++;
    if (!existsSync(this.file)) { this.entries = Object.freeze([]); this.fileBytes = 0; return null; }
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
    // Written only after every kept line validated.
    if (repair?.kind === 'torn-tail') truncateSync(this.file, Buffer.byteLength(body, 'utf8'));
    else if (repair) appendFileSync(this.file, '\n');
    this.fileBytes = statSync(this.file).size;
    this.entries = Object.freeze(rows);
    return repair;
  }

  append(entry: ContextRecord): ContextRecord {
    const next = structuredClone(entry);
    if (this.stamp && next.context.ts === undefined) next.context.ts = this.stamp();
    const line = JSON.stringify(next) + '\n';
    retryBusy(() => appendFileSync(this.file, line));
    this.fileBytes += Buffer.byteLength(line);
    this.entries = Object.freeze([...this.entries, freeze(next)]);
    return next;
  }

  reset(records: readonly ContextRecord[]): void {
    const next = records.map(entry => freeze(structuredClone(entry)));
    this.fileBytes = atomicContextWrite(this.file, next);
    this.revision++;
    this.entries = Object.freeze(next);
  }

  /** Preserve the existing JSONL tail, including appends made while the temporary file is written. */
  async replacePrefix(removed: number, entry: ContextRecord, active: () => boolean, committed: () => void): Promise<boolean> {
    if (!active()) return false;
    if (this.entries.length === 0) {
      this.reset([entry]);
      committed();
      return true;
    }
    const revision = this.revision;
    const prefix = freeze(structuredClone(entry));
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    const current = () => this.revision === revision && active();
    let created = false;
    let replaced = false;
    try {
      while (current()) {
        const first = !created;
        let count: number, targetSize: number;
        const target = await open(temporary, first ? 'wx' : 'a');
        created = true;
        try {
          if (first) await target.writeFile(JSON.stringify(prefix) + '\n');
          if (!current()) return false;
          const source = await open(this.file, 'r');
          try {
            if (!current()) return false;
            count = this.entries.length;
            const end = fstatSync(source.fd).size;
            if (end !== this.fileBytes) throw new Error('Session file size changed outside the active writer');
            if (first) position = await offsetAfterRecords(source, removed, buffer);
            while (position < end) {
              const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, end - position), position);
              if (!bytesRead) throw new Error('Unexpected end of session file during prefix replacement');
              position += bytesRead;
              await target.writeFile(buffer.subarray(0, bytesRead));
              if (!current()) return false;
            }
          } finally { await source.close(); }
          await target.sync();
          targetSize = fstatSync(target.fd).size;
        } finally { await target.close(); }
        // Windows requires both our handles to be closed for replacement. Recheck concurrent appends
        // after closing and after every external file-sharing retry, before the synchronous commit.
        const done = await retryBusyAsync(() => {
          if (!current()) return false;
          if (this.entries.length !== count) return null;
          if (statSync(this.file).size !== this.fileBytes) throw new Error('Session file size changed outside the active writer');
          const next = Object.freeze([prefix, ...this.entries.slice(removed)]);
          renameSync(temporary, this.file);
          replaced = true;
          this.revision++;
          this.fileBytes = targetSize;
          this.entries = next;
          committed();
          return true;
        });
        if (done !== null) return done;
      }
      return false;
    } finally {
      if (created && !replaced) await unlink(temporary);
    }
  }
}

/** Byte offset immediately after the Nth validated JSON object, including any intervening blank lines. */
async function offsetAfterRecords(source: FileHandle, count: number, buffer: Buffer): Promise<number> {
  let position = 0;
  let nonblank = false;
  while (count > 0) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (!bytesRead) throw new Error('Session file is missing the prefix being replaced');
    const chunk = buffer.subarray(0, bytesRead);
    let from = 0;
    while (from < bytesRead) {
      const newline = chunk.indexOf(10, from);
      const end = newline === -1 ? bytesRead : newline + 1;
      nonblank ||= chunk.subarray(from, end).includes(0x7b); // Every validated record starts with '{'.
      if (newline !== -1) {
        if (nonblank && --count === 0) return position + end;
        nonblank = false;
      }
      from = end;
    }
    position += bytesRead;
  }
  return position;
}

function atomicContextWrite(path: string, records: readonly ContextRecord[]): number {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w');
  let size: number;
  try {
    writeFileSync(fd, records.map(row => JSON.stringify(row)).join('\n') + (records.length ? '\n' : ''));
    fsyncSync(fd);
    size = fstatSync(fd).size;
  } finally { closeSync(fd); }
  retryBusy(() => renameSync(temporary, path));
  return size;
}
