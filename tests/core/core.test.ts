/**
 * 验证恰好一个接收事件的常驻 session，以及 fork 的声明解析、并发统计和计量。
 * fork 模型来自活跃端点，工具和轮数来自声明；session id 仅作为查表键。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Core } from "./fixture-core.ts";
import type { LoadedConfig } from '../../src/core/config.ts';
import type { BotConfig } from '../../bots/corti-soulmate/assemble.ts';
import type {
  EventEnvelope,
  CoreApi,
  World,
  WorldHost,
  LogRecord,
  SessionDecl,
  ToolDef,
  ToolTag,
} from '../../src/core/types.ts';
import {
  activeSpec,
  FakeLLM,
  makeCfg,
  makeFakeIO,
  makeFakePersona,
  makeLoaded,
  makeTmpDir,
  makeTool,
  textReply,
  toolReply,
} from './helpers.ts';

function loadedFor(dir: string): LoadedConfig<BotConfig> {
  const config = makeCfg();
  config.worlds.qq.enabled = false;
  return makeLoaded({
    config,
    rootDir: dir,
    memoryDir: `${dir}/persona`,
    dataDir: `${dir}/data`,
  });
}

/** 临时 session 声明。 */
function forkDecl(patch: Partial<SessionDecl> = {}): SessionDecl {
  return {
    id: 'sidethought',
    label: '侧向思路',
    rounds: () => ({ soft: 2, hard: 3 }),
    persistent: false,
    receivesEvents: false,
    tools: () => [makeTool('probe', 'ok')],
    ...patch,
  };
}

describe('Core · session 声明与 fork 原语', () => {
  let tmp: ReturnType<typeof makeTmpDir> | null = null;
  afterEach(() => {
    tmp?.cleanup();
    tmp = null;
  });

  const build = (opts: Parameters<typeof makeFakePersona>[1] = {}) => {
    tmp = makeTmpDir();
    const loaded = loadedFor(tmp.dir);
    const persona = makeFakePersona([], { cfg: loaded.config, ...opts });
    const llm = new FakeLLM();
    const core = new Core(loaded, {
      persona,
      worlds: [makeFakeIO('web')],
      llm,
    });
    return { core, llm, persona };
  };

  it('恰好一个接收投递的常驻 session:多了或少了都在装配时拒绝', () => {
    expect(() => build({ mainPatch: { receivesEvents: false } })).toThrow(/恰好声明一个/);
    expect(() =>
      build({ extraSessions: [forkDecl({ persistent: true, receivesEvents: true })] }),
    ).toThrow(/恰好声明一个/);
    expect(() => build({ extraSessions: [forkDecl()] })).not.toThrow();
  });

  it('主循环异常退出记录原始 rename 错误并停止定时唤醒，保留未到期任务', async () => {
    vi.useFakeTimers();
    const { core, llm } = build();
    const exits: LogRecord[] = [];
    core.runlog.onWrite((entry) => {
      if (entry.event === 'loop-exit') exits.push(entry);
    });
    const due: string[] = [];
    core.timers.onDue((entry) => due.push(entry.id));
    core.timers.set(new Date(Date.now() + 60_000).toISOString(), { note: '保留的任务' });
    const stale = Date.now() - 2 * 60 * 60_000;
    core.state.data.llmStall = { since: stale, at: [stale] };
    mkdirSync(join(core.loaded.dataDir, 'core-state.json'));
    try {
      await core.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(exits).toHaveLength(1);
      expect(exits[0].level).toBe('error');
      expect(exits[0].err?.message).toMatch(/rename.*core-state\.json/);
      expect(core.loop.getStatus().running).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(due).toEqual([]);
      expect(core.timers.list()).toHaveLength(1);
      expect(llm.calls).toHaveLength(0);
      expect(exits).toHaveLength(1);
    } finally {
      await core.stop();
      vi.useRealTimers();
    }
  });

  it("spawnFork 使用活跃端点和声明工具，返回工具循环的最后正文", async () => {
    const { core, llm } = build({ extraSessions: [forkDecl()] });
    llm.script(toolReply([{ name: 'probe', id: 'p1' }]), textReply('看完了。'));

    const out = await core.spawnFork({
      id: 'sidethought',
      messages: [{ role: 'user', content: '去看看' }],
    });

    expect(out).toBe('看完了。');
    expect(llm.calls[0].spec.model).toBe(activeSpec(makeCfg()).model);
    expect(llm.calls[0].tools?.map((t) => t.name)).toEqual(['probe']);
    // 用量归账到声明 id 上(成本页按此分类)
    const stats = core.sessions.list().find((s) => s.role === 'sidethought');
    expect(stats?.calls).toBe(2);
    expect(stats?.endedAt).not.toBeNull();
  });

  it('首轮未完成时也能观察流式进度', async () => {
    const { core, llm } = build({ extraSessions: [forkDecl()] });
    let release!: () => void;
    let llmSessionId: string | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = llm.chat.bind(llm);
    llm.chat = async (spec, messages, tools, opts) => {
      expect(opts?.onDelta).toBeTypeOf('function');
      expect(opts?.role).toBe('sidethought');
      llmSessionId = opts?.sessionId;
      opts!.onDelta!({ type: 'reasoning', text: '正在画第一层' });
      await gate;
      return original(spec, messages, tools, opts);
    };
    llm.fallback = () => textReply('画完了。');

    const running = core.spawnFork({
      id: 'sidethought',
      messages: [{ role: 'user', content: '画一张图' }],
    });
    const session = core.sessions.list().find((s) => s.role === 'sidethought')!;
    expect(llmSessionId).toBe(session.id);
    expect(core.sessions.messages(session.id)?.map(entry => entry.item)).toMatchObject([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '画一张图' }] },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: '正在画第一层' }] },
    ]);

    release();
    await expect(running).resolves.toBe('画完了。');
  });

  it("spawnFork 拒绝未声明的 session id", async () => {
    const { core } = build();
    await expect(core.spawnFork({ id: '没声明过', messages: [] })).rejects.toThrow(/未声明/);
  });

  it('并发记账:运行中的实例数经 sessionInfo 可读,Persona据此判断单实例', async () => {
    let api: CoreApi | null = null;
    const personaOpts: Parameters<typeof makeFakePersona>[1] = {
      extraSessions: [forkDecl()],
    };
    tmp = makeTmpDir();
    const loaded = loadedFor(tmp.dir);
    const persona = makeFakePersona([], { cfg: loaded.config, ...personaOpts });
    const attach = persona.attach.bind(persona);
    persona.attach = (h) => {
      api = h;
      attach(h);
    };
    const llm = new FakeLLM();
    const core = new Core(loaded, { persona, worlds: [makeFakeIO('web')], llm });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = llm.chat.bind(llm);
    llm.chat = async (...args) => {
      await gate;
      return original(...args);
    };
    const running = core.spawnFork({ id: 'sidethought', messages: [] });
    expect(api!.sessionInfo('sidethought').running).toBe(1);
    release();
    await running;
    expect(api!.sessionInfo('sidethought').running).toBe(0);
  });

  it('同一声明的并发 fork 保留相同 role,但拿到不同 session 实例 id', async () => {
    const { core, llm } = build({ extraSessions: [forkDecl()] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: Array<{ role?: string; sessionId?: string }> = [];
    const original = llm.chat.bind(llm);
    llm.chat = async (spec, messages, tools, opts) => {
      seen.push({ role: opts?.role, sessionId: opts?.sessionId });
      await gate;
      return original(spec, messages, tools, opts);
    };

    const first = core.spawnFork({ id: 'sidethought', messages: [] });
    const second = core.spawnFork({ id: 'sidethought', messages: [] });
    const activeIds = core.sessions.list()
      .filter((s) => s.role === 'sidethought' && s.endedAt === null)
      .map((s) => s.id)
      .sort();

    expect(seen.map((call) => call.role)).toEqual(['sidethought', 'sidethought']);
    expect(seen.map((call) => call.sessionId).sort()).toEqual(activeIds);
    expect(new Set(activeIds).size).toBe(2);

    release();
    await Promise.all([first, second]);
  });

  it('toolsTagged:Persona按 tag 取工具子集,不必认识 World 的工具名', async () => {
    let api: CoreApi | null = null;
    tmp = makeTmpDir();
    const loaded = loadedFor(tmp.dir);
    const tool = (name: string, tags: ToolTag[]): ToolDef => ({
      name, tags, description: '', parameters: {}, handler: async () => 'ok',
    });
    const persona = makeFakePersona(
      [tool('喊一嗓子', ['speak']), tool('挖一铲子', ['act']), tool('看一眼', ['read'])],
      { cfg: loaded.config },
    );
    const attach = persona.attach.bind(persona);
    persona.attach = (h) => {
      api = h;
      attach(h);
    };
    const core = new Core(loaded, {
      persona,
      worlds: [makeFakeIO('web')],
      llm: new FakeLLM(),
    });
    // 工具表在前缀重建时装配;交接会走那条路。
    await core.loop.handoffContext();

    expect(api!.toolsTagged('speak').has('喊一嗓子')).toBe(true);
    expect(api!.toolsTagged('speak').has('挖一铲子')).toBe(false);
    expect(api!.toolsTagged('act').has('挖一铲子')).toBe(true);
    expect(api!.toolsTagged('read').has('看一眼')).toBe(true);
  });

  it("Persona 状态经 CoreApi 读写并保存到 core-state.json", () => {
    let api: CoreApi | null = null;
    tmp = makeTmpDir();
    const loaded = loadedFor(tmp.dir);
    const persona = makeFakePersona([], { cfg: loaded.config });
    const attach = persona.attach.bind(persona);
    persona.attach = (h) => {
      api = h;
      attach(h);
    };
    const core = new Core(loaded, {
      persona,
      worlds: [makeFakeIO('web')],
      llm: new FakeLLM(),
    });
    core.state.load();

    api!.personaState().无论装什么 = ['core 不解释内容'];
    api!.savePersonaState();

    expect(core.state.data.persona).toEqual({ 无论装什么: ['core 不解释内容'] });
  });

  /** attach 前加载持久状态；load() 会替换 data.persona，Persona 必须取得加载后的引用。 */
  it('第二个 core 实例在 attach 时就看得见盘上的人格状态', () => {
    tmp = makeTmpDir();
    const loaded = loadedFor(tmp.dir);

    const writer = makeFakePersona([], { cfg: loaded.config });
    let writeApi: CoreApi | null = null;
    const writerAttach = writer.attach.bind(writer);
    writer.attach = (h) => { writeApi = h; writerAttach(h); };
    new Core(loaded, { persona: writer, worlds: [makeFakeIO('web')], llm: new FakeLLM() });
    writeApi!.personaState().指纹表 = { 'bilibili/314544096': 'sha' };
    writeApi!.savePersonaState();

    // 重启:同一个 dataDir 上重新装配一次
    const reader = makeFakePersona([], { cfg: loaded.config });
    let seenAtAttach: unknown = null;
    const readerAttach = reader.attach.bind(reader);
    reader.attach = (h) => {
      seenAtAttach = h.personaState().指纹表;
      readerAttach(h);
    };
    new Core(loaded, { persona: reader, worlds: [makeFakeIO('web')], llm: new FakeLLM() });

    expect(seenAtAttach).toEqual({ 'bilibili/314544096': 'sha' });
  });

  // 已消费的事件须标记已处理，使投递水位继续推进。
  it('World 抽走待投递事件后水位越过它们', async () => {
    tmp = makeTmpDir();
    const loaded = loadedFor(tmp.dir);
    let host: WorldHost | null = null;
    const probe: World = {
      id: 'probe',
      envPromptVars: () => ({}),
      tools: () => [],
      start: async (h) => { host = h; },
      stop: async () => {},
    };
    const persona = makeFakePersona([], { cfg: loaded.config, worlds: [probe], silent: true });
    const core = new Core(loaded, { persona, worlds: [probe], llm: new FakeLLM() });
    try {
      await core.start();
      core.bus.setPaused(true);
      const pushed: EventEnvelope[] = [];
      for (let i = 1; i <= 3; i++) {
        pushed.push(await host!.pushEvent({
          type: 'probe.msg',
          ts: `2026-08-27T21:0${i}:00+08:00`,
          source: 'probe',
          text: `抽走的第${i}条`,
        }));
      }
      const drained = await host!.drainPendingEvents((e) => e.source === 'probe');
      expect(drained).toHaveLength(3);
      expect(core.state.data.lastDeliveredCursor)
        .toBeGreaterThanOrEqual(pushed[2].cursor);
    } finally {
      await core.stop();
    }
  });
});
