import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutateInstallation } from '../../src/extensions/install.ts';

let root: string, dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'extension-install-'));
  dir = join(root, 'extensions'); mkdirSync(join(dir, 'node_modules', 'example'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"dependencies":{"example":"1.0.0"}}');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'original lock');
  writeFileSync(join(dir, 'node_modules', 'example', 'package.json'), '{"version":"1.0.0"}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const leftovers = () => readdirSync(root).filter(name => name.startsWith('.extensions-operations-'));

describe('mutateInstallation', () => {
  it('publishes the prepared dependency tree and metadata together', async () => {
    await mutateInstallation(dir, async stage => {
      expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('original lock');
      writeFileSync(join(stage, 'package.json'), '{"dependencies":{"example":"0.9.0"}}');
      writeFileSync(join(stage, 'pnpm-lock.yaml'), 'new lock');
      writeFileSync(join(stage, 'node_modules', 'example', 'package.json'), '{"version":"0.9.0"}');
    });
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies.example).toBe('0.9.0');
    expect(JSON.parse(readFileSync(join(dir, 'node_modules', 'example', 'package.json'), 'utf8')).version).toBe('0.9.0');
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('new lock');
    expect(leftovers()).toEqual([]);
  });

  it('a package manager failure leaves the original files and dependency tree intact', async () => {
    await expect(mutateInstallation(dir, async stage => {
      writeFileSync(join(stage, 'package.json'), '{}');
      rmSync(join(stage, 'node_modules'), { recursive: true });
      throw new Error('build failed');
    })).rejects.toThrow('build failed');
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies.example).toBe('1.0.0');
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('original lock');
    expect(existsSync(join(dir, 'node_modules', 'example', 'package.json'))).toBe(true);
    expect(leftovers()).toEqual([]);
    expect(existsSync(join(dir, '.install-lock'))).toBe(false);
  });

  it('a replacement failure restores files already replaced', async () => {
    await expect(mutateInstallation(dir, async stage => {
      writeFileSync(join(stage, 'package.json'), '{}');
      mkdirSync(join(stage, '.backup', 'pnpm-lock.yaml'));
      writeFileSync(join(stage, '.backup', 'pnpm-lock.yaml', 'obstruction'), 'x');
    })).rejects.toThrow('恢复');
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies.example).toBe('1.0.0');
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('original lock');
    expect(leftovers()).toEqual([]);
  });

  it('two managers cannot mutate the same shared directory concurrently', async () => {
    let release!: () => void;
    const first = mutateInstallation(dir, () => new Promise<void>(resolve => { release = resolve; }));
    await expect(mutateInstallation(dir, async () => {})).rejects.toThrow('已有安装');
    release(); await first;
    expect(existsSync(join(dir, '.install-lock'))).toBe(false);
  });

  it('internal junctions point to the staged tree while external local links remain usable', async () => {
    const local = join(root, 'local'); mkdirSync(local);
    const modules = join(dir, 'node_modules');
    symlinkSync(join(modules, 'example'), join(modules, 'internal'), 'junction');
    symlinkSync(local, join(modules, 'local'), 'junction');
    await mutateInstallation(dir, async stage => {
      expect(realpathSync(join(stage, 'node_modules', 'internal'))).toBe(realpathSync(join(stage, 'node_modules', 'example')));
      expect(realpathSync(join(stage, 'node_modules', 'local'))).toBe(realpathSync(local));
    });
    expect(realpathSync(join(modules, 'internal'))).toBe(realpathSync(join(modules, 'example')));
    expect(realpathSync(join(modules, 'local'))).toBe(realpathSync(local));
    expect(leftovers()).toEqual([]);
  });
});
