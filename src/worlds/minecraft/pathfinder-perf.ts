/**
 * mineflayer-pathfinder 的运行时补丁，涵盖搜索缓存与移动约束。
 *
 * 被替换的 Movements 方法（getNeighbors、getMoveJumpUp、getMoveForward 等）以
 * mineflayer-pathfinder 2.4.5 的 lib/movements.js 为底本改写。上游为 MIT 许可，
 * Copyright (c) 2020 Karang；许可全文见同目录 LICENSE-mineflayer-pathfinder.txt。
 *
 * 1. 单次 AStar 搜索内缓存方块读数，按 stateId 构造特征；仅在计算 digTime 时物化完整 Block。
 * 2. 搜索期间工具与效果不变，挖掘成本按方块类型缓存。
 * 3. 空实体索引直接返回，safeToBreak 按位置缓存；compute 之外保留原始读取逻辑。
 * 4. 浅水允许垫塔，深水表面允许游上一格高的岸。
 * 5. 脚在液体且脚下无实底时不生成放置动作。
 * 6. 工地范围禁止寻路放置，走与挖不受限；工地建材在垫脚候选中排最后。
 * 7. 前行与跳上一格的整个放置分支同样受脚下实底约束。
 * 8. 三分钟内被拒且方块未变的落点进入放置黑名单。
 *
 * 缺失区块列须返回不可走；已加载列的越界 y 按空气处理。getMoveJumpUp 的高度调整使用局部值，避免污染缓存。
 */
import { createRequire } from 'node:module';
import { Movements } from 'mineflayer-pathfinder';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import type { Logger } from '../../core/types.ts';

// prismarine-nbt / vec3 是 mineflayer-pathfinder 的依赖而非本包的,要顺它的依赖链拿
const req = createRequire(import.meta.url);
const pfRequire = createRequire(req.resolve('mineflayer-pathfinder/package.json'));
const nbt = pfRequire('prismarine-nbt') as { simplify(n: unknown): { Enchantments: unknown[] } };
const { Vec3 } = pfRequire('vec3') as { Vec3: new (x: number, y: number, z: number) => unknown };
const Move = pfRequire('./lib/move.js') as new (
  x: number, y: number, z: number, remainingBlocks: number, cost: number, toBreak: unknown[], toPlace: unknown[],
) => unknown;
// prismarine-block 顺 mineflayer 的依赖链拿(pathfinder 自己不直接依赖它)
const mfRequire = createRequire(req.resolve('mineflayer/package.json'));
const prismarineBlock = mfRequire('prismarine-block') as (registry: unknown) => {
  fromStateId(stateId: number, biomeId: number): {
    type: number; boundingBox: string; shapes?: number[][];
    getProperties?(): Record<string, unknown>;
  } | null;
};

/**
 * 按 stateId 预计算的方块特征(每 registry 建一次,~20ms):搜索只消费这些,
 * 不必每次读块都物化完整 Block。建表走 Block.fromStateId 逐状态物化一遍,
 * 与原版装饰读到的值按构造相等。
 */
interface StateTables {
  typeId: Uint32Array;
  bbEmpty: Uint8Array;
  bbBlock: Uint8Array;
  /** 高度增量 = max(0, 形状最高点):原版 height = y 再与 y+shape[4] 取 max */
  delta: Float64Array;
  shapes: (number[][] | undefined)[];
  names: string[];
  maxType: number;
  /**
   * 门与栅栏门按 stateId 记录开合状态，0 表示其他方块。
   * 注册表的类型级 boundingBox 不区分开合，寻路可通行性须读取 open 状态。
   */
  doorState: Uint8Array;
}

/** 这一格是开着的门/栅栏门:人走得过去(开门后的碰撞盒只占边上 3/16 格) */
const DOOR_OPEN = 1;
/** 关着、而且手能开的(木门、栅栏门):寻路器可以「用一下再过去」 */
const DOOR_SHUT_HAND = 2;
/** 关着、手开不动的(铁门只吃红石):继续当墙,不假装能过 */
const DOOR_SHUT_LOCKED = 3;
/** 门的上半扇(`half=upper`)。它只当头顶净空,永远不许当落脚格 */
const DOOR_UPPER = 4;
const DOOR_KIND = 3;

/**
 * 门类逐状态判词。只认竖着挡路的两族:
 *
 *  - `*_door`:两半共用一个 `open`,开下半扇上半扇跟着开,所以两半都照同一条判;
 *  - `*_fence_gate`:上游 `canOpenDoors` 本来就是为它写的(开着时 shapes 是空的,
 *    可它 `boundingBox` 仍是 `block`,照样被当墙 —— 开着的栅栏门今天也走不过去)。
 *
 * **活板门不进来**:它是横着的地板,「开一下再过去」等于把脚下的地板打开。
 * 开着的活板门当空气是对的,但那属于另一个判断(掉下去),这里不顺手做。
 */
export function doorStateOf(name: string, props: Record<string, unknown>): number {
  const isDoor = name.endsWith('_door');
  if (!isDoor && !name.endsWith('_fence_gate')) return 0;
  const open = props.open === true || props.open === 'true';
  // 铁门(以及万一有的铁栅栏门)手上没有开关的办法
  const kind = open ? DOOR_OPEN
    : isDoor && name.startsWith('iron_') ? DOOR_SHUT_LOCKED
      : DOOR_SHUT_HAND;
  return kind | (props.half === 'upper' ? DOOR_UPPER : 0);
}

/**
 * 把门的判词落到一次读块结果上(`b` 是本模块自己拼的轻量块,原地改)。
 *
 * - **开着的门**:可穿过,而且**撤掉 openable** —— 上游那条 `shapes.length !== 0`
 *   的判据会把开着的门也「用一下」,而那一下是把门关上(这正是上游把 canOpenDoors
 *   默认关掉、注释写「causes issues」的原因之一:它只对栅栏门成立,开着的栅栏门
 *   shapes 是空的,开着的门不是)。
 * - **关着、手能开的**:标成可穿过 + openable,由 getMoveForward 那条 useOne 分支
 *   在走到门口时 activateBlock 一下。
 * - **关着的铁门**:一个字不改,继续当墙。
 *
 * 两种可穿过的门都把 `height` 压回本格地面高度:门不是站得住的台面,留着
 * shapes 算出来的 1.0 会让上下坡判据以为这儿垫高了一格。
 */
export function applyDoorState(
  b: { safe: boolean; physical: boolean; openable: boolean; height: number },
  door: number,
  y: number,
  canOpenDoors: boolean,
): void {
  const kind = door & DOOR_KIND;
  if (kind === DOOR_OPEN) {
    b.safe = true;
    b.physical = false;
    b.openable = false;
    b.height = y;
    return;
  }
  if (kind === DOOR_SHUT_HAND && canOpenDoors) {
    b.safe = true;
    b.physical = false;
    b.openable = true;
    b.height = y;
  }
}

const tablesByRegistry = new WeakMap<object, StateTables>();

function tablesFor(registry: object): StateTables {
  let t = tablesByRegistry.get(registry);
  if (t) return t;
  const blocksArray = (registry as { blocksArray: Array<{ id: number; maxStateId: number; name: string }> }).blocksArray;
  let maxState = 0;
  let maxType = 0;
  for (const b of blocksArray) {
    if (b.maxStateId > maxState) maxState = b.maxStateId;
    if (b.id > maxType) maxType = b.id;
  }
  const Block = prismarineBlock(registry);
  t = {
    typeId: new Uint32Array(maxState + 1),
    bbEmpty: new Uint8Array(maxState + 1),
    bbBlock: new Uint8Array(maxState + 1),
    delta: new Float64Array(maxState + 1),
    shapes: new Array<number[][] | undefined>(maxState + 1),
    names: new Array<string>(maxType + 1),
    maxType,
    doorState: new Uint8Array(maxState + 1),
  };
  for (const b of blocksArray) t.names[b.id] = b.name;
  for (let s = 0; s <= maxState; s++) {
    const b = Block.fromStateId(s, 0);
    if (!b) continue;
    t.typeId[s] = b.type;
    t.bbEmpty[s] = b.boundingBox === 'empty' ? 1 : 0;
    t.bbBlock[s] = b.boundingBox === 'block' ? 1 : 0;
    let d = 0;
    for (const sh of b.shapes ?? []) if (sh[4] > d) d = sh[4];
    t.delta[s] = d;
    t.shapes[s] = b.shapes;
    const name = t.names[b.type];
    // getProperties 只在建表时调一遍(每 registry 一次),搜索热路径上读的是这张表
    if (name !== undefined && (name.endsWith('_door') || name.endsWith('_fence_gate'))) {
      t.doorState[s] = doorStateOf(name, b.getProperties?.() ?? {});
    }
  }
  tablesByRegistry.set(registry, t);
  return t;
}

/** movements 各分类 Set 折成按方块类型索引的位表;每次搜索重建,热改 Set 也能跟上 */
const BIT_CLIMB = 1, BIT_CARPET = 2, BIT_AVOID = 4, BIT_FENCE = 8,
  BIT_REPLACE = 16, BIT_LIQUID = 32, BIT_GRAVITY = 64, BIT_OPEN = 128;

function buildBits(m: PatchedMovements, maxType: number): Uint8Array {
  const bits = new Uint8Array(maxType + 1);
  for (let id = 0; id <= maxType; id++) {
    bits[id] = (m.climbables.has(id) ? BIT_CLIMB : 0)
      | (m.carpets.has(id) ? BIT_CARPET : 0)
      | (m.blocksToAvoid.has(id) ? BIT_AVOID : 0)
      | (m.fences.has(id) ? BIT_FENCE : 0)
      | (m.replaceables.has(id) ? BIT_REPLACE : 0)
      | (m.liquids.has(id) ? BIT_LIQUID : 0)
      | (m.gravityBlocks.has(id) ? BIT_GRAVITY : 0)
      | (m.openable.has(id) ? BIT_OPEN : 0);
  }
  return bits;
}

/**
 * 一片在建工地。包围盒含端点两格,寻路器对它有两条规矩:区内不生成放置动作
 * (走、挖不受限),区里的建材在垫脚候选里排到最后。
 */
export interface SiteZone {
  /** 日志与受阻文案里怎么称呼这片工地 */
  key: string;
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  /** 这片工地要用的物品名;垫脚挑料时降到最低优先级 */
  materials: readonly string[];
}

/**
 * 给一份 movements 装上工地取数口;`null` 撤销。搜索开工与每次挑垫脚料时现取,
 * 所以工地绑定/完工下一次寻路就生效,不必重装 movements。
 */
export function setSiteZones(
  movements: Movements,
  zones: (() => readonly SiteZone[]) | null,
): void {
  (movements as unknown as PatchedMovements).__siteZonesFn = zones;
}

/**
 * 注册禁垫格判据(成果登记格、传送门方块),落点本身或落点下面那格命中都不生成放置；null 撤销。
 * 此稀疏点集与 setSiteZones 的工地体积约束独立。
 */
export function setNoPlaceCells(
  movements: Movements,
  blocked: ((x: number, y: number, z: number) => boolean) | null,
): void {
  (movements as unknown as PatchedMovements).__noPlaceFn = blocked;
}

/**
 * 给一份 movements 装上「这一格此刻挖不动」的取数口;`null` 撤销。判据由调用方给
 * (bridge 的挖掘失败退避与成果登记格),这里只负责让 `safeToBreak` 认它 —— 挖不动的格子不再
 * 进 `toBreak`,A* 自然绕开,而不是每个物理刻把同一条路重算一遍。
 */
export function setDigBackoff(
  movements: Movements,
  blocked: ((x: number, y: number, z: number) => boolean) | null,
): void {
  (movements as unknown as PatchedMovements).__digBackoffFn = blocked;
}

function inZones(zones: readonly SiteZone[], x: number, y: number, z: number): boolean {
  for (const zone of zones) {
    if (x >= zone.min[0] && x <= zone.max[0]
      && y >= zone.min[1] && y <= zone.max[1]
      && z >= zone.min[2] && z <= zone.max[2]) return true;
  }
  return false;
}

interface SliceCache {
  blocks: Map<number, unknown>;
  labor: Map<number, number>;
  /** safeToBreak 按位置记忆化:纯世界函数,同一堵墙会被相邻节点反复评估 */
  breakable: Map<number, boolean>;
  /** 特征表与位表;bot 上没有 registry 时为 null,未命中退回原始读块 */
  tables: StateTables | null;
  bits: Uint8Array | null;
  /** chunk 是否已加载,按 chunk 记一次,免得每次空气读都去查列 */
  chunkKnown: Map<number, boolean>;
  /** 这一场搜索认的工地;取一次,partial 续算不重取 */
  zones: readonly SiteZone[] | null;
}

interface PatchedMovements {
  __sliceCache?: SliceCache | null;
  __entityIdxEmpty?: boolean;
  __siteZonesFn?: (() => readonly SiteZone[]) | null;
  __digBackoffFn?: ((x: number, y: number, z: number) => boolean) | null;
  __noPlaceFn?: ((x: number, y: number, z: number) => boolean) | null;
  /** 本次搜索的工地快照;compute 之外为 null(路径跟随不判包围盒) */
  __siteZones?: readonly SiteZone[] | null;
  entityIntersections: Record<string, number>;
  exclusionStep(block: unknown): number;
  exclusionBreak(block: unknown): number;
  getNumEntitiesAt(pos: unknown, dx: number, dy: number, dz: number): number;
  safeToBreak(block: unknown): boolean;
  entityCost: number;
  digCost: number;
  /** 上游默认 false(注释写「causes issues」);见 applyDoorState 的说明 */
  canOpenDoors: boolean;
  climbables: Set<number>;
  carpets: Set<number>;
  blocksToAvoid: Set<number>;
  fences: Set<number>;
  replaceables: Set<number>;
  liquids: Set<number>;
  gravityBlocks: Set<number>;
  openable: Set<number>;
  bot: {
    registry?: object;
    world?: {
      getBlockStateId(pos: unknown): number | undefined;
      getColumn(cx: number, cz: number): unknown;
    };
    pathfinder: { bestHarvestTool(block: unknown): { type: number; nbt: unknown } | null };
    entity: { effects: unknown };
  };
}

interface BlockLike {
  type: number;
  safe: boolean;
  physical: boolean;
  position: unknown;
  /** 特征表 POJO 上没有;要用时按需物化真 Block */
  digTime?(tool: number | null, a: boolean, b: boolean, c: boolean, enchants: unknown[], effects: unknown): number;
}

/**
 * 一个候选移动里的放置清单。`x/y/z` 是**参照方块**,加上面向量才是落点;
 * `useOne` 那种是"对着这一格用一下"(开栅门),不是放置。
 */
interface PlacingMove {
  toPlace?: Array<{ x: number; y: number; z: number; dx: number; dy: number; dz: number; useOne?: boolean }>;
}

/** 20+20+10 位打包进一个安全整数;坐标按 2^20 环绕,单次搜索半径内不会撞 */
function packPos(x: number, y: number, z: number): number {
  return (x & 0xFFFFF) * 0x40000000 + (z & 0xFFFFF) * 0x400 + (y & 0x3FF);
}

/**
 * 被服务端三连拒的放置格在搜索里避让多久。太短挡不住「drop 目标→重算→又选同一步」
 * 的循环(一轮约 2s);太长会把世界已经变过的老账当禁区 —— 黑名单同时比对
 * 记录时的方块名,世界变了立即放行,这个时长只兜「什么都没变」的重试。
 */
export const PLACE_MISS_TTL_MS = 3 * 60_000;

let installed = false;

/** 幂等;进程内装一次,对所有 Movements/AStar 实例生效 */
export function installPathfinderPerf(log?: Logger): void {
  if (installed) return;
  installed = true;

  const mProto = Movements.prototype as unknown as PatchedMovements & {
    getBlock(pos: { x: number; y: number; z: number } | null, dx: number, dy: number, dz: number): unknown;
    safeOrBreak(block: BlockLike, toBreak: unknown[]): number;
    clearCollisionIndex(): void;
    updateCollisionIndex(): void;
    getNeighbors(node: unknown): PlacingMove[];
    getScaffoldingItem(): unknown;
    scafoldingBlocks: number[];
  };
  const origGetBlock = mProto.getBlock;

  mProto.getBlock = function (this: PatchedMovements & { getBlock: unknown }, pos, dx, dy, dz) {
    const cache = this.__sliceCache;
    if (!cache || !pos) return origGetBlock.call(this, pos, dx, dy, dz);
    const wx = Math.floor(pos.x) + dx;
    const wy = Math.floor(pos.y) + dy;
    const wz = Math.floor(pos.z) + dz;
    const key = packPos(wx, wy, wz);
    let b = cache.blocks.get(key);
    if (b !== undefined) return b;

    const { tables, bits } = cache;
    const world = this.bot.world;
    if (!tables || !bits || !world) {
      // 没有 registry/world 的非常规 bot:退回原始读块,只保留缓存
      b = origGetBlock.call(this, pos, dx, dy, dz);
      cache.blocks.set(key, b);
      return b;
    }
    const vec = new (Vec3 as new (x: number, y: number, z: number) => { x: number; y: number; z: number })(wx, wy, wz);
    const stateId = world.getBlockStateId(vec) ?? 0;
    if (stateId === 0) {
      // getBlockStateId 对缺列也回 0:必须区分"空气"与"区块没加载"(后者不可走)
      const ck = (wx >> 4) * 0x100000 + (wz >> 4);
      let loaded = cache.chunkKnown.get(ck);
      if (loaded === undefined) {
        loaded = world.getColumn(wx >> 4, wz >> 4) !== undefined;
        cache.chunkKnown.set(ck, loaded);
      }
      if (!loaded) {
        // 与原版缺块兜底逐字一致(height=dy 是相对量,随调用方变,不能缓存)
        return { replaceable: false, canFall: false, safe: false, physical: false, liquid: false, climbable: false, height: dy, openable: false };
      }
    }
    const type = tables.typeId[stateId];
    const tb = bits[type];
    const climbable = (tb & BIT_CLIMB) !== 0;
    const physical = tables.bbBlock[stateId] === 1 && (tb & BIT_FENCE) === 0;
    const built = {
      type,
      name: tables.names[type],
      position: vec,
      shapes: tables.shapes[stateId],
      climbable,
      safe: (tables.bbEmpty[stateId] === 1 || climbable || (tb & BIT_CARPET) !== 0) && (tb & BIT_AVOID) === 0,
      physical,
      replaceable: (tb & BIT_REPLACE) !== 0 && !physical,
      liquid: (tb & BIT_LIQUID) !== 0,
      canFall: (tb & BIT_GRAVITY) !== 0,
      openable: (tb & BIT_OPEN) !== 0,
      height: wy + tables.delta[stateId],
      // 0 = 不是门;非 0 的含义见 DOOR_*。挂在块上是给移动生成器用的(上半扇不许落脚、
      // 斜着不进门框),字段常在于是块的形状稳定,不会因为门而多出一种隐藏类。
      door: tables.doorState[stateId],
    };
    if (built.door !== 0) applyDoorState(built, built.door, wy, this.canOpenDoors === true);
    b = built;
    cache.blocks.set(key, b);
    return b;
  };

  // 空实体索引占了热路径近两成:原版对空索引也逐次拼 `x,y,z` 字符串键去查。
  // 空/非空在 clear/update 时就已确定,空索引直接短路成 0。
  const origGetNumEntitiesAt = mProto.getNumEntitiesAt;
  mProto.getNumEntitiesAt = function (this: PatchedMovements, pos, dx, dy, dz) {
    if (this.__entityIdxEmpty === true) return 0;
    return origGetNumEntitiesAt.call(this, pos, dx, dy, dz);
  };
  const origClearCollisionIndex = mProto.clearCollisionIndex;
  mProto.clearCollisionIndex = function (this: PatchedMovements) {
    origClearCollisionIndex.call(this);
    this.__entityIdxEmpty = true;
  };
  const origUpdateCollisionIndex = mProto.updateCollisionIndex;
  mProto.updateCollisionIndex = function (this: PatchedMovements) {
    origUpdateCollisionIndex.call(this);
    for (const _ in this.entityIntersections) { this.__entityIdxEmpty = false; return; }
    this.__entityIdxEmpty = true;
  };

  // safeToBreak 是纯世界判断(液体邻查 5 次读块),同一堵墙被相邻节点反复评估,按位置记忆化
  const origSafeToBreak = mProto.safeToBreak;
  mProto.safeToBreak = function (this: PatchedMovements, block: BlockLike & { position: { x: number; y: number; z: number } }) {
    const cache = this.__sliceCache;
    // 退避判据带时效,排在记忆化之前:过期之后同一格立刻恢复可挖
    const backoff = this.__digBackoffFn;
    if (backoff && block.position
      && backoff(block.position.x, block.position.y, block.position.z)) return false;
    if (!cache || !block.position) return origSafeToBreak.call(this, block);
    const key = packPos(block.position.x, block.position.y, block.position.z);
    let ok = cache.breakable.get(key);
    if (ok === undefined) {
      ok = origSafeToBreak.call(this, block) as boolean;
      cache.breakable.set(key, ok);
    }
    return ok;
  };

  // 逐字复刻原版 safeOrBreak,仅把「选工具 + digTime → laborCost」按 block.type 记忆化
  mProto.safeOrBreak = function (this: PatchedMovements, block: BlockLike, toBreak: unknown[]) {
    let cost = 0;
    cost += this.exclusionStep(block);
    cost += this.getNumEntitiesAt(block.position, 0, 0, 0) * this.entityCost;
    if (block.safe) return cost;
    if (!this.safeToBreak(block)) return 100;
    toBreak.push(block.position);
    if (block.physical) cost += this.getNumEntitiesAt(block.position, 0, 1, 0) * this.entityCost;

    const cache = this.__sliceCache;
    let labor = cache?.labor.get(block.type);
    if (labor === undefined) {
      // 特征表 POJO 没有 digTime 方法,这里按需物化真 Block(每类型每搜索只走一次)
      const real = (typeof block.digTime === 'function'
        ? block
        : origGetBlock.call(this, block.position as { x: number; y: number; z: number }, 0, 0, 0)) as BlockLike;
      const tool = this.bot.pathfinder.bestHarvestTool(real);
      const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : [];
      const digTime = real.digTime!(tool ? tool.type : null, false, false, false, enchants, this.bot.entity.effects);
      labor = (1 + 3 * digTime / 1000) * this.digCost;
      cache?.labor.set(block.type, labor);
    }
    cost += labor;
    return cost;
  };

  // 上游全库唯一一处 block 对象原地突变在 getMoveJumpUp:`blockC.height += 1`
  // (模拟垫块后的高度)。原版每次 getBlock 都是新实例,改完即弃;有了缓存这个
  // 突变会留在共享实例里越加越高,污染整个搜索。逐字复刻,突变改局部变量。
  type MoveBlock = { physical: boolean; replaceable: boolean; liquid: boolean; height: number; position: { x: number; y: number; z: number } };
  (mProto as unknown as {
    getMoveJumpUp(node: { x: number; y: number; z: number; remainingBlocks: number }, dir: { x: number; z: number }, neighbors: unknown[]): void;
  }).getMoveJumpUp = function (
    this: PatchedMovements & {
      getBlock(pos: unknown, dx: number, dy: number, dz: number): MoveBlock;
      exclusionPlace(block: unknown): number;
      safeOrBreak(block: unknown, toBreak: unknown[]): number;
      placeCost: number;
    },
    node, dir, neighbors,
  ) {
    const blockA = this.getBlock(node, 0, 2, 0);
    const blockH = this.getBlock(node, dir.x, 2, dir.z);
    const blockB = this.getBlock(node, dir.x, 1, dir.z);
    const blockC = this.getBlock(node, dir.x, 0, dir.z);

    let cost = 2; // move cost (move+jump)
    const toBreak: unknown[] = [];
    const toPlace: unknown[] = [];

    if (blockA.physical && this.getNumEntitiesAt(blockA.position, 0, 1, 0) > 0) return;
    if (blockH.physical && this.getNumEntitiesAt(blockH.position, 0, 1, 0) > 0) return;
    if (blockB.physical && !blockH.physical && !blockC.physical && this.getNumEntitiesAt(blockB.position, 0, 1, 0) > 0) return;

    let landHeight = blockC.height; // 原版此处直改 blockC.height,这里用局部量
    if (!blockC.physical) {
      if (node.remainingBlocks === 0) return;
      /* 脚在液体且脚下无实底时禁止生成放置动作；有实底的浅水允许放置。 */
      if (this.getBlock(node, 0, 0, 0).liquid && !this.getBlock(node, 0, -1, 0).physical) return;
      if (this.getNumEntitiesAt(blockC.position, 0, 0, 0) > 0) return;
      const blockD = this.getBlock(node, dir.x, -1, dir.z);
      if (!blockD.physical) {
        if (node.remainingBlocks === 1) return;
        if (this.getNumEntitiesAt(blockD.position, 0, 0, 0) > 0) return;
        if (!blockD.replaceable) {
          if (!this.safeToBreak(blockD)) return;
          cost += this.exclusionBreak(blockD);
          toBreak.push(blockD.position);
        }
        cost += this.exclusionPlace(blockD);
        toPlace.push({ x: node.x, y: node.y - 1, z: node.z, dx: dir.x, dy: 0, dz: dir.z, returnPos: new Vec3(node.x, node.y, node.z) });
        cost += this.placeCost;
      }
      if (!blockC.replaceable) {
        if (!this.safeToBreak(blockC)) return;
        cost += this.exclusionBreak(blockC);
        toBreak.push(blockC.position);
      }
      cost += this.exclusionPlace(blockC);
      toPlace.push({ x: node.x + dir.x, y: node.y - 1, z: node.z + dir.z, dx: 0, dy: 1, dz: 0 });
      cost += this.placeCost;

      landHeight += 1;
    }

    const block0 = this.getBlock(node, 0, -1, 0);
    // 深水中脚下还是水，它的坐标比水面节点低一格；用它量岸高会把
    // 普通一格岸误判为两格跳。游泳起跳面是当前节点高度。
    const takeoffHeight = block0.liquid ? node.y : block0.height;
    if (landHeight - takeoffHeight > 1.2) return;

    cost += this.safeOrBreak(blockA, toBreak);
    if (cost > 100) return;
    cost += this.safeOrBreak(blockH, toBreak);
    if (cost > 100) return;
    cost += this.safeOrBreak(blockB, toBreak);
    if (cost > 100) return;

    neighbors.push(new Move(blockB.position.x, blockB.position.y, blockB.position.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace));
  };

  // 允许从有实底的浅水垫塔上升，并计入 liquidCost。
  // 执行侧 placingBlock.jump 会持续上浮，越过脚格后放置支撑。
  type UpBlock = {
    liquid: boolean; climbable: boolean; replaceable: boolean; physical: boolean;
    height: number; position: { x: number; y: number; z: number };
  };
  (mProto as unknown as {
    getMoveUp(node: { x: number; y: number; z: number; remainingBlocks: number }, neighbors: unknown[]): void;
  }).getMoveUp = function (
    this: PatchedMovements & {
      getBlock(pos: unknown, dx: number, dy: number, dz: number): UpBlock;
      exclusionPlace(block: unknown): number;
      safeOrBreak(block: unknown, toBreak: unknown[]): number;
      allow1by1towers: boolean;
      placeCost: number;
      liquidCost: number;
    },
    node, neighbors,
  ) {
    const block1 = this.getBlock(node, 0, 0, 0);
    if (this.getNumEntitiesAt(node, 0, 0, 0) > 0) return; // 建造位上压着别的实体

    const block2 = this.getBlock(node, 0, 2, 0);

    let cost = 1; // move cost
    const toBreak: unknown[] = [];
    const toPlace: unknown[] = [];
    cost += this.safeOrBreak(block2, toBreak);
    if (cost > 100) return;

    if (!block1.climbable) {
      if (!this.allow1by1towers || node.remainingBlocks === 0) return; // 垫脚方块不够
      if (!block1.replaceable) {
        if (!this.safeToBreak(block1)) return;
        toBreak.push(block1.position);
      }
      const block0 = this.getBlock(node, 0, -1, 0);
      if (block0.physical && block0.height - node.y < -0.2) return; // 半砖上跳不起来
      // 垫脚落点预检(见模块头第 5 条):脚下那一格就是这一放的参照,水里没有面可贴
      if (block1.liquid && !block0.physical) return;
      cost += this.exclusionPlace(block1);
      toPlace.push({ x: node.x, y: node.y - 1, z: node.z, dx: 0, dy: 1, dz: 0, jump: true });
      cost += this.placeCost;
      if (block1.liquid) cost += this.liquidCost;
    }

    if (cost > 100) return;

    neighbors.push(new Move(node.x, node.y + 1, node.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace));
  };

  // 搭桥同样要求脚下有实底；游泳状态下缺少可贴附的支撑面。
  type FwdBlock = {
    physical: boolean; replaceable: boolean; liquid: boolean; safe: boolean;
    openable: boolean; shapes?: number[][]; height: number;
    position: { x: number; y: number; z: number };
    /** 见 DOOR_*;非本模块拼的块(退回原始读块那条)没有这一项 */
    door?: number;
  };
  (mProto as unknown as {
    getMoveForward(node: { x: number; y: number; z: number; remainingBlocks: number }, dir: { x: number; z: number }, neighbors: unknown[]): void;
  }).getMoveForward = function (
    this: PatchedMovements & {
      getBlock(pos: unknown, dx: number, dy: number, dz: number): FwdBlock;
      exclusionStep(block: unknown): number;
      exclusionBreak(block: unknown): number;
      exclusionPlace(block: unknown): number;
      safeOrBreak(block: unknown, toBreak: unknown[]): number;
      canOpenDoors: boolean;
      placeCost: number;
      liquidCost: number;
    },
    node, dir, neighbors,
  ) {
    const blockB = this.getBlock(node, dir.x, 1, dir.z);
    const blockC = this.getBlock(node, dir.x, 0, dir.z);
    const blockD = this.getBlock(node, dir.x, -1, dir.z);

    let cost = 1; // move cost
    cost += this.exclusionStep(blockC);

    const toBreak: unknown[] = [];
    const toPlace: unknown[] = [];

    if (!blockD.physical && !blockC.liquid) {
      if (node.remainingBlocks === 0) return; // not enough blocks to place
      // 垫脚落点预检(见模块头第 5/7 条):搭桥参照脚下那一格,游着没有面可贴
      if (this.getBlock(node, 0, 0, 0).liquid && !this.getBlock(node, 0, -1, 0).physical) return;
      if (this.getNumEntitiesAt(blockD.position, 0, 0, 0) > 0) return; // D intersects an entity hitbox
      if (!blockD.replaceable) {
        if (!this.safeToBreak(blockD)) return;
        cost += this.exclusionBreak(blockD);
        toBreak.push(blockD.position);
      }
      cost += this.exclusionPlace(blockC);
      toPlace.push({ x: node.x, y: node.y - 1, z: node.z, dx: dir.x, dy: 0, dz: dir.z });
      cost += this.placeCost; // additional cost for placing a block
    }

    cost += this.safeOrBreak(blockB, toBreak);
    if (cost > 100) return;

    // Open fence gates
    if (this.canOpenDoors && blockC.openable && blockC.shapes && blockC.shapes.length !== 0) {
      toPlace.push({ x: node.x + dir.x, y: node.y, z: node.z + dir.z, dx: 0, dy: 0, dz: 0, useOne: true });
    } else {
      cost += this.safeOrBreak(blockC, toBreak);
      if (cost > 100) return;
    }

    if (this.getBlock(node, 0, 0, 0).liquid) cost += this.liquidCost;

    // 门的上半扇只当头顶净空,不能当落脚格:那一格的地板正是下半扇门,踩上去等于
    // 站在门里。applyDoorState 把两半都标成可穿过(否则 blockB 会被算成要挖的墙),
    // 落脚这一头就必须在这里挡住,不然 A* 会生出"顺着门爬上去"的假路。
    if (((blockC.door ?? 0) & DOOR_UPPER) !== 0) return;

    neighbors.push(new Move(blockC.position.x, blockC.position.y, blockC.position.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace));
  };

  /**
   * 斜着不进门框。
   *
   * getMoveDiagonal 里没有 useOne 那条分支(上游只给 getMoveForward 写了开门),
   * 而 applyDoorState 把关着的木门也标成了"可穿过" —— 两下一凑,A* 会生出一条
   * 斜着穿过关着的门的路,走到那儿门还关着,人就撞在门板上。开着的门也一样按
   * 正面进:开门后的碰撞盒占着边上 3/16 格,斜切进去会刮在门板上。
   *
   * 门口本来就该正面进,绕成"先站到门正前方"只多 1 格代价。
   */
  const origGetMoveDiagonal = (mProto as unknown as {
    getMoveDiagonal(node: unknown, dir: unknown, neighbors: unknown[]): void;
  }).getMoveDiagonal;
  (mProto as unknown as {
    getMoveDiagonal(node: unknown, dir: unknown, neighbors: unknown[]): void;
  }).getMoveDiagonal = function (
    this: PatchedMovements & {
      getBlock(pos: unknown, dx: number, dy: number, dz: number): { door?: number };
    },
    node, dir, neighbors,
  ) {
    const before = neighbors.length;
    origGetMoveDiagonal.call(this, node, dir, neighbors);
    for (let i = neighbors.length - 1; i >= before; i--) {
      const mv = neighbors[i] as { x: number; y: number; z: number };
      if (((this.getBlock(mv, 0, 0, 0).door ?? 0) & DOOR_KIND) !== 0) neighbors.splice(i, 1);
    }
  };

  /**
   * 禁垫区(见模块头第 6 条)在**候选移动**这一层筛,不在各 getMoveX 里逐个判:
   * 上游有五处 `toPlace.push`,分散在四个生成器里,而 `exclusionAreasPlace` 这个
   * 上游钩子在 getMoveForward 里传的是落点上面那一格(blockC),按包围盒判会漏掉
   * 贴着区顶那一层的搭路。落点一律是"参照方块 + 面向量",在这里算得准且只算一次。
   */
  const origGetNeighbors = mProto.getNeighbors;
  mProto.getNeighbors = function (
    this: PatchedMovements & {
      getBlock(pos: { x: number; y: number; z: number } | null, dx: number, dy: number, dz: number): { physical: boolean; name?: string };
      bot: { placeMisses?: Array<{ was: string; x: number; y: number; z: number; at?: number }> };
    },
    node,
  ) {
    const moves = origGetNeighbors.call(this, node);
    const zones = this.__siteZones;
    const noPlace = this.__noPlaceFn;
    // 服务端刚三连拒过的放置,同格同块短期内还会拒:进搜索黑名单,逼 A* 换条路
    // (没有这条,drop 目标 → 重算 → 又选中同一个最便宜的放置,循环一整个小时)
    const now = Date.now();
    let misses: Map<string, string> | null = null;
    for (const miss of this.bot?.placeMisses ?? []) {
      if (miss.at === undefined || now - miss.at > PLACE_MISS_TTL_MS) continue;
      (misses ??= new Map()).set(`${miss.x},${miss.y},${miss.z}`, miss.was);
    }
    if ((zones === null || zones === undefined || zones.length === 0) && !noPlace && !misses) return moves;
    return moves.filter((mv) => {
      // 注意这里不做"参照格必须实心"的静态预检:A* 的跨步放置合法地踩在
      // 前几步刚垫的块上,搜索时世界里那一格还是水/空气(垫塔第二步的参照
      // 就是第一步的落点)。执行必败的那几类由各生成器的点 5 预检按语义挡。
      for (const p of mv.toPlace ?? []) {
        if (p.useOne === true) continue;
        const [x, y, z] = [p.x + p.dx, p.y + p.dy, p.z + p.dz];
        // 落点自己在成果登记上、或它正压在一格登记的东西头顶,两种都不生成这个放置
        if (zones !== null && zones !== undefined && zones.length > 0 && inZones(zones, x, y, z)) return false;
        if (noPlace !== null && noPlace !== undefined && (noPlace(x, y, z) || noPlace(x, y - 1, z))) return false;
        if (misses) {
          const was = misses.get(`${x},${y},${z}`);
          // 那一格还是被拒时的那种方块 → 同一结局;世界变过了就放行重试
          if (was !== undefined && this.getBlock({ x, y, z }, 0, 0, 0).name === was) return false;
        }
      }
      return true;
    });
  };

  /**
   * 工地建材在垫脚候选中排最后，背包只剩建材时仍可使用。
   * 上游按 scafoldingBlocks 顺序选物品，此处临时重排优先级。
   */
  const origGetScaffoldingItem = mProto.getScaffoldingItem;
  mProto.getScaffoldingItem = function (this: PatchedMovements & {
    getScaffoldingItem(): unknown; scafoldingBlocks: number[];
  }) {
    const zones = this.__siteZonesFn?.();
    if (!zones || zones.length === 0) return origGetScaffoldingItem.call(this);
    const byName = (this.bot.registry as { itemsByName?: Record<string, { id: number } | undefined> } | undefined)
      ?.itemsByName;
    if (!byName) return origGetScaffoldingItem.call(this);
    const last = new Set<number>();
    for (const zone of zones) for (const name of zone.materials) {
      const id = byName[name]?.id;
      if (id !== undefined) last.add(id);
    }
    if (last.size === 0) return origGetScaffoldingItem.call(this);
    const saved = this.scafoldingBlocks;
    this.scafoldingBlocks = [...saved.filter((id) => !last.has(id)), ...saved.filter((id) => last.has(id))];
    try {
      return origGetScaffoldingItem.call(this);
    } finally {
      this.scafoldingBlocks = saved;
    }
  };

  const aProto = (AStar as unknown as { prototype: { compute(): unknown; movements: unknown } }).prototype;
  const origCompute = aProto.compute;
  aProto.compute = function (this: { movements: PatchedMovements; __searchCache?: SliceCache }) {
    // 缓存随单次搜索生老病死:pathfinder 对相关方块变化本就整个重开搜索(新 AStar),
    // 旧缓存跟着旧搜索一起被丢;compute 之外(路径跟随)读到的永远是新鲜世界。
    if (!this.__searchCache) {
      const m = this.movements;
      const tables = m.bot.registry && m.bot.world ? tablesFor(m.bot.registry) : null;
      this.__searchCache = {
        blocks: new Map(),
        labor: new Map(),
        breakable: new Map(),
        tables,
        bits: tables ? buildBits(m, tables.maxType) : null,
        chunkKnown: new Map(),
        zones: m.__siteZonesFn?.() ?? null,
      };
    }
    this.movements.__sliceCache = this.__searchCache;
    this.movements.__siteZones = this.__searchCache.zones;
    try {
      return origCompute.call(this);
    } finally {
      this.movements.__sliceCache = null;
      this.movements.__siteZones = null;
    }
  };

  log?.info('寻路性能补丁已装上:特征表读块 + 搜索级缓存 + 挖掘成本记忆化');
}
