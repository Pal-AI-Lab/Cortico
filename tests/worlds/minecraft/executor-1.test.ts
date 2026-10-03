/**
 * executor 行为测试 第 1/4 份(见 executor-harness.ts)。
 * 分份只为并行,按实测耗时配平;哪个 describe 落在哪一份没有语义。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dangerNoteText, describeSkill, Executor, Reflexes, parseScoutSteps, parseSteps,
  type MarkDesk, type MarkLookup, type RouteProbe, type SkillCall, type TargetDiag,
  type ResourcePlacementGate, type TaskReport,
} from '../../../src/worlds/minecraft/executor.ts';
import {
  dangerZonesAt, nearMarkText, nearestMark, type MinecraftMark,
} from '../../../src/worlds/minecraft/world.ts';
import type { Anchor } from '../../../src/worlds/minecraft/geometry.ts';
import { ChestBook } from '../../../src/worlds/minecraft/chests.ts';
import { MinecraftLog } from '../../../src/worlds/minecraft/log.ts';
import {
  log,
  nextTaskId,
  sleep,
  waitUntil,
  V,
  FakeGoal,
  JudgingGoal,
  terrainGoto,
  combatBot,
  makeExecutorOn,
  makeExecutorWith,
  chestBot,
  brewBot,
  furnaceBot,
  recordPlacements,
  onLedge,
  drownBot,
  makeReflexes,
  fakePathfinder,
} from './executor-harness.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseScoutSteps:同一套校验,只留下试算', () => {
  const ok = (raw: unknown): SkillCall[] => {
    const r = parseScoutSteps(raw);
    if ('error' in r) throw new Error(`本该通过却被退回: ${r.error}`);
    return r.steps;
  };
  const err = (raw: unknown): string => {
    const r = parseScoutSteps(raw);
    if (!('error' in r)) throw new Error('本该被退回却通过了');
    return r.error;
  };

  it('结构错误仍走 parseSteps 的原文', () => {
    expect(err([{ skill: 'goto' }])).toContain('at:[x,y,z]');
    expect(err([{ skill: '往下挖' }])).toContain('第 1 步');
  });

  it('会动世界的技能整批退回,点名第几步', () => {
    expect(err([{ skill: 'collect', block: 'stone', count: 1 }])).toContain('collect');
    expect(err([
      { skill: 'probe', shape: 'line', anchors: [[0, 64, 0], [0, 66, 0]] },
      { skill: 'chat', text: 'hi' },
    ])).toContain('第 2 步');
  });

  it('没写 dryRun 的试算技能入队前补上;probe 保持原样', () => {
    expect(ok([{ skill: 'goto', at: [10, 64, 10] }]))
      .toEqual([{ skill: 'goto', at: [10, 64, 10], dryRun: true }]);
    expect(ok([{ skill: 'goto', at: [10, 5] }]))
      .toEqual([{ skill: 'goto', at: [10, 0, 5], groundY: true, dryRun: true }]);
    expect(ok([{ skill: 'build', material: 'torch', anchors: [[1, 64, 0]] }]))
      .toEqual([{ skill: 'build', anchors: [[1, 64, 0]], material: 'torch', dryRun: true }]);
    expect(ok([{ skill: 'probe', shape: 'line', anchors: [[0, 64, 0], [0, 66, 0]] }])[0])
      .not.toHaveProperty('dryRun');
  });

  it('needs/expect 与 parseSteps 同一套', () => {
    expect(ok([
      { skill: 'goto', at: [10, 64, 10], expect: { near: [10, 64, 10] } },
      { skill: 'probe', shape: 'line', anchors: [[0, 64, 0], [0, 66, 0]], needs: [] },
    ])).toEqual([
      { skill: 'goto', at: [10, 64, 10], dryRun: true, expect: { near: [10, 64, 10] } },
      { skill: 'probe', shape: 'line', anchors: [[0, 64, 0], [0, 66, 0]], needs: [] },
    ]);
  });
});

describe('goto dryRun / 出发前试算', () => {
  const PROBES_CHEAP: RouteProbe[] = [
    { profile: 'style', status: 'complete', steps: 14, place: 2, breaks: 0, endDist: 0 },
    { profile: 'dig', status: 'complete', steps: 16, place: 0, breaks: 3, endDist: 0 },
    { profile: 'walk', status: 'complete', steps: 20, place: 0, breaks: 0, endDist: 0 },
  ];
  const PROBES_EXPENSIVE: RouteProbe[] = [
    { profile: 'style', status: 'complete', steps: 60, place: 23, breaks: 0, endDist: 0 },
    { profile: 'dig', status: 'complete', steps: 90, place: 0, breaks: 28, endDist: 0 },
    { profile: 'walk', status: 'partial', steps: 12, place: 0, breaks: 0, endDist: 9 },
  ];

  function styleRig(probes: RouteProbe[] | null, probeTarget?: () => TargetDiag | null) {
    const bot = combatBot({});
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      probeRoutes: () => probes,
      probeTarget,
    });
    return { exec, reports, bot };
  }

  it.each(['upkeep', 'unknown_skill'])('未知技能 %s 使整批解析失败,不返回前面的有效步骤', (skill) => {
    const r = parseSteps([
      { skill: 'eat', item: 'bread' },
      { skill },
    ]) as { error: string };
    expect(r.error).toContain('第 2 步');
    expect(r.error).toContain(skill);
    expect(r).not.toHaveProperty('steps');
  });

  // scout_route 已并进 goto:dryRun 就是"探路不动身",不再是单独一条技能
  it('goto dryRun 只探不动身:三份试算各成一行', async () => {
    const rig = styleRig(PROBES_EXPENSIVE);
    rig.exec.submit([{ skill: 'goto', at: [10, 64, 10], dryRun: true }]);
    await waitUntil(() => rig.reports.length === 1);
    expect(rig.reports[0].kind).toBe('done');
    const text = rig.reports[0].text;
    expect(text).toContain('按当前风格:走 60 步,垫 23 块');
    expect(text).toContain('只挖不垫:走 90 步,挖 28 块');
    expect(text).toContain('只靠走:只有部分路,能推进到离目标 9 格');
    // 没动身
    expect(rig.bot.entity.position.x).toBe(0.5);
  });

  it('路贵不拦:照走,把三种走法的数字附进完成回执', async () => {
    const rig = styleRig(PROBES_EXPENSIVE);
    rig.exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => rig.reports.length === 1);
    // 贵不贵是权衡,归她;旧闸门在这儿抛受阻,每触发一次烧一整轮
    expect(rig.reports[0].kind).toBe('done');
    expect(rig.reports[0].text).toContain('垫 23 块');
    expect(rig.reports[0].text).toContain('只挖不垫');
    expect(rig.bot.entity.position.x).not.toBe(0.5);
  });

  /**
   * 受阻回执同时保留出发前的三档试算与当前位置的读数。
   */
  it('走不到也留住出发前的试算结论,不白算一趟', async () => {
    const bot = combatBot({ goto: () => Promise.reject(new Error('NoPath')) });
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      probeRoutes: () => PROBES_EXPENSIVE,
    });
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('出发前按三种走法的试算:');
    expect(reports[0].text).toContain('探路到 (10, 64, 10):');
  }, 15_000);

  it('路平常就不啰嗦:回执里不塞试算', async () => {
    const rig = styleRig(PROBES_CHEAP);
    rig.exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => rig.reports.length === 1);
    expect(rig.reports[0].kind).toBe('done');
    expect(rig.reports[0].text).not.toContain('试算');
  });

  it('长途 partial 有进展、尽头贴着目标:都不算贵', async () => {
    const far = styleRig([
      { profile: 'style', status: 'partial', steps: 80, place: 0, breaks: 0, endDist: 100 },
      { profile: 'dig', status: 'partial', steps: 80, place: 0, breaks: 0, endDist: 100 },
      { profile: 'walk', status: 'partial', steps: 80, place: 0, breaks: 0, endDist: 100 },
    ]);
    far.exec.submit([{ skill: 'goto', at: [200, 64, 0] }]);
    await waitUntil(() => far.reports.length === 1);
    expect(far.reports[0].kind).toBe('done');
    expect(far.reports[0].text).not.toContain('试算');

    const near = styleRig([
      { profile: 'style', status: 'partial', steps: 6, place: 0, breaks: 2, endDist: 1 },
      { profile: 'dig', status: 'partial', steps: 6, place: 0, breaks: 2, endDist: 1 },
      { profile: 'walk', status: 'noPath', steps: 0, place: 0, breaks: 0, endDist: 5 },
    ]);
    near.exec.submit([{ skill: 'goto', at: [5, 64, 0] }]);
    await waitUntil(() => near.reports.length === 1);
    expect(near.reports[0].kind).toBe('done');
    expect(near.reports[0].text).not.toContain('试算');
  });

  it('三份探针全无结论也照走:算不出路不等于没路', async () => {
    const rig = styleRig([
      { profile: 'style', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 13 },
      { profile: 'dig', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 13 },
      { profile: 'walk', status: 'noPath', steps: 0, place: 0, breaks: 0, endDist: 13 },
    ]);
    rig.exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => rig.reports.length === 1);
    expect(rig.reports[0].kind).toBe('done');
    expect(rig.reports[0].text).toContain('限时内没算完');
  });

  it('timeout 只报实测出发距离,不报"太远/太绕"这种成因', async () => {
    // combatBot 在原点,目标 (10,64,10) 只有 14 格:此时"太远或太绕"是误导
    const rig = styleRig([
      { profile: 'style', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 13 },
      { profile: 'dig', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 13 },
      { profile: 'walk', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 13 },
    ]);
    rig.exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => rig.reports.length === 1);
    expect(rig.reports[0].text).toContain('出发点离目标 13 格');
    expect(rig.reports[0].text).not.toContain('目标远或绕');
  });

  it('目标站不进人:这是事实不是权衡,拦下;回执不给办法', async () => {
    const probes: RouteProbe[] = [
      { profile: 'style', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 3 },
      { profile: 'dig', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 3 },
      { profile: 'walk', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 3 },
    ];
    const rig = styleRig(probes, () => ({ kind: 'noStand' }));
    rig.exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => rig.reports.length === 1);
    expect(rig.reports[0].kind).toBe('blocked');
    expect(rig.reports[0].text).toContain('站不进人');
    for (const t of ['确认硬走', '想采它用 collect', '换一个邻近']) {
      expect(rig.reports[0].text).not.toContain(t);
    }
    expect(rig.bot.entity.position.x).toBe(0.5);
  });

  it('目标封在死角:报死角大小', async () => {
    const probes: RouteProbe[] = [
      { profile: 'style', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 4 },
      { profile: 'dig', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 4 },
      { profile: 'walk', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 4 },
    ];
    const rig = styleRig(probes, () => ({ kind: 'sealed', size: 9 }));
    rig.exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => rig.reports.length === 1);
    expect(rig.reports[0].kind).toBe('blocked');
    expect(rig.reports[0].text).toContain('约 9 格的死角');
  });

  it('分诊说 open:进得去就照走,不因为算不出路而拦', async () => {
    const probes: RouteProbe[] = [
      { profile: 'style', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 13 },
      { profile: 'dig', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 13 },
      { profile: 'walk', status: 'noPath', steps: 0, place: 0, breaks: 0, endDist: 13 },
    ];
    const rig = styleRig(probes, () => ({ kind: 'open' }));
    rig.exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => rig.reports.length === 1);
    expect(rig.reports[0].kind).toBe('done');
  });

  it('goto dryRun 带分诊行:站不进人的定性排在菜单前面,后面不跟建议', async () => {
    const rig = styleRig([
      { profile: 'style', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 3 },
      { profile: 'dig', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 3 },
      { profile: 'walk', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 3 },
    ], () => ({ kind: 'noStand' }));
    rig.exec.submit([{ skill: 'goto', at: [10, 64, 10], dryRun: true }]);
    await waitUntil(() => rig.reports.length === 1);
    expect(rig.reports[0].kind).toBe('done');
    expect(rig.reports[0].text).toContain('站不进人');
    expect(rig.reports[0].text).not.toContain('想采它用 collect');
  });
});

describe('寻路卡住判据:十秒没更近就跳闸', () => {
  it('原地打转不再等满两分钟:十秒没离目标更近就带着两个距离受阻', async () => {
    // flee 的目标只约束水平位置；无法靠岸时仍须识别停滞，避免一直占用逃生执行权。
    let rej: ((e: Error) => void) | null = null;
    const bot = combatBot({
      entities: { '1': { name: 'zombie', type: 'mob', position: new V(2, 64, 2), isValid: true } },
      // 永远走不到,位置一格不动 = 目标距离刷不出新低
      goto: () => new Promise<void>((_ok, reject) => { rej = reject; }),
    });
    // 撤目标时真寻路器会把挂着的 goto reject 掉,假件也照做
    (bot.pathfinder as { setGoal: (g: unknown) => void }).setGoal = (g) => {
      if (g === null) rej?.(new Error('GoalChanged'));
    };
    const { exec, reports } = makeExecutorOn(bot);
    const t0 = Date.now();
    exec.submit([{ skill: 'flee', distance: 24 }]);
    await waitUntil(() => reports.length === 1, 20_000);
    expect(reports[0].kind).toBe('blocked');
    // 假件的身体是冻着的,解卡一动没动:这一档报「钉在原地」,不是「走不过去」
    expect(reports[0].text).toContain('钉在原地');
    // 两个距离都要在:相等说明从没靠近过,现在更远说明被顶开了,她选的招不一样
    expect(reports[0].text).toContain('最近到过');
    expect(reports[0].text).toContain('人在 (0, 64, 0)');
    // flee 使用 GoalNearXZ，距离口径为水平距离。
    expect(reports[0].text).toContain('水平');
    // 时长报的是这一次真憋了多久,不是那个 10 秒常量:静止档确实是 10 秒上下
    expect(reports[0].text).toMatch(/钉在原地: 1[01]s 一格都没挪动过/);
    expect(reports[0].text).not.toContain('这一段一直在挖或搭');
    expect(Date.now() - t0).toBeLessThan(30_000); // 远早于 120 秒的 deadline
  }, 25_000);

  /**
   * 已站到目标旁边时报告够不到，避免将到达后的可达性问题写成未能行进。
   */
  it('人已经站在目标旁边:说的是「够不到」,不许再说「走不过去」', async () => {
    let rej: ((e: Error) => void) | null = null;
    let shuffle: ReturnType<typeof setInterval> | null = null;
    const bot = combatBot({
      goto: () => new Promise<void>((_ok, reject) => {
        rej = reject;
        // 在原地两格间来回蹭:净位移够不上「钉在原地」,而距离一次也没缩过
        shuffle = setInterval(() => {
          const p = bot.entity.position;
          bot.entity.position = new V(0.5, 64, p.z === 0.5 ? 2.5 : 0.5);
        }, 400);
      }),
    });
    (bot.pathfinder as { setGoal: (g: unknown) => void }).setGoal = (g) => {
      if (g === null) rej?.(new Error('GoalChanged'));
    };
    try {
      const { exec, reports } = makeExecutorOn(bot);
      // 2.5 格:落在核验半径(2 格)之外、「已经到跟前」的 3 格之内
      exec.submit([{ skill: 'goto', at: [3, 64, 0] }]);
      await waitUntil(() => reports.length === 1, 20_000);
      expect(reports[0].kind).toBe('blocked');
      // 段的目标要点名到格:同一条回执里另有步骤核验的那个"目标",两处不许同名
      expect(reports[0].text).toContain('够不到这一段的落点 (3, 64, 0)');
      expect(reports[0].text).toContain('已经到它旁边');
      expect(reports[0].text).not.toContain('走不过去');
      expect(reports[0].text).not.toContain('钉在原地');
      // 两个读数与口径照旧都在
      expect(reports[0].text).toContain('最近到过 直线');
    } finally {
      if (shuffle) clearInterval(shuffle);
    }
  }, 25_000);

  it('绕远路不算卡住:直线距离一路不降,但人一直在挪窝', async () => {
    // heuristic 是直线距离,绕湖绕山时它十几秒不降是正常的;只看距离会把绕路误判成卡住
    let rej: ((e: Error) => void) | null = null;
    let walk: ReturnType<typeof setInterval> | null = null;
    const bot = combatBot({
      entities: { '1': { name: 'zombie', type: 'mob', position: new V(2, 64, 2), isValid: true } },
      goto: () => new Promise<void>((_ok, reject) => {
        rej = reject;
        // 每秒往背着目标的方向挪 10 格:距离只涨不降,净位移一直在增
        walk = setInterval(() => {
          const p = bot.entity.position;
          bot.entity.position = new V(p.x + 10, p.y, p.z + 10);
        }, 1000);
      }),
    });
    (bot.pathfinder as { setGoal: (g: unknown) => void }).setGoal = (g) => {
      if (g === null) rej?.(new Error('GoalChanged'));
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'flee', distance: 24 }]);
    await sleep(12_000); // 越过 10 秒的卡住判据
    expect(reports).toHaveLength(0);
    if (walk) clearInterval(walk);
    exec.clear();
    exec.shutdown();
  }, 20_000);

  /**
   * 零位移快照须暴露挖掘、装备锁、控制键、队列冻结、身体占用和支撑放置状态，以区分停滞原因。
   */
  it('零位移探针:isMining 钉死为真时跳闸,快照里那一格看得见', async () => {
    const diag = new MinecraftLog();
    let rej: ((e: Error) => void) | null = null;
    const bot = combatBot({
      goto: () => new Promise<void>((_ok, reject) => { rej = reject; }),
    });
    // 寻路器自认在挖:goto 看门狗因此走 25 秒的"正在干活"宽限那一支
    Object.assign(bot.pathfinder, {
      isMining: () => true,
      isBuilding: () => false,
      isMoving: () => true,
      path: [{}, {}, {}],
      goal: null as unknown,
      setGoal: (g: unknown) => { if (g === null) rej?.(new Error('GoalChanged')); },
    });
    Object.assign(bot.entity, { onGround: true, velocity: new V(0, 0, 0), isInWater: false });
    Object.assign(bot, {
      controlState: { forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: true },
      pathPlacementActive: 1,
      pathSupportFailure: { seq: 3 },
    });
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      fleeHealth: () => 0,
      diag,
      bodyState: () => ({ combatActive: true, environmentOwnerKind: 'drown' }),
    });

    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => reports.length === 1, 40_000);

    // 停滞回执使用本次实际持续时长；挖掘或搭建使用较长的停滞窗口。
    expect(reports[0].text).toMatch(/2[5-9]s 没能(离这一段的落点 \(10, 64, 10\)更近|再靠近)一步\(这一段一直在挖或搭\)/);
    expect(reports[0].text).not.toContain('10 秒');

    const probes = diag.after(0).filter((e) => e.event === 'goto-stall-probe');
    expect(probes).toHaveLength(1);
    expect(probes[0].data).toMatchObject({
      trip: 'stall',
      isMining: true,
      isBuilding: false,
      isMoving: true,
      pathLen: 3,
      onGround: true,
      isInWater: false,
      combatActive: true,
      environmentOwnerKind: 'drown',
      queueHold: null,
      frozenTaskId: null,
      pathPlacementActive: 1,
      pathSupportSeq: 3,
      controlState: { forward: true, sneak: true },
    });
    // 快照要齐:少一格就有一个候选分不出来
    for (const key of ['goalKind', 'goalStillMine', 'velocity', 'position']) {
      expect(probes[0].data).toHaveProperty(key);
    }
    exec.shutdown();
  }, 45_000);
});



describe('find:站着扫与边走边找', () => {
  /** 走够 `foundAfter` 格之后 findBlocks 才报到目标;0 = 一开始就在眼前 */
  function scoutBot(foundAfter: number) {
    const scans: number[] = [];
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      players: {},
      registry: {
        blocks: { 17: { name: 'acacia_log' } },
        blocksByName: { acacia_log: { id: 17, name: 'acacia_log' } },
        items: {},
        itemsByName: {},
      },
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: () => {
        const walked = Math.abs(bot.entity.position.x - 0.5);
        scans.push(walked);
        return walked >= foundAfter ? [new V(walked + 6, 64, 0)] : [];
      },
      blockAt: () => ({ name: 'acacia_log' }),
      canSeeBlock: () => true,
      pathfinder: { stop() {}, setGoal() {}, goto: async (_goal: FakeGoal) => {} },
      scans,
    };
    return bot;
  }

  /**
   * 站着扫描的假 bot 按半径过滤 findBlocks，canSeeBlock 可按格开关。
   */
  function standBot(cells: Array<[number, number, number]>, opts: { blind?: string[] } = {}) {
    const blind = new Set(opts.blind ?? []);
    const me = new V(0.5, 64, 0.5);
    return {
      entity: { id: 9, position: me },
      entities: {},
      health: 20,
      players: {},
      registry: {
        blocks: { 54: { name: 'chest' }, 15: { name: 'iron_ore' } },
        blocksByName: { chest: { id: 54, name: 'chest' }, iron_ore: { id: 15, name: 'iron_ore' } },
        items: {},
        itemsByName: {},
      },
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: ({ maxDistance }: { maxDistance: number }) => cells
        .map(([x, y, z]) => new V(x, y, z))
        .filter((v) => Math.hypot(v.x - me.x, v.y - me.y, v.z - me.z) <= maxDistance),
      blockAt: (v: V) => ({ name: 'chest', position: v }),
      canSeeBlock: (b: { position: V }) => !blind.has(`${b.position.x},${b.position.y},${b.position.z}`),
      // 挡着的不是玻璃:透光集那条加法路不放行
      world: { raycast: () => null },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => { throw new Error('站着扫不该走路'); } },
    };
  }

  it('站着扫:不给 direction 就不挪地方,按距离先近后远,带方位与高差', async () => {
    const bot = standBot([[6, 64, 0], [0, 64, 20], [10, 72, 0]]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'chest', distance: 48 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('在周围 48 格内看见 3 处箱子');
    const t = reports[0].text;
    expect(t.indexOf('(6, 64, 0)')).toBeLessThan(t.indexOf('(10, 72, 0)'));
    expect(t.indexOf('(10, 72, 0)')).toBeLessThan(t.indexOf('(0, 64, 20)'));
    expect(t).toContain('东边');
    expect(t).toContain('上方'); // (10,72,0) 比脚下高 8 格
    expect(t).toContain('blockAt=(6, 64, 0)');
    expect(t).toContain('目标方块占用格,不是可站落点');
    expect(t).not.toContain('approachAt=');
    expect(bot.entity.position.x).toBe(0.5); // 一步都不走
  });

  it('站着扫过视线闸:看不见的那几处一个字都不报', async () => {
    const bot = standBot([[6, 64, 0], [8, 64, 0]], { blind: ['8,64,0'] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'chest', distance: 48 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('看见 1 处');
    expect(reports[0].text).not.toContain('(8, 64, 0)');
  });

  // 扫描无结果时按目标类型给出下一步。
  it('站着扫空手:按目标类型给下一步,不留死胡同', async () => {
    const ore = standBot([]);
    const a = makeExecutorOn(ore);
    a.exec.submit([{ skill: 'find', target: 'iron_ore', distance: 32 }]);
    await waitUntil(() => a.reports.length === 1, 8000);
    expect(a.reports[0].kind).toBe('done');
    expect(a.reports[0].text).toContain('没看见铁矿石');
    expect(a.reports[0].text).toContain('不表示目标不存在');
    expect(a.reports[0].text).toContain('挖开');
    expect(a.reports[0].text).toContain('洞穴');

    const box = standBot([]);
    const b = makeExecutorOn(box);
    b.exec.submit([{ skill: 'find', target: 'chest', distance: 32 }]);
    await waitUntil(() => b.reports.length === 1, 8000);
    expect(b.reports[0].text).toContain('多半在屋里');
    expect(b.reports[0].text).toContain('门口或者窗户');
  });

  it('站着扫写了超过感知半径的距离:照实说站着只看得到那么远,并指向走过去', async () => {
    const bot = standBot([]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'chest', distance: 300 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('在周围 48 格内');
    expect(reports[0].text).toContain('站着最远只看得到 48 格');
    expect(reports[0].text).toContain('direction');
  });

  it('找着了就停下报坐标', async () => {
    const bot = scoutBot(48);
    bot.pathfinder.goto = async (goal: FakeGoal) => {
      bot.entity.position = new V(goal.x ?? bot.entity.position.x, 64, goal.z ?? 0.5);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'acacia_log', direction: 'east', distance: 200 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('看见了金合欢原木');
    // 48 格就该收手,不会一路走满 200
    expect(Math.abs(bot.entity.position.x)).toBeLessThan(80);
  });

  it('边走边找的每段目标只锚 XZ:一段段往下走也不改判据', async () => {
    const bot = scoutBot(Infinity);
    bot.entity.position = new V(0.5, 70, 0.5);
    const goalsSeen: FakeGoal[] = [];
    bot.pathfinder.goto = async (goal: FakeGoal) => {
      goalsSeen.push(goal);
      // 每段落脚比上一段低一格:高度既然不进判据,累计下沉也不该让任何一段落空
      bot.entity.position = new V(goal.x!, bot.entity.position.y - 1, goal.z!);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'acacia_log', direction: 'east', distance: 96 }]);
    await waitUntil(() => reports.length === 1, 8000);

    expect(goalsSeen).toHaveLength(4);
    expect(goalsSeen.every((g) => g.constructor.name === 'GoalNearXZ')).toBe(true);
    expect(goalsSeen.map((g) => g.y)).toEqual([undefined, undefined, undefined, undefined]);
    expect(goalsSeen.map((g) => g.x)).toEqual([25, 49, 73, 97]);
    expect(reports[0].kind).toBe('done');
  });

  /**
   * 夹具使用 1:4 连续坡面；每段目标 XZ 的地面 Y 都会变化，不能用起点 Y 附近的三维球排除合法落点。
   */
  it('1:4 连续上坡的多段行军:每段都走得到,不是零位移受阻', async () => {
    const bot = scoutBot(Infinity);
    bot.entity.position = new V(0.5, 70, 0.5);
    const goalsSeen: FakeGoal[] = [];
    const walk = terrainGoto(bot, (x) => 70 + Math.floor(Math.max(x, 0) / 4));
    bot.pathfinder.goto = (async (goal: JudgingGoal) => {
      goalsSeen.push(goal);
      await walk(goal);
    }) as never;
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'acacia_log', direction: 'east', distance: 96 }]);
    await waitUntil(() => reports.length === 1, 12_000);

    expect(reports[0].kind).toBe('done');
    expect(goalsSeen).toHaveLength(4);
    // 净位移达标:96 格走满,人也真被坡抬上去了
    expect(bot.entity.position.x).toBeGreaterThanOrEqual(96);
    expect(bot.entity.position.y).toBeGreaterThanOrEqual(94);
    expect(reports[0].text).not.toContain('走不过去');
  }, 15_000);

  /**
   * 行军扫描只覆盖路径及视野范围，不能据此排除整个方向。
   */
  it('走满了没找着不算失败:报走了多远、没看见什么、人在哪,不下"这个方向可以排除"的结论', async () => {
    const bot = scoutBot(Infinity);
    bot.pathfinder.goto = async (goal: FakeGoal) => {
      bot.entity.position = new V(goal.x ?? bot.entity.position.x, 64, goal.z ?? 0.5);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'acacia_log', direction: 'east', distance: 96 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('一路没看见金合欢原木');
    expect(reports[0].text).not.toContain('排除');
    // 原木不是屋里的东西,不提穿墙那条路
    expect(reports[0].text).not.toContain('radius');
  });

  // 结束时回到出发点可能源于水流或重生；净位移为零不能声称完成了声明距离的搜索。
  it('一趟走完净位移 0:说的是没走出去,不说"走满了 0 格"', async () => {
    const bot = scoutBot(Infinity);
    const scan = bot.findBlocks;
    let legs = 0;
    bot.pathfinder.goto = async (goal: FakeGoal) => {
      legs += 1;
      bot.entity.position = new V(goal.x ?? bot.entity.position.x, 64, goal.z ?? 0.5);
    };
    // 最后一段刚走完就被冲回出发点;扫描这一拍正是收工前读世界的那一拍
    bot.findBlocks = (() => {
      const hits = scan();
      if (legs === 2) bot.entity.position = new V(0.5, 64, 0.5);
      return hits;
    }) as never;
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'acacia_log', direction: 'east', distance: 48 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('朝东这一趟没走出去(要走 48 格,人还在出发点)');
    expect(reports[0].text).not.toContain('走满了');
  });

  it('走满没看见屋里那类东西(箱子等):尾注说清该走近了看,不再递穿墙那条路', async () => {
    // 视线扫描看不到墙后的箱子。
    const bot = scoutBot(Infinity);
    bot.registry.blocksByName = { chest: { id: 54, name: 'chest' } } as never;
    bot.registry.blocks = { 54: { name: 'chest' } } as never;
    bot.pathfinder.goto = async (goal: FakeGoal) => {
      bot.entity.position = new V(goal.x ?? bot.entity.position.x, 64, goal.z ?? 0.5);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'chest', direction: 'east', distance: 96 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('一路没看见箱子');
    expect(reports[0].text).toContain('多半在屋里');
    expect(reports[0].text).toContain('门口或者窗户');
    // 穿墙那条路已经撤了,不许再递
    expect(reports[0].text).not.toContain('radius');
  });

  it('不认识的方块当场退回,不白走一趟', async () => {
    const bot = scoutBot(0);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: '大树', direction: 'east', distance: 96 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('不认识');
  });


  it('#类别写进 target:说清它是 until 的写法,并把这里该写什么给出来', async () => {
    const bot = scoutBot(0);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: '#logs', direction: 'east', distance: 96 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].text).toContain('是 until 名单的写法');
    expect(reports[0].text).toContain('裸名 log');
    expect(reports[0].text).toContain('oak_log');
    expect(reports[0].text).not.toContain('不认识');
  });

  it('#后面跟的词不在 until 名单里:连名单一起念出来', async () => {
    const bot = scoutBot(0);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: '#planks', direction: 'east', distance: 96 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].text).toContain('#ores');
    expect(reports[0].text).toContain('#logs');
  });

  /**
   * 写类别名找到具体一种时,回执要报实际看见的那种,不是入参那个词。
   * target 常是看图猜的,照它报等于把猜测坐实,以后会一直去找这个群系根本没有的树种。
   */
  it('报实际找到的那一种,不照抄入参那个词', async () => {
    const bot = scoutBot(0);
    bot.registry.blocks = { 17: { name: 'acacia_log' }, 18: { name: 'jungle_log' } } as never;
    bot.registry.blocksByName = {
      acacia_log: { id: 17, name: 'acacia_log' },
      jungle_log: { id: 18, name: 'jungle_log' },
    } as never;
    bot.blockAt = (() => ({ name: 'jungle_log' })) as never;

    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'log', direction: 'east', distance: 96 }]);
    await waitUntil(() => reports.length === 1, 8000);

    expect(reports[0].text).toContain('丛林原木');
    expect(reports[0].text).not.toContain('金合欢');
  });

  /**
   * 出发前的 48 格全向扫描按目标实际位置报告方位。
   * 任务 direction 只约束后续探索,不得覆盖扫描结果的方向。
   */
  it('还没走就看见的:报它实际在哪个方向,不跟着任务的方向词说', async () => {
    const bot = scoutBot(0);
    bot.findBlocks = () => [new V(0, 64, -34)]; // 正北 34 格,而这一条是"朝南找"
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'acacia_log', direction: 'south', distance: 200 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('还没往南走');
    expect(reports[0].text).toContain('在我北边 35 格');
    expect(reports[0].text).toContain('请求的南向行军尚未发生');
    expect(reports[0].text).toContain('不是南向搜索结果');
  });

  it('未命中时只引用本执行器真实见过的带年龄线索', async () => {
    const cells: Array<[number, number, number]> = [[6, 64, 0]];
    const bot = standBot(cells);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'chest', distance: 48 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).not.toContain('真实历史观察');

    cells.splice(0);
    exec.submit([{ skill: 'find', target: 'chest', distance: 48 }]);
    await waitUntil(() => reports.length === 2, 8000);
    expect(reports[1].text).toMatch(/真实历史观察:\d+ 秒前曾看见箱子/);
    expect(reports[1].text).toContain('现在没有复见,只能当过期线索');
  });

  it('target 也认实体:sheep 是实体不是方块,看得见就报位置并标明它会动', async () => {
    const bot = scoutBot(0);
    bot.registry = {
      ...bot.registry,
      entitiesByName: { sheep: { id: 91 } },
    } as never;
    (bot as { entities: unknown }).entities = {
      '7': { name: 'sheep', height: 1.3, position: new V(4, 64, 9) },
    };
    (bot as { world?: unknown }).world = { raycast: () => null }; // 视线无遮挡
    bot.findBlocks = () => [];
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'sheep', direction: 'north', distance: 100 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('羊');
    expect(reports[0].text).toContain('(4, 64, 9)');
    expect(reports[0].text).toContain('它会动');
  });

  /** explored 回调可断言的执行器:scoutBot + 群系注册表 */
  function coverageRig(bot: ReturnType<typeof scoutBot>) {
    bot.registry = { ...bot.registry, biomes: { 5: { name: 'plains' } } } as never;
    bot.blockAt = (() => ({ name: 'acacia_log', biome: { id: 5 } })) as never;
    bot.pathfinder.goto = async (goal: FakeGoal) => {
      bot.entity.position = new V(goal.x ?? bot.entity.position.x, 64, goal.z ?? 0.5);
    };
    const reports: TaskReport[] = [];
    const recs: Array<{ dimension: string; direction: string; distance: number; biome: string }> = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      explored: (dimension, direction, distance, biome) => recs.push({ dimension, direction, distance, biome }),
    });
    return { exec, reports, recs };
  }

  it('走满收工落覆盖账本:方向、走出的格数、末端群系', async () => {
    const { exec, reports, recs } = coverageRig(scoutBot(Infinity));
    exec.submit([{ skill: 'find', target: 'acacia_log', direction: 'east', distance: 96 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(recs).toHaveLength(1);
    expect(recs[0].dimension).toBe('overworld');
    expect(recs[0].direction).toBe('east');
    expect(recs[0].distance).toBeGreaterThanOrEqual(90);
    expect(recs[0].biome).toBe('plains');
  });

  it('半路命中也落账,距离是实际走出的那截', async () => {
    const { exec, reports, recs } = coverageRig(scoutBot(48));
    exec.submit([{ skill: 'find', target: 'acacia_log', direction: 'east', distance: 200 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(recs).toHaveLength(1);
    expect(recs[0].dimension).toBe('overworld');
    expect(recs[0].direction).toBe('east');
    expect(recs[0].distance).toBeGreaterThanOrEqual(48);
    expect(recs[0].distance).toBeLessThan(200);
  });

  it('还没走就看见的不算探过,账本不落', async () => {
    const { exec, reports, recs } = coverageRig(scoutBot(0));
    exec.submit([{ skill: 'find', target: 'acacia_log', direction: 'east', distance: 96 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].text).toContain('还没往东走');
    expect(recs).toHaveLength(0);
  });

  it('实体隔着方块只闻其声不算找到:感知规则与方块一致', async () => {
    const bot = scoutBot(Infinity);
    bot.registry = {
      ...bot.registry,
      entitiesByName: { sheep: { id: 91 } },
    } as never;
    (bot as { entities: unknown }).entities = {
      '7': { name: 'sheep', height: 1.3, position: new V(4, 64, 9) },
    };
    (bot as { world?: unknown }).world = { raycast: () => ({ position: new V(2, 64, 5) }) }; // 视线被挡
    bot.findBlocks = () => [];
    bot.pathfinder.goto = async (goal: FakeGoal) => {
      bot.entity.position = new V(goal.x ?? bot.entity.position.x, 64, goal.z ?? 0.5);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'sheep', direction: 'north', distance: 48 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('一路没看见羊');
  });
});

/**
 * 合成用的假 bot:1 根金合欢原木换 4 块木板,不用工作台。
 * `gain` 决定合成事务被接受之后东西进不进包:1.20.6 上出现过
 * bot.craft 正常返回、物品栏一个都不多的情形。
 */

describe('toss / pickup 过滤 / 箱子', () => {
  it('toss 按实测扔出数量回执,包里没有就受阻', async () => {
    const counts = new Map<string, number>([['cobblestone', 20]]);
    const bot = {
      entity: { id: 1, position: new V(0.5, 64, 0.5) },
      entities: {},
      game: { dimension: 'overworld' },
      registry: { itemsByName: {}, blocksByName: {} },
      inventory: {
        items: () => [...counts].filter(([, n]) => n > 0)
          .map(([name, count]) => ({ type: 1, metadata: 0, name, count })),
      },
      toss: async (_type: number, _meta: number | null, n: number) => {
        counts.set('cobblestone', (counts.get('cobblestone') ?? 0) - n);
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'toss', item: 'cobblestone', count: 8 }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('扔掉了圆石×8');
    expect(counts.get('cobblestone')).toBe(12);
    exec.submit([{ skill: 'toss', item: 'coal', count: 1 }]);
    await waitUntil(() => reports.length === 2);
    expect(reports[1].kind).toBe('blocked');
    expect(reports[1].text).toContain('包里没有');
  });

  /**
   * pickup 按库存增量验收；战利品可能在扫描掉落物之前已自动进入背包。
   */
  function dropBot() {
    const bag: Array<{ name: string; count: number }> = [];
    const walked: string[] = [];
    const entities: Record<string, unknown> = {
      '1': {
        name: 'item', type: 'object', position: new V(3, 64, 0.5), isValid: true,
        getDroppedItem: () => ({ name: 'coal', count: 1 }),
      },
      '2': {
        name: 'item', type: 'object', position: new V(0.5, 64, -4), isValid: true,
        getDroppedItem: () => ({ name: 'porkchop', count: 3 }),
      },
    };
    const bot = {
      bag,
      walked,
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities,
      health: 20,
      players: {},
      registry: { items: {}, itemsByName: {} },
      inventory: { items: () => bag },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      pathfinder: {
        stop() {},
        setGoal() {},
        goto: async (goal: FakeGoal) => {
          walked.push(`${goal.x},${goal.z}`);
          // 走到了就捡起来:实体消失,东西进包
          delete entities['2'];
          bag.push({ name: 'porkchop', count: 3 });
        },
      },
    };
    return bot;
  }

  it('pickup 按物品栏净增判成:带 item 只走向匹配的掉落物', async () => {
    const bot = dropBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'pickup', item: 'porkchop' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('任务#1完成: ');
    expect(reports[0].text).toContain('捡了 生猪排×3');
    expect(bot.walked.some((p) => p.includes('-4'))).toBe(true);
    // 煤那一堆不匹配 item,一步都不该走过去
    expect(bot.walked.some((p) => p.startsWith('3,'))).toBe(false);
  });

  /**
   * 原版拾取半径会吸入路过的其他物品；点名 pickup 的选目标与库存验收须使用同一 item 条件。
   */
  it('pickup:点名要的没进包,不许拿顺手吸进来的那些冒充', async () => {
    const bot = dropBot();
    // 走向生猪排的路上把深板岩圆石吸进了包,生猪排一块都没捡到
    bot.pathfinder.goto = async () => {
      delete (bot.entities as Record<string, unknown>)['2'];
      bot.bag.push({ name: 'deepslate_cobblestone', count: 61 });
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'pickup', item: 'porkchop' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('没捡到生猪排');
    expect(reports[0].text).toContain('顺手带进包的:');
    expect(reports[0].text).toContain('×61');
    expect(reports[0].text).not.toContain('捡了 深板岩');
  });

  it('pickup:要的进了包,顺手带的另起一栏,两栏都照报', async () => {
    const bot = dropBot();
    const inner = bot.pathfinder.goto;
    bot.pathfinder.goto = async (goal: FakeGoal) => {
      await inner(goal);
      bot.bag.push({ name: 'deepslate_cobblestone', count: 7 });
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'pickup', item: 'porkchop' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('捡了 生猪排×3');
    expect(reports[0].text).toContain('顺手带进包的:');
  });

  it('pickup:一处掉落物实体都没有,只要包里多了就算捡到', async () => {
    const bot = dropBot();
    // 战利品自己飞进包里、实体压根没在 entities 里露过面:一步都不用走
    delete (bot.entities as Record<string, unknown>)['1'];
    delete (bot.entities as Record<string, unknown>)['2'];
    setTimeout(() => bot.bag.push({ name: 'porkchop', count: 3 }), 200);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'pickup' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('任务#1完成: ');
    expect(reports[0].text).toContain('捡了 生猪排×3');
    expect(bot.walked).toEqual([]);
  });

  it('stow 存进最近箱子并刷新账本', async () => {
    const inv = new Map<string, number>([['cobblestone', 64]]);
    const box: Array<{ type: number; metadata: number; name: string; count: number }> = [];
    const chestPos = new V(2, 64, 0);
    const bot = {
      entity: { id: 1, position: new V(0.5, 64, 0.5) },
      entities: {},
      game: { dimension: 'overworld' },
      registry: {
        blocksByName: { chest: { id: 54, name: 'chest' } },
        itemsByName: {},
      },
      inventory: {
        items: () => [...inv].filter(([, n]) => n > 0)
          .map(([name, count]) => ({ type: 4, metadata: 0, name, count })),
      },
      findBlocks: () => [chestPos],
      blockAt: (p: V) => (p.x === 2 && p.y === 64 && p.z === 0
        ? { name: 'chest', position: p, boundingBox: 'block' }
        : { name: 'air', position: p, boundingBox: 'empty' }),
      openContainer: async () => ({
        deposit: async (_t: number, _m: number | null, n: number) => {
          inv.set('cobblestone', (inv.get('cobblestone') ?? 0) - n);
          const cur = box.find((i) => i.name === 'cobblestone');
          if (cur) cur.count += n;
          else box.push({ type: 4, metadata: 0, name: 'cobblestone', count: n });
        },
        withdraw: async () => {},
        containerItems: () => [...box],
        inventoryStart: 27,
        close: () => {},
      }),
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { ChestBook } = await import('../../../src/worlds/minecraft/chests.ts');
    const book = new ChestBook(null);
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      chests: book,
    });
    exec.submit([{ skill: 'stow', item: 'cobblestone', count: 64 }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('存了圆石×64');
    expect(book.get('overworld', { x: 2, y: 64, z: 0 })?.items).toEqual([{ name: 'cobblestone', count: 64 }]);
  });

  it('take:附近只有运输矿车时开它的箱子取,回执点名是运输矿车', async () => {
    const bag = new Map<string, number>();
    const cart = new Map<string, number>([['enchanted_book', 1], ['rail', 9]]);
    const ids: Record<string, number> = { enchanted_book: 13, rail: 14 };
    const stacks = (m: Map<string, number>) => [...m].filter(([, n]) => n > 0)
      .map(([name, count]) => ({ type: ids[name], metadata: 0, name, count, slot: 0 }));
    const opened: unknown[] = [];
    const cartEntity = { id: 7, name: 'chest_minecart', position: new V(3.5, 64, 0.5), isValid: true };
    const bot = {
      entity: { id: 1, position: new V(0.5, 64, 0.5) },
      entities: { 7: cartEntity },
      game: { dimension: 'overworld' },
      registry: { blocksByName: { chest: { id: 54, name: 'chest' } }, itemsByName: {} },
      inventory: { items: () => stacks(bag) },
      findBlocks: () => [],
      blockAt: (p: V) => ({ name: 'air', position: p, boundingBox: 'empty' }),
      openContainer: async (target: unknown) => {
        opened.push(target);
        return {
          items: () => stacks(bag),
          containerItems: () => stacks(cart),
          inventoryStart: 27,
          firstEmptyInventorySlot: () => 27,
          withdraw: async (type: number, _m: number | null, n: number) => {
            const name = Object.keys(ids).find((k) => ids[k] === type)!;
            const k = Math.min(n, cart.get(name) ?? 0);
            cart.set(name, (cart.get(name) ?? 0) - k);
            bag.set(name, (bag.get(name) ?? 0) + k);
          },
          close: () => {},
        };
      },
      pathfinder: {
        stop() {}, setGoal() {},
        goto: async (g: FakeGoal) => { bot.entity.position = new V(g.x!, g.y!, g.z!); },
      },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'take', item: 'enchanted_book', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(opened).toEqual([cartEntity]);
    expect(bag.get('enchanted_book')).toBe(1);
    expect(reports[0].text).toContain('(3, 64, 0) 的运输矿车 取出附魔书×1');
  });

  it('use 右键运输矿车开出箱子窗口:回执念出里面有什么并关窗', async () => {
    const cartEntity = { id: 7, name: 'chest_minecart', position: new V(2.5, 64, 0.5), isValid: true, height: 0.7 };
    const closed: unknown[] = [];
    const win = {
      id: 3, type: 'minecraft:generic_9x3', inventoryStart: 27,
      containerItems: () => [{ name: 'enchanted_book', count: 1 }, { name: 'rail', count: 9 }],
    };
    const bot = {
      entity: { id: 1, position: new V(0.5, 64, 0.5) },
      entities: { 7: cartEntity },
      game: { dimension: 'overworld' },
      health: 20,
      players: {},
      heldItem: null,
      registry: { blocksByName: {}, itemsByName: {}, entitiesByName: { chest_minecart: {} } },
      inventory: { items: () => [] },
      currentWindow: null as typeof win | null,
      closeWindow: (w: unknown) => { closed.push(w); bot.currentWindow = null; },
      lookAt: async () => {},
      useOn: async () => { bot.currentWindow = win; },
      blockAt: (p: V) => ({ name: 'air', position: p, boundingBox: 'empty' }),
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', target: 'chest_minecart' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('开出了它的箱子窗口,里面:');
    expect(reports[0].text).toContain('附魔书×1');
    expect(closed).toEqual([win]);
  });

  it('stow:首选箱子放不下就换下一口,大箱子另一半不重开,回执逐口报数和剩下的', async () => {
    let inv = 64;
    // (2,64,0)+(2,64,1) 是一口朝东的大箱子,两半开出同一扇窗;(5,64,0) 是单箱
    const boxes = new Map<string, { room: number; held: number }>([
      ['double', { room: 20, held: 0 }], ['single', { room: 30, held: 0 }],
    ]);
    const cells: Record<string, { box: string; props: Record<string, string> }> = {
      '2,64,0': { box: 'double', props: { facing: 'east', type: 'left' } },
      '2,64,1': { box: 'double', props: { facing: 'east', type: 'right' } },
      '5,64,0': { box: 'single', props: { facing: 'east', type: 'single' } },
    };
    const opens: string[] = [];
    const bot = {
      entity: { id: 1, position: new V(0.5, 64, 0.5) },
      entities: {},
      game: { dimension: 'overworld' },
      registry: { blocksByName: { chest: { id: 54, name: 'chest' } }, itemsByName: {} },
      inventory: { items: () => (inv > 0 ? [{ type: 4, metadata: 0, name: 'cod', count: inv }] : []) },
      findBlocks: () => Object.keys(cells).map((k) => new V(...(k.split(',').map(Number) as [number, number, number]))),
      blockAt: (p: V) => {
        const c = cells[`${p.x},${p.y},${p.z}`];
        return c
          ? { name: 'chest', position: p, boundingBox: 'block', getProperties: () => c.props }
          : { name: 'air', position: p, boundingBox: 'empty', getProperties: () => ({}) };
      },
      openContainer: async (block: { position: V }) => {
        const box = boxes.get(cells[`${block.position.x},${block.position.y},${block.position.z}`].box)!;
        opens.push(`${block.position.x},${block.position.y},${block.position.z}`);
        return {
          deposit: async (_t: number, _m: number | null, n: number) => {
            if (box.room === 0) throw new Error('destination full');
            const k = Math.min(n, box.room);
            box.room -= k;
            box.held += k;
            inv -= k;
          },
          withdraw: async () => {},
          containerItems: () => (box.held > 0 ? [{ type: 4, metadata: 0, name: 'cod', count: box.held }] : []),
          inventoryStart: 27,
          close: () => {},
        };
      },
      pathfinder: {
        stop() {}, setGoal() {},
        goto: async (g: FakeGoal) => { bot.entity.position = new V(g.x! + 0.5, g.y!, g.z! + 0.5); },
      },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'stow', item: 'cod', count: 64 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(opens).toEqual(['2,64,0', '5,64,0']);
    expect(inv).toBe(14);
    expect(reports[0].text).toContain('分 2 口箱子存,共存进生鳕鱼×50');
    expect(reports[0].text).toContain('还有生鳕鱼×14没放下');
    expect(reports[0].text).toContain('往(2, 64, 0) 的箱子存了生鳕鱼×20');
    expect(reports[0].text).toContain('往(5, 64, 0) 的箱子存了生鳕鱼×30');
  });
});

describe('brew · 与 smelt 同构的下料点火就走', () => {
  it('三个瓶位下料,燃料补一份,回执报燃料轮数、在酿与取货写法', async () => {
    const { bot, stand, slots } = brewBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'brew', at: stand, input: 'nether_wart', bottle: 'potion', count: 3, fuel: 'blaze_powder' }]);
    await waitUntil(() => reports.length === 1, 8000);
    const t = reports[0].text;
    expect(reports[0].kind).toBe('done');
    expect(t).toContain('材料位下界疣');
    expect(t).toContain('燃料位补了烈焰粉');
    expect(t).toContain('燃料还能烧 20/20 轮');
    expect(t).toContain('正在酿');
    expect(t).toContain(`{"skill":"take","at":[${stand[0]},${stand[1]},${stand[2]}],"all":true}`);
    expect(slots[3]?.name).toBe('nether_wart');
    expect(slots.slice(0, 3).filter(Boolean)).toHaveLength(3);
  });

  it('台里没燃料、包里也没有烈焰粉:受阻说清,不报「燃料槽本来就有」', async () => {
    const { bot, stand } = brewBot({ inv: { potion: 3, nether_wart: 1 } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'brew', at: stand, input: 'nether_wart', bottle: 'potion', count: 3, fuel: 'blaze_powder' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('燃料 0/20 轮、燃料位空,包里也没有烈焰粉');
  });

  it('包里没有那样材料:当场受阻,不白跑一趟', async () => {
    const { bot, stand } = brewBot({ inv: { potion: 3, blaze_powder: 1 } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'brew', at: stand, input: 'nether_wart', bottle: 'potion', count: 3, fuel: 'blaze_powder' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('包里没有下界疣');
  });

  it('那一格不是酿造台:报它实际是什么', async () => {
    const { bot } = brewBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'brew', at: [1, 64, 0], input: 'nether_wart', bottle: 'potion', count: 3, fuel: 'blaze_powder' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('不是酿造台');
  });

  it('take at 认酿造台:五个槽一起掏回来', async () => {
    const { bot, stand, inv } = brewBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'brew', at: stand, input: 'nether_wart', bottle: 'potion', count: 3, fuel: 'blaze_powder' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(inv.get('potion')).toBe(0);
    exec.submit([{ skill: 'take', at: stand, all: true }]);
    await waitUntil(() => reports.length === 2, 8000);
    expect(reports[1].kind).toBe('done');
    expect(reports[1].text).toContain('取了');
    expect(inv.get('potion')).toBe(3);
  });
});

/**
 * 附近没有箱子时，回执补充账本中最近已知箱子的位置和距离，不代替调用方选择去留。
 */
describe('附近没箱子:受阻句带上账本里最近的那个', () => {
  /** 32 格内一个容器都扫不到的台架:账本照样喂满 */
  const noContainerBot = (opts: Parameters<typeof chestBot>[0] = {}) => {
    const rig = chestBot(opts);
    rig.bot.findBlocks = () => [];
    return rig;
  };

  it('stow:账上有本维度的箱子就报坐标与直线距离,跨维度的不算', async () => {
    const { bot } = noContainerBot({ inv: { cobblestone: 64 } });
    const book = new ChestBook(null);
    // 主世界远处一个、近处一个;下界那个坐标上更近,但维度不同不可比
    book.remember('overworld', { x: -213, y: 16, z: 38 }, [{ name: 'cobblestone', count: 12 }], 1, 27);
    book.remember('overworld', { x: 10, y: 64, z: 0 }, [], 0, 27);
    book.remember('the_nether', { x: 1, y: 64, z: 1 }, [], 0, 27);
    const { exec, reports } = makeExecutorWith(bot, book);
    exec.submit([{ skill: 'stow', item: 'cobblestone', count: 64 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('32 格内没有箱子');
    expect(reports[0].text).toContain('账上本维度最近的是你开过的箱子 (10, 64, 0),直线 10 格(上次看见)');
    expect(reports[0].text).not.toContain('(1, 64, 1)');
    expect(reports[0].text).not.toContain('(-213, 16, 38)');
  });

  it('stow:账上没有本维度的箱子就维持原样那一句', async () => {
    const { bot } = noContainerBot({ inv: { cobblestone: 64 } });
    const book = new ChestBook(null);
    book.remember('the_nether', { x: 1, y: 64, z: 1 }, [], 0, 27);
    // 工作站不是箱子:自备的工作台/炉子不许顶上来充数
    book.rememberStation('overworld', { x: 1, y: 64, z: 1 }, 'crafting_table', Date.now());
    book.rememberFurnace(
      'overworld', { x: 1, y: 64, z: 2 }, 'furnace',
      { input: null, fuel: null, output: null }, Date.now(), null,
    );
    const { exec, reports } = makeExecutorWith(bot, book);
    exec.submit([{ skill: 'stow', item: 'cobblestone', count: 64 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('32 格内没有箱子');
    expect(reports[0].text).not.toContain('账上本维度最近的是');
  });

  it('take:同一段补注,同一句措辞', async () => {
    const { bot } = noContainerBot({ box: { coal: 4 } });
    const book = new ChestBook(null);
    book.remember('overworld', { x: 10, y: 64, z: 0 }, [{ name: 'coal', count: 4 }], 1, 27);
    const { exec, reports } = makeExecutorWith(bot, book);
    exec.submit([{ skill: 'take', item: 'coal', count: 4 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('32 格内没有箱子');
    expect(reports[0].text).toContain('账上本维度最近的是你开过的箱子 (10, 64, 0),直线 10 格(上次看见)');
  });
});

describe('容器账本:下料入账、到期、抢占点名', () => {
  const FURNACE_AT = [{ x: 2, y: 64, z: 0, name: 'furnace' }];

  it('燃料耗完留下原料:三槽位写账本,没有燃烧确认就不登记到期提醒', async () => {
    const book = new ChestBook(null);
    // 一块木板只够烧一件,剩两件粗铁留在输入槽。
    const { bot } = furnaceBot({ inv: { raw_iron: 3, oak_planks: 1 }, furnaces: FURNACE_AT });
    const { exec, reports } = makeExecutorWith(bot, book);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 3, fuel: 'oak_planks' }]);
    await waitUntil(() => reports.length === 1, 8000);
    const rec = book.get('overworld', { x: 2, y: 64, z: 0 })!;
    expect(rec.name).toBe('furnace');
    expect(rec.furnace!.input?.name).toBe('raw_iron');
    expect(rec.furnace!.input?.count).toBe(2);
    expect(rec.furnace!.output?.name).toBe('iron_ingot');
    expect(rec.furnace!.expectedDoneAt).toBeNull();
    expect(book.due(Date.now())).toHaveLength(0);
    expect(book.due(Date.now() + 60_000)).toHaveLength(0);
  });

  it('撞上输入槽留着别的原料:受阻,但看见的槽位照样入账', async () => {
    const book = new ChestBook(null);
    const { bot } = furnaceBot({ inv: { oak_log: 4, oak_planks: 1, raw_iron: 2, coal: 1 }, furnaces: FURNACE_AT });
    const { exec, reports } = makeExecutorWith(bot, book);
    // 第一炉:燃料只够烧一件,三根原木留在输入槽
    exec.submit([{ skill: 'smelt', input: 'oak_log', count: 4, fuel: 'oak_planks' }]);
    await waitUntil(() => reports.length === 1, 8000);
    // 第二炉:输入槽仍有原木,受阻直说;账本记下看见的槽位。
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 2, 8000);
    expect(reports[1].kind).toBe('blocked');
    expect(reports[1].text).toContain('输入槽还留着橡木原木');
    const rec = book.get('overworld', { x: 2, y: 64, z: 0 })!;
    expect(rec.furnace!.input?.name).toBe('oak_log');
  });

  it('input 写真实 id:包里只有熟鳕鱼时不拿它顶生鳕鱼进炉', async () => {
    const book = new ChestBook(null);
    const { bot, slots } = furnaceBot({ inv: { cooked_cod: 16, coal: 2 }, furnaces: FURNACE_AT });
    const { exec, reports } = makeExecutorWith(bot, book);
    exec.submit([{ skill: 'smelt', input: 'cod', count: 16, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('包里没有生鳕鱼');
    expect(slots().input).toBeNull();
  });

  it('生熟鳕鱼都在包里:投进去的是生鳕鱼,回执点名投了什么', async () => {
    const book = new ChestBook(null);
    const { bot, inv } = furnaceBot({ inv: { cod: 3, cooked_cod: 40, coal: 2 }, furnaces: FURNACE_AT });
    const { exec, reports } = makeExecutorWith(bot, book);
    exec.submit([{ skill: 'smelt', input: 'cod', count: 16, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(inv.get('cod')).toBe(0);
    expect(inv.get('cooked_cod')).toBe(40);
    expect(reports[0].text).toContain('往输入槽投了包里的生鳕鱼×3');
  });

  it('反射抢占的汇报点名账上还压着料的炉子', async () => {
    const book = new ChestBook(null);
    const { bot } = furnaceBot({ inv: { raw_iron: 3, oak_planks: 1 }, furnaces: FURNACE_AT });
    const { exec, reports } = makeExecutorWith(bot, book);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 3, fuel: 'oak_planks' }]);
    await waitUntil(() => reports.length === 1, 8000);
    // 手上压一件走不完的活,反射来抢
    bot.pathfinder.goto = () => new Promise(() => {});
    exec.submit([{ skill: 'goto', at: [50, 64, 50] }]);
    await waitUntil(() => exec.current !== null, 3000);
    exec.preempt('挨打了');
    await waitUntil(() => reports.length === 2, 3000);
    expect(reports[1].kind).toBe('superseded');
    expect(reports[1].text).toContain('(2, 64, 0) 的熔炉里账上还有');
    expect(reports[1].text).toContain('粗铁×2 没烧完');
  });
});

/**
 * 夹具对每次 placeBlock 都写 placedLedger；placedNote 按技能决定豁免，自备工作站不能被报作寻路垫脚消耗。
 */

describe('自备工作站:兜底不能是哑的', () => {
  it('smelt 自己放下的熔炉写进回执,不记成"路上垫脚用掉了"', async () => {
    const rig = furnaceBot({ inv: { raw_iron: 2, coal: 1, furnace: 1 } });
    const ledger = recordPlacements(rig.bot as unknown as Record<string, unknown>);
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(rig.placed).toEqual(['furnace']);
    expect(reports[0].text).toContain('放下了一个熔炉 (1, 64, 0)');
    expect(reports[0].text).not.toContain('路上垫脚');
    expect(ledger).toEqual([]); // 自备那一条从台账里摘掉了
  });

  it('同一步里寻路器真垫掉的方块照报:摘的只是自备工作站那一条', async () => {
    const rig = furnaceBot({ inv: { raw_iron: 2, coal: 1 }, furnaces: [{ x: 2, y: 64, z: 0, name: 'furnace' }] });
    const ledger = recordPlacements(rig.bot as unknown as Record<string, unknown>);
    // 走到炉子跟前那一路寻路器垫了一块土;它走的是同一本台账
    (rig.bot.pathfinder as { goto: unknown }).goto = async () => {
      ledger.push({ name: 'dirt', x: 1, y: 63, z: 0 });
    };
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('路上垫脚/搭路用掉了 泥土×1');
    expect(reports[0].text).not.toContain('放下了一个熔炉');
  });

  // 放置期间须保持潜行，避免参照格为交互方块时触发打开或睡床。
  it('自备放置全程按着 shift:参照格是交互方块时不至于点开它', async () => {
    const rig = furnaceBot({ inv: { raw_iron: 2, coal: 1, furnace: 1 } });
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(rig.placed).toEqual(['furnace']);
    expect(rig.sneaks[0]).toBe(true);       // 放之前按下
    expect(rig.sneaks.at(-1)).toBe(false);  // 收工松开
  });


  it('脚边一圈都没落点:垫一格再放', async () => {
    const rig = furnaceBot({ inv: { raw_iron: 2, coal: 1, furnace: 1, dirt: 4 } });
    onLedge(rig);
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(rig.placed).toEqual(['dirt', 'furnace']); // 先垫一格,再把炉子放上去
    expect(reports[0].text).toContain('放下了一个熔炉 (1, 64, 0)');
  });

  it('连垫脚方块也没有:说的是垫不上,不冒充成别的', async () => {
    const rig = furnaceBot({ inv: { raw_iron: 2, coal: 1, furnace: 1 } });
    onLedge(rig);
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('垫脚名单里的方块包里都没有');
    // 垫不上时说的仍是整件事(在放什么、为谁放、该怎么办),不是「垫脚料没有」这半句
    expect(reports[0].text).toContain('要放的是熔炉,是这一步给炉子用的');
    expect(reports[0].text).toContain('想就地垫一格腾位置也不行');
  });
});

/** 她维护着十几处路标并且自己在用航点分解走长途;写名字是那条习惯与工具面的缺口 */
describe('at 收 mc_map 路标名', () => {
  const marks: MarkLookup = (name) => (name === '家' ? [100, 64, -20] : null);

  it('goto 的 at 写路标名:受理这一刻换成坐标', () => {
    expect(parseSteps([{ skill: 'goto', at: '家' }], marks))
      .toEqual({ steps: [{ skill: 'goto', at: [100, 64, -20] }] });
  });

  it('大小写与空白归一,但不做近似:猜她指哪一处就是替她决策', () => {
    const r = parseSteps([{ skill: 'goto', at: '老家' }], marks);
    expect('error' in r && r.error).toContain('mc_map 里没有登记叫「老家」的路标');
  });

  it('这个部署没接路标表:说的是「at 只认坐标」,不是查无此名', () => {
    const r = parseSteps([{ skill: 'goto', at: '家' }]);
    expect('error' in r && r.error).toContain('没接路标表');
  });

  it('take 的 at 同收路标名', () => {
    expect(parseSteps([{ skill: 'take', at: '家', all: true }], marks))
      .toEqual({ steps: [{ skill: 'take', at: [100, 64, -20], all: true }] });
  });

  it('坐标写法一个字没变', () => {
    expect(parseSteps([{ skill: 'goto', at: [1, 2, 3] }], marks))
      .toEqual({ steps: [{ skill: 'goto', at: [1, 2, 3] }] });
  });
});

describe('Reflexes 防溺水泳道与阈值', () => {
  /**
   * 氧气 6→0 只有 6 秒;分频到 1s 一拍,在 2 秒静默窗之后只剩三四次采样机会。
   * 这里数的是上浮键被按下的次数 = `antiDrown` 真正跑了几遍。
   */
  it('防溺水与挨烧同走 200ms 快泳道:静默窗过后每一拍都采样', () => {
    const bot = drownBot('water', 3);
    const { reflexes } = makeReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(3_000);
    reflexes.stop();
    // 2 秒静默窗之后还剩 1 秒:快泳道 5 拍,分频到 1s 的慢泳道只有 1 拍
    expect(bot.jumps.filter((v) => v).length).toBeGreaterThanOrEqual(5);
  });

  it('触发阈值仍是氧气 ≤6:7/20 一动不动', () => {
    const bot = drownBot('water', 7);
    const { reflexes, reports } = makeReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(5_000);
    reflexes.stop();
    expect(reports).toEqual([]);
    expect(bot.jumps).toHaveLength(0);
  });
});

describe('Reflexes 岩浆', () => {
  /**
   * 岩浆测试用的假 bot:一张按格填的世界表,人站在 (x, 63, z)。
   * 表里没写的格子:y=62 一律石头(地面),其余空气。
   */
  function lavaBot(world: Record<string, string>, at: { x: number; z: number } = { x: 10.5, z: 10.5 }) {
    const controls: Array<[string, boolean]> = [];
    const looks: V[] = [];
    const pf = fakePathfinder();
    const metadata: unknown[] = [0];
    const bot = {
      pf, controls, looks, metadata,
      entity: { id: 1, position: new V(at.x, 63, at.z), metadata },
      entities: {},
      health: 16,
      food: 20,
      oxygenLevel: 20,
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async (p: V) => { looks.push(p); },
      attack: () => {},
      blockAt(p: V) {
        const [x, y, z] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
        const name = world[`${x},${y},${z}`] ?? (y === 62 ? 'stone' : 'air');
        return { name, boundingBox: name === 'stone' ? 'block' : 'empty' };
      },
      setControlState(k: string, v: boolean) { controls.push([k, v]); },
      pathfinder: pf,
      on: () => {},
      removeListener: () => {},
      setFire(on: boolean) { metadata[0] = on ? 1 : 0; },
    };
    return bot;
  }

  function lavaReflexes(bot: ReturnType<typeof lavaBot>, diag?: MinecraftLog) {
    const reports: TaskReport[] = [];
    const preempts: string[] = [];
    const { exec: environmentExec } = makeExecutorOn(bot);
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: (r) => reports.push(r),
      log,
      preempt: (reason) => preempts.push(reason),
      stopFallTask: () => null,
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => true,
      diag,
    });
    return { reflexes, reports, preempts, exec: environmentExec };
  }

  /** 手动冲刺按下的方向键 */
  const dashed = (bot: ReturnType<typeof lavaBot>): boolean =>
    bot.controls.some(([k, v]) => k === 'forward' && v);

  /**
   * 离开岩浆后只剩身上着火:岩浆那一轮结算、环境冻结当场解除(bot 自己排的灭火不被压住),
   * 包里没有水桶时反射走去最近的水里,并把去向报出来。
   */
  it('脱出后身上还烧着:冻结解除,包里没水桶就去最近的水里并报给 bot', async () => {
    const world: Record<string, string> = { '10,63,10': 'lava' };
    const bot = lavaBot(world);
    world['14,62,10'] = 'water';
    Object.assign(bot, {
      registry: { blocksByName: { water: { id: 99 } } },
      findBlocks: () => [new V(14, 62, 10)],
    });
    const { reflexes, reports, exec } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(250); // 岩浆反射触发,开始冲刺
    expect(exec.status().hold).toBe('逃离岩浆');
    delete world['10,63,10'];
    bot.setFire(true);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(reflexes.environmentOwnerKind).toBeNull();
    expect(exec.status().hold).toBeNull();
    const goal = bot.pf.goal as { x?: number; y?: number; z?: number } | null;
    expect(goal).not.toBeNull();
    expect([goal!.x, goal!.y, goal!.z]).toEqual([14, 62, 10]);
    expect(reports.some((r) => r.text.includes('去 (14, 62, 10) 的水里灭火'))).toBe(true);
    reflexes.stop();
  });

  /** 灭火要用的那几样:水桶倒水/空桶舀水由 activateItem 按手上那件改世界和背包 */
  function bucketBot(world: Record<string, string>, dimension = 'overworld') {
    const bot = lavaBot(world);
    let held: string | null = null;
    let bag = [{ name: 'water_bucket', count: 1, type: 1 }];
    const used: string[] = [];
    Object.assign(bot.entity, { onGround: true });
    Object.assign(bot, {
      game: { dimension },
      inventory: { items: () => bag },
      equip: async (item: { name: string }) => { held = item.name; },
      waitForTicks: async () => {},
      activateItem: async () => {
        used.push(held ?? '空手');
        if (held === 'water_bucket') {
          world['10,63,10'] = 'water';
          bag = [{ name: 'bucket', count: 1, type: 2 }];
          held = 'bucket';
        } else if (held === 'bucket' && world['10,63,10'] === 'water') {
          delete world['10,63,10'];
          bag = [{ name: 'water_bucket', count: 1, type: 1 }];
          held = 'water_bucket';
        }
      },
      used,
    });
    return bot as typeof bot & { used: string[] };
  }

  /**
   * 着火出了岩浆、包里有水桶:反射对脚下顶面倒水,火灭后用空桶舀回,每一步都报给 bot;
   * 期间队列不冻结。
   */
  it('脱出后身上还烧着、包里有水桶:往脚下倒水灭火,火灭后舀回,都报给 bot', async () => {
    const world: Record<string, string> = { '10,63,10': 'lava' };
    const bot = bucketBot(world);
    const { reflexes, reports, exec } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(250);
    delete world['10,63,10'];
    bot.setFire(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bot.used).toEqual(['water_bucket']);
    // 瞄的是脚下那格方块的顶面中心:水落进脚这一格
    expect(bot.looks.map((p) => [p.x, p.y, p.z])).toContainEqual([10.5, 63, 10.5]);
    expect(reports.some((r) => r.text.includes('往 (10, 63, 10) 倒了水灭火'))).toBe(true);
    bot.setFire(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(bot.used).toEqual(['water_bucket', 'bucket']);
    expect(world['10,63,10']).toBeUndefined();
    expect(reports.some((r) => r.text.includes('舀回来了'))).toBe(true);
    expect(exec.status().hold).toBeNull();
    reflexes.stop();
  });

  it('下界里着火:水桶倒出来会蒸发,不倒,把这件事报给 bot', async () => {
    const world: Record<string, string> = { '10,63,10': 'lava' };
    const bot = bucketBot(world, 'the_nether');
    Object.assign(bot, { registry: { blocksByName: { water: { id: 99 } } }, findBlocks: () => [] });
    Object.assign(bot, { world: { getColumn: () => ({}) } });
    const { reflexes, reports } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(250);
    delete world['10,63,10'];
    bot.setFire(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bot.used).toEqual([]);
    expect(reports.some((r) => r.text.includes('蒸发'))).toBe(true);
    reflexes.stop();
  });

  it('环境租约覆盖岩浆:脱离并稳定落脚后恢复,不走破坏性抢占', () => {
    const world: Record<string, string> = { '10,63,10': 'lava' };
    const bot = lavaBot(world);
    Object.assign(bot.entity, { onGround: true, velocity: new V(0, 0, 0) });
    const token = { owner: Symbol('lava-hold') };
    let held = false;
    const pauses: string[] = [];
    const resumes: unknown[] = [];
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      report: () => {},
      log,
      preempt: () => { throw new Error('岩浆危机不该走破坏性抢占'); },
      pauseEnvironment: (reason) => { pauses.push(reason); held = true; return token; },
      resumeEnvironment: (received) => {
        resumes.push(received);
        const released = held && received === token;
        if (released) held = false;
        return { released, note: null };
      },
      stopFallTask: () => null,
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => true,
    });

    reflexes.start();
    vi.advanceTimersByTime(250);
    expect(pauses).toEqual(['逃离岩浆']);
    delete world['10,63,10'];
    vi.advanceTimersByTime(500);
    expect(resumes).toEqual([]);
    expect(held).toBe(true);
    // 脱离要站满驻留窗口(600ms)才算数,之后还要站满稳定落脚(600ms)才交还队列
    vi.advanceTimersByTime(1_400);
    reflexes.stop();

    expect(resumes).toEqual([token]);
    expect(held).toBe(false);
  });

  it('贴着岩浆边缘走:中心格还是空气,但碰撞箱压上去了就得跑', () => {
    // 斜对角的流动岩浆与玩家碰撞箱接触。
    const bot = lavaBot({ '9,63,9': 'lava' }, { x: 10.15, z: 10.15 });
    const { reflexes, reports, preempts, exec } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(250);
    expect(exec.status().hold).toBe('逃离岩浆');
    reflexes.stop();
    expect(preempts).toEqual([]);
    expect(reports[0].text).toContain('岩浆');
    expect(reports[0].hurt).toBe(true);
    expect(dashed(bot)).toBe(true);
  });

  it('只有中心那一格的老判定漏掉的:头顶是岩浆', () => {
    const bot = lavaBot({ '10,64,10': 'lava' });
    const { reflexes, reports } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(250);
    reflexes.stop();
    expect(reports).toHaveLength(1);
    expect(dashed(bot)).toBe(true);
  });

  it('身上着着火、火源还在近处:算没脱离,继续跑', () => {
    const bot = lavaBot({ '8,63,10': 'lava' }); // 2 格外,碰撞箱够不着
    const { reflexes, reports } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(250);
    expect(reports).toEqual([]); // 没着火就只是旁边有岩浆,不关反射的事
    bot.setFire(true);
    vi.advanceTimersByTime(250);
    reflexes.stop();
    expect(reports[0].text).toContain('身上着火');
  });

  it('离开岩浆但身上仍着火:站满驻留窗口照样结算,lava-clear 写明还着火', () => {
    const world: Record<string, string> = { '10,64,10': 'lava' };
    const bot = lavaBot(world);
    const diag = new MinecraftLog();
    const { reflexes } = lavaReflexes(bot, diag);
    bot.setFire(true);
    reflexes.start();
    vi.advanceTimersByTime(250);
    delete world['10,64,10'];
    vi.advanceTimersByTime(400);
    expect(diag.after(0).filter((e) => e.event === 'lava-clear')).toEqual([]);
    vi.advanceTimersByTime(400);
    reflexes.stop();
    const clears = diag.after(0).filter((e) => e.event === 'lava-clear');
    expect(clears).toHaveLength(1);
    expect(clears[0].data!.onFire).toBe(true);
    expect(clears[0].msg).toContain('身上还着着火');
  });

  /**
   * 岩浆退出需满足驻留窗口；重复进出同一区域时，lava-clear 日志带本次计数。
   */
  it('反复进出同一片岩浆:第 2 次起的 lava-clear 带计次,读日志的人不会当成成功了两次', () => {
    const world: Record<string, string> = { '10,64,10': 'lava' };
    const bot = lavaBot(world);
    const diag = new MinecraftLog();
    const { reflexes } = lavaReflexes(bot, diag);
    const clears = () => diag.after(0).filter((e) => e.event === 'lava-clear');
    reflexes.start();
    vi.advanceTimersByTime(250);
    delete world['10,64,10'];
    vi.advanceTimersByTime(800);
    world['10,64,10'] = 'lava';
    vi.advanceTimersByTime(250);
    delete world['10,64,10'];
    vi.advanceTimersByTime(800);
    reflexes.stop();
    expect(clears()).toHaveLength(2);
    const [first, second] = clears();
    // 第 1 次不加计次:那时候还没有"反复"可言
    expect(first.data!.bout).toBe(1);
    expect(first.msg).not.toContain('本轮第');
    expect(second.data!.bout).toBe(2);
    expect(second.msg).toContain('本轮第 2 次脱离');
  });

  /**
   * hazardTouch 可在相邻 200ms tick 间抖动；单 tick 无接触不算脱离，也不交还执行权。
   */
  it('岩浆退出要站满驻留窗口:抖掉一 tick 不算脱离', () => {
    const world: Record<string, string> = { '10,64,10': 'lava' };
    const bot = lavaBot(world);
    const diag = new MinecraftLog();
    const { reflexes } = lavaReflexes(bot, diag);
    const clears = () => diag.after(0).filter((e) => e.event === 'lava-clear');
    reflexes.start();
    vi.advanceTimersByTime(250);
    // 抖掉一拍:读数说没碰到,但下一拍又碰上了 —— 这不是脱离
    delete world['10,64,10'];
    vi.advanceTimersByTime(200);
    expect(clears()).toEqual([]);
    world['10,64,10'] = 'lava';
    vi.advanceTimersByTime(200);
    expect(clears()).toEqual([]);
    // 真出来了:站满窗口才结算,而且只算一次
    delete world['10,64,10'];
    vi.advanceTimersByTime(400);
    expect(clears()).toEqual([]);
    vi.advanceTimersByTime(400);
    reflexes.stop();
    expect(clears()).toHaveLength(1);
    expect(clears()[0].data!.bout).toBe(1);
  });

  it('站在安全的地方不乱动:旁边三格外的岩浆不触发', () => {
    const bot = lavaBot({ '7,63,10': 'lava' });
    const { reflexes, reports, preempts } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(2_000);
    reflexes.stop();
    expect(reports).toEqual([]);
    expect(preempts).toEqual([]);
    expect(bot.controls).toEqual([]);
  });

  it('逃跑方向背着岩浆,不是闭眼往东', () => {
    // 岩浆在西边,落脚点只能往东找
    const bot = lavaBot({ '10,63,10': 'lava', '9,63,10': 'lava', '11,63,10': 'lava' }, { x: 10.5, z: 10.5 });
    const { reflexes } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(250);
    reflexes.stop();
    const aim = bot.looks[0];
    expect(aim).toBeDefined();
    // 落脚格必须离三格岩浆都远,朝向也就只能是南北向或更远的东西向
    expect(Math.hypot(aim.x - 10, aim.z - 10)).toBeGreaterThanOrEqual(3);
  });

  it('只站在岩浆块上、周围没有烧人的方块:冲刺瞄点是有限坐标', () => {
    const bot = lavaBot({ '10,62,10': 'magma_block' });
    const { reflexes } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(250);
    reflexes.stop();
    const aim = bot.looks[0];
    expect(aim).toBeDefined();
    expect([aim.x, aim.y, aim.z].every(Number.isFinite)).toBe(true);
  });

  it('陷进岩浆里要一直按跳:人在往下沉', () => {
    const bot = lavaBot({ '10,63,10': 'lava' });
    const { reflexes } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(250);
    reflexes.stop();
    expect(bot.controls).toContainEqual(['jump', true]);
  });

  it('冲开一段之后把落脚点交给寻路器,并松开方向键', () => {
    const bot = lavaBot({ '10,63,10': 'lava' });
    const { reflexes } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(250);
    expect(bot.pf.goal).toBeNull(); // 先撤掉把人送进来的那条路
    vi.advanceTimersByTime(1_500);
    reflexes.stop();
    expect(bot.pf.goal).not.toBeNull();
    expect(bot.controls[bot.controls.length - 1]).toEqual(['jump', false]);
  });

  it('出来了要松手并说一声,免得她以为还在火里', () => {
    const world: Record<string, string> = { '10,63,10': 'lava' };
    const bot = lavaBot(world);
    const { reflexes, reports } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(250);
    expect(reports).toHaveLength(1);
    delete world['10,63,10']; // 跑出来了
    vi.advanceTimersByTime(800); // 站满驻留窗口才算脱离
    reflexes.stop();
    expect(reports).toHaveLength(2);
    expect(reports[1].text).toContain('出来了');
    expect(bot.controls[bot.controls.length - 1]).toEqual(['jump', false]);
  });

  /** 一片岩浆:x、z 都在 [lo, hi] 里的 y63 格 */
  function lavaPool(lo: { x: number; z: number }, hi: { x: number; z: number }): Record<string, string> {
    const world: Record<string, string> = {};
    for (let x = lo.x; x <= hi.x; x++) {
      for (let z = lo.z; z <= hi.z; z++) world[`${x},63,${z}`] = 'lava';
    }
    return world;
  }

  /**
   * 第一拍在扫描窗口边上找到的落脚格,人一跨格窗口就移开、回头的直线又全是岩浆,
   * 每拍重算会把它丢掉,人改成背着最近一格乱冲。选定的落脚格仍安全就一直朝它走。
   */
  it('人跨格后落脚格出了扫描窗口:仍朝第一拍选定的那一格冲', () => {
    const bot = lavaBot(lavaPool({ x: 8, z: 8 }, { x: 10, z: 12 }), { x: 10.5, z: 10.5 });
    const { reflexes } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(250);
    const first = bot.looks[bot.looks.length - 1];
    expect(Math.floor(first.x)).toBe(14);
    bot.entity.position = new V(9.9, 63, 10.5);
    vi.advanceTimersByTime(400);
    reflexes.stop();
    const last = bot.looks[bot.looks.length - 1];
    expect([last.x, last.y, last.z]).toEqual([first.x, first.y, first.z]);
  });

  /** 找不到落脚格时一直硬冲而不看人动没动,卡在原地十几秒也没人知道。 */
  it('没有落脚格又冲不动:满 5 秒把卡住的现场报给 bot', () => {
    const bot = lavaBot(lavaPool({ x: 6, z: 6 }, { x: 14, z: 14 }), { x: 10.5, z: 10.5 });
    const { reflexes, reports } = lavaReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(4_800);
    expect(reports.filter((r) => r.text.includes('卡住'))).toEqual([]);
    vi.advanceTimersByTime(600);
    reflexes.stop();
    const stuck = reports.filter((r) => r.text.includes('卡住'));
    expect(stuck).toHaveLength(1);
    expect(stuck[0].text).toContain('人在 (10, 63, 10)');
    expect(stuck[0].text).toContain('只挪了 0.0 格');
  });
});

/**
 * 原版放置以参照方块和面定位，对应 use_item_on 的 position/face 与 mineflayer.placeBlock(ref, faceVector)；只有目标格不能完整表达该操作。
 */
describe('放置 =(参照方块, 面):她指名贴哪一面,执行器不再猜', () => {
  const NON_SOLID = new Set(['air', 'torch', 'wall_torch']);
  /** 面向量 → 协议里的 Direction 序号,与 mineflayer/pathfinder 的 vectorToDirection 同一张表 */
  const faceIndex = (dx: number, dy: number, dz: number): number =>
    (dy < 0 ? 0 : dy > 0 ? 1 : dz < 0 ? 2 : dz > 0 ? 3 : dx < 0 ? 4 : 5);
  const faceName = (dx: number, dy: number, dz: number): string =>
    ['down', 'up', 'north', 'south', 'west', 'east'][faceIndex(dx, dy, dz)];

  /**
   * 带 `world` 的体素假世界。GoalPlaceBlock 靠 `world.getBlock` 列出可贴的面、
   * 靠 `world.raycast` 判落脚点看不看得见那一面,所以这里给的是真射线与真落位搜索:
   * 「挪一步之后放上了」要有这两样才立得住,goto 桩成"总能到"就什么都没测。
   */
  function faceBot(opts: {
    cells?: string[];
    props?: Record<string, string>;
    refuse?: string[];
    bag?: Array<{ name: string; count: number }>;
    at?: [number, number, number];
  }) {
    const key = (x: number, y: number, z: number) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    const cells = new Map<string, string>();
    for (const c of opts.cells ?? []) cells.set(c, 'stone');
    for (const [c, n] of Object.entries(opts.props ?? {})) cells.set(c, n);
    const refuse = new Set(opts.refuse ?? []);
    const bag = opts.bag ?? [{ name: 'dirt', count: 64 }];
    const start = opts.at ?? [0, 64, 0];
    const solid = (x: number, y: number, z: number): boolean => {
      const n = cells.get(key(x, y, z));
      return n !== undefined && !NON_SOLID.has(n);
    };
    /** 每一次 placeBlock 点的是谁的哪一面:「只点她说的那一面」靠它验 */
    const clicks: string[] = [];
    const bot = {
      cells, clicks,
      entity: { id: 9, position: new V(start[0] + 0.5, start[1], start[2] + 0.5), onGround: true },
      entities: {},
      health: 20,
      players: {},
      registry: { blocksByName: {}, itemsByName: {} },
      inventory: { items: () => bag.filter((i) => i.count > 0) },
      heldItem: null as { name: string; count: number } | null,
      equip: async (item: { name: string; count: number }) => { bot.heldItem = item; },
      lookAt: async () => {},
      setControlState: () => {},
      blockAt: (p: V) => {
        const name = cells.get(key(p.x, p.y, p.z)) ?? 'air';
        return {
          name,
          position: new V(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
          boundingBox: NON_SOLID.has(name) ? 'empty' : 'block',
          diggable: true,
          canHarvest: () => true,
        };
      },
      placeBlock: async (ref: { position: V }, face: V) => {
        const held = bot.heldItem;
        if (!held) throw new Error('must be holding an item to place');
        clicks.push(`${key(ref.position.x, ref.position.y, ref.position.z)}:${faceName(face.x, face.y, face.z)}`);
        const dest = key(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z);
        if (refuse.has(dest)) return;
        cells.set(dest, held.name);
        const slot = bag.find((i) => i.name === held.name);
        if (slot) slot.count--;
      },
      canDigBlock: () => true,
      digTime: () => 20,
      stopDigging: () => {},
      dig: async () => {},
      world: {
        getBlock: (p: { x: number; y: number; z: number }) =>
          (solid(p.x, p.y, p.z) ? { position: p, shapes: [[0, 0, 0, 1, 1, 1]] } : null),
        raycast: (from: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, range: number) => {
          let prev = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) };
          for (let t = 0.005; t <= range; t += 0.005) {
            const c = {
              x: Math.floor(from.x + dir.x * t),
              y: Math.floor(from.y + dir.y * t),
              z: Math.floor(from.z + dir.z * t),
            };
            if (c.x === prev.x && c.y === prev.y && c.z === prev.z) continue;
            if (solid(c.x, c.y, c.z)) {
              return {
                position: {
                  ...c,
                  equals: (o: { x: number; y: number; z: number }) => o.x === c.x && o.y === c.y && o.z === c.z,
                },
                face: faceIndex(prev.x - c.x, prev.y - c.y, prev.z - c.z),
              };
            }
            prev = c;
          }
          return null;
        },
      },
      pathfinder: {
        stop() {},
        setGoal() {},
        // 目标自己说哪儿站得住(GoalPlaceBlock 把脚与脑袋两格都算"站在目标格里"),
        // 这里只负责在站得进人、脚下踩得住的邻格里挑一个它认的
        goto: async (goal: { isEnd: (n: unknown) => boolean }) => {
          const p = bot.entity.position;
          const here = new V(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
          if (goal.isEnd(here)) return;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const n = new V(here.x + dx, here.y, here.z + dz);
            if (solid(n.x, n.y, n.z) || solid(n.x, n.y + 1, n.z)) continue;
            if (!solid(n.x, n.y - 1, n.z)) continue;
            if (!goal.isEnd(n)) continue;
            bot.entity.position = new V(n.x + 0.5, n.y, n.z + 0.5);
            return;
          }
        },
      },
    };
    return bot;
  }

  /** 一片 y=63 的地板 */
  const floor = (r = 2): string[] => {
    const out: string[] = [];
    for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) out.push(`${x},63,${z}`);
    return out;
  };

  /** 1.20.5 registry 里 obsidian←crying_obsidian 这样的同族共 207 组 */
  const OBSIDIAN_REG = {
    blocksByName: { obsidian: {}, crying_obsidian: {}, oak_planks: {} },
    itemsByName: { obsidian: {}, crying_obsidian: {}, oak_planks: {} },
  };


  it('材料写真实 id:包里只有哭泣的黑曜石就不下手,不拿近亲顶替', async () => {
    const bot = faceBot({ cells: floor(), bag: [{ name: 'crying_obsidian', count: 8 }] });
    bot.registry = OBSIDIAN_REG;
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'obsidian', anchors: [[1, 64, 0]] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('包里没有黑曜石');
    expect(bot.clicks).toEqual([]);
  });

  /** 错块落地后再跑同一条 build 永远不会修它,只回「本来就是黑曜石」——错误自我封印 */
  it('错块已经落地:核对不再说「本来就是」,照实报那一格现在是什么', async () => {
    const bot = faceBot({
      cells: floor(),
      props: { '1,64,0': 'crying_obsidian' },
      bag: [{ name: 'obsidian', count: 8 }],
    });
    bot.registry = OBSIDIAN_REG;
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'obsidian', anchors: [[1, 64, 0]] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).not.toContain('本来就是');
    expect(reports[0].text).toContain('哭泣的黑曜石');
  });

  it('裸类别名照旧:planks 收得下任意一种木板', async () => {
    const bot = faceBot({ cells: floor(), bag: [{ name: 'oak_planks', count: 8 }] });
    bot.registry = OBSIDIAN_REG;
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'planks', anchors: [[1, 64, 0]] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.cells.get('1,64,0')).toBe('oak_planks');
  });

  it('回执点名贴的是哪一面:落成的那一格与参照方块都报出来', async () => {
    const bot = faceBot({ cells: floor() });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'dirt', anchors: [[1, 64, 0]] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('(1, 64, 0) 放下了泥土,贴着 (1, 63, 0) 的上面');
    expect(bot.clicks).toEqual(['1,63,0:up']);
  });

  it('on 形态:她给(参照方块,面),落点由这一对算出来', async () => {
    const bot = faceBot({ cells: floor() });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'dirt', on: [{ at: [1, 63, 0], face: 'up' }] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('(1, 64, 0) 放下了泥土,贴着 (1, 63, 0) 的上面');
    expect(bot.cells.get('1,64,0')).toBe('dirt');
  });

  // 指名了面就只点那一面:她说了贴哪儿,执行器不必猜,也不该背着她换一面
  it('on 形态被服务端拒:只点她说的那一面,不去挨个试另外五个', async () => {
    const bot = faceBot({ cells: [...floor(), '2,64,0'], refuse: ['2,65,0'] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'dirt', on: [{ at: [2, 64, 0], face: 'up' }] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(bot.clicks).toEqual(['2,64,0:up']);
    expect(reports[0].text).toContain('指名的那一面试过了');
    expect(reports[0].text).not.toContain('六个面');
  });

  it('on 形态参照方块是空气:贴不住这件事在现场点名到格', async () => {
    const bot = faceBot({ cells: floor() });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'dirt', on: [{ at: [1, 70, 0], face: 'north' }] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('指名的那一面不是实心方块');
    expect(reports[0].text).toContain('(1, 70, -1) 贴不住:(1, 70, 0) 是空气');
    expect(bot.clicks).toEqual([]);
  });

  /**
   * 一步放置多处时，各落点独立报告结果。
   */
  it('不写 shape = 就这些格:一步放 N 处,一处占着不牵连另外两处', async () => {
    const bot = faceBot({ cells: floor(3), props: { '2,64,0': 'stone' } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'build', material: 'dirt', anchors: [[1, 64, 0], [2, 64, 0], [3, 64, 0]],
    } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('放上了 2/3 处');
    expect(reports[0].text).toContain('(1, 64, 0) 贴着 (1, 63, 0) 的上面放上了');
    expect(reports[0].text).toContain('(2, 64, 0) 现在是石头');
    expect(reports[0].text).toContain('(3, 64, 0) 贴着 (3, 63, 0) 的上面放上了');
    expect(bot.cells.get('1,64,0')).toBe('dirt');
    expect(bot.cells.get('3,64,0')).toBe('dirt');
  });

  it('手工 build 每一格重新取材料 permit,覆盖预算耗尽后不继续放剩余锚点', async () => {
    const bot = faceBot({ cells: floor(3) });
    const reports: TaskReport[] = [];
    let left = 1;
    const settled: boolean[] = [];
    const gate: ResourcePlacementGate = (item) => left > 0
      ? {
          ok: true,
          finish: (placed) => {
            settled.push(placed);
            if (placed) left--;
          },
        }
      : { ok: false, reason: `${item} 的蓝图 reserve 已收口` };
    const exec = new Executor({
      getBot: () => bot as never,
      report: (report) => reports.push(report),
      log,
      nextId: nextTaskId(),
      permitResourcePlacement: gate,
    });

    exec.submit([{
      skill: 'build', material: 'dirt', anchors: [[1, 64, 0], [2, 64, 0], [3, 64, 0]],
    } as never]);
    await waitUntil(() => reports.length === 1, 8000);

    expect(reports[0].kind).toBe('partial');
    expect(reports[0].text).toContain('蓝图 reserve 已收口');
    expect(bot.clicks).toHaveLength(1);
    expect([...bot.cells.values()].filter((name) => name === 'dirt')).toHaveLength(1);
    expect(settled).toEqual([true]);
  });

  it('服务端没放成时 permit 以 false 结算', async () => {
    const bot = faceBot({ cells: floor(), refuse: ['1,64,0'] });
    const reports: TaskReport[] = [];
    const settled: boolean[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (report) => reports.push(report),
      log,
      nextId: nextTaskId(),
      permitResourcePlacement: () => ({ ok: true, finish: (placed) => settled.push(placed) }),
    });

    exec.submit([{ skill: 'build', material: 'dirt', anchors: [[1, 64, 0]] } as never]);
    await waitUntil(() => reports.length === 1, 8000);

    expect(reports[0].kind).toBe('blocked');
    expect(settled).toEqual([false]);
  });

  /**
   * 目标格被自身头部碰撞箱占据时，须先横移再放置，即使目标已经在放置距离内。
   */
  it('顶在脑袋上:自己横移一步再放,那一格真的放上了', async () => {
    const bot = faceBot({ cells: [...floor(), '1,65,0'] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'dirt', anchors: [['~', '~1', '~']] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    // 文案之外先钉世界:方块真在那一格了,而且人是挪开之后才放上的
    expect(bot.cells.get('0,65,0')).toBe('dirt');
    expect(Math.floor(bot.entity.position.x)).not.toBe(0);
    expect(reports[0].text).toContain('贴着 (1, 65, 0) 的西面');
  });

  it('挪不开就受阻:说的是挪过一步,不是"站开一步才放得上"', async () => {
    // 1×1 竖井:四壁齐到头顶,人挪不出去
    const shaft = [...floor()];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const y of [64, 65]) shaft.push(`${dx},${y},${dz}`);
    }
    const bot = faceBot({ cells: shaft });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'dirt', anchors: [['~', '~1', '~']] } as never]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('顶在我脑袋上,挪了一步也没挪开');
    expect(bot.cells.get('0,65,0')).toBeUndefined();
  });


  it('脚下那一格:先挪开自己再照常放', async () => {
    const bot = faceBot({ cells: floor() });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'dirt', anchors: [['~', '~', '~']] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.cells.get('0,64,0')).toBe('dirt');
    expect([Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.z)]).not.toEqual([0, 0]);
  });

  it('脚下那一格挪不开:退回跳起来垫,照样放上', async () => {
    const shaft = [...floor()];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const y of [64, 65]) shaft.push(`${dx},${y},${dz}`);
    }
    const bot = faceBot({ cells: shaft });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'dirt', anchors: [['~', '~', '~']] } as never]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(bot.cells.get('0,64,0')).toBe('dirt');
    expect(reports[0].text).toContain('贴着 (0, 63, 0) 的上面');
  });

  // 自下而上是几何层的顺序;按三维距离排会先够高处那格,低处那格于是"吊着盖"
  it('跨层的一单:低的那层先放,近的高格不插队', async () => {
    const bot = faceBot({ cells: [...floor(4), '2,64,0', '2,65,0'] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'dirt', anchors: [[1, 65, 0], [3, 64, 0]] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.clicks).toEqual(['3,63,0:up', '2,65,0:west']);
  });

  // 寻路挖掘可能把手持材料换成工具，放置前须重新装备材料。
  it('寻路把手里换成了工具:放之前重新拿回材料', async () => {
    const bot = faceBot({
      cells: floor(),
      bag: [{ name: 'dirt', count: 64 }, { name: 'stone_pickaxe', count: 1 }],
    });
    const walk = bot.pathfinder.goto;
    bot.pathfinder.goto = async (goal: { isEnd: (n: unknown) => boolean }) => {
      await walk(goal);
      bot.heldItem = { name: 'stone_pickaxe', count: 1 };
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'dirt', anchors: [['~', '~', '~']] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.cells.get('0,64,0')).toBe('dirt');
  });

  /**
   * build 的放置账本只豁免本单落点，途中寻路垫脚仍须报告。
   */
  it('build 期间寻路垫掉的方块照报,落点上的那一块不算', async () => {
    const bot = faceBot({ cells: floor(4) });
    const ledger: Array<{ name: string; x: number; y: number; z: number }> = [];
    (bot as unknown as { placedLedger: unknown }).placedLedger = ledger;
    const walk = bot.pathfinder.goto;
    bot.pathfinder.goto = async (goal: { isEnd: (n: unknown) => boolean }) => {
      await walk(goal);
      // 寻路器为了挪开身位搭了一格路,又把落点那一格顺手垫上了
      ledger.push({ name: 'cobblestone', x: -2, y: 64, z: 0 }, { name: 'dirt', x: 0, y: 64, z: 0 });
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'dirt', anchors: [['~', '~', '~']] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('路上垫脚/搭路用掉了 圆石×1');
    expect(reports[0].text).toContain('(-2, 64, 0)');
    expect(reports[0].text).not.toContain('泥土×1');
  });

  it('任务名列到第 3 处为止:名字随每份快照重发,16 处坐标是常驻开销', () => {
    const on = [0, 1, 2, 3].map((i) => ({ at: [i, 63, 0] as Anchor, face: 'up' as const }));
    const label = describeSkill({ skill: 'build', material: 'torch', on } as never);
    expect(label).toContain('(0,63,0) 的上面');
    expect(label).toContain('等 4 处');
    expect(label).not.toContain('(3,63,0)');
  });

  // 「贴得住不」在出发前就读得出来:参照方块实心不实心是当场的读数,不是要跑一趟才知道的
  it('on 形态 dryRun:参照方块不是实心的,试算就点名了', async () => {
    const bot = faceBot({ cells: floor() });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'build', material: 'dirt', dryRun: true,
      on: [{ at: [1, 63, 0], face: 'up' }, { at: [1, 70, 0], face: 'north' }],
    } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('1 处贴不住((1, 70, 0) 不是实心方块)');
    expect(reports[0].text).toContain('没动工');
    expect(bot.clicks).toEqual([]);
  });

  it('parseSteps:on 与 anchors 二选一;face 只认六个原版面名;跟 on 一起写的 shape 进 notes', () => {
    expect(parseSteps([{ skill: 'build', material: 'torch', on: [{ at: [1, 2, 3], face: 'up' }] }]))
      .toEqual({ steps: [{ skill: 'build', material: 'torch', on: [{ at: [1, 2, 3], face: 'up' }] }] });
    const both = parseSteps([{
      skill: 'build', material: 'torch', anchors: [[1, 2, 3]], on: [{ at: [1, 2, 3], face: 'up' }],
    }]);
    expect(both).toHaveProperty('error');
    expect('error' in both && both.error).toContain('只能给一个');
    // 相对朝向会在排队期间变化，因此不接受“我左边”一类放置面。
    expect(parseSteps([{ skill: 'build', material: 'torch', on: [{ at: [1, 2, 3], face: 'left' }] }]))
      .toHaveProperty('error');
    const withShape = parseSteps([{
      skill: 'build', material: 'torch', shape: 'line', on: [{ at: [1, 2, 3], face: 'up' }],
    }]);
    expect('notes' in withShape && withShape.notes?.[0].field).toBe('shape');
  });
});

/**
 * 受理回执只有受理时的事实；执行结束后再按四种终态报告结果。
 */
describe('终态四分与受理刻回顾', () => {
  it('无事可做不是没做成:单步空转的一单照样算做完了', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'pickup' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('没什么可做的');
    expect(reports[0].text).not.toContain('没做成');
  });

  it('无事可做照旧拦下游:因果闸省掉的那一步注定也落空,只是说法不同', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    // 地上没煤可捡,第 2 步要扔的正是该捡回来的煤
    exec.submit([{ skill: 'pickup', item: 'coal' }, { skill: 'toss', item: 'coal', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked'); // 有步被跳过,这一单没做完
    expect(reports[0].text).toContain('跳过');
    expect(reports[0].text).toContain('那一步没什么可做的');
  });

  it('开工那张条子说的是中间态,不说完成体', async () => {
    const bot = combatBot({});
    const { exec } = makeExecutorOn(bot);
    // 多步任务:分母自己说清「后面还有」,不必再来一句「还没做完」
    const receipt = exec.submit([{ skill: 'chat', text: '在做了' }, { skill: 'chat', text: '第二句' }]);
    expect(receipt).toContain('收下了,排在第 1/2 步:说: 在做了');
    expect(receipt).not.toContain('已开始');
  });

  it('上次一步没成也没什么可做的:照样记账,这正是找牛那类风暴的形状', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    // pickup 不进受理刻试算,拿它验前情这一句自己说不说得对
    exec.submit([{ skill: 'pickup', item: 'coal' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done'); // 任务层面做完了……
    // ……可她要的那件事一次没发生,所以再下同一单时说出来。
    // 口气是回顾不是判据:此刻的判据归受理刻试算,那一句才该说准。
    const again = exec.submit([{ skill: 'pickup', item: 'coal' }]);
    expect(again).toContain('下过同类的单');
    expect(again).toContain('当时没什么可做的');
    expect(again).toContain('附近没有煤炭掉落物');
  });

  it('上次成了就不出声:旧账当场抹掉,不拿过期事实提醒她', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'pickup', item: 'coal' }, { skill: 'toss', item: 'coal', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(exec.submit([{ skill: 'pickup', item: 'coal' }, { skill: 'toss', item: 'coal', count: 1 }]))
      .toContain('下过同类的单');
    // 这一单只有一步且能成:同签名的旧账不该再被翻出来
    exec.submit([{ skill: 'chat', text: '一' }]);
    await waitUntil(() => reports.length === 3, 5000);
    expect(exec.submit([{ skill: 'chat', text: '一' }])).not.toContain('下过同类的单');
  });

  /**
   * taskSignature 不含坐标，同签名任务可能位于不同地点；引用旧失败原因时须去除具体坐标。
   */
  it('回顾句不留伪现场:坐标脱敏成「那一处」,措辞也改成「同类的单」', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    const why = '一块都没放上:剩下的那一格 (579, 70, 243) 顶在我脑袋上,现在人在 (579, 69, 243)';
    (exec as any).priorOutcomes.set('pickup:coal', { kind: 'blocked', why, at: Date.now() });
    const again = exec.submit([{ skill: 'pickup', item: 'coal' }]);
    expect(again).toContain('下过同类的单(按技能和目标算,不看坐标)');
    expect(again).toContain('那一处');
    expect(again).not.toContain('579');
    expect(again).not.toContain('下过同样的单');
    exec.clear();
    void reports;
  });

  /**
   * 同签名任务的回顾报告提交次数与执行进度，只陈述事实。
   */
  it('打转计数:同签名反复下单时回执报这是第几次、前几次跑没跑过第 1 步', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'pickup', item: 'coal' }]);
    await waitUntil(() => reports.length === 1, 5000);
    exec.submit([{ skill: 'pickup', item: 'coal' }]);
    await waitUntil(() => reports.length === 2, 5000);
    const third = exec.submit([{ skill: 'pickup', item: 'coal' }]);
    expect(third).toContain('第 3 次下同形状的单');
    expect(third).toContain('前 2 次里有 2 次跑过第 1 步');
    exec.clear();
  });

  /**
   * 高频受阻原因只上浮已经发生过的事实，不加推断或建议。
   */
  it('受阻头名上浮:同一类反复撞上时,回执首行报这是第几次', async () => {
    const bot = combatBot({});
    const { exec } = makeExecutorOn(bot);
    const priv = exec as any;
    const keyOf = (w: string): string => (Executor as any).blockedKey(w);
    const now = Date.now();
    // 坐标与次数各不相同,归并键是同一个:头条数的是「这一类」而不是逐字相同的原文
    const why = (i: number): string =>
      `包里没有能保住砂岩掉落的工具,要木镐及以上;没动方块(第 ${i} 次,${i}, 64, ${i})`;
    for (let i = 0; i < 6; i++) priv.noteBlockedReason(why(i), now - i * 1000);
    const headline = priv.blockedHeadline(now, new Set([keyOf(why(0))])) as string | null;
    expect(headline).toContain('已经是第 6 次');
    // 真实原因就写在下面几行里:头条不复述原文,也就不会把一个过期坐标顶到第一行
    expect(headline).not.toContain('要木镐及以上');
    expect(headline).not.toContain('64');
    // 没到门槛就不出声:偶发的一两次不该被说成"模式"
    const quiet = makeExecutorOn(combatBot({}));
    (quiet.exec as any).noteBlockedReason(why(0), now);
    expect((quiet.exec as any).blockedHeadline(now, new Set([keyOf(why(0))]))).toBeNull();
    exec.shutdown();
    quiet.exec.shutdown();
  });


  it('受阻头名只在这一单自己也撞在那一类上时才浮', async () => {
    const bot = combatBot({});
    const { exec } = makeExecutorOn(bot);
    const priv = exec as any;
    const keyOf = (w: string): string => (Executor as any).blockedKey(w);
    const now = Date.now();
    const road = '走不过去:搭路支撑 (-250, 61, 17) 放了三次仍是水,服务端未确认;已取消这段路径';
    for (let i = 0; i < 9; i++) priv.noteBlockedReason(road, now - i * 1000);
    const mine = '附近看不见铜矿石';
    priv.noteBlockedReason(mine, now);
    // 这一单撞的是别的类:窗口里那 9 次搭路与她这一单无关,不该顶到第一行
    expect(priv.blockedHeadline(now, new Set([keyOf(mine)]))).toBeNull();
    // 一单多步分属不同类:候选在这几类里挑票数最高的,不是只看第一条
    const both = new Set([keyOf(mine), keyOf(road)]);
    expect(priv.blockedHeadline(now, both) as string).toContain('已经是第 9 次');
    exec.shutdown();
  });

  /**
   * 「反复撞同一堵墙」这件事本身就该被看见,不是只有全场最高那堵才算。她这一类撞了
   * 6 次、另一类撞了 9 次占着第一,那 6 次照样是一堵墙 —— 只挑本单撞过的类,
   * 但在这几类里按票数挑,不跟全场第一比。
   */
  it('本单撞到的类自己过了门槛就报,哪怕另有一类票数更高', async () => {
    const { exec } = makeExecutorOn(combatBot({}));
    const priv = exec as any;
    const keyOf = (w: string): string => (Executor as any).blockedKey(w);
    const now = Date.now();
    const a = '走不过去:搭路支撑放了三次仍是水,服务端未确认;已取消这段路径';
    const b = '包里没有能保住砂岩掉落的工具,要木镐及以上;没动方块';
    for (let i = 0; i < 9; i++) priv.noteBlockedReason(a, now - i * 1000);
    for (let i = 0; i < 6; i++) priv.noteBlockedReason(b, now - i * 1000);
    const headline = priv.blockedHeadline(now, new Set([keyOf(b)])) as string;
    expect(headline).toContain('已经是第 6 次');
    expect(headline).not.toContain('第 9 次');
    exec.shutdown();
  });

  it('整条回执上:同类的一单带头条,别类的一单一个字都不带', async () => {
    // 32 格内一个容器都没有:stow 圆石固定撞「没有箱子」,stow 煤炭固定撞「包里没有」
    const { bot } = chestBot({ inv: { cobblestone: 640 } });
    bot.findBlocks = () => [];
    const { exec, reports } = makeExecutorOn(bot);
    for (let i = 1; i <= 5; i++) {
      exec.submit([{ skill: 'stow', item: 'cobblestone', count: 1 }]);
      await waitUntil(() => reports.length === i, 8000);
    }
    expect(reports[4].kind).toBe('blocked');
    expect(reports[4].text).toContain('⚠ 这一类受阻在过去 60 分钟里已经是第 5 次');
    // 换一类受阻:窗口里那 5 次没有一次是这一单的事,回执第一行不许说别处
    exec.submit([{ skill: 'stow', item: 'coal', count: 1 }]);
    await waitUntil(() => reports.length === 6, 8000);
    expect(reports[5].kind).toBe('blocked');
    expect(reports[5].text).toContain('包里没有煤炭');
    expect(reports[5].text).not.toContain('⚠');
    expect(reports[5].text).not.toContain('32 格内没有箱子');
    // 再撞回同一类:照浮不误,次数接着数
    exec.submit([{ skill: 'stow', item: 'cobblestone', count: 1 }]);
    await waitUntil(() => reports.length === 7, 8000);
    expect(reports[6].text).toContain('已经是第 6 次');
    exec.shutdown();
  });

  it('开关关掉就退回旧行为:受理回执只说这一单', async () => {
    const bot = combatBot({});
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      fleeHealth: () => 0,
      priorOutcome: () => false,
    });
    exec.submit([{ skill: 'pickup', item: 'coal' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(exec.submit([{ skill: 'pickup', item: 'coal' }])).not.toContain('下过同类的单');
  });
});



describe('文案批:主语、指路、候选菜单', () => {
  /** use 台架:手里拿着泥土,空手 use 打在一格床上 */
  function useBot() {
    return {
      entity: { id: 9, position: new V(0.5, 64, 0.5), yaw: 0, pitch: 0 },
      entities: {},
      health: 20,
      players: {},
      heldItem: { name: 'dirt', count: 1, type: 3, metadata: 0 },
      time: { timeOfDay: 1000 },
      registry: {
        blocks: { 26: { name: 'white_bed' } },
        blocksByName: { white_bed: { id: 26, name: 'white_bed' } },
        items: {},
        itemsByName: { white_bed: { id: 26, name: 'white_bed' } },
        entitiesByName: { cow: {} },
      },
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: () => [new V(3, 64, 0)],
      blockAt: () => ({ name: 'white_bed', stateId: 1, position: new V(3, 64, 0) }),
      canSeeBlock: () => true,
      world: { raycast: () => null },
      activateBlock: async () => {},
      isSleeping: false,
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
  }

  it('(b) use 受阻文案的主语是真实手持,不再无条件写「空手」', async () => {
    const bot = useBot();
    const { exec, reports } = makeExecutorOn(bot);
    // 空手右键床:白天点不躺下,探针落空 → 受阻。头部主语该是「用泥土」
    exec.submit([{ skill: 'use', at: [3, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('用泥土右键 (3,64,0)没做成');
    expect(reports[0].text).not.toContain('空手右键 (3,64,0)没做成');
    exec.shutdown();
  });

  it('(c) use.target 收到方块名:说清 target 只认活物,并把正确写法与坐标递过去', async () => {
    const bot = useBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', target: 'white_bed' }]);
    await waitUntil(() => reports.length === 1, 8000);
    const t = reports[0].text;
    expect(t).toContain('use 的 target 只认活物(生物、玩家),「white_bed」不是活物');
    expect(t).toContain('{"skill":"use","at":[3,64,0]}');
    expect(t).not.toContain('不认识「white_bed」这种东西');
    exec.shutdown();
  });
});

describe('受理刻的危险区陈述与行军相对化', () => {
  /** 真表真函数:措辞铁律要连着 mc_map 那张表一起验,不能只验一个假 desk */
  function deskOf(marks: MinecraftMark[]): MarkDesk {
    return {
      near: (p, approx) => nearMarkText(marks, p, approx),
      nearest: (p) => {
        const hit = nearestMark(marks, p);
        return hit ? { name: hit.mark.name, x: hit.mark.pos[0], y: hit.mark.pos[1], z: hit.mark.pos[2] } : null;
      },
      danger: (p) => dangerZonesAt(marks, p).map((m) => m.name),
      around: (p, radius) => marks
        .filter((m) => Math.hypot(m.pos[0] - p.x, m.pos[1] - p.y, m.pos[2] - p.z) <= radius)
        .map((m) => ({ name: m.name, at: m.at })),
    };
  }

  function mark(name: string, over: Partial<MinecraftMark> = {}): MinecraftMark {
    return {
      name, dimension: 'overworld', pos: [0, 64, 0], kind: '地标', note: null, radius: null, at: 0, ...over,
    };
  }

  function execWith(marks: MinecraftMark[], spawn: { x: number; y: number; z: number } | null = null) {
    const bot = combatBot({});
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never, report: (r) => reports.push(r), log, nextId: nextTaskId(),
      spawnAnchor: () => spawn,
      marks: () => deskOf(marks),
    });
    return { exec, bot };
  }

  const ZONE = mark('出生点刷怪窝', { pos: [100, 64, 0], kind: '危险区', radius: 30 });

  it('目标点落进她标的圈:逐字「你标记的」,不带任何系统判断的词', () => {
    const { exec } = execWith([ZONE]);
    const r = exec.submit([{ skill: 'goto', at: [110, 64, 0] }]);
    expect(r).toContain('目标落在你标记的危险区「出生点刷怪窝」里');
    for (const banned of ['建议', '危险,', '注意', '小心', '系统判断', '不建议', '最好']) {
      expect(r).not.toContain(banned);
    }
    exec.shutdown();
  });

  it('只陈述不拦不劝:这一单照样受理,任务号照发', () => {
    const { exec } = execWith([ZONE]);
    const r = exec.submit([{ skill: 'goto', at: [110, 64, 0] }]);
    expect(r).toContain('任务#1');
    expect(r).not.toContain('这一单我没接');
    exec.shutdown();
  });

  it('圈外的目标一个字都不加;没标半径的危险区不成圈', () => {
    const { exec } = execWith([ZONE]);
    expect(exec.submit([{ skill: 'goto', at: [140, 64, 0] }])).not.toContain('你标记的危险区');
    exec.shutdown();
    const point = execWith([mark('那口岩浆', { pos: [100, 64, 0], kind: '危险区' })]);
    expect(point.exec.submit([{ skill: 'goto', at: [100, 64, 0] }])).not.toContain('你标记的危险区');
    point.exec.shutdown();
  });

  it('形状族按第一个锚点算;行军终点落进圈里另说一句', () => {
    const shape = execWith([mark('塌方区', { pos: [20, 64, 20], kind: '危险区', radius: 10 })]);
    expect(shape.exec.submit([{ skill: 'excavate', shape: 'line', anchors: [[20, 64, 20], [24, 64, 20]] }]))
      .toContain('目标落在你标记的危险区「塌方区」里');
    shape.exec.shutdown();
    // 站着的地方是 (0,64,0):朝南走满 100 格 = (0,64,100)
    const march = execWith([mark('沼泽', { pos: [0, 64, 100], kind: '危险区', radius: 20 })]);
    const r = march.exec.submit([{ skill: 'find', target: 'spider', direction: 'south', distance: 100 }]);
    expect(r).toContain('走满时的行军终点落在你标记的危险区「沼泽」里');
    march.exec.shutdown();
  });

  it('没接路标表(台架):这两句整段不出现', () => {
    const { exec } = makeExecutorOn(combatBot({}));
    expect(exec.submit([{ skill: 'goto', at: [110, 64, 0] }])).not.toContain('你标记的');
    exec.shutdown();
  });

  it('行军代价:重生点之外再附一句离最近路标多远,「约」写在字面上', () => {
    const { exec } = execWith([mark('家', { pos: [0, 64, 0] })], { x: 0, y: 64, z: 0 });
    const r = exec.submit([{ skill: 'find', target: 'spider', direction: 'south', distance: 130 }]);
    expect(r).toContain('走满时离重生点 (0, 64, 0) 约 130 格、离「家」从 0 格变成约 130 格');
    exec.shutdown();
  });

  it('没有重生点时那一句照样出:路标是她自己的尺子,与重生点无关', () => {
    const { exec } = execWith([mark('家', { pos: [0, 64, 0] })], null);
    const r = exec.submit([{ skill: 'find', target: 'spider', direction: 'south', distance: 130 }]);
    expect(r).toContain('走满时离「家」从 0 格变成约 130 格(你现在没有重生点)');
    exec.shutdown();
  });

  it('表空 / 太远:退回原来那句,不编一个地名出来', () => {
    const { exec } = execWith([], { x: 0, y: 64, z: 0 });
    const r = exec.submit([{ skill: 'find', target: 'spider', direction: 'south', distance: 48 }]);
    expect(r).toContain('走满时离重生点 (0, 64, 0) 约 48 格');
    expect(r).not.toContain('离「');
    exec.shutdown();
  });

  it('dangerNoteText:名字多的时候逐个点名,空清单返回 null', () => {
    expect(dangerNoteText(['A', 'B'], '目标')).toBe('目标落在你标记的危险区「A」、「B」里');
    expect(dangerNoteText([], '目标')).toBeNull();
  });
});

/**
 * 「包快满了」的主动提醒。
 *
 * 补的是 precheck 那条格位警告够不着的一段:precheck 只在**这一步要往包里装东西**时
 * 才算格位,于是挖了一路矿、包早就快满了,只要下一单不是装东西的,她一个字都读不到。
 */


describe('eat:毒食确认门、可吃物清单、一单三连的回执', () => {
  const ITEMS: Record<number, string> = { 1: 'wheat', 2: 'wheat_seeds', 3: 'bread', 4: 'pufferfish', 5: 'cooked_beef' };
  function eatBot(bag: Array<{ name: string; count: number }>, opts: { wheatNearby?: boolean } = {}) {
    const itemsByName = Object.fromEntries(Object.entries(ITEMS).map(([id, n]) => [n, { id: Number(id), name: n }]));
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      food: 10,
      players: {},
      time: { timeOfDay: 1000 },
      world: { raycast: () => null },
      registry: {
        entitiesByName: {},
        foodsByName: { bread: {}, pufferfish: {}, cooked_beef: {} },
        blocks: { 100: { name: 'wheat', drops: [1, 2] } },
        blocksByName: { wheat: { id: 100, name: 'wheat', drops: [1, 2] } },
        items: Object.fromEntries(Object.entries(ITEMS).map(([id, name]) => [id, { name }])),
        itemsByName,
      },
      // 面包 = 小麦×3
      recipesAll: () => [{ result: { id: 3, count: 1 }, ingredients: [{ id: 1 }, { id: 1 }, { id: 1 }], requiresTable: true }],
      inventory: { items: () => bag },
      findBlocks: () => (opts.wheatNearby ? [new V(3, 64, 0)] : []),
      canSeeBlock: () => true,
      blockAt: (p: V) => ({ name: 'air', position: p.floored(), boundingBox: 'empty' }),
      equip: async (item: { name: string }) => { bot.eaten = item.name; },
      eaten: null as string | null,
      consume: async () => {
        const hit = bag.find((e) => e.name === bot.eaten);
        if (hit) hit.count -= 1;
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  it('河豚:第一次只报后果不接单,同样的单再下一次才吃', async () => {
    const bag = [{ name: 'pufferfish', count: 2 }];
    const bot = eatBot(bag);
    const { exec, reports } = makeExecutorOn(bot);
    const first = exec.submit([{ skill: 'eat', item: 'pufferfish' }]);
    expect(first).toContain('我没接');
    expect(first).toContain('中毒 60 秒');
    expect(first).toContain('没吃');
    expect(first).toContain('再下一次一模一样的单');
    expect(exec.current).toBeNull();
    expect(bag[0].count).toBe(2);

    const second = exec.submit([{ skill: 'eat', item: 'pufferfish' }]);
    expect(second).toContain('收下了');
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(bag[0].count).toBe(1);
    // 确认只顶一次:再吃一个还得再确认
    expect(exec.submit([{ skill: 'eat', item: 'pufferfish' }])).toContain('我没接');
  });

  it('多步单里点名河豚:点明是第几步;换了单就换槽', () => {
    const { exec } = makeExecutorOn(eatBot([{ name: 'pufferfish', count: 1 }]));
    const steps: SkillCall[] = [{ skill: 'chat', text: '先说一句' }, { skill: 'eat', item: 'spider_eye' }];
    expect(exec.submit(steps)).toContain('第 2 步要吃的是蜘蛛眼');
    expect(exec.submit([{ skill: 'eat', item: 'pufferfish' }])).toContain('我没接');
    expect(exec.submit(steps)).toContain('我没接'); // 单槽被换掉了,不是确认
  });

  it('普通食物不经这道门', async () => {
    const bag = [{ name: 'bread', count: 1 }];
    const { exec, reports } = makeExecutorOn(eatBot(bag));
    expect(exec.submit([{ skill: 'eat', item: 'bread' }])).toContain('收下了');
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
  });

  it('包里没有点名的食物:回执附上包里能吃的清单;一样都没有就说没有任何食物', async () => {
    const a = makeExecutorOn(eatBot([{ name: 'cooked_beef', count: 2 }, { name: 'wheat', count: 1 }]));
    a.exec.submit([{ skill: 'eat', item: 'bread' }]);
    await waitUntil(() => a.reports.length === 1, 5000);
    expect(a.reports[0].kind).toBe('blocked');
    // 小麦不是食物,不进清单(它只出现在末尾的 [背包] 全量里)
    expect(a.reports[0].text).toContain('包里没有点名的面包;包里能吃的有:牛排×2)');

    const b = makeExecutorOn(eatBot([{ name: 'wheat', count: 1 }]));
    b.exec.submit([{ skill: 'eat', item: 'bread' }]);
    await waitUntil(() => b.reports.length === 1, 5000);
    expect(b.reports[0].text).toContain('包里没有点名的面包;包里没有任何食物');
  });

  it('找麦→面包→吃面包:第 1 步落空,后两步并成一行「没跑」,不各报一条失败', async () => {
    const bot = eatBot([]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'collect', block: 'wheat', count: 3, mature: true },
      { skill: 'craft', item: 'bread', count: 1 },
      { skill: 'eat', item: 'bread' },
    ]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('附近看不见熟着的小麦');
    expect(reports[0].text).toContain(
      '第 2~3 步 没跑(第 1 步没做成,这 2 步一环扣一环都要用它的产出):'
      + '{"skill":"craft","item":"bread","count":1};{"skill":"eat","item":"bread"}',
    );
    expect(reports[0].text).not.toContain('包里没有点名的面包');
    expect(reports[0].text).not.toContain('包里凑不齐');
    expect(bot.eaten).toBeNull();
  });

  it('要用的料包里本来就有:上游没成也照跑,并说明为什么', async () => {
    const bag = [{ name: 'bread', count: 1 }];
    const bot = eatBot(bag);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'collect', block: 'wheat', count: 3, mature: true },
      { skill: 'craft', item: 'bread', count: 1 },
      { skill: 'eat', item: 'bread' },
    ]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    // 第 2 步依赖第 1 步未取得的小麦，按依赖失败报告跳过。
    expect(reports[0].text).toContain('第 2 步 {"skill":"craft","item":"bread","count":1} 跳过(要用第 1 步的小麦,那一步没做成)');
    // 第 3 步要的面包在包里 → 照吃
    expect(reports[0].text).toContain('吃了一个面包');
    expect(reports[0].text).toContain('(第 2 步没做成;要用的面包包里本来就有,照做了)');
    expect(bag[0].count).toBe(0);
  });
});
