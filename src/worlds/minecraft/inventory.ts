/**
 * 背包的读法与等待:按名字数数、找那一件、以及放置/合成/拾取后等服务端回话确认增量。
 *
 * 只读背包与等确认,不决定拿什么;该拿哪把工具在 tools.ts。
 */
import type { Bot } from 'mineflayer';
import { itemMatchesPick, pickLabel, pickMissText, pickTargetOf } from './item-pick.ts';
import { matchItemName } from './chests.ts';
import { type ItemLike } from './item-facts.ts';
import { SkillBlocked, checkAbort, sleep, type SkillContext } from './skill-context.ts';
import { zhName } from './names.ts';


/** 原版背包格数:9 快捷栏 + 27 主仓。盔甲 4 格与副手 1 格不在其中 */
export const INVENTORY_SLOTS = 36;

/** equip 的找法:精确名优先,退而求其次才用后缀/前缀(类别名 pickaxe→iron_pickaxe) */
export function invItemNamed(bot: Bot, want: string, pick?: string) {
  const items = (bot.inventory?.items?.() ?? [])
    .filter((i) => itemMatchesPick(pick, i, bot.registry as never));
  return items.find((i) => i.name === want)
    ?? items.find((i) => i.name.endsWith(`_${want}`))
    ?? items.find((i) => i.name.startsWith(`${want}_`));
}

/** invItemNamed 的名字口径,摊开给"这个名字下有哪几件"用 */
export function namedLike(want: string, name: string): boolean {
  return name === want || name.endsWith(`_${want}`) || name.startsWith(`${want}_`);
}

/**
 * 报得出玩家物品栏的东西。`bot.inventory` 和打开的容器窗口都是 Window,
 * 两者的 `items()` 都只数 inventoryStart..inventoryEnd,也就是玩家那半边。
 */
export interface InvView {
  items(): InvItem[];
}

/**
 * 库存判据。第二个入参是那一摞东西本身:同 id 的几件靠挑选词分辨(item-pick),
 * 光看名字分不出来。只看名字的判据照旧写一元箭头。
 */
export type InvPred = (name: string, item: InvItem) => boolean;

/**
 * 容器开启时玩家库存以 currentWindow 为准；windowId 0 才更新 bot.inventory。
 * 点击预测也修改当前窗口，close() 的 copyInventory() 才回灌 bot.inventory。
 * 开窗期间的搬运增量须从窗口 items() 读取。
 */
export function playerInvIn(bot: Bot, win: unknown): InvView {
  return typeof (win as InvView | null)?.items === 'function' ? (win as InvView) : bot.inventory;
}

export function invCountIn(view: InvView, pred: InvPred): number {
  return view.items().filter((i) => pred(i.name, i)).reduce((s, i) => s + i.count, 0);
}

export function invCountByIdIn(view: InvView, id: number): number {
  return view.items().filter((i) => i.type === id).reduce((s, i) => s + i.count, 0);
}

export function invCount(bot: Bot, pred: InvPred): number {
  return invCountIn(bot.inventory, pred);
}

/** 这一步点名的是哪一件:名字口径 + 挑选词,两道都过才算 */
export function itemPredOf(bot: Bot, item: string, pick?: string): InvPred {
  return (n, it) => matchItemName(item, n) && itemMatchesPick(pick, it, bot.registry as never);
}

/**
 * 包里没有这一步要的东西。两句话分开:连 id 都没有,还是有 id 而挑选词一件都没命中 ——
 * 后者要把同 id 的那几件各自是什么摆出来,她下一步要么改挑选词要么改主意。
 */
export function noSuchItem(
  bot: Bot, item: string, pick?: string, candidates?: readonly ItemLike[],
): SkillBlocked {
  const same = candidates ?? bot.inventory.items().filter((i) => matchItemName(item, i.name));
  if (pick && same.length > 0) {
    const targets = same.map((i) => pickTargetOf(i, bot.registry as never));
    return new SkillBlocked(pickMissText('包里', item, pick, targets));
  }
  return new SkillBlocked(`包里没有${zhName(item)}`);
}

/** 「附魔书(带「无限」的)」:点名到具体一件时,受阻话里也要带上挑选词 */
export function itemAsked(item: string, pick?: string): string {
  return `${zhName(item)}${pick ? `(带「${pick}」的)` : ''}`;
}

/** 回执里怎么念这一件:点名挑过就念全标签(带附魔括号),没挑就念 id 的中文名 */
export function askedLabel(bot: Bot, name: string, pick?: string, item?: ItemLike | null): string {
  return pick && item ? pickLabel(pickTargetOf(item, bot.registry as never)) : zhName(name);
}

/**
 * 点名那一件的搬运:直接点它所在的那一格。
 *
 * `deposit`/`withdraw`/`transfer` 都按物品类型找槽(mineflayer 的 nbt 参数比的是
 * 1.20.5 之前的 NBT,组件时代的附魔在它眼里一律为空),同 id 的几件对它没有分别 ——
 * 挑中哪一件全看槽位顺序。所以点名到具体一件时只能按槽位搬。
 * 只用在**一格一件**的东西上:能堆叠的一摞里每件都一样,按类型搬本来就没有歧义。
 */
export async function moveExactSlot(bot: Bot, from: number, to: number): Promise<void> {
  await bot.moveSlotItem(from, to);
}

/** minecraft-data 的 drops 简表不含概率掉落；补充表同时用于入包对账和按掉落物反查方块。 */
export function probabilisticDropsOf(name: string): string[] {
  if (['short_grass', 'tall_grass', 'grass', 'fern', 'large_fern'].includes(name)) return ['wheat_seeds'];
  if (name === 'dead_bush') return ['stick'];
  if (name.endsWith('_leaves')) {
    return [
      'stick',
      name.replace('_leaves', '_sapling'), // 没有对应树苗的(红树/杜鹃)对不上就是对不上,无害
      ...(name === 'oak_leaves' || name === 'dark_oak_leaves' ? ['apple'] : []),
    ];
  }
  return [];
}

/**
 * 挖这些方块会掉出什么物品。核对入包数要认掉落物:挖 coal_ore 进包的是 coal,
 * 挖 stone 进包的是 cobblestone,按方块名去数永远数出 0。
 */
export function dropNamesOf(bot: Bot, blockIds: number[]): Set<string> {
  const blocks = bot.registry.blocks as unknown as Record<number, { name: string; drops?: unknown[] }>;
  const items = bot.registry.items as unknown as Record<number, { name: string }>;
  const names = new Set<string>();
  for (const id of blockIds) {
    const b = blocks[id];
    if (!b) continue;
    names.add(b.name);
    for (const d of b.drops ?? []) {
      const itemId = typeof d === 'number' ? d : (d as { drop?: number } | null)?.drop;
      if (itemId !== undefined && items[itemId]) names.add(items[itemId].name);
    }
    for (const n of probabilisticDropsOf(b.name)) names.add(n);
  }
  return names;
}

export function invCountById(bot: Bot, id: number): number {
  return invCountByIdIn(bot.inventory, id);
}

/** 合成产物必须持续存在的稳定窗口。 */
export const CRAFT_SETTLE_MS = 600;

/** 等物品栏的账落到位最多等这么久。 */
export const INV_CONFIRM_MS = 2_000;
/** 挖下来的东西进包要等的上限:原版掉落物 10 tick 可拾取,再给一点走过去的余量 */
export const PICKUP_SETTLE_MS = 800;

/**
 * 对账结果。三种下场分得开,是为了让回执照实说,而不是一律报"失败":
 * - `confirmed` 服务端的账已经变了,`moved` 是稳定后的实际变化量;
 * - `rolled-back` 变过又被收回,这是**确认没成**;
 * - `timeout` 等到超时账都没动,这是**没等到确认**,成没成都还不知道。
 */
export type InvConfirm =
  | { moved: number; status: 'confirmed' }
  | { moved: 0; status: 'rolled-back' | 'timeout' };

/**
 * 等物品栏的账相对 `before` 朝 `dir` 方向变化(dir=1 是多出来,-1 是少掉),
 * 返回稳定后的变化量。
 *
 * `settleMs > 0` 时增量还得在这段窗口里持续存在才算数——合成走这一条:
 * 服务端可能先把产物塞进来再撤回,单次读取会把临时产物误报成功。
 * 容器搬运不需要这段:`close()` 里的 `copyInventory()` 是一次确定的灌回,
 * 见到就是准的,白等只会让每次存取多花半秒。
 */
export async function awaitInvConfirm(
  read: () => number,
  before: number,
  dir: 1 | -1,
  ctx: SkillContext,
  settleMs = 0,
): Promise<InvConfirm> {
  const deadline = Date.now() + INV_CONFIRM_MS;
  while (Date.now() < deadline) {
    checkAbort(ctx);
    const moved = (read() - before) * dir;
    if (moved > 0) {
      if (settleMs <= 0) return { moved, status: 'confirmed' };
      const settleUntil = Date.now() + settleMs;
      while (Date.now() < settleUntil) {
        checkAbort(ctx);
        await sleep(100);
      }
      const settled = (read() - before) * dir;
      return settled > 0 ? { moved: settled, status: 'confirmed' } : { moved: 0, status: 'rolled-back' };
    }
    await sleep(100);
  }
  return { moved: 0, status: 'timeout' };
}

/**
 * 等这一次合成的产物出现在物品栏里**并且留得住**,返回实际多出来的数量;
 * 到点没出现、或出现后又被收回,都返回 0。
 */
export async function awaitCraftGain(bot: Bot, itemId: number, before: number, ctx: SkillContext): Promise<number> {
  const r = await awaitInvConfirm(
    () => invCountById(bot, itemId), before, 1, ctx, CRAFT_SETTLE_MS,
  );
  if (r.status === 'rolled-back') {
    ctx.diag?.write({
      lane: 'craft', event: 'rolled-back', taskId: ctx.taskId,
      msg: `产物入包后又没了:${CRAFT_SETTLE_MS}ms 后一个不剩(服务端收回了)`,
      data: { itemId, before },
    });
  }
  return r.moved;
}

/** 全物品栏按物品名计数;配 lootNote 求一步前后的净增 */
export function invSnapshot(bot: Bot): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of bot.inventory.items()) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
  return m;
}

/** 这一步实际进包了什么(净增部分);一样都没多也要说出来 */
export function lootNote(before: Map<string, number>, bot: Bot): string {
  const gains = invGains(before, bot);
  return gains.length > 0 ? `这一路拾取:${gains.join('、')}` : '这一路什么都没进包';
}

/** 与 lootNote 同口径的净增清单;没有净增返回空数组 */
export function invGains(before: Map<string, number>, bot: Bot): string[] {
  const gains: string[] = [];
  for (const [name, n] of invSnapshot(bot)) {
    const d = n - (before.get(name) ?? 0);
    if (d > 0) gains.push(`${zhName(name)}×${d}`);
  }
  return gains;
}

/** 原版拾取范围会同时吸入沿途物品；净增分为点名目标与顺路拾得两栏，均回报。 */
export function invGainsSplit(
  before: Map<string, number>, bot: Bot, item: string,
): { wanted: string[]; alongside: string[] } {
  const wanted: string[] = [];
  const alongside: string[] = [];
  for (const [name, n] of invSnapshot(bot)) {
    const d = n - (before.get(name) ?? 0);
    if (d <= 0) continue;
    (matchItemName(item, name) ? wanted : alongside).push(`${zhName(name)}×${d}`);
  }
  return { wanted, alongside };
}

/** 与 invGains 反向:这一步从包里少掉了什么(手上用出去的、装到别处去的) */
export function invLosses(before: Map<string, number>, bot: Bot): string[] {
  const now = invSnapshot(bot);
  const losses: string[] = [];
  for (const [name, n] of before) {
    const d = n - (now.get(name) ?? 0);
    if (d > 0) losses.push(`${zhName(name)}×${d}`);
  }
  return losses;
}

/** 窗口/背包里的一摞。`slot` 是**它所在那扇窗**的槽位号,点名搬运只认它 */
export type InvItem = ReturnType<Bot['inventory']['items']>[number];

