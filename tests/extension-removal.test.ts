import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionManager, loadExtensions } from '../src/extensions.ts';
import { EXTENSION_API_VERSIONS } from '../src/extensions/manifest.ts';
import { text } from '../src/extensions/strings.ts';
import { extensionRuntimeState } from '../src/bot.ts';
import { loadDeployment } from '../src/deploy.ts';
import { CORE_DEFAULTS } from '../src/core/config.ts';
import { WorldAssembly, worldDefaults } from '../src/world.ts';
import type { WorldHost } from '../src/core/types.ts';
import { nullLogger } from '../src/core/util.ts';
import { providerModule, providerModules, registerProviderModules, removeProviderModule } from '../src/providers/registry.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'extension-removal-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function setup(enabled = false, failRemoval = false, importFailure = false, reserved: string[] = []) {
  const dir = join(root, 'extensions'), pkg = join(dir, 'node_modules', 'fixture-world');
  mkdirSync(pkg, { recursive: true });
  const install = () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { 'fixture-world': '1.0.0' } }));
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture-world', version: '1.0.0', type: 'module', main: './index.js', cortico: { kind: 'world', api: EXTENSION_API_VERSIONS.world } }));
    writeFileSync(join(pkg, 'index.js'), `export default {id:'fixture',label:'Fixture',defaults:()=>({enabled:false,port:3210}),create:()=>({id:'fixture',envPromptVars:()=>({}),tools:()=>[],start:async()=>{},stop:async()=>{}})};`);
  };
  install();
  writeFileSync(join(root, 'config.json'), JSON.stringify({ worlds: { fixture: { enabled, port: 4321 } } }));
  await loadExtensions(root);
  if (importFailure) {
    const manifestFile = join(pkg, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.main = './broken.js';
    writeFileSync(manifestFile, JSON.stringify(manifest));
    writeFileSync(join(pkg, 'broken.js'), 'throw new Error("fixture import failure");');
  }
  const booted = await loadExtensions(root, { reserved });
  const source = { defaults: () => ({ ...structuredClone(CORE_DEFAULTS), worlds: worldDefaults(booted.worlds, []) }) };
  const loaded = loadDeployment(source, root, root);
  const assembly = new WorldAssembly(loaded, booted.worlds, []);
  assembly.bind({ mount: async world => { await world.start({} as WorldHost); assembly.mounted.push(world); }, unmount: async id => {
    const i = assembly.mounted.findIndex(world => world.id === id);
    await assembly.mounted[i].stop(); assembly.mounted.splice(i, 1);
  } });
  let gate: Promise<void> | undefined;
  const manager = new ExtensionManager(root, booted, {
    decorate: extensionRuntimeState(assembly, () => true, () => false),
    removeWorld: (id, remove) => assembly.removeDefinition(id, remove),
    run: async () => {
      if (gate) await gate;
      if (failRemoval) return { code: 1, output: 'filesystem busy' };
      rmSync(pkg, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: {} }));
      return { code: 0, output: 'removed' };
    },
  });
  return { assembly, manager, install, pkg, source, loaded, pause: (until: Promise<void>) => { gate = until; },
    saved: () => JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as { worlds: { fixture: { enabled: boolean; port: number } } } };
}

it('rejects a running World before removing its files or configuration', async () => {
  const { manager, pkg, saved } = await setup(true);
  await expect(manager.uninstall('fixture-world', 'en')).rejects.toMatchObject({ status: 409 });
  await expect(manager.uninstall('fixture-world', 'en')).rejects.toThrow(text('en').worldInUse);
  expect(existsSync(join(pkg, 'index.js'))).toBe(true);
  expect(saved().worlds.fixture).toEqual({ enabled: true, port: 4321 });
});

it('removes inactive slots, clears activation intent, and marks same-version reinstalls pending restart', async () => {
  const { assembly, manager, install, pkg, saved, source } = await setup(true);
  assembly.startFailed('fixture', 'startup failed');
  await manager.uninstall('fixture-world');
  expect(existsSync(pkg)).toBe(false);
  expect(assembly.instances()).toEqual([]);
  expect(assembly.definitions).toEqual([]);
  expect(saved().worlds.fixture).toEqual({ enabled: false, port: 4321 });
  await expect(assembly.activate('fixture')).rejects.toThrow();
  install();
  expect(manager.list().extensions[0]).toMatchObject({ state: 'pending-restart', enabled: false });
  const next = loadDeployment(source, root, root);
  const rebooted = new WorldAssembly(next, (await loadExtensions(root)).worlds, []);
  expect(rebooted.mounted).toEqual([]);
});

it('keeps the slot and restores activation intent when package removal fails', async () => {
  const { assembly, manager, pkg, saved } = await setup(true, true);
  assembly.startFailed('fixture', 'startup failed');
  await expect(manager.uninstall('fixture-world')).rejects.toThrow('filesystem busy');
  expect(existsSync(pkg)).toBe(true);
  expect(assembly.instances()).toHaveLength(1);
  expect(saved().worlds.fixture.enabled).toBe(true);
});

it('serializes activation behind deletion and rejects it after the slot is removed', async () => {
  const { assembly, manager, pause, pkg } = await setup();
  const gate = deferred(); pause(gate.promise);
  const removing = manager.uninstall('fixture-world');
  await Promise.resolve(); await Promise.resolve();
  const activating = assembly.activate('fixture');
  const rejected = expect(activating).rejects.toThrow();
  gate.resolve();
  await removing; await rejected;
  expect(existsSync(pkg)).toBe(false);
  expect(assembly.mounted).toEqual([]);
});

it('rechecks a World whose activation was queued before uninstall', async () => {
  const { assembly, manager, pkg } = await setup();
  const activating = assembly.activate('fixture');
  const removing = manager.uninstall('fixture-world');
  const rejected = expect(removing).rejects.toMatchObject({ status: 409 });
  await activating; await rejected;
  expect(existsSync(pkg)).toBe(true);
  expect(assembly.mounted.map(world => world.id)).toEqual(['fixture']);
});

it.each([false, true])('shutdown drains the complete removal transaction (failure=%s) and refuses new mutations', async fail => {
  const { manager, pause, pkg, saved } = await setup(true, fail, true);
  const gate = deferred(); pause(gate.promise);
  const removal = manager.uninstall('fixture-world');
  const result = removal.catch(error => error);
  let closed = false;
  const closing = manager.close().then(() => { closed = true; });
  await expect(manager.install({ name: 'another-fixture' })).rejects.toMatchObject({ status: 503 });
  await expect(manager.uninstall('fixture-world')).rejects.toMatchObject({ status: 503 });
  await Promise.resolve(); await Promise.resolve();
  expect(closed).toBe(false);
  gate.resolve();
  await result; await closing;
  expect(existsSync(pkg)).toBe(fail);
  expect(saved().worlds.fixture.enabled).toBe(fail);
  expect(manager.list().extensions[0].state).toBe(fail ? 'failed' : 'removed');
});

it('clears a previously loaded World after import failure and keeps its reinstall inactive', async () => {
  const { manager, install, saved, source, assembly } = await setup(true, false, true);
  expect(assembly.instances()).toEqual([]);
  expect(manager.list().extensions[0]).toMatchObject({ state: 'failed', loaded: false });
  await manager.uninstall('fixture-world');
  expect(saved().worlds.fixture).toEqual({ enabled: false, port: 4321 });
  install();
  const rebooted = new WorldAssembly(loadDeployment(source, root, root), (await loadExtensions(root)).worlds, []);
  expect(rebooted.mounted).toEqual([]);
});

it('restores activation intent when removal of an import-failed World fails', async () => {
  const { manager, saved } = await setup(true, true, true);
  await expect(manager.uninstall('fixture-world')).rejects.toThrow('filesystem busy');
  expect(saved().worlds.fixture.enabled).toBe(true);
});

it('does not clear a formerly owned ID now reserved by the assembly', async () => {
  const { manager, saved } = await setup(true, false, true, ['fixture']);
  await manager.uninstall('fixture-world');
  expect(saved().worlds.fixture.enabled).toBe(true);
});

it('transfers ownership only to an accepted World, so removing an old package cannot clear its replacement', async () => {
  await setup(true, false, true);
  const dir = join(root, 'extensions');
  const pkg = join(dir, 'node_modules', 'replacement');
  mkdirSync(pkg);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'replacement', type: 'module', main: './index.js', cortico: { kind: 'world', api: EXTENSION_API_VERSIONS.world } }));
  writeFileSync(join(pkg, 'index.js'), `export default {id:'fixture',label:'Replacement',defaults:()=>({enabled:false}),create:()=>({id:'fixture',tools:()=>[],envPromptVars:()=>({}),start:async()=>{},stop:async()=>{}})};`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'fixture-world': '1.0.0', replacement: '1.0.0' } }));
  const booted = await loadExtensions(root);
  expect(booted.worldOwners).toEqual({ fixture: 'replacement' });
  const loaded = loadDeployment({ defaults: () => ({ ...structuredClone(CORE_DEFAULTS), worlds: worldDefaults(booted.worlds, []) }) }, root, root);
  const assembly = new WorldAssembly(loaded, booted.worlds, []);
  const manager = new ExtensionManager(root, booted, {
    decorate: extensionRuntimeState(assembly, () => true, () => false),
    removeWorld: (id, remove) => assembly.removeDefinition(id, remove),
    run: async () => { writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { replacement: '1.0.0' } })); return { code: 0, output: '' }; },
  });
  await manager.uninstall('fixture-world');
  expect(assembly.mounted.map(world => world.id)).toEqual(['fixture']);
  expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).worlds.fixture.enabled).toBe(true);
});

it('boots when the World owners file is corrupt, holds a non-string owner, or cannot be read or written', { timeout: 15_000 }, async () => {
  await setup(true);
  const file = join(root, 'extensions', 'world-owners.json');
  const warnings: string[] = [];
  const log = { ...nullLogger(), warn: (msg: string) => { warnings.push(msg); } };
  writeFileSync(file, JSON.stringify({ fixture: 'fixture-world', ghost: 7 }));
  expect((await loadExtensions(root, { log })).worldOwners).toEqual({ fixture: 'fixture-world' });
  writeFileSync(file, '{"fixture": "fixture-wor');
  expect((await loadExtensions(root, { log })).worldOwners).toEqual({ fixture: 'fixture-world' });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fixture: 'fixture-world' });
  rmSync(file);
  mkdirSync(file);
  expect((await loadExtensions(root, { log })).worldOwners).toEqual({ fixture: 'fixture-world' });
  expect(warnings.filter(msg => msg.includes(file))).toHaveLength(3);
});

it('uninstalls a provider again after it was uninstalled and reinstalled in the same process', async () => {
  const module = { ...providerModule('openai-responses-compat'), id: 'fixture-reinstalled', title: 'Fixture' };
  registerProviderModules([module]);
  const dir = join(root, 'extensions'), pkg = join(dir, 'node_modules', 'fixture-provider');
  const install = () => {
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture-provider', version: '1.0.0' }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { 'fixture-provider': '1.0.0' } }));
  };
  install();
  const record = { name: 'fixture-provider', spec: '1.0.0', version: '1.0.0', kind: 'provider' as const, worldId: module.id, loaded: true, webUiClient: false };
  const manager = new ExtensionManager(root, { dir, records: [record], worlds: [], providers: [module], webUiAssets: [], worldOwners: {} }, {
    removeProvider: (id, remove) => removeProviderModule(id, remove),
    run: async (args) => {
      if (args[0] === 'remove') {
        rmSync(pkg, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: {} }));
      } else install();
      return { code: 0, output: args[0] };
    },
  });
  try {
    await manager.uninstall('fixture-provider', 'en');
    expect(providerModules).not.toContain(module);
    await manager.install({ name: 'fixture-provider' }, 'en');
    await expect(manager.uninstall('fixture-provider', 'en')).resolves.toContain('remove');
    expect(existsSync(pkg)).toBe(false);
  } finally {
    if (providerModules.includes(module)) await removeProviderModule(module.id, async () => 'cleanup');
  }
});
