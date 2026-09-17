/**
 * 选具:这一下该拿哪把、够不够级、快断了没有,以及 reserve 收着的那把被迫动用时的记号。
 *
 * 挑与装备在这里,挖与放在技能族里;回执里的那一句由 toolTraceNote 出。
 */
import type { Bot } from 'mineflayer';
import { type InvItem } from './inventory.ts';
import { readDurability } from './item-facts.ts';
import { SkillBlocked, type ReserveHit, type SkillContext, type ToolTrace } from './skill-context.ts';
import { matchItemName } from './chests.ts';
import { zhName } from './names.ts';

/**
 * 工具材质的等级序,好的在前;倒着读就是等级序的低往高。
 * 金镐挖得最快但等级只等于木镐(挖不动铁矿),所以它排在石之后。
 */
export const TOOL_RANK = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

/** minecraft-data 的方块条目里跟"拿什么挖"有关的两个字段 */
export interface BlockToolData {
  /** 掉落的硬条件:itemId → true。缺省 = 这块谁挖都掉东西 */
  harvestTools?: Record<string, unknown>;
  /** `mineable/pickaxe`、`plant;mineable/axe` 这类;只决定快慢 */
  material?: string;
}

export function blockToolData(bot: Bot, blockName: string): BlockToolData | undefined {
  return (bot.registry.blocksByName as unknown as Record<string, BlockToolData | undefined>)[blockName];
}

/** harvestTools 的 itemId 清单 → 物品名 */
export function harvestToolNames(bot: Bot, def: BlockToolData | undefined): string[] {
  if (!def?.harvestTools) return [];
  const items = bot.registry.items as unknown as Record<number, { name: string } | undefined>;
  return Object.keys(def.harvestTools).map((id) => items[Number(id)]?.name).filter((n): n is string => !!n);
}

/** 名字属于哪一类家伙什:`stone_pickaxe` → pickaxe、`shears` → shears */
export function toolKindOf(itemName: string): string {
  const i = itemName.lastIndexOf('_');
  return i < 0 ? itemName : itemName.slice(i + 1);
}

export type MiningToolPlan = { mode: 'economy' | 'fastest' } | { mode: 'exact'; item: string };

export interface ToolDecision {
  pick: InvItem | null;
  canDrop: boolean;
  need: string | null;
  error: string | null;
  reserve?: { reason: 'only-capable' | 'override'; instead: string | null };
}

export function miningToolPlan(tool: string | undefined): MiningToolPlan {
  return tool === undefined ? { mode: 'economy' }
    : tool === 'fastest' ? { mode: 'fastest' }
      : { mode: 'exact', item: tool };
}

/** 方块无需工具或没有适用工具时，不让上一把耐久物品继续替空手承受消耗。 */
export function isDurabilityItem(name: string): boolean {
  return readDurability({ name }) !== null;
}

export function nearBreak(item: InvItem): { left: number; max: number } | null {
  const d = readDurability(item);
  if (!d || d.left > Math.max(3, Math.ceil(d.max * 0.05))) return null;
  return d;
}

/** 返回被换下的耐久物品；没有换手时为 null。 */
export async function avoidUnsuitableHeldTool(bot: Bot): Promise<string | null> {
  const held = bot.heldItem;
  if (!held || !isDurabilityItem(held.name)) return null;
  const substitute = bot.inventory.items().find((item) => !isDurabilityItem(item.name));
  if (substitute) {
    try {
      await bot.equip(substitute, 'hand');
      return held.name;
    } catch {
      // 继续尝试腾空主手。
    }
  }
  // mineflayer 在主物品栏全满时 unequip 可能把手上物品丢到地上；这种情况保留原物品。
  if (bot.inventory.items().length >= 36 || typeof bot.unequip !== 'function') return null;
  try {
    await bot.unequip('hand');
    return held.name;
  } catch {
    return null;
  }
}

export function toolRank(name: string): number {
  const i = TOOL_RANK.findIndex((r) => name.startsWith(r));
  return i < 0 ? TOOL_RANK.length : i;
}

export function durabilityLeft(item: InvItem): number {
  return readDurability(item)?.left ?? Number.MAX_SAFE_INTEGER;
}

export function toolOrder(mode: 'economy' | 'fastest'): (a: InvItem, b: InvItem) => number {
  if (mode === 'fastest') {
    const speed = ['golden', 'netherite', 'diamond', 'iron', 'stone', 'wooden'];
    const speedRank = (name: string): number => {
      const i = speed.findIndex((tier) => name.startsWith(tier));
      return i < 0 ? speed.length : i;
    };
    return (a, b) => Number(nearBreak(a) !== null) - Number(nearBreak(b) !== null)
      || speedRank(a.name) - speedRank(b.name)
      || durabilityLeft(b) - durabilityLeft(a);
  }
  return (a, b) => Number(nearBreak(a) !== null) - Number(nearBreak(b) !== null)
    || toolRank(b.name) - toolRank(a.name)
    || durabilityLeft(b) - durabilityLeft(a);
}

export function reservedBy(ctx: SkillContext, name: string): boolean {
  return (ctx.policy?.get().reserve ?? []).some((r) => matchItemName(r, name));
}

export function chooseTool(
  bot: Bot,
  block: { name: string; canHarvest?: (type: number | null) => boolean },
  ctx: SkillContext,
  plan: MiningToolPlan,
): ToolDecision {
  const def = blockToolData(bot, block.name);
  const harvest = harvestToolNames(bot, def);
  const need = minHarvestTool(bot, block.name);
  const canDrop = (item: InvItem): boolean => typeof block.canHarvest === 'function'
    ? block.canHarvest(item.type)
    : harvest.length === 0 || harvest.includes(item.name);

  if (plan.mode === 'exact') {
    const exact = bot.inventory.items().find((item) => item.name === plan.item && item.count > 0);
    if (!exact) {
      return { pick: null, canDrop: false, need, error: `包里没有本步指定的${zhName(plan.item)};没有改用别的工具` };
    }
    if (!canDrop(exact)) {
      return {
        pick: exact,
        canDrop: false,
        need,
        error: `本步指定的${zhName(exact.name)}挖${zhName(block.name)}不掉东西${need ? `,要${zhName(need)}及以上` : ''};没有改用别的工具`,
      };
    }
    return {
      pick: exact,
      canDrop: true,
      need,
      error: null,
      ...(reservedBy(ctx, exact.name) ? { reserve: { reason: 'override' as const, instead: null } } : {}),
    };
  }

  if (plan.mode === 'economy' && harvest.length === 0) {
    return { pick: null, canDrop: true, need, error: null };
  }

  const kinds = new Set(harvest.length > 0
    ? harvest.map(toolKindOf)
    : [...(def?.material ?? '').matchAll(/mineable\/(\w+)/g)].map((m) => m[1]));
  if (kinds.size === 0) return { pick: null, canDrop: true, need, error: null };
  const inClass = bot.inventory.items()
    .filter((item) => [...kinds].some((kind) => item.name === kind || item.name.endsWith(`_${kind}`)));
  if (inClass.length === 0 && harvest.length === 0) {
    return { pick: null, canDrop: true, need, error: null };
  }
  const capable = inClass.filter(canDrop);
  if (capable.length === 0) {
    return {
      pick: null,
      canDrop: false,
      need,
      error: `包里没有能保住${zhName(block.name)}掉落的工具${need ? `,要${zhName(need)}及以上` : ''};没动方块`,
    };
  }
  const usable = plan.mode === 'economy' ? capable.filter((item) => nearBreak(item) === null) : capable;
  if (usable.length === 0) {
    const worn = capable.map((item) => {
      const d = nearBreak(item)!;
      return `${zhName(item.name)} ${d.left}/${d.max}`;
    }).join('、');
    return {
      pick: null,
      canDrop: false,
      need,
      error: `能保住${zhName(block.name)}掉落的工具都临近损坏(${worn});节约模式没动方块;本步写 tool:"fastest" 或具体工具名可临时覆盖`,
    };
  }
  const pool = usable.sort(toolOrder(plan.mode));
  const free = pool.filter((item) => !reservedBy(ctx, item.name));
  if (free.length > 0) return { pick: free[0], canDrop: canDrop(free[0]), need, error: null };
  const pick = pool[0];
  const alternate = inClass.filter((item) => !reservedBy(ctx, item.name)).sort(toolOrder(plan.mode))[0];
  return {
    pick,
    canDrop: canDrop(pick),
    need,
    error: null,
    reserve: { reason: 'only-capable' as const, instead: alternate?.name ?? null },
  };
}

export function recordToolChoice(ctx: SkillContext, block: string, plan: MiningToolPlan, decision: ToolDecision): void {
  const trace = ctx.toolTrace;
  if (!trace) return;
  const pick = decision.pick?.name ?? null;
  const first = trace.last === undefined;
  const changed = !first && trace.last !== pick;
  if (first || changed) {
    if (pick === null) {
      trace.notes.push(first
        ? `${zhName(block)}不需工具,已换下耐久工具`
        : `挖到${zhName(block)}时换下耐久工具`);
    } else if (plan.mode === 'exact') {
      trace.notes.push(`本步临时指定${zhName(pick)}`);
    } else if (plan.mode === 'fastest') {
      trace.notes.push(`${first ? '本步临时用最快工具' : `挖到${zhName(block)}时换成`}:${zhName(pick)}`);
    } else {
      trace.notes.push(`${first ? '节约模式选' : `挖到${zhName(block)}时换成`}:${zhName(pick)}`);
    }
    trace.last = pick;
  }
  if (decision.pick) {
    const d = nearBreak(decision.pick);
    const key = decision.pick.name;
    if (d && !trace.near.has(key)) {
      trace.near.add(key);
      trace.notes.push(`${zhName(decision.pick.name)}临近损坏,只剩 ${d.left}/${d.max} 耐久`);
    }
  }
}

export function toolTraceNote(trace: ToolTrace | undefined): string {
  return trace && trace.notes.length > 0 ? `;工具:${trace.notes.join(';')}` : '';
}

/** harvestTools 限定能产出掉落的工具；没有此限制时，material 的 mineable/tool 只决定速度。 */
export async function equipToolFor(
  bot: Bot,
  block: { name: string; canHarvest?: (type: number | null) => boolean },
  ctx: SkillContext,
  plan?: MiningToolPlan,
): Promise<void> {
  const actualPlan = plan ?? { mode: 'fastest' as const };
  const decision = chooseTool(bot, block, ctx, actualPlan);
  if (decision.error) throw new SkillBlocked(decision.error);
  if (!decision.pick) {
    const replaced = await avoidUnsuitableHeldTool(bot);
    if (plan && replaced) recordToolChoice(ctx, block.name, actualPlan, decision);
    return;
  }
  if (decision.reserve && ctx.reserveHits
    && !ctx.reserveHits.some((hit) => hit.tool === decision.pick!.name && hit.block === block.name)) {
    ctx.reserveHits.push({
      tool: decision.pick.name,
      block: block.name,
      instead: decision.reserve.instead,
      reason: decision.reserve.reason,
    });
  }
  try {
    await bot.equip(decision.pick, 'hand');
    if (plan) recordToolChoice(ctx, block.name, actualPlan, decision);
  } catch {
    await avoidUnsuitableHeldTool(bot);
    throw new SkillBlocked(`选了${zhName(decision.pick.name)}挖${zhName(block.name)},但没能拿到手;没动方块`);
  }
}

/** 例外进这一步的回执;这一步没触发例外时是空串 */
export function reserveNote(hits: readonly ReserveHit[], mark: number): string {
  return hits.slice(mark).map((h) => h.reason === 'override'
    ? `;本步点名覆盖 reserve,拿了收着的${zhName(h.tool)}`
    : h.instead
      ? `;${zhName(h.instead)}挖不出${zhName(h.block)}的掉落,拿了收着的${zhName(h.tool)}`
      : `;只有收着的${zhName(h.tool)}挖得出${zhName(h.block)}的掉落,拿了`).join('');
}

/** 能收获这块的家伙里等级最低的那一件;这块不挑工具时为 null */
export function minHarvestTool(bot: Bot, blockName: string): string | null {
  const names = harvestToolNames(bot, blockToolData(bot, blockName));
  if (names.length === 0) return null;
  // TOOL_RANK 倒着读就是低到高:先命中的那个就是原版说的"及以上"那一级
  for (const tier of [...TOOL_RANK].reverse()) {
    const hit = names.find((n) => n.startsWith(tier));
    if (hit) return hit;
  }
  return names[0];
}

/**
 * 挖掘前以 canHarvest 报告工具能否产出掉落及最低等级；仅报告，不阻止挖掘。
 * 原版允许工具等级不足时挖掉方块，但不产生掉落。
 */
export function harvestFact(
  bot: Bot,
  b: { name: string; canHarvest?: (t: number | null) => boolean },
): string | null {
  if (typeof b.canHarvest !== 'function' || b.canHarvest(bot.heldItem?.type ?? null)) return null;
  const hand = bot.heldItem ? zhName(bot.heldItem.name) : '空手';
  const need = minHarvestTool(bot, b.name);
  return `${hand}挖${zhName(b.name)}不掉东西${need ? `,要${zhName(need)}及以上` : ''}`;
}

/** 拿在手上才有用的那几类:镐斧锹锄剑,以及打火石、水桶这些一次性道具不算 */
export const HANDHELD_SUFFIXES = ['_pickaxe', '_axe', '_shovel', '_hoe', '_sword'];

/**
 * equip 的目标槽位。盔甲的槽位是物品自带的属性(minecraft-data 的
 * `equipmentSlot`/`equipDest`),不必自己按名字猜——猜出来的表迟早跟不上版本。
 * 数据里没写的一律拿主手;盾牌的副手位是协议约定,数据里没有,单列一条。
 */
export function equipDestOf(name: string, registry?: Bot['registry']): 'head' | 'torso' | 'legs' | 'feet' | 'off-hand' | 'hand' {
  if (name === 'shield') return 'off-hand';
  const def = registry
    ? (registry.itemsByName as Record<string, { equipDest?: string; equipmentSlot?: string } | undefined>)[name]
    : undefined;
  const slot = def?.equipDest ?? def?.equipmentSlot;
  if (slot === 'head' || slot === 'torso' || slot === 'legs' || slot === 'feet') return slot;
  // registry 不在手上(纯文案场景)时按后缀兜一层:装备槽这件事本身不靠它做决定
  if (name.endsWith('helmet')) return 'head';
  if (name.endsWith('chestplate') || name === 'elytra') return 'torso';
  if (name.endsWith('leggings')) return 'legs';
  if (name.endsWith('boots')) return 'feet';
  return 'hand';
}

