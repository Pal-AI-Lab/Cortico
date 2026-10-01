/**
 * 定位测试覆盖 probe.where、find 命中格旁的落脚点，以及无法识别的物品 id。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { V, makeExecutorOn, waitUntil } from './executor-harness.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const NON_SOLID = new Set(['air', 'water', 'lava', 'torch']);

/**
 * 只读世界的假 bot。`canSeeBlock` 由 `blind` 点名哪几种看不见 ——
 * 封在结构里的方块 `findBlocks` 索引得到、视线到不了,这正是要复现的形状。
 */
function worldBot(
  cells: Record<string, string>,
  at: { x: number; y: number; z: number },
  opts: {
    blind?: ReadonlySet<string>;
    stock?: Array<{ name: string; count: number; type: number }>;
    entities?: Record<string, { name: string; position: V }>;
  } = {},
) {
  const world = new Map(Object.entries(cells));
  const names = new Set(['air', 'stone', 'nether_bricks', 'spawner', 'salmon', ...world.values()]);
  const blocksByName: Record<string, { id: number; name: string }> = {};
  let nextId = 1;
  for (const n of names) blocksByName[n] = { id: nextId++, name: n };
  const blind = opts.blind ?? new Set<string>();
  const bag = opts.stock ?? [];
  const bot = {
    // `canSeeBlock` 说不见时 canSeeBlockAt 会补一次射线;这一份台架里射线一律不中
    world: { raycast: () => null },
    entity: { id: 9, position: new V(at.x, at.y, at.z), onGround: true, eyeHeight: 1.62 },
    entities: opts.entities ?? {},
    players: {},
    health: 20,
    food: 20,
    game: { minY: -64, height: 384, dimension: 'minecraft:the_nether' },
    inventory: { items: () => bag },
    registry: {
      blocksByName, itemsByName: { salmon: {}, cooked_salmon: {} }, items: {}, foodsByName: { salmon: {} },
      entitiesByName: { chest_minecart: {} },
    },
    equip: async () => {},
    lookAt: async () => {},
    blockAt: (p: V) => {
      const [x, y, z] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
      const name = world.get(`${x},${y},${z}`) ?? 'air';
      return {
        name,
        position: new V(x, y, z),
        boundingBox: NON_SOLID.has(name) ? 'empty' : 'block',
        diggable: true,
        canHarvest: () => true,
      };
    },
    canSeeBlock: (b: { name: string }) => !blind.has(b.name),
    // 真 findBlocks 走区块索引:无视遮挡,只看距离
    findBlocks: (o: { matching: number[]; maxDistance: number; count: number }) => {
      const me = bot.entity.position;
      const out: V[] = [];
      for (const [k, name] of world) {
        const id = blocksByName[name]?.id;
        if (id === undefined || !o.matching.includes(id)) continue;
        const [x, y, z] = k.split(',').map(Number);
        if (Math.hypot(x + 0.5 - me.x, y + 0.5 - me.y, z + 0.5 - me.z) <= o.maxDistance) out.push(new V(x, y, z));
      }
      return out.slice(0, o.count);
    },
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
  };
  return bot;
}

/** 封死的一间下界砖房子,刷怪笼在正中;外面一格站着人 */
function sealedRoom(): Record<string, string> {
  const cells: Record<string, string> = { '0,63,0': 'stone' };
  for (let x = 9; x <= 13; x++) {
    for (let y = 63; y <= 67; y++) {
      for (let z = 9; z <= 13; z++) {
        const edge = x === 9 || x === 13 || y === 63 || y === 67 || z === 9 || z === 13;
        if (edge) cells[`${x},${y},${z}`] = 'nether_bricks';
      }
    }
  }
  cells['11,65,11'] = 'spawner';
  return cells;
}

describe('probe 的 where 档:封在结构里的东西', () => {
  it('刷怪笼在封死的房子里:视线看不见,where 照样报出坐标', async () => {
    const bot = worldBot(sealedRoom(), { x: 0.5, y: 64, z: 0.5 }, { blind: new Set(['spawner']) });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'find', target: 'spawner', distance: 48 },
      // 21×13×21 = 5733 格:超过逐格/聚合两档的 2048 上限,where 档吃得下
      { skill: 'probe', shape: 'box', anchors: [[0, 60, 0], [20, 72, 20]], where: ['spawner'] },
    ]);
    await waitUntil(() => reports.length === 1, 15_000);
    const text = reports[0].text;
    // find 走视线闸:看不见就是看不见,不许拿索引冒充
    expect(text).toContain('没看见刷怪笼');
    // where 档读区块:坐标照报
    expect(text).toContain('刷怪笼×1:(11, 65, 11)');
    expect(text).toContain('不受遮挡与视线限制');
  });

  it('这片里一样都没有也照实说', async () => {
    const bot = worldBot({ '0,63,0': 'stone' }, { x: 0.5, y: 64, z: 0.5 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'probe', shape: 'box', anchors: [[0, 60, 0], [8, 68, 8]], where: ['spawner'] }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].text).toContain('一样都没有');
  });

  it('不给 where 时同一个盒子仍受 2048 格上限', async () => {
    const bot = worldBot(sealedRoom(), { x: 0.5, y: 64, z: 0.5 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'probe', shape: 'box', anchors: [[0, 60, 0], [20, 72, 20]] }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].text).toContain('一单上限 2048');
  });

  it('where 点名运输矿车:按实体表报坐标,不说成认不出来', async () => {
    const bot = worldBot({ '0,63,0': 'stone' }, { x: 0.5, y: 64, z: 0.5 }, {
      entities: { 7: { name: 'chest_minecart', position: new V(4.5, 64, 4.5) } },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'probe', shape: 'box', anchors: [[0, 60, 0], [8, 68, 8]], where: ['spawner', 'chest_minecart'],
    }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].text).toContain('运输矿车(实体)×1:(4, 64, 4)');
    expect(reports[0].text).not.toContain('认不出来');
  });

  it('数量多时只列最近几处,总数照实报', async () => {
    const bot = worldBot(sealedRoom(), { x: 0.5, y: 64, z: 0.5 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'probe', shape: 'box', anchors: [[8, 62, 8], [14, 68, 14]], where: ['nether_bricks'],
    }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].text).toMatch(/下界砖块×\d{2,},最近的 /);
  });
});

describe('find 命中格旁边的落点', () => {
  it('blockAt 之外点名一个站得住的格子:goto 有地方去', async () => {
    // 一块孤零零的下界砖,四周与顶上都是空的:站它头上最近
    const bot = worldBot(
      { '0,63,0': 'stone', '3,63,0': 'stone', '3,64,0': 'nether_bricks' },
      { x: 0.5, y: 64, z: 0.5 },
    );
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'nether_bricks', distance: 16 }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].text).toContain('blockAt=(3, 64, 0)');
    expect(reports[0].text).toContain('贴着它站得住的是 (3, 65, 0),goto 走这一格');
  });

  it('四周与顶上都没有落脚时不编一个格子出来', async () => {
    // 埋在实心里的一块:六邻全是石头,一个站得住的格都没有
    const cells: Record<string, string> = { '0,63,0': 'stone' };
    for (let x = 2; x <= 4; x++) {
      for (let y = 63; y <= 65; y++) for (let z = -1; z <= 1; z++) cells[`${x},${y},${z}`] = 'stone';
    }
    cells['3,64,0'] = 'nether_bricks';
    const bot = worldBot(cells, { x: 0.5, y: 64, z: 0.5 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'nether_bricks', distance: 16 }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].text).toContain('blockAt=(3, 64, 0)');
    expect(reports[0].text).not.toContain('站得住的是');
  });
});

describe('认不出的物品 id', () => {
  it('点名这个 id 不存在,再点名包里词根相同的那几件', async () => {
    const bot = worldBot({ '0,63,0': 'stone' }, { x: 0.5, y: 64, z: 0.5 }, {
      stock: [{ name: 'salmon', count: 1, type: 1 }, { name: 'cooked_salmon', count: 2, type: 2 }],
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'eat', item: 'raw_salmon' }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].text).toContain('没有 raw_salmon 这样的物品');
    expect(reports[0].text).toContain('salmon(生鲑鱼)');
    expect(reports[0].text).toContain('cooked_salmon(熟鲑鱼)');
  });
});
