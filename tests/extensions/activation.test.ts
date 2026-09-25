import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCfg, makeLoaded, makeTmpDir } from '../core/helpers.ts';
import { nullLogger } from '../../src/core/util.ts';
import { WorldAssembly, type WorldDefinition } from '../../src/world.ts';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import type { ProviderModule } from '../../src/providers/base.ts';
import { ExtensionActivation } from '../../src/extensions/activation.ts';
import type { ExtensionSet } from '../../src/extensions.ts';
import { EXTENSION_API_VERSIONS } from '../../src/extensions/manifest.ts';
import { installFixture } from '../fixtures/extensions/install.ts';
let temp: ReturnType<typeof makeTmpDir>;
beforeEach(() => temp = makeTmpDir()); afterEach(() => temp.cleanup());
function fixture(initiallyEnabled = false) {
  const deployment = join(temp.dir, 'deployments', 'example'); mkdirSync(deployment, { recursive: true });
  const ext = join(temp.dir, 'extensions'); mkdirSync(ext);
  const cfg = makeCfg({ activeProvider: '', providers: { sample: { kind: 'extension-example', baseUrl: 'https://model.test' } } });
  const world: WorldDefinition = { id: 'sample-world', label: 'Sample', defaults: () => ({ enabled: false }), create: () => ({ id: 'sample-world', envPromptVars: () => ({}), tools: () => [], start: async () => {}, stop: async () => {} }) };
  const provider: ProviderModule = { id: 'extension-example', title: 'Example', reasoningTiers: [], serviceTiers: [], create: () => ({ client: { respond: async () => { throw new Error('unused'); } } }) };
  (cfg as unknown as { worlds: Record<string, unknown> }).worlds = { 'sample-world': { enabled: initiallyEnabled } };
  const loaded = makeLoaded({ config: cfg, rootDir: deployment, dataDir: join(deployment, 'data'), memoryDir: join(deployment, 'memory') });
  const assembly = new WorldAssembly(loaded, [world], []); assembly.bind({ mount: async mod => { await mod.start({} as never); }, unmount: async id => { await assembly.slot(id).instance.stop(); } });
  const registry = new ProviderRegistry(() => cfg.providers, { stateRoot: join(temp.dir, 'providers'), readBlob: () => null, keepThinking: () => true, log: nullLogger() }, [provider]);
  const booted: ExtensionSet = { dir: ext, providers: [provider], worlds: [world], consoleAssets: [], records: [
    { name: 'example-world', spec: '1.0.0', version: '1.0.0', kind: 'world', worldId: world.id, loaded: true, consoleClient: false },
    { name: 'example-provider', spec: '1.0.0', version: '1.0.0', kind: 'provider', worldId: provider.id, loaded: true, consoleClient: false },
  ] };
  writeFileSync(join(ext, 'package.json'), JSON.stringify({ dependencies: { 'example-world': '1.0.0', 'example-provider': '1.0.0' } }));
  for (const record of booted.records) { const dir = join(ext, 'node_modules', record.name); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: record.name, version: record.version, type: 'module', cortico: { kind: record.kind, api: EXTENSION_API_VERSIONS[record.kind!] } })); }
  const service = () => new ExtensionActivation(deployment, temp.dir, booted, cfg, assembly, registry, join(temp.dir, 'providers'));
  return { service, registry, cfg, assembly, deployment, booted };
}
it('migrates disabled provider policies to automatic registration while preserving World intents', async () => {
  const f = fixture(); const file = join(f.deployment, 'extension-state.json');
  const worldIntent = { name: 'example-world', version: '1.0.0', moduleId: 'sample-world' };
  writeFileSync(file, JSON.stringify({ providers: { 'extension-example': false }, pending: [worldIntent, { name: 'example-provider', version: '1.0.0', moduleId: 'extension-example' }], errors: {} }));
  const service = f.service();
  expect(f.registry.resolve('sample')).toBeTruthy();
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pending: [worldIntent], errors: {} });
  await expect(service.activate('example-provider', false)).rejects.toThrow('自动注册');
  expect(f.cfg.activeProvider).toBe('');
});
it('protects provider deletion while the active model or a bound fork uses it', async () => {
  const f = fixture(); const service = f.service(); f.cfg.activeProvider = 'sample';
  expect(service.references('example-provider')).toContain(f.deployment); f.cfg.activeProvider = '';
  const binding = f.registry.bind('sample'); expect(service.references('example-provider')).toContain(f.deployment);
  binding.release?.(); expect(service.references('example-provider')).not.toContain(f.deployment);
});
it('registers newly installed shared providers without restarting the registry', async () => {
  const f = fixture(); const service = f.service();
  const preview = f.registry.previewRegistry('newEndpoint', { kind: 'fixture-provider', baseUrl: 'https://model.test' });
  installFixture(temp.dir, 'provider-ok');
  await service.manager.refresh?.();
  expect(service.manager.list().extensions.find(item => item.name === 'provider-ok')).toMatchObject({ loaded: true, enabled: true });
  f.cfg.providers.newEndpoint = { kind: 'fixture-provider', baseUrl: 'https://model.test' };
  expect(f.registry.resolve('newEndpoint').client).toBeTruthy();
  expect(preview.resolve('newEndpoint').client).toBeTruthy();
  await service.manager.refresh?.();
  expect(f.registry.definitions.filter(module => module.id === 'fixture-provider')).toHaveLength(1);
  await f.registry.unregisterModule('fixture-provider');
  expect(() => f.registry.resolve('newEndpoint')).toThrow();
  expect(() => preview.resolve('newEndpoint')).toThrow();
});
it('waits for real World activation and persists local enabled state', async () => {
  const f = fixture(); const service = f.service(); await service.activate('example-world', true);
  expect(f.assembly.slot('sample-world').mounted).toBe(true); expect(service.manager.list().extensions[0].enabled).toBe(true);
  await service.activate('example-world', false); expect(f.assembly.slot('sample-world').mounted).toBe(false);
  expect(JSON.parse(readFileSync(join(f.deployment, 'config.json'), 'utf8')).worlds['sample-world'].enabled).toBe(false);
});
it('failed World startup stays disabled and exposes a diagnostic result', async () => {
  const f = fixture(); f.assembly.bind({ mount: async () => { throw new Error('start failed'); }, unmount: async () => {} });
  const service = f.service(); await expect(service.activate('example-world', true)).rejects.toThrow('start failed');
  expect(service.manager.list().extensions[0]).toMatchObject({ enabled: false, activationError: 'Error: start failed' });
});
it('shared provider configurations block package deletion without deleting configuration', () => {
  const f = fixture(); const service = f.service(); writeFileSync(join(f.deployment, 'deployment.json'), JSON.stringify({ bot: 'sample' })); writeFileSync(join(f.deployment, 'config.json'), JSON.stringify({ providers: f.cfg.providers }));
  expect(service.references('example-provider')).toContain(join(f.deployment, 'config.json'));
});

it('lists built-in modules from the current assembly and prevents package deletion', async () => {
  const f = fixture(); f.booted.worlds = []; f.booted.providers = []; f.booted.records = [];
  const service = f.service();
  expect(service.manager.list().extensions.find(item => item.name === 'builtin:world:sample-world')).toMatchObject({ builtin: true, enabled: false, label: 'Sample' });
  await service.activate('builtin:world:sample-world', true);
  expect(service.manager.list().extensions.find(item => item.name === 'builtin:world:sample-world')?.enabled).toBe(true);
  await expect(service.manager.perform('delete-builtin-world', 'delete', { name: 'builtin:world:sample-world' })).rejects.toThrow('不能单独');
  await expect(service.activate('builtin:provider:extension-example', false)).rejects.toThrow('自动注册');
  expect(f.registry.resolve('sample')).toBeTruthy();
});
it('can stop the running World version after its installed version changes', async () => {
  const f = fixture(); const service = f.service(); await service.activate('example-world', true);
  writeFileSync(join(f.booted.dir, 'node_modules', 'example-world', 'package.json'), JSON.stringify({ name: 'example-world', version: '2.0.0' }));
  expect(service.manager.list().extensions[0]).toMatchObject({ enabled: true, state: 'pending-restart' });
  await service.activate('example-world', false); expect(f.assembly.slot('sample-world').mounted).toBe(false);
});

it('reflects deployment startup configuration rather than assuming all built-ins are active', () => {
  const f = fixture(true); f.booted.worlds = []; f.booted.records = [];
  expect(f.service().manager.list().extensions.find(item => item.name === 'builtin:world:sample-world')?.enabled).toBe(true);
});
