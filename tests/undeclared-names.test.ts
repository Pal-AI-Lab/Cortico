/**
 * 运行中不在自描述里的工具名与事件 type:照常挂载、照常落库,每个名字只记一条 warn,并标在 World 页与 Persona 页上。
 * 没写 describe 的 World 不检查。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBot, deriveWebUiPageSources, type BotDefinition } from '../src/bot.ts';
import { CORE_DEFAULTS, type LoadedConfig } from '../src/core/config.ts';
import type { CoreConfig, LogRecord, ToolDef, World, WorldHost } from '../src/core/types.ts';
import type { WorldDefinition, WorldSection } from '../src/world.ts';
import { FakeLLM, makeFakePersona } from './core/helpers.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'undeclared-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tool = (name: string): ToolDef => ({
  name, description: name, parameters: { type: 'object', properties: {} }, tags: ['read'], handler: async () => 'ok',
});

class ProbeWorld implements World {
  host: WorldHost | null = null;
  constructor(readonly id: string, private readonly names: string[]) {}
  envPromptVars(): Record<string, string> { return {}; }
  tools(): ToolDef[] { return this.names.map(tool); }
  async start(host: WorldHost): Promise<void> { this.host = host; }
  async stop(): Promise<void> {}
}

function definition(id: string, names: string[], describe?: WorldDefinition['describe']): WorldDefinition<WorldSection> & { instance: ProbeWorld } {
  const instance = new ProbeWorld(id, names);
  return { id, label: id, defaults: () => ({ enabled: true }), create: () => instance, instance, ...(describe ? { describe } : {}) };
}

it('undeclared tools and events still mount and land in the store, are logged once per name, and show on the World and Persona pages', async () => {
  const described = definition('probe', ['probe_known', 'probe_extra'], {
    tools: [{ ...tool('probe_known'), tags: ['read'] }],
    events: [{ type: 'probe.known', description: 'declared' }],
  });
  const plain = definition('plain', ['plain_any']);
  const config = { ...CORE_DEFAULTS, web: { ...CORE_DEFAULTS.web, port: 0 }, worlds: { probe: { enabled: true }, plain: { enabled: true } } } as unknown as CoreConfig;
  const loaded: LoadedConfig<CoreConfig> = { config, secret: () => '', rootDir: dir, memoryDir: join(dir, 'memory'), dataDir: join(dir, 'data') };
  const bot: BotDefinition<CoreConfig> = {
    id: 'probe-bot',
    defaults: () => config,
    worlds: [described, plain],
    describe: { tools: [{ ...tool('persona_known'), tags: ['read'] }], memory: { form: 'none' } },
    build: (_loaded, worlds) => {
      const persona = makeFakePersona([], { worlds });
      return { persona: { ...persona, ownToolNames: () => ['persona_known', 'persona_extra'], webUi: () => ({}) }, llm: new FakeLLM(), webUi: { enabled: false } };
    },
  };
  const app = createBot(loaded, bot);
  try {
    await app.start();
    const host = described.instance.host!;
    const now = new Date().toISOString();
    await host.pushEvent({ type: 'probe.known', ts: now, source: 'probe', text: 'a' });
    await host.pushEvent({ type: 'probe.surprise', ts: now, source: 'probe', text: 'b' });
    await host.pushEvent({ type: 'probe.surprise', ts: now, source: 'probe', text: 'c' });
    host.pushDeferred({ type: 'probe.later', render: () => 'd' });
    await plain.instance.host!.pushEvent({ type: 'plain.anything', ts: now, source: 'plain', text: 'e' });

    expect(app.assembly.slot('probe').mounted).toBe(true);
    expect(app.core.store.range({ source: 'probe' }).map((e) => e.type)).toEqual(['probe.known', 'probe.surprise', 'probe.surprise']);
    expect(app.undeclared.of('worlds.probe')).toEqual({ tools: ['probe_extra'], events: ['probe.surprise', 'probe.later'] });
    expect(app.undeclared.of('worlds.plain')).toBeUndefined();
    expect(app.undeclared.of('persona')).toEqual({ tools: ['persona_extra'], events: [] });

    const warns = readFileSync(app.core.runlog.path!, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as LogRecord)
      .filter((record) => record.level === 'warn' && /probe_extra|probe\.surprise|probe\.later|persona_extra|plain/.test(record.msg));
    expect(warns.map((record) => record.area).sort()).toEqual(['persona', 'worlds.probe', 'worlds.probe', 'worlds.probe']);

    const sources = deriveWebUiPageSources(app.core, { assembly: app.assembly, persona: app.parts.persona, undeclared: app.undeclared }, { id: 'probe-bot', label: 'probe' })();
    const page = async (id: string) => sources.find((source) => source.id === id)?.contribute('en');
    expect((await page('world:probe'))?.undeclared).toEqual({ tools: ['probe_extra'], events: ['probe.surprise', 'probe.later'] });
    expect((await page('world:plain'))?.undeclared).toBeUndefined();
    expect((await page('persona:probe-bot'))?.undeclared).toEqual({ tools: ['persona_extra'], events: [] });
  } finally {
    await app.stop();
  }
});
