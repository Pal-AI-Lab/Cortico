/**
 * 手写的文本文件按 BOM 解码:Windows 的 shell 重定向写出的是 UTF-16 LE 或带 BOM 的 UTF-8,
 * 两者按 UTF-8 读都读不出原文。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTextFile } from '../../src/core/util.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-text-file-'));
  dirs.push(dir);
  return dir;
}

/** PowerShell 5.1 的 `>` 写出的字节:UTF-16 LE,带 BOM。 */
function writeUtf16le(file: string, text: string): void {
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
}

/** `Out-File -Encoding utf8` 写出的字节:UTF-8,带 BOM。 */
function writeUtf8Bom(file: string, text: string): void {
  writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
}

describe('readTextFile', () => {
  it('UTF-8 无 BOM 原样读出', () => {
    const file = join(tempDir(), 'a.txt');
    writeFileSync(file, '你好 hello\n', 'utf8');
    expect(readTextFile(file)).toBe('你好 hello\n');
  });

  it('UTF-16 LE 按 UTF-16 解码,BOM 不进返回值', () => {
    const file = join(tempDir(), 'b.txt');
    writeUtf16le(file, '你好 hello\n');
    expect(readTextFile(file)).toBe('你好 hello\n');
  });

  it('UTF-8 BOM 不进返回值', () => {
    const file = join(tempDir(), 'c.txt');
    writeUtf8Bom(file, '{ "bot": "cormini" }');
    expect(readTextFile(file)).toBe('{ "bot": "cormini" }');
  });
});
