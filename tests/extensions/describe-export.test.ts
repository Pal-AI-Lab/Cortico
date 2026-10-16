/**
 * describe.json 从定义的 describe 与干装载的提示词模板生成;check:extension 要求定义写了 describe、
 * 实例工具名都已声明、包里的文件与重新生成的一致。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDescribe, exportDescribe } from '../../src/extensions/describe-export.ts';
import type { BotDefinition } from '../../src/bot.ts';
import type { CoreConfig, Persona, ToolDef, ToolDescribe } from '../../src/core/types.ts';
import type { WorldDefinition, WorldSection } from '../../src/world.ts';
import type { ProviderModule } from '../../src/providers/base.ts';

let pkgDir: string;
let scratchDir: string;
beforeEach(() => {
  pkgDir = mkdtempSync(join(tmpdir(), 'describe-pkg-'));
  scratchDir = mkdtempSync(join(tmpdir(), 'describe-scratch-'));
});
afterEach(() => {
  rmSync(pkgDir, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

const declared = (name: string): ToolDescribe => ({ name, description: name, parameters: { type: 'object', properties: {} }, tags: ['read'] });
const tool = (name: string): ToolDef => ({ ...declared(name), handler: async () => 'ok' });

function world(names: string[], withDescribe = true): WorldDefinition<WorldSection> {
  return {
    id: 'sample',
    label: 'Sample',
    defaults: () => ({ enabled: false }),
    create: (ctx) => ({
      id: 'sample',
      envPromptVars: () => ({}),
      tools: () => names.map(tool),
      start: async () => {},
      stop: async () => {},
      webUi: () => ({
        promptDocs: [
          { key: 'worlds.sample.envPrompt', title: 'Env', description: '', path: join(ctx.packageDir, 'ENV.md'), role: 'envPrompt' },
          { key: 'worlds.sample.notes', title: 'Notes', description: '', path: join(ctx.packageDir, 'NOTES.md') },
        ],
      }),
    }),
    ...(withDescribe ? { describe: { tools: [declared('sample_ping')], events: [{ type: 'sample.tick', description: { zh: '心跳', en: 'Tick' } }] } } : {}),
  };
}

describe('World', () => {
  it('describe.json carries the declared tools and events and the env prompt template text; the check passes on it and fails once the template changes', async () => {
    writeFileSync(join(pkgDir, 'ENV.md'), 'You are in {{sample.place}}.\n');
    writeFileSync(join(pkgDir, 'NOTES.md'), 'not an env prompt');
    const opts = { scratchDir, packageDir: pkgDir };
    const file = await exportDescribe('world', world(['sample_ping']), opts);
    expect(file).toEqual({
      tools: [declared('sample_ping')],
      events: [{ type: 'sample.tick', description: { zh: '心跳', en: 'Tick' } }],
      prompts: [{ key: 'worlds.sample.envPrompt', title: 'Env', role: 'envPrompt', content: 'You are in {{sample.place}}.\n' }],
    });
    writeFileSync(join(pkgDir, 'describe.json'), JSON.stringify(file));
    expect((await checkDescribe('world', world(['sample_ping']), 'describe.json', opts)).failures).toEqual([]);

    writeFileSync(join(pkgDir, 'ENV.md'), 'You are somewhere else.\n');
    const stale = await checkDescribe('world', world(['sample_ping']), 'describe.json', opts);
    expect(stale.failures.join('\n')).toContain('pnpm describe:extension');
  });

  it('the check fails on a missing describe, a tool missing from describe.tools, and a package without cortico.describe', async () => {
    const opts = { scratchDir, packageDir: pkgDir };
    expect((await checkDescribe('world', world(['sample_ping'], false), 'describe.json', opts)).failures.join('\n')).toContain('has no describe');
    expect((await checkDescribe('world', world(['sample_ping', 'sample_extra']), undefined, opts)).failures.join('\n')).toMatch(/sample_extra[\s\S]*cortico\.describe/);
  });
});

it('a bot describe.json lists the declared Worlds, the Memory name and the Persona templates; Persona tools missing from describe.tools fail the check', async () => {
  writeFileSync(join(pkgDir, 'PREFIX.md'), '{{persona.memory}}');
  const persona = {
    ownToolNames: () => ['mem_read', 'mem_extra'],
    webUi: () => ({ promptDocs: [{ key: 'persona.prefix', title: 'PREFIX', description: '', path: join(pkgDir, 'PREFIX.md'), role: 'prefix' as const }] }),
  } as unknown as Persona;
  const bot: BotDefinition<CoreConfig> = {
    id: 'sample-bot',
    memoryName: 'Notebook',
    declares: ['console', { id: 'chat', label: 'Chat' }],
    defaults: () => ({}) as CoreConfig,
    build: () => ({ persona }),
    describe: { tools: [declared('mem_read')], memory: { form: 'Markdown files' } },
  };
  const opts = { scratchDir, packageDir: pkgDir };
  expect(await exportDescribe('bot', bot, opts)).toEqual({
    tools: [declared('mem_read')],
    bot: { worlds: ['console', 'chat'], memory: { name: 'Notebook', form: 'Markdown files' } },
    prompts: [{ key: 'persona.prefix', title: 'PREFIX', role: 'prefix', content: '{{persona.memory}}' }],
  });
  expect((await checkDescribe('bot', bot, undefined, opts)).failures.join('\n')).toContain('mem_extra');
});

it('a provider describe.json carries describe, title, description and the non-empty tier tables', async () => {
  const mod = {
    id: 'sample', title: 'Sample', description: 'A sample endpoint.',
    reasoningTiers: [{ id: 'high', label: 'High', thinking: true, effort: 'high' }], serviceTiers: [],
    describe: { protocols: ['sample-chat'], auth: ['api-key'], local: false, input: ['text', 'image'] },
  } as unknown as ProviderModule;
  expect(await exportDescribe('provider', mod, { scratchDir, packageDir: pkgDir })).toEqual({
    provider: {
      protocols: ['sample-chat'], auth: ['api-key'], local: false, input: ['text', 'image'],
      title: 'Sample', description: 'A sample endpoint.',
      reasoningTiers: [{ id: 'high', label: 'High', thinking: true, effort: 'high' }],
    },
  });
});
