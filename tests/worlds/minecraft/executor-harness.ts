/**
 * executor 各测试文件共用的假 bot、假寻路器和执行器工厂。
 */
import { vi } from 'vitest';
import {
  Executor, Reflexes, type SkillCall, type TaskReport,
} from '../../../src/worlds/minecraft/executor.ts';
import { ChestBook } from '../../../src/worlds/minecraft/chests.ts';
import { trackWindowProps } from '../../../src/worlds/minecraft/containers.ts';
import { EventEmitter } from 'node:events';
import { WorksBook } from '../../../src/worlds/minecraft/works.ts';
import type { Logger } from '../../../src/core/types.ts';

export const log = { child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {} } as unknown as Logger;

/** 每个执行器一条独立号段:测试之间不共享计数,断言里的 #1 才稳定 */
export function nextTaskId(): () => number {
  let seq = 0;
  return () => ++seq;
}

export async function sleep(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

export async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil 超时');
    await sleep(10);
  }
}

/**
 * 执行器编排测试使用仅实现 chat 与 goto 的 fake bot。
 * gate 控制 goto 的完成时点,用于构造慢任务。
 */
export function fakeBot(gate?: Promise<void>) {
  const said: string[] = [];
  return {
    said,
    entity: { position: { x: 0, y: 64, z: 0 } },
    chat(text: string) { said.push(text); },
    pathfinder: { stop() {}, setGoal() {}, goto: () => gate ?? Promise.resolve() },
  };
}

/** 一步走不完的技能:配合 fakeBot(gate) 当慢任务 */
export const SLOW: SkillCall = { skill: 'goto', at: [10, 64, 10] };

export function makeExecutor(gate?: Promise<void>) {
  const reports: TaskReport[] = [];
  const bot = fakeBot(gate);
  const exec = new Executor({
    getBot: () => bot as never,
    report: (r) => reports.push(r),
    log,
    nextId: nextTaskId(),
  });
  return { exec, reports, bot };
}

export class V {
  constructor(public x: number, public y: number, public z: number) {}
  offset(dx: number, dy: number, dz: number) { return new V(this.x + dx, this.y + dy, this.z + dz); }
  floored() { return new V(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
  distanceTo(o: V) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }
  minus(o: V) { return new V(this.x - o.x, this.y - o.y, this.z - o.z); }
  plus(o: V) { return new V(this.x + o.x, this.y + o.y, this.z + o.z); }
  clone() { return new V(this.x, this.y, this.z); }
  set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
  normalize() { const n = Math.hypot(this.x, this.y, this.z) || 1; return new V(this.x / n, this.y / n, this.z / n); }
  scaled(s: number) { return new V(this.x * s, this.y * s, this.z * s); }
}

/** 目标点缺的轴保持原样。 */
export interface FakeGoal { x?: number; y?: number; z?: number }

/** 判得出「到没到」的假目标:坡面测试要靠它复刻寻路器的空路径分支 */
export interface JudgingGoal extends FakeGoal {
  isEnd(node: { x: number; y: number; z: number }): boolean;
}

/**
 * 按地形高度落地的假 `goto`。
 *
 * 别的测试用的假 goto 是「瞬移到 goal.x/y/z」,任何目标都到得了 —— 坡面上的目标
 * 判据缺陷在它下面恒绿。这一份按 XZ 查地形高度得到真正的落点,再拿目标自己的
 * `isEnd` 判:判不成立就**位置不变、无错 resolve**,精确复刻寻路器给空路径时的
 * 行为(`goto` 不 reject,收尾的 isEnd 校验才把它变成一条零位移的「走不过去」)。
 */
export function terrainGoto(
  bot: { entity: { position: V } },
  heightAt: (x: number, z: number) => number,
): (goal: JudgingGoal) => Promise<void> {
  return async (goal: JudgingGoal) => {
    const here = bot.entity.position;
    const x = goal.x ?? Math.floor(here.x);
    const z = goal.z ?? Math.floor(here.z);
    const y = heightAt(x, z);
    if (!goal.isEnd({ x, y, z })) return;
    bot.entity.position = new V(x, y, z);
  };
}

/**
 * 战逃测试用的假 bot:实体、位置向量、可控的 pathfinder.goto。
 *
 * goto 默认真把位置挪到目标:寻路库算不出路时是 resolve 不是 reject,执行器靠
 * `goal.isEnd(位置)` 自行核验是否到达,原地不动的假 goto 会被这道校验判成走不过去。
 */
export function combatBot(opts: {
  health?: number;
  entities?: Record<string, { name: string; type: string; position: V; isValid: boolean; height?: number }>;
  goto?: (arrive: () => void) => Promise<void>;
  headBlock?: string;
}) {
  let head = opts.headBlock ?? 'air';
  const said: string[] = [];
  // 上浮与近战都使用控制键；夹具记录按键状态以检查 surface 收尾释放跳键。
  const controls: Array<[string, boolean]> = [];
  const bot = {
    said,
    controls,
    chat(text: string) { said.push(text); },
    entity: { id: 9, position: new V(0.5, 64, 0.5) },
    entities: opts.entities ?? {},
    health: opts.health ?? 20,
    players: {},
    registry: { entitiesByName: { skeleton: {}, zombie: {}, pig: {} } },
    inventory: { items: () => [] as never[] },
    equip: async () => {},
    lookAt: async () => {},
    attack: () => {},
    // surface 的上浮:一按跳就当浮出了水面
    setControlState: (k: string, v: boolean) => { controls.push([k, v]); if (v) head = 'air'; },
    clearControlStates: () => { controls.push(['clear', false]); },
    blockAt: (p: V) => (p.x === 0.5 && p.y === 65 && p.z === 0.5 ? { name: head } : null),
    pathfinder: { stop() {}, setGoal() {}, goto: async (_goal: FakeGoal) => {} },
  };
  const arrive = (goal: FakeGoal): void => {
    const at = bot.entity.position;
    bot.entity.position = new V(goal.x ?? at.x, goal.y ?? at.y, goal.z ?? at.z);
  };
  bot.pathfinder.goto = opts.goto
    ? (goal: FakeGoal) => opts.goto!(() => arrive(goal))
    : async (goal: FakeGoal) => { arrive(goal); };
  return bot;
}

export function makeExecutorOn(
  bot: unknown,
  fleeHealth = 0,
  ranged?: NonNullable<ConstructorParameters<typeof Executor>[0]['ranged']>,
) {
  const reports: TaskReport[] = [];
  const exec = new Executor({
    getBot: () => bot as never,
    report: (r) => reports.push(r),
    log,
    nextId: nextTaskId(),
    fleeHealth: () => fleeHealth,
    ...(ranged ? { ranged } : {}),
  });
  return { exec, reports };
}

/** 带容器账本的执行器:账本相关技能(smelt 入账 / take at / 试算点名)用它 */
export function makeExecutorWith(bot: unknown, chests: ChestBook) {
  const reports: TaskReport[] = [];
  const exec = new Executor({
    getBot: () => bot as never,
    report: (r) => reports.push(r),
    log,
    nextId: nextTaskId(),
    chests,
  });
  return { exec, reports };
}

/** 带成果登记的执行器 */
export function makeExecutorWithWorks(bot: unknown, works: WorksBook) {
  const reports: TaskReport[] = [];
  const exec = new Executor({
    getBot: () => bot as never,
    report: (r) => reports.push(r),
    log,
    nextId: nextTaskId(),
    works,
  });
  return { exec, reports };
}

/**
 * 合成用的假 bot:1 根金合欢原木换 4 块木板,不用工作台。
 * `gain` 决定合成事务被接受之后东西进不进包:1.20.6 上出现过
 * bot.craft 正常返回、物品栏一个都不多的情形。
 */
export function craftBot(opts: { logs: number; planks?: number; gain: 'real' | 'none' }) {
  const counts = new Map<number, number>([[1, opts.logs], [2, opts.planks ?? 0]]);
  const names: Record<number, { name: string }> = {
    1: { name: 'acacia_log' }, 2: { name: 'acacia_planks' }, 3: { name: 'crafting_table' },
  };
  const recipe = {
    result: { id: 2, count: 4 },
    ingredients: [{ id: 1 }],
    delta: [{ id: 1, count: -1 }, { id: 2, count: 4 }],
    requiresTable: false,
  };
  const crafts: number[] = [];
  const bot = {
    crafts,
    entity: { id: 9, position: new V(0.5, 64, 0.5) },
    entities: {},
    health: 20,
    players: {},
    registry: {
      items: names,
      itemsByName: {
        acacia_log: { id: 1, name: 'acacia_log' },
        acacia_planks: { id: 2, name: 'acacia_planks' },
        crafting_table: { id: 3, name: 'crafting_table' },
      },
      blocksByName: { crafting_table: { id: 30, name: 'crafting_table' } },
    },
    inventory: {
      items: () => [...counts].filter(([, n]) => n > 0)
        .map(([type, count]) => ({ type, count, name: names[type].name })),
    },
    recipesAll: (id: number) => (id === 2 ? [recipe] : []),
    findBlocks: () => [] as V[],
    craft: async (r: typeof recipe, times: number) => {
      crafts.push(times);
      if (opts.gain === 'none') return; // 事务被接受了,东西没到手
      for (const d of r.delta) counts.set(d.id, (counts.get(d.id) ?? 0) + d.count * times);
    },
    equip: async () => {},
    lookAt: async () => {},
    setControlState: () => {},
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
  };
  return bot;
}

/**
 * 她自己摆合成格用的假 bot:产物由服务端裁决(配方的 result.id 是 null),
 * 摆好的 inShape 与要不要工作台是 craft 这一步唯一的入参。
 */
export function gridCraftBot(opts: { tableNearby?: boolean } = {}) {
  const CHARCOAL = 11; const STICK = 12; const TORCH = 13; const PLANKS = 14;
  const counts = new Map<number, number>([[CHARCOAL, 4], [STICK, 4], [PLANKS, 8]]);
  const names: Record<number, { name: string }> = {
    [CHARCOAL]: { name: 'charcoal' }, [STICK]: { name: 'stick' },
    [TORCH]: { name: 'torch' }, [PLANKS]: { name: 'oak_planks' },
  };
  const seen: Array<{ inShape: unknown; requiresTable: boolean; table: unknown }> = [];
  const table = { name: 'crafting_table', position: new V(2, 64, 0) };
  const bot = {
    seen,
    entity: { id: 9, position: new V(0.5, 64, 0.5) },
    entities: {},
    health: 20,
    players: {},
    registry: {
      items: names,
      itemsByName: {
        charcoal: { id: CHARCOAL, name: 'charcoal' }, stick: { id: STICK, name: 'stick' },
        torch: { id: TORCH, name: 'torch' }, oak_planks: { id: PLANKS, name: 'oak_planks' },
      },
      blocksByName: { crafting_table: { id: 30, name: 'crafting_table' } },
    },
    inventory: {
      items: () => [...counts].filter(([, n]) => n > 0)
        .map(([type, count]) => ({ type, count, name: names[type].name })),
    },
    recipesAll: () => [],
    findBlocks: () => (opts.tableNearby ? [table.position] : []),
    blockAt: () => (opts.tableNearby ? table : { name: 'air', boundingBox: 'empty' }),
    craft: async (r: { inShape: unknown; requiresTable: boolean }, _n: number, t: unknown) => {
      seen.push({ inShape: r.inShape, requiresTable: r.requiresTable, table: t });
      counts.set(TORCH, (counts.get(TORCH) ?? 0) + 4);
    },
    equip: async () => {},
    lookAt: async () => {},
    setControlState: () => {},
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
  };
  return bot;
}

/**
 * 工作台合成夹具:包里有木板和一个自带的工作台,附近没有现成的。
 * 中间材料不再自动补齐(配方树已撤),所以工作台必须是她自己带的。
 * `placement` 覆盖成功、服务端未确认与无候选位置三种结果。
 */
export function tableCraftBot(placement: 'lands' | 'vanishes' | 'no-spot') {
  const PLANKS = 2; const TABLE = 3; const PICK = 4;
  const counts = new Map<number, number>([[PLANKS, 8], [TABLE, 1]]);
  const names: Record<number, { name: string }> = {
    [PLANKS]: { name: 'oak_planks' }, [TABLE]: { name: 'crafting_table' }, [PICK]: { name: 'wooden_pickaxe' },
  };
  const tableRecipe = {
    result: { id: TABLE, count: 1 }, ingredients: [{ id: PLANKS }],
    delta: [{ id: PLANKS, count: -4 }, { id: TABLE, count: 1 }], requiresTable: false,
  };
  const pickRecipe = {
    result: { id: PICK, count: 1 }, ingredients: [{ id: PLANKS }],
    delta: [{ id: PLANKS, count: -3 }, { id: PICK, count: 1 }], requiresTable: true,
  };
  /** 世界:脚边那一圈的地面(no-spot 时连地面都没有,放不成) */
  const world = new Map<string, string>();
  const key = (p: V): string => `${p.x},${p.y},${p.z}`;
  if (placement !== 'no-spot') {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) world.set(key(new V(dx, 63, dz)), 'stone');
  }
  const bot = {
    entity: { id: 9, position: new V(0.5, 64, 0.5) },
    entities: {},
    health: 20,
    players: {},
    registry: {
      items: names,
      itemsByName: {
        oak_planks: { id: PLANKS, name: 'oak_planks' },
        crafting_table: { id: TABLE, name: 'crafting_table' },
        wooden_pickaxe: { id: PICK, name: 'wooden_pickaxe' },
      },
      blocksByName: { crafting_table: { id: 30, name: 'crafting_table' } },
    },
    inventory: {
      items: () => [...counts].filter(([, n]) => n > 0)
        .map(([type, count]) => ({ type, count, name: names[type].name })),
    },
    recipesAll: (id: number, _meta: unknown, withTable: unknown) => {
      if (id === TABLE) return [tableRecipe];
      if (id === PICK) return withTable ? [pickRecipe] : [];
      return [];
    },
    // 附近没有现成工作台;放下之后也只按 world 回读,不靠这里
    findBlocks: () => [] as V[],
    craft: async (r: typeof tableRecipe) => {
      for (const d of r.delta) counts.set(d.id, (counts.get(d.id) ?? 0) + d.count);
    },
    placeBlock: async (below: { position: V }) => {
      counts.set(TABLE, (counts.get(TABLE) ?? 0) - 1);
      if (placement === 'lands') world.set(key(below.position.offset(0, 1, 0)), 'crafting_table');
      // vanishes:物品扣掉了,世界里什么都没出现
    },
    blockAt: (p: V) => {
      const name = world.get(key(p));
      return name
        ? { name, boundingBox: 'block', position: p }
        : { name: 'air', boundingBox: 'empty', position: p };
    },
    heldItem: null as { name: string } | null,
    equip: async (it: { name: string }) => { bot.heldItem = it; },
    lookAt: async () => {},
    setControlState: () => {},
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
  };
  return { bot, counts, PICK, TABLE };
}

export const CHEST_IDS: Record<string, number> = { cobblestone: 1, diamond_pickaxe: 2, coal: 3, iron_ingot: 4 };

/**
 * 容器开启时，玩家库存的实时内容在 window.items()；bot.inventory 保留开窗前内容，close 的 copyInventory 才回灌。
 * 夹具使用分开的库存镜像，避免错误读取旧账也能得到实时变化。
 */
export function chestBot(opts: {
  inv?: Record<string, number>;
  box?: Record<string, number>;
  /** 窗口里点了也不动:这是真的没搬成 */
  deaf?: boolean;
  /** 关窗不灌回:服务端没回灌确认 */
  noCopyBack?: boolean;
  /** 点一下就抛这句(mineflayer 的原话) */
  throws?: string;
  /** 关窗回灌时每样再多少掉几个:制造点击侧与库存侧对不上的那种情形 */
  drift?: number;
} = {}) {
  const inv = new Map(Object.entries(opts.inv ?? {}));
  const box = new Map(Object.entries(opts.box ?? {}));
  const nameOf = (type: number) => Object.keys(CHEST_IDS).find((k) => CHEST_IDS[k] === type)!;
  const stacks = (m: Map<string, number>) => [...m]
    .filter(([, n]) => n > 0)
    .map(([name, count]) => ({ type: CHEST_IDS[name] ?? 99, metadata: 0, name, count }));
  const chestPos = new V(2, 64, 0);
  const bot = {
    entity: { id: 1, position: new V(0.5, 64, 0.5) },
    entities: {},
    game: { dimension: 'overworld' },
    registry: { blocksByName: { chest: { id: 54, name: 'chest' } }, itemsByName: {} },
    // 开窗期间冻着不动,close() 才被灌回
    inventory: { items: () => stacks(inv) },
    findBlocks: () => [chestPos],
    blockAt: (p: V) => (p.x === 2 && p.y === 64 && p.z === 0
      ? { name: 'chest', position: p, boundingBox: 'block' }
      : { name: 'air', position: p, boundingBox: 'empty' }),
    openContainer: async () => {
      const live = new Map(inv);
      const move = (from: Map<string, number>, to: Map<string, number>, name: string, n: number) => {
        if (opts.throws) throw new Error(opts.throws);
        const has = from.get(name) ?? 0;
        const k = Math.min(has, n);
        if (opts.deaf || k <= 0) return;
        from.set(name, has - k);
        to.set(name, (to.get(name) ?? 0) + k);
      };
      return {
        items: () => stacks(live),
        containerItems: () => stacks(box),
        inventoryStart: 27,
        deposit: async (type: number, _m: number | null, n: number) => move(live, box, nameOf(type), n),
        withdraw: async (type: number, _m: number | null, n: number) => move(box, live, nameOf(type), n),
        close: () => {
          if (opts.noCopyBack) return;
          for (const [k, v] of live) inv.set(k, Math.max(0, v - (opts.drift ?? 0)));
        },
      };
    },
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
  };
  return { bot, inv, box };
}

/**
 * 逐格记账的箱子台架:同 id 而各自带不同附魔的几件东西,靠它才分得出来。
 *
 * `chestBot` 那份按「名字 → 个数」记账,五本各不相同的附魔书在它眼里是一条 `×5`,
 * 挑中哪一本无从考证。这一份照原版逐格摆:`deposit`/`withdraw` 照 mineflayer 的做法
 * **按物品类型找第一格**(点名挑那一件的实现要是退回它,这里当场变红),
 * `moveSlotItem` 照 mineflayer 的做法搬点名的那一格。
 */
export function slotChestBot(opts: {
  /** 玩家背包,按格摆;每格 `ench` 是这一件身上的附魔(注册表序号 → 等级) */
  inv: Array<{ name: string; type: number; count?: number; ench?: Array<[number, number]> }>;
  box?: Array<{ name: string; type: number; count?: number }>;
  /** 箱子有几格;满箱的情形把它调小 */
  boxSlots?: number;
  enchants?: Record<number, { name: string }>;
}) {
  const INV_START = 27;
  const boxSlots = opts.boxSlots ?? 27;
  const mk = (it: { name: string; type: number; count?: number; ench?: Array<[number, number]> }) => ({
    name: it.name, type: it.type, count: it.count ?? 1, metadata: 0, slot: 0,
    ...(it.ench
      ? {
          componentMap: new Map<string, { data?: unknown }>([
            ['enchantments', { data: { enchantments: it.ench.map(([id, level]) => ({ id, level })) } }],
          ]),
        }
      : {}),
  });
  type Slot = ReturnType<typeof mk> | null;
  /** 一整扇窗:0..boxSlots-1 是箱子,其后是玩家背包 —— 与原版的槽位编号一致 */
  const slots: Slot[] = new Array<Slot>(INV_START + 36).fill(null);
  opts.box?.forEach((it, i) => { slots[i] = mk(it); });
  opts.inv.forEach((it, i) => { slots[INV_START + i] = mk(it); });
  const inRange = (from: number, to: number): Slot[] => slots
    .slice(from, to)
    .map((s, i) => (s ? { ...s, slot: from + i } : null))
    .filter((s): s is NonNullable<Slot> => s !== null);
  const firstEmpty = (from: number, to: number): number | null => {
    for (let i = from; i < to; i++) if (!slots[i]) return i;
    return null;
  };
  /** mineflayer 的口径:按物品类型找**第一格**,附魔在它眼里不存在 */
  const moveByType = (fromA: number, fromB: number, toA: number, toB: number, type: number): void => {
    const src = slots.findIndex((s, i) => i >= fromA && i < fromB && s?.type === type);
    const dst = firstEmpty(toA, toB);
    if (src < 0 || dst === null) return;
    slots[dst] = slots[src];
    slots[src] = null;
  };
  const win = {
    id: 3,
    inventoryStart: INV_START,
    inventoryEnd: INV_START + 36,
    items: () => inRange(INV_START, INV_START + 36),
    containerItems: () => inRange(0, boxSlots),
    firstEmptyContainerSlot: () => firstEmpty(0, boxSlots),
    firstEmptyInventorySlot: () => firstEmpty(INV_START, INV_START + 36),
    deposit: async (type: number) => moveByType(INV_START, INV_START + 36, 0, boxSlots, type),
    withdraw: async (type: number) => moveByType(0, boxSlots, INV_START, INV_START + 36, type),
    close: () => {},
  };
  const chestPos = new V(2, 64, 0);
  const bot = {
    entity: { id: 1, position: new V(0.5, 64, 0.5) },
    entities: {},
    game: { dimension: 'overworld' },
    registry: {
      blocksByName: { chest: { id: 54, name: 'chest' } },
      itemsByName: {},
      enchantments: opts.enchants ?? {},
    },
    inventory: { items: () => inRange(INV_START, INV_START + 36) },
    findBlocks: () => [chestPos],
    blockAt: (p: V) => (p.x === 2 && p.y === 64 && p.z === 0
      ? { name: 'chest', position: p, boundingBox: 'block' }
      : { name: 'air', position: p, boundingBox: 'empty' }),
    openContainer: async () => win,
    moveSlotItem: async (from: number, to: number) => {
      slots[to] = slots[from];
      slots[from] = null;
    },
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
  };
  /** 现在包里/箱里各有什么(按格,带附魔序号):断言拿它对 */
  const names = (from: number, to: number): string[] => slots
    .slice(from, to)
    .filter((s): s is NonNullable<Slot> => s !== null)
    .map((s) => {
      const data = s.componentMap?.get('enchantments')?.data as
        { enchantments?: Array<{ id: number }> } | undefined;
      const ids = data?.enchantments?.map((e) => e.id) ?? [];
      return ids.length > 0 ? `${s.name}#${ids.join(',')}` : s.name;
    });
  return { bot, bag: () => names(INV_START, INV_START + 36), boxed: () => names(0, boxSlots) };
}

// 附魔台与酿造台

/**
 * 附魔台台架。`use` 右键附魔台开出来的窗口在 skillUse 里被无条件关掉,窗口生命周期
 * 只认容器族与炉子族 —— 所以 enchant 必须自己开窗,这个 rig 验的正是那条链。
 */
export function enchantBot(opts: {
  inv?: Record<string, number>;
  level?: number;
  /** 三档门槛等级;-1 = 服务端还没给出这一档 */
  costs?: [number, number, number];
  /** 每档显示出来的那条附魔(注册表序号与等级);null = 没有提示 */
  hints?: Array<{ id: number; lvl: number } | null>;
  shelves?: Array<[number, number, number]>;
  tableAt?: [number, number, number];
} = {}) {
  const inv = new Map(Object.entries(opts.inv ?? { diamond_pickaxe: 1, lapis_lazuli: 3 }));
  const table = opts.tableAt ?? [2, 64, 0];
  const shelves = new Set((opts.shelves ?? []).map((s) => s.join(',')));
  const costs = opts.costs ?? [1, 8, 12];
  const hints = opts.hints ?? [{ id: 22, lvl: 1 }, { id: 20, lvl: 3 }, { id: 20, lvl: 4 }];
  let level = opts.level ?? 12;
  let onTable: { name: string; count: number; slot: number } | null = null;
  let lapisOn: { name: string; count: number; slot: number } | null = null;
  let enchanted: Array<{ id: number; level: number }> = [];
  const stacks = () => [...inv]
    .filter(([, n]) => n > 0)
    .map(([name, count], i) => ({ type: 100 + i, metadata: 0, name, count, slot: 9 + i }));
  const win = {
    enchantments: costs.map((c, i) => ({
      level: c,
      expected: { enchant: hints[i] ? hints[i]!.id : -1, level: hints[i] ? hints[i]!.lvl : -1 },
    })),
    get slots() { return [onTable, lapisOn] as Array<{ name: string; count: number; slot: number } | null>; },
    items: () => stacks(),
    targetItem: () => onTable,
    putTargetItem: async (it: { name: string; count: number }) => {
      onTable = { name: it.name, count: it.count, slot: 0 };
      inv.set(it.name, (inv.get(it.name) ?? 0) - it.count);
    },
    putLapis: async (it: { name: string; count: number }) => {
      lapisOn = { name: it.name, count: it.count, slot: 1 };
    },
    enchant: async (choice: number) => {
      level -= choice + 1;
      inv.set('lapis_lazuli', (inv.get('lapis_lazuli') ?? 0) - (choice + 1));
      lapisOn = null;
      enchanted = [{ id: 20, level: 4 }, { id: 22, level: 2 }];
      onTable = { ...onTable!, ...{ componentMap: new Map([['enchantments', { data: { enchantments: enchanted } }]]) } } as never;
    },
    close: () => { onTable = null; lapisOn = null; },
  };
  const bot = {
    entity: { id: 1, position: new V(0.5, 64, 0.5) },
    entities: {},
    game: { dimension: 'overworld' },
    get experience() { return { level, points: 0, progress: 0 }; },
    registry: {
      blocksByName: { enchanting_table: { id: 116, name: 'enchanting_table' } },
      itemsByName: {},
      enchantments: { 20: { name: 'efficiency' }, 22: { name: 'unbreaking' } },
    },
    inventory: { items: () => stacks() },
    currentWindow: null,
    findBlocks: () => [],
    blockAt: (p: V) => {
      if (p.x === table[0] && p.y === table[1] && p.z === table[2]) {
        return { name: 'enchanting_table', position: p, boundingBox: 'block' };
      }
      if (shelves.has(`${p.x},${p.y},${p.z}`)) return { name: 'bookshelf', position: p, boundingBox: 'block' };
      return { name: 'air', position: p, boundingBox: 'empty' };
    },
    openEnchantmentTable: async () => win,
    putAway: async () => {
      if (onTable) { inv.set(onTable.name, (inv.get(onTable.name) ?? 0) + onTable.count); onTable = null; }
    },
    closeWindow: () => {},
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
  };
  return { bot, inv, table, levelNow: () => level };
}

/**
 * 酿造台台架:五个槽(3 瓶位 + 材料 + 燃料),moveSlotItem 从包里搬进去。
 * 窗口属性照原版推:燃料位进烈焰粉就烧成 20 轮,瓶位和材料位齐了且有燃料就开酿(400 刻)。
 * openContainer 照 mineflayer 的白名单拒收酿造台,只有 openBlock 开得出来。
 */
export function brewBot(opts: { inv?: Record<string, number>; standAt?: [number, number, number]; fuelLeft?: number } = {}) {
  const inv = new Map(Object.entries(opts.inv ?? { potion: 3, nether_wart: 4, blaze_powder: 2 }));
  const stand = opts.standAt ?? [2, 64, 0];
  const slots: Array<{ name: string; count: number; slot: number } | null> = [null, null, null, null, null];
  const stacks = () => [...inv]
    .filter(([, n]) => n > 0)
    .map(([name, count], i) => ({ type: 200 + i, metadata: 0, name, count, slot: 9 + i }));
  const win = {
    id: 7,
    type: 'minecraft:brewing_stand',
    slots,
    items: () => stacks(),
    close: () => {},
  };
  const client = new EventEmitter();
  let fuel = opts.fuelLeft ?? 0;
  const prop = (property: number, value: number) => client.emit('craft_progress_bar', { windowId: win.id, property, value });
  const tick = () => {
    if (fuel === 0 && slots[4]?.name === 'blaze_powder') {
      fuel = 20;
      slots[4] = slots[4].count > 1 ? { ...slots[4], count: slots[4].count - 1 } : null;
    }
    prop(1, fuel);
    prop(0, fuel > 0 && slots[3] && slots.slice(0, 3).some(Boolean) ? 400 : 0);
  };
  const bot = {
    entity: { id: 1, position: new V(0.5, 64, 0.5) },
    entities: {},
    game: { dimension: 'overworld' },
    registry: { blocksByName: { brewing_stand: { id: 330, name: 'brewing_stand' } }, itemsByName: {} },
    inventory: { items: () => stacks() },
    currentWindow: null,
    findBlocks: () => [],
    blockAt: (p: V) => (p.x === stand[0] && p.y === stand[1] && p.z === stand[2]
      ? { name: 'brewing_stand', position: p, boundingBox: 'block' }
      : { name: 'air', position: p, boundingBox: 'empty' }),
    _client: client,
    openContainer: async () => { throw new Error('containerToOpen is neither a block nor an entity'); },
    openBlock: async () => {
      client.emit('open_window', { windowId: win.id });
      tick();
      return win;
    },
    moveSlotItem: async (from: number, to: number) => {
      const src = stacks().find((s) => s.slot === from);
      if (!src) return;
      const take = to <= 2 ? 1 : src.count;
      inv.set(src.name, (inv.get(src.name) ?? 0) - take);
      slots[to] = { name: src.name, count: take, slot: to };
      tick();
    },
    putAway: async (slot: number) => {
      const s = slots[slot];
      if (!s) return;
      inv.set(s.name, (inv.get(s.name) ?? 0) + s.count);
      slots[slot] = null;
    },
    closeWindow: () => {},
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
  };
  trackWindowProps(bot as never);
  return { bot, inv, slots, stand };
}

export const SMELT_IDS: Record<string, number> = {
  raw_iron: 1, iron_ingot: 2, coal: 3, oak_planks: 4, oak_log: 5,
  charcoal: 6, furnace: 7, blast_furnace: 8, dirt: 9, sand: 10, glass: 11,
};

/**
 * 熔炉假 bot:一座炉子按"燃料能烧几样就烧几样"当场换出成品。
 *
 * 真炉子是每 10 秒出一个;这里下料瞬间换出成品,测的是账怎么算(要几个、烧掉几个
 * 燃料、剩下的怎么办),不是等的那段时间。**炉子的三槽位跨开窗持续存在**——
 * smelt 下料关窗、take 再开窗收货,靠的就是这份持续。
 */
export function furnaceBot(opts: {
  inv: Record<string, number>;
  /** 世界里现成的炉子;不给就是附近一座都没有 */
  furnaces?: Array<{ x: number; y: number; z: number; name: string }>;
  /** 开炉时输出槽里的上一炉残留 */
  stale?: { name: string; count: number };
  /** 关炉不灌回:服务端没回灌确认 */
  noCopyBack?: boolean;
}) {
  const inv = new Map(Object.entries(opts.inv));
  const placed: string[] = [];
  const world = [...(opts.furnaces ?? [])];
  /**
 * 自备放置全程保持 shift，避免右键交互方块时触发打开或睡床。
 */
  const sneaks: boolean[] = [];
  const stack = (name: string, count: number) => ({ type: SMELT_IDS[name] ?? 99, metadata: 0, name, count });
  /** 开炉期间玩家那半边的实时账在窗口上,inv 冻着不动(分账见 chestBot 注释) */
  let live: Map<string, number> | null = null;
  const cur = () => live ?? inv;
  const give = (name: string, n: number) => cur().set(name, (cur().get(name) ?? 0) + n);
  const take = (name: string, n: number) => cur().set(name, (cur().get(name) ?? 0) - n);
  const nameOfType = (type: number) => Object.keys(SMELT_IDS).find((k) => SMELT_IDS[k] === type)!;
  // 炉子自己的三槽位:跨开窗持续
  let input: ReturnType<typeof stack> | null = null;
  let fuel: ReturnType<typeof stack> | null = null;
  let output: ReturnType<typeof stack> | null = opts.stale ? stack(opts.stale.name, opts.stale.count) : null;

  const bot = {
    entity: { id: 1, position: new V(0.5, 64, 0.5) },
    entities: {},
    game: { dimension: 'overworld' },
    registry: {
      itemsByName: Object.fromEntries(Object.entries(SMELT_IDS).map(([name, id]) => [name, { id, name }])),
      blocksByName: { furnace: { id: 61, name: 'furnace' }, blast_furnace: { id: 62, name: 'blast_furnace' } },
    },
    inventory: {
      items: () => [...inv].filter(([, n]) => n > 0).map(([name, n]) => stack(name, n)),
    },
    heldItem: null as { name: string } | null,
    equip: async (it: { name: string }) => { bot.heldItem = it; },
    findBlocks: ({ matching }: { matching: number[] }) => world
      .filter((f) => matching.includes(f.name === 'furnace' ? 61 : 62))
      .map((f) => new V(f.x, f.y, f.z)),
    blockAt: (p: V) => {
      const hit = world.find((f) => f.x === p.x && f.y === p.y && f.z === p.z);
      if (hit) return { name: hit.name, position: p, boundingBox: 'block' };
      // 脚下实心、身周空气:placeBlockNearby 要靠这个找落点
      return { name: p.y < 64 ? 'stone' : 'air', position: p, boundingBox: p.y < 64 ? 'block' : 'empty' };
    },
    setControlState: (k: string, v: boolean) => { if (k === 'sneak') sneaks.push(v); },
    placeBlock: async (ref: { position: V }, face: V) => {
      const held = bot.heldItem!.name;
      world.push({ x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z, name: held });
      placed.push(held);
      take(held, 1);
    },
    openFurnace: async () => {
      const mine = new Map(inv);
      live = mine;
      return {
        items: () => [...mine].filter(([, n]) => n > 0).map(([name, n]) => stack(name, n)),
        inventoryStart: 3,
        putFuel: async (type: number, _m: null, n: number) => {
          const name = nameOfType(type);
          take(name, n);
          fuel = stack(name, n);
        },
        putInput: async (type: number, _m: null, n: number) => {
          const name = nameOfType(type);
          take(name, n);
          // 烧出来是什么由服务端说了算:执行器不再有烧炼表。没配方的(泥土)就一直不出货
          const per = name === 'raw_iron' ? 'iron_ingot'
            : name === 'sand' ? 'glass'
              : name.endsWith('_log') ? 'charcoal' : null;
          const cap = fuel ? Math.floor((fuel.name === 'coal' ? 1600 : 300) * fuel.count / 200) : 0;
          const done = Math.min(n, cap);
          if (fuel) {
            const spent = Math.ceil(done * 200 / (fuel.name === 'coal' ? 1600 : 300));
            fuel = spent >= fuel.count ? null : stack(fuel.name, fuel.count - spent);
          }
          input = done < n ? stack(name, n - done) : null;
          if (done > 0 && per) output = stack(per, (output?.name === per ? output.count : 0) + done);
        },
        inputItem: () => input,
        fuelItem: () => fuel,
        outputItem: () => output,
        takeOutput: async () => { give(output!.name, output!.count); output = null; },
        takeInput: async () => { give(input!.name, input!.count); input = null; },
        takeFuel: async () => { give(fuel!.name, fuel!.count); fuel = null; },
        close: () => {
          live = null;
          if (opts.noCopyBack) return;
          for (const [k, v] of mine) inv.set(k, v);
        },
      };
    },
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
  };
  return { bot, inv, placed, world, sneaks, slots: () => ({ input, fuel, output }) };
}

/**
 * 夹具对每次 placeBlock 写 placedLedger；placedNote 按技能过滤，自备工作站不能混入寻路垫脚消耗。
 */
export function recordPlacements(bot: Record<string, unknown>): Array<{ name: string; x: number; y: number; z: number }> {
  const ledger: Array<{ name: string; x: number; y: number; z: number }> = [];
  bot.placedLedger = ledger;
  const inner = bot.placeBlock as (ref: { position: V }, face: V) => Promise<void>;
  bot.placeBlock = async (ref: { position: V }, face: V) => {
    const name = (bot.heldItem as { name: string }).name;
    await inner(ref, face);
    ledger.push({
      name, x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z,
    });
  };
  return ledger;
}

/** 悬崖边:只有脚下那一格实心,脚边一圈的下面全悬空——脚边八选一一个候选位都没有 */
export function onLedge(rig: ReturnType<typeof furnaceBot>): void {
  rig.bot.blockAt = (p: V) => {
    const hit = rig.world.find((w) => w.x === p.x && w.y === p.y && w.z === p.z);
    if (hit) return { name: hit.name, position: p, boundingBox: 'block' };
    const solid = p.x === 0 && p.y === 63 && p.z === 0;
    return { name: solid ? 'stone' : 'air', position: p, boundingBox: solid ? 'block' : 'empty' };
  };
}

/** 防溺水反射的假 bot:头顶方块与氧气读数可控 */
export function drownBot(headBlock: string, oxygenLevel: number) {
  const pos = {
    x: 10, y: 63, z: 10,
    offset(dx: number, dy: number, dz: number) {
      return { ...pos, x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
    },
    floored() { return pos; },
    distanceTo() { return 1; },
  };
  const jumps: boolean[] = [];
  const bot = {
    jumps,
    entity: { id: 1, position: pos },
    oxygenLevel,
    health: 20,
    food: 20,
    entities: {},
    setControlState(_k: string, v: boolean) { jumps.push(v); },
    setHead(name: string) { headBlock = name; },
    blockAt(p: { y: number }) {
      if (p.y === pos.y + 1) return { name: headBlock, boundingBox: 'empty' };
      return null; // 登岸点扫描一律找不到,与本测试无关
    },
    pathfinder: { setGoal() {}, stop() {} },
    on() {},
    removeListener() {},
  };
  return bot;
}

export function makeReflexes(bot: ReturnType<typeof drownBot>) {
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
    fleeHealth: () => 8,
    reactCooldownSec: () => 8,
    antiDrown: () => true,
    antiLava: () => false,
  });
  return { reflexes, reports, preempts };
}

/**
 * 模拟 mineflayer-pathfinder 的延迟停止语义：`stop()` 设置待清理标志，
 * 下一次 `setGoal()` 经 `resetPath` 消耗该标志并清除目标。
 */
export function fakePathfinder() {
  let stopPathing = false;
  const pf = {
    goal: null as unknown,
    stop() { stopPathing = true; },
    setGoal(g: unknown) {
      pf.goal = g;
      if (stopPathing) { stopPathing = false; pf.goal = null; }
    },
    goto: async (_g?: unknown) => {},
  };
  return pf;
}
