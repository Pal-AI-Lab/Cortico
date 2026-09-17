/**
 * 容器与工作站的窗口:找到哪一个、开得稳、槽位怎么排、这一次看见了什么记进账本。
 *
 * 只管开窗与读写槽位,存什么取什么由技能族决定。
 */
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { type Cell } from './geometry.ts';
import { SkillBlocked, checkAbort, sleep, type SkillContext } from './skill-context.ts';
import { gotoGoal, reachCell } from './travel.ts';
import { blockAtCell, cellText, dimensionOf } from './cell-facts.ts';
import { zhName } from './names.ts';
import { moveExactSlot, playerInvIn, type InvPred } from './inventory.ts';
import { readDurability, readEnchants, type EnchantRegistry } from './item-facts.ts';
import {
  CONTAINER_FIND, ChestBook, FURNACE_KINDS, chestBlockName, hasItem, hasRoom, type ChestRecord,
} from './chests.ts';
import { type ItemStack } from './terrain.ts';
import { contentsText } from './receipt.ts';

const { goals } = pathfinderPkg;

/** 三种磨损态的铁砧都认 */
export const ANVIL_BLOCKS = ['anvil', 'chipped_anvil', 'damaged_anvil'] as const;
/** 找工作方块的半径,与 smelt 找炉子一个量级 */
export const STATION_FIND_R = 16;
/** 放料/取货后等服务端回灌窗口槽位 */
export const WINDOW_SETTLE_MS = 600;

export interface StationWindow {
  id: number;
  type: string;
  slots: Array<{ name: string; type: number; count: number } | null>;
  inventoryStart: number;
  inventoryEnd: number;
}

export function findStationCell(bot: Bot, names: readonly string[]): Cell | null {
  const reg = bot.registry.blocksByName as unknown as Record<string, { id: number } | undefined>;
  const ids = names.map((n) => reg[n]?.id).filter((n): n is number => typeof n === 'number');
  if (ids.length === 0) return null;
  const found = bot.findBlocks({ matching: ids, maxDistance: STATION_FIND_R, count: 1 });
  return found.length > 0 ? { x: found[0].x, y: found[0].y, z: found[0].z } : null;
}

/** 走到 cell、开它的窗;那一格不是这种工作方块当场说清 */
export async function openStationWindow(
  bot: Bot, ctx: SkillContext, cell: Cell, blockNames: readonly string[], zhStation: string,
): Promise<{ win: StationWindow; blockName: string }> {
  await reachCell(bot, cell, ctx);
  checkAbort(ctx);
  const block = blockAtCell(bot, cell);
  if (!block) throw new SkillBlocked(`${cellText(cell)} 所在区块没加载`);
  if (!blockNames.includes(block.name)) {
    throw new SkillBlocked(`${cellText(cell)} 那一格是${zhName(block.name)},不是${zhStation}`);
  }
  const win = await (bot as unknown as { openBlock(b: unknown): Promise<StationWindow> }).openBlock(block);
  return { win, blockName: block.name };
}

/**
 * 把包里符合判据的一件挪进窗口的某个格。
 *
 * 找料照**开着的那扇窗**自己的账读(见 playerInvIn),槽位号也只在那扇窗里成立。
 * 一格一件的按槽位挪(见 moveExactSlot):`transfer` 按类型找槽,同 id 的几件在它
 * 眼里没有分别,点名挑的那一件就白挑了。
 */
export async function putIntoStation(
  bot: Bot, win: StationWindow, pred: InvPred, destSlot: number, asked: string,
): Promise<void> {
  const item = playerInvIn(bot, win).items().find((i) => pred(i.name, i));
  if (!item) throw new SkillBlocked(`包里没有${asked}`);
  if (item.count === 1) {
    await moveExactSlot(bot, item.slot, destSlot);
    return;
  }
  await (bot as unknown as { transfer(o: Record<string, unknown>): Promise<void> }).transfer({
    window: win, itemType: item.type, metadata: null, count: 1,
    sourceStart: win.inventoryStart, sourceEnd: win.inventoryEnd,
    destStart: destSlot, destEnd: destSlot + 1,
  });
}

/** 一件东西的读数:耐久 + 附魔,回执格式统一 */
export function stationItemFacts(bot: Bot, item: { name: string } | null): string {
  if (!item) return '';
  const parts: string[] = [];
  const dur = readDurability(item as never);
  if (dur) parts.push(`耐久 ${dur.left}/${dur.max}`);
  const ench = readEnchants(item as never, bot.registry as never);
  parts.push(ench.length > 0 ? `附魔 ${ench.map((e) => `${e.name}${e.level}`).join('、')}` : '没有附魔');
  return parts.join(',');
}

export function findContainers(bot: Bot, range: number): Array<{ x: number; y: number; z: number; name: string; d: number }> {
  const ids = CONTAINER_FIND
    .map((n) => (bot.registry.blocksByName as Record<string, { id: number } | undefined>)[n]?.id)
    .filter((id): id is number => id !== undefined);
  if (ids.length === 0) return [];
  const me = bot.entity.position;
  const found = bot.findBlocks({ matching: ids, maxDistance: range, count: 16 });
  const out: Array<{ x: number; y: number; z: number; name: string; d: number }> = [];
  for (const p of found) {
    const b = bot.blockAt(p);
    if (!b) continue;
    out.push({ x: p.x, y: p.y, z: p.z, name: b.name, d: p.distanceTo(me) });
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

/**
 * 报告本维度账本中最近箱子的上次观测位置与取整直线距离；没有则返回 null。
 * 不跨维度比较坐标，也不决定走过去或放新箱子。
 */
export function knownChestNote(bot: Bot, chests: ChestBook | undefined): string | null {
  const me = bot.entity.position;
  let best: { rec: ChestRecord; d: number } | null = null;
  for (const rec of chests?.chestsIn(dimensionOf(bot)) ?? []) {
    const d = Math.hypot(rec.x - me.x, rec.y - me.y, rec.z - me.z);
    if (!best || d < best.d) best = { rec, d };
  }
  if (!best) return null;
  const r = best.rec;
  const origin = r.placedAt !== undefined ? '你放的' : '你开过的';
  return `;账上本维度最近的是${origin}${zhName(chestBlockName(r))}`
    + ` (${r.x}, ${r.y}, ${r.z}),直线 ${Math.round(best.d)} 格(上次看见)`;
}

/** 附近一个容器都扫不到:两处(stow / take)共用同一句措辞与同一段账本补注 */
export function noContainerNearby(bot: Bot, ctx: SkillContext): SkillBlocked {
  return new SkillBlocked(`32 格内没有箱子${knownChestNote(bot, ctx.chests) ?? ''}`);
}

/**
 * 箱内容按「名字 + 附魔」并栈,与背包同一条线(原版里带不同附魔的同名物品不能堆叠)。
 * 只按名字并,五本各不相同的附魔书会念成「附魔书×5」:数量读得到,哪一本在里面读不到,
 * 于是也点不了名(见 item-pick)。
 */
export function containerStacks(win: {
  containerItems?: () => Array<{ name: string; count: number }>;
  slots?: Array<{ name: string; count: number } | null>;
  inventoryStart?: number;
}, registry?: EnchantRegistry | null): { items: ItemStack[]; usedSlots: number; slots: number } {
  const raw = typeof win.containerItems === 'function'
    ? win.containerItems()
    : (win.slots ?? []).slice(0, win.inventoryStart ?? 27).filter((s): s is { name: string; count: number } => s != null);
  const merged = new Map<string, ItemStack>();
  for (const it of raw) {
    const ench = readEnchants(it as never, registry as never);
    const key = ench.length > 0 ? `${it.name}|${ench.map((e) => `${e.name}${e.level}`).join(',')}` : it.name;
    const cur = merged.get(key);
    if (cur) cur.count += it.count;
    else merged.set(key, { name: it.name, count: it.count, ...(ench.length > 0 ? { enchantments: ench } : {}) });
  }
  return {
    items: [...merged.values()],
    usedSlots: raw.length,
    slots: win.inventoryStart ?? 27,
  };
}

export function rememberChest(
  ctx: SkillContext,
  bot: Bot,
  pos: { x: number; y: number; z: number },
  win: Parameters<typeof containerStacks>[0],
): { items: ItemStack[]; usedSlots: number; slots: number } {
  const snap = containerStacks(win, bot.registry as never);
  ctx.chests?.remember(dimensionOf(bot), pos, snap.items, snap.usedSlots, snap.slots);
  return snap;
}

/**
 * 原版烧一件的耗时:熔炉 200 刻(10 秒);高炉与烟熏炉减半(100 刻)。
 * 这是确定性数值,所以熔炉的到期**可以**估;作物不行(随机刻),别把这条挪去作物。
 */
export function smeltPerItemMs(blockName: string): number {
  return blockName === 'furnace' ? 10_000 : 5_000;
}

/** 槽位有料不能证明正在烧炼;估时需要炉火和进度读数同时确认。 */
export function furnaceDoneAt(win: unknown, input: ItemStack | null, blockName: string, now: number): number | null {
  const { fuel, progress } = win as { fuel?: number | null; progress?: number | null };
  return input && typeof fuel === 'number' && fuel > 0 && typeof progress === 'number' && progress > 0
    ? now + (input.count - progress) * smeltPerItemMs(blockName)
    : null;
}

/** 窗口 slots 里的一格转成账本的 ItemStack;空格与读不出都算 null */
export function slotStack(win: unknown, i: number): ItemStack | null {
  const slots = (win as { slots?: Array<{ name?: string; count?: number } | null> }).slots;
  const s = slots?.[i];
  return s && typeof s.name === 'string' && typeof s.count === 'number'
    ? { name: s.name, count: s.count }
    : null;
}

/**
 * 右键开出来的窗口在关窗前记进容器账本,回执带上看见了什么。
 * 箱子族整窗记;炉子族记三槽位,有炉火和进度读数才估到期。不是容器就什么都不做。
 */
export function rememberWindow(
  bot: Bot,
  ctx: SkillContext,
  cell: Cell,
  blockName: string,
  win: NonNullable<Bot['currentWindow']>,
): string {
  if (CONTAINER_FIND.includes(blockName)) {
    const snap = rememberChest(ctx, bot, cell, win as Parameters<typeof containerStacks>[0]);
    return `。箱里:${contentsText(snap.items)}`;
  }
  if (FURNACE_KINDS.has(blockName)) {
    const state = { input: slotStack(win, 0), fuel: slotStack(win, 1), output: slotStack(win, 2) };
    const now = Date.now();
    const expected = furnaceDoneAt(win, state.input, blockName, now);
    ctx.chests?.rememberFurnace(dimensionOf(bot), cell, blockName, state, now, expected);
    const slot = (s: ItemStack | null): string => (s ? `${zhName(s.name)}×${s.count}` : '空');
    return `。炉里:输入${slot(state.input)},燃料${slot(state.fuel)},输出${slot(state.output)}`;
  }
  return '';
}

export function orderForStow(
  found: Array<{ x: number; y: number; z: number; name: string; d: number }>,
  ctx: SkillContext,
  bot: Bot,
  item: string,
): typeof found {
  const dim = dimensionOf(bot);
  const withRoom: typeof found = [];
  const unseen: typeof found = [];
  const rest: typeof found = [];
  // 堆叠上限是物品自带的属性(原版:大多 64,鸡蛋/雪球 16,工具/桶 1),registry 里就有
  const stackMax = (bot.registry.itemsByName as Record<string, { stackSize?: number } | undefined>)
    ?.[item]?.stackSize ?? 64;
  for (const s of found) {
    const rec = ctx.chests?.get(dim, s);
    if (rec && hasRoom(rec, item, stackMax)) withRoom.push(s);
    else if (!rec) unseen.push(s);
    else rest.push(s);
  }
  return [...withRoom, ...unseen, ...rest];
}

export function orderForTake(
  found: Array<{ x: number; y: number; z: number; name: string; d: number }>,
  ctx: SkillContext,
  bot: Bot,
  item: string,
): typeof found {
  const dim = dimensionOf(bot);
  const withItem: typeof found = [];
  const rest: typeof found = [];
  for (const s of found) {
    const rec = ctx.chests?.get(dim, s);
    if (rec && hasItem(rec, item)) withItem.push(s);
    else rest.push(s);
  }
  return [...withItem, ...rest];
}

/** mineflayer 拿错窗口身份时抛的话:「Non-container window used as a container」一族 */
export function isWindowIdentityError(err: unknown): boolean {
  return err instanceof Error && / window used as a /i.test(err.message);
}

/**
 * 开容器前退役遗留窗口；返回窗口身份不符时关闭并重开一次，连续失败才受阻。
 * 此处校验窗口身份，窗口状态版本由 mineflayer-fixes 的 stateId 守卫处理。
 */
export async function openWindowGuarded<T>(bot: Bot, ctx: SkillContext, open: () => Promise<T>): Promise<T> {
  const cur = bot.currentWindow;
  if (cur) {
    ctx.diag?.write({
      lane: 'skill', event: 'stale-window-retire',
      msg: `开容器前发现还挂着窗口${cur.id}(${cur.type}),先关掉`,
      data: { windowId: cur.id, type: String(cur.type) },
    });
    bot.closeWindow(cur);
    await sleep(150);
  }
  try {
    return await open();
  } catch (err) {
    if (!isWindowIdentityError(err)) throw err;
    const w = bot.currentWindow;
    ctx.diag?.write({
      lane: 'skill', event: 'window-identity-retry',
      msg: `开出来的窗口身份不对(${w ? `窗口${w.id} ${w.type}` : '窗口已不在'}),强制关窗重开一次`,
      data: { windowId: w?.id, type: w ? String(w.type) : null },
    });
    if (w) bot.closeWindow(w);
    await sleep(300);
    try {
      return await open();
    } catch (err2) {
      if (!isWindowIdentityError(err2)) throw err2;
      throw new SkillBlocked(
        '窗口串号了:上一个界面窗口没退干净,这次开容器拿到的是错的窗口身份;' +
        '已强制关窗重试一次仍没成。东西都还在,没有丢——过几秒再开一次多半就好',
      );
    }
  }
}

export async function openNearbyContainer(
  bot: Bot,
  spot: { x: number; y: number; z: number; name: string },
  ctx: SkillContext,
): Promise<Awaited<ReturnType<Bot['openContainer']>>> {
  await gotoGoal(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 2), ctx);
  const block = bot.blockAt(new Vec3(spot.x, spot.y, spot.z));
  if (!block) throw new SkillBlocked(`${zhName(spot.name)}不见了`);
  return openWindowGuarded(bot, ctx, () => bot.openContainer(block));
}

export interface GenericWindow {
  slots: Array<{ name: string; count: number; slot: number } | null>;
  items(): Array<{ name: string; count: number; slot: number }>;
  close(): void;
}

