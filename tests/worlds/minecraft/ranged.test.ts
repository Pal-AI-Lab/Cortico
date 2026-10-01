import { describe, expect, it } from 'vitest';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import {
  BOW_HIT_WINDOW_MS,
  HYBRID_MELEE_AT,
  RANGED_ENTER_RANGE,
  RANGED_EXIT_RANGE,
  BowController,
  PositionVelocityTracker,
  bestRangedWeapon,
  cellTarget,
  chooseHybridWeapon,
  hasRangedLos,
  hasUsableArrows,
  inKiteRange,
  lowArcAimPoint,
  rangedTargetDistance,
  type BowAbortCause,
  type BowEvent,
  type RangedTarget,
} from '../../../src/worlds/minecraft/ranged.ts';

interface FakeItem {
  name: string;
  count: number;
  type: number;
  nbt?: unknown;
}

function item(name: string, count = 1, damage = 0): FakeItem {
  const types: Record<string, number> = { bow: 261, arrow: 262, stone: 1, dirt: 3 };
  return {
    name,
    count,
    type: types[name] ?? 500,
    nbt: damage === 0 ? undefined : { value: { Damage: { value: damage } } },
  };
}

function target(distance = 20): RangedTarget {
  return {
    id: 7,
    position: new Vec3(distance, 64, 0),
    height: 1.8,
    width: 0.6,
  };
}

interface RigOptions {
  bag?: FakeItem[];
  distance?: number;
  hotbar?: Array<FakeItem | null>;
}

function rig(opts: RigOptions = {}) {
  const bag = opts.bag ?? [item('bow'), item('arrow', 16)];
  const hotbarStart = 36;
  const slots: Array<FakeItem | null> = Array(45).fill(null);
  for (const [slot, entry] of (opts.hotbar ?? []).entries()) slots[hotbarStart + slot] = entry;
  let quickBarSlot = 0;
  let now = 0;
  let blocked = false;
  let lease = 'lease-1';
  let connected = true;
  let targetAvailable = true;
  let onSleep: ((at: number) => void) | null = null;
  const looks: Vec3[] = [];
  const events: BowEvent[] = [];
  const switched: number[] = [];
  let activations = 0;
  let deactivations = 0;
  let usingHeldItem = false;
  let deactivateThrows = false;
  let lookFailsAfter = Number.POSITIVE_INFINITY;
  const shotTarget = target(opts.distance);

  const bot = {
    entity: { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), eyeHeight: 1.62 },
    inventory: { items: () => bag, slots, hotbarStart },
    get quickBarSlot() { return quickBarSlot; },
    get heldItem() { return slots[hotbarStart + quickBarSlot]; },
    get usingHeldItem() { return usingHeldItem; },
    equip: async (entry: FakeItem) => { slots[hotbarStart + quickBarSlot] = entry; },
    setQuickBarSlot: (slot: number) => {
      quickBarSlot = slot;
      usingHeldItem = false;
      switched.push(slot);
    },
    lookAt: async (point: Vec3) => {
      if (looks.length >= lookFailsAfter) throw new Error('look failed');
      looks.push(point.clone());
    },
    activateItem: () => { activations += 1; usingHeldItem = true; },
    deactivateItem: () => {
      deactivations += 1;
      if (deactivateThrows) throw new Error('release failed');
      usingHeldItem = false;
    },
    world: {
      raycast: () => (blocked ? { position: new Vec3(3, 65, 0), boundingBox: 'block' } : null),
    },
  } as unknown as Bot;

  const controller = new BowController({
    getBot: () => connected ? bot : null,
    resolveTarget: (id) => targetAvailable && id === shotTarget.id
      ? {
          ...shotTarget,
          position: new Vec3(shotTarget.position.x, shotTarget.position.y, shotTarget.position.z),
        }
      : null,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      onSleep?.(now);
    },
    leaseValid: (token) => token === lease,
    emit: (event) => { events.push(event); },
  });

  return {
    bag,
    bot,
    controller,
    events,
    looks,
    switched,
    get now() { return now; },
    get activations() { return activations; },
    get deactivations() { return deactivations; },
    setBlocked(value: boolean) { blocked = value; },
    setLease(value: string) { lease = value; },
    setConnected(value: boolean) { connected = value; },
    setTargetAvailable(value: boolean) { targetAvailable = value; },
    setDeactivateThrows(value: boolean) { deactivateThrows = value; },
    setLookFailsAfter(value: number) { lookFailsAfter = value; },
    onSleep(fn: ((at: number) => void) | null) { onSleep = fn; },
    advance(ms: number) { now += ms; },
    shotTarget,
  };
}

describe('远程物品与范围事实', () => {
  it('首期只认未损坏的 bow 与普通 arrow', () => {
    const bag = [
      item('bow', 1, 384),
      item('crossbow'),
      item('spectral_arrow', 12),
      item('bow', 1, 7),
      item('arrow', 0),
      item('bow', 1, 3),
    ];
    const r = rig({ bag });

    expect(bestRangedWeapon(r.bot)).toBe(bag[5]);
    expect(hasUsableArrows(r.bot)).toBe(false);
    bag[4].count = 2;
    expect(hasUsableArrows(r.bot)).toBe(true);
  });

  it('32 格进入、40 格退出只是感知滞回，不会自行拉弓', () => {
    const r = rig();
    expect(RANGED_ENTER_RANGE).toBe(32);
    expect(RANGED_EXIT_RANGE).toBe(40);
    expect(r.controller.active).toBe(false);
    expect(r.activations).toBe(0);
  });
});

describe('混合武器与风筝区间', () => {
  it('8 格切弓、5.5 格切近战，中间保持当前选择', () => {
    expect(chooseHybridWeapon('melee', 7.9, true)).toBe('melee');
    expect(chooseHybridWeapon('melee', 8, true)).toBe('ranged');
    expect(chooseHybridWeapon('ranged', 7.9, true)).toBe('ranged');
    expect(chooseHybridWeapon('ranged', 5.6, true)).toBe('ranged');
    expect(chooseHybridWeapon('ranged', 5.5, true)).toBe('melee');
    expect(chooseHybridWeapon('ranged', 20, false)).toBe('melee');
  });

  it('风筝目标区间含 8 与 14 格', () => {
    expect(inKiteRange(7.99)).toBe(false);
    expect(inKiteRange(8)).toBe(true);
    expect(inKiteRange(14)).toBe(true);
    expect(inKiteRange(14.01)).toBe(false);
  });
});

describe('低弧瞄点', () => {
  it('静止目标补偿下坠，移动目标沿速度方向给提前量', () => {
    const eye = new Vec3(0, 65.62, 0);
    const still = target(24);
    const moving = target(24);

    const staticAim = lowArcAimPoint(eye, still);
    const leadAim = lowArcAimPoint(eye, moving, new Vec3(0, 0, 0.12));

    expect(staticAim).not.toBeNull();
    expect(leadAim).not.toBeNull();
    expect(staticAim!.y).toBeGreaterThan(still.position.y + (still.height ?? 1.8) * 0.55);
    expect(staticAim!.z).toBeCloseTo(0, 6);
    expect(leadAim!.z).toBeGreaterThan(0.5);
  });

  it('射手横移时按相对速度反向修正提前量，无解时返回 null', () => {
    const eye = new Vec3(0, 65.62, 0);
    const still = target(24);
    const fromMovingShooter = lowArcAimPoint(
      eye,
      still,
      new Vec3(0, 0, 0),
      new Vec3(0, 0, 0.1),
    );
    const unreachable = target(0);
    unreachable.position.y = 200;

    expect(fromMovingShooter).not.toBeNull();
    expect(fromMovingShooter!.z).toBeLessThan(-0.5);
    expect(lowArcAimPoint(eye, unreachable)).toBeNull();
  });

  it('沿瞄点射出的箭按原版逐刻运动(位移→×0.99→减 0.05)飞到目标处,高度落在目标中心', () => {
    const eye = new Vec3(0, 65.62, 0);
    // 平射、站岛中心射柱顶水晶、离柱更远处射柱顶
    for (const [horizontal, rise] of [[24, 0], [42, 40], [60, 40]]) {
      const goal: RangedTarget = { id: 7, position: new Vec3(horizontal, eye.y + rise, 0), height: 0, width: 0 };
      const aim = lowArcAimPoint(eye, goal)!;
      const dir = aim.minus(eye).normalize();
      let vx = dir.x * 3;
      let vy = dir.y * 3;
      let x = 0;
      let y = eye.y - 0.1;
      while (x + vx < horizontal) {
        x += vx;
        y += vy;
        vx *= 0.99;
        vy = vy * 0.99 - 0.05;
      }
      expect(y + vy * ((horizontal - x) / vx)).toBeCloseTo(goal.position.y, 1);
    }
  });
});

describe('方块靶的射线', () => {
  /** 沿射线依次碰到的方块;raycast 返回第一个被 matcher 认作遮挡的 */
  function botFacing(blocks: Array<{ x: number; y: number; z: number }>): Bot {
    return {
      entity: { position: new Vec3(0, 64, 0) },
      world: {
        raycast: (_from: Vec3, _dir: Vec3, _range: number, matcher: (b: unknown) => boolean) =>
          blocks.map((p) => ({ boundingBox: 'block', position: new Vec3(p.x, p.y, p.z) })).find(matcher) ?? null,
      },
    } as unknown as Bot;
  }

  it('射线先碰到的就是靶格本身时算看得见,中间另有方块时算挡住', () => {
    const cell = { x: 10, y: 65, z: 0 };
    expect(hasRangedLos(botFacing([cell]), cellTarget(cell))).toBe(true);
    expect(hasRangedLos(botFacing([{ x: 5, y: 65, z: 0 }, cell]), cellTarget(cell))).toBe(false);
  });
});

describe('PositionVelocityTracker', () => {
  it('从位置时间差推导格/tick，并让陈旧速度衰减到零', () => {
    const tracker = new PositionVelocityTracker({ staleMs: 100, decayMs: 100 });
    tracker.observe(7, new Vec3(0, 64, 0), 0);
    tracker.observe(7, new Vec3(0.2, 64, 0), 50);

    expect(tracker.estimate(7, 50)?.velocityPerTick.x).toBeCloseTo(0.2, 6);
    expect(tracker.estimate(7, 200)?.velocityPerTick.x).toBeCloseTo(0.1, 6);
    expect(tracker.estimate(7, 250)?.velocityPerTick.x).toBe(0);
  });

  it('异常跳变重置速度，forget 删除目标', () => {
    const tracker = new PositionVelocityTracker({ maxBlocksPerTick: 1 });
    tracker.observe(7, new Vec3(0, 64, 0), 0);
    tracker.observe(7, new Vec3(10, 64, 0), 50);

    expect(tracker.estimate(7, 50)?.velocityPerTick).toEqual({ x: 0, y: 0, z: 0 });
    tracker.forget(7);
    expect(tracker.estimate(7, 50)).toBeNull();
  });

  it('瞄准轮询重复同一位置时不把最近一次移动速度误衰减', () => {
    const tracker = new PositionVelocityTracker({ staleMs: 100, decayMs: 100 });
    tracker.observe(7, new Vec3(0, 64, 0), 0);
    tracker.observe(7, new Vec3(0.2, 64, 0), 50);
    tracker.observe(7, new Vec3(0.2, 64, 0), 75);

    expect(tracker.estimate(7, 75)?.velocityPerTick.x).toBeCloseTo(0.2, 6);
  });
});

describe('BowController', () => {
  it('满弓期间从实时位置采样更新提前量，commit 恰发送一次 release', async () => {
    const r = rig();
    r.onSleep(() => {
      r.shotTarget.position.z += 0.1;
    });

    const result = await r.controller.shoot(r.shotTarget, 'lease-1');

    expect(result.kind).toBe('released');
    if (result.kind !== 'released') throw new Error('expected release');
    expect(result.at).toBe(1_000);
    expect(result.hitWindow.until - result.hitWindow.from).toBe(BOW_HIT_WINDOW_MS);
    expect(result.ownerToken).toBe('lease-1');
    expect(r.looks.length).toBeGreaterThanOrEqual(20);
    expect(r.looks.at(-1)!.z).toBeGreaterThan(r.looks[0].z);
    expect(r.activations).toBe(1);
    expect(r.deactivations).toBe(1);
    expect(r.switched).toEqual([]);

    expect(r.controller.noteHit(7)).toMatchObject({
      kind: 'hit', shotId: result.shotId, targetId: 7, ownerToken: 'lease-1',
    });
    expect(r.controller.noteHit(7)).toBeNull();
    expect(r.events.map((event) => event.kind)).toEqual(['released', 'hit']);
  });

  it('命中超过窗口不归到旧箭', async () => {
    const r = rig();
    const result = await r.controller.shoot(r.shotTarget, 'lease-1');
    expect(result.kind).toBe('released');
    r.advance(BOW_HIT_WINDOW_MS + 1);
    expect(r.controller.noteHit(7)).toBeNull();
  });

  it('无箭、初始遮挡和目标过近分别给出机械阻塞原因', async () => {
    const noArrow = rig({ bag: [item('bow')] });
    await expect(noArrow.controller.shoot(noArrow.shotTarget, 'lease-1'))
      .resolves.toEqual({ kind: 'blocked', reason: 'no_arrow' });

    const noLos = rig();
    noLos.setBlocked(true);
    await expect(noLos.controller.shoot(noLos.shotTarget, 'lease-1'))
      .resolves.toEqual({ kind: 'blocked', reason: 'no_los' });

    const close = rig({ distance: 5.5 });
    await expect(close.controller.shoot(close.shotTarget, 'lease-1'))
      .resolves.toEqual({ kind: 'blocked', reason: 'too_close' });
    expect(noArrow.activations + noLos.activations + close.activations).toBe(0);
  });

  it('开始时手上已有使用动作则不换装也不拉弓', async () => {
    const r = rig();
    r.bot.activateItem();

    await expect(r.controller.shoot(r.shotTarget, 'lease-1')).resolves.toEqual({
      kind: 'blocked', reason: 'aborted', cause: 'busy',
    });
    expect(r.activations).toBe(1);
    expect(r.deactivations).toBe(0);
    expect(r.switched).toEqual([]);
  });

  it('拉弓中丢失 LOS 会切换安全槽取消，绝不发送 release', async () => {
    const r = rig();
    r.onSleep((at) => {
      if (at >= 250) r.setBlocked(true);
    });

    await expect(r.controller.shoot(r.shotTarget, 'lease-1'))
      .resolves.toEqual({ kind: 'blocked', reason: 'no_los' });
    expect(r.activations).toBe(1);
    expect(r.deactivations).toBe(0);
    expect(r.switched).toHaveLength(1);
    expect(r.now).toBe(300);
    expect(r.events.some((event) => event.kind === 'released')).toBe(false);
  });

  it.each([
    ['abort', 'abort'],
    ['lease', 'lease'],
  ] as const)('%s 在拉弓中止时切安全槽且零 release', async (mode, cause) => {
    const r = rig();
    r.onSleep((at) => {
      if (at < 200) return;
      if (mode === 'abort') r.controller.abort();
      if (mode === 'lease') r.setLease('lease-2');
    });

    const result = await r.controller.shoot(r.shotTarget, 'lease-1');

    expect(result).toEqual({ kind: 'blocked', reason: 'aborted', cause: cause as BowAbortCause });
    expect(r.deactivations).toBe(0);
    expect(r.switched).toHaveLength(1);
    expect(r.events.some((event) => event.kind === 'released')).toBe(false);
  });

  it.each(['no_arrow', 'too_close', 'no_solution'] as const)(
    '拉弓中的 %s 也只用安全槽取消',
    async (reason) => {
      const r = rig();
      r.onSleep((at) => {
        if (at < 200) return;
        if (reason === 'no_arrow') r.bag.find((entry) => entry.name === 'arrow')!.count = 0;
        if (reason === 'too_close') r.shotTarget.position.x = 1;
        if (reason === 'no_solution') {
          r.shotTarget.position.x = 0;
          r.shotTarget.position.y = 200;
        }
      });

      await expect(r.controller.shoot(r.shotTarget, 'lease-1')).resolves.toEqual({
        kind: 'blocked', reason,
      });
      expect(r.deactivations).toBe(0);
      expect(r.switched).toHaveLength(1);
    },
  );

  it.each(['death', 'bot_lost'] as const)('%s 只清逻辑状态，不切槽也不发 release', async (mode) => {
    const r = rig();
    r.onSleep((at) => {
      if (at < 200) return;
      if (mode === 'death') r.controller.onDeath();
      else r.setConnected(false);
    });

    await expect(r.controller.shoot(r.shotTarget, 'lease-1')).resolves.toEqual({
      kind: 'blocked', reason: 'aborted', cause: mode === 'death' ? 'death' : 'bot_lost',
    });
    expect(r.deactivations).toBe(0);
    expect(r.switched).toEqual([]);
  });

  it('死亡和目标消失同拍时保留 death 归因', async () => {
    const r = rig();
    r.onSleep((at) => {
      if (at < 200) return;
      r.controller.onDeath();
      r.setTargetAvailable(false);
    });

    await expect(r.controller.shoot(r.shotTarget, 'lease-1')).resolves.toEqual({
      kind: 'blocked', reason: 'aborted', cause: 'death',
    });
    expect(r.events.some((event) => event.kind === 'released')).toBe(false);
  });

  it('弓在拉弓期间损坏时按 bow_lost 中止，不把松手记成发射', async () => {
    const bow = item('bow');
    const r = rig({ bag: [bow, item('arrow', 8)] });
    r.onSleep((at) => {
      if (at >= 300) bow.nbt = { value: { Damage: { value: 384 } } };
    });

    await expect(r.controller.shoot(r.shotTarget, 'lease-1')).resolves.toEqual({
      kind: 'blocked', reason: 'aborted', cause: 'bow_lost',
    });
    expect(r.deactivations).toBe(0);
    expect(r.switched).toHaveLength(1);
    expect(r.events.some((event) => event.kind === 'released')).toBe(false);
  });

  it('没有与弓 type 不同的热栏槽时不开始拉弓', async () => {
    const bows = Array.from({ length: 9 }, () => item('bow'));
    const r = rig({ hotbar: bows, bag: [bows[0], item('arrow', 8)] });

    await expect(r.controller.shoot(r.shotTarget, 'lease-1')).resolves.toEqual({
      kind: 'blocked', reason: 'aborted', cause: 'cancel_slot',
    });
    expect(r.activations).toBe(0);
    expect(r.deactivations).toBe(0);
    expect(r.switched).toEqual([]);
  });

  it('正常 release 发送失败时切槽收尾且不产生 released', async () => {
    const r = rig();
    r.setDeactivateThrows(true);

    await expect(r.controller.shoot(r.shotTarget, 'lease-1')).resolves.toEqual({
      kind: 'blocked', reason: 'aborted', cause: 'release',
    });
    expect(r.deactivations).toBe(1);
    expect(r.switched).toHaveLength(1);
    expect(r.events.some((event) => event.kind === 'released')).toBe(false);
  });

  it('拉弓后的异常只走 cancel，不会从 finally 发送 release', async () => {
    const r = rig();
    r.setLookFailsAfter(1);

    await expect(r.controller.shoot(r.shotTarget, 'lease-1')).rejects.toThrow('look failed');
    expect(r.deactivations).toBe(0);
    expect(r.switched).toHaveLength(1);
    expect(r.events.some((event) => event.kind === 'released')).toBe(false);
  });

  it('目标在正上方但 AABB 距离足够远时可以射击', async () => {
    const r = rig();
    r.shotTarget.position.x = 0;
    r.shotTarget.position.y = 84;

    expect(rangedTargetDistance(r.bot, r.shotTarget)).toBeGreaterThan(HYBRID_MELEE_AT);
    await expect(r.controller.shoot(r.shotTarget, 'lease-1')).resolves.toMatchObject({ kind: 'released' });
    expect(r.looks.at(-1)!.y).toBeGreaterThan(65.62);
  });

  it('弹道无解时在拉弓前明确阻塞', async () => {
    const r = rig();
    r.shotTarget.position.x = 0;
    r.shotTarget.position.y = 200;

    await expect(r.controller.shoot(r.shotTarget, 'lease-1')).resolves.toEqual({
      kind: 'blocked', reason: 'no_solution',
    });
    expect(r.activations).toBe(0);
    expect(r.deactivations).toBe(0);
  });

  it('实时 resolver 丢失目标时切槽取消', async () => {
    const r = rig();
    r.onSleep((at) => {
      if (at >= 200) r.setTargetAvailable(false);
    });

    await expect(r.controller.shoot(r.shotTarget, 'lease-1')).resolves.toEqual({
      kind: 'blocked', reason: 'aborted', cause: 'target_lost',
    });
    expect(r.deactivations).toBe(0);
    expect(r.switched).toHaveLength(1);
  });
});
