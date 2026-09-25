import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionPackageStore, installedEnvironment, type PackageOperation } from '../../src/extensions/package-store.ts';
let root: string, dir: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'extension-store-')); dir = join(root, 'extensions'); mkdirSync(dir); writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { sample: '1.0.0' } })); writeFileSync(join(dir, 'user-notes.txt'), 'retain me'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const operation = (id = 'example-operation'): PackageOperation => ({ id, action: 'install', target: 'sample@2.0.0', phase: 'preparing' });
const prepare = async (stage: string) => { writeFileSync(join(stage, 'package.json'), JSON.stringify({ dependencies: { sample: '2.0.0' } })); return { name: 'sample', version: '2.0.0' }; };
const version = () => JSON.parse(readFileSync(join(installedEnvironment(dir), 'package.json'), 'utf8')).dependencies.sample;
describe('extension package transactions', () => {
  it('commits validated state once and retains unrelated environment files', async () => {
    const store = new ExtensionPackageStore(dir); const result = await store.transact(operation(), prepare);
    expect(result.phase).toBe('committed'); expect(version()).toBe('2.0.0'); expect(readFileSync(join(dir, 'user-notes.txt'), 'utf8')).toBe('retain me');
    const repeated = await store.transact(operation(), async () => { throw new Error('must not repeat'); }); expect(repeated).toEqual(result);
  });
  it.each(['before-swap', 'after-backup', 'after-install'])('restores old packages when %s fails, with readers seeing the old version', async checkpoint => {
    const store = new ExtensionPackageStore(dir, phase => { expect(version()).toBe('1.0.0'); if (phase === checkpoint) throw new Error('injected failure'); });
    const result = await store.transact(operation(), prepare); expect(result.phase).toBe('rolled-back'); expect(version()).toBe('1.0.0'); expect(store.operation(result.id)?.phase).toBe('rolled-back');
  });
  it('validation rejection preserves the entire original environment', async () => {
    const original = readFileSync(join(dir, 'package.json'), 'utf8');
    const result = await new ExtensionPackageStore(dir).transact(operation(), async stage => { await prepare(stage); throw new Error('invalid export'); });
    expect(result.phase).toBe('rolled-back'); expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(original);
  });
  it('serializes different manager instances through the shared lock', async () => {
    const first = new ExtensionPackageStore(dir), second = new ExtensionPackageStore(dir);
    let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
    const pending = first.transact(operation(), async stage => { await gate; return prepare(stage); });
    await expect(second.transact(operation('other-operation'), prepare)).rejects.toThrow('另一项操作'); release(); await pending;
    expect(first.busy).toBe(false); expect(existsSync(dir)).toBe(true);
  });
});
