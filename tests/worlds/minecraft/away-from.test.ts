/**
 * 逃跑方向的退化输入。
 *
 * 由来(实测 2026-10-03 00:09:13):`antiLava` 里危险格列表只扫 `BURNING_BLOCKS`,而
 * `hazardTouch` 有一条"脚下是灼热地面"的兜底 —— 于是"整个人站在岩浆块上"时
 * `hazards` 为空、`hazard` 有值,`dashAway` 的 `pool` 跟着为空,空数组的平均是 `0/0 = NaN`,
 * 瞄点变成 `(NaN, …, NaN)`,`bot.lookAt(NaN, …)` 把朝向写成 NaN,后者再被
 * `prismarine-physics` 拿去把位置也算坏 —— 服务端 30 秒 `Timed out` 踢人。
 *
 * 修法有两道:antiLava 保证把当前那个危险格并进列表;dashAway 的 pool 为空时退化成
 * "朝正北冲"而不是算 NaN。这里钉的是**第二道**:无论输入多退化,瞄点都必须是有限的。
 */
import { describe, expect, it } from 'vitest';
import { awayFrom } from '../../../src/worlds/minecraft/executor.ts';

const finite = (v: { x: number; y: number; z: number }) =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

describe('awayFrom', () => {
  it('正常输入:背对危险格走出 6 格', () => {
    const aim = awayFrom({ x: 0, y: 64, z: 0 }, { x: -2, y: 63, z: 0 });
    expect(finite(aim)).toBe(true);
    expect(aim.x).toBeGreaterThan(0); // 危险格在西边,就往东
    expect(aim.y).toBeCloseTo(65.6, 6); // p.y + 1.6
  });

  it('人正好在危险格中心:没有方向可言,也必须是有限瞄点', () => {
    // 危险格 (0,63,0) 的中心是 (0.5, …, 0.5);人站在那儿时 dx=dz=0、len=0
    const aim = awayFrom({ x: 0.5, y: 64, z: 0.5 }, { x: 0, y: 63, z: 0 });
    expect(finite(aim)).toBe(true);
  });

  it('危险格与人在同一点上:方向退化,但瞄点仍然有限且离人 6 格', () => {
    // pool 为空时 center 取 p 自己,经 awayFrom 就是"危险格中心 = 人所在处"这一种输入
    const p = { x: 5, y: -59, z: 36 };
    const aim = awayFrom(p, { x: p.x, y: p.y, z: p.z });
    expect(finite(aim)).toBe(true);
    expect(Math.hypot(aim.x - p.x, aim.z - p.z)).toBeCloseTo(6, 6); // 水平走出去 6 格
    expect(aim.y).toBeCloseTo(-57.4, 6); // p.y + 1.6
  });
});
