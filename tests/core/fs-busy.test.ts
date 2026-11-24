import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceFile } from '../../src/core/fs-busy.ts';

describe('replaceFile', () => {
  it('replaces an existing file and leaves no temporary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-busy-'));
    const file = join(dir, 'record.json');
    writeFileSync(file, 'old');
    replaceFile(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['record.json']);
  });

  it('keeps what is at the path when the rename fails, and removes the temporary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-busy-'));
    const target = join(dir, 'record.json');
    // a non-empty directory cannot be renamed over on any platform
    mkdirSync(target);
    writeFileSync(join(target, 'inside'), 'kept');
    expect(() => replaceFile(target, 'new')).toThrow();
    expect(readdirSync(dir)).toEqual(['record.json']);
    expect(readFileSync(join(target, 'inside'), 'utf8')).toBe('kept');
  }, 10_000);
});
