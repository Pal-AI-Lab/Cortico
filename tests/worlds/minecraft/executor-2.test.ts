/**
 * executor 行为测试 第 2/4 份(见 executor-harness.ts)。
 * 分份只为并行,按实测耗时配平;哪个 describe 落在哪一份没有语义。
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeSkill, Executor, Reflexes, parseNoteText, parseSteps,
  type MarkLookup, type SkillCall, type TaskProgress, type TaskReport,
} from '../../../src/worlds/minecraft/executor.ts';
import type { Anchor } from '../../../src/worlds/minecraft/geometry.ts';
import { MinecraftLog } from '../../../src/worlds/minecraft/log.ts';
import {
  log,
  nextTaskId,
  sleep,
  waitUntil,
  V,
  FakeGoal,
  combatBot,
  makeExecutorOn,
  chestBot,
  enchantBot,
  fakePathfinder,
} from './executor-harness.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseSteps:mc_do 的入参校验', () => {
  const ok = (raw: unknown): SkillCall[] => {
    const r = parseSteps(raw);
    if ('error' in r) throw new Error(`本该通过却被退回: ${r.error}`);
    return r.steps;
  };
  const err = (raw: unknown): string => {
    const r = parseSteps(raw);
    if (!('error' in r)) throw new Error('本该被退回却通过了');
    return r.error;
  };

  it('认下合法序列,缺省的 count/distance 用默认值', () => {
    expect(ok([{ skill: 'collect', block: 'oak_log' }, { skill: 'flee' }]))
      .toEqual([{ skill: 'collect', block: 'oak_log', count: 1 }, { skill: 'flee', distance: 24 }]);
  });

  it('多余的键不会漏进技能实现', () => {
    expect(ok([{ skill: 'eat', item: 'bread', block: 'stone', 备注: '随手写的' }]))
      .toEqual([{ skill: 'eat', item: 'bread' }]);
  });

  it('技能名不在表里就整条退回,并说是第几步', () => {
    expect(err([{ skill: 'chat', text: 'hi' }, { skill: 'build_house', style: '好看的' }])).toContain('第 2 步');
    expect(err([{ skill: 'build_house' }])).toContain('build_house');
  });

  it('缺参数、参数类型不对都点名说清楚', () => {
    expect(err([{ skill: 'attack' }])).toContain('target');
    expect(err([{ skill: 'goto' }])).toContain('at:[x,y,z]');
    expect(err([{ skill: 'find', target: 'log', direction: 'down' }])).toContain('direction');
    expect(err([{ skill: 'eat' }])).toContain('item');
    expect(err([{ skill: 'eat', item: '' }])).toContain('item');
    expect(err([{ skill: 'attack', target: 'zombie', mode: 'sniper' }])).toContain('auto/melee/ranged/kite');
  });

  it('attack mode 可选且无 mode 保持兼容', () => {
    expect(ok([{ skill: 'attack', target: 'zombie' }]))
      .toEqual([{ skill: 'attack', target: 'zombie' }]);
    expect(ok([{ skill: 'attack', target: 'zombie', mode: 'kite' }]))
      .toEqual([{ skill: 'attack', target: 'zombie', mode: 'kite' }]);
  });

  it('越界数值返回允许范围且不截断', () => {
    expect(err([{ skill: 'flee', distance: 150 }])).toContain('1-128');
    expect(err([{ skill: 'collect', block: 'stone', count: 999 }])).toContain('1-64');
  });

  it('空序列与非数组一律退回', () => {
    expect(err([])).toContain('非空');
    expect(err({ skill: 'eat' })).toContain('非空');
    expect(err(undefined)).toContain('非空');
    expect(err(['eat'])).toContain('不是一个对象');
  });

  it('needs 只准引用更早的步,违规整批退回并点名第几步', () => {
    expect(err([{ skill: 'chat', text: 'a', needs: [1] }])).toContain('第 1 步');
    expect(err([{ skill: 'eat', item: 'bread' }, { skill: 'chat', text: 'b', needs: [2] }])).toContain('第 2 步');
    expect(err([{ skill: 'eat', item: 'bread' }, { skill: 'chat', text: 'b', needs: [0] }])).toContain('needs');
    expect(err([{ skill: 'eat', item: 'bread' }, { skill: 'chat', text: 'b', needs: [1.5] }])).toContain('needs');
    expect(err([{ skill: 'eat', item: 'bread' }, { skill: 'chat', text: 'b', needs: '1' }])).toContain('needs');
  });

  it('expect 四形态之外整批退回', () => {
    expect(err([{ skill: 'eat', item: 'bread', expect: {} }])).toContain('四种之一');
    expect(err([{ skill: 'eat', item: 'bread', expect: { has: { item: 'stone', count: 1 }, near: [0, 0, 0] } }]))
      .toContain('四种之一');
    expect(err([{ skill: 'eat', item: 'bread', expect: { within: 3 } }])).toContain('四种之一');
    expect(err([{ skill: 'eat', item: 'bread', expect: { has: { item: 'stone' } } }])).toContain('count');
    expect(err([{ skill: 'eat', item: 'bread', expect: { has: { count: 3 } } }])).toContain('item');
    expect(err([{ skill: 'eat', item: 'bread', expect: { near: 'home' } }])).toContain('near');
    expect(err([{ skill: 'eat', item: 'bread', expect: { block: 'chest' } }])).toContain('at');
    expect(err([{ skill: 'eat', item: 'bread', expect: { holding: {} } }])).toContain('holding 要 item');
  });

  it('合法的 needs/expect 进规范步骤;near 的 within 缺省不落进对象', () => {
    expect(ok([
      { skill: 'eat', item: 'bread' },
      { skill: 'flee', needs: [], expect: { near: [0, 64, 0], within: 5 } },
    ])).toEqual([
      { skill: 'eat', item: 'bread' },
      { skill: 'flee', distance: 24, needs: [], expect: { near: [0, 64, 0], within: 5 } },
    ]);
    expect(ok([{ skill: 'eat', item: 'bread', expect: { near: ['~', '~', '~'] } }]))
      .toEqual([{ skill: 'eat', item: 'bread', expect: { near: ['~', '~', '~'] } }]);
    expect(ok([{ skill: 'eat', item: 'bread', expect: { has: { item: 'bread', count: 3 } } }]))
      .toEqual([{ skill: 'eat', item: 'bread', expect: { has: { item: 'bread', count: 3 } } }]);
  });

  it('goto 规范化维度前置条件;transit 只接受门方块坐标或当前维度路标', () => {
    expect(ok([{ skill: 'goto', at: [-33, 70, 15], dimension: 'the_nether' }]))
      .toEqual([{ skill: 'goto', at: [-33, 70, 15], dimension: 'minecraft:the_nether' }]);
    expect(ok([{ skill: 'transit', at: [-228, 73, 58] }]))
      .toEqual([{ skill: 'transit', at: [-228, 73, 58] }]);

    const foreign: MarkLookup = () => ({ error: '「家门下界落点」在下界,当前在主世界;先明确穿门' });
    const parsed = parseSteps([{ skill: 'transit', at: '家门下界落点' }], foreign);
    expect(parsed).toEqual({ error: expect.stringContaining('在下界,当前在主世界') });
  });
});

describe('走不到与挖不动:失败要说出来,不能静默挂着', () => {
  /**
   * 采矿用的假 bot:findBlocks 报一块矿,能不能够到与挖不挖得动可控。
   * 挖成了往包里放掉落物(coal_ore 掉的是 coal,名字和方块不一样)。
   */
  function mineBot(opts: { reachable: boolean; digHangs?: boolean; harvestable?: boolean; visible?: boolean }) {
    const ore = { name: 'coal_ore', position: new V(-8, 50, 8) };
    const bag: Array<{ name: string; count: number }> = [];
    return {
      entity: { id: 9, position: new V(0.5, 63, 0.5) },
      entities: {},
      health: 20,
      players: {},
      // GoalLookAtBlock 对可达目标要求 raycast 命中该矿块。
      world: { raycast: () => ({ position: ore.position, face: 1 }) },
      registry: {
        blocks: { 100: { name: 'coal_ore', drops: [802] } },
        blocksByName: { coal_ore: { id: 100, name: 'coal_ore', drops: [802] } },
        items: { 802: { name: 'coal' } },
        itemsByName: { coal: { id: 802 } },
      },
      inventory: { items: () => bag },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: () => [ore.position],
      blockAt: () => ({ ...ore, canHarvest: () => opts.harvestable !== false }),
      canSeeBlock: () => opts.visible !== false,
      canDigBlock: () => opts.reachable,
      digTime: () => 1000,
      // 服务端会忽略超距 block_dig；mineflayer 将持续等待方块变化。
      dig: () => {
        if (opts.digHangs) return new Promise<void>(() => {});
        bag.push({ name: 'coal', count: 1 });
        return Promise.resolve();
      },
      stopDigging: () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
  }

  /**
   * 挖竖井的假 bot:一列方块(y 63 往下),列外全是石头。列默认在脚边 x=1;
   * `underfoot` 把它放到自己脚下 x=0,挖一格人掉一格。
   * blockAt 带 boundingBox/diggable,与 excavate 的实心判定同一口径。
   */
  function shaftBot(column: string[], opts: { harvestable?: boolean; loot?: string; underfoot?: boolean } = {}) {
    const dugNames: string[] = [];
    const bag: Array<{ name: string; count: number; type?: number }> = [
      { name: 'wooden_pickaxe', count: 1, type: 1 },
    ];
    const col = opts.underfoot ? 0 : 1;
    const at = new Map<number, string>();
    column.forEach((name, i) => at.set(63 - i, name));
    const nameAt = (p: V) => {
      if (Math.floor(p.x) !== col || Math.floor(p.z) !== 0) return 'stone';
      return at.get(Math.floor(p.y)) ?? 'bedrock';
    };
    const bot = {
      dugNames,
      entity: { id: 9, position: new V(0.5, 64, 0.5), onGround: true },
      entities: {},
      health: 20,
      players: {},
      inventory: { items: () => bag },
      // 选家伙什读的是方块自己的 harvestTools / material(minecraft-data 原样),
      // 石头列出全部六把镐,与真注册表同形
      registry: {
        blocksByName: {
          stone: {
            material: 'mineable/pickaxe',
            harvestTools: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true },
          },
        },
        items: {
          1: { name: 'wooden_pickaxe' }, 2: { name: 'golden_pickaxe' }, 3: { name: 'stone_pickaxe' },
          4: { name: 'iron_pickaxe' }, 5: { name: 'diamond_pickaxe' }, 6: { name: 'netherite_pickaxe' },
        },
      },
      heldItem: null as { name: string; count: number; type?: number } | null,
      equip: async (item: { name: string; count: number; type?: number }) => { bot.heldItem = item; },
      lookAt: async () => {},
      setControlState: () => {},
      blockAt: (p: V) => {
        const name = nameAt(p);
        return {
          name,
          position: p,
          boundingBox: name === 'air' || name === 'lava' || name === 'water' ? 'empty' : 'block',
          diggable: name !== 'bedrock',
          canHarvest: () => opts.harvestable !== false,
        };
      },
      canDigBlock: (b: { name: string }) => b.name !== 'bedrock',
      digTime: () => 50,
      stopDigging: () => {},
      dig: async (block: { name: string; position: V }) => {
        dugNames.push(block.name);
        at.set(Math.floor(block.position.y), 'air');
        if (opts.underfoot) bot.entity.position = new V(0.5, bot.entity.position.y - 1, 0.5);
        if (opts.loot) bag.push({ name: opts.loot, count: 1 });
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  it('寻路算不出路时 goto 是 resolve 不是 reject:自己验到没到,别当成走到了', async () => {
    // goto 什么都不做(位置没动)= 寻路库"算不出路"那条 resolve 分支
    const bot = mineBot({ reachable: false });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 8 }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('走不过去');
    expect(reports[0].text).toContain('找不到可行路线');
    // 非物品类受阻不贴全量背包:这一步卡在路上,不是卡在东西上
    expect(reports[0].text).not.toContain('[背包]');
    // 三段式:结论之外带现场事实——目标坐标、我在哪、相对方位高差
    expect(reports[0].text).toContain('[现场]');
    expect(reports[0].text).toContain('看得见的煤矿石在 (-8, 50, 8)');
    expect(reports[0].text).toContain('比我低 13 格');
  });

  it('看得见够不着且给了试算:三种走法的菜单进现场,垫几块挖几块她自己看', async () => {
    const bot = mineBot({ reachable: false });
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      probeRoutes: () => [
        { profile: 'style', status: 'noPath', steps: 0, place: 0, breaks: 0, endDist: 15 },
        { profile: 'place', status: 'complete', steps: 12, place: 2, breaks: 0, endDist: 0 },
      ] as never,
    });
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 1 }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('垫 2 块');
  });

  /**
   * 世界读数决定目标格的可站性；A* 超时只说明搜索未完成，回执先报告可直接确认的世界事实。
   */
  it('目标格站不进人:结论先说这件事,寻路器的超时退到后面', async () => {
    const bot = mineBot({ reachable: false });
    bot.pathfinder.goto = async () => { throw new Error('Took to long to decide path to goal!'); };
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      probeRoutes: () => [
        { profile: 'style', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 3 },
      ] as never,
      probeTarget: () => ({ kind: 'noStand' }),
    });
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 1 }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    const text = reports[0].text;
    // 超时不被吞掉,只是不再排在首因
    expect(text).toContain('限时内没算完');
    expect(text.indexOf('站不进人')).toBeLessThan(text.indexOf('限时内没算完'));
    expect(text).not.toContain('太远');
  });

  // 埋在遮挡后的矿不进入感知；看不见时不挖，并在回执说明后续路径。
  it('看不见就不挖:埋着的矿不进感知,回执说清是看不见并指路', async () => {
    const bot = mineBot({ reachable: true, visible: false });
    // 射线被别的方块挡住:透光集那条加法路不放行
    bot.world = { raycast: () => ({ position: new V(0, 60, 0), face: 1, name: 'stone' }) };
    bot.pathfinder.goto = async () => { bot.entity.position = new V(-8, 50, 8); };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 1 }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('附近看不见煤矿石');
    expect(reports[0].text).toContain('挖开');
    // 看不见那些的坐标是穿墙情报,一个字都不许漏
    expect(reports[0].text).not.toContain('(-8, 50, 8)');
  });

  it('隔着玻璃算看得见:透光集只做加法,原判据说被挡时才补那条射线', async () => {
    const bot = mineBot({ reachable: true, visible: false });
    // 挡在中间的是玻璃 → 射线穿过去打到目标本身
    bot.world = { raycast: () => ({ position: new V(-8, 50, 8), face: 1, name: 'coal_ore' }) };
    bot.pathfinder.goto = async () => { bot.entity.position = new V(-8, 50, 8); };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 1 }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('实际入包 1 个');
  });

  // buried 处理看得见但走不过去的目标：先过视线闸，再允许挖通路径。
  it('collect buried:看得见但走不过去,挖条路过去照常采到', async () => {
    const bot = mineBot({ reachable: true, visible: true });
    let tries = 0;
    bot.pathfinder.goto = async () => {
      if (tries++ === 0) throw new Error('走不过去');
      bot.entity.position = new V(-8, 51, 8);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 1, buried: true }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('实际入包 1 个');
    expect(tries).toBeGreaterThan(1); // 真走了挖过去那条兜底
  });

  /**
   * 假 bot 使用三维格子图；jump 置位即离地，placeBlock 落格后站上新方块。
   */
  function pillarBot(solidCells: string[], opts: { stock?: number } = {}) {
    const solid = new Set(solidCells);
    const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;
    const bag = [{ name: 'cobblestone', count: opts.stock ?? 64, type: 35 }];
    const placedName = new Map<string, string>();
    const bot = {
      placedAt: [] as string[],
      entity: { id: 9, position: new V(0.5, 64, 0.5), onGround: true },
      entities: {},
      health: 20,
      players: {},
      inventory: { items: () => (bag[0].count > 0 ? bag : []) },
      heldItem: bag[0],
      equip: async () => {},
      lookAt: async () => {},
      setControlState: (name: string, on: boolean) => {
        // 跳跃:立刻离地一格,松开落回(若脚下已被垫上则站在新高度)
        if (name !== 'jump') return;
        const p = bot.entity.position;
        if (on) bot.entity.position = new V(p.x, Math.floor(p.y) + 1.2, p.z);
        else {
          const feet = Math.floor(p.y);
          const under = keyOf(Math.floor(p.x), feet - 1, Math.floor(p.z));
          bot.entity.position = new V(p.x, solid.has(under) ? feet : feet - 1, p.z);
        }
      },
      blockAt: (p: V) => {
        const k = keyOf(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
        // 放下去的是什么,回读就该是什么:执行器按"这一格变成了要放的东西"判成败,
        // 一律回 stone 的假世界会把放成功报成失败
        const name = placedName.get(k) ?? (solid.has(k) ? 'stone' : 'air');
        return {
          name,
          position: p,
          boundingBox: solid.has(k) ? 'block' : 'empty',
          diggable: true,
          canHarvest: () => true,
        };
      },
      placeBlock: async (ref: { position: V }, face: V) => {
        const spot = keyOf(
          Math.floor(ref.position.x) + face.x,
          Math.floor(ref.position.y) + face.y,
          Math.floor(ref.position.z) + face.z,
        );
        solid.add(spot);
        placedName.set(spot, bag[0].name);
        bot.placedAt.push(spot);
        bag[0].count--;
      },
      canDigBlock: () => true,
      digTime: () => 50,
      stopDigging: () => {},
      dig: async () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  it('build 垫高出坑:从脚下往上搭 line,跳一下垫一块,一路把自己顶上去', async () => {
    // 脚下只有一块支撑。
    const bot = pillarBot(['0,63,0']);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'build', shape: 'line', material: 'cobblestone',
      anchors: [['~', '~', '~'], ['~', '~2', '~']],
    }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('放好了 3 块圆石');
    // 三块都垫在自己脚下,人跟着上了 3 格
    expect(bot.placedAt).toEqual(['0,64,0', '0,65,0', '0,66,0']);
    expect(Math.floor(bot.entity.position.y)).toBe(67);
  });

  it('build 材料中途用完:如实停,报放了几块、停在哪', async () => {
    const bot = pillarBot(['0,63,0'], { stock: 2 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'build', shape: 'line', material: 'cobblestone',
      anchors: [['~', '~', '~'], ['~', '~4', '~']],
    }]);
    await waitUntil(() => reports.length === 1, 8000);
    // 放上 2 块、还差 3 块属于部分完成。
    expect(reports[0].kind).toBe('partial');
    expect(reports[0].text).toContain('放了 2/5 块');
    expect(reports[0].text).toContain('圆石用完了');
    // 缺口点名:差几处、差在哪几格
    expect(reports[0].text).toContain('还差 3 处没放上');
  });

  it('build dryRun:报格数/占用/缺口,一块不动', async () => {
    const bot = pillarBot(['0,63,0'], { stock: 1 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'build', shape: 'line', material: 'cobblestone', dryRun: true,
      anchors: [['~', '~', '~'], ['~', '~2', '~']],
    }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('要放 3 块');
    expect(reports[0].text).toContain('差 2');
    expect(reports[0].text).toContain('没动工');
    expect(bot.placedAt).toEqual([]);
  });

  it('probe 竖井:头顶一柱空气 + 封闭判定', async () => {
    // 四壁+顶封死的 1×1 井:井内空气仅 3 格
    const walls: string[] = ['0,63,0', '0,67,0'];
    for (let y = 64; y <= 66; y++) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) walls.push(`${dx},${y},${dz}`);
    }
    const bot = pillarBot(walls);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'probe', shape: 'line', anchors: [['~', '~', '~'], ['~', '~2', '~']] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('全是空气');
    expect(reports[0].text).toContain('封死的');
  });

  it('probe 通天井:露天探查不再说"连着更大的空间"', async () => {
    const bot = pillarBot(['0,63,0']); // 四面八方全是空气
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'probe', shape: 'line', anchors: [['~', '~', '~'], ['~', '~40', '~']] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('空气×41');
    expect(reports[0].text).not.toContain('连着更大的空间');
  });

  it('tunnel 坡度闸:超 45° 不接;只报几何事实,不指路', async () => {
    const bot = shaftBot(['stone', 'stone']);
    const rigA = makeExecutorOn(bot);
    rigA.exec.submit([{ skill: 'tunnel', at: ['~10', '~-20', '~'] }]);
    await waitUntil(() => rigA.reports.length === 1, 8000);
    expect(rigA.reports[0].kind).toBe('blocked');
    expect(rigA.reports[0].text).toContain('45°');
    expect(rigA.reports[0].text).not.toContain('excavate');
  });

  // fill 须出现在 build、excavate、probe 的任务标签中。
  it('fill 进 build/excavate/probe 三个技能的标签;别的形状没有这一维', () => {
    const corners: Anchor[] = [[0, 64, 0], [3, 66, 3]];
    expect(describeSkill({ skill: 'excavate', shape: 'box', anchors: [...corners], fill: 'outline' }))
      .toContain('挖开空壳长方体');
    expect(describeSkill({ skill: 'probe', shape: 'box', anchors: [...corners], fill: 'edges' }))
      .toContain('探查框架长方体');
    expect(describeSkill({ skill: 'build', shape: 'box', anchors: [...corners], material: 'stone', fill: 'outline' }))
      .toContain('搭空壳石头');
    // box 缺省即实心,照实写出来;直线没有填充这一维,一个字都不加
    expect(describeSkill({ skill: 'excavate', shape: 'box', anchors: [...corners] })).toContain('挖开实心长方体');
    expect(describeSkill({ skill: 'excavate', shape: 'line', anchors: [...corners] })).toContain('挖开直线');
  });

  it('parseSteps 校验几何技能:shape 枚举、锚点数、材料、fill、dryRun', () => {
    const bad1 = parseSteps([{ skill: 'build', shape: 'blob', anchors: [], material: 'stone' }]);
    expect(bad1).toMatchObject({ error: expect.stringContaining('shape') });
    const bad2 = parseSteps([{ skill: 'probe', shape: 'arc', anchors: [[0, 0, 0], [1, 1, 1]] }]);
    expect(bad2).toMatchObject({ error: expect.stringContaining('3 个锚点') });
    const bad3 = parseSteps([{ skill: 'build', shape: 'line', anchors: [[0, 0, 0], [1, 1, 1]] }]);
    expect(bad3).toMatchObject({ error: expect.stringContaining('material') });
    const bad4 = parseSteps([{ skill: 'excavate', shape: 'box', anchors: [[0, 0, 0], [1, 1, 1]], fill: 'lace' }]);
    expect(bad4).toMatchObject({ error: expect.stringContaining('fill') });
    // 假朋友:原版 /fill 的 hollow 是"外壳 + 内部清成空气",与我们的 outline 差一整个内部。
    // 不当别名收下,退回时当场说清分别 —— 这是改名唯一的通知口。
    const falseFriend = parseSteps([{ skill: 'build', shape: 'box', anchors: [[0, 0, 0], [1, 1, 1]], material: 'stone', fill: 'hollow' }]);
    expect(falseFriend).toMatchObject({ error: expect.stringContaining('outline') });
    expect('error' in falseFriend && falseFriend.error).toContain('清成空气');
    const bad5 = parseSteps([{ skill: 'tunnel', at: [0, 0] }]);
    expect(bad5).toMatchObject({ error: expect.stringContaining('tunnel') });

    const ok = parseSteps([
      { skill: 'build', shape: 'box', anchors: [['~', 0, 0], [3, 3, 3]], material: 'cobblestone', fill: 'outline', dryRun: true },
      { skill: 'tunnel', at: ['~30', '~-10', '~'] },
      { skill: 'probe', shape: 'line', anchors: [[0, 0, 0], [0, 9, 0]] },
    ]);
    if ('error' in ok) throw new Error(ok.error);
    expect(ok.steps[0]).toEqual({
      skill: 'build', shape: 'box', anchors: [['~', 0, 0], [3, 3, 3]],
      material: 'cobblestone', fill: 'outline', dryRun: true,
    });
    expect(ok.steps[1]).toEqual({ skill: 'tunnel', at: ['~30', '~-10', '~'] });
    expect(ok.steps[2]).toEqual({ skill: 'probe', shape: 'line', anchors: [[0, 0, 0], [0, 9, 0]] });
  });

  it('parseSteps 为 collect/excavate/tunnel 保留单步 tool 覆盖', () => {
    const parsed = parseSteps([
      { skill: 'collect', block: 'stone', count: 2, tool: 'fastest' },
      { skill: 'excavate', shape: 'line', anchors: [[0, 64, 0], [2, 64, 0]], tool: 'stone_pickaxe' },
      { skill: 'tunnel', at: [8, 64, 0], tool: 'iron_pickaxe' },
    ]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.steps).toEqual([
      { skill: 'collect', block: 'stone', count: 2, tool: 'fastest' },
      { skill: 'excavate', shape: 'line', anchors: [[0, 64, 0], [2, 64, 0]], tool: 'stone_pickaxe' },
      { skill: 'tunnel', at: [8, 64, 0], tool: 'iron_pickaxe' },
    ]);
  });

  // probe 契约不提供 target/radius；无形状参数的调用走普通 shape 校验。
  it('probe 只圈一片读:契约面上没有 target/radius', () => {
    expect(parseSteps([{ skill: 'probe', target: 'chest' }]))
      .toMatchObject({ error: expect.stringContaining('shape') });
    expect(parseSteps([{ skill: 'probe', shape: 'line', anchors: [[0, 0, 0], [0, 9, 0]] }]))
      .toEqual({ steps: [{ skill: 'probe', shape: 'line', anchors: [[0, 0, 0], [0, 9, 0]] }] });
    expect(describeSkill({ skill: 'probe', shape: 'line', anchors: [[0, 0, 0], [0, 9, 0]] }))
      .toBe('探查直线 (0,0,0)→(0,9,0)');
  });

  it('parseSteps 认 pickup/toss/stow/take,不带时不冒出可选键', () => {
    expect(parseSteps([{ skill: 'pickup' }])).toEqual({ steps: [{ skill: 'pickup' }] });
    expect(parseSteps([{ skill: 'pickup', item: 'cobblestone' }]))
      .toEqual({ steps: [{ skill: 'pickup', item: 'cobblestone' }] });
    expect(parseSteps([{ skill: 'toss', item: 'cobblestone', count: 64 }]))
      .toEqual({ steps: [{ skill: 'toss', item: 'cobblestone', count: 64 }] });
    expect(parseSteps([{ skill: 'stow', item: 'cobblestone' }]))
      .toEqual({ steps: [{ skill: 'stow', item: 'cobblestone', count: 1 }] });
    expect(parseSteps([{ skill: 'take', item: 'coal', count: 16 }]))
      .toEqual({ steps: [{ skill: 'take', item: 'coal', count: 16 }] });
    const gone = parseSteps([{ skill: 'peek' }]);
    expect('error' in gone && gone.error).toContain('peek');
    const bad = parseSteps([{ skill: 'toss' }]);
    expect('error' in bad && bad.error).toContain('item');
  });

  it('parseSteps 认 buried,不带时不冒出这个键', () => {
    const parsed = parseSteps([{ skill: 'collect', block: 'stone', count: 3, buried: true }]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.steps[0]).toEqual({ skill: 'collect', block: 'stone', count: 3, buried: true });
    const plain = parseSteps([{ skill: 'collect', block: 'stone', count: 3 }]);
    if ('error' in plain) throw new Error(plain.error);
    expect(plain.steps[0]).toEqual({ skill: 'collect', block: 'stone', count: 3 });
  });

  it('够不到的方块不下挖:先说够不到,不发那个永远不返回的 dig', async () => {
    // 位置对上了(goto 判定到达),但方块在 reach 之外
    const bot = mineBot({ reachable: false, digHangs: true });
    bot.pathfinder.goto = async () => { bot.entity.position = new V(-8, 50, 8); };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 8 }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('够不到');
  });

  it('走不到的矿现在有出路:excavate 沿直线挖脚边那一列,不经寻路', async () => {
    const bot = shaftBot(['stone', 'stone', 'stone', 'stone']);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [['~1', '~-1', '~'], ['~1', '~-3', '~']] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('挖开了 3/3 块');
    expect(bot.dugNames).toEqual(['stone', 'stone', 'stone']);
  });


  it('excavate 目标柱就是自己站的这一列:拒收并说清,一格都不动', async () => {
    const bot = shaftBot(['stone', 'stone', 'stone', 'stone'], { underfoot: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [['~', '~-1', '~'], ['~', '~-3', '~']] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('这列在你脚下');
    expect(reports[0].text).toContain('先站到旁边');
    expect(reports[0].text).toContain('tunnel');
    expect(bot.dugNames).toEqual([]);
  });

  it('只含脚下单独一格支撑的不拒:仍走「它下面是实心才挖」那条,一格一落', async () => {
    const bot = shaftBot(['stone', 'stone'], { underfoot: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [['~', '~-1', '~'], ['~', '~-1', '~']] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.dugNames).toEqual(['stone']);
  });

  it('说 cobblestone 挖的是 stone:按掉落表反查,不是找不到就算了', async () => {
    // 地下只有 stone;cobblestone 那个方块(石头挖过之后放下的)一块都没有
    const stone = { name: 'stone', position: new V(1, 63, 0) };
    const asked: number[][] = [];
    const dug: string[] = [];
    const bag: Array<{ name: string; count: number }> = [];
    const bot = {
      entity: { id: 9, position: new V(0.5, 63, 0.5), onGround: true },
      entities: {},
      health: 20,
      players: {},
      world: { raycast: () => ({ position: stone.position, face: 1 }) },
      registry: {
        blocks: { 1: { name: 'stone', drops: [35] }, 12: { name: 'cobblestone', drops: [35] } },
        blocksByName: {
          stone: { id: 1, name: 'stone', drops: [35] },
          cobblestone: { id: 12, name: 'cobblestone', drops: [35] },
        },
        items: { 35: { name: 'cobblestone' } },
        itemsByName: { cobblestone: { id: 35 } },
      },
      inventory: { items: () => bag },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: (opts: { matching: number[] }) => { asked.push(opts.matching); return [stone.position]; },
      blockAt: () => ({ ...stone, canHarvest: () => true }),
      canSeeBlock: () => true,
      canDigBlock: () => true,
      digTime: () => 50,
      stopDigging: () => {},
      dig: async (b: { name: string }) => { dug.push(b.name); bag.push({ name: 'cobblestone', count: 1 }); },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => { bot.entity.position = new V(1, 63, 0); } },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'cobblestone', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(asked[0]).toContain(1); // stone 的 id 进了候选
    expect(dug).toEqual(['stone']);
    expect(reports[0].kind).toBe('done');
  });

  it('excavate 没有能保住掉落的工具:开挖前阻断,不毁方块', async () => {
    const line = { skill: 'excavate', shape: 'line', anchors: [['~1', '~-1', '~'], ['~1', '~-3', '~']] } as const;
    const bare = shaftBot(['stone', 'stone', 'stone', 'stone'], { harvestable: false });
    const rigA = makeExecutorOn(bare);
    rigA.exec.submit([{ ...line, anchors: [...line.anchors.map((a) => [...a])] } as never]);
    await waitUntil(() => rigA.reports.length === 1, 8000);
    expect(rigA.reports[0].kind).toBe('blocked');
    expect(rigA.reports[0].text).toContain('包里没有能保住石头掉落的工具');
    expect(rigA.reports[0].text).toContain('没动方块');
    expect(bare.dugNames).toEqual([]);

    // 工具趁手有掉落:拾取清单如实入回执
    const loot = shaftBot(['dirt', 'dirt', 'dirt', 'dirt'], { loot: 'dirt' });
    const rigB = makeExecutorOn(loot);
    rigB.exec.submit([{ ...line, anchors: [...line.anchors.map((a) => [...a])] } as never]);
    await waitUntil(() => rigB.reports.length === 1, 8000);
    expect(rigB.reports[0].kind).toBe('done');
    expect(rigB.reports[0].text).toContain('这一路拾取:泥土×3');
    expect(rigB.reports[0].text).not.toContain('不掉东西');
  });

  it('collect 圆石找不着:受阻回执带掉落物来源的机械事实', async () => {
    const bot = {
      entity: { id: 9, position: new V(0.5, 63, 0.5), onGround: true },
      entities: {},
      health: 20,
      players: {},
      registry: {
        blocks: { 12: { name: 'cobblestone', drops: [35] } },
        blocksByName: { cobblestone: { id: 12, name: 'cobblestone', drops: [35] } },
        items: { 35: { name: 'cobblestone' } },
        itemsByName: { cobblestone: { id: 35 } },
      },
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: () => [],
      blockAt: () => null,
      canSeeBlock: () => true,
      canDigBlock: () => true,
      digTime: () => 50,
      stopDigging: () => {},
      dig: async () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'cobblestone', count: 8 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('附近看不见圆石');
    expect(reports[0].text).toContain('用镐挖石头掉出来的');
  });

  it('计数过半推一份进度:带完成数与位置,投递档位由 World 按 half 升为常规', async () => {
    const bot = shaftBot(['stone', 'stone', 'stone', 'stone']);
    const progress: TaskProgress[] = [];
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      onProgress: (p) => progress.push(p),
    });
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [['~1', '~-1', '~'], ['~1', '~-4', '~']] }]);
    await waitUntil(() => reports.length === 1, 8000);
    const half = progress.find((p) => p.half);
    if (!half) throw new Error('过半进度没有推送');
    expect(half.count).toEqual({ done: 2, total: 4 });
    expect(half.step).toContain('挖开直线');
    expect(half.pos).not.toBeNull();
    // 30s 周期份在测试时长内不该触发
    expect(progress.filter((p) => !p.half)).toHaveLength(0);
  });

  it('基岩上开挖:一格都挖不成算受阻,不报个"挖了 0 格"的成功', async () => {
    const bot = shaftBot([]);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [['~1', '~-1', '~'], ['~1', '~-5', '~']] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('基岩');
    expect(reports[0].text).toContain('挖不动');
    expect(bot.dugNames).toEqual([]);
  });

  it('够得到就照常挖,不被这两道校验误伤;入包按掉落物数(挖煤矿进包的是煤)', async () => {
    const bot = mineBot({ reachable: true });
    bot.pathfinder.goto = async () => { bot.entity.position = new V(-8, 50, 8); };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('挖了 1 块');
    expect(reports[0].text).toContain('实际入包 1 个');
  });

  /**
   * collect 的 count 是方块数，has.count 是物品数，不能用前者作为后者的验收量。
   * 未够数时回执先报告缺口，实际挖掘和入包数量由技能报告。
   */
  it('挖到没得挖了:缺口写在句首,不再叠一条推来的核验', async () => {
    const bot = mineBot({ reachable: true });
    bot.pathfinder.goto = async () => { bot.entity.position = new V(-8, 50, 8); };
    let left = 1; // 只有一块,挖完就没了
    bot.findBlocks = () => (left-- > 0 ? [new V(-8, 50, 8)] : []);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 3 }]);
    await waitUntil(() => reports.length === 1, 5000);
    // 未够数的采集属于部分完成。
    expect(reports[0].kind).toBe('partial');
    expect(reports[0].text).toContain('挖了 1 块煤矿石(要 3 块)');
    expect(reports[0].text).toContain('入包 1 个');
    expect(reports[0].text).toContain('近处再没有看得见的了');
    expect(reports[0].text).not.toContain('核验');
  });

  /**
   * 采空事实与登记路标并列出现在回执中，不自动修改路标。
   */
  it('把一片采空:回执把「挖完了」和「这儿有你登记的路标」并排摆出来', async () => {
    const bot = mineBot({ reachable: true });
    bot.pathfinder.goto = async () => { bot.entity.position = new V(-8, 50, 8); };
    let left = 1;
    bot.findBlocks = () => (left-- > 0 ? [new V(-8, 50, 8)] : []);
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never, report: (r) => reports.push(r), log, nextId: nextTaskId(),
      marks: () => ({
        near: () => null,
        nearest: () => null,
        danger: () => [],
        around: () => [{ name: '废门1号', at: 1_700_000_000_000 }],
      }),
    });
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 3 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].text).toContain('这一片的煤矿石挖完了');
    expect(reports[0].text).toContain('这里有你登记的路标「废门1号」');
    expect(reports[0].text).toContain('记于');
    // 只并置,不动表:一个「要不要改路标」的词都没有
    expect(reports[0].text).not.toContain('改一下');
    expect(reports[0].text).not.toContain('建议');
  });

  it('周围没有路标就不出这一句', async () => {
    const bot = mineBot({ reachable: true });
    bot.pathfinder.goto = async () => { bot.entity.position = new V(-8, 50, 8); };
    let left = 1;
    bot.findBlocks = () => (left-- > 0 ? [new V(-8, 50, 8)] : []);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 3 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].text).not.toContain('挖完了');
  });

  /**
   * 她自己写的 `{has:{item,count}}` 说的是**存量**(「包里有 N 个」),不是这一趟挖到多少。
   * 执行器不替她换口径:她要的是"手上凑够 3 个煤",库存里那 25 个当然算数。
   */
  it('她自己声明 expect 时按存量核验:包里够了就是达成', async () => {
    const bot = mineBot({ reachable: true });
    bot.pathfinder.goto = async () => { bot.entity.position = new V(-8, 50, 8); };
    let left = 1;
    bot.findBlocks = () => (left-- > 0 ? [new V(-8, 50, 8)] : []);
    bot.inventory.items().push({ name: 'coal', count: 25 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 3, expect: { has: { item: 'coal', count: 3 } } }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('挖了 1 块煤矿石(要 3 块)');
  });

  it('挖下来了却一个都没进包:两件事分开报,不把"方块已经没了"说成没做成', async () => {

    const bot = mineBot({ reachable: true });
    bot.pathfinder.goto = async () => { bot.entity.position = new V(-8, 50, 8); };
    bot.dig = async () => {}; // 挖成了,掉落物没进包
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].text).toContain('方块已经不在了');
    // 但绝不能让她以为东西到手了
    expect(reports[0].text).toContain('一个都没进包');
  });

  it('一块都没挖到才是真没做成', async () => {
    const bot = mineBot({ reachable: true });
    bot.pathfinder.goto = async () => { bot.entity.position = new V(-8, 50, 8); };
    bot.dig = async () => { throw new Error('digging aborted'); };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
  });
});

describe('needs:缺省因果闸,独立性显式声明', () => {
  /**
   * 默认依赖按产出消费关系判断；后一步不依赖失败步骤的产出时仍可执行。
   */
  it('因果闸:消费前一步产出的跳过并点名要用什么;无因果的照跑并说明', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    // 第 1 步捡煤失败;第 2 步要扔的正是第 1 步该捡回来的煤(因果边)→ 跳过;
    // 第 3 步说话与煤无关 → 照跑,回执说明为什么照跑
    exec.submit([
      { skill: 'pickup', item: 'coal' },
      { skill: 'toss', item: 'coal', count: 1 },
      { skill: 'chat', text: '汇报' },
    ]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    // 跳过那行回念解析后的那一步,并点名要用的是哪样东西。
    // 上游是「地上没煤可捡」这类无事可做,说法与真受阻分开:她不该以为第 1 步走错了
    expect(reports[0].text).toContain('第 2 步 {"skill":"toss","item":"coal","count":1} 跳过(要用第 1 步的煤炭,那一步没什么可做的)');
    expect(bot.said).toEqual(['汇报']);
    expect(reports[0].text).toContain('(第 2 步没做成;这一步不用它的产出,照做了)');
  });

  it('自保尾巴不再连坐:eat 失败后 flee 照跑,不必声明 needs:[]', async () => {
    const bot = combatBot({
      entities: { '1': { name: 'zombie', type: 'mob', position: new V(2, 64, 2), isValid: true } },
    });
    const { exec, reports } = makeExecutorOn(bot);
    // 包里没吃的,eat 必受阻;flee 不消费 eat 的产出,因果闸放行
    exec.submit([{ skill: 'eat', item: 'bread' }, { skill: 'flee', distance: 24 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('吃面包没做成');
    expect(reports[0].text).toContain('甩开了僵尸');
    expect(reports[0].text).toContain('照做了');
  });

  /**
   * 独立步骤有成有败时，任务整体报告 blocked。
   */
  it('needs:[] 独立步:前面怎么失败都照跑;有成有败整条报 blocked', async () => {
    const bot = combatBot({
      entities: { '1': { name: 'zombie', type: 'mob', position: new V(2, 64, 2), isValid: true } },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'eat', item: 'bread' }, { skill: 'flee', distance: 24, needs: [] }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    // 一份回执里两个结局都在
    expect(reports[0].text).toContain('吃面包没做成');
    expect(reports[0].text).toContain('做成的:');
    expect(reports[0].text).toContain('甩开了僵尸');
  });

  /**
   * 战利品可能自动进包；needs:[] 的进食步骤独立于中间 pickup 的结果。
   */
  it('中间一步假失败,声明独立的自保尾巴照跑', async () => {
    const pig = { id: 1, name: 'pig', type: 'mob', position: new V(2, 64, 0.5), isValid: true, height: 1 };
    const bag = [{ name: 'cooked_beef', type: 7, count: 1 }];
    let noteDead = (): void => {};
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: { '1': pig },
      health: 20,
      food: 14,
      players: {},
      registry: { entitiesByName: { pig: {} }, foodsByName: { cooked_beef: {} } },
      inventory: { items: () => bag },
      equip: async () => {},
      lookAt: async () => {},
      attack: () => { pig.isValid = false; noteDead(); },
      blockAt: () => null,
      setControlState: () => {},
      consume: async () => { bag.pop(); },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    noteDead = () => exec.noteCombatTargetDead(1);
    exec.submit([
      { skill: 'attack', target: 'pig' },
      { skill: 'pickup' },
      { skill: 'eat', item: 'cooked_beef', needs: [] },
    ]);
    await waitUntil(() => reports.length === 1, 10_000);
    // 中间那步是「地上没有掉落物」——什么都没发生,不是没做成,整条照样算做完了。
    // 这条测试的名字就是它测的东西:那一次「失败」本来就是假的。
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('打死了猪');
    expect(reports[0].text).toContain('没什么可做的');
    expect(reports[0].text).not.toContain('捡起附近的掉落物没做成');
    // 第三步真的跑了:包里那块熟牛排被吃掉了
    expect(reports[0].text).toContain('吃了一个牛排');
    expect(bag).toHaveLength(0);
  }, 15_000);

  it('全失败与跳过才报 blocked;跳过步不算成功步', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    // 没吃的、也没有敌对生物:独立声明的 flee 照跑,但两步都没做成
    exec.submit([{ skill: 'eat', item: 'bread' }, { skill: 'flee', distance: 24, needs: [] }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked'); // eat 是真受阻(包里没吃的)
    expect(reports[0].text).toContain('吃面包没做成');
    // flee 那一步是无事可做:陈述句、单独成段,不算进没做成的那一堆
    expect(reports[0].text).toContain('附近 32 格内没有敌对生物,不用逃,这一步没什么可做的');
    expect(reports[0].text).not.toContain('做成的:');
  });

  it('显式 DAG:写了就按她写的传递跳过;没写的按因果闸放行', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'chat', text: '一' },
      { skill: 'collect', block: 'nonexistent_block', count: 1, needs: [] },
      { skill: 'chat', text: '三', needs: [1] },
      { skill: 'chat', text: '四', needs: [2, 3] },
      { skill: 'chat', text: '五' },
    ]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked'); // 有步没做成
    // 第 3 步只依赖第 1 步,第 2 步的失败不牵连;第 4 步显式引用了失败的第 2 步,
    // 按她写的跳过;第 5 步没写 needs,说话不消费第 4 步的产出——因果闸放行
    expect(bot.said).toEqual(['一', '三', '五']);
    expect(reports[0].text).toContain('第 4 步 {"skill":"chat","text":"四","needs":[2,3]} 跳过(依赖的第 2 步没做成)');
    expect(reports[0].text).toContain('第 5 步 {"skill":"chat","text":"五"} 用时');
  });

  it('一件里有步受阻+有步跳过,后排任务照泵:队列层不连坐', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'pickup', item: 'coal' },
      { skill: 'toss', item: 'coal', count: 1 },
    ]);
    exec.submit([{ skill: 'chat', text: '下一件' }], 'append');
    await waitUntil(() => reports.length === 2, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('跳过');
    expect(reports[1].kind).toBe('done');
    expect(bot.said).toEqual(['下一件']);
    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
  });

  // optional 这个字段整个没了:独立性如今由 needs:[] 声明
  it('parseSteps 不再认 optional:丢掉它,并把丢了什么交出去', () => {
    const parsed = parseSteps([{ skill: 'eat', item: 'bread', optional: true }, { skill: 'flee' }]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.steps).toEqual([{ skill: 'eat', item: 'bread' }, { skill: 'flee', distance: 24 }]);
    expect(parsed.notes).toEqual([
      { step: 1, field: 'optional', given: true, kind: 'dropped', why: 'eat 不收这个字段' },
    ]);
    expect(parseNoteText(parsed.notes![0])).toBe('第 1 步写的 optional:true,eat 不收这个字段,忽略了');
  });

  // 扁平字段池下模型会把用不上的字段填成 null:那是照 schema 写的,不是她想说什么
  it('parseSteps:写对了的一步不带 notes,填成 null 的多余键也不算', () => {
    const clean = parseSteps([{ skill: 'eat', item: 'bread' }, { skill: 'collect', block: 'stone', count: 2, at: null }]);
    expect(clean).toEqual({
      steps: [{ skill: 'eat', item: 'bread' }, { skill: 'collect', block: 'stone', count: 2 }],
    });
  });
});

describe('expect:在场时即为裁决', () => {
  it('技能报阻但期望已达成:按成功算,回执附实测值', async () => {
    // 包里只有石头,eat 必报阻;has 形态的期望却已满足
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      players: {},
      registry: { entitiesByName: {}, foodsByName: {} },
      inventory: { items: () => [{ name: 'stone', type: 1, count: 5 }] },
      equip: async () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'eat', item: 'bread', expect: { has: { item: 'stone', count: 3 } } }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('技能报受阻(面包不是可进食物品)');
    expect(reports[0].text).toContain('该步按「背包内石头 ≥3」核验:达成(实测 5,读于 ');
  });

  it('期望落空推翻技能报成:回执带期望与实测值', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'chat', text: '喊过了', expect: { has: { item: 'iron_ingot', count: 1 } } }]);
    await waitUntil(() => reports.length === 1, 5000);
    // 技能自己跑成了(话说出去了),但裁决权在 expect
    expect(bot.said).toEqual(['喊过了']);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('该步按「背包内铁锭 ≥1」核验:落空(实测 0,读于 ');
  });

  it('near:goto 报阻但人已在目的地附近,救回', async () => {
    const bot = combatBot({ goto: async () => { throw new Error('No path to the goal!'); } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [0, 64, 0], expect: { near: [0, 64, 0] } }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('技能报受阻(走不过去: 找不到可行路线)');
    expect(reports[0].text).toContain('该步按「距 (0,64,0) 2 格内」核验:达成(实测 水平 0 格,读于 ');
  });

  it('block:锚点按评估时刻脚下解析,落空报该格实际方块', async () => {
    const bot = combatBot({});
    bot.blockAt = (p: V) => ({ name: p.y < 64 ? 'stone' : 'air' });
    const { exec, reports } = makeExecutorOn(bot);
    // 脚下那格(~,~-1,~)是石头:达成
    exec.submit([{ skill: 'chat', text: '甲', expect: { block: 'stone', at: ['~', '~-1', '~'] } }]);
    // 脚所在那格是空气,不是箱子:落空,回执报实际方块
    exec.submit([{ skill: 'chat', text: '乙', expect: { block: 'chest', at: ['~', '~', '~'] } }]);
    await waitUntil(() => reports.length === 2, 5000);
    expect(reports[0].kind).toBe('done');
    // 达成也回显:她拿不到正向确认时,重发是唯一可用的确认手段
    expect(reports[0].text).toContain('该步按「(~,~-1,~) 为石头」核验:达成(实测 石头,读于 ');
    // 核验在该步骤执行时读取，随最终回执重放；须标明读取时刻，不重新读取世界。
    expect(reports[0].text).toMatch(/核验:达成\(实测 石头,读于 \d\d:\d\d:\d\d\)/);
    expect(reports[1].kind).toBe('blocked');
    expect(reports[1].text).toContain('该步按「(~,~,~) 为箱子」核验:落空(实测 空气,读于 ');
  });

  /**
   * 自动推导的判据在达成时也须回显。
   */
  it('自动推导的期望达成时也回显:她没声明,判据照样出声', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('该步按「距 (10,64,10) 2 格内」核验:达成(实测 水平 0 格,读于 ');
  });

  /** 判据出不来的技能(use 的裁决住在自己那儿)不硬凑一句核验 */
  it('推不出判据的一步不回显:回执里一个「核验」字都没有', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'chat', text: '说一句' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).not.toContain('核验');
  });

  /** 回显是一行,不是一段:多步任务里每步只多这一句 */
  it('达成回显只占一行,跟在这一步的结果后面', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'goto', at: [20, 64, 20] }]);
    await waitUntil(() => reports.length === 1, 5000);
    const lines = reports[0].text.split('\n').filter((l) => l.includes('核验'));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toContain('核验:达成');
  });
});

describe('enchant · 只看报价与按档下手', () => {
  it('只看报价:三档各要多少级多少青金石、显示出来的那条附魔、书架数,一个推荐都不给', async () => {
    const { bot, table, inv } = enchantBot({
      // 东西南北四个方向各留出空隙,外圈放两座书架
      shelves: [[4, 64, 0], [4, 65, 0]],
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'enchant', at: table, item: 'diamond_pickaxe' }]);
    await waitUntil(() => reports.length === 1, 8000);
    const t = reports[0].text;
    expect(reports[0].kind).toBe('done');
    expect(t).toContain('等级 12 · 青金石 3 个 · 周围有效书架 2 座');
    expect(t).toContain('1 档 需 1 级 + 1 青金石:耐久I、[未知]');
    expect(t).toContain('3 档 需 12 级 + 3 青金石:效率IV、[未知]');
    expect(t).toContain('只看了报价,没下手');
    // 三原则第三条:不替她权衡哪一档划算
    for (const word of ['建议', '推荐', '划算', '最好', '值得']) expect(t).not.toContain(word);
    // 东西一件不留在台子上
    expect(inv.get('diamond_pickaxe')).toBe(1);
  });

  it('下手:回执报附魔结果与等级、青金石的真实增减', async () => {
    const { bot, table, levelNow } = enchantBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'enchant', at: table, item: 'diamond_pickaxe', index: 3 }]);
    await waitUntil(() => reports.length === 1, 8000);
    const t = reports[0].text;
    expect(t).toContain('第 3 档下手了:钻石镐 → 效率IV·耐久II');
    expect(t).toContain('等级 12 → 9');
    expect(t).toContain('青金石 3 → 0');
    expect(levelNow()).toBe(9);
  });

  it('等级不够:报门槛与现有,不下手', async () => {
    const { bot, table, levelNow } = enchantBot({ level: 5 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'enchant', at: table, item: 'diamond_pickaxe', index: 3 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('要 12 级,现在 5 级');
    expect(levelNow()).toBe(5);
  });

  it('青金石不够:同样只报数', async () => {
    const { bot, table } = enchantBot({ inv: { diamond_pickaxe: 1, lapis_lazuli: 1 } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'enchant', at: table, item: 'diamond_pickaxe', index: 2 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('要 2 个青金石,包里 1 个');
  });

  it('那一格不是附魔台:报它实际是什么', async () => {
    const { bot } = enchantBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'enchant', at: [1, 64, 0], item: 'diamond_pickaxe' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('不是附魔台');
  });

  it('服务端没给报价(比如这件已经附过魔):如实说没读到,不编三档数字', async () => {
    const { bot, table } = enchantBot({ costs: [-1, -1, -1] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'enchant', at: table, item: 'diamond_pickaxe' }]);
    await waitUntil(() => reports.length === 1, 12000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没给出报价');
  }, 15000);
});

/** 酿造台台架:五个槽(3 瓶位 + 材料 + 燃料),moveSlotItem 从包里搬进去 */

describe('容器分账:开窗期间 bot.inventory 是旧账', () => {
  it('stow:照窗口读进度,关窗对上账就报存进去多少', async () => {
    const { bot, inv, box } = chestBot({ inv: { cobblestone: 64 } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'stow', item: 'cobblestone', count: 64 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('存了圆石×64');
    expect(box.get('cobblestone')).toBe(64);
    expect(inv.get('cobblestone')).toBe(0);
  });

  /**
   * 连续 stow 到同一箱子共用一次开关窗口，各步骤仍独立记录搬运与关窗对账。
   */
  it('stow×3 存同一个箱子:并成一次开窗,三条回执照旧各对各的账', async () => {
    const { bot, inv, box } = chestBot({ inv: { cobblestone: 64, iron_ingot: 17, coal: 8 } });
    let opens = 0;
    const open = bot.openContainer;
    bot.openContainer = async (): Promise<Awaited<ReturnType<typeof open>>> => { opens++; return open(); };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'stow', item: 'cobblestone', count: 64 },
      { skill: 'stow', item: 'iron_ingot', count: 17 },
      { skill: 'stow', item: 'coal', count: 8 },
    ]);
    await waitUntil(() => reports.length === 1, 12000);
    expect(opens).toBe(1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('存了圆石×64');
    expect(reports[0].text).toContain('存了铁锭×17');
    expect(reports[0].text).toContain('存了煤炭×8');
    // 并进来的步照实说它是跟谁一起做掉的:回执里"用时 0s"不能是个谜
    expect(reports[0].text).toContain('同一次开窗');
    expect(box.get('cobblestone')).toBe(64);
    expect(box.get('iron_ingot')).toBe(17);
    expect(box.get('coal')).toBe(8);
    expect(inv.get('coal')).toBe(0);
  });

  it('stow×2 中间夹着别的技能:不并,各开各的窗', async () => {
    const { bot, box } = chestBot({ inv: { cobblestone: 64, coal: 8 } });
    let opens = 0;
    const open = bot.openContainer;
    bot.openContainer = async (): Promise<Awaited<ReturnType<typeof open>>> => { opens++; return open(); };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'stow', item: 'cobblestone', count: 64 },
      { skill: 'goto', at: [0, 64, 0] },
      { skill: 'stow', item: 'coal', count: 8 },
    ]);
    await waitUntil(() => reports.length === 1, 12000);
    expect(opens).toBe(2);
    expect(box.get('cobblestone')).toBe(64);
    expect(box.get('coal')).toBe(8);
  });

  it('stow:窗口里一格都没动才算确认没存进,回执说破', async () => {
    const { bot, box } = chestBot({ inv: { cobblestone: 64 }, deaf: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'stow', item: 'cobblestone', count: 64 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('窗口里一格都没动');
    expect(box.size).toBe(0);
  });

  it('stow:关窗后包里的账没跟着变,报的是"没等到确认"而不是失败', async () => {
    const { bot, box } = chestBot({ inv: { cobblestone: 64 }, noCopyBack: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'stow', item: 'cobblestone', count: 64 }]);
    await waitUntil(() => reports.length === 1, 12000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('没回灌确认');
    // 东西是真进箱子了,只是包里那本账还没跟上——回执不能把这个说成没存
    expect(box.get('cobblestone')).toBe(64);
  });

  it('take:照窗口读进度,关窗对上账就报取出多少', async () => {
    const { bot, inv, box } = chestBot({ box: { diamond_pickaxe: 1 } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'take', item: 'diamond_pickaxe', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('取出了钻石镐×1');
    expect(inv.get('diamond_pickaxe')).toBe(1);
    expect(box.get('diamond_pickaxe')).toBe(0);
  });

  it('take:箱子里有但窗口里点不出来,如实说没取到', async () => {
    const { bot } = chestBot({ box: { coal: 16 }, deaf: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'take', item: 'coal', count: 16 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('窗口里一格都没动');
  });

  it('stow:点不动时报服务端给的原话,不拿"箱子满了或对不上"的猜测顶替', async () => {
    const { bot } = chestBot({ inv: { cobblestone: 64 }, throws: 'destination full' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'stow', item: 'cobblestone', count: 64 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('那一边没空位了');
    expect(reports[0].text).not.toContain('或对不上');
  });

  /**
   * 背包已满导致 take 受阻时，回执须点明背包容量原因，保留目标箱子坐标。
   */
  it('take:包满了取不出来,结论说的是包不是箱子;箱子那一格的坐标照旧带着', async () => {
    const { bot } = chestBot({
      box: { coal: 16 },
      throws: 'Unable to withdraw, Bot inventory is full.',
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'take', item: 'coal', count: 16 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('背包 36 格全满了,煤炭取不出来');
    expect(reports[0].text).not.toContain('附近箱子里没取到');
    // 哪个箱子里有、开箱时里面是什么仍是现场事实,不因为改主语而丢掉
    expect(reports[0].text).toContain('(2, 64, 0)');
    // 背包满也是卡在东西上:回执带当刻全量背包
    expect(reports[0].text).toContain('[背包]');
  });

  /**
   * 开容器前退役遗留窗口；返回错误窗口类型时强制关窗重开一次，连续两次失败才报告受阻。
   */
  it('开箱撞上串号窗口:退役遗留窗口、强制重开一次,这单照常做成', async () => {
    const { bot, box } = chestBot({ inv: { cobblestone: 64 } });
    const open = bot.openContainer;
    let calls = 0;
    let closed = 0;
    const b = bot as unknown as {
      currentWindow: { id: number; type: string } | null;
      closeWindow: (w: unknown) => void;
    };
    b.currentWindow = { id: 58, type: 'minecraft:crafting' };
    b.closeWindow = () => { closed++; b.currentWindow = null; };
    bot.openContainer = async (): Promise<Awaited<ReturnType<typeof open>>> => {
      calls++;
      if (calls === 1) throw new Error('Non-container window used as a container');
      return open();
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'stow', item: 'cobblestone', count: 64 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('存了圆石×64');
    expect(box.get('cobblestone')).toBe(64);
    expect(calls).toBe(2);
    expect(closed).toBe(1); // 开窗前那次退役;重试前 currentWindow 已空,不再关
  });

  it('连着两次都是串号窗口:受阻,回执说人话而不是英文黑话', async () => {
    const { bot } = chestBot({ inv: { cobblestone: 64 } });
    const open = bot.openContainer;
    bot.openContainer = async (): Promise<Awaited<ReturnType<typeof open>>> => {
      throw new Error('Non-container window used as a container');
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'stow', item: 'cobblestone', count: 64 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('窗口串号了');
    expect(reports[0].text).toContain('没有丢');
    expect(reports[0].text).not.toContain('Non-container');
  });

  it('take:箱子里真的没有时结论仍归箱子', async () => {
    const { bot } = chestBot({ box: { cobblestone: 8 } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'take', item: 'coal', count: 16 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('附近箱子里没取到煤炭');
    expect(reports[0].text).not.toContain('包里没空格');
  });

  it('take:没等到回灌确认时报"以包里为准",不冒充成没拿到', async () => {
    const { bot, box } = chestBot({ box: { diamond_pickaxe: 1 }, noCopyBack: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'take', item: 'diamond_pickaxe', count: 1 }]);
    await waitUntil(() => reports.length === 1, 12000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('没回灌确认');
    expect(reports[0].text).toContain('服务端还没回灌确认');
    expect(box.get('diamond_pickaxe')).toBe(0);
  });
});



describe('take:差多少说多少 + at 寻址', () => {
  it('部分取到:回执点破要几个、为什么只有这些,不让 ×4 冒充到齐', async () => {
    const { bot } = chestBot({ box: { coal: 4 } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'take', item: 'coal', count: 16 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('从箱子取出了煤炭×4(要 16 个,附近箱子里就取到这些)');
  });

  it('take at 指着箱子:不带 item 整箱掏空,带 item 只取那一样', async () => {
    const a = chestBot({ box: { coal: 4, iron_ingot: 2 } });
    const ra = makeExecutorOn(a.bot);
    ra.exec.submit([{ skill: 'take', at: [2, 64, 0], all: true }]);
    await waitUntil(() => ra.reports.length === 1, 8000);
    expect(ra.reports[0].kind).toBe('done');
    expect(ra.reports[0].text).toContain('煤炭×4');
    expect(ra.reports[0].text).toContain('铁锭×2');
    expect(ra.reports[0].text).toContain('箱里现在:空的');
    expect(a.inv.get('coal')).toBe(4);
    expect(a.inv.get('iron_ingot')).toBe(2);

    const b = chestBot({ box: { coal: 4, iron_ingot: 2 } });
    const rb = makeExecutorOn(b.bot);
    rb.exec.submit([{ skill: 'take', at: [2, 64, 0], item: 'coal', count: 2 }]);
    await waitUntil(() => rb.reports.length === 1, 8000);
    // 只取煤;铁锭留在箱里,只出现在「箱里现在」的读数里
    expect(rb.reports[0].text).toContain('取出煤炭×2。');
    expect(rb.reports[0].text).toContain('箱里现在:煤炭×2、铁锭×2');
    expect(b.box.get('iron_ingot')).toBe(2);
  });

  it('take at 指着不是容器的一格:直说那是什么', async () => {
    const { bot } = chestBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'take', at: [0, 63, 0], all: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('不是箱子、炉子或酿造台');
  });

  it('parse:定量取物与清空容器是两种显式形状', () => {
    const bad = parseSteps([{ skill: 'take', count: 3 }]);
    expect('error' in bad && bad.error).toContain('item+count');
    const ambiguous = parseSteps([{ skill: 'take', at: [1, 64, 1] }]);
    expect('error' in ambiguous && ambiguous.error).toContain('all:true');
    expect(parseSteps([{ skill: 'take', at: [1, 64, 1], all: true }]))
      .toEqual({ steps: [{ skill: 'take', at: [1, 64, 1], all: true }] });
    const noCount = parseSteps([{ skill: 'take', item: 'coal' }]);
    expect('error' in noCount && noCount.error).toContain('必须写 count');
  });
});

describe('第一步的相对锚点入队即冻结', () => {
  it('第一步的 ~ 按受理时脚下解析并在回执点破;第二步保留到执行时再解析', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    const receipt = exec.submit([
      { skill: 'goto', at: ['~5', '~', '~-2'] },
      { skill: 'tunnel', at: ['~', '~-10', '~'] },
    ]);
    expect(receipt).toContain('{"skill":"goto","at":[5,64,-2]}');
    expect(receipt).toContain('{"skill":"tunnel","at":["~","~-10","~"]}');
    expect(receipt).toContain('第 1 步的 ~ 是按你下这一单时站的地方 (0, 64, 0) 算的');
    await waitUntil(() => reports.length === 1, 5000);
  });

  it('绝对坐标是恒等变换:不点破、不改写', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    const receipt = exec.submit([{ skill: 'goto', at: [3, 64, 3] }]);
    expect(receipt).toContain('{"skill":"goto","at":[3,64,3]}');
    expect(receipt).not.toContain('相对锚点');
    await waitUntil(() => reports.length === 1, 5000);
  });

  /**
   * 回念只列与原始输入不同的字段；相对坐标冻结为绝对坐标属于须回念的变更。
   */
  it('~ 被冻成绝对坐标:回念点名这一步的这个字段,一致的那一步不出现', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    const wrote = [
      { skill: 'goto', at: ['~5', '~', '~-2'] },
      { skill: 'toss', item: 'dirt', count: 2 },
    ];
    const receipt = exec.submit(
      [{ skill: 'goto', at: ['~5', '~', '~-2'] }, { skill: 'toss', item: 'dirt', count: 2 }],
      'replace',
      wrote,
    );
    expect(receipt).toContain('相对锚点已折成绝对坐标:第 1 步的 at 你写 ["~5","~","~-2"]、我按 [5,64,-2] 跑');
    expect(receipt).not.toContain('第 2 步的');
    // 整份 JSON 回念不再出场
    expect(receipt).not.toContain('{"skill":"toss"');
    await waitUntil(() => reports.length === 1, 5000);
  });

  /**
   * 相对坐标折算放在回执首句；缺省填充说明采用的理解，路标解析压缩为尾段事实。
   */
  it('回念三类分开说:~ 折算提首句、缺省填充说「我按…理解」、路标解析压成一句', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    const wrote = [{ skill: 'goto', at: ['~5', '~', '~-2'] }];
    const receipt = exec.submit(
      [{ skill: 'goto', at: ['~5', '~', '~-2'], groundY: true } as never],
      'replace',
      wrote,
    );
    // `~` 折算排在受理句之前的 ⚠ 段里
    expect(receipt.indexOf('相对锚点已折成绝对坐标')).toBeLessThan(receipt.indexOf('任务#1 收下了'));
    // 缺省填充不说"我按 X 跑"(那读起来像改写了她的话),说"我按 X 理解"
    expect(receipt).toContain('groundY 你没写,我按 true 理解');
    await waitUntil(() => reports.length === 1, 5000);
  });

  it('路标名解析不再混进「跟你写的不一样」:它是解析,不是改写', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    const receipt = exec.submit(
      [{ skill: 'goto', at: [100, 64, -20] }],
      'replace',
      [{ skill: 'goto', at: '家' }],
    );
    expect(receipt).toContain('at 路标「家」= [100,64,-20]');
    expect(receipt).not.toContain('跟你写的不一样');
    await waitUntil(() => reports.length === 1, 8000);
  });

  it('拿不到她写的原文(台架、 World 内部下单)就照旧整份回念', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    const receipt = exec.submit([{ skill: 'toss', item: 'dirt', count: 2 }]);
    expect(receipt).toContain('{"skill":"toss","item":"dirt","count":2}');
    await waitUntil(() => reports.length === 1, 5000);
  });
});

describe('抢占之后的寻路目标要活下来', () => {
  it('preempt 不撤目标:反射紧接着下的逃跑目标不会被抹掉', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const bot = combatBot({ goto: async (arrive) => { await gate; arrive(); } });
    const pf = fakePathfinder();
    bot.pathfinder = pf as never;
    const { exec } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    exec.preempt('血量过低,脱离战斗');
    pf.setGoal('逃跑目标'); // 反射在抢占后设置替代目标。
    expect(pf.goal).toBe('逃跑目标');
    // 被抢占任务的 200ms 看门狗不得清除替代目标。
    await sleep(400);
    expect(pf.goal).toBe('逃跑目标');
    release!();
  });

  it('顶替与叫停仍然把人停下来', async () => {
    const bot = combatBot({});
    const pf = fakePathfinder();
    bot.pathfinder = pf as never;
    const { exec } = makeExecutorOn(bot);
    pf.setGoal('旧目标');
    exec.submit([{ skill: 'chat', text: 'x' }]);
    expect(pf.goal).toBeNull();
    pf.setGoal('又一个');
    exec.clear();
    expect(pf.goal).toBeNull();
  });

  /**
   * pathfinder.goto() 先设置目标再 resolve/reject；夹具复现该顺序，受阻退出须撤销本任务目标。
   */
  it('goto 被寻路器拒掉:退出时把目标一起撤了', async () => {
    const bot = combatBot({});
    const pf = fakePathfinder();
    pf.goto = async (g?: unknown) => { pf.setGoal(g); throw new Error('goal was changed'); };
    bot.pathfinder = pf as never;
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(pf.goal).toBeNull();
  });

  it('goto 的承重放置未确认:按具体支撑格受阻,不继续同一目标', async () => {
    const bot = combatBot({});
    const pf = fakePathfinder();
    pf.goto = async (g?: unknown) => {
      pf.setGoal(g);
      Object.assign(bot, { pathSupportFailure: { seq: 1, was: 'air', x: 19, y: 100, z: 7 } });
      pf.setGoal(null);
      throw new Error('goal was changed');
    };
    bot.pathfinder = pf as never;
    const { exec, reports } = makeExecutorOn(bot);

    exec.submit([{ skill: 'goto', at: [32, 100, 1] }]);
    await waitUntil(() => reports.length === 1, 8000);

    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('搭路支撑 (19, 100, 7)');
    expect(reports[0].text).toContain('服务端未确认;已取消这段路径');
    expect(pf.goal).toBeNull();
  });

  it('goto 到点校验没过(人没到而 goto 却 resolve 了):目标同样撤掉', async () => {
    const bot = combatBot({});
    const pf = fakePathfinder();
    pf.goto = async (g?: unknown) => { pf.setGoal(g); }; // 目标留着,人一步没动
    bot.pathfinder = pf as never;
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('找不到可行路线');
    expect(pf.goal).toBeNull();
  });

  /**
   * 中止后由抢占方设置的目标属于新执行者，旧任务收尾不能撤销它。
   */
  it('中止退出:抢占方随后下的目标必须活下来,旧任务收尾不许抹掉', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const bot = combatBot({});
    const pf = fakePathfinder();
    pf.goto = async (g?: unknown) => { pf.setGoal(g); await gate; throw new Error('goal was changed'); };
    bot.pathfinder = pf as never;
    const { exec } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => pf.goal !== null);
    exec.preempt('防溺水上浮找岸');
    pf.setGoal('反射的登岸目标');
    release!();
    await sleep(400);
    expect(pf.goal).toBe('反射的登岸目标');
  });
});

describe('Reflexes 受击', () => {
  /** 受击反应的假 bot:一只贴脸的僵尸,血量可控 */
  function hurtBot(health: number) {
    type HurtSource = {
      id: number; name: string; type: string; position: V; isValid: boolean;
    };
    const handlers: Array<(e: { id: number }, source?: HurtSource) => void> = [];
    const pf = fakePathfinder();
    const entities: Record<string, HurtSource> = {
      '2': { id: 2, name: 'zombie', type: 'mob', position: new V(2, 64, 0.5), isValid: true },
    };
    return {
      pf,
      entity: { id: 1, position: new V(0.5, 64, 0.5) },
      entities,
      health,
      food: 20,
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async () => {},
      attack: () => {},
      blockAt: () => null,
      setControlState: () => {},
      pathfinder: pf,
      on: (event: string, h: (x: { id: number }, source?: HurtSource) => void) => {
        if (event === 'entityHurt') handlers.push(h);
      },
      removeListener: () => {},
      hooked: () => handlers.length > 0,
      hurt: (source?: HurtSource) => handlers.forEach((h) => h({ id: 1 }, source)),
    };
  }

  function reflexesOn(
    bot: ReturnType<typeof hurtBot>,
    fightBack: boolean,
    escapeActive?: () => boolean,
    combatHurt?: (attackerId: number, name: string) => boolean,
  ) {
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
      fightBack: () => fightBack,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => false,
      ...(escapeActive ? { escapeActive } : {}),
      ...(combatHurt ? { combatHurt } : {}),
    });
    return { reflexes, reports, preempts };
  }

  it('血跌破撤退线时照样撤,关掉反击的意思是不还手而不是不跑', async () => {
    const bot = hurtBot(6);
    const { reflexes, reports, preempts } = reflexesOn(bot, false);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000); // 受击监听挂在 1s 心跳上
    bot.hurt(bot.entities['2']);
    await waitUntil(() => reports.length === 1, 3000);
    reflexes.stop();
    expect(reports[0].text).toContain('脱离战斗');
    expect(preempts[0]).toContain('血量过低');
    // 汇报说在逃,寻路器那边就得真有一个目标
    expect(bot.pf.goal).not.toBeNull();
    expect((bot.pf.goal as FakeGoal).constructor.name).toBe('GoalNearXZ');
    expect((bot.pf.goal as FakeGoal).y).toBeUndefined();
    expect((bot.pf.goal as FakeGoal).x).toBe(-16);
    expect((bot.pf.goal as FakeGoal).z).toBe(0);
  });

  /**
   * 1.20+ damage_event 自带 source；animation/entity_status 路径的 entityHurt 不带 source，须使用无来源事件的备用判据。
   */
  it('entityHurt 不带 source:退回「6 格内最近敌对生物」,反击不哑火', async () => {
    const bot = hurtBot(6);
    const { reflexes, reports, preempts } = reflexesOn(bot, false);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt(undefined); // 旧协议路径:一个 source 都没有
    await waitUntil(() => reports.length === 1, 3000);
    reflexes.stop();
    expect(reports[0].text).toContain('zombie');
    expect(reports[0].text).toContain('脱离战斗');
    expect(preempts[0]).toContain('血量过低');
  });

  it('没有 source 且 6 格内没有敌对生物:照旧判环境伤害,不拿远处的乱猜', async () => {
    const bot = hurtBot(6);
    bot.entities['2'].position = new V(20, 64, 0.5); // 挪到 6 格之外
    const { reflexes, reports } = reflexesOn(bot, false);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt(undefined);
    await sleep(300);
    reflexes.stop();
    expect(reports.some((r) => r.text.includes('脱离战斗'))).toBe(false);
  });

  it('反击关着且血还够:什么都不做', async () => {
    const bot = hurtBot(18);
    const { reflexes, reports } = reflexesOn(bot, false);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt(bot.entities['2']);
    await sleep(200);
    reflexes.stop();
    expect(reports).toEqual([]);
  });

  it('自救任务在场(escapeActive 为真)时低血受击不抢占:吃东西/逃跑让它做完', async () => {
    const bot = hurtBot(6);
    const { reflexes, reports, preempts } = reflexesOn(bot, false, () => true);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt(bot.entities['2']);
    await sleep(300);
    reflexes.stop();
    expect(preempts).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('只把事件给出的精确 source 交给战斗会话,不拿更近的生物替换远距来源', async () => {
    const bot = hurtBot(18);
    const distant = {
      id: 3, name: 'skeleton', type: 'mob', position: new V(40, 64, 0.5), isValid: true,
    };
    bot.entities['3'] = distant;
    const seen: Array<{ id: number; name: string }> = [];
    const { reflexes } = reflexesOn(bot, true, undefined, (id, name) => {
      seen.push({ id, name });
      return true;
    });
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt(distant);
    await waitUntil(() => seen.length === 1, 3000);
    reflexes.stop();
    expect(seen).toEqual([{ id: 3, name: 'skeleton' }]);
  });

  /**
   * 有 source 时按 source 判断；animation/entity_status 无 source 时取 6 格内最近敌对生物，玩家不计入。
   */
  it('事件没有 source 时退回 6 格内最近敌对生物;玩家不算攻击者', async () => {
    const bot = hurtBot(18);
    const combatHurt = vi.fn(() => true);
    const { reflexes } = reflexesOn(bot, true, undefined, combatHurt);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt();
    await waitUntil(() => combatHurt.mock.calls.length === 1, 3000);
    reflexes.stop();
    expect(combatHurt).toHaveBeenCalledWith(2, 'zombie');
  });

  it('没有 source 且 6 格内只有玩家:仍按环境伤害走,不把人当攻击者', async () => {
    const bot = hurtBot(18);
    bot.entities['2'].position = new V(30, 64, 0.5);
    bot.entities['9'] = { id: 9, name: 'Phant', type: 'player', position: new V(1.5, 64, 0.5), isValid: true };
    const combatHurt = vi.fn(() => true);
    const { reflexes, reports } = reflexesOn(bot, true, undefined, combatHurt);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt();
    await sleep(100);
    reflexes.stop();
    expect(combatHurt).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });
});

/**
 * 长途 goto 在受理时报告空间代价，不拆分航点或阻止调用。
 */
describe('长途 goto 的空间代价', () => {
  it('直线超过 100 格:受理刻就报直线距离与步行时长', () => {
    const { exec } = makeExecutorOn(combatBot({}));
    // 1000 格 ÷ 原版步行 4.317 格/秒 ≈ 232 秒
    expect(exec.submit([{ skill: 'goto', at: [1000, 64, 0] }]))
      .toContain('这一步直线 1000 格,步行约 4 分钟');
    exec.clear();
  });

  it('100 格以内不说:短途没有这笔代价可报', () => {
    const { exec } = makeExecutorOn(combatBot({}));
    expect(exec.submit([{ skill: 'goto', at: [50, 64, 0] }])).not.toContain('步行约');
    exec.clear();
  });

  it('这一趟里有格子连续挖不动被绕开:受阻回执照实说是哪一格', async () => {
    const bot = combatBot({});
    const pf = fakePathfinder();
    pf.goto = async (g?: unknown) => { pf.setGoal(g); throw new Error('goal was changed'); };
    bot.pathfinder = pf as never;
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      digBackoffSince: () => [{ x: 12, y: 63, z: -4 }],
    });
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('(12, 63, -4) 连续挖不动,绕开了');
  });
});

/** 她维护着十几处路标并且自己在用航点分解走长途;写名字是那条习惯与工具面的缺口 */

describe('Reflexes 窒息', () => {
  /**
   * 被埋住的假 bot。`headStack` 是头顶那格从上往下的序列:挖掉一块,上面的沙
   * 立刻补进来 —— 这正是「挖一次就当出来了」会漏掉的形态。
   */
  function buriedBot(headStack: string[]) {
    const handlers: Array<(e: { id: number }) => void> = [];
    const dug: string[] = [];
    const controls: Array<[string, boolean]> = [];
    const pf = fakePathfinder();
    return {
      dug, controls, pf,
      entity: { id: 1, position: new V(0.5, 63, 0.5) },
      entities: {},
      health: 12,
      food: 20,
      oxygenLevel: 20,
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async () => {},
      attack: () => {},
      blockAt(p: V) {
        const name = p.y === 64 ? (headStack[0] ?? 'air') : 'stone';
        // transparent 按真实 minecraft-data:铁砧是非整方块(transparent: true)
        return { name, boundingBox: name === 'air' ? 'empty' : 'block', transparent: name === 'anvil' };
      },
      async dig(block: { name: string }) { dug.push(block.name); headStack.shift(); },
      setControlState(k: string, v: boolean) { controls.push([k, v]); },
      pathfinder: pf,
      on: (event: string, h: (x: { id: number }) => void) => {
        if (event === 'entityHurt') handlers.push(h);
      },
      removeListener: () => {},
      hooked: () => handlers.length > 0,
      hurt: () => handlers.forEach((h) => h({ id: 1 })),
    };
  }

  function buriedReflexes(bot: ReturnType<typeof buriedBot>, diag?: MinecraftLog) {
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
      antiLava: () => false,
      diag,
    });
    return { reflexes, reports, preempts, exec: environmentExec };
  }


  it('头顶是砾石且在掉血:撤掉寻路、按住跳、往上挖', async () => {
    const bot = buriedBot(['gravel', 'gravel', 'air']);
    const { reflexes, reports, preempts, exec } = buriedReflexes(bot);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.pf.setGoal('把人送进沙砾层的那条路');
    bot.hurt();
    await waitUntil(() => bot.dug.length === 1, 3000);
    expect(reflexes.envActive).toBe(true);
    expect(reflexes.environmentOwnerKind).toBe('suffocation');
    expect(exec.status().hold).toBe('被埋住,往上挖');
    expect(preempts).toEqual([]);
    expect(bot.pf.goal).toBeNull();
    expect(bot.controls).toContainEqual(['jump', true]);
    expect(reports[0].text).toContain('埋住');
    // 上面的沙补进来了:再挨一下伤害还得接着挖,不能挖一次就当出来了
    bot.hurt();
    await waitUntil(() => bot.dug.length === 2, 3000);
    expect(bot.dug).toEqual(['gravel', 'gravel']);
    // 头顶通了:松开跳键,不再报第二条
    bot.hurt();
    await waitUntil(() => bot.controls.some(([k, v]) => k === 'jump' && !v), 3000);
    expect(reflexes.envActive).toBe(false);
    reflexes.stop();
    expect(bot.dug).toHaveLength(2);
    expect(reports).toHaveLength(1);
  });

  it('沙砾挖开后不再掉血:下一拍主动清掉被埋状态并松开跳键', async () => {
    const bot = buriedBot(['gravel', 'air']);
    const { reflexes } = buriedReflexes(bot);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt();
    await waitUntil(() => bot.dug.length === 1, 3000);
    await waitUntil(() => bot.controls.some(([key, pressed]) => key === 'jump' && !pressed), 3000);

    expect(reflexes.environmentOwnerKind).toBeNull();
    expect(bot.controls.at(-1)).toEqual(['jump', false]);
    reflexes.stop();
  });

  it('铁砧砸头不算窒息:会掉但不是整方块,挖它脱不了困', async () => {
    const bot = buriedBot(['anvil']);
    const { reflexes, reports } = buriedReflexes(bot);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt();
    await sleep(200);
    reflexes.stop();
    expect(bot.dug).toEqual([]);
    expect(reports).toEqual([]);
  });


  it('头卡在圆石里且在掉血:实心窒息反射接管,挖头那格', async () => {
    const bot = buriedBot(['cobblestone', 'air']);
    const { reflexes, reports, preempts, exec } = buriedReflexes(bot);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt();
    await waitUntil(() => bot.dug.length === 1, 3000);
    expect(reflexes.environmentOwnerKind).toBe('suffocation');
    expect(exec.status().hold).toBe('头卡在实心方块里,挖开脱身');
    expect(preempts).toEqual([]);
    expect(bot.dug).toEqual(['cobblestone']);
    expect(reports[0].text).toContain('头卡在');
    // 挖开了:清状态、松跳键
    await waitUntil(() => reflexes.environmentOwnerKind === null, 3000);
    reflexes.stop();
  });

  it('头卡实心但没掉血:不起手(贴墙站着不算窒息)', async () => {
    const bot = buriedBot(['cobblestone']);
    const { reflexes, reports } = buriedReflexes(bot);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    await sleep(500);
    reflexes.stop();
    expect(bot.dug).toEqual([]);
    expect(reports).toEqual([]);
    expect(reflexes.environmentOwnerKind).toBeNull();
  });

  /** 格子地图假 bot:key `x,y,z`;dig 真把那格挖成空气(横向脱出要看得见世界变化) */
  function sandMapBot(cells: Map<string, string>) {
    const handlers: Array<(e: { id: number }) => void> = [];
    const dug: string[] = [];
    const controls: Array<[string, boolean]> = [];
    const pf = fakePathfinder();
    return {
      dug, controls, pf,
      entity: { id: 1, position: new V(0.5, 63, 0.5) },
      entities: {},
      health: 12,
      food: 20,
      oxygenLevel: 20,
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async () => {},
      attack: () => {},
      blockAt(p: V) {
        const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z);
        const name = cells.get(`${x},${y},${z}`) ?? 'stone';
        return {
          name,
          boundingBox: name === 'air' ? 'empty' : 'block',
          diggable: true,
          position: { x, y, z },
        };
      },
      async dig(block: { name: string; position: { x: number; y: number; z: number } }) {
        dug.push(block.name);
        cells.set(`${block.position.x},${block.position.y},${block.position.z}`, 'air');
      },
      setControlState(k: string, v: boolean) { controls.push([k, v]); },
      pathfinder: pf,
      on: (event: string, h: (x: { id: number }) => void) => {
        if (event === 'entityHurt') handlers.push(h);
      },
      removeListener: () => {},
      hooked: () => handlers.length > 0,
      hurt: () => handlers.forEach((h) => h({ id: 1 })),
    };
  }

  /**
   * 沙埋脱困优先寻找横向出口：先挖头层四邻中的非下落方块，再挖脚层并走出。
   */
  it('被沙埋住且有横向出口:挖穿侧面而不是往上挖', async () => {
    const cells = new Map<string, string>([
      ['0,64,0', 'sand'], // 头
      ['1,64,0', 'sand'], ['-1,64,0', 'sand'], ['0,64,-1', 'sand'], // 三面还是沙
      ['0,64,1', 'cobblestone'], // 唯一的非下落方块出口
      ['0,63,1', 'dirt'], // 出口的脚层
    ]);
    const bot = sandMapBot(cells);
    const { reflexes } = buriedReflexes(bot as never as ReturnType<typeof buriedBot>);
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt();
    // 先挖头层出口,再挖脚层那格 —— 全程不碰头顶的沙
    await waitUntil(() => bot.dug.length === 2, 3000);
    expect(bot.dug).toEqual(['cobblestone', 'dirt']);
    expect(bot.controls).toContainEqual(['forward', true]);
    expect(reflexes.environmentOwnerKind).toBe('suffocation');
    reflexes.stop();
  });

  /**
   * mc_stop 清空环境冻结后通知反射丢弃旧令牌，下一拍可申请新租约；forfeit 的 60 秒限制不变。
   */
  it('mc_stop 单边清空冻结:反射丢掉旧令牌,下一拍重申新租约', async () => {
    const bot = buriedBot(Array.from({ length: 12 }, () => 'gravel'));
    const { exec } = makeExecutorOn(bot);
    const pauses: string[] = [];
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      report: () => {},
      log,
      preempt: () => {},
      pauseEnvironment: (reason) => { pauses.push(reason); return exec.pauseForEnvironment(reason); },
      resumeEnvironment: (token) => exec.resumeAfterEnvironment(token),
      stopFallTask: () => null,
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => false,
    });
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt();
    await waitUntil(() => pauses.length === 1, 3000);
    expect(reflexes.envActive).toBe(true);
    expect(exec.status().hold).toBe(pauses[0]);
    exec.clear();
    expect(exec.status().hold).toBeNull();
    reflexes.invalidateEnvironmentHold();
    await waitUntil(() => pauses.length === 2, 3000);
    expect(pauses[1]).toContain('重申');
    expect(exec.status().hold).toBe(pauses[1]);
    expect(reflexes.envActive).toBe(true);
    reflexes.stop();
  });
});

describe('Reflexes 环境伤害', () => {
  /** 挨了打但周围一个敌对生物都没有:岩浆、摔落、窒息都是这个形态 */
  function envBot() {
    type HurtSource = {
      id: number; name: string; type: string; position: V; isValid: boolean;
    };
    const handlers: Array<(e: { id: number }, source?: HurtSource) => void> = [];
    const pf = fakePathfinder();
    return {
      pf,
      entity: { id: 1, position: new V(0.5, 64, 0.5), metadata: [0] },
      entities: {} as Record<string, HurtSource>,
      health: 16,
      food: 20,
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async () => {},
      attack: () => {},
      blockAt: () => null,
      setControlState: () => {},
      pathfinder: pf,
      on: (event: string, h: (x: { id: number }, source?: HurtSource) => void) => {
        if (event === 'entityHurt') handlers.push(h);
      },
      removeListener: () => {},
      hooked: () => handlers.length > 0,
      hurt: (source?: HurtSource) => handlers.forEach((h) => h({ id: 1 }, source)),
    };
  }

  it('环境伤害不占反击冷却:挨完摔落紧接着来的僵尸照样打得着', async () => {
    const bot = envBot();
    const reports: TaskReport[] = [];
    const { exec: environmentExec } = makeExecutorOn(bot);
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: (r) => reports.push(r),
      log,
      preempt: () => {},
      stopFallTask: () => null,
      resumeAfterFall: () => false,
      fightBack: () => true,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => false,
    });
    reflexes.start();
    await waitUntil(() => bot.hooked(), 3000);
    bot.hurt(); // 没有敌人:环境伤害,不该武装那 8 秒冷却
    await sleep(50);
    expect(reports).toEqual([]);
    // 实际来源在 5 格外,够不着挥刀,反击当场收手不占满 10 秒
    bot.entities['2'] = { id: 2, name: 'zombie', type: 'mob', position: new V(5, 64, 0.5), isValid: true };
    bot.hurt(bot.entities['2']);
    await waitUntil(() => reports.length === 1, 3000);
    reflexes.stop();
    expect(reports[0].text).toContain('反击');
  });
});



/**
 * 效果夹具保留门的 open、作物的 age 等方块属性；床与箱子的右键效果不能只按 stateId 是否变化判断。
 */
describe('use:(item × 目标方块) 效果表', () => {
  interface Cel { name: string; props?: Record<string, string> }
  type Bag = Array<{ name: string; count: number }>;

  const cellKey = (x: number, y: number, z: number): string => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  const EMPTY = new Set(['air', 'water', 'lava', 'fire', 'wheat', 'farmland']);

  function effectBot(opts: {
    cells?: Record<string, string | Cel>;
    bag?: Bag;
    hold?: string;
    entities?: Record<string, unknown>;
    known?: string[];
    entityDefs?: Record<string, { metadataKeys?: string[] }>;
    /** 牌子上现在写着什么:格 → [正面, 背面];updateSign 往这儿写 */
    signs?: Record<string, [string, string]>;
    /** 方块实体(告示牌的 is_waxed 就在这里,不在方块状态里) */
    blockEntities?: Record<string, Record<string, unknown>>;
    /** registry 里认得的食物;篝火那一条按它分流,默认一样都不认(与旧用例一致) */
    foods?: string[];
    /** 人在哪个维度;下界的水会蒸发、床会炸,这些事实按它分流 */
    dimension?: string;
    /** 服务端认了这一次右键之后世界成什么样;不给 = 什么都没发生 */
    onUse?: (bot: ReturnType<typeof effectBot>) => void;
  }) {
    const world = new Map<string, Cel>();
    for (const [k, v] of Object.entries(opts.cells ?? {})) world.set(k, typeof v === 'string' ? { name: v } : v);
    const bag: Bag = opts.bag ?? [];
    const activated: string[] = [];
    const signs = new Map<string, [string, string]>(Object.entries(opts.signs ?? {}));
    let heldItem: { name: string; count: number } | null = opts.hold ? { name: opts.hold, count: 1 } : null;
    const known: Record<string, { metadataKeys?: string[] }> = {};
    for (const n of opts.known ?? []) known[n] = {};
    Object.assign(known, opts.entityDefs ?? {});
    const bot = {
      world,
      bag,
      activated,
      itemActivated: 0,
      isSleeping: false,
      time: { timeOfDay: 6000 },
      get heldItem() { return heldItem; },
      entity: { id: 9, uuid: 'me-uuid', position: new V(0.5, 64, 0.5), onGround: true },
      entities: opts.entities ?? {},
      signs,
      vehicle: null as { name?: string } | null,
      dismount: () => { bot.vehicle = null; },
      updateSign: (b: { position: V }, text: string, back = false) => {
        const k = cellKey(b.position.x, b.position.y, b.position.z);
        const both = signs.get(k) ?? ['', ''];
        signs.set(k, back ? [both[0], text] : [text, both[1]]);
      },
      game: { dimension: opts.dimension ?? 'overworld' },
      health: 20,
      players: {},
      registry: {
        entitiesByName: known,
        blocksByName: {} as Record<string, unknown>,
        foodsByName: Object.fromEntries((opts.foods ?? []).map((n) => [n, {}])),
      },
      inventory: { items: () => bag },
      currentWindow: null,
      closeWindow: () => {},
      equip: async (item: { name: string; count: number }) => { heldItem = item; },
      // useSeq 记录看准、等 tick、使用的顺序；朝向包要到下一物理 tick 才发出，提前 use_item 会按旧朝向射线。
      useSeq: [] as string[],
      lookAt: async () => { bot.useSeq.push('look'); },
      waitForTicks: async (n: number) => { bot.useSeq.push(`tick${n}`); },
      setControlState: () => {},
      wake: async () => { bot.isSleeping = false; },
      // onUse 是「服务端认了这一次使用之后世界成什么样」,与走哪条包无关:
      // 舀水倒水走「使用物品」(activateItem),开门锄地走「对方块使用」(activateBlock)。
      // 两条路都通向同一个 onUse,所以走错包的用例照样绿 —— 分路只有 itemActivated
      // 与 activated 这两个计数看得出来,凡是挑包的行为都得显式断言它们。
      activateItem: async () => { bot.useSeq.push('use'); bot.itemActivated += 1; opts.onUse?.(bot); },
      deactivateItem: () => {},
      useOn: async () => { opts.onUse?.(bot); },
      activateBlock: async (b: { position: V }) => {
        activated.push(cellKey(b.position.x, b.position.y, b.position.z));
        opts.onUse?.(bot);
      },
      blockAt: (p: V) => {
        const k = cellKey(p.x, p.y, p.z);
        const c = world.get(k) ?? { name: 'air' };
        const props = c.props ?? {};
        return {
          name: c.name,
          position: new V(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
          boundingBox: EMPTY.has(c.name) ? 'empty' : 'block',
          stateId: [...c.name, ...JSON.stringify(props)].reduce((a, ch) => a + ch.charCodeAt(0), 0),
          getProperties: () => props,
          blockEntity: opts.blockEntities?.[k],
          getSignText: () => signs.get(k) ?? ['', ''],
        };
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  /** 脚下那层地,好让受阻现场的「下面一格」有东西可报 */
  const FLOOR: Record<string, string> = { '0,63,0': 'stone', '1,63,0': 'stone' };

  async function runUse(bot: unknown, call: SkillCall): Promise<TaskReport> {
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([call]);
    await waitUntil(() => reports.length === 1, 8000);
    return reports[0];
  }

  function piglinEntity(id: number, baby = false) {
    return {
      id, name: 'piglin', type: 'mob', position: new V(1.5, 64, 0.5),
      isValid: true, height: 1.95, metadata: [false, baby],
    };
  }

  function piglinGift(id: number, name: string, count: number) {
    return {
      id, name: 'item', type: 'object', position: new V(2.5, 64, 1.5), isValid: true,
      getDroppedItem: () => ({ name, count }),
    };
  }

  it('锄头 + 草方块:那一格变耕地', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'grass_block' },
      bag: [{ name: 'iron_hoe', count: 1 }],
      onUse: (b) => b.world.set('1,64,0', { name: 'farmland', props: { moisture: '0' } }),
    });
    const r = await runUse(bot, { skill: 'use', item: 'iron_hoe', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('那一格现在是耕地');
  });

  // 目标格上方非空气时原版不执行锄地，前置回执须点明遮挡方块。
  it('锄头 + 草方块:头顶压着方块,右键之前就受阻并点名盖子', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'grass_block', '1,65,0': 'stone' },
      bag: [{ name: 'iron_hoe', count: 1 }],
    });
    const r = await runUse(bot, { skill: 'use', item: 'iron_hoe', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('(1, 64, 0) 头上盖着石头,锄不动;先把它清掉');
  });

  // 没碰撞箱的照样拦:原版判的是 isAir,矮草/火把/雪都算盖子
  it('锄头 + 草方块:头顶那株矮草也拦,盖子名字照报', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'grass_block', '1,65,0': 'short_grass' },
      bag: [{ name: 'iron_hoe', count: 1 }],
    });
    const r = await runUse(bot, { skill: 'use', item: 'iron_hoe', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('头上盖着');
  });

  // 根泥翻成泥土在原版里不看头顶,这一条不能跟着拦
  it('锄头 + 根泥:头顶有东西也照锄', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'rooted_dirt', '1,65,0': 'stone' },
      bag: [{ name: 'iron_hoe', count: 1 }],
      onUse: (b) => b.world.set('1,64,0', { name: 'dirt', props: {} }),
    });
    const r = await runUse(bot, { skill: 'use', item: 'iron_hoe', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
  });

  // 「反复重锄」的成因是她自己踩坏耕地(跳一下 60%、落差 ≥2 格必坏),不是掉墒。
  // 只补一句事实,不拦
  it('锄头:同一格第二次锄成,回执说清它是被踩回泥土的', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'grass_block' },
      bag: [{ name: 'iron_hoe', count: 1 }],
      onUse: (b) => b.world.set('1,64,0', { name: 'farmland', props: { moisture: '0' } }),
    });
    const first = await runUse(bot, { skill: 'use', item: 'iron_hoe', at: [1, 64, 0] });
    expect(first.kind).toBe('done');
    expect(first.text).not.toContain('被踩回泥土');
    // 踩坏了:那一格退回泥土
    bot.world.set('1,64,0', { name: 'dirt', props: {} });
    const again = await runUse(bot, { skill: 'use', item: 'iron_hoe', at: [1, 64, 0] });
    expect(again.kind).toBe('done');
    expect(again.text).toContain('这格之前翻过,是被踩回泥土的');
  });

  // 那一格已经是她要的样子(原版里锄头对耕地什么都不做)。报「本来就是」而不是
  // 「没反应」,与 build「本来就是火把」同一条:读回执只知道"没做成"就会接着重来
  it('锄头 + 耕地:那一格本来就是耕地,算已达成', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': { name: 'farmland', props: { moisture: '7' } } },
      bag: [{ name: 'iron_hoe', count: 1 }],
    });
    const r = await runUse(bot, { skill: 'use', item: 'iron_hoe', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('那一格本来就是耕地');
  });

  it('种子 + 耕地:作物长在上面那一格,读的也是那一格', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'farmland' },
      bag: [{ name: 'wheat_seeds', count: 3 }],
      onUse: (b) => b.world.set('1,65,0', { name: 'wheat', props: { age: '0' } }),
    });
    const r = await runUse(bot, { skill: 'use', item: 'wheat_seeds', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('(1, 65, 0) 现在是小麦');
  });

  it('种子 + 耕地:没种上就是受阻', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'farmland' },
      bag: [{ name: 'wheat_seeds', count: 3 }],
    });
    const r = await runUse(bot, { skill: 'use', item: 'wheat_seeds', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('要看到的是:(1, 65, 0) 长出小麦');
  });

  it('空桶 + 水:走「使用物品」,读包里多没多出一个水桶', async () => {
    const bag: Bag = [{ name: 'bucket', count: 1 }];
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': { name: 'water', props: { level: '0' } } },
      bag,
      onUse: (b) => { b.bag.splice(0, 1); b.bag.push({ name: 'water_bucket', count: 1 }); },
    });
    const r = await runUse(bot, { skill: 'use', item: 'bucket', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('包里水桶 0 → 1 个');
    expect(bot.activated).toHaveLength(0);
    expect(bot.itemActivated).toBe(1);
    // lookAt(force) 只改本地朝向；等下一物理 tick 发出朝向包后，才能使用物品。
    expect(bot.useSeq).toEqual(['look', 'tick1', 'use']);
  });

  it('空桶 + 流动水:执行前受阻并回报 level/source,不发使用包', async () => {
    const bag: Bag = [{ name: 'bucket', count: 1 }];
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': { name: 'water', props: { level: '1' } } },
      bag,
    });
    const r = await runUse(bot, { skill: 'use', item: 'bucket', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('level=1, source=false');
    expect(r.text).toContain('只舀 level=0 的源方块');
    expect(bot.itemActivated).toBe(0);
    expect(bag).toEqual([{ name: 'bucket', count: 1 }]);
  });

  it('空桶 + 普通方块:没有明确桶操作就受阻,库存不变不算 done', async () => {
    const bag: Bag = [{ name: 'bucket', count: 1 }];
    const bot = effectBot({ cells: { ...FLOOR, '1,64,0': 'stone' }, bag });
    const r = await runUse(bot, { skill: 'use', item: 'bucket', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('没有空桶可执行的明确操作');
    expect(bot.activated).toHaveLength(0);
    expect(bot.itemActivated).toBe(0);
    expect(bag).toEqual([{ name: 'bucket', count: 1 }]);
  });

  /**
   * BucketItem 只有 use()，没有 useOn()；两个调用计数区分使用物品与对方块使用的协议路径。
   */
  it('满桶 + 空气:走「使用物品」倒出去变空桶,不被"右键空气"拦下', async () => {
    const bot = effectBot({
      cells: { ...FLOOR },
      bag: [{ name: 'water_bucket', count: 1 }],
      onUse: (b) => { b.bag.splice(0, 1); b.bag.push({ name: 'bucket', count: 1 }); b.world.set('1,64,0', { name: 'water' }); },
    });
    const r = await runUse(bot, { skill: 'use', item: 'water_bucket', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('包里空桶 0 → 1 个');
    expect(bot.activated).toHaveLength(0);
    expect(bot.itemActivated).toBe(1);
  });

  // 实心格与空气格全场一视同仁失败,只测空气盖不住
  it('满桶 + 实心方块:照样走「使用物品」,水浇在它上面那格', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'grass_block' },
      bag: [{ name: 'water_bucket', count: 1 }],
      onUse: (b) => { b.bag.splice(0, 1); b.bag.push({ name: 'bucket', count: 1 }); b.world.set('1,65,0', { name: 'water' }); },
    });
    const r = await runUse(bot, { skill: 'use', item: 'water_bucket', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('包里空桶 0 → 1 个');
    expect(bot.activated).toHaveLength(0);
    expect(bot.itemActivated).toBe(1);
  });

  // 成功路径带背包增减、失败路径不带,于是「包里少了什么」在受阻那一刻整句丢掉。
  // 这里桶用掉了却没换回空桶(服务端吃了这一下):她要看得见的正是这半句
  it('满桶倒水判负:受阻回执带上包里少掉的那一样', async () => {
    const bot = effectBot({
      cells: { ...FLOOR },
      bag: [{ name: 'water_bucket', count: 1 }],
      onUse: (b) => { b.bag.splice(0, 1); },
    });
    const r = await runUse(bot, { skill: 'use', item: 'water_bucket', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('包里空桶 0 → 0 个');
    expect(r.text).toContain('用掉:水桶×1');
  });

  it('种子没种上:「对方块使用」那条路的受阻回执同样带背包增减', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'farmland' },
      bag: [{ name: 'wheat_seeds', count: 3 }],
      onUse: (b) => { b.bag[0].count -= 1; },
    });
    const r = await runUse(bot, { skill: 'use', item: 'wheat_seeds', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('要看到的是:(1, 65, 0) 长出小麦');
    expect(r.text).toContain('用掉:小麦种子×1');
  });

  // A2 放宽的是满桶那一条,不许把整条「对方块使用」带偏:打火石仍走 activateBlock
  it('打火石 + 实心方块:仍走「对方块使用」,火出现在上面那一格', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'oak_planks' },
      bag: [{ name: 'flint_and_steel', count: 1 }],
      onUse: (b) => b.world.set('1,65,0', { name: 'fire' }),
    });
    const r = await runUse(bot, { skill: 'use', item: 'flint_and_steel', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('(1, 65, 0) 现在是火');
    expect(bot.activated).toEqual(['1,64,0']);
    expect(bot.itemActivated).toBe(0);
  });

  it('骨粉 + 作物:读原版的 age 有没有往上走', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': { name: 'wheat', props: { age: '2' } } },
      bag: [{ name: 'bone_meal', count: 4 }],
      onUse: (b) => b.world.set('1,64,0', { name: 'wheat', props: { age: '5' } }),
    });
    const r = await runUse(bot, { skill: 'use', item: 'bone_meal', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('age 2 → 5');
  });

  it('骨粉 + 作物:age 没动就是没催动', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': { name: 'wheat', props: { age: '7' } } },
      bag: [{ name: 'bone_meal', count: 4 }],
    });
    const r = await runUse(bot, { skill: 'use', item: 'bone_meal', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('age 7 → 7');
  });

  // 右键床不改变方块状态，睡眠效果须读取自身 isSleeping。
  it('床:读的是自身 isSleeping,不是那一格', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'red_bed' },
      // 服务端受理躺下,一夜之后自己醒(原版 101 tick);这一步要等到那时才收工
      onUse: (b) => {
        b.isSleeping = true;
        setTimeout(() => { b.isSleeping = false; }, 1_200);
      },
    });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('躺下了');
    expect(r.text).toContain('一直躺到醒');
  });

  it('床:没躺下就是受阻,现场报当下的 dayTime', async () => {
    const bot = effectBot({ cells: { ...FLOOR, '1,64,0': 'red_bed' } });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('没躺下(现在 dayTime 6000)');
    // 没接 set_spawn 的场子一个字不加:不无中生有
    expect(r.text).not.toContain('重生点');
  });

  /**
   * startSleepInBed 先设置重生点再判断白天拒睡；白天点床也可能改变重生点。
   */
  it('床:白天没躺下,但重生点已经记在这张床上了 —— 回执捎带这件事', async () => {
    const bot = effectBot({ cells: { ...FLOOR, '1,64,0': 'red_bed' } });
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      spawnNote: () => '但重生点已经记在这张床上了 (1, 64, 0)',
    });
    exec.submit([{ skill: 'use', at: [1, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没躺下(现在 dayTime 6000)');
    expect(reports[0].text).toContain('但重生点已经记在这张床上了 (1, 64, 0)');
  });

  /**
   * 床爆炸或水在下界蒸发可能是调用方需要的效果；回执陈述原版规则，不据此拦截。
   */
  it('床在非主世界:回执点明它会爆炸,不拦', async () => {
    const bot = effectBot({ cells: { ...FLOOR, '1,64,0': 'red_bed' }, dimension: 'the_nether' });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0] });
    expect(r.text).toContain('床在下界这个维度会爆炸,不会躺下');
    // 拦人的词一个都不许有
    for (const word of ['别点', '不要点', '先确认']) expect(r.text).not.toContain(word);
  });

  it('床在主世界不多这一句', async () => {
    const bot = effectBot({ cells: { ...FLOOR, '1,64,0': 'red_bed' } });
    expect((await runUse(bot, { skill: 'use', at: [1, 64, 0] })).text).not.toContain('会爆炸');
  });

  it('水桶在下界倒出去:回执如实说水会立刻蒸发', async () => {
    const bag: Bag = [{ name: 'water_bucket', count: 1 }];
    const bot = effectBot({
      cells: FLOOR,
      bag,
      dimension: 'the_nether',
      onUse: (b) => { b.bag.splice(0, 1); b.bag.push({ name: 'bucket', count: 1 }); },
    });
    const r = await runUse(bot, { skill: 'use', item: 'water_bucket', at: [1, 64, 0] });
    expect(r.text).toContain('水在下界会立刻蒸发');
    expect(bot.itemActivated).toBe(1);
  });

  /**
   * 玻璃瓶装水与空桶舀液、放船、满桶倒液是同一条病根:原版这几件只实现了 use(),
   * activateBlock 发的 use_item_on 服务端返回 PASS 就丢掉。这是同族第四例。
   */
  it('玻璃瓶 + 水源:走「使用物品」,读包里多没多出一个水瓶', async () => {
    const bag: Bag = [{ name: 'glass_bottle', count: 3 }];
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'water' },
      bag,
      onUse: (b) => { b.bag[0].count -= 1; b.bag.push({ name: 'potion', count: 1 }); },
    });
    const r = await runUse(bot, { skill: 'use', item: 'glass_bottle', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('包里水瓶 0 → 1 个');
    expect(bot.activated).toHaveLength(0);
    expect(bot.itemActivated).toBe(1);
    expect(bot.useSeq).toEqual(['look', 'tick1', 'use']);
  });

  /**
   * 末影之眼是纯观测增强:现有 use 只报「包里少了一个」,而她要的读数在飞行途中。
   * 报飞向哪边、飞多远、落地没落地;一个「往那边走」都不说。
   */
  it('末影之眼:报飞向、飞了多远、最后看见它在哪、落没落地', async () => {
    const bag: Bag = [{ name: 'ender_eye', count: 2 }];
    const entities: Record<string, unknown> = {};
    const bot = effectBot({
      cells: FLOOR,
      bag,
      onUse: () => {
        // 物品叫 ender_eye,飞的实体叫 eye_of_ender;先在身边生成,再飞远
        const eye = { id: 9, name: 'eye_of_ender', position: new V(0.5, 65.5, 0.5) };
        entities[9] = eye;
        setTimeout(() => { eye.position = new V(0.5, 70, -24.5); }, 150);
        // 飞完落地留下一个掉落物
        setTimeout(() => {
          delete entities[9];
          entities[10] = { id: 10, name: 'item', position: new V(0.5, 69, -24.5) };
        }, 400);
      },
      entities,
    });
    const r = await runUse(bot, { skill: 'use', item: 'ender_eye' });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('末影之眼朝北飞了 25 格,方位角 0°');
    expect(r.text).toContain('升了 6 格');
    expect(r.text).toContain('落地了,地上有掉落物');
    for (const word of ['往那边走', '建议', '要塞在']) expect(r.text).not.toContain(word);
  });

  it('末影之眼点框架是放进去,不是扔:回执报这一圈几个框放了眼', async () => {
    const bag: Bag = [{ name: 'ender_eye', count: 1 }];
    const frame = { name: 'end_portal_frame', props: { eye: 'false', facing: 'north' } };
    const bot = effectBot({
      cells: {
        ...FLOOR,
        '1,64,0': frame,
        '2,64,0': { name: 'end_portal_frame', props: { eye: 'true', facing: 'north' } },
      },
      bag,
      onUse: (b) => { frame.props.eye = 'true'; b.bag[0].count = 0; },
    });
    const r = await runUse(bot, { skill: 'use', item: 'ender_eye', at: [1, 64, 0] });
    expect(bot.itemActivated).toBe(0);
    expect(bot.activated).toEqual(['1,64,0']);
    expect(r.kind).toBe('done');
    expect(r.text).toContain('eye false → true');
    expect(r.text).toContain('框架 2 个,放了眼的 2 个');
  });

  it('走过去再右键:路上主手被换成垫脚块,到了先把点名的东西拿回手上', async () => {
    const bag: Bag = [{ name: 'ender_eye', count: 1 }];
    const frame = { name: 'end_portal_frame', props: { eye: 'false', facing: 'north' } };
    let heldAtUse: string | null = null;
    const bot = effectBot({
      cells: { ...FLOOR, '8,63,0': 'stone', '8,64,0': frame },
      bag,
      onUse: (b) => { heldAtUse = b.heldItem?.name ?? null; frame.props.eye = 'true'; b.bag[0].count = 0; },
    });
    // 寻路器路上搭桥会把主手换成垫脚块;走到框架旁边
    bot.pathfinder.goto = async () => {
      await bot.equip({ name: 'cobblestone', count: 1 });
      bot.entity.position = new V(6.5, 64, 0.5);
    };
    const r = await runUse(bot, { skill: 'use', item: 'ender_eye', at: [8, 64, 0] });
    expect(heldAtUse).toBe('ender_eye');
    expect(r.text).toContain('eye false → true');
  });

  it('末影之眼一路没看见:如实说没看见,不编方向', async () => {
    const bag: Bag = [{ name: 'ender_eye', count: 1 }];
    const bot = effectBot({ cells: FLOOR, bag, onUse: (b) => { b.bag[0].count = 0; } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', item: 'ender_eye' }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].text).toContain('一路没看见那颗末影之眼');
    expect(reports[0].text).not.toContain('朝');
  }, 20000);

  it('surface 在下界当场说清用不了,不耗 8 秒跳键', async () => {
    const bot = effectBot({ cells: FLOOR, dimension: 'the_nether' });
    const started = Date.now();
    const r = await runUse(bot, { skill: 'surface' });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('下界没有露天');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('空手 + 门:判的是 open 翻了没有,不管翻成哪一面', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': { name: 'oak_door', props: { open: 'false' } } },
      onUse: (b) => b.world.set('1,64,0', { name: 'oak_door', props: { open: 'true' } }),
    });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('open false → true');
  });

  // 铁门空手推不开,原版如此:翻牌判据要的就是把这一类判出来
  it('空手 + 铁门:open 一动不动就是受阻', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': { name: 'iron_door', props: { open: 'false' } } },
    });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('open false → false');
    expect(r.text).toContain('要看到的是:open 翻个面');
  });

  it('鞍 + 驴:读包里的鞍少没少;没驯服的驴上不了鞍,原版是空操作', async () => {
    const donkey = { name: 'donkey', type: 'animal', position: new V(1.5, 64, 0.5), isValid: true, height: 1 };
    const bot = effectBot({
      cells: { ...FLOOR },
      bag: [{ name: 'saddle', count: 1 }],
      entities: { '3': donkey },
      known: ['donkey'],
    });
    const r = await runUse(bot, { skill: 'use', item: 'saddle', target: 'donkey' });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('包里鞍 1 → 1 个');
    expect(r.text).toContain('要看到的是:鞍从包里装到它身上');
  });

  it('鞍 + 已驯服的驴:鞍从包里装到它身上就是做成', async () => {
    const donkey = { name: 'donkey', type: 'animal', position: new V(1.5, 64, 0.5), isValid: true, height: 1 };
    const bot = effectBot({
      cells: { ...FLOOR },
      bag: [{ name: 'saddle', count: 1 }],
      entities: { '3': donkey },
      known: ['donkey'],
      onUse: (b) => b.bag.splice(0, 1),
    });
    const r = await runUse(bot, { skill: 'use', item: 'saddle', target: 'donkey' });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('包里鞍 1 → 0 个');
  });

  it('金锭 + 成年猪灵:交出金锭后等待服务端延迟回礼,地上掉落物报名字、数量和未拾取', async () => {
    const entities: Record<string, unknown> = { '3': piglinEntity(3) };
    const bot = effectBot({
      cells: FLOOR,
      bag: [{ name: 'gold_ingot', count: 1 }],
      entities,
      entityDefs: { piglin: { metadataKeys: ['flags', 'baby'] } },
      onUse: (b) => {
        b.bag[0].count -= 1;
        setTimeout(() => { entities['4'] = piglinGift(4, 'ender_pearl', 3); }, 80);
      },
    });
    const r = await runUse(bot, { skill: 'use', item: 'gold_ingot', target: 'piglin' });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('成年猪灵收了金锭×1');
    expect(r.text).toContain('回礼落在地上:末影珍珠×3');
    expect(r.text).toContain('这一步没有替你捡');
    expect(bot.bag[0].count).toBe(0);
  });

  it('附近只有幼年猪灵:不交出金锭,明确说它不会以物易物', async () => {
    let uses = 0;
    const bot = effectBot({
      cells: FLOOR,
      bag: [{ name: 'gold_ingot', count: 1 }],
      entities: { '3': piglinEntity(3, true) },
      entityDefs: { piglin: { metadataKeys: ['flags', 'baby'] } },
      onUse: () => { uses += 1; },
    });
    const r = await runUse(bot, { skill: 'use', item: 'gold_ingot', target: 'piglin' });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('附近只有幼年猪灵');
    expect(r.text).toContain('金锭没有交出去');
    expect(bot.bag[0].count).toBe(1);
    expect(uses).toBe(0);
  });

  it('金锭 + 猪灵蛮兵:当场受阻且不调用实体交互', async () => {
    let uses = 0;
    const bot = effectBot({
      cells: FLOOR,
      bag: [{ name: 'gold_ingot', count: 1 }],
      entities: {
        '3': {
          id: 3, name: 'piglin_brute', type: 'mob', position: new V(1.5, 64, 0.5),
          isValid: true, height: 1.95,
        },
      },
      known: ['piglin_brute'],
      onUse: () => { uses += 1; },
    });
    const r = await runUse(bot, { skill: 'use', item: 'gold_ingot', target: 'piglin_brute' });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('猪灵蛮兵不接受以物易物');
    expect(r.text).toContain('金锭没有交出去');
    expect(bot.bag[0].count).toBe(1);
    expect(uses).toBe(0);
  });

  it('times 会逐次交金锭并分别等到回礼,总回执保留每一次交易结果', async () => {
    const entities: Record<string, unknown> = { '3': piglinEntity(3) };
    let uses = 0;
    const bot = effectBot({
      cells: FLOOR,
      bag: [{ name: 'gold_ingot', count: 2 }],
      entities,
      entityDefs: { piglin: { metadataKeys: ['flags', 'baby'] } },
      onUse: (b) => {
        b.bag[0].count -= 1;
        uses += 1;
        const current = uses;
        setTimeout(() => {
          entities[String(10 + current)] = current === 1
            ? piglinGift(10 + current, 'ender_pearl', 2)
            : piglinGift(10 + current, 'obsidian', 1);
        }, 50);
      },
    });
    const r = await runUse(bot, {
      skill: 'use', item: 'gold_ingot', target: 'piglin', times: 2,
    });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('交易了 2/2 次');
    expect(r.text).toContain('末影珍珠×2');
    expect(r.text).toContain('黑曜石×1');
    expect(uses).toBe(2);
    expect(bot.bag[0].count).toBe(0);
  });

  it('右键空气:直接受阻,现场报下面一格是什么', async () => {
    const bot = effectBot({ cells: { ...FLOOR } });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('(1, 64, 0) 那一格是空气');
    expect(r.text).toContain('下面一格 (1, 63, 0) 是石头');
    expect(bot.activated).toEqual([]);
  });

  it('空手右键水:直接受阻(空桶舀水走的是表里那一条)', async () => {
    const bot = effectBot({ cells: { ...FLOOR, '1,64,0': 'water' } });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('(1, 64, 0) 那一格是水');
  });

  /**
   * 表外那一对退回「报事实不下结论」:按钮按下去自己会弹回来,开箱子只为看一眼,
   * 这两类原版里本来就没有"成没成"。落表外的对记一条 debug,表靠它长。
   */
  it('表外的 (item, 方块) 对:退回报事实,并记一条 use-off-table', async () => {
    const diag = new MinecraftLog();
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'stone_button' },
      onUse: (b) => b.world.set('1,64,0', { name: 'stone_button', props: { powered: 'true' } }),
    });
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      diag,
    });
    exec.submit([{ skill: 'use', at: [1, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('空手右键了 (1, 64, 0) 的石按钮');
    const off = diag.after(0).filter((e) => e.event === 'use-off-table');
    expect(off).toHaveLength(1);
    expect(off[0].data).toEqual({ item: null, target: 'stone_button' });
  });

  it('锄头 + 石头:表里没这一对,不判成受阻', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'stone' },
      bag: [{ name: 'iron_hoe', count: 1 }],
    });
    const r = await runUse(bot, { skill: 'use', item: 'iron_hoe', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('右键了 (1, 64, 0) 的石头');
  });

  // 唱片机、篝火、贴面与告示牌写字

  it('唱片 + 唱片机:读的是方块自己的 has_record,不是"包里少了一张"', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': { name: 'jukebox', props: { has_record: 'false' } } },
      bag: [{ name: 'music_disc_13', count: 1 }],
      onUse: (b) => b.world.set('1,64,0', { name: 'jukebox', props: { has_record: 'true' } }),
    });
    const r = await runUse(bot, { skill: 'use', item: 'music_disc_13', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('has_record');
  });

  it('唱片 + 唱片机:里头已经有一张时放不进去,当场说清而不是报"放上了"', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': { name: 'jukebox', props: { has_record: 'false' } } },
      bag: [{ name: 'music_disc_13', count: 1 }],
    });
    const r = await runUse(bot, { skill: 'use', item: 'music_disc_13', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
  });

  // 原版:篝火四个位置满了/这东西不能烤,一律不消耗。所以"少没少"是精确信号
  it('生鱼 + 篝火:放上去 = 包里少一个', async () => {
    const bag: Bag = [{ name: 'cod', count: 3 }];
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'campfire' },
      bag,
      foods: ['cod'],
      onUse: () => { bag[0].count -= 1; },
    });
    const r = await runUse(bot, { skill: 'use', item: 'cod', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('包里生鳕鱼 3 → 2 个');
  });

  // 四个位置满了/这东西烤不了,原版一件都不收。判据只有"少没少"这一条
  it('生鱼 + 篝火:一个都没少 = 没放上去,不报成放上了', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'campfire' },
      bag: [{ name: 'cod', count: 3 }],
      foods: ['cod'],
    });
    const r = await runUse(bot, { skill: 'use', item: 'cod', at: [1, 64, 0] });
    expect(r.kind).toBe('blocked');
  });

  it('展示框贴北面:face 传到 activateBlock,判据是包里少一个', async () => {
    const bag: Bag = [{ name: 'item_frame', count: 2 }];
    const faces: Array<{ x: number; y: number; z: number } | undefined> = [];
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'stone' },
      bag,
      onUse: () => { bag[0].count -= 1; },
    });
    const orig = bot.activateBlock;
    bot.activateBlock = async (b: { position: V }, dir?: { x: number; y: number; z: number }) => {
      faces.push(dir);
      await orig(b);
    };
    const r = await runUse(bot, { skill: 'use', item: 'item_frame', at: [1, 64, 0], face: 'north' });
    expect(r.kind).toBe('done');
    expect(faces[0]).toMatchObject({ x: 0, y: 0, z: -1 });
  });

  it('不给 face 时照旧不传方向(缺省顶面的老行为不变)', async () => {
    const faces: unknown[] = [];
    const bot = effectBot({ cells: { ...FLOOR, '1,64,0': 'oak_door' } });
    const orig = bot.activateBlock;
    bot.activateBlock = async (b: { position: V }, dir?: unknown) => { faces.push(dir); await orig(b); };
    await runUse(bot, { skill: 'use', at: [1, 64, 0] });
    expect(faces[0]).toBeUndefined();
  });

  /**
   * 告示牌写字:原版分两步——先右键把编辑框打开(服务端由此记住谁在编辑),
   * 再把四行字发回去。验收读的是服务端回灌的牌子文本,不是"包发出去了"。
   */
  it('告示牌写字:先右键开编辑框再写,回执报读回来的那几个字', async () => {
    const bot = effectBot({ cells: { ...FLOOR, '1,64,0': 'oak_sign' } });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0], text: '欢迎\n可缇' });
    expect(r.kind).toBe('done');
    expect(bot.activated).toContain('1,64,0');
    expect(bot.signs.get('1,64,0')).toEqual(['欢迎\n可缇', '']);
    // 逐行列出并报行数:「共 N 行」是她一眼看出「要 4 行只写了 1 行」的唯一信号
    expect(r.text).toContain('2 行:①欢迎 ②可缇');
  });

  it('空手右键告示牌不带 text:回执明说打开了编辑框、没写字', async () => {

    const bot = effectBot({ cells: { ...FLOOR, '1,64,0': 'oak_sign' } });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0] });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('把编辑框打开了,没写字');
    expect(r.text).toContain('要写字就在同一条 use 里给 text');
  });

  it('告示牌写字:back 写背面,正面原样不动', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'oak_hanging_sign' },
      signs: { '1,64,0': ['正面原文', ''] },
    });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0], text: '背面', back: true });
    expect(r.kind).toBe('done');
    expect(bot.signs.get('1,64,0')).toEqual(['正面原文', '背面']);
    expect(r.text).toContain('背面');
  });

  it('写到不是告示牌的那一格:当场受阻并说清 text 只对告示牌有用', async () => {
    const bot = effectBot({ cells: { ...FLOOR, '1,64,0': 'stone' } });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0], text: '喂' });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('不是告示牌');
  });

  it('上过蜡的牌子:发包之前就拦下来(is_waxed 在方块实体里,不在方块状态里)', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'oak_sign' },
      blockEntities: { '1,64,0': { is_waxed: 1 } },
    });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0], text: '喂' });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('上过蜡');
    expect(bot.signs.has('1,64,0')).toBe(false);
  });

  it('手上拿着染料时右键牌子做的是改色:拦下来并给出空手的写法', async () => {
    const bot = effectBot({
      cells: { ...FLOOR, '1,64,0': 'oak_sign' },
      bag: [{ name: 'blue_dye', count: 1 }],
      hold: 'blue_dye',
    });
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0], text: '喂' });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('equip');
  });

  it('写进去与读回来对不上:算受阻,两份都报出来', async () => {
    const bot = effectBot({ cells: { ...FLOOR, '1,64,0': 'oak_sign' } });
    bot.updateSign = () => { /* 服务端把这个包丢了 */ };
    const r = await runUse(bot, { skill: 'use', at: [1, 64, 0], text: '写不上' });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('读回来是');
  });

  /**
   * 活物效果按相应状态验收：染羊读取颜色，驯服和喂食报告事实。
   */
  describe('活物侧的事实与验收', () => {
  const WOLF_KEYS = ['baby', 'flags', 'owneruuid'];
  const SHEEP_KEYS = ['baby', 'wool'];

  function beast(name: string, keys: string[], key: string, value: unknown) {
    const metadata: unknown[] = [];
    metadata[keys.indexOf(key)] = value;
    return { id: 3, name, type: 'mob', position: new V(1.5, 64, 0.5), isValid: true, height: 1, metadata };
  }

  it('染料 + 羊:读它现在身上是什么颜色', async () => {
    const sheep = beast('sheep', SHEEP_KEYS, 'wool', 0);
    const bot = effectBot({
      cells: { ...FLOOR },
      bag: [{ name: 'blue_dye', count: 1 }],
      entities: { 3: sheep },
      entityDefs: { sheep: { metadataKeys: SHEEP_KEYS } },
      onUse: () => { sheep.metadata[SHEEP_KEYS.indexOf('wool')] = 11; },
    });
    const r = await runUse(bot, { skill: 'use', item: 'blue_dye', target: 'sheep' });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('蓝色羊毛');
  });

  it('染料 + 羊:颜色没变就是没染上,受阻里报它现在的颜色', async () => {
    const bot = effectBot({
      cells: { ...FLOOR },
      bag: [{ name: 'blue_dye', count: 1 }],
      entities: { 3: beast('sheep', SHEEP_KEYS, 'wool', 0) },
      entityDefs: { sheep: { metadataKeys: SHEEP_KEYS } },
    });
    const r = await runUse(bot, { skill: 'use', item: 'blue_dye', target: 'sheep' });
    expect(r.kind).toBe('blocked');
    expect(r.text).toContain('白色羊毛');
  });

  // 骨头消耗与驯服成功不是同一判据；驯服具有随机性，回执同时报告当前主人状态。
  it('骨头 + 狼:没驯上不算失败,回执说清它还没有主人以及这事是随机的', async () => {
    const bot = effectBot({
      cells: { ...FLOOR },
      bag: [{ name: 'bone', count: 4 }],
      entities: { 3: beast('wolf', WOLF_KEYS, 'owneruuid', undefined) },
      entityDefs: { wolf: { metadataKeys: WOLF_KEYS } },
    });
    const r = await runUse(bot, { skill: 'use', item: 'bone', target: 'wolf' });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('还没有主人');
    expect(r.text).toContain('随机');
  });

  it('骨头 + 狼:驯上了就说它认你当主人了', async () => {
    const wolf = beast('wolf', WOLF_KEYS, 'owneruuid', undefined);
    const bot = effectBot({
      cells: { ...FLOOR },
      bag: [{ name: 'bone', count: 4 }],
      entities: { 3: wolf },
      entityDefs: { wolf: { metadataKeys: WOLF_KEYS } },
      onUse: () => { wolf.metadata[WOLF_KEYS.indexOf('owneruuid')] = 'me-uuid'; },
    });
    const r = await runUse(bot, { skill: 'use', item: 'bone', target: 'wolf' });
    expect(r.text).toContain('认你当主人');
  });

  // 原版喂不进去就不消耗 —— 这条规则本身要写进回执,她才判得了"要不要再喂一次"
  it('小麦 + 牛:附上"喂不进去就不消耗"这条规则', async () => {
    const bot = effectBot({
      cells: { ...FLOOR },
      bag: [{ name: 'wheat', count: 8 }],
      entities: { 3: beast('cow', ['baby'], 'baby', false) },
      entityDefs: { cow: { metadataKeys: ['baby'] } },
    });
    const r = await runUse(bot, { skill: 'use', item: 'wheat', target: 'cow' });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('不会消耗');
  });

  /**
   * 右键备好鞍的坐骑会骑上，保持乘坐并在回执指出 ride 的驾驭和下车操作。
   */
  it('右键坐骑:骑上就骑着,回执指出 ride 的驾驭与下车两条路', async () => {
    const bot = effectBot({
      cells: { ...FLOOR },
      entities: { 3: beast('horse', ['baby'], 'baby', false) },
      entityDefs: { horse: { metadataKeys: ['baby'] } },
      onUse: (b) => { b.vehicle = { name: 'horse' }; },
    });
    const r = await runUse(bot, { skill: 'use', target: 'horse' });
    expect(r.kind).toBe('done');
    expect(r.text).toContain('人已经骑在马身上了');
    expect(r.text).toContain('"skill":"ride","off":true');
    expect(bot.vehicle).not.toBe(null); // 不再替她下车
  });

  it('没骑上去时一个字都不多说', async () => {
    const bot = effectBot({
      cells: { ...FLOOR },
      entities: { 3: beast('cow', ['baby'], 'baby', false) },
      entityDefs: { cow: { metadataKeys: ['baby'] } },
    });
    const r = await runUse(bot, { skill: 'use', target: 'cow' });
    expect(r.text).not.toContain('坐骑');
  });
  });
});

describe('parseSteps:fish / 交易(并进 use)', () => {
  it('fish 可不带 at;带了要合法', () => {
    const bare = parseSteps([{ skill: 'fish' }]);
    if ('error' in bare) throw new Error(bare.error);
    expect(bare.steps[0]).toEqual({ skill: 'fish' });
    const at = parseSteps([{ skill: 'fish', at: [10, 62, -5] }]);
    if ('error' in at) throw new Error(at.error);
    expect(at.steps[0]).toEqual({ skill: 'fish', at: [10, 62, -5] });
    const bad = parseSteps([{ skill: 'fish', at: [10, 62] }]);
    expect(bad).toMatchObject({ error: expect.stringContaining('fish') });
  });

  // trade 已并进 use:target 写 villager/wandering_trader 就是看报价,再带 index 才成交
  it('交易走 use:target 看菜单,index/times 越界当场退回', () => {
    const menu = parseSteps([{ skill: 'use', target: 'villager' }]);
    if ('error' in menu) throw new Error(menu.error);
    expect(menu.steps[0]).toEqual({ skill: 'use', target: 'villager' });
    const deal = parseSteps([{ skill: 'use', target: 'wandering_trader', index: 2, times: 3 }]);
    if ('error' in deal) throw new Error(deal.error);
    expect(deal.steps[0]).toEqual({ skill: 'use', target: 'wandering_trader', index: 2, times: 3 });
    // index 是报价菜单序号,离了 target 没有意义
    expect(parseSteps([{ skill: 'use', item: 'potion', index: 1 }]))
      .toMatchObject({ error: expect.stringContaining('index') });
    expect(parseSteps([{ skill: 'use', target: 'villager', index: 0 }]))
      .toMatchObject({ error: expect.stringContaining('index') });
    expect(parseSteps([{ skill: 'use', target: 'villager', index: 1, times: 99 }]))
      .toMatchObject({ error: expect.stringContaining('times') });
  });
});

describe('use target=villager:菜单只看不买,带 index 成交并按差分报实收实付', () => {
  function tradeRig(opts: {
    trades: Array<Record<string, unknown>>;
    onTrade?: (index: number, times: number) => void;
    villagerAt?: V;
    /** 实体元数据(村民职业注从这里读);缺省不带 */
    metadata?: unknown[];
    /** 交易窗永远开不出来(无业村民、被打断):照 mineflayer 的样子超时才 reject */
    neverOpens?: boolean;
  }) {
    const inv: Array<{ name: string; count: number; type: number }> = [{ name: 'wheat', count: 50, type: 10 }];
    const villager = {
      id: 5, name: 'villager', type: 'mob',
      position: opts.villagerAt ?? new V(2.5, 64, 0.5), entityType: 77, height: 1.9,
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    };
    const calls: Array<[number, number]> = [];
    let closed = 0;
    let openSeenType: number | undefined;
    const win = {
      trades: opts.trades,
      trade: async (i: number, n: number) => { calls.push([i, n]); opts.onTrade?.(i, n); },
    };
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: { '5': villager },
      world: { raycast: () => null },
      inventory: { items: () => inv },
      registry: { entitiesByName: { villager: { id: 99 } }, blocksByName: {}, itemsByName: {} },
      _client: new EventEmitter(),
      // 照搬 mineflayer:等窗之前就把报价包监听器挂上,只在窗口 close 时摘。
      // 窗开不出来那条路上它留在原地,手里攥着一个必然 reject 的 promise
      openVillager: async (e: { entityType?: number }) => {
        openSeenType = e.entityType;
        const opening = opts.neverOpens
          ? new Promise<never>((_, rej) => {
            // 比 TRADE_OPEN_MS 晚:真链路里 mineflayer 等 20 秒,执行器 5 秒就先放弃了
            setTimeout(() => rej(new Error('Event windowOpen did not fire within timeout of 20000ms')), 6_000);
          })
          : Promise.resolve(win);
        bot._client.on('trade_list', async () => { await opening; });
        return await opening;
      },
      closeWindow: () => { closed++; },
      equip: async () => {},
      lookAt: async () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return {
      bot, inv, calls, closedOf: () => closed, seenType: () => openSeenType, villager,
      tradeListeners: () => bot._client.listenerCount('trade_list'),
    };
  }

  const T = (over: Record<string, unknown> = {}) => ({
    inputItem1: { name: 'wheat', count: 24 },
    inputItem2: null, hasItem2: false,
    outputItem: { name: 'emerald', count: 1 },
    realPrice: 24, tradeDisabled: false, nbTradeUses: 0, maximumNbTradeUses: 16,
    ...over,
  });

  it('交易窗开不出来:受阻回执之外,openVillager 挂的报价包监听器必须摘掉', async () => {
    const rig = tradeRig({ trades: [T()], neverOpens: true });
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'use', target: 'villager' }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('交易窗没开出来');
    expect(rig.tradeListeners()).toBe(0);
    // 监听器已摘:此后再来报价包也没人会去 await 那个已经 reject 的 promise
    rig.bot._client.emit('trade_list', {});
    await sleep(300);
  }, 20000);

  it('无 index:报价菜单原样报出,关窗不成交;借道的 entityType 用后还原', async () => {
    const rig = tradeRig({
      trades: [
        T(),
        T({ inputItem1: { name: 'emerald', count: 1 }, outputItem: { name: 'bread', count: 6 }, realPrice: 1, tradeDisabled: true }),
      ],
    });
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'use', target: 'villager' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('1号:24小麦→1绿宝石');
    expect(reports[0].text).toContain('2号:1绿宝石→6面包(锁死)');
    expect(reports[0].text).toContain('没成交');
    expect(rig.calls).toHaveLength(0);
    expect(rig.closedOf()).toBe(1);
    expect(rig.seenType()).toBe(99); // openVillager 只认 villager 的 entityType,开窗时借道
    expect(rig.villager.entityType).toBe(77); // 开完窗还原
  });

  it('带 index 成交:回执报实付实收(差分),窗口关了', async () => {
    const rig = tradeRig({
      trades: [T()],
      onTrade: (_i, times) => {
        rig.inv[0].count -= 24 * times;
        rig.inv.push({ name: 'emerald', count: times, type: 40 });
      },
    });
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'use', target: 'villager', index: 1, times: 2 }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('按 1 号成交 2 次');
    expect(reports[0].text).toContain('付出小麦×48');
    expect(reports[0].text).toContain('进账绿宝石×2');
    expect(rig.calls).toEqual([[0, 2]]);
    expect(rig.closedOf()).toBe(1);
  });

  it('报价锁死照实受阻,不硬点', async () => {
    const rig = tradeRig({ trades: [T({ tradeDisabled: true })] });
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'use', target: 'villager', index: 1, times: 1 }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('锁死');
    expect(rig.calls).toHaveLength(0);
    expect(rig.closedOf()).toBe(1);
  });

  it('32 格内没有可视村民:受阻', async () => {
    const rig = tradeRig({ trades: [T()], villagerAt: new V(40.5, 64, 0.5) });
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'use', target: 'villager' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没看见村民');
  });

  it('身份注进回执:右键的是哪一只、什么职业,菜单里点名', async () => {
    // 村民职业从实体元数据读取，回执点明职业。
    const meta: unknown[] = new Array(19).fill(null);
    meta[18] = { villagerType: 2, villagerProfession: 5, level: 1 };
    const rig = tradeRig({ trades: [T()], metadata: meta });
    const { exec, reports } = makeExecutorOn(rig.bot);
    exec.submit([{ skill: 'use', target: 'villager' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('村民(农民)的报价');
  });
});



/** 试算(dryRun / mc_scout)一格都不动:两道受理刻的闸都不该拦它 */
describe('受理刻两道闸都放行试算', () => {
  it('dryRun 的 excavate 罩住重生锚也照收:它不动世界', () => {
    const bot = combatBot({});
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      spawnAnchor: () => ({ x: 4, y: 64, z: 4 }),
    });
    expect(exec.submit([{
      skill: 'excavate', shape: 'box', anchors: [[2, 63, 2], [6, 66, 6]], fill: 'solid', dryRun: true,
    }])).not.toContain('我没接');
  });

  it('dryRun 的重力方块头顶 build 也照收', () => {
    const bot = combatBot({});
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
    });
    expect(exec.submit([{
      skill: 'build', material: 'sand', anchors: [['~', '~1', '~']], dryRun: true,
    }])).not.toContain('我没接');
  });
});


describe('受理回执:警告在前,受理句自称结果未知', () => {
  /** 包里空着的台架:第 1 步必然命中前置试算的「包里没有」 */
  function shortBot() {
    return {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      players: {},
      registry: {
        blocks: { 1: { name: 'stone' } },
        blocksByName: { stone: { id: 1, name: 'stone' } },
        items: {},
        itemsByName: {},
      },
      inventory: { items: () => [] as never[] },
      blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
  }

  it('试算警告排在受理句之前,并用 ⚠ 开头', () => {
    const { exec } = makeExecutorOn(shortBot());
    const r = exec.submit([{ skill: 'toss', item: 'diamond', count: 1 }]);
    expect(r).toMatch(/^\[\d{2}:\d{2}:\d{2}\] ⚠ /);
    // 警告排在受理成功句之前。
    expect(r.indexOf('包里没有')).toBeLessThan(r.indexOf('任务#1 收下了'));
    exec.shutdown();
  });

  // 「第 1/M 步 + 这一步在做什么」自己就是中间态:写着 1/3 的条子说得清后面还有两步,
  // 不必再靠「还没做完」这句否定去立(F 批:治「还没做完 ≠ 没进展」)
  it('开工那一句点名第几步在做什么,不说「已开始」,也不解释自己的名词', () => {
    const { exec } = makeExecutorOn(combatBot({}));
    const r = exec.submit([{ skill: 'chat', text: 'hi' }]);
    expect(r).toContain('任务#1 收下了,排在第 1/1 步:说: hi。');
    expect(r).not.toContain('已开始');
    // 拿系统自己的分类去教她读条子(「这是受理不是结果」)是检具腔,不要
    expect(r).not.toContain('受理');
    // 估时现成拿不到就不写:编一个数比不说更糟
    expect(r).not.toMatch(/约 \d+ 秒/);
    exec.shutdown();
  });

  it('排队那一档同样把状态说成人话', () => {
    const { exec } = makeExecutorOn(combatBot({ goto: async () => new Promise<void>(() => {}) }));
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    const r = exec.submit([{ skill: 'chat', text: 'x' }], 'append');
    expect(r).toContain('排进队尾,前面还有 1 件。');
    expect(r).not.toContain('受理');
    exec.shutdown();
  });
});

describe('教学句情境化:夜里/空手/无重生点改口', () => {
  /** 什么都找不到的站着扫台架;`night` 与包里有没有剑可调 */
  function hintBot(opts: { night?: boolean; sword?: boolean } = {}) {
    const items = opts.sword ? [{ name: 'stone_sword', count: 1, type: 3, metadata: 0 }] : [];
    return {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      players: {},
      time: { timeOfDay: opts.night ? 15000 : 1000 },
      registry: {
        blocks: { 17: { name: 'acacia_log' } },
        blocksByName: { acacia_log: { id: 17, name: 'acacia_log' } },
        items: {},
        itemsByName: {},
      },
      inventory: { items: () => items as never[] },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: () => [] as V[],
      blockAt: () => ({ name: 'air' }),
      canSeeBlock: () => true,
      world: { raycast: () => null },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
  }

  it('白天、手里有剑、有重生点:照旧那句教学', async () => {
    const bot = hintBot({ sword: true });
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never, report: (r) => reports.push(r), log, nextId: nextTaskId(),
      spawnAnchor: () => ({ x: 0, y: 64, z: 0 }),
    });
    exec.submit([{ skill: 'find', target: 'acacia_log', distance: 16 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('给个 direction 走一段再找,站着只看得到眼前这一圈');
    exec.shutdown();
  });

  it('夜里 + 空手 + 没重生点:改口成「这一趟要想清楚」,但不拦动作', async () => {
    const bot = hintBot({ night: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'acacia_log', distance: 16 }]);
    await waitUntil(() => reports.length === 1, 8000);
    const t = reports[0].text;
    expect(t).toContain('要走过去找就加 direction');
    expect(t).toContain('现在是夜里');
    expect(t).toContain('你空着手');
    expect(t).toContain('你现在没有重生点');
    expect(t).toContain('这一趟要想清楚');
    // 只改说法:这一步照旧是「做完了」,没有被判成受阻
    expect(reports[0].kind).toBe('done');
    exec.shutdown();
  });
});

/**
 * Paper 1.20.6 中玩家驾驭的载具使用客户端逐 tick vehicle_move。此处验证 ride 技能分派与回执，不复算协议运动。
 */
describe('ride:上/驾/下坐骑', () => {
  const PIG_KEYS = ['shared_flags', 'baby', 'saddle', 'boost_time'];

  function rideBot(opts: {
    entityName?: string;
    saddled?: boolean;
    bag?: Array<{ name: string; count: number; type: number }>;
    mountable?: boolean;
  } = {}) {
    const bag = opts.bag ?? [];
    const writes: Array<{ name: string; data: Record<string, unknown> }> = [];
    const name = opts.entityName ?? 'pig';
    const meta: unknown[] = [];
    meta[PIG_KEYS.indexOf('saddle')] = opts.saddled !== false;
    const entity = {
      id: 7, name, type: 'mob', isValid: true, height: 0.9,
      position: new V(2.5, 64, 0.5),
      metadata: name === 'pig' ? meta : [],
    };
    let heldItem: { name: string; count: number; type: number } | null = null;
    const bot = {
      writes,
      entity: { id: 9, position: new V(0.5, 64, 0.5), onGround: true },
      entities: { 7: entity } as Record<string, unknown>,
      vehicle: null as typeof entity | null,
      game: { dimension: 'overworld' },
      health: 20,
      players: {},
      registry: {
        entitiesByName: { pig: { metadataKeys: PIG_KEYS }, horse: { metadataKeys: [] }, boat: { metadataKeys: [] } },
        blocksByName: {},
        itemsByName: {},
      },
      get heldItem() { return heldItem; },
      inventory: { items: () => bag },
      equip: async (it: { name: string; count: number; type: number }) => { heldItem = it; },
      unequip: async () => { heldItem = null; },
      lookAt: async () => {},
      mount: () => { if (opts.mountable !== false) bot.vehicle = entity; },
      dismount: () => { bot.vehicle = null; },
      _client: {
        write: (n: string, data: Record<string, unknown>) => { writes.push({ name: n, data }); },
        on: () => {},
        removeListener: () => {},
      },
      blockAt: (p: V) => {
        const f = p.floored();
        return f.y < 64
          ? { name: 'stone', position: f, boundingBox: 'block', stateId: 0 }
          : { name: 'air', position: f, boundingBox: 'empty', stateId: 1 };
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  it('ride off 没骑着任何东西:无事可做,不是失败', async () => {
    const bot = rideBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'ride', off: true }]);
    await waitUntil(() => reports.length === 1, 5000);
    // SkillNoop 的终态是「没什么可做」的完成,不进失败堆
    expect(reports[0].text).toContain('没骑着任何东西');
    expect(reports[0].text).toContain('没什么可做');
  });

  it('ride target 只骑上不走:回执带坐骑位置与后续两条路', async () => {
    const bot = rideBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'ride', target: 'pig' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('骑上猪了');
    expect(reports[0].text).toContain('"skill":"ride","off":true');
    expect(bot.vehicle).not.toBe(null);
  });

  it('ride off 骑着时:下来并报人在哪', async () => {
    const bot = rideBot();
    bot.vehicle = bot.entities['7'] as never;
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'ride', off: true }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('从猪上下来了');
    expect(bot.vehicle).toBe(null);
  });

  it('骑猪驾驭:手持胡萝卜钓竿逐 tick 发 vehicle_move,到点回执报走了多远', async () => {
    const bot = rideBot({ bag: [{ name: 'carrot_on_a_stick', count: 1, type: 30 }] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'ride', target: 'pig', to: [8, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('骑着猪到了');
    expect(reports[0].text).toContain('人还骑着');
    const moves = bot.writes.filter((w) => w.name === 'vehicle_move');
    expect(moves.length).toBeGreaterThan(10);
    // 客户端权威:每一步都是绝对坐标,最后一步应落在到点半径内
    const last = moves[moves.length - 1].data as { x: number };
    expect(last.x).toBeGreaterThan(5.5);
  }, 20_000);

  it('骑猪驾驭但包里没有胡萝卜钓竿:受阻说清要拿什么', async () => {
    const bot = rideBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'ride', target: 'pig', to: [8, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('驾猪要手持胡萝卜钓竿');
  });

  it('马骑得上但驾不了:白名单外如实拒绝,不假装支持', async () => {
    const bot = rideBot({ entityName: 'horse' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'ride', target: 'horse', to: [8, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('驾着走这版还不支持');
    expect(reports[0].text).toContain('能驾的是猪');
  });
});



/**
 * 驾船保持服务端给出的浮高，不能将 Y 压到水格的整数高度。
 */
describe('ride boat:浮在水面的船 y 不压回水格', () => {
  it('船在 y=63.2 浮着、水格是 62:vehicle_move 的 y 钉在 63,不是 62', async () => {
    const writes: Array<{ name: string; data: Record<string, unknown> }> = [];
    const boat = { id: 7, name: 'boat', type: 'object', isValid: true, height: 0.56, position: new V(2.5, 63.2, 0.5), metadata: [] };
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5), onGround: true },
      entities: { 7: boat } as Record<string, unknown>,
      vehicle: boat as typeof boat | null,
      game: { dimension: 'overworld' },
      health: 20,
      players: {},
      registry: { entitiesByName: { boat: { metadataKeys: [] } }, blocksByName: {}, itemsByName: {} },
      heldItem: null,
      inventory: { items: () => [] },
      equip: async () => {},
      unequip: async () => {},
      lookAt: async () => {},
      mount: () => {},
      dismount: () => { bot.vehicle = null; },
      _client: {
        write: (n: string, data: Record<string, unknown>) => { writes.push({ name: n, data }); },
        on: () => {},
        removeListener: () => {},
      },
      blockAt: (p: V) => {
        const f = p.floored();
        if (f.y < 62) return { name: 'stone', position: f, boundingBox: 'block', stateId: 0 };
        if (f.y === 62) return { name: 'water', position: f, boundingBox: 'empty', stateId: 2 };
        return { name: 'air', position: f, boundingBox: 'empty', stateId: 1 };
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'ride', to: [8, 63, 0] }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].kind).toBe('done');
    const moves = writes.filter((w) => w.name === 'vehicle_move').map((w) => w.data as { x: number; y: number });
    expect(moves.length).toBeGreaterThan(5);
    expect(moves.every((m) => m.y === 63)).toBe(true);
    expect(moves[moves.length - 1].x).toBeGreaterThan(5.5);
  }, 20_000);
});
