/**
 * 密钥文件按 BOM 解码:Windows 的 shell 重定向写出的是 UTF-16 LE,按 UTF-8 读不出原文。
 * 名字取夹具专用的一个,并把同名进程环境变量钉成空串:secretReader 优先读非空环境变量,
 * 真环境里存在同名变量时文件那一路根本走不到。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretReader } from '../../src/core/secrets.ts';

const NAME = 'CORTICO_FIXTURE_API_KEY';
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envFile(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-secrets-'));
  dirs.push(dir);
  const file = join(dir, '.env');
  writeFileSync(file, bytes);
  return file;
}

describe('secretReader', () => {
  it('UTF-16 LE 的 .env 里读得出密钥', () => {
    vi.stubEnv(NAME, '');
    const text = `${NAME}=sk-test\n`;
    const file = envFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    expect(secretReader(file)(NAME)).toBe('sk-test');
  });

  it('文件里没有这个名字时回空串', () => {
    vi.stubEnv(NAME, '');
    const file = envFile(Buffer.from('OTHER=1\n', 'utf8'));
    expect(secretReader(file)(NAME)).toBe('');
  });

  it('进程不重启时改写 .env 后读到新值', () => {
    vi.stubEnv(NAME, '');
    const file = envFile(Buffer.from(`${NAME}=first\n`, 'utf8'));
    const read = secretReader(file);
    expect(read(NAME)).toBe('first');
    writeFileSync(file, Buffer.from(`${NAME}=second\n`, 'utf8'));
    expect(read(NAME)).toBe('second');
  });
});
