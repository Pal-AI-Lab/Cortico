/** 部署配置的默认值归属、覆盖顺序、World 配置与密钥读取。 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeployment } from '../../src/deploy.ts';
import { CORE_DEFAULTS } from '../../src/core/config.ts';
import { composeDefaults, loadConfig } from '../../bots/corti-soulmate/assemble.ts';
import { PERSONA_DEFAULTS } from '../../bots/corti-soulmate/persona/config.ts';
import { VISION_DEFAULTS } from '../../src/worlds/qq/vision.ts';

function withConfig(json: unknown): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bot-cfgtest-'));
  if (json !== undefined) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(json), 'utf8');
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("部署配置合并与默认值归属", () => {
  it("Core 默认配置不包含 Persona 参数", () => {
    expect(CORE_DEFAULTS.batching).toHaveProperty('quietGapMs');
    expect(CORE_DEFAULTS.context.keepPastThinking).toBe(true);
    // Persona 的阶段预算、轮数和作息不属于 Core 默认值。
    for (const key of ['models', 'loop', 'memo', 'tick', 'dream']) {
      expect(CORE_DEFAULTS, `core 不该持有 ${key}`).not.toHaveProperty(key);
    }
  });

  it('composeDefaults 把三方的默认值合到一起,来源可追', () => {
    const cfg = composeDefaults();
    expect(cfg.batching).toEqual(CORE_DEFAULTS.batching);
    // Persona 可提供自有参数及 Core 参数的建议值。
    expect(PERSONA_DEFAULTS).not.toHaveProperty('models');
    expect(cfg.providers).toEqual(CORE_DEFAULTS.providers);
    expect(cfg.activeProvider).toBe(CORE_DEFAULTS.activeProvider);
    expect(cfg.memo).toEqual(PERSONA_DEFAULTS.memo);
    expect(cfg.context.maxTokens).toBe(PERSONA_DEFAULTS.context.maxTokens);
    // Persona 设置阶段预算，模型容量由 provider 配置决定。
    expect(cfg.context.keepPastThinking).toBe(CORE_DEFAULTS.context.keepPastThinking);
    // Vision 默认值属于 QQ World，不是顶层配置段。
    expect(cfg.worlds.qq.vision).toEqual(VISION_DEFAULTS);
    expect(cfg.worlds.websearch.enabled).toBe(true);
  });

  it("部署 config.json 覆盖 Persona 建议值", () => {
    const { dir, cleanup } = withConfig({ context: { maxTokens: 32000 }, memo: { residentCap: 3 } });
    try {
      const { config } = loadConfig(dir);
      expect(config.context.maxTokens).toBe(32000);
      expect(config.memo.residentCap).toBe(3);
      expect(config.context.keepRatio).toBe(PERSONA_DEFAULTS.context.keepRatio);
    } finally { cleanup(); }
  });

  it('密钥按名字取:进程环境优先,其次 .env(core 不认识具体名字)', () => {
    const { dir, cleanup } = withConfig(undefined);
    try {
      writeFileSync(join(dir, '.env'), 'SOME_MODULE_KEY=from-file\n', 'utf8');
      const loaded = loadConfig(dir);
      expect(loaded.secret('SOME_MODULE_KEY')).toBe('from-file');
      expect(loaded.secret('从没配过的名字')).toBe('');
      process.env.SOME_MODULE_KEY = 'from-env';
      try {
        expect(loadConfig(dir).secret('SOME_MODULE_KEY')).toBe('from-env');
      } finally {
        delete process.env.SOME_MODULE_KEY;
      }
    } finally { cleanup(); }
  });

  it("密钥使用进程环境或部署 .env，不读取仓库根 .env", () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-reporoot-'));
    const botDir = join(root, 'bots', 'x');
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(root, '.env'), 'SHARED_KEY=from-repo-root\n', 'utf8');
    try {
      expect(loadDeployment({ defaults: composeDefaults }, botDir, root).secret('SHARED_KEY')).toBe('');
      writeFileSync(join(botDir, '.env'), 'SHARED_KEY=from-bot-dir\n', 'utf8');
      expect(loadDeployment({ defaults: composeDefaults }, botDir, root).secret('SHARED_KEY')).toBe('from-bot-dir');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('loadConfig:worlds.qq.groups/privates', () => {
  it('无config.json → 默认空roster', () => {
    const { dir, cleanup } = withConfig(undefined);
    try {
      const { config } = loadConfig(dir);
      expect(config.worlds.qq.groups).toEqual([]);
      expect(config.worlds.qq.privates).toEqual([]);
    } finally { cleanup(); }
  });

  it('config.json 写的{id,enabled}[]整段替换默认空roster(含disabled条目)', () => {
    const { dir, cleanup } = withConfig({
      worlds: { qq: { groups: [{ id: 111, enabled: false }, { id: 222, enabled: true }], privates: [{ id: 333, enabled: true }] } },
    });
    try {
      const { config } = loadConfig(dir);
      expect(config.worlds.qq.groups).toEqual([{ id: 111, enabled: false }, { id: 222, enabled: true }]);
      expect(config.worlds.qq.privates).toEqual([{ id: 333, enabled: true }]);
    } finally { cleanup(); }
  });

  it('每次加载都拿到独立配置树,不会把运行时热改泄漏进默认值', () => {
    const first = withConfig({ worlds: { qq: { groups: [{ id: 555, enabled: true }] } } });
    const second = withConfig(undefined);
    try {
      const loaded = loadConfig(first.dir).config;
      expect(loaded.worlds.qq.groups).toEqual([{ id: 555, enabled: true }]);
      loaded.context.maxTokens = 42;
      loaded.providers.fixture = { kind: 'openai-responses-compat', baseUrl: 'https://changed.test' };

      const fresh = loadConfig(second.dir).config;
      expect(fresh.worlds.qq.groups).toEqual([]);
      expect(fresh.context.maxTokens).toBe(PERSONA_DEFAULTS.context.maxTokens);
      expect(fresh.providers).toEqual(CORE_DEFAULTS.providers);
      expect(composeDefaults().worlds.qq.groups).toEqual([]);
      expect(composeDefaults().context.maxTokens).toBe(PERSONA_DEFAULTS.context.maxTokens);
      expect(composeDefaults().providers).toEqual(CORE_DEFAULTS.providers);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });
});
