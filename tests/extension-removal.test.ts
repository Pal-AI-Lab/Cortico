import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionManager, loadExtensions } from '../src/extensions.ts';
import { EXTENSION_API_VERSIONS } from '../src/extensions/manifest.ts';
import { extensionRuntimeState } from '../src/bot.ts';
import { loadDeployment } from '../src/deploy.ts';
import { CORE_DEFAULTS } from '../src/core/config.ts';
import { WorldAssembly, worldDefaults } from '../src/world.ts';
import type { WorldHost } from '../src/core/types.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'extension-removal-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function setup(enabled = false, failRemoval = false) {
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
  const booted = await loadExtensions(root);
  const source = { defaults: () => ({ ...structuredClone(CORE_DEFAULTS), worlds: worldDefaults(booted.worlds, []) }) };
  const loaded = loadDeployment(source, root, root);
  const assembly = new WorldAssembly(loaded, booted.worlds, []);
  assembly.bind({ mount: async world => { await world.start({} as WorldHost); assembly.mounted.push(world); }, unmount: async id => {
    const i = assembly.mounted.findIndex(world => world.id === id);
    await assembly.mounted[i].stop(); assembly.mounted.splice(i, 1);
  } });
  let gate: Promise<void> | undefined;
  const manager = new ExtensionManager(root, booted, {
    decorate: extensionRuntimeState(assembly, () => true),
    removeWorld: (id, remove, language) => assembly.removeDefinition(id, remove, language),
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
  await expect(manager.uninstall('fixture-world', 'en')).rejects.toThrow('in use');
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
  const rejected = expect(removing).rejects.toThrow();
  await activating; await rejected;
  expect(existsSync(pkg)).toBe(true);
  expect(assembly.mounted.map(world => world.id)).toEqual(['fixture']);
});
