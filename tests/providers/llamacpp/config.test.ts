import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CORE_DEFAULTS } from '../../../src/core/config.ts';
import type { CoreConfig } from '../../../src/core/types.ts';
import { nullLogger } from '../../../src/core/util.ts';
import { ProviderSettings } from '../../../src/providers/console/settings.ts';
import { ProviderRegistry } from '../../../src/providers/registry.ts';
import module from '../../../src/providers/llamacpp/index.ts';
import { LAUNCH_DEFAULTS } from '../../../src/providers/llamacpp/options.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('declared runtime fields validate and persist only the selected endpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-config-'));
  dirs.push(dir);
  const cfg: CoreConfig = structuredClone(CORE_DEFAULTS);
  const entry = module.normalize({
    kind: module.id, baseUrl: 'http://127.0.0.1:8090/v1',
    options: { runtime: { backend: 'cpu' } },
  });
  cfg.providers = { 'local.one': entry, other: structuredClone(entry) };
  cfg.activeProvider = 'local.one';
  const file = join(dir, 'config.json');
  writeFileSync(file, '{}');
  const providersDir = join(dir, 'providers');
  const registry = new ProviderRegistry(() => cfg.providers, {
    stateRoot: providersDir, readBlob: () => null, keepThinking: () => true, log: nullLogger(),
  }, [module]);
  const settings = new ProviderSettings(cfg, registry, file, providersDir, [module]);
  const path = 'providers.local.one.options.launch.parallel';
  const group = settings.groups().find((group) => path in group.schema.properties)!;
  expect(group).toBeDefined();
  expect(settings.values(group.id)[path]).toBe(LAUNCH_DEFAULTS.parallel);
  expect(() => settings.setConfig(group.id, { [path]: 0 })).toThrow();
  expect(settings.values(group.id)[path]).toBe(LAUNCH_DEFAULTS.parallel);
  settings.setConfig(group.id, { [path]: LAUNCH_DEFAULTS.parallel + 1 });
  const saved = JSON.parse(readFileSync(join(providersDir, 'local.one', 'config.json'), 'utf8'));
  expect(saved.options.launch.parallel).toBe(LAUNCH_DEFAULTS.parallel + 1);
  expect(cfg.providers.other).toEqual(entry);

  const runtimePath = 'providers.local.one.options.runtime.runtimeDir';
  const runtimeGroup = settings.groups().find((group) => runtimePath in group.schema.properties)!;
  settings.setConfig(runtimeGroup.id, { [runtimePath]: `  ${dir}  ` });
  expect(cfg.providers['local.one'].options?.runtime).toHaveProperty('runtimeDir', dir);
  settings.setConfig(runtimeGroup.id, { [runtimePath]: '' });
  expect(cfg.providers['local.one'].options?.runtime).not.toHaveProperty('runtimeDir');
});
