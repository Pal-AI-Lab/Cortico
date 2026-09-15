/**
 * 在临时部署中检查扩展构造和声明接口，不调用 start()。
 * 使用内建 World、provider、bot 定义及测试专用定义。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectToolNames, dryMountBot, dryMountProvider, dryMountWorld, fakeWorldContext } from '../../src/extensions/dry-mount.ts';
import { BUILTIN_WORLDS } from '../../src/worlds/index.ts';
import { providerModules } from '../../src/providers/registry.ts';
import { RESERVED_FRAME_NAMES } from '../../src/core/loop.ts';
import { CORE_DEFAULTS } from '../../src/core/config.ts';
import cormini from '../../bots/cormini/index.ts';
import type { BotDefinition } from '../../src/bot.ts';
import type { WorldDefinition, WorldSection } from '../../src/world.ts';
import type { CoreConfig, ToolDef, World } from '../../src/core/types.ts';
import type { ProviderModule } from '../../src/providers/base.ts';

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'dry-mount-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

const tool = (name: string, extra: Partial<ToolDef> = {}): ToolDef => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  tags: ['read'],
  handler: async () => 'ok',
  ...extra,
});

function worldDef(id: string, tools: ToolDef[], patch: Partial<World> = {}, defaults: WorldSection = { enabled: false }): WorldDefinition<WorldSection> {
  return {
    id,
    label: `${id} 扩展`,
    defaults: () => ({ ...defaults }),
    create: () => ({ id, envPromptVars: () => ({}), tools: () => tools, start: async () => {}, stop: async () => {}, ...patch }),
  };
}

describe("World 构造检查", () => {
  it('合格的定义:没有失败,工具列出来', async () => {
    const report = await dryMountWorld(worldDef('alpha', [tool('alpha_ping')]), { scratchDir });
    expect(report.failures).toEqual([]);
    expect(report.ok.join('\n')).toContain('alpha_ping');
  });

  it('假上下文:默认配置、无密钥、persist 写进活配置', () => {
    const ctx = fakeWorldContext(worldDef('alpha', []), { scratchDir });
    expect(ctx.timezone).toBe(CORE_DEFAULTS.timezone);
    expect(ctx.secret('ANY')).toBe('');
    ctx.persist({ enabled: true });
    expect(ctx.cfg.enabled).toBe(true);
  });

  it('create() 抛错是失败:装配层对每个定义都调它', async () => {
    const def = worldDef('alpha', []);
    def.create = () => { throw new Error('需要密钥'); };
    const report = await dryMountWorld(def, { scratchDir });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('create()');
    expect(report.failures[0]).toContain('需要密钥');
  });

  it('实例 id 与定义 id 不同是失败', async () => {
    const report = await dryMountWorld(worldDef('alpha', [], { id: 'beta' }), { scratchDir });
    expect(report.failures.join('\n')).toContain('「beta」');
  });

  it('保留帧名、撞名、重名都是失败,理由点名占用者', async () => {
    const reserved = [...RESERVED_FRAME_NAMES][0];
    const tools = [tool(reserved), tool('web_search'), tool('alpha_x'), tool('alpha_x')];
    const report = await dryMountWorld(worldDef('alpha', tools), {
      scratchDir,
      takenToolNames: new Map([['web_search', 'WebSearch']]),
    });
    const text = report.failures.join('\n');
    expect(text).toContain(`「${reserved}」`);
    expect(text).toContain('WebSearch');
    expect(text).toContain('重复: alpha_x');
  });

  it('空 tags 与没有前缀只是警告', async () => {
    const report = await dryMountWorld(worldDef('alpha', [tool('ping', { tags: [] })]), { scratchDir });
    expect(report.failures).toEqual([]);
    expect(report.warnings.join('\n')).toContain('tags 为空');
    expect(report.warnings.join('\n')).toContain('没有前缀');
  });

  it('声明了面板但 manifest 没有浏览器端产物是警告;有产物就不警告', async () => {
    const def = worldDef('alpha', [], { console: () => ({ panels: [{ id: 'main', title: '主' }] }) });
    const without = await dryMountWorld(def, { scratchDir });
    expect(without.warnings.join('\n')).toContain('consoleClient');
    const withClient = await dryMountWorld(def, { scratchDir, hasConsoleClient: true });
    expect(withClient.warnings).toEqual([]);
  });

  it('面板 id 不合形状是失败', async () => {
    const def = worldDef('alpha', [], { console: () => ({ panels: [{ id: 'Main Panel', title: '主' }] }) });
    const report = await dryMountWorld(def, { scratchDir, hasConsoleClient: true });
    expect(report.failures.join('\n')).toContain('「Main Panel」');
  });

  it('defaults().enabled 不是 false 是警告', async () => {
    const report = await dryMountWorld(worldDef('alpha', [], {}, { enabled: true }), { scratchDir });
    expect(report.failures).toEqual([]);
    expect(report.warnings.join('\n')).toContain('enabled');
  });

  it('内建 World 全部在假环境下构造得出来,工具名可供对照', () => {
    const { taken, skipped } = collectToolNames(BUILTIN_WORLDS, { scratchDir });
    expect(skipped).toEqual([]);
    expect(taken.get('web_search')).toBe('WebSearch');
  });
});

describe("Provider 构造检查", () => {
  const module = (patch: Partial<ProviderModule> = {}): ProviderModule => ({
    id: 'fixture',
    title: '夹具端点',
    reasoningTiers: [],
    serviceTiers: [],
    create: () => ({ client: { respond: async () => { throw new Error("构造检查不调用模型"); } } }),
    ...patch,
  });

  it('合格的模块:没有失败', () => {
    expect(dryMountProvider(module(), { scratchDir }).failures).toEqual([]);
  });

  it('内建的两个模块都过', () => {
    for (const mod of providerModules) {
      expect(dryMountProvider(mod, { scratchDir }).failures, mod.id).toEqual([]);
    }
  });

  it('实例没有 client.respond() 是失败', () => {
    const report = dryMountProvider(module({ create: () => ({}) as never }), { scratchDir });
    expect(report.failures.join('\n')).toContain('client.respond()');
  });

  it('档位表缺 id 或 label 是失败', () => {
    const report = dryMountProvider(module({ reasoningTiers: [{ label: '低' } as never] }), { scratchDir });
    expect(report.failures.join('\n')).toContain('reasoningTiers');
  });

  it('create() 在假端点条目下抛错只是警告', () => {
    const report = dryMountProvider(module({ create: () => { throw new Error('要 token'); } }), { scratchDir });
    expect(report.failures).toEqual([]);
    expect(report.warnings.join('\n')).toContain('要 token');
  });
});

describe("Bot 构造检查", () => {
  const packageDir = resolve(import.meta.dirname, '../../bots/cormini');

  it('cormini 在假部署下 build() 得出来,契约必填项都在', () => {
    const report = dryMountBot(cormini as unknown as BotDefinition<CoreConfig>, { scratchDir, packageDir });
    expect(report.failures).toEqual([]);
    expect(report.ok.join('\n')).toContain('declares: terminal');
    expect(report.warnings.join('\n')).not.toContain('memoryName');
  });

  it('persona 缺必填项是失败', () => {
    const def: BotDefinition<CoreConfig> = {
      id: 'x',
      defaults: () => ({ ...CORE_DEFAULTS }),
      build: () => ({ persona: { systemSegments: async () => [], attach: () => {}, memoryDir: '/m', blobs: { put: () => '', get: () => null, list: () => [] } } as never }),
    };
    const report = dryMountBot(def, { scratchDir, packageDir: scratchDir });
    expect(report.failures.join('\n')).toContain('declareSessions()');
    expect(report.warnings.join('\n')).toContain('memoryName');
  });

  it('declares 不合形状是失败', () => {
    const def: BotDefinition<CoreConfig> = {
      id: 'x',
      declares: [{ id: 'q' } as never],
      defaults: () => ({ ...CORE_DEFAULTS }),
      build: () => { throw new Error('走不到'); },
    };
    const report = dryMountBot(def, { scratchDir, packageDir: scratchDir });
    expect(report.failures.join('\n')).toContain('declares');
  });
});
