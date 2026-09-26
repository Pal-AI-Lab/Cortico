/** 扩展页里随框架提供的条目:World 取本进程的装配,provider 取模块表里不来自扩展的那些。 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinExtensions } from '../src/bot.ts';
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

it('builtin Worlds carry this process\'s mount state; failed constructions carry their reason; other Worlds are not listed', async () => {
  const [running, parked, broken] = BUILTIN_WORLDS.map((world) => world.id);
  const defs = [probe(running), probe(parked), probe(broken, () => { throw new Error('probe construction failed'); }), probe('not-builtin')];
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ worlds: { [running]: { enabled: true } } }), 'utf8');
  const loaded = loadDeployment({ defaults: () => makeCfg({ worlds: worldDefaults(defs, []) } as never) }, dir, dir);
  const assembly = new WorldAssembly(loaded, defs, []);
  await assembly.bind({ mount: async (world: World) => { await world.start({} as WorldHost); }, unmount: async () => {} });
  const set = { dir, records: [], worlds: [], providers: [providerModules[0]], consoleAssets: [] };

  const entries = builtinExtensions(assembly, set, 'en');
  const worlds = entries.filter((entry) => entry.kind === 'world');
  expect(worlds.map((entry) => [entry.worldId, entry.state, entry.mounted])).toEqual([
    [running, 'loaded', true], [parked, 'loaded', false], [broken, 'failed', undefined],
  ]);
  expect(worlds.find((entry) => entry.worldId === broken)?.reason).toContain('probe construction failed');
  expect(entries.filter((entry) => entry.kind === 'provider').map((entry) => entry.worldId)).toEqual(providerModules.slice(1).map((module) => module.id));
  const version = (JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as { version: string }).version;
  for (const entry of entries) expect(entry).toMatchObject({ builtin: true, version, name: `builtin:${entry.kind}:${entry.worldId}` });
});
