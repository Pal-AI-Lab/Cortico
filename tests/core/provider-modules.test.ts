import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BaseProvider, type ProviderHost, type ProviderModule } from '../../src/providers/base.ts';
import { discoverProviderModules, ProviderRegistry, providerModules } from '../../src/providers/registry.ts';
import { nullLogger } from '../../src/core/util.ts';

describe('Provider module discovery', () => {
  it('loads each native implementation through the common base and isolates deployment instances', () => {
    const entries = {
      first: { kind: 'openai-responses-compat', baseUrl: 'https://one.test' },
      second: { kind: 'openai-responses-compat', baseUrl: 'https://two.test', options: { preset: 'openrouter' } },
    };
    const registry = new ProviderRegistry(() => entries, {
      stateRoot: join(tmpdir(), 'unused-provider-state'), readBlob: () => null,
      keepThinking: () => true, log: nullLogger(),
    });
    for (const name of Object.keys(entries)) expect(registry.resolve(name).client).toBeInstanceOf(BaseProvider);
    expect(registry.resolve('first')).toBe(registry.resolve('first'));
    expect(registry.resolve('first')).not.toBe(registry.resolve('second'));
    expect(() => registry.resolve('missing')).toThrow('没有这个 LLM provider');
    expect(providerModules.map(module => module.id)).toEqual(['llamacpp', 'openai-responses-compat']);
  });

  it('discovers an added module by directory and rejects a mismatched namespace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortico-provider-discovery-'));
    try {
      mkdirSync(join(root, 'fixture'));
      writeFileSync(join(root, 'fixture', 'index.ts'), 'export default { id: "fixture", title: "Fixture", reasoningTiers: [], serviceTiers: [] };');
      expect((await discoverProviderModules(root)).map(module => module.id)).toEqual(['fixture']);
      mkdirSync(join(root, 'invalid'));
      writeFileSync(join(root, 'invalid', 'index.ts'), 'export default { id: "different" };');
      await expect(discoverProviderModules(root)).rejects.toThrow('must match directory');
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('端点拿到自己的目录,密钥链是 进程环境 > 端点 .env', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'cortico-provider-state-'));
    try {
      mkdirSync(join(stateRoot, 'cloud'));
      writeFileSync(join(stateRoot, 'cloud', '.env'), 'SHARED=from-endpoint\nONLY_HERE=yes\n');
      let seen: ProviderHost | null = null;
      const module: ProviderModule = {
        id: 'probe', title: 'Probe', reasoningTiers: [], serviceTiers: [],
        create: (_name, _entry, host) => { seen = host; return { client: { respond: async () => { throw new Error('unused'); } } }; },
      };
      new ProviderRegistry(
        () => ({ cloud: { kind: 'probe', baseUrl: 'https://probe.test' } }),
        { stateRoot, readBlob: () => null, keepThinking: () => true, log: nullLogger() },
        [module],
      ).resolve('cloud');

      const host = seen as unknown as ProviderHost;
      expect(host.stateDir).toBe(join(stateRoot, 'cloud'));
      expect(host.secret('ONLY_HERE')).toBe('yes');
      expect(host.secret('SHARED')).toBe('from-endpoint');
      expect(host.secret('MODULE_KEY')).toBe('');
      process.env.SHARED = 'from-process';
      try {
        expect(host.secret('SHARED')).toBe('from-process');
      } finally {
        delete process.env.SHARED;
      }
    } finally {
      rmSync(stateRoot, { recursive: true });
    }
  });
});
