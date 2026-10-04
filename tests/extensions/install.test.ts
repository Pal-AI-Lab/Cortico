import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

async function preventCleanup(stage: string): Promise<() => Promise<void>> {
  const held = join(stage, 'held'); mkdirSync(held);
  const file = join(held, 'file'); writeFileSync(file, 'held');
  if (process.platform !== 'win32') {
    chmodSync(held, 0o500);
    return async () => { chmodSync(held, 0o700); };
  }
  const script = `$file = [System.IO.File]::Open('${file.replace(/'/g, "''")}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); [Console]::WriteLine('ready'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $file.Dispose()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    let error = '';
    child.stderr.on('data', chunk => { error += String(chunk); });
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`file holder exited ${code}: ${error}`)));
  });
  return async () => { const exited = once(child, 'exit'); child.stdin.end('\n'); await exited; };
}

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

  it.skipIf(process.platform !== 'win32' && process.getuid?.() === 0)('cleanup failure preserves the package failure and reports the remaining directory', async () => {
    let release!: () => Promise<void>;
    let stage!: string;
    const cause = new Error('package build failed');
    try {
      const operation = mutateInstallation(dir, async path => {
        stage = path; release = await preventCleanup(stage);
        throw cause;
      });
      await expect(operation).rejects.toMatchObject({ cause, message: expect.stringContaining('package build failed') });
      await expect(operation).rejects.toThrow('临时文件清理失败');
      await expect(operation).rejects.toThrow(stage);
      expect(existsSync(stage)).toBe(true);
      expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('original lock');
      expect(existsSync(join(dir, '.install-lock'))).toBe(false);
    } finally { await release?.(); }
  });

  it.skipIf(process.platform !== 'win32' && process.getuid?.() === 0)('a published installation stays successful when temporary cleanup fails', async () => {
    let release!: () => Promise<void>;
    let stage!: string;
    try {
      const result = await mutateInstallation(dir, async path => {
        stage = path; release = await preventCleanup(stage);
        writeFileSync(join(stage, 'package.json'), '{"dependencies":{"example":"0.9.0"}}');
        return 'installed';
      });
      expect(result.value).toBe('installed');
      expect(result.cleanupWarning).toContain(stage);
      expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies.example).toBe('0.9.0');
      expect(existsSync(join(dir, '.install-lock'))).toBe(false);
    } finally { await release?.(); }
  });

  it('two managers cannot mutate the same shared directory concurrently', async () => {
    let release!: () => void;
    const first = mutateInstallation(dir, () => new Promise<void>(resolve => { release = resolve; }));
    await expect(mutateInstallation(dir, async () => {})).rejects.toThrow('已有安装');
    release(); await first;
    expect(existsSync(join(dir, '.install-lock'))).toBe(false);
  });

  it.each(['json', 'yaml'])('the %s module manifest keeps pnpm in the staged store until publication', async format => {
    const store = join(dir, 'node_modules', '.pnpm');
    const file = join(dir, 'node_modules', '.modules.yaml');
    writeFileSync(file, format === 'json' ? JSON.stringify({ virtualStoreDir: store, storeDir: 'shared-cache' }) : `virtualStoreDir: ${JSON.stringify(store)}\nstoreDir: shared-cache\n`);
    const value = (text: string) => format === 'json' ? JSON.parse(text).virtualStoreDir : JSON.parse(/^virtualStoreDir: (.+)$/m.exec(text)![1]);
    await mutateInstallation(dir, async stage => {
      expect(value(readFileSync(join(stage, 'node_modules', '.modules.yaml'), 'utf8'))).toBe(join(stage, 'node_modules', '.pnpm'));
    });
    const text = readFileSync(file, 'utf8');
    expect(value(text)).toBe(store);
    expect(text).toContain('shared-cache');
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
