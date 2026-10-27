/**
 * 扩展页里随框架提供的条目:World 取装配里不来自扩展的定义,provider 取模块表里不来自扩展的那些;
 * 运行状态(enabled / hidden)由 extensionRuntimeState 补上。
 * 启动:一个 World 的 start() 抛错不影响 bot 与其余 World 启动。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinExtensions, createBot, deriveWorldFacts, extensionRuntimeState } from '../src/bot.ts';
import { CORE_DEFAULTS, type LoadedConfig } from '../src/core/config.ts';
import { loadDeployment } from '../src/deploy.ts';
import { WorldAssembly, worldDefaults, type WorldDefinition, type WorldSection } from '../src/world.ts';
import { providerModules } from '../src/providers/registry.ts';
import { repoRoot } from '../src/paths.ts';
import type { CoreConfig, World, WorldHost, WorldLifecycleEvent } from '../src/core/types.ts';
import type { Language } from '../src/core/language.ts';
import { CONSOLE } from '../src/worlds/console/definition.ts';
import { text as consoleText } from '../src/worlds/console/strings.ts';
import { FakeLLM, makeCfg, makeFakePersona } from './core/helpers.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bot-builtins-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function probe(id: string, create?: () => World): WorldDefinition<WorldSection> {
  return {
    id,
    label: `${id} probe`,
    defaults: () => ({ enabled: false }),
    create: create ?? (() => ({ id, envPromptVars: () => ({}), tools: () => [], start: async () => {}, stop: async () => {} })),
  };
}

it('assembled Worlds not supplied by an extension are listed: enabled when mounted, hidden when the agent cannot see them, failed with their reason', () => {
  const [running, parked, broken] = ['running', 'parked', 'broken'];
  const fromExtension = probe('from-extension');
  const defs = [probe(running), probe(parked), probe(broken, () => { throw new Error('probe construction failed'); }), fromExtension];
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ worlds: { [running]: { enabled: true } } }), 'utf8');
  const loaded = loadDeployment({ defaults: () => makeCfg({ worlds: worldDefaults(defs, []) } as never) }, dir, dir);
  const assembly = new WorldAssembly(loaded, defs, []);
  assembly.bind({ mount: async (world: World) => { await world.start({} as WorldHost); }, unmount: async () => {} });
  const set = { dir, records: [], worlds: [fromExtension], providers: [providerModules[0]], webUiAssets: [] };

  const decorate = extensionRuntimeState(assembly, (id) => id !== running);
  const entries = builtinExtensions(assembly, set, 'en').map((entry) => decorate(entry, 'en'));
  const worlds = entries.filter((entry) => entry.kind === 'world');
  expect(worlds.map((entry) => [entry.worldId, entry.state, entry.enabled, entry.hidden ?? false])).toEqual([
    [running, 'loaded', true, true], [parked, 'loaded', false, false], [broken, 'failed', false, false],
  ]);
  expect(worlds.find((entry) => entry.worldId === broken)?.reason).toContain('probe construction failed');
  const providers = entries.filter((entry) => entry.kind === 'provider');
  expect(providers.map((entry) => entry.worldId)).toEqual(providerModules.slice(1).map((module) => module.id));
  expect(providers.every((entry) => entry.enabled)).toBe(true);
  const version = (JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as { version: string }).version;
  for (const entry of entries) expect(entry).toMatchObject({ builtin: true, version, location: repoRoot(), name: `builtin:${entry.kind}:${entry.worldId}` });
});

it('World names follow the request language: the console World, a definition whose label getter changed after assembly, and the same World loaded from an extension', () => {
  let current = 'name at startup';
  const live: WorldDefinition<WorldSection> = { ...probe('live'), get label() { return current; } };
  const defs = [CONSOLE as unknown as WorldDefinition<WorldSection>, live];
  const loaded = loadDeployment({ defaults: () => makeCfg({ worlds: worldDefaults(defs, []) } as never) }, dir, dir);
  const assembly = new WorldAssembly(loaded, defs, []);
  current = 'name now';
  const set = { dir, records: [], worlds: [], providers: [], webUiAssets: [] };
  const labels = (language: Language) => Object.fromEntries(builtinExtensions(assembly, set, language)
    .filter((entry) => entry.kind === 'world').map((entry) => [entry.worldId, entry.label]));
  expect(labels('en')).toEqual({ console: consoleText('en').moduleLabel, live: 'name now' });
  expect(labels('pt-BR').console).toBe(consoleText('pt-BR').moduleLabel);
  const installed = { name: 'cortico-world-live', spec: '^1.0.0', version: '1.0.0', kind: 'world' as const, worldId: 'live', label: 'name at startup', webUiClient: false, loaded: true, state: 'loaded' as const };
  expect(extensionRuntimeState(assembly, () => true)(installed, 'en').label).toBe('name now');
});

it('removed entries are never enabled', () => {
  const loaded = loadDeployment({ defaults: () => makeCfg() }, dir, dir);
  const decorate = extensionRuntimeState(new WorldAssembly(loaded, [], []), () => true);
  const removed = { name: 'gone', spec: '^1.0.0', version: '1.0.0', kind: 'provider' as const, webUiClient: false, loaded: true, state: 'removed' as const };
  expect(decorate(removed, 'en').enabled).toBe(false);
});

it('a World whose start() throws at boot is left inactive with its reason and the Persona hears start-failed; the bot and the other Worlds start, enabled stays, a later activation clears the reason', async () => {
  let boom = true;
  const lifecycle: WorldLifecycleEvent[] = [];
  const bad = probe('bad', () => ({
    id: 'bad', envPromptVars: () => ({}), tools: () => [],
    start: async () => { if (boom) throw new Error('port 7797 in use'); }, stop: async () => {},
  }));
  const goodInstance = { id: 'good', envPromptVars: () => ({}), tools: () => [], started: 0, start: async () => { goodInstance.started++; }, stop: async () => {} };
  const good = probe('good', () => goodInstance);
  const worlds = { bad: { enabled: true }, good: { enabled: true } };
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ worlds }), 'utf8');
  const config = { ...CORE_DEFAULTS, worlds } as unknown as CoreConfig;
  const loaded: LoadedConfig<CoreConfig> = { config, secret: () => '', rootDir: dir, memoryDir: join(dir, 'memory'), dataDir: join(dir, 'data') };
  const app = createBot(loaded, {
    id: 'probe-bot',
    defaults: () => config,
    worlds: [bad, good],
    build: (_loaded, mounted) => {
      const persona = makeFakePersona([], { worlds: mounted });
      persona.onWorldLifecycle = (event) => { lifecycle.push(event); };
      return { persona, llm: new FakeLLM(), webUi: { enabled: false } };
    },
  });
  try {
    await app.start();
    expect(goodInstance.started).toBe(1);
    expect(lifecycle).toEqual([{ kind: 'start-failed', id: 'bad', label: 'bad probe', reason: 'port 7797 in use' }]);
    expect(app.assembly.mounted.map((world) => world.id)).toEqual(['good']);
    expect(deriveWorldFacts(app.core, app.assembly, 'en').find((facts) => facts.id === 'bad'))
      .toMatchObject({ status: 'inactive', reason: 'Start failed: port 7797 in use' });
    expect((JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { worlds: typeof worlds }).worlds.bad.enabled).toBe(true);

    boom = false;
    await app.assembly.activate('bad', 'en');
    expect(app.assembly.mounted.map((world) => world.id)).toEqual(['good', 'bad']);
    expect(deriveWorldFacts(app.core, app.assembly, 'en').find((facts) => facts.id === 'bad')).toMatchObject({ status: 'active' });
    expect(lifecycle.map((event) => event.kind)).toEqual(['start-failed', 'mounted']);
  } finally {
    await app.stop();
  }
});
