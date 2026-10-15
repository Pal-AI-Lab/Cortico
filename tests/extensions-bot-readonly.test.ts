/**
 * 扩展包来源的 bot:框架从不往包目录写。Persona 的提示词模板没给 `deploymentPath` 的在
 * WebUI 里能读不能存;给了的照常写到部署侧。仓内 bot 不受影响(tests/cormini/definition.test.ts)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBot, type Bot } from '../src/bot.ts';
import { loadDeployment } from '../src/deploy.ts';
import { FakeLLM } from './core/helpers.ts';
import { withWorlds } from '../src/world.ts';
import { loadBuiltinWorlds } from '../src/worlds/index.ts';
import cormini, { type CorminiConfig } from '../bots/cormini/index.ts';

const builtinWorlds = await loadBuiltinWorlds();

const definition = withWorlds(cormini, builtinWorlds);

let dir: string;
let bot: Bot<CorminiConfig>;
let port: number;
let packedFile: string;
let overrideFile: string;

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
  dir = mkdtempSync(join(tmpdir(), 'bot-readonly-'));
  const loaded = loadDeployment(definition, dir, resolve(import.meta.dirname, '..'));
  loaded.config.web.port = 0;
  packedFile = join(dir, 'PACKED.md');
  writeFileSync(packedFile, '包里的模板\n', 'utf8');
  overrideFile = join(dir, 'prompts', 'OVERRIDABLE.md');
  bot = createBot(loaded, {
    ...definition,
    build: (l, worlds) => {
      const parts = definition.build(l, worlds);
      return {
        ...parts,
        llm: new FakeLLM(),
        webUi: {
          ...parts.webUi,
          promptDocs: [
            { key: 'packed', title: '包内模板', description: '没给 deploymentPath。', path: packedFile },
            { key: 'overridable', title: '可覆盖模板', description: '给了 deploymentPath。', path: packedFile, deploymentPath: overrideFile },
          ],
        },
      };
    },
  }, {
    extensions: {
      dir: join(dir, 'extensions'),
      records: [],
      worlds: [],
      providers: [],
      webUiAssets: [],
      bot: { name: 'cortico-bot-fixture', id: definition.id },
    },
  });
  port = (await bot.start()).port as number;
}, 20000);

afterAll(async () => {
  await bot.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('扩展包来源的 bot 的提示词模板', () => {
  it('两份都能读', async () => {
    const prompts = (await getJ('/api/prompts')).body.prompts as Array<Record<string, string>>;
    expect(prompts.find((p) => p.key === 'packed')?.content).toBe('包里的模板\n');
    expect(prompts.find((p) => p.key === 'overridable')?.content).toBe('包里的模板\n');
  });

  it('没给 deploymentPath 的保存被拒,包内文件原样', async () => {
    const before = (await getJ('/api/prompts')).body.prompts as Array<Record<string, string>>;
    const revision = before.find((p) => p.key === 'packed')!.revision;
    const saved = await postJ('/api/prompts', { key: 'packed', content: '改了\n', baseRevision: revision });
    expect(saved.status).toBe(400);
    expect(String(saved.body.error)).toContain('只读');
    expect(readFileSync(packedFile, 'utf8')).toBe('包里的模板\n');
  });

  it('给了 deploymentPath 的写到部署侧,包内文件原样', async () => {
    const before = (await getJ('/api/prompts')).body.prompts as Array<Record<string, string>>;
    const revision = before.find((p) => p.key === 'overridable')!.revision;
    const saved = await postJ('/api/prompts', { key: 'overridable', content: '部署侧的\n', baseRevision: revision });
    expect(saved.status).toBe(200);
    expect(existsSync(overrideFile)).toBe(true);
    expect(readFileSync(overrideFile, 'utf8')).toBe('部署侧的\n');
    expect(readFileSync(packedFile, 'utf8')).toBe('包里的模板\n');
  });
});
