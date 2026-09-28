import { describe, expect, it } from 'vitest';
import {
  bearing, bodyInWater, classifyEntity, cropAgeAt, dayNightTransition, droppedStackOf, facingDegrees,
  facingOf, findBankCell, isNight, isBackground, isRaining, narrateWorld, narrateWorldSegments,
  pitchPhrase, pocketScan, scanMatureCrops, snapshotFingerprint, snapshotFromBot, standCellsAround,
  timePhrase, villagerNote, wetNote, worldDelta,
  type BlockReader, type ItemStack, type WorldSnapshot,
} from '../../../src/worlds/minecraft/terrain.ts';

function snap(over: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    position: { x: 100, y: 64, z: -20 },
    dimension: 'overworld',
    health: 20,
    food: 18,
    oxygen: 20,
    inWater: false,
    invSynced: true,
    timeOfDay: 6000,
    realTime: '2026-08-19T20:15:33+08:00',
    light: null,
    raining: false,
    biome: 'plains',
    gameMode: 'survival',
    heldItem: 'stone_pickaxe',
    inventory: [
      { name: 'oak_log', count: 12 },
      { name: 'bread', count: 3 },
      { name: 'oak_log', count: 5 },
    ],
    xpLevel: 0,
    equipment: [],
    effects: [],
    entities: [
      { name: 'zombie', kind: 'hostile', distance: 8.24, direction: 'north', dy: 0, visible: true },
      { name: 'Alice', kind: 'player', distance: 3.1, direction: 'east', dy: 0, visible: true },
    ],
    entitiesOmitted: 0,
    standingOn: 'grass_block',
    nearbyBlocks: [{ name: 'iron_ore', distance: 11.3, direction: 'south', dy: -4, x: 100, y: 60, z: -9 }],
    blocksScanned: true,
    players: ['Alice', 'corti'],
    terrain: [],
    motion: 'still',
    speed: 0,
    facing: 'south',
    heading: null,
    onGround: true,
    ...over,
  };
}

describe('worldDelta', () => {
  it('小位移不值得说', () => {
    const a = snap();
    const b = snap({ position: { x: 105, y: 64, z: -20 } });
    expect(worldDelta(a, b, 24).notes).toEqual([]);
  });

  it('过阈值位移、群系变化、开始下雨都会被点名', () => {
    const a = snap();
    const b = snap({ position: { x: 160, y: 70, z: -20 }, biome: 'forest', raining: true });
    const { notes } = worldDelta(a, b, 24);
    expect(notes.join(';')).toContain('走了');
    expect(notes.join(';')).toContain('往东'); // 位移带上方向
    expect(notes.join(';')).toContain('森林'); // 群系名也说中文
    expect(notes.join(';')).toContain('下雨');
  });

  it('换维度不把两边坐标差渲染成步行位移或跨维度群系变化', () => {
    const before = snap({
      dimension: 'minecraft:overworld',
      position: { x: -228, y: 73, z: 58 },
      biome: 'plains',
    });
    const after = snap({
      dimension: 'the_nether',
      position: { x: -33, y: 70, z: 15 },
      biome: 'nether_wastes',
      raining: true,
    });
    const said = worldDelta(before, after, 24).notes.join(';');
    expect(said).not.toContain('走了');
    expect(said).not.toContain('下界荒地');
    expect(said).not.toContain('下雨');
  });

  it('实体进出不进摘要:由 World 的接近状态机报,快照对比只管环境与随身', () => {
    const a = snap({ entities: [] });
    const b = snap(); // 一只 zombie
    expect(worldDelta(a, b, 24).notes).toEqual([]);
    expect(worldDelta(b, a, 24).notes).toEqual([]);
  });

  it('包里的增减自己成一条:执行器说合成了什么之外的独立核对渠道', () => {
    const a = snap({ inventory: [{ name: 'acacia_log', count: 5 }] });
    const b = snap({ inventory: [{ name: 'acacia_log', count: 4 }, { name: 'acacia_planks', count: 4 }] });
    const notes = worldDelta(a, b, 24).notes.join(';');
    expect(notes).toContain('多了 金合欢木板×4');
    expect(notes).toContain('少了 金合欢原木×1');
  });

  it('增减都带变化之后的总数:一路的流水加起来是错的,够没够只有总数答得上', () => {
    const a = snap({ inventory: [{ name: 'spruce_log', count: 9 }, { name: 'crafting_table', count: 1 }] });
    const b = snap({ inventory: [{ name: 'spruce_log', count: 13 }] });
    const notes = worldDelta(a, b, 24).notes.join(';');
    expect(notes).toContain('云杉原木×4(共 13)');
    expect(notes).toContain('工作台×1(剩 0)');
  });

  it('物品栏还没同步时不比对:空栏当基准会把整包东西报成刚到手', () => {
    const a = snap({ invSynced: false, inventory: [] });
    const b = snap({ inventory: [{ name: 'stone', count: 30 }] });
    expect(worldDelta(a, b, 24).notes).toEqual([]);
  });

  it('饥饿跨档才说,档内浮动不吵', () => {
    const full = snap({ food: 20 });
    expect(worldDelta(full, snap({ food: 19 }), 24).notes).toEqual([]);
    expect(worldDelta(full, snap({ food: 5 }), 24).notes.join(';')).toContain('快饿坏了');
  });

  it('伤害事件由含攻击者信息的 World 播报处理', () => {
    expect(worldDelta(snap({ health: 20 }), snap({ health: 7 }), 24).notes).toEqual([]);
  });

  describe('inventoryOnly:调用方据此选搭车档', () => {
    it('只有包里增减时为真', () => {
      const a = snap({ inventory: [{ name: 'dirt', count: 3 }] });
      const b = snap({ inventory: [{ name: 'dirt', count: 9 }] });
      expect(worldDelta(a, b, 24).inventoryOnly).toBe(true);
    });

    it('同一批里还有位移就为假:走路那条照常唤醒', () => {
      const a = snap({ inventory: [{ name: 'dirt', count: 3 }] });
      const b = snap({ position: { x: 160, y: 64, z: -20 }, inventory: [{ name: 'dirt', count: 9 }] });
      const d = worldDelta(a, b, 24);
      expect(d.notes.join(';')).toContain('包里多了');
      expect(d.inventoryOnly).toBe(false);
    });

    it('饥饿跨档与天候同样按不搭车算', () => {
      const a = snap({ food: 20, inventory: [{ name: 'dirt', count: 3 }] });
      expect(worldDelta(a, snap({ food: 5, inventory: [{ name: 'dirt', count: 9 }] }), 24).inventoryOnly)
        .toBe(false);
      expect(worldDelta(a, snap({ food: 20, raining: true, inventory: [{ name: 'dirt', count: 9 }] }), 24).inventoryOnly)
        .toBe(false);
    });

    it('没有变化时为假:空摘要根本不推,别让它看起来像一条搭车帧', () => {
      expect(worldDelta(snap(), snap(), 24).inventoryOnly).toBe(false);
    });
  });
});

describe('昼夜', () => {
  it('isNight 的边界与 dayNightTransition 的两个转换', () => {
    expect(isNight(12999)).toBe(false);
    expect(isNight(13000)).toBe(true);
    expect(isNight(22999)).toBe(true);
    expect(isNight(23000)).toBe(false);
    expect(dayNightTransition(12500, 13200)).toContain('夜幕');
    expect(dayNightTransition(22500, 23500)).toContain('天亮');
    expect(dayNightTransition(5000, 6000)).toBeNull();
  });

  it('timePhrase 全程有词', () => {
    for (const t of [0, 500, 3000, 7000, 10000, 12500, 15000, 20000, 23500]) {
      expect(timePhrase(t)).toBeTruthy();
    }
  });
});

describe('classifyEntity', () => {
  it('玩家/敌对/动物/其他', () => {
    expect(classifyEntity('player', undefined)).toBe('player');
    expect(classifyEntity('hostile', 'creeper')).toBe('hostile');
    expect(classifyEntity('mob', 'zombie')).toBe('hostile'); // 按名字识别,不信 type
    expect(classifyEntity('animal', 'cow')).toBe('animal');
    expect(classifyEntity('object', 'arrow')).toBe('other');
  });
});

/** snapshotFromBot 的最小假 bot:位置向量只带用到的方法 */
type Pos = { x: number; y: number; z: number; offset(dx: number, dy: number, dz: number): Pos; distanceTo(o: Pos): number; floored(): Pos };
function pos(x: number, y: number, z: number): Pos {
  return {
    x, y, z,
    offset: (dx, dy, dz) => pos(x + dx, y + dy, z + dz),
    distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z),
    floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)),
  };
}

describe('snapshotFromBot 的现实时刻', () => {
  const bareBot = () => ({
    entity: { position: pos(0.5, 64, 0.5) },
    entities: {},
    registry: { biomes: {}, blocksByName: {} },
    findBlocks: () => [],
    blockAt: () => null,
    world: { raycast: () => null },
    game: { dimension: 'overworld', gameMode: 'survival' },
    health: 20, food: 20, oxygenLevel: 20,
    time: { timeOfDay: 1000 }, rainState: 0,
    heldItem: null,
    inventory: { items: () => [] },
    players: {},
  });

  it('不指定时区就按东八区报', () => {
    expect(snapshotFromBot(bareBot()).realTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);
  });

  it('指定了就按指定的那个时区报', () => {
    expect(snapshotFromBot(bareBot(), { timezone: 'UTC' }).realTime).toMatch(/\+00:00$/);
  });
});

describe('天候读的是雨量不是 isRaining', () => {
  it('雨量大于 0 才算在下雨', () => {
    expect(isRaining({ rainState: 0 })).toBe(false);
    expect(isRaining({ rainState: 1 })).toBe(true);
    // 起雨/收雨都是渐变,过程中的中间值一样算在下雨
    expect(isRaining({ rainState: 0.04 })).toBe(true);
  });

  it('没有雨量字段就当没下雨,不会拿 NaN 当真', () => {
    expect(isRaining({})).toBe(false);
    expect(isRaining({ rainState: undefined })).toBe(false);
    expect(isRaining({ rainState: NaN })).toBe(false);
  });

  it('mineflayer 的 isRaining 极性是反的,一律不看它', () => {
    // 真在下雨:reason 2 让 mineflayer 把 isRaining 置成了 false
    expect(isRaining({ rainState: 1, isRaining: false })).toBe(true);
    // 真晴天:reason 1 让 mineflayer 把 isRaining 置成了 true
    expect(isRaining({ rainState: 0, isRaining: true })).toBe(false);
  });
});

describe('snapshotFromBot 实体筛选', () => {
  it('实体列表排除不可拾取的箭和三叉戟', () => {
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {
        '1': { name: 'trident', type: 'projectile', position: pos(3, 64, 3) },
        '2': { name: 'arrow', type: 'projectile', position: pos(4, 64, 4) },
        '3': { name: 'skeleton', type: 'mob', position: pos(5, 64, 5) },
        '4': { name: 'item', type: 'object', position: pos(2, 64, 2) },
      },
      registry: { biomes: {}, blocksByName: {} },
      findBlocks: () => [],
      blockAt: () => null,
      // 射线畅通无阻:全部实体按看得见算
      world: { raycast: () => null },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    const snap = snapshotFromBot(bot);
    expect(snap.entities.map((e) => e.name).sort()).toEqual(['item', 'skeleton']);
  });

  it('隔墙的实体只闻其声:16 格内报动静且只给方位,更远的不存在,掉落物没声音', () => {
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {
        '1': { name: 'zombie', type: 'mob', position: pos(-10, 64, 0.5) }, // 西边 10.5 格,被挡
        '2': { name: 'creeper', type: 'mob', position: pos(20, 64, 0.5) }, // 19.5 格,被挡 → 不存在
        '3': { name: 'item', type: 'object', position: pos(3, 64, 0.5) }, // 被挡的掉落物 → 不存在
        '4': { name: 'cow', type: 'animal', position: pos(0.5, 64, 6) }, // 南边,看得见
      },
      registry: { biomes: {}, blocksByName: {} },
      findBlocks: () => [],
      blockAt: () => null,
      // 只有朝南看牛的那条射线畅通,其余都撞墙
      world: {
        raycast: (_from: unknown, dir: { z: number }) => (dir.z > 0.9 ? null : { name: 'stone' }),
      },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    const s = snapshotFromBot(bot);
    expect(s.entities.map((e) => e.name).sort()).toEqual(['cow', 'zombie']);
    expect(s.entities.find((e) => e.name === 'zombie')?.visible).toBe(false);
    const text = narrateWorld(s);
    expect(text).toContain('看得见的：南边 5.5 格有牛');
    expect(text).toContain('听得见动静的：西边有僵尸的动静');
    expect(text).not.toContain('僵尸的动静 '); // 动静行不带距离
  });

  it('看不见就得发得出声:展示框/画/盔甲架落到 other,鱿鱼在静默名单,牛照常报动静', () => {
    // type 值取自 minecraft-data 1.20.6(mineflayer entities.js:163 原样搬过来):
    // item_frame/painting=other、armor_stand=living、squid=water_creature。
    // 前三个都不在 classifyEntity 认的 animal/mob/water_creature 里,落到 other;
    // 鱿鱼落到 animal,靠 SILENT_ENTITIES 挡。两条判据各挡各的一半,少一条就漏。
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {
        '1': { name: 'item_frame', type: 'other', position: pos(3, 64, 0.5) },
        '2': { name: 'painting', type: 'other', position: pos(4, 64, 0.5) },
        '3': { name: 'armor_stand', type: 'living', position: pos(5, 64, 0.5) },
        '4': { name: 'squid', type: 'water_creature', position: pos(6, 64, 0.5) },
        '5': { name: 'cow', type: 'animal', position: pos(7, 64, 0.5) },
      },
      registry: { biomes: {}, blocksByName: {} },
      findBlocks: () => [],
      blockAt: () => null,
      // 全部射线撞墙:五个都是"看不见"
      world: { raycast: () => ({ name: 'stone' }) },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    const s = snapshotFromBot(bot);
    expect(s.entities.map((e) => e.name)).toEqual(['cow']);
    expect(s.entities[0].visible).toBe(false);
  });

  it('看得见的掉落物带上 getDroppedItem 的名字和数量', () => {
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {
        '1': {
          name: 'item', type: 'object', position: pos(0.5, 64, -3),
          getDroppedItem: () => ({ name: 'cobblestone', count: 12 }),
        },
      },
      registry: { biomes: {}, blocksByName: {} },
      findBlocks: () => [],
      blockAt: () => null,
      world: { raycast: () => null },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    const s = snapshotFromBot(bot);
    expect(s.entities[0]?.item).toEqual({ name: 'cobblestone', count: 12 });
    expect(narrateWorld(s)).toContain('北边 3.5 格附近有掉落物：圆石×12');
  });

  it('近处容器可并列多块,账本没有就写没开过', () => {
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {},
      registry: { biomes: {}, blocksByName: { chest: { id: 54 } } },
      findBlocks: () => [pos(2, 64, 0), pos(-3, 64, 0), pos(0, 64, 4)],
      blockAt: (p: { x: number; y: number; z: number }) => ({ name: 'chest', position: p }),
      canSeeBlock: () => true,
      world: { raycast: () => null },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
      chestOf: undefined,
    };
    const known = snapshotFromBot(bot, {
      chestOf: (_dim, p) => (p.x === 2 ? { items: [{ name: 'coal', count: 6 }] } : undefined),
    });
    expect(known.nearbyBlocks).toHaveLength(3);
    const text = narrateWorld(known);
    expect(text).toContain('是箱子（煤炭×6）');
    expect(text).toContain('（没开过）');
  });

  it('炉子族也走容器行:账本有槽位读数就随行显示,没开过写没开过', () => {
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {},
      registry: { biomes: {}, blocksByName: { furnace: { id: 61 } } },
      findBlocks: () => [pos(2, 64, 0), pos(-3, 64, 0)],
      blockAt: (p: { x: number; y: number; z: number }) => ({ name: 'furnace', position: p }),
      canSeeBlock: () => true,
      world: { raycast: () => null },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    // 账本的 items 就是三槽位的非空清单(rememberFurnace 同步的那份)
    const s = snapshotFromBot(bot, {
      chestOf: (_dim, p) => (p.x === 2
        ? { items: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 2 }] }
        : undefined),
    });
    const text = narrateWorld(s);
    expect(text).toContain('是熔炉（粗铁×8、煤炭×2）');
    expect(text).toContain('（没开过）');
  });

  it('cropAgeAt 只认作物并报原版 age 原值;scanMatureCrops 只回 age 到顶的', () => {
    const ages: Record<string, number> = { '1,64,0': 7, '2,64,0': 5 };
    const bot = {
      registry: { blocksByName: { wheat: { id: 7 } } },
      findBlocks: ({ matching }: { matching: number[] }) =>
        (matching.includes(7) ? [pos(1, 64, 0), pos(2, 64, 0)] : []),
      blockAt: (p: { x: number; y: number; z: number }) =>
        ({ name: 'wheat', getProperties: () => ({ age: ages[`${p.x},${p.y},${p.z}`] }) }),
    };
    expect(cropAgeAt(bot, { x: 1, y: 64, z: 0 })).toEqual({ value: 7, max: 7 });
    expect(cropAgeAt(bot, { x: 2, y: 64, z: 0 })).toEqual({ value: 5, max: 7 });
    expect(cropAgeAt({ blockAt: () => ({ name: 'stone' }) }, { x: 0, y: 0, z: 0 })).toBeNull();
    // 成熟只能观察不能倒计时:扫描回的就是"现在读到 age 到顶"的那些格
    expect(scanMatureCrops(bot, 16)).toEqual([{ x: 1, y: 64, z: 0, name: 'wheat', age: 7, max: 7 }]);
  });

  it('近处方块摘要跳过被挡的,报第一块看得见的', () => {
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {},
      registry: { biomes: {}, blocksByName: { iron_ore: { id: 1 } } },
      // 第一块埋着(y=60),第二块露头(y=64)
      findBlocks: () => [pos(5, 60, 0), pos(2, 64, 2)],
      blockAt: (p: Pos) => ({ name: 'iron_ore', position: p }),
      canSeeBlock: (b: { position: Pos }) => b.position.y === 64,
      world: { raycast: () => null },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    const s = snapshotFromBot(bot);
    expect(s.nearbyBlocks).toHaveLength(1);
    expect(s.nearbyBlocks[0]).toMatchObject({ name: 'iron_ore', x: 2, y: 64, z: 2 });
  });

  it('scanBlocks:false 一次 findBlocks 都不发:只要位置与身体状况的调用方不付这份钱', () => {
    let scans = 0;
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {},
      registry: { biomes: {}, blocksByName: { iron_ore: { id: 1 } } },
      findBlocks: () => { scans++; return []; },
      blockAt: () => null,
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    expect(snapshotFromBot(bot, { scanBlocks: false }).nearbyBlocks).toEqual([]);
    expect(scans).toBe(0);
    snapshotFromBot(bot);
    expect(scans).toBeGreaterThan(0);
  });
});

describe('地形采样', () => {
  it('断崖/水面/山体/高地入摘要,平地不占条目', () => {
    // 缺省地面 y=63 实心(站在 64):平地。东边整列实心=山体;西边悬空=深沟;
    // 南边 y=63 是水;北边地面抬到 y=66(高出 3 格)
    const solid = { boundingBox: 'block', name: 'stone' };
    const air = { boundingBox: 'empty', name: 'air' };
    const water = { boundingBox: 'empty', name: 'water' };
    const blockAt = (p: { x: number; y: number; z: number }) => {
      const [x, y, z] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
      if (x === 8 && z === 0) return solid; // 东
      if (x === -8 && z === 0) return air; // 西
      if (x === 0 && z === 8) return y === 63 ? water : y < 60 ? solid : air; // 南
      if (x === 0 && z === -8) return y <= 66 ? solid : air; // 北
      return y <= 63 ? solid : air;
    };
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {},
      registry: { biomes: {}, blocksByName: {} },
      findBlocks: () => [],
      blockAt,
      world: { raycast: () => null },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    const s = snapshotFromBot(bot);
    const byDir = Object.fromEntries(s.terrain.map((t) => [t.direction, t]));
    expect(byDir.east?.kind).toBe('solid');
    expect(byDir.west?.kind).toBe('down');
    expect(byDir.south?.kind).toBe('water');
    expect(byDir.north).toMatchObject({ kind: 'up', dy: 3 });
    // 四个斜方向都是平地,不占条目
    expect(s.terrain).toHaveLength(4);
    const text = narrateWorld(s);
    expect(text).toContain('东边是实心山体');
    expect(text).toContain('西边是深沟或悬崖');
    expect(text).toContain('南边是水面');
    expect(text).toContain('北边高出约 3 格');
    // 采到了、是平的,要跟"根本没采到"分开说
    expect(text).toContain('是平的');
    expect(text).not.toContain('没读到');
  });

  it('地下八向全实心:合并成一句,不逐向罗列', () => {
    const solid = { boundingBox: 'block', name: 'stone' };
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {},
      registry: { biomes: {}, blocksByName: {} },
      findBlocks: () => [],
      blockAt: () => solid,
      world: { raycast: () => null },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    const s = snapshotFromBot(bot);
    expect(s.terrain).toHaveLength(8);
    const text = narrateWorld(s);
    expect(text).toContain('四面八方基本都是实心山体');
    expect(text).not.toContain('北边是实心山体');
    expect(text).not.toContain('没提到的方向');
  });

  it('scanBlocks:false 不做地形采样', () => {
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {},
      registry: { biomes: {}, blocksByName: {} },
      findBlocks: () => [],
      blockAt: () => null,
      world: { raycast: () => null },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    expect(snapshotFromBot(bot, { scanBlocks: false }).terrain).toEqual([]);
  });
});

describe('bearing / facingOf', () => {
  it('八方位:北=-z 南=+z 东=+x 西=-x,与 move 技能同一套词', () => {
    expect(bearing(0, -10)).toBe('north');
    expect(bearing(0, 10)).toBe('south');
    expect(bearing(10, 0)).toBe('east');
    expect(bearing(-10, 0)).toBe('west');
    expect(bearing(7, -7)).toBe('northeast');
    expect(bearing(-7, 7)).toBe('southwest');
    expect(bearing(0, 0)).toBeNull();
  });

  it('yaw → 罗盘度数:北=0 东=90 南=180 西=270,给解说定位用', () => {
    expect(facingDegrees(0)).toBe(180);
    expect(facingDegrees(Math.PI)).toBe(0);
    expect(facingDegrees(Math.PI / 2)).toBe(270);
    expect(facingDegrees(-Math.PI / 2)).toBe(90);
    // 八方位只有 45° 分辨率;转头 20° 画面换一半,度数才对得上
    expect(facingOf(-Math.PI / 2 + 0.35)).toBe(facingOf(-Math.PI / 2));
    expect(facingDegrees(-Math.PI / 2 + 0.35)).not.toBe(90);
  });

  it('俯仰只在明显低头抬头时说一句', () => {
    expect(pitchPhrase(0)).toBeNull();
    expect(pitchPhrase(0.2)).toBeNull();
    expect(pitchPhrase(Math.PI / 5)).toBe('低头看着地面');
    expect(pitchPhrase(Math.PI / 3)).toBe('几乎盯着脚下');
    expect(pitchPhrase(-Math.PI / 3)).toBe('仰头看天');
  });

  it('yaw → 朝向:mineflayer 的 yaw=0 是朝南', () => {
    expect(facingOf(0)).toBe('south');
    expect(facingOf(Math.PI)).toBe('north');
    expect(facingOf(Math.PI / 2)).toBe('west');
  });
});

describe('narrateWorld', () => {
  it('写成话、全中文、带方位:中文那一份不出现英文 id', () => {
    const text = narrateWorld(snap({
      biome: 'savanna', standingOn: 'stone', heldItem: 'stone_pickaxe',
      inventory: [{ name: 'acacia_planks', count: 5 }, { name: 'raw_iron', count: 3 }],
      entities: [{ name: 'skeleton', kind: 'hostile', distance: 13.3, direction: 'northeast', dy: 0, visible: true }],
      nearbyBlocks: [{ name: 'deepslate_iron_ore', distance: 14.7, direction: 'west', dy: -12, x: 86, y: 52, z: -20 }],
      players: [],
    }));
    expect(text).toContain('热带草原');
    expect(text).toContain('石头');
    expect(text).toContain('石镐');
    expect(text).toContain('金合欢木板×5');
    expect(text).toContain('粗铁×3');
    expect(text).toContain('东北边 13.3 格有骷髅（会打我）');
    expect(text).toContain('西边下方 14.7 格是深板岩铁矿石');
    expect(narrateWorld(snap({ players: ['Phant'] }))).toContain('服务器上还有：Phant。');
    expect(text).not.toMatch(/[A-Za-z_]{3,}/);
  });

  it('运动状态进正文:站着/走/跑/游/掉下去各有说法', () => {
    expect(narrateWorld(snap({ motion: 'still' }))).toContain('我站着没动');
    expect(narrateWorld(snap({ motion: 'walking', heading: 'north' }))).toContain('我正朝北走着');
    expect(narrateWorld(snap({ motion: 'sprinting', heading: 'west' }))).toContain('我正朝西跑着');
    expect(narrateWorld(snap({ motion: 'swimming', heading: 'east' }))).toContain('我正朝东游着');
    expect(narrateWorld(snap({ motion: 'falling' }))).toContain('往下掉');
  });

  it('水里才报氧气;生命向上取整(与 HUD 半颗心一致),饥饿四舍五入,不出现小数', () => {
    const wet = narrateWorld(snap({ inWater: true, oxygen: 6, health: 8.24 }));
    expect(wet).toContain('氧气还剩 6/20');
    expect(wet).toContain('生命 9/20');
    expect(narrateWorld(snap({ health: 0.086 }))).toContain('生命 1/20');
    expect(narrateWorld(snap({ oxygen: 6, inWater: false }))).not.toContain('氧气');
  });

  it('看得见的掉落物从活物行拆出,同方位合成一句', () => {
    const text = narrateWorld(snap({
      entities: [
        { name: 'item', kind: 'other', distance: 3.5, direction: 'north', dy: 0, visible: true, item: { name: 'cobblestone', count: 12 } },
        { name: 'item', kind: 'other', distance: 3.6, direction: 'north', dy: 0, visible: true, item: { name: 'coal', count: 3 } },
        { name: 'sheep', kind: 'animal', distance: 5, direction: 'east', dy: 0, visible: true },
      ],
    }));
    expect(text).toContain('北边 3.5 格附近有掉落物：圆石×12、煤炭×3');
    expect(text).toContain('看得见的：东边 5 格有羊');
    expect(text).not.toMatch(/看得见的：.*掉落物/);
  });

  it('不同方向的掉落物各写一句', () => {
    const text = narrateWorld(snap({
      entities: [
        { name: 'item', kind: 'other', distance: 3.5, direction: 'north', dy: 0, visible: true, item: { name: 'cobblestone', count: 12 } },
        { name: 'item', kind: 'other', distance: 2.6, direction: 'west', dy: 0, visible: true, item: { name: 'terracotta', count: 4 } },
      ],
    }));
    expect(text).toContain('北边 3.5 格附近有掉落物：圆石×12');
    expect(text).toContain('西边 2.6 格附近有掉落物：陶瓦×4');
  });

  /**
   * 快照里的恒定句一律不占字:活物段空着就整段不出现,可见方块行也
   * 不再补「被方块挡住的不在这份里」——那一条常驻前缀每轮都在说。
   */
  it('周围什么都没有时:活物段与遮挡尾句都不占字', () => {
    const text = narrateWorld(snap({ entities: [], nearbyBlocks: [], players: [] }));
    expect(text).not.toContain('周围没看见活物');
    expect(text).not.toContain('被方块挡住');
    // 有东西时照旧报
    const seen = narrateWorld(snap({
      nearbyBlocks: [{ name: 'chest', distance: 3, direction: 'east', dy: 0, x: 3, y: 64, z: 0 }],
    }));
    expect(seen).toContain('东边 3 格是箱子');
    expect(seen).not.toContain('被方块挡住');
  });

  it('开过的箱子带账本,没开过写没开过', () => {
    const text = narrateWorld(snap({
      nearbyBlocks: [
        {
          name: 'chest', distance: 1.5, direction: 'west', dy: 0, x: 0, y: 64, z: 0,
          contents: [{ name: 'cobblestone', count: 378 }, { name: 'coal', count: 6 }],
        },
        { name: 'chest', distance: 4, direction: 'east', dy: 0, x: 4, y: 64, z: 0, contents: null },
      ],
    }));
    expect(text).toContain('西边 1.5 格是箱子（圆石×378、煤炭×6）');
    expect(text).toContain('东边 4 格是箱子（没开过）');
  });
});

describe('作物与耕地感知', () => {
  const one = (b: Partial<WorldSnapshot['nearbyBlocks'][number]>) => snap({
    nearbyBlocks: [{ name: 'wheat', distance: 4, direction: 'north', dy: 0, x: 100, y: 64, z: -24, ...b }],
  });

  it('作物报原版 age 方块状态,连满龄一起给,不折成自造的量纲', () => {
    expect(narrateWorld(one({ age: { value: 3, max: 7 } }))).toContain('北边 4 格是小麦（age 3/7）');
    expect(narrateWorld(one({ age: { value: 7, max: 7 } }))).toContain('小麦（age 7/7）');
    expect(narrateWorld(one({ age: { value: 0, max: 7 } }))).toContain('小麦（age 0/7）');
    // beetroots 满龄 3:满龄随方块给,不按小麦的 7 折算
    expect(narrateWorld(one({ name: 'beetroots', age: { value: 2, max: 3 } })))
      .toContain('甜菜作物（age 2/3）');
  });

  // 原版 moisture 0–7:四格内有水就置 7,没水每次随机刻掉一档,而作物照常长到 0 为止。
  // `moisture >= 7` 折出来的布尔把 1–6 一律说成「旱着」,那是一句假话。
  it('耕地报原版 moisture 原值,不折成湿润/旱着', () => {
    expect(narrateWorld(one({ name: 'farmland', moisture: { value: 7, max: 7 } })))
      .toContain('是耕地（moisture 7/7）');
    expect(narrateWorld(one({ name: 'farmland', moisture: { value: 5, max: 7 } })))
      .toContain('是耕地（moisture 5/7）');
    expect(narrateWorld(one({ name: 'farmland', moisture: { value: 0, max: 7 } })))
      .toContain('是耕地（moisture 0/7）');
    for (const v of [0, 3, 5, 7]) {
      expect(narrateWorld(one({ name: 'farmland', moisture: { value: v, max: 7 } }))).not.toContain('旱着');
    }
  });

  it('龄期与湿润态进 structure 段比对键:age 跳一档才算段变,同一档不抖', () => {
    const cmpOf = (b: Partial<WorldSnapshot['nearbyBlocks'][number]>) =>
      narrateWorldSegments(one(b)).find((g) => g.key === 'structure')!.cmp;
    expect(cmpOf({ age: { value: 3, max: 7 } })).not.toBe(cmpOf({ age: { value: 4, max: 7 } }));
    // 同一档反复渲染是同一个键:去重不因为改了表示法而失效
    expect(cmpOf({ age: { value: 3, max: 7 } })).toBe(cmpOf({ age: { value: 3, max: 7 } }));
  });

  /**
   * 水分是显示与比对分开的那一档(同 distBucket):文本给原版原值,键只看"水合没有"。
   * 两版都是二值键,而边界从 6/7 挪到了 0/1 —— 断水的耕地在旧键上第一次随机刻就翻,
   * 新键要连掉七档才动。所以换成原值渲染之后去重只会更松,不会更紧。
   */
  it('moisture 的比对键只认水合与否:7→1 一路渲染都在变,键一次没动;掉到 0 才换键', () => {
    const cmpOf = (v: number) =>
      narrateWorldSegments(one({ name: 'farmland', moisture: { value: v, max: 7 } }))
        .find((g) => g.key === 'structure')!.cmp;
    const keys = new Set([7, 6, 5, 4, 3, 2, 1].map(cmpOf));
    expect(keys.size).toBe(1);
    expect(cmpOf(0)).not.toBe(cmpOf(1));
    // 文本本身照旧逐档变:比对键放宽了,读到的读数不跟着变糊
    expect(narrateWorld(one({ name: 'farmland', moisture: { value: 6, max: 7 } })))
      .not.toBe(narrateWorld(one({ name: 'farmland', moisture: { value: 5, max: 7 } })));
  });

  it('snapshotFromBot 读 age/moisture:小麦与耕地带着状态进快照', () => {
    const spots: Record<number, Pos[]> = { 1: [pos(3, 64, 0)], 2: [pos(0, 63, 3)] };
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {},
      registry: { biomes: {}, blocksByName: { wheat: { id: 1 }, farmland: { id: 2 } } },
      // 判据形态:水/岩浆仍按 id 数组各查一次,其余走一次函数判据(见 world.ts 的注释)
      findBlocks: ({ matching }: { matching: number[] | ((b: { type: number }) => boolean) }) =>
        (typeof matching === 'function'
          ? Object.entries(spots).flatMap(([id, ps]) => (matching({ type: +id }) ? ps : []))
          : matching.flatMap((id) => spots[id] ?? [])),
      blockAt: (p: Pos) => (p.y === 63
        ? { name: 'farmland', position: p, getProperties: () => ({ moisture: 4 }) }
        : { name: 'wheat', position: p, getProperties: () => ({ age: 5 }) }),
      canSeeBlock: () => true,
      world: { raycast: () => null },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    const s = snapshotFromBot(bot);
    expect(s.nearbyBlocks.find((b) => b.name === 'wheat')?.age).toEqual({ value: 5, max: 7 });
    expect(s.nearbyBlocks.find((b) => b.name === 'farmland')?.moisture).toEqual({ value: 4, max: 7 });
    const text = narrateWorld(s);
    expect(text).toContain('小麦（age 5/7）');
    expect(text).toContain('耕地（moisture 4/7）');
  });
});

describe('背景判据', () => {
  it('天然地形与天然植被是背景;人造物、可采集物、野花都不是', () => {
    // 空气也在背景里:她本人就站在空气里,「东南边 0.3 格是空气」是零信息
    for (const n of ['air', 'cave_air', 'stone', 'grass_block', 'oak_leaves', 'seagrass', 'oak_sapling']) {
      expect(isBackground(n), n).toBe(true);
    }
    for (const n of ['melon', 'spawner', 'oak_planks', 'dandelion', 'white_bed', 'bamboo_sapling']) {
      expect(isBackground(n), n).toBe(false);
    }
  });

  it('扫描不再靠白名单:床按 registry 里的真名报,不统称"床"', () => {
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {},
      registry: { biomes: {}, blocksByName: { white_bed: { id: 100 } } },
      findBlocks: ({ matching }: { matching: number[] | ((b: { type: number }) => boolean) }) =>
        (typeof matching === 'function' && matching({ type: 100 }) ? [pos(2, 64, 2)] : []),
      blockAt: (p: Pos) => ({ name: 'white_bed', position: p }),
      canSeeBlock: () => true,
      world: { raycast: () => null },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    const s = snapshotFromBot(bot);
    expect(s.nearbyBlocks.map((b) => b.name)).toContain('white_bed');
    expect(narrateWorld(s)).toContain('是白色床');
  });
});

describe('droppedStackOf', () => {
  it('优先 getDroppedItem,没有元数据就记成不明掉落物', () => {
    expect(droppedStackOf({
      name: 'item',
      getDroppedItem: () => ({ name: 'coal', count: 3 }),
    })).toEqual({ name: 'coal', count: 3 });
    expect(droppedStackOf({ name: 'item' })).toEqual({ name: 'item', count: 1 });
    expect(droppedStackOf({ name: 'zombie' })).toBeNull();
  });
});

describe('narrateWorldSegments(分段去重的数据源)', () => {
  it('段键齐全且有序,各段拼接就是 narrateWorld 全文', () => {
    const s = snap({ terrain: [{ direction: 'north', dy: 5, kind: 'up' }] });
    const segs = narrateWorldSegments(s);
    expect(segs.map((g) => g.key))
      .toEqual([
        'place', 'clock', 'realclock', 'body', 'gear', 'equip', 'life', 'structure', 'terrain', 'players',
      ]);
    expect(segs.map((g) => g.text).filter(Boolean).join('\n')).toBe(narrateWorld(s));
  });

  it('地形只随全量锚发:比对键钉死成常量,地形真变了也不弄脏增量', () => {
    const terrain: WorldSnapshot['terrain'] = [{ direction: 'west', dy: -9, kind: 'down' }];
    const a = narrateWorldSegments(snap({ terrain }));
    const moved = narrateWorldSegments(snap({
      terrain,
      nearbyBlocks: [{ name: 'crafting_table', distance: 3, direction: 'east', dy: 0, x: 103, y: 64, z: -20 }],
    }));
    const dirty = moved.filter((g, i) => g.cmp !== a[i].cmp).map((g) => g.key);
    expect(dirty).toEqual(['structure']);
    // 悬崖没了也不算段变:逐份重发同一行地形花掉的比它值钱
    const cliffGone = narrateWorldSegments(snap({ terrain: [] }));
    expect(cliffGone.filter((g, i) => g.cmp !== a[i].cmp)).toEqual([]);
    // 文本仍是当刻真值,全量锚拿到的就是新的那一份
    expect(a.find((g) => g.key === 'terrain')?.text).toContain('西边是深沟或悬崖');
    // 平地:地形段无文本,全量拼接里也就没有地形行
    expect(cliffGone.find((g) => g.key === 'terrain')?.text).toBe('');
    expect(narrateWorld(snap({ terrain: [] }))).not.toContain('地形：');
  });

  it('时段/天气翻牌只弄脏 clock 段', () => {
    const a = narrateWorldSegments(snap({ timeOfDay: 12500 })); // 黄昏
    const b = narrateWorldSegments(snap({ timeOfDay: 13500, raining: true })); // 深夜,下雨
    const dirty = b.filter((g, i) => g.cmp !== a[i].cmp).map((g) => g.key);
    expect(dirty).toEqual(['clock']);
  });

  it('实体原地小步挪动不弄脏 life 段(2 格量化);真挪远了才算变', () => {
    const one = (distance: number): Partial<WorldSnapshot> => ({
      entities: [{ name: 'sheep', kind: 'animal', distance, direction: 'north', dy: 0, visible: true }],
    });
    const lifeCmp = (s: Partial<WorldSnapshot>) =>
      narrateWorldSegments(snap(s)).find((g) => g.key === 'life')?.cmp;
    expect(lifeCmp(one(5.9))).toBe(lifeCmp(one(5.1)));
    expect(lifeCmp(one(9.8))).not.toBe(lifeCmp(one(5.1)));
    // 段文本本身仍给新鲜的原值,量化只在比对键
    const text = narrateWorldSegments(snap(one(5.9))).find((g) => g.key === 'life')?.text;
    expect(text).toContain('5.9 格');
  });

  it('明暗只在真的全黑时进 clock 段,亮着一个字都不加', () => {
    const clockOf = (over: Partial<WorldSnapshot>) =>
      narrateWorldSegments(snap(over)).find((g) => g.key === 'clock')!;
    const dark = clockOf({ light: 0, timeOfDay: 6000 });
    expect(dark.text).toContain('什么都看不见');
    // 具体读数不进快照:几点几她不用关心,能不能看见才是
    expect(dark.text).not.toMatch(/亮度|方块光|天光/);
    // 刷怪阈值、火把亮度都是她自己知道的游戏常识,回执不复述也不支招
    for (const t of ['火把', '刷怪', '能压掉']) expect(dark.text).not.toContain(t);
    expect(clockOf({ light: 1 }).text).toContain('什么都看不见');
    // 微光以上、以及采不到样,都不加字
    expect(clockOf({ light: 2 }).text).toBe('现在是正午前后。');
    expect(clockOf({ light: null }).text).toBe('现在是正午前后。');
  });

  it('现实时钟自成一段:报到分,与游戏内时辰互不牵连', () => {
    const segOf = (over: Partial<WorldSnapshot>, key: string) =>
      narrateWorldSegments(snap(over)).find((g) => g.key === key)!;
    expect(segOf({}, 'realclock').text).toBe('现实世界现在是 8 月 19 日 20:15。');
    // 报到分:同一分钟内的秒不进这一段
    expect(segOf({ realTime: '2026-08-19T20:15:59+08:00' }, 'realclock').cmp)
      .toBe(segOf({ realTime: '2026-08-19T20:15:00+08:00' }, 'realclock').cmp);
    expect(segOf({ realTime: '2026-08-19T20:16:00+08:00' }, 'realclock').cmp)
      .not.toBe(segOf({ realTime: '2026-08-19T20:15:00+08:00' }, 'realclock').cmp);
    // 两个时钟不同档:现实的分针走一格不该把游戏内时辰那段拖着重发,反之亦然
    expect(segOf({ realTime: '2026-08-19T21:30:00+08:00' }, 'clock').cmp)
      .toBe(segOf({}, 'clock').cmp);
    expect(segOf({ timeOfDay: 18000 }, 'realclock').cmp).toBe(segOf({}, 'realclock').cmp);
  });

  it('明暗只有黑与不黑两态:亮度数字变动不再牵动 clock 段', () => {
    const cmpOf = (light: WorldSnapshot['light']) =>
      narrateWorldSegments(snap({ light })).find((g) => g.key === 'clock')!.cmp;
    // 15 和 4 都是"看得见",走一格光照变一点不该把整段环境读数重发一遍
    expect(cmpOf(15)).toBe(cmpOf(4));
    expect(cmpOf(2)).toBe(cmpOf(null));
    expect(cmpOf(0)).toBe(cmpOf(1));
    expect(cmpOf(0)).not.toBe(cmpOf(2));
  });

  it('背包没同步时 gear 段是提示语,同步后自然算"变了"', () => {
    const gearOf = (over: Partial<WorldSnapshot>) =>
      narrateWorldSegments(snap(over)).find((g) => g.key === 'gear');
    const unsynced = gearOf({ invSynced: false });
    expect(unsynced?.text).toContain('还没到');
    expect(unsynced?.cmp).not.toBe(gearOf({})?.cmp);
  });

  /**
   * 默认夹具库存合计橡木原木 12+5=17、面包 3；传入上一份库存后只渲染变化。
   */
  it('给了上一份的包就只印变的那几条,没变的一个字都不占', () => {
    const gear = (prevBag: ItemStack[] | null) =>
      narrateWorldSegments(snap(), null, prevBag).find((g) => g.key === 'gear')!.text;
    // 一条都没变
    expect(gear([{ name: 'oak_log', count: 17 }, { name: 'bread', count: 3 }]))
      .toBe('手里拿着石镐。');
    // 数字变了的按现在的存量印,没变的那条不印
    expect(gear([{ name: 'oak_log', count: 17 }, { name: 'bread', count: 1 }]))
      .toBe('手里拿着石镐。包里变的：面包×3。');
    // 新出现的一样按存量印
    expect(gear([{ name: 'oak_log', count: 17 }])).toBe('手里拿着石镐。包里变的：面包×3。');
    // 整个不见了的列不出存量,单说一句
    expect(gear([{ name: 'oak_log', count: 17 }, { name: 'bread', count: 3 }, { name: 'torch', count: 4 }]))
      .toBe('手里拿着石镐。火把没了。');
    // 不给基线(全量锚那一拍、还没有基线)照旧整份印
    expect(gear(null)).toBe('手里拿着石镐。包里有：橡木原木×17、面包×3。');
  });

  it('比对键只认当刻存量,与给不给基线无关', () => {
    const cmp = (prevBag: ItemStack[] | null) =>
      narrateWorldSegments(snap(), null, prevBag).find((g) => g.key === 'gear')!.cmp;
    // 否则"变过一次之后就不再重发"与"没变却每拍重发"两头都会出
    expect(cmp([{ name: 'oak_log', count: 17 }, { name: 'bread', count: 3 }])).toBe(cmp(null));
    expect(cmp([{ name: 'oak_log', count: 1 }])).toBe(cmp(null));
    // 包真变了才算段变
    const other = narrateWorldSegments(snap({ inventory: [{ name: 'bread', count: 3 }] }))
      .find((g) => g.key === 'gear')!.cmp;
    expect(other).not.toBe(cmp(null));
  });
});

describe('背包渲染:附魔件', () => {
  const gearOf = (over: Partial<WorldSnapshot>) =>
    narrateWorldSegments(snap(over)).find((g) => g.key === 'gear')!.text;

  it('附魔进名字后面的括号,等级用罗马数字', () => {
    const text = gearOf({
      inventory: [{ name: 'diamond_pickaxe', count: 1, enchantments: [{ name: 'efficiency', level: 4 }, { name: 'unbreaking', level: 3 }] }],
    });
    expect(text).toContain('钻石镐（效率IV·耐久III）×1');
  });

  it('带不同附魔的同名物品不合并 —— 原版里它们本来就摞不到一起', () => {
    const text = gearOf({
      inventory: [
        { name: 'diamond_pickaxe', count: 1, enchantments: [{ name: 'efficiency', level: 4 }] },
        { name: 'diamond_pickaxe', count: 1, enchantments: [{ name: 'fortune', level: 3 }] },
        { name: 'diamond_pickaxe', count: 1 },
      ],
    });
    expect(text).toContain('钻石镐（效率IV）×1');
    expect(text).toContain('钻石镐（时运III）×1');
    expect(text).toContain('钻石镐×1');
    expect(text).not.toContain('钻石镐×3');
  });

  it('没附魔的照旧按名字合并', () => {
    expect(gearOf({ inventory: [{ name: 'oak_log', count: 12 }, { name: 'oak_log', count: 5 }] }))
      .toContain('橡木原木×17');
  });
});

describe('equip 段:经验、盔甲副手与状态效果', () => {
  const equipOf = (over: Partial<WorldSnapshot>) =>
    narrateWorldSegments(snap(over)).find((g) => g.key === 'equip')!;

  it('空身只报经验与"没穿",没有效果就不出那一句', () => {
    const seg = equipOf({ xpLevel: 7 });
    expect(seg.text).toBe('经验 7 级。身上没穿护甲。');
    expect(seg.text).not.toContain('状态');
  });

  it('四槽与副手按头胸腿脚排,耐久报剩余/上限,附魔进括号', () => {
    const seg = equipOf({
      equipment: [
        { slot: 'feet', name: 'iron_boots', durability: { left: 100, max: 195 }, enchantments: [] },
        { slot: 'head', name: 'diamond_helmet', durability: { left: 363, max: 363 }, enchantments: [{ name: 'protection', level: 4 }] },
        { slot: 'offhand', name: 'shield', durability: { left: 336, max: 336 }, enchantments: [] },
      ],
    });
    expect(seg.text).toContain('穿着：头钻石头盔（保护IV） 363/363、脚铁靴子 100/195。');
    expect(seg.text).toContain('副手盾牌 336/336。');
  });

  it('耐久按一成一档进比对键:磨掉几点不重印,跨档才重印', () => {
    const withLeft = (left: number) => equipOf({
      equipment: [{ slot: 'chest', name: 'iron_chestplate', durability: { left, max: 240 }, enchantments: [] }],
    }).cmp;
    expect(withLeft(240)).toBe(withLeft(235));
    expect(withLeft(240)).not.toBe(withLeft(200));
  });

  it('效果剩余秒不进比对键,只在跌破 30 秒时翻一次', () => {
    const withSec = (seconds: number) => equipOf({
      effects: [{ name: 'FireResistance', level: 1, seconds }],
    });
    expect(withSec(400).cmp).toBe(withSec(120).cmp);
    expect(withSec(400).cmp).not.toBe(withSec(20).cmp);
    // 键没翻,但真打印出来时读数是当刻的
    expect(withSec(120).text).toContain('抗火还有 120 秒');
    expect(withSec(400).text).toContain('抗火还有 400 秒');
  });

  it('二级以上的效果带罗马数字,一级不带', () => {
    expect(equipOf({ effects: [{ name: 'Strength', level: 2, seconds: 60 }] }).text)
      .toContain('状态：力量II还有 60 秒。');
    expect(equipOf({ effects: [{ name: 'Poison', level: 1, seconds: 5 }] }).text)
      .toContain('状态：中毒还有 5 秒。');
  });
});

describe('snapshotFingerprint 收装备与效果', () => {
  it('穿上/掉一件盔甲与中毒开始都算实质变化,耐久与剩余秒不算', () => {
    const bare = snapshotFingerprint(snap());
    const armored = snapshotFingerprint(snap({
      equipment: [{ slot: 'chest', name: 'iron_chestplate', durability: { left: 240, max: 240 }, enchantments: [] }],
    }));
    const worn = snapshotFingerprint(snap({
      equipment: [{ slot: 'chest', name: 'iron_chestplate', durability: { left: 3, max: 240 }, enchantments: [] }],
    }));
    expect(armored).not.toBe(bare);
    expect(worn).toBe(armored);

    const poisoned = snapshotFingerprint(snap({ effects: [{ name: 'Poison', level: 1, seconds: 40 }] }));
    const nearlyOver = snapshotFingerprint(snap({ effects: [{ name: 'Poison', level: 1, seconds: 2 }] }));
    expect(poisoned).not.toBe(bare);
    expect(nearlyOver).toBe(poisoned);
  });

  it('升级不单独把她叫醒:升级事件已经在报,经验不进指纹', () => {
    expect(snapshotFingerprint(snap({ xpLevel: 30 }))).toBe(snapshotFingerprint(snap({ xpLevel: 0 })));
  });
});

describe('snapshotFromBot 读装备槽、经验与效果', () => {
  const bareBot = () => ({
    entity: {
      position: pos(0.5, 64, 0.5), velocity: { x: 0, y: 0, z: 0 }, yaw: 0, onGround: true,
      effects: {} as Record<number, { id: number; amplifier: number; duration: number }>,
    },
    entities: {},
    registry: {
      biomes: {}, blocksByName: {},
      effects: { 11: { name: 'FireResistance' }, 19: { name: 'Poison' } } as Record<number, { name: string }>,
      enchantments: { 20: { name: 'efficiency' } } as Record<number, { name: string }>,
    },
    findBlocks: () => [], blockAt: () => null,
    game: { dimension: 'overworld', gameMode: 'survival' },
    health: 20, food: 20, oxygenLevel: 20,
    time: { timeOfDay: 1000 }, rainState: 0, heldItem: null,
    experience: { level: 12, points: 5, progress: 0.2 },
    inventory: { items: () => [], slots: [] as unknown[] }, players: {},
  });

  it('五个装备槽从窗口下标读(5-8 与 45),耐久走原版上限表而非 registry', () => {
    const bot = bareBot();
    bot.inventory.slots = [];
    // componentMap 是 1.20.5+ 服务端发来的形状;damage 组件即已损耗点数
    bot.inventory.slots[6] = { name: 'iron_chestplate', componentMap: new Map([['damage', { data: 22 }]]) };
    bot.inventory.slots[45] = { name: 'shield', componentMap: new Map() };
    const s = snapshotFromBot(bot);
    expect(s.equipment).toEqual([
      { slot: 'chest', name: 'iron_chestplate', durability: { left: 218, max: 240 }, enchantments: [] },
      { slot: 'offhand', name: 'shield', durability: { left: 336, max: 336 }, enchantments: [] },
    ]);
  });

  it('附魔从 enchantments 组件按注册表序号译名', () => {
    const bot = bareBot();
    bot.inventory.slots = [];
    bot.inventory.slots[5] = {
      name: 'diamond_helmet',
      componentMap: new Map<string, { data: unknown }>([
        ['damage', { data: 0 }],
        ['enchantments', { data: { enchantments: [{ id: 20, level: 4 }], showTooltip: true } }],
      ]),
    };
    expect(snapshotFromBot(bot).equipment[0].enchantments).toEqual([{ name: 'efficiency', level: 4 }]);
  });

  it('效果时长从刻换成秒,amplifier 加一才是她看见的级数', () => {
    const bot = bareBot();
    bot.entity.effects = {
      19: { id: 19, amplifier: 1, duration: 100 },
      11: { id: 11, amplifier: 0, duration: 6000 },
    };
    expect(snapshotFromBot(bot).effects).toEqual([
      { name: 'FireResistance', level: 1, seconds: 300 },
      { name: 'Poison', level: 2, seconds: 5 },
    ]);
  });

  it('经验等级直接读 bot.experience', () => {
    expect(snapshotFromBot(bareBot()).xpLevel).toBe(12);
  });
});

describe('snapshotFromBot 运动与方位', () => {
  it('速度换成格/秒判断走还是跑,并给出移动方向与朝向', () => {
    // 0.2 格/tick = 4 格/秒,是走;疾跑在 5.6 格/秒上下
    const bot = {
      entity: { position: pos(0.5, 64, 0.5), velocity: { x: 0, y: 0, z: -0.2 }, yaw: Math.PI, onGround: true },
      entities: {},
      registry: { biomes: {}, blocksByName: {} },
      findBlocks: () => [], blockAt: () => null,
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0, heldItem: null,
      inventory: { items: () => [] }, players: {},
    };
    const snap = snapshotFromBot(bot);
    expect(snap.motion).toBe('walking');
    expect(snap.heading).toBe('north');
    expect(snap.facing).toBe('north');
    const fast = { ...bot, entity: { ...bot.entity, velocity: { x: 0, y: 0, z: -0.3 } } };
    expect(snapshotFromBot(fast).motion).toBe('sprinting');
  });

  it('实体带方位与高度差', () => {
    const bot = {
      entity: { position: pos(0.5, 64, 0.5), velocity: { x: 0, y: 0, z: 0 }, yaw: 0, onGround: true },
      entities: { '1': { name: 'skeleton', type: 'mob', position: pos(10.5, 60, 0.5) } },
      registry: { biomes: {}, blocksByName: {} },
      findBlocks: () => [], blockAt: () => null,
      world: { raycast: () => null },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0, heldItem: null,
      inventory: { items: () => [] }, players: {},
    };
    const e = snapshotFromBot(bot).entities[0];
    expect(e.direction).toBe('east');
    expect(e.dy).toBe(-4);
    expect(snapshotFromBot(bot).motion).toBe('still');
  });
});

describe('snapshotFromBot 亮度采样', () => {
  /**
   * 一小片假世界。她站在 (0,64,0):`solid` 说哪些格不透光(默认 y<64 是地),
   * `lit` 给每格两路光照(默认露天),`loaded` 说哪些格所在的区块加载了。
   */
  function litBot(over: {
    solid?: (x: number, y: number, z: number) => boolean;
    lit?: (x: number, y: number, z: number) => { block: number; sky: number };
    loaded?: () => boolean;
    timeOfDay?: number;
    noLightApi?: boolean;
  }) {
    const solid = over.solid ?? ((_x, y) => y < 64);
    const lit = over.lit ?? (() => ({ block: 0, sky: 15 }));
    const loaded = over.loaded ?? (() => true);
    return {
      entity: { position: pos(0.5, 64, 0.5), velocity: { x: 0, y: 0, z: 0 }, yaw: 0, onGround: true },
      entities: {},
      registry: { biomes: {}, blocksByName: {} },
      findBlocks: () => [],
      blockAt: (p: Pos) => (loaded()
        ? solid(p.x, p.y, p.z)
          ? { name: 'stone', boundingBox: 'block' }
          : { name: 'air', boundingBox: 'empty' }
        : null),
      world: {
        raycast: () => null,
        ...(over.noLightApi ? {} : {
          getBlockLight: (p: Pos) => lit(p.x, p.y, p.z).block,
          getSkyLight: (p: Pos) => lit(p.x, p.y, p.z).sky,
        }),
      },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: over.timeOfDay ?? 1000 }, rainState: 0, heldItem: null,
      inventory: { items: () => [] }, players: {},
    };
  }

  it('取的是周身连通那一小片的众数:洞里插一根火把不算这片亮了', () => {
    // y=64、x=0 上一条 z=0..4 的过道,只有 (0,64,3) 那格被照亮
    const bot = litBot({
      solid: (x, y, z) => y !== 64 || x !== 0 || z < 0 || z > 4,
      lit: (_x, _y, z) => ({ block: z === 3 ? 14 : 0, sky: 0 }),
    });
    expect(snapshotFromBot(bot).light).toBe(0);
  });

  it('脚那一格不透光时从头顶那格起漫,不再把方块内部的 0 当读数', () => {
    // 她整个人陷在地里一格:脚那格是方块自己(光照恒 0),头顶露天
    const bot = litBot({
      solid: (_x, y) => y <= 64,
      lit: (_x, y) => (y <= 64 ? { block: 0, sky: 0 } : { block: 0, sky: 15 }),
    });
    expect(snapshotFromBot(bot).light).toBe(15);
  });

  it('连通才算:隔着一堵墙的亮进不来', () => {
    // z=0、y=64 一条道,x=2 是墙;墙那边 x≥3 全亮
    const bot = litBot({
      solid: (x, y, z) => y !== 64 || z !== 0 || x === 2,
      lit: (x) => ({ block: x >= 3 ? 15 : 0, sky: 0 }),
    });
    expect(snapshotFromBot(bot).light).toBe(0);
  });

  it('众数并列取大的那个:宁可漏报黑,不要再踩着火把喊漆黑', () => {
    const bot = litBot({
      solid: (x, y, z) => y !== 64 || x !== 0 || z < 0 || z > 1,
      lit: (_x, _y, z) => ({ block: z === 1 ? 14 : 0, sky: 0 }),
    });
    expect(snapshotFromBot(bot).light).toBe(14);
  });

  it('夜里露天不算黑:天光扣掉 11 还剩 4', () => {
    expect(snapshotFromBot(litBot({ timeOfDay: 18000 })).light).toBe(4);
  });

  it('区块没加载时报 null——那时两路都读成 0,跟真的全黑分不开', () => {
    expect(snapshotFromBot(litBot({ loaded: () => false })).light).toBeNull();
  });

  it('整个人被方块埋住时报 null:没有可采的空间,不替她喊黑', () => {
    expect(snapshotFromBot(litBot({ solid: () => true })).light).toBeNull();
  });

  it('world 不提供光照接口时报 null,不当成 0', () => {
    expect(snapshotFromBot(litBot({ noLightApi: true })).light).toBeNull();
  });
});

describe('探路分诊:落脚预检与死角灌水', () => {
  /** 方块表驱动的假世界:表里没有的坐标一律按 fallback(默认空气) */
  function worldOf(solids: Array<[number, number, number]>, fallback: 'air' | 'stone' = 'air'): BlockReader {
    const set = new Set(solids.map(([x, y, z]) => `${x},${y},${z}`));
    return (x, y, z) => {
      const solid = set.has(`${x},${y},${z}`) || fallback === 'stone';
      return { name: solid ? 'stone' : 'air', solid: set.has(`${x},${y},${z}`) ? true : fallback === 'stone' };
    };
  }

  it('平地上的目标:目标格与邻格都能站', () => {
    // 全世界 y=63 一层地板
    const read: BlockReader = (_x, y, _z) => ({ name: y <= 63 ? 'stone' : 'air', solid: y <= 63 });
    const cells = standCellsAround(read, { x: 10, y: 64, z: 10 });
    // 目标格 + 四个水平邻格能站;y±1 两格(悬空/埋在地里)不能
    expect(cells.length).toBe(5);
  });

  it('树冠里的原木:一格都站不进', () => {
    // 目标与全部邻格都是实心(树干周围裹满树叶的形态)
    const t = { x: 5, y: 70, z: 5 };
    const read: BlockReader = () => ({ name: 'oak_leaves', solid: true });
    expect(standCellsAround(read, t)).toEqual([]);
  });

  it('水面目标:泡在水里也算落脚(浮着能到)', () => {
    const read: BlockReader = (_x, y, _z) => (
      y <= 62 ? { name: 'water', solid: false } : { name: 'air', solid: false }
    );
    const cells = standCellsAround(read, { x: 0, y: 62, z: 0 });
    expect(cells.length).toBeGreaterThan(0);
  });

  it('区块没加载不下结论:读数缺失的格子当能站', () => {
    const read: BlockReader = () => null;
    expect(standCellsAround(read, { x: 0, y: 64, z: 0 }).length).toBeGreaterThan(0);
  });

  it('封死的小气泡:灌水数得出死角大小', () => {
    // 3x3x3 石头块中心挖出一格空腔,目标躺在腔里
    const solids: Array<[number, number, number]> = [];
    for (let x = -1; x <= 1; x++) for (let y = 63; y <= 65; y++) for (let z = -1; z <= 1; z++) {
      if (!(x === 0 && y === 64 && z === 0)) solids.push([x, y, z]);
    }
    const read = worldOf(solids, 'stone');
    const seeds = [{ x: 0, y: 64, z: 0 }];
    expect(pocketScan(read, seeds)).toBe(1);
  });

  it('开阔地:灌水触到上限,不下"封死"的结论', () => {
    const read: BlockReader = (_x, y, _z) => ({ name: y <= 63 ? 'stone' : 'air', solid: y <= 63 });
    expect(pocketScan(read, [{ x: 0, y: 64, z: 0 }])).toBeNull();
  });

  it('灌水摸到未加载区块:不下结论', () => {
    const read: BlockReader = (x, y, z) => (Math.abs(x) > 2 ? null : { name: y <= 63 ? 'stone' : 'air', solid: y <= 63 });
    expect(pocketScan(read, [{ x: 0, y: 64, z: 0 }])).toBeNull();
  });
});

/**
 * 脚泡在液体中时 standingOn 应报告液体；头部 inWater 与脚部状态不同。
 */
describe('standingOn:脚泡在液体里就报液体', () => {
  function botOn(feet: string | null, below: string) {
    return {
      entity: { position: pos(0.5, 64, 0.5), velocity: { x: 0, y: 0, z: 0 }, yaw: 0, onGround: true },
      entities: {},
      registry: { biomes: {}, blocksByName: {} },
      findBlocks: () => [],
      blockAt: (p: { y: number }) => {
        if (p.y === 64) return feet === null ? null : { name: feet, boundingBox: 'empty' };
        if (p.y === 63) return { name: below, boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
      },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0, heldItem: null,
      inventory: { items: () => [] }, players: {},
    };
  }

  it('一格水:报水,不报水底下那块石头', () => {
    const snap = snapshotFromBot(botOn('water', 'stone'));
    expect(snap.standingOn).toBe('water');
    expect(snap.inWater).toBe(false); // 头在空气里,氧气读数照旧不可信
    expect(narrateWorld(snap)).toContain('脚下是水');
  });

  it('岩浆同理:脚陷进去了就说岩浆', () => {
    expect(snapshotFromBot(botOn('lava', 'stone')).standingOn).toBe('lava');
  });

  it('脚下踩着什么才是她要的答案:草、火把这类不改口', () => {
    expect(snapshotFromBot(botOn('short_grass', 'grass_block')).standingOn).toBe('grass_block');
    expect(snapshotFromBot(botOn('air', 'grass_block')).standingOn).toBe('grass_block');
    expect(snapshotFromBot(botOn(null, 'grass_block')).standingOn).toBe('grass_block');
  });
});

/**
 * 村民职业与幼年状态须进入感知身份注。
 */
describe('村民身份注 villagerNote', () => {
  it('职业对象按形状找(不钉下标),按注册表序翻译;none=还没有职业', () => {
    const meta = (at: number, profession: number): unknown[] => {
      const m: unknown[] = new Array(19).fill(null);
      m[at] = { villagerType: 2, villagerProfession: profession, level: 1 };
      return m;
    };
    expect(villagerNote({ name: 'villager', metadata: meta(18, 5) })).toBe('农民');
    expect(villagerNote({ name: 'villager', metadata: meta(18, 0) })).toBe('还没有职业');
    expect(villagerNote({ name: 'villager', metadata: meta(18, 11) })).toBe('傻子');
    // 版本迁移把下标挪了也认得出:按对象形状扫
    expect(villagerNote({ name: 'villager', metadata: meta(17, 8) })).toBe('皮匠');
    // 注册表长出新职业:报编号,不瞎译
    expect(villagerNote({ name: 'villager', metadata: meta(18, 99) })).toBe('职业#99');
  });

  it('小孩按 16 位(台架实锚);非村民/没元数据不给注', () => {
    const m: unknown[] = new Array(19).fill(null);
    m[16] = true;
    m[18] = { villagerType: 2, villagerProfession: 0, level: 1 };
    expect(villagerNote({ name: 'villager', metadata: m })).toBe('小孩');
    expect(villagerNote({ name: 'zombie', metadata: m })).toBe(null);
    expect(villagerNote({ name: 'villager' })).toBe(null);
  });

  it('快照与叙述带上身份注:看得见的有村民（农民）', () => {
    const m: unknown[] = new Array(19).fill(null);
    m[18] = { villagerType: 2, villagerProfession: 5, level: 1 };
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      entities: {
        '1': { name: 'villager', type: 'mob', position: pos(0.5, 64, 6), metadata: m },
      },
      registry: { biomes: {}, blocksByName: {} },
      findBlocks: () => [],
      blockAt: () => null,
      world: { raycast: () => null },
      game: { dimension: 'overworld', gameMode: 'survival' },
      health: 20, food: 20, oxygenLevel: 20,
      time: { timeOfDay: 1000 }, rainState: 0,
      heldItem: null,
      inventory: { items: () => [] },
      players: {},
    };
    const s = snapshotFromBot(bot);
    expect(s.entities.find((e) => e.name === 'villager')?.note).toBe('农民');
    expect(narrateWorld(s)).toContain('有村民（农民）');
  });
});

/**
 * bodyInWater 判断战斗和撤退的水陆姿态；findBankCell 寻找登岸格，同一圈优先远离敌群的一侧。
 */
describe('bodyInWater / findBankCell:水陆判据与登岸点', () => {
  /** 以 (0,64,0) 为中心的一片水,x≥bankX 处是岸(脚下实心、脚与头是空气) */
  function waterBot(bankX: number | null) {
    return {
      entity: { position: pos(0.5, 64, 0.5) },
      blockAt: (p: { x: number; y: number; z: number }) => {
        const onLand = bankX !== null && p.x >= bankX;
        if (p.y <= 63) return { name: onLand ? 'stone' : 'water', boundingBox: onLand ? 'block' : 'empty' };
        if (p.y === 64 || p.y === 65) return onLand
          ? { name: 'air', boundingBox: 'empty' }
          : { name: 'water', boundingBox: 'empty' };
        return { name: 'air', boundingBox: 'empty' };
      },
    };
  }

  it('脚或头泡在水里都算在水里;上岸后不算', () => {
    expect(bodyInWater(waterBot(null))).toBe(true);
    const land = waterBot(0); // 全图是岸
    expect(bodyInWater(land)).toBe(false);
  });

  it('找得到岸:返回脚下实心、脚与头不是水的格子', () => {
    const bank = findBankCell(waterBot(4), null, 16);
    expect(bank).not.toBeNull();
    expect(bank!.x).toBeGreaterThanOrEqual(4);
  });

  it('同一圈优先背离怪群那侧:怪在东边就往西上岸', () => {
    const bot = {
      entity: { position: pos(0.5, 64, 0.5) },
      blockAt: (p: { x: number; y: number; z: number }) => {
        // 东西两侧 |x|≥4 都是岸,南北是水
        const onLand = Math.abs(p.x) >= 4;
        if (p.y <= 63) return { name: onLand ? 'stone' : 'water', boundingBox: onLand ? 'block' : 'empty' };
        if (p.y === 64 || p.y === 65) return onLand
          ? { name: 'air', boundingBox: 'empty' }
          : { name: 'water', boundingBox: 'empty' };
        return { name: 'air', boundingBox: 'empty' };
      },
    };
    const bank = findBankCell(bot, { x: 8, z: 0 }, 16); // 怪群质心在东边
    expect(bank).not.toBeNull();
    expect(bank!.x).toBeLessThan(0); // 往西那侧上岸
  });

  it('周围全是水:返回 null,不硬造目标', () => {
    expect(findBankCell(waterBot(null), null, 8)).toBeNull();
  });
});

describe('wetNote', () => {
  /** x < 4 是两格深的水(底 y=60),x ≥ 4 是岸(实心到 y=62) */
  function poolBot() {
    const blockAt = (p: { x: number; y: number; z: number }) => {
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      const bankTop = x >= 4 ? 62 : 60;
      const name = y <= bankTop ? 'stone' : y <= 62 ? 'water' : 'air';
      return { name, boundingBox: name === 'stone' ? 'block' : 'empty' };
    };
    const at = (x: number, y: number, z: number) => ({
      x, y, z,
      offset: (dx: number, dy: number, dz: number) => at(x + dx, y + dy, z + dz),
      floored: () => at(Math.floor(x), Math.floor(y), Math.floor(z)),
    });
    // 浮在水面上时物理引擎的 isInWater 会逐刻翻,这里取读成 false 的那一刻
    return { entity: { position: at(0.5, 62.3, 0.5), isInWater: false }, vehicle: null, blockAt };
  }

  it('isInWater 读成 false 但脚下那格是水:照样补水深与最近的岸', () => {
    const note = wetNote(poolBot());
    expect(note).toContain('脚下水深 2 格');
    expect(note).toContain('最近能站的干地 (4, 63,');
  });
});
