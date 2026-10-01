/**
 * 战斗模式 · 档 1(常驻夜间自保)。
 *
 * 战术核 = 台架 v7(scratch/mc-bench/combat/,七轮 300+ 场:30 只僵尸清场、
 * survive 补波 20 场零死亡),旋钮按「自保」配:被打或 3 格内有敌对才动手,
 * 不主动招惹;血线 10 撤;追击 6 格;硬时长 30s;间距 2.6(故意不用台架的 2.88——
 * 2.88 几乎无敌,画面上"站在三十只僵尸中间毫发无伤"比冷却完美更不像人,
 * 2.6 会偶尔挨打,是"人味"旋钮,不是性能旋钮)。
 *
 * 这几条是拿数据换来的,别改(依据在 RESULTS.md / RESULTS2.md):
 * 1. 打最近的 + 1.3 倍粘性。威胁排序实测有害(9 只混合怪群 0/3 全死 → 改最近 3/3)。
 *    **任何让她离开身上那只、穿过怪堆去打另一只的策略都输。**
 * 2. 贴身 ≥2 只切横扫,否则暴击;冷却一律等满(≥84.8% 才有暴击/横扫/冲刺击退)。
 * 3. 距离用「眼睛 → AABB 最近点」,上限 3.0(服务端判定),不是脚底距离。
 * 4. 移动走上下文图(combat-context.ts):行为只往 interest/danger 图写,硬约束走
 *    masking。不要写成 if/else 模式机——台架前四轮每加一条战术就打断另一条,
 *    根因是架构不是战术。
 * 5. 接近卡住 1.5s 交给寻路器,够得着(≤3.2)立刻收回来自己打。
 * 6. 前摇排进冷却窗口(prep):单独值 1.6×。
 * 7. 亚格间距(spacing):贴上沿做比例控制,目标以 v 逼近就以 v 后退。再值 1.8×。
 * (6+7 合起来把承伤/秒从 0.79 压到 0.27。)
 *
 * 生命周期:夺手不夺嘴——接管移动与出手,事件照常推给人格说话;mc_do 期间
 * 入队不启动;任务队列**挂起**不是抢占,战后从断点续做(非幂等步不重跑)。
 */
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { Logger } from '../../core/types.ts';
import type { MinecraftLog } from './log.ts';
import {
  HARD, blend, blur, decide, newMap, slotDir, write, writeSlot, type Map16,
} from './combat-context.ts';
import { HOSTILE, bestWeapon, dropOwnedGoal, meleeCooldownMs, releaseBody, setOwnedGoal } from './executor.ts';
import type { FightMode } from './policy.ts';
import { zhEntity, zhName } from './names.ts';
import { zhErrorText } from './receipt.ts';
import { BURNING_BLOCKS, SCORCHING_FLOOR, bodyInWater, findBankCell, headInWater } from './terrain.ts';
import { piglinIsHostile } from './piglin.ts';
import {
  RANGED_EXIT_RANGE,
  chooseHybridWeapon,
  inKiteRange,
  type BowEvent,
  type BowShotResult,
  type HybridWeapon,
  type RangedTarget,
} from './ranged.ts';

const { goals } = pathfinderPkg;

/** 眼高;距离全部从这里量 */
const EYE = 1.62;
/** 服务端攻击判定上限(player.entity_interaction_range) */
const REACH_MAX = 3.0;
/** 远程怪贴脸:骷髅 <4 格会后退,逼它的直线预判失效 */
const RANGED_STOP = 1.7;
/** 苦力怕引信触发 3 格,留 0.6 余量 */
const CREEPER_SAFE = 3.6;
/** 贴身几只就改横扫(台架:sweepCrowd 2 全面优于 3) */
const SWEEP_CROWD = 2;
const KB_CROWD = 2;
/** 第二近的怪超过这个距离就当「有空间」,可以暴击 */
const SOLO_SPACE = 6;
/** 间距控制的预判时长:目标以 v 逼近,就按 v·t 提前修正 */
const SPACE_PREDICT_S = 0.25;
/** 接近毫无进展这么久就交给寻路器 */
const STUCK_PATH_MS = 1_500;
/** E1:场上没怪之后再等这么久才收工(防"炸完→退出→新怪→再进入"抖动) */
const CLEAR_HOLD_MS = 3_000;
/** E5:连续这么久打不着又靠不近就收工 */
const UNREACHABLE_MS = 6_000;
/**
 * 无实际进展的绝对时限；只有进入近战可达且可见范围或实际命中才重置。
 * 目标移动导致的 reach 差分不重置此计时。
 */
const UNREACHABLE_HARD_MS = 20_000;
/** 进场后刀和箭均未出手的时限；不依赖挥刀次数门槛。 */
const NO_SWING_MS = 15_000;
/** E8:够得着、刀也挥出去了,却这么久一下没打中,就是打不到它 */
const NO_DAMAGE_MS = 6_000;
/** E8 起判所需的挥刀数:刚接敌头两刀还没回音不算 */
const NO_DAMAGE_SWINGS = 3;
/** 战况事件的节流 */
const STATUS_EVERY_MS = 6_000;
/** 击杀事件合并窗口 */
const KILL_MERGE_MS = 2_000;
/** E4 战斗占比的滑动窗口 */
const BUSY_WINDOW_MS = 300_000;
/**
 * `queue:"now"` 交还身体之后的宽限:这段时间内不自动进场。
 * 没有它,250ms 巡检会在下一拍把刚开跑的那一单重新挂起 —— 交还就白交了。
 */
const STAND_DOWN_GRACE_MS = 5_000;
/** 挥刀到目标掉血的判定窗口(一个网络往返);超窗的掉血算别人打的,不记进命中 */
const LANDED_WINDOW_MS = 400;
/** 撤退:最近威胁超过这个距离,并保持无伤一段时间,才算安全 */
const RETREAT_CLEAR_DIST = 16;
/** 距离安全与无伤都要连续守住这一段,过滤瞬时丢实体/箭还在飞的假脱离 */
const RETREAT_SAFE_HOLD_MS = 1_500;
/** 撤退净位移这么久没有增加,持续受击时就视为逃路已经证伪 */
const RETREAT_STALL_MS = 1_500;
/** 到时只升级策略,不能在威胁仍近时把撤退记成成功 */
const RETREAT_MAX_MS = 8_000;
/**
 * 撤退中连续未受击的时限；到期且撤退已超时、无进展时交还身体。
 * 再次受击仍由 onHurtBy 重新处理。
 */
const RETREAT_IDLE_MS = 10_000;
/** E5/E8 收工后的主动进场冷却，防止近处不可达目标立即触发新战斗。 */
const STUCK_COOLDOWN_MS = 10_000;

/** 远程怪:该举盾、该贴脸 */
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'illusioner', 'breeze']);

/** E7:反射不主动交战;挨打时除 REPORT_ONLY 外一律撤 */
const NO_FIGHT = new Set(['warden', 'wither', 'ender_dragon']);
/**
 * 挨打只报不撤的 NO_FIGHT。末影龙只在末地出现,去末地就是去打它;自动撤退在
 * 主岛上等于朝虚空跑。打不打、怎么打由任务决定(attack 步里挨打本来就由任务吸收)。
 */
const REPORT_ONLY = new Set(['ender_dragon']);

/**
 * 撤退每一拍踩出去之前看前方那一格往下多深有落脚。超过这个深度按悬崖处理:
 * 原版摔落伤害 = 落差 - 3,3 格以内不掉血;末地岛边往下是虚空,整柱都空。
 */
const RETREAT_MAX_DROP = 3;

/** 主动进场高于脱战血线的余量，单位为生命点；普通受击入场不加此余量。 */
const ENGAGE_MARGIN = 3;

/** 主手此刻的读数,空着念「空手」 */
function heldText(bot: Bot): string {
  return bot.heldItem ? zhName(bot.heldItem.name) : '空手';
}

/**
 * 朝 (dx,dz) 迈一步踩得住吗:前方 1.2 格那一柱,从脚那层往下 RETREAT_MAX_DROP 格内有实心(或脚那层
 * 本身是台阶/墙,由 autoJump 跳),且落脚面不是岩浆。区块没加载不拦,那是读不到,不是悬崖。
 */
export function footingAhead(bot: Bot, dx: number, dz: number): boolean {
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return true;
  const p = bot.entity.position;
  const x = Math.floor(p.x + (dx / len) * 1.2);
  const z = Math.floor(p.z + (dz / len) * 1.2);
  const y = Math.floor(p.y);
  for (let d = 0; d <= RETREAT_MAX_DROP + 1; d++) {
    const b = bot.blockAt(new Vec3(x, y - d, z));
    if (!b) return true;
    if (b.name === 'lava') return false;
    if (b.boundingBox === 'block') return true;
  }
  return false;
}

export interface CombatTuning {
  enabled: boolean;
  /** 触发半径:这么近才算"找上门",不主动招惹(档 1 没有先手) */
  engageRadius: number;
  /** 追击上限(格) */
  chaseMax: number;
  /** E3 硬时长闸(秒) */
  maxSec: number;
  /** 理想间距。2.88 几乎无敌;2.6 像个会玩的人 */
  space: number;
  /** E4:5 分钟滑窗里战斗占比超过这个百分数就强制冷却 */
  busyRatio: number;
  /** E4 触发后多少秒内不自动进入 */
  cooldownSec: number;
  /** 血线:低于它就收手撤退(与反射的脱战血线同源) */
  fleeHealth: number;
  /**
   * 主动进场的条件(mc_policy 的 `fight`)。只接在 `watchTick` 那一条上:
   * 不接 `onHurtBy`(挨打一律还手)、不接 E1–E9 任何一道退出闸。
   */
  fight: FightMode;
}

interface CombatSessionOptions {
  getBot: () => Bot | null;
  tuning: () => CombatTuning;
  /** 环境自保(岩浆/溺水反射/主动传送)正在进行:比战斗优先,期间不进场、进了也让位 */
  envBusy: () => boolean;
  /**
   * flee/surface/eat 任务正在逃生时，阻止近处敌对触发主动进场；
   * 受击仍交给 onHurtBy 判定，战斗结束后从断点恢复任务。
   */
  taskEscaping?: () => boolean;
  /** 主动 attack 已持有身体；被动三格巡检不得把同一场再接管一遍。 */
  taskFighting?: () => boolean;
  /**
   * 夺手:冻结任务执行器(当前任务断点挂起,队列原样保留,新任务只收不跑)。
   * `by` 是记进 `skill/aborted` 日志的抢占方,写清是哪一只怪触发的。
   */
  suspendTasks: (by: string) => void;
  /** 还手:解冻并从断点续做;返回一句"接着做"的说明(没有挂起任务则 null) */
  resumeTasks: () => string | null;
  /**
   * 事件出口。第一人称事实,不出现「战斗模式/脚本/接管」(闭包原则)。
   * hurt=true 表示这句已讲明掉血来由,World 据此不再复述掉血播报。
   */
  emit: (text: string, urgent: boolean, hurt?: boolean) => void;
  ranged?: CombatRangedActions;
  diag?: MinecraftLog;
  log: Logger;
}

export interface CombatRangedActions {
  ready(bot: Bot): boolean;
  active(): boolean;
  shoot(target: RangedTarget, ownerToken: unknown): Promise<BowShotResult>;
  abort(): void;
}

interface Foe {
  id: number;
  name: string;
  ent: NonNullable<Bot['entities'][number]>;
  pos: Vec3;
  /** 眼睛到 AABB 最近点——服务端攻击判定用的就是这个 */
  reach: number;
  /** 水平距离,给站位用 */
  flat: number;
}

type EndReason = 'clear' | 'flee' | 'timeout' | 'stuck' | 'mc_stop' | 'env' | 'death' | 'gone' | 'busy' | 'preempt';

/** 眼睛到实体 AABB 最近点的距离 */
function aabbReach(bot: Bot, e: { position: Vec3; height?: number; width?: number }): number {
  const eye = bot.entity.position.offset(0, EYE, 0);
  const w = (e.width ?? 0.6) / 2;
  const h = e.height ?? 1.8;
  const cx = Math.max(e.position.x - w, Math.min(eye.x, e.position.x + w));
  const cy = Math.max(e.position.y, Math.min(eye.y, e.position.y + h));
  const cz = Math.max(e.position.z - w, Math.min(eye.z, e.position.z + w));
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz);
}

/** 从某只眼睛看不看得见这只怪(苦力怕引信全程要视线,断视线即熄) */
function hasLosFrom(bot: Bot, eye: Vec3, e: { position: Vec3; height?: number }): boolean {
  try {
    const to = e.position.offset(0, (e.height ?? 1.8) * 0.6, 0);
    const d = to.minus(eye);
    const len = d.norm();
    if (len < 0.5) return true;
    const hit = (bot.world as unknown as {
      raycast(f: Vec3, dir: Vec3, range: number, matcher?: (b: unknown) => boolean): unknown;
    }).raycast(eye, d.scaled(1 / len), len, (b) => Boolean(b) && (b as { boundingBox?: string }).boundingBox === 'block');
    return !hit;
  } catch {
    return true;
  }
}

/**
 * 档 1 战斗会话:触发、v7 战术核、退出闸门、事件面,一个 owner 管到底。
 * 反射层的受击反击与它合并(combat.enabled 时反射不再自己抡),环境自保仍在
 * 它之上(envBusy 让位)。
 */
export class CombatSession {
  private watch: ReturnType<typeof setInterval> | null = null;
  private state: 'idle' | 'fighting' | 'retreating' = 'idle';
  private bot: Bot | null = null;
  private startedAt = 0;
  private deadlineAt = 0;
  private cooldownUntil = 0;
  private cooldownNoticed = false;
  /** E4 滑窗:每场战斗的 [开始,结束] */
  private readonly busyLog: Array<{ from: number; to: number }> = [];
  /** 打过我们的实体(末影人只有惹过我们才进目标池) */
  private readonly provoked = new Set<number>();
  /** 我们出手打过的:击杀归账 + World 的"它死了"播报让位给这里 */
  private readonly struck = new Set<number>();
  /** 死亡事件先于实体表清理；本场已经死亡的实体不得继续参与威胁判断。 */
  private readonly deadIds = new Set<number>();
  private kills = new Map<string, number>();
  private killsPending = new Map<string, number>();
  private lastKillEmitAt = 0;
  private lastStatusAt = 0;
  private emptySince = 0;
  private retreatFrom: { x: number; z: number } | null = null;
  private retreatStartedAt = 0;
  private retreatWhy: 'flee' | 'mc_stop' | 'no-fight' = 'flee';
  /** 在水里撤退时的登岸目标;上岸或转身还手后清掉 */
  private retreatBank: { x: number; y: number; z: number } | null = null;
  /** 这一场撤退里挨的打:逃不掉(挨打且怪还贴着)就转身还手的判据 */
  private retreatHits = 0;
  /** 最近一次撤退中受伤；安全结束必须在它之后守住无伤时窗 */
  private retreatLastHurtAt = 0;
  /** 威胁距离首次进入安全区的时刻；重新靠近就清零 */
  private retreatSafeSince = 0;
  /** 撤退净位移最近一次取得进展的时刻与位置 */
  private retreatProgressAt = 0;
  private retreatProgressPos: { x: number; y: number; z: number } | null = null;
  /** 非可战目标/明确收手在超时后继续撤，只记一次策略升级 */
  private retreatEscalated = false;
  /** 空手低血挡下的那次转身还手,一场撤退只记一次(判据每 250ms 都会再成立一遍) */
  private retreatBarehandNoted = false;
  /** 这一场撤退有没有记过「前面没落脚」;一场只记一次 */
  private retreatEdgeNoted = false;
  /** 撤退失败转身还手中:E2 血线对本场静默(血线的前提是"跑得掉",这里已经证伪) */
  private desperate = false;

  // —— v7 出手/移动状态
  private lastSwingAt = 0;
  private swingPhase: 'idle' | 'hop' | 'settle' = 'idle';
  private phaseTargetId = -1;
  private phaseUntil = 0;
  private wtapUntil = 0;
  private sprintSince = 0;
  private shieldUp = false;
  private shieldHoldUntil = 0;
  private targetId = -1;
  private pathing = false;
  private pathUntil = 0;
  private lastReach = 99;
  private lastProgressAt = 0;
  /** 上一次**真**进展(够得着+视线,或走到跟前)的时刻;reach 差分刷新不了这条 */
  private lastRealProgressAt = 0;
  private lastLandedAt = 0;
  private readonly ctxI: Map16 = newMap();
  private readonly ctxD: Map16 = newMap();
  private readonly ctxPrevI: Map16 = newMap();
  private readonly ctxPrevD: Map16 = newMap();
  private readonly ctxTerrain: Map16 = newMap();
  private ctxTerrainAt = 0;
  private readonly ctxCreeper: Map16 = newMap();
  private ctxCreeperAt = 0;
  private coverCell: { x: number; y: number; z: number } | null = null;
  private coverAt = 0;

  /**
   * 出手记账:挥了几次、其中几次让目标掉了血。`bot.attack()` 只管发包,够不够得着
   * 由服务端说了算 —— 不分账的话「打了半天没打死」在日志上与「压根没碰到」同形。
   */
  private swings = 0;
  private landed = 0;
  private lastSwingTargetId = -1;
  private hybridWeapon: HybridWeapon = 'melee';
  private rangedOwner: object | null = null;
  private rangedPendingOwner: object | null = null;
  private nextRangedAt = 0;
  private arrows = 0;
  private rangedLanded = 0;
  private lastRangedHitTargetId = -1;
  private lastRangedHitAt = 0;

  private readonly onTick = (): void => this.tick();
  private readonly onDead = (e: { id?: number; name?: string; position?: Vec3 }): void => this.noteDead(e);
  private readonly onFoeHurt = (e: { id?: number }, source?: { id?: number }): void => this.noteFoeHurt(e, source);
  private readonly onSelfDeath = (): void => {
    if (this.state !== 'idle') this.end('death');
    else this.cancelRanged();
  };

  constructor(private readonly opts: CombatSessionOptions) {}

  start(): void {
    if (this.watch) return;
    this.watch = setInterval(() => this.watchTick(), 250);
    this.watch.unref?.();
  }

  stop(): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    if (this.state !== 'idle') this.end('gone');
    else this.cancelRanged();
  }

  /** 正在打(或正在撤)。执行器的受理回执与 World 的播报口径都看它 */
  get active(): boolean {
    return this.state !== 'idle';
  }

  /** 这只怪的死由战斗会话来说,World 的「它死了」播报让位 */
  claims(id: number): boolean {
    return this.state !== 'idle' && this.struck.has(id);
  }

  /** 弓控制器的租约只在创建它的这一场战斗内有效。 */
  ownsRanged(ownerToken: unknown): boolean {
    return this.state === 'fighting' && ownerToken === this.rangedOwner;
  }

  /** 近战发包窗口优先，防止在途旧箭把刚落下的一刀归成远程命中。 */
  acceptsRangedHit(targetId: number, at = Date.now()): boolean {
    return this.rangedOwner !== null && !(
      this.lastSwingTargetId === targetId && at - this.lastSwingAt <= LANDED_WINDOW_MS
    );
  }

  onBowEvent(event: BowEvent): void {
    if (event.kind === 'blocked' || !this.ownsRanged(event.ownerToken)) return;
    if (event.kind === 'released') {
      this.arrows += 1;
      this.nextRangedAt = Math.max(this.nextRangedAt, event.at + 200);
      return;
    }
    this.rangedLanded += 1;
    this.landed += 1;
    this.lastLandedAt = event.at;
    this.lastRangedHitTargetId = event.targetId;
    this.lastRangedHitAt = event.at;
    this.struck.add(event.targetId);
  }

  onConnectionLost(): void {
    if (this.state !== 'idle') this.end('gone');
    else this.cancelRanged();
  }

  /**
   * 反射层受击时转进来。返回 true = 会话接手(反射不再自己抡);
   * false = 会话进不了场(关着/冷却/环境自保中),退回反射的降级行为。
   */
  onHurtBy(attackerId: number, name: string): boolean {
    const t = this.opts.tuning();
    if (!t.enabled) return false;
    if (this.state === 'retreating') {
      this.retreatHits += 1;
      this.retreatLastHurtAt = Date.now();
      this.retreatSafeSince = 0;
      this.provoked.add(attackerId);
      return true;
    } // 已经在撤了,别叠加;伤害历史留在同一场里,逃不掉要转身
    if (this.state === 'fighting') {
      this.provoked.add(attackerId);
      return true;
    }
    if (this.opts.envBusy()) return false;
    // 头在水里不接手:水下近战是另一回事,交回 surface/防溺水那条线
    const bot = this.opts.getBot();
    if (bot && headInWater(bot)) return false;
    if (REPORT_ONLY.has(name)) {
      // 不急报:一次俯冲连着打几下,由投递批次合并
      this.opts.emit(`${zhEntity(name)}打中了我(生命 ${this.hp()}/20);它不在自动撤退之列,手上的任务照常`, false, true);
      return false;
    }
    // E7:打不过的,不进场,直接跑
    if (NO_FIGHT.has(name)) {
      this.bot = this.opts.getBot();
      if (!this.bot) return false;
      this.opts.suspendTasks(`战斗:${zhEntity(name)}打不过,撤退`);
      this.hook(this.bot);
      this.opts.emit(`是${zhEntity(name)}!这个打不过,快跑!(生命 ${this.hp()}/20)`, true, true);
      this.beginRetreat('no-fight');
      return true;
    }
    if (Date.now() < this.cooldownUntil) return false;
    if (bot?.entity && !bestWeapon(bot) && !this.rangedReady(bot) && (bot.health ?? 20) < t.fleeHealth + ENGAGE_MARGIN) {
      this.bot = bot;
      this.opts.suspendTasks(`战斗:空手血 ${this.hp()},不还手,撤`);
      this.hook(bot);
      this.opts.emit(`空手,血只剩 ${this.hp()}/20 —— 这架不还手了,撤。`, true, true);
      this.opts.diag?.write({
        lane: 'combat', event: 'barehand-flee',
        msg: `空手低血脱离:${zhEntity(name)}打过来,生命 ${this.hp()}/20 低于 ${t.fleeHealth + ENGAGE_MARGIN}`,
        data: { foe: name, health: bot.health, line: t.fleeHealth + ENGAGE_MARGIN },
      });
      this.beginRetreat('flee');
      return true;
    }
    this.provoked.add(attackerId);
    return this.engage(name, true);
  }

  /** 250ms 巡检:3 格内有敌对就开打(不主动招惹,这是"找上门"的判据) */
  private watchTick(): void {
    if (this.state !== 'idle') return;
    const t = this.opts.tuning();
    // 她正在跑(flee/surface):不趁逃跑抢场——挨了打另说(onHurtBy 不看这道闸)
    if (!t.enabled || this.opts.envBusy() || this.opts.taskEscaping?.() || this.opts.taskFighting?.()) return;
    if (t.fight === 'off') return;
    if (Date.now() < this.cooldownUntil) return;
    const bot = this.opts.getBot();
    if (!bot?.entity) return;
    // armed 模式仅在背包有可用近战武器或远程武器就绪时主动进场。
    if (t.fight === 'armed' && !bestWeapon(bot) && !this.rangedReady(bot)) return;
    this.bot = bot;
    const foes = this.scan(bot, t);
    const near = foes.find((f) => f.reach <= t.engageRadius && !NO_FIGHT.has(f.name));
    if (near) {
      if (near.name === 'piglin') this.provoked.add(near.id);
      this.engage(near.name, false);
    }
  }

  /** 播报用的整数血量:向上取整与游戏 HUD 的半颗心一致,0.1 血活着就报 1,不报 0。判定一律用浮点原值。 */
  private hp(): number {
    return Math.ceil(this.bot?.health ?? 0);
  }

  private engage(firstName: string, hurt: boolean): boolean {
    const bot = this.opts.getBot();
    if (!bot?.entity) return false;
    // 血线不足时转入撤退，避免 250ms 巡检反复尝试进场。
    const line = this.opts.tuning().fleeHealth + (hurt ? 0 : ENGAGE_MARGIN);
    if ((bot.health ?? 20) < line) {
      this.bot = bot;
      this.opts.suspendTasks(`战斗:血只剩 ${this.hp()},不接这架`);
      this.hook(bot);
      this.opts.emit(`血只剩 ${this.hp()}/20,这架不接了,先拉开。`, true, hurt);
      this.opts.diag?.write({
        lane: 'combat', event: 'engage-refused',
        msg: `血线挡下进场:${firstName}${hurt ? '(挨了打)' : '(进了 3 格圈)'},` +
          `生命 ${this.hp()}/20 低于入场线 ${line}`,
        data: { first: firstName, hurt, health: bot.health, line },
      });
      this.beginRetreat('flee');
      return true;
    }
    // E4:5 分钟滑窗里战斗占比超标 → 冷却,不自动进场
    if (this.busyRatioNow() > this.opts.tuning().busyRatio / 100) {
      this.cooldownUntil = Date.now() + this.opts.tuning().cooldownSec * 1000;
      if (!this.cooldownNoticed) {
        this.cooldownNoticed = true;
        this.opts.emit('这地方怪一波接一波,打不完,我得先离开这一片。', true, false);
      }
      return false;
    }
    this.cooldownNoticed = false;
    this.bot = bot;
    this.state = 'fighting';
    const now = Date.now();
    this.startedAt = now;
    this.deadlineAt = now + this.opts.tuning().maxSec * 1000;
    this.lastStatusAt = now;
    this.emptySince = 0;
    this.lastProgressAt = now;
    this.lastRealProgressAt = now;
    this.lastLandedAt = now;
    this.lastReach = 99;
    this.targetId = -1;
    this.swingPhase = 'idle';
    this.desperate = false;
    this.retreatBank = null;
    this.pathing = false;
    this.kills = new Map();
    this.killsPending = new Map();
    this.struck.clear();
    this.deadIds.clear();
    this.swings = 0;
    this.landed = 0;
    this.lastSwingTargetId = -1;
    this.hybridWeapon = 'melee';
    this.rangedOwner = {};
    this.rangedPendingOwner = null;
    this.nextRangedAt = now;
    this.arrows = 0;
    this.rangedLanded = 0;
    this.lastRangedHitTargetId = -1;
    this.lastRangedHitAt = 0;
    this.ctxPrevI.fill(0);
    this.ctxPrevD.fill(0);
    this.opts.suspendTasks(`战斗:${hurt ? '被' : ''}${zhEntity(firstName)}${hurt ? '打了' : '贴到跟前'}`);
    this.hook(bot);
    const held = this.armMelee(bot);
    this.opts.emit(
      hurt
        ? `有只${zhEntity(firstName)}打过来了,我抄家伙还手!(生命 ${this.hp()}/20${held})`
        : `${zhEntity(firstName)}贴到跟前了,我先动手!(生命 ${this.hp()}/20${held})`,
      true, hurt,
    );
    this.opts.diag?.write({
      lane: 'combat', event: 'engage',
      msg: `开打:${firstName}${hurt ? '(挨了打)' : '(进了 3 格圈)'},生命 ${this.hp()}/20`,
      data: { first: firstName, hurt, health: this.bot.health },
    });
    return true;
  }

  private hook(bot: Bot): void {
    bot.on('physicsTick', this.onTick);
    bot.on('entityDead' as never, this.onDead as never);
    bot.on('entityHurt' as never, this.onFoeHurt as never);
    bot.on('death', this.onSelfDeath);
  }

  private unhook(): void {
    const bot = this.bot;
    if (!bot) return;
    bot.removeListener('physicsTick', this.onTick);
    bot.removeListener('entityDead' as never, this.onDead as never);
    bot.removeListener('entityHurt' as never, this.onFoeHurt as never);
    bot.removeListener('death', this.onSelfDeath);
  }

  /** 刚挥的那一刀落没落在目标身上:掉血在挥刀后一个往返内到,超窗的算别人打的 */
  private noteFoeHurt(e: { id?: number }, source?: { id?: number }): void {
    if (this.state === 'idle' || typeof e.id !== 'number') return;
    if (typeof source?.id === 'number' && source.id !== this.bot?.entity.id) return;
    if (e.id === this.lastRangedHitTargetId && Date.now() - this.lastRangedHitAt <= LANDED_WINDOW_MS) {
      this.lastRangedHitTargetId = -1;
      return;
    }
    if (e.id !== this.lastSwingTargetId) return;
    if (Date.now() - this.lastSwingAt > LANDED_WINDOW_MS) return;
    this.landed += 1;
    this.lastLandedAt = Date.now();
    this.lastSwingTargetId = -1; // 一刀只记一次命中
  }

  private noteDead(e: { id?: number; name?: string }): void {
    if (this.state === 'idle' || typeof e.id !== 'number') return;
    this.deadIds.add(e.id);
    if (!this.struck.has(e.id)) return;
    this.struck.delete(e.id);
    const name = e.name ?? 'unknown';
    this.kills.set(name, (this.kills.get(name) ?? 0) + 1);
    this.killsPending.set(name, (this.killsPending.get(name) ?? 0) + 1);
    const now = Date.now();
    if (now - this.lastKillEmitAt < KILL_MERGE_MS) return;
    this.lastKillEmitAt = now;
    const parts = [...this.killsPending].map(([n, c]) => `${zhEntity(n)}${c > 1 ? `×${c}` : ''}`);
    this.killsPending = new Map();
    const t = this.opts.tuning();
    const left = this.bot
      ? this.exitFoes(
          this.scan(this.bot, t, this.rangedReady(this.bot) ? RANGED_EXIT_RANGE : undefined), t,
        ).length
      : 0;
    this.opts.emit(
      `砍翻了${parts.join('、')}!${left > 0 ? `还有 ${left} 只在。` : '周围没别的了。'}`,
      true, false,
    );
  }

  /** 目标池:敌对、够近、不是打不过的;末影人只有惹过我们的才进(看它就是宣战) */
  private scan(bot: Bot, t: CombatTuning, maxFlat = t.chaseMax + 4): Foe[] {
    const out: Foe[] = [];
    for (const key of Object.keys(bot.entities)) {
      const e = bot.entities[key as unknown as number];
      if (!e?.isValid || !e.position || e === bot.entity) continue;
      if (this.deadIds.has(e.id)) continue;
      const name = e.name ?? '';
      const provoked = this.provoked.has(e.id);
      if (name === 'piglin') {
        if (!piglinIsHostile(bot, e, provoked)) continue;
      } else if (!HOSTILE.has(name) && !provoked) continue;
      if (name === 'enderman' && !provoked) continue;
      const flat = Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z);
      if (flat > maxFlat) continue;
      out.push({ id: e.id, name, ent: e as never, pos: e.position, reach: aabbReach(bot, e as never), flat });
    }
    return out;
  }

  /**
   * 退出判据和剩余敌人数只统计常规半径内或已交手的目标。
   * 可用远程武器扩大的扫描半径不扩大退出范围。
   */
  private exitFoes(foes: Foe[], t: CombatTuning): Foe[] {
    const near = t.chaseMax + 4;
    return foes.filter((f) => f.flat <= near || this.provoked.has(f.id));
  }

  /** 最近的 + 1.3 倍粘性。就这一条,威胁排序实测有害 */
  private pick(foes: Foe[]): Foe | null {
    const pool = foes.filter((f) => !NO_FIGHT.has(f.name));
    if (pool.length === 0) return null;
    const best = [...pool].sort((a, b) => a.reach - b.reach)[0];
    const cur = pool.find((f) => f.id === this.targetId);
    if (cur && best.id !== cur.id && !(cur.reach > best.reach * 1.3)) return cur;
    this.targetId = best.id;
    return best;
  }

  /** 三形态:贴身 ≥2 只 → 横扫;否则暴击;远程怪贴脸暴击(推远了它就开始射) */
  private resolveMode(foes: Foe[], target: Foe): 'crit' | 'kb' | 'sweep' {
    const bot = this.bot!;
    // 水里 onGround 恒假，且无法保持横扫所需的站定状态，因此只用平 A。
    if (bodyInWater(bot)) return 'kb';
    const sword = (bot.heldItem?.name ?? '').endsWith('_sword');
    const crowd = foes.filter((f) => f.reach <= 3.4).length;
    if (sword && crowd >= SWEEP_CROWD) return 'sweep';
    if (crowd >= KB_CROWD) return 'kb';
    const others = foes.filter((f) => f.id !== target.id).map((f) => f.flat).sort((a, b) => a - b);
    const space = others.length === 0 || others[0] > SOLO_SPACE;
    if (space || RANGED.has(target.name)) return 'crit';
    return 'kb';
  }

  private tick(): void {
    if (this.state === 'idle') return;
    const bot = this.bot;
    if (!bot?.entity || bot !== this.opts.getBot()) { this.end('gone'); return; }
    const now = Date.now();
    // E6:环境自保找上门(岩浆/溺水),战斗静默让位,由环境反射自己汇报
    if (this.opts.envBusy()) { this.end('env'); return; }
    if (this.state === 'retreating') { this.retreatTick(bot, now); return; }

    const t = this.opts.tuning();
    const rangedReady = this.rangedReady(bot);
    const foes = this.scan(
      bot,
      t,
      this.desperate ? RETREAT_CLEAR_DIST : rangedReady ? RANGED_EXIT_RANGE : t.chaseMax + 4,
    );
    // E1:没怪了,滞后 3s 收工(防"炸完→退出→新怪→再进入"刷屏)。
    // 「没怪了」按退出口径算(见 exitFoes):远处那些没交过手的不算数,
    // 否则夜里 40 格内总有一只,这一局就永远收不了工。
    const clearPool = this.desperate ? foes : this.exitFoes(foes, t);
    if (clearPool.length === 0) {
      if (this.emptySince === 0) this.emptySince = now;
      this.opts.ranged?.abort();
      this.rangedPendingOwner = null;
      this.hybridWeapon = 'melee';
      this.release(bot);
      if (now - this.emptySince >= CLEAR_HOLD_MS) this.endClear();
      return;
    }
    this.emptySince = 0;

    // E3:硬时长。刷怪笼、夜晚开阔地的"索得到敌"可以永久为真,没有这道闸
    // 就是脚本永久持有控制权、人格整场没有手
    if (now >= this.deadlineAt) {
      this.opts.emit(`打太久了,先收手——还有 ${foes.length} 只在附近,怎么办你来定。(生命 ${this.hp()}/20)`, true, false);
      this.end('timeout');
      return;
    }
    // E2:血线只在场上仍有活威胁时撤。死亡事件到实体表移除之间不能把已清场误判成逃跑。
    // 转身还手中不看——血线的前提是"跑得掉",cornered 正是跑不掉才回的头。
    if (!this.desperate && (bot.health ?? 20) < t.fleeHealth) {
      this.opts.emit(`血被打到 ${this.hp()}/20 了,我先撤!`, true, true);
      this.beginRetreat('flee');
      return;
    }

    // 出手相位一旦起了就必须走完:台架第一轮 crit/sweep 整场只挥得出 2–4 刀,
    // 就是因为别的分支每 tick 把起跳/站定重置掉
    if (this.swingPhase !== 'idle') {
      const held = foes.find((f) => f.id === this.phaseTargetId);
      if (!held) { this.swingPhase = 'idle'; bot.setControlState('jump', false); }
      else {
        this.aimAt(bot, held);
        this.tryOffense(held, this.resolveMode(foes, held), now);
        return;
      }
    }

    const target = this.pick(foes);
    if (!target) {
      // 场上只剩打不过的(E7):撤
      this.opts.emit(`剩下的是${zhEntity(foes[0].name)},这个打不过,撤!`, true, false);
      this.beginRetreat('no-fight');
      return;
    }

    // 近战触及目标须同时满足距离和视线：原版服务端近战不检查墙体。
    if (target.reach < this.lastReach - 0.3) this.lastProgressAt = now;
    this.lastReach = target.reach;
    if (target.reach <= REACH_MAX && this.losTo(bot, target)) {
      this.lastProgressAt = now;
      this.lastRealProgressAt = now;
    }
    if (now - Math.max(this.lastProgressAt, this.lastLandedAt) > UNREACHABLE_MS) {
      this.opts.emit(`够不着${zhEntity(target.name)},不耗了。(生命 ${this.hp()}/20)`, true, false);
      this.end('stuck');
      return;
    }
    // 绝对时限只由实际可达或命中重置，reach 差分只刷新上面的软窗口。
    if (now - Math.max(this.lastRealProgressAt, this.lastLandedAt) > UNREACHABLE_HARD_MS) {
      this.opts.emit(
        `缠了 ${Math.round(UNREACHABLE_HARD_MS / 1000)} 秒始终够不到${zhEntity(target.name)},不耗了。(生命 ${this.hp()}/20)`,
        true, false,
      );
      this.end('stuck');
      return;
    }

    // 挥刀达到门槛后仍未命中则收工；空挥不刷新命中时间。
    if (this.swings >= NO_DAMAGE_SWINGS && now - this.lastLandedAt > NO_DAMAGE_MS) {
      this.opts.emit(
        `挥了 ${this.swings} 刀一下都没打到${zhEntity(target.name)},不耗了。(生命 ${this.hp()}/20)`,
        true, false,
      );
      this.end('stuck');
      return;
    }

    if (this.swings === 0 && this.arrows === 0 && now - this.startedAt > NO_SWING_MS) {
      this.opts.emit(
        `进场 ${Math.round(NO_SWING_MS / 1000)} 秒一下手都没出上(${zhEntity(target.name)}),不耗了。(生命 ${this.hp()}/20)`,
        true, false,
      );
      this.end('stuck');
      return;
    }

    const weapon = chooseHybridWeapon(this.hybridWeapon, target.reach, rangedReady);
    if (weapon !== this.hybridWeapon) this.switchWeapon(bot, weapon);
    if (this.hybridWeapon === 'ranged') {
      this.driveRanged(bot, target, foes, now);
      return;
    }

    this.aimAt(bot, target);

    // 接近卡住 1.5s 交给寻路器,够得着立刻收回来自己打
    if (!this.pathing && target.reach > 3.4 && now - this.lastProgressAt > STUCK_PATH_MS) {
      this.pathing = true;
      this.pathUntil = now + 4_000;
      setOwnedGoal(bot, new goals.GoalFollow(target.ent as never, 2), 'combat', '接近目标', { dynamic: true, diag: this.opts.diag });
    }
    if (this.pathing) {
      if (target.reach <= 3.2 || now > this.pathUntil) {
        // 走到了才算进展;窗口空转到期不算,否则 E5 被这条无限续命
        if (target.reach <= 3.2) {
          this.lastProgressAt = now;
          this.lastRealProgressAt = now;
        }
        this.pathing = false;
        dropOwnedGoal(bot, 'combat', '够得着了,收回来自己打', this.opts.diag);
      } else {
        // 寻路期间视线归寻路器:两边每 tick 各拧一次,镜头里就是原地疯狂旋转
        if (this.canSwing(now) && target.reach <= REACH_MAX) {
          this.aimAt(bot, target);
          this.tryOffense(target, this.resolveMode(foes, target), now);
        }
        this.statusTick(bot, foes, now);
        return;
      }
    }

    const mode = this.resolveMode(foes, target);
    this.shieldLogic(bot, foes, now);
    this.driveContext(bot, t, target, mode, now, foes);
    this.tryOffense(target, mode, now);
    this.statusTick(bot, foes, now);
  }

  /**
   * 看向目标。够得着才低头瞄它身上——攻击射线要打在碰撞箱上,矮个子(蜘蛛、小僵尸)
   * 本来就得低头。够不着就平视它的方向:那一刀反正打不出去,盯着脚下那一格只换来
   * 镜头里一个对着地板转圈的人。
   */
  private aimAt(bot: Bot, f: Foe): void {
    const y = f.reach <= REACH_MAX
      ? f.pos.y + (f.ent.height ?? 1.8) * 0.75
      : bot.entity.position.y + EYE;
    void bot.lookAt(new Vec3(f.pos.x, y, f.pos.z), true).catch(() => undefined);
  }

  /** 这一刀看不看得见目标。原版服务端近战不查墙——隔墙发包真能打中,穿帮得我们自己拦 */
  private losTo(bot: Bot, f: Foe): boolean {
    return hasLosFrom(bot, bot.entity.position.offset(0, EYE, 0), f.ent as never);
  }

  /** 战况:每 6s 一条,不唤醒(接敌/击杀/撤退才唤醒) */
  private statusTick(bot: Bot, foes: Foe[], now: number): void {
    if (now - this.lastStatusAt < STATUS_EVERY_MS) return;
    this.lastStatusAt = now;
    const nearest = [...foes].sort((a, b) => a.reach - b.reach)[0];
    this.opts.emit(
      `还在打:${foes.length} 只在附近(最近的是${zhEntity(nearest.name)}),` +
        `刀 ${this.swings} 次命中 ${this.meleeLanded()} 次,箭 ${this.arrows} 支命中 ${this.rangedLanded} 次,` +
        `手里是${heldText(bot)},生命 ${this.hp()}/20。`,
      false, false,
    );
  }

  private rangedReady(bot: Bot): boolean {
    return this.opts.ranged?.ready(bot) ?? false;
  }

  private switchWeapon(bot: Bot, next: HybridWeapon): void {
    this.hybridWeapon = next;
    this.swingPhase = 'idle';
    bot.setControlState('jump', false);
    if (next === 'ranged') {
      if (this.pathing) {
        this.pathing = false;
        dropOwnedGoal(bot, 'combat', '改用远程,寻路器让位', this.opts.diag);
      }
      this.lowerShield(bot);
      return;
    }
    this.opts.ranged?.abort();
    this.rangedPendingOwner = null;
    this.armMelee(bot);
  }

  /**
   * 把近战最好的那件拿到主手,返回接敌播报里那半句。已经在手上就不动;
   * 要换时播报只说正在换,换手的结果出来后没拿到手就另发一条,写明原因和手里实际是什么。
   */
  private armMelee(bot: Bot): string {
    const weapon = bestWeapon(bot);
    if (!weapon) return ',手边没趁手的家伙';
    if (bot.heldItem?.name === weapon.name) return `,手里是${zhName(weapon.name)}`;
    const was = heldText(bot);
    const miss = (why: string): void => {
      const now = heldText(bot);
      this.opts.emit(`${zhName(weapon.name)}没换到手上(${why}),手里是${now}。`, true, false);
      this.opts.diag?.write({
        lane: 'combat', event: 'arm-miss',
        msg: `近战换${weapon.name}没成:${why},主手是${now}`,
        data: { weapon: weapon.name, held: bot.heldItem?.name ?? null, why },
      });
    };
    void bot.equip(weapon, 'hand').then(
      () => { if (bot.heldItem?.name !== weapon.name) miss('换手做完了,主手读数却不是它'); },
      (err: Error) => miss(zhErrorText(err.message)),
    );
    return `,正把${zhName(weapon.name)}换到手上(原来手里是${was})`;
  }

  private driveRanged(bot: Bot, target: Foe, foes: Foe[], now: number): void {
    this.lowerShield(bot);
    const dx = target.pos.x - bot.entity.position.x;
    const dz = target.pos.z - bot.entity.position.z;
    if (target.reach > 14) {
      this.driveRangedDirection(bot, [{ x: dx, z: dz }], true);
    } else if (target.reach < 8) {
      this.driveRangedDirection(bot, [{ x: -dx, z: -dz }], true);
    } else if (inKiteRange(target.reach)) {
      this.driveRangedDirection(bot, [
        { x: -dz, z: dx },
        { x: dz, z: -dx },
      ], true);
    } else {
      this.stopMovement(bot);
    }
    this.tryRanged(target, now);
    this.statusTick(bot, foes, now);
  }

  /** 弓态不靠寻路器接管视线；只在实际移动方向有干燥落脚格时写水平键。 */
  private driveRangedDirection(
    bot: Bot,
    candidates: Array<{ x: number; z: number }>,
    sprint: boolean,
  ): void {
    const direction = candidates.find((d) => this.rangedDirectionSafe(bot, d.x, d.z));
    if (!direction) {
      this.stopMovement(bot);
      if (bodyInWater(bot)) bot.setControlState('jump', true);
      return;
    }
    this.pressToward(bot, direction.x, direction.z, sprint);
    this.autoJump(bot, direction.x, direction.z);
  }

  private rangedDirectionSafe(bot: Bot, dx: number, dz: number): boolean {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return false;
    const me = bot.entity.position;
    const base = me.floored();
    const x = Math.floor(me.x + (dx / len) * 1.3);
    const z = Math.floor(me.z + (dz / len) * 1.3);
    return this.rangedStandable(bot, x, base.y, z) ||
      this.rangedStandable(bot, x, base.y + 1, z) ||
      this.rangedStandable(bot, x, base.y - 1, z);
  }

  private rangedStandable(bot: Bot, x: number, y: number, z: number): boolean {
    const below = bot.blockAt(new Vec3(x, y - 1, z));
    const feet = bot.blockAt(new Vec3(x, y, z));
    const head = bot.blockAt(new Vec3(x, y + 1, z));
    if (!below || !feet || !head) return false;
    const liquid = (name: string): boolean => name === 'water' || name === 'lava' || name === 'bubble_column';
    return below.boundingBox === 'block' && feet.boundingBox === 'empty' && head.boundingBox === 'empty' &&
      !liquid(feet.name) && !liquid(head.name);
  }

  private tryRanged(target: Foe, now: number): void {
    const ranged = this.opts.ranged;
    const owner = this.rangedOwner;
    if (!ranged || !owner || this.rangedPendingOwner || ranged.active() || now < this.nextRangedAt) return;
    this.nextRangedAt = now + 250;
    this.rangedPendingOwner = owner;
    void ranged.shoot({
      id: target.id,
      position: target.pos,
      height: target.ent.height,
      width: target.ent.width,
    }, owner).catch((error: unknown) => {
      this.opts.log.warn(`远程出手失败:${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (this.rangedPendingOwner === owner) this.rangedPendingOwner = null;
    });
  }

  private meleeLanded(): number {
    return Math.max(0, this.landed - this.rangedLanded);
  }

  // —— v7 移动:上下文图 ————————————————————————————————————————

  private driveContext(bot: Bot, t: CombatTuning, target: Foe, mode: 'crit' | 'kb' | 'sweep', now: number, foes: Foe[]): void {
    // 横扫要求出手那一 tick 几乎没动:站定期间任何移动都不许写
    if (this.swingPhase === 'settle') {
      for (const k of ['forward', 'back', 'left', 'right', 'sprint'] as const) bot.setControlState(k, false);
      return;
    }
    const I = this.ctxI;
    const D = this.ctxD;
    I.fill(0);
    D.fill(0);
    const me = bot.entity.position;

    // interest:亚格间距。贴着攻击距离上沿做比例控制,把目标的接近速度补进误差——
    // 它以 v 逼近,我就以 v 后退(spacing,单独值 1.8×)
    const tx = target.pos.x - me.x, tz = target.pos.z - me.z;
    const tlen = Math.hypot(tx, tz) || 1;
    const ideal = RANGED.has(target.name) ? RANGED_STOP : t.space;
    const tv = (target.ent as unknown as { velocity?: { x: number; z: number } }).velocity;
    const closing = tv ? -((tv.x * tx + tv.z * tz) / tlen) * 20 : 0;
    const err = (target.reach - closing * SPACE_PREDICT_S) - ideal;
    if (err > 0.10) write(I, tx, tz, Math.min(1.0, 0.45 + err), 1);
    else if (err < -0.10) write(I, -tx, -tz, Math.min(1.0, 0.45 - err), 1);

    // interest:公转。两侧切向都写,怪少的那侧写得更强——绕着走把它们叠成一个扇区,
    // 同时能碰到你的嘴变少,横扫一刀吃到的反而多
    const lx = -tz / tlen, lz = tx / tlen;
    let leftMass = 0, rightMass = 0;
    for (const f of foes) {
      if (f.flat > 8) continue;
      const lat = (f.pos.x - me.x) * lx + (f.pos.z - me.z) * lz;
      const w = 1 / (1 + f.flat);
      if (lat > 0) leftMass += w;
      else rightMass += w;
    }
    write(I, lx, lz, leftMass <= rightMass ? 0.75 : 0.4, 2);
    write(I, -lx, -lz, rightMass < leftMass ? 0.75 : 0.4, 2);

    // interest:掩体(退进更窄的落脚格)。只是写图的一个行为,不独占方向盘
    this.pickCoverCell(bot, foes, now);
    const c = this.coverCell;
    if (c && !this.coverArrived(bot)) {
      write(I, c.x + 0.5 - me.x, c.z + 0.5 - me.z, 0.65, 2);
    }

    // danger:怪群
    for (const f of foes) {
      if (f.flat > 10) continue;
      write(D, f.pos.x - me.x, f.pos.z - me.z, 1.6 / (1 + f.flat * 0.55), 2);
    }
    // danger:苦力怕圈(往「走过去仍在圈内且它看得见我」的方向写重危险;
    // 被方块挡住视线的方向不写——「绕到柱子后面」是图的自然结果,不是一个模式)
    this.writeCreeperDanger(bot, D, foes, now);
    // danger:地形硬 masking
    this.writeTerrainDanger(bot, D, now);

    blur(I);
    blur(D);
    blend(this.ctxPrevI, I, 0.45);
    blend(this.ctxPrevD, D, 0.55);
    this.ctxPrevI.set(I);
    this.ctxPrevD.set(D);

    const choice = decide(I, D, 0.25);
    if (!choice) { this.release(bot); return; }
    this.pressToward(bot, choice.x, choice.z, choice.strength > 0.7 && mode === 'kb');
    this.autoJump(bot, choice.x, choice.z);
  }

  /** 每 150ms 重算:16 条射线不该每 tick 都打 */
  private writeCreeperDanger(bot: Bot, D: Map16, foes: Foe[], now: number): void {
    if (now - this.ctxCreeperAt > 150) {
      this.ctxCreeperAt = now;
      this.ctxCreeper.fill(0);
      const me = bot.entity.position;
      for (const f of foes) {
        if (f.name !== 'creeper' || f.flat > 8) continue;
        for (let i = 0; i < 16; i++) {
          const d = slotDir(i);
          const px = me.x + d.x * 2.2, pz = me.z + d.z * 2.2;
          if (Math.hypot(px - f.pos.x, pz - f.pos.z) > CREEPER_SAFE) continue;
          const eye = new Vec3(px, me.y + EYE, pz);
          if (!hasLosFrom(bot, eye, f.ent as never)) continue;
          writeSlot(this.ctxCreeper, i, 3.0);
        }
      }
    }
    for (let i = 0; i < 16; i++) writeSlot(D, i, this.ctxCreeper[i]);
  }

  /** 每 200ms 重算:走不过去的方向直接 HARD,永不入选 */
  private writeTerrainDanger(bot: Bot, D: Map16, now: number): void {
    if (now - this.ctxTerrainAt > 200) {
      this.ctxTerrainAt = now;
      this.ctxTerrain.fill(0);
      const me = bot.entity.position;
      const base = me.floored();
      for (let i = 0; i < 16; i++) {
        const d = slotDir(i);
        const x = Math.floor(me.x + d.x * 1.3);
        const z = Math.floor(me.z + d.z * 1.3);
        if (this.standable(bot, x, base.y, z) || this.standable(bot, x, base.y + 1, z) || this.standable(bot, x, base.y - 1, z)) continue;
        writeSlot(this.ctxTerrain, i, HARD);
      }
    }
    for (let i = 0; i < 16; i++) writeSlot(D, i, this.ctxTerrain[i]);
  }

  private standable(bot: Bot, x: number, y: number, z: number): boolean {
    const below = bot.blockAt(new Vec3(x, y - 1, z));
    const feet = bot.blockAt(new Vec3(x, y, z));
    const head = bot.blockAt(new Vec3(x, y + 1, z));
    if (!below || !feet || !head) return false;
    // 岩浆的 boundingBox 是 empty；危险方块须额外按与 world.ts 共用的名称集合排除。
    if (BURNING_BLOCKS.has(feet.name) || BURNING_BLOCKS.has(head.name)) return false;
    if (BURNING_BLOCKS.has(below.name) || SCORCHING_FLOOR.has(below.name)) return false;
    return below.boundingBox === 'block' && feet.boundingBox === 'empty' && head.boundingBox === 'empty';
  }

  /** 敞开度:八个水平方向里有几个是通的 */
  private openness(bot: Bot, x: number, y: number, z: number): number {
    let n = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const feet = bot.blockAt(new Vec3(x + dx, y, z + dz));
      const head = bot.blockAt(new Vec3(x + dx, y + 1, z + dz));
      if (feet?.boundingBox === 'empty' && head?.boundingBox === 'empty') n++;
    }
    return n;
  }

  /** 掩体:背离怪群那一侧找更窄的落脚格。任何穿过怪堆的移动都输,所以只往背面找 */
  private pickCoverCell(bot: Bot, foes: Foe[], now: number): void {
    if (now - this.coverAt < 900) return;
    this.coverAt = now;
    if (foes.length === 0) { this.coverCell = null; return; }
    const me = bot.entity.position;
    const base = me.floored();
    let cx = 0, cz = 0;
    for (const f of foes) { cx += f.pos.x; cz += f.pos.z; }
    cx /= foes.length;
    cz /= foes.length;
    const ax = me.x - cx, az = me.z - cz;
    const alen = Math.hypot(ax, az) || 1;
    const hereOpen = this.openness(bot, base.x, base.y, base.z);
    let best: { x: number; y: number; z: number } | null = null;
    let bestScore = -Infinity;
    for (let dx = -5; dx <= 5; dx++) {
      for (let dz = -5; dz <= 5; dz++) {
        const d = Math.hypot(dx, dz);
        if (d < 1 || d > 5) continue;
        if ((dx * ax + dz * az) / (d * alen) < 0.1) continue;
        for (let dy = 1; dy >= -1; dy--) {
          const x = base.x + dx, y = base.y + dy, z = base.z + dz;
          if (!this.standable(bot, x, y, z)) continue;
          const open = this.openness(bot, x, y, z);
          const score = -open * 2 - d * 0.6;
          if (score > bestScore) { bestScore = score; best = { x, y, z }; }
          break;
        }
      }
    }
    if (!best) { this.coverCell = null; return; }
    if (hereOpen - this.openness(bot, best.x, best.y, best.z) < 2) { this.coverCell = null; return; }
    this.coverCell = best;
  }

  private coverArrived(bot: Bot): boolean {
    const c = this.coverCell;
    if (!c) return true;
    const p = bot.entity.position;
    return Math.hypot(p.x - (c.x + 0.5), p.z - (c.z + 0.5)) < 1.0 && Math.abs(p.y - c.y) < 1.2;
  }

  /**
   * 世界方向 → 方向键。局部坐标系是台架量出来钉死的(probe-frame.ts),别照公式推:
   * 符号推反了不报错,只会让人朝反方向走,在战斗数据里表现成「这条战术没用」。
   */
  private pressToward(bot: Bot, dx: number, dz: number, sprint = false): void {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const ux = dx / len, uz = dz / len;
    const y = bot.entity.yaw;
    const f = ux * -Math.sin(y) + uz * -Math.cos(y);
    const l = ux * -Math.cos(y) + uz * Math.sin(y);
    bot.setControlState('forward', f > 0.35);
    bot.setControlState('back', f < -0.35);
    bot.setControlState('left', l > 0.35);
    bot.setControlState('right', l < -0.35);
    const wantSprint = sprint && f > 0.35 && Date.now() >= this.wtapUntil;
    if (wantSprint && this.sprintSince === 0) this.sprintSince = Date.now();
    if (!wantSprint) this.sprintSince = 0;
    bot.setControlState('sprint', wantSprint);
  }

  private stopMovement(bot: Bot): void {
    for (const key of ['forward', 'back', 'left', 'right', 'sprint', 'jump'] as const) {
      bot.setControlState(key, false);
    }
  }

  /** 前面是一格高的坎就跳上去;水里按住跳=向上游(不按就往下沉,沉到头进水战斗就被防溺水抢走) */
  private autoJump(bot: Bot, dx?: number, dz?: number): void {
    if (this.swingPhase === 'hop') return;
    if (bodyInWater(bot)) { bot.setControlState('jump', true); return; }
    const len = dx === undefined || dz === undefined ? 0 : Math.hypot(dx, dz);
    const ax = len > 1e-6 ? dx! / len : -Math.sin(bot.entity.yaw);
    const az = len > 1e-6 ? dz! / len : -Math.cos(bot.entity.yaw);
    const ahead = bot.entity.position.offset(ax * 0.8, 0, az * 0.8);
    const feet = bot.blockAt(ahead);
    const head = bot.blockAt(ahead.offset(0, 1, 0));
    const blocked = feet?.boundingBox === 'block' && head?.boundingBox !== 'block';
    bot.setControlState('jump', Boolean(blocked) && bot.entity.onGround);
  }

  // —— v7 盾与出手 ————————————————————————————————————————————

  private raiseShield(bot: Bot): void {
    const off = (bot.inventory.slots[45] as { name?: string } | null)?.name;
    if (off !== 'shield') return;
    try { bot.activateItem(true); this.shieldUp = true; } catch { /* noop */ }
  }

  private lowerShield(bot: Bot): void {
    if (!this.shieldUp) return;
    try { bot.deactivateItem(); } catch { /* noop */ }
    this.shieldUp = false;
  }

  /** 远程怪在射程内且近处没贴脸的就举着;出手前放下(抬起要 5 tick 才生效) */
  private shieldLogic(bot: Bot, foes: Foe[], now: number): void {
    const ranged = foes.some((f) => RANGED.has(f.name) && f.flat < 18);
    const closeMelee = foes.some((f) => !RANGED.has(f.name) && f.reach < 3.2);
    const want = ranged && !closeMelee && now >= this.shieldHoldUntil;
    if (want && !this.shieldUp) this.raiseShield(bot);
    if (!want && this.shieldUp) this.lowerShield(bot);
  }

  private canSwing(now: number): boolean {
    return this.bot !== null && now - this.lastSwingAt >= meleeCooldownMs(this.bot);
  }

  /**
   * 出手。前摇排进冷却窗口(prep,单独值 1.6×):横扫站定 100ms、跳劈起跳约 300ms,
   * 不是冷却好了再准备——提前 lead 毫秒进入前摇,冷却一满正好在暴击/横扫的姿态上。
   */
  private tryOffense(target: Foe, mode: 'crit' | 'kb' | 'sweep', now: number): void {
    const bot = this.bot!;
    const inReach = target.reach <= REACH_MAX;
    const cd = meleeCooldownMs(bot);
    const left = cd - (now - this.lastSwingAt);
    const ready = left <= 0;

    if (this.swingPhase === 'hop') {
      const vy = bot.entity.velocity?.y ?? 0;
      if (vy < -0.05 && ready) { bot.setControlState('jump', false); this.swing(bot, target, now); return; }
      if (now > this.phaseUntil) {
        bot.setControlState('jump', false);
        if (ready) this.swing(bot, target, now);
        else this.swingPhase = 'idle';
      }
      return;
    }
    if (this.swingPhase === 'settle') {
      if (now >= this.phaseUntil && ready) { this.swing(bot, target, now); return; }
      if (now > this.phaseUntil + 400) this.swingPhase = 'idle';
      return;
    }
    if (!inReach) return;
    // 隔着方块不出手:打得中也不打(镜头里像开挂),E5 那边同样不算「够得着」
    if (!this.losTo(bot, target)) return;

    const lead = mode === 'crit' ? 300 : 100;
    if (left > lead) return;

    if (mode === 'crit') {
      if (bot.entity.onGround) {
        bot.setControlState('sprint', false);
        bot.setControlState('jump', true);
        this.swingPhase = 'hop';
        this.phaseTargetId = target.id;
        this.phaseUntil = now + 450 + Math.max(0, lead);
      }
      return;
    }
    if (mode === 'sweep') {
      this.swingPhase = 'settle';
      this.phaseTargetId = target.id;
      this.phaseUntil = now + 100;
      return;
    }
    if (!ready) return;
    // kb:命中瞬间要在疾跑;控制状态下一 tick 才发包,先按住攒一 tick 再出手。
    // 攒不出疾跑就别一直攒——冷却空转半秒,软伤害也比不出手强
    // 水里疾跑攒不出来:别为它空转冷却,到点就出手
    const overdue = now - this.lastSwingAt > cd + 500 || bodyInWater(bot);
    if (!overdue && (!bot.controlState.sprint || now - this.sprintSince < 60)) {
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      if (this.sprintSince === 0) this.sprintSince = now;
      return;
    }
    this.swing(bot, target, now);
    this.wtapUntil = now + 120;
  }

  private swing(bot: Bot, target: Foe, now: number): void {
    this.swingPhase = 'idle';
    if (this.shieldUp) { this.lowerShield(bot); this.shieldHoldUntil = now + 250; }
    try { bot.attack(target.ent as never); } catch { /* 实体刚没 */ }
    this.lastSwingAt = now;
    this.swings += 1;
    this.lastSwingTargetId = target.id;
    this.struck.add(target.id);
  }

  // —— 撤退与收尾 ————————————————————————————————————————————

  private beginRetreat(why: 'flee' | 'mc_stop' | 'no-fight'): void {
    this.cancelRanged();
    const bot = this.bot;
    if (!bot?.entity) { this.end('gone'); return; }
    // 没打起来就直接撤(E7 / 血线挡下):E4 滑窗记的是这一场,起点得是现在,
    // 否则 end() 会把上一场的开始时刻算成本场时长
    if (this.state === 'idle') {
      this.startedAt = Date.now();
      this.deadIds.clear();
    }
    this.state = 'retreating';
    this.retreatWhy = why;
    const now = Date.now();
    this.retreatStartedAt = now;
    this.swingPhase = 'idle';
    if (this.pathing) { this.pathing = false; dropOwnedGoal(bot, 'combat', '转撤退', this.opts.diag); }
    this.lowerShield(bot);
    const foes = this.scan(bot, this.opts.tuning(), RETREAT_CLEAR_DIST);
    let cx = 0, cz = 0;
    for (const f of foes) { cx += f.pos.x; cz += f.pos.z; }
    this.retreatFrom = foes.length > 0
      ? { x: cx / foes.length, z: cz / foes.length }
      : { x: bot.entity.position.x + 1, z: bot.entity.position.z };
    this.retreatHits = 0;
    // 触发这场撤退的那次伤害也属于安全时窗；否则第一拍实体表短暂丢失就会立刻收工。
    this.retreatLastHurtAt = now;
    this.retreatSafeSince = 0;
    this.retreatProgressAt = now;
    this.retreatProgressPos = {
      x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
    };
    this.retreatEscalated = false;
    this.retreatBarehandNoted = false;
    this.retreatEdgeNoted = false;
    // 在水里"拉开 N 格"是永远追不上的目标(溺尸游得比人快),赢法只有出水:目标改成最近的岸
    this.retreatBank = bodyInWater(bot) ? findBankCell(bot, this.retreatFrom, 16) : null;
    if (this.retreatBank) {
      const b = this.retreatBank;
      this.opts.diag?.write({
        lane: 'combat', event: 'retreat-to-bank',
        msg: `在水里撤退:朝 (${b.x}, ${b.y}, ${b.z}) 的登岸点游`,
        data: { bank: b },
      });
    }
  }

  /** 撤退:背对怪群疾跑;距离安全并守住无伤时窗才收,到时仍危险就升级策略 */
  private retreatTick(bot: Bot, now: number): void {
    const from = this.retreatFrom!;
    const p = bot.entity.position;
    const foes = this.scan(bot, this.opts.tuning(), RETREAT_CLEAR_DIST);
    const nearest = foes.reduce((m, f) => Math.min(m, f.flat), 99);
    const last = this.retreatProgressPos;
    if (!last || Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) >= 1) {
      this.retreatProgressAt = now;
      this.retreatProgressPos = { x: p.x, y: p.y, z: p.z };
    }
    const stalled = now - this.retreatProgressAt >= RETREAT_STALL_MS;
    const recentlyHurt = now - this.retreatLastHurtAt < RETREAT_SAFE_HOLD_MS;
    const inWater = bodyInWater(bot);
    if (this.retreatBank && !inWater) this.retreatBank = null; // 上岸了,剩下按老样子拉开
    // 游向岸比跑步慢:有登岸目标时放宽时限,别在半程收工又被追回水里
    const maxMs = this.retreatBank ? RETREAT_MAX_MS * 2 : RETREAT_MAX_MS;
    const timedOut = now - this.retreatStartedAt >= maxMs;

    // 跑不掉时近战按贴身判据还手；远程目标须持续命中且撤退无进展。
    // RETREAT_MAX_MS 到期只升级撤退策略，不单独触发转身还手。
    const fightable = foes.filter((f) => !NO_FIGHT.has(f.name)).sort((a, b) => a.reach - b.reach);
    if (this.retreatWhy === 'flee' && fightable.length > 0) {
      const threat = fightable[0];
      const closeCornered = this.retreatHits >= 2 && now - this.retreatStartedAt >= 1_500 && threat.reach <= 3.2;
      const rangedCornered = this.retreatHits >= 2 && recentlyHurt && stalled;
      if (closeCornered || rangedCornered) {
        if (this.turnAndFight(bot, threat, now, closeCornered ? 'close' : 'stalled')) return;
      }
    }

    // 撤退证伪的另一面:跑不动、也没人打。这不是把撤退记成成功 —— 是它已经证明
    // 自己什么都挡不住,身体该还给任务;再挨打 `onHurtBy` 照常重开这一场。
    if (timedOut && stalled && now - this.retreatLastHurtAt >= RETREAT_IDLE_MS) {
      this.opts.emit(
        `跑不动,也没人打我——${nearest < 99 ? `最近的还在 ${Math.round(nearest)} 格外` : '附近也没怪了'},先把手还回去。(生命 ${this.hp()}/20)`,
        true, false,
      );
      this.opts.diag?.write({
        lane: 'combat', event: 'retreat-idle',
        msg: `撤退 ${Math.round((now - this.retreatStartedAt) / 1000)}s 无位移且 ` +
          `${Math.round((now - this.retreatLastHurtAt) / 1000)}s 无伤:收工,最近威胁 ${Math.round(nearest * 10) / 10} 格`,
        data: { nearest, hits: this.retreatHits, why: this.retreatWhy },
      });
      this.end('stuck');
      return;
    }

    // 计时只触发策略升级。打不过的目标和明确 mc_stop 不强行改成反击，但也不能
    // 把威胁还在附近的状态写成成功；继续持有撤退身体并只记一次升级事实。
    if (timedOut && nearest <= RETREAT_CLEAR_DIST && !this.retreatEscalated) {
      this.retreatEscalated = true;
      this.opts.diag?.write({
        lane: 'combat', event: 'retreat-extended',
        msg: `撤退到时仍不安全:最近威胁 ${Math.round(nearest * 10) / 10} 格,继续撤`,
        data: { nearest, hits: this.retreatHits, stalled, why: this.retreatWhy },
      });
    }

    const distanceSafe = nearest > RETREAT_CLEAR_DIST && !inWater;
    if (distanceSafe) {
      if (this.retreatSafeSince === 0) this.retreatSafeSince = now;
    } else {
      this.retreatSafeSince = 0;
    }
    if (
      distanceSafe &&
      now - this.retreatSafeSince >= RETREAT_SAFE_HOLD_MS &&
      now - this.retreatLastHurtAt >= RETREAT_SAFE_HOLD_MS
    ) {
      const doneWhy = this.retreatWhy;
      this.opts.emit(
        doneWhy === 'flee'
          ? `跑开了,喘口气。生命 ${this.hp()}/20。`
          : `撤出来了。生命 ${this.hp()}/20。`,
        false, false,
      );
      this.end(doneWhy === 'mc_stop' ? 'mc_stop' : 'flee');
      return;
    }
    const to = this.retreatBank;
    let dx = to ? to.x + 0.5 - p.x : p.x - from.x;
    let dz = to ? to.z + 0.5 - p.z : p.z - from.z;
    // 背对怪群那个方向前面是悬崖、岩浆或虚空时,换成左右两侧里踩得住的那边;都踩不住就原地不动
    if (!to && !footingAhead(bot, dx, dz)) {
      const side = ([[-dz, dx], [dz, -dx]] as const).find(([sx, sz]) => footingAhead(bot, sx, sz));
      if (!this.retreatEdgeNoted) {
        this.retreatEdgeNoted = true;
        this.opts.diag?.write({
          lane: 'combat', event: 'retreat-edge',
          msg: `撤退方向前面没有 ${RETREAT_MAX_DROP} 格内的落脚:${side ? '改走侧面' : '两侧也没有,原地不动'}`,
          data: { at: { x: p.x, y: p.y, z: p.z }, dx, dz },
        });
      }
      if (!side) {
        for (const k of ['forward', 'back', 'left', 'right', 'sprint'] as const) bot.setControlState(k, false);
        return;
      }
      [dx, dz] = side;
    }
    void bot.lookAt(new Vec3(p.x + dx * 4, p.y + EYE, p.z + dz * 4), true).catch(() => undefined);
    this.pressToward(bot, dx, dz, true);
    this.autoJump(bot, dx, dz);
  }

  /**
   * 撤退失败后转身还手，重新选择武器；本场不再检查 E2 和普通入场血线，
   * E1/E3/E5/E8 仍生效。无近战武器、无可用远程且低于 fleeHealth + ENGAGE_MARGIN
   * 时返回 false 并继续撤退。
   */
  private turnAndFight(bot: Bot, glued: Foe, now: number, cause: 'close' | 'stalled'): boolean {
    const line = this.opts.tuning().fleeHealth + ENGAGE_MARGIN;
    if (!bestWeapon(bot) && !this.rangedReady(bot) && (bot.health ?? 20) < line) {
      if (!this.retreatBarehandNoted) {
        this.retreatBarehandNoted = true;
        this.opts.diag?.write({
          lane: 'combat', event: 'cornered-barehand',
          msg: `撤退受阻(${cause})但空手、生命 ${this.hp()}/20 低于 ${line}:不转身还手,继续撤`,
          data: { cause, hits: this.retreatHits, foe: glued.name, distance: glued.flat, health: bot.health, line },
        });
      }
      return false;
    }
    this.desperate = true;
    this.state = 'fighting';
    this.retreatBank = null;
    this.deadlineAt = now + this.opts.tuning().maxSec * 1000;
    this.lastProgressAt = now;
    this.lastRealProgressAt = now;
    this.lastLandedAt = now;
    this.lastStatusAt = now;
    this.emptySince = 0;
    this.swingPhase = 'idle';
    this.targetId = glued.id;
    this.hybridWeapon = 'melee';
    this.rangedOwner = {};
    this.rangedPendingOwner = null;
    this.nextRangedAt = now;
    const held = this.armMelee(bot);
    const pressure = glued.reach <= 3.2 ? '还咬着我' : '还在远处压着我';
    this.opts.emit(`跑不掉,${zhEntity(glued.name)}${pressure}——回头打!(生命 ${this.hp()}/20${held})`, true, true);
    this.opts.diag?.write({
      lane: 'combat', event: 'cornered',
      msg: `撤退失败(${cause}):挨了 ${this.retreatHits} 下,${glued.name}在 ${Math.round(glued.flat * 10) / 10} 格:转身还手,生命 ${this.hp()}/20`,
      data: { cause, hits: this.retreatHits, foe: glued.name, distance: glued.flat, health: bot.health },
    });
    return true;
  }

  /**
   * 环境自保夺权(岩浆/溺水):立刻放开身体,静默收工——由环境反射自己汇报,
   * 战斗这边不抢话。优先级 ENV > FIGHT > TASK 里的那一道。
   */
  yieldToEnv(): void {
    if (this.state !== 'idle') this.end('env');
  }

  /**
   * `queue:"now"` 夺手:她说的「现在」就是现在,战斗也放下。
   *
   * 与 `mc_stop` 的收手分得开:那一条要撤退,而撤退期间身体仍归战斗,新任务照样
   * 跑不起来;这一条当场把身体交还,任务立刻开跑。交还后留一小段不自动进场的宽限
   * —— 250ms 巡检会在下一拍把刚开跑的任务重新挂起,那就等于什么都没改。挨打仍走
   * `onHurtBy`(宽限期内它退回反射的降级行为),环境反射照旧在两者之上。
   *
   * 返回刚才在做什么(受理回执照实说一句);本来就空闲返回 null。
   */
  standDown(): string | null {
    if (this.state === 'idle') return null;
    // queue:"now" 只更新普通任务意图，不清除受击和无进展记录。
    // 低血、绝境战斗或距上次受击不足 RETREAT_IDLE_MS 的撤退仍持有身体，急件须等待。
    const now = Date.now();
    const retreatStillSaving = this.state === 'retreating' && now - this.retreatLastHurtAt < RETREAT_IDLE_MS;
    if (retreatStillSaving || this.desperate || (this.bot?.health ?? 0) < this.opts.tuning().fleeHealth) {
      this.opts.diag?.write({
        lane: 'combat', event: 'stand-down-deferred',
        msg: `queue:"now" 未夺走救命动作:${retreatStillSaving ? '撤退中刚挨过打' : `生命 ${this.hp()}/20`}`,
        data: { state: this.state, health: this.bot?.health, hits: this.retreatHits },
      });
      return null;
    }
    const what = '正在跟怪打';
    this.cooldownUntil = Date.now() + STAND_DOWN_GRACE_MS;
    this.opts.diag?.write({
      lane: 'combat', event: 'stand-down',
      msg: `queue:"now" 夺手:${what},当场交还身体,${STAND_DOWN_GRACE_MS / 1000}s 内不自动进场`,
      data: { was: this.state, graceMs: STAND_DOWN_GRACE_MS },
    });
    this.opts.emit('先不打了,这件事更急。', false, false);
    this.end('preempt');
    return what;
  }

  /** mc_stop:收手 + 撤退(原地站住等于送死)。返回给工具回执的一句话 */
  requestStop(): string | null {
    if (this.state === 'idle') return null;
    if (this.state === 'retreating') return '正在撤了';
    this.beginRetreat('mc_stop');
    return '收手了,正在撤离';
  }

  private endClear(): void {
    const totalKills = [...this.kills.values()].reduce((a, b) => a + b, 0);
    const what = totalKills > 0
      ? `打完了,干掉 ${[...this.kills].map(([n, c]) => `${zhEntity(n)}${c > 1 ? `×${c}` : ''}`).join('、')}。`
      : '它们散了,没打起来。';
    this.opts.emit(
      `${what}刀 ${this.swings} 次命中 ${this.meleeLanded()} 次,` +
        `箭 ${this.arrows} 支命中 ${this.rangedLanded} 次;生命 ${this.hp()}/20。`,
      true,
      false,
    );
    this.end('clear');
  }

  private busyRatioNow(): number {
    const now = Date.now();
    const from = now - BUSY_WINDOW_MS;
    while (this.busyLog.length > 0 && this.busyLog[0].to < from) this.busyLog.shift();
    let busy = 0;
    for (const b of this.busyLog) busy += Math.min(b.to, now) - Math.max(b.from, from);
    return busy / BUSY_WINDOW_MS;
  }

  private end(reason: EndReason): void {
    if (this.state === 'idle') return;
    this.cancelRanged();
    const bot = this.bot;
    this.state = 'idle';
    this.desperate = false;
    this.retreatBank = null;
    this.unhook();
    if (bot?.entity) {
      this.release(bot);
      // 统一交还身体；releaseBody 保留反射登记的逃生目标。
      releaseBody(bot, `战斗收工(${reason})`, this.opts.diag, 'combat');
    }
    this.pathing = false;
    this.busyLog.push({ from: this.startedAt, to: Date.now() });
    this.provoked.clear();
    // 够不着收工的怪下一拍还在圈里:不设冷却就是 1 秒一开(见 STUCK_COOLDOWN_MS)
    if (reason === 'stuck') this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + STUCK_COOLDOWN_MS);
    this.opts.diag?.write({
      lane: 'combat', event: 'end',
      msg: `收工(${reason}),${Math.round((Date.now() - this.startedAt) / 1000)}s,` +
        `击杀 ${[...this.kills.values()].reduce((a, b) => a + b, 0)},` +
        `挥刀 ${this.swings} 次命中 ${this.meleeLanded()} 次,` +
        `放箭 ${this.arrows} 支命中 ${this.rangedLanded} 次,生命 ${this.hp()}/20`,
      data: {
        reason, ms: Date.now() - this.startedAt, kills: Object.fromEntries(this.kills),
        swings: this.swings, arrows: this.arrows, meleeLanded: this.meleeLanded(),
        rangedLanded: this.rangedLanded, landed: this.landed,
      },
    });
    // 只有正常战斗收尾解冻断点。断线、环境夺权、外部抢占与死亡各自由其终态边界
    // 处理冻结队列；在这里泵回会让任务进入已断线或正在交权的执行器。
    const resumable = reason === 'clear' || reason === 'flee' || reason === 'timeout' ||
      reason === 'stuck' || reason === 'mc_stop' || reason === 'busy';
    const resumed = resumable ? this.opts.resumeTasks() : null;
    if (resumed) {
      this.opts.emit(`${resumed}。`, false, false);
    }
  }

  private release(bot: Bot): void {
    // sneak 也在名单里:寻路器交互放置失败时是**故意**留着它的
    // (index.js:557-566 只在放成那一支才 sneak=false),战斗夺手正好夹在中间,
    // 于是"战后一直半蹲着走"的残留没人收
    for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak'] as const) {
      bot.setControlState(k, false);
    }
    this.lowerShield(bot);
  }

  private cancelRanged(): void {
    this.rangedOwner = null;
    this.rangedPendingOwner = null;
    this.hybridWeapon = 'melee';
    this.opts.ranged?.abort();
  }
}
