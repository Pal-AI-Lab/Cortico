import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CombatSession, footingAhead, type CombatTuning } from '../../../src/worlds/minecraft/combat.ts';
import type { CombatRangedActions } from '../../../src/worlds/minecraft/combat.ts';
import type { RangedTarget } from '../../../src/worlds/minecraft/ranged.ts';
import { MinecraftLog } from '../../../src/worlds/minecraft/log.ts';
import type { Logger } from '../../../src/core/types.ts';

const log = { child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {} } as unknown as Logger;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function sleep(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil 超时');
    await sleep(10);
  }
}

interface FakeFoe {
  id: number;
  name: string;
  isValid: boolean;
  position: Vec3;
  height: number;
  width: number;
  velocity: { x: number; y: number; z: number };
  metadata?: unknown[];
}

function foe(id: number, name: string, x: number, z = 0.5): FakeFoe {
  return { id, name, isValid: true, position: new Vec3(x, 64, z), height: 1.95, width: 0.6, velocity: { x: 0, y: 0, z: 0 } };
}

/** 平地上的战斗假 bot:实体表、方向键、可控血量;physicsTick 由测试手动发 */
function combatRigBot(foes: FakeFoe[] = []) {
  const bot = new EventEmitter() as unknown as Record<string, unknown> & EventEmitter;
  const attacks: number[] = [];
  const controls: Record<string, boolean> = {};
  bot.entity = {
    id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0,
    velocity: new Vec3(0, 0, 0), onGround: true,
  };
  bot.health = 20;
  bot.entities = Object.fromEntries(foes.map((f) => [f.id, f]));
  bot.heldItem = { name: 'iron_sword' };
  bot.inventory = { items: () => [{ name: 'iron_sword', type: 1, count: 1 }], slots: [] as unknown[] };
  bot.registry = { entitiesByName: { piglin: { metadataKeys: ['flags', 'baby'] } } };
  bot.equip = async () => {};
  bot.lookAt = async () => {};
  bot.attack = (e: { id: number }) => { attacks.push(e.id); };
  bot.setControlState = (k: string, v: boolean) => { controls[k] = v; };
  bot.controlState = controls;
  bot.blockAt = (p: { y: number }) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' });
  bot.pathfinder = { setGoal: () => {} };
  return { bot: bot as never, attacks, controls };
}

function rig(
  bot: unknown,
  over: Partial<CombatTuning> = {},
  diag?: MinecraftLog,
  ranged?: CombatRangedActions,
) {
  const events: Array<{ text: string; urgent: boolean }> = [];
  const calls = { suspended: 0, resumed: 0, suspendedBy: [] as string[] };
  let envBusy = false;
  let taskEscaping = false;
  let taskFighting = false;
  const session = new CombatSession({
    diag,
    getBot: () => bot as never,
    tuning: () => ({
      enabled: true, engageRadius: 3, chaseMax: 6, maxSec: 30, space: 2.6,
      busyRatio: 60, cooldownSec: 60, fleeHealth: 10, fight: 'auto', ...over,
    }),
    envBusy: () => envBusy,
    taskEscaping: () => taskEscaping,
    taskFighting: () => taskFighting,
    suspendTasks: (by) => { calls.suspended++; calls.suspendedBy.push(by); },
    resumeTasks: () => { calls.resumed++; return '刚才做到一半的任务#1 接着做(第 1 步:去坐标)'; },
    emit: (text, urgent) => events.push({ text, urgent }),
    ranged,
    log,
  });
  return {
    session, events, calls,
    setEnvBusy: (v: boolean) => { envBusy = v; },
    setTaskEscaping: (v: boolean) => { taskEscaping = v; },
    setTaskFighting: (v: boolean) => { taskFighting = v; },
  };
}

function rangedRig() {
  const shots: Array<{ target: RangedTarget; ownerToken: unknown }> = [];
  let aborts = 0;
  let active = false;
  const actions: CombatRangedActions = {
    ready: () => true,
    active: () => active,
    shoot: async (target, ownerToken) => {
      shots.push({ target, ownerToken });
      return { kind: 'blocked', reason: 'aborted', cause: 'busy' };
    },
    abort: () => { aborts += 1; active = false; },
  };
  return {
    actions,
    shots,
    get aborts() { return aborts; },
    setActive(value: boolean) { active = value; },
  };
}

/** 每拍先发 physicsTick,再推进同一时钟上的定时器与 Date。 */
async function drive(bot: EventEmitter, ms: number, stepMs = 50): Promise<void> {
  for (let t = 0; t < ms; t += stepMs) {
    bot.emit('physicsTick');
    await sleep(stepMs);
  }
}

/**
 * 岩浆的 boundingBox 为 empty，岩浆块为 block；可站性须同时检查危险方块名称，使用共享的 BURNING_BLOCKS/SCORCHING_FLOOR。
 */
describe('standable 认岩浆', () => {
  it('低一格是岩浆、脚下是岩浆块:都不算可站方向', () => {
    const { bot } = combatRigBot();
    const { session } = rig(bot);
    const world: Record<string, { name: string; boundingBox: string }> = {};
    (bot as unknown as { blockAt: unknown }).blockAt = (p: { x: number; y: number; z: number }) => {
      const hit = world[`${p.x},${p.y},${p.z}`];
      return hit ?? { name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' };
    };
    const standable = (x: number, y: number, z: number): boolean =>
      (session as unknown as { standable(b: unknown, x: number, y: number, z: number): boolean })
        .standable(bot, x, y, z);
    // 平地照旧可站
    expect(standable(5, 64, 5)).toBe(true);
    // 低一格是 boundingBox 为 empty 的岩浆，下方是石头、头部是空气，仍不能站立。
    world['5,63,5'] = { name: 'lava', boundingBox: 'empty' };
    world['5,62,5'] = { name: 'stone', boundingBox: 'block' };
    expect(standable(5, 63, 5)).toBe(false);
    // 脚下是岩浆块(boundingBox block):踩上去也烧
    world['6,63,6'] = { name: 'magma_block', boundingBox: 'block' };
    expect(standable(6, 64, 6)).toBe(false);
  });
});

describe('战斗会话:进入(夺手不夺嘴)', () => {
  it('换武器没成:接敌播报不说手里是它,换手结果出来后照实补一条', async () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.5)]);
    const b = bot as unknown as Record<string, unknown>;
    b.heldItem = null;
    b.inventory = { items: () => [{ name: 'diamond_sword', type: 1, count: 1 }], slots: [] };
    b.equip = async () => { throw new Error('Server rejected transaction for clicking on slot 36'); };
    const { session, events } = rig(bot);
    expect(session.onHurtBy(7, 'zombie')).toBe(true);
    expect(events[0].text).not.toContain('手里是钻石剑');
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.text.includes('钻石剑没换到手上') && e.text.includes('手里是空手'))).toBe(true);
    session.stop();
  });

  it('被打就接手:挂起任务、发第一人称接敌事件,文本不出现「战斗模式/脚本/接管」', () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.5)]);
    const { session, events, calls } = rig(bot);
    expect(session.onHurtBy(7, 'zombie')).toBe(true);
    expect(session.active).toBe(true);
    expect(calls.suspended).toBe(1);
    expect(events[0].urgent).toBe(true);
    expect(events[0].text).toContain('抄家伙还手');
    expect(events[0].text).toContain('生命 20/20');
    expect(events[0].text).toContain('铁剑');
    for (const banned of ['战斗模式', '脚本', '接管', '控制器']) {
      expect(events[0].text).not.toContain(banned);
    }
    session.stop();
  });

  it('不主动招惹:触发圈外的怪不动手,贴进 3 格才开打', async () => {
    const far = combatRigBot([foe(7, 'zombie', 6.5)]);
    const a = rig(far.bot);
    a.session.start();
    await sleep(600);
    expect(a.session.active).toBe(false);
    a.session.stop();

    const near = combatRigBot([foe(7, 'zombie', 2.5)]);
    const b = rig(near.bot);
    b.session.start();
    await waitUntil(() => b.session.active, 2000);
    expect(b.events[0].text).toContain('贴到跟前');
    b.session.stop();
  });

  it('普通猪灵只认实际穿戴的金甲:穿在装备槽不进场,只放背包仍主动接敌', async () => {
    const worn = combatRigBot([foe(7, 'piglin', 2.5)]);
    (worn.bot as unknown as { inventory: { slots: unknown[] } }).inventory.slots[8] = { name: 'golden_boots' };
    const protectedSession = rig(worn.bot);
    protectedSession.session.start();
    await sleep(600);
    expect(protectedSession.session.active).toBe(false);
    protectedSession.session.stop();

    const bagOnly = combatRigBot([foe(8, 'piglin', 2.5)]);
    (bagOnly.bot as unknown as { inventory: { items: () => unknown[] } }).inventory.items = () => [
      { name: 'iron_sword', type: 1, count: 1 },
      { name: 'golden_boots', type: 2, count: 1 },
    ];
    const hostileSession = rig(bagOnly.bot);
    hostileSession.session.start();
    await waitUntil(() => hostileSession.session.active, 2000);
    hostileSession.session.stop();
  });

  it('幼年猪灵不主动进场,猪灵蛮兵即使玩家穿着金甲也始终敌对', async () => {
    const baby = foe(7, 'piglin', 2.5);
    baby.metadata = [false, true];
    const young = combatRigBot([baby]);
    const youngSession = rig(young.bot);
    youngSession.session.start();
    await sleep(600);
    expect(youngSession.session.active).toBe(false);
    youngSession.session.stop();

    const brute = combatRigBot([foe(8, 'piglin_brute', 2.5)]);
    (brute.bot as unknown as { inventory: { slots: unknown[] } }).inventory.slots[5] = { name: 'golden_helmet' };
    const bruteSession = rig(brute.bot);
    bruteSession.session.start();
    await waitUntil(() => bruteSession.session.active, 2000);
    bruteSession.session.stop();
  });

  it('穿着金甲时被普通猪灵实际打到,仍按这只来源接敌', () => {
    const protectedRig = combatRigBot([foe(7, 'piglin', 2.5)]);
    (protectedRig.bot as unknown as { inventory: { slots: unknown[] } }).inventory.slots[6] = {
      name: 'golden_chestplate',
    };
    const { session } = rig(protectedRig.bot);
    expect(session.onHurtBy(7, 'piglin')).toBe(true);
    expect(session.active).toBe(true);
    session.stop();
  });

  it('死亡是终态:释放战斗但不恢复被冻结的旧任务', () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.5)]);
    const { session, calls } = rig(bot);
    session.onHurtBy(7, 'zombie');
    expect(session.active).toBe(true);

    (bot as unknown as EventEmitter).emit('death');

    expect(session.active).toBe(false);
    expect(calls.resumed).toBe(0);
    session.stop();
  });

  /**
   * 交还身体须释放 sneak，并停止挖掘和右键，不能只松方向键与盾。
   */
  it('收工交还身体:sneak 也松开,挖掘与右键一并停掉', () => {
    const { bot, controls } = combatRigBot([foe(7, 'zombie', 2.5)]);
    const stopped: string[] = [];
    const b = bot as unknown as Record<string, unknown>;
    b.clearControlStates = (): void => { stopped.push('controls'); };
    b.stopDigging = (): void => { stopped.push('dig'); };
    b.deactivateItem = (): void => { stopped.push('use'); };
    b.usingHeldItem = true; // 举着盾;松手不发射的那一类
    const goals: unknown[] = [];
    b.pathfinder = { goal: null, setGoal: (g: unknown) => { goals.push(g); } };
    const { session } = rig(bot);
    session.onHurtBy(7, 'zombie');
    // 寻路器交互放置失败时留下的半蹲
    (bot as unknown as { setControlState(k: string, v: boolean): void }).setControlState('sneak', true);
    expect(controls.sneak).toBe(true);

    session.standDown();

    expect(controls.sneak).toBe(false);
    expect(stopped).toContain('dig');
    expect(stopped).toContain('use');
    expect(goals).toEqual([null]);
    session.stop();
  });

  it('关着 / 环境自保中 / 冷却中都进不了场,退回反射的降级行为', () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.5)]);
    const off = rig(bot, { enabled: false });
    expect(off.session.onHurtBy(7, 'zombie')).toBe(false);

    const busy = rig(bot);
    busy.setEnvBusy(true);
    expect(busy.session.onHurtBy(7, 'zombie')).toBe(false);
  });

  /**
   * 任务正在逃跑时，3 格圈不主动夺手；受击仍可还手，结束后从断点继续逃跑。
   */
  it('任务在逃时:3 格圈不主动进场,但被打照样还手', async () => {
    const near = combatRigBot([foe(7, 'cave_spider', 2.2)]);
    const a = rig(near.bot);
    a.setTaskEscaping(true);
    a.session.start();
    await sleep(600);
    expect(a.session.active).toBe(false); // 不趁逃跑抢场
    expect(a.session.onHurtBy(7, 'cave_spider')).toBe(true); // 挨打了就还手
    expect(a.session.active).toBe(true);
    expect(a.calls.suspended).toBe(1); // 逃跑任务挂起,打完接着逃
    a.session.stop();
  });

  it('头在水里不接手:水下近战交回 surface/防溺水那条线', () => {
    const { bot } = combatRigBot([foe(7, 'drowned', 2.5)]);
    (bot as unknown as { blockAt: unknown }).blockAt = () => ({ name: 'water', boundingBox: 'empty' });
    const { session } = rig(bot);
    expect(session.onHurtBy(7, 'drowned')).toBe(false);
    expect(session.active).toBe(false);
  });

  /**
   * mc_policy.fight 只控制主动进场，不处理 onHurtBy。
   */
  describe('fight 三档:只管主动进场', () => {
    it('off:3 格圈内也不主动动手', async () => {
      const { bot } = combatRigBot([foe(7, 'zombie', 2.2)]);
      const a = rig(bot, { fight: 'off' });
      a.session.start();
      await sleep(600);
      expect(a.session.active).toBe(false);
      a.session.stop();
    });

    it('armed:空手不进场,包里有剑就进场', async () => {
      const bare = combatRigBot([foe(7, 'zombie', 2.2)]);
      (bare.bot as unknown as { inventory: { items: () => unknown[] } }).inventory.items = () => [];
      (bare.bot as unknown as { heldItem: unknown }).heldItem = null;
      const a = rig(bare.bot, { fight: 'armed' });
      a.session.start();
      await sleep(600);
      expect(a.session.active).toBe(false);
      a.session.stop();

      const armed = combatRigBot([foe(7, 'zombie', 2.2)]);
      const b = rig(armed.bot, { fight: 'armed' });
      b.session.start();
      await waitUntil(() => b.session.active, 2000);
      b.session.stop();
    });

    it('三档下挨打一律还手;armed 空手 / off 打起来时措辞永远走「被打」那一支', async () => {
      for (const fight of ['auto', 'armed', 'off'] as const) {
        const bare = combatRigBot([foe(7, 'zombie', 2.2)]);
        (bare.bot as unknown as { inventory: { items: () => unknown[] } }).inventory.items = () => [];
        (bare.bot as unknown as { heldItem: unknown }).heldItem = null;
        const a = rig(bare.bot, { fight });
        a.session.start();
        await sleep(400);
        // 主动那条路:auto 会进场,armed 空手与 off 不会
        expect(a.session.active).toBe(fight === 'auto');
        a.session.stop();

        const hit = combatRigBot([foe(7, 'zombie', 2.2)]);
        (hit.bot as unknown as { inventory: { items: () => unknown[] } }).inventory.items = () => [];
        (hit.bot as unknown as { heldItem: unknown }).heldItem = null;
        const b = rig(hit.bot, { fight });
        expect(b.session.onHurtBy(7, 'zombie')).toBe(true);
        expect(b.events[0].text).toContain('打过来了');
        expect(b.events[0].text).not.toContain('我先动手');
        b.session.stop();
      }
    });
  });

  /**
   * 血量不足时主动入场转为撤退并播报；不能在每次巡检中静默跳过。
   */
  describe('入场血线闸', () => {
    it('主动进场要留出挨一下的余量:血低于线时转撤退,不开打', async () => {
      const { bot, attacks } = combatRigBot([foe(7, 'zombie', 2.2)]);
      (bot as unknown as { health: number }).health = 12; // fleeHealth 10 + 余量 3
      const a = rig(bot);
      a.session.start();
      await waitUntil(() => a.events.length > 0, 2000);
      expect(a.events[0].text).toContain('这架不接了');
      expect(a.events[0].urgent).toBe(true);
      expect(attacks).toHaveLength(0);
      a.session.stop();
    });

    it('挨打不加余量:脱战线以上照旧还手', () => {
      const { bot } = combatRigBot([foe(7, 'zombie', 2.2)]);
      (bot as unknown as { health: number }).health = 11;
      const a = rig(bot);
      expect(a.session.onHurtBy(7, 'zombie')).toBe(true);
      expect(a.events[0].text).toContain('抄家伙还手');
      a.session.stop();
    });

    it('挨打且已在脱战线以下:接手但直接撤,不发「我抄家伙还手」', () => {
      const { bot, attacks } = combatRigBot([foe(7, 'zombie', 2.2)]);
      (bot as unknown as { health: number }).health = 3;
      const a = rig(bot);
      expect(a.session.onHurtBy(7, 'zombie')).toBe(true);
      expect(a.events[0].text).toContain('血只剩 3/20');
      expect(a.events[0].text).not.toContain('抄家伙还手');
      expect(a.calls.suspended).toBe(1);
      expect(attacks).toHaveLength(0);
      a.session.stop();
    });
  });

  it('E7:warden 找上门不交战,直接跑', () => {
    const { bot, attacks } = combatRigBot([foe(9, 'warden', 2.5)]);
    const { session, events, calls } = rig(bot);
    expect(session.onHurtBy(9, 'warden')).toBe(true);
    expect(events[0].text).toContain('打不过');
    expect(calls.suspended).toBe(1);
    expect(attacks).toHaveLength(0);
    session.stop();
  });
});

describe('弓与近战的同一战斗会话', () => {
  function rangedTerrain(
    bot: unknown,
    cell: (x: number, y: number, z: number) => 'air' | 'stone' | 'lava' | 'water',
  ): void {
    (bot as { blockAt: (p: Vec3) => unknown }).blockAt = (p) => {
      const name = cell(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return { name, boundingBox: name === 'stone' ? 'block' : 'empty' };
    };
  }

  it('远处可见敌对只进入感知，不会由 3 格巡检主动开火', async () => {
    const { bot, attacks } = combatRigBot([foe(7, 'skeleton', 20)]);
    const ranged = rangedRig();
    const { session } = rig(bot, {}, undefined, ranged.actions);
    session.start();

    await sleep(600);

    expect(session.active).toBe(false);
    expect(ranged.shots).toHaveLength(0);
    expect(attacks).toHaveLength(0);
    session.stop();
  });

  it('主动 attack 持有身体时:三格巡检不重复接管', async () => {
    const near = combatRigBot([foe(7, 'zombie', 2.2)]);
    const active = rig(near.bot);
    active.setTaskFighting(true);
    active.session.start();
    await sleep(600);
    expect(active.session.active).toBe(false);
    expect(active.calls.suspended).toBe(0);
    active.session.stop();
  });

  it('20 格外打过来的骷髅进入 40 格交战池并用弓回火', async () => {
    const skeleton = foe(7, 'skeleton', 20);
    const { bot, attacks } = combatRigBot([skeleton]);
    const ranged = rangedRig();
    const { session } = rig(bot, {}, undefined, ranged.actions);

    expect(session.onHurtBy(7, 'skeleton')).toBe(true);
    (bot as unknown as EventEmitter).emit('physicsTick');
    await waitUntil(() => ranged.shots.length > 0);

    expect(ranged.shots[0].target.id).toBe(7);
    expect(attacks).toHaveLength(0);
    session.stop();
  });

  it('8–14 格面对远程敌人也持续横移，不在骷髅射线上站桩', () => {
    const skeleton = foe(7, 'skeleton', 0.5, 10);
    const { bot, controls } = combatRigBot([skeleton]);
    const ranged = rangedRig();
    const { session } = rig(bot, {}, undefined, ranged.actions);
    session.onHurtBy(7, 'skeleton');

    (bot as unknown as EventEmitter).emit('physicsTick');
    expect(controls.left || controls.right).toBe(true);

    controls.left = false;
    controls.right = false;
    (bot as unknown as EventEmitter).emit('physicsTick');
    expect(controls.left || controls.right).toBe(true);
    session.stop();
  });

  it.each([
    ['悬崖', (_y: number): 'air' => 'air'],
    ['岩浆', (y: number): 'air' | 'stone' | 'lava' => y === 63 ? 'lava' : y < 63 ? 'stone' : 'air'],
  ])('10 格风筝时左侧是%s、右侧可站：改走右侧', (_name, leftCell) => {
    const skeleton = foe(7, 'skeleton', 0.5, 10);
    const { bot, controls } = combatRigBot([skeleton]);
    rangedTerrain(bot, (x, y) => x < 0 ? leftCell(y) : y < 64 ? 'stone' : 'air');
    const ranged = rangedRig();
    const { session } = rig(bot, {}, undefined, ranged.actions);
    session.onHurtBy(7, 'skeleton');

    (bot as unknown as EventEmitter).emit('physicsTick');

    expect(controls.left).toBe(false);
    expect(controls.right).toBe(true);
    session.stop();
  });

  it('侧向一格高墙按横移方向起跳，不再按面向目标的 yaw 探测', () => {
    const skeleton = foe(7, 'skeleton', 0.5, 10);
    const { bot, controls } = combatRigBot([skeleton]);
    rangedTerrain(bot, (x, y) => {
      if (x < 0 && y === 64) return 'stone';
      return y < 64 ? 'stone' : 'air';
    });
    const ranged = rangedRig();
    const { session } = rig(bot, {}, undefined, ranged.actions);
    session.onHurtBy(7, 'skeleton');

    (bot as unknown as EventEmitter).emit('physicsTick');

    expect(controls.left).toBe(true);
    expect(controls.jump).toBe(true);
    session.stop();
  });

  it('两侧都没有干燥落脚格时不写水平键', () => {
    const skeleton = foe(7, 'skeleton', 0.5, 10);
    const { bot, controls } = combatRigBot([skeleton]);
    rangedTerrain(bot, (x, y) => {
      if (x < 0) return 'air';
      if (x >= 1 && y === 63) return 'water';
      return y < 64 ? 'stone' : 'air';
    });
    const ranged = rangedRig();
    const { session } = rig(bot, {}, undefined, ranged.actions);
    session.onHurtBy(7, 'skeleton');

    (bot as unknown as EventEmitter).emit('physicsTick');

    expect(controls.forward).toBe(false);
    expect(controls.back).toBe(false);
    expect(controls.left).toBe(false);
    expect(controls.right).toBe(false);
    session.stop();
  });

  it('8/5.5 格滞回保持弓态，8–14 格横移风筝，贴近后回到近战', async () => {
    const zombie = foe(7, 'zombie', 0.5, 10);
    const { bot, attacks, controls } = combatRigBot([zombie]);
    const ranged = rangedRig();
    const { session } = rig(bot, {}, undefined, ranged.actions);
    session.onHurtBy(7, 'zombie');

    (bot as unknown as EventEmitter).emit('physicsTick');
    await waitUntil(() => ranged.shots.length > 0);
    expect((session as unknown as { hybridWeapon: string }).hybridWeapon).toBe('ranged');
    expect(controls.left).toBe(true);

    zombie.position = new Vec3(0.5, 64, 8);
    (bot as unknown as EventEmitter).emit('physicsTick');
    expect((session as unknown as { hybridWeapon: string }).hybridWeapon).toBe('ranged');

    zombie.position = new Vec3(0.5, 64, 3);
    await drive(bot as unknown as EventEmitter, 900);
    expect((session as unknown as { hybridWeapon: string }).hybridWeapon).toBe('melee');
    expect(ranged.aborts).toBeGreaterThan(0);
    expect(attacks).toContain(7);
    session.stop();
  });

  it('死亡、低血撤退和会话结束都先撤销在途拉弓', () => {
    const deathBot = combatRigBot([foe(7, 'skeleton', 20)]);
    const deathRanged = rangedRig();
    const death = rig(deathBot.bot, {}, undefined, deathRanged.actions).session;
    death.onHurtBy(7, 'skeleton');
    (deathBot.bot as unknown as EventEmitter).emit('physicsTick');
    (deathBot.bot as unknown as EventEmitter).emit('death');
    expect(deathRanged.aborts).toBeGreaterThan(0);

    const fleeBot = combatRigBot([foe(7, 'skeleton', 20)]);
    const fleeRanged = rangedRig();
    const flee = rig(fleeBot.bot, {}, undefined, fleeRanged.actions).session;
    flee.onHurtBy(7, 'skeleton');
    (fleeBot.bot as unknown as EventEmitter).emit('physicsTick');
    (fleeBot.bot as unknown as { health: number }).health = 5;
    (fleeBot.bot as unknown as EventEmitter).emit('physicsTick');
    expect(fleeRanged.aborts).toBeGreaterThan(0);
    flee.stop();

    const endBot = combatRigBot([foe(7, 'skeleton', 20)]);
    const endRanged = rangedRig();
    const end = rig(endBot.bot, {}, undefined, endRanged.actions).session;
    end.onHurtBy(7, 'skeleton');
    (endBot.bot as unknown as EventEmitter).emit('physicsTick');
    end.stop();
    expect(endRanged.aborts).toBeGreaterThan(0);
  });

  it('箭数与远程命中单独记账，旧 owner 的事件不能污染下一场', () => {
    const diag = new MinecraftLog();
    const { bot } = combatRigBot([foe(7, 'skeleton', 20)]);
    const ranged = rangedRig();
    const { session } = rig(bot, {}, diag, ranged.actions);
    session.onHurtBy(7, 'skeleton');
    (bot as unknown as EventEmitter).emit('physicsTick');
    const ownerToken = ranged.shots[0].ownerToken;
    const at = Date.now();
    session.onBowEvent({
      kind: 'released', shotId: 1, targetId: 7, ownerToken, at,
      aim: new Vec3(20, 65, 0), hitWindow: { from: at, until: at + 1_500 },
    });
    session.onBowEvent({ kind: 'hit', shotId: 1, targetId: 7, ownerToken, at: at + 20 });
    session.stop();

    expect(diag.after(0).find((entry) => entry.event === 'end')?.data).toMatchObject({
      arrows: 1, rangedLanded: 1, meleeLanded: 0, landed: 1,
    });
    session.onBowEvent({ kind: 'hit', shotId: 1, targetId: 7, ownerToken, at: at + 30 });
    expect(session.claims(7)).toBe(false);
  });
});

describe('战斗会话:打与收', () => {
  it('出手打中目标后 claims 生效;打死由会话说「砍翻了」,收工报战果并恢复队列', async () => {
    const zombie = foe(7, 'zombie', 2.5);
    const { bot, attacks } = combatRigBot([zombie]);
    const { session, events, calls } = rig(bot);
    session.onHurtBy(7, 'zombie');
    // 暴击相位:起跳后下落中出手
    (bot as unknown as { entity: { velocity: { y: number } } }).entity.velocity.y = -0.1;
    await drive(bot as unknown as EventEmitter, 600);
    expect(attacks).toContain(7);
    expect(session.claims(7)).toBe(true);
    // 打死了:会话自己说,不再由 World 补「死了」
    (bot as unknown as EventEmitter).emit('entityDead', { id: 7, name: 'zombie' });
    expect(events.some((e) => e.text.includes('砍翻了僵尸'))).toBe(true);
    expect(events.some((e) => e.text.includes('砍翻了僵尸') && e.text.includes('周围没别的了'))).toBe(true);
    expect(session.claims(7)).toBe(false);
    // Mineflayer 的实体表还没删掉死亡对象、生命又已掉到撤退线；这一拍仍应按清场处理。
    (bot as unknown as { health: number }).health = 5;
    (bot as unknown as EventEmitter).emit('physicsTick');
    expect(events.some((e) => e.text.includes('我先撤'))).toBe(false);
    // E1:场上没怪,滞后 3s 收工;战果 + 队列恢复各一句
    await drive(bot as unknown as EventEmitter, 3400, 100);
    await waitUntil(() => !session.active, 2000);
    expect(calls.resumed).toBe(1);
    expect(events.some((e) => e.text.includes('打完了') && e.text.includes('僵尸'))).toBe(true);
    expect(events.some((e) => e.text.includes('接着做'))).toBe(true);
    session.stop();
  }, 15_000);

  /**
   * 携带弓箭不能扩大普通战斗的退出扫描范围，否则未交手的远处敌人会一直阻止任务恢复。
   */
  it('带弓时退出半径不被撑开:25 格外那只没交过手的骷髅拦不住收工', async () => {
    const zombie = foe(7, 'zombie', 2.5);
    const skeleton = foe(9, 'skeleton', 25);
    const { bot } = combatRigBot([zombie, skeleton]);
    const ranged = rangedRig();
    const { session, events } = rig(bot, {}, undefined, ranged.actions);
    session.onHurtBy(7, 'zombie');
    (bot as unknown as { entity: { velocity: { y: number } } }).entity.velocity.y = -0.1;
    await drive(bot as unknown as EventEmitter, 600);
    // 打死近处那只;25 格外的骷髅还在实体表里,但它一次都没打过我们
    zombie.isValid = false;
    (bot as unknown as EventEmitter).emit('entityDead', { id: 7, name: 'zombie' });
    delete (bot as unknown as { entities: Record<number, unknown> }).entities[7];
    await drive(bot as unknown as EventEmitter, 3600, 100);
    await waitUntil(() => !session.active, 2000);
    expect(session.active).toBe(false);
    // 「还剩几只」也按退出口径报:远处那只没交过手的不算在内
    expect(events.some((e) => e.text.includes('砍翻了僵尸') && e.text.includes('周围没别的了'))).toBe(true);
    session.stop();
  }, 15_000);

  it('交过手的远程目标照旧留在场上:25 格外的骷髅射过我们就不算清场', async () => {
    const skeleton = foe(9, 'skeleton', 25);
    const { bot } = combatRigBot([skeleton]);
    const ranged = rangedRig();
    const { session } = rig(bot, {}, undefined, ranged.actions);
    expect(session.onHurtBy(9, 'skeleton')).toBe(true);
    await drive(bot as unknown as EventEmitter, 3600, 100);
    expect(session.active).toBe(true);
    session.stop();
  }, 15_000);

  it('E3 硬时长:到点强制收手,点名还剩几只', async () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.5), foe(8, 'zombie', 4)]);
    const { session, events, calls } = rig(bot, { maxSec: 1 });
    session.onHurtBy(7, 'zombie');
    await drive(bot as unknown as EventEmitter, 1300, 100);
    expect(session.active).toBe(false);
    expect(events.some((e) => e.text.includes('打太久了') && e.text.includes('2 只'))).toBe(true);
    expect(calls.resumed).toBe(1);
    session.stop();
  }, 10_000);

  it('E2 血线:低血收手转撤退,撤完恢复队列', async () => {
    const zombie = foe(7, 'zombie', 2.5);
    const { bot } = combatRigBot([zombie]);
    const { session, events, calls } = rig(bot);
    session.onHurtBy(7, 'zombie');
    (bot as unknown as { health: number }).health = 5;
    await drive(bot as unknown as EventEmitter, 200);
    expect(events.some((e) => e.text.includes('血被打到 5/20') && e.text.includes('先撤'))).toBe(true);
    // 怪不在追击圈内后还要守住无伤时窗，不能靠一拍实体表丢失假完成。
    zombie.position = new Vec3(60, 64, 0.5);
    await drive(bot as unknown as EventEmitter, 1_700);
    await waitUntil(() => !session.active, 2000);
    expect(calls.resumed).toBe(1);
    session.stop();
  }, 10_000);

  it('mc_stop = 收手 + 撤退,不是原地站住', async () => {
    const zombie = foe(7, 'zombie', 2.5);
    const { bot } = combatRigBot([zombie]);
    const { session, calls } = rig(bot);
    session.onHurtBy(7, 'zombie');
    expect(session.requestStop()).toContain('收手');
    expect(session.active).toBe(true); // 还在撤,没有原地放手
    zombie.position = new Vec3(40, 64, 0.5);
    await drive(bot as unknown as EventEmitter, 1_700);
    expect(session.active).toBe(false);
    expect(calls.resumed).toBe(1);
    session.stop();
  }, 10_000);

  it('E6:环境自保夺权时静默让位,一句话都不抢', async () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.5)]);
    const { session, events, calls } = rig(bot);
    session.onHurtBy(7, 'zombie');
    const before = events.length;
    session.yieldToEnv();
    expect(session.active).toBe(false);
    expect(calls.resumed).toBe(0);
    expect(events.length).toBe(before); // 让位不发事件,由环境反射自己汇报
    session.stop();
  });

  it('断线终止会话但不在失联窗口恢复冻结任务', () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.5)]);
    const { session, calls } = rig(bot);
    session.onHurtBy(7, 'zombie');

    session.onConnectionLost();

    expect(session.active).toBe(false);
    expect(calls.resumed).toBe(0);
    session.stop();
  });
});

/**
 * bot.attack() 只发包，没有命中确认；本组断言出手次数与抢占原因，出手不能等同命中。
 */
describe('战斗:打不中它的时候', () => {
  it('E8:够得着、刀也挥了,却一下没打中,6 秒后收手——不再耗到 E3 硬时长', async () => {
    const { bot, attacks } = combatRigBot([foe(7, 'zombie', 2.5)]);
    const { session, events, calls } = rig(bot);
    session.onHurtBy(7, 'zombie');
    await drive(bot, 7_000, 100);
    expect(attacks.length).toBeGreaterThanOrEqual(3); // 刀确实挥出去了
    const quit = events.find((e) => e.text.includes('一下都没打到'));
    expect(quit).toBeDefined();
    expect(quit!.text).toContain('僵尸');
    expect(session.active).toBe(false);
    expect(calls.resumed).toBe(1);
    session.stop();
  }, 15_000);

  it('繁忙闸按正常收尾恢复断点', () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.5)]);
    const { session, calls } = rig(bot);
    session.onHurtBy(7, 'zombie');

    (session as unknown as { end(reason: 'busy'): void }).end('busy');

    expect(session.active).toBe(false);
    expect(calls.resumed).toBe(1);
    session.stop();
  });

  it('够不着就平视它的方向:视线不扎向脚下那一格', async () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 5.5)]);
    const looks: Array<{ y: number }> = [];
    (bot as unknown as { lookAt: (p: { y: number }) => Promise<void> })
      .lookAt = async (p) => { looks.push(p); };
    const { session } = rig(bot);
    session.onHurtBy(7, 'zombie');
    await drive(bot, 1_000, 100);
    expect(looks.length).toBeGreaterThan(0);
    // 眼高 1.62:够不着时每一次都平着看过去,而不是瞄怪脚下(y≈64.x)
    for (const p of looks) expect(p.y).toBeCloseTo(64 + 1.62, 5);
    session.stop();
  }, 10_000);
});

describe('战斗:抢占方与出手记账', () => {
  it('夺手时点名是哪一只怪触发的:执行器据此填 aborted 的抢占方', () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.5)]);
    const { session, calls } = rig(bot);
    session.onHurtBy(7, 'zombie');
    expect(calls.suspendedBy).toEqual(['战斗:被僵尸打了']);
    session.stop();
  });

  it('打不过的那类(E7)也点名,措辞与主动进场分得开', () => {
    const { bot } = combatRigBot([foe(7, 'warden', 2.5)]);
    const { session, calls } = rig(bot);
    session.onHurtBy(7, 'warden');
    expect(calls.suspendedBy[0]).toContain('打不过');
    session.stop();
  });

  /** 喂 tick 直到出了一刀;`onSwing` 在同一拍里跑,用来模拟服务端的回应 */
  async function untilSwing(
    bot: EventEmitter, attacks: number[], onSwing: () => void, budgetMs = 4000,
  ): Promise<boolean> {
    for (let t = 0; t < budgetMs; t += 50) {
      const before = attacks.length;
      bot.emit('physicsTick');
      if (attacks.length > before) { onSwing(); return true; }
      await sleep(50);
    }
    return false;
  }

  it('收工日志分账挥刀次数与命中次数:够不着的空挥不再与命中同形', async () => {
    const diag = new MinecraftLog();
    const { bot, attacks } = combatRigBot([foe(7, 'zombie', 2.5)]);
    const em = bot as unknown as EventEmitter;
    const { session } = rig(bot, {}, diag);
    session.onHurtBy(7, 'zombie');
    // 只有第一刀落在目标身上,之后照挥不报掉血
    expect(await untilSwing(em, attacks, () => em.emit('entityHurt', { id: 7 }))).toBe(true);
    await drive(em, 1200);
    session.stop();
    const end = diag.after(0).find((e) => e.event === 'end')!;
    expect(attacks.length).toBeGreaterThan(1);
    expect(end.data!.swings).toBe(attacks.length);
    expect(end.data!.landed).toBe(1);
    expect(end.msg).toContain(`挥刀 ${attacks.length} 次命中 1 次`);
  }, 15_000);

  it('别人打掉的血不记进命中:超窗的掉血与别的实体掉血都不算我们那一刀', async () => {
    const diag = new MinecraftLog();
    const { bot, attacks } = combatRigBot([foe(7, 'zombie', 2.5)]);
    const em = bot as unknown as EventEmitter;
    const { session } = rig(bot, {}, diag);
    session.onHurtBy(7, 'zombie');
    expect(await untilSwing(em, attacks, () => {
      // 同一拍里别的实体掉血:不是我们打的那只
      em.emit('entityHurt', { id: 99 });
    })).toBe(true);
    await sleep(500); // 出刀之后隔了半秒,已经出了一个往返的窗口
    em.emit('entityHurt', { id: 7 });
    session.stop();
    expect(diag.after(0).find((e) => e.event === 'end')!.data!.landed).toBe(0);
  }, 15_000);
});

/**
 * 服务端近战在 reach≤3 时不检查遮挡；客户端视线断开时须停止挥刀，也不能将隔墙目标记作够得着。
 */
describe('战斗:隔着方块不出手', () => {
  it('射线被方块挡住:够得着也不挥;视线恢复才开打', async () => {
    const { bot, attacks } = combatRigBot([foe(7, 'zombie', 2.5)]);
    let blocked = true;
    (bot as unknown as Record<string, unknown>).world = {
      raycast: () => (blocked ? { position: { x: 1, y: 64, z: 0 } } : null),
    };
    const { session } = rig(bot);
    session.onHurtBy(7, 'zombie');
    await drive(bot as unknown as EventEmitter, 1_200);
    expect(attacks.length).toBe(0);
    blocked = false;
    await drive(bot as unknown as EventEmitter, 1_500);
    expect(attacks.length).toBeGreaterThan(0);
    session.stop();
  }, 15_000);
});

/**
 * 水中撤退须按跳键向岸游；连续受击且敌人贴身时转为还手，血线不再阻止。
 */
describe('战斗:水里与逃不掉', () => {
  /** 头在水面上、脚泡在水里的假 bot;x≥5 是岸 */
  function swimRigBot(foes: FakeFoe[] = []) {
    const r = combatRigBot(foes);
    (r.bot as unknown as Record<string, unknown>).blockAt = (p: { x: number; y: number }) => {
      const onLand = p.x >= 5;
      if (p.y >= 65) return { name: 'air', boundingBox: 'empty' };
      if (p.y === 64) return onLand
        ? { name: 'air', boundingBox: 'empty' }
        : { name: 'water', boundingBox: 'empty' };
      if (p.y === 63) return onLand
        ? { name: 'stone', boundingBox: 'block' }
        : { name: 'water', boundingBox: 'empty' };
      return { name: 'stone', boundingBox: 'block' };
    };
    return r;
  }

  it('低血在水里被打:撤退带登岸目标,水里按住跳不沉底', async () => {
    const diag = new MinecraftLog();
    const { bot, controls } = swimRigBot([foe(7, 'drowned', 2.5)]);
    (bot as unknown as { health: number }).health = 5;
    const { session } = rig(bot, {}, diag);
    session.onHurtBy(7, 'drowned');
    expect(session.active).toBe(true); // 血线拒战也不是不管:转撤退
    await drive(bot as unknown as EventEmitter, 300);
    expect(diag.after(0).some((e) => e.event === 'retreat-to-bank')).toBe(true);
    expect(controls.jump).toBe(true); // 水里不按跳就往下沉
    session.stop();
  }, 15_000);

  it('撤退路上挨两下、怪还贴着:转身还手,血线不再把人按回撤退', async () => {
    const diag = new MinecraftLog();
    const { bot, attacks } = combatRigBot([foe(7, 'zombie', 1.8)]);
    (bot as unknown as { health: number }).health = 5;
    const { session, events } = rig(bot, {}, diag);
    session.onHurtBy(7, 'zombie'); // 血线拒战 → 撤退
    await drive(bot as unknown as EventEmitter, 1_600);
    session.onHurtBy(7, 'zombie'); // 撤退路上还在挨打
    session.onHurtBy(7, 'zombie');
    await drive(bot as unknown as EventEmitter, 400);
    expect(diag.after(0).some((e) => e.event === 'cornered')).toBe(true);
    expect(events.some((e) => e.text.includes('回头打'))).toBe(true);
    // 血 5/20 也照打:E2 对本场静默,挥得出刀
    await drive(bot as unknown as EventEmitter, 1_500);
    expect(attacks.length).toBeGreaterThan(0);
    session.stop();
  }, 15_000);
});

/**
 * 空手且低血时，受击的默认反应是脱离。
 */
describe('空手低血:挨打的默认反应改成脱离', () => {
  function bareHanded(foes: Parameters<typeof combatRigBot>[0], health: number) {
    const r = combatRigBot(foes);
    (r.bot as unknown as { inventory: { items: () => unknown[] } }).inventory.items = () => [];
    (r.bot as unknown as { heldItem: unknown }).heldItem = null;
    (r.bot as unknown as { health: number }).health = health;
    return r;
  }

  it('空手 + 血低于入场线:不还手,当场撤,并说明为什么', () => {
    const diag = new MinecraftLog();
    // 11 落在「挨打还手线 10」与「主动进场线 13」之间:有家伙就照打,空手就不打
    const { bot } = bareHanded([foe(7, 'zombie', 2.2)], 11);
    const { session, events, calls } = rig(bot, {}, diag);
    expect(session.onHurtBy(7, 'zombie')).toBe(true); // 会话仍接手(不退回反射自己抡)
    expect(session.active).toBe(true);
    expect(calls.suspended).toBe(1);
    expect(events[0].text).toContain('空手');
    expect(events[0].text).toContain('不还手');
    expect(events[0].text).not.toContain('抄家伙');
    expect(diag.after(0).some((e) => e.event === 'barehand-flee')).toBe(true);
    session.stop();
  });

  it('空手但血还够:照旧还手 —— 闸只钉在"空手且低血"这一对上', () => {
    const { bot } = bareHanded([foe(7, 'zombie', 2.2)], 20);
    const { session, events } = rig(bot); // 20 ≥ 13,闸不管
    expect(session.onHurtBy(7, 'zombie')).toBe(true);
    expect(events[0].text).toContain('抄家伙还手');
    session.stop();
  });

  it('同一条血线上有家伙就照打:闸分的是手上有没有东西,不是血本身', () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.2)]); // 包里有铁剑
    (bot as unknown as { health: number }).health = 11;
    const { session, events } = rig(bot);
    expect(session.onHurtBy(7, 'zombie')).toBe(true);
    expect(events[0].text).toContain('抄家伙还手'); // 挨打不加入场余量,照旧还手
    expect(events[0].text).not.toContain('空手');
    session.stop();
  });

  it('血再低一档:有家伙走原来的血线拒战那一支,措辞不变', () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.2)]);
    (bot as unknown as { health: number }).health = 6;
    const { session, events } = rig(bot);
    expect(session.onHurtBy(7, 'zombie')).toBe(true);
    expect(events[0].text).toContain('这架不接了');
    session.stop();
  });

  it('三档 fight 不受影响:off 档空手低血挨打仍走脱离,不是"什么都不做"', () => {
    const { bot } = bareHanded([foe(7, 'zombie', 2.2)], 11);
    const { session, events } = rig(bot, { fight: 'off' });
    expect(session.onHurtBy(7, 'zombie')).toBe(true);
    expect(events[0].text).toContain('不还手');
    session.stop();
  });
});

/**
 * queue:"now" 可以夺回普通战斗的执行权；低血或尚未安全结束的撤退只更新后续任务意图。
 */
describe('standDown:queue:"now" 夺手', () => {
  it('当场交还身体但不恢复旧断点，并把刚才在做什么交回给受理回执', () => {
    const diag = new MinecraftLog();
    const { bot } = combatRigBot([foe(7, 'zombie', 2.2)]);
    const { session, calls } = rig(bot, {}, diag);
    session.onHurtBy(7, 'zombie');
    expect(session.active).toBe(true);
    expect(session.standDown()).toBe('正在跟怪打');
    expect(session.active).toBe(false);
    expect(calls.resumed).toBe(0); // 抢占方负责启动新意图，旧断点不能在这里抢跑
    expect(diag.after(0).some((e) => e.event === 'stand-down')).toBe(true);
    session.stop();
  });

  it('交还之后不出「接着做」那一句:它紧接着就被新任务顶掉了', () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.2)]);
    const { session, events } = rig(bot);
    session.onHurtBy(7, 'zombie');
    session.standDown();
    expect(events.some((e) => e.text.includes('接着做'))).toBe(false);
    expect(events.some((e) => e.text.includes('先不打了'))).toBe(true);
    session.stop();
  });

  it('交还之后留一段宽限:250ms 巡检不会立刻把刚开跑的那一单再挂起', async () => {
    const { bot } = combatRigBot([foe(7, 'zombie', 2.2)]);
    const { session, calls } = rig(bot);
    session.onHurtBy(7, 'zombie');
    session.standDown();
    session.start();
    await sleep(700);
    expect(session.active).toBe(false);
    expect(calls.suspended).toBe(1); // 只有最初那一次
    session.stop();
  });

  it('本来就没在打:返回 null,不惊动任何东西', () => {
    const { bot } = combatRigBot([]);
    const { session, calls } = rig(bot);
    expect(session.standDown()).toBeNull();
    expect(calls.resumed).toBe(0);
    session.stop();
  });

  it('低血撤退不交手:now 排在脱身后,不重置撤退会话', () => {
    const diag = new MinecraftLog();
    const { bot } = combatRigBot([foe(7, 'skeleton', 7)]);
    (bot as unknown as { health: number }).health = 5;
    const { session, calls } = rig(bot, {}, diag);
    session.onHurtBy(7, 'skeleton');
    session.onHurtBy(7, 'skeleton');
    expect(session.active).toBe(true);

    expect(session.standDown()).toBeNull();

    expect(session.active).toBe(true);
    expect(calls.resumed).toBe(0);
    expect(diag.after(0).some((e) => e.event === 'stand-down-deferred')).toBe(true);
    // 会话仍认得撤退中的伤害，后续同一来源继续由它接手。
    expect(session.onHurtBy(7, 'skeleton')).toBe(true);
    session.stop();
  });

  it('撤退里 10 秒没挨打、血也在线:now 能把身体要回去', () => {

    const diag = new MinecraftLog();
    const { bot } = combatRigBot([foe(7, 'skeleton', 10)]);
    (bot as unknown as { health: number }).health = 5;
    const { session, calls } = rig(bot, {}, diag);
    session.onHurtBy(7, 'skeleton'); // 血线拒战 → 撤退
    expect(session.active).toBe(true);
    (bot as unknown as { health: number }).health = 15;
    Object.assign(session as unknown as Record<string, unknown>, { retreatLastHurtAt: Date.now() - 11_000 });

    expect(session.standDown()).toBe('正在跟怪打');

    expect(session.active).toBe(false);
    expect(calls.resumed).toBe(0);
    expect(diag.after(0).some((e) => e.event === 'stand-down-deferred')).toBe(false);
    expect(diag.after(0).some((e) => e.event === 'stand-down')).toBe(true);
    session.stop();
  });

  it('撤退里刚挨过打:now 仍排在脱身后', () => {
    const diag = new MinecraftLog();
    const { bot } = combatRigBot([foe(7, 'skeleton', 10)]);
    (bot as unknown as { health: number }).health = 5;
    const { session } = rig(bot, {}, diag);
    session.onHurtBy(7, 'skeleton');
    (bot as unknown as { health: number }).health = 15;
    Object.assign(session as unknown as Record<string, unknown>, { retreatLastHurtAt: Date.now() - 2_000 });

    expect(session.standDown()).toBeNull();
    expect(session.active).toBe(true);
    expect(diag.after(0).find((e) => e.event === 'stand-down-deferred')?.msg).toContain('刚挨过打');
    session.stop();
  });

  it('够不着收工之后留一段冷却:圈里那只下一拍不会再把她拖进去', async () => {

    const { bot } = combatRigBot([foe(7, 'zombie', 2.2)]);
    const { session, calls } = rig(bot);
    session.onHurtBy(7, 'zombie');
    expect(session.active).toBe(true);
    (session as unknown as { end(reason: string): void }).end('stuck');
    expect(session.active).toBe(false);

    session.start();
    await sleep(700);
    expect(session.active).toBe(false);
    expect(calls.suspended).toBe(1); // 只有最初那一次
    expect(session.onHurtBy(7, 'zombie')).toBe(false); // 冷却里挨打退回反射降级
    session.stop();
  });
});

describe('撤退:安全结束与失败升级', () => {
  it('远程骷髅在 3.2 格外持续命中、撤退无进展:转身处理威胁而非一直背身跑', async () => {
    const diag = new MinecraftLog();
    const { bot } = combatRigBot([foe(7, 'skeleton', 7)]);
    (bot as unknown as { health: number }).health = 5;
    const { session, events, calls } = rig(bot, {}, diag);
    session.onHurtBy(7, 'skeleton');
    await drive(bot as unknown as EventEmitter, 1_600);
    session.onHurtBy(7, 'skeleton');
    session.onHurtBy(7, 'skeleton');
    (bot as unknown as EventEmitter).emit('physicsTick');

    const cornered = diag.after(0).find((e) => e.event === 'cornered');
    expect(cornered?.data).toMatchObject({ cause: 'stalled', foe: 'skeleton' });
    expect(events.some((e) => e.text.includes('远处压着我') && e.text.includes('回头打'))).toBe(true);
    expect(session.active).toBe(true);
    expect(calls.resumed).toBe(0);
    session.stop();
  }, 10_000);

  it('堵住直到撤退时限:时限只升级策略,威胁仍近时不报跑开、不恢复任务', () => {
    const diag = new MinecraftLog();
    const { bot } = combatRigBot([foe(7, 'zombie', 5)]);
    (bot as unknown as { health: number }).health = 5;
    const { session, events, calls } = rig(bot, {}, diag);
    session.onHurtBy(7, 'zombie');
    Object.assign(session as unknown as Record<string, unknown>, {
      retreatStartedAt: Date.now() - 9_000,
      retreatProgressAt: Date.now() - 9_000,
    });

    (bot as unknown as EventEmitter).emit('physicsTick');

    // RETREAT_MAX_MS 到期只升级提示，不因此判为 cornered 或转身还手。
    expect(diag.after(0).find((e) => e.event === 'cornered')).toBeUndefined();
    expect(diag.after(0).find((e) => e.event === 'retreat-extended')?.data)
      .toMatchObject({ why: 'flee' });
    expect(events.some((e) => e.text.includes('回头打'))).toBe(false);
    expect(events.some((e) => e.text.includes('跑开了'))).toBe(false);
    expect(session.active).toBe(true);
    expect(calls.resumed).toBe(0);
    session.stop();
  });

  it('撤退跑满时限但怪已经拉开:不转身还手,继续撤,也不报跑开', () => {
    const diag = new MinecraftLog();
    const { bot, attacks } = combatRigBot([foe(7, 'skeleton', 14.7)]);
    (bot as unknown as { health: number }).health = 5;
    const { session, events } = rig(bot, {}, diag);
    session.onHurtBy(7, 'skeleton');
    Object.assign(session as unknown as Record<string, unknown>, {
      retreatStartedAt: Date.now() - 9_000,
      retreatProgressAt: Date.now() - 9_000,
    });

    (bot as unknown as EventEmitter).emit('physicsTick');

    // 血 5/20 冲 14.7 格外的骷髅是自造的死亡主线:一下没挨、拉开到近 15 格,
    // 撤退在客观上是成功的
    expect(diag.after(0).some((e) => e.event === 'cornered')).toBe(false);
    expect(attacks.length).toBe(0);
    expect(events.some((e) => e.text.includes('回头打'))).toBe(false);
    session.stop();
  });

  it('空手低血被堵住:入场侧那道空手闸 cornered 也认,不转身空手对砍', async () => {
    const diag = new MinecraftLog();
    const { bot, attacks } = combatRigBot([foe(7, 'zombie', 1.8)]);
    (bot as unknown as { health: number }).health = 5;
    const { session, events } = rig(bot, {}, diag);
    session.onHurtBy(7, 'zombie'); // 手上还有剑:血线拒战 → 撤退
    await drive(bot as unknown as EventEmitter, 1_600);
    // 撤退路上剑没了(掉耐久断了/被换手):空手 + 血 5 低于 fleeHealth(10)+3
    (bot as unknown as Record<string, unknown>).heldItem = null;
    (bot as unknown as { inventory: { items: () => unknown[] } }).inventory.items = () => [];
    session.onHurtBy(7, 'zombie');
    session.onHurtBy(7, 'zombie');
    await drive(bot as unknown as EventEmitter, 400);

    expect(diag.after(0).some((e) => e.event === 'cornered')).toBe(false);
    expect(diag.after(0).find((e) => e.event === 'cornered-barehand')?.data)
      .toMatchObject({ foe: 'zombie', health: 5 });
    expect(events.some((e) => e.text.includes('回头打'))).toBe(false);
    expect(attacks.length).toBe(0);
    session.stop();
  }, 15_000);

  it('威胁真正拉开并守住无伤时窗后才结束、恢复任务', async () => {
    const zombie = foe(7, 'zombie', 2.5);
    const { bot } = combatRigBot([zombie]);
    (bot as unknown as { health: number }).health = 5;
    const { session, events, calls } = rig(bot);
    session.onHurtBy(7, 'zombie');
    zombie.position = new Vec3(40, 64, 0.5);

    await drive(bot as unknown as EventEmitter, 800);
    expect(session.active).toBe(true);
    expect(calls.resumed).toBe(0);
    await drive(bot as unknown as EventEmitter, 1_000);

    expect(session.active).toBe(false);
    expect(calls.resumed).toBe(1);
    expect(events.some((e) => e.text.includes('跑开了'))).toBe(true);
    session.stop();
  }, 10_000);

  it('跑不动也没人打:撤退到时收工还身体,不再无限持有', () => {
    // 远处上层的骷髅不离开范围也不再次命中，玩家无法移动；夹具覆盖常规撤退出口均未满足的状态。
    const diag = new MinecraftLog();
    const { bot } = combatRigBot([foe(7, 'skeleton', 10)]);
    (bot as unknown as { health: number }).health = 5;
    const { session, events, calls } = rig(bot, {}, diag);
    session.onHurtBy(7, 'skeleton');
    (bot as unknown as { health: number }).health = 15;
    Object.assign(session as unknown as Record<string, unknown>, {
      retreatStartedAt: Date.now() - 12_000,
      retreatProgressAt: Date.now() - 12_000,
      retreatLastHurtAt: Date.now() - 11_000,
    });

    (bot as unknown as EventEmitter).emit('physicsTick');

    expect(diag.after(0).find((e) => e.event === 'retreat-idle')?.data).toMatchObject({ why: 'flee', hits: 0 });
    expect(diag.after(0).find((e) => e.event === 'cornered')).toBeUndefined();
    expect(events.some((e) => e.text.includes('先把手还回去'))).toBe(true);
    expect(session.active).toBe(false);
    expect(calls.resumed).toBe(1);
    session.stop();
  });

  it('跑不动但 10 秒内挨过打:撤退照旧,只升级不收工', () => {
    const diag = new MinecraftLog();
    const { bot } = combatRigBot([foe(7, 'skeleton', 10)]);
    (bot as unknown as { health: number }).health = 5;
    const { session, calls } = rig(bot, {}, diag);
    session.onHurtBy(7, 'skeleton');
    Object.assign(session as unknown as Record<string, unknown>, {
      retreatStartedAt: Date.now() - 12_000,
      retreatProgressAt: Date.now() - 12_000,
      retreatLastHurtAt: Date.now() - 3_000,
    });

    (bot as unknown as EventEmitter).emit('physicsTick');

    expect(diag.after(0).find((e) => e.event === 'retreat-idle')).toBeUndefined();
    expect(diag.after(0).find((e) => e.event === 'retreat-extended')).toBeDefined();
    expect(session.active).toBe(true);
    expect(calls.resumed).toBe(0);
    session.stop();
  });
});

/**
 * 血量播报向上取整，与 HUD 半颗心显示一致；血线判定仍使用浮点原值。
 */
describe('血量播报向上取整', () => {
  it('0.086 血挨打:拒战文案与 diag 都写 1/20,不写 0/20', () => {
    const diag = new MinecraftLog();
    const { bot } = combatRigBot([foe(7, 'zombie', 2.2)]);
    (bot as unknown as { health: number }).health = 0.086;
    const { session, events } = rig(bot, {}, diag);
    expect(session.onHurtBy(7, 'zombie')).toBe(true);
    expect(events[0].text).toContain('血只剩 1/20');
    expect(events[0].text).not.toContain('0/20');
    const refused = diag.after(0).find((e) => e.event === 'engage-refused');
    expect(refused?.msg).toContain('生命 1/20');
    expect(refused?.data).toMatchObject({ health: 0.086 });
    session.stop();
  });
});

describe('末地:龙只报不撤,撤退不朝悬崖跑', () => {
  it('末影龙打中:只播报(不急报),不挂起任务、不撤退', () => {
    const { bot } = combatRigBot([foe(9, 'ender_dragon', 2.5)]);
    const { session, events, calls } = rig(bot);
    expect(session.onHurtBy(9, 'ender_dragon')).toBe(false);
    expect(calls.suspended).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].text).toContain('不在自动撤退之列');
    expect(events[0].urgent).toBe(false);
    session.stop();
  });

  /** x < 0 整柱是空的(岛边往下是虚空),其余 y < 64 是石头 */
  function cliffBlockAt(p: { x: number; y: number }) {
    if (p.x < 0 || p.y >= 64) return { name: 'air', boundingBox: 'empty' };
    return { name: 'stone', boundingBox: 'block' };
  }

  it('footingAhead:前方整柱空是悬崖,3 格内有实心算踩得住,落脚面是岩浆不算', () => {
    const { bot } = combatRigBot();
    const b = bot as unknown as { blockAt: unknown };
    b.blockAt = cliffBlockAt;
    expect(footingAhead(bot, -1, 0)).toBe(false);
    expect(footingAhead(bot, 1, 0)).toBe(true);
    b.blockAt = (p: { y: number }) => (p.y === 62
      ? { name: 'lava', boundingBox: 'empty' }
      : p.y < 62 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' });
    expect(footingAhead(bot, 1, 0)).toBe(false);
  });

  it('背对怪群那边是悬崖:撤退改走侧面,记一条 retreat-edge', async () => {
    const diag = new MinecraftLog();
    const { bot } = combatRigBot([foe(7, 'zombie', 2.5)]);
    (bot as unknown as { health: number }).health = 5;
    (bot as unknown as { blockAt: unknown }).blockAt = cliffBlockAt;
    const { session } = rig(bot, {}, diag);
    session.onHurtBy(7, 'zombie');
    expect(session.active).toBe(true);
    await drive(bot as unknown as EventEmitter, 300);
    const edge = diag.after(0).find((e) => e.event === 'retreat-edge');
    expect(edge?.msg).toContain('改走侧面');
    session.stop();
  }, 15_000);
});
