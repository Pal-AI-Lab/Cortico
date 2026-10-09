/**
 * 寻路器搭路支撑的 `lockEquipItem` 不得因 equip 失败而永久上锁。
 *
 * 上游 `mineflayer-pathfinder/index.js:546-572` 的放置支撑分支写成:
 *
 * ```js
 * if (!lockEquipItem.tryAcquire()) return
 * bot.equip(block, 'hand')
 *   .then(function () { lockEquipItem.release(); ...真正的放置... })
 *   .catch(_ignoreError => {})
 * ```
 *
 * `release()` 只写在 fulfilled 那一支。equip 一旦失败(垫脚料刚用完、窗口忙、槽位
 * 正在交换),锁就永远留在 true 上:此后每一个物理刻都在 `tryAcquire()` 处掉头,
 * `placing` 也没人清,而这一支的 `return`(index.js:573)在**自愈用的 futility 检查
 * (index.js:631-634 `resetPath('stuck')`)之前**——那条自愈路径根本跑不到。
 * 结果是有目标、有路径、零位移,一直挂到外面某处主动 `resetPath` 为止。
 *
 * 三把锁都是 `inject` 闭包里的 `new Lock()`,bot 面上没有任何出口(`isBuilding()`
 * 读得到 `placing`,读不到锁),所以 mineflayer-fixes 那一层从外面补不了,只能改包。
 * 补丁在 src/worlds/minecraft/dependency-patches.ts,编译前改写源码。
 *
 * 这一组不 stub pathfinder:装的是真 `inject`,喂真 minecraft-data 的方块与物品,
 * 只把"这一步给什么路"(`getPathTo`)和"equip 成不成"换成台架。断言落在**行为**上——
 * equip 失败之后下一刻还会不会再试——因为锁本身在闭包里,断不到。
 */
import '../../../src/worlds/minecraft/dependency-patches.ts';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
// minecraft-data / prismarine-block 不是本仓库的直接依赖,只能顺着 mineflayer 的解析根找
const mfRequire = createRequire(require_.resolve('mineflayer'));

/** 服务端与执行器都钉在这一版 */
const MC_VERSION = '1.20.6';

const mcData = mfRequire('minecraft-data')(MC_VERSION) as {
  blocksByName: Record<string, { id: number; defaultState: number }>;
  itemsByName: Record<string, { id: number }>;
};
const PBlock = mfRequire('prismarine-block')(MC_VERSION) as {
  fromStateId(stateId: number, biomeId: number): { name: string; type: number; position?: unknown };
};
const { Vec3 } = mfRequire('vec3') as {
  Vec3: new (x: number, y: number, z: number) => Vec3Like;
};
const { pathfinder: inject } = require_('mineflayer-pathfinder') as {
  pathfinder: (bot: unknown) => void;
};

interface Vec3Like {
  x: number; y: number; z: number;
  floored(): Vec3Like;
  clone(): Vec3Like;
  offset(dx: number, dy: number, dz: number): Vec3Like;
  distanceTo(o: Vec3Like): number;
  distanceSquared(o: Vec3Like): number;
}

interface PathfinderFace {
  isBuilding(): boolean;
  isMining(): boolean;
  isMoving(): boolean;
  setGoal(goal: unknown, dynamic?: boolean): void;
  getPathTo(movements: unknown, goal: unknown): unknown;
  LOSWhenPlacingBlocks: boolean;
}

/** 台架目标:永远有效、从不移动、永远没到 —— 让 monitorMovement 每刻都走完整条 */
const goal = {
  isValid: (): boolean => true,
  hasChanged: (): boolean => false,
  isEnd: (): boolean => false,
};

/**
 * 一格待搭的支撑。`dy = 1`(从下面那一格的上表面放)让上游的 LOS 分支
 * (`placingBlock.dy === 0`)不成立,免得台架还要模拟走到边缘的那一整套。
 */
function scaffoldStep() {
  return {
    x: 0,
    y: 64,
    z: 0,
    dx: 0,
    dy: 1,
    dz: 0,
    jump: false,
    toBreak: [] as unknown[],
    toPlace: [] as unknown[],
  };
}

/** 只带一步的路:那一步要先搭一块支撑 */
function pathWithScaffold(): unknown[] {
  const step = scaffoldStep();
  step.toPlace = [{ x: 0, y: 64, z: 0, dx: 0, dy: 1, dz: 0, jump: false }];
  return [step];
}

interface Rig {
  bot: EventEmitter & { pathfinder: PathfinderFace };
  /** equip 被调了几次(= 支撑分支真正开了几次工) */
  equipCalls: () => number;
  /** placeBlock 被调了几次 */
  placeCalls: () => number;
  /** 让接下来的 equip 成功 */
  letEquipSucceed: () => void;
  /** 走一个物理刻,并把这一刻挂出去的 promise 链全部跑完 */
  tick: () => Promise<void>;
}

function rig(): Rig {
  const stone = PBlock.fromStateId(mcData.blocksByName.stone.defaultState, 0);
  const dirtItem = { name: 'dirt', type: mcData.itemsByName.dirt.id, count: 64, slot: 36 };

  let equipFails = true;
  let equips = 0;
  let places = 0;

  const bot = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(bot, {
    registry: mcData,
    entity: {
      position: new Vec3(0.5, 65, 0.5),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      isInWater: false,
      effects: {},
    },
    controlState: {
      forward: false, back: false, left: false, right: false,
      jump: false, sprint: false, sneak: false,
    },
    heldItem: null,
    inventory: { hotbarStart: 36, items: () => [dirtItem] },
    blockAt(pos: Vec3Like) {
      const copy = Object.assign(
        Object.create(Object.getPrototypeOf(stone) as object) as { position?: unknown },
        stone,
      );
      copy.position = pos.clone();
      return copy;
    },
    setControlState(name: string, value: boolean): void {
      (bot.controlState as Record<string, boolean>)[name] = value;
    },
    clearControlStates(): void {
      for (const k of Object.keys(bot.controlState as Record<string, boolean>)) {
        (bot.controlState as Record<string, boolean>)[k] = false;
      }
    },
    look(): void {},
    lookAt(): void {},
    async equip(): Promise<void> {
      equips += 1;
      if (equipFails) throw new Error('槽位正在交换,这一次 equip 没成');
    },
    async placeBlock(): Promise<void> {
      places += 1;
    },
    async dig(): Promise<void> {},
    stopDigging(): void {},
    async activateBlock(): Promise<void> {},
  });

  inject(bot);
  const pf = (bot as unknown as { pathfinder: PathfinderFace }).pathfinder;
  // 只换"这一步给什么路";postProcessPath / A* 都绕开,台架不需要真地形
  pf.getPathTo = () => ({ status: 'success', path: pathWithScaffold() });
  pf.setGoal(goal);

  return {
    bot: bot as unknown as EventEmitter & { pathfinder: PathfinderFace },
    equipCalls: () => equips,
    placeCalls: () => places,
    letEquipSucceed: () => { equipFails = false; },
    async tick(): Promise<void> {
      bot.emit('physicsTick');
      // equip / placeBlock 的 then 链要跑完才看得到锁的归属
      for (let i = 0; i < 8; i++) await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe('寻路器搭路支撑:equip 失败不得把 lockEquipItem 永久锁住', () => {
  it('第一次 equip 失败之后,后面每一刻都还会再试(锁被释放了)', async () => {
    const r = rig();

    await r.tick();
    // 第一刻:进入放置分支,拿到锁,equip 抛错
    expect(r.equipCalls()).toBe(1);
    expect(r.bot.pathfinder.isBuilding()).toBe(true);

    // 泄漏版在这里永远停在 1:tryAcquire 失败即 return,而这个 return 在
    // futility 自愈检查之前,没有任何东西会把它救回来
    await r.tick();
    await r.tick();
    await r.tick();
    expect(r.equipCalls()).toBe(4);
  });

  it('equip 恢复正常之后这一段路自己走得下去(放置真的发生了)', async () => {
    const r = rig();

    await r.tick();
    await r.tick();
    expect(r.placeCalls()).toBe(0);

    r.letEquipSucceed();
    await r.tick();

    expect(r.equipCalls()).toBe(3);
    expect(r.placeCalls()).toBe(1);
    // 放置走完,placing 归位;泄漏版永远卡在 true 上
    expect(r.bot.pathfinder.isBuilding()).toBe(false);
  });

  it('equip 一直失败也不会把 placing 卡死在别人看不见的地方:每刻都在重试', async () => {
    const r = rig();
    for (let i = 0; i < 10; i++) await r.tick();
    expect(r.equipCalls()).toBe(10);
    expect(r.placeCalls()).toBe(0);
    expect(r.bot.pathfinder.isBuilding()).toBe(true);
  });
});
