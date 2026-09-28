import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { holdTreadWater, installTreadWater } from '../../../src/worlds/minecraft/travel.ts';
import { V } from './executor-harness.ts';

/**
 * 踩水台架:y ≤ 59 是石头,60–64 是水(五格深),人悬在 62.3,脚下与头都泡着。
 * 寻路器只留 isMoving 和它推给监听的路点;jump 最后一次写进去的值就是这一刻按没按。
 */
function swimmer() {
  const bot = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let moving = false;
  const controls: Record<string, boolean> = {};
  Object.assign(bot, {
    entity: { position: new V(10.5, 62.3, 10.5) },
    vehicle: null,
    targetDigBlock: null,
    pathfinder: { isMoving: () => moving },
    blockAt(p: V) {
      const y = Math.floor(p.y);
      const name = y <= 59 ? 'stone' : y <= 64 ? 'water' : 'air';
      return { name, boundingBox: name === 'stone' ? 'block' : 'empty' };
    },
    setControlState(k: string, v: boolean) { controls[k] = v; },
  });
  installTreadWater(bot as never);
  return {
    bot,
    jump: () => controls.jump ?? false,
    setMoving: (m: boolean) => { moving = m; },
    tick: () => { bot.emit('physicsTick'); },
    path: (p: unknown[]) => { bot.emit('path_update', { path: p }); },
  };
}

describe('installTreadWater', () => {
  it('泡在水里、寻路器没在走:按住跳,不往下沉', () => {
    const r = swimmer();
    r.tick();
    expect(r.jump()).toBe(true);
  });

  it('寻路器有目标但还在算路(没有路点):照样踩水', () => {
    const r = swimmer();
    r.setMoving(true);
    r.path([]);
    r.tick();
    expect(r.jump()).toBe(true);
  });

  it('寻路器停下来挖这个路点要挖的方块:照样踩水,不沉到够不着', () => {
    const r = swimmer();
    r.setMoving(true);
    r.path([{ x: 11, y: 62, z: 10, toBreak: [{ x: 11, y: 63, z: 10 }], toPlace: [] }]);
    r.tick();
    expect(r.jump()).toBe(true);
  });

  it('寻路器照着纯走动的路点往下走:让位并松开跳,下得去', () => {
    const r = swimmer();
    r.tick();
    r.setMoving(true);
    r.path([{ x: 11, y: 61, z: 10, toBreak: [], toPlace: [] }]);
    r.tick();
    expect(r.jump()).toBe(false);
  });

  it('这一步点名的格泡在水下:不踩水,人才待得住', () => {
    const r = swimmer();
    const release = holdTreadWater(r.bot as never, { x: 10, y: 61, z: 10 });
    r.tick();
    expect(r.jump()).toBe(false);
    release();
    r.tick();
    expect(r.jump()).toBe(true);
  });
});
