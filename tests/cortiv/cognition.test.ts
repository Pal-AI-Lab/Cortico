import { FixtureForkOptions as ForkOptions, FixtureSessionInfo as SessionInfo } from '../core/fixture-protocol.ts';
import { records, messages as legacyMessages } from '../core/fixture-protocol.ts';
/** Persona cognition 受理测试：继承前缀并裁剪不配平的工具尾、限定工具集合、第一人称产出、单实例、超时、开关与错误返回。spawnFork 使用测试替身；模型配置属于 Provider。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COGNITION, CortiV, balancedSnapshot } from '../../bots/cortiv/persona/persona.ts';
import type { ChatMessage } from '../core/fixture-types.ts';
import type { CognitionContext, CognitionResult, ToolDef } from '../../src/core/types.ts';
import { makeFakeHarnessApi, makeTool } from '../core/helpers.ts';
import { readGroupValues } from '../../src/core/config-schema.ts';
import definition, { CORTIV_COGNITION_CONFIG_GROUP } from '../../bots/cortiv/index.ts';


/** 主 session 的出线态快照:前缀 + 一轮已配平的对话 */
const SNAPSHOT: ChatMessage[] = [
  { role: 'system', content: '(前缀)' },
  { role: 'user', content: '观众:盖个房子吧' },
  { role: 'assistant', content: '好啊', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'speak', arguments: '{}' } }] },
  { role: 'tool', content: '[已播出]', tool_call_id: 'c1' },
];

interface Rig {
  persona: CortiV;
  forks: ForkOptions[];
  /** spawnFork 的返回;默认交回一段结论 */
  reply: (opts: ForkOptions) => Promise<string>;
  /** cognition 声明当前在跑的 fork 数(core 的并发记账) */
  forkRunning: { n: number };
  dir: string;
}

let live: Rig | null = null;
afterEach(() => {
  vi.useRealTimers();
  if (live) rmSync(live.dir, { recursive: true, force: true });
  live = null;
});

function rig(opts: { enabled?: () => boolean; snapshot?: ChatMessage[] } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'cortiv-cog-'));
  const persona = new CortiV({
    memoryDir: dir,
    ...(opts.enabled ? { cognitionEnabled: opts.enabled } : {}),
  });
  const state: Rig = {
    persona,
    dir,
    forks: [],
    forkRunning: { n: 0 },
    reply: async () => '图出好了:home-v2,存在 minecraft/蓝图/home-v2.json',
  };
  persona.attach(
    makeFakeHarnessApi({
      spawnFork: async (o) => {
        state.forks.push(o);
        return state.reply(o);
      },
      sessionInfo: (id): SessionInfo => ({
        id,
        running: id === COGNITION ? state.forkRunning.n : 0,
        snapshot: id === 'main' ? (opts.snapshot ?? SNAPSHOT) : null,
        estTokens: null,
        hardTokens: null,
      }),
    }),
  );
  live = state;
  return state;
}

function ctx(patch: Partial<CognitionContext> = {}): CognitionContext {
  return { worldId: 'minecraft', tools: [], running: 1, ...patch };
}

/** 框架消息 = fork messages 的最后一条(前面全是继承来的快照) */
function frameOf(opts: ForkOptions): string {
  return opts.messages[opts.messages.length - 1].content;
}

describe('认知外包受理 · 声明', () => {
  it('声明里没有模型,轮数 hard 8 / soft 6', () => {
    const { persona } = rig();
    const decl = persona.declareSessions().find((d) => d.id === COGNITION);
    expect(decl).toBeTruthy();
    expect(decl).not.toHaveProperty('spec');
    expect(decl!.rounds()).toEqual({ soft: 6, hard: 8 });
    expect(decl!.persistent).toBe(false);
    expect(decl!.receivesEvents).toBe(false);
    expect(decl!.label).toContain('代想');
  });

  it('梦与主 session 的声明照旧在(新增一条,不是替换)', () => {
    const ids = rig().persona.declareSessions().map((d) => d.id);
    expect(ids).toContain('main');
    expect(ids).toContain('dream');
    expect(ids).toContain(COGNITION);
  });
});

describe('认知外包受理 · 全局开关', () => {
  it('默认开', () => {
    expect(rig().persona.cognition.enabled!()).toBe(true);
  });

  it('每次现读:控制台上关掉立即生效', () => {
    let on = true;
    const { persona } = rig({ enabled: () => on });
    expect(persona.cognition.enabled!()).toBe(true);
    on = false;
    expect(persona.cognition.enabled!()).toBe(false);
  });
});

describe('认知外包受理 · 保留前缀与框架消息', () => {
  it('fork 继承主 session 出线态快照,末尾追一条任务框架消息', async () => {
    const r = rig();
    await r.persona.cognition.request({ brief: '设计一间会呼吸的小屋' }, ctx());
    expect(r.forks).toHaveLength(1);
    const msgs = r.forks[0].messages;
    expect(msgs.slice(0, SNAPSHOT.length)).toEqual(SNAPSHOT);
    expect(msgs).toHaveLength(SNAPSHOT.length + 1);
    expect(msgs[msgs.length - 1].role).toBe('user');
    expect(r.forks[0].id).toBe(COGNITION);
  });

  it('框架消息写明 brief 的来源身份:是 World 交办的文字,不是她自己的念头', async () => {
    const r = rig();
    await r.persona.cognition.request({ brief: '设计一间会呼吸的小屋' }, ctx());
    const frame = frameOf(r.forks[0]);
    expect(frame).toContain('minecraft');
    expect(frame).toContain('交办');
    expect(frame).toContain('设计一间会呼吸的小屋');
    expect(frame).toContain('不是你自己的想法');
    // fork 与主意识是同一个自我,交回 World 的正文必须维持第一人称。
    expect(frame).toContain('第一人称');
    expect(frame).toContain('同一个“我”');
    expect(frame).toContain('最后一段话');
    // 成品存哪、笔记只记键(与 MEMORY_NOTE 同一句约定)
    expect(frame).toContain('minecraft/蓝图/');
  });

  it('框架消息交代这次能用的 World 工具;一把没给时也说清', async () => {
    const r = rig();
    await r.persona.cognition.request(
      { brief: '出图' },
      ctx({ tools: [makeTool('mc_blueprint', 'ok')] }),
    );
    expect(frameOf(r.forks[0])).toContain('mc_blueprint');

    r.forks.length = 0;
    await r.persona.cognition.request({ brief: '光想想' }, ctx());
    expect(frameOf(r.forks[0])).toContain('一把工具都没给');
  });

  it('hint 是建议不是指令:说出来,但预算仍报自己的 8 轮', async () => {
    const r = rig();
    await r.persona.cognition.request({ brief: '出图', hint: { rounds: 20 } }, ctx());
    const frame = frameOf(r.forks[0]);
    expect(frame).toContain('20 轮');
    expect(frame).toContain('最多 8 轮');
  });

  it('快照末尾悬空的 tool_call 先裁掉(请求正是从那只手里发出来的)', async () => {
    const pending: ChatMessage[] = [
      ...SNAPSHOT,
      {
        role: 'assistant',
        content: '我想想怎么盖',
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'mc_blueprint', arguments: '{}' } }],
      },
    ];
    const r = rig({ snapshot: pending });
    await r.persona.cognition.request({ brief: '出图' }, ctx());
    const msgs = r.forks[0].messages;
    expect(msgs.slice(0, SNAPSHOT.length)).toEqual(SNAPSHOT);
    expect(msgs).toHaveLength(SNAPSHOT.length + 1);
    expect(msgs.some((m) => m.tool_calls?.some((c) => c.id === 'c2'))).toBe(false);
  });

  it('balancedSnapshot:配平的原样留,半截的裁到最后一个配平位', () => {
    expect(legacyMessages(balancedSnapshot(records(SNAPSHOT)))).toEqual(SNAPSHOT);
    expect(balancedSnapshot([])).toEqual([]);
    const half: ChatMessage[] = [
      { role: 'user', content: 'a' },
      {
        role: 'assistant',
        content: 'b',
        tool_calls: [
          { id: 'x', type: 'function', function: { name: 't', arguments: '{}' } },
          { id: 'y', type: 'function', function: { name: 't', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'x' },
    ];
    expect(legacyMessages(balancedSnapshot(records(half)))).toEqual([{ role: 'user', content: 'a' }]);
  });

  it('主 session 还没有快照(装配期/刚起):只发框架消息,不炸', async () => {
    const r = rig({ snapshot: [] });
    const out = await r.persona.cognition.request({ brief: '出图' }, ctx());
    expect(out).toHaveProperty('text');
    expect(r.forks[0].messages).toHaveLength(1);
  });
});

describe('认知外包受理 · 工具面', () => {
  it('World 点名的那几把在前,她自己的工作区文件工具在后;别的一把没有', async () => {
    const r = rig();
    const modTools: ToolDef[] = [makeTool('mc_blueprint', 'ok'), makeTool('mc_goal', 'ok')];
    await r.persona.cognition.request({ brief: '出图' }, ctx({ tools: modTools }));
    const names = (r.forks[0].tools ?? []).map((t) => t.name);
    expect(names.slice(0, 2)).toEqual(['mc_blueprint', 'mc_goal']);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_files');
    expect(names).not.toContain('end_turn');
    expect(names.some((n) => n.startsWith('vtuber_'))).toBe(false);
  });
});

describe('认知外包受理 · 四条路的返回', () => {
  it('正常:交回 fork 的最后一段话,并给撞顶留了 capNote', async () => {
    const r = rig();
    const out = await r.persona.cognition.request({ brief: '出图' }, ctx());
    expect(out).toEqual({ text: '图出好了:home-v2,存在 minecraft/蓝图/home-v2.json' });
    expect(r.forks[0].capNote).toContain('8 轮');
    expect(r.forks[0].capNote).toContain('没想完');
  });

  it('正忙(同 World 第二件):直说排队没开,不再开一个 fork', async () => {
    const r = rig();
    const out = await r.persona.cognition.request({ brief: '第二件' }, ctx({ running: 2 }));
    expect(out).toEqual({ error: '上一件后台思考还没结束,排队没开,稍后再请' });
    expect(r.forks).toHaveLength(0);
  });

  it('正忙(别的 World 占着这条 session):同样挡下', async () => {
    const r = rig();
    r.forkRunning.n = 1;
    const out = await r.persona.cognition.request({ brief: '插队' }, ctx());
    expect(out).toHaveProperty('error');
    expect(r.forks).toHaveLength(0);
  });

  it('超时:15 分钟到点先让工具循环收线,再认超时', async () => {
    vi.useFakeTimers();
    const r = rig();
    // 永不返回的 fork:模拟一次卡住的构思
    r.reply = () => new Promise<string>(() => {});
    const pending = r.persona.cognition.request({ brief: '想不完的事' }, ctx());
    await vi.advanceTimersByTimeAsync(60_000);
    const stopWhen = r.forks[0].stopWhen!;
    expect(stopWhen()).toBe(false);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(stopWhen()).toBe(true);
    await expect(pending).resolves.toEqual({ error: '后台思考超时(15 分钟),已放弃' });
  });

  it('实现内部炸了:兜成一句人话的 error,不炸穿 World', async () => {
    const r = rig();
    r.reply = async () => { throw new Error('这一档没配模型'); };
    const out = (await r.persona.cognition.request({ brief: '出图' }, ctx())) as { error: string };
    expect(out.error).toContain('这一档没配模型');
    expect(out).not.toHaveProperty('text');
  });

  it('跑完却一句话都没说:当没交稿,不把空串当结论交回去', async () => {
    const r = rig();
    r.reply = async () => '   ';
    const out = await r.persona.cognition.request({ brief: '出图' }, ctx());
    expect(out).toHaveProperty('error');
  });

  it('控制台上有这一格:归Persona、跟人格页走、默认开、读的是真配置', () => {
    const prop = CORTIV_COGNITION_CONFIG_GROUP.schema.properties['cognition.enabled'];
    expect(prop?.type).toBe('boolean');
    expect(prop.title).toContain('请托');
    expect(prop['x-hot']).toBe(true);
    expect(CORTIV_COGNITION_CONFIG_GROUP.owner).toBe('persona');

    const defaults = definition.defaults();
    expect(defaults.cognition.enabled).toBe(true);
    // 声明的读取路径指向真配置
    expect(readGroupValues(defaults, CORTIV_COGNITION_CONFIG_GROUP)['cognition.enabled']).toBe(true);
    const off = { ...defaults, cognition: { enabled: false } };
    expect(readGroupValues(off, CORTIV_COGNITION_CONFIG_GROUP)['cognition.enabled']).toBe(false);
  });

  it('还没接上 core:如实说这次没受理', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortiv-cog-bare-'));
    try {
      const persona = new CortiV({ memoryDir: dir });
      const out: CognitionResult = await persona.cognition.request({ brief: '出图' }, ctx());
      expect(out).toHaveProperty('error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
