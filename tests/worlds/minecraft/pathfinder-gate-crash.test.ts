/**
 * 开门是一步路里的最后一件放置活:开完 `placing` 归位,`physicsTick` 的监听不抛出。
 * 从这个监听里抛出的异常没有 catch 接,引擎子进程按 uncaughtException 退出。
 *
 * 上游在 `activateBlock` 成功后把 `placingBlock` 赋成 `nextPoint.toPlace.shift()`。
 * 门是 `toPlace` 里最后一项,shift 回 `undefined`,而 `placing` 仍为 true,下一刻
 * 读 `placingBlock.y`。
 *
 * 读得到那一行还要求包里有垫脚料。没有时 `getScaffoldingItem()` 返回空,
 * `resetPath('no_scaffolding_blocks')` 先清掉 `placing`。台架的包里放土。
 *
 * `placing` 与 `placingBlock` 都在 `inject` 闭包里,bot 面上取不到,只能改包:
 * patches/mineflayer-pathfinder@2.4.5.patch。台架装真 `inject`,只换 `getPathTo`。
 */
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

/** 台架目标:永远有效、从不移动、永远没到,monitorMovement 每刻都走完整条 */
const goal = {
  isValid: (): boolean => true,
  hasChanged: (): boolean => false,
  isEnd: (): boolean => false,
};

/**
 * 只带一步的路,这一步要先开门。`toPlace` 里就这一项,和 `getMoveForward` 开门那一支
 * 给出的形状一样:开完这一项,数组就空了。
 */
function pathWithGate(): unknown[] {
  return [{
    x: 0,
    y: 64,
    z: 0,
    dx: 0,
    dy: 1,
    dz: 0,
    jump: false,
    toBreak: [] as unknown[],
    toPlace: [{ x: 0, y: 65, z: 1, dx: 0, dy: 0, dz: 0, useOne: true }],
  }];
}

interface Rig {
  bot: EventEmitter & { pathfinder: PathfinderFace };
  /** activateBlock 被调了几次(= 门被开了几次) */
  openCalls: () => number;
  /** 这一步的 toPlace 里还剩几件活 */
  placesPending: () => number;
  /** 走一个物理刻,并把这一刻挂出去的 promise 链全部跑完 */
  tick: () => Promise<void>;
}

function rig(): Rig {
  const stone = PBlock.fromStateId(mcData.blocksByName.stone.defaultState, 0);
  // 垫脚料。没有它 getScaffoldingItem() 返回空,resetPath 会先一步清掉 placing
  const dirtItem = { name: 'dirt', type: mcData.itemsByName.dirt.id, count: 64, slot: 36 };

  let opens = 0;

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
    async equip(): Promise<void> {},
    async placeBlock(): Promise<void> {},
    async dig(): Promise<void> {},
    stopDigging(): void {},
    async activateBlock(): Promise<void> {
      opens += 1;
    },
  });

  inject(bot);
  const pf = (bot as unknown as { pathfinder: PathfinderFace }).pathfinder;
  // 只换"这一步给什么路";postProcessPath / A* 都绕开,台架不需要真地形。
  // 交出去的就是这一份,上游 shift 的也是这一份,剩几件活从它身上读
  const path = pathWithGate() as Array<{ toPlace: unknown[] }>;
  pf.getPathTo = () => ({ status: 'success', path });
  pf.setGoal(goal);

  return {
    bot: bot as unknown as EventEmitter & { pathfinder: PathfinderFace },
    openCalls: () => opens,
    placesPending: () => path[0].toPlace.length,
    async tick(): Promise<void> {
      bot.emit('physicsTick');
      // activateBlock 的 then 链要跑完,placingBlock 才会被改成 undefined
      for (let i = 0; i < 8; i++) await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe('寻路器开门:开完之后 placingBlock 为 undefined,physicsTick 的监听不抛出', () => {
  it('开门那一刻之后再走一刻不抛异常', async () => {
    const r = rig();

    await r.tick();
    expect(r.openCalls()).toBe(1);
    expect(r.bot.pathfinder.isBuilding()).toBe(true);

    // 没打补丁的版本在这一刻抛 TypeError,emit 同步往外抛
    await expect(r.tick()).resolves.toBeUndefined();
  });

  it('开完门这一步没有放置活了:placing 归位,门只开一次', async () => {
    const r = rig();

    await r.tick();
    await r.tick();

    // 放置分支的入口条件是 `placing || nextPoint.toPlace.length > 0`,两边都空了,
    // 后面每一刻都直接走路去,不会再回到这一支(也就不会再开一次门)
    expect(r.bot.pathfinder.isBuilding()).toBe(false);
    expect(r.placesPending()).toBe(0);
    expect(r.openCalls()).toBe(1);
  });
});
