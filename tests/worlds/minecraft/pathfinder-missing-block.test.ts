/**
 * 挖方块那一格已经从世界里消失时(区块卸载),选工具这一步不再抛异常。
 *
 * `monitorMovement` 挖方块前先 `bot.blockAt()` 取那一格,再交给 `bestHarvestTool`;
 * 区块卸载之后 `blockAt` 返回 null,而选工具要读 `block.digTime`。契约:
 * `bestHarvestTool(null)` 回报 null(不换手,与空手同一语义);上游随后的 `bot.dig(null)`
 * 立即 reject,由上游 catch 走 `resetPath('dig_error')`。
 *
 * 台架装真 `inject`,只换 `getPathTo`;`physicsTick` 上没有 catch,这里的异常会一路抛出去。
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { installPathfinderToolSelection } from '../../../src/worlds/minecraft/mineflayer-fixes.ts';

const require_ = createRequire(import.meta.url);
const mfRequire = createRequire(require_.resolve('mineflayer'));

const MC_VERSION = '1.20.6';

const mcData = mfRequire('minecraft-data')(MC_VERSION) as {
  itemsByName: Record<string, { id: number }>;
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

/** 要挖的那一格,区块已卸载,`blockAt` 对它给 null */
const MISSING = { x: 11, y: 64, z: 10 };
/** 人站的地方,已经在那一格西边一格:不必先走过去 */
const ME = { x: 10.5, y: 64, z: 10.5 };

/** 一步挖方块:落脚格就是当前这格,`toBreak` 里是那个已经取不到的坐标 */
function digStep(): unknown {
  return {
    x: ME.x, y: ME.y, z: ME.z, dx: 0, dy: 0, dz: 0, jump: false,
    toPlace: [] as unknown[],
    toBreak: [{ x: MISSING.x, y: MISSING.y, z: MISSING.z, dx: 1, dy: 0, dz: 0 }],
  };
}

/** 返回推进一个物理节拍的函数 */
function rig(): () => Promise<void> {
  const pickaxe = {
    name: 'diamond_pickaxe', type: mcData.itemsByName.diamond_pickaxe.id, count: 1, slot: 36,
  };
  const bot = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(bot, {
    registry: mcData,
    entity: {
      position: new Vec3(ME.x, ME.y, ME.z),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      isInWater: false,
      effects: {},
    },
    controlState: {
      forward: false, back: false, left: false, right: false,
      jump: false, sprint: false, sneak: false,
    },
    heldItem: pickaxe,
    inventory: { hotbarStart: 36, items: () => [pickaxe] },
    blockAt: () => null,
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
  });

  inject(bot);
  installPathfinderToolSelection(
    bot as never,
    { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never,
  );
  const pf = (bot as unknown as { pathfinder: PathfinderFace }).pathfinder;
  pf.getPathTo = () => ({ status: 'success', path: [digStep()] });
  pf.setGoal(goal);

  return async (): Promise<void> => {
    bot.emit('physicsTick');
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  };
}

describe('挖方块那一格区块已卸载', () => {
  it('物理节拍照常挖,不把异常抛出物理节拍', async () => {
    const tick = rig();
    await expect(tick()).resolves.toBeUndefined();
  });
});
