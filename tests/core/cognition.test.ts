import { records } from './fixture-protocol.ts';
/**
 * 认知请求的工具归属、开关、并发统计与用量契约。
 * World 提供 brief 和自身工具；Persona 决定处理方式与预算，模型来自活跃端点。
 * Core 校验请求并统计并发，spawnFork 负责计量；测试使用 FakeLLM。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Core } from "./fixture-core.ts";
import type {
  CognitionContext,
  CognitionRequest,
  CoreApi,
  World,
  WorldHost,
  PersonaCognition,
  SessionDecl,
  ToolDef,
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
  sleep,
} from './helpers.ts';

/** 保留 start() 收到的 WorldHost，供测试调用。 */
function makeProbe(id: string, tools: ToolDef[]): { mod: World; host: () => WorldHost } {
  const base = makeFakeIO(id, tools);
  let captured: WorldHost | null = null;
  const mod: World = {
    ...base,
    start: async (h: WorldHost) => {
      captured = h;
      await base.start(h);
    },
  };
  return {
    mod,
    host: () => {
      if (!captured) throw new Error(`${id} 还没 start`);
      return captured;
    },
  };
}

const cognitionDecl: SessionDecl = {
  id: 'cognition',
  label: '认知外包',
  rounds: () => ({ soft: 2, hard: 3 }),
  persistent: false,
  receivesEvents: false,
  tools: () => [],
};

interface Rig {
  core: Core;
  llm: FakeLLM;
  api: CoreApi;
  host: () => WorldHost;
  otherHost: () => WorldHost;
  cleanup: () => Promise<void>;
}

/**
 * 两个 World 提供不同工具，用于检查工具归属。
 * Persona 钩子不注入文本，因此 FakeLLM 调用仅来自 fork。
 */
async function rig(cognition?: PersonaCognition): Promise<Rig> {
  const tmp = makeTmpDir();
  const config = makeCfg();
  config.worlds.qq.enabled = false;
  const loaded = makeLoaded({
    config,
    rootDir: tmp.dir,
    memoryDir: `${tmp.dir}/persona`,
    dataDir: `${tmp.dir}/data`,
  });
  const mc = makeProbe('mc', [makeTool('mc_blueprint', '蓝图收下了'), makeTool('mc_goal', '目标收下了')]);
  const other = makeProbe('other', [makeTool('other_send', 'ok')]);
  const persona = makeFakePersona([], {
    cfg: config,
    silent: true,
    worlds: [mc.mod, other.mod],
    extraSessions: [cognitionDecl],
  });
  if (cognition) persona.cognition = cognition;
  let api: CoreApi | null = null;
  const attach = persona.attach.bind(persona);
  persona.attach = (h) => {
    api = h;
    attach(h);
  };
  const llm = new FakeLLM();
  const core = new Core(loaded, { persona, worlds: [mc.mod, other.mod], llm });
  await core.start();
  await sleep(20);
  return {
    core,
    llm,
    api: api!,
    host: mc.host,
    otherHost: other.host,
    cleanup: async () => {
      await core.stop();
      tmp.cleanup();
    },
  };
}

let live: Rig | null = null;
afterEach(async () => {
  await live?.cleanup();
  live = null;
});

describe('认知外包 · 注入与开关', () => {
  it("Persona 未提供实现时 WorldHost.cognition 为 undefined", async () => {
    live = await rig();
    expect(live.host().cognition).toBeUndefined();
    expect(Boolean(live.host().cognition)).toBe(false);
  });

  it("关闭 cognition 后 WorldHost 立即停止提供该接口", async () => {
    let on = false;
    live = await rig({
      enabled: () => on,
      request: async () => ({ text: '想完了' }),
    });
    expect(live.host().cognition).toBeUndefined();
    on = true;
    expect(live.host().cognition).toBeDefined();
    on = false;
    expect(live.host().cognition).toBeUndefined();
  });

  it('提供实现:World 能调,拿回文本;brief 与 hint 原样透传,人格可否决量级', async () => {
    const seen: Array<{ req: CognitionRequest; ctx: CognitionContext }> = [];
    live = await rig({
      request: async (req, ctx) => {
        seen.push({ req, ctx });
        // hint 由 Persona 解释，Core 不强制采用。
        return { text: `想完了:${req.brief}` };
      },
    });

    const out = await live.host().cognition!.request({
      brief: '盖一间会呼吸的小屋',
      hint: { rounds: 8 },
    });

    expect(out).toEqual({ text: '想完了:盖一间会呼吸的小屋' });
    expect(seen).toHaveLength(1);
    expect(seen[0].req.brief).toBe('盖一间会呼吸的小屋');
    expect(seen[0].req.hint).toEqual({ rounds: 8 });
    expect(seen[0].ctx.worldId).toBe('mc');
    expect(seen[0].ctx.tools).toEqual([]);
  });

  it("空 brief 返回错误且不调用 Persona", async () => {
    let called = 0;
    live = await rig({
      request: async () => {
        called++;
        return { text: '不该到这儿' };
      },
    });
    const out = await live.host().cognition!.request({ brief: '   ' });
    expect(out).toHaveProperty('error');
    expect(called).toBe(0);
  });

  it("Persona 抛错时返回错误给 World", async () => {
    live = await rig({
      request: async () => {
        throw new Error('这一档没配模型');
      },
    });
    const out = await live.host().cognition!.request({ brief: '想点什么' });
    expect(out).toEqual({ error: '这一档没配模型' });
  });
});

describe('认知外包 · 工具白名单(core 的机械校验)', () => {
  it('点名本 World 自己的工具:解析成定义本体交给人格,handler 可直接执行', async () => {
    let handed: ToolDef[] = [];
    live = await rig({
      request: async (_req, ctx) => {
        handed = ctx.tools;
        return { text: 'ok' };
      },
    });

    await live.host().cognition!.request({
      brief: '出一张图',
      tools: ['mc_blueprint', 'mc_goal'],
    });

    expect(handed.map((t) => t.name)).toEqual(['mc_blueprint', 'mc_goal']);
    const ran = await handed[0].handler({}, { role: 'cognition', log: live.core.runlog.logger('t') });
    expect(ran).toBe('蓝图收下了');
  });

  it("请求其他 World 的工具时返回错误且不调用 Persona", async () => {
    let called = 0;
    live = await rig({
      request: async () => {
        called++;
        return { text: '不该到这儿' };
      },
    });

    const out = await live.host().cognition!.request({
      brief: '借别人的手',
      tools: ['mc_blueprint', 'other_send'],
    });

    expect(out).toHaveProperty('error');
    // 错误字段只列出越权工具，附带的可用工具表可能包含合法名称。
    const error = (out as { error: string }).error;
    expect(error.split('(')[0]).toContain('other_send');
    expect(error.split('(')[0]).not.toContain('mc_blueprint');
    expect(called).toBe(0);
  });

  it("请求 Persona 工具时返回越权错误", async () => {
    let called = 0;
    live = await rig({
      request: async () => {
        called++;
        return { text: '不该到这儿' };
      },
    });
    const out = await live.host().cognition!.request({ brief: '越级', tools: ['fork'] });
    expect(out).toHaveProperty('error');
    expect(called).toBe(0);
  });

  it('白名单按请求方 World 各算各的:同一把工具换个 World 请求就成了越权', async () => {
    live = await rig({ request: async () => ({ text: 'ok' }) });
    const mine = await live.host().cognition!.request({ brief: '自家的', tools: ['mc_goal'] });
    const theirs = await live.otherHost().cognition!.request({ brief: '别家的', tools: ['mc_goal'] });
    expect(mine).toEqual({ text: 'ok' });
    expect(theirs).toHaveProperty('error');
  });
});

describe('认知外包 · 并发记账与用量归账', () => {
  it("Persona 可读取在途请求数，Core 不限制并发", async () => {
    const seen: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const bothEntered = new Promise<void>((resolve) => { entered = resolve; });
    live = await rig({
      request: async (_req, ctx) => {
        seen.push(ctx.running);
        if (seen.length === 2) entered();
        await gate;
        return { text: 'ok' };
      },
    });

    const a = live.host().cognition!.request({ brief: '第一件' });
    const b = live.host().cognition!.request({ brief: '第二件' });
    await bothEntered;
    expect(seen).toEqual([1, 2]);

    release();
    await Promise.all([a, b]);
    await live.host().cognition!.request({ brief: '第三件' });
    expect(seen).toEqual([1, 2, 1]);
  });

  it('人格实现走 spawnFork:工具装进 fork,用量归到它自己的声明上', async () => {
    let api: CoreApi | null = null;
    const impl: PersonaCognition = {
      request: async (req, ctx) => ({
        text: await api!.spawnFork({
          id: 'cognition',
          messages: records([{ role: 'user', content: req.brief }]),
          tools: ctx.tools,
        }),
      }),
    };
    live = await rig(impl);
    api = live.api;
    live.llm.fallback = () => textReply('图出好了');

    const out = await live.host().cognition!.request({
      brief: '设计 home-v2',
      tools: ['mc_blueprint'],
    });

    expect(out).toEqual({ text: '图出好了' });
    const call = live.llm.calls.find((c) => c.tools?.some((t) => t.name === 'mc_blueprint'));
    expect(call).toBeDefined();
    expect(call!.spec.model).toBe(activeSpec(makeCfg()).model);
    // cognition 不重复记录 spawnFork 已计入的用量。
    const stats = live.core.sessions.list().find((s) => s.role === 'cognition');
    expect(stats?.calls).toBe(1);
  });
});
