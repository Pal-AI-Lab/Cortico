/**
 * 仓内 World、provider 与 bot 都带自描述,且实例真拿出来的工具都在声明里:挡的是加了工具忘了写进
 * describe。World 的声明还要等于各可达配置下工具名的并集,删了工具忘了从声明里摘也会红。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BotDefinition } from '../src/bot.ts';
import type { CoreConfig } from '../src/core/types.ts';
import { loadDeployment } from '../src/deploy.ts';
import { providerModules } from '../src/providers/registry.ts';
import { withWorlds, type WorldContext, type WorldDefinition, type WorldSection } from '../src/world.ts';
import { loadBuiltinWorlds } from '../src/worlds/index.ts';
import type { QQConfigSection } from '../src/worlds/qq/config.ts';

const REPO = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'builtin-describe-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** 默认配置之外、会改变工具表的配置。密钥一律给非空值,按密钥开关的工具也算可达。 */
const VARIANTS: Record<string, Array<(cfg: WorldSection) => void>> = {
  qq: [(cfg) => { (cfg as QQConfigSection).vision.enabled = true; }],
};

function context(def: WorldDefinition<WorldSection>, cfg: WorldSection): WorldContext<WorldSection> {
  const dir = tempDir();
  return {
    id: def.id,
    cfg,
    timezone: 'UTC',
    botName: 'bot',
    botDir: dir,
    packageDir: dir,
    dataDir: dir,
    repoRoot: REPO,
    secret: () => 'configured',
    storeSecret: () => {},
    persist: () => {},
    restart: async () => {},
  };
}

const worlds = await loadBuiltinWorlds();

describe('仓内 World 的自描述', () => {
  it.each(worlds.map((def) => [def.id, def] as const))('%s:声明的工具等于各可达配置下工具名的并集', (_id, def) => {
    expect(def.describe).toBeDefined();
    const declared = def.describe!.tools.map((t) => t.name);
    const seen = new Set<string>();
    for (const tweak of [() => {}, ...(VARIANTS[def.id] ?? [])]) {
      const cfg = { ...def.defaults(), enabled: true };
      tweak(cfg);
      for (const tool of def.create(context(def, cfg)).tools()) seen.add(tool.name);
    }
    expect([...seen].sort()).toEqual([...declared].sort());
    for (const tool of def.describe!.tools) expect(tool.summary, tool.name).toBeDefined();
  });
});

describe('仓内 provider 的自描述', () => {
  it.each(providerModules.map((m) => [m.id, m] as const))('%s:带 describe', (_id, module) => {
    expect(module.describe).toBeDefined();
  });
});

const BOT_IDS = readdirSync(join(REPO, 'bots'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(REPO, 'bots', d.name, 'index.ts')))
  .map((d) => d.name);

describe('仓内 bot 的自描述', () => {
  it.each(BOT_IDS)('%s:Persona 各 session 的工具与自有工具名都在声明里', async (id) => {
    const href = pathToFileURL(join(REPO, 'bots', id, 'index.ts')).href;
    const def = (await import(href)).default as BotDefinition<CoreConfig>;
    expect(def.describe).toBeDefined();
    const declared = new Set(def.describe!.tools.map((t) => t.name));
    for (const tool of def.describe!.tools) expect(tool.summary, tool.name).toBeDefined();

    // 不挂 World:session 工具表里剩下的全是 Persona 自己的。
    const withNone = withWorlds(def, []);
    const { persona } = def.build(loadDeployment(withNone, tempDir(), REPO), []);
    const offered = new Set([
      ...persona.declareSessions().flatMap((s) => s.tools().map((t) => t.name)),
      ...(persona.ownToolNames?.() ?? []),
    ]);
    expect([...offered].filter((name) => !declared.has(name))).toEqual([]);
  });
});
