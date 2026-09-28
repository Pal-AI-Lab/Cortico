/**
 * executor 行为测试 第 3/4 份(见 executor-harness.ts)。
 * 分份只为并行,按实测耗时配平;哪个 describe 落在哪一份没有语义。
 */
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dropOwnedGoal, Executor, findFishingSpot, fishWaitMs, goalOwnerKind, isOpenFishingWater,
  Reflexes, parseSteps, planFishingCasts, releaseBody, renderQueue, renderRouteMenu, setOwnedGoal,
  type RouteProbe, type SkillCall, type TargetDiag, type TaskReport,
} from '../../../src/worlds/minecraft/executor.ts';
import { defaultPolicy } from '../../../src/worlds/minecraft/policy.ts';
import { ChestBook } from '../../../src/worlds/minecraft/chests.ts';
import { MinecraftLog } from '../../../src/worlds/minecraft/log.ts';
import { BowController, type BowEvent } from '../../../src/worlds/minecraft/ranged.ts';
import {
  log,
  nextTaskId,
  sleep,
  waitUntil,
  makeExecutor,
  V,
  FakeGoal,
  terrainGoto,
  combatBot,
  makeExecutorOn,
  makeExecutorWith,
  tableCraftBot,
  furnaceBot,
  fakePathfinder,
} from './executor-harness.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('显式维度穿越', () => {
  it('transit 走到门边后亲自踏入,只在维度变化且落点稳定后完成', async () => {
    const bot = combatBot({});
    const game = { dimension: 'overworld' };
    Object.assign(bot, { game });
    bot.blockAt = ((p: V) => (
      Math.floor(p.x) === 10 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0
        ? { name: 'nether_portal' }
        : { name: 'air' }
    )) as typeof bot.blockAt;
    bot.pathfinder.goto = async () => { bot.entity.position = new V(9.5, 64, 0.5); };
    let crossing = false;
    bot.setControlState = ((key: string, value: boolean) => {
      bot.controls.push([key, value]);
      if (key !== 'forward' || !value || crossing) return;
      crossing = true;
      bot.entity.position = new V(10.5, 64, 0.5);
      setTimeout(() => {
        game.dimension = 'the_nether';
        bot.entity.position = new V(-32.5, 70, 15.5);
      }, 20);
    }) as typeof bot.setControlState;

    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'transit', at: [10, 64, 0] }, { skill: 'chat', text: '穿越后继续' }]);
    await waitUntil(() => reports.length === 1, 3000);

    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('穿门成功:主世界 (10, 64, 0) → 下界 (-33, 70, 15)');
    expect(bot.controls).toContainEqual(['forward', true]);
    expect(bot.controls).toContainEqual(['forward', false]);
    expect(bot.said).toContain('穿越后继续');
  });

  it('transit 末地传送门:框架挡着平走进不去,跳进去之后维度换成末地才完成', async () => {
    const bot = combatBot({});
    const game = { dimension: 'overworld' };
    Object.assign(bot, { game });
    bot.blockAt = ((p: V) => (
      Math.floor(p.x) === 10 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0
        ? { name: 'end_portal' }
        : { name: 'air' }
    )) as typeof bot.blockAt;
    bot.pathfinder.goto = async () => { bot.entity.position = new V(8.5, 64, 0.5); };
    let crossing = false;
    bot.setControlState = ((key: string, value: boolean) => {
      bot.controls.push([key, value]);
      // 只有跳起来才越得过 13/16 格高的框架
      if (key !== 'jump' || !value || crossing) return;
      crossing = true;
      bot.entity.position = new V(10.5, 64, 0.5);
      setTimeout(() => {
        game.dimension = 'the_end';
        bot.entity.position = new V(100.5, 49, 0.5);
      }, 20);
    }) as typeof bot.setControlState;

    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'transit', at: [10, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 3000);
    expect(reports[0].kind).toBe('done');
    expect(bot.controls).toContainEqual(['jump', true]);
  });

  it('transit 折跃门:维度不变,按人被挪走的距离判穿过去', async () => {
    const bot = combatBot({});
    Object.assign(bot, { game: { dimension: 'the_end' } });
    bot.blockAt = ((p: V) => (
      Math.floor(p.x) === 10 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0
        ? { name: 'end_gateway' }
        : { name: 'air' }
    )) as typeof bot.blockAt;
    bot.pathfinder.goto = async () => { bot.entity.position = new V(8.5, 64, 0.5); };
    let crossing = false;
    bot.setControlState = ((key: string, value: boolean) => {
      bot.controls.push([key, value]);
      if (key !== 'jump' || !value || crossing) return;
      crossing = true;
      bot.entity.position = new V(10.5, 64, 0.5);
      setTimeout(() => { bot.entity.position = new V(1010.5, 70, 0.5); }, 20);
    }) as typeof bot.setControlState;

    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'transit', at: [10, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 3000);
    expect(reports[0].kind).toBe('done');
  });

  it('transit 折跃门:从百格外走到门边不算穿过去,一直没被传走就受阻', async () => {
    const bot = combatBot({});
    Object.assign(bot, { game: { dimension: 'the_end' } });
    bot.entity.position = new V(-90.5, 64, 0.5);
    bot.blockAt = ((p: V) => (
      Math.floor(p.x) === 10 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0
        ? { name: 'end_gateway' }
        : { name: 'air' }
    )) as typeof bot.blockAt;
    bot.pathfinder.goto = async () => { bot.entity.position = new V(8.5, 64, 0.5); };

    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'transit', at: [10, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 30_000);
    expect(reports[0].kind).toBe('blocked');
  });

  it('transit 没成功时阻断全部尾巴，即使后一步没有物品因果依赖', async () => {
    const bot = combatBot({});
    Object.assign(bot, { game: { dimension: 'overworld' } });
    bot.blockAt = (() => ({ name: 'air' })) as typeof bot.blockAt;
    const { exec, reports } = makeExecutorOn(bot);

    exec.submit([{ skill: 'transit', at: [10, 64, 0] }, { skill: 'chat', text: '不该在主世界执行' }]);
    await waitUntil(() => reports.length === 1, 3000);

    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('不是传送门方块');
    expect(reports[0].text).toContain('没有完成可信的维度穿越');
    expect(bot.said).not.toContain('不该在主世界执行');
  });

  it('goto 的维度前置条件不符时不寻路,受理回执也不计算两边直线距离', async () => {
    const bot = combatBot({});
    Object.assign(bot, { game: { dimension: 'overworld' } });
    const goto = vi.fn(async () => {});
    bot.pathfinder.goto = goto;
    const { exec, reports } = makeExecutorOn(bot);

    const accepted = exec.submit([{
      skill: 'goto', at: [-33, 70, 15], dimension: 'minecraft:the_nether',
    }]);
    await waitUntil(() => reports.length === 1);

    expect(accepted).not.toContain('直线');
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('这处坐标属于下界,我当前在主世界');
    expect(goto).not.toHaveBeenCalled();
  });
});

/** 带容器账本的执行器:账本相关技能(smelt 入账 / take at / 试算点名)用它 */

describe('队列:排着等,一件一件做', () => {
  /** 一步走得通、但要等 gate 才走完的慢任务 */
  const slowBot = (gate: Promise<void>) =>
    combatBot({ goto: async (arrive) => { await gate; arrive(); } });

  it('新任务追加到运行中任务之后', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const bot = slowBot(gate);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'chat', text: '原计划' }]);
    const receipt = exec.submit([{ skill: 'chat', text: '后排的' }]);
    expect(receipt).toContain('排进队尾');
    expect(receipt).toContain('前面还有 1 件');
    expect(reports).toHaveLength(0); // 没有顶替汇报:前一件一直活着
    expect(exec.status().waiting).toHaveLength(1);
    release!();
    // 两件事各自有各自的回报,前一件做完后一件才开始
    await waitUntil(() => reports.length === 2, 5000);
    expect(reports.map((r) => r.kind)).toEqual(['done', 'done']);
    expect(bot.said).toEqual(['原计划', '后排的']);
    expect(reports[0].text).toContain('任务#1');
    expect(reports[1].text).toContain('任务#2');
  });

  it('队列空着就当场开做', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    expect(exec.submit([{ skill: 'chat', text: 'x' }])).toContain('任务#1 收下了,排在第 1/1 步:说: x');
    await waitUntil(() => reports.length === 1);
    expect(bot.said).toEqual(['x']);
  });

  // 一件任务受阻不撤销后续队列；显式 mc_stop 才清队列。
  it('一件受阻不撤后面排着的:那一件照样轮到它做,各报各的', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    // 不认识的方块 → 第一件当场受阻
    exec.submit([{ skill: 'collect', block: 'nonexistent_block', count: 1 }]);
    exec.submit([{ skill: 'chat', text: '本来还要说的' }]);
    await waitUntil(() => reports.length === 2);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).not.toContain('都撤了');
    // 后面那件照常做完,并且有它自己的回报
    expect(reports[1].kind).toBe('done');
    expect(reports[1].text).toContain('任务#2');
    expect(bot.said).toEqual(['本来还要说的']);
    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
  });

  it('mc_stop 清空:手上这件停下,排着的一并撤,两件事写在同一句里', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const { exec } = makeExecutorOn(slowBot(gate));
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    exec.submit([{ skill: 'chat', text: '排着的' }]);
    const receipt = exec.clear()!;
    expect(receipt).toContain('已叫停任务#1');
    expect(receipt).toContain('撤掉了排在后面的');
    expect(receipt).toContain('任务#2');
    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
    expect(exec.clear()).toBeNull();
    release!();
  });

  it('status:手上这件做到第几步、后面排着谁,是同一份数据', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const { exec } = makeExecutorOn(slowBot(gate));
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'chat', text: '之后' }]);
    exec.submit([{ skill: 'chat', text: '下一件' }]);
    await waitUntil(() => exec.status().running !== null);
    const st = exec.status();
    expect(st.running).toMatchObject({ id: 1, stepIndex: 0, stepCount: 2, step: '去坐标 (10,64,10)' });
    expect(st.waiting).toEqual([{ id: 2, label: '说: 下一件' }]);
    const line = renderQueue(st);
    expect(line).toContain('正在做任务#1');
    expect(line).toContain('第 1/2 步');
    expect(line).toContain('后面排着 任务#2');
    release!();
  });

  // 受理刻两个耗时必然都是 0(replace 下单的 976/1338 都长这样),印出来只是把
  // 「刚开跑」说第二遍;走起来之后照旧报读数。
  it('刚开跑那一拍不印两个零耗时', () => {
    const fresh = renderQueue({
      running: {
        id: 1, label: '去坐标 (3,64,3)', step: '去坐标 (3,64,3)', stepIndex: 0, stepCount: 1,
        elapsedMs: 0, taskElapsedMs: 0, count: null, pos: null,
      },
      waiting: [],
    });
    expect(fresh).toContain('第 1/1 步');
    expect(fresh).not.toContain('已跑');
    const running = renderQueue({
      running: {
        id: 1, label: '去坐标 (3,64,3)', step: '去坐标 (3,64,3)', stepIndex: 0, stepCount: 1,
        elapsedMs: 4_000, taskElapsedMs: 9_000, count: null, pos: null,
      },
      waiting: [],
    });
    expect(running).toContain('已跑 4s');
    expect(running).toContain('整单已跑 9s');
  });

  /**
   * 反射持有身体时，队列状态须点明执行权归属，即使普通任务尚未运行。
   */
  it('反射持身时队列行照实点名占着手的是谁,不再说「手上没有在做的事」', () => {
    const held = renderQueue({
      running: null,
      waiting: [{ id: 262, label: '去坐标 (5,64,5)' }],
      hold: '防溺水上浮找岸',
    });
    expect(held).not.toContain('手上没有在做的事');
    expect(held).toContain('手上是防溺水上浮找岸(不是任务),队列头空着');
    expect(held).toContain('后面排着 任务#262');
    // 真空着的时候一个字都不改
    const idle = renderQueue({ running: null, waiting: [], hold: null });
    expect(idle).toContain('手上没有在做的事');
  });

  it('状态表里的 hold 与受理句读同一份来源:反射占着身体时两处不打架', async () => {
    let busy: string | null = '正在跟怪打';
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => combatBot({}) as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      busyWith: () => busy,
    });
    const receipt = exec.submit([{ skill: 'chat', text: '排着' }]);
    expect(receipt).toContain('排上了');
    expect(receipt).toContain('正在跟怪打');
    expect(exec.status().hold).toBe('正在跟怪打');
    expect(renderQueue(exec.status())).toContain('手上是正在跟怪打(不是任务)');
    busy = null;
    exec.shutdown();
  });

  /**
   * elapsedMs 是当前步骤的用时,不是整条任务的累计用时。混入前序步骤的耗时会
   * 误判卡点:前面走了 70 秒、合成刚开始时若按整条任务算,会读成"合成卡住了",
   * 实际卡住的是回工作台那段路。
   */
  it('心跳那行的"已跑"是这一步的,不是整条任务的', async () => {
    const gates: Array<() => void> = [];
    const bot = combatBot({
      goto: async (arrive) => {
        await new Promise<void>((r) => gates.push(r));
        arrive();
      },
    });
    const { exec } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'goto', at: [20, 64, 20] }]);
    await waitUntil(() => gates.length === 1);
    await sleep(1100); // 第 1 步磨了 1.1 秒
    gates[0]();
    await waitUntil(() => exec.status().running?.stepIndex === 1);
    const st = exec.status();
    expect(renderQueue(st)).toContain('第 2/2 步');
    expect(st.running!.elapsedMs).toBeLessThan(200); // 第 2 步刚开始,不背前面那 1.1 秒
    // 整单那一份另给:只看步骤耗时读不出「这一单已经磨了多久」
    expect(st.running!.taskElapsedMs).toBeGreaterThan(1000);
    expect(renderQueue(st)).toContain('整单已跑');
    gates[1]?.();
  });

  it('反射抢占把排着的一并撤掉:逃完之后原地写的计划已经不知道自己在哪', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const { exec, reports } = makeExecutorOn(slowBot(gate));
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    exec.submit([{ skill: 'chat', text: '排着的' }]);
    exec.preempt('脱离战斗');
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain('自保反射');
    expect(reports[0].text).toContain('排在后面的 1 件也撤了');
    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
    release!();
    await sleep(50);
    expect(reports.filter((r) => r.kind === 'done')).toHaveLength(0);
  });
});

/**
 * 三种队列模式均构造一件在跑、一件排队的状态，以区分各模式的队列处理。
 */
describe('queue 三模式:她说了要撤才撤', () => {
  const slowBot = (gate: Promise<void>) =>
    combatBot({ goto: async (arrive) => { await gate; arrive(); } });

  /** 一件在跑(卡在 gate 上)+ 一件排着 */
  function twoDeep() {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const rig = makeExecutorOn(slowBot(gate));
    rig.exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    rig.exec.submit([{ skill: 'chat', text: '排着的' }], 'append');
    return { ...rig, release: () => release!() };
  }

  it('replace(缺省):正在跑的继续跑,排着的全撤,新的接在它后面', async () => {
    const { exec, reports, release } = twoDeep();
    const receipt = exec.submit([{ skill: 'chat', text: '改主意了' }]);
    // 撤掉了谁必须点名:排队深度从此最多一层,这是这个缺省唯一的对冲
    expect(receipt).toContain('撤掉了排在后面的 任务#2「说: 排着的」');
    expect(receipt).toContain('前面还有 1 件');
    expect(exec.status().running!.id).toBe(1); // 手上这件没被动
    expect(exec.status().waiting).toEqual([{ id: 3, label: '说: 改主意了' }]);
    // 被撤销任务仍须投递终态，避免结果只出现在受理时的上下文窗口。
    expect(reports.map((r) => [r.kind, r.taskId])).toEqual([['cancelled', 2]]);
    expect(reports[0].text).toContain('任务#2没做完:一步都没开始,被新任务#3 顶替');
    release();
    await waitUntil(() => reports.length === 3, 5000);
    expect(reports.map((r) => r.taskId)).toEqual([2, 1, 3]);
  });

  it('append:排着的都保留,新的排队尾', async () => {
    const { exec, release } = twoDeep();
    const receipt = exec.submit([{ skill: 'chat', text: '再加一件' }], 'append');
    expect(receipt).not.toContain('撤掉');
    expect(receipt).toContain('前面还有 2 件');
    expect(exec.status().waiting.map((w) => w.id)).toEqual([2, 3]);
    release();
  });

  it('now:中断手上这件并报它做到第几步,排着的保留,新的插到队头立刻开做', async () => {
    const { exec, reports, release } = twoDeep();
    await waitUntil(() => exec.status().running !== null);
    const receipt = exec.submit([{ skill: 'chat', text: '先插火把' }], 'now');
    expect(receipt).toContain('已叫停任务#1');
    // 被顶替的任务尚未执行任何步骤时，回执须明确说明。
    expect(receipt).toContain('一步都没跑过');
    expect(receipt).toContain('它卡在第 1/1 步');
    expect(receipt).toContain('任务#3 收下了,排在第 1/1 步:说: 先插火把');
    // 被顶替任务补一条 cancelled 终态，避免结果只出现在受理时的上下文窗口。
    expect(reports.map((r) => [r.kind, r.taskId])).toEqual([['cancelled', 1]]);
    expect(reports[0].text).toContain('做到第 1/1 步,被queue:"now" 的新任务顶替');
    // 排着的原样还在,插的这件走在它前面
    expect(exec.status().running!.id).toBe(3);
    expect(exec.status().waiting).toEqual([{ id: 2, label: '说: 排着的' }]);
    await waitUntil(() => reports.length === 3, 5000);
    expect(reports.map((r) => r.taskId)).toEqual([1, 3, 2]); // 被掐掉的 #1 排在最前
    release();
  });

  it('now 不抢正在逃的那件:急件排队头,逃完立刻做', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const bot = combatBot({
      entities: { '1': { name: 'zombie', type: 'mob', position: new V(2, 64, 2), isValid: true } },
      goto: async (arrive) => { await gate; arrive(); },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'flee', distance: 24 }]);
    await waitUntil(() => exec.escaping);
    const receipt = exec.submit([{ skill: 'chat', text: '先插火把' }], 'now');
    expect(receipt).toContain('正在自保');
    expect(receipt).toContain('脱身之后立刻做这件');
    expect(exec.status().running!.id).toBe(1); // 没被抢
    release!();
    await waitUntil(() => reports.length === 2, 5000);
    expect(reports.map((r) => r.taskId)).toEqual([1, 2]);
    expect(bot.said).toEqual(['先插火把']);
  });

  /**
   * 取消回执包含各步骤下场，包括已完成、执行中和未开始的步骤；沿 cancelled 通道攒批投递，不单独唤醒。
   */
  it('queue:now 顶替:被掐掉那一单的各步下场跟着终态一起回投', async () => {
    let release: (() => void) | null = null;
    const bot = combatBot({
      goto: async (arrive) => { await new Promise<void>((r) => { release = r; }); arrive(); },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'chat', text: '第一步做成' },
      { skill: 'goto', at: [10, 64, 10] },
      { skill: 'chat', text: '轮不到' },
    ]);
    await waitUntil(() => release !== null, 3000);
    exec.submit([{ skill: 'chat', text: '急件' }], 'now');

    const cut = reports.find((r) => r.kind === 'cancelled' && r.taskId === 1)!;
    expect(cut.text).toContain('做到第 2/3 步');
    expect(cut.text).toContain('各步下场:');
    // 已完成的第 1 步仍报告成功。
    expect(cut.text).toContain('第 1/3 步 说: 第一步做成:做成了');
    // 正在跑的那一步是"做到一半被撤",不是"跳过"也不是不提
    expect(cut.text).toContain('第 2/3 步 去坐标 (10,64,10):做到一半被撤');
    // 压根没轮到的第 3 步不出现在账上
    expect(cut.text).not.toContain('第 3/3 步');
    release!();
  });

  it('一步都没跑过的单被撤:只说一步都没开始,不编各步下场', () => {
    const bot = combatBot({
      goto: async () => { await new Promise<void>(() => {}); },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    exec.submit([{ skill: 'chat', text: '排着的' }], 'append');
    exec.clear();
    const queued = reports.find((r) => r.kind === 'cancelled' && r.taskId === 2)!;
    expect(queued.text).toContain('一步都没开始');
    expect(queued.text).not.toContain('各步下场');
  });

  it('自保反射抢占:被打飞那一单的各步下场也一起回投', async () => {
    let release: (() => void) | null = null;
    const bot = combatBot({
      goto: async (arrive) => { await new Promise<void>((r) => { release = r; }); arrive(); },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'chat', text: '先说一句' }, { skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => release !== null, 3000);
    exec.preempt('血量过低,脱离战斗');
    const sup = reports.find((r) => r.kind === 'superseded')!;
    expect(sup.text).toContain('被自保反射抢占');
    expect(sup.text).toContain('第 1/2 步 说: 先说一句:做成了');
    expect(sup.text).toContain('第 2/2 步 去坐标 (10,64,10):做到一半被撤');
    release!();
  });

  it('mc_stop 语义一个字没变:全停全撤,之后什么都不做', async () => {
    const { exec, release } = twoDeep();
    const receipt = exec.clear()!;
    expect(receipt).toContain('已叫停任务#1');
    expect(receipt).toContain('撤掉了排在后面的');
    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
    release();
  });
});

describe('战逃与水面', () => {
  it('flee 的目标只判 XZ:背对敌人的水平方向,高度不进判据', async () => {
    const goalsSeen: FakeGoal[] = [];
    const bot = combatBot({
      entities: { '1': { name: 'zombie', type: 'mob', position: new V(3, 70, 4), isValid: true } },
    });
    bot.entity.position = new V(0.5, 70, 0.5);
    bot.pathfinder.goto = async (g: FakeGoal) => {
      goalsSeen.push(g);
      bot.entity.position = new V(g.x!, 70, g.z!);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'flee', distance: 24 }]);
    await waitUntil(() => reports.length === 1, 5000);

    expect(goalsSeen).toHaveLength(1);
    expect(goalsSeen[0].constructor.name).toBe('GoalNearXZ');
    expect(goalsSeen[0].y).toBeUndefined();
    expect(goalsSeen[0].x).toBe(-13);
    expect(goalsSeen[0].z).toBe(-19);
    expect(reports[0].kind).toBe('done');
  });

  /**
   * 逃跑终点所在柱比脚下高 6 格，仍须允许水平目标成立，不能被起点 Y 附近的三维球排除。
   */
  it('坡上的 flee:逃跑终点比脚下高 6 格也走得到,不是零位移受阻', async () => {
    const bot = combatBot({
      entities: { '1': { name: 'zombie', type: 'mob', position: new V(3, 70, 4), isValid: true } },
    });
    bot.entity.position = new V(0.5, 70, 0.5);
    bot.pathfinder.goto = terrainGoto(bot, () => 76) as never;
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'flee', distance: 24 }]);
    await waitUntil(() => reports.length === 1, 5000);

    expect(reports[0].kind).toBe('done');
    expect(bot.entity.position.x).toBe(-13);
    expect(bot.entity.position.z).toBe(-19);
    expect(bot.entity.position.y).toBe(76);
  });

  /**
   * 试算与实际行军使用同一个目标判据。
   */
  it('逃跑受阻的试算递的是这一趟真正下达的目标', async () => {
    const bot = combatBot({
      entities: { '1': { name: 'zombie', type: 'mob', position: new V(3, 70, 4), isValid: true } },
    });
    bot.entity.position = new V(0.5, 70, 0.5);
    const marched: unknown[] = [];
    // 目标不可达:goto 无错 resolve、人一步没动,收尾校验把它判成受阻
    bot.pathfinder.goto = (async (goal: unknown) => { marched.push(goal); }) as never;
    const probed: unknown[] = [];
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      probeRoutes: (_target, goal) => { probed.push(goal ?? null); return null; },
    });
    exec.submit([{ skill: 'flee', distance: 24 }]);
    await waitUntil(() => reports.length === 1, 8000);

    expect(reports[0].kind).toBe('blocked');
    expect(marched).toHaveLength(1);
    expect(probed).toEqual([marched[0]]);
  });

  /**
   * flee 自身时限覆盖持续移动但未拉开距离的状态；到期报告持续时长、距离和周围敌人数，后续步骤按依赖闸处理。
   */
  it('flee 自身时限:一直在走也甩不掉时到点收工,按读数报事实', async () => {
    const bot = combatBot({
      entities: {
        '1': { name: 'zombie', type: 'mob', position: new V(3, 70, 4), isValid: true },
        '2': { name: 'skeleton', type: 'mob', position: new V(6, 70, 6), isValid: true },
      },
    });
    bot.entity.position = new V(0.5, 70, 0.5);
    // 走得到不了:goto 永不 resolve。人却一路在挪窝,零位移看门狗因此永远不跳闸
    bot.pathfinder.goto = (async () => { await new Promise<void>(() => {}); }) as never;
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'flee', distance: 80 }, { skill: 'chat', text: '逃完再说' }]);

    for (let sec = 1; sec <= 31; sec++) {
      // 每秒往目标方向挪 2 格:一直在推进,只是 80 格永远走不满
      bot.entity.position = new V(0.5 - sec * 2, 70, 0.5 - sec * 2);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(200);

    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe('blocked');
    const text = reports[0].text;
    expect(text).toContain('没拉开:逃了 30 秒');
    expect(text).toContain('这一单要的是 80 格');
    expect(text).toContain('当初那只僵尸起手');
    // 身边此刻的读数照实报;不下"逃不掉""换个法子"这类结论
    expect(text).toContain('32 格内');
    expect(text).not.toContain('建议');
    expect(text).not.toContain('换');
    // 正常终态:整条单当场收口,后面那一步按既有因果闸处置(chat 不消费 flee 的产出,照跑)
    expect(bot.said).toEqual(['逃完再说']);
    expect(text).toContain('第 1 步没做成;这一步不用它的产出,照做了');
  });

  it('正在逃的任务不被反射抢占:flee 途中 preempt 是空操作', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const bot = combatBot({
      entities: { '1': { name: 'zombie', type: 'mob', position: new V(3, 64, 4), isValid: true } },
      goto: async (arrive) => { await gate; arrive(); },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'flee', distance: 24 }]);
    await waitUntil(() => exec.escaping);
    exec.preempt('血量过低,脱离战斗');
    expect(exec.current).not.toBeNull();
    expect(reports.filter((r) => r.kind === 'superseded')).toHaveLength(0);
    release!();
    await waitUntil(() => reports.some((r) => r.kind === 'done'));
    expect(reports.find((r) => r.kind === 'done')!.text).toContain('甩开了僵尸');
  });

  it('战斗撤退是真撤退:低于撤退线时走完撤离路线再汇报,不是丢下方向就报错', async () => {
    const path: string[] = [];
    let retreatGoal: FakeGoal | null = null;
    const bot = combatBot({
      health: 5,
      entities: { '1': { name: 'skeleton', type: 'mob', position: new V(2, 64, 0.5), isValid: true, height: 2 } },
    });
    bot.pathfinder.goto = async (goal: FakeGoal) => {
      path.push('retreat');
      retreatGoal = goal;
      bot.entity.position = new V(goal.x!, 64, goal.z!);
    };
    const { exec, reports } = makeExecutorOn(bot, 8);
    exec.submit([{ skill: 'attack', target: 'skeleton' }]);
    await waitUntil(() => reports.length === 1);
    expect(path).toEqual(['retreat']);
    expect(retreatGoal).not.toBeNull();
    const goal = retreatGoal as unknown as FakeGoal;
    expect(goal.constructor.name).toBe('GoalNearXZ');
    expect(goal.y).toBeUndefined();
    expect(goal.x).toBe(-24);
    expect(goal.z).toBe(0);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('低于撤退线');
    // 一刀没挥就不能说"打到一半":那会让她以为打过了打不过,反复重排同一单
    expect(reports[0].text).not.toContain('打到一半');
    expect(reports[0].text).toContain('没跟骷髅动手');
  });

  it('撤退线只管会还手的:3/20 血也能打猪,那是去找吃的', async () => {
    const pig = { id: 1, name: 'pig', type: 'mob', position: new V(2, 64, 0.5), isValid: true, height: 1 };
    const bot = combatBot({ health: 3, entities: { '1': pig } });
    const { exec, reports } = makeExecutorOn(bot, 10);
    bot.attack = () => { pig.isValid = false; exec.noteCombatTargetDead(1); };
    exec.submit([{ skill: 'attack', target: 'pig' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('打死了猪');
  });

  /**
   * 主动攻击猪灵属于挑衅；即使其原本中立，也须启用血线撤退。
   */
  it('主动打猪灵:血线撤退闸照样武装,不因为它名义上中立就当成打猪', async () => {
    const piglin = { id: 1, name: 'piglin', type: 'mob', position: new V(2, 64, 0.5), isValid: true, height: 2 };
    let retreated = false;
    const bot = combatBot({ health: 5, entities: { '1': piglin } });
    // 穿着金甲:被动扫描里它算中立,可我们这一步是主动打它
    bot.inventory = {
      items: () => [] as never[],
      slots: [null, null, null, null, null, { name: 'golden_helmet' }, null, null, null],
    } as never;
    bot.registry = { entitiesByName: { piglin: { metadataKeys: ['flags', 'baby'] } } } as never;
    bot.pathfinder.goto = async (goal: FakeGoal) => {
      retreated = true;
      bot.entity.position = new V(goal.x!, 64, goal.z!);
    };
    const { exec, reports } = makeExecutorOn(bot, 8);
    exec.submit([{ skill: 'attack', target: 'piglin' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(retreated).toBe(true);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('低于撤退线');
  });

  /**
   * 水下攻击的回执报告氧气读数，不因此中止操作。
   */
  it('水下打鱼:回执带氧气读数,不因此收手', async () => {
    const salmon = { id: 1, name: 'salmon', type: 'mob', position: new V(2, 64, 0.5), isValid: true, height: 1 };
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: { '1': salmon },
      health: 8,
      oxygenLevel: 4,
      players: {},
      registry: { entitiesByName: { salmon: {} } },
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async () => {},
      attack: () => {},
      blockAt: (p: V) => (p.y === 65 ? { name: 'water' } : null),
      setControlState: () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot, 10);
    bot.attack = () => { salmon.isValid = false; exec.noteCombatTargetDead(1); };
    exec.submit([{ skill: 'attack', target: 'salmon' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('人在水下,氧气 4/20');
  });

  it('近战挑最好的剑:包里有木剑和钻石剑时拿钻石的', async () => {
    const pig = { id: 1, name: 'pig', type: 'mob', position: new V(2, 64, 0.5), isValid: true, height: 1 };
    const bag = [
      { name: 'wooden_sword', type: 1, count: 1 },
      { name: 'diamond_sword', type: 2, count: 1 },
    ];
    const equipped: string[] = [];
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: { '1': pig },
      health: 20,
      players: {},
      registry: { entitiesByName: { pig: {} } },
      inventory: { items: () => bag },
      equip: async (item: { name: string }) => { equipped.push(item.name); },
      lookAt: async () => {},
      attack: () => {},
      blockAt: () => null,
      setControlState: () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    bot.attack = () => { pig.isValid = false; exec.noteCombatTargetDead(1); };
    exec.submit([{ skill: 'attack', target: 'pig' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(equipped[0]).toBe('diamond_sword');
  });

  function hybridBot(distance = 9) {
    const bow = { name: 'bow', type: 20, count: 1 };
    const arrow = { name: 'arrow', type: 21, count: 8 };
    const sword = { name: 'iron_sword', type: 22, count: 1 };
    const target = {
      id: 1, name: 'zombie', type: 'mob', username: undefined,
      position: new V(0.5 + distance, 64, 0.5), isValid: true, height: 1.8, width: 0.6,
    };
    const controls: Array<[string, boolean]> = [];
    const bot = {
      controls,
      entity: { id: 9, position: new V(0.5, 64, 0.5), onGround: false, velocity: new V(0, 0, 0) },
      entities: { '1': target },
      health: 20,
      players: {},
      registry: { entitiesByName: { zombie: {} } },
      inventory: { items: () => [bow, arrow, sword] },
      heldItem: sword as typeof sword | typeof bow,
      equip: async (item: typeof sword | typeof bow) => { bot.heldItem = item; },
      lookAt: async () => {},
      attack: () => {},
      blockAt: () => null,
      world: { raycast: () => null },
      setControlState: (key: string, value: boolean) => { controls.push([key, value]); },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return { bot, target, bow, arrow, sword };
  }

  it('attack auto 按 8/5.5 滞回:9 格拉弓、6 格保持、5.4 格切回近战', async () => {
    const { bot, target } = hybridBot(9);
    let exec!: Executor;
    let shots = 0;
    const ranged: NonNullable<ConstructorParameters<typeof Executor>[0]['ranged']> = {
      ready: () => true,
      abort: () => {},
      shoot: async (_target, ownerToken) => {
        expect(exec.ownsRanged(ownerToken)).toBe(true);
        shots += 1;
        exec.onBowEvent({ kind: 'hit', shotId: shots, targetId: 1, ownerToken, at: Date.now() });
        target.position = shots === 1 ? new V(6.5, 64, 0.5) : new V(5.9, 64, 0.5);
        return {
          kind: 'released', shotId: shots, targetId: 1, ownerToken, at: Date.now(),
          aim: new Vec3(0, 0, 0), hitWindow: { from: 0, until: 1 },
        };
      },
    };
    const made = makeExecutorOn(bot, 0, ranged);
    exec = made.exec;
    const setControl = bot.setControlState;
    bot.setControlState = (key, value) => {
      setControl(key, value);
      if (key === 'forward' && value && shots === 2) bot.entity.position = new V(3, 64, 0.5);
    };
    bot.attack = () => {
      expect(exec.acceptsRangedHit(1)).toBe(false);
      exec.noteCombatTargetHurt(1);
      target.isValid = false;
      exec.noteCombatTargetDead(1);
    };

    exec.submit([{ skill: 'attack', target: 'zombie' }]);
    await waitUntil(() => made.reports.length === 1, 5000);

    expect(made.reports[0].kind).toBe('done');
    expect(shots).toBe(2);
    expect(made.reports[0].text).toContain('挥击 1 次命中 1 次');
    expect(made.reports[0].text).toContain('放箭 2 支命中 2 支');
  });

  it('拉弓中目标死亡会撤销弓和路径,迟到的 shoot 结果不计箭', async () => {
    const { bot } = hybridBot(10);
    const goals: unknown[] = [];
    bot.pathfinder.setGoal = (goal?: unknown) => { goals.push(goal); };
    let exec!: Executor;
    let ownerToken: unknown;
    let resolveShot: ((result: { kind: 'blocked'; reason: 'aborted'; cause: 'abort' }) => void) | null = null;
    let aborts = 0;
    const ranged: NonNullable<ConstructorParameters<typeof Executor>[0]['ranged']> = {
      ready: () => true,
      abort: () => {
        aborts += 1;
        const resolve = resolveShot;
        resolveShot = null;
        resolve?.({ kind: 'blocked', reason: 'aborted', cause: 'abort' });
      },
      shoot: async (_target, token) => {
        ownerToken = token;
        return await new Promise((resolve) => { resolveShot = resolve; });
      },
    };
    const made = makeExecutorOn(bot, 0, ranged);
    exec = made.exec;
    exec.submit([{ skill: 'attack', target: 'zombie', mode: 'ranged' }]);
    await waitUntil(() => resolveShot !== null);

    expect(exec.ownsRanged(ownerToken)).toBe(true);
    goals.length = 0;
    exec.noteCombatTargetDead(1);

    expect(exec.ownsRanged(ownerToken)).toBe(false);
    expect(aborts).toBeGreaterThan(0);
    expect(goals).toEqual([null]);
    await waitUntil(() => made.reports.length === 1, 5000);
    expect(made.reports[0].kind).toBe('done');
    expect(made.reports[0].text).toContain('放箭 0 支');
  });

  it('forced ranged 中途失去 LOS:明确受阻且不暗换近战', async () => {
    const { bot } = hybridBot(10);
    let melee = 0;
    bot.attack = () => { melee += 1; };
    const ranged: NonNullable<ConstructorParameters<typeof Executor>[0]['ranged']> = {
      ready: () => true,
      abort: () => {},
      shoot: async () => ({ kind: 'blocked', reason: 'no_los' }),
    };
    const { exec, reports } = makeExecutorOn(bot, 0, ranged);
    exec.submit([{ skill: 'attack', target: 'zombie', mode: 'ranged' }]);
    await waitUntil(() => reports.length === 1, 5000);

    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没有射线');
    expect(reports[0].text).toContain('ranged 不会改用近战');
    expect(melee).toBe(0);
  });

  it('kite 先拉回 8–14 格再放箭,中窗横移而不挥刀', async () => {
    const { bot, target } = hybridBot(6);
    let exec!: Executor;
    let melee = 0;
    let backed = false;
    const originalControl = bot.setControlState;
    bot.setControlState = (key: string, value: boolean) => {
      originalControl(key, value);
      if (key === 'back' && value && !backed) {
        backed = true;
        bot.entity.position = new V(-2, 64, 0.5);
      }
    };
    bot.attack = () => { melee += 1; };
    const ranged: NonNullable<ConstructorParameters<typeof Executor>[0]['ranged']> = {
      ready: () => true,
      abort: () => {},
      shoot: async (_shotTarget, ownerToken) => {
        target.isValid = false;
        exec.noteCombatTargetDead(1);
        return {
          kind: 'released', shotId: 1, targetId: 1, ownerToken, at: Date.now(),
          aim: new Vec3(0, 0, 0), hitWindow: { from: 0, until: 1 },
        };
      },
    };
    const made = makeExecutorOn(bot, 0, ranged);
    exec = made.exec;
    exec.submit([{ skill: 'attack', target: 'zombie', mode: 'kite' }]);
    await waitUntil(() => made.reports.length === 1, 5000);

    expect(made.reports[0].kind).toBe('done');
    expect(backed).toBe(true);
    expect(bot.controls.some(([key, value]) => (key === 'left' || key === 'right') && value)).toBe(true);
    expect(melee).toBe(0);
  });

  it('低血撤退零进展时回身还手,不把原地写成已经逃脱', async () => {
    const skeleton = { id: 1, name: 'skeleton', type: 'mob', position: new V(2, 64, 0.5), isValid: true, height: 2 };
    const bot = combatBot({ health: 5, entities: { '1': skeleton } });
    bot.pathfinder.goto = async () => {};
    const { exec, reports } = makeExecutorOn(bot, 8);
    bot.attack = () => { skeleton.isValid = false; exec.noteCombatTargetDead(1); };
    exec.submit([{ skill: 'attack', target: 'skeleton' }]);
    await waitUntil(() => reports.length === 1, 5000);

    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('撤退没走开后回身打完');
    expect(reports[0].text).not.toContain('确认撤开');
  });

  it('目标只失效但没有 entityDead:不把消失误报成击杀', async () => {
    const { bot, target } = hybridBot(2);
    bot.attack = () => { target.isValid = false; };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'attack', target: 'zombie', mode: 'melee' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没有把“消失”算成击杀');
  });

  it('主动弓拉弦中撤单:task lease 失效并切槽取消,不误放箭', async () => {
    const { bot, target, bow, arrow, sword } = hybridBot(10);
    const slots = Array.from({ length: 46 }, () => null as typeof bow | typeof sword | null);
    slots[36] = bow;
    slots[37] = sword;
    Object.assign(bot.inventory, { hotbarStart: 36, slots });
    const bowBot = bot as typeof bot & {
      quickBarSlot: number;
      usingHeldItem: boolean;
      activateItem(): void;
      deactivateItem(): void;
      setQuickBarSlot(slot: number): void;
    };
    Object.assign(bowBot, {
      quickBarSlot: 0,
      usingHeldItem: false,
      activateItem: () => { bowBot.usingHeldItem = true; },
    });
    let releases = 0;
    let exec!: Executor;
    const controller = new BowController({
      getBot: () => bowBot as never,
      resolveTarget: () => target,
      leaseValid: (token) => exec?.ownsRanged(token) ?? false,
      emit: (event: BowEvent) => exec?.onBowEvent(event),
    });
    Object.assign(bowBot, {
      deactivateItem: () => { releases += 1; bowBot.usingHeldItem = false; arrow.count -= 1; },
      setQuickBarSlot: (slot: number) => {
        bowBot.quickBarSlot = slot;
        bowBot.heldItem = slots[36 + slot] ?? sword;
        bowBot.usingHeldItem = false;
      },
    });
    const made = makeExecutorOn(bowBot, 0, {
      ready: () => true,
      shoot: (shotTarget, token) => controller.shoot(shotTarget, token),
      abort: () => controller.abort(),
    });
    exec = made.exec;
    exec.submit([{ skill: 'attack', target: 'zombie', mode: 'ranged' }]);
    await waitUntil(() => bowBot.usingHeldItem, 3000);
    exec.clear();
    await waitUntil(() => !controller.active, 3000);

    expect(exec.attacking).toBe(false);
    expect(releases).toBe(0);
    expect(arrow.count).toBe(8);
    expect(made.reports.filter((report) => report.kind === 'cancelled')).toHaveLength(1);
  });

  it('主动远程中断线:旧连接任务统一 cancelled,不降级挥刀', async () => {
    const { bot } = hybridBot(10);
    let melee = 0;
    let stopShot: (() => void) | null = null;
    bot.attack = () => { melee += 1; };
    const ranged: NonNullable<ConstructorParameters<typeof Executor>[0]['ranged']> = {
      ready: () => true,
      shoot: async () => new Promise((resolve) => {
        stopShot = () => resolve({ kind: 'blocked', reason: 'aborted', cause: 'bot_lost' });
      }),
      abort: () => stopShot?.(),
    };
    const { exec, reports } = makeExecutorOn(bot, 0, ranged);
    exec.submit([{ skill: 'attack', target: 'zombie', mode: 'ranged' }]);
    await waitUntil(() => stopShot !== null, 3000);
    exec.onConnectionLost();
    await waitUntil(() => reports.length === 1, 3000);

    expect(reports[0].kind).toBe('cancelled');
    expect(reports[0].text).toContain('Minecraft 连接断开');
    expect(exec.attacking).toBe(false);
    expect(melee).toBe(0);
  });

  /**
   * eat 的假 bot 一律带一个真会被扣掉的背包:`consume()` 的 resolve 不是「吃完了」,
   * 判据是「这一样食物在包里少了一个」,包不动的假件只会得到「没吃进去」。
   */
  function eatBot(opts: {
    food?: number;
    /** 服务端认了这一口之后世界成什么样;不给 = 包里扣掉一个 */
    onConsume?: (bot: ReturnType<typeof eatBot>) => void | Promise<void>;
  }) {
    const bag = [{ name: 'cooked_beef', type: 1, count: 1 }];
    const bot = {
      bag,
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 3,
      food: opts.food ?? 18,
      players: {},
      registry: { foodsByName: { cooked_beef: {} } },
      inventory: { items: () => bag },
      equip: async () => {},
      consume: async () => {
        if (opts.onConsume) await opts.onConsume(bot);
        else bag[0].count -= 1;
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  it('吃东西是自救:eat 途中 escaping 为真,反射按这个信号让路不抢占', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const bot = eatBot({ onConsume: async (b) => { await gate; b.bag[0].count -= 1; } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'eat', item: 'cooked_beef' }]);
    // World 将反射的 escapeActive 接到 executor.escaping；进食期间低血受击反射在入口让路。
    await waitUntil(() => exec.escaping);
    release!();
    await waitUntil(() => reports.some((r) => r.kind === 'done'));
    expect(exec.escaping).toBe(false);
    expect(reports.find((r) => r.kind === 'done')!.text).toContain('吃了一个');
  });

  /**
   * consume() 可能在动画结束前因主手格变化而 resolve；进食须等库存扣数，再读取饥饿值报告。
   */
  it('eat:背包晚一步才扣,等到扣掉为止再报,饥饿报的是等完的新值', async () => {
    const bot = eatBot({
      onConsume: (b) => { setTimeout(() => { b.bag[0].count -= 1; b.food = 14; }, 400); },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'eat', item: 'cooked_beef' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('吃了一个牛排,饥饿 18 → 14/20');
  });

  /**
   * 跑步和死亡重生也会改变 bot.food；进食成功不能只按饥饿值变化判断。
   */
  it('eat:食物没少而饥饿因别的原因动了,如实说没吃进去', async () => {
    const bot = eatBot({ onConsume: (b) => { b.food = 12; } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'eat', item: 'cooked_beef' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没吃进去');
    expect(reports[0].text).toContain('包里还是 1 个、饥饿 18 → 12/20');
    expect(reports[0].text).not.toContain('吃了一个');
  });

  it('eat:死亡重生把饥饿重置成 20 也不算吃上了', async () => {
    const bot = eatBot({ food: 6, onConsume: (b) => { b.food = 20; } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'eat', item: 'cooked_beef' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没吃进去');
    expect(reports[0].text).not.toContain('吃了一个');
  });

  // 吃饱是正常无操作结局，不应作为受阻跳过后续隐式依赖步骤。
  it('吃饱了不算受阻:照实说没吃,后面那一步照跑', async () => {
    let consumed = 0;
    const said: string[] = [];
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      food: 20,
      players: {},
      registry: { foodsByName: { cooked_beef: {} } },
      inventory: { items: () => [{ name: 'cooked_beef', type: 1, count: 1 }] },
      equip: async () => {},
      consume: async () => { consumed++; throw new Error('Food is full'); },
      chat: (t: string) => said.push(t),
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'eat', item: 'cooked_beef' }, { skill: 'chat', text: '接着挖' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('饥饿已经是 20/20');
    // 由 Mineflayer 判定该物品能否在满饱食时使用；普通食物的明确错误映射成 no-op。
    expect(consumed).toBe(1);
    expect(said).toEqual(['接着挖']);
  });

  it('surface 只有换气却没有稳定落脚点:如实报受阻', async () => {
    const bot = combatBot({ headBlock: 'water' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 12_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没找到可站立的岸');
    expect(reports[0].text).toContain('还没有脱离液体');
    // 跳键不许漏出这个技能:留在按下状态会污染后面每一个任务
    expect(bot.controls[bot.controls.length - 1]).toEqual(['jump', false]);
  });

  /**
   * 深水里的 surface。世界很简单:y≤63 是水、y≥64 是空气,`land` 再在脚边一格
   * 摆一根「沙子 + 两格空气」的岸柱。
   *
   * 按着跳到点就浮出水面 = 人整个上到 y=63(水面那一格),头顶随之出水;
   * 不给 `surfaceAfterMs` 就一直沉着,专测 8 秒到点那条出口。
   */
  function diveBot(opts: {
    surfaceAfterMs?: number;
    land?: boolean;
    roofY?: number;
    goto?: (bot: ReturnType<typeof diveBot>) => Promise<void>;
  }) {
    const controls: Array<[string, boolean]> = [];
    const startedAt = Date.now();
    const bot = {
      controls,
      entity: { id: 9, position: new V(0.5, 50, 0.5), onGround: false },
      entities: {},
      health: 20,
      food: 20,
      oxygenLevel: 3,
      players: {},
      registry: { entitiesByName: {} },
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: (k: string, v: boolean) => {
        controls.push([k, v]);
        if (v && opts.surfaceAfterMs !== undefined && Date.now() - startedAt >= opts.surfaceAfterMs) {
          bot.entity.position = new V(0.5, 63, 0.5);
        }
      },
      blockAt: (p: V) => {
        const [x, y, z] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
        if (opts.roofY === y && x === 1 && z === 0) {
          return { name: 'stone', boundingBox: 'block' };
        }
        if (opts.land && x === 1 && z === 0 && y >= 63 && y <= 65) {
          return y === 63
            ? { name: 'sand', boundingBox: 'block' }
            : { name: 'air', boundingBox: 'empty' };
        }
        return y <= 63 ? { name: 'water', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' };
      },
      pathfinder: {
        stop() {},
        setGoal() {},
        goto: async () => {
          await opts.goto?.(bot);
          bot.entity.onGround = true;
        },
      },
    };
    return bot;
  }

  // surface 只有实际出水才报告浮上水面，超时退出须报告仍在水中。
  it('surface 按满 8 秒还在水里:照实说没出水,不谎报浮上了水面', async () => {
    const bot = diveBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 18_000);
    expect(reports[0].text).toContain('按着上浮 8 秒还没出水');
    expect(reports[0].text).toContain('氧气 3/20');
    expect(reports[0].text).not.toContain('我浮上了水面');
    expect(bot.controls[bot.controls.length - 1]).toEqual(['jump', false]);
  });

  /**
   * 夹具的岸在水平相邻一格、水面高度 Y=64；玩家在 Y=50，扫描高度须覆盖实际水柱。
   */
  it('surface 在深水里也够得着水面高度的岸:垂直范围按实测水柱走', async () => {
    const bot = diveBot({ land: true, goto: async (b) => { b.entity.position = new V(1.5, 64, 0.5); } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 18_000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('我脱离液体并站稳了,这里能看见天空');
    expect(reports[0].text).toContain('out_of_liquid=true,standing=true,sky_visible=true,final_y=64');
    expect(reports[0].text).not.toContain('没找到岸');
    expect(bot.controls[bot.controls.length - 1]).toEqual(['jump', false]);
  });

  it('surface 头已出水但身体仍泡在水里:继续登岸而不是按陆上露天完成', async () => {
    const bot = diveBot({ land: true, goto: async (b) => { b.entity.position = new V(1.5, 64, 0.5); } });
    bot.entity.position = new V(0.5, 63, 0.5);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('我脱离液体并站稳了');
    expect(reports[0].text).toContain('out_of_liquid=true,standing=true,sky_visible=true,final_y=64');
    expect(reports[0].text).not.toContain('我已经在露天了');
    expect(bot.entity.position).toEqual(new V(1.5, 64, 0.5));
  });

  it('surface 在洞穴岸面成功:明确仍有遮盖,不称为回到露天', async () => {
    const bot = diveBot({
      land: true,
      roofY: 70,
      goto: async (b) => { b.entity.position = new V(1.5, 64, 0.5); },
    });
    const { exec, reports } = makeExecutorOn(bot);

    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 18_000);

    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('这里仍有遮盖,没有回到露天');
    expect(reports[0].text).toContain('out_of_liquid=true,standing=true,sky_visible=false,final_y=64');
    expect(reports[0].text).not.toContain('这里能看见天空');
  });

  it('surface 登岸寻路失败:跳键照样在退出前松开', async () => {
    const bot = diveBot({
      surfaceAfterMs: 400,
      land: true,
      goto: async () => { throw new Error('goal was changed'); },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 18_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('我浮上了水面');
    expect(reports[0].text).toContain('游不到看见的那处岸');
    expect(bot.controls[bot.controls.length - 1]).toEqual(['jump', false]);
  });
});

describe('采草:无碰撞箱方块走得近、对得上账', () => {
  /**
   * 草的假 bot:raycast 永远穿过草(无碰撞形状)= GoalLookAtBlock 在这种
   * 目标上必败的真实条件;修复后 collect 对 empty 形状要改按距离走近。
   */
  function grassBot(opts: { visible?: boolean; drops?: boolean } = {}) {
    const pos = new V(3, 64, 0);
    const bag: Array<{ name: string; count: number }> = [];
    const gotoGoals: string[] = [];
    const bot = {
      gotoGoals,
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      players: {},
      world: { raycast: () => null },
      registry: {
        blocks: { 200: { name: 'short_grass', drops: [] } },
        blocksByName: { short_grass: { id: 200, name: 'short_grass', drops: [] } },
        items: { 901: { name: 'wheat_seeds' } },
        itemsByName: { wheat_seeds: { id: 901 } },
      },
      inventory: { items: () => bag },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: () => [pos],
      blockAt: (p: V) => (Math.floor(p.x) === 3 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0
        ? { name: 'short_grass', position: pos, boundingBox: 'empty', diggable: true, canHarvest: () => true }
        : { name: 'air', position: p, boundingBox: 'empty', diggable: false, canHarvest: () => false }),
      canSeeBlock: () => opts.visible !== false,
      canDigBlock: () => true,
      digTime: () => 50,
      stopDigging: () => {},
      dig: async () => { if (opts.drops !== false) bag.push({ name: 'wheat_seeds', count: 1 }); },
      pathfinder: {
        stop() {},
        setGoal() {},
        goto: async (goal: { constructor: { name: string } }) => {
          gotoGoals.push(goal.constructor.name);
          bot.entity.position = new V(2.5, 64, 0.5);
        },
      },
    };
    return bot;
  }

  it('对草不用 GoalLookAtBlock:按距离走近就挖,种子对得上账', async () => {
    const bot = grassBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'short_grass', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(bot.gotoGoals[0]).toBe('GoalNear');
    expect(reports[0].text).toContain('实际入包 1 个');
  });

  it('挖成了没掉种子:照实说是概率没掉,不算失败', async () => {
    const bot = grassBot({ drops: false });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'short_grass', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('概率');
    expect(reports[0].text).not.toContain('入包 0 个');
  });

  it('脚边的草不算"被挡":canSeeBlock 漏判时按挖掘距离豁免', async () => {
    const bot = grassBot({ visible: false });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'short_grass', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('实际入包 1 个');
  });

  it('collect 按掉落物名反查:要 wheat_seeds 就去挖草', async () => {
    const bot = grassBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'wheat_seeds', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('实际入包 1 个');
  });
});


describe('reserve:收着不主动拿的家伙什', () => {
  /** 一块矿 + 一包镐子的假 bot:记下每次 equip 拿的是哪一把 */
  function pickaxeBot(block: string, harvestIds: number[], bag: readonly string[]) {
    const equipped: string[] = [];
    const ore = { name: block, position: new V(2, 63, 0) };
    const loot: Array<{ name: string; count: number }> = [];
    const items = {
      1: { name: 'wooden_pickaxe' }, 3: { name: 'stone_pickaxe' },
      4: { name: 'iron_pickaxe' }, 5: { name: 'diamond_pickaxe' },
      100: { name: 'raw_ore' },
    };
    const idOf = (name: string): number => Number(
      Object.entries(items).find(([, def]) => def.name === name)?.[0] ?? -1,
    );
    const inventory = bag.map((name) => ({ name, type: idOf(name), count: 1 }));
    const bot = {
      equipped,
      entity: { id: 9, position: new V(0.5, 63, 0.5) },
      entities: {},
      health: 20,
      players: {},
      world: { raycast: () => ({ position: ore.position, face: 1 }) },
      registry: {
        blocks: { 70: { name: block, drops: [100] } },
        blocksByName: {
          [block]: {
            id: 70, name: block, drops: [100],
            material: 'mineable/pickaxe',
            harvestTools: Object.fromEntries(harvestIds.map((id) => [id, true])),
          },
        },
        items,
        itemsByName: Object.fromEntries(Object.entries(items).map(([id, def]) => [def.name, { id: Number(id) }])),
      },
      inventory: {
        items: () => [
          ...inventory,
          ...loot,
        ],
      },
      heldItem: null as { name: string; type: number; count: number } | null,
      equip: async (item: { name: string; type: number; count: number }) => {
        equipped.push(item.name);
        bot.heldItem = item;
      },
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: () => [ore.position],
      blockAt: () => ({
        ...ore,
        canHarvest: (type: number | null) => type !== null && harvestIds.includes(type),
      }),
      canSeeBlock: () => true,
      canDigBlock: () => true,
      digTime: () => 10,
      dig: async () => { loot.push({ name: 'raw_ore', count: 1 }); },
      stopDigging: () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  function rigWith(bot: unknown, reserve: string[]) {
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      policy: {
        get: () => ({ ...defaultPolicy(), reserve }),
        defaults: () => ({ scaffold: ['dirt', 'cobblestone'], light: ['torch'] }),
      },
    });
    return { exec, reports };
  }

  it('名单里的镐不被选中:剔掉铁镐,剩下的最好那把是石镐', async () => {
    // 石头一级的方块:木/石/铁三把都挖得出掉落,剔掉铁镐仍有得挑
    const bot = pickaxeBot('stone', [1, 3, 4, 5], ['stone_pickaxe', 'iron_pickaxe']);
    const { exec, reports } = rigWith(bot, ['iron_pickaxe']);
    exec.submit([{ skill: 'collect', block: 'stone', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(bot.equipped).not.toContain('iron_pickaxe');
    expect(bot.equipped).toContain('stone_pickaxe');
    expect(reports[0].text).not.toContain('收着的');
  });

  it('剔完没有别的挖得出掉落:照旧拿收着的那把,并在回执点名', async () => {
    // 钻石矿只有铁镐及以上挖得出掉落,石镐不在 harvestTools 里
    const bot = pickaxeBot('diamond_ore', [4, 5], ['stone_pickaxe', 'iron_pickaxe']);
    const { exec, reports } = rigWith(bot, ['iron_pickaxe']);
    exec.submit([{ skill: 'collect', block: 'diamond_ore', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(bot.equipped).toContain('iron_pickaxe');
    expect(reports[0].text).toContain('石镐挖不出钻石矿石的掉落,拿了收着的铁镐');
  });

  it('空名单走默认节约模式:同类里拿能掉落的最低等级', async () => {
    const bot = pickaxeBot('stone', [1, 3, 4, 5], ['stone_pickaxe', 'iron_pickaxe']);
    const { exec, reports } = rigWith(bot, []);
    exec.submit([{ skill: 'collect', block: 'stone', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(bot.equipped).toContain('stone_pickaxe');
    expect(reports[0].text).not.toContain('收着的');
  });
});

/**
 * releaseBody 统一释放控制键、挖掘闩锁、右键和本方目标。
 */
describe('交还身体:releaseBody', () => {
  function bodyBot() {
    const calls: string[] = [];
    const pathfinder = {
      goal: null as unknown,
      setGoal(g: unknown) { calls.push('goal'); pathfinder.goal = g; },
    };
    const bot = {
      entity: { position: new V(0.5, 64, 0.5) },
      pathfinder,
      // 右键按着(举着盾/在吃东西);松手不发射的那一类
      usingHeldItem: true,
      heldItem: { name: 'shield' },
      clearControlStates: () => { calls.push('controls'); },
      stopDigging: () => { calls.push('dig'); },
      deactivateItem: () => { calls.push('use'); },
    };
    return { bot, calls, pathfinder };
  }

  function escapeReflexes(bot: unknown, diag?: MinecraftLog) {
    const { exec: environmentExec } = makeExecutorOn(bot);
    return new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: () => {},
      log,
      ...(diag ? { diag } : {}),
      preempt: () => {},
      stopFallTask: () => null,
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 8,
      reactCooldownSec: () => 8,
      antiDrown: () => true,
      antiLava: () => false,
    });
  }

  /** 反射的唯一登记口是私有的 setEscapeGoal;测试直接走它,免得再造一整场溺水 */
  function register(reflexes: Reflexes, bot: unknown, goal: unknown): void {
    (reflexes as unknown as { setEscapeGoal(b: unknown, k: string, g: unknown): void })
      .setEscapeGoal(bot, 'drown', goal);
  }

  it('普通目标:撤目标、松控制键、停挖、松右键', () => {
    const { bot, calls, pathfinder } = bodyBot();
    pathfinder.goal = { kind: '普通行军' };

    releaseBody(bot as never, '中止任务');

    expect(calls).toEqual(['goal', 'controls', 'dig', 'use']);
    expect(pathfinder.goal).toBeNull();
  });

  /**
   * 已登记的反射逃生目标仍在救命，交还身体不能撤销它或松开其控制键。
   */
  it('反射登记在案的逃生目标:只停挖掘与右键,目标与控制键留给它', () => {
    const diag = new MinecraftLog();
    const { bot, calls, pathfinder } = bodyBot();
    const reflexes = escapeReflexes(bot);
    const escape = { kind: '登岸' };
    register(reflexes, bot, escape);
    calls.length = 0;

    releaseBody(bot as never, '战斗收工', diag);

    expect(calls).toEqual(['dig', 'use']);
    expect(pathfinder.goal).toBe(escape);
    expect(diag.after(0).map((e) => e.event)).toContain('release-body-kept-escape');
    reflexes.stop();
  });

  /**
   * 弓/弩/三叉戟松手就是发射:撤单误放一箭是 ranged.ts 改用切槽取消的原因,
   * 身体交还这一处不许把那件事又做回去。
   */
  it('手上正拉着弓:目标照撤、挖掘照停,但绝不松弦', () => {
    const { bot, calls } = bodyBot();
    Object.assign(bot, { heldItem: { name: 'bow' } });

    releaseBody(bot as never, '中止任务');

    expect(calls).toEqual(['goal', 'controls', 'dig']);
  });

  it('右键本来就没按着:不多发一次松手', () => {
    const { bot, calls } = bodyBot();
    Object.assign(bot, { usingHeldItem: false });

    releaseBody(bot as never, '中止任务');

    expect(calls).toEqual(['goal', 'controls', 'dig']);
  });

  it('反射早已换到别的目标:那张登记不再罩着当前目标,照撤', () => {
    const { bot, calls, pathfinder } = bodyBot();
    const reflexes = escapeReflexes(bot);
    register(reflexes, bot, { kind: '登岸' });
    pathfinder.goal = { kind: '别人后来挂的' };
    calls.length = 0;

    releaseBody(bot as never, 'World 停止');

    expect(calls).toEqual(['goal', 'controls', 'dig', 'use']);
    expect(pathfinder.goal).toBeNull();
    reflexes.stop();
  });

  it('反射停了:登记跟着作废,目标可以正常撤掉', () => {
    const { bot, calls, pathfinder } = bodyBot();
    const reflexes = escapeReflexes(bot);
    const escape = { kind: '登岸' };
    register(reflexes, bot, escape);
    reflexes.stop();
    calls.length = 0;

    releaseBody(bot as never, 'World 停止');

    expect(calls).toEqual(['goal', 'controls', 'dig', 'use']);
    expect(pathfinder.goal).toBeNull();
  });

  /**
   * owner 仲裁记录目标被谁撤销及其原因，不据此禁止目标覆盖。
   */
  it('owner 仲裁:撤别人的目标照撤,但落一条带理由的 diag', () => {
    const diag = new MinecraftLog();
    const { bot, pathfinder } = bodyBot();
    setOwnedGoal(bot as never, { kind: '战斗接近' } as never, 'combat', '接近目标', { diag });
    expect(goalOwnerKind(bot as never)).toBe('combat');

    dropOwnedGoal(bot as never, 'task', '新任务#7接管身体', diag);

    expect(pathfinder.goal).toBeNull();
    expect(goalOwnerKind(bot as never)).toBeNull();
    const hit = diag.after(0).find((e) => e.event === 'goal-owner-override')!;
    expect(hit).toBeDefined();
    expect(hit.data).toMatchObject({ from: 'combat', by: 'task', why: '撤销:新任务#7接管身体' });
  });

  it('撤自己下的目标不记账:同一 owner 的正常收尾不是覆盖', () => {
    const diag = new MinecraftLog();
    const { bot } = bodyBot();
    setOwnedGoal(bot as never, { kind: '行军' } as never, 'task', '去坐标', { diag });
    dropOwnedGoal(bot as never, 'task', '寻路零推进', diag);
    expect(diag.after(0).filter((e) => e.event === 'goal-owner-override')).toEqual([]);
  });

  it('换下别人的目标(不是撤,是改下一张)同样记一笔', () => {
    const diag = new MinecraftLog();
    const { bot } = bodyBot();
    setOwnedGoal(bot as never, { kind: '行军' } as never, 'task', '去坐标', { diag });
    setOwnedGoal(bot as never, { kind: '登岸' } as never, 'escape', '登岸', { diag });
    const hit = diag.after(0).find((e) => e.event === 'goal-owner-override')!;
    expect(hit.data).toMatchObject({ from: 'task', by: 'escape', why: '改下 登岸' });
    // 换完之后账记在新主人名下
    expect(goalOwnerKind(bot as never)).toBe('escape');
  });

  /**
   * goto 被反射逃逸接管后，战斗收尾须保留反射的救命目标；最终仅一个 owner 的目标存活。
   */
  it('多 owner 竞态:反射救命目标在战斗收工的交还里活下来,账只有一本', () => {
    const diag = new MinecraftLog();
    const { bot, pathfinder } = bodyBot();
    const reflexes = escapeReflexes(bot, diag);
    // 技能先挂着一张行军目标
    setOwnedGoal(bot as never, { kind: '行军' } as never, 'task', '去坐标', { diag });
    // 反射逃逸接管:换下它(记一笔覆盖)
    const escape = { kind: '登岸' };
    register(reflexes, bot, escape);
    expect(goalOwnerKind(bot as never)).toBe('escape');

    // 战斗收工来交还身体:救命的这张不许撤
    releaseBody(bot as never, '战斗收工(它们散了)', diag, 'combat');

    expect(pathfinder.goal).toBe(escape);
    expect(goalOwnerKind(bot as never)).toBe('escape');
    expect(diag.after(0).map((e) => e.event)).toContain('release-body-kept-escape');
    // 覆盖账只有反射接管那一笔;交还没抹掉任何人的目标,不该多记
    const overrides = diag.after(0).filter((e) => e.event === 'goal-owner-override');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].data).toMatchObject({ from: 'task', by: 'escape' });
    reflexes.stop();
  });
});

describe('放置与合成:按世界里真的有没有说话', () => {
  it('放下去了就照常往下合成,回执报目标物实际净增', async () => {
    const { bot, counts, PICK } = tableCraftBot('lands');
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'wooden_pickaxe', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('放下了一个工作台');
    expect(reports[0].text).toContain('合成出来:木镐×1');
    expect(counts.get(PICK)).toBe(1);
  });

  it('造出来的工具直接拿在手上,回执也说了', async () => {
    const { bot } = tableCraftBot('lands');
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'wooden_pickaxe', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    // 合成后必须装备新工具,不保留此前选中的运输方块。
    expect(bot.heldItem?.name).toBe('wooden_pickaxe');
    expect(reports[0].text).toContain('已经拿在手上');
  });

  it('工作台这种放地上的东西不往手上塞:只有工具和武器换手', async () => {
    const { bot } = tableCraftBot('lands');
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'crafting_table', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).not.toContain('已经拿在手上');
  });

  it('换手失败不算合成失败:东西已经在包里了,照实说没换成就行', async () => {
    const { bot, counts, PICK } = tableCraftBot('lands');
    const realEquip = bot.equip;
    bot.equip = async (it) => {
      if (it.name === 'wooden_pickaxe') throw new Error('服务端拒了这次换手');
      await realEquip(it);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'wooden_pickaxe', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(counts.get(PICK)).toBe(1);
    expect(reports[0].text).not.toContain('已经拿在手上');
  });

  it('客户端认了服务端没认:回读那一格还是空气,当场受阻并说破,不接着往下合成', async () => {
    const { bot, counts, PICK } = tableCraftBot('vanishes');
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'wooden_pickaxe', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('回读那一格还是空气');
    expect(counts.get(PICK) ?? 0).toBe(0);
  });

  it('产物进包又被服务端收回:不认这次合成,报的是东西没到手而不是位置放不下', async () => {
    const { bot, counts, PICK } = tableCraftBot('lands');
    // 客户端预测把木镐记进包里,不到一秒服务端收回——实测 1.20.6 的样子
    const realCraft = bot.craft;
    bot.craft = async (r) => {
      await realCraft(r);
      if (r.result.id === PICK) setTimeout(() => counts.set(PICK, 0), 150);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'wooden_pickaxe', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('一样都没多出来');
    // 不会走到放置那一步去报"脚边放不下"——那句话会让她白挪地方
    expect(reports[0].text).not.toContain('位置');
  });

  it('东西不在手上时说破,不冒充成位置问题', async () => {
    const { bot } = tableCraftBot('lands');
    // 模拟 equip 后服务端未确认手持物品的状态分歧。
    bot.equip = async () => { bot.heldItem = null; };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'wooden_pickaxe', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('手上却是');
    expect(reports[0].text).not.toContain('位置都放不下');
  });

  it('脚边没有能放的位置:说的是位置的事,不冒充成东西没到手', async () => {
    const { bot } = tableCraftBot('no-spot');
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'wooden_pickaxe', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    // 放置回执说明放什么、为谁放及后续操作。
    expect(reports[0].text).toContain('要放的是工作台,是这一步给工作台用的');
    expect(reports[0].text).toContain('没有一个「本身是空气、脚下又是实心」的位置');
    expect(reports[0].text).toContain('先 goto 挪到一块开阔的平地再来');
    expect(reports[0].text).not.toContain('还是空的');
  });
});

describe('要工作台:只摆事实,不代她权衡', () => {
  /** 32 格内摆一个现成的工作台;世界的其余部分沿用夹具 */
  function withNearbyTable(bot: ReturnType<typeof tableCraftBot>['bot'], at: V): void {
    const inner = bot.blockAt;
    bot.findBlocks = () => [at];
    bot.blockAt = (p: V) => (p.x === at.x && p.y === at.y && p.z === at.z
      ? { name: 'crafting_table', boundingBox: 'block', position: p }
      : inner(p));
  }

  // 三档按"要不要走路"分,不按"走多远值不值"。够得着那一档没有取舍可言:
  // 旁边一格就有台子还要再放一个,是"不代她权衡"这条规矩走过了头。
  it('够得着的现成台子直接用,不重复放一个', async () => {
    const { bot, counts, TABLE, PICK } = tableCraftBot('lands');
    withNearbyTable(bot, new V(2, 64, 0));
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'wooden_pickaxe', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(counts.get(PICK)).toBe(1);
    expect(reports[0].text).toContain('用了手边现成的工作台 (2, 64, 0)');
    expect(reports[0].text).toContain('包里还有 1 个,没动');
    expect(counts.get(TABLE)).toBe(1); // 一个都没放出去
    expect(reports[0].text).not.toContain('放下了一个工作台');
  });

  // 现成工作站够不着但库存可自备时就地放置，两个选项的事实都进入回执。
  it('够不着但包里有:就地放,两个选项的事实都进回执', async () => {
    const { bot, counts, PICK } = tableCraftBot('lands');
    withNearbyTable(bot, new V(12, 64, 0));
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'wooden_pickaxe', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(counts.get(PICK)).toBe(1);
    expect(reports[0].text).toContain('放下了一个工作台 (1, 64, 0)');
    expect(reports[0].text).toContain('包里还有 0 个');
    expect(reports[0].text).toContain('附近现成的那个在 (12, 64, 0),约 12 格外,这趟没去');
  });

  it('包里空了才走过去用现成的,并说清为什么', async () => {
    const { bot, counts, TABLE, PICK } = tableCraftBot('lands');
    counts.set(TABLE, 0);
    withNearbyTable(bot, new V(12, 64, 0));
    // 夹具的 pathfinder 是空转桩,人不会真的挪窝;这一档要走过去才算数,所以让它落地
    bot.pathfinder.goto = async () => { bot.entity.position = new V(11.5, 64, 0.5); };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'wooden_pickaxe', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(counts.get(PICK)).toBe(1);
    expect(reports[0].text).toContain('包里没有工作台,走过去用了现成的那个 (12, 64, 0),约 12 格外');
  });
});

/**
 * 工作台与炉子走同一个 `ensureStation`,所以三档规矩在两种工作站上必须落在同一处。
 * 上一组测工作台,这一组测炉子:同一份判据、同一份措辞。
 */
describe('要炉子:与工作台同一套三档', () => {
  const FAR = [{ x: 12, y: 64, z: 0, name: 'furnace' }];

  it('够得着的现成炉子直接用,不重复放一个', async () => {
    const rig = furnaceBot({
      inv: { raw_iron: 2, coal: 1, furnace: 1 },
      furnaces: [{ x: 2, y: 64, z: 0, name: 'furnace' }],
    });
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('用了手边现成的熔炉 (2, 64, 0)');
    expect(reports[0].text).toContain('包里还有 1 个,没动');
    expect(rig.placed).toEqual([]);
    expect(rig.inv.get('furnace')).toBe(1);
  });

  it('够不着但包里有:就地放,两个选项的事实都进回执', async () => {
    const rig = furnaceBot({ inv: { raw_iron: 2, coal: 1, furnace: 1 }, furnaces: FAR });
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(rig.placed).toEqual(['furnace']);
    expect(reports[0].text).toContain('放下了一个熔炉 (1, 64, 0)');
    expect(reports[0].text).toContain('附近现成的那个在 (12, 64, 0),约 12 格外,这趟没去');
  });

  it('包里空了才走过去用现成的,并说清为什么', async () => {
    const rig = furnaceBot({ inv: { raw_iron: 2, coal: 1 }, furnaces: FAR });
    // 夹具的 pathfinder 是空转桩;这一档要走到才算数,所以让它落地
    rig.bot.pathfinder.goto = async () => { rig.bot.entity.position = new V(11.5, 64, 0.5); };
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(rig.placed).toEqual([]);
    expect(reports[0].text).toContain('包里没有炉子,走过去用了现成的那个 (12, 64, 0),约 12 格外');
  });
});

describe('Reflexes 摔落', () => {
  function fallBot() {
    const pf = fakePathfinder();
    const events = new EventEmitter();
    const controls: Array<[string, boolean]> = [];
    const said: string[] = [];
    return {
      pf, controls, said,
      entity: {
        id: 1,
        position: new V(0.5, 80, 0.5),
        velocity: { x: 0, y: -0.9, z: 0 },
        onGround: false,
      },
      entities: {},
      health: 20,
      food: 20,
      oxygenLevel: 20,
      inventory: { items: () => [] as never[] },
      blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
      chat(text: string) { said.push(text); },
      setControlState(k: string, v: boolean) { controls.push([k, v]); },
      pathfinder: pf,
      on: events.on.bind(events),
      removeListener: events.removeListener.bind(events),
      emit: events.emit.bind(events),
    };
  }

  function recoveryReflex(bot: ReturnType<typeof fallBot>) {
    const resumed: object[] = [];
    const hold = { owner: Symbol('test-fall-hold') };
    const { exec: environmentExec } = makeExecutorOn(bot);
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: () => {},
      log,
      preempt: () => {},
      stopFallTask: () => hold,
      resumeAfterFall: (token) => { resumed.push(token); return true; },
      fightBack: () => false,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => false,
    });
    return { hold, reflexes, resumed };
  }

  function crossStopThreshold(bot: ReturnType<typeof fallBot>, reflexes: Reflexes): void {
    reflexes.start();
    vi.advanceTimersByTime(200);
    bot.entity.position = new V(0.5, 73, 0.5);
    vi.advanceTimersByTime(200);
  }

  it('普通受伤落差只记录:未到深坠阈值不抢占任务', () => {
    const bot = fallBot();
    const diag = new MinecraftLog();
    const preempts: string[] = [];
    const { exec: environmentExec } = makeExecutorOn(bot);
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: () => {},
      log,
      preempt: (reason) => preempts.push(reason),
      stopFallTask: () => null,
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => false,
      diag,
    });
    bot.pf.setGoal('原来那条路');
    reflexes.start();
    vi.advanceTimersByTime(200); // 记下起跳点 y=80
    bot.entity.position = new V(0.5, 75, 0.5);
    vi.advanceTimersByTime(200);
    bot.entity.onGround = true;
    vi.advanceTimersByTime(200);
    reflexes.stop();
    const falls = diag.after(0).filter((e) => e.event === 'falling');
    expect(falls).toHaveLength(1);
    expect(falls[0].data!.drop).toBe(5);
    expect(preempts).toEqual([]);
    expect(bot.controls).toEqual([]);
    expect(bot.pf.goal).toBe('原来那条路');
  });

  /**
   * 寻路目标带数值 Y 且位于当前位置下方至少阈值距离时，深坠守卫不撤销该任务。
   */
  it('寻路目标就在下方 ≥6 格:深坠不撤单(抢救豁免)', () => {
    const bot = fallBot();
    const diag = new MinecraftLog();
    const stops: string[] = [];
    const { exec: environmentExec } = makeExecutorOn(bot);
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: () => {},
      log,
      preempt: () => {},
      stopFallTask: (reason) => { stops.push(reason); return null; },
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => false,
      diag,
    });
    const enRoute = { x: 0, y: 40, z: 0 }; // 目的地就在深处
    bot.pf.setGoal(enRoute);
    crossStopThreshold(bot, reflexes); // 80 → 73,落差 7 格
    reflexes.stop();
    expect(stops).toEqual([]);
    expect(bot.pf.goal).toBe(enRoute); // 那条路不撤,继续飞
    expect(diag.after(0).map((e) => e.event)).toContain('falling-en-route');
  });

  it('寻路目标不带 y(GoalXZ 类):豁免不适用,深坠照撤', () => {
    const bot = fallBot();
    const stops: string[] = [];
    const { exec: environmentExec } = makeExecutorOn(bot);
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: () => {},
      log,
      preempt: () => {},
      stopFallTask: (reason) => { stops.push(reason); return null; },
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => false,
    });
    bot.pf.setGoal({ x: 20, z: 0 }); // 没有 y 的目标读不出「就在下方」
    crossStopThreshold(bot, reflexes);
    reflexes.stop();
    expect(stops).toHaveLength(1);
  });

  it('深坠超过 6 格:终止当前任务,稳定落脚前保留且不执行排队计划', async () => {
    const bot = fallBot();
    const diag = new MinecraftLog();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    bot.pf.goto = async (goal?: unknown) => {
      bot.pf.setGoal(goal);
      await gate;
    };
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      diag,
    });
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => exec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => exec.resumeAfterEnvironment(token),
      report: (r) => reports.push(r),
      log,
      preempt: (reason) => exec.preempt(reason),
      stopFallTask: (reason) => exec.stopCurrent(reason),
      resumeAfterFall: (token) => exec.resumeQueue(token),
      fightBack: () => false,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => false,
      diag,
    });

    exec.submit([{ skill: 'goto', at: [20, 80, 0] }]);
    exec.submit([{ skill: 'chat', text: '安全后继续' }], 'append');
    reflexes.start();
    vi.advanceTimersByTime(200);
    bot.entity.position = new V(0.5, 73, 0.5);
    vi.advanceTimersByTime(200);

    expect(exec.current).toBeNull();
    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe('cancelled');
    expect(reports[0].text).toContain('深坠落超过 6 格');
    expect(bot.pf.goal).toBeNull();
    expect(diag.after(0).filter((e) => e.event === 'falling-stop')).toHaveLength(1);
    expect(bot.controls).toEqual([]);
    expect(exec.status().waiting).toEqual([{ id: 2, label: '说: 安全后继续' }]);
    expect(bot.said).toEqual([]);
    // mc_stop 清队列时也须清除冻结令牌，避免后续任务永久等待。
    const stopped = exec.clear();
    expect(stopped).toContain('撤掉了排在后面的');
    expect(stopped).toContain('队列冻结(深坠落超过 6 格)也解除了');
    expect(exec.status().waiting).toEqual([]);
    const after = exec.submit([{ skill: 'chat', text: '停完再排' }], 'append');
    expect(after).not.toContain('排上了(深坠落超过 6 格');
    await vi.advanceTimersByTimeAsync(50);
    expect(bot.said).toEqual(['停完再排']);

    bot.entity.velocity.y = 0;
    bot.entity.onGround = true;
    bot.blockAt = ((p: V) => Math.floor(p.y) === 72
      ? { name: 'stone', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }) as typeof bot.blockAt;
    await vi.advanceTimersByTimeAsync(800);

    expect(reports.map((r) => r.kind)).toEqual(['cancelled', 'cancelled', 'done']);
    const safe = diag.after(0).filter((e) => e.event === 'falling-safe');
    expect(safe).toHaveLength(1);
    // 冻结已经由 mc_stop 解除,反射手里那张令牌落地时对不上号
    expect(safe[0].data?.resumed).toBe(false);

    reflexes.stop();
    release!();
    await Promise.resolve();
  });

  it('深坠 hold 租约:过期 token 不能释放后来一次止损', async () => {
    const bot = fallBot();
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
    });
    const stale = exec.stopCurrent('第一次止损');
    const current = exec.stopCurrent('第二次止损');

    exec.resumeQueue(stale);
    const held = exec.submit([{ skill: 'chat', text: '只能由当前租约放行' }]);
    expect(held).toContain('排上了(第二次止损');
    expect(bot.said).toEqual([]);

    exec.resumeQueue(current);
    await waitUntil(() => reports.length === 1);
    expect(bot.said).toEqual(['只能由当前租约放行']);
    expect(reports[0].kind).toBe('done');
  });

  it('深坠旧租约已失效:落稳只报告位置安全，不谎报队列恢复', () => {
    const bot = fallBot();
    const diag = new MinecraftLog();
    const hold = { owner: Symbol('stale-fall-hold') };
    const { exec: environmentExec } = makeExecutorOn(bot);
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: () => {}, log, preempt: () => {},
      stopFallTask: () => hold,
      resumeAfterFall: () => false,
      fightBack: () => false, fleeHealth: () => 10, reactCooldownSec: () => 8,
      antiDrown: () => false, antiLava: () => false,
      diag,
    });
    crossStopThreshold(bot, reflexes);
    bot.entity.velocity.y = 0;
    bot.entity.onGround = true;
    bot.blockAt = ((p: V) => Math.floor(p.y) === 72
      ? { name: 'stone', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }) as typeof bot.blockAt;
    vi.advanceTimersByTime(800);

    const safe = diag.after(0).find((entry) => entry.event === 'falling-safe');
    expect(safe?.data?.resumed).toBe(false);
    // 令牌对不上号 = 执行器换了租约或冻结已被 mc_stop/抢占清掉,反射分不出是哪一种,
    // 就不再替队列断言"当前冻结保持"
    expect(safe?.msg).toContain('旧恢复租约已失效');
    expect(safe?.msg).not.toContain('排队计划恢复');
    reflexes.stop();
  });

  it.each([
    ['下半砖', 'oak_slab', 73.5],
    ['楼梯低面', 'oak_stairs', 73.5],
    ['地毯', 'white_carpet', 73.0625],
    ['梯子底部', 'ladder', 73],
  ])('深坠后落在%s:连续稳定窗口后恢复', (_label, support, y) => {
    const bot = fallBot();
    const { hold, reflexes, resumed } = recoveryReflex(bot);
    crossStopThreshold(bot, reflexes);

    bot.entity.position = new V(0.5, y, 0.5);
    bot.entity.velocity.y = 0;
    bot.entity.onGround = true;
    const feetY = Math.floor(y);
    bot.blockAt = ((p: V) => {
      const blockY = Math.floor(p.y);
      if (blockY === feetY) return { name: support, boundingBox: 'block' };
      if (blockY === feetY - 1) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    }) as typeof bot.blockAt;

    vi.advanceTimersByTime(600);
    expect(resumed).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(resumed).toEqual([hold]);
    reflexes.stop();
  });

  it('深坠后史莱姆反弹:瞬时 onGround 不释放队列', () => {
    const bot = fallBot();
    const { hold, reflexes, resumed } = recoveryReflex(bot);
    crossStopThreshold(bot, reflexes);
    bot.blockAt = ((p: V) => Math.floor(p.y) === 72
      ? { name: 'slime_block', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }) as typeof bot.blockAt;

    bot.entity.velocity.y = 0;
    bot.entity.onGround = true;
    vi.advanceTimersByTime(400);
    bot.entity.position = new V(0.5, 73.4, 0.5);
    bot.entity.velocity.y = 0.4;
    bot.entity.onGround = false;
    vi.advanceTimersByTime(200);
    expect(resumed).toEqual([]);

    bot.entity.position = new V(0.5, 73, 0.5);
    bot.entity.velocity.y = 0;
    bot.entity.onGround = true;
    vi.advanceTimersByTime(600);
    expect(resumed).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(resumed).toEqual([hold]);
    reflexes.stop();
  });

  it('深坠后落在仙人掌或水里:危险仍在时不恢复', () => {
    const bot = fallBot();
    const { hold, reflexes, resumed } = recoveryReflex(bot);
    crossStopThreshold(bot, reflexes);
    bot.entity.velocity.y = 0;
    bot.entity.onGround = true;
    bot.blockAt = ((p: V) => Math.floor(p.y) === 72
      ? { name: 'cactus', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }) as typeof bot.blockAt;
    vi.advanceTimersByTime(1_000);
    expect(resumed).toEqual([]);

    Object.assign(bot.entity, { isInWater: true });
    bot.blockAt = (() => ({ name: 'water', boundingBox: 'empty' })) as typeof bot.blockAt;
    vi.advanceTimersByTime(1_000);
    expect(resumed).toEqual([]);

    Object.assign(bot.entity, { isInWater: false });
    bot.blockAt = ((p: V) => Math.floor(p.y) === 72
      ? { name: 'stone', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }) as typeof bot.blockAt;
    vi.advanceTimersByTime(800);
    expect(resumed).toEqual([hold]);
    reflexes.stop();
  });

  it.each(['death', 'reconnect', 'stop'] as const)('%s 清除旧身体的深坠恢复代次', (terminal) => {
    let bot = fallBot();
    const resumed: object[] = [];
    const hold = { owner: Symbol('terminal-fall-hold') };
    const { exec: environmentExec } = makeExecutorOn(bot);
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: () => {}, log, preempt: () => {},
      stopFallTask: () => hold,
      resumeAfterFall: (token) => { resumed.push(token); return true; },
      fightBack: () => false, fleeHealth: () => 10, reactCooldownSec: () => 8,
      antiDrown: () => false, antiLava: () => false,
    });
    crossStopThreshold(bot, reflexes);

    if (terminal === 'death') bot.emit('death');
    if (terminal === 'reconnect') bot = fallBot();
    if (terminal === 'stop') {
      reflexes.stop();
      reflexes.start();
    }
    bot.entity.velocity.y = 0;
    bot.entity.onGround = true;
    bot.blockAt = ((p: V) => Math.floor(p.y) === 72
      ? { name: 'stone', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }) as typeof bot.blockAt;
    vi.advanceTimersByTime(1_000);
    expect(resumed).toEqual([]);
    reflexes.stop();
  });

  it('一格跳跃不算摔落:够不到原版伤害线就不记', () => {
    const bot = fallBot();
    const diag = new MinecraftLog();
    const { exec: environmentExec } = makeExecutorOn(bot);
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: () => {},
      log,
      preempt: () => {},
      stopFallTask: () => null,
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => false,
      diag,
    });
    reflexes.start();
    vi.advanceTimersByTime(200);
    bot.entity.position = new V(0.5, 78.8, 0.5);
    vi.advanceTimersByTime(400);
    reflexes.stop();
    expect(diag.after(0).filter((e) => e.event === 'falling')).toEqual([]);
  });

  /**
   * 夹具在深坠冻结期间撤销队列，验证令牌释放后新任务仍可执行。
   */
  function fallHoldRig(diag?: MinecraftLog) {
    const bot = fallBot();
    bot.pf.goto = async (goal?: unknown) => {
      bot.pf.setGoal(goal);
      await new Promise<void>(() => {}); // 深坠打断前一直挂着
    };
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      diag,
    });
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => exec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => exec.resumeAfterEnvironment(token),
      report: (r) => reports.push(r),
      log,
      preempt: (reason) => exec.preempt(reason),
      stopFallTask: (reason) => exec.stopCurrent(reason),
      resumeAfterFall: (token) => exec.resumeQueue(token),
      fightBack: () => false,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => false,
      diag,
    });
    return { bot, exec, reflexes, reports };
  }

  it('深坠冻结期间 mc_stop:冻结跟着撤单一起解除,后来的任务照常开跑', async () => {
    const { bot, exec, reflexes } = fallHoldRig();
    exec.submit([{ skill: 'goto', at: [20, 80, 0] }]);
    crossStopThreshold(bot, reflexes);

    // 深坠已经把当前任务叫停了,mc_stop 这一下撤的只剩冻结本身
    expect(exec.clear()).toContain('解除了队列冻结(深坠落超过 6 格)');
    expect(exec.submit([{ skill: 'chat', text: '停完再排' }])).not.toContain('深坠落超过 6 格');
    await vi.advanceTimersByTimeAsync(50);
    expect(bot.said).toEqual(['停完再排']);
    reflexes.stop();
  });

  it('深坠冻结期间自保抢占:抢占撤空队列,冻结不许留下', async () => {
    const { bot, exec, reflexes } = fallHoldRig();
    exec.submit([{ skill: 'goto', at: [20, 80, 0] }]);
    exec.submit([{ skill: 'chat', text: '会被抢占撤掉' }], 'append');
    crossStopThreshold(bot, reflexes);

    exec.preempt('血量过低,脱离战斗');
    expect(exec.status().waiting).toEqual([]);
    exec.submit([{ skill: 'chat', text: '抢占后再排' }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(bot.said).toEqual(['抢占后再排']);
    reflexes.stop();
  });

  it('深坠冻结超过 60 秒仍没稳住:强制解冻并照实说当时脚下是什么', async () => {
    const diag = new MinecraftLog();
    const { bot, exec, reflexes, reports } = fallHoldRig(diag);
    exec.submit([{ skill: 'goto', at: [20, 80, 0] }]);
    exec.submit([{ skill: 'chat', text: '解冻后才轮到我' }], 'append');
    crossStopThreshold(bot, reflexes);

    // 落进一格水坑:onGround 了,但身体泡在水里 —— 干燥落脚这个条件永远不成立
    bot.entity.velocity.y = 0;
    bot.entity.onGround = true;
    bot.blockAt = ((p: V) => {
      const y = Math.floor(p.y);
      if (y === 73) return { name: 'water', boundingBox: 'empty' };
      if (y === 72) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    }) as typeof bot.blockAt;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(bot.said).toEqual([]);
    await vi.advanceTimersByTimeAsync(31_000);

    const forced = reports.find((r) => r.kind === 'reflex' && r.text.includes('深坠冻结'));
    expect(forced?.text).toContain('已解冻队列');
    expect(forced?.text).toContain('当时脚下是石头');
    expect(forced?.text).toContain('(0, 73, 0)');
    expect(diag.after(0).some((e) => e.event === 'hold-timeout' && e.data?.hold === 'fall')).toBe(true);
    expect(bot.said).toEqual(['解冻后才轮到我']);
    reflexes.stop();
  });

  /**
   * 深坠与环境两槽各自计时，看门狗只解除自己持有的冻结令牌。
   */
  it('两槽各自计时:深坠看门狗跳闸只解深坠那一张,环境那张照冻', async () => {
    const diag = new MinecraftLog();
    const { bot, exec, reflexes, reports } = fallHoldRig(diag);
    exec.submit([{ skill: 'goto', at: [20, 80, 0] }]);
    exec.submit([{ skill: 'chat', text: '两槽都解了才轮到我' }], 'append');
    // 先持有环境槽,再触发坠落槽,检验两者独立释放。
    const environment = exec.pauseForEnvironment('防溺水上浮找岸');
    crossStopThreshold(bot, reflexes);
    expect(exec.status().hold).toBe('防溺水上浮找岸、深坠落超过 6 格');

    // 落进一格水坑:干燥落脚永远不成立,深坠那一槽只能靠看门狗
    bot.entity.velocity.y = 0;
    bot.entity.onGround = true;
    bot.blockAt = ((p: V) => {
      const y = Math.floor(p.y);
      if (y === 73) return { name: 'water', boundingBox: 'empty' };
      if (y === 72) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    }) as typeof bot.blockAt;
    await vi.advanceTimersByTimeAsync(61_000);

    // 深坠那一槽解了,环境那一槽照冻:队列不开闸
    expect(reports.some((r) => r.kind === 'reflex' && r.text.includes('深坠冻结'))).toBe(true);
    expect(exec.status().hold).toBe('防溺水上浮找岸');
    expect(bot.said).toEqual([]);
    expect(diag.after(0).some((e) => e.event === 'hold-partial-release' && e.data?.slot === 'fall')).toBe(true);

    // 环境那一张自己解开才开闸:断点这时才放回队首接着做
    const out = exec.resumeAfterEnvironment(environment);
    expect(out.released).toBe(true);
    expect(out.note).toContain('任务#1');
    expect(exec.status().hold).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(exec.status().running?.id).toBe(1);
    expect(exec.status().waiting).toEqual([{ id: 2, label: '说: 两槽都解了才轮到我' }]);
    reflexes.stop();
  });

  it('执行器给不出冻结租约:不装成冻结态,落稳也不报"租约失效"', () => {
    const bot = fallBot();
    const diag = new MinecraftLog();
    const resumeCalls: unknown[] = [];
    const { exec: environmentExec } = makeExecutorOn(bot);
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: () => {},
      log,
      preempt: () => {},
      stopFallTask: () => null,
      resumeAfterFall: (token) => { resumeCalls.push(token); return false; },
      fightBack: () => false,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => false,
      diag,
    });
    crossStopThreshold(bot, reflexes);
    bot.entity.velocity.y = 0;
    bot.entity.onGround = true;
    bot.blockAt = ((p: V) => Math.floor(p.y) === 72
      ? { name: 'stone', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }) as typeof bot.blockAt;
    vi.advanceTimersByTime(1_000);
    reflexes.stop();

    const stop = diag.after(0).find((e) => e.event === 'falling-stop');
    expect(stop?.data?.held).toBe(false);
    expect(stop?.msg).toContain('没有可冻结的队列');
    expect(diag.after(0).filter((e) => e.event === 'falling-safe')).toEqual([]);
    expect(resumeCalls).toEqual([]);
  });
});



describe('build 单锚点 / use:位置由她定,结果按服务端回读认', () => {
  /** 可写的方块世界:place/use 改了哪一格,回读就看得见 */
  function placeBot(seed: Record<string, string> = {}, bag: Array<{ name: string; count: number }> = []) {
    const cells = new Map<string, string>(Object.entries(seed));
    const key = (x: number, y: number, z: number) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    const activated: string[] = [];
    const usedOn: string[] = [];
    let heldItem: { name: string; count: number } | null = null;
    let itemActivations = 0;
    const bot = {
      cells, activated, usedOn,
      get heldItem() { return heldItem; },
      entity: { id: 9, position: new V(0.5, 64, 0.5), onGround: true },
      entities: {} as Record<string, unknown>,
      health: 20,
      players: {},
      registry: {
        entitiesByName: { sheep: {}, cow: {} },
        // footprintOf 从方块状态推占位:床有 part:head/foot,火把没有
        blocksByName: {
          torch: { states: [] },
          red_bed: { states: [{ name: 'part', values: ['head', 'foot'] }] },
        } as Record<string, unknown>,
      },
      inventory: { items: () => bag },
      currentWindow: null,
      closeWindow: () => {},
      equip: async (item: { name: string; count: number }) => { heldItem = item; },
      lookAt: async () => {},
      setControlState: () => {},
      waitForTicks: async () => {},
      activateItem: async () => { itemActivations++; },
      deactivateItem: () => {},
      itemActivations: () => itemActivations,
      activateBlock: async (b: { name: string; position: V }) => {
        activated.push(`${b.name}@${key(b.position.x, b.position.y, b.position.z)}`);
        cells.set(key(b.position.x, b.position.y, b.position.z), `${b.name}_open`);
      },
      useOn: async (e: { name: string }) => { usedOn.push(e.name); },
      blockAt: (p: V) => {
        const name = cells.get(key(p.x, p.y, p.z)) ?? 'air';
        const empty = name === 'air' || name.endsWith('_open')
          || name === 'torch' || name === 'fire' || name === 'water';
        return {
          name,
          position: new V(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
          boundingBox: empty ? 'empty' : 'block',
          stateId: [...name].reduce((a, c) => a + c.charCodeAt(0), 0),
        };
      },
      placeBlock: async (ref: { position: V }, face: V) => {
        const dest = key(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z);
        if (!heldItem) throw new Error('must be holding an item to place');
        cells.set(dest, heldItem.name === 'flint_and_steel' ? 'fire'
          : heldItem.name === 'water_bucket' ? 'water' : heldItem.name);
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  const GROUND: Record<string, string> = { '0,63,0': 'stone', '1,63,0': 'stone', '2,63,0': 'stone' };

  // place 已并进 build:只给 1 个锚点 = 放那一格,shape 不必写
  it('build 单锚点放进她指定的那一格,回执报格坐标与包里剩余', async () => {
    const bot = placeBot({ ...GROUND }, [{ name: 'torch', count: 4 }]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'torch', anchors: [[1, 64, 0]] } as never]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('(1, 64, 0) 放下了火把');
    expect(bot.cells.get('1,64,0')).toBe('torch');
  });

  it('build 的 anchors 认 "~":原点是这一步开始执行那一刻我脚下那一格', async () => {
    const bot = placeBot({ ...GROUND }, [{ name: 'torch', count: 4 }]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'torch', anchors: [['~1', '~', '~']] } as never]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(bot.cells.get('1,64,0')).toBe('torch');
  });

  /**
   * 目标格已经是所需方块时，该格视为已达成。
   */
  it('build 单锚点:那一格本来就是要放的东西,算已达成', async () => {
    const bot = placeBot({ ...GROUND, '1,64,0': 'torch' }, [{ name: 'torch', count: 4 }]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'torch', anchors: [[1, 64, 0]] } as never]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('(1, 64, 0) 本来就是火把');
  });

  // 目标格被其他方块占据且一块都未放上时，报告受阻。
  it('build 单锚点:那一格被别的方块占着,一块都没放上就是受阻', async () => {
    const bot = placeBot({ ...GROUND, '1,64,0': 'stone' }, [{ name: 'torch', count: 4 }]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'torch', anchors: [[1, 64, 0]] } as never]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('一块都没放上');
    expect(reports[0].text).toContain('1 格被别的方块占着');
    // 现场点名占位的是谁:只说"没有一格空着"读不出下一步该拆什么
    expect(reports[0].text).toContain('(1, 64, 0) 现在是石头');
    // 拒绝理由附读取时刻，便于判断世界读数的新旧。
    expect(reports[0].text).toMatch(/读于 \d{2}:\d{2}:\d{2}/);
    expect(bot.cells.get('1,64,0')).toBe('stone');
  });

  // 放置依赖参照方块与面；六面都无可贴实心块时，回执须列明这一事实。
  it('build 单锚点六面都贴不住:一块都没放上就受阻,回执点名六个面', async () => {
    const bare = placeBot({ ...GROUND }, [{ name: 'torch', count: 4 }]);
    const { exec, reports } = makeExecutorOn(bare);
    exec.submit([{ skill: 'build', material: 'torch', anchors: [[1, 66, 0]] } as never]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('六个面都没有能贴着放的实心方块');
    expect(reports[0].text).not.toContain('悬空没依托');
  });

  // 床/门这类占两格的东西:她从快照里看不出"哪儿有连续两格空位",受阻现场把够用的位置列出来
  it('build 多格家具放不下:现场列出附近够放两格的位置', async () => {
    const bot = placeBot({ ...GROUND }, [{ name: 'red_bed', count: 1 }]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'red_bed', anchors: [[1, 66, 0]] } as never]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('[现场]');
    expect(reports[0].text).toContain('红色床要占两格');
    expect(reports[0].text).toContain('横着连续两格空、脚下都实心');
  });

  // 候选落点按距离排序，不附推荐理由。
  it('build 多格家具的候选清单:按远近排、只列前 5,并报总数', async () => {
    // 一整片 5×5 的地面 → 够放两格的位置远多于 5 处
    const wide: Record<string, string> = {};
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) wide[`${x},63,${z}`] = 'stone';
    const bot = placeBot({ ...wide }, [{ name: 'red_bed', count: 1 }]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'red_bed', anchors: [[1, 66, 0]] } as never]);
    await waitUntil(() => reports.length === 1);
    const listed = reports[0].text.match(/\(-?\d+, -?\d+, -?\d+\)\+/g) ?? [];
    expect(listed.length).toBe(5);
    expect(reports[0].text).toMatch(/共 \d+ 处,按远近取前 5/);
    expect(reports[0].text).not.toContain('推荐');
    // 第一处比最后一处离她近:排序是真排了,不是原扫描序
    const coords = (s: string | undefined): number[] => ((s ?? '').match(/-?\d+/g) ?? []).map(Number);
    const first = coords(listed[0]);
    const last = coords(listed[4]);
    const d = (c: number[]): number => Math.hypot(c[0] + 0.5 - 0.5, c[1] - 64, c[2] + 0.5 - 0.5);
    expect(d(first)).toBeLessThanOrEqual(d(last));
  });

  it('use + 有方块的那一格:对它本身动手,按服务端状态变没变说话', async () => {
    const bot = placeBot({ ...GROUND, '1,64,0': 'oak_door' }, []);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', at: [1, 64, 0] }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(bot.activated).toEqual(['oak_door@1,64,0']);
    expect(reports[0].text).toContain('空手右键了 (1, 64, 0)');
    expect(reports[0].text).toContain('那一格现在是');
  });

  it('use + target:对活物右键,按包里多没多出羊毛判', async () => {
    const sheep = { name: 'sheep', type: 'animal', position: new V(2.5, 64, 0.5), isValid: true, height: 1 };
    const bag = [{ name: 'shears', count: 1 }];
    const bot = placeBot({ ...GROUND }, bag);
    bot.entities = { '3': sheep };
    const sheared = bot.useOn;
    bot.useOn = async (e: { name: string }) => { await sheared(e); bag.push({ name: 'white_wool', count: 2 }); };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', item: 'shears', target: 'sheep' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(bot.usedOn).toEqual(['sheep']);
    expect(reports[0].text).toContain('右键了羊');
    expect(reports[0].text).toContain('包里羊毛 0 → 2 个');
  });

  /**
   * 「空手右键了 (-158,65,-18) 的空气,那一格现在是丛林门」——同一批事件里包里少了
   * 丛林门×1。不写 item 时既不腾手也不读手上,一律标空手,而 activateBlock 照样把手里
   * 那件东西放出去。
   */
  it('use 不写 item:按手上现在拿着的报,不再一律说"空手"', async () => {
    const bot = placeBot({ ...GROUND, '1,64,0': 'oak_door' }, [{ name: 'jungle_door', count: 1 }]);
    await bot.equip({ name: 'jungle_door', count: 1 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', at: [1, 64, 0] }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].text).toContain('右键了 (1, 64, 0)');
    expect(reports[0].text).not.toContain('空手');
  });

  it('use 只给 item:对自己/面前用,报包里前后的数', async () => {
    const bot = placeBot({ ...GROUND }, [{ name: 'potion', count: 2 }]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', item: 'potion' }]);
    await waitUntil(() => reports.length === 1, 6000);
    expect(reports[0].kind).toBe('done');
    expect(bot.itemActivations()).toBe(1);
    // 通用使用后库存未变时，应说明仅凭库存无法判断效果。
    expect(reports[0].text).toContain('包里一样没动');
    expect(reports[0].text).toContain('读不出');
  });

  it('投掷类给 at 是朝那儿扔,不是往那一格放东西', async () => {
    const bot = placeBot({ ...GROUND }, [{ name: 'ender_pearl', count: 3 }]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', item: 'ender_pearl', at: [1, 64, 0] }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('朝 (1, 64, 0) 扔了');
    expect(bot.cells.get('1,64,0')).toBeUndefined();
  });

  /**
   * use times 执行多次使用，回执报告实际成功次数。
   */
  it('use times:连着右键 N 次,回执报实际做成几次', async () => {
    expect(parseSteps([{ skill: 'use', item: 'bone_meal', at: [1, 64, 0], times: 3 }]))
      .toEqual({ steps: [{ skill: 'use', item: 'bone_meal', at: [1, 64, 0], times: 3 }] });

    const bot = placeBot({ ...GROUND, '1,64,0': 'wheat' }, [{ name: 'bone_meal', count: 8 }]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', item: 'bone_meal', at: [1, 64, 0], times: 3 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.activated.length).toBe(3);
    expect(reports[0].text).toContain('右键了 3/3 次');
  });

  it('use times:东西用到一半没了,停在那一次并说清停在第几次', async () => {
    const bag = [{ name: 'bone_meal', count: 2 }];
    const bot = placeBot({ ...GROUND, '1,64,0': 'wheat' }, bag);
    const activate = bot.activateBlock;
    bot.activateBlock = async (b) => {
      await activate(b);
      if (--bag[0].count <= 0) bag.splice(0, 1);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', item: 'bone_meal', at: [1, 64, 0], times: 5 }]);
    await waitUntil(() => reports.length === 1, 8000);
    // 做成两次是事实,报出来;一次都没做成才是受阻
    expect(reports[0].kind).toBe('done');
    expect(bot.activated.length).toBe(2);
    expect(reports[0].text).toContain('右键了 2/5 次,第 3 次停下:包里没有骨粉');
    // times>1 两句制:整段净差在前,最后一次现场读数在后 —— 只报最后一次会自相矛盾
    // (第 3 次对已驯服的狼用骨头不消耗,「包里一样没动」逐字属实却把前两根说没了)
    expect(reports[0].text).toContain('这 2 次合计');
    expect(reports[0].text).toContain('用掉:骨粉');
  });

  it('parseSteps:build 不写 shape 就是"就这些格";use 的 at 与 target 互斥,且不能三样都不给', () => {
    // 不写 shape = 给几个格子就放几处,不补形状
    expect(parseSteps([{ skill: 'build', material: 'torch', anchors: [[1, 2, 3]] }]))
      .toEqual({ steps: [{ skill: 'build', anchors: [[1, 2, 3]], material: 'torch' }] });
    expect(parseSteps([{ skill: 'build', anchors: [[1, 2, 3]] }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'use', at: [1, 2, 3], target: 'sheep' }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'use' }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'use', item: 'potion' }])).toHaveProperty('steps');
    expect(parseSteps([{ skill: 'use', at: ['~', '~1', '~'] }])).toHaveProperty('steps');
  });

  /**
   * 牌子上的字在入口就量:原版四行、每行 45 字符,超了 mineflayer 只 emit 一个 error
   * 就静默返回 —— 那等于一次什么都没发生却报"写上了"。
   */
  it('parseSteps:告示牌的字在入口量行数与长度,超了点名第几行', () => {
    expect(parseSteps([{ skill: 'use', at: [1, 2, 3], text: '一行\n两行' }]))
      .toEqual({ steps: [{ skill: 'use', at: [1, 2, 3], text: '一行\n两行' }] });
    expect(parseSteps([{ skill: 'use', at: [1, 2, 3], text: 'a\nb\nc\nd\ne' }])).toHaveProperty('error');
    const long = parseSteps([{ skill: 'use', at: [1, 2, 3], text: `a\n${'x'.repeat(46)}` }]);
    expect((long as { error?: string }).error).toContain('第 2 行');
    // text 是写在某一块牌子上的:没有 at 就没有牌子
    expect(parseSteps([{ skill: 'use', text: '喂' }])).toHaveProperty('error');
    // back 单独给没有意义
    expect(parseSteps([{ skill: 'use', at: [1, 2, 3], back: true }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'use', at: [1, 2, 3], text: '喂', back: true }]))
      .toEqual({ steps: [{ skill: 'use', at: [1, 2, 3], text: '喂', back: true }] });
  });

  /**
   * 含字面 \n 且不含真实换行的文本，在转换后不超过四行时归一为换行，再走校验并回念改写。
   */
  it('parseSteps:只含字面 \\n 的 text 归一成真换行,回念改写;切出 5 行以上不动它', () => {
    const fixed = parseSteps([{ skill: 'use', at: [1, 2, 3], text: '家名投票\\n缇谷？\\n可缇机房？\\n弹幕投！' }]);
    expect((fixed as { steps: Array<{ text?: string }> }).steps[0].text).toBe('家名投票\n缇谷？\n可缇机房？\n弹幕投！');
    expect(JSON.stringify((fixed as { notes?: unknown }).notes ?? '')).toContain('rewritten');
    // 归一后行数超 4 = 那串 \n 多半不是分行符,原样保留走原有的行数闸(45 字符内 1 行照过)
    const keep = parseSteps([{ skill: 'use', at: [1, 2, 3], text: 'a\\nb\\nc\\nd\\ne' }]);
    expect((keep as { steps: Array<{ text?: string }> }).steps[0].text).toBe('a\\nb\\nc\\nd\\ne');
    // 已有真换行的串一个字都不动
    const mixed = parseSteps([{ skill: 'use', at: [1, 2, 3], text: '真\n换行\\n字面' }]);
    expect((mixed as { steps: Array<{ text?: string }> }).steps[0].text).toBe('真\n换行\\n字面');
  });

  it('parseSteps:ride 的 off 与 target/to 互斥,三样至少给一样', () => {
    expect(parseSteps([{ skill: 'ride', target: 'pig', to: [1, 2, 3] }]))
      .toEqual({ steps: [{ skill: 'ride', target: 'pig', to: [1, 2, 3] }] });
    expect(parseSteps([{ skill: 'ride', off: true }])).toEqual({ steps: [{ skill: 'ride', off: true }] });
    expect(parseSteps([{ skill: 'ride', off: true, target: 'pig' }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'ride' }])).toHaveProperty('error');
  });

  it('parseSteps:anvil 按 op 查缺,grindstone 只要 item', () => {
    expect(parseSteps([{ skill: 'anvil', op: 'combine', item: 'iron_pickaxe', with: 'iron_pickaxe' }]))
      .toEqual({ steps: [{ skill: 'anvil', op: 'combine', item: 'iron_pickaxe', with: 'iron_pickaxe' }] });
    expect(parseSteps([{ skill: 'anvil', op: 'combine', item: 'iron_pickaxe' }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'anvil', op: 'rename', item: 'iron_sword' }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'anvil', op: 'rename', item: 'iron_sword', name: '剑' }]))
      .toEqual({ steps: [{ skill: 'anvil', op: 'rename', item: 'iron_sword', name: '剑' }] });
    // 合修顺便带 name 不静默吃:两步分开做
    expect(parseSteps([{ skill: 'anvil', op: 'combine', item: 'a', with: 'a', name: 'x' }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'grindstone', item: 'iron_sword' }]))
      .toEqual({ steps: [{ skill: 'grindstone', item: 'iron_sword' }] });
    expect(parseSteps([{ skill: 'grindstone' }])).toHaveProperty('error');
  });

  it('parseSteps:face 只收六个面,且要跟 at 一起给', () => {
    expect(parseSteps([{ skill: 'use', item: 'item_frame', at: [1, 2, 3], face: 'north' }]))
      .toEqual({ steps: [{ skill: 'use', item: 'item_frame', at: [1, 2, 3], face: 'north' }] });
    expect(parseSteps([{ skill: 'use', item: 'item_frame', at: [1, 2, 3], face: '北' }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'use', item: 'item_frame', face: 'north' }])).toHaveProperty('error');
  });
});



describe('fish:走到水边钓一竿,收获按物品栏差分照实报', () => {
  function fishBot(opts: {
    water?: Array<[number, number, number]>;
    rod?: boolean;
    biteAfterMs?: number;
    loot?: { name: string; type: number };
    /** 抛出去的浮标停在哪(不给就当浮标实体没同步过来) */
    bobberAt?: [number, number, number];
  }) {
    const inv: Array<{ name: string; count: number; type: number }> = [];
    if (opts.rod !== false) inv.push({ name: 'fishing_rod', count: 1, type: 30 });
    const water = new Set((opts.water ?? []).map(([x, y, z]) => `${x},${y},${z}`));
    let reeled = 0;
    const bot = {
      reeledCount: () => reeled,
      entity: { id: 9, position: new V(0.5, 64, 0.5), onGround: true },
      entities: opts.bobberAt
        ? { 7: { id: 7, name: 'fishing_bobber', position: new V(...opts.bobberAt) } }
        : {},
      inventory: { items: () => inv },
      registry: { blocksByName: { water: { id: 1, name: 'water' } }, itemsByName: {} },
      findBlocks: () => (opts.water ?? []).map(([x, y, z]) => new V(x, y, z)),
      canSeeBlock: () => true,
      blockAt: (p: V) => {
        const name = water.has(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ? 'water' : 'air';
        return { name, position: p.floored(), boundingBox: 'empty', diggable: true };
      },
      equip: async () => {},
      lookAt: async () => {},
      look: async () => {},
      activateItem: () => { reeled++; },
      fish: () => new Promise<void>((resolve) => {
        if (opts.biteAfterMs === undefined) return; // 永不咬钩,等收竿
        setTimeout(() => {
          if (opts.loot) inv.push({ name: opts.loot.name, count: 1, type: opts.loot.type });
          resolve();
        }, opts.biteAfterMs);
      }),
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  it('包里没竿:受阻明说', async () => {
    const bot = fishBot({ water: [[2, 63, 0]], rod: false });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('包里没有钓竿');
  });

  it('8 格内没看见水面:受阻', async () => {
    const bot = fishBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没看见能下竿的水面');
  });

  it('at 指定的那格不是水:受阻并说它是什么', async () => {
    const bot = fishBot({ water: [[2, 63, 0]] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish', at: [5, 63, 5] }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('不是水');
  });

  it('离水面远:先走到岸上的干格站,不停在离水面 3 格的水里', async () => {
    // x ≤ 5 是岸(实心到 y=63),x ≥ 6 是水(水面 y=63,底 y=60);人在 22 格外,原地抛不到
    const cell = (x: number, y: number) => {
      if (y >= 64) return 'air';
      if (x <= 5) return 'stone';
      return y >= 61 ? 'water' : 'stone';
    };
    const goals: Array<{ kind: string; x?: number; y?: number; z?: number }> = [];
    const inv = [{ name: 'fishing_rod', count: 1, type: 30 }];
    const bot = {
      entity: { id: 9, position: new V(-12.5, 64, 0.5), onGround: true },
      entities: {},
      inventory: { items: () => inv },
      registry: { blocksByName: { water: { id: 1, name: 'water' } }, itemsByName: {} },
      findBlocks: () => [new V(9, 63, 0)],
      canSeeBlock: () => true,
      blockAt: (p: V) => {
        const name = cell(Math.floor(p.x), Math.floor(p.y));
        return { name, position: p.floored(), boundingBox: name === 'stone' ? 'block' : 'empty', diggable: true };
      },
      equip: async () => {},
      lookAt: async () => {},
      look: async () => {},
      activateItem: () => {},
      fish: () => new Promise<void>((resolve) => { setTimeout(resolve, 50); }),
      pathfinder: {
        stop() {}, setGoal() {},
        goto: async (g: { constructor: { name: string }; x?: number; y?: number; z?: number }) => {
          goals.push({ kind: g.constructor.name, x: g.x, y: g.y, z: g.z });
          if (g.x !== undefined && g.y !== undefined && g.z !== undefined) bot.entity.position = new V(g.x + 0.5, g.y, g.z + 0.5);
        },
      },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish', at: [9, 63, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(goals[0].kind).toBe('GoalBlock');
    const g = goals[0] as { x: number; y: number; z: number };
    expect(cell(g.x, g.y - 1)).toBe('stone');
    expect(cell(g.x, g.y)).toBe('air');
  });

  it('咬钩收线:收获按差分照实报', async () => {
    const bot = fishBot({ water: [[2, 63, 0]], biteAfterMs: 50, loot: { name: 'salmon', type: 21 } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('钓上来生鲑鱼×1');
  });

  it('弹道瞄准:远处的水直瞄会抛短,选出来的仰角比直瞄平', () => {
    // 岸在 x<6,水从 x=6 起;直瞄 6 格外的水面按弹道只飞得到 5 格出头
    const bot = {
      entity: { position: new V(0.5, 64, 0.5), eyeHeight: 1.62 },
      blockAt: (p: V) => {
        const x = Math.floor(p.x); const y = Math.floor(p.y);
        if (y > 63) return { name: 'air', boundingBox: 'empty' };
        if (x >= 6) return { name: y === 63 ? 'water' : 'stone', boundingBox: y === 63 ? 'empty' : 'block' };
        return { name: 'stone', boundingBox: 'block' };
      },
    } as never;
    const plans = planFishingCasts(bot, { x: 6, y: 63, z: 0 });
    expect(plans.length).toBeGreaterThan(0);
    const deg = (plans[0].elev * 180) / Math.PI;
    const directDeg = (Math.atan2(63.9 - 65.62, 6.5 - 0.5) * 180) / Math.PI;
    expect(deg).toBeGreaterThan(directDeg + 1);
    expect(plans[0].dist).toBeGreaterThan(6);
  });

  it('浮标落在岸上:立刻收竿换仰角重抛,抛满还是不进水就照实受阻', async () => {
    const bot = fishBot({ water: [[2, 63, 0]], bobberAt: [1.5, 64.2, 0.5] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish' }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没进水里');
    expect(reports[0].text).toContain('(1, 64, 0)');
    // 三竿三次收竿,不是干等满 45 秒
    expect(bot.reeledCount()).toBe(3);
  }, 20000);
});

/**
 * visitedNodes 是 A* 的 closed set 大小；等于 1 表示只展开起点且没有可行邻居，须与目标不可达区分。
 */
describe('试算菜单:算不出路要说清是起点还是目标', () => {
  const probe = (over: Partial<RouteProbe>): RouteProbe => ({
    profile: 'style', status: 'noPath', steps: 0, place: 0, breaks: 0, endDist: 4, ...over,
  });
  const at = { x: 1, y: 2, z: 3 };

  it('visited=1:说破一步都迈不出去', () => {
    expect(renderRouteMenu([probe({ visited: 1 })], at))
      .toContain('算不出路:从我站的这一格一步都迈不出去');
  });

  it('visited 更大:报铺开试过的落脚点数,不下结论', () => {
    const text = renderRouteMenu([probe({ visited: 137 })], at);
    expect(text).toContain('算不出路(从出发点铺开试了 137 个落脚点)');
    expect(text).not.toContain('一步都迈不出去');
  });

  it('试算根本没跑起来(visited 缺失):照旧只说算不出路,不编数', () => {
    const text = renderRouteMenu([probe({})], at);
    expect(text).toContain('算不出路');
    expect(text).not.toContain('落脚点');
  });

  it('目标分诊照旧在头部,与起点读数并存不打架', () => {
    const text = renderRouteMenu([probe({ visited: 1 })], at, { diag: { kind: 'noStand' } as TargetDiag });
    expect(text).toContain('目标那一格站不进人');
    expect(text).toContain('一步都迈不出去');
  });

  /**
   * 分诊已确认目标站不进人时，超时行只报告未完成搜索，不推断目标距离或绕路原因。
   */
  it('分诊说站不进人:超时行只报超时,不再补"目标远或绕"', () => {
    const timeout = probe({ status: 'timeout', endDist: 3 });
    const text = renderRouteMenu([timeout], at, { startDist: 90, diag: { kind: 'noStand' } as TargetDiag });
    expect(text).toContain('目标那一格站不进人');
    expect(text).toContain('限时内没算完');
    expect(text).not.toContain('目标远或绕');
    expect(text).not.toContain('出发点离目标');
  });

  it('分诊说封在死角:同样只报超时', () => {
    const timeout = probe({ status: 'timeout', endDist: 3 });
    const text = renderRouteMenu([timeout], at, { startDist: 5, diag: { kind: 'sealed', size: 7 } as TargetDiag });
    expect(text).toContain('约 7 格的死角');
    expect(text).not.toContain('出发点离目标');
  });

  // 距离是实测值,两档都照报;「远」「绕」这种成因一个字都不给 ——
  // 「目标远或绕」与 zhErrorText 删掉的「目标太远或根本没路」是同一句话的两处出口。
  it('分诊说 open 或没跑分诊:只报实测距离,不报成因', () => {
    const timeout = probe({ status: 'timeout', endDist: 3 });
    for (const opts of [{ startDist: 5, diag: { kind: 'open' } as TargetDiag }, { startDist: 5 }]) {
      expect(renderRouteMenu([timeout], at, opts)).toContain('出发点离目标 5 格');
    }
    const far = renderRouteMenu([timeout], at, { startDist: 120 });
    expect(far).toContain('出发点离目标 120 格');
    expect(far).not.toContain('远或绕');
  });
});

/**
 * 建筑与挖掘的"半步":失败之前先把该做的做完,做不成时把那一格里是什么说出来。
 *
 * 这一组共用一份体素假世界:格子是 name→cell 的 Map,放置写进去、挖掘删掉,
 * 实心与否按名字判——与执行器"这一格变成了要放的东西"那套判据同一口径。
 */

/**
 * 账本中尚未到期且烧其他料的炉子跳过并说明原因；同料可继续投料，at 可指定炉子。
 */
describe('smelt 双炉并行:烧着别的就换一座,at 可点名', () => {
  const TWO = [
    { x: 2, y: 64, z: 0, name: 'furnace' },
    { x: 5, y: 64, z: 0, name: 'furnace' },
  ];
  const busyBook = (input: string): ChestBook => {
    const chests = new ChestBook(null);
    chests.rememberFurnace('overworld', { x: 2, y: 64, z: 0 }, 'furnace',
      { input: { name: input, count: 4 }, fuel: { name: 'coal', count: 1 }, output: null },
      Date.now(), Date.now() + 60_000);
    return chests;
  };
  /** furnaceBot 的 goto 是不动的空操作,2 格外那座炉子按 isEnd 判"走不到";换成真挪人的 */
  const mobile = (bot: ReturnType<typeof furnaceBot>['bot']): void => {
    (bot.pathfinder as { goto: unknown }).goto = async (goal: { x?: number; y?: number; z?: number }) => {
      const p = bot.entity.position;
      bot.entity.position = new V(
        (goal.x ?? Math.floor(p.x)) + 0.5, goal.y ?? p.y, (goal.z ?? Math.floor(p.z)) + 0.5,
      );
    };
  };

  it('最近的炉子还烧着别的:跳过它用下一座,跳过的连原因进回执', async () => {
    const { bot } = furnaceBot({ inv: { oak_log: 2, oak_planks: 4 }, furnaces: TWO });
    mobile(bot);
    const { exec, reports } = makeExecutorWith(bot, busyBook('raw_iron'));
    exec.submit([{ skill: 'smelt', input: 'oak_log', count: 2, fuel: 'oak_planks' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('(2, 64, 0) 那座输入槽还留着粗铁');
    expect(reports[0].text).toContain('(5, 64, 0)');
  });

  it('同一种料还烧着:不算占用,照常用最近那座续料', async () => {
    const { bot } = furnaceBot({ inv: { oak_log: 2, oak_planks: 4 }, furnaces: TWO });
    const { exec, reports } = makeExecutorWith(bot, busyBook('oak_log'));
    exec.submit([{ skill: 'smelt', input: 'oak_log', count: 2, fuel: 'oak_planks' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('(2, 64, 0)');
    expect(reports[0].text).not.toContain('还烧着');
  });

  it('到点了的炉子不算占用:烧完没取货不挡新一炉', async () => {
    const { bot } = furnaceBot({ inv: { oak_log: 2, oak_planks: 4 }, furnaces: TWO });
    const chests = new ChestBook(null);
    chests.rememberFurnace('overworld', { x: 2, y: 64, z: 0 }, 'furnace',
      { input: { name: 'raw_iron', count: 4 }, fuel: null, output: null },
      Date.now() - 90_000, Date.now() - 10_000);
    const { exec, reports } = makeExecutorWith(bot, chests);
    exec.submit([{ skill: 'smelt', input: 'oak_log', count: 2, fuel: 'oak_planks' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).not.toContain('还烧着');
  });

  it('唯一的炉子在烧别的且包里有备用:就地放一座新的', async () => {
    const { bot, placed } = furnaceBot({
      inv: { oak_log: 2, oak_planks: 4, furnace: 1 },
      furnaces: [TWO[0]],
    });
    const { exec, reports } = makeExecutorWith(bot, busyBook('raw_iron'));
    exec.submit([{ skill: 'smelt', input: 'oak_log', count: 2, fuel: 'oak_planks' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('输入槽还留着粗铁');
    expect(reports[0].text).toContain('放下了一个熔炉');
    expect(placed).toContain('furnace');
  });

  it('at 点名哪座就用哪座,不再按远近挑', async () => {
    const { bot } = furnaceBot({ inv: { oak_log: 2, oak_planks: 4 }, furnaces: TWO });
    mobile(bot);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'smelt', input: 'oak_log', count: 2, fuel: 'oak_planks', at: [5, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('用了指定的熔炉 (5, 64, 0)');
    expect(reports[0].text).toContain('取货:{"skill":"take","at":[5,64,0],"all":true}');
  });

  it('at 指到的那一格不是炉子:照实受阻,说那格是什么', async () => {
    const { bot } = furnaceBot({ inv: { oak_log: 2, oak_planks: 4 }, furnaces: TWO });
    mobile(bot);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'smelt', input: 'oak_log', count: 2, fuel: 'oak_planks', at: [9, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('不是炉子');
  });
});

/**
 * 中止与挂起日志须记录来源，区分战斗、自保反射和 mc_stop/顶替。
 */
describe('aborted 记抢占方', () => {
  /** 一件卡在 gate 上的 goto;放开后寻路报走不通,那时中止标记已经置上 */
  function stuckRig() {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const diag = new MinecraftLog();
    const reports: TaskReport[] = [];
    const bot = combatBot({ goto: async () => { await gate; throw new Error('No path to the goal!'); } });
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      diag,
    });
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    return { exec, diag, reports, release: () => release!() };
  }

  /** 中止落定后那一条 skill/aborted */
  async function abortedEntry(diag: MinecraftLog) {
    await waitUntil(() => diag.after(0).some((e) => e.event === 'aborted'), 5000);
    return diag.after(0).find((e) => e.event === 'aborted')!;
  }

  it('战斗挂起:抢占方带上是哪一只怪触发的', async () => {
    const { exec, diag, release } = stuckRig();
    await waitUntil(() => exec.status().running !== null);
    exec.suspend('战斗:被僵尸打了');
    release();
    const e = await abortedEntry(diag);
    expect(e.data!.by).toBe('战斗:被僵尸打了');
    expect(e.msg).toContain('战斗:被僵尸打了');
    // 抢占方随异常一起走:error 字段本身也说得出是谁
    expect(e.data!.error).toBe('aborted: 战斗:被僵尸打了');
  });

  it('自保反射:抢占方是反射的理由(岩浆/溺水各自的那句)', async () => {
    const { exec, diag, release } = stuckRig();
    await waitUntil(() => exec.status().running !== null);
    exec.preempt('逃离岩浆');
    release();
    const e = await abortedEntry(diag);
    expect(e.data!.by).toBe('自保反射:逃离岩浆');
  });

  it('mc_stop:抢占方是 mc_stop 自己', async () => {
    const { exec, diag, release } = stuckRig();
    await waitUntil(() => exec.status().running !== null);
    exec.clear();
    release();
    expect((await abortedEntry(diag)).data!.by).toBe('mc_stop');
  });

  it('queue:"now" 顶替:抢占方是那件插队的新任务', async () => {
    const { exec, diag, release } = stuckRig();
    await waitUntil(() => exec.status().running !== null);
    exec.submit([{ skill: 'chat', text: '先插这件' }], 'now');
    release();
    expect((await abortedEntry(diag)).data!.by).toBe('被 queue:"now" 的新任务顶替');
  });

  it('战斗挂起的 task/suspend 那条也点名抢占方', async () => {
    const { exec, diag, release } = stuckRig();
    await waitUntil(() => exec.status().running !== null);
    exec.suspend('战斗:被苦力怕贴脸');
    release();
    const s = diag.after(0).find((e) => e.event === 'suspend')!;
    expect(s.msg).toContain('被挂起(战斗:被苦力怕贴脸)');
    expect(s.data!.by).toBe('战斗:被苦力怕贴脸');
  });
});



/**
 * 重生锚的间接破坏分别由寻路禁挖、受理时几何检查和拾取回执处理；显式拆除采用同单重发确认。
 */
describe('重生锚闸', () => {
  const ANCHOR = { x: 4, y: 64, z: 4 };

  function anchorRig(anchor: { x: number; y: number; z: number } | null = ANCHOR) {
    const bot = combatBot({});
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      spawnAnchor: () => anchor,
    });
    return { exec, reports, bot };
  }

  it('形状罩住重生锚那一格:受理刻驳回,队列一个字都不动', () => {
    const { exec } = anchorRig();
    const r = exec.submit([{
      skill: 'excavate', shape: 'box', anchors: [[2, 63, 2], [6, 66, 6]], fill: 'solid',
    }]);
    expect(r).toContain('我没接');
    expect(r).toContain('重生锚');
    expect(r).toContain('(4, 64, 4)');
    expect(exec.current).toBeNull();
    expect(exec.status().waiting).toEqual([]);
  });

  // 形状只覆盖床下支撑格，也会破坏重生锚。
  it('「床正下方挖」同样驳回:护的那几格含锚点正下方', () => {
    const { exec } = anchorRig();
    const r = exec.submit([{ skill: 'excavate', shape: 'line', anchors: [[2, 63, 4], [6, 63, 4]] }]);
    expect(r).toContain('我没接');
    expect(r).toContain('(4, 63, 4)');
  });

  it('避开那一格就照常受理', () => {
    const { exec } = anchorRig();
    expect(exec.submit([{ skill: 'excavate', shape: 'line', anchors: [[8, 64, 8], [12, 64, 8]] }]))
      .toContain('收下了');
  });

  it('没设过重生点:这道闸什么都不管', () => {
    const { exec } = anchorRig(null);
    expect(exec.submit([{
      skill: 'excavate', shape: 'box', anchors: [[2, 63, 2], [6, 66, 6]], fill: 'solid',
    }])).toContain('收下了');
  });

  it('显式指名那一格:第一次警告等确认,同样的单再下一次就放行', () => {
    const { exec } = anchorRig();
    const call: SkillCall = { skill: 'excavate', shape: 'line', anchors: [[4, 64, 4], [4, 64, 4]] };
    const first = exec.submit([call]);
    expect(first).toContain('我没接');
    expect(first).toContain('再下一次一模一样的单');
    expect(exec.current).toBeNull();

    const second = exec.submit([call]);
    expect(second).not.toContain('我没接');
    expect(second).toContain('收下了');
  });

  it('collect 点名床也走确认路径:她说的就是这个东西,不是顺带罩上的', () => {
    const { exec } = anchorRig();
    const call: SkillCall = { skill: 'collect', block: 'white_bed', count: 1 };
    expect(exec.submit([call])).toContain('再下一次一模一样的单');
    expect(exec.submit([call])).toContain('收下了');
  });

  it('确认只对同一单有效:中间换了别的单,原来那一单还得再警告一次', () => {
    const { exec } = anchorRig();
    const call: SkillCall = { skill: 'excavate', shape: 'line', anchors: [[4, 64, 4], [4, 64, 4]] };
    expect(exec.submit([call])).toContain('我没接');
    expect(exec.submit([{ skill: 'collect', block: 'red_bed', count: 1 }])).toContain('我没接');
    expect(exec.submit([call])).toContain('我没接'); // 单槽被换掉了,不是确认
  });

  it('捡起床的回执照实说它是重生锚,不让「捡了 白色床×1」读成收益', async () => {
    const bag: Array<{ name: string; count: number }> = [];
    const bot = combatBot({});
    (bot as unknown as { inventory: unknown }).inventory = { items: () => bag };
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      spawnAnchor: () => ANCHOR,
    });
    setTimeout(() => bag.push({ name: 'white_bed', count: 1 }), 100);
    exec.submit([{ skill: 'pickup' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].text).toContain('捡了 白色床×1');
    expect(reports[0].text).toContain('重生锚');
    expect(reports[0].text).toContain('重生点随之作废');
    expect(reports[0].text).toContain('(4, 64, 4)');
  });

  it('捡的是别的东西就一个字不加', async () => {
    const bag: Array<{ name: string; count: number }> = [];
    const bot = combatBot({});
    (bot as unknown as { inventory: unknown }).inventory = { items: () => bag };
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      spawnAnchor: () => ANCHOR,
    });
    setTimeout(() => bag.push({ name: 'coal', count: 3 }), 100);
    exec.submit([{ skill: 'pickup' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].text).toContain('捡了 煤炭×3');
    expect(reports[0].text).not.toContain('重生锚');
  });
});

/**
 * 重力方块位于自身碰撞箱正上方时，受理刻整单拒绝，早于挪动身位腾空落点。
 */
describe('重力方块头顶闸', () => {
  function gravityRig() {
    const bot = combatBot({});
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
    });
    return { exec, reports, bot };
  }

  it('anchors:[["~","~1","~"]] + 红沙:受理刻驳回,说明它会掉下来', () => {
    const { exec } = gravityRig();
    const r = exec.submit([{ skill: 'build', material: 'red_sand', anchors: [['~', '~1', '~']] }]);
    expect(r).toContain('我没接');
    expect(r).toContain('红沙');
    expect(r).toContain('头顶');
    expect(r).toContain('掉下来');
    expect(exec.current).toBeNull();
  });

  it('写成绝对坐标也拦得住:判的是"落在我这一柱上"', () => {
    const { exec } = gravityRig();
    // combatBot 站在 (0.5, 64, 0.5) → 脚下那一格 (0, 64, 0)
    expect(exec.submit([{ skill: 'build', material: 'sand', anchors: [[0, 66, 0]] }]))
      .toContain('我没接');
  });

  it('不在头顶的重力方块照常受理:闸只钉在贴着身体的那一段', () => {
    const { exec } = gravityRig();
    expect(exec.submit([{ skill: 'build', material: 'sand', anchors: [[5, 64, 5]] }]))
      .toContain('收下了');
  });

  it('不会掉的材料放头顶不管:那是正当的封顶', () => {
    const { exec } = gravityRig();
    expect(exec.submit([{ skill: 'build', material: 'cobblestone', anchors: [['~', '~1', '~']] }]))
      .toContain('收下了');
  });
});

/**
 * queue:"now" 可请求普通战斗交还身体；低血或最近受击等安全门禁仍可拒绝。
 */
describe('queue:"now" 抢占战斗', () => {
  function combatQueueRig() {
    const bot = combatBot({});
    const reports: TaskReport[] = [];
    const state = { fighting: true, stoodDown: 0 };
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      busyWith: () => (state.fighting ? '正在跟怪打' : null),
      stopCombat: () => {
        if (!state.fighting) return null;
        state.fighting = false;
        state.stoodDown++;
        return '正在跟怪打';
      },
    });
    return { exec, reports, bot, state };
  }

  it('now 受理即让战斗交还身体,任务立刻开跑,回执照实说战斗被打断了', async () => {
    const { exec, reports, bot, state } = combatQueueRig();
    const r = exec.submit([{ skill: 'chat', text: '急件' }], 'now');
    expect(state.stoodDown).toBe(1);
    expect(r).toContain('战斗被这单打断了');
    expect(r).toContain('收下了');
    expect(r).not.toContain('腾出手就做');
    expect(r).not.toContain('排上了');
    await waitUntil(() => reports.length === 1, 3000);
    expect(bot.said).toEqual(['急件']);
  });

  it('replace/append 不动战斗:那两档排队是实话,不是降级', () => {
    const { exec, state } = combatQueueRig();
    const r = exec.submit([{ skill: 'chat', text: '不急' }]);
    expect(state.stoodDown).toBe(0);
    expect(r).toContain('排上了');
    expect(r).toContain('腾出手就做');
  });

  it('救命撤退拒绝 standDown 时:now 如实说仍在排队', () => {
    const bot = combatBot({});
    let retreating = true;
    const exec = new Executor({
      getBot: () => bot as never,
      report: () => {},
      log,
      nextId: nextTaskId(),
      busyWith: () => retreating ? '正在撤退' : null,
      stopCombat: () => null,
    });
    const receipt = exec.submit([{ skill: 'chat', text: '急件' }], 'now');
    expect(receipt).toContain('排上了');
    expect(receipt).toContain('正在撤退,腾出手就做');
    expect(receipt).not.toContain('收下了');
    expect(bot.said).toEqual([]);
    retreating = false;
    exec.resume();
  });

  it('急件排在解冻的旧任务前面:先让战斗交还,再插队头', async () => {
    const { exec, reports, bot, state } = combatQueueRig();
    exec.submit([{ skill: 'chat', text: '旧的' }]); // 战斗中只排队
    exec.submit([{ skill: 'chat', text: '急件' }], 'now');
    expect(state.stoodDown).toBe(1);
    await waitUntil(() => reports.length === 2, 4000);
    expect(bot.said).toEqual(['急件', '旧的']);
  });

  it('没接战斗层(台架)时 now 照旧走原来的插队', () => {
    const { exec } = makeExecutor();
    expect(exec.submit([{ skill: 'chat', text: 'x' }], 'now')).toContain('任务#1');
  });
});

describe('find 的行军代价上受理刻', () => {
  it('带 direction 的 find:受理回执报走多远、走满时离重生点多远', () => {
    const bot = combatBot({});
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never, report: (r) => reports.push(r), log, nextId: nextTaskId(),
      spawnAnchor: () => ({ x: 0, y: 64, z: 0 }),
    });
    const r = exec.submit([{ skill: 'find', target: 'spider', direction: 'south', distance: 48 }]);
    expect(r).toContain('这一步会朝南走最多 48 格');
    expect(r).toContain('走满时离重生点 (0, 64, 0) 约 48 格');
    exec.shutdown();
  });

  it('没有重生点就照实说,不编一个距离出来', () => {
    const { exec } = makeExecutorOn(combatBot({}));
    const r = exec.submit([{ skill: 'find', target: 'spider', direction: 'south', distance: 48 }]);
    expect(r).toContain('走满时你现在没有重生点');
    expect(r).not.toContain('离重生点 (');
    exec.shutdown();
  });

  it('站着扫那一档一个字都不加:它不走路', () => {
    const { exec } = makeExecutorOn(combatBot({}));
    expect(exec.submit([{ skill: 'find', target: 'spider', distance: 16 }]))
      .not.toContain('这一步会朝');
    exec.shutdown();
  });
});


describe('Reflexes 防溺水:换气点、登岸通路与计时兜底', () => {
  /** 三维格子图的假 bot:`world` 给每格方块名;人在 (0,61,0),头在 y62 */
  function waterBot(world: (x: number, y: number, z: number) => string, oxygenLevel: number) {
    const goals: Array<{ x: number; y: number; z: number } | null> = [];
    const bot = {
      goals,
      entity: { id: 1, position: new V(0.5, 61, 0.5), onGround: false, velocity: new V(0, 0, 0), metadata: [0] },
      oxygenLevel,
      health: 20,
      food: 20,
      entities: {},
      blockAt(p: V) {
        const c = p.floored();
        const name = world(c.x, c.y, c.z);
        return { name, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block' };
      },
      setControlState() {},
      pathfinder: {
        setGoal(goal: { x: number; y: number; z: number } | null) { goals.push(goal); },
        stop() {},
      },
      on() {},
      removeListener() {},
    };
    return bot;
  }

  function reflexesOn(bot: unknown) {
    const diag = new MinecraftLog();
    const reports: TaskReport[] = [];
    const { exec: environmentExec } = makeExecutorOn(bot);
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: (r) => reports.push(r),
      log,
      diag,
      preempt: () => {},
      stopFallTask: () => null,
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 8,
      reactCooldownSec: () => 8,
      antiDrown: () => true,
      antiLava: () => false,
    });
    const events = () => diag.after(0).map((e) => e.event);
    return { reflexes, reports, diag, events };
  }

  const setGoals = (bot: ReturnType<typeof waterBot>) =>
    bot.goals.filter((g): g is { x: number; y: number; z: number } => g !== null);

  /** 河岸草皮下方的水袋:自己这一列 y63 是草方块;一格之南的水面头顶是空气;四周 y62 以下是岸 */
  const pocket = (x: number, y: number, z: number): string => {
    if (x === 0 && z === 0) return y <= 62 ? 'water' : y === 63 ? 'grass_block' : 'air';
    if (x === 0 && z === 1) return y <= 62 ? 'water' : 'air';
    return y <= 62 ? 'stone' : 'air';
  };

  it('盖子水袋:第一级目标是头顶通气的水面格,盖子上方那一格不选', () => {
    const bot = waterBot(pocket, 3);
    const { reflexes, events } = reflexesOn(bot);
    reflexes.start();
    vi.advanceTimersByTime(2_600);
    reflexes.stop();
    const set = setGoals(bot);
    expect(set.length).toBeGreaterThan(0);
    expect(set[0]).toMatchObject({ x: 0, y: 62, z: 1 });
    expect(set.some((g) => g.x === 0 && g.y === 64 && g.z === 0)).toBe(false);
    expect(events()).toContain('drown-breath');
  });

  it('盖子水袋没有换气格:登岸点也过通路检查,盖子上方与隔着草皮的岸都不选', () => {
    // 只有自己这一列是水,盖子 y63,四周岸面 y63 就能站
    const sealed = (x: number, y: number, z: number): string => {
      if (x === 0 && z === 0) return y <= 62 ? 'water' : y === 63 ? 'grass_block' : 'air';
      return y <= 62 ? 'stone' : 'air';
    };
    const bot = waterBot(sealed, 3);
    const { reflexes, events } = reflexesOn(bot);
    reflexes.start();
    vi.advanceTimersByTime(2_600);
    reflexes.stop();
    expect(setGoals(bot)).toEqual([]);
    expect(events()).toContain('drown-noland');
  });

  it('零推进撤销过的登岸格进排除集:重找不再选同一格', () => {
    // 开阔水面(自己这一列头顶通气),四周岸面 y63:换气不用游,直接找岸
    const open = (x: number, y: number, z: number): string => {
      if (x === 0 && z === 0) return y <= 62 ? 'water' : 'air';
      return y <= 62 ? 'stone' : 'air';
    };
    const bot = waterBot(open, 3);
    const { reflexes, events } = reflexesOn(bot);
    reflexes.start();
    vi.advanceTimersByTime(2_600);
    const first = setGoals(bot);
    expect(first).toHaveLength(1);
    // 人一动不动:5 秒零推进 → 撤销 → 下一拍重找
    vi.advanceTimersByTime(6_000);
    reflexes.stop();
    const all = setGoals(bot);
    expect(events()).toContain('escape-goal-stalled');
    expect(all.length).toBeGreaterThan(1);
    const again = all.slice(1).some((g) => g.x === first[0].x && g.y === first[0].y && g.z === first[0].z);
    expect(again).toBe(false);
  });

  it('氧气读数一直不跌:头在水下满 10 秒按计时兜底触发', () => {
    const bot = waterBot(pocket, 20);
    const { reflexes, reports, events } = reflexesOn(bot);
    reflexes.start();
    vi.advanceTimersByTime(9_000);
    expect(reports).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    reflexes.stop();
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain('头在水下已 10 秒');
    expect(reports[0].text).toContain('氧气读数 20/20');
    expect(events()).toContain('drown-trigger');
  });

  it('氧气持续下降但尚未低于阈值:计时触发只报告当前读数', () => {
    const bot = waterBot(pocket, 20);
    const { reflexes, reports, diag } = reflexesOn(bot);
    reflexes.start();
    for (const oxygen of [20, 17, 15, 12, 9]) {
      bot.oxygenLevel = oxygen;
      vi.advanceTimersByTime(2_000);
    }
    expect(reports).toHaveLength(0);
    bot.oxygenLevel = 7;
    vi.advanceTimersByTime(1_000);
    reflexes.stop();
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain('氧气读数 7/20');
    expect(reports[0].text).not.toContain('没跌');
    const trigger = diag.after(0).find((r) => r.event === 'drown-trigger');
    expect(trigger?.data).toMatchObject({ oxygen: 7, oxygenTrusted: true, byTimer: true });
    expect(trigger?.msg).not.toContain('没跌');
  });

  it('水下每 2 秒记一条 drown-submerged:带氧气读数与水下时长', () => {
    const bot = waterBot(pocket, 20);
    const { reflexes, diag } = reflexesOn(bot);
    reflexes.start();
    vi.advanceTimersByTime(6_400);
    reflexes.stop();
    const rows = diag.after(0).filter((e) => e.event === 'drown-submerged');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(rows[rows.length - 1].data).toMatchObject({ headWet: true, oxygenLevel: 20, oxygenTrusted: true });
    expect((rows[rows.length - 1].data as { submergedMs: number }).submergedMs).toBeGreaterThan(5_000);
  });

  it('死过一次之后氧气读数不可信:低读数不再当场触发,改走 10 秒计时', () => {
    const bot = waterBot(pocket, 3);
    const { reflexes, reports } = reflexesOn(bot);
    reflexes.start();
    vi.advanceTimersByTime(200);
    (reflexes as unknown as { deathHandler: () => void }).deathHandler();
    vi.advanceTimersByTime(6_000);
    expect(reports).toHaveLength(0);
    vi.advanceTimersByTime(5_000);
    reflexes.stop();
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain('氧气读数复活后没刷新');
  });

  it('读数复活后变了一次就重新可信:又按氧气触发', () => {
    const bot = waterBot(pocket, 3);
    const { reflexes, reports } = reflexesOn(bot);
    reflexes.start();
    vi.advanceTimersByTime(200);
    (reflexes as unknown as { deathHandler: () => void }).deathHandler();
    bot.oxygenLevel = 5;
    vi.advanceTimersByTime(2_600);
    reflexes.stop();
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain('氧气 5/20');
  });
});


describe('fish:开阔水域优先、视线放宽、包满与遮蔽的回执', () => {
  interface Lake { x0: number; x1: number; z0: number; z1: number; depth: number }
  /**
   * 一片湖:x∈[x0,x1]、z∈[z0,z1] 是水,水面 y=63、往下 depth 格;其余 y≤63 是石头,
   * y>63 是空气(`cover` 里的格子例外,是树叶)。findBlocks 把湖里所有水格(含水下)
   * 都交出去,水面筛选与开阔判定都靠 blockAt。
   */
  function lakeBot(opts: {
    lake: Lake;
    me?: [number, number, number];
    /** 哪些水面格看得见;缺省全看得见 */
    canSee?: (p: { x: number; y: number; z: number }) => boolean;
    bag?: Array<{ name: string; count: number; type: number }>;
    biteAfterMs?: number;
    loot?: { name: string; type: number };
    bobberAt?: [number, number, number];
    cover?: Set<string>;
  }) {
    const { lake } = opts;
    const inLake = (x: number, y: number, z: number): boolean =>
      x >= lake.x0 && x <= lake.x1 && z >= lake.z0 && z <= lake.z1 && y <= 63 && y > 63 - lake.depth;
    const inv = opts.bag ?? [{ name: 'fishing_rod', count: 1, type: 30 }];
    const me = new V(...(opts.me ?? [0.5, 64, 0.5]));
    const gotoGoals: string[] = [];
    const bot = {
      gotoGoals,
      entity: { id: 9, position: me, onGround: true, eyeHeight: 1.62 },
      entities: opts.bobberAt
        ? { 7: { id: 7, name: 'fishing_bobber', position: new V(...opts.bobberAt) } }
        : {},
      game: { minY: -64, height: 384 },
      inventory: { items: () => inv },
      registry: { blocksByName: { water: { id: 1, name: 'water' } }, itemsByName: {} },
      world: { raycast: () => null },
      findBlocks: (o: { maxDistance: number }) => {
        const out: V[] = [];
        for (let x = lake.x0; x <= lake.x1; x++) {
          for (let z = lake.z0; z <= lake.z1; z++) {
            for (let y = 63; y > 63 - lake.depth; y--) {
              const p = new V(x, y, z);
              if (p.distanceTo(me) <= o.maxDistance) out.push(p);
            }
          }
        }
        return out;
      },
      canSeeBlock: (b: { position: V }) => (opts.canSee ? opts.canSee(b.position) : true),
      blockAt: (p: V) => {
        const f = p.floored();
        if (inLake(f.x, f.y, f.z)) {
          return { name: 'water', position: f, boundingBox: 'empty', getProperties: () => ({ level: '0' }) };
        }
        if (opts.cover?.has(`${f.x},${f.y},${f.z}`)) return { name: 'oak_leaves', position: f, boundingBox: 'block' };
        return f.y <= 63
          ? { name: 'stone', position: f, boundingBox: 'block' }
          : { name: 'air', position: f, boundingBox: 'empty' };
      },
      equip: async () => {},
      lookAt: async () => {},
      look: async () => {},
      activateItem: () => {},
      fish: () => new Promise<void>((resolve) => {
        if (opts.biteAfterMs === undefined) return;
        setTimeout(() => {
          if (opts.loot) inv.push({ name: opts.loot.name, count: 1, type: opts.loot.type });
          resolve();
        }, opts.biteAfterMs);
      }),
      pathfinder: {
        stop() {}, setGoal() {},
        goto: async (goal: { constructor: { name: string } }) => { gotoGoals.push(goal.constructor.name); },
      },
    };
    return bot;
  }

  /** 岸在 x<2,湖从 x=2 到 x=14、z∈[-6,6],3 格深:开阔水域从 x=4 起(5×5 要全是水) */
  const DEEP: Lake = { x0: 2, x1: 14, z0: -6, z1: 6, depth: 3 };
  /** 家门口那种 1 格深小池 */
  const SHALLOW: Lake = { x0: 2, x1: 8, z0: -3, z1: 3, depth: 1 };

  it('原版开阔水域判定:5×5 至少 2 格深且岸不在 2 格内', () => {
    const bot = lakeBot({ lake: DEEP }) as never;
    expect(isOpenFishingWater(bot, { x: 2, y: 63, z: 0 })).toBe(false); // 岸沿
    expect(isOpenFishingWater(bot, { x: 3, y: 63, z: 0 })).toBe(false); // 岸在 2 格内
    expect(isOpenFishingWater(bot, { x: 4, y: 63, z: 0 })).toBe(true);
    expect(isOpenFishingWater(bot, { x: 8, y: 63, z: 5 })).toBe(false); // z 边上的岸
    expect(isOpenFishingWater(lakeBot({ lake: SHALLOW }) as never, { x: 5, y: 63, z: 0 })).toBe(false); // 1 格深
  });

  it('深湖旁选点:放过最近的岸沿格,取离岸 ≥3 格的合规格', () => {
    const spot = findFishingSpot(lakeBot({ lake: DEEP }) as never, 12);
    expect(spot).toEqual({ cell: { x: 4, y: 63, z: 0 }, open: true });
  });

  it('只有 1 格深小池:退回最近一格,并标明没有开阔水域', () => {
    const spot = findFishingSpot(lakeBot({ lake: SHALLOW }) as never, 12);
    expect(spot).toEqual({ cell: { x: 2, y: 63, z: 0 }, open: false });
  });

  it('站在岸壁上方看不见脚下水面:3 格内免视线,同一片水连通的远处格一并入席', () => {
    // 玩家位于水面上方 3 格、水平相距 1.5 格；canSeeBlock 始终为 false，射线也不通。
    const bot = lakeBot({ lake: DEEP, me: [0.5, 66, 0.5], canSee: () => false });
    const spot = findFishingSpot(bot as never, 12);
    // (2,63,0) 离人 4 格内免检,沿水面连通到 (4,63,0) 这类开阔格
    expect(spot).toEqual({ cell: { x: 4, y: 63, z: 0 }, open: true });
    // 完全看不见、也不在 3 格内的另一片水不入席
    const far = lakeBot({ lake: { x0: 5, x1: 12, z0: -6, z1: 6, depth: 3 }, canSee: () => false });
    expect(findFishingSpot(far as never, 12)).toBeNull();
  });

  it('小池钓成:回执带「这片水没有开阔水域」,站在原地抛得到就不走过去', async () => {
    const bot = lakeBot({ lake: SHALLOW, biteAfterMs: 50, loot: { name: 'cod', type: 21 } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('钓上来生鳕鱼×1');
    expect(reports[0].text).toContain('这片水没有开阔水域,只能钓岸边(不出宝藏)');
    expect(bot.gotoGoals).toEqual([]);
  });

  it('at 指定了岸沿那一格:照实说它不是开阔水域', async () => {
    const bot = lakeBot({ lake: DEEP, biteAfterMs: 50, loot: { name: 'cod', type: 21 } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish', at: [2, 63, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('(2, 63, 0) 不是开阔水域');
  });

  it('开阔水域钓成:没有那句注脚', async () => {
    const bot = lakeBot({ lake: DEEP, biteAfterMs: 50, loot: { name: 'cod', type: 21 } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).not.toContain('开阔水域');
  });

  it('包满时咬钩没进包:回执说包满了、战利品掉在脚边,不说掉进水里', async () => {
    const bag = [{ name: 'fishing_rod', count: 1, type: 30 }];
    while (bag.length < 36) bag.push({ name: 'cobblestone', count: 64, type: 1 });
    const bot = lakeBot({ lake: SHALLOW, bag, biteAfterMs: 50 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('包满了(36 格全占着),战利品掉在脚边');
    expect(reports[0].text).not.toContain('水里');
  });

  it('包没满时咬钩没进包:报剩几格空位,不猜去向', async () => {
    const bot = lakeBot({ lake: SHALLOW, biteAfterMs: 50 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('东西没进包(包里还有 35 格空位)');
  });

  it('浮标头顶有遮盖:等待上限放宽到 60 秒,回执带「看不到天」', async () => {
    expect(fishWaitMs(false)).toBe(45_000);
    expect(fishWaitMs(true)).toBe(60_000);
    // 浮标落在 (3,63,0) 的水里,头顶 y=70 一片树叶
    const bot = lakeBot({
      lake: SHALLOW, biteAfterMs: 300, loot: { name: 'cod', type: 21 },
      bobberAt: [3.5, 63.5, 0.5], cover: new Set(['3,70,0']),
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('这里浮标头顶看不到天,咬钩慢');
  });

  it('露天的浮标:没有「看不到天」', async () => {
    const bot = lakeBot({ lake: SHALLOW, biteAfterMs: 300, loot: { name: 'cod', type: 21 }, bobberAt: [3.5, 63.5, 0.5] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'fish' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).not.toContain('看不到天');
  });
});
