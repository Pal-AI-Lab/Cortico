/**
 * 前置试算的单测。
 *
 * 这里守的不是「试算说了什么」,而是**试算与技能的判定必须一致**:
 * 试算判 `hard` ⇒ 真跑必受阻。反过来技能会正常返回的形态(例如吃饱了 —— 执行器
 * 注释明写「吃饱了是这一步的正常结局,不是受阻」),试算一个字都不许说。
 *
 * 这条纪律是被实测打出来的:出队刻硬闸的第一版把 3 个本来能成的任务判死了,
 * 台架又抓到「吃饱了」被误报成 hard。判据漂移是这套东西唯一的真风险。
 */
import { describe, expect, it } from 'vitest';
import { precheckStep, precheckSteps, renderPrecheckNotes, type PrecheckDeps } from '../../../src/worlds/minecraft/precheck.ts';
import { parseSteps, type SkillCall } from '../../../src/worlds/minecraft/executor.ts';
import { resolveAnchors, type Anchor } from '../../../src/worlds/minecraft/geometry.ts';

interface FakeItem { type: number; count: number; name: string }

const NAMES: Record<number, { name: string }> = {
  1: { name: 'cobblestone' }, 2: { name: 'stick' }, 3: { name: 'stone_pickaxe' },
  4: { name: 'dirt' }, 5: { name: 'torch' }, 6: { name: 'cooked_beef' },
  7: { name: 'golden_apple' }, 8: { name: 'white_bed' }, 9: { name: 'iron_pickaxe' },
  10: { name: 'iron_hoe' }, 11: { name: 'wheat_seeds' },
  12: { name: 'pufferfish' }, 13: { name: 'wooden_pickaxe' },
  14: { name: 'bow' }, 15: { name: 'arrow' },
  16: { name: 'bamboo' }, 17: { name: 'oak_planks' }, 18: { name: 'jungle_planks' },
  19: { name: 'spruce_planks' }, 20: { name: 'birch_planks' },
  21: { name: 'milk_bucket' },
};
/** 工具/床一格只放一件,别的按 64:空格试算全靠这个数 */
const STACK_MAX: Record<string, number> = {
  stone_pickaxe: 1, iron_pickaxe: 1, white_bed: 1, golden_apple: 64, milk_bucket: 1,
};
const BY_NAME = Object.fromEntries(
  Object.entries(NAMES).map(([id, v]) =>
    [v.name, { id: Number(id), name: v.name, stackSize: STACK_MAX[v.name] ?? 64 }]),
);

/** 石镐 = 圆石×3 + 木棍×2 */
const PICK_RECIPE = { delta: [{ id: 1, count: -3 }, { id: 2, count: -2 }, { id: 3, count: 1 }] };
/** 木棍 = 竹子×2 或 橡木木板×2(1.20.6 的 minecraft-data 把 #planks 拍平成只剩橡木) */
const STICK_RECIPES = [
  { delta: [{ id: 16, count: -2 }, { id: 2, count: 4 }] },
  { delta: [{ id: 17, count: -2 }, { id: 2, count: 4 }] },
];

type FakeRecipe = { delta: Array<{ id: number; count: number }> };

function fakeBot(opts: {
  bag?: Array<[string, number]>;
  /** 覆盖配方表:物品 id → 配方数组;没列的走内置的石镐/木棍两张 */
  recipes?: Record<number, FakeRecipe[]>;
  food?: number;
  health?: number;
  at?: [number, number, number];
  /** 世界:'x,y,z' → 方块名;没列的当空气 */
  blocks?: Record<string, string | null>;
  entities?: Array<{ name: string; d: number }>;
  los?: boolean;
} = {}) {
  const items: FakeItem[] = (opts.bag ?? []).map(([name, count]) => ({
    name, count, type: BY_NAME[name]?.id ?? 99,
  }));
  const at = opts.at ?? [0, 64, 0];
  const blocks = opts.blocks ?? {};
  const entities: Record<string, unknown> = {};
  (opts.entities ?? []).forEach((e, i) => {
    entities[String(i)] = {
      id: i + 1, name: e.name, type: 'mob', height: 1.8, width: 0.6,
      position: { x: at[0] + e.d, y: at[1], z: at[2] },
    };
  });
  return {
    entity: { position: { x: at[0] + 0.5, y: at[1], z: at[2] + 0.5 } },
    entities,
    food: opts.food ?? 20,
    health: opts.health ?? 20,
    inventory: { items: () => items },
    world: { raycast: () => opts.los === false ? { name: 'stone' } : null },
    registry: {
      items: NAMES,
      itemsByName: BY_NAME,
      foodsByName: { cooked_beef: {}, golden_apple: {}, pufferfish: {} },
      blocksByName: {
        stone: { harvestTools: { 13: true, 3: true, 9: true } },
        iron_ore: { harvestTools: { 3: true, 9: true } },
      },
    },
    recipesAll: (id: number) => opts.recipes?.[id]
      ?? (id === 3 ? [PICK_RECIPE] : id === 2 ? STICK_RECIPES : []),
    blockAt: (p: { x: number; y: number; z: number }) => {
      const n = blocks[`${p.x},${p.y},${p.z}`];
      if (n === null) return null;
      if (!n) return { name: 'air', boundingBox: 'empty' };
      return { name: n, boundingBox: n === 'air' ? 'empty' : 'block' };
    },
  } as never;
}

/**
 * deps 必须绑到具体 bot —— `blockAt` 是执行器传进来的 blockAtCell(真机内部 new Vec3)。
 * 类型上强制要求它,正是为了不让「方块判据在真机静默失效」再发生一次。
 */
function makeDeps(bot: ReturnType<typeof fakeBot>): PrecheckDeps {
  return {
  blockAt: (c) => (bot as unknown as { blockAt(p: unknown): { name: string; boundingBox?: string } | null }).blockAt(c),
  resolve: (a) => {
    if (!Array.isArray(a)) return null;
    const p = (bot as { entity: { position: { x: number; y: number; z: number } } }).entity.position;
    const cells = resolveAnchors([a as Anchor], { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    return 'error' in cells ? null : cells[0];
  },
  cellsOf: (c) => {
    const b = c as { anchors?: Array<[number, number, number]>; shape?: string };
    if (!b.anchors) return null;
    if (b.shape !== 'box') return b.anchors.map(([x, y, z]) => ({ x, y, z }));
    const [a1, a2] = b.anchors;
    const out: Array<{ x: number; y: number; z: number }> = [];
    for (let x = Math.min(a1[0], a2[0]); x <= Math.max(a1[0], a2[0]); x++) {
      for (let y = Math.min(a1[1], a2[1]); y <= Math.max(a1[1], a2[1]); y++) {
        for (let z = Math.min(a1[2], a2[2]); z <= Math.max(a1[2], a2[2]); z++) out.push({ x, y, z });
      }
    }
    return out;
  },
  };
}

const call = (c: unknown): SkillCall => c as SkillCall;

describe('前置试算 · 判死的必须真的做不成', () => {
  it('craft 缺料:说清还差什么,不只说「凑不齐」', () => {
    const bot = fakeBot({ bag: [['stick', 1]] });
    const n = precheckStep(bot, call({ skill: 'craft', item: 'stone_pickaxe', count: 1 }), makeDeps(bot));
    expect(n?.level).toBe('hard');
    expect(n?.text).toContain('圆石×3');
    expect(n?.text).toContain('木棍×1'); // 已有 1 根,只差 1
  });

  // 配方缺口并列时报告全部并列选项，不按 recipesAll 顺序代选。
  it('craft 缺口并列:并列的几条都说,不由配方表的顺序替她挑一条', () => {
    const bot = fakeBot({ bag: [['jungle_planks', 12]] });
    const n = precheckStep(bot, call({ skill: 'craft', item: 'stick', count: 4 }), makeDeps(bot));
    expect(n?.level).toBe('hard');
    expect(n?.text).toBe('做木棍还差 竹子×2 或 橡木木板×2');
  });

  it('craft 缺口严格更小:只报最近的那一条,不退化成并列', () => {
    const bot = fakeBot({ bag: [['jungle_planks', 12], ['bamboo', 1]] });
    const n = precheckStep(bot, call({ skill: 'craft', item: 'stick', count: 4 }), makeDeps(bot));
    expect(n?.text).toBe('做木棍还差 竹子×1');
    expect(n?.text).not.toContain('或');
  });

  it('craft 并列条数超上限:列三条,余下的只报条数', () => {
    const bot = fakeBot({
      bag: [],
      recipes: {
        2: [16, 17, 18, 19, 20].map((id) => ({ delta: [{ id, count: -2 }, { id: 2, count: 4 }] })),
      },
    });
    const n = precheckStep(bot, call({ skill: 'craft', item: 'stick', count: 4 }), makeDeps(bot));
    expect(n?.text).toBe('做木棍还差 竹子×2 或 橡木木板×2 或 丛林木板×2;还有 2 条配方缺口一样多');
    expect(n?.text).not.toContain('云杉木板');
  });

  it('craft 料齐:一个字都不说', () => {
    const bot = fakeBot({ bag: [['cobblestone', 8], ['stick', 4]] });
    expect(precheckStep(bot, call({ skill: 'craft', item: 'stone_pickaxe', count: 1 }), makeDeps(bot))).toBeNull();
  });

  it('eat 没吃的:判死', () => {
    const bot = fakeBot({ bag: [], food: 10 });
    expect(precheckStep(bot, call({ skill: 'eat', item: 'cooked_beef' }), makeDeps(bot))?.level).toBe('hard');
  });

  it('eat 包里只有别的食物:点名食物缺货就判死', () => {
    const bot = fakeBot({ bag: [['golden_apple', 1]], food: 10 });
    const n = precheckStep(bot, call({ skill: 'eat', item: 'cooked_beef' }), makeDeps(bot));
    expect(n?.level).toBe('hard');
    expect(n?.text).toContain('牛排');
  });

  it('eat 显式点名河豚且有库存:与执行技能一致放行', () => {
    const bot = fakeBot({ bag: [['pufferfish', 1]], food: 10 });
    expect(precheckStep(bot, call({ skill: 'eat', item: 'pufferfish' }), makeDeps(bot))).toBeNull();
  });

  it('eat 背包顺序不影响点名食物:与执行技能一致放行', () => {
    const bot = fakeBot({ bag: [['pufferfish', 1], ['cooked_beef', 1]], food: 10 });
    expect(precheckStep(bot, call({ skill: 'eat', item: 'cooked_beef' }), makeDeps(bot))).toBeNull();
  });

  // 牛奶桶虽不在 foodsByName 饱食度食物表中，仍可饮用。
  it('eat 牛奶桶:不在食物表里也放行,与技能一致', () => {
    const bot = fakeBot({ bag: [['milk_bucket', 1]], food: 20 });
    expect(precheckStep(bot, call({ skill: 'eat', item: 'milk_bucket' }), makeDeps(bot))).toBeNull();
  });

  it('eat 牛奶桶但包里没有:仍按缺货判死', () => {
    const bot = fakeBot({ bag: [['cooked_beef', 1]], food: 10 });
    const n = precheckStep(bot, call({ skill: 'eat', item: 'milk_bucket' }), makeDeps(bot));
    expect(n?.rule).toBe('eat.noStock');
  });

  it('eat 吃饱了:技能对这一形态是正常返回,所以试算必须闭嘴', () => {
    // 吃饱属于正常无操作结局，试算不得判 hard。
    const bot = fakeBot({ bag: [['cooked_beef', 3]], food: 20 });
    expect(precheckStep(bot, call({ skill: 'eat', item: 'cooked_beef' }), makeDeps(bot))).toBeNull();
  });

  it('挖掘工具:默认与 fastest 都不允许用不够级的镐毁矿', () => {
    for (const tool of [undefined, 'fastest']) {
      const bot = fakeBot({ bag: [['wooden_pickaxe', 1]] });
      const n = precheckStep(bot, call({
        skill: 'collect', block: 'iron_ore', count: 1, ...(tool ? { tool } : {}),
      }), makeDeps(bot));
      expect(n).toMatchObject({ level: 'hard', rule: 'collect.toolNoDrop' });
      expect(n?.text).toContain('要石镐及以上');
      expect(n?.text).toContain('还没动方块');
    }
  });

  it('挖掘工具:有能保住掉落的镐时默认与 fastest 都放行', () => {
    const bot = fakeBot({ bag: [['stone_pickaxe', 1], ['iron_pickaxe', 1]] });
    expect(precheckStep(bot, call({ skill: 'collect', block: 'iron_ore', count: 1 }), makeDeps(bot))).toBeNull();
    expect(precheckStep(bot, call({ skill: 'collect', block: 'iron_ore', count: 1, tool: 'fastest' }), makeDeps(bot))).toBeNull();
  });

  it('挖掘工具:精确点名缺货或不够级都硬阻断,不静默替换', () => {
    const missing = fakeBot({ bag: [['iron_pickaxe', 1]] });
    expect(precheckStep(missing, call({
      skill: 'tunnel', at: [0, 60, 0], tool: 'diamond_pickaxe',
    }), makeDeps(missing))).toMatchObject({ level: 'hard', rule: 'tunnel.toolNoStock' });

    const wrong = fakeBot({ bag: [['wooden_pickaxe', 1], ['iron_pickaxe', 1]], blocks: { '0,64,0': 'iron_ore' } });
    const n = precheckStep(wrong, call({
      skill: 'excavate', shape: 'line', anchors: [[0, 64, 0], [0, 64, 0]], tool: 'wooden_pickaxe',
    }), makeDeps(wrong));
    expect(n).toMatchObject({ level: 'hard', rule: 'excavate.toolNoDrop' });
    expect(n?.text).toContain('不会改用别的工具');
  });

  it('build 贴面:参照那一格不是实心就贴不住', () => {
    const bot = fakeBot({ bag: [['torch', 5]] });
    const parsed = parseSteps([{
      skill: 'build', material: 'torch', on: [{ at: [3, 65, 0], face: 'down' }],
    }]);
    if ('error' in parsed) throw new Error(parsed.error);
    const n = precheckStep(bot, parsed.steps[0], makeDeps(bot));
    expect(n?.level).toBe('hard');
    expect(n?.text).toContain('贴不住');
  });

  it('build 贴面:参照格是实心就不吭声', () => {
    const bot = fakeBot({ bag: [['torch', 5]], blocks: { '3,65,0': 'stone' } });
    const parsed = parseSteps([{
      skill: 'build', material: 'torch', on: [{ at: [3, 65, 0], face: 'down' }],
    }]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(precheckStep(bot, parsed.steps[0], makeDeps(bot))).toBeNull();
  });

  it('build 贴面:相对坐标解析为参照格,面外侧为空仍可放置', () => {
    const bot = fakeBot({ at: [10, 64, -4], bag: [['torch', 5]], blocks: { '13,65,-4': 'stone' } });
    const parsed = parseSteps([{
      skill: 'build', material: 'torch', on: [{ at: ['~3', '~1', '~'], face: 'down' }],
    }]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(precheckStep(bot, parsed.steps[0], makeDeps(bot))).toBeNull();
  });

  it('build 贴面:未加载的参照格只报 unknown,不当成非实心', () => {
    const bot = fakeBot({ bag: [['torch', 5]], blocks: { '3,65,0': null } });
    const parsed = parseSteps([{
      skill: 'build', material: 'torch', on: [{ at: [3, 65, 0], face: 'down' }],
    }]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(precheckStep(bot, parsed.steps[0], makeDeps(bot))).toMatchObject({ level: 'soft', rule: 'build.unloaded' });
  });

  it('build 锚点:料不够铺满,报出缺口', () => {
    const bot = fakeBot({ bag: [['dirt', 2]] });
    const n = precheckStep(bot, call({
      skill: 'build', material: 'dirt', shape: 'box', anchors: [[2, 64, -1], [4, 64, 1]],
    }), makeDeps(bot));
    expect(n?.level).toBe('hard');
    expect(n?.text).toContain('差 7');
  });

  it('tunnel 坡度超 45°:与技能逐字同源', () => {
    const bot = fakeBot({ at: [0, 101, 0] });
    const n = precheckStep(bot, call({ skill: 'tunnel', at: [2, 81, 0] }), makeDeps(bot));
    expect(n?.level).toBe('hard');
    expect(n?.text).toContain('坡度超过 45°');
  });

  it('tunnel 坡度合法:不吭声', () => {
    const bot = fakeBot({ at: [0, 101, 0] });
    expect(precheckStep(bot, call({ skill: 'tunnel', at: [20, 96, 0] }), makeDeps(bot))).toBeNull();
  });

  it('equip 包里没有:带上技能自己的模糊命中提示', () => {
    const bot = fakeBot({ bag: [['stone_pickaxe', 1]] });
    const n = precheckStep(bot, call({ skill: 'equip', item: 'iron_pickaxe' }), makeDeps(bot));
    expect(n?.level).toBe('hard');
    expect(n?.text).toContain('包里没有');
  });

  it('equip 主手点名的东西挂在副手:不报包里没有(执行时会从副手换过来)', () => {
    const bot = fakeBot({ bag: [] });
    (bot as unknown as { inventory: { slots?: unknown[] } }).inventory.slots =Object.assign([], { 45: { name: 'diamond_sword', count: 1, type: 7 } });
    expect(precheckStep(bot, call({ skill: 'equip', item: 'diamond_sword', hand: 'main' }), makeDeps(bot))).toBeNull();
  });

  it('use item 指向的那一格本身就是那件东西:照抄技能的正确写法提示', () => {
    const bot = fakeBot({ bag: [], blocks: { '3,64,0': 'white_bed' } });
    const n = precheckStep(bot, call({ skill: 'use', item: 'white_bed', at: [3, 64, 0] }), makeDeps(bot));
    expect(n?.level).toBe('hard');
    expect(n?.text).toContain('那一格本身就是');
    expect(n?.text).toContain('不用带 item');
  });

  it('attack 目标不在身边:只算 soft(它会自己走过来),不判死', () => {
    const bot = fakeBot({});
    const n = precheckStep(bot, call({ skill: 'attack', target: 'cow' }), makeDeps(bot));
    expect(n?.level).toBe('soft');
  });

  it('attack 目标就在 32 格内:不吭声', () => {
    const bot = fakeBot({ entities: [{ name: 'cow', d: 10 }] });
    expect(precheckStep(bot, call({ skill: 'attack', target: 'cow' }), makeDeps(bot))).toBeNull();
  });

  it('forced ranged/kite 的弓、箭、LOS 缺口是 hard,不会暗示近战替代', () => {
    const noBow = fakeBot({ bag: [['arrow', 8]], entities: [{ name: 'cow', d: 10 }] });
    expect(precheckStep(noBow, call({ skill: 'attack', target: 'cow', mode: 'ranged' }), makeDeps(noBow)))
      .toMatchObject({ level: 'hard', rule: 'attack.noBow' });

    const noArrow = fakeBot({ bag: [['bow', 1]], entities: [{ name: 'cow', d: 10 }] });
    expect(precheckStep(noArrow, call({ skill: 'attack', target: 'cow', mode: 'kite' }), makeDeps(noArrow)))
      .toMatchObject({ level: 'hard', rule: 'attack.noArrow' });

    const blocked = fakeBot({
      bag: [['bow', 1], ['arrow', 8]], entities: [{ name: 'cow', d: 10 }], los: false,
    });
    const note = precheckStep(blocked, call({ skill: 'attack', target: 'cow', mode: 'ranged' }), makeDeps(blocked));
    expect(note).toMatchObject({ level: 'hard', rule: 'attack.noLos' });
    expect(note?.text).toContain('不会改用近战');
  });

  it('带 dryRun 的步不再试算一遍', () => {
    const bot = fakeBot({ bag: [] });
    expect(precheckStep(bot, call({ skill: 'tunnel', at: [2, 40, 0], dryRun: true }), makeDeps(bot))).toBeNull();
  });

  it('take 空格不够:报剩几格、这步要几格,不替她决定扔什么', () => {
    // 35 格占着,只剩 1 格;取 3 把镐(堆叠上限 1)要 3 格
    const bag: Array<[string, number]> = Array.from({ length: 35 }, () => ['dirt', 64] as [string, number]);
    const bot = fakeBot({ bag });
    const n = precheckStep(bot, call({ skill: 'take', item: 'stone_pickaxe', count: 3 }), makeDeps(bot));
    expect(n?.level).toBe('soft');
    expect(n?.text).toBe('包里剩 1 格空位,这一步石镐×3 预计要占 3 格');
    expect(n?.text).not.toContain('扔');
  });

  it('空格按槽位数,不按名字合并:三把镐是三格不是一格', () => {
    const bag: Array<[string, number]> = [
      ...Array.from({ length: 33 }, () => ['dirt', 64] as [string, number]),
      ['stone_pickaxe', 1], ['stone_pickaxe', 1], ['stone_pickaxe', 1],
    ];
    const bot = fakeBot({ bag });
    // 33 + 3 = 36 格用满;按名字合并的话三把镐只算一格,会算出还剩两格
    expect(precheckStep(bot, call({ skill: 'take', item: 'iron_pickaxe', count: 1 }), makeDeps(bot))?.text)
      .toContain('包里剩 0 格空位');
  });

  it('已有的未满栈先填:剩 1 格也放得下 30 个圆石', () => {
    const bag: Array<[string, number]> = [
      ...Array.from({ length: 34 }, () => ['dirt', 64] as [string, number]),
      ['cobblestone', 40],
    ];
    const bot = fakeBot({ bag });
    expect(precheckStep(bot, call({ skill: 'take', item: 'cobblestone', count: 24 }), makeDeps(bot))).toBeNull();
  });

  it('collect/pickup 的掉落物试算刻叫不出名字,只在一格不剩时报', () => {
    const roomy = fakeBot({ bag: [['dirt', 64]] });
    expect(precheckStep(roomy, call({ skill: 'collect', block: 'oak_log', count: 64 }), makeDeps(roomy))).toBeNull();
    const full = fakeBot({ bag: Array.from({ length: 36 }, () => ['dirt', 64] as [string, number]) });
    const n = precheckStep(full, call({ skill: 'pickup' }), makeDeps(full));
    expect(n?.text).toContain('36 格全满了');
  });

  it('craft 料齐但没地方放:料的判据让位给空格的判据', () => {
    const bag: Array<[string, number]> = [
      ...Array.from({ length: 34 }, () => ['dirt', 64] as [string, number]),
      ['cobblestone', 8], ['stick', 4],
    ];
    const bot = fakeBot({ bag });
    expect(precheckStep(bot, call({ skill: 'craft', item: 'stone_pickaxe', count: 3 }), makeDeps(bot)))
      .toMatchObject({ rule: 'craft.slots' });
  });

  it('锄头指着空气:报读数与一个可能,不改她的坐标', () => {
    const bot = fakeBot({ bag: [['iron_hoe', 1]], blocks: { '3,64,0': 'dirt' } });
    const n = precheckStep(bot, call({ skill: 'use', item: 'iron_hoe', at: [3, 65, 0] }), makeDeps(bot));
    expect(n?.level).toBe('soft');
    expect(n?.text).toBe('(3,65,0) 是空气;锄头要指着土那一格(可能是 (3,64,0))');
  });

  it('种子指着空气:同一条判据,措辞换成种子', () => {
    const bot = fakeBot({ bag: [['wheat_seeds', 8]], blocks: { '3,64,0': 'farmland' } });
    const n = precheckStep(bot, call({ skill: 'use', item: 'wheat_seeds', at: [3, 65, 0] }), makeDeps(bot));
    expect(n?.text).toContain('种子要指着土那一格');
  });

  it('指着土那一格就不出声', () => {
    const bot = fakeBot({ bag: [['iron_hoe', 1]], blocks: { '3,64,0': 'dirt' } });
    expect(precheckStep(bot, call({ skill: 'use', item: 'iron_hoe', at: [3, 64, 0] }), makeDeps(bot))).toBeNull();
  });

  it('包里根本没有那把锄头:先说没有,差一格那句让位', () => {
    const bot = fakeBot({ bag: [], blocks: { '3,64,0': 'dirt' } });
    const n = precheckStep(bot, call({ skill: 'use', item: 'iron_hoe', at: [3, 65, 0] }), makeDeps(bot));
    expect(n?.level).toBe('hard');
    expect(n?.text).toContain('包里没有');
  });

  it('试算自己不许成为故障源:背包读取异常只返回 null', () => {
    const d = makeDeps(fakeBot({}));
    const broken = {
      registry: { foodsByName: { cooked_beef: {} } },
      inventory: { items: () => { throw new Error('boom'); } },
      food: 5,
    } as never;
    expect(precheckStep(broken, call({ skill: 'eat', item: 'cooked_beef' }), d)).toBeNull();
  });
});

describe('前置试算 · 受理回执的那一句', () => {
  it('全通就静默 —— 1418 次受理都挂一段话等于噪声', () => {
    expect(renderPrecheckNotes([])).toBeNull();
  });

  it('点名是第几步,并带「还没动工」防抢报', () => {
    const bot = fakeBot({ bag: [] });
    const hits = precheckSteps(bot, [
      call({ skill: 'goto', at: [1, 64, 0] }),
      call({ skill: 'craft', item: 'stone_pickaxe', count: 1 }),
    ], makeDeps(bot));
    const text = renderPrecheckNotes(hits);
    expect(text).toContain('还没动工');
    expect(text).toContain('第 2 步');
    expect(text).not.toContain('第 1 步');
  });

  it('hard 与 soft 分开说,soft 不混进判死那一段', () => {
    const bot = fakeBot({ bag: [] });
    const hits = precheckSteps(bot, [
      call({ skill: 'craft', item: 'stone_pickaxe', count: 1 }),
      call({ skill: 'attack', target: 'cow' }),
    ], makeDeps(bot));
    const text = renderPrecheckNotes(hits) ?? '';
    expect(text).toContain('试算(还没动工)');
    expect(text).toContain('另外');
    expect(text.indexOf('试算')).toBeLessThan(text.indexOf('另外'));
  });

  it('「包里没有任何食物」拎成 [口粮] 独立行,报四个数,不给建议', () => {
    // 受理时的生存读数包含生命值。
    const bot = fakeBot({ bag: [], food: 8, health: 1.5 });
    const deps = { ...makeDeps(bot), lastAte: () => Date.now() - 25 * 60_000 };
    const text = renderPrecheckNotes(precheckSteps(bot, [call({ skill: 'eat', item: 'cooked_beef' })], deps)) ?? '';
    expect(text.startsWith('[口粮] ')).toBe(true);
    expect(text).toContain('包里没有任何食物');
    expect(text).toContain('上次进食 25 分钟前');
    expect(text).toContain('饱食度 8/20');
    expect(text).toContain('生命 2/20');
    expect(text).not.toContain('试算(还没动工)');
  });

  it('[口粮] 在前、别的试算在后,两段各说各的', () => {
    const bot = fakeBot({ bag: [], food: 8 });
    const deps = { ...makeDeps(bot), lastAte: () => null };
    const text = renderPrecheckNotes(precheckSteps(bot, [
      call({ skill: 'eat', item: 'cooked_beef' }),
      call({ skill: 'craft', item: 'stone_pickaxe', count: 1 }),
    ], deps)) ?? '';
    expect(text.split('\n')[0]).toContain('[口粮]');
    expect(text).toContain('这一场还没吃过东西');
    expect(text).toContain('第 2 步做石镐还差');
  });
});

/**
 * 深层作业的水桶缺失提示为 soft，只报告事实，不阻止执行。
 */
describe('前置试算 · 深层作业水桶', () => {
  it('tunnel 目标 y ≤ 0 且没带水桶:soft 提示,不闸', () => {
    const bot = fakeBot({ at: [0, 10, 0] });
    const n = precheckStep(bot, call({ skill: 'tunnel', at: [40, -20, 0] }), makeDeps(bot));
    expect(n?.level).toBe('soft');
    expect(n?.rule).toBe('tunnel.deepNoWater');
    expect(n?.text).toContain('y=-20');
    expect(n?.text).toContain('水桶');
    expect(n?.text).toContain('还没动工');
  });

  it('带了水桶、或目标不深:一个字不说', () => {
    const withBucket = fakeBot({ at: [0, 10, 0], bag: [['water_bucket', 1]] });
    expect(precheckStep(withBucket, call({ skill: 'tunnel', at: [40, -20, 0] }), makeDeps(withBucket))).toBeNull();
    const shallow = fakeBot({ at: [0, 70, 0] });
    expect(precheckStep(shallow, call({ skill: 'tunnel', at: [40, 40, 0] }), makeDeps(shallow))).toBeNull();
  });

  it('excavate 按体积最低格判;collect 按人现在站的深度判', () => {
    const digger = fakeBot({ at: [0, -5, 0] });
    const box = precheckStep(digger, call({
      skill: 'excavate', shape: 'box', anchors: [[0, -10, 0], [2, -12, 2]],
    }), makeDeps(digger));
    expect(box?.level).toBe('soft');
    expect(box?.rule).toBe('excavate.deepNoWater');
    expect(box?.text).toContain('y=-12');

    const miner = fakeBot({ at: [0, -30, 0], bag: [['wooden_pickaxe', 1]] });
    const n = precheckStep(miner, call({ skill: 'collect', block: 'stone', count: 8 }), makeDeps(miner));
    expect(n?.level).toBe('soft');
    expect(n?.rule).toBe('collect.deepNoWater');
    // 地表采集不沾这条
    const surface = fakeBot({ at: [0, 70, 0], bag: [['wooden_pickaxe', 1]] });
    expect(precheckStep(surface, call({ skill: 'collect', block: 'stone', count: 8 }), makeDeps(surface))).toBeNull();
  });
});
