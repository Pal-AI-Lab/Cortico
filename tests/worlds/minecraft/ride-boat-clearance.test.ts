/**
 * 驾船每一步先按船身包围盒和骑手眼睛那一格自查。
 */
import { Vec3 as V } from 'vec3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rideDrive, rideObstacle } from '../../../src/worlds/minecraft/skills-interact.ts';
import { SkillBlocked, type SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const BOAT = { width: 1.375, height: 0.5625 };
/** 船浮在 62 号水格上时的 y */
const FLOAT_Y = 62.52;

type Solid = Map<string, string>;
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

function world(solid: Solid) {
  return (p: V) => {
    const f = p.floored();
    const name = solid.get(key(f.x, f.y, f.z)) ?? (f.y <= 62 ? 'water' : 'air');
    const cube = name !== 'water' && name !== 'air';
    return {
      name, position: f, boundingBox: cube ? 'block' : 'empty',
      shapes: cube ? [[0, 0, 0, 1, 1, 1]] : [],
    };
  };
}

/** 圆石垫子:水面上一格两块、上两格一片 */
function padOf(): Solid {
  const s: Solid = new Map();
  for (const [x, z] of [[-411, 155], [-410, 155]]) s.set(key(x, 63, z), 'cobblestone');
  for (const [x, z] of [[-411, 157], [-411, 156], [-412, 156], [-411, 155]]) s.set(key(x, 64, z), 'cobblestone');
  for (const [x, z] of [[-410, 157], [-410, 156], [-409, 157], [-408, 157]]) s.set(key(x, 64, z), 'oak_planks');
  return s;
}

function rideBot(solid: Solid, at: V) {
  const writes: Array<Record<string, unknown>> = [];
  const vehicle = { name: 'boat', position: at.clone(), ...BOAT };
  const bot = {
    entity: { position: at.offset(0, 0.6, 0) },
    vehicle: vehicle as typeof vehicle | null,
    blockAt: world(solid),
    dismount() { bot.vehicle = null; },
    _client: {
      write(name: string, data: Record<string, unknown>) { if (name === 'vehicle_move') writes.push(data); },
      on() {},
      removeListener() {},
    },
  };
  return { bot, writes };
}

const ctx = { aborted: () => false } as unknown as SkillContext;

async function drive(bot: unknown, to: { x: number; y: number; z: number }): Promise<string | SkillBlocked> {
  const p = rideDrive(bot as never, ctx, to).catch((e: unknown) => e as SkillBlocked);
  await vi.advanceTimersByTimeAsync(60_000);
  return p;
}

describe('rideObstacle', () => {
  it('贴着垫子的位置:往西头进垫子,往北船身蹭垫子边', () => {
    const { bot } = rideBot(padOf(), new V(-411.09, FLOAT_Y, 156.69));
    expect(rideObstacle(bot as never, -411.39, FLOAT_Y, 156.69, BOAT))
      .toEqual({ cell: { x: -412, y: 64, z: 156 }, name: 'cobblestone', kind: 'head' });
    expect(rideObstacle(bot as never, -411.09, FLOAT_Y, 156.39, BOAT)?.kind).toBe('hull');
  });

  it('开阔水面不挡;船身正好贴着方块面不挡,伸进去 0.06 格就挡(台架上 Paper 这就拽回)', () => {
    const { bot } = rideBot(new Map([[key(0, 63, 3), 'stone']]), new V(0.5, FLOAT_Y, 0.5));
    expect(rideObstacle(bot as never, 0.5, FLOAT_Y, 0.5, BOAT)).toBeNull();
    // 船身南北半宽 0.6875:z=2.3125 时北沿正好是石头的南面 z=3
    expect(rideObstacle(bot as never, 0.5, FLOAT_Y, 2.3125, BOAT)).toBeNull();
    expect(rideObstacle(bot as never, 0.5, FLOAT_Y, 2.3725, BOAT)?.kind).toBe('hull');
  });
});

describe('rideDrive 驾船自查', () => {
  it('从贴着垫子的位置往西开:当场停下,两格都报出来,一个包都不白发', async () => {
    const { bot, writes } = rideBot(padOf(), new V(-411.09, FLOAT_Y, 156.69));
    const out = await drive(bot, { x: -440, y: 63, z: 150 });
    expect(out).toBeInstanceOf(SkillBlocked);
    const text = (out as SkillBlocked).message;
    expect(text).toContain('(-411, 63, 155) 是圆石,挡着船的身子');
    expect(text).toContain('(-412, 64, 156) 是圆石,在人头的高度');
    expect(text).not.toContain('20 秒只挪了');
    expect(writes).toHaveLength(0);
  });

  it('从垫子东边开过来:绕过垫子开到,船身和人头一次都没进实心格', async () => {
    const pad = padOf();
    const { bot, writes } = rideBot(pad, new V(-403.5, FLOAT_Y, 158.5));
    const out = await drive(bot, { x: -440, y: 63, z: 150 });
    expect(out as string).toContain('骑着船到了');
    for (const w of writes) {
      expect(rideObstacle(bot as never, w.x as number, w.y as number, w.z as number, BOAT)).toBeNull();
    }
  });

  it('斜着开、目标在墙那一侧:贴着墙滑到正对目标的地方,再过不去就停下报墙', async () => {
    // 水面那一层 z=3 一整排石头,目标在墙这一侧的东北
    const wall: Solid = new Map();
    for (let x = -2; x <= 30; x += 1) wall.set(key(x, 63, 3), 'stone');
    const { bot } = rideBot(wall, new V(0.5, FLOAT_Y, 1.5));
    const out = await drive(bot, { x: 20, y: 63, z: 9 });
    expect(out).toBeInstanceOf(SkillBlocked);
    expect((out as SkillBlocked).message).toContain('是石头,挡着船的身子');
    expect(bot.vehicle).toBeNull();
    const x = Number(/停在 \((-?\d+),/.exec((out as SkillBlocked).message)?.[1]);
    expect(x).toBeGreaterThanOrEqual(19);
  });

  it('开阔水面照直开到', async () => {
    const { bot, writes } = rideBot(new Map(), new V(0.5, FLOAT_Y, 0.5));
    const out = await drive(bot, { x: 30, y: 63, z: 0 });
    expect(typeof out).toBe('string');
    expect(out as string).toContain('骑着船到了');
    expect(writes.length).toBeGreaterThan(80);
  });
});
