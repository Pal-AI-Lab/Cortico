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
let temp: ReturnType<typeof makeTmpDir>;
beforeEach(() => temp = makeTmpDir()); afterEach(() => temp.cleanup());
function fixture() {
  const deployment = join(temp.dir, 'deployments', 'example'); mkdirSync(deployment, { recursive: true });
  const ext = join(temp.dir, 'extensions'); mkdirSync(ext);
  const cfg = makeCfg({ activeProvider: '', providers: { sample: { kind: 'extension-example', baseUrl: 'https://model.test' } } });
  const world: WorldDefinition = { id: 'sample-world', label: 'Sample', defaults: () => ({ enabled: false }), create: () => ({ id: 'sample-world', envPromptVars: () => ({}), tools: () => [], start: async () => {}, stop: async () => {} }) };
  const provider: ProviderModule = { id: 'extension-example', title: 'Example', reasoningTiers: [], serviceTiers: [], create: () => ({ client: { respond: async () => { throw new Error('unused'); } } }) };
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
it('migrates existing providers once and retains disabled policy after reconstruction', async () => {
  const f = fixture(); const first = f.service(); expect(f.registry.isModuleEnabled('extension-example')).toBe(true);
  await first.activate('example-provider', false); expect(() => f.registry.resolve('sample')).toThrow('未加载');
  const second = f.service(); expect(f.registry.isModuleEnabled('extension-example')).toBe(false);
  await second.activate('example-provider', true); expect(f.registry.resolve('sample')).toBeTruthy(); expect(f.cfg.activeProvider).toBe('');
});
it('blocks module unloading while the active model or a bound fork uses it', async () => {
  const f = fixture(); const service = f.service(); f.cfg.activeProvider = 'sample';
  await expect(service.activate('example-provider', false)).rejects.toThrow('使用'); f.cfg.activeProvider = '';
  const binding = f.registry.bind('sample'); await expect(service.activate('example-provider', false)).rejects.toThrow('使用');
  binding.release?.(); await service.activate('example-provider', false); expect(f.cfg.providers.sample.kind).toBe('extension-example');
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
