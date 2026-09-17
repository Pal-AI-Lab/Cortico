/**
 * 技能执行的共享面:执行上下文、两种终态异常,以及 World 交给技能的只读取用口。
 *
 * 这里只有契约,没有技能逻辑:除 pathfinder 的目标类型外一律只取类型。
 * 执行器与各技能族都依赖它,它反过来不依赖两者中的任何一个。
 */
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Logger } from '../../core/types.ts';
import type { ChestBook } from './chests.ts';
import type { WorksBook } from './works.ts';
import type { MinecraftLog } from './log.ts';
import type { Direction } from './terrain.ts';
import type { SkillCall } from './skills.ts';
import type { PolicyDefaults, PolicySettings } from './policy.ts';
import type { NormalizedBlueprint, PositionXYZ } from './blueprint.ts';
import type { BlueprintPlan, ItemTally } from './blueprint-plan.ts';
import type { BowShotResult, RangedTarget } from './ranged.ts';
import type { ShowTempo } from './show.ts';
import type { FindObservationCache, SearchScope } from './search-observation.ts';

const { goals } = pathfinderPkg;

/** 一份代价配置下的试算结果:寻路器自己就是地形扫描器 */
export interface RouteProbe {
  profile: 'style' | 'dig' | 'walk';
  status: 'complete' | 'partial' | 'noPath' | 'timeout';
  steps: number;
  /** 要垫的方块数 */
  place: number;
  /** 要挖的方块数 */
  breaks: number;
  /** 这条路(或部分路)尽头离目标还有几格 */
  endDist: number;
  /**
   * A* closed set 大小；未运行试算时为 undefined。
   * 1 表示只展开起点，没有生成可行邻居。
   */
  visited?: number;
}

/**
 * 目标点分诊:A* 对"目标本身进不去"只会以 timeout 收场,10 格外的树冠会被
 * 说成"太远或太绕"。落脚预检与死角灌水(world.ts 纯函数)给出定性结论。
 */
export type TargetDiag =
  | { kind: 'open' }
  | { kind: 'noStand' }
  | { kind: 'sealed'; size: number };

/** 技能受阻是业务终态；scene 携带受阻时的坐标、可见性与试算事实，随回执返回。 */
export class SkillBlocked extends Error {
  readonly scene: string[];
  /**
   * 受阻来源：server 表示操作后的回读或服务端结果，local 表示本地前置判断。
   * 仅写入 World 诊断日志。
   */
  readonly source: 'server' | 'local';
  constructor(message: string, scene: string[] = [], source: 'server' | 'local' = 'local') {
    super(message);
    this.scene = scene;
    this.source = source;
  }
}

/**
 * 条件不成立且没有可作用对象时的无操作终态，不计失败。
 * 继承 SkillBlocked 以共用捕获路径，需要区分终态的调用方再单独判断。
 */
export class SkillNoop extends SkillBlocked {}

/**
 * 一张已装载的蓝图,连同它在**这个世界**里的施工绑定。
 * 设计跨世界(她画的图不属于某个存档),锚点与游标只在这个世界里算数。
 */
export interface BlueprintSite {
  key: string;
  name: string | null;
  blueprint: NormalizedBlueprint;
  plan: BlueprintPlan;
  /** 蓝图 [0,0,0] 落在世界的哪一格;这个世界里还没开工时 null */
  anchor: PositionXYZ | null;
  /** 已完成的 IR 步数(从头连着那些) */
  cursor: number;
  /** 改造模式的最近一次初探；没有或新建模式为 null。 */
  survey?: BlueprintSurvey | null;
  /** null 表示只完成了初探，尚未动工；旧施工面可省略。 */
  startedAt?: number | null;
}

export interface BlueprintSurvey {
  at: number;
  matched: number;
  missing: number;
  unknown: number;
  wrongBlock: number;
  shouldBeAir: number;
  samples: string[];
}

/**
 * 蓝图施工面。装载表与缓存归 World 持有(world.ts 的 BlueprintBook),执行器只经
 * 这个口取用 —— 与 `spawnAnchor` 同一种接法:World 是唯一写入口,技能只读,
 * 外加一个纯机械的游标回写(进度变化**不是**语义写,不触发任何过夜提醒)。
 */
export interface BlueprintDesk {
  get(key: string): BlueprintSite | null;
  keys(): string[];
  /** 采集搭车认的那一张:被目标点名的,或者一共就装载了一张;说不清时 null */
  activeKey(): string | null;
  /** 首次开工登记锚点(realm 域) */
  bind(key: string, anchor: PositionXYZ): void;
  /** 改造模式的初探结果与锚点。 */
  survey(key: string, anchor: PositionXYZ, result: BlueprintSurvey): void;
  /** 进度游标回写 */
  progress(key: string, cursor: number): void;
  /** 三分账单的「在箱」一栏(容器账本合计;口径是「上次看见」) */
  stored(): ItemTally;
}

/**
 * 路标取用面(World 持有 mc_map 那张表;执行器只读)。
 *
 * 它只喂**回执侧的机械计算**:把一个裸坐标相对化成她认得的地方,把"这一单的目标
 * 落进了她自己圈的危险区"当场陈述一句。两件事都不改变任何执行 —— 走不走、盖不盖
 * 是她的权衡,系统只出事实(PWSR 主客观纪律)。
 */
export interface MarkDesk {
  /** 「离「新家」82 格」;`approx` 用于上界估算(「约 130 格」)。没有近处路标时 null */
  near(pos: { x: number; y: number; z: number }, approx?: boolean): string | null;
  /** 离这一点最近的那处路标本体:同一处路标的两个距离要对得起来时用它 */
  nearest(pos: { x: number; y: number; z: number }): { name: string; x: number; y: number; z: number } | null;
  /** 这一格落进的、**她自己标的**危险区名字;没有则空数组 */
  danger(pos: { x: number; y: number; z: number }): string[];
  /** `radius` 格以内那几处路标的名字与登记时刻;没有则空数组 */
  around(pos: { x: number; y: number; z: number }, radius: number): Array<{ name: string; at: number }>;
}

/**
 * 危险区那一句。**措辞铁律(PWSR 主客观纪律):** 参照系永远归她 ——
 * 「你标记的危险区」是事实,「这里危险」「建议绕开」是系统在替她判断。
 * 只陈述,不拦不劝:圈是她画的,她比系统更清楚圈里为什么危险、这一趟值不值。
 */
export function dangerNoteText(names: readonly string[], what: string): string | null {
  if (names.length === 0) return null;
  return `${what}落在你标记的危险区${names.map((n) => `「${n}」`).join('、')}里`;
}

export type ResourcePlacementPermit =
  | { ok: true; finish(placed: boolean): void }
  | { ok: false; reason: string };

export type ResourcePlacementGate = (item: string) => ResourcePlacementPermit;

/** 试算用的只读判据:不占串行闸、不扣账,因此也没有 finish */
export type ResourcePlacementPreview = (item: string) => { ok: boolean; reason?: string };

export interface SkillContext {
  aborted: () => boolean;
  /** 谁把这一步打飞的(战斗/反射/mc_stop/顶替);没被打飞时 null */
  abortedBy?: () => string | null;
  log: Logger;
  /** 战斗中生命跌破此值就收手撤退;0 = 不撤 */
  fleeHealth: () => number;
  /** 技能正在脱身(flee/surface/战斗撤退)时置 true:反射不抢占正在逃的任务 */
  escape: { active: boolean };
  /** 主动攻击独占身体与弓租约；被动战斗层只观察，不重复接管。 */
  attack: {
    acquire(targetId: number): TaskAttackLease;
    release(lease: TaskAttackLease): void;
    ranged?: TaskRangedActions;
  };
  /** World 日志;技能内部的判断过程记在这里 */
  diag?: MinecraftLog;
  /** 这一步属于哪个任务 */
  taskId: number;
  /** 计数类技能(collect/build/excavate/tunnel)每完成一个单位报一次;执行器据此出进度事件 */
  progress?: (done: number, total: number) => void;
  /** 常驻规矩(mc_policy;World 持有并落盘)。技能只读它,改由工具面走 */
  policy?: {
    get(): PolicySettings;
    /** 她没设过名单时用哪一份;与寻路器的垫脚名单同源(见 world.ts 的接线注释) */
    defaults(): PolicyDefaults;
  };
  /** 普通放置的材料许可；成功与否必须在同一 permit 上结算。 */
  permitResourcePlacement?: ResourcePlacementGate;
  /** 试算的材料判据;不取 permit,免得预览文案说出结算期的话 */
  previewResourcePlacement?: ResourcePlacementPreview;
  /**
   * 这一步里被迫动用的、`reserve` 收着的家伙什。收着的那把是唯一挖得出掉落时的例外,
   * 由 `reserveNote` 摘成回执里的一句 —— 「策略被事实覆盖」必须看得见。
   */
  reserveHits?: ReserveHit[];
  /** 当前步骤的工具选择摘要；同一把连续使用只记一次。 */
  toolTrace?: ToolTrace;
  /**
   * 以三份代价配置试算路径，未连接时返回 null。
   * 试算与执行必须使用同一目标；水平寻路须显式传入 GoalNearXZ，省略时使用以 target 为中心、半径 1 的 GoalNear。
   */
  probeRoutes?: (
    target: { x: number; y: number; z: number },
    goal?: InstanceType<typeof goals.Goal>,
  ) => RouteProbe[] | null;
  /** 目标点分诊(落脚预检+死角灌水);没连上服务器时 null */
  probeTarget?: (target: { x: number; y: number; z: number }) => TargetDiag | null;
  /**
   * 零位移探针里执行器自己看不见的那几格(战斗、环境 owner、队列冻结、断点)。
   * 只读,不改任何动作;不接 = 那几格记 null(台架)。
   */
  bodyState?: () => BodyStateProbe;
  /** `ts` 之后进「暂时挖不动」退避的格子(桥持有);受阻回执据此说清绕开了哪儿 */
  digBackoffSince?: (ts: number) => Array<{ x: number; y: number; z: number }>;
  /** 容器账本(World 持有,跨任务):箱子内容、炉子槽位与到期、自备工作站的来历 */
  chests?: ChestBook;
  /**
   * 成果登记(World 持有,跨任务跨场次):她做成的蓝图格、耕地、作物。
   * 技能只往里记与读事实,不据此阻断任何动作。
   */
  works?: WorksBook;
  /** 挂钟时刻 HH:MM:SS(与回执同一时区);账本里的 placedAt/到期估计都用它渲染 */
  clock?: (ms: number) => string;
  /** probe 差分的单槽记忆(执行器持有,跨任务;mc_stop 不清,重启清) */
  probeMemo?: { last: ProbeMemo | null };
  /** find 边走边找收工(走满/命中)落探索覆盖账本(World 持久化) */
  explored?: (dimension: string, direction: Direction, distance: number, biome: string) => void;
  /** find 的短期真实观察；只供回执，不改变动作。 */
  search: {
    history: FindObservationCache;
    scope(): SearchScope;
  };
  /** 容器 GUI 演出节拍;摄像机没开/演出关着时回 null,每单容器操作开工时现取一次 */
  showTempo?: () => ShowTempo | null;
  /**
   * 这一单还剩哪些步、当前是第几步,以及「这一步顺手把后面某一步也做掉了」的登记口。
   * 目前只有 stow 用它并窗(见 collectStowBatch):登记过的步执行器不再跑,直接用
   * 登记的那句当回执。
   */
  batch?: {
    steps: readonly SkillCall[];
    index: number;
    absorb(stepIndex: number, receipt: string): void;
  };
  /** 登记部分完成：技能正常返回，任务终态为部分完成，gap 说明未完成的量。 */
  partial?: (gap: string) => void;
  /**
   * 刚刚有没有把重生点记到这张床上(World 听 set_spawn 系统消息)。白天点床原版是
   * 「先记重生点,再拒绝睡觉」,回执只说没躺下的话,那一次点击在她眼里就是纯空操作。
   */
  spawnNote?: () => string | null;
  /**
   * 这一步有意放的那些格(cellKey),由 build 自己登记。执行器据此把「路上垫脚/搭路
   * 用掉了」那句里的落点摘掉,落点之外的放置仍是耗材,照报。执行器每步换一只新的,
   * 蓝图那层的内层 ctx 是浅拷贝,登记进的是同一只。
   */
  intended?: Set<string>;
  /** 禁止本步补光，供蓝图清场使用，避免在要求空置的格重新放火把。 */
  noLight?: boolean;
  /**
   * 个人重生点那一格(床/重生锚);没设过为 null。 World 持有唯一写入口(setPersonalSpawn)。
   * 技能只读它,用来把「这一下动的是你的重生锚」当场说出来。
   */
  spawnAnchor?: () => { x: number; y: number; z: number; dimension?: string } | null;
  /**
   * 蓝图施工面(World 持有);没接 = 这个部署没有蓝图能力,build 的 blueprint 形态
   * 会如实说"这边没装载"。采集搭车也读它。
   */
  blueprints?: () => BlueprintDesk;
  /**
   * 路标取用面(World 持有 mc_map);不接 = 这个部署没有路标(台架)。
   * 技能只读它做回执侧的机械并置,不改表也不改执行。
   */
  marks?: () => MarkDesk;
  /**
   * 这一步现在正躺在床上等醒(见 waitForWake)。进度事件据此换一句话说 ——
   * 等醒期间人本来就一动不动,周期进度报「进行中、挪了 0 格」会被读成卡住。
   * 技能自己置位与复位,执行器只读。
   */
  sleeping?: boolean;
}

/** 上一次探查的指纹:形状+锚点(key)与读数(hash),都是 FNV-1a */
export interface ProbeMemo {
  key: number;
  hash: number;
  /** 同参同读数连续探查到第几次 */
  count: number;
  /** 上次回执的第一句,重复时带给她当参照 */
  summary: string;
}

/** 抢占方随异常一起走:message 就是日志与回执里那句「被谁打断的」 */
export class Aborted extends Error {
  readonly by: string | null;
  constructor(by: string | null = null) {
    super(by ? `aborted: ${by}` : 'aborted');
    this.by = by;
  }
}

export function checkAbort(ctx: SkillContext): void {
  if (ctx.aborted()) throw new Aborted(ctx.abortedBy?.() ?? null);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export interface TaskRangedActions {
  ready(bot: Bot): boolean;
  shoot(target: RangedTarget, ownerToken: unknown): Promise<BowShotResult>;
  abort(): void;
}

export interface TaskAttackLease {
  token: object;
  targetId: number;
  swings: number;
  meleeHits: number;
  arrows: number;
  rangedHits: number;
  hurts: number;
  lastHurtAt: number;
  lastSwingAt: number;
  lastSwingTargetId: number;
  dead: boolean;
  disconnected: boolean;
}

/**
 * 零位移探针里执行器够不着的那几格。战斗与环境 owner 归 World 接线,
 * 队列冻结与断点归执行器自己,合成一只递给 SkillContext(见 `bodyState`)。
 */
export interface BodyStateProbe {
  /** 战斗会话正占着身体 */
  combatActive: boolean;
  /** 环境自保正占着身体(岩浆/溺水/窒息);没有时 null */
  environmentOwnerKind: 'lava' | 'drown' | 'suffocation' | null;
  /** 队列冻结令牌还在谁手上(冻结理由);没冻结时 null */
  queueHold: string | null;
  /** 战斗挂起的断点任务号;没有时 null */
  frozenTaskId: number | null;
}

export interface ToolTrace {
  last: string | null | undefined;
  notes: string[];
  near: Set<string>;
}

/** 收着的工具被选中时的回执事实。 */
export interface ReserveHit {
  tool: string;
  block: string;
  /** 名单外还剩的最好那把;一把不剩时 null */
  instead: string | null;
  reason?: 'only-capable' | 'override';
}

