import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readJsonObject, updateJsonObject } from '../src/config-file.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xuewu-config-'));
  dirs.push(dir);
  return join(dir, 'config.json');
}

describe('config.json persistence', () => {
  it('带 BOM 的 config.json 解析得出来', () => {
    const file = tempFile();
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{ "language": "en" }', 'utf8')]));
    expect(readJsonObject(file)).toEqual({ language: 'en' });
  });

  it('updates one section without replacing unrelated configuration', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ models: { main: { model: 'old' } }, worlds: { web: { enabled: true } } }));

    updateJsonObject(file, (root) => {
      const models = root.models as Record<string, unknown>;
      models.main = { model: 'new' };
    });

    expect(readJsonObject(file)).toEqual({
      models: { main: { model: 'new' } },
      worlds: { web: { enabled: true } },
    });
    expect(readFileSync(file, 'utf8')).toMatch(/\n$/);
    expect(readdirSync(dirname(file))).toEqual(['config.json']);
  });

  it('rejects malformed or non-object roots without overwriting the source', () => {
    for (const content of ['{broken', '[]']) {
      const file = tempFile();
      writeFileSync(file, content);
      expect(() => updateJsonObject(file, (root) => { root.changed = true; })).toThrow('config.json解析失败');
      expect(readFileSync(file, 'utf8')).toBe(content);
    }
  });
});
