/**
 * 端点可用性:通用条件(选了模型、声明的密钥读得到)由框架查,模块只补自己的本地条件。
 * 汇总灯回答的是「这些端点里有没有一个能用」。
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeCfg, makeTmpDir } from './helpers.ts';
import { nullLogger } from '../../src/core/util.ts';
import { endpointAvailability } from '../../src/providers/configuration.ts';
import { ProviderSettings } from '../../src/providers/console/settings.ts';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import type { ProviderModule } from '../../src/providers/base.ts';
import type { LLMProviderEntry } from '../../src/core/types.ts';

const KIND = 'fixture-llm';

function moduleWith(availability?: ProviderModule['availability']): ProviderModule {
  return {
    id: KIND,
    title: 'Fixture LLM',
    reasoningTiers: [],
    serviceTiers: [],
    ...(availability ? { availability } : {}),
    create: () => ({ client: null as never }),
  };
}

function entry(patch: Partial<LLMProviderEntry> = {}): LLMProviderEntry {
  return {
    kind: KIND,
    baseUrl: 'https://provider.test',
    spec: { model: 'fixture-pro', thinking: false },
    ...patch,
  };
}

describe('endpointAvailability', () => {
  it('没选模型就不可用,模块不被问', () => {
    const asked: string[] = [];
    const module = moduleWith((name) => { asked.push(name); return { ready: true }; });
    const out = endpointAvailability(module, 'primary', entry({ spec: undefined }), true);
    expect(out.ready).toBe(false);
    expect(out.reason).toContain('模型');
    expect(asked).toEqual([]);
  });

  it('声明了密钥但读不到就不可用,原因里带变量名', () => {
    const out = endpointAvailability(moduleWith(), 'primary', entry({ secret: 'FIXTURE_KEY' }), false);
    expect(out.ready).toBe(false);
    expect(out.reason).toContain('FIXTURE_KEY');
  });

  it('通用条件齐了就听模块的', () => {
    const module = moduleWith(() => ({ ready: false, reason: '运行时还没装好' }));
    expect(endpointAvailability(module, 'primary', entry(), true)).toEqual({
      ready: false,
      reason: '运行时还没装好',
    });
  });

  it('模块没有别的条件时,通用条件齐了就可用', () => {
    expect(endpointAvailability(moduleWith(), 'primary', entry(), true)).toEqual({ ready: true });
  });
});

/** 一份只有 fixture 模块的设置面,端点按给定的 entry 表装。 */
function settingsWith(
  providers: Record<string, LLMProviderEntry>,
  module: ProviderModule = moduleWith(),
): { settings: ProviderSettings; providersDir: string; cleanup: () => void } {
  const temp = makeTmpDir();
  const cfg = makeCfg();
  cfg.providers = providers;
  cfg.activeProvider = Object.keys(providers)[0] ?? '';
  const providersDir = join(temp.dir, 'providers');
  const modules = [module];
  const settings = new ProviderSettings(
    cfg,
    new ProviderRegistry(() => cfg.providers, {
      stateRoot: providersDir,
      readBlob: () => null,
      keepThinking: () => true,
      log: nullLogger(),
    }, modules),
    join(temp.dir, 'config.json'),
    providersDir,
    modules,
  );
  return { settings, providersDir, cleanup: temp.cleanup };
}

describe('ProviderSettings.providersLamp', () => {
  it('一个端点都没有:灯灭', () => {
    const { settings, cleanup } = settingsWith({});
    expect(settings.providersLamp('zh').state).toBe('offline');
    cleanup();
  });

  it('端点缺密钥:灯灭,悬停说明带上是哪个端点缺什么', () => {
    const { settings, cleanup } = settingsWith({ primary: entry({ secret: 'FIXTURE_KEY' }) });
    const lamp = settings.providersLamp('zh');
    expect(lamp.state).toBe('offline');
    expect(lamp.hint).toContain('primary');
    expect(lamp.hint).toContain('FIXTURE_KEY');
    cleanup();
  });

  it('密钥写进端点 .env 后灯亮', () => {
    const { settings, providersDir, cleanup } = settingsWith({ primary: entry({ secret: 'FIXTURE_KEY' }) });
    mkdirSync(join(providersDir, 'primary'), { recursive: true });
    writeFileSync(join(providersDir, 'primary', '.env'), 'FIXTURE_KEY=sk-test\n', 'utf8');
    const lamp = settings.providersLamp('zh');
    expect(lamp.state).toBe('online');
    expect(lamp.hint).toContain('primary');
    cleanup();
  });

  it('一个端点可用就够了,不要求每个都可用', () => {
    const { settings, cleanup } = settingsWith({
      broken: entry({ spec: undefined }),
      good: entry(),
    });
    expect(settings.providersLamp('zh').state).toBe('online');
    cleanup();
  });
});
