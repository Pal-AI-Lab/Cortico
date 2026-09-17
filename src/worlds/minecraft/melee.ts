/**
 * 动手那几下:挑兵器、够不够得着、挥击与冷却、远程接管的判据,以及附近敌对生物的读数。
 *
 * attack 技能与自保反射共用这一层;谁占着身体不在这里决定。
 */
import { piglinIsHostile } from './piglin.ts';
import { sleep, type TaskAttackLease } from './skill-context.ts';
import { headInWater } from './terrain.ts';
import {
  HYBRID_MELEE_AT, KITE_MAX_RANGE, KITE_MIN_RANGE, bestRangedWeapon, hasRangedLos, hasUsableArrows,
  type BowShotResult, type RangedTarget,
} from './ranged.ts';
import { type AttackMode } from './skills.ts';
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Aborted, SkillBlocked, SkillNoop, checkAbort, type SkillContext } from './skill-context.ts';
import { isKnownTarget } from './entity-facts.ts';
import { dropGoal, findEntity, gotoGoal, levelTravelGoal } from './travel.ts';
import { zhEntity } from './names.ts';
import { chooseHybridWeapon, type HybridWeapon } from './ranged.ts';
import { zhErrorText } from './receipt.ts';

const { goals } = pathfinderPkg;

export type HurtSource = Parameters<Bot['attack']>[0];

/** entityHurt 不带 source 时(旧协议路径)回退猜攻击者的距离上限,沿用旧判据的 6 格 */
export const REFLEX_HURT_FALLBACK_RANGE = 6;

/** 半径内最近的敌对生物；排除玩家和自身，没有则返回 null。 */
export function nearestHostileWithin(bot: Bot, radius: number): HurtSource | null {
  let best: HurtSource | null = null;
  let bestD = radius;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id as unknown as number];
    if (!e?.position || e.type === 'player' || e === bot.entity) continue;
    const name = e.name ?? '';
    if (!HOSTILE.has(name) && !(name === 'piglin' && piglinIsHostile(bot, e))) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d < bestD) { bestD = d; best = e as unknown as HurtSource; }
  }
  return best;
}

/** 剑 > 斧 > 镐 > 锹,同种再按材质:下界合金 > 钻石 > 铁 > 石 > 金 > 木 */
export const WEAPON_KIND_SCORE: Record<string, number> = { sword: 40, axe: 30, pickaxe: 20, shovel: 10 };
export const WEAPON_TIER_SCORE: Record<string, number> = {
  netherite: 6, diamond: 5, iron: 4, stone: 3, golden: 2, wooden: 1,
};

/** 剑 1.6 攻速 → 满伤间隔 625ms;冷却不满就挥是软伤害。战斗会话与技能共用一份 */
export function meleeCooldownMs(bot: Bot): number {
  return attackCooldownMs(bot);
}

export function weaponScore(name: string): number {
  const kind = Object.keys(WEAPON_KIND_SCORE).find((k) => name.endsWith(`_${k}`));
  if (!kind) return -1;
  const tier = Object.keys(WEAPON_TIER_SCORE).find((t) => name.startsWith(`${t}_`));
  return WEAPON_KIND_SCORE[kind] + (tier ? WEAPON_TIER_SCORE[tier] : 0);
}

export function bestWeapon(bot: Bot) {
  let best: ReturnType<Bot['inventory']['items']>[number] | null = null;
  let score = -1;
  for (const item of bot.inventory.items()) {
    const s = weaponScore(item.name);
    if (s > score) { score = s; best = item; }
  }
  return best;
}

/** 1.9+ 攻速换算的满伤间隔。剑 1.6、斧 1.0,不满就挥是软伤害。 */
export function attackCooldownMs(bot: Bot): number {
  const name = bot.heldItem?.name ?? '';
  if (name.endsWith('_sword')) return 625;
  if (name.endsWith('_axe')) return 1_000;
  if (name === 'trident' || name.endsWith('_trident')) return 900;
  if (name.endsWith('_pickaxe')) return 850;
  if (name.endsWith('_shovel') || name.endsWith('_hoe')) return 1_000;
  return 250;
}

export const MELEE_REACH = 3.2;
export const MELEE_CHASE = 8;
export const HOP_MS = 280;
export const STRAFE_MS = 400;

export function releaseMelee(bot: Bot): void {
  for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump'] as const) {
    bot.setControlState(k, false);
  }
}

export async function aimAt(bot: Bot, entity: { position: { offset(x: number, y: number, z: number): unknown }; height?: number }): Promise<void> {
  await bot.lookAt(entity.position.offset(0, entity.height ?? 1.6, 0) as never, true);
}

/**
 * 跳劈:落地才跳,下落才出手。冲刺中 crit 不成,先松 sprint。
 * 等不到下落(测试假实体没有速度)就 HOP_MS 后挥,不堵死循环。
 */
export async function hopCrit(bot: Bot): Promise<void> {
  if ((bot.entity as { isInWater?: boolean }).isInWater) return;
  if (bot.entity.onGround === false) return;
  bot.setControlState('sprint', false);
  bot.setControlState('jump', true);
  const deadline = Date.now() + HOP_MS;
  while (Date.now() < deadline) {
    await sleep(50);
    const vy = (bot.entity as { velocity?: { y?: number } }).velocity?.y;
    if (typeof vy === 'number' && vy < 0) break;
  }
  bot.setControlState('jump', false);
}

export function pressMelee(bot: Bot, entity: { position: { distanceTo(o: unknown): number }; name?: string }, strafeLeft: boolean | null): void {
  const d = entity.position.distanceTo(bot.entity.position);
  if (entity.name === 'creeper' && d < 3) {
    bot.setControlState('forward', false);
    bot.setControlState('back', true);
    bot.setControlState('sprint', false);
  } else {
    bot.setControlState('back', false);
    bot.setControlState('forward', d > 1.6);
    bot.setControlState('sprint', d > 2.4);
  }
  bot.setControlState('left', strafeLeft === true);
  bot.setControlState('right', strafeLeft === false);
}

export async function meleeSwing(
  bot: Bot,
  entity: Parameters<Bot['attack']>[0],
  beforeAttack?: () => void,
): Promise<void> {
  await hopCrit(bot);
  await aimAt(bot, entity);
  beforeAttack?.();
  bot.attack(entity);
}

/** 水下攻击回执附氧气读数，不额外用氧气阈值阻断主动攻击。 */
export function underwaterOxygenNote(bot: Bot): string {
  if (!headInWater(bot)) return '';
  return `;人在水下,氧气 ${Math.max(0, Math.min(20, bot.oxygenLevel ?? 20))}/20`;
}

export function rangedTargetOf(entity: NonNullable<Bot['entities'][string]>): RangedTarget {
  return {
    id: entity.id,
    position: entity.position,
    ...(entity.height === undefined ? {} : { height: entity.height }),
    ...(entity.width === undefined ? {} : { width: entity.width }),
  };
}

export function forcedRangedIssue(bot: Bot, target: RangedTarget): string | null {
  if (!bestRangedWeapon(bot)) return '包里没有可用的弓';
  if (!hasUsableArrows(bot)) return '包里没有普通箭';
  if (!hasRangedLos(bot, target)) return '目标被方块挡住,没有射线';
  return null;
}

export function rangedBlockedText(result: Exclude<BowShotResult, { kind: 'released' }>): string {
  if (result.reason === 'no_arrow') return '普通箭用完了';
  if (result.reason === 'no_los') return '目标被方块挡住,没有射线';
  if (result.reason === 'no_solution') return '这段距离没有可用的弓箭弹道';
  if (result.reason === 'too_close') return '目标贴得太近,弓拉不开安全距离';
  if (result.cause === 'bow_lost') return '可用的弓不在手边了';
  if (result.cause === 'bot_lost') return '连接断了';
  if (result.cause === 'target_lost') return '目标离开视野了';
  return '这一箭在放出前被取消了';
}

export function attackStats(stats: TaskAttackLease): string {
  return `挥击 ${stats.swings} 次命中 ${stats.meleeHits} 次,放箭 ${stats.arrows} 支命中 ${stats.rangedHits} 支` +
    `${stats.hurts > 0 ? `,期间挨打 ${stats.hurts} 次` : ''}`;
}

export function pressRanged(
  bot: Bot,
  distance: number,
  mode: AttackMode,
  strafeLeft: boolean,
): void {
  const kite = mode === 'kite';
  const retreat = distance <= HYBRID_MELEE_AT || (kite && distance < KITE_MIN_RANGE);
  bot.setControlState('jump', false);
  bot.setControlState('forward', kite && distance > KITE_MAX_RANGE);
  bot.setControlState('back', retreat);
  bot.setControlState('sprint', kite && distance > KITE_MAX_RANGE);
  const lateral = kite && distance >= KITE_MIN_RANGE && distance <= KITE_MAX_RANGE;
  bot.setControlState('left', lateral && strafeLeft);
  bot.setControlState('right', lateral && !strafeLeft);
}

/** 一只在 32 格内的敌对生物读数 */
export interface HostileRead {
  e: NonNullable<Bot['entities'][string]>;
  d: number;
}

/** 32 格内所有敌对生物,由近到远。piglin 只在真敌对时算数(见 piglinIsHostile) */
export function hostilesAround(bot: Bot, from: { x: number; y: number; z: number }): HostileRead[] {
  const out: HostileRead[] = [];
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e?.position || !e.name) continue;
    if (!HOSTILE.has(e.name) && !(e.name === 'piglin' && piglinIsHostile(bot, e))) continue;
    const d = e.position.distanceTo(from as never);
    if (d <= 32) out.push({ e, d });
  }
  return out.sort((a, b) => a.d - b.d);
}

export function nearestHostileTo(bot: Bot, from: { x: number; y: number; z: number }): HostileRead | null {
  return hostilesAround(bot, from)[0] ?? null;
}

export const HOSTILE = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch',
  'slime', 'phantom', 'drowned', 'husk', 'stray', 'pillager', 'vindicator',
  'ravager', 'vex', 'evoker', 'silverfish', 'zombie_villager', 'blaze', 'ghast',
  'magma_cube', 'wither_skeleton', 'warden', 'bogged', 'breeze',
  'piglin_brute', 'hoglin', 'zoglin', 'endermite', 'illusioner', 'guardian',
]);

export async function skillAttack(
  bot: Bot,
  target: string,
  mode: AttackMode = 'auto',
  ctx: SkillContext,
): Promise<string> {
  if (!isKnownTarget(bot, target)) {
    throw new SkillBlocked(`不认识「${target}」这种东西,认不出要打谁`);
  }
  const entity = findEntity(bot, target, 32);
  // 要打的东西不在场 = 无事可做:没打输,是没得打(见 SkillNoop)
  if (!entity) throw new SkillNoop(`附近 32 格内没有${zhEntity(target)}`);
  const ranged = ctx.attack.ranged;
  const forcedRanged = mode === 'ranged' || mode === 'kite';
  if (forcedRanged) {
    const issue = forcedRangedIssue(bot, rangedTargetOf(entity));
    if (!ranged || issue) {
      throw new SkillBlocked(`${issue ?? '远程控制器现在不可用'};${mode} 不会改用近战`);
    }
  }
  // 血线撤退只针对可能还手的目标；玩家、敌对生物及主动攻击的普通猪灵均适用。
  const attackName = entity.name ?? '';
  const dangerous = entity.type === 'player'
    || HOSTILE.has(attackName)
    // 这一步是**主动**打它:攻击本身就是挑衅,金甲带来的中立当场作废,所以 provoked 传真
    || (attackName === 'piglin' && piglinIsHostile(bot, entity, true));
  const stats = ctx.attack.acquire(entity.id);
  const deadline = Date.now() + 45_000;
  let lastSwing = 0;
  let inMelee = false;
  let strafeLeft = false;
  let strafeAt = 0;
  let weapon: HybridWeapon = forcedRanged ? 'ranged' : 'melee';
  let desperate = false;
  let retreatFailed = false;
  const equipMelee = async (): Promise<void> => {
    ranged?.abort();
    const best = bestWeapon(bot);
    if (best) await bot.equip(best, 'hand').catch(() => undefined);
  };
  if (weapon === 'melee') await equipMelee();
  try {
    while (!stats.dead && entity.isValid && Date.now() < deadline) {
      checkAbort(ctx);
      if (stats.disconnected) throw new SkillBlocked(`连接断了,主动攻击已取消;${attackStats(stats)}`);
      const floor = ctx.fleeHealth();
      if (!desperate && dangerous && floor > 0 && (bot.health ?? 20) < floor) {
        // 撤退是任务的一部分:走完再汇报,不能丢下一个方向就报错收工
        releaseMelee(bot);
        ranged?.abort();
        ctx.escape.active = true;
        const hp = Math.ceil(bot.health ?? 0);
        const start = bot.entity.position.clone();
        const hurtMark = stats.hurts;
        const away = bot.entity.position.minus(entity.position).normalize().scaled(24);
        const dest = bot.entity.position.plus(away);
        let pathError: string | null = null;
        await gotoGoal(bot, levelTravelGoal(dest.x, dest.z), ctx).catch((error: unknown) => {
          if (error instanceof Aborted) throw error;
          pathError = error instanceof Error ? zhErrorText(error.message) : String(error);
        });
        const p = bot.entity.position;
        const moved = p.distanceTo(start);
        const distance = entity.position.distanceTo(p);
        const hurtAgain = stats.hurts > hurtMark;
        const safe = moved >= 3 && distance >= KITE_MIN_RANGE && !hurtAgain;
        if (stats.dead || !entity.isValid) break;
        if (safe) {
          throw new SkillBlocked(
            `${stats.swings > 0 ? '打到一半' : `没跟${zhEntity(target)}动手`},生命 ${hp}/20 低于撤退线;` +
              `确认撤开 ${Math.round(moved * 10) / 10} 格,现在离目标 ${Math.round(distance * 10) / 10} 格` +
              `${pathError ? `(${pathError})` : ''};${attackStats(stats)}${underwaterOxygenNote(bot)}`,
          );
        }
        // 跑不动或撤退中还在掉血时，血线的前提已经失效；本步继续持有身体回身还手。
        desperate = true;
        retreatFailed = true;
        ctx.escape.active = false;
        weapon = forcedRanged ? 'ranged' : 'melee';
        if (weapon === 'melee') await equipMelee();
        ctx.diag?.write({
          lane: 'skill', event: 'attack-cornered', taskId: ctx.taskId,
          msg: `主动攻击撤退失败:只挪 ${Math.round(moved * 10) / 10} 格${hurtAgain ? ',仍在受击' : ''},回身还手`,
          data: { target, mode, moved, distance, hurtAgain, pathError },
        });
        continue;
      }
      const d = entity.position.distanceTo(bot.entity.position);
      const rangedReady = Boolean(ranged?.ready(bot));
      const nextWeapon = forcedRanged
        ? 'ranged'
        : mode === 'melee' ? 'melee' : chooseHybridWeapon(weapon, d, rangedReady);
      if (nextWeapon !== weapon) {
        weapon = nextWeapon;
        releaseMelee(bot);
        if (weapon === 'melee') await equipMelee();
      }

      if (weapon === 'ranged') {
        inMelee = false;
        dropGoal(bot, 'task', '改用远程,寻路器让位', ctx.diag);
        if (!rangedReady || !ranged) {
          if (forcedRanged) {
            throw new SkillBlocked(`${forcedRangedIssue(bot, rangedTargetOf(entity)) ?? '远程控制器现在不可用'};${mode} 不会改用近战;${attackStats(stats)}`);
          }
          weapon = 'melee';
          await equipMelee();
          continue;
        }
        if (Date.now() >= strafeAt) {
          strafeLeft = !strafeLeft;
          strafeAt = Date.now() + STRAFE_MS;
        }
        await aimAt(bot, entity);
        pressRanged(bot, d, mode, strafeLeft);
        // kite 先把过近距离拉开；ranged/auto 只需高于弓控制器的安全下限。
        if ((mode === 'kite' && d < KITE_MIN_RANGE) || d <= HYBRID_MELEE_AT) {
          await sleep(50);
          continue;
        }
        const result = await ranged.shoot(rangedTargetOf(entity), stats.token);
        checkAbort(ctx);
        // entityDead can arrive while the bow controller is still settling its draw.
        // The target's terminal event owns that race; a late shoot result must not spend
        // an arrow in the task receipt or start a fallback attack.
        if (stats.dead) break;
        if (result.kind === 'released') {
          stats.arrows += 1;
          continue;
        }
        if (forcedRanged) {
          throw new SkillBlocked(`${rangedBlockedText(result)};${mode} 不会改用近战;${attackStats(stats)}`);
        }
        if (
          result.reason === 'aborted' &&
          ['bot_lost', 'lease', 'death', 'target_lost'].includes(result.cause ?? '')
        ) {
          throw new SkillBlocked(`${rangedBlockedText(result)};${attackStats(stats)}`);
        }
        weapon = 'melee';
        await equipMelee();
        continue;
      }

      if (d > MELEE_CHASE) {
        inMelee = false;
        releaseMelee(bot);
        await gotoGoal(bot, new goals.GoalFollow(entity, 2), ctx).catch(() => undefined);
        continue;
      }
      if (!inMelee) {
        dropGoal(bot, 'task', '够得着了,自己打', ctx.diag);
        inMelee = true;
      }
      if (Date.now() >= strafeAt) {
        strafeLeft = !strafeLeft;
        strafeAt = Date.now() + STRAFE_MS;
      }
      await aimAt(bot, entity);
      pressMelee(bot, entity, dangerous ? strafeLeft : null);
      if (d <= MELEE_REACH && Date.now() - lastSwing >= attackCooldownMs(bot)) {
        await meleeSwing(bot, entity, () => {
          stats.lastSwingAt = Date.now();
          stats.lastSwingTargetId = entity.id;
          stats.swings += 1;
        });
        lastSwing = Date.now();
      } else {
        await sleep(50);
      }
    }
  } finally {
    releaseMelee(bot);
    ranged?.abort();
    ctx.escape.active = false;
    ctx.attack.release(stats);
  }
  if (stats.dead) {
    return `打死了${zhEntity(target)}(${attackStats(stats)})${retreatFailed ? ';撤退没走开后回身打完' : ''}${underwaterOxygenNote(bot)}`;
  }
  if (!entity.isValid) {
    throw new SkillBlocked(`交手中${zhEntity(target)}离开了视野,没有把“消失”算成击杀;${attackStats(stats)}${underwaterOxygenNote(bot)}`);
  }
  if (entity.isValid) {
    throw new SkillBlocked(
      `${attackStats(stats)}没打死${zhEntity(target)},超时收手${underwaterOxygenNote(bot)}`,
    );
  }
  throw new SkillBlocked(`没有确认${zhEntity(target)}死亡;${attackStats(stats)}`);
}

