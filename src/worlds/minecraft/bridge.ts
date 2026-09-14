/**
 * mineflayer 连接管理:建 bot、断线重连、prismarine-viewer 拉起。
 *
 * World 与执行器只能使用当前连接的 bot;重连会替换实例,持有方必须通过
 * `bridge.bot` 解析引用。断线转为事件与重连,不外溢异常。
 */
import mineflayer from 'mineflayer';
import pathfinderPkg, { pathfinder, Movements } from 'mineflayer-pathfinder';

// goals 不是 cjs-module-lexer 能静态识别的命名导出,只能从默认导出上取
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import type { Logger } from '../../core/types.ts';
import type { RouteProbe, TargetDiag } from './executor.ts';
import type { MinecraftLog } from './log.ts';
import { installMineflayerFixes, installPathfinderToolSelection } from './mineflayer-fixes.ts';
import {
  installPathfinderPerf, setDigBackoff, setNoPlaceCells, setSiteZones, type SiteZone,
} from './pathfinder-perf.ts';
import { isGravityBlock, isSpawnAnchorBlock } from './policy.ts';
import type { ShowTempo } from './show.ts';
import { pocketScan, standCellsAround } from './terrain.ts';

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
   * 垫脚搭路;走与挖不受限。每次候选移动生成时现问。
   */
  workCell?: (x: number, y: number, z: number) => boolean;
  /** 容器 GUI 演出节拍;摄像机没开/演出关着时回 null(craft 用,每次 bot.craft 现取) */
  showTempo?: () => ShowTempo | null;
  /** spawn 完成(含重连后) */
  onSpawn: () => void;
  /**
   * 同一条连接里死亡之后重生。**不是**新连接:连接代次不变、这一代的资源袋照旧,
   * 只通知上层"身体换了一期"。
   */
  onRespawn?: () => void;
  /**
   * 断线(kicked/end),已安排重连。`attempt` = 在这之前已经连不上几次
   * (连上一次归零):0 是刚掉线,>0 是重连又没成——播报文案据此分档。
   */
  onDisconnect: (reason: string, willReconnect: boolean, attempt: number) => void;
  /** 明确告警(服务器没在跑那一类):接 World 的事件通道,不走断线播报 */
  onAlarm?: (text: string) => void;
  /** 收摊期不新建连接、不安排重连；未提供时视为非收摊期。 */
  shuttingDown?: () => boolean;
}

const RECONNECT_DELAYS_MS = [3_000, 10_000, 30_000, 60_000];

/** 同一格连挖这么多次没挖动就退避;计数只算连续失败,挖成一次即清零 */
const DIG_BACKOFF_TRIES = 3;

/**
 * 退避时效。挖不动的原因多半会变(基岩不会,但屏障、别人正在放的方块、
 * 够不着的角度都会),所以是时效不是永久名单。
 */
const DIG_BACKOFF_MS = 60_000;

interface Cell { x: number; y: number; z: number }

const cellKey = (p: Cell): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/** 「暂时挖不动」的一格,连同它进退避的时刻 */
interface DigBackoffCell extends Cell {
  since: number;
}

/** 本机端口连续拒连达到此次数时，提示检查服务器是否已启动。 */
const REFUSED_ALARM_AT = 5;
/** 越过阈值之后每再拒连这么多次复述一遍告警,免得只在第 5 次说一句就没了下文 */
const REFUSED_ALARM_EVERY = 10;
/** 已经确认"服务器没在跑"之后的重连间隔:再密也没用,留给人去启动 */
const REFUSED_DELAY_MS = 120_000;

/** 本机地址:告警只对自己托管的服务器说「去面板启动」 */
function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

/**
 * 单份路线试算的思考预算:timeout 是 A* 的总思考上限,tick 是每次迭代的片段。
 * 生成器在 partial 时继续同一场搜索,迭代到有结论或预算耗尽——一发弱扫描的
 * partial 会把"没算完"误当"没有路"。
 */
const PROBE_TIMEOUT_MS = 400;
const PROBE_TICK_MS = 60;
const PROBE_WALL_MS = 500;

/** 试算只读这几个面(ComputedPath 的平面形状) */
interface ProbePath {
  status: string;
  /** A* closed set 大小;=1 表示只展开了起点 */
  visitedNodes?: number;
  path: Array<{ x: number; y: number; z: number; toBreak?: unknown[]; toPlace?: unknown[] }>;
}

/** 最后一次读到"沾水"之后再压制多少个物理 tick 的疾跑(20 tick = 1s) */
const SPRINT_WET_TICKS = 40;

const WATER_BLOCKS = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);

/**
 * 水面附近的 `isInWater` 会逐 tick 抖动；检测到水后禁用疾跑 40 tick 形成滞回。
 * 离水一秒后恢复疾跑，陆地移动不受影响。
 */
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

/**
 * viewer 关闭之后等端口真正让出的上限。上游的 close 不返回 Promise,端口何时让出
 * 只能自己探;探不到就记一条 warn 走人,不无限等。
 */
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
  /** 单独一个标志:draining 要等 dispose 的同步前缀跑完才赋上,那段窗口里也得算已关闭 */
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
  /** 在途的资源回收;新一代绑端口前先等它们落地 */
  private readonly disposing = new Set<Promise<void>>();
  /** 当前 viewer 属于哪一代;viewerUrl 是它的派生量,不再另存布尔标志 */
  private viewer: { gen: number; url: string } | null = null;
  private _invSynced = false;
  /** scaffoldBlocks 配置的上一轮告警全文;retune 高频跑,同样的抱怨只说一次 */
  private scaffoldComplained = '';
  /** 连续被本机端口拒连了几次;连上一次归零 */
  private refusedStreak = 0;
  /** 当前连接的 movements;风格热改(retune)在它身上就地生效 */
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

  /** 连上一次就归零。控制台据此把"正在重连"与"反复连不上"分开报。 */
  get reconnects(): number {
    return this.reconnectAttempt;
  }

  get viewerUrl(): string | null {
    return this.viewer !== null && this.viewer.gen === this.generation ? this.viewer.url : null;
  }

  /**
   * 这一代的资源袋。袋子不存在就现建;世代已经作废的,袋子生下来就是关闭态,
   * 于是迟到的注册会被就地关掉(见 ResourceBag 的注释)。
   */
  private bagFor(gen: number): ResourceBag {
    const existing = this.bags.get(gen);
    if (existing) return existing;
    const bag = new ResourceBag(this.opts.log);
    this.bags.set(gen, bag);
    if (gen <= this.disposedThrough) void this.disposeGeneration(gen);
    return bag;
  }

  /** 这一代作废:资源逆序关掉。返回的 Promise 只覆盖发起时已在袋里的那些 */
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
    // viewer 不随 bot 的 'end' 自行关闭(上游没有那条接线),端口只能在这里让出。
    // 这个 await 覆盖的是发起时已经在袋里的资源;此刻还没拿到句柄的异步启动流程
    // 回来时会撞上已 dispose 的袋子,就地自关,那一份不在本次等待范围内。
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
    // 端口上已经有人听了:拒连连击归零,这一次万一没连上也从短退避重来
    this.refusedStreak = 0;
    this.opts.log.info(`minecraft 立刻重连: ${reason}`);
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.opts.shuttingDown?.()) return;
    const { host, port, username, version, log } = this.opts;
    const gen = ++this.generation;
    // 上一代的资源不许跨代活着:viewer 的 http server 还在监听时,这一代的端口
    // 探测撞的就是自己的旧 server
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
    // 必须当插件装:mineflayer 自己的插件要等 inject_allowed 才注入,在这里直接改
    // bot.craft 改的是个还不存在的方法,随后会被内建的 craft.js 原样覆盖掉
    bot.loadPlugin((b) => installMineflayerFixes(b, log, this.opts.diag, this.opts.showTempo));
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
      // mineflayer 的 'spawn' 不只发一次:血量由 0 回正时(health.js)会再发一次,
      // 那正是同一条连接里的死亡重生。装配走 once,重生通知走这条持续监听 ——
      // 在 once 回调里注册不会被本次 emit 收到(EventEmitter 在 emit 前已取好监听表)。
      // 不用 'respawn' 事件:它跟着 respawn 包走,换维度也发,与死亡重生分不开。
      bot.on('spawn', () => {
        if (this.stopped || this._bot !== bot || this.generation !== gen) return;
        this.opts.onRespawn?.();
      });
    });

    const onGone = (reason: string) => {
      if (this._bot !== bot || this.generation !== gen) return; // 迟到回调不得改状态
      this._bot = null;
      this._invSynced = false;
      this.viewer = null;
      // 重连前必须先把端口让出来,否则下一代的探测必然报「已被占用」
      void this.disposeGeneration(gen);
      this.liveMovements = null;
      // 退避账跟着这条连接走:重连之后世界可能已经变了,旧的挖不动不作数
      this.digFails.clear();
      const willReconnect = !this.stopped;
      this.opts.onDisconnect(reason, willReconnect, this.reconnectAttempt);
      if (willReconnect) this.scheduleReconnect(reason);
    };
    bot.once('end', (reason) => onGone(String(reason)));
    bot.once('kicked', (reason) => onGone(`kicked: ${JSON.stringify(reason)}`));
    bot.on('error', (err) => {
      // 连接期错误跟着 'end' 走重连,不外溢;拒连要单独数——它与"网络抖动"不是一回事
      log.warn(`minecraft 连接错误: ${err.message}`);
      this.noteConnectError(err);
    });
  }

  /**
   * 拒连计数与告警。ECONNREFUSED = 那个端口上没有进程在听,重连再密也不会变。
   * 数到阈值推一条明确告警(去面板把服务器启动起来),并把重连拉稀。
   */
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
    this.opts.log.error(`minecraft 连续 ${n} 次被 ${where} 拒连:服务器进程多半没在跑`);
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
    // A* 每物理 tick 的同步计算预算。canDig 下单节点成本高(邻居都要算挖掘
    // 耗时),20ms 只够搜约 50 节点,挖掘型路径在"搜三步-挖一块-方块变化重置"
    // 里永远算不完整。mc 已在独立子进程,不再影响演出注入。
    bot.pathfinder.tickTimeout = 60;
    suppressSprintNearWater(bot, movements);
    this.installDigBackoff(bot);
    this.installPathDiag(bot);
    this.startViewer(bot, gen);
  }

  /** 把垫脚名单与挖/垫代价装到 movements 上;spawn 与风格热改共用 */
  private applyTuning(bot: mineflayer.Bot, movements: Movements): void {
    const log = this.opts.log;

    // 一次落差只允许下降一格。默认值会把三格坠落当普通步伐，路径执行稍有偏差
    // 就会越过落脚面；连续寻路还能沿悬崖逐级把人带到远低于出发点的位置。
    movements.maxDropDown = 2;

    // 岩浆在上游是"可挖方块":diggable=true、boundingBox=empty,只被 blocksToAvoid
    // 挡住 safe。今天不被挖穿全靠 dontCreateFlow 撞见液体邻居——可孤立的一格岩浆
    // 五面都不是液体,那道检查一条都不命中,A* 会照样把它排进 toBreak 走过去。
    // 钉进 blocksCantBreak 才是照实说"这一格不是能挖开走过去的东西"。
    const lava = (bot.registry.blocksByName as Record<string, { id: number } | undefined>).lava;
    if (lava) movements.blocksCantBreak.add(lava.id);

    // 维度切换只由 transit 发起；普通寻路把传送面与门框当作空间边界。
    const portalBlocks = bot.registry.blocksByName as Record<string, { id: number } | undefined>;
    for (const name of [
      'nether_portal', 'end_portal', 'end_gateway',
      'obsidian', 'crying_obsidian', 'end_portal_frame',
    ]) {
      const portal = portalBlocks[name];
      if (!portal) continue;
      if (name === 'nether_portal' || name === 'end_portal' || name === 'end_gateway') {
        movements.blocksToAvoid.add(portal.id);
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

    // 门:开着的门今天照样过不去,而且会被当墙挖掉。
    //
    // 上游把 boundingBox 当作方块类型的属性,门无论开着关着都是 `block` —— 于是
    // 开着的门在寻路器眼里与石墙无异(safe=false),路线要么绕开,要么把门挖了;
    // `canOpenDoors` 又默认关着,而且它的 openable 名单只收栅栏门,不收门。
    // 逐状态的判词在 pathfinder-perf(applyDoorState):开着的可穿过、关着的木门
    // 「用一下再过去」、铁门当墙。这里只做两件事:把那条开门开关打开,
    // 并把门钉进不许挖的名单 —— 门是别人家的建筑,而且现在根本不需要挖它。
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
      // 寻路器把 scafoldingBlocks 当物品 id 用(与背包 item.type 比对),
      // 1.20.6 里方块与物品 id 空间不同(圆石 方块12/物品35),必须走 itemsByName
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
        // 顺序即优先级:寻路器垫脚时从数组头开始找包里有的;空数组 = 禁垫
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
    // 回调本身装上去(不是当下的取数):工地在两次 retune 之间照样会绑定、完工
    setSiteZones(movements, this.opts.blueprintZones ?? null);
    setNoPlaceCells(movements, this.opts.workCell ?? null);
    // 试算的三份 movements 一并装上:菜单上的三种走法要与实际会走的路同一套判据
    setDigBackoff(movements, (x, y, z) => this.digBackedOff(x, y, z));
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
    // 上一次失败已经过了时效:那是另一轮,重新计数(判据是「连续」)
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

  /**
   * 三份代价配置各试算一条路(当前风格/只挖不垫/只靠走),不动身、不打扰在飞寻路。
   * 走 getPathFromTo 生成器:getPathTo 会覆写寻路器内部的 astar 上下文。
   */
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

  /**
   * 目标点分诊(探路误诊断的另一半):A* 对"目标本身进不去"只会 timeout,
   * 10 格外的树冠会被说成"太远或太绕"。落脚预检 O(27) + 死角灌水 ≤128 格读数,
   * 给试算菜单一句定性;区块未加载时不下结论。
   */
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

  /**
   * 寻路进展进 path 泳道。partial 循环重算是"原地抽搐"的典型形态,
   * 每种记录各有一个 5 秒窗口,窗口内只计数,窗口外落一条并带上本类的抑制计数。
   */
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

  /**
   * viewer 模块的加载口。单独一个方法是为了测试能换成不依赖 three/canvas 的假模块;
   * 生产始终走这里的动态 import(viewer 依赖较重,不开画面的部署不加载它)。
   */
  private loadViewer(): Promise<ViewerModule> {
    return import('prismarine-viewer') as unknown as Promise<ViewerModule>;
  }

  private startViewer(bot: mineflayer.Bot, gen: number): void {
    if (this.opts.viewerPort <= 0 || this.viewerUrl !== null) return;
    const port = this.opts.viewerPort;
    // viewer 内部的 http server 不暴露 error 事件(上游没挂,句柄也不外露),端口被占
    // 会直接崩进程——先自己探一次。探测与真正 bind 之间隔着 import,严格说仍是 TOCTOU;
    // 真正让它不发生的是"绑之前旧代资源已经关干净",探测只是最后一道机械保险。
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

  /**
   * 关掉一代的 viewer 并等端口真正让出。上游的 `bot.viewer.close` 只做 http.close()
   * 加逐 socket disconnect,不返回 Promise、也不关 socket.io,所以"关完了没有"这件事
   * 只有端口本身能回答。
   */
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
    // 已经确认端口上没进程在听:密集重连只是刷屏,拉长到两分钟一次等人去启动
    const delay = this.refusedStreak >= REFUSED_ALARM_AT
      ? REFUSED_DELAY_MS
      : RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    this.opts.log.info(`minecraft ${delay / 1000}s 后重连(第 ${this.reconnectAttempt} 次): ${reason}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
