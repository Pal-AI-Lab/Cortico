/**
 * World 模板占位符、WebUI 变量声明与运行时取值保持一致。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envPromptDocOf, renderWorldEnvPrompt } from '../src/core/prefix.ts';
import { templateVarNames, unknownVarNames } from '../src/core/template.ts';
import type { World } from '../src/core/types.ts';
import { BilibiliWorld } from '../src/worlds/bilibili/world.ts';
import { WebUiFixtureWorld } from '../src/worlds/webui-fixture/world.ts';
import { MinecraftWorld } from '../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from '../src/worlds/minecraft/config.ts';
import { QQWorld } from '../src/worlds/qq/world.ts';
import { ConsoleWorld } from '../src/worlds/console/world.ts';
import { WebSearchWorld } from '../src/worlds/websearch/world.ts';

const mcCfg = structuredClone({ ...MINECRAFT_DEFAULTS, enabled: true }) as MinecraftConfigSection;

/** 只构造 World，不启动外部连接。 */
const MODULES: Array<() => World> = [
  () => new BilibiliWorld({ roomId: 0 }),
  () => new WebUiFixtureWorld(),
  () => new MinecraftWorld({ cfg: mcCfg }),
  () => new QQWorld({ wsUrl: 'ws://127.0.0.1:1', groups: [], privates: [], token: '' }),
  () => new ConsoleWorld(),
  () => new WebSearchWorld({ apiKey: 'k' }),
];

describe('环境提示词模板契约', () => {
  it.each(MODULES.map((make) => [make().id, make] as const))(
    '%s:模板占位符、vars 声明与运行时值一致',
    async (_id, make) => {
      const mod = make();
      const doc = envPromptDocOf(mod);
      expect(doc, '每个 World 都该声明 role=envPrompt 的模板').toBeTruthy();

      const declared = (doc!.vars ?? []).map((v) => v.name).sort();
      const inTemplate = templateVarNames(readFileSync(doc!.path, 'utf8')).sort();
      const reported = Object.keys((await mod.envPromptVars()) ?? {}).sort();


      expect(inTemplate, '模板用到的占位符都要在 vars 里声明').toEqual(declared);

      expect(reported, 'vars 声明的占位符都要有运行时值').toEqual(declared);
    },
  );

  it.each(MODULES.map((make) => [make().id, make] as const))(
    '%s:渲染结果里不留没填上的占位符',
    async (_id, make) => {
      const { text } = await renderWorldEnvPrompt(make());
      expect(text).not.toMatch(/\{\{/);
    },
  );

  it('World 的 envPromptVars 返回 null 时省略该段且不读取模板', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nullprompt-'));
    const path = join(dir, 'ENV_PROMPT.md');
    const mod: World = {
      id: 'nullprompt',
      envPromptVars: () => null,
      webUi: () => ({
        promptDocs: [
          { key: 'worlds.nullprompt.envPrompt', title: 'nullprompt · 环境提示词', description: '测试模板', path, role: 'envPrompt' },
        ],
      }),
      tools: () => [],
      start: async () => {},
      stop: async () => {},
    };
    try {
      const out = await renderWorldEnvPrompt(mod);
      expect(out.text).toBe('');
      expect(out.sourceKey).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bot 侧环境提示词覆盖文件', () => {
  it('随源码发布的覆盖模板只使用所属 World 声明的占位符', () => {
    const root = resolve(import.meta.dirname, '..');
    const paths = execFileSync('git', ['ls-files', '-z', '--', 'bots/*/worlds/*/ENV_PROMPT.md'], {
      cwd: root, encoding: 'utf8',
    }).split('\0').filter(Boolean);
    const worlds = new Map(MODULES.map((make) => { const mod = make(); return [mod.id, mod]; }));
    for (const path of paths) {
      const id = path.split('/')[3];
      const mod = worlds.get(id);
      expect(mod, path).toBeDefined();
      const declared = (envPromptDocOf(mod!)!.vars ?? []).map((v) => v.name);
      expect(unknownVarNames(readFileSync(join(root, path), 'utf8'), declared), path).toEqual([]);
    }
  });
});
