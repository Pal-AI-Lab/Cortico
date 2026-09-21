/**
 * 垫脚名单落在物品 id 空间。寻路器把 scafoldingBlocks 与背包 item.type 比对,
 * 用方块 id 会让垫脚材料恒为 0,塔跳与搭桥动作在 A* 里根本不生成。
 */
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import mineflayer from 'mineflayer';
import pathfinderPkg, { Movements } from 'mineflayer-pathfinder';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import Move from 'mineflayer-pathfinder/lib/move.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../../../src/worlds/minecraft/bridge.ts';
import { installPathfinderPerf, type SiteZone } from '../../../src/worlds/minecraft/pathfinder-perf.ts';
import { MinecraftLog } from '../../../src/worlds/minecraft/log.ts';
import { nullLogger } from '../../../src/core/util.ts';

// 禁垫区判在补丁装上的 getNeighbors 里;bridge 真跑时由 connect() 装
installPathfinderPerf();

const { goals } = pathfinderPkg as unknown as { goals: { GoalNear: new (...a: number[]) => unknown } };

const req = createRequire(createRequire(import.meta.url).resolve('mineflayer/package.json'));
const registry = req('prismarine-registry')('1.20.6');
const World = req('prismarine-world')(registry);
const Chunk = req('prismarine-chunk')(registry);
const { Vec3 } = req('vec3');

const STONE = registry.blocksByName.stone.defaultState as number;
const AIR = registry.blocksByName.air.defaultState as number;
const WATER = registry.blocksByName.water.defaultState as number;
const COBBLE_ITEM = registry.itemsByName.cobblestone.id as number;

/** 石头封到 y=63,以上全是空气:只有塔跳能上升,走/挖都够不着头顶目标 */
function makeWorld() {
  const world = new World(null).sync;
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  }
  for (let x = -8; x < 16; x++) {
    for (let z = -8; z < 16; z++) {
      for (let y = 56; y <= 63; y++) world.setBlockStateId(new Vec3(x, y, z), STONE);
    }
  }
  return world;
}

function makeBot(world: unknown) {
  const items = [
    { type: registry.itemsByName.wooden_pickaxe.id as number, count: 1, name: 'wooden_pickaxe', nbt: null, metadata: 0 },
    { type: COBBLE_ITEM, count: 500, name: 'cobblestone', nbt: null, metadata: 0 },
  ];
  const bot: Record<string, unknown> = {
    registry,
    version: '1.20.6',
    world,
    blockAt: (p: unknown) => (world as { getBlock(p: unknown): unknown }).getBlock(p),
    inventory: { items: () => items },
    entity: { position: new Vec3(0.5, 64, 0.5), effects: {}, height: 1.8 },
    entities: {} as Record<string, unknown>,
    game: { minY: -64, height: 384 },
  };
  bot.pathfinder = {
    bestHarvestTool: () => items[0],
  };
  return bot;
}

function makeBridge(scaffold: string[], warns: string[], zones?: SiteZone[]): Bridge {
  return new Bridge({
    host: 'localhost', port: 25565, username: 'tester', version: '1.20.6', viewerPort: 0,
    log: { ...nullLogger(), warn: (msg: string) => void warns.push(msg) },
    scaffoldBlocks: () => scaffold,
    ...(zones ? { blueprintZones: () => zones } : {}),
    onSpawn: () => {},
    onDisconnect: () => {},
  });
}

/** applyTuning 是 spawn / upkeep 热改 / 路线试算共用的唯一装配点 */
function tune(bridge: Bridge, bot: unknown, movements: Movements): void {
  (bridge as unknown as { applyTuning(b: unknown, m: Movements): void }).applyTuning(bot, movements);
}

/** 从脚下往正上方 6 格找路;起点的 remainingBlocks 与寻路器 getPathTo 同源 */
function searchUp(bot: unknown, movements: Movements): { status: string; place: number } {
  (movements as unknown as { clearCollisionIndex(): void }).clearCollisionIndex();
  (movements as unknown as { updateCollisionIndex(): void }).updateCollisionIndex();
  const remaining = (movements as unknown as { countScaffoldingItems(): number }).countScaffoldingItems();
  const start = new (Move as never as new (...a: unknown[]) => unknown)(0, 64, 0, remaining, 0);
  const astar = new (AStar as never as new (...a: unknown[]) => {
    compute(): { status: string; path: Array<{ toPlace?: unknown[] }> };
  })(start, movements, new goals.GoalNear(0, 70, 0, 1), 5_000, 60, -1);
  let res = astar.compute();
  while (res.status === 'partial') res = astar.compute();
  const place = res.path.reduce((s, mv) => s + (mv.toPlace?.length ?? 0), 0);
  return { status: res.status, place };
}

describe('bridge 垫脚名单', () => {
  it('1.20.6 里圆石的方块 id 与物品 id 不同(错配的前提)', () => {
    expect(registry.blocksByName.cobblestone.id).not.toBe(COBBLE_ITEM);
  });

  it('名单转成物品 id,背包里的圆石才数得到,A* 才生成塔跳', () => {
    const warns: string[] = [];
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    tune(makeBridge(['cobblestone'], warns), bot, m);

    expect(m.scafoldingBlocks).toEqual([COBBLE_ITEM]);
    expect((m as unknown as { countScaffoldingItems(): number }).countScaffoldingItems()).toBe(500);
    expect(warns).toEqual([]);

    const up = searchUp(bot, m);
    expect(up.status).toBe('success');
    expect(up.place).toBe(5); // 目标半径 1,垫到 y=69 就够
  });

  // 工地是 applyTuning 装上去的第三样东西(名单、代价、工地),spawn / 热改 / 试算共用
  it('在建工地的体积里不生成垫脚:同一条往上的路,圈起来就没了', () => {
    const warns: string[] = [];
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    tune(makeBridge(['cobblestone'], warns, [{
      key: 'home', min: [-64, 0, -64], max: [64, 320, 64], materials: ['cobblestone'],
    }]), bot, m);

    expect(m.scafoldingBlocks).toEqual([COBBLE_ITEM]); // 名单本身不动,禁的只是落点
    const up = searchUp(bot, m);
    expect(up.place).toBe(0); // 包里 500 块圆石,一块都没排进路线
    expect(up.status).not.toBe('success');
  });

  it('空数组=禁垫:名单清空,头顶目标就没路了', () => {
    const warns: string[] = [];
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    tune(makeBridge([], warns), bot, m);

    expect(m.scafoldingBlocks).toEqual([]);
    expect(warns).toEqual([]);
    expect(searchUp(bot, m).status).toBe('noPath');
  });

  it('不认识的名字被忽略并告警,认得的那些照常生效', () => {
    const warns: string[] = [];
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    tune(makeBridge(['cobblestone', 'unobtainium'], warns), bot, m);

    expect(m.scafoldingBlocks).toEqual([COBBLE_ITEM]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('unobtainium');
  });

  // 岩浆 diggable=true、boundingBox=empty,上游只靠 blocksToAvoid 让它 safe=false。
  // 不被挖穿全指望 dontCreateFlow 撞见液体邻居——孤立的一格岩浆五面都不是液体,
  // 那道检查一条都不命中,A* 会照样把它排进 toBreak 走过去。
  it('岩浆钉进 blocksCantBreak:孤立的一格岩浆也不许被排进挖掘计划', () => {
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    const lavaId = registry.blocksByName.lava.id as number;
    // safeToBreak 是 A* 唯一的挖掘许可口;(3,60,3) 四周全是石头,液体邻查一条都不命中
    const lava = { type: lavaId, position: new Vec3(3, 60, 3) };
    const canBreak = () => (m as unknown as { safeToBreak(b: unknown): boolean }).safeToBreak(lava);
    expect(m.blocksCantBreak.has(lavaId)).toBe(false);
    expect(canBreak()).toBe(true); // 上游放行——这就是要堵的口子

    tune(makeBridge(['cobblestone'], []), bot, m);
    expect(m.blocksCantBreak.has(lavaId)).toBe(true);
    expect(canBreak()).toBe(false);
  });

  it('名单全无效时沿用寻路器默认名单', () => {
    const warns: string[] = [];
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    const fallback = [...m.scafoldingBlocks];
    tune(makeBridge(['unobtainium'], warns), bot, m);

    expect(m.scafoldingBlocks).toEqual(fallback);
    expect(warns).toHaveLength(2);
  });

  // 重力方块失去支撑后下落，不能作为寻路器认为已稳定放置的垫脚格。
  it('重力方块入不了垫脚名单,并说明为什么', () => {
    const warns: string[] = [];
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    tune(makeBridge(['sand', 'cobblestone', 'red_concrete_powder', 'gravel'], warns), bot, m);

    expect(m.scafoldingBlocks).toEqual([COBBLE_ITEM]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('重力方块');
    for (const n of ['sand', 'red_concrete_powder', 'gravel']) expect(warns[0]).toContain(n);
  });
});

describe('bridge 落差边界', () => {
  it('真实寻路器不再生成三格坠落动作', () => {
    const world = makeWorld();
    // 起点北侧挖成三格落差：默认 maxDropDown=4 会把脚位 y64→61 排成一步。
    for (const y of [61, 62, 63]) world.setBlockStateId(new Vec3(0, y, -1), AIR);
    const bot = makeBot(world);
    const m = new Movements(bot as never);
    const node = new (Move as never as new (...a: number[]) => {
      x: number; y: number; z: number; remainingBlocks: number;
    })(0, 64, 0, 500, 0);
    const drops = (): Array<{ y: number }> => {
      const out: Array<{ y: number }> = [];
      (m as unknown as {
        getMoveDropDown(n: unknown, dir: { x: number; z: number }, neighbors: Array<{ y: number }>): void;
      }).getMoveDropDown(node, { x: 0, z: -1 }, out);
      return out;
    };

    expect(drops().map((n) => n.y)).toEqual([61]);
    tune(makeBridge(['cobblestone'], []), bot, m);
    expect(m.maxDropDown).toBe(2);
    expect(drops()).toEqual([]);
  });

  it('深水表面可以游上一格岸,不把水下那格当起跳面', () => {
    const world = makeWorld();
    world.setBlockStateId(new Vec3(0, 63, 0), WATER);
    world.setBlockStateId(new Vec3(0, 64, 0), WATER);
    world.setBlockStateId(new Vec3(1, 64, 0), STONE);
    const bot = makeBot(world);
    const m = new Movements(bot as never);
    const node = new (Move as never as new (...a: number[]) => unknown)(0, 64, 0, 500, 0);
    const neighbors: Array<{ x: number; y: number; z: number }> = [];
    (m as unknown as {
      getMoveJumpUp(n: unknown, dir: { x: number; z: number }, out: Array<{ x: number; y: number; z: number }>): void;
    }).getMoveJumpUp(node, { x: 1, z: 0 }, neighbors);
    expect(neighbors).toContainEqual(expect.objectContaining({ x: 1, y: 65, z: 0 }));
  });
});

/**
 * bridge 禁止寻路间接挖穿床与重生锚；显式拆除仍走执行器的确认路径。
 */
describe('bridge 重生锚不可破坏', () => {
  it('16 色床与重生锚全进 blocksCantBreak,赶路不许挖穿', () => {
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    const beds = Object.keys(registry.blocksByName).filter((n) => /(^|_)bed$/.test(n));
    expect(beds.length).toBeGreaterThanOrEqual(16);

    for (const n of beds) expect(m.blocksCantBreak.has(registry.blocksByName[n].id)).toBe(false);
    tune(makeBridge(['cobblestone'], []), bot, m);
    for (const n of [...beds, 'respawn_anchor']) {
      expect(m.blocksCantBreak.has(registry.blocksByName[n].id)).toBe(true);
    }
  });

  it('safeToBreak 是 A* 唯一的挖掘许可口:床进名单之后它直接说不', () => {
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    const bed = { type: registry.blocksByName.white_bed.id as number, position: new Vec3(3, 64, 3) };
    const canBreak = (): boolean => (m as unknown as { safeToBreak(b: unknown): boolean }).safeToBreak(bed);
    expect(canBreak()).toBe(true); // 上游放行——这就是要堵的口子
    tune(makeBridge(['cobblestone'], []), bot, m);
    expect(canBreak()).toBe(false);
  });
});

/**
 * 功能方块不能被寻路器作为普通障碍挖穿。
 */
describe('bridge 功能方块不许赶路挖穿', () => {
  const FUNCTIONAL = [
    'chest', 'trapped_chest', 'barrel', 'ender_chest',
    'furnace', 'blast_furnace', 'smoker', 'crafting_table',
    'bookshelf', 'enchanting_table', 'cake',
    'brewing_stand', 'lectern', 'smithing_table',
    'anvil', 'chipped_anvil', 'damaged_anvil',
    'beacon', 'cauldron', 'water_cauldron',
  ];

  it('容器、工作站与摆出来就有用的那些全进 blocksCantBreak', () => {
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    // 上游默认只保护 chest 一种:书架、蛋糕、附魔台原样放行,这就是要堵的口子
    expect(m.blocksCantBreak.has(registry.blocksByName.bookshelf.id as number)).toBe(false);

    tune(makeBridge(['cobblestone'], []), bot, m);
    for (const name of FUNCTIONAL) {
      const id = registry.blocksByName[name]?.id as number | undefined;
      if (id === undefined) continue; // 版本里没有这一样就跳过,枚举不因缺项报错
      expect(m.blocksCantBreak.has(id), `${name} 应在 blocksCantBreak`).toBe(true);
    }
  });

  it('safeToBreak 对书架直接说不:A* 唯一的挖掘许可口', () => {
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    const shelf = { type: registry.blocksByName.bookshelf.id as number, position: new Vec3(3, 64, 3) };
    const canBreak = (): boolean => (m as unknown as { safeToBreak(b: unknown): boolean }).safeToBreak(shelf);
    expect(canBreak()).toBe(true);
    tune(makeBridge(['cobblestone'], []), bot, m);
    expect(canBreak()).toBe(false);
  });
});

describe('bridge 传送门边界', () => {
  it('普通寻路避开所有传送面,并且不把门体或门框排进挖掘计划', () => {
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    tune(makeBridge(['cobblestone'], []), bot, m);

    for (const name of ['nether_portal', 'end_portal', 'end_gateway']) {
      const id = registry.blocksByName[name].id as number;
      expect(m.blocksToAvoid.has(id), `${name} 应在 blocksToAvoid`).toBe(true);
      expect(m.blocksCantBreak.has(id), `${name} 应在 blocksCantBreak`).toBe(true);
    }
    for (const name of ['obsidian', 'crying_obsidian', 'end_portal_frame']) {
      const id = registry.blocksByName[name].id as number;
      expect(m.blocksCantBreak.has(id), `${name} 应在 blocksCantBreak`).toBe(true);
    }
  });

  it('黑曜石进入 A* 的不可挖名单后 safeToBreak 直接拒绝', () => {
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    const obsidian = {
      type: registry.blocksByName.obsidian.id as number,
      position: new Vec3(3, 64, 3),
    };
    const canBreak = (): boolean =>
      (m as unknown as { safeToBreak(b: unknown): boolean }).safeToBreak(obsidian);
    expect(canBreak()).toBe(true);
    tune(makeBridge(['cobblestone'], []), bot, m);
    expect(canBreak()).toBe(false);
  });
});

/**
 * ECONNREFUSED 的回执须说明连接被拒绝，并指出检查服务器是否启动。
 */
describe('bridge 断连告警', () => {
  const refused = (): Error =>
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:25565'), { code: 'ECONNREFUSED' });

  function alarmBridge(host: string, alarms: string[]): Bridge {
    return new Bridge({
      host, port: 25565, username: 'tester', version: '1.20.6', viewerPort: 0,
      log: nullLogger(),
      onSpawn: () => {},
      onDisconnect: () => {},
      onAlarm: (text) => void alarms.push(text),
    });
  }

  const note = (b: Bridge, err: Error): void =>
    (b as unknown as { noteConnectError(e: Error): void }).noteConnectError(err);

  it('连续 5 次拒连才推告警,措辞点名「服务器没在跑」和该去哪儿启动', () => {
    const alarms: string[] = [];
    const bridge = alarmBridge('127.0.0.1', alarms);
    for (let i = 0; i < 4; i++) note(bridge, refused());
    expect(alarms).toEqual([]);
    note(bridge, refused());
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toContain('MC 服务器没在跑');
    expect(alarms[0]).toContain('面板');
    // 阈值之后不再每次都喊,隔 10 次复述一遍
    for (let i = 0; i < 9; i++) note(bridge, refused());
    expect(alarms).toHaveLength(1);
    note(bridge, refused());
    expect(alarms).toHaveLength(2);
  });

  it('别的连接错误不算拒连:连击断了就归零', () => {
    const alarms: string[] = [];
    const bridge = alarmBridge('127.0.0.1', alarms);
    for (let i = 0; i < 4; i++) note(bridge, refused());
    note(bridge, new Error('read ECONNRESET'));
    for (let i = 0; i < 4; i++) note(bridge, refused());
    expect(alarms).toEqual([]);
  });

  it('远端服务器连接被拒绝时不提示使用本地面板', () => {
    const alarms: string[] = [];
    const bridge = alarmBridge('mc.example.com', alarms);
    for (let i = 0; i < 5; i++) note(bridge, refused());
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).not.toContain('面板');
    expect(alarms[0]).toContain('没在跑');
  });

  it('连续连接被拒绝后，重连间隔延长到两分钟', () => {
    const alarms: string[] = [];
    const bridge = alarmBridge('127.0.0.1', alarms);
    const delays: number[] = [];
    const timers = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(((_fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as never);
    const schedule = (): void => {
      (bridge as unknown as { reconnectTimer: unknown }).reconnectTimer = null;
      (bridge as unknown as { scheduleReconnect(r: string): void }).scheduleReconnect('测试');
    };
    schedule();
    expect(delays[0]).toBe(3_000);
    for (let i = 0; i < 5; i++) note(bridge, refused());
    schedule();
    expect(delays[1]).toBe(120_000);
    timers.mockRestore();
  });

  /**
   * 收摊期不新建连接、不排重连，避免服务器先退出后留下重连定时器。
   */
  it('收摊期不排重连也不新建连接:服务器先退时的 ECONNREFUSED 不是故障', () => {
    let shutting = false;
    const bridge = new Bridge({
      host: '127.0.0.1', port: 25565, username: 'tester', version: '1.20.6', viewerPort: 0,
      log: nullLogger(),
      onSpawn: () => {},
      onDisconnect: () => {},
      shuttingDown: () => shutting,
    });
    const inner = bridge as unknown as {
      scheduleReconnect(reason: string): void;
      reconnectTimer: unknown;
    };
    inner.scheduleReconnect('连接被拒');
    expect(inner.reconnectTimer).not.toBeNull();

    clearTimeout(inner.reconnectTimer as ReturnType<typeof setTimeout>);
    inner.reconnectTimer = null;
    shutting = true;
    inner.scheduleReconnect('连接被拒');
    expect(inner.reconnectTimer).toBeNull();
  });

  it('stop 清掉重连计时器，长期关闭不连接；重新 start 只发起一次连接', async () => {
    vi.useFakeTimers();
    try {
      const bridge = alarmBridge('127.0.0.1', []);
      const inner = bridge as unknown as {
        _bot: { quit(): void } | null;
        connect(): void;
        scheduleReconnect(reason: string): void;
        reconnectTimer: unknown;
        _invSynced: boolean;
        liveMovements: unknown;
        digFails: Map<string, unknown>;
      };
      const attempts: string[] = [];
      let quits = 0;
      inner.connect = () => void attempts.push('connect');
      inner.scheduleReconnect('测试');
      inner._bot = { quit: () => { quits += 1; } };
      inner._invSynced = true;
      inner.liveMovements = {};
      inner.digFails.set('1,2,3', {});

      await bridge.stop();
      expect(inner.reconnectTimer).toBeNull();
      expect(quits).toBe(1);
      expect(inner._invSynced).toBe(false);
      expect(inner.liveMovements).toBeNull();
      expect(inner.digFails.size).toBe(0);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(attempts).toEqual([]);

      bridge.start();
      bridge.start();
      expect(bridge.active).toBe(true);
      expect(attempts).toEqual(['connect']);
      await bridge.stop();
    } finally {
      vi.useRealTimers();
    }
  });


  it('立刻重连掐掉当前退避,到点的那一次不再来', () => {
    vi.useFakeTimers();
    const bridge = alarmBridge('127.0.0.1', []);
    const inner = bridge as unknown as {
      connect(): void;
      scheduleReconnect(reason: string): void;
      reconnectTimer: unknown;
      refusedStreak: number;
    };
    const attempts: string[] = [];
    inner.connect = () => void attempts.push('connect');
    for (let i = 0; i < 5; i++) note(bridge, refused());
    inner.scheduleReconnect('测试');
    expect(attempts).toEqual([]);
    bridge.reconnectNow('服务器就绪');
    expect(attempts).toEqual(['connect']);
    expect(inner.reconnectTimer).toBeNull();
    // 端口上已经有人听了:拒连连击归零,下一次失败从短退避重来
    expect(inner.refusedStreak).toBe(0);
    vi.advanceTimersByTime(300_000);
    expect(attempts).toEqual(['connect']);
    vi.useRealTimers();
  });

  it('已经连上时不重连', () => {
    const bridge = alarmBridge('127.0.0.1', []);
    const inner = bridge as unknown as { connect(): void; _bot: unknown };
    const attempts: string[] = [];
    inner.connect = () => void attempts.push('connect');
    inner._bot = {};
    bridge.reconnectNow('服务器就绪');
    expect(attempts).toEqual([]);
  });
});

/**
 * 寻路日志的抑制计数按 key 分开，补报数量须归属同一种原因。
 */
describe('bridge 寻路日志抑制', () => {
  function diagBridge(): { bridge: Bridge; diag: MinecraftLog; bot: EventEmitter } {
    const diag = new MinecraftLog();
    const bridge = new Bridge({
      host: 'localhost', port: 25565, username: 'tester', version: '1.20.6', viewerPort: 0,
      log: nullLogger(),
      diag,
      onSpawn: () => {},
      onDisconnect: () => {},
    });
    const bot = new EventEmitter();
    (bridge as unknown as { installPathDiag(b: unknown): void }).installPathDiag(bot);
    return { bridge, diag, bot };
  }

  const resets = (diag: MinecraftLog): string[] =>
    diag.after(0).filter((e) => e.event === 'reset').map((e) => e.msg);

  it('交替两种原因:各按各的 5 秒窗口压住,尾巴的计数归各自那一类', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const { diag, bot } = diagBridge();

    for (let i = 0; i < 10; i++) {
      bot.emit('path_reset', 'stuck');
      bot.emit('path_reset', 'dig_error');
    }
    // 每种原因各只落一条。
    expect(resets(diag)).toEqual(['寻路重置:卡住', '寻路重置:挖掘失败']);

    vi.setSystemTime(new Date(1_700_000_006_000));
    bot.emit('path_reset', 'stuck');
    bot.emit('path_reset', 'dig_error');
    expect(resets(diag).slice(2)).toEqual([
      '寻路重置:卡住(此前 9 条同类未记)',
      '寻路重置:挖掘失败(此前 9 条同类未记)',
    ]);
    vi.useRealTimers();
  });

  it('单一原因连写:窗口内只出一条、窗口外补上计数', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const { diag, bot } = diagBridge();

    for (let i = 0; i < 10; i++) bot.emit('path_reset', 'stuck');
    expect(resets(diag)).toEqual(['寻路重置:卡住']);

    vi.setSystemTime(new Date(1_700_000_006_000));
    bot.emit('path_reset', 'stuck');
    expect(resets(diag)).toEqual(['寻路重置:卡住', '寻路重置:卡住(此前 9 条同类未记)']);

    // 计数清零:下一个窗口不许把上一个窗口的账再报一遍
    vi.setSystemTime(new Date(1_700_000_012_000));
    bot.emit('path_reset', 'stuck');
    expect(resets(diag)[2]).toBe('寻路重置:卡住');
    vi.useRealTimers();
  });

  it('不同泳道事件各自计账:reset 的抑制不吃掉 goal 的第一条', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const { diag, bot } = diagBridge();

    bot.emit('path_reset', 'stuck');
    bot.emit('path_reset', 'stuck');
    bot.emit('goal_reached');
    expect(diag.after(0).map((e) => e.event)).toEqual(['reset', 'reached']);
    vi.useRealTimers();
  });

});

/**
 * 连续挖掘失败的格暂不进入 toBreak，让 A* 绕行；退避到期后恢复。
 */
describe('bridge 挖掘失败退避', () => {
  function digBridge(): { bridge: Bridge; diag: MinecraftLog; bot: EventEmitter } {
    const diag = new MinecraftLog();
    const bridge = new Bridge({
      host: 'localhost', port: 25565, username: 'tester', version: '1.20.6', viewerPort: 0,
      log: nullLogger(),
      diag,
      onSpawn: () => {},
      onDisconnect: () => {},
    });
    const bot = new EventEmitter();
    (bridge as unknown as { installDigBackoff(b: unknown): void }).installDigBackoff(bot);
    return { bridge, diag, bot };
  }

  /** 真 Movements 上的挖掘许可口:A* 认不认这一格全看它 */
  function breakProbe(bridge: Bridge): () => boolean {
    const bot = makeBot(makeWorld());
    const m = new Movements(bot as never);
    tune(bridge, bot, m);
    const stone = { type: registry.blocksByName.stone.id as number, position: new Vec3(3, 60, 3) };
    return () => (m as unknown as { safeToBreak(b: unknown): boolean }).safeToBreak(stone);
  }

  const at = (bot: EventEmitter, ev: string) => bot.emit(ev, { position: new Vec3(3, 60, 3) });

  it('同一格连挖 3 次没挖动才退避,寻路器随即不再把它排进挖掘计划', () => {
    const { bridge, bot, diag } = digBridge();
    const canBreak = breakProbe(bridge);
    expect(canBreak()).toBe(true);

    at(bot, 'diggingAborted');
    at(bot, 'diggingAborted');
    expect(canBreak()).toBe(true); // 两次还谈不上「连续挖不动」
    at(bot, 'diggingAborted');
    expect(canBreak()).toBe(false);
    expect(bridge.digBackoffSince(0)).toEqual([
      { x: 3, y: 60, z: 3, since: expect.any(Number) },
    ]);
    expect(diag.after(0).find((e) => e.event === 'dig-backoff')!.msg)
      .toContain('(3, 60, 3) 连挖 3 次没挖动');
  });

  it('中间挖成过一次:连续计数清零,不进退避', () => {
    const { bridge, bot } = digBridge();
    const canBreak = breakProbe(bridge);
    at(bot, 'diggingAborted');
    at(bot, 'diggingAborted');
    at(bot, 'diggingCompleted');
    at(bot, 'diggingAborted');
    at(bot, 'diggingAborted');
    expect(canBreak()).toBe(true);
    expect(bridge.digBackoffSince(0)).toEqual([]);
  });

  it('退避带时效:过了 60 秒同一格自己恢复可挖', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const { bridge, bot } = digBridge();
    const canBreak = breakProbe(bridge);
    at(bot, 'diggingAborted');
    at(bot, 'diggingAborted');
    at(bot, 'diggingAborted');
    expect(canBreak()).toBe(false);
    vi.setSystemTime(new Date(1_700_000_061_000));
    expect(canBreak()).toBe(true);
    expect(bridge.digBackoffSince(0)).toEqual([]);
    vi.useRealTimers();
  });

  it('digBackoffSince 只回这一趟新进的:上一趟退避的那格不再复述', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const { bridge, bot } = digBridge();
    at(bot, 'diggingAborted');
    at(bot, 'diggingAborted');
    at(bot, 'diggingAborted');
    expect(bridge.digBackoffSince(1_700_000_000_000)).toHaveLength(1);
    expect(bridge.digBackoffSince(1_700_000_000_001)).toEqual([]);
    vi.useRealTimers();
  });
});

/**
 * viewer 的 close 通过 bot.viewer 暴露，不随 bot.end 自动执行；断连须释放其 HTTP 与 socket.io 监听。
 * 夹具使用真实 HTTP 和 socket.io，并复现上游 close 语义；以端口能否重新绑定验证释放。
 */
describe('bridge viewer 端口生命周期', () => {
  /**
   * 这一条加载真模块,下面的用例用假模块只测端口生命周期。`lib/mineflayer.js` 经
   * `viewer/index.js` → `viewer/lib/viewer.js` → `viewer/lib/entities.js` 顶层 require canvas,
   * 上游只把 canvas 列进自己的 devDependencies,所以它由本仓库声明。
   */
  it('viewer 模块装得起来', async () => {
    const mod = (await import('prismarine-viewer')) as { default: { mineflayer: unknown } };
    expect(typeof mod.default.mineflayer).toBe('function');
  });

  const viewerReq = createRequire(createRequire(import.meta.url).resolve('prismarine-viewer/package.json'));
  const { Server: IOServer } = viewerReq('socket.io') as {
    Server: new (srv: unknown, opts: unknown) => {
      on(ev: string, cb: (s: { disconnect(): void }) => void): void;
      close(): void;
    };
  };
  const ioClient = viewerReq('socket.io-client') as {
    io(url: string, opts: unknown): { on(ev: string, cb: () => void): void; close(): void };
  };

  interface Inner {
    generation?: number;
    _bot: unknown;
    loadViewer(): Promise<unknown>;
    startViewer(bot: unknown, gen?: number): void;
  }
  const inner = (b: Bridge): Inner => b as unknown as Inner;

  const bridges: Bridge[] = [];
  const cleanups: Array<() => void> = [];
  let createBotSpy: { mockRestore(): void };

  /** 端口现在能绑上就是 true;判据与 bridge 自己的 probePort 同形 */
  const probeFree = (port: number): Promise<boolean> => new Promise((resolve) => {
    const srv = createNetServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });

  /** 现取一个空闲端口:写死端口号会跟真机的 7794 抢 */
  async function freePort(): Promise<number> {
    const srv = createNetServer();
    await new Promise<void>((r) => srv.listen(0, () => r()));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    return port;
  }

  async function until(cond: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await cond()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * 假 viewer 模块。http/socket.io 都是真的,`bot.viewer.close` 的两行照抄上游:
   * 只 `http.close()` + 逐 socket disconnect,不返回 Promise、不关 socket.io。
   */
  function fakeViewerWorld(hooks: { onBind?: () => void } = {}): unknown {
    return {
      mineflayer(bot: Record<string, unknown>, { port }: { port: number }) {
        const http: HttpServer = createHttpServer((_q, s) => {
          s.writeHead(200, { 'content-type': 'text/plain' });
          s.end('viewer');
        });
        const worlds = new IOServer(http, { path: '/socket.io' });
        const sockets: Array<{ disconnect(): void }> = [];
        worlds.on('connection', (s) => void sockets.push(s));
        http.listen(port);
        cleanups.push(() => {
          try {
            http.close();
            worlds.close();
            for (const s of sockets) s.disconnect();
          } catch { /* 已经关了 */ }
        });
        bot.viewer = {
          close: () => {
            http.close();
            for (const s of sockets) s.disconnect();
          },
        };
        hooks.onBind?.();
      },
    };
  }

  /** connect() 能跑通所需的最小 bot 面:插件装载、包流、生命周期事件 */
  function connectFakeBot(): EventEmitter & Record<string, unknown> {
    const bot = new EventEmitter() as EventEmitter & Record<string, unknown>;
    bot._client = new EventEmitter();
    bot.loadPlugin = () => {};
    bot.quit = () => {};
    return bot;
  }

  function viewerBridge(viewerPort: number, warns: string[] = []): Bridge {
    const bridge = new Bridge({
      host: '127.0.0.1', port: 25565, username: 'tester', version: '1.20.6', viewerPort,
      log: { ...nullLogger(), warn: (msg: string) => void warns.push(msg) },
      onSpawn: () => {},
      onDisconnect: () => {},
    });
    bridges.push(bridge);
    return bridge;
  }

  const botOf = (b: Bridge): EventEmitter & Record<string, unknown> =>
    inner(b)._bot as EventEmitter & Record<string, unknown>;

  /** spawn 里那一步:换掉模块加载口,再按当前世代拉起 viewer */
  function launchViewer(bridge: Bridge, mod: unknown): void {
    const i = inner(bridge);
    i.loadViewer = () => Promise.resolve(mod);
    i.startViewer(botOf(bridge), i.generation ?? 0);
  }

  beforeEach(() => {
    // connect() 走真代码(onGone 闭包与世代都在里面),只把 createBot 换成假 bot
    createBotSpy = vi.spyOn(mineflayer, 'createBot')
      .mockImplementation(() => connectFakeBot() as never);
  });

  afterEach(async () => {
    for (const b of bridges.splice(0)) await b.stop().catch(() => {});
    for (const c of cleanups.splice(0)) c();
    createBotSpy.mockRestore();
  });

  it('断线之后 viewer 端口必须让出:否则下一代的探测撞的是自己的旧 server', async () => {
    const port = await freePort();
    const bridge = viewerBridge(port);
    bridge.start();
    launchViewer(bridge, fakeViewerWorld());
    expect(await until(() => bridge.viewerUrl !== null)).toBe(true);
    expect(bridge.viewerUrl).toBe(`http://127.0.0.1:${port}`);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    expect(await probeFree(port)).toBe(false); // 前提:server 确实占着端口

    botOf(bridge).emit('end', '测试断线');
    expect(bridge.viewerUrl).toBeNull();
    expect(await until(() => probeFree(port))).toBe(true);
    await bridge.stop();
  });

  it('OBS 那样连着 socket.io 的时候断线,端口一样让出', async () => {
    const port = await freePort();
    const bridge = viewerBridge(port);
    bridge.start();
    launchViewer(bridge, fakeViewerWorld());
    expect(await until(() => bridge.viewerUrl !== null)).toBe(true);

    const client = ioClient.io(`http://127.0.0.1:${port}`, {
      path: '/socket.io', transports: ['websocket'],
    });
    cleanups.push(() => client.close());
    await new Promise<void>((r) => client.on('connect', () => r()));

    botOf(bridge).emit('end', '测试断线');
    expect(await until(() => probeFree(port))).toBe(true);
    await bridge.stop();
  });

  it('stop 返回时端口已经让出,重开的那一代能重新拿到画面', async () => {
    const port = await freePort();
    const warns: string[] = [];
    const bridge = viewerBridge(port, warns);
    bridge.start();
    launchViewer(bridge, fakeViewerWorld());
    expect(await until(() => bridge.viewerUrl !== null)).toBe(true);

    await bridge.stop();
    // stop 的完成语义:发起时已在袋里的资源都关完了才 resolve
    expect(await probeFree(port)).toBe(true);
    expect(bridge.viewerUrl).toBeNull();

    bridge.start();
    launchViewer(bridge, fakeViewerWorld());
    expect(await until(() => bridge.viewerUrl !== null)).toBe(true);
    expect(bridge.viewerUrl).toBe(`http://127.0.0.1:${port}`);
    expect(warns.filter((w) => w.includes('已被占用'))).toEqual([]);
    await bridge.stop();
  });

  /**
   * 端口已绑定而句柄尚未注册时 stop，旧代资源袋已 dispose。
   * 启动流程随后注册的 viewer 须就地关闭；该关闭发生在 stop resolve 之后，不能回写旧代状态。
   */
  it('端口绑好之后才 stop:迟到注册的 viewer 就地关闭,旧代也不回写状态', async () => {
    const port = await freePort();
    const bridge = viewerBridge(port);
    bridge.start();
    const box: { stopping: Promise<void> | null } = { stopping: null };
    launchViewer(bridge, fakeViewerWorld({
      onBind: () => { box.stopping = bridge.stop(); },
    }));

    expect(await until(() => box.stopping !== null)).toBe(true);
    await box.stopping;
    expect(bridge.viewerUrl).toBeNull(); // 旧代不许把 viewer 状态写回去
    expect(await until(() => probeFree(port))).toBe(true);
  });

  it('stop 之后才回来的启动流程不再绑端口', async () => {
    const port = await freePort();
    const bridge = viewerBridge(port);
    bridge.start();
    let release: (() => void) | null = null;
    const parked = new Promise<void>((r) => { release = r; });
    const i = inner(bridge);
    const mod = fakeViewerWorld();
    i.loadViewer = async () => { await parked; return mod; };
    i.startViewer(botOf(bridge), i.generation ?? 0);

    await bridge.stop();
    release!();
    await parked;
    // 让被卡住的那条流程跑完
    expect(await until(() => false, 100)).toBe(false);
    expect(bridge.viewerUrl).toBeNull();
    expect(await probeFree(port)).toBe(true);
  });
});

/**
 * mineflayer 在同一连接内死亡重生时会再次发 spawn；连接代次不变，仍须通知以解除 BodyLease 的失效状态。
 */
describe('bridge 死亡重生通知', () => {
  interface Inner {
    generation: number;
    _bot: unknown;
    installSpawnGear(bot: unknown, gen: number): void;
  }
  const inner = (b: Bridge): Inner => b as unknown as Inner;

  let createBotSpy: { mockRestore(): void };
  const bridges: Bridge[] = [];

  beforeEach(() => {
    createBotSpy = vi.spyOn(mineflayer, 'createBot').mockImplementation(() => {
      const bot = new EventEmitter() as EventEmitter & Record<string, unknown>;
      bot._client = new EventEmitter();
      bot.loadPlugin = () => {};
      bot.quit = () => {};
      return bot as never;
    });
  });

  afterEach(async () => {
    for (const b of bridges.splice(0)) await b.stop().catch(() => {});
    createBotSpy.mockRestore();
  });

  function rig(): { bridge: Bridge; events: string[]; bot: EventEmitter } {
    const events: string[] = [];
    const bridge = new Bridge({
      host: '127.0.0.1', port: 25565, username: 'tester', version: '1.20.6', viewerPort: 0,
      log: nullLogger(),
      onSpawn: () => events.push('spawn'),
      onRespawn: () => events.push('respawn'),
      onDisconnect: () => {},
    });
    bridges.push(bridge);
    // 假 bot 装不了寻路器;一次性装配与本用例无关,只留生命周期通知这条线
    inner(bridge).installSpawnGear = () => {};
    bridge.start();
    return { bridge, events, bot: inner(bridge)._bot as EventEmitter };
  }

  it('第二次及以后的 spawn 走 onRespawn,首次仍只走 onSpawn', () => {
    const { bridge, events, bot } = rig();
    const gen = inner(bridge).generation;
    bot.emit('spawn');
    expect(events).toEqual(['spawn']);
    bot.emit('spawn');
    bot.emit('spawn');
    expect(events).toEqual(['spawn', 'respawn', 'respawn']);
    // 重生不是新连接:代次不动,这一代的资源袋也不回收
    expect(inner(bridge).generation).toBe(gen);
    expect(bridge.viewerUrl).toBeNull();
  });

  it('断线之后旧 bot 迟到的 spawn 不再通知', async () => {
    const { bridge, events, bot } = rig();
    bot.emit('spawn');
    bot.emit('end', '测试断线');
    await bridge.stop();
    bot.emit('spawn');
    expect(events).toEqual(['spawn']);
  });
});
