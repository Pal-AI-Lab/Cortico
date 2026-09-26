/**
 * 扩展页里随框架提供的条目:World 取本进程的装配,provider 取模块表里不来自扩展的那些;
 * 运行状态(enabled / hidden)由 extensionRuntimeState 补上。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinExtensions, extensionRuntimeState } from '../src/bot.ts';
import { loadDeployment } from '../src/deploy.ts';
import { WorldAssembly, worldDefaults, type WorldDefinition, type WorldSection } from '../src/world.ts';
import { BUILTIN_WORLDS } from '../src/worlds/index.ts';
import { providerModules } from '../src/providers/registry.ts';
import { repoRoot } from '../src/paths.ts';
import type { World, WorldHost } from '../src/core/types.ts';
import { makeCfg } from './core/helpers.ts';

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

it('builtin Worlds are enabled when mounted and hidden when the agent cannot see them; failed constructions carry their reason', () => {
  const [running, parked, broken] = BUILTIN_WORLDS.map((world) => world.id);
  const defs = [probe(running), probe(parked), probe(broken, () => { throw new Error('probe construction failed'); }), probe('not-builtin')];
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ worlds: { [running]: { enabled: true } } }), 'utf8');
  const loaded = loadDeployment({ defaults: () => makeCfg({ worlds: worldDefaults(defs, []) } as never) }, dir, dir);
  const assembly = new WorldAssembly(loaded, defs, []);
  assembly.bind({ mount: async (world: World) => { await world.start({} as WorldHost); }, unmount: async () => {} });
  const set = { dir, records: [], worlds: [], providers: [providerModules[0]], consoleAssets: [] };

  const entries = builtinExtensions(assembly, set, 'en').map(extensionRuntimeState(assembly, (id) => id !== running));
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

it('removed entries are never enabled', () => {
  const loaded = loadDeployment({ defaults: () => makeCfg() }, dir, dir);
  const decorate = extensionRuntimeState(new WorldAssembly(loaded, [], []), () => true);
  const removed = { name: 'gone', spec: '^1.0.0', version: '1.0.0', kind: 'provider' as const, consoleClient: false, loaded: true, state: 'removed' as const };
  expect(decorate(removed).enabled).toBe(false);
});
