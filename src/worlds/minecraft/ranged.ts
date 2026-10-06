import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { readDurability, type ItemLike } from './item-facts.ts';

/** 未交战时允许进入远程候选池的最大距离。感知命中本身不触发开火。 */
export const RANGED_ENTER_RANGE = 32;
/** 已进入远程交战后允许继续追踪的最大距离，避免目标在边界来回抖动。 */
export const RANGED_EXIT_RANGE = 40;
export const HYBRID_RANGED_AT = 8;
export const HYBRID_MELEE_AT = 5.5;
export const KITE_MIN_RANGE = 8;
export const KITE_MAX_RANGE = 14;
const BOW_FULL_DRAW_MS = 1_000;
export const BOW_HIT_WINDOW_MS = 1_500;

const AIM_STEP_MS = 50;
const ARROW_SPEED_PER_TICK = 3;
const ARROW_GRAVITY_PER_TICK = 0.05;
/** 原版箭每刻先位移,再把速度乘这个系数,再减重力 */
const ARROW_DRAG_PER_TICK = 0.99;
/** 箭在射手眼高下方这么多格生成 */
const ARROW_SPAWN_BELOW_EYE = 0.1;
/** 仰角从朝下往朝上逐度扫,第一个够得着目标高度的角就是低弧那一侧,再在前一度之间二分 */
const PITCH_SCAN_STEP = Math.PI / 180;
const PITCH_BISECT_ROUNDS = 20;
const MOTION_STALE_MS = 250;
const MOTION_DECAY_MS = 250;
const MOTION_MAX_BLOCKS_PER_TICK = 1.5;
const MOTION_SMOOTHING = 0.5;

type InventoryItem = ReturnType<Bot['inventory']['items']>[number];

interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface RangedTarget {
  id: number;
  position: Point3;
  height?: number;
  width?: number;
  /** 瞄的是这一格方块而不是实体:射线碰到这一格本身不算遮挡,不跟踪移动,没有近身下限 */
  cell?: Point3;
}

/** 以一格方块的中心为靶;id 为 -1,不会与任何实体的受击事件对上 */
export function cellTarget(cell: Point3): RangedTarget {
  return {
    id: -1,
    position: { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 },
    height: 0,
    width: 0,
    cell: { x: cell.x, y: cell.y, z: cell.z },
  };
}

interface PositionVelocityEstimate {
  position: Point3;
  velocityPerTick: Point3;
  ageMs: number;
}

interface PositionVelocityTrackerOptions {
  staleMs?: number;
  decayMs?: number;
  maxBlocksPerTick?: number;
  smoothing?: number;
}

interface MotionState {
  position: Point3;
  velocityPerTick: Point3;
  at: number;
  measured: boolean;
}

/** 从实体位置事件推导速度；协议的 entity.velocity 不代表普通行走速度。 */
export class PositionVelocityTracker {
  private readonly states = new Map<number, MotionState>();
  private readonly staleMs: number;
  private readonly decayMs: number;
  private readonly maxBlocksPerTick: number;
  private readonly smoothing: number;

  constructor(opts: PositionVelocityTrackerOptions = {}) {
    this.staleMs = opts.staleMs ?? MOTION_STALE_MS;
    this.decayMs = opts.decayMs ?? MOTION_DECAY_MS;
    this.maxBlocksPerTick = opts.maxBlocksPerTick ?? MOTION_MAX_BLOCKS_PER_TICK;
    this.smoothing = opts.smoothing ?? MOTION_SMOOTHING;
  }

  observe(id: number, position: Point3, at: number): void {
    const next = copyPoint(position);
    const previous = this.states.get(id);
    if (!previous) {
      this.states.set(id, { position: next, velocityPerTick: zeroPoint(), at, measured: false });
      return;
    }
    const elapsedMs = at - previous.at;
    if (elapsedMs <= 0) return;
    if (pointDistance(next, previous.position) < 1e-6) return;
    const scale = 50 / elapsedMs;
    const measured = {
      x: (next.x - previous.position.x) * scale,
      y: (next.y - previous.position.y) * scale,
      z: (next.z - previous.position.z) * scale,
    };
    if (pointNorm(measured) > this.maxBlocksPerTick) {
      this.states.set(id, { position: next, velocityPerTick: zeroPoint(), at, measured: false });
      return;
    }
    const velocityPerTick = previous.measured
      ? mixPoint(previous.velocityPerTick, measured, this.smoothing)
      : measured;
    this.states.set(id, { position: next, velocityPerTick, at, measured: true });
  }

  estimate(id: number, at: number): PositionVelocityEstimate | null {
    const state = this.states.get(id);
    if (!state) return null;
    const ageMs = Math.max(0, at - state.at);
    const decay = ageMs <= this.staleMs
      ? 1
      : this.decayMs <= 0 ? 0 : Math.max(0, 1 - (ageMs - this.staleMs) / this.decayMs);
    return {
      position: copyPoint(state.position),
      velocityPerTick: scalePoint(state.velocityPerTick, decay),
      ageMs,
    };
  }

  forget(id: number): void {
    this.states.delete(id);
  }
}

export type HybridWeapon = 'melee' | 'ranged';

/** 仅支持首期的弓和普通箭；弩、药箭和光灵箭不隐式混入。 */
export function bestRangedWeapon(bot: Bot): InventoryItem | null {
  let best: InventoryItem | null = null;
  let bestLeft = 0;
  for (const item of bot.inventory.items()) {
    if (!usableBow(item)) continue;
    const left = readDurability(item)?.left ?? 0;
    if (left > bestLeft) {
      best = item;
      bestLeft = left;
    }
  }
  return best;
}

export function hasUsableArrows(bot: Bot): boolean {
  return bot.inventory.items().some((item) => item.name === 'arrow' && item.count > 0);
}

/** 近远武器切换带 2.5 格滞回；中间区间保持当前武器。 */
export function chooseHybridWeapon(
  current: HybridWeapon,
  distance: number,
  rangedReady: boolean,
): HybridWeapon {
  if (!rangedReady) return 'melee';
  if (current === 'ranged') return distance <= HYBRID_MELEE_AT ? 'melee' : 'ranged';
  return distance >= HYBRID_RANGED_AT ? 'ranged' : 'melee';
}

export function inKiteRange(distance: number): boolean {
  return distance >= KITE_MIN_RANGE && distance <= KITE_MAX_RANGE;
}

function usableBow(item: ItemLike | null | undefined): boolean {
  return item != null && item.name === 'bow' && item.count !== 0 && (readDurability(item)?.left ?? 0) > 0;
}

function targetCenter(target: RangedTarget): Point3 {
  return {
    x: target.position.x,
    y: target.position.y + (target.height ?? 1.8) * 0.55,
    z: target.position.z,
  };
}

/** 满弓箭的低弧瞄点,按原版箭的逐刻重力与阻力算;速度由位置采样得到,单位为格/tick。 */
export function lowArcAimPoint(
  eye: Point3,
  target: RangedTarget,
  targetVelocity: Point3 = zeroPoint(),
  shooterVelocity: Point3 = zeroPoint(),
): Vec3 | null {
  const velocity = subtractPoint(targetVelocity, shooterVelocity);
  const center = targetCenter(target);
  let flightTicks = pointDistance(center, eye) / ARROW_SPEED_PER_TICK;
  let aim = new Vec3(center.x, center.y, center.z);

  for (let i = 0; i < 3; i += 1) {
    const predicted = {
      x: center.x + velocity.x * flightTicks,
      y: center.y + velocity.y * flightTicks,
      z: center.z + velocity.z * flightTicks,
    };
    const horizontal = Math.hypot(predicted.x - eye.x, predicted.z - eye.z);
    const dy = predicted.y - eye.y;
    if (horizontal < 1e-6) {
      const vertical = verticalFlight(dy);
      if (vertical === null) return null;
      flightTicks = vertical.ticks;
      aim = new Vec3(predicted.x, eye.y + vertical.direction, predicted.z);
      continue;
    }
    const arc = lowArcPitch(horizontal, dy);
    if (arc === null) return null;
    flightTicks = arc.ticks;
    aim = new Vec3(predicted.x, eye.y + horizontal * Math.tan(arc.pitch), predicted.z);
  }
  return new Vec3(aim.x, aim.y, aim.z);
}

/**
 * 仰角 pitch 射出的箭飞到水平距离 horizontal 时相对眼睛的高度与所用刻数。
 * 下落中已经低于 floor 还没飞到时返回 null:之后只会更低。
 */
function arrowHeightAt(
  pitch: number,
  horizontal: number,
  floor: number,
): { y: number; ticks: number } | null {
  let vx = ARROW_SPEED_PER_TICK * Math.cos(pitch);
  let vy = ARROW_SPEED_PER_TICK * Math.sin(pitch);
  let x = 0;
  let y = -ARROW_SPAWN_BELOW_EYE;
  let ticks = 0;
  for (;;) {
    if (x + vx >= horizontal) {
      const part = (horizontal - x) / vx;
      return { y: y + vy * part, ticks: ticks + part };
    }
    x += vx;
    y += vy;
    ticks += 1;
    vx *= ARROW_DRAG_PER_TICK;
    vy = vy * ARROW_DRAG_PER_TICK - ARROW_GRAVITY_PER_TICK;
    if (vy < 0 && y < floor) return null;
  }
}

function lowArcPitch(horizontal: number, dy: number): { pitch: number; ticks: number } | null {
  const reaches = (pitch: number): boolean => (arrowHeightAt(pitch, horizontal, dy)?.y ?? -Infinity) >= dy;
  let below: number | null = null;
  for (let pitch = -Math.PI / 2 + PITCH_SCAN_STEP; pitch < Math.PI / 2; pitch += PITCH_SCAN_STEP) {
    if (!reaches(pitch)) {
      below = pitch;
      continue;
    }
    let above = pitch;
    for (let round = 0; below !== null && round < PITCH_BISECT_ROUNDS; round += 1) {
      const mid = (below + above) / 2;
      if (reaches(mid)) above = mid;
      else below = mid;
    }
    return { pitch: above, ticks: arrowHeightAt(above, horizontal, dy)!.ticks };
  }
  return null;
}

function verticalFlight(dy: number): { ticks: number; direction: 1 | -1 } | null {
  const direction = dy >= -ARROW_SPAWN_BELOW_EYE ? 1 : -1;
  let vy = ARROW_SPEED_PER_TICK * direction;
  let y = -ARROW_SPAWN_BELOW_EYE;
  let ticks = 0;
  while (direction > 0 ? y < dy : y > dy) {
    if (direction > 0 && vy <= 0) return null;
    y += vy;
    ticks += 1;
    vy = vy * ARROW_DRAG_PER_TICK - ARROW_GRAVITY_PER_TICK;
  }
  return { ticks, direction };
}

/** 眼睛到目标半身高(方块靶为格心)的方块射线；读不到世界射线时保守地视为遮挡。 */
export function hasRangedLos(bot: Bot, target: RangedTarget): boolean {
  try {
    const entity = bot.entity as Bot['entity'] & { eyeHeight?: number };
    const eye = new Vec3(
      entity.position.x,
      entity.position.y + (entity.eyeHeight ?? 1.62),
      entity.position.z,
    );
    const center = targetCenter(target);
    const delta = new Vec3(center.x - eye.x, center.y - eye.y, center.z - eye.z);
    const distance = delta.norm();
    if (distance < 0.5) return true;
    const hit = (bot.world as unknown as {
      raycast(
        from: Vec3,
        direction: Vec3,
        range: number,
        matcher?: (block: unknown) => boolean,
      ): unknown;
    }).raycast(
      eye,
      delta.scaled(1 / distance),
      distance,
      (block) => {
        const b = block as { boundingBox?: string; position?: Point3 } | null;
        if (b?.boundingBox !== 'block') return false;
        const cell = target.cell;
        return !(cell && b.position && b.position.x === cell.x && b.position.y === cell.y && b.position.z === cell.z);
      },
    );
    return hit == null;
  } catch {
    return false;
  }
}

type BowBlockedReason = 'no_arrow' | 'no_los' | 'no_solution' | 'too_close' | 'aborted';
export type BowAbortCause =
  | 'abort'
  | 'death'
  | 'lease'
  | 'bow_lost'
  | 'bot_lost'
  | 'target_lost'
  | 'equip'
  | 'activate'
  | 'release'
  | 'cancel_slot'
  | 'busy';

interface BowBlocked {
  kind: 'blocked';
  reason: BowBlockedReason;
  cause?: BowAbortCause;
}

interface BowReleased {
  kind: 'released';
  shotId: number;
  targetId: number;
  ownerToken: unknown;
  at: number;
  aim: Vec3;
  hitWindow: { from: number; until: number };
}

interface BowHit {
  kind: 'hit';
  shotId: number;
  targetId: number;
  ownerToken: unknown;
  at: number;
}

export type BowShotResult = BowBlocked | BowReleased;
export type BowEvent = BowShotResult | BowHit;

interface BowControllerOptions {
  getBot: () => Bot | null;
  resolveTarget?: (id: number) => RangedTarget | null;
  motion?: PositionVelocityTracker;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  hasLos?: (bot: Bot, target: RangedTarget) => boolean;
  leaseValid?: (token: unknown) => boolean;
  emit?: (event: BowEvent) => void;
}

interface Drawing {
  bot: Bot;
  targetId: number;
  leaseToken: unknown;
  bowType: number;
  cancelSlot: number;
  activated: boolean;
  abortCause: BowAbortCause | null;
  cancelWait: Promise<boolean> | null;
}

interface TrackedTarget {
  target: RangedTarget;
  velocityPerTick: Point3;
}

/** 单次满弓控制器；身体租约、死亡和显式取消都在 release 事件之前复核。 */
export class BowController {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly hasLos: (bot: Bot, target: RangedTarget) => boolean;
  private readonly motion: PositionVelocityTracker;
  private drawing: Drawing | null = null;
  private pending: BowReleased[] = [];
  private nextShotId = 1;

  constructor(private readonly opts: BowControllerOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.hasLos = opts.hasLos ?? hasRangedLos;
    this.motion = opts.motion ?? new PositionVelocityTracker();
  }

  get active(): boolean { return this.drawing !== null; }

  abort(): void { this.cancel('abort'); }

  onDeath(): void { this.cancel('death'); }

  onBotLost(): void { this.cancel('bot_lost'); }

  async shoot(target: RangedTarget, leaseToken?: unknown): Promise<BowShotResult> {
    if (this.drawing) return this.blocked('aborted', 'busy');
    const bot = this.opts.getBot();
    if (!bot) return this.blocked('aborted', 'bot_lost');
    if (bot.usingHeldItem) return this.blocked('aborted', 'busy');
    const bow = bestRangedWeapon(bot);
    if (!bow) return this.blocked('aborted', 'bow_lost');
    if (!hasUsableArrows(bot)) return this.blocked('no_arrow');
    if (!target.cell && rangedTargetDistance(bot, target) <= HYBRID_MELEE_AT) return this.blocked('too_close');
    if (!this.hasLos(bot, target)) return this.blocked('no_los');
    if (!this.validLease(leaseToken)) return this.blocked('aborted', 'lease');

    const drawing: Drawing = {
      bot,
      targetId: target.id,
      leaseToken,
      bowType: bow.type,
      cancelSlot: -1,
      activated: false,
      abortCause: null,
      cancelWait: null,
    };
    this.drawing = drawing;
    try {
      try {
        await bot.equip(bow, 'hand');
      } catch {
        return await this.finishBlocked(drawing, 'aborted', 'equip');
      }
      drawing.cancelSlot = findSafeCancelSlot(bot, drawing.bowType);
      if (drawing.cancelSlot < 0) return await this.finishBlocked(drawing, 'aborted', 'cancel_slot');
      let stopped = this.validateOwner(drawing);
      if (stopped) return await this.finishBlocked(drawing, stopped.reason, stopped.cause);
      let current = this.trackTarget(drawing, target);
      if (!current) return await this.finishBlocked(drawing, 'aborted', 'target_lost');
      stopped = this.validate(drawing, current.target);
      if (stopped) return await this.finishBlocked(drawing, stopped.reason, stopped.cause);

      let aim = this.aim(bot, current);
      if (!aim) return await this.finishBlocked(drawing, 'no_solution');
      await bot.lookAt(aim, true);
      stopped = this.validateOwner(drawing);
      if (stopped) return await this.finishBlocked(drawing, stopped.reason, stopped.cause);
      current = this.trackTarget(drawing, target);
      if (!current) return await this.finishBlocked(drawing, 'aborted', 'target_lost');
      stopped = this.validate(drawing, current.target);
      if (stopped) return await this.finishBlocked(drawing, stopped.reason, stopped.cause);
      try {
        bot.activateItem();
      } catch {
        return await this.finishBlocked(drawing, 'aborted', 'activate');
      }
      drawing.activated = true;

      const startedAt = this.now();
      while (this.now() - startedAt < BOW_FULL_DRAW_MS) {
        await this.sleep(Math.min(AIM_STEP_MS, BOW_FULL_DRAW_MS - (this.now() - startedAt)));
        stopped = this.validateOwner(drawing);
        if (stopped) return await this.finishBlocked(drawing, stopped.reason, stopped.cause);
        current = this.trackTarget(drawing, target);
        if (!current) return await this.finishBlocked(drawing, 'aborted', 'target_lost');
        stopped = this.validate(drawing, current.target);
        if (stopped) return await this.finishBlocked(drawing, stopped.reason, stopped.cause);
        aim = this.aim(bot, current);
        if (!aim) return await this.finishBlocked(drawing, 'no_solution');
        await bot.lookAt(aim, true);
        stopped = this.validateOwner(drawing);
        if (stopped) return await this.finishBlocked(drawing, stopped.reason, stopped.cause);
        current = this.trackTarget(drawing, target);
        if (!current) return await this.finishBlocked(drawing, 'aborted', 'target_lost');
        stopped = this.validate(drawing, current.target);
        if (stopped) return await this.finishBlocked(drawing, stopped.reason, stopped.cause);
      }

      if (!this.commitRelease(drawing)) return await this.finishBlocked(drawing, 'aborted', 'release');
      const at = this.now();
      const released: BowReleased = {
        kind: 'released',
        shotId: this.nextShotId,
        targetId: target.id,
        ownerToken: leaseToken,
        at,
        aim,
        hitWindow: { from: at, until: at + BOW_HIT_WINDOW_MS },
      };
      this.nextShotId += 1;
      this.pending.push(released);
      this.pruneHits(at);
      this.opts.emit?.(released);
      return released;
    } finally {
      if (drawing.activated) {
        const cause = drawing.abortCause
          ?? (this.opts.getBot() !== drawing.bot ? 'bot_lost' : 'abort');
        await this.cancelDrawing(drawing, cause);
      } else if (drawing.cancelWait) {
        await drawing.cancelWait;
      }
      if (this.drawing === drawing) this.drawing = null;
    }
  }

  /** 实体受伤事件落在放箭窗口内时归到最早一支未结算的箭。 */
  noteHit(targetId: number, at = this.now()): BowHit | null {
    this.pruneHits(at);
    const index = this.pending.findIndex((shot) => (
      shot.targetId === targetId && at >= shot.hitWindow.from && at <= shot.hitWindow.until
    ));
    if (index < 0) return null;
    const [shot] = this.pending.splice(index, 1);
    const hit: BowHit = {
      kind: 'hit', shotId: shot.shotId, targetId, ownerToken: shot.ownerToken, at,
    };
    this.opts.emit?.(hit);
    return hit;
  }

  private aim(bot: Bot, tracked: TrackedTarget): Vec3 | null {
    const entity = bot.entity as Bot['entity'] & { eyeHeight?: number };
    return lowArcAimPoint({
      x: entity.position.x,
      y: entity.position.y + (entity.eyeHeight ?? 1.62),
      z: entity.position.z,
    }, tracked.target, tracked.velocityPerTick, entity.velocity ?? zeroPoint());
  }

  private validate(drawing: Drawing, target: RangedTarget): BowBlocked | null {
    const owner = this.validateOwner(drawing);
    if (owner) return owner;
    if (!usableBow(drawing.bot.heldItem as InventoryItem | null)) {
      return { kind: 'blocked', reason: 'aborted', cause: 'bow_lost' };
    }
    if (!hasUsableArrows(drawing.bot)) return { kind: 'blocked', reason: 'no_arrow' };
    if (!target.cell && rangedTargetDistance(drawing.bot, target) <= HYBRID_MELEE_AT) {
      return { kind: 'blocked', reason: 'too_close' };
    }
    if (!this.hasLos(drawing.bot, target)) return { kind: 'blocked', reason: 'no_los' };
    return null;
  }

  private validateOwner(drawing: Drawing): BowBlocked | null {
    if (drawing.abortCause) return { kind: 'blocked', reason: 'aborted', cause: drawing.abortCause };
    if (this.opts.getBot() !== drawing.bot) return { kind: 'blocked', reason: 'aborted', cause: 'bot_lost' };
    if (!this.validLease(drawing.leaseToken)) return { kind: 'blocked', reason: 'aborted', cause: 'lease' };
    return null;
  }

  private trackTarget(drawing: Drawing, fallback: RangedTarget): TrackedTarget | null {
    if (fallback.cell) return { target: fallback, velocityPerTick: zeroPoint() };
    const resolved = this.opts.resolveTarget
      ? this.opts.resolveTarget(drawing.targetId)
      : fallback;
    if (!resolved || resolved.id !== drawing.targetId) return null;
    const at = this.now();
    this.motion.observe(resolved.id, resolved.position, at);
    const estimate = this.motion.estimate(resolved.id, at);
    return {
      target: {
        id: resolved.id,
        position: estimate?.position ?? copyPoint(resolved.position),
        ...(resolved.height === undefined ? {} : { height: resolved.height }),
        ...(resolved.width === undefined ? {} : { width: resolved.width }),
      },
      velocityPerTick: estimate?.velocityPerTick ?? zeroPoint(),
    };
  }

  private validLease(token: unknown): boolean {
    return this.opts.leaseValid?.(token) ?? true;
  }

  private cancel(cause: BowAbortCause): void {
    const drawing = this.drawing;
    if (!drawing || drawing.abortCause) return;
    drawing.abortCause = cause;
    void this.cancelDrawing(drawing, cause);
  }

  private commitRelease(drawing: Drawing): boolean {
    if (!drawing.activated) return false;
    try {
      drawing.bot.deactivateItem();
    } catch {
      return false;
    }
    drawing.activated = false;
    return true;
  }

  private cancelDrawing(drawing: Drawing, cause: BowAbortCause): Promise<boolean> {
    if (drawing.cancelWait) return drawing.cancelWait;
    if (!drawing.activated) return Promise.resolve(true);
    drawing.activated = false;
    if (cause === 'death' || cause === 'bot_lost') return Promise.resolve(true);
    const slot = findSafeCancelSlot(drawing.bot, drawing.bowType, drawing.cancelSlot);
    if (slot < 0) return Promise.resolve(false);
    drawing.cancelSlot = slot;
    try {
      drawing.bot.setQuickBarSlot(slot);
    } catch {
      return Promise.resolve(false);
    }
    drawing.cancelWait = this.sleep(AIM_STEP_MS).then(() => true);
    return drawing.cancelWait;
  }

  private async finishBlocked(
    drawing: Drawing,
    reason: BowBlockedReason,
    cause?: BowAbortCause,
  ): Promise<BowBlocked> {
    const cancelled = await this.cancelDrawing(drawing, cause ?? 'abort');
    if (!cancelled) return this.blocked('aborted', 'cancel_slot');
    return this.blocked(reason, cause);
  }

  private blocked(reason: BowBlockedReason, cause?: BowAbortCause): BowBlocked {
    const event: BowBlocked = cause === undefined
      ? { kind: 'blocked', reason }
      : { kind: 'blocked', reason, cause };
    this.opts.emit?.(event);
    return event;
  }

  private pruneHits(at: number): void {
    this.pending = this.pending.filter((shot) => shot.hitWindow.until >= at);
  }
}

/** 玩家眼睛到目标碰撞箱最近点的三维距离。 */
export function rangedTargetDistance(bot: Bot, target: RangedTarget): number {
  const entity = bot.entity as Bot['entity'] & { eyeHeight?: number };
  const eye = {
    x: entity.position.x,
    y: entity.position.y + (entity.eyeHeight ?? 1.62),
    z: entity.position.z,
  };
  const halfWidth = (target.width ?? 0.6) / 2;
  const nearest = {
    x: clamp(eye.x, target.position.x - halfWidth, target.position.x + halfWidth),
    y: clamp(eye.y, target.position.y, target.position.y + (target.height ?? 1.8)),
    z: clamp(eye.z, target.position.z - halfWidth, target.position.z + halfWidth),
  };
  return pointDistance(eye, nearest);
}

function findSafeCancelSlot(bot: Bot, bowType: number, preferred = -1): number {
  const start = bot.inventory.hotbarStart;
  const safe = (slot: number): boolean => {
    if (slot < 0 || slot > 8 || slot === bot.quickBarSlot) return false;
    return bot.inventory.slots[start + slot]?.type !== bowType;
  };
  if (safe(preferred)) return preferred;
  for (let slot = 0; slot < 9; slot += 1) {
    if (safe(slot)) return slot;
  }
  return -1;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function zeroPoint(): Point3 {
  return { x: 0, y: 0, z: 0 };
}

function copyPoint(point: Point3): Point3 {
  return { x: point.x, y: point.y, z: point.z };
}

function subtractPoint(a: Point3, b: Point3): Point3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scalePoint(point: Point3, scale: number): Point3 {
  return { x: point.x * scale, y: point.y * scale, z: point.z * scale };
}

function mixPoint(a: Point3, b: Point3, weight: number): Point3 {
  return {
    x: a.x * (1 - weight) + b.x * weight,
    y: a.y * (1 - weight) + b.y * weight,
    z: a.z * (1 - weight) + b.z * weight,
  };
}

function pointDistance(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function pointNorm(point: Point3): number {
  return Math.hypot(point.x, point.y, point.z);
}
