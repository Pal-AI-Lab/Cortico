/**
 * 爬坎垫块之后的回位点(`returningPos`)只属于垫它的那条路。
 *
 * 带 `returnPos` 的放置只有一种:`getMoveJumpUp` 往上跳一格、落脚格和它下面都空着时,
 * 先垫下面那格(这一块带回位点),再垫落脚格。第一块放成之后
 * `monitorMovement` 每刻先朝回位点走,没回到(水平 0.2 格内)就 return,不算路、不垫块。
 * 换目标或停下时回位点作废;判到达只比水平距离,人在回位格上方浮着也算回到位。
 *
 * `returningPos` 在 `inject` 闭包里,只能改包:patches/mineflayer-pathfinder@2.4.5.patch。
 * 台架装真 `inject`,只换 `getPathTo`。
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
  fromStateId(stateId: number, biomeId: number): { name: string; position?: unknown };
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
  setGoal(goal: unknown, dynamic?: boolean): void;
  getPathTo(movements: unknown, goal: unknown): unknown;
}

/** 永远有效、从不移动、永远没到:monitorMovement 每刻都走完整条 */
const goal = {
  isValid: (): boolean => true,
  hasChanged: (): boolean => false,
  isEnd: (): boolean => false,
};

/** 回位点所在的格;要爬上去的那一列在它东边一格,上下两格都空着 */
const NODE = { x: 10, y: 64, z: 10 };

/** 一步爬坎:和 getMoveJumpUp 落脚格与它下面都空着那一支给出的形状一样 */
function climbStep(): unknown {
  return {
    x: NODE.x + 1, y: NODE.y + 1, z: NODE.z, dx: 1, dy: 1, dz: 0, jump: false,
    toBreak: [] as unknown[],
    toPlace: [
      {
        x: NODE.x, y: NODE.y - 1, z: NODE.z, dx: 1, dy: 0, dz: 0,
        returnPos: new Vec3(NODE.x, NODE.y, NODE.z),
      },
      { x: NODE.x + 1, y: NODE.y - 1, z: NODE.z, dx: 0, dy: 1, dz: 0 },
    ],
  };
}

interface Rig {
  bot: EventEmitter & {
    pathfinder: PathfinderFace;
    entity: { position: Vec3Like };
    controlState: Record<string, boolean>;
  };
  /** getPathTo 被调了几次 = 寻路器算过几次路(按调用次数断言的就是这件事) */
  plans: () => number;
  places: () => number;
  /** 朝回位格中心 lookAt 了几次:回位那一支每刻都朝它看,别的分支不看它 */
  looksAtReturn: () => number;
  /** 清空交给寻路器的那条路,等于这一步已经走完;回位之后就不进走路那一支 */
  finishPath: () => void;
  tick: () => Promise<void>;
}

function rig(): Rig {
  const stone = PBlock.fromStateId(mcData.blocksByName.stone.defaultState, 0);
  const dirtItem = { name: 'dirt', type: mcData.itemsByName.dirt.id, count: 64, slot: 36 };
  let plans = 0;
  let places = 0;
  let looksAtReturn = 0;

  const bot = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(bot, {
    registry: mcData,
    entity: {
      // moveToEdge 要人在缺口那格中心 0.4 格内才垫
      position: new Vec3(NODE.x + 1.3, NODE.y, NODE.z + 0.5),
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
    lookAt(p: Vec3Like): void {
      if (p.x === NODE.x + 0.5 && p.y === NODE.y && p.z === NODE.z + 0.5) looksAtReturn += 1;
    },
    async equip(): Promise<void> {},
    async placeBlock(): Promise<void> {
      places += 1;
    },
    async dig(): Promise<void> {},
    stopDigging(): void {},
  });

  inject(bot);
  const pf = (bot as unknown as { pathfinder: PathfinderFace }).pathfinder;
  // 上游直接持有这一份数组(path = results.path),清空它就是清空寻路器手上的路
  const handed: unknown[] = [];
  let first = true;
  pf.getPathTo = () => {
    plans += 1;
    // 第一次给爬坎那一步,之后给空路:只数算没算,不让它走
    if (!first) return { status: 'noPath', path: [] };
    first = false;
    handed.push(climbStep());
    return { status: 'success', path: handed };
  };
  pf.setGoal(goal);

  return {
    bot: bot as unknown as Rig['bot'],
    plans: () => plans,
    places: () => places,
    looksAtReturn: () => looksAtReturn,
    finishPath: () => { handed.length = 0; },
    async tick(): Promise<void> {
      bot.emit('physicsTick');
      for (let i = 0; i < 8; i++) await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    },
  };
}

/** 走到第一块垫成、回位点已经立起来 */
async function bridged(): Promise<Rig> {
  const r = rig();
  await r.tick();
  expect(r.places()).toBe(1);
  expect(r.plans()).toBe(1);
  return r;
}

describe('爬坎垫块后的回位点', () => {
  it('人被挪走回不去,换了目标之后照常算路,不再朝旧回位点走', async () => {
    const r = await bridged();
    // 离回位点几百格(被传送走了):按住前进也到不了
    r.bot.entity.position = new Vec3(-300.5, 64, 10.5);
    await r.tick();
    expect(r.looksAtReturn()).toBe(1);
    const plans = r.plans();

    r.bot.pathfinder.setGoal(goal);
    await r.tick();
    await r.tick();

    expect(r.plans()).toBe(plans + 1);
    expect(r.looksAtReturn()).toBe(1);
  });

  it('人在回位格正上方浮着(高出 0.8 格)算回到位,不再朝回位点走', async () => {
    const r = await bridged();
    r.finishPath();
    r.bot.entity.position = new Vec3(NODE.x + 0.5, NODE.y + 0.8, NODE.z + 0.5);
    await r.tick();
    await r.tick();
    await r.tick();

    expect(r.looksAtReturn()).toBe(0);
  });
});
