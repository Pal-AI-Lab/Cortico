import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import {
  WALL_GAP, installMineflayerFixes, installPathfinderToolSelection, installWallGap,
} from '../../../src/worlds/minecraft/mineflayer-fixes.ts';
import { MinecraftLog } from '../../../src/worlds/minecraft/log.ts';
import type { Logger } from '../../../src/core/types.ts';

const log = { child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {} } as unknown as Logger;

type Stack = { type: number; count: number; metadata?: number | null; nbt?: unknown } | null;

/**
 * 一个够用的窗口 + 一个够真的服务端。
 *
 * 服务端这一半是关键:它按自己的账本处理点击,只有格子里摆的东西真的配上了配方
 * 才往产出槽里放东西。客户端伪造产出槽的那条路在这里必然露馅。
 */
function fakeWorld(opts: {
  gridWidth: number;
  bag: Array<[number, number]>;
  recipeOk?: boolean;
  /** 服务端认的摆法[格子, 物品];给了就只有一模一样才出货 */
  needs?: Array<[number, number]>;
  /**
 * 服务端整窗回灌补回来源格，客户端光标仍持有已取出的堆叠。
 */
  refillSource?: boolean;
  /**
 * 右键放料后，光标余量被替换为另一种材质。
 */
  remainderType?: number;
}) {
  const size = opts.gridWidth * opts.gridWidth;
  const inventoryStart = size + 1;
  const inventoryEnd = inventoryStart + 36;
  const slots: Stack[] = new Array(inventoryEnd).fill(null);
  opts.bag.forEach(([type, count], i) => { slots[inventoryStart + i] = { type, count }; });

  const window = {
    id: opts.gridWidth === 3 ? 1 : 0,
    type: opts.gridWidth === 3 ? 'minecraft:crafting' : 'minecraft:inventory',
    slots,
    selectedItem: null as Stack,
    inventoryStart,
    inventoryEnd,
    findInventoryItem(type: number) {
      for (let i = inventoryStart; i < inventoryEnd; i++) {
        if (slots[i]?.type === type) return { slot: i, ...slots[i]! };
      }
      return null;
    },
    findItemRange(start: number, end: number, type: number) {
      for (let i = start; i < end; i++) if (slots[i]?.type === type) return { slot: i, ...slots[i]! };
      return null;
    },
    firstEmptySlotRange(start: number, end: number) {
      for (let i = start; i < end; i++) if (!slots[i]) return i;
      return null;
    },
  };

  /** 每次点击的槽位、游标物品与点击前槽位内容。 */
  const clicks: Array<{
    slot: number; button: number; mode: number; cursor: number | null; at: number | null;
  }> = [];

  /** 服务端按格子里实际有什么决定产出槽 */
  const settleResult = (): void => {
    const grid = slots.slice(1, size + 1);
    const matches = opts.needs
      ? opts.needs.every(([slot, type]) => slots[slot]?.type === type)
        && grid.filter(Boolean).length === opts.needs.length
      : grid.some(Boolean);
    slots[0] = matches && opts.recipeOk !== false ? { type: 99, count: 1 } : null;
  };

  const clickWindow = async (slot: number, button: number, mode: number): Promise<void> => {
    const at = slots[slot];
    clicks.push({ slot, button, mode, cursor: window.selectedItem?.type ?? null, at: at?.type ?? null });
    if (slot === 0) {
      // 产出槽:有东西才拿得走,拿走之后格子清空
      if (at && !window.selectedItem) {
        window.selectedItem = at;
        slots[0] = null;
        for (let i = 1; i <= size; i++) slots[i] = null;
      }
      return;
    }
    if (button === 1 && window.selectedItem) { // 右键放一个
      if (!at) {
        slots[slot] = { type: window.selectedItem.type, count: 1 };
        window.selectedItem = window.selectedItem.count > 1
          ? { type: window.selectedItem.type, count: window.selectedItem.count - 1 }
          : null;
      }
      if (opts.remainderType !== undefined && window.selectedItem) {
        window.selectedItem = { type: opts.remainderType, count: window.selectedItem.count };
      }
    } else if (window.selectedItem) { // 左键落下
      if (!at) { slots[slot] = window.selectedItem; window.selectedItem = null; }
      else { const tmp = at; slots[slot] = window.selectedItem; window.selectedItem = tmp; }
    } else if (at) { // 左键拿起
      window.selectedItem = at;
      if (!opts.refillSource || slot <= size) slots[slot] = null;
    }
    if (slot <= size) settleResult();
  };

  return { window, slots, clicks, clickWindow };
}

function fakeBot(world: ReturnType<typeof fakeWorld>) {
  const bot = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
  const client = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
  client.write = (): void => {};
  bot._client = client;
  bot.registry = {
    items: { 1: { name: 'oak_planks' }, 2: { name: 'stick' }, 3: { name: 'oak_log' } },
  };
  bot.inventory = world.window;
  bot.currentWindow = null;
  bot.clickWindow = world.clickWindow;
  bot.closeWindow = (): void => {};
  // 右键工作台 → 服务端开窗
  bot.activateBlock = async (): Promise<void> => {
    bot.currentWindow = world.window;
    setImmediate(() => bot.emit('windowOpen', world.window));
  };
  bot.blockAt = (): null => null;
  return bot;
}

/** 木镐那种两种材料的有形状配方:上排三块木板,中下两根木棍 */
const PICKAXE = {
  result: { id: 99, count: 1 },
  inShape: [
    [{ id: 1 }, { id: 1 }, { id: 1 }],
    [{ id: -1 }, { id: 2 }, { id: -1 }],
    [{ id: -1 }, { id: 2 }, { id: -1 }],
  ],
  requiresTable: true,
};

/** 徒手 2x2 的木棍:上下两格各一块木板,落在格子 1 和 3 */
const STICK = {
  result: { id: 99, count: 4 },
  inShape: [[{ id: 1 }], [{ id: 1 }]],
  requiresTable: false,
};

/**
 * 修补必须在 mineflayer 的 `inject_allowed` 之后安装，并显式记录安装结果。
 * 提前安装会被内建 `craft.js` 覆盖。
 */
describe('安装时序与诊断', () => {
  function bareBot() {
    const bot = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    const client = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    client.write = (): void => {};
    bot._client = client;
    bot.inventory = { slots: [] };
    bot.blockAt = (): null => null;
    return bot;
  }

  function recordingLog() {
    const lines: Array<{ level: string; msg: string }> = [];
    const rec = {
      child() { return rec; },
      info(msg: string) { lines.push({ level: 'info', msg }); },
      warn(msg: string) { lines.push({ level: 'warn', msg }); },
      error(msg: string) { lines.push({ level: 'error', msg }); },
      debug() {},
    };
    return { rec: rec as unknown as Logger, lines };
  }

  it('内建插件尚未注入时记录安装错误', () => {
    const bot = bareBot(); // 内建 craft 与 placeBlock 尚未注入。
    const { rec, lines } = recordingLog();
    installMineflayerFixes(bot as never, rec);
    const err = lines.find((l) => l.level === 'error');
    expect(err?.msg).toContain('装得太早');
    expect(err?.msg).toContain('loadPlugin');
  });

  it('安装成功时记录确认日志', () => {
    const bot = bareBot();
    bot.craft = async (): Promise<void> => {};
    bot.placeBlock = async (): Promise<void> => {};
    const { rec, lines } = recordingLog();
    installMineflayerFixes(bot as never, rec);
    expect(lines.some((l) => l.level === 'error')).toBe(false);
    expect(lines.find((l) => l.level === 'info')?.msg).toContain('修补已装上');
  });

  it('缺少 World 日志时说明包流不记录', () => {
    const bot = bareBot();
    bot.craft = async (): Promise<void> => {};
    bot.placeBlock = async (): Promise<void> => {};
    const { rec, lines } = recordingLog();
    installMineflayerFixes(bot as never, rec);
    expect(lines.find((l) => l.level === 'info')?.msg).toContain('包流不留痕');
  });
});

describe('合成采用服务端确认的产物', () => {
  afterEach(() => vi.useRealTimers());

  it('材料按种类分趟摆,两种材料之间光标一定是空的', async () => {
    const world = fakeWorld({ gridWidth: 3, bag: [[1, 6], [2, 5]] });
    const bot = fakeBot(world);
    installMineflayerFixes(bot as never, log);
    (bot as Record<string, unknown>).currentWindow = world.window;

    await (bot as unknown as { craft(r: unknown, n: number, t: unknown): Promise<void> })
      .craft(PICKAXE, 1, {});

    const inBag = (c: { slot: number }): boolean => c.slot >= world.window.inventoryStart;
    // 禁止以物品 A 为光标左击物品 B 的格子;该交换容易使本地状态偏离服务端。
    const swap = world.clicks.find(
      (c) => inBag(c) && c.mode === 0 && c.button === 0
        && c.cursor !== null && c.at !== null && c.cursor !== c.at,
    );
    expect(swap).toBeUndefined();
    // 木棍是空着手拿起来的
    const pickUpStick = world.clicks.find((c) => inBag(c) && c.at === 2 && c.cursor === null);
    expect(pickUpStick).toBeDefined();
  });

  it('产出槽是服务端填的:客户端从不往 slot 0 写东西', async () => {
    const world = fakeWorld({ gridWidth: 3, bag: [[1, 6], [2, 5]] });
    const bot = fakeBot(world);
    installMineflayerFixes(bot as never, log);
    (bot as Record<string, unknown>).currentWindow = world.window;

    await (bot as unknown as { craft(r: unknown, n: number, t: unknown): Promise<void> })
      .craft(PICKAXE, 1, {});

    // 产物真的进了背包(服务端账本上的)
    const got = world.slots.slice(world.window.inventoryStart).filter((s) => s?.type === 99);
    expect(got).toHaveLength(1);
    // 产出槽只被"拿"过,没被"写"过
    expect(world.clicks.filter((c) => c.slot === 0)).toHaveLength(1);
  });

  it('服务端不给产物:当场说破并放弃,不伪造一个塞进包里', async () => {
    vi.useFakeTimers();
    const world = fakeWorld({ gridWidth: 3, bag: [[1, 6], [2, 5]], recipeOk: false });
    const bot = fakeBot(world);
    installMineflayerFixes(bot as never, log);
    (bot as Record<string, unknown>).currentWindow = world.window;

    let closed = false;
    (bot as Record<string, unknown>).closeWindow = (): void => { closed = true; };

    await Promise.all([
      expect(
        (bot as unknown as { craft(r: unknown, n: number, t: unknown): Promise<void> }).craft(PICKAXE, 1, {}),
      ).rejects.toThrow('没有给出产物'),
      vi.runAllTimersAsync(),
    ]);

    expect(world.slots.filter((s) => s?.type === 99)).toHaveLength(0);
    expect(closed).toBe(true);
  });

  /**
   * 点击一律落在 bot.currentWindow 上。上一件事留下的工作台窗口不关掉的话,
   * 这次徒手 2x2 的点击会全打到工作台的格子里去。
   */
  it('不要工作台的配方在自己的 2x2 里做:开工前先把上一件事的窗口关掉', async () => {
    const world = fakeWorld({ gridWidth: 2, bag: [[1, 4]] });
    const bot = fakeBot(world);
    installMineflayerFixes(bot as never, log);
    const stale = { id: 7 };
    (bot as Record<string, unknown>).currentWindow = stale;
    let closedId: number | null = null;
    (bot as Record<string, unknown>).closeWindow = (w: { id: number }): void => {
      closedId = w.id;
      (bot as Record<string, unknown>).currentWindow = null;
    };

    const planks = {
      result: { id: 99, count: 4 }, ingredients: [{ id: 1 }], requiresTable: false,
    };
    await (bot as unknown as { craft(r: unknown, n: number): Promise<void> }).craft(planks, 1);

    expect(closedId).toBe(7);
    expect(world.slots.filter((s) => s?.type === 99)).toHaveLength(1);
  });

  /**
   * 窗口 0 从不关闭,上一次留在 2x2 里的材料会一直在。往占着的格子右键放料,
   * prismarine-windows 本地换位而服务端不动,服务端格子里永远是旧材料,产出槽不出货。
   */
  it('合成格里剩着上次的材料:开工前腾空再摆,不往占着的格子里塞', async () => {
    const world = fakeWorld({ gridWidth: 2, bag: [[1, 8]], needs: [[1, 1], [3, 1]] });
    world.slots[1] = { type: 3, count: 4 }; // 上一次失败的合成剩下的原木
    const bot = fakeBot(world);
    installMineflayerFixes(bot as never, log);

    await (bot as unknown as { craft(r: unknown, n: number): Promise<void> }).craft(STICK, 1);

    const bagCount = (type: number): number => world.slots
      .slice(world.window.inventoryStart)
      .reduce((n, s) => n + (s?.type === type ? s.count : 0), 0);
    expect(bagCount(99)).toBe(1); // 服务端认了这次摆法
    expect(bagCount(3)).toBe(4); // 腾出来的原木回了背包,不是丢在格子里
  });

  /**
   * 光标持物点击产出槽可能只形成客户端预测交换，不能据此认作服务端产物已到账。
   */
  it('包满了放不回手上剩的材料:当场报错,绝不带着东西去点产出槽', async () => {
    const bag: Array<[number, number]> = [[1, 20]];
    for (let i = 1; i < 36; i++) bag.push([7, 1]); // 剩下的格子全占着
    const world = fakeWorld({ gridWidth: 2, bag, refillSource: true });
    const bot = fakeBot(world);
    installMineflayerFixes(bot as never, log);

    await expect(
      (bot as unknown as { craft(r: unknown, n: number): Promise<void> }).craft(STICK, 1),
    ).rejects.toThrow('手上还攥着');

    expect(world.clicks.filter((c) => c.slot === 0)).toHaveLength(0);
  });

  it('徒手合成失败:摆进 2x2 的材料自己拿回来,不留在格子里', async () => {
    vi.useFakeTimers();
    const world = fakeWorld({ gridWidth: 2, bag: [[1, 8]], recipeOk: false });
    const bot = fakeBot(world);
    installMineflayerFixes(bot as never, log);

    await Promise.all([
      expect(
        (bot as unknown as { craft(r: unknown, n: number): Promise<void> }).craft(STICK, 1),
      ).rejects.toThrow('没有给出产物'),
      vi.runAllTimersAsync(),
    ]);

    expect(world.slots.slice(1, 5).filter(Boolean)).toHaveLength(0);
    const planks = world.slots
      .slice(world.window.inventoryStart)
      .reduce((n, s) => n + (s?.type === 1 ? s.count : 0), 0);
    expect(planks).toBe(8);
  });

  /**
   * 服务端回灌与本地预测竞态可能改变光标材质；只有材质与原取出项相同才放回来源格，否则另找空格。
   */
  it('光标上的材质和来源格对不上:不放回来源格,另找空格', async () => {
    const world = fakeWorld({ gridWidth: 2, bag: [[1, 8]], remainderType: 3 });
    const iS = world.window.inventoryStart;
    world.slots[iS + 1] = world.slots[iS]; // 来源挪到第二格,第一格空着当"另找的空格"
    world.slots[iS] = null;
    const bot = fakeBot(world);
    installMineflayerFixes(bot as never, log);

    await expect(
      (bot as unknown as { craft(r: unknown, n: number): Promise<void> }).craft(STICK, 1),
    ).rejects.toThrow('包里没有可用的');

    // 换错的那摞进了空格;木板的来源格上没有它
    const at = (i: number): Stack => world.slots[i];
    expect(at(iS)?.type).toBe(3);
    expect(at(iS + 1)?.type ?? null).not.toBe(3);
  });

  it('材料不够:报缺料,不去点一个不存在的格子', async () => {
    const world = fakeWorld({ gridWidth: 3, bag: [[1, 6]] }); // 没有木棍
    const bot = fakeBot(world);
    installMineflayerFixes(bot as never, log);
    (bot as Record<string, unknown>).currentWindow = world.window;

    await expect(
      (bot as unknown as { craft(r: unknown, n: number, t: unknown): Promise<void> }).craft(PICKAXE, 1, {}),
    ).rejects.toThrow('包里没有可用的');
  });
});

describe('放方块:短超时 + 就地重发', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function placeBot(landsOnAttempt: number, pathBuilding = false) {
    const bot = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    const client = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    client.write = (): void => {};
    bot._client = client;
    bot.inventory = { slots: [] };
    bot.clickWindow = async (): Promise<void> => {};
    let attempts = 0;
    let placed = false;
    bot._genericPlace = async (): Promise<void> => {
      attempts++;
      if (attempts >= landsOnAttempt) placed = true;
    };
    bot.blockAt = (): { type: number; name: string } => (placed
      ? { type: 5, name: 'dirt' }
      : { type: 0, name: 'air' });
    const pathGoals: unknown[] = [];
    let building = pathBuilding;
    bot.pathfinder = {
      isBuilding: () => building,
      setGoal: (goal: unknown) => {
        pathGoals.push(goal);
        bot.emit('goal_updated', goal);
      },
    };
    bot.pathGoals = pathGoals;
    bot.setPathBuilding = (value: boolean): void => { building = value; };
    Object.defineProperty(bot, 'attempts', { get: () => attempts });
    return bot;
  }

  const ref = { position: { plus: () => ({ x: 1, y: 2, z: 3 }) } };

  it('第一次就回读到:不重发', async () => {
    const bot = placeBot(1);
    installMineflayerFixes(bot as never, log);
    await (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> }).placeBlock(ref, {});
    expect((bot as unknown as { attempts: number }).attempts).toBe(1);
  });

  it('前两次未确认时重试,并在 2 秒内完成', async () => {
    const bot = placeBot(3);
    installMineflayerFixes(bot as never, log);
    const t0 = Date.now();
    const placing = (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> }).placeBlock(ref, {});
    await vi.advanceTimersByTimeAsync(399);
    expect(bot.attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(399);
    expect(bot.attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await placing;
    expect((bot as unknown as { attempts: number }).attempts).toBe(3);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('重试耗尽后保持 mineflayer 错误文本', async () => {
    const bot = placeBot(99);
    installMineflayerFixes(bot as never, log);
    await Promise.all([
      expect(
        (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> }).placeBlock(ref, {}),
      ).rejects.toThrow('No block has been placed'),
      vi.runAllTimersAsync(),
    ]);
  });

  it('寻路垫脚未确认:撤掉当前路径,不让 pathfinder 重算后踏入依赖节点', async () => {
    const bot = placeBot(99, true);
    installMineflayerFixes(bot as never, log);

    await Promise.all([
      expect(
        (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> }).placeBlock(ref, {}),
      ).rejects.toThrow('No block has been placed'),
      vi.runAllTimersAsync(),
    ]);

    expect((bot as unknown as { pathGoals: unknown[] }).pathGoals).toEqual([null]);
    expect((bot as unknown as { pathSupportFailure: unknown }).pathSupportFailure).toEqual({
      seq: 1, generation: 0, was: 'air', x: 1, y: 2, z: 3,
    });
  });

  it('同代同格的七个重叠垫脚请求共享一次三遍确认', async () => {
    const bot = placeBot(99, true);
    installMineflayerFixes(bot as never, log);
    const place = () => (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> })
      .placeBlock(ref, {});

    const pending = Promise.allSettled(Array.from({ length: 7 }, place));
    await vi.runAllTimersAsync();
    const settled = await pending;

    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    expect((bot as unknown as { attempts: number }).attempts).toBe(3);
    expect((bot as unknown as { placeMisses: unknown[] }).placeMisses)
      .toEqual([{ was: 'air', x: 1, y: 2, z: 3, at: expect.any(Number) }]);
    expect((bot as unknown as { pathGoals: unknown[] }).pathGoals).toEqual([null]);
    expect((bot as unknown as { pathSupportFailure: { seq: number } }).pathSupportFailure.seq).toBe(1);
  });

  it('上游 reset 已退出 building 状态时,本代支撑失败仍撤路径', async () => {
    const bot = placeBot(99, true);
    installMineflayerFixes(bot as never, log);
    const pending = (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> })
      .placeBlock(ref, {});
    await vi.advanceTimersByTimeAsync(50);
    (bot as unknown as { setPathBuilding(value: boolean): void }).setPathBuilding(false);

    await Promise.all([
      expect(pending).rejects.toThrow('No block has been placed'),
      vi.runAllTimersAsync(),
    ]);
    expect((bot as unknown as { pathGoals: unknown[] }).pathGoals).toEqual([null]);
    expect((bot as unknown as { pathSupportFailure: { generation: number } }).pathSupportFailure.generation).toBe(0);
  });

  it('同代同格成功也只记一次放置副作用', async () => {
    const bot = placeBot(2, true);
    installMineflayerFixes(bot as never, log);
    const place = () => (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> })
      .placeBlock(ref, {});

    await Promise.all([
      Promise.all(Array.from({ length: 5 }, place)),
      vi.runAllTimersAsync(),
    ]);

    expect((bot as unknown as { attempts: number }).attempts).toBe(2);
    expect((bot as unknown as { placedLedger: unknown[] }).placedLedger).toEqual([
      { name: 'dirt', x: 1, y: 2, z: 3 },
    ]);
    expect((bot as unknown as { placeMisses?: unknown[] }).placeMisses ?? []).toEqual([]);
    expect((bot as unknown as { pathGoals: unknown[] }).pathGoals).toEqual([]);
  });

  /**
   * 全局单槽时代的深坠循环:A 在一格上放、B 在另一格上放,B 一启动就把"当前那一次"
   * 抢走,A 三次未确认时判自己不是当前那一次 —— 既不写 pathSupportFailure 也不撤目标,
   * 寻路器把它当普通 place_error 重算,再把人送回同一处悬空边缘。所有权改按 flight 记
   * 之后,A 只对自己那一格负责,B 放成放不成都碍不着它。
   */
  it('跨格并发:B 抢跑不影响 A,A 三次未确认照样写出支撑失败并撤掉目标', async () => {
    const bot = placeBot(99, true);
    let placedB = false;
    bot._genericPlace = async (referenceBlock: unknown): Promise<void> => {
      const at = (referenceBlock as { position: { plus(face: unknown): { x: number } } })
        .position.plus({});
      if (at.x === 2) placedB = true;
    };
    bot.blockAt = (at: { x: number }): { type: number; name: string } => (
      at.x === 2 && placedB ? { type: 5, name: 'dirt' } : { type: 0, name: 'air' }
    );
    installMineflayerFixes(bot as never, log);
    const place = (x: number) => (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> })
      .placeBlock({ position: { plus: () => ({ x, y: 2, z: 3 }) } }, {});

    const pending = Promise.allSettled([place(1), place(2)]);
    await vi.runAllTimersAsync();
    const [aResult, bResult] = await pending;

    expect(aResult.status).toBe('rejected');
    expect(bResult.status).toBe('fulfilled');
    expect((bot as unknown as { pathGoals: unknown[] }).pathGoals).toEqual([null]);
    expect((bot as unknown as { pathSupportFailure: unknown }).pathSupportFailure)
      .toMatchObject({ seq: 1, generation: 0, was: 'air', x: 1 });
  });

  it('同代 A→B→A 重叠:第二次 A 并入同一次放置,所有权本来就不会被 B 抢走', async () => {
    const bot = placeBot(99, true);
    let placedB = false;
    bot._genericPlace = async (referenceBlock: unknown): Promise<void> => {
      const at = (referenceBlock as { position: { plus(face: unknown): { x: number } } })
        .position.plus({});
      if (at.x === 2) placedB = true;
    };
    bot.blockAt = (at: { x: number }): { type: number; name: string } => (
      at.x === 2 && placedB ? { type: 5, name: 'dirt' } : { type: 0, name: 'air' }
    );
    installMineflayerFixes(bot as never, log);
    const place = (x: number) => (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> })
      .placeBlock({ position: { plus: () => ({ x, y: 2, z: 3 }) } }, {});

    const firstA = place(1);
    const b = place(2);
    const lastA = place(1);
    const pending = Promise.allSettled([firstA, b, lastA]);
    await vi.runAllTimersAsync();
    const [a1Result, bResult, a2Result] = await pending;

    expect(a1Result.status).toBe('rejected');
    expect(bResult.status).toBe('fulfilled');
    expect(a2Result.status).toBe('rejected');
    expect((bot as unknown as { pathGoals: unknown[] }).pathGoals).toEqual([null]);
    expect((bot as unknown as { pathSupportFailure: { x: number; generation: number } }).pathSupportFailure)
      .toMatchObject({ x: 1, generation: 0 });
  });

  it('旧放置失败晚到:不撤掉已经开始放置的新路径目标', async () => {
    const bot = placeBot(99, true);
    installMineflayerFixes(bot as never, log);
    const place = () => (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> })
      .placeBlock(ref, {}).then(() => null, (err: unknown) => err);

    const stale = place();
    await vi.advanceTimersByTimeAsync(50);
    (bot.pathfinder as { setGoal(goal: unknown): void }).setGoal('新路径');
    const current = place();

    // 旧请求的三次 400ms 确认期先到，新请求还剩 50ms。
    await vi.advanceTimersByTimeAsync(3 * 400 - 50);
    expect(await stale).toBeInstanceOf(Error);
    expect((bot as unknown as { pathGoals: unknown[] }).pathGoals).toEqual(['新路径']);
    expect((bot as unknown as { pathSupportFailure?: unknown }).pathSupportFailure).toBeUndefined();

    await vi.advanceTimersByTimeAsync(50);
    expect(await current).toBeInstanceOf(Error);
    expect((bot as unknown as { pathGoals: unknown[] }).pathGoals).toEqual(['新路径', null]);
    expect((bot as unknown as { pathSupportFailure: { generation: number } }).pathSupportFailure.generation).toBe(1);
  });

  /**
   * 放成了的那些进 `placedLedger`,放了三次不认的那些进 `placeMisses`:同一本台账的两半。
   * 服务端拒了放置客户端仍可能把物品扣掉 —— 包里少了东西而没人说得出为什么,就是这一条。
   */
  it('放了三次不认的那一格进 placeMisses,执行器据此在回执里解释包里少了什么', async () => {
    const bot = placeBot(99);
    installMineflayerFixes(bot as never, log);
    await Promise.all([
      (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> })
        .placeBlock(ref, {}).catch(() => undefined),
      vi.runAllTimersAsync(),
    ]);
    expect((bot as unknown as { placeMisses: unknown[] }).placeMisses)
      .toEqual([{ was: 'air', x: 1, y: 2, z: 3, at: expect.any(Number) }]);
    expect((bot as unknown as { placedLedger?: unknown[] }).placedLedger ?? []).toEqual([]);
  });

  /**
   * `referenceBlock.position.plus(faceVector)` 是函数体第一行:参照面/参照块不对时它
   * 当场抛。所有调用点(含 pathfinder 自己的 `.catch(_ignoreError => resetPath)`)都按
   * rejected promise 接,同步抛出一路漏到调用栈外面。
   */
  it('参照块算不出目标格:拿到的是 rejected promise,不是同步抛出', async () => {
    const bot = placeBot(1);
    installMineflayerFixes(bot as never, log);
    const placeBlock = (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> })
      .placeBlock;

    let thrownSync: unknown = null;
    let pending: Promise<void> | null = null;
    try {
      pending = placeBlock(undefined, {});
    } catch (err) {
      thrownSync = err;
    }

    expect(thrownSync).toBeNull();
    await expect(pending).rejects.toBeInstanceOf(TypeError);
  });

  /**
   * 直接技能放置也查询负缓存：同一格、方块仍为被拒时的状态且 TTL 未到时，不重复发包。
   */
  it('同一格刚三连拒过、方块没变:直接放置不再发包,负缓存也拦得住', async () => {
    const bot = placeBot(99);
    installMineflayerFixes(bot as never, log);
    const place = () => (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> })
      .placeBlock(ref, {}).catch((err: unknown) => err);

    const first = place();
    await vi.runAllTimersAsync();
    expect(await first).toBeInstanceOf(Error);
    expect((bot as unknown as { attempts: number }).attempts).toBe(3);

    const cached = place();
    await vi.runAllTimersAsync();
    expect(await cached).toBeInstanceOf(Error);
    expect((bot as unknown as { attempts: number }).attempts).toBe(3); // 一个包都没再发
    expect((bot as unknown as { placeMisses: unknown[] }).placeMisses).toHaveLength(1);
  });

  it('那一格的方块变过了就放行重试:黑名单挡的是「什么都没变的重试」', async () => {
    const bot = placeBot(99);
    installMineflayerFixes(bot as never, log);
    const place = () => (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> })
      .placeBlock(ref, {}).catch((err: unknown) => err);

    await Promise.all([place(), vi.runAllTimersAsync()]);
    expect((bot as unknown as { attempts: number }).attempts).toBe(3);
    // 世界变了:被拒时是 air,现在是水
    bot.blockAt = (): { type: number; name: string } => ({ type: 9, name: 'water' });

    await Promise.all([place(), vi.runAllTimersAsync()]);
    expect((bot as unknown as { attempts: number }).attempts).toBe(6);
  });

  /**
   * 目标格从 air 变成**任何东西**(水流进来、砂砾塌下来、别人放的)都判 place-confirmed:
   * 那句「放置在第 1 次回读到了 (x,y,z)」并不断言那一格是要放的那样。技能层的
   * `placeIntoCell` 早就用 `matchPlacedMaterialName` 校验身份,底层补丁没用。
   */
  describe('回读校验落地方块的身份', () => {
    function heldPlaceBot(becomes: string, held: string | null) {
      const bot = placeBot(1);
      let placed = false;
      bot._genericPlace = async (): Promise<void> => { placed = true; };
      bot.blockAt = (): { type: number; name: string } => (placed
        ? { type: 5, name: becomes }
        : { type: 0, name: 'air' });
      bot.heldItem = held === null ? null : { name: held };
      bot.registry = { blocksByName: { dirt: {}, wall_torch: {}, torch: {} }, itemsByName: {} };
      return bot;
    }

    it('变成的不是要放的那样:不认这次放置,照走未确认那一支', async () => {
      const bot = heldPlaceBot('water', 'dirt');
      installMineflayerFixes(bot as never, log);
      await Promise.all([
        expect(
          (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> }).placeBlock(ref, {}),
        ).rejects.toThrow('No block has been placed'),
        vi.runAllTimersAsync(),
      ]);
      expect((bot as unknown as { placedLedger?: unknown[] }).placedLedger ?? []).toEqual([]);
    });

    it('原版形态转换照旧认账:torch 落地成 wall_torch 是同一样东西', async () => {
      const bot = heldPlaceBot('wall_torch', 'torch');
      installMineflayerFixes(bot as never, log);
      await (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> }).placeBlock(ref, {});
      expect((bot as unknown as { placedLedger: unknown[] }).placedLedger)
        .toEqual([{ name: 'wall_torch', x: 1, y: 2, z: 3 }]);
    });

    it('答不出期望方块名(水桶、种子这类)时降级为旧口径,不把真放置判成失败', async () => {
      const bot = heldPlaceBot('water', 'water_bucket');
      installMineflayerFixes(bot as never, log);
      await (bot as unknown as { placeBlock(a: unknown, b: unknown): Promise<void> }).placeBlock(ref, {});
      expect((bot as unknown as { placedLedger: unknown[] }).placedLedger)
        .toEqual([{ name: 'water', x: 1, y: 2, z: 3 }]);
    });
  });
});

/**
 * 寻路器可能已置 digging=true，却仍在 await equip，targetDigBlock 尚为空；此时 stopDigging 空转不发中止事件，夹具覆盖闩锁清理。
 */
describe('digging 闩锁:stopDigging 空转那一下补一记中止', () => {
  function latchBot(opts: { mining: boolean; targetDigBlock?: unknown }) {
    const bot = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    const client = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    client.write = (): void => {};
    bot._client = client;
    bot.inventory = { slots: [] };
    bot.craft = async (): Promise<void> => {};
    bot.placeBlock = async (): Promise<void> => {};
    bot._updateBlockState = (): void => {};
    bot.dig = async (): Promise<void> => {};
    bot.digTime = (): number => 0;
    bot.blockAt = (): null => null;
    bot.targetDigBlock = opts.targetDigBlock ?? null;

    // 寻路器闭包里的那个 digging:只有它自己那个零参数监听清得掉
    let digging = opts.mining;
    bot.pathfinder = { isMining: () => digging };
    // 上游 resetPath 里挂的就是这一只(index.js:117-128),名字与零参数都照抄
    function detectDiggingStopped(): void { digging = false; }
    bot.on('diggingAborted', detectDiggingStopped);
    // bridge 的挖不动退避账听同一个事件,而它按 block.position 记账:
    // 补发一个没有方块的中止若走 bot.emit,这只会当场炸
    const backoff: unknown[] = [];
    bot.on('diggingAborted', (block: { position: unknown }) => { backoff.push(block.position); });

    let stopCalls = 0;
    // mineflayer 的真实现:targetDigBlock 为 null 时第一行就 return,事件一个不发
    bot.stopDigging = (): void => {
      stopCalls++;
      if (!bot.targetDigBlock) return;
      bot.targetDigBlock = null;
      bot.emit('diggingAborted', { position: { x: 0, y: 0, z: 0 } });
    };

    return {
      bot,
      backoff,
      get mining() { return digging; },
      get stopCalls() { return stopCalls; },
    };
  }

  const stop = (bot: unknown): void => (bot as { stopDigging(): void }).stopDigging();

  it('寻路器自认在挖、身上却没有挖掘目标:补一记中止把闩锁解开', () => {
    const diag = new MinecraftLog();
    const rig = latchBot({ mining: true });
    installMineflayerFixes(rig.bot as never, log, diag);

    expect(rig.mining).toBe(true);
    stop(rig.bot);

    expect(rig.stopCalls).toBe(1); // 真实现照常先跑,补发是它之后的事
    expect(rig.mining).toBe(false);
    // 只叫零参数那一只:要看方块的监听器(退避账)不能被喂一个没有方块的中止
    expect(rig.backoff).toEqual([]);
    expect(diag.after(0).filter((e) => e.event === 'dig-latch-released')).toHaveLength(1);
  });

  it('身上真有挖掘目标:事件归 mineflayer 自己发,不补第二记', () => {
    const rig = latchBot({ mining: true, targetDigBlock: { position: { x: 1, y: 2, z: 3 } } });
    installMineflayerFixes(rig.bot as never, log);

    stop(rig.bot);

    expect(rig.mining).toBe(false); // 真实现发的那一记就够了
    expect(rig.backoff).toEqual([{ x: 0, y: 0, z: 0 }]); // 有方块,退避账照常收
  });

  it('寻路器没在挖:什么都不补', () => {
    const diag = new MinecraftLog();
    const rig = latchBot({ mining: false });
    installMineflayerFixes(rig.bot as never, log, diag);

    stop(rig.bot);

    expect(rig.backoff).toEqual([]);
    expect(diag.after(0).filter((e) => e.event === 'dig-latch-released')).toHaveLength(0);
  });

  it('后来的 dig() 换掉 bot.stopDigging 之后,包装仍然在位', () => {
    const rig = latchBot({ mining: true });
    installMineflayerFixes(rig.bot as never, log);
    // digging.js 每开一次挖掘就把 bot.stopDigging 换成那一次的闭包
    let inner = 0;
    (rig.bot as Record<string, unknown>).stopDigging = (): void => { inner++; };

    stop(rig.bot);

    expect(inner).toBe(1);
    expect(rig.mining).toBe(false);
  });
});

describe('stateId:windowId=-2 的 set_slot 拦在门外', () => {
  function guardBot() {
    const bot = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    const client = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    client.write = (): void => {};
    bot._client = client;
    bot.inventory = { slots: [] };
    bot.clickWindow = async (): Promise<void> => {};
    bot.blockAt = (): null => null;
    bot._genericPlace = async (): Promise<void> => {};
    return { bot, client };
  }

  /**
   * windowId=-2 的 set_slot 没有对应容器内容，但会覆盖 mineflayer 的全局 stateId。
   * 拦截后当前容器的 stateId 必须保持不变。
   */
  it('-2 的包被吞掉,别的窗口照常透传', () => {
    const { bot, client } = guardBot();
    installMineflayerFixes(bot as never, log);
    const seen: number[] = [];
    client.on('set_slot', (pkt: { windowId: number }) => seen.push(pkt.windowId));

    client.emit('set_slot', { windowId: 0, stateId: 7, slot: 36 });
    client.emit('set_slot', { windowId: -2, stateId: 0, slot: 36 });
    client.emit('set_slot', { windowId: -1, stateId: 8, slot: -1 });
    client.emit('set_slot', { windowId: 1, stateId: 9, slot: 0 });

    expect(seen).toEqual([0, -1, 1]);
  });

  it('别的包一律不碰', () => {
    const { bot, client } = guardBot();
    installMineflayerFixes(bot as never, log);
    const seen: string[] = [];
    client.on('window_items', () => seen.push('window_items'));
    client.on('block_change', () => seen.push('block_change'));

    client.emit('window_items', { windowId: 0, stateId: 3, items: [] });
    client.emit('block_change', {});

    expect(seen).toEqual(['window_items', 'block_change']);
  });

  /**
   * 其他窗口的 set_slot/window_items 内容仍透传，但点击所用 stateId 须保持当前窗口流的值。
   */
  it('开着别的窗口时,窗口 0 的 set_slot 透传但 stateId 改回当前窗口的值', () => {
    const { bot, client } = guardBot();
    installMineflayerFixes(bot as never, log);
    (bot as Record<string, unknown>).currentWindow = { id: 3 };
    const seen: Array<[number, number]> = [];
    client.on('set_slot', (pkt: { windowId: number; stateId: number }) => seen.push([pkt.windowId, pkt.stateId]));

    client.emit('set_slot', { windowId: 3, stateId: 41, slot: 1 }); // 当前窗口:记账
    client.emit('set_slot', { windowId: 0, stateId: 900, slot: 45 });
    client.emit('set_slot', { windowId: 3, stateId: 42, slot: 2 });

    expect(seen).toEqual([[3, 41], [0, 41], [3, 42]]);
  });

  it('window_items 同规则;当前窗口的包照常记账不改写', () => {
    const { bot, client } = guardBot();
    installMineflayerFixes(bot as never, log);
    (bot as Record<string, unknown>).currentWindow = { id: 3 };
    const seen: Array<[number, number]> = [];
    client.on('window_items', (pkt: { windowId: number; stateId: number }) => seen.push([pkt.windowId, pkt.stateId]));

    client.emit('window_items', { windowId: 3, stateId: 50, items: [] });
    client.emit('window_items', { windowId: 0, stateId: 907, items: [] });
    client.emit('window_items', { windowId: 3, stateId: 51, items: [] });

    expect(seen).toEqual([[3, 50], [0, 50], [3, 51]]);
  });

  it('还没见过当前窗口的 stateId 之前不改写:没有更好的值可换', () => {
    const { bot, client } = guardBot();
    installMineflayerFixes(bot as never, log);
    (bot as Record<string, unknown>).currentWindow = { id: 3 };
    const seen: number[] = [];
    client.on('set_slot', (pkt: { stateId: number }) => seen.push(pkt.stateId));

    client.emit('set_slot', { windowId: 0, stateId: 900, slot: 45 });

    expect(seen).toEqual([900]);
  });
});

describe('包流留痕:只在合成/放置那几百毫秒里记', () => {
  it('平时不记,合成期间的点击与窗口回灌都进日志', async () => {
    const world = fakeWorld({ gridWidth: 3, bag: [[1, 6], [2, 5]] });
    const bot = fakeBot(world);
    const diag = new MinecraftLog();
    installMineflayerFixes(bot as never, log, diag);
    (bot as Record<string, unknown>).currentWindow = world.window;

    // 合成之外的包不留痕
    (bot._client as EventEmitter).emit('set_slot', { windowId: 0, stateId: 1, slot: 36 });
    expect(diag.after(0)).toHaveLength(0);

    // 合成期间发出去的点击有痕(点击包由 clickWindow 的桩发,这里直接走 write)
    const craft = (bot as unknown as { craft(r: unknown, n: number, t: unknown): Promise<void> })
      .craft(PICKAXE, 1, {});
    (bot._client as unknown as { write(n: string, p: Record<string, unknown>): void })
      .write('window_click', { windowId: 1, stateId: 4, slot: 1, mouseButton: 1, mode: 0, changedSlots: [] });
    (bot._client as EventEmitter).emit('window_items', { windowId: 1, stateId: 5, items: [] });
    await craft;

    const lanes = diag.after(0).map((e) => e.event);
    expect(lanes).toContain('click-out');
    expect(lanes).toContain('items-in');
    expect(lanes).toContain('result-slot');
    expect(lanes).toContain('confirmed');
  });
});

/**
 * 光照段是 2048 字节的 nibble 数组；按大端长整型读取会每 8 字节反转，镜像同一行的 X 坐标。
 */
describe('光照段按 nibble 原序落位', () => {
  /** 与 prismarine-chunk 的 BitArray(bitsPerValue=4).get 同款取法 */
  function nibbleOf(section: { data: Uint32Array }, index: number): number {
    const long = Math.floor(index / 16);
    const inLong = (index % 16) * 4;
    const word = inLong >= 32 ? section.data[long * 2 + 1] : section.data[long * 2];
    return (word >>> (inLong % 32)) & 0xF;
  }

  /** 段内第 index 格:第 index>>1 字节,偶数格在低半字节 */
  function putNibble(bytes: Uint8Array, index: number, value: number): void {
    const at = index >> 1;
    bytes[at] = (index & 1) ? ((bytes[at] & 0x0f) | (value << 4)) : ((bytes[at] & 0xf0) | value);
  }

  /** 装了两段光照的列:第 3 段全零(包里不带数据),第 9 段带数据 */
  function fakeLightWorld() {
    const make = (): { data: Uint32Array } => ({ data: new Uint32Array(512) });
    const column = {
      skyLightSections: Array.from({ length: 26 }, (_, i) => (i === 3 || i === 9 ? make() : null)),
      blockLightSections: Array.from({ length: 26 }, (_, i) => (i === 9 ? make() : null)),
    };
    return { column, getColumn: () => column };
  }

  /** (x=8, z=12, 段内 y=2) 那一格:与真机上脚下踩着火把的那格同一个下标 */
  const CELL = ((2 * 16) + 12) * 16 + 8;

  function lightPacket(): Record<string, unknown> {
    const sky = new Uint8Array(2048);
    const block = new Uint8Array(2048);
    putNibble(sky, CELL, 15);
    putNibble(block, CELL, 14);
    putNibble(block, CELL + 6, 8);
    return {
      x: -6, z: 4, chunkX: -6, chunkZ: 4,
      skyLight: [Array.from(sky)], blockLight: [Array.from(block)],
      skyLightMask: [[0, 1 << 9]], blockLightMask: [[0, 1 << 9]],
      emptySkyLightMask: [[0, 1 << 3]], emptyBlockLightMask: [[0, 0]],
    };
  }

  it('map_chunk 的光照按原序落位,读出来是那一格自己的亮度', () => {
    const world = fakeWorld({ gridWidth: 3, bag: [] });
    const bot = fakeBot(world);
    const light = fakeLightWorld();
    (bot as Record<string, unknown>).world = light;
    installMineflayerFixes(bot as never, log);

    const sky = light.column.skyLightSections[9]!;
    const block = light.column.blockLightSections[9]!;
    expect(nibbleOf(block, CELL)).toBe(0);

    (bot._client as EventEmitter).emit('map_chunk', lightPacket());

    expect(nibbleOf(block, CELL)).toBe(14);
    expect(nibbleOf(sky, CELL)).toBe(15);
    // 同一组 8 字节里的另一格也要各归各位,不能整组倒过来
    expect(nibbleOf(block, CELL + 6)).toBe(8);
    // 掩码里标了"全零"的那段包里不带数据,不该被后面那段的字节顶上
    expect(nibbleOf(light.column.skyLightSections[3]!, CELL)).toBe(0);
  });

  it('update_light 走同一条路', () => {
    const world = fakeWorld({ gridWidth: 3, bag: [] });
    const bot = fakeBot(world);
    const light = fakeLightWorld();
    (bot as Record<string, unknown>).world = light;
    const diag = new MinecraftLog();
    installMineflayerFixes(bot as never, log, diag);

    (bot._client as EventEmitter).emit('update_light', lightPacket());

    expect(nibbleOf(light.column.blockLightSections[9]!, CELL)).toBe(14);
    expect(diag.after(0).map((e) => e.event)).toContain('light-relay');
  });

  it('没有 bot.world 时只报警,不炸', () => {
    const world = fakeWorld({ gridWidth: 3, bag: [] });
    const bot = fakeBot(world);
    installMineflayerFixes(bot as never, log);
    expect(() => (bot._client as EventEmitter).emit('map_chunk', lightPacket())).not.toThrow();
  });

  // inject_allowed 时 bot.world 尚不存在，login 后才创建；修补须在事件到达时读取 world。
  it('安装时还没有 bot.world,login 后到包照样落位', () => {
    const world = fakeWorld({ gridWidth: 3, bag: [] });
    const bot = fakeBot(world);
    installMineflayerFixes(bot as never, log);

    const light = fakeLightWorld();
    (bot as Record<string, unknown>).world = light; // login 包之后 mineflayer 才建 world
    (bot._client as EventEmitter).emit('map_chunk', lightPacket());

    expect(nibbleOf(light.column.blockLightSections[9]!, CELL)).toBe(14);
    expect(nibbleOf(light.column.skyLightSections[9]!, CELL)).toBe(15);
  });
});

/**
 * 「同速不换手」在这里的表达是**原样回报手上那把**,不是 null:
 * null 会被规划侧读成徒手计价(语义冲突见 pathfinder-tool-contract.test.ts)。
 */
describe('寻路选工具不洗物品栏', () => {
  it('同速物品不换手，确实更快时优先选择快捷栏里的工具', () => {
    const torch = { name: 'torch', type: 1, count: 8, slot: 36 };
    const bone = { name: 'bone', type: 2, count: 2, slot: 10 };
    const bagPickaxe = { name: 'stone_pickaxe', type: 3, count: 1, slot: 11 };
    const hotbarPickaxe = { name: 'stone_pickaxe', type: 3, count: 1, slot: 37 };
    const bot = {
      heldItem: torch as typeof torch | null,
      entity: { effects: {} },
      registry: {},
      inventory: {
        hotbarStart: 36,
        items: () => [bone, bagPickaxe, hotbarPickaxe, torch],
      },
      pathfinder: { bestHarvestTool: (_block: unknown) => bone as typeof torch | null },
    };
    installPathfinderToolSelection(bot as never, log);

    // 全同速:手上那根火把原样回去,骨头/食物都不许被拿起来
    const handBlock = { digTime: () => 1_000 };
    expect(bot.pathfinder.bestHarvestTool(handBlock)).toBe(torch);

    const stone = { digTime: (type: number | null) => type === 3 ? 100 : 1_000 };
    expect(bot.pathfinder.bestHarvestTool(stone)).toBe(hotbarPickaxe);

    // 手上已是最优:不换手 = 回报它自己
    bot.heldItem = hotbarPickaxe;
    expect(bot.pathfinder.bestHarvestTool(stone)).toBe(hotbarPickaxe);

    // 手上那把在背包深处:同速时仍挪到快捷栏里的同款,省掉挖放交替的槽位交换
    bot.heldItem = bagPickaxe;
    expect(bot.pathfinder.bestHarvestTool(stone)).toBe(hotbarPickaxe);

    // 空手且没有更快的:null 在两侧都恰好等于「徒手」
    bot.heldItem = null;
    expect(bot.pathfinder.bestHarvestTool(handBlock)).toBeNull();
  });
});

/**
 * 1.20.6 的附魔组件是一份 `{enchantments,showTooltip}`,prismarine-item 1.18.0
 * 会把整份对象作为 `item.enchants` 返回；mineflayer 仍按数组拼头盔附魔。
 */
describe('挖掘计时:组件附魔规范成数组', () => {
  function componentItem(name: string, type: number, enchantments: Array<{ id: number; level: number }>) {
    const componentMap = new Map([['enchantments', {
      data: { enchantments, showTooltip: true },
    }]]);
    return {
      name, type, count: 1, componentMap,
      get enchants() { return componentMap.get('enchantments')!.data; },
    };
  }

  it('效率II钻石镐加水下速掘头盔:旧计时会在 concat 崩掉,修补后两件附魔都参与计时', () => {
    const bot = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    const client = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    client.write = (): void => {};
    bot._client = client;
    bot.craft = async (): Promise<void> => {};
    bot.placeBlock = async (): Promise<void> => {};
    bot.blockAt = (): null => null;
    bot.registry = {
      enchantments: { 20: { name: 'efficiency' }, 22: { name: 'aqua_affinity' } },
    };
    const pickaxe = componentItem('diamond_pickaxe', 13, [{ id: 20, level: 2 }]);
    const helmet = componentItem('diamond_helmet', 14, [{ id: 22, level: 1 }]);
    const slots: unknown[] = [];
    slots[5] = helmet;
    bot.inventory = { slots };
    bot.heldItem = pickaxe;
    bot.getEquipmentDestSlot = (): number => 5;
    bot.game = { gameMode: 'survival' };
    bot.entity = { onGround: true, effects: {} };
    bot._getBlockAtEyeLevel = (): { name: string } => ({ name: 'water' });

    let received: Array<{ name: string; lvl: number }> = [];
    const block = {
      digTime(
        _tool: number | null, _creative: boolean, _water: boolean, _airborne: boolean,
        enchantments: Array<{ name: string; lvl: number }>,
      ): number {
        received = enchantments;
        const efficiency = enchantments.find((e) => e.name === 'efficiency')?.lvl ?? 0;
        return 1_000 - efficiency * 100;
      },
    };

    // digging.js 4.37.1 的原路径:主手组件对象一到头盔拼接处就抛出本场的原错误。
    bot.digTime = (target: typeof block): number => {
      let enchantments = (bot.heldItem as typeof pickaxe).enchants;
      const head = (bot.inventory as { slots: unknown[] }).slots[5] as typeof helmet;
      enchantments = (enchantments as unknown as { concat(v: unknown): typeof enchantments })
        .concat(head.enchants);
      return target.digTime(13, false, true, false, enchantments as never);
    };
    expect(() => (bot.digTime as (b: typeof block) => number)(block)).toThrow('concat is not a function');

    installMineflayerFixes(bot as never, log);
    expect((bot.digTime as (b: typeof block) => number)(block)).toBe(800);
    expect(received).toEqual([
      { name: 'efficiency', lvl: 2 },
      { name: 'aqua_affinity', lvl: 1 },
    ]);
  });
});

/**
 * mineflayer 的挖掘到点就把本地那格写成空气并回报成功,服务端同不同意都一样。
 * 这一组盯的就是那一笔:它不许落到世界上,`bot.dig()` 也不许在服务端改掉之前返回。
 */
describe('挖掘:以服务端改掉那一格为准', () => {
  /** 一格石头,外加两条写入通道:本地那条会被补丁拦下,服务端那条(blocks.js 的内部闭包)不会 */
  function digBot(opts: { digMs: number }) {
    const bot = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    const client = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    client.write = (): void => {};
    bot._client = client;
    bot.inventory = { slots: [] };
    bot.craft = async (): Promise<void> => {};
    bot.placeBlock = async (): Promise<void> => {};

    const world = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    bot.world = world;
    // blocks.js 把世界的事件转发到 bot 上
    world.on('blockUpdate', (o: unknown, n: unknown) => bot.emit('blockUpdate', o, n));

    const pos = { x: 10, y: 64, z: 5, toString() { return `(${this.x}, ${this.y}, ${this.z})`; } };
    const names: Record<number, string> = { 0: 'air', 1: 'stone', 8: 'water' };
    let type = 1;
    const blockAt = (): { type: number; name: string; position: typeof pos } =>
      ({ type, name: names[type], position: pos });
    bot.blockAt = blockAt;

    /** 写本地世界并广播;真机上 digging.js 与 blocks.js 都落在这个函数上 */
    const write = (point: unknown, stateId: number): void => {
      const old = blockAt();
      type = stateId;
      const now = blockAt();
      world.emit('blockUpdate', old, now);
      world.emit(`blockUpdate:${point}`, old, now);
    };
    bot._updateBlockState = write;

    let digCalls = 0;
    bot.digTime = (): number => opts.digMs;
    // mineflayer 的挖掘:开挖时挂位置监听,本地定时器到点写空气,谁先来算谁
    bot.dig = async (block: { position: typeof pos }): Promise<void> => {
      digCalls++;
      const name = `blockUpdate:${block.position}`;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          world.off(name, onUpdate);
          clearTimeout(timer);
          resolve();
        };
        const onUpdate = (_o: unknown, nb: { type: number } | null): void => {
          if (nb?.type !== 0) return;
          finish();
        };
        world.on(name, onUpdate);
        const timer = setTimeout(() => {
          (bot._updateBlockState as (p: unknown, s: number) => void)(block.position, 0);
          finish();
        }, opts.digMs);
      });
    };

    return {
      bot,
      block: { position: pos },
      blockAt,
      /** 服务端那条通道:绕开 bot._updateBlockState,和真机一样 */
      serverSet: (stateId: number): void => write(pos, stateId),
      get digCalls() { return digCalls; },
    };
  }

  const digOf = (bot: unknown) =>
    (bot as { dig(b: unknown): Promise<void> }).dig.bind(bot as object);

  it('本地定时器到点不算数:服务端改掉那一格之前不返回,世界里也不许出现假空气', async () => {
    vi.useFakeTimers();
    try {
      const h = digBot({ digMs: 50 });
      installMineflayerFixes(h.bot as never, log);
      let settled = false;
      const p = digOf(h.bot)(h.block).then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false);
      expect(h.blockAt().name).toBe('stone'); // 那一笔假空气被按下了

      h.serverSet(0);
      await vi.advanceTimersByTimeAsync(40);
      await p;
      expect(settled).toBe(true);
      expect(h.blockAt().name).toBe('air');
    } finally {
      vi.useRealTimers();
    }
  });

  it('挖完变的是水也算数:判据是那格变了,不是必须变空气', async () => {
    vi.useFakeTimers();
    try {
      const h = digBot({ digMs: 50 });
      installMineflayerFixes(h.bot as never, log);
      const p = digOf(h.bot)(h.block);
      await vi.advanceTimersByTimeAsync(100);
      h.serverSet(8);
      await vi.advanceTimersByTimeAsync(40);
      await p;
      expect(h.blockAt().name).toBe('water'); // 假空气若落了地,这里会是 air
    } finally {
      vi.useRealTimers();
    }
  });

  it('服务端一直不认:报错收场,不自己重挖,世界照真的留着', async () => {
    vi.useFakeTimers();
    try {
      const h = digBot({ digMs: 50 });
      installMineflayerFixes(h.bot as never, log);
      const p = digOf(h.bot)(h.block).then(() => null, (e: Error) => e);
      await vi.advanceTimersByTimeAsync(9_000);
      const err = await p;
      expect(err?.message).toContain('服务端没认这一下');
      expect(err?.message).toContain('(10, 64, 5)');
      expect(h.digCalls).toBe(1); // 重挖会把服务端的破坏进度清零,一次都不许
      expect(h.blockAt().name).toBe('stone');
    } finally {
      vi.useRealTimers();
    }
  });

  it('服务端比本地定时器快:照常返回,不多等', async () => {
    vi.useFakeTimers();
    try {
      const h = digBot({ digMs: 5_000 });
      installMineflayerFixes(h.bot as never, log);
      let settled = false;
      const p = digOf(h.bot)(h.block).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(100);
      h.serverSet(0);
      await vi.advanceTimersByTimeAsync(40);
      await p;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * digTime 在起挖时采样 !onGround 的 ×5 惩罚；悬空时等落地再挖，水中 onGround 恒假则不等待。
   */
  it('悬空起挖:等落了地才开挖,digTime 采到地面值', async () => {
    vi.useFakeTimers();
    try {
      const h = digBot({ digMs: 50 });
      const entity = { onGround: false, isInWater: false };
      (h.bot as unknown as Record<string, unknown>).entity = entity;
      installMineflayerFixes(h.bot as never, log);
      const p = digOf(h.bot)(h.block).then(() => null, (e: Error) => e);
      await vi.advanceTimersByTimeAsync(100);
      expect(h.digCalls).toBe(0); // 还悬空:一刀没起
      entity.onGround = true;
      await vi.advanceTimersByTimeAsync(60);
      expect(h.digCalls).toBe(1);
      h.serverSet(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('水里起挖不等落地:onGround 恒假,双方都按水里的速度算', async () => {
    vi.useFakeTimers();
    try {
      const h = digBot({ digMs: 50 });
      (h.bot as unknown as Record<string, unknown>).entity = { onGround: false, isInWater: true };
      installMineflayerFixes(h.bot as never, log);
      const p = digOf(h.bot)(h.block).then(() => null, (e: Error) => e);
      await vi.advanceTimersByTimeAsync(30);
      expect(h.digCalls).toBe(1); // 没等
      h.serverSet(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('一直落不了地:等满上限照旧开挖,不无限扣着', async () => {
    vi.useFakeTimers();
    try {
      const h = digBot({ digMs: 50 });
      (h.bot as unknown as Record<string, unknown>).entity = { onGround: false, isInWater: false };
      installMineflayerFixes(h.bot as never, log);
      const p = digOf(h.bot)(h.block).then(() => null, (e: Error) => e);
      await vi.advanceTimersByTimeAsync(700);
      expect(h.digCalls).toBe(1);
      h.serverSet(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * minecraft-data 的 1.20.6 food 协议组件混入后续版本 usingConvertsTo 字段，会导致 trade_list 解码失败；安装时移除不属于该版本的字段。
 */
describe('协议表修正:food 组件摘除 usingConvertsTo', () => {
  function protoBot(foodFields: Array<{ name: string; type: unknown }>) {
    const bot = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    const client = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    client.write = (): void => {};
    bot._client = client;
    bot.inventory = { slots: [] };
    bot.blockAt = (): null => null;
    bot.craft = async (): Promise<void> => {};
    bot.placeBlock = async (): Promise<void> => {};
    const food = ['container', foodFields];
    bot.registry = {
      protocol: {
        types: {
          SlotComponent: ['container', [
            { name: 'type', type: 'SlotComponentType' },
            { name: 'data', type: ['switch', { compareTo: 'type', fields: { food } }] },
          ]],
        },
      },
    };
    return { bot, food };
  }
  const recording = () => {
    const lines: Array<{ level: string; msg: string }> = [];
    const rec = {
      child() { return rec; },
      info(msg: string) { lines.push({ level: 'info', msg }); },
      warn(msg: string) { lines.push({ level: 'warn', msg }); },
      error(msg: string) { lines.push({ level: 'error', msg }); },
      debug() {},
    };
    return { rec: rec as unknown as Logger, lines };
  };

  it('装上即摘除该字段并留痕;上游修好后(字段不在)静默歇手', () => {
    const { bot, food } = protoBot([
      { name: 'nutrition', type: 'varint' },
      { name: 'usingConvertsTo', type: 'Slot' },
      { name: 'effects', type: 'varint' },
    ]);
    const { rec, lines } = recording();
    installMineflayerFixes(bot as never, rec);
    expect((food[1] as Array<{ name: string }>).map((f) => f.name)).toEqual(['nutrition', 'effects']);
    expect(lines.some((l) => l.msg.includes('usingConvertsTo'))).toBe(true);

    // 再装一遍(字段已不在):不摘错别的字段,也不再留痕
    const { rec: rec2, lines: lines2 } = recording();
    installMineflayerFixes(bot as never, rec2);
    expect((food[1] as Array<{ name: string }>).map((f) => f.name)).toEqual(['nutrition', 'effects']);
    expect(lines2.some((l) => l.msg.includes('usingConvertsTo'))).toBe(false);
  });

  /**
   * potion_contents.customName 属于 1.21.2；1.20.6 解码表须移除此字段，避免 set_slot/window_items 等带组件数据的包解析失败。
   */
  it('potion_contents 组件同样摘除 customName;food 与 potion 各摘各的,互不误伤', () => {
    const { bot, food } = protoBot([
      { name: 'nutrition', type: 'varint' },
      { name: 'usingConvertsTo', type: 'Slot' },
    ]);
    const potion = ['container', [
      { name: 'potionId', type: ['option', 'varint'] },
      { name: 'customColor', type: ['option', 'i32'] },
      { name: 'customEffects', type: ['array', { countType: 'varint', type: 'ItemPotionEffect' }] },
      { name: 'customName', type: ['option', 'string'] },
    ]];
    const types = (bot.registry as { protocol: { types: { SlotComponent: [string, Array<{ type: unknown }>] } } }).protocol.types;
    const sw = types.SlotComponent[1][1].type as [string, { fields: Record<string, unknown> }];
    sw[1].fields.potion_contents = potion;
    const { rec, lines } = recording();
    installMineflayerFixes(bot as never, rec);
    expect((potion[1] as Array<{ name: string }>).map((f) => f.name)).toEqual(['potionId', 'customColor', 'customEffects']);
    expect((food[1] as Array<{ name: string }>).map((f) => f.name)).toEqual(['nutrition']);
    expect(lines.some((l) => l.msg.includes('potion_contents') && l.msg.includes('customName'))).toBe(true);

    // 幂等:再装一遍不再动、不再留痕
    const { rec: rec2, lines: lines2 } = recording();
    installMineflayerFixes(bot as never, rec2);
    expect((potion[1] as Array<{ name: string }>).map((f) => f.name)).toEqual(['potionId', 'customColor', 'customEffects']);
    expect(lines2.some((l) => l.msg.includes('potion_contents'))).toBe(false);
  });

  it('registry 没有协议表(测试假 bot)时不碰不炸', () => {
    const bot = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    const client = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    client.write = (): void => {};
    bot._client = client;
    bot.inventory = { slots: [] };
    bot.blockAt = (): null => null;
    bot.craft = async (): Promise<void> => {};
    bot.placeBlock = async (): Promise<void> => {};
    expect(() => installMineflayerFixes(bot as never, log)).not.toThrow();
  });
});

/**
 * minecraft-data 3.112 将 1.20.5+ 的 incorrect_for_*_tool 等级标签写成 material，速度表只含被排除的低级工具，其他工具会退回空手速度。
 * mineflayer 使用本地挖掘计时；夹具验证标签修正后的工具速度与原版硬度规则。
 */
describe('挖掘速度表修正:incorrect_for_*_tool 伪 material', () => {
  const ITEMS: Record<number, { name: string }> = {
    10: { name: 'wooden_pickaxe' }, 11: { name: 'stone_pickaxe' }, 12: { name: 'iron_pickaxe' },
    13: { name: 'diamond_pickaxe' }, 14: { name: 'netherite_pickaxe' }, 15: { name: 'golden_pickaxe' },
    20: { name: 'wooden_shovel' }, 21: { name: 'stone_shovel' },
  };
  /** 原样照抄 1.20.6 的形状:键是物品 id */
  const materials = (): Record<string, Record<number, number>> => ({
    'mineable/pickaxe': { 10: 2, 11: 4, 15: 12, 12: 6, 13: 8, 14: 9 },
    'mineable/shovel': { 20: 2, 21: 4 },
    incorrect_for_wooden_tool: { 20: 2, 10: 2 },
  });

  function matBot(blocks: Array<{ name: string; material: string; harvestTools?: Record<number, boolean> }>) {
    const bot = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    const client = new EventEmitter() as unknown as EventEmitter & Record<string, unknown>;
    client.write = (): void => {};
    bot._client = client;
    bot.inventory = { slots: [] };
    bot.blockAt = (): null => null;
    bot.craft = async (): Promise<void> => {};
    bot.placeBlock = async (): Promise<void> => {};
    bot.registry = { blocksArray: blocks, materials: materials(), items: ITEMS };
    return bot;
  }
  const recording = () => {
    const lines: Array<{ level: string; msg: string }> = [];
    const rec = {
      child() { return rec; },
      info(msg: string) { lines.push({ level: 'info', msg }); },
      warn(msg: string) { lines.push({ level: 'warn', msg }); },
      error(msg: string) { lines.push({ level: 'error', msg }); },
      debug() {},
    };
    return { rec: rec as unknown as Logger, lines };
  };

  /** 铁矿:名单是石镐及以上那四把;煤矿:material 本来就对 */
  const ironOre = () => ({
    name: 'iron_ore', material: 'incorrect_for_wooden_tool',
    harvestTools: { 11: true, 12: true, 13: true, 14: true },
  });
  const coalOre = () => ({
    name: 'coal_ore', material: 'mineable/pickaxe',
    harvestTools: { 10: true, 11: true, 15: true, 12: true, 13: true, 14: true },
  });

  it('铁矿一类换回 mineable/pickaxe,本来就对的不动,并留痕', () => {
    const blocks = [ironOre(), coalOre()];
    const { rec, lines } = recording();
    installMineflayerFixes(matBot(blocks) as never, rec);
    expect(blocks[0].material).toBe('mineable/pickaxe');
    expect(blocks[1].material).toBe('mineable/pickaxe');
    expect(lines.some((l) => l.msg.includes('挖掘速度表修正'))).toBe(true);
  });

  /**
   * 这条才是被打破的那个不变量:能挖掉它的每一把,都得在自己 material 的速度表里
   * 查得到速度。查不到 prismarine-block 就按空手算,于是白等。
   */
  it('修完之后:每个方块的 harvestTools 都能在自己的速度表里查到速度', () => {
    const blocks = [ironOre(), coalOre()];
    const bot = matBot(blocks);
    installMineflayerFixes(bot as never, log);
    const table = (bot.registry as { materials: Record<string, Record<number, number>> }).materials;
    for (const b of blocks) {
      for (const id of Object.keys(b.harvestTools ?? {})) {
        expect(table[b.material]?.[Number(id)]).toBeGreaterThan(1);
      }
    }
  });

  it('幂等:再装一遍不改动、也不再留痕(上游修好后自然歇手)', () => {
    const blocks = [ironOre()];
    const bot = matBot(blocks);
    installMineflayerFixes(bot as never, log);
    expect(blocks[0].material).toBe('mineable/pickaxe');
    const { rec, lines } = recording();
    installMineflayerFixes(bot as never, rec);
    expect(blocks[0].material).toBe('mineable/pickaxe');
    expect(lines.some((l) => l.msg.includes('挖掘速度表修正'))).toBe(false);
  });

  it('认不出类别就不猜:没有 harvestTools、名单混类别的原样留着', () => {
    const noList = { name: 'ancient_debris_like', material: 'incorrect_for_wooden_tool' };
    const mixed = {
      name: 'weird', material: 'incorrect_for_wooden_tool',
      harvestTools: { 11: true, 21: true },
    };
    const blocks = [noList, mixed];
    installMineflayerFixes(matBot(blocks) as never, log);
    expect(blocks[0].material).toBe('incorrect_for_wooden_tool');
    expect(blocks[1].material).toBe('incorrect_for_wooden_tool');
  });

});

/**
 * 真 prismarine-physics 在真 prismarine-world 上走:地面 y=63,北边 z≤0 与西边 x≤-3 各一堵
 * 两格高的墙。断言的是碰撞解算停下来的位置。
 */
describe('installWallGap:水平碰撞停在离方块面 WALL_GAP 处', () => {
  const req = createRequire(createRequire(import.meta.url).resolve('mineflayer/package.json'));
  const registry = req('prismarine-registry')('1.20.6');
  const World = req('prismarine-world')(registry);
  const Chunk = req('prismarine-chunk')(registry);
  const { Vec3 } = req('vec3');
  const { Physics, PlayerState } = req('prismarine-physics');
  const mcData = req('minecraft-data')('1.20.6');
  const STONE = registry.blocksByName.stone.defaultState as number;
  const HALF = 0.3;

  function makeWorld(ceiling: boolean) {
    const world = new World(null).sync;
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
    }
    for (let x = -8; x < 8; x++) {
      for (let z = -8; z < 8; z++) {
        world.setBlockStateId(new Vec3(x, 63, z), STONE);
        for (let y = 64; y <= 65; y++) {
          if (z <= 0 || x <= -3) world.setBlockStateId(new Vec3(x, y, z), STONE);
        }
        if (ceiling) world.setBlockStateId(new Vec3(x, 66, z), STONE);
      }
    }
    return world;
  }

  /** yaw 0 朝 -z,π/2 朝 -x(prismarine-physics 的 applyHeading 口径) */
  function stateAt(x: number, y: number, z: number, yaw: number, control: Record<string, boolean>) {
    const bot = {
      version: '1.20.6',
      entity: {
        position: new Vec3(x, y, z), velocity: new Vec3(0, 0, 0), onGround: false,
        isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
        elytraFlying: false, attributes: {}, yaw, pitch: 0, effects: {},
      },
      jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
      inventory: { slots: [] },
    };
    return new PlayerState(bot, {
      forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, ...control,
    });
  }

  function walk(world: unknown, state: { pos: { x: number; y: number; z: number }; onGround: boolean }, ticks: number) {
    const physics = Physics(mcData, world);
    for (let i = 0; i < ticks; i++) physics.simulatePlayer(state, world);
    return state;
  }

  it('朝墙走:两轴都停在离墙面 WALL_GAP 处', () => {
    installWallGap();
    const world = makeWorld(false);
    const north = walk(world, stateAt(0.5, 64, 3.5, 0, { forward: true }), 60);
    expect(north.pos.z - HALF - 1).toBeCloseTo(WALL_GAP, 9);
    expect(north.pos.y).toBe(64);
    const west = walk(world, stateAt(0.5, 64, 3.5, Math.PI / 2, { forward: true }), 60);
    expect(west.pos.x - HALF - (-2)).toBeCloseTo(WALL_GAP, 9);
  });

  it('已经贴着面(服务端传送来的位置)再往里走:一拍退到 WALL_GAP 处', () => {
    installWallGap();
    const world = makeWorld(false);
    const s = walk(world, stateAt(0.5, 64, 1 + HALF, 0, { forward: true }), 1);
    expect(s.pos.z - HALF - 1).toBeCloseTo(WALL_GAP, 9);
  });

  it('竖直方向不留缝:落地贴地、起跳顶天花板都停在整面上', () => {
    installWallGap();
    const world = makeWorld(true);
    const landed = walk(world, stateAt(0.5, 64.5, 3.5, 0, {}), 20);
    expect(landed.pos.y).toBe(64);
    expect(landed.onGround).toBe(true);
    const physics = Physics(mcData, world);
    const jumper = stateAt(0.5, 64, 3.5, 0, { jump: true });
    let top = 0;
    for (let i = 0; i < 20; i++) {
      physics.simulatePlayer(jumper, world);
      top = Math.max(top, jumper.pos.y);
    }
    expect(top).toBeCloseTo(66 - 1.8, 10);
  });

  it('装两遍只改一次:缝隙仍是一个 WALL_GAP', () => {
    installWallGap();
    installWallGap();
    const s = walk(makeWorld(false), stateAt(0.5, 64, 3.5, 0, { forward: true }), 60);
    expect(s.pos.z - HALF - 1).toBeCloseTo(WALL_GAP, 9);
  });
});
