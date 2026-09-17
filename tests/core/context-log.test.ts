import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextLog } from '../../src/protocol/open-responses/context-log.ts';
import { message, record } from '../../src/protocol/open-responses/context.ts';
import { makeTmpDir } from './helpers.ts';

describe('Standard Item context storage', () => {
  it('preserves item order, encrypted reasoning, content parts, phase and runtime sidecars across restart', () => {
    const tmp = makeTmpDir();
    try {
      const file = join(tmp.dir, 'session-main.jsonl');
      const log = new ContextLog(file, () => '2026-09-05T12:00:00Z');
      const records = [
        record({ type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: 'first' }], encrypted_content: 'sealed1' }),
        record({ type: 'message', id: 'm1', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'checking', annotations: [] }, { type: 'refusal', refusal: 'part refusal' }] }),
        record({ type: 'reasoning', id: 'r2', summary: [], content: [{ type: 'reasoning_text', text: 'native plaintext' }], encrypted_content: 'sealed2' }),
      ];
      for (const entry of records) log.append(entry);
      const restored = new ContextLog(file);
      restored.load();
      expect(restored.records.map(entry => entry.item)).toEqual(records.map(entry => entry.item));
      expect(restored.records.every(entry => entry.context.ts === '2026-09-05T12:00:00Z')).toBe(true);
      expect(() => { (restored.records[0].item as { id: string }).id = 'changed'; }).toThrow();
      expect(() => { (restored.records as unknown[]).splice(0, 1); }).toThrow();
      records[0].context.ts = 'outside mutation';
      expect(restored.records[0].context.ts).toBe('2026-09-05T12:00:00Z');
    } finally { tmp.cleanup(); }
  });

  it.each([
    { role: 'assistant', content: 'old message' },
    null,
    { version: 2, item: [], context: {} },
    { version: 2, item: { type: 'message' }, context: [] },
  ])('rejects an unsupported record without changing disk or loaded context: %j', (invalid) => {
    const tmp = makeTmpDir();
    try {
      const file = join(tmp.dir, 'session-main.jsonl');
      const log = new ContextLog(file);
      log.append(message('user', 'current input'));
      const prior = log.records;
      const raw = readFileSync(file, 'utf8') + JSON.stringify(invalid) + '\n';
      writeFileSync(file, raw);
      expect(() => log.load()).toThrow('Invalid context record');
      expect(log.records).toBe(prior);
      expect(readFileSync(file, 'utf8')).toBe(raw);
    } finally { tmp.cleanup(); }
  });

  it('cuts off a torn final line, reports it and appends on a fresh line afterwards', () => {
    const tmp = makeTmpDir();
    try {
      const file = join(tmp.dir, 'session-main.jsonl');
      const log = new ContextLog(file);
      const kept = message('user', 'kept');
      log.append(kept);
      const intact = readFileSync(file, 'utf8');
      const torn = JSON.stringify(message('assistant', 'lost in a crash')).slice(0, 40);
      writeFileSync(file, intact + torn);

      const restored = new ContextLog(file);
      expect(restored.load()).toEqual({ kind: 'torn-tail', bytes: Buffer.byteLength(torn) });
      expect(restored.records.map(entry => entry.item)).toEqual([kept.item]);
      expect(readFileSync(file, 'utf8')).toBe(intact);

      restored.append(message('assistant', 'after repair'));
      const again = new ContextLog(file);
      expect(again.load()).toBeNull();
      expect(again.records.map(entry => entry.item)).toEqual(restored.records.map(entry => entry.item));
    } finally { tmp.cleanup(); }
  });

  it('keeps a complete final record that lacks its newline and terminates it', () => {
    const tmp = makeTmpDir();
    try {
      const file = join(tmp.dir, 'session-main.jsonl');
      const log = new ContextLog(file);
      const kept = message('user', 'kept');
      log.append(kept);
      const complete = message('assistant', 'complete');
      const last = JSON.stringify(complete);
      writeFileSync(file, readFileSync(file, 'utf8') + last);

      const restored = new ContextLog(file);
      expect(restored.load()).toEqual({ kind: 'unterminated-tail' });
      expect(restored.records.map(entry => entry.item)).toEqual([kept.item, complete.item]);
      expect(readFileSync(file, 'utf8').endsWith(last + '\n')).toBe(true);
      expect(new ContextLog(file).load()).toBeNull();
    } finally { tmp.cleanup(); }
  });

  it('rejects damaged input without replacing the session', () => {
    const tmp = makeTmpDir();
    try {
      const file = join(tmp.dir, 'session-main.jsonl');
      const raw = '{broken\n';
      writeFileSync(file, raw);
      expect(() => new ContextLog(file).load()).toThrow('Invalid session JSON');
      expect(readFileSync(file, 'utf8')).toBe(raw);
    } finally { tmp.cleanup(); }
  });
});
