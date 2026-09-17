/**
 * 走到那里:寻路一次的时限与卡死判据、寻路目标归谁、走不通时的试算现场。
 *
 * 技能族要挪动身体一律经这里;谁占着寻路目标由 goalOwner 一处记账,抢占按归属判。
 */
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { nowIso } from '../../core/util.ts';
import {
  Aborted, SkillBlocked, checkAbort, sleep, type RouteProbe, type SkillContext, type TargetDiag,
} from './skill-context.ts';
import { DIRECTION_ZH, bearing } from './terrain.ts';
import { cellText, dimensionOf, feetOf } from './cell-facts.ts';
import { MinecraftLog } from './log.ts';
import { zhName } from './names.ts';
import { fmtDur, zhErrorText } from './receipt.ts';
import { type Cell } from './geometry.ts';
import { probabilisticDropsOf } from './inventory.ts';
import { PLACE_REACH } from './cell-facts.ts';

export const { goals } = pathfinderPkg;

/** 单次寻路上限；超时按不可达处理。 */
export const GOTO_DEADLINE_MS = 120_000;

/**
 * 未刷新离目标最近距离的无进展时限；寻路器 isMining/isBuilding 期间暂停此计时。
 * 到期结束当前步，并释放该步持有的 escape.active。
 */
export const GOTO_STALL_MS = 10_000;
/** 挖掘或搭建期间的无进展时限；距离刷新低值时归零，防止工作状态无限延长等待。 */
export const GOTO_WORK_STALL_MS = 25_000;
/** 距离要缩到比历史最近还少这么多才算真前进了;更小的变化是寻路器的抖动 */
export const GOTO_STALL_EPS = 1;
/** 净位移超过此格数也视为进展，允许绕路；按净位移而非累计路程判断。 */
export const GOTO_STALL_MOVE = 8;
/**
 * 这一段里净位移没超过这么多 = 人根本没挪过窝,不是"绕远路没更近"。
 *
 * 两者的招不一样:钉在原地要先解卡(见 `unwedgeBody`),绕远路要换目标或拆航点。
 * 1.5 格是一格多一点,容得下站位抖动与被水流顶开的幅度。
 */
export const GOTO_WEDGE_MOVE = 1.5;

/** flee 的独立时限；到期按受阻终态报告耗时、已拉开距离及剩余威胁。 */
export const FLEE_DEADLINE_MS = 30_000;

/**
 * 水平行军只判 XZ，半径 2 格容纳台阶和半砖落脚。
 * 下坠上限由 Movements.maxDropDown 控制，不由目标高度限制。
 */
export function levelTravelGoal(x: number, z: number): InstanceType<typeof goals.GoalNearXZ> {
  return new goals.GoalNearXZ(x, z, 2);
}

/** 超过这些数就把试算附进回执(只管啰不啰嗦,不管走不走) */
export const ROUTE_PLACE_LIMIT = 12;
export const ROUTE_BREAK_LIMIT = 20;
export const ROUTE_PROGRESS_MIN = 16;

export const PROBE_LABEL: Record<RouteProbe['profile'], string> = {
  style: '按当前风格', dig: '只挖不垫', walk: '只靠走',
};

/**
 * 闸门拒绝理由里的回读时刻(HH:MM:SS)。技能层拿不到执行器的时区配置,用默认那档;
 * 它与执行器的 `clock()` 同一口径。
 */
export function readStamp(): string {
  return nowIso('Asia/Shanghai').slice(11, 19);
}

/** 与判决同口径的距离文案:2.4 显示 2.4,别四舍五入成"2 格却不放行"的自相矛盾 */
export function fmtDist(d: number): string {
  return Number.isInteger(d) ? String(d) : d.toFixed(1);
}

/**
 * 目标格分诊的一句话;`open` 与缺席都返回 null。
 *
 * 这是当场读得出的世界读数(落脚预检 O(27) + 死角灌水),比寻路器的
 * "限时内没算完"硬——超时只说明 A* 没搜完,分诊说明搜什么都没用。
 */
export function diagText(diag: TargetDiag | null | undefined): string | null {
  if (diag?.kind === 'noStand') return '目标那一格站不进人:它和四周都被方块占着';
  if (diag?.kind === 'sealed') return `目标封在一个约 ${diag.size} 格的死角里`;
  return null;
}

/** 试算菜单渲染:goto 的 dryRun、走不到的受阻现场、代价偏高时的完成回执共用同一份文本 */
export function renderRouteMenu(
  probes: RouteProbe[],
  target: { x: number; y: number; z: number },
  opts?: { startDist?: number; diag?: TargetDiag | null; head?: string },
): string {
  const head = [opts?.head ?? `探路到 (${target.x}, ${target.y}, ${target.z}):`];
  const diagLine = diagText(opts?.diag);
  if (diagLine) head.push(diagLine);
  // 已有目标格分诊结论时省略出发距离；超时不解释为距离过远或绕路。
  const near = diagLine || opts?.startDist === undefined ? null
    : `出发点离目标 ${Math.round(opts.startDist)} 格`;
  const lines = probes.map((p) => {
    const label = `${PROBE_LABEL[p.profile]}:`;
    switch (p.status) {
      case 'complete': {
        const bits = [`走 ${p.steps} 步`];
        if (p.place > 0) bits.push(`垫 ${p.place} 块`);
        if (p.breaks > 0) bits.push(`挖 ${p.breaks} 块`);
        return label + bits.join(',');
      }
      case 'partial': return label + `只有部分路,能推进到离目标 ${fmtDist(p.endDist)} 格`;
      case 'timeout': return label + (near ? `限时内没算完(${near})` : '限时内没算完');
      // 三份试算同因全灭时,光说"算不出路"三遍会把她引向目标;起点锁死是另一回事
      case 'noPath': return label + (
        p.visited === undefined ? '算不出路'
          : p.visited <= 1 ? '算不出路:从我站的这一格一步都迈不出去'
            : `算不出路(从出发点铺开试了 ${p.visited} 个落脚点)`
      );
    }
  });
  return `${head.join('\n')}\n- ${lines.join('\n- ')}`;
}

/** 方位短语:目标相对我在哪个方向多远、高差几格 */
export function whereFromMe(bot: Bot, target: { x: number; y: number; z: number }): string {
  const me = bot.entity.position;
  const dir = bearing(target.x - me.x, target.z - me.z);
  const away = Math.round(Math.hypot(target.x - me.x, target.y - me.y, target.z - me.z));
  const dy = Math.round(target.y - me.y);
  const height = dy >= 2 ? `,比我高 ${dy} 格` : dy <= -2 ? `,比我低 ${-dy} 格` : '';
  return `${dir ? DIRECTION_ZH[dir] + '边' : '就在脚边'}约 ${away} 格${height}`;
}

/**
 * 受阻回执附位置、目标高差和三种路线试算；行动选择留给 agent。
 * 目标格分诊结论优先呈现，A* 超时信息随后。
 */
export function withRouteScene(
  bot: Bot, ctx: SkillContext, err: unknown, target: { x: number; y: number; z: number },
  extra: string[] = [],
  /** 这一趟实际下达的目标;水平行军必须递进来,否则试算判的是另一个目标 */
  goal?: InstanceType<typeof goals.Goal>,
): unknown {
  if (!(err instanceof SkillBlocked)) return err;
  const me = bot.entity.position;
  // 目标格分诊问的是"那一格站不站得进人",只对精确坐标目标成立。水平行军的 target.y
  // 是脚下高度凑出来的、根本不是目标的一部分,拿它去分诊会凭空造出「站不进人」。
  const diag = goal ? null : ctx.probeTarget?.(target) ?? null;
  const scene = [
    ...extra,
    `我在 (${Math.round(me.x)}, ${Math.round(me.y)}, ${Math.round(me.z)}),目标在${whereFromMe(bot, target)}`,
  ];
  const probes = ctx.probeRoutes?.(target, goal);
  if (probes && probes.length > 0) {
    const startDist = Math.hypot(me.x - target.x, me.y - target.y, me.z - target.z);
    scene.push(renderRouteMenu(probes, target, { startDist, diag }));
  }
  const lead = diagText(diag);
  return new SkillBlocked(lead ? `${lead};${err.message}` : err.message, [...err.scene, ...scene]);
}

/**
 * 这一趟里挖不动、被寻路器绕开的格子。退避本身是机械兜底(不重规划就打满物理刻),
 * 但「路上有一格挖不动」是关于世界的事实,受阻回执里必须看得见。
 */
export function digBackoffScene(ctx: SkillContext, since: number): string[] {
  const cells = ctx.digBackoffSince?.(since) ?? [];
  if (cells.length === 0) return [];
  return [`${cells.map(cellText).join('、')} 连续挖不动,绕开了`];
}

/** 这一条试算贵不贵——只决定回执里啰不啰嗦,不决定走不走 */
export function routeCostly(p: RouteProbe, startDist: number): boolean {
  if (p.status === 'complete') {
    return p.place > ROUTE_PLACE_LIMIT || p.breaks > ROUTE_BREAK_LIMIT;
  }
  // timeout 与 partial 一样带着"算到哪了":A* 到点返回的是目前最好的部分路。
  // 尽头已贴着目标 = 实质可达;推进足够 = 远目标只算得出前半段的长途常态
  if (p.endDist <= 2.5) return false;
  return startDist - p.endDist < ROUTE_PROGRESS_MIN;
}

/**
 * 出发前试算一次。
 *
 * **目标本身进不去**(站不进人、封在死角)是事实,拦下——确认一万次也走不到。
 * **路贵不贵**是权衡,不拦:三种走法的数字附进回执,要不要换归 agent(她有 mc_stop)。
 * 旧版在这里设阈值代她判"这条路太贵不许走",每触发一次烧一整轮,还误杀过有完整路的目标。
 *
 * 返回值是要附进回执的试算文本;代价平常时为 null(不啰嗦)。
 */
export function routeNote(bot: Bot, ctx: SkillContext, target: { x: number; y: number; z: number }): string | null {
  const probes = ctx.probeRoutes?.(target);
  if (!probes || probes.length === 0) return null;
  const style = probes.find((p) => p.profile === 'style') ?? probes[0];
  const me = bot.entity.position;
  const startDist = Math.hypot(me.x - target.x, me.y - target.y, me.z - target.z);
  const diag = style.status !== 'complete' ? ctx.probeTarget?.(target) ?? null : null;
  if (diag && diag.kind !== 'open') {
    throw new SkillBlocked(renderRouteMenu(probes, target, { startDist, diag }));
  }
  if (!routeCostly(style, startDist)) return null;
  return renderRouteMenu(probes, target, { startDist, diag, head: '出发前按三种走法的试算:' });
}

export interface PathSupportFailure {
  seq: number;
  generation: number;
  was: string;
  x: number;
  y: number;
  z: number;
}

export function pathSupportFailureOf(bot: Bot): PathSupportFailure | null {
  return (bot as unknown as { pathSupportFailure?: PathSupportFailure }).pathSupportFailure ?? null;
}

/**
 * 谁下的这个寻路目标。
 *
 * `escape` = 反射的救命目标(登岸/逃岩浆/低血脱离),`task` = 执行器的技能,
 * `combat` = 战斗会话,`fall` = 深坠反射,`path-support` = 寻路器搭路支撑没被
 * 服务端确认时的自撤,`link` = 断线/停机这类连接层收尾。
 */
export type GoalOwnerKind = 'task' | 'combat' | 'escape' | 'fall' | 'path-support' | 'link';

/** 一次登记:这张目标是谁下的、为了什么、什么时候 */
export interface GoalOwnerRecord {
  goal: InstanceType<typeof goals.Goal>;
  kind: GoalOwnerKind;
  intent: string;
  at: number;
}

/**
 * 寻路目标按 bot 实例登记所有权；允许覆盖，但必须给出理由并记录 diag。
 * 重连更换实例后，旧实例的登记失效。
 */
export const goalOwners = new WeakMap<object, GoalOwnerRecord>();

/** 此刻真正挂在寻路器上的那张目标的登记;已经被换掉/撤掉的登记不算数 */
export function goalOwnerOf(bot: Bot | null | undefined): GoalOwnerRecord | null {
  if (!bot) return null;
  const rec = goalOwners.get(bot);
  if (!rec) return null;
  const live = bot.pathfinder?.goal ?? null;
  return live !== null && live === rec.goal ? rec : null;
}

/** 当前寻路目标归谁;没有目标(或没登记过)为 null。给探针与回执读 */
export function goalOwnerKind(bot: Bot | null | undefined): GoalOwnerKind | null {
  return goalOwnerOf(bot)?.kind ?? null;
}

/** 覆盖/撤销别人的目标时落一条事实。不拦,只记 */
export function noteGoalOverride(
  prev: GoalOwnerRecord, by: GoalOwnerKind, why: string, diag: MinecraftLog | undefined,
): void {
  diag?.write({
    lane: 'body', event: 'goal-owner-override',
    msg: `${by} 覆盖了 ${prev.kind} 的寻路目标(${prev.intent}):${why}`,
    data: {
      from: prev.kind, fromIntent: prev.intent, heldMs: Date.now() - prev.at,
      by, why,
    },
  });
}

/**
 * 下寻路目标的统一入口:登记 owner,顺带把"这一下抹掉了谁的目标"记成事实。
 *
 * `dynamic` 透传给 `pathfinder.setGoal(goal, dynamic)`(跟随类目标要它)。
 */
export function setOwnedGoal(
  bot: Bot | null | undefined,
  goal: InstanceType<typeof goals.Goal>,
  kind: GoalOwnerKind,
  intent: string,
  opts?: { dynamic?: boolean; diag?: MinecraftLog },
): void {
  if (!bot?.pathfinder) return;
  noteGoalOwner(bot, goal, kind, intent, opts?.diag);
  bot.pathfinder.setGoal(goal, opts?.dynamic);
}

/**
 * 只记账不下达。`pathfinder.goto()` 自己会 `setGoal`,那条路进不了 `setOwnedGoal`,
 * 而它恰恰是执行器技能的主路 —— 不在这里记一笔,"战斗/反射把技能的目标换走了"
 * 就仍然是账外的事。目标对象同一个,身份对得上。
 */
export function noteGoalOwner(
  bot: Bot,
  goal: InstanceType<typeof goals.Goal>,
  kind: GoalOwnerKind,
  intent: string,
  diag?: MinecraftLog,
): void {
  const prev = goalOwnerOf(bot);
  if (prev && prev.kind !== kind && prev.goal !== goal) {
    noteGoalOverride(prev, kind, `改下 ${intent}`, diag);
  }
  goalOwners.set(bot, { goal, kind, intent, at: Date.now() });
}

/**
 * 通过 `setGoal(null)` 同步撤销目标并清理控制键。
 * `pathfinder.stop()` 仅设置延迟处理的 `stopPathing`，会影响紧随其后的新目标。
 *
 * `by` 是撤销方,`why` 是理由 —— 撤的是别人登记的目标时两者一起落 diag(不禁止)。
 */
export function dropGoal(
  bot: Bot | null | undefined,
  by: GoalOwnerKind = 'task',
  why = '未说明',
  diag?: MinecraftLog,
): void {
  const prev = goalOwnerOf(bot);
  if (prev && prev.kind !== by) noteGoalOverride(prev, by, `撤销:${why}`, diag);
  // 连接到 spawn 之间 pathfinder 尚未注入。
  bot?.pathfinder?.setGoal(null);
  if (bot) goalOwners.delete(bot);
}

/** 给别的 World(战斗会话、寻路器搭路自撤)用的撤销口,与执行器内部同一本账 */
export function dropOwnedGoal(
  bot: Bot | null | undefined, by: GoalOwnerKind, why: string, diag?: MinecraftLog,
): void {
  dropGoal(bot, by, why, diag);
}

/**
 * 反射停机/死亡时把逃生目标那一笔从账上撤下来(下达一路走 `setOwnedGoal`)。
 * 只清账不动寻路器 —— 那时目标要么已经另有归属,要么各自的收尾已经撤过。
 * 别人名下的那一笔不许顺手抹掉:反射停机不代表战斗的目标也作废了。
 */
export function clearEscapeGoalOwner(bot: Bot): void {
  if (goalOwners.get(bot)?.kind === 'escape') goalOwners.delete(bot);
}

/** 三条反射自救各自的说法;只出现在所有权账与回报里 */
export function escapeIntent(kind: 'drown' | 'lava' | 'flee'): string {
  return kind === 'drown' ? '登岸' : kind === 'lava' ? '逃离岩浆' : '低血脱离';
}

/** 松开右键等于发射的那几样:取消归它们自己的持有者(切槽,不放箭) */
export const RELEASE_FIRES = new Set(['bow', 'crossbow', 'trident']);

/** 此刻挂着的寻路目标是不是登记在案的那张逃生目标。 */
export function onEscapeGoal(bot: Bot): boolean {
  return goalOwnerOf(bot)?.kind === 'escape';
}

/**
 * 交还身体：撤目标、松全部控制键、停挖并结束不会在松手时发射的右键使用。
 * 当前目标由反射登记为逃生目标时，保留目标和方向键。
 */
export function releaseBody(
  bot: Bot | null | undefined,
  reason: string,
  diag?: MinecraftLog,
  /** 谁在交还身体。撤的是别人登记的目标时,这个名字和理由一起进 diag */
  by: GoalOwnerKind = 'task',
): void {
  if (!bot?.entity) return;
  const escaping = onEscapeGoal(bot);
  if (!escaping) {
    dropGoal(bot, by, `交还身体(${reason})`, diag);
    // pathfinder 的 resetPath 已经清过一遍;这一下管的是它还没注入、或目标本来就是空的时候
    try { bot.clearControlStates(); } catch { /* 台架假 bot 没有这一面 */ }
  }
  try { bot.stopDigging(); } catch { /* 没在挖 */ }
  // 松右键只对"按着不放"的那几样成立(盾、吃东西、望远镜)。弓/弩/三叉戟的松手
  // 就是**发射** —— 撤单时误放一箭正是 ranged.ts 绕开 deactivateItem、改用切槽
  // 取消的原因,身体交还这一处不许把那件事又做回去。
  if ((bot as unknown as { usingHeldItem?: boolean }).usingHeldItem === true
    && !RELEASE_FIRES.has(bot.heldItem?.name ?? '')) {
    try { bot.deactivateItem(); } catch { /* 手上没有正在用的东西 */ }
  }
  if (escaping) {
    diag?.write({
      lane: 'body', event: 'release-body-kept-escape',
      msg: `交还身体(${reason}):当前挂的是反射的逃生目标,只收了挖掘与按着的右键,目标与方向键留给它`,
      data: { reason },
    });
  }
}

/**
 * 寻路完成必须同时满足 deadline、中止状态与目标位置校验。
 * `pathfinder.goto()` 在空路径时可能 resolve，因此返回后仍需用 `goal.isEnd` 验证。
 * watchdog 仅在本次 goto 存续期间有效，不能撤销后续任务的目标。
 */
/**
 * 钉在原地跳闸时抛的内部标记:外层据它决定"解卡再来一遍"还是照实受阻。
 * 不出 World —— 两次都钉住时它会被换成 `stallBlocked` 的受阻句。
 */
export class Wedged extends Error {
  constructor(readonly stall: Stall) { super('钉在原地'); }
}

/**
 * 寻路卡住时释放控制键，再跳跃、后退和侧移解卡。
 * 必须先撤寻路目标，避免寻路器逐 tick 覆盖控制键。
 */
export async function unwedgeBody(bot: Bot, ctx: SkillContext): Promise<number> {
  const hold = async (keys: readonly string[], ms: number): Promise<void> => {
    for (const k of keys) bot.setControlState(k as never, true);
    await sleep(ms);
    for (const k of keys) bot.setControlState(k as never, false);
  };
  bot.clearControlStates();
  const before = bot.entity.position.clone();
  await hold(['jump', 'back'], 400);
  checkAbort(ctx);
  await hold(['jump', 'left'], 300);
  bot.clearControlStates();
  await sleep(200);
  const after = bot.entity.position;
  const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
  ctx.diag?.write({
    lane: 'path', event: 'goto-unwedge', taskId: ctx.taskId,
    msg: `钉在原地,跳/退解卡:挪了 ${moved.toFixed(2)} 格`,
    data: {
      moved: Number(moved.toFixed(3)),
      from: { x: Number(before.x.toFixed(3)), y: Number(before.y.toFixed(3)), z: Number(before.z.toFixed(3)) },
      to: { x: Number(after.x.toFixed(3)), y: Number(after.y.toFixed(3)), z: Number(after.z.toFixed(3)) },
    },
  });
  return moved;
}

/** 解卡挪不到这么多 = 身体是冻着的,同一个目标再等一轮静止档是白等 */
export const UNWEDGE_MOVED = 0.2;

/**
 * 寻路一段。钉在原地跳闸时先解卡:解卡挪动了就再来一遍,一动没动就直接受阻。
 *
 * 只重试这一种:绕远路、走满 deadline、支撑没确认都各有各的招,重发同一个目标只是白等。
 * 逃生路上尤其不许白等 —— 那 10 秒静止档是 flee 三十秒时限里的三分之一。
 */
export async function gotoGoal(bot: Bot, goal: InstanceType<typeof goals.Goal>, ctx: SkillContext): Promise<void> {
  let unwedged: number | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      await gotoGoalOnce(bot, goal, ctx);
      return;
    } catch (err) {
      if (!(err instanceof Wedged)) throw err;
      if (attempt > 0) throw stallBlocked(bot, err.stall, unwedged);
      unwedged = await unwedgeBody(bot, ctx);
      if (unwedged < UNWEDGE_MOVED) throw stallBlocked(bot, err.stall, unwedged);
    }
  }
}

export async function gotoGoalOnce(bot: Bot, goal: InstanceType<typeof goals.Goal>, ctx: SkillContext): Promise<void> {
  let done = false;
  let timedOut = false;
  let stalled: Stall | null = null;
  /** 钉住的那一档抛 `Wedged` 交给外层解卡;绕远路那一档照实受阻 */
  const stallError = (s: Stall): Error => (s.wedged ? new Wedged(s) : stallBlocked(bot, s));
  const deadline = Date.now() + GOTO_DEADLINE_MS;
  const supportSeq = pathSupportFailureOf(bot)?.seq ?? 0;
  const supportBlocked = (): PathSupportFailure | null => {
    const failure = pathSupportFailureOf(bot);
    return failure && failure.seq > supportSeq ? failure : null;
  };
  // pathfinder.goto() 内部自行 setGoal，须先登记目标所有权。
  noteGoalOwner(bot, goal, 'task', `技能寻路(${goal.constructor?.name ?? '目标'})`, ctx.diag);
  void (async () => {
    // 离目标的最近距离、它刷出新低的时刻与当时人在哪;heuristic 声明收 Move,实现只读 x/y/z
    let best = Infinity;
    let bestAt = Date.now();
    let bestPos = { x: 0, y: 0, z: 0 };
    // 这一段里离 bestPos 最远到过多少:区分"钉在原地"与"绕远路没更近"
    let wander = 0;
    // 上一次看到"正在挖/搭"的时刻:两段挖之间 isMining 会闪断一拍,
    // 不留观察期的话攒了一阵的账龄会把 10s 闸当场引爆
    let lastWorkAt = 0;
    while (!done) {
      // 中止由发起方撤销目标；watchdog 仅处理 deadline 与原地打转。
      if (ctx.aborted()) return;
      const now = Date.now();
      if (now > deadline) {
        timedOut = true;
        writeStallProbe(bot, ctx, goal, 'timeout');
        dropGoal(bot, 'task', '寻路到点未达', ctx.diag);
        return;
      }
      const here = bot.entity.position;
      const dist = goal.heuristic({ x: here.x, y: here.y, z: here.z } as never);
      // 挖穿一格、搭一段路的时候人本来就该站着不动:钟走慢档,不按 10 秒计——
      // 但不能停走(见 GOTO_WORK_STALL_MS:挖-放振荡全程都算"在干活")
      const working = Boolean(bot.pathfinder?.isMining?.() || bot.pathfinder?.isBuilding?.());
      // 还在挪窝就不算卡住:绕远路时直线距离可以一直不降,人却一路在走
      const moved = Math.hypot(here.x - bestPos.x, here.y - bestPos.y, here.z - bestPos.z);
      wander = Math.max(wander, moved);
      if (working) lastWorkAt = now;
      if (best === Infinity || dist <= best - GOTO_STALL_EPS || moved > GOTO_STALL_MOVE) {
        best = Math.min(best, dist);
        bestAt = now;
        bestPos = { x: here.x, y: here.y, z: here.z };
        wander = 0;
      } else if (working
        ? now - bestAt > GOTO_WORK_STALL_MS
        : now - bestAt > GOTO_STALL_MS && now - lastWorkAt > 4_000) {
        stalled = {
          best, now: dist, at: feetOf(bot), metric: goalDistanceMetric(goal),
          ms: now - bestAt, gate: working ? 'work' : 'idle',
          // 挖/搭那一档不算钉住:人本来就该站着不动
          wedged: !working && wander < GOTO_WEDGE_MOVE,
          leg: goalCell(goal),
        };
        // 撤目标之前采样:dropGoal 会把 digging/placing/控制键一起清掉,
        // 清完再看等于把要找的证据先擦了
        writeStallProbe(bot, ctx, goal, 'stall');
        dropGoal(bot, 'task', '寻路零推进', ctx.diag);
        return;
      }
      await sleep(200);
    }
  })();
  try {
    await bot.pathfinder.goto(goal);
  } catch (err) {
    // 中止时目标可能已归抢占方；此处不撤目标，撤销由 abortTask/pump 负责。
    if (ctx.aborted()) throw new Aborted(ctx.abortedBy?.() ?? null);
    dropGoal(bot, 'task', '寻路报错,技能退出', ctx.diag);
    const support = supportBlocked();
    if (support) {
      throw new SkillBlocked(
        `走不过去:搭路支撑 (${support.x}, ${support.y}, ${support.z}) 放了三次仍是${zhName(support.was)},`
        + '服务端未确认;已取消这段路径',
      );
    }
    if (stalled) throw stallError(stalled);
    if (timedOut) throw new SkillBlocked(`走不过去: 走了 ${Math.round(GOTO_DEADLINE_MS / 1000)} 秒还没到`);
    throw new SkillBlocked(`走不过去: ${zhErrorText((err as Error).message)}`);
  } finally {
    done = true;
  }
  checkAbort(ctx);
  const support = supportBlocked();
  if (support) {
    dropGoal(bot, 'task', '搭路支撑未确认', ctx.diag);
    throw new SkillBlocked(
      `走不过去:搭路支撑 (${support.x}, ${support.y}, ${support.z}) 放了三次仍是${zhName(support.was)},`
      + '服务端未确认;已取消这段路径',
    );
  }
  // 撤目标之后 goto 也可能是 resolve 而不是 reject,两条路都要认这份卡住
  if (stalled) throw stallError(stalled);
  // 半砖等位置需同时检查 floored 坐标及其上方一格，与寻路库判据一致。
  // isEnd 类型声明为 Move，但实现只读取 x/y/z。
  const p = bot.entity.position.floored();
  const at = (v: typeof p): boolean => goal.isEnd(v as never);
  if (!at(p) && !at(p.offset(0, 1, 0))) {
    dropGoal(bot, 'task', '收尾校验没到目标格', ctx.diag);
    throw new SkillBlocked('走不过去: 找不到可行路线(目标被封住,或者中间没有能走的路)');
  }
}

/** 看门狗跳闸时记录控制、寻路与持有权的结构化快照；只进诊断日志，不进回执。 */
export function writeStallProbe(
  bot: Bot, ctx: SkillContext, goal: InstanceType<typeof goals.Goal>, trip: 'stall' | 'timeout',
): void {
  const diag = ctx.diag;
  if (!diag) return;
  const pf = bot.pathfinder as unknown as {
    isMining?: () => boolean; isBuilding?: () => boolean; isMoving?: () => boolean;
    goal?: unknown; path?: unknown[];
  } | undefined;
  const e = bot.entity as unknown as {
    position?: { x: number; y: number; z: number };
    velocity?: { x: number; y: number; z: number };
    onGround?: boolean; isInWater?: boolean;
  } | undefined;
  const round3 = (v: number | undefined): number | null =>
    typeof v === 'number' ? Number(v.toFixed(3)) : null;
  const body = ctx.bodyState?.() ?? null;
  const patched = bot as unknown as {
    pathPlacementActive?: number;
    pathSupportFailure?: { seq: number };
  };
  diag.write({
    lane: 'path', event: 'goto-stall-probe', taskId: ctx.taskId,
    msg: `零位移探针(${trip === 'stall' ? '原地打转跳闸' : '走满 deadline'}):` +
      `挖=${pf?.isMining?.() ?? '?'} 搭=${pf?.isBuilding?.() ?? '?'} 走=${pf?.isMoving?.() ?? '?'}`,
    data: {
      trip,
      goalKind: goal.constructor?.name ?? null,
      isMining: pf?.isMining?.() ?? null,
      isBuilding: pf?.isBuilding?.() ?? null,
      isMoving: pf?.isMoving?.() ?? null,
      // 上游没把 path 挂出来,拿得到就记,拿不到记 null(isMoving 已经说了空不空)
      pathLen: Array.isArray(pf?.path) ? pf.path.length : null,
      goalStillMine: pf?.goal === goal,
      // 此刻这张目标记在谁名下(见 goalOwners):"目标被别人换走了"从此在案卷里认得出来
      goalOwner: goalOwnerKind(bot),
      controlState: (bot as unknown as { controlState?: Record<string, boolean> }).controlState ?? null,
      onGround: e?.onGround ?? null,
      isInWater: e?.isInWater ?? null,
      velocity: e?.velocity
        ? { x: round3(e.velocity.x), y: round3(e.velocity.y), z: round3(e.velocity.z) }
        : null,
      position: e?.position
        ? { x: round3(e.position.x), y: round3(e.position.y), z: round3(e.position.z) }
        : null,
      combatActive: body?.combatActive ?? null,
      environmentOwnerKind: body?.environmentOwnerKind ?? null,
      queueHold: body?.queueHold ?? null,
      frozenTaskId: body?.frozenTaskId ?? null,
      pathPlacementActive: patched.pathPlacementActive ?? 0,
      pathSupportSeq: patched.pathSupportFailure?.seq ?? 0,
    },
  });
}

/** 原地打转跳闸时记下的读数:最近到过多远、此刻多远、人在哪、这个"多远"是哪种口径、憋了多久 */
export interface Stall {
  best: number;
  now: number;
  at: Cell;
  /** 距离口径。GoalNearXZ 的 heuristic 只算水平,其余目标算三维直线 */
  metric: DistanceMetric;
  /** 从最近一次进展到跳闸的实际耗时，单位为毫秒。 */
  ms: number;
  /** 跳闸的是哪一档:`work` = 挖/搭那 25 秒档,`idle` = 静止那 10 秒档 */
  gate: 'idle' | 'work';
  /** 这一段里人一格都没挪过(净位移不到 `GOTO_WEDGE_MOVE`) */
  wedged: boolean;
  /** 这一段寻路目标的那一格;拿不到全部三轴时 null(GoalNearXZ 没有 y) */
  leg: Cell | null;
}

export type DistanceMetric = '水平' | '直线';

/** 当前寻路段的目标格；受阻句须区别此格与整个步骤的终点。 */
export function goalCell(goal: InstanceType<typeof goals.Goal>): Cell | null {
  const g = goal as unknown as { x?: unknown; y?: unknown; z?: unknown };
  return typeof g.x === 'number' && typeof g.y === 'number' && typeof g.z === 'number'
    ? { x: g.x, y: g.y, z: g.z }
    : null;
}

/** 寻路目标的距离口径；回执须注明水平或三维直线，不换算。 */
export function goalDistanceMetric(goal: InstanceType<typeof goals.Goal>): DistanceMetric {
  return goal instanceof goals.GoalNearXZ ? '水平' : '直线';
}

/** 到这个距离以内就不能再说「走不过去」:人已经在目标旁边了 */
export const REACHED_NEARBY_BLOCKS = 3;

/** 卡住时报告最近距离、当前距离及是否解卡成功；区分无法走近、已近但够不到和原地未动。 */
export function stallBlocked(bot: Bot, s: Stall, unwedged: number | null = null): SkillBlocked {
  const under = bot.blockAt(new Vec3(s.at.x, s.at.y - 1, s.at.z));
  // 报的是这一次实际憋了多久,不是那个 10 秒常量:钟有静止 10 秒、"正在挖/搭" 25 秒
  // 两档,`GOTO_STALL_MOVE` 每把净位移刷过 8 格就再归零一次,一路能续到两分钟的 deadline。
  // 跳闸档位一并说出来 —— "一直在挖却没更近" 与 "站着没动" 她要换的招不一样。
  const held = fmtDur(s.ms);
  const gate = s.gate === 'work' ? '(这一段一直在挖或搭)' : '';
  // 段的目标不是步的终点:点名这一格,免得同一条回执里两个"目标"指着两处
  const leg = s.leg ? `这一段的落点 ${cellText(s.leg)}` : '这一段的落点';
  const near = s.best <= REACHED_NEARBY_BLOCKS;
  const head = s.wedged
    ? `钉在原地: ${held} 一格都没挪动过,${unwedged !== null && unwedged >= UNWEDGE_MOVED
      ? `跳/退解卡挪开了 ${fmtDist(unwedged)} 格,接着走还是没动`
      : '跳/退解卡也没能动一下'};这不是路难走,是人动不了`
    : near
      ? `够不到${leg}: 已经到它旁边(${s.metric} ${fmtDist(s.best)} 格),${held} 没能再靠近一步${gate}`
      : `走不过去: ${held} 没能离${leg}更近一步${gate}`;
  return new SkillBlocked(
    `${head}(最近到过 ${s.metric} ${fmtDist(s.best)} 格,现在 ${s.metric} ${fmtDist(s.now)} 格),` +
    `人在 ${cellText(s.at)},脚下是${under ? zhName(under.name) : '空的'}`,
  );
}

/** 挖掘在不可达时立即失败，并以 deadline 限制服务端无响应。 */
export async function digBlock(bot: Bot, target: NonNullable<ReturnType<Bot['blockAt']>>, ctx: SkillContext): Promise<void> {
  // canDigBlock 与服务端使用相同的可挖掘性和 5.1 格距离约束。
  if (!bot.canDigBlock(target)) {
    throw new SkillBlocked(`够不到${zhName(target.name)}(离得太远或者隔着方块),没挖成`);
  }
  const budget = Math.max(15_000, bot.digTime(target) * 3);
  let finished = false;
  const guard = setTimeout(() => {
    if (!finished) bot.stopDigging();
  }, budget);
  try {
    await bot.dig(target);
  } catch (err) {
    if (ctx.aborted()) throw new Aborted(ctx.abortedBy?.() ?? null);
    const msg = (err as Error).message;
    if (/digging aborted/i.test(msg)) {
      throw new SkillBlocked(`挖${zhName(target.name)}挖到一半被打断了,这一块没挖完`);
    }
    throw new SkillBlocked(`挖不动${zhName(target.name)}: ${zhErrorText(msg)}`);
  } finally {
    finished = true;
    clearTimeout(guard);
  }
  // 挖掉的那一格若在容器账本上,账跟着划掉——不然几何族试算还会点名一座已经不在的工作台
  ctx.chests?.forget(dimensionOf(bot), target.position);
}

export function findEntity(bot: Bot, nameOrType: string, range = 24) {
  const me = bot.entity.position;
  let best: { e: NonNullable<Bot['entities'][string]>; d: number } | null = null;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position) continue;
    const label = e.type === 'player' ? e.username : (e.name ?? '');
    if (label?.toLowerCase() !== nameOrType.toLowerCase()) continue;
    const d = e.position.distanceTo(me);
    if (d <= range && (!best || d < best.d)) best = { e, d };
  }
  return best?.e ?? null;
}

/**
 * 方块匹配顺序：完整名称、类别前后缀、掉落物反查。
 * 掉落物反查处理 cobblestone 等物品名与来源方块名不一致的情况。
 */
export function matchBlockIds(bot: Bot, name: string): number[] {
  const byName = bot.registry.blocksByName as Record<string, { id: number; name: string; drops?: unknown[] }>;
  const ids = new Set<number>();
  if (byName[name]) ids.add(byName[name].id);
  const suffix = `_${name}`;
  for (const b of Object.values(byName)) {
    if (b.name.endsWith(suffix) || b.name.startsWith(`${name}_`)) ids.add(b.id);
  }
  const item = (bot.registry.itemsByName as Record<string, { id: number } | undefined>)[name];
  if (item) {
    for (const b of Object.values(byName)) {
      // drops 在不同版本里是 id 数字或 {drop:id} 对象;概率掉落不在简表,查补充表
      const dropsIt = (b.drops ?? []).some(
        (d) => (typeof d === 'number' ? d : (d as { drop?: number } | null)?.drop) === item.id,
      ) || probabilisticDropsOf(b.name).includes(name);
      if (dropsIt) ids.add(b.id);
    }
  }
  return [...ids];
}

/** 脚下方块挖开后的下落结束前，不读取下一格位置。 */
export async function settleOnGround(bot: Bot, ctx: SkillContext, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!bot.entity.onGround && Date.now() < deadline) {
    checkAbort(ctx);
    await sleep(100);
  }
}

/** 走到够得着那一格的地方 */
export async function reachCell(bot: Bot, c: Cell, ctx: SkillContext): Promise<void> {
  const me = bot.entity.position;
  const d = Math.hypot(me.x - (c.x + 0.5), me.y - (c.y + 0.5), me.z - (c.z + 0.5));
  if (d <= PLACE_REACH) return;
  await gotoGoal(bot, new goals.GoalNear(c.x, c.y, c.z, 2), ctx);
}

