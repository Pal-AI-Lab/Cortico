/** 验收最小人格定义的派生控制台,以及未安装 World 的控制台目录状态。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBot, type Bot } from '../../src/bot.ts';
import { loadDeployment } from '../../src/deploy.ts';
import { withWorlds, type WorldDefinition, type WorldSection } from '../../src/world.ts';
import { BUILTIN_WORLDS } from '../../src/worlds/index.ts';
import { FakeLLM } from '../core/helpers.ts';
import cormini, { type CorminiConfig } from '../../bots/cormini/index.ts';

/** 与启动器同一条线:仓内全部实现并进定义;多声明一个没有实现的 id,验收灰卡那条路。 */
const definition = withWorlds({ ...cormini, declares: [...(cormini.declares ?? []), 'phantom'] }, BUILTIN_WORLDS);

let dir: string;
let bot: Bot<CorminiConfig>;
let port: number;
/** bot 声明的固定提示词源文件(ORIENTATION 一类)由框架代办读写,这里用临时文件顶替 */
let orientationFile: string;
let dormantFile: string;

const getJ = async (path: string) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const postJ = async (path: string, body: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cormini-def-'));
  mkdirSync(join(dir, 'providers', 'fixture'), { recursive: true });
  writeFileSync(join(dir, 'providers', 'fixture', 'config.json'), JSON.stringify({ kind: 'openai-responses-compat', baseUrl: 'https://model.test', spec: { model: 'test-model', thinking: false } }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ activeProvider: 'fixture' }));
  const loaded = loadDeployment(definition, dir, resolve(import.meta.dirname, '../..'));
  loaded.config.web.port = 0;
  // cormini 自己声明的那份指向仓库里的源文件;测试改指临时文件,免得写坏它
  orientationFile = join(dir, 'ORIENTATION.md');
  writeFileSync(orientationFile, '第一版定向\n', 'utf8');
  dormantFile = join(dir, 'DORMANT_ENV_PROMPT.md');
  writeFileSync(dormantFile, '未激活 World 的环境提示词\n', 'utf8');
  // 有定义、部署侧没启用的 World:激活之前也该能改它的环境提示词,激活后热挂载。
  const dormant: WorldDefinition = {
    id: 'dormant',
    label: '未激活 World',
    defaults: () => ({ enabled: false }),
    create: () => ({
      id: 'dormant',
      envPromptVars: () => ({}),
      tools: () => [{
        name: 'dormant_ping',
        description: 'ping',
        usage: '* `dormant_ping()`',
        tags: [] as const,
        parameters: { type: 'object' as const, properties: {}, required: [] },
        handler: async () => 'pong',
      }],
      start: async () => {},
      stop: async () => {},
      console: () => ({
        promptDocs: [{
          key: 'worlds.dormant.envPrompt',
          title: '未激活 World · 环境提示词',
          description: '接入前就能改。',
          path: dormantFile,
          role: 'envPrompt' as const,
        }],
      }),
    }),
  };
  bot = createBot(loaded, {
    ...definition,
    worlds: [...(definition.worlds ?? []), dormant],
    build: (l, worlds) => {
      const parts = definition.build(l, worlds);
      return {
        ...parts,
        llm: new FakeLLM(),
        console: {
          ...parts.console,
          promptDocs: [{
            key: 'orientation',
            title: 'ORIENTATION',
            description: 'Persona的存在方式与元认知说明。',
            path: orientationFile,
          }],
        },
      };
    },
  });
  port = (await bot.start()).port as number;
}, 20000);

afterAll(async () => {
  await bot.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('统一入口:框架派生的控制台', () => {
  it('层2 来自被选中的那个Persona,不掺别人的段', () => {
    const cfg = bot.core.config as CorminiConfig & Record<string, unknown>;
    expect(cfg.displayName).toBe('可缇mini');
    // 模型归 provider,不再是Persona的配置段
    expect(cfg.model).toBeUndefined();
    expect(cfg.providers.fixture.spec?.model).toBe('test-model');
    // 起 cormini 不该把 corti 的段合进来
    expect(cfg.models).toBeUndefined();
    expect(cfg.memo).toBeUndefined();
    // qq 段来自仓内 World 目录(部署侧选配,默认关),不是 corti 的层 2。
    expect((cfg.worlds as Record<string, WorldSection>).qq).toMatchObject({ enabled: false });
  });

  it.each([
    ['/api/status', 'loop'],
    ['/api/storage', 'parts'],
    ['/api/usage', 'series'],
    ['/api/config', 'groups'],
    ['/api/worlds', 'worlds'],
    ['/api/tool-schemas', 'tools'],
  ])('%s 提供配置与控制台能力', async (path, key) => {
    const { status, body } = await getJ(path);
    expect(status).toBe(200);
    expect(body[key]).toBeDefined();
  });

  it('工具归属按装配事实标注:World 的工具指回 World,其余算Persona自有', async () => {
    const { body } = await getJ('/api/tool-schemas');
    const owners = new Map(
      (body.tools as Array<{ name: string; owner: { kind: string; id?: string; label?: string } }>)
        .map((t) => [t.name, t.owner]),
    );
    expect(owners.get('terminal_send')).toEqual({ kind: 'world', id: 'terminal', label: '终端对话' });
    expect(owners.get('read_file')).toEqual({ kind: 'persona' });
    expect(owners.get('write_file')).toEqual({ kind: 'persona' });
  });

  it('存储清单是框架派生的九条,加Persona的工作区,再加各 World 槽位自报的', async () => {
    const { body } = await getJ('/api/storage');
    const keys = (body.parts as Array<{ key: string }>).map((p) => p.key);
    const slotKeys = new Set(bot.assembly.slots.flatMap((s) => s.instance.console?.()?.storage ?? []).map((p) => p.key));
    expect(keys.filter((k) => !slotKeys.has(k)).sort()).toEqual(['events', 'pending', 'runlog', 'session', 'state', 'toolcalls', 'tracker', 'usage', 'wakes', 'workspace']);
  });

  it('工作区可清:她写的文件删掉,宪法留下', async () => {
    const core = bot.parts.persona as unknown as { memoryDir: string };
    writeFileSync(join(core.memoryDir, 'session_log.md'), '旧场次日志\n', 'utf8');
    const { status, body } = await postJ('/api/storage/clear?key=workspace', {});
    expect(status).toBe(200);
    expect(String(body.result)).toContain('已删除 1 个');
    expect(existsSync(join(core.memoryDir, 'session_log.md'))).toBe(false);
    expect(existsSync(join(core.memoryDir, 'CONSTITUTION.md'))).toBe(true);
  });

  it('模型与报价由 Provider 模块提供，旧全局端点不存在', async () => {
    const { status, body } = await postJ('/api/console/providers/llm%3Aopenai-responses-compat/panels/settings/state', { args: [] });
    expect(status).toBe(200);
    // 角色矩阵没了:一个端点一份档
    expect(body.roles).toBeUndefined();
    expect(body.active).toBe('fixture');
    expect((body.instances as any[])[0].quotes.length).toBeGreaterThan(0);
    for (const path of ['/api/models', '/api/pricing']) expect((await fetch(`http://127.0.0.1:${port}${path}`)).status).toBe(404);
  });

  it('模块保存模型档位后热生效，非法档位不改变配置', async () => {
    const save = (spec: Record<string, unknown>) => postJ('/api/console/providers/llm%3Aopenai-responses-compat/panels/settings/save', { args: [{ name: 'fixture', spec, pricing: [] }] });
    const effective = () => bot.core.mainSessionSpec();
    expect((await save({ model: 'test-reasoner', thinking: true, reasoningEffort: 'max' })).status).toBe(200);
    expect(effective()).toMatchObject({ model: 'test-reasoner', thinking: true, reasoningEffort: 'max' });
    expect((await save({ model: 'test-model', thinking: false })).status).toBe(200);
    expect('reasoningEffort' in effective()).toBe(false);
    const invalid = await save({ model: 'x', thinking: false, reasoningEffort: 'high' });
    expect(invalid.status).toBe(500);
    expect(invalid.body.error).toContain('推理强度');
    expect(effective().model).toBe('test-model');
  });

  it('cormini 没有的那些面板:provider 里根本没声明,一律 404', async () => {
    for (const p of ['dream', 'checkpoints', 'reset', 'workspace']) {
      const path = '/api/console/providers/persona%3Acormini/panels/' + p + '/state';
      expect((await postJ(path, { args: [] })).status, path).toBe(404);
    }
  });
});

describe('bot 声明的固定提示词源文件', () => {
  it('ORIENTATION 以 persona 身份列入提示词源', async () => {
    const { status, body } = await getJ('/api/prompts');
    expect(status).toBe(200);
    const prompts = body.prompts as Array<Record<string, string>>;
    const orient = prompts.find((p) => p.key === 'orientation');
    expect(orient).toBeDefined();
    expect(orient!.scope).toBe('persona');
    expect(orient!.content).toContain('第一版定向');
    // World 自报的环境提示词仍在,scope 区分两者
    expect(prompts.find((p) => p.key === 'worlds.terminal.envPrompt')?.scope).toBe('world');
    // 只上控制台的实例也算:未激活的 World,环境提示词照样能改
    expect(prompts.find((p) => p.key === 'worlds.dormant.envPrompt')?.content).toContain('未激活 World 的环境提示词');
  });

  it('保存写回源文件;revision 不匹配报冲突', async () => {
    const before = (await getJ('/api/prompts')).body.prompts as Array<Record<string, string>>;
    const revision = before.find((p) => p.key === 'orientation')!.revision;
    const saved = await postJ('/api/prompts', { key: 'orientation', content: '改过的定向\n', baseRevision: revision });
    expect(saved.status).toBe(200);
    expect(readFileSync(orientationFile, 'utf8')).toBe('改过的定向\n');

    const stale = await postJ('/api/prompts', { key: 'orientation', content: 'x', baseRevision: revision });
    expect(stale.status).toBe(409);
    expect(readFileSync(orientationFile, 'utf8')).toBe('改过的定向\n');
  });

  it('World 环境模板保存为部署覆盖，移除覆盖后使用后备模板', async () => {
    const list = async () => (await getJ('/api/prompts')).body.prompts as Array<Record<string, string>>;
    const before = (await list()).find((p) => p.key === 'worlds.dormant.envPrompt')!;
    expect(before.origin).toBe('module');

    const saved = await postJ('/api/prompts', { key: 'worlds.dormant.envPrompt', content: 'bot 自己的写法\n', baseRevision: before.revision });
    expect(saved.status).toBe(200);
    expect(saved.body.result).toContain('覆盖');
    const overrideFile = join(dir, 'worlds', 'dormant', 'ENV_PROMPT.md');
    expect(readFileSync(overrideFile, 'utf8')).toBe('bot 自己的写法\n');
    expect(readFileSync(dormantFile, 'utf8')).toBe('未激活 World 的环境提示词\n');
    const after = (await list()).find((p) => p.key === 'worlds.dormant.envPrompt')!;
    expect(after.origin).toBe('deployment');
    expect(after.content).toBe('bot 自己的写法\n');

    const reset = await postJ('/api/prompts/reset', { key: 'worlds.dormant.envPrompt' });
    expect(reset.status).toBe(200);
    expect(existsSync(overrideFile)).toBe(false);
    const restored = (await list()).find((p) => p.key === 'worlds.dormant.envPrompt')!;
    expect(restored.origin).toBe('module');
    expect(restored.content).toBe('未激活 World 的环境提示词\n');

    // 人格侧的模板没有"World 默认"可回
    expect((await postJ('/api/prompts/reset', { key: 'orientation' })).status).toBe(400);
  });

  it('前缀预览读的是 bot 侧覆盖;删掉覆盖后回到 World 那份', async () => {
    const segments = async () => (await getJ('/api/prompts/prefix')).body.segments as Array<{ text: string; sourceKey?: string }>;
    const terminal = (await segments()).find((s) => s.sourceKey === 'worlds.terminal.envPrompt')!;
    expect(terminal).toBeDefined();
    const moduleText = terminal.text;

    const doc = ((await getJ('/api/prompts')).body.prompts as Array<Record<string, string>>).find((p) => p.key === 'worlds.terminal.envPrompt')!;
    await postJ('/api/prompts', { key: 'worlds.terminal.envPrompt', content: 'bot 侧的终端说明\n', baseRevision: doc.revision });
    const overridden = (await segments()).find((s) => s.sourceKey === 'worlds.terminal.envPrompt')!;
    expect(overridden.text).toContain('bot 侧的终端说明');
    expect(overridden.text).not.toBe(moduleText);

    await postJ('/api/prompts/reset', { key: 'worlds.terminal.envPrompt' });
    expect((await segments()).find((s) => s.sourceKey === 'worlds.terminal.envPrompt')!.text).toBe(moduleText);
  });
});

describe('Persona定义了但是没安装', () => {
  it('未安装的 World 不进 core', () => {
    expect(bot.assembly.mounted.map((m) => m.id)).toEqual(['terminal']);
    expect(bot.core.worldVisibility().visibility).toEqual({ terminal: true });
  });

  it('在控制台清单里标记未安装 World', async () => {
    const { body } = await getJ('/api/worlds');
    const worlds = body.worlds as Array<Record<string, unknown>>;
    const missing = worlds.find((m) => m.status === 'missing');
    expect(missing).toBeDefined();
    expect(missing!.id).toBe('phantom');
    expect(String(missing!.reason)).toContain('没有找到');
    // 未安装 World 没有工具与环境提示词。
    expect(missing!.tools).toBeUndefined();
    expect(missing!.envPrompt).toBeUndefined();
  });

  it('对未安装的 World 开可见性开关会被拒绝(不静默成功)', async () => {
    const { status, body } = await postJ('/api/worlds/visibility', { id: 'phantom', visible: false });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('未挂载');
  });
});

describe('激活 / 停用 / 重启经 HTTP(热生效)', () => {
  const modulesOf = async () => (await getJ('/api/worlds')).body.worlds as Array<Record<string, unknown>>;
  const toolNames = () => bot.core.loop.getToolSchemas().map((t) => t.name);

  it('未激活的槽位以 inactive 上清单,选配外挂', async () => {
    const dormant = (await modulesOf()).find((m) => m.id === 'dormant')!;
    expect(dormant.status).toBe('inactive');
    expect(dormant.declared).toBe(false);
    expect(dormant.label).toBe('未激活 World');
  });

  it('激活:写回 config.json、启动、挂进 core、工具立刻进表,不重启进程', async () => {
    const r = await postJ('/api/worlds/activation', { id: 'dormant', enabled: true });
    expect(r.status).toBe(200);
    expect(String(r.body.result)).toContain('已启用');
    expect(r.body.restarting).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).worlds.dormant.enabled).toBe(true);
    const dormant = (await modulesOf()).find((m) => m.id === 'dormant')!;
    expect(dormant.status).toBe('active');
    expect(dormant.tools).toEqual(['dormant_ping']);
    expect(bot.assembly.mounted.map((m) => m.id)).toEqual(['terminal', 'dormant']);
    expect(toolNames()).toContain('dormant_ping');
  });

  it('重启:停下再按定义重建,仍然挂着', async () => {
    const before = bot.assembly.slot('dormant').instance;
    const r = await postJ('/api/worlds/restart', { id: 'dormant' });
    expect(r.status).toBe(200);
    expect(bot.assembly.slot('dormant').instance).not.toBe(before);
    expect(bot.assembly.slot('dormant').mounted).toBe(true);
  });

  it('停用:撤出 core、工具撤下、config.json 写回 false;未激活的 World 不能重启', async () => {
    const r = await postJ('/api/worlds/activation', { id: 'dormant', enabled: false });
    expect(r.status).toBe(200);
    expect(bot.assembly.mounted.map((m) => m.id)).toEqual(['terminal']);
    expect(toolNames()).not.toContain('dormant_ping');
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).worlds.dormant.enabled).toBe(false);
    const dormant = (await modulesOf()).find((m) => m.id === 'dormant')!;
    expect(dormant.status).toBe('inactive');
    const restart = await postJ('/api/worlds/restart', { id: 'dormant' });
    expect(restart.status).toBe(400);
    expect(String(restart.body.error)).toContain('未激活');
  });

  it('未知 id 与只占位子的 World 都是 400', async () => {
    expect((await postJ('/api/worlds/activation', { id: 'nope', enabled: true })).status).toBe(400);
    expect((await postJ('/api/worlds/activation', { id: 'phantom', enabled: true })).status).toBe(400);
  });
});

describe('可见性开关经 HTTP', () => {
  it('关掉后清单反映状态,并报告前缀尚未跟上', async () => {
    const off = await postJ('/api/worlds/visibility', { id: 'terminal', visible: false });
    expect(off.status).toBe(200);
    expect(off.body.driftedWorlds).toEqual(['terminal']);

    const { body } = await getJ('/api/worlds');
    const terminal = (body.worlds as Array<Record<string, unknown>>).find((m) => m.id === 'terminal')!;
    expect(terminal.visible).toBe(false);
    expect(terminal.prefixDrifted).toBe(true);

    await postJ('/api/session/reload-prefix', {});
    const after = await getJ('/api/worlds');
    const t2 = (after.body.worlds as Array<Record<string, unknown>>).find((m) => m.id === 'terminal')!;
    expect(t2.prefixDrifted).toBe(false);

    await postJ('/api/worlds/visibility', { id: 'terminal', visible: true });
  });
});
