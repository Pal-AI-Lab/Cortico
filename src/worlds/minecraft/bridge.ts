/**
 * 管理 Mineflayer 连接、重连和 prismarine-viewer。
 * 重连会替换 bot 实例，World 与执行器须通过 bridge.bot 取得当前实例。
 */
import mineflayer from 'mineflayer';
import pathfinderPkg, { pathfinder, Movements } from 'mineflayer-pathfinder';

// goals 不是 cjs-module-lexer 能静态识别的命名导出,只能从默认导出上取
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import type { Logger } from '../../core/types.ts';
import type { RouteProbe, TargetDiag } from './executor.ts';
import type { MinecraftLog } from './log.ts';
import { installMineflayerFixes, installOffsetShapes, installPathfinderToolSelection } from './mineflayer-fixes.ts';
import {
  installPathfinderPerf, setDigBackoff, setNoPlaceCells, setSiteZones, type SiteZone,
} from './pathfinder-perf.ts';
import { isGravityBlock, isSpawnAnchorBlock } from './policy.ts';
import type { ShowTempo } from './show.ts';
import { pocketScan, standCellsAround } from './terrain.ts';
import { trackWindowProps } from './containers.ts';
import { installTreadWater } from './travel.ts';
import { trackMaps } from './map-view.ts';
import { trackDamageSources } from './damage-source.ts';

interface BridgeOptions {
  host: string;
  port: number;
  username: string;
  version: string;
  /** prismarine-viewer 网页端口;0=不开 viewer */
  viewerPort: number;
  log: Logger;
  /** World 日志;不给就不记(合成与放置的包流走它) */
  diag?: MinecraftLog;
  /** 寻路垫脚方块名单(顺序即优先级,空数组=禁垫);spawn 与风格热改时求值 */
  scaffoldBlocks?: () => string[];
  /** 挖/垫代价系数(mc_policy 的 travel 档位);spawn 与设置热改时求值 */
  movementCosts?: () => { placeCost: number; digCost: number };
  /**
   * 在建的蓝图工地(已绑定锚点、游标未满的那些)。寻路器据此**不在工地体积里垫脚
   * 搭路**,并把工地建材降到垫脚候选末位;走与挖不受限。每次寻路搜索现取。
   */
  blueprintZones?: () => readonly SiteZone[];
  /**
   * 成果登记里的一格(维度已由调用方合上)。寻路器不往登记格自己、也不往它头顶
   * 垫脚搭路,也不把它排进挖掘计划;走不受限。每次候选移动生成时现问。
   */
  workCell?: (x: number, y: number, z: number) => boolean;
  /** 容器 GUI 演出节拍;摄像机没开/演出关着时回 null(craft 用,每次 bot.craft 现取) */
  showTempo?: () => ShowTempo | null;
  /** spawn 完成(含重连后) */
  onSpawn: () => void;
  /** 同一连接内的死亡重生；连接代次和资源保持不变。 */
  onRespawn?: () => void;
  /** 断线后通知；attempt 为本次断线前连续连接失败次数，连接成功归零。 */
  onDisconnect: (reason: string, willReconnect: boolean, attempt: number) => void;
  /** 连接告警通过 World 事件通道投递。 */
  onAlarm?: (text: string) => void;
  /** 停止期间不创建连接或安排重连。 */
  shuttingDown?: () => boolean;
}

const RECONNECT_DELAYS_MS = [3_000, 10_000, 30_000, 60_000];

const DIG_BACKOFF_TRIES = 3;

const DIG_BACKOFF_MS = 60_000;

interface Cell { x: number; y: number; z: number }

const cellKey = (p: Cell): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/** 「暂时挖不动」的一格,连同它进退避的时刻 */
interface DigBackoffCell extends Cell {
  since: number;
}

/** 本机端口连续拒连达到此次数时，提示检查服务器是否已启动。 */
const REFUSED_ALARM_AT = 5;
const REFUSED_ALARM_EVERY = 10;
/** 连续连接被拒绝达到阈值后的重试间隔。 */
const REFUSED_DELAY_MS = 120_000;

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

/** 路线试算的总超时与单次迭代预算；partial 时继续原搜索。 */
const PROBE_TIMEOUT_MS = 400;
const PROBE_TICK_MS = 60;
const PROBE_WALL_MS = 500;

interface ProbePath {
  status: string;
  /** A* closed set 大小;=1 表示只展开了起点 */
  visitedNodes?: number;
  path: Array<{ x: number; y: number; z: number; toBreak?: unknown[]; toPlace?: unknown[] }>;
}

/** 最后一次检测到水后禁用疾跑的物理 tick 数；20 tick 约一秒。 */
const SPRINT_WET_TICKS = 40;

const WATER_BLOCKS = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);

/** 水面附近 isInWater 会逐 tick 变化；检测到水后禁用疾跑 40 tick（约两秒）。 */
function suppressSprintNearWater(bot: mineflayer.Bot, movements: Movements): void {
  let wet = 0;
  // isInWater 由 prismarine-physics 每 tick 写在实体上,prismarine-entity 的类型里没有
  const inWater = (): boolean => Boolean((bot.entity as unknown as { isInWater?: boolean }).isInWater);
  bot.on('physicsTick', () => {
    const feet = bot.blockAt(bot.entity.position);
    const soaked = inWater() || (feet !== null && WATER_BLOCKS.has(feet.name));
    wet = soaked ? SPRINT_WET_TICKS : Math.max(0, wet - 1);
    movements.allowSprinting = wet === 0;
  });
}

/** prismarine-viewer 只用到 mineflayer() 这一个入口 */
interface ViewerModule {
  mineflayer(bot: mineflayer.Bot, opts: { port: number; firstPerson: boolean }): void;
}

/** 上游 viewer.close() 不返回 Promise，关闭后轮询端口是否可绑定，超时记录警告。 */
const VIEWER_RELEASE_MS = 3_000;
const VIEWER_RELEASE_POLL_MS = 50;

/** 端口可绑返回 true(探完即关) */
async function probePort(port: number): Promise<boolean> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 每代连接登记监听端口、外部进程句柄等资源，失效时逆序关闭。
 * dispose 之后收到的注册立即执行 closer，回收异步启动迟到的资源。
 */
class ResourceBag {
  private readonly closers: Array<{ name: string; close: () => Promise<void> | void }> = [];
  private draining: Promise<void> | null = null;
  /** draining 在 dispose 的同步部分完成后赋值；此前由此标记阻止新资源登记。 */
  private closed = false;

  constructor(private readonly log: Logger) {}

  get disposed(): boolean {
    return this.closed;
  }

  register(name: string, close: () => Promise<void> | void): void {
    if (this.closed) {
      void this.run(name, close);
      return;
    }
    this.closers.push({ name, close });
  }

  dispose(): Promise<void> {
    if (this.draining !== null) return this.draining;
    this.closed = true;
    const items = this.closers.splice(0).reverse();
    this.draining = (async () => {
      for (const item of items) await this.run(item.name, item.close);
    })();
    return this.draining;
  }

  private async run(name: string, close: () => Promise<void> | void): Promise<void> {
    try {
      await close();
    } catch (err) {
      this.log.warn(`${name} 关闭失败: ${(err as Error).message}`);
    }
  }
}

export class Bridge {
  private _bot: mineflayer.Bot | null = null;
  private started = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** 每次 connect 递增的连接世代；资源和迟到回调均据此判定归属。 */
  private generation = 0;
  /** 已经作废的最高世代；世代单调作废，一代结束才有下一代。 */
  private disposedThrough = -1;
  private readonly bags = new Map<number, ResourceBag>();
  private readonly disposing = new Set<Promise<void>>();
  private viewer: { gen: number; url: string } | null = null;
  private _invSynced = false;
  private scaffoldComplained = '';
  private refusedStreak = 0;
  private liveMovements: Movements | null = null;

  /**
   * 挖掘失败按格坐标记账；连续失败 DIG_BACKOFF_TRIES 次进入退避，
   * DIG_BACKOFF_MS 后过期。
   */
  private digFails = new Map<string, { tries: number; lastAt: number; since: number | null; cell: Cell }>();

  constructor(private readonly opts: BridgeOptions) {}

  /** 当前连接的 bot;未连接或重连中为 null。 */
  get bot(): mineflayer.Bot | null {
    return this._bot;
  }

  /** 登录后收到窗口 0 的 window_items 才将空物品栏视为真实状态。 */
  get invSynced(): boolean {
    return this._invSynced;
  }

  get connected(): boolean {
    return this._bot !== null && (this._bot as unknown as { entity?: unknown }).entity !== undefined;
  }

  /** 连接生命周期已启用；不要求当前已经完成登录。 */
  get active(): boolean {
    return this.started;
  }

  get reconnects(): number {
    return this.reconnectAttempt;
  }

  get viewerUrl(): string | null {
    return this.viewer !== null && this.viewer.gen === this.generation ? this.viewer.url : null;
  }

  /** 已作废代次使用关闭状态的 ResourceBag，迟到资源登记时立即关闭。 */
  private bagFor(gen: number): ResourceBag {
    const existing = this.bags.get(gen);
    if (existing) return existing;
    const bag = new ResourceBag(this.opts.log);
    this.bags.set(gen, bag);
    if (gen <= this.disposedThrough) void this.disposeGeneration(gen);
    return bag;
  }

  /** 逆序关闭资源；返回值只等待调用时已登记的资源。 */
  private disposeGeneration(gen: number): Promise<void> {
    const bag = this.bags.get(gen);
    this.disposedThrough = Math.max(this.disposedThrough, gen);
    if (!bag) return Promise.resolve();
    this.bags.delete(gen);
    const done = bag.dispose().finally(() => void this.disposing.delete(done));
    this.disposing.add(done);
    return done;
  }

  /** 等所有在途回收落地:端口释放必须排在新一代绑定之前 */
  private async settleDisposals(): Promise<void> {
    while (this.disposing.size > 0) await Promise.allSettled([...this.disposing]);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const bot = this._bot;
    this._bot = null;
    this._invSynced = false;
    this.liveMovements = null;
    this.digFails.clear();
    this.reconnectAttempt = 0;
    this.refusedStreak = 0;
    this.viewer = null;
    if (bot) {
      try {
        bot.quit();
      } catch {
        /* 已断开 */
      }
    }
    this.disposedThrough = Math.max(this.disposedThrough, this.generation);
    for (const gen of [...this.bags.keys()].sort((a, b) => b - a)) {
      await this.disposeGeneration(gen);
    }
    await this.settleDisposals();
  }

  /**
   * 服务器进入 running 时取消退避并立即重连；已连接或正在连接时不操作。
   */
  reconnectNow(reason: string): void {
    if (this.stopped || this._bot !== null) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.refusedStreak = 0;
    this.opts.log.info(`minecraft 立刻重连: ${reason}`);
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.opts.shuttingDown?.()) return;
    const { host, port, username, version, log } = this.opts;
    const gen = ++this.generation;
    for (const old of [...this.bags.keys()]) {
      if (old < gen) void this.disposeGeneration(old);
    }
    this.bagFor(gen);
    log.info(`minecraft 连接 ${host}:${port} as ${username} (${version})`);
    let bot: mineflayer.Bot;
    try {
      bot = mineflayer.createBot({ host, port, username, version, auth: 'offline' });
    } catch (err) {
      log.warn(`createBot 失败: ${(err as Error).message}`);
      this.scheduleReconnect(String((err as Error).message));
      return;
    }
    this._bot = bot;
    this._invSynced = false;
    // 包里地图的整张画面服务端只在登录后第一刻推一次,早于 spawn;挂在 spawn 上就只剩增量
    trackMaps(bot);
    trackDamageSources(bot);
    /** 修补须通过插件注入，等待 Mineflayer 的 inject_allowed。 */
    bot.loadPlugin((b) => installMineflayerFixes(b, log, this.opts.diag, this.opts.showTempo));
    bot.loadPlugin(installOffsetShapes);
    bot.loadPlugin(pathfinder);
    installPathfinderPerf(log);
    (bot._client as unknown as { on(ev: string, cb: (pkt: { windowId: number }) => void): void }).on(
      'window_items',
      (pkt) => {
        if (this._bot === bot && this.generation === gen && pkt.windowId === 0) this._invSynced = true;
      },
    );

    bot.once('spawn', () => {
      if (this.stopped || this._bot !== bot || this.generation !== gen) return;
      this.reconnectAttempt = 0;
      this.refusedStreak = 0;
      this.installSpawnGear(bot, gen);
      this.opts.onSpawn();
      /** spawn 在死亡重生时也触发，连接装配使用 once；持续监听处理同连接重生。 */
      /** respawn 包也用于维度切换，不能单独识别死亡重生。 */
      bot.on('spawn', () => {
        if (this.stopped || this._bot !== bot || this.generation !== gen) return;
        this.opts.onRespawn?.();
      });
    });

    const onGone = (reason: string) => {
      if (this._bot !== bot || this.generation !== gen) return;
      this._bot = null;
      this._invSynced = false;
      this.viewer = null;
      void this.disposeGeneration(gen);
      this.liveMovements = null;
      this.digFails.clear();
      const willReconnect = !this.stopped;
      this.opts.onDisconnect(reason, willReconnect, this.reconnectAttempt);
      if (willReconnect) this.scheduleReconnect(reason);
    };
    bot.once('end', (reason) => onGone(String(reason)));
    bot.once('kicked', (reason) => onGone(`kicked: ${JSON.stringify(reason)}`));
    bot.on('error', (err) => {
      log.warn(`minecraft 连接错误: ${err.message}`);
      this.noteConnectError(err);
    });
  }

  /** 连续 ECONNREFUSED 达到阈值时告警，并延长重连间隔。其他错误重置计数。 */
  private noteConnectError(err: Error): void {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code !== 'ECONNREFUSED' && !err.message.includes('ECONNREFUSED')) {
      this.refusedStreak = 0;
      return;
    }
    this.refusedStreak += 1;
    const n = this.refusedStreak;
    if (n < REFUSED_ALARM_AT || (n - REFUSED_ALARM_AT) % REFUSED_ALARM_EVERY !== 0) return;
    const where = `${this.opts.host}:${this.opts.port}`;
    this.opts.log.error(`minecraft 连续 ${n} 次被 ${where} 拒连:连接被拒绝`);
    this.opts.onAlarm?.(
      isLocalHost(this.opts.host)
        ? `连着 ${n} 次连不上 ${where},端口上根本没有进程在听 —— MC 服务器没在跑,去控制台的 Minecraft 面板把它启动起来;` +
          '在那之前我进不了游戏,做不了任何事。'
        : `连着 ${n} 次连不上 ${where},对面端口没有进程在听 —— 那台服务器没在跑。`,
    );
  }

  /** 一条连接只装一次的那些东西(寻路器、挖掘退避、viewer);死亡重生不重装 */
  private installSpawnGear(bot: mineflayer.Bot, gen: number): void {
    const log = this.opts.log;
    installPathfinderToolSelection(bot, log);
    const movements = new Movements(bot);
    movements.canDig = true;
    movements.allow1by1towers = true;
    this.applyTuning(bot, movements);
    this.liveMovements = movements;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.tickTimeout = 60;
    suppressSprintNearWater(bot, movements);
    installTreadWater(bot);
    trackWindowProps(bot);
    this.installDigBackoff(bot);
    this.installPathDiag(bot);
    this.startViewer(bot, gen);
  }

  /** 把垫脚名单与挖/垫代价装到 movements 上;spawn 与风格热改共用 */
  private applyTuning(bot: mineflayer.Bot, movements: Movements): void {
    const log = this.opts.log;

    /** 寻路单次落差上限 2 格(原版 3 格内摔落不掉血)。 */
    movements.maxDropDown = 2;

    /**
     * 水路代价:游一步记 1 + 3,往水里跳也受 maxDropDown 约束(上游默认不限高)。
     * 在存档 33 西海台周边取直播里真实下过的 107 对起终点只算不走:成功路线上泡水的路点
     * 139 → 99,没有新增算不出的路,多垫 44 块方块;液体代价取 5 与 3 的结果逐条相同。
     */
    // 上游类型声明漏了 liquidCost,运行时字段在 Movements 上
    (movements as unknown as { liquidCost: number }).liquidCost = 3;
    movements.infiniteLiquidDropdownDistance = false;

    /** 上游 lava 的 diggable=true；额外加入 blocksCantBreak 禁止寻路挖掘。 */
    const lava = (bot.registry.blocksByName as Record<string, { id: number } | undefined>).lava;
    if (lava) movements.blocksCantBreak.add(lava.id);

    // 维度切换只由 transit 发起；普通寻路把传送面与门框当作空间边界。
    const portalBlocks = bot.registry.blocksByName as Record<string, { id: number } | undefined>;
    /** 传送门方块的 id;寻路器不在这些格子里、也不在它们头顶垫脚(末地传送门头顶垫一块就把门盖住) */
    const portalIds = new Set<number>();
    for (const name of [
      'nether_portal', 'end_portal', 'end_gateway',
      'obsidian', 'crying_obsidian', 'end_portal_frame',
    ]) {
      const portal = portalBlocks[name];
      if (!portal) continue;
      if (name === 'nether_portal' || name === 'end_portal' || name === 'end_gateway') {
        movements.blocksToAvoid.add(portal.id);
        portalIds.add(portal.id);
      }
      movements.blocksCantBreak.add(portal.id);
    }

    // 寻路不得挖穿容器、工作站及下列功能方块；取出或拆除须走 take/collect。
    // 上游默认保护名单只有 chest，需在此补齐。
    const blocksByName = bot.registry.blocksByName as Record<string, { id: number } | undefined>;
    for (const name of [
      'chest', 'trapped_chest', 'barrel', 'ender_chest',
      'furnace', 'blast_furnace', 'smoker', 'crafting_table',
      'bookshelf', 'enchanting_table', 'cake',
      'brewing_stand', 'lectern', 'smithing_table',
      'anvil', 'chipped_anvil', 'damaged_anvil',
      'beacon', 'cauldron', 'water_cauldron', 'lava_cauldron', 'powder_snow_cauldron',
    ]) {
      const b = blocksByName[name];
      if (b) movements.blocksCantBreak.add(b.id);
    }

    /** 启用开门并禁止挖门；状态通行判据由 pathfinder-perf 的 applyDoorState 提供。 */
    movements.canOpenDoors = true;
    for (const name of Object.keys(blocksByName)) {
      if (!name.endsWith('_door') && !name.endsWith('_fence_gate')) continue;
      const b = blocksByName[name];
      if (b) movements.blocksCantBreak.add(b.id);
    }

    // 床与 respawn_anchor 禁止被寻路挖穿；显式拆除仍走执行器确认路径。
    for (const name of Object.keys(blocksByName)) {
      if (!isSpawnAnchorBlock(name)) continue;
      const b = blocksByName[name];
      if (b) movements.blocksCantBreak.add(b.id);
    }

    const wanted = this.opts.scaffoldBlocks?.();
    if (wanted) {
      /** scafoldingBlocks 使用物品 ID；1.20.6 的物品和方块 ID 不同，须查询 itemsByName。 */
      const byName = bot.registry.itemsByName as Record<string, { id: number } | undefined>;
      // 重力方块失去支撑后会下落，不能作为寻路器按固定落点记账的垫脚料。
      const heavy = wanted.filter((n) => isGravityBlock(n));
      const usable = wanted.filter((n) => !isGravityBlock(n));
      const complaints: string[] = [];
      if (heavy.length > 0) {
        complaints.push(`scaffoldBlocks 里的重力方块不收(垫下去会自己掉,垫不住): ${heavy.join('、')}`);
      }
      const ids = usable.map((n) => byName[n]?.id).filter((id): id is number => id !== undefined);
      const unknown = usable.filter((n) => byName[n] === undefined);
      if (unknown.length > 0) complaints.push(`scaffoldBlocks 里不认识的方块名被忽略: ${unknown.join('、')}`);
      if (ids.length > 0 || wanted.length === 0) {
        movements.scafoldingBlocks = ids;
      } else {
        complaints.push('scaffoldBlocks 全部无效,沿用寻路器默认(泥土、圆石)');
      }
      const key = complaints.join('\n');
      if (key !== this.scaffoldComplained) {
        this.scaffoldComplained = key;
        for (const c of complaints) log.warn(c);
      }
    }
    setSiteZones(movements, this.opts.blueprintZones ?? null);
    // 判据对落点和落点下面那一格各问一次(见 setNoPlaceCells)
    const workCell = this.opts.workCell;
    setNoPlaceCells(movements, (x, y, z) => portalIds.has(bot.blockAt(new Vec3(x, y, z), false)?.type ?? -1)
      || (workCell?.(x, y, z) ?? false));
    // 成果登记格同挖不动的格一样排出寻路的挖掘计划;显式挖掘不经这里
    setDigBackoff(movements, (x, y, z) => this.digBackedOff(x, y, z) || (workCell?.(x, y, z) ?? false));
    const costs = this.opts.movementCosts?.();
    if (costs) {
      movements.placeCost = costs.placeCost;
      movements.digCost = costs.digCost;
    }
  }

  /**
   * 挖掘失败退避的记账口。挂 mineflayer 的挖掘结局事件而不是寻路器的
   * `path_reset('dig_error')`:后者不带坐标,而退避是按格记的。
   */
  private installDigBackoff(bot: mineflayer.Bot): void {
    bot.on('diggingAborted', (block) => this.noteDigFailure(block.position));
    bot.on('diggingCompleted', (block) => {
      this.digFails.delete(cellKey(block.position));
    });
  }

  private noteDigFailure(p: Cell): void {
    const now = Date.now();
    const key = cellKey(p);
    const rec = this.digFails.get(key);
    if (rec === undefined || now - rec.lastAt > DIG_BACKOFF_MS) {
      this.pruneDigFails(now);
      this.digFails.set(key, {
        tries: 1, lastAt: now, since: null,
        cell: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      });
      return;
    }
    rec.tries += 1;
    rec.lastAt = now;
    if (rec.tries < DIG_BACKOFF_TRIES || rec.since !== null) return;
    rec.since = now;
    this.opts.diag?.write({
      lane: 'path', event: 'dig-backoff',
      msg: `(${rec.cell.x}, ${rec.cell.y}, ${rec.cell.z}) 连挖 ${rec.tries} 次没挖动,`
        + `${DIG_BACKOFF_MS / 1000} 秒内寻路绕开`,
      data: { cell: rec.cell, tries: rec.tries, ms: DIG_BACKOFF_MS },
    });
  }

  private pruneDigFails(now: number): void {
    for (const [key, rec] of this.digFails) {
      if (now - rec.lastAt > DIG_BACKOFF_MS) this.digFails.delete(key);
    }
  }

  /** 这一格此刻挖不动(寻路器据此不把它排进 toBreak) */
  private digBackedOff(x: number, y: number, z: number): boolean {
    if (this.digFails.size === 0) return false;
    const key = cellKey({ x, y, z });
    const rec = this.digFails.get(key);
    if (rec?.since == null) return false;
    if (Date.now() - rec.since <= DIG_BACKOFF_MS) return true;
    this.digFails.delete(key);
    return false;
  }

  /** `ts` 之后进退避的格子。goto 受阻回执据此说清「哪一格挖不动、绕开了」 */
  digBackoffSince(ts: number): DigBackoffCell[] {
    const now = Date.now();
    const out: DigBackoffCell[] = [];
    for (const rec of this.digFails.values()) {
      if (rec.since === null || rec.since < ts || now - rec.since > DIG_BACKOFF_MS) continue;
      out.push({ ...rec.cell, since: rec.since });
    }
    return out.sort((a, b) => a.since - b.since);
  }

  /** 移动风格热改:把新名单/代价装回当前 movements 并触发重算 */
  retune(): void {
    const bot = this._bot;
    if (!bot || !this.liveMovements || !(bot as { pathfinder?: unknown }).pathfinder) return;
    this.applyTuning(bot, this.liveMovements);
    bot.pathfinder.setMovements(this.liveMovements);
  }

  /** getPathFromTo 生成器用于路线试算，避免 getPathTo 覆盖当前寻路的 A* 上下文。 */
  probeRoutes(
    target: { x: number; y: number; z: number },
    /** 试算与执行须使用同一目标。省略时使用以 target 为中心、半径 1 的 GoalNear；水平寻路显式传入 GoalNearXZ。 */
    goal: InstanceType<typeof goals.Goal> = new goals.GoalNear(target.x, target.y, target.z, 1),
  ): RouteProbe[] | null {
    const bot = this._bot;
    if (!bot?.entity || typeof bot.pathfinder?.getPathFromTo !== 'function') return null;
    const me = bot.entity.position;
    const startDist = Math.hypot(me.x - target.x, me.y - target.y, me.z - target.z);
    const out: RouteProbe[] = [];
    for (const profile of ['style', 'dig', 'walk'] as const) {
      const m = new Movements(bot);
      m.canDig = profile !== 'walk';
      m.allow1by1towers = profile === 'style';
      this.applyTuning(bot, m);
      if (profile !== 'style') m.scafoldingBlocks = [];
      let result: ProbePath | null = null;
      try {
        const gen = bot.pathfinder.getPathFromTo(m, me, goal, {
          timeout: PROBE_TIMEOUT_MS, tickTimeout: PROBE_TICK_MS,
        });
        const deadline = Date.now() + PROBE_WALL_MS;
        for (const step of gen) {
          result = (step?.result ?? null) as ProbePath | null;
          if (!result || result.status !== 'partial' || Date.now() > deadline) break;
        }
      } catch (err) {
        this.opts.log.warn(`路线试算失败(${profile}): ${(err as Error).message}`);
      }
      if (!result) {
        out.push({ profile, status: 'noPath', steps: 0, place: 0, breaks: 0, endDist: startDist });
        continue;
      }
      const path = result.path ?? [];
      const last = path[path.length - 1];
      const endDist = last
        ? Math.hypot(last.x - target.x, last.y - target.y, last.z - target.z)
        : startDist;
      let place = 0;
      let breaks = 0;
      for (const mv of path) {
        place += mv.toPlace?.length ?? 0;
        breaks += mv.toBreak?.length ?? 0;
      }
      const status = result.status === 'success' ? 'complete'
        : result.status === 'partial' || result.status === 'timeout' || result.status === 'noPath'
          ? result.status as RouteProbe['status']
          : 'noPath';
      out.push({
        profile, status, steps: path.length, place, breaks,
        endDist: Math.round(endDist * 10) / 10,
        ...(typeof result.visitedNodes === 'number' ? { visited: result.visitedNodes } : {}),
      });
    }
    return out;
  }

  /** 检查目标附近落脚格与最多 128 格的空间连通性；未加载区域不作封闭结论。 */
  probeTarget(target: { x: number; y: number; z: number }): TargetDiag | null {
    const bot = this._bot;
    if (!bot?.entity) return null;
    const read = (x: number, y: number, z: number) => {
      const b = bot.blockAt(new Vec3(x, y, z));
      return b ? { name: b.name, solid: b.boundingBox === 'block' } : null;
    };
    const t = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) };
    const stand = standCellsAround(read, t);
    if (stand.length === 0) return { kind: 'noStand' };
    const size = pocketScan(read, stand);
    return size === null ? { kind: 'open' } : { kind: 'sealed', size };
  }

  /** 每类寻路记录使用独立的五秒窗口；期间重复项计数，下一次输出附抑制数量。 */
  private installPathDiag(bot: mineflayer.Bot): void {
    const diag = this.opts.diag;
    if (!diag) return;
    const RESET_ZH: Record<string, string> = {
      goal_updated: '目标更换', movements_updated: '移动规则更新', block_updated: '方块变化',
      chunk_loaded: '区块加载', goal_moved: '目标移动', dig_error: '挖掘失败',
      no_scaffolding_blocks: '没有搭路方块', place_error: '放置失败', stuck: '卡住',
    };
    // 抑制计数与时间窗按 key 独立记录；key 来自 RESET_ZH、update、goal、reached 的有限集合。
    const suppressed = new Map<string, number>();
    const lastAt = new Map<string, number>();
    const write = (key: string, event: string, msg: string, data?: Record<string, unknown>): void => {
      const now = Date.now();
      if (now - (lastAt.get(key) ?? 0) < 5_000) {
        suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
        return;
      }
      const n = suppressed.get(key) ?? 0;
      const tail = n > 0 ? `(此前 ${n} 条同类未记)` : '';
      diag.write({ lane: 'path', event, msg: msg + tail, data });
      suppressed.set(key, 0);
      lastAt.set(key, now);
    };
    bot.on('path_update', (r) => {
      write(`update:${r.status}`, 'update',
        `寻路 ${r.status}:${r.path.length} 步,搜了 ${r.visitedNodes} 节点/${Math.round(r.time)}ms`,
        { status: r.status, pathLen: r.path.length, visitedNodes: r.visitedNodes, timeMs: Math.round(r.time) });
    });
    bot.on('path_reset', (reason) => {
      write(`reset:${reason}`, 'reset', `寻路重置:${RESET_ZH[reason] ?? reason}`, { reason });
    });
    bot.on('goal_updated', (goal, dynamic) => {
      write(`goal:${goal ? 'set' : 'clear'}`, 'goal',
        goal ? `新寻路目标${dynamic ? '(动态)' : ''}:${goal.constructor?.name ?? 'Goal'}` : '寻路目标已撤销');
    });
    bot.on('goal_reached', () => {
      write('reached', 'reached', '寻路到达目标');
    });
  }

  /** 按需动态加载 viewer。 */
  private loadViewer(): Promise<ViewerModule> {
    return import('prismarine-viewer') as unknown as Promise<ViewerModule>;
  }

  private startViewer(bot: mineflayer.Bot, gen: number): void {
    if (this.opts.viewerPort <= 0 || this.viewerUrl !== null) return;
    const port = this.opts.viewerPort;
    /** 上游 viewer 不暴露 http server 的 error 处理接口，启动前先探测端口；探测与绑定之间仍有竞争窗口。 */
    void (async () => {
      try {
        await this.settleDisposals();
        const free = await probePort(port);
        if (!free) {
          this.opts.log.warn(
            `viewer 端口 ${port} 已被占用,本次不开画面(worlds.minecraft.viewerPort 可改)`,
          );
          return;
        }
        const mod = await this.loadViewer();
        if (this.stopped || this._bot !== bot || this.generation !== gen || this.bagFor(gen).disposed) return;
        mod.mineflayer(bot, { port, firstPerson: true });
        // 取得句柄后必须同步注册到资源袋，中间不能 await，以免 stop 时漏收。
        const close = (bot as unknown as { viewer?: { close?: () => void } }).viewer?.close;
        this.bagFor(gen).register('prismarine-viewer', () => this.releaseViewer(gen, port, close));
        if (this.stopped || this.generation !== gen) return; // 旧代不得改新代状态
        this.viewer = { gen, url: `http://127.0.0.1:${port}` };
        this.opts.log.info(`prismarine-viewer 已启动 http://127.0.0.1:${port}`);
      } catch (err) {
        this.opts.log.warn(`prismarine-viewer 启动失败(不影响游玩): ${(err as Error).message}`);
      }
    })();
  }

  /** viewer.close() 不返回 Promise，关闭后通过端口绑定探测确认释放。 */
  private async releaseViewer(gen: number, port: number, close?: () => void): Promise<void> {
    if (this.viewer?.gen === gen) this.viewer = null;
    if (!close) {
      this.opts.log.warn(`viewer 没有暴露 close,端口 ${port} 无法主动释放`);
      return;
    }
    close();
    const deadline = Date.now() + VIEWER_RELEASE_MS;
    for (;;) {
      if (await probePort(port)) return;
      if (Date.now() >= deadline) {
        this.opts.log.warn(`viewer 已关闭,端口 ${port} 在 ${VIEWER_RELEASE_MS / 1000}s 内仍不可绑定`);
        return;
      }
      await sleep(VIEWER_RELEASE_POLL_MS);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.opts.shuttingDown?.() || this.reconnectTimer) return;
    const delay = this.refusedStreak >= REFUSED_ALARM_AT
      ? REFUSED_DELAY_MS
      : RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    this.opts.log.info(`minecraft ${delay / 1000}s 后重连(第 ${this.reconnectAttempt} 次): ${reason}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
