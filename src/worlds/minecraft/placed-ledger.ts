/**
 * 挂在 bot 实例上的几本小账:这一场放过哪些格、锄过哪几格、放了三次还没上去的那些格。
 *
 * 跟着连接走,换实例即清;跨任务跨场次的成果登记在 works.ts。
 */
import type { Bot } from 'mineflayer';
import { type SkillCall } from './skills.ts';
import { type SkillContext } from './skill-context.ts';
import { type Cell } from './geometry.ts';
import { blockAtCell, cellKeyOf, dimensionOf } from './cell-facts.ts';
import { HOE_TILLED } from './blueprint-registry.ts';
import { zhName } from './names.ts';
import { FURNACE_BLOCKS } from './chests.ts';

/** 这些技能的放置整段是本意,回执自己会说;其余步骤里的放置都是寻路垫脚/搭路 */
export const INTENTIONAL_PLACERS = new Set<SkillCall['skill']>(['craft', 'use']);

export function placedLedgerOf(bot: Bot): Array<{ name: string; x: number; y: number; z: number }> {
  const b = bot as unknown as { placedLedger?: Array<{ name: string; x: number; y: number; z: number }> };
  return (b.placedLedger ??= []);
}

/**
 * 这一场锄成过耕地的那些格(内存,换 bot 实例即清)。
 *
 * 同一格再锄一次成功 = 那块耕地已经被踩回泥土:站在耕地上跳一下 60% 踩坏,
 * 落差 ≥2 格必坏。它是「反复重锄」的成因,不是掉墒。
 */
export function tilledOf(bot: Bot): Set<string> {
  const b = bot as unknown as { tilledCells?: Set<string> };
  return (b.tilledCells ??= new Set<string>());
}

/**
 * 一次成功的右键落进成果登记:锄成的耕地记这一格,种下的作物记它上面那一格
 * (作物长在耕地上面,不在被点的那一格)。别的右键不进登记。
 */
export function noteWork(bot: Bot, ctx: SkillContext, item: string | null, cell: Cell, target: string): void {
  if (!ctx.works || item === null) return;
  const dim = dimensionOf(bot);
  if (item.endsWith('_hoe') && HOE_TILLED[target] === 'farmland') {
    ctx.works.note(dim, cell.x, cell.y, cell.z, { kind: 'farmland', block: 'farmland', site: null });
    return;
  }
  const crop = SEED_CROP[item] ?? (item === 'nether_wart' ? 'nether_wart' : undefined);
  if (crop !== undefined) {
    ctx.works.note(dim, cell.x, cell.y + 1, cell.z, { kind: 'crop', block: crop, site: null });
  }
}

/** 这一场上次真吃进去的时刻(内存,换 bot 实例即清);`[口粮]` 那行的四个数之一 */
export function lastAteOf(bot: Bot): number | null {
  return (bot as unknown as { lastAteAt?: number }).lastAteAt ?? null;
}

export function noteAte(bot: Bot): void {
  (bot as unknown as { lastAteAt?: number }).lastAteAt = Date.now();
}

/** 记下这一格锄成了耕地;记过一次的补一句事实,不拦 */
export function noteTilled(bot: Bot, cell: Cell): string {
  const key = `${dimensionOf(bot)}:${cellKeyOf(cell)}`;
  const seen = tilledOf(bot);
  if (!seen.has(key)) {
    seen.add(key);
    return '';
  }
  return ';这格之前翻过,是被踩回泥土的;种上作物或别在上面跳';
}

/** 放了三次回读还是老样子的那些格(mineflayer-fixes 记的另一半台账) */
export function placeMissesOf(bot: Bot): Array<{ was: string; x: number; y: number; z: number }> {
  const b = bot as unknown as { placeMisses?: Array<{ was: string; x: number; y: number; z: number }> };
  return (b.placeMisses ??= []);
}

/** 一步开工时两本台账各记到哪一条:回执报的是这一步之内的那一段 */
export interface PlaceMarks { placed: number; missed: number }

export function placeMarksOf(bot: Bot): PlaceMarks {
  return { placed: placedLedgerOf(bot).length, missed: placeMissesOf(bot).length };
}

/** 从寻路耗材台账摘除技能有意放置的格，由该技能回报；同一步的其他垫脚仍记耗材。 */
export function forgetPlaced(bot: Bot, at: { x: number; y: number; z: number }): void {
  const ledger = placedLedgerOf(bot);
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].x === at.x && ledger[i].y === at.y && ledger[i].z === at.z) {
      ledger.splice(i, 1);
      return;
    }
  }
}

/**
 * 回报寻路垫脚的成功与未确认放置；服务端拒绝放置时客户端仍可能扣物品。
 * 成功项按 INTENTIONAL_PLACERS 与 intended 豁免，未确认项只豁免逐格回报的 build。
 * 寻路承重失败另由 pathSupportFailure 裁决。
 */
export function placedNote(
  bot: Bot, mark: PlaceMarks, skill: SkillCall['skill'], intended: ReadonlySet<string>,
): string {
  const placed = INTENTIONAL_PLACERS.has(skill)
    ? []
    : placedLedgerOf(bot).slice(mark.placed).filter((p) => !intended.has(cellKeyOf(p)));
  const missed = skill === 'build' ? [] : placeMissesOf(bot).slice(mark.missed);
  let out = '';
  if (placed.length > 0) {
    const byName = new Map<string, number>();
    for (const p of placed) byName.set(p.name, (byName.get(p.name) ?? 0) + 1);
    const last = placed[placed.length - 1];
    out += `;路上垫脚/搭路用掉了 ${[...byName].map(([n, c]) => `${zhName(n)}×${c}`).join('、')}` +
      `(最后一块在 (${last.x}, ${last.y}, ${last.z}))`;
  }
  if (missed.length > 0) {
    const last = missed[missed.length - 1];
    out += `;路上还有 ${missed.length} 次放置服务端没认` +
      `(最后一次在 (${last.x}, ${last.y}, ${last.z}),那一格还是${zhName(last.was)})`;
  }
  return out;
}

/** 这一格是不是账本上还记着有东西的容器;是就给出一句点名现场事实(tunnel 停步用) */
export function ledgerBlockFact(bot: Bot, ctx: SkillContext, c: Cell): string | null {
  const rec = ctx.chests?.get(dimensionOf(bot), c);
  if (!rec || rec.items.length === 0) return null;
  const b = blockAtCell(bot, c);
  if (!b || !LEDGER_GUARD_BLOCKS.has(b.name)) return null;
  const inside = rec.items.slice(0, 3).map((i) => `${zhName(i.name)}×${i.count}`).join('、');
  return `(${c.x}, ${c.y}, ${c.z}) 的${zhName(b.name)}(账本记着里头有 ${inside})`;
}

/**
 * 种子种下去长出来的是哪种作物。**作物在耕地上面那一格**,不在被点的那一格。
 * (把握:前六种确定;torchflower_seeds/pitcher_pod 比较确定。)
 */
export const SEED_CROP: Record<string, string> = {
  wheat_seeds: 'wheat',
  beetroot_seeds: 'beetroots',
  carrot: 'carrots',
  potato: 'potatoes',
  melon_seeds: 'melon_stem',
  pumpkin_seeds: 'pumpkin_stem',
  torchflower_seeds: 'torchflower_crop',
  pitcher_pod: 'pitcher_crop',
};

/** 账本保护容器：excavate 跳过，tunnel 停步回报；拆除前先取空内容再 collect 点名。 */
export const LEDGER_GUARD_BLOCKS = new Set<string>([
  ...FURNACE_BLOCKS, 'chest', 'trapped_chest', 'barrel', 'ender_chest', 'crafting_table',
]);

