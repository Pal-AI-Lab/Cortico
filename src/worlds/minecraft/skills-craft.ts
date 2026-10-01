/**
 * 合成、吃喝与换装:craft、eat、equip。
 *
 * 配方只认服务端给的那一份;吃喝与换装都等服务端回话再报。
 */
import type { Bot } from 'mineflayer';
import { SkillBlocked, checkAbort, sleep, type SkillContext } from './skill-context.ts';
import { type SkillCall } from './skills.ts';
import { zhName } from './names.ts';
import { gridText, zhErrorText } from './receipt.ts';
import {
  CRAFT_SETTLE_MS, INVENTORY_SLOTS, awaitCraftGain, invCount, invCountById, invGains,
  invItemNamed, invSnapshot, invVariantGains, invVariantSnapshot,
  namedLike, noSuchItem, offHandItem,
} from './inventory.ts';
import { CRAFTING_STATION, ensureStation, type Station } from './placement.ts';
import {
  WINDOW_SETTLE_MS, openStationWindow, putIntoStation, stationItemFacts,
} from './containers.ts';
import { HANDHELD_SUFFIXES, equipDestOf, equippedAlready } from './tools.ts';
import { DRINKABLES } from './item-facts.ts';
import { noteAte } from './placed-ledger.ts';
import { edibleInBag, notFoodText } from './precheck.ts';
import { pickLabel, pickTargetOf } from './item-pick.ts';

/**
 * `bot.craft` 吃的配方数据面(见 mineflayer-fixes 的覆写版):
 * 只是"哪一格放哪个 id"的摆位指令,**不是许可证** —— 产出由服务端裁决。
 */
export interface CraftRecipeLike {
  result: { id: number | null; count: number };
  inShape?: Array<Array<{ id: number } | null>> | null;
  ingredients?: Array<{ id: number }> | null;
  requiresTable: boolean;
}

/** 一份配方一次要吃掉的材料(按 id 计数) */
export function craftNeeds(r: CraftRecipeLike): Map<number, number> {
  const need = new Map<number, number>();
  const bump = (id: number): void => { need.set(id, (need.get(id) ?? 0) + 1); };
  if (r.inShape) {
    for (const row of r.inShape) for (const cell of row) if (cell && cell.id >= 0) bump(cell.id);
  } else if (r.ingredients) {
    for (const ing of r.ingredients) if (ing.id >= 0) bump(ing.id);
  }
  return need;
}

/** 名字 → 物品定义;planks/bed 这两个类别词按包里的树种/羊毛色落地 */
export function craftItemDef(bot: Bot, item: string): { id: number; name: string } | undefined {
  const registry = bot.registry;
  let def = registry.itemsByName[item];
  if (!def && item === 'planks') {
    const log = bot.inventory.items().find((i) => i.name.endsWith('_log'));
    def = registry.itemsByName[log ? log.name.replace('_log', '_planks') : 'oak_planks'];
  }
  if (!def && item === 'bed') {
    const wool = bot.inventory.items().find((i) => i.name.endsWith('_wool'));
    def = registry.itemsByName[wool ? wool.name.replace('_wool', '_bed') : 'white_bed'];
  }
  return def;
}

/** 她自己摆的格子 → 摆位指令。产物不预设:产出槽出什么就是什么 */
export function recipeFromGrid(bot: Bot, grid: string[][]): CraftRecipeLike {
  const width = Math.max(...grid.map((r) => r.length));
  const inShape = grid.map((row) => {
    const cells: Array<{ id: number } | null> = [];
    for (let x = 0; x < width; x++) {
      const name = row[x] ?? '';
      if (!name) { cells.push(null); continue; }
      const def = bot.registry.itemsByName[name];
      if (!def) throw new SkillBlocked(`不认识「${name}」这种物品`);
      cells.push({ id: def.id });
    }
    return cells;
  });
  return {
    result: { id: null, count: 1 },
    inShape,
    // 2x2 徒手放得下,再大就要工作台
    requiresTable: grid.length > 2 || width > 2,
  };
}

export async function skillCraft(
  bot: Bot, call: Extract<SkillCall, { skill: 'craft' }>, ctx: SkillContext,
): Promise<string> {
  const nameOf = (id: number): string => {
    const raw = (bot.registry.items as Record<number, { name: string }>)[id]?.name;
    return raw ? zhName(raw) : `#${id}`;
  };
  const registry = bot.registry;
  const tableDef = registry.blocksByName['crafting_table'];
  const tableNear = bot.findBlocks({ matching: tableDef.id, maxDistance: 32, count: 1 });

  let recipe: CraftRecipeLike;
  let label: string;
  let targetId: number | null = null;
  if (call.grid) {
    recipe = recipeFromGrid(bot, call.grid);
    label = gridText(call.grid);
  } else {
    const def = craftItemDef(bot, call.item ?? '');
    if (!def) throw new SkillBlocked(`不认识「${call.item}」这种物品`);
    targetId = def.id;
    label = zhName(def.name);
    const smithing = smithingInputs(def.name);
    if (smithing) return smithNetherite(bot, def.name, smithing, call.count, ctx);
    // 配方表里同一样东西可能有好几种摆法(木棍:竹子/木板)。挑手上材料齐的那一种;
    // 都不齐就把配方要的直接材料照实说出来 —— 不再往下递归找"材料的材料"。
    const all = bot.recipesAll(def.id, null, true as never) as unknown as CraftRecipeLike[];
    if (all.length === 0) throw new SkillBlocked(`游戏的配方表里没有${label}的做法;要自己摆就写 grid`);
    const have = new Map<number, number>();
    for (const it of bot.inventory.items()) have.set(it.type, (have.get(it.type) ?? 0) + it.count);
    const ready = all.find((r) => [...craftNeeds(r)].every(([id, n]) => (have.get(id) ?? 0) >= n));
    if (!ready) {
      const options = all.map((r) => [...craftNeeds(r)]
        .map(([id, n]) => `${nameOf(id)}×${n}`).join(' + ')).join('  或  ');
      // 现有库存已满足本步需求时不判失败，允许依赖该物品的后续步骤继续。
      const stock = invCountById(bot, def.id);
      if (stock >= call.count) {
        return `没现搓${label}:配方要 ${options},包里凑不齐;` +
          `不过包里本来就有 ${stock} 个,够这一步要的 ${call.count} 个了`;
      }
      throw new SkillBlocked(`${label}的配方要:${options};包里凑不齐`);
    }
    recipe = ready;
  }

  const times = call.grid
    ? call.count
    : Math.ceil(call.count / Math.max(1, recipe.result.count));
  ctx.diag?.write({
    lane: 'craft', event: call.grid ? 'grid' : 'recipe', taskId: ctx.taskId,
    msg: `合成 ${label} ${times} 次` +
      `(${recipe.requiresTable
        ? `要工作台:包里 ${invCount(bot, (n) => n === 'crafting_table')} 个,32 格内${tableNear.length > 0 ? '有' : '没有'}现成的`
        : '徒手'})`,
    data: {
      grid: call.grid ?? null, expect: call.item ?? null, count: call.count, times,
      requiresTable: recipe.requiresTable, tableNearby: tableNear.length > 0,
      needs: [...craftNeeds(recipe)].map(([id, n]) => ({ item: nameOf(id), per: n })),
    },
  });

  const made: string[] = [];
  const doneSoFar = (): string => (made.length > 0 ? `已完成: ${made.join('、')}。` : '');
  let table: ReturnType<Bot['blockAt']> = null;
  if (recipe.requiresTable) {
    const station = await ensureStation(bot, CRAFTING_STATION, ctx);
    made.push(station.note);
    table = station.block;
  }

  // 产量一律按库存净增算:服务端给了什么就报什么,不照配方表复述。
  const before = invSnapshot(bot);
  const variantsBefore = invVariantSnapshot(bot);
  const targetBefore = targetId === null ? 0 : invCountById(bot, targetId);
  /** 当场没读到入包的是第几次:槽位回灌会迟到,这是现场事实,不是判据(见下) */
  const lateRounds: number[] = [];
  for (let n = 0; n < times; n++) {
    checkAbort(ctx);
    const beforeOne = targetId === null ? null : invCountById(bot, targetId);
    try {
      await bot.craft(recipe as never, 1, recipe.requiresTable ? table ?? undefined : undefined);
    } catch (err) {
      const msg = zhErrorText((err as Error).message);
      throw new SkillBlocked(
        n === 0 ? `合成 ${label}: ${msg}` : `合成 ${label} 做到第 ${n + 1} 次时: ${msg}。${doneSoFar()}`,
        [], 'server',
      );
    }
    if (targetId !== null && beforeOne !== null) {
      const got = await awaitCraftGain(bot, targetId, beforeOne, ctx);
      if (got === 0) lateRounds.push(n + 1);
      ctx.diag?.write({
        lane: 'craft', event: got === 0 ? 'no-gain' : 'gain', taskId: ctx.taskId,
        msg: `合成 ${label} 第 ${n + 1}/${times} 次,入包 ${got} 个`,
        data: { item: label, before: beforeOne, got, requiresTable: recipe.requiresTable },
      });
    } else {
      await sleep(CRAFT_SETTLE_MS);
    }
  }

  // 名字没净增时看同名换新(放大地图的产物还是地图);有名字净增就不另报
  const named = invGains(before, bot);
  const gains = named.length > 0 || targetId !== null ? named : invVariantGains(variantsBefore, bot);
  const targetGain = targetId === null ? 0 : invCountById(bot, targetId) - targetBefore;
  ctx.diag?.write({
    lane: 'craft', event: 'verify', taskId: ctx.taskId,
    msg: gains.length > 0 ? `净增 ${gains.join('、')}` : '一样都没多出来',
    data: { label, times, gains, targetGain, lateRounds },
  });
  /**
   * 单次 no-gain 只记现场，槽位回灌可能落入下一次等待窗口。
   * 合成以目标物品总净增裁决，不因某一次尚未入包立即停止。
   */
  const late = lateRounds.length > 0
    ? `(第 ${lateRounds.join('、')} 次当场没读到入包,服务端槽位回灌迟到)`
    : '';
  if (gains.length === 0 || (targetId !== null && targetGain <= 0)) {
    throw new SkillBlocked(
      `摆了 ${times} 次${label},包里${targetId !== null && gains.length > 0
        ? `${label}一个都没多` : '一样都没多出来'}${late}。${doneSoFar()}`,
      gains.length > 0 ? [`这一步包里多出来的是:${gains.join('、')}`] : [], 'server',
    );
  }
  // 合成出来的手持工具和武器立即拿上;运输用的方块不动。
  const held = targetId !== null ? await equipIfHandheld(bot, nameOfId(bot, targetId)) : false;
  return `${made.length > 0 ? `${made.join('、')};` : ''}合成出来:${gains.join('、')}` +
    (targetId !== null && targetGain < call.count ? `(要 ${call.count} 个,只多出 ${targetGain} 个)${late}` : '') +
    (held ? ',已经拿在手上' : '');
}

/** 原版锻造台的升级配方只有下界合金这一族:钻石件 + 下界合金锭 + 下界合金升级模板 */
const NETHERITE_UPGRADES = [
  'sword', 'axe', 'pickaxe', 'shovel', 'hoe', 'helmet', 'chestplate', 'leggings', 'boots',
];
const NETHERITE_TEMPLATE = 'netherite_upgrade_smithing_template';
const NETHERITE_INGOT = 'netherite_ingot';

export const SMITHING_STATION: Station = {
  kinds: ['smithing_table'], label: '锻造台', hint: '先 craft 一个锻造台(2 个铁锭 + 4 块木板)',
};
/** 1.20 起锻造台的槽位:模板 0、底料 1、添料 2、产出 3 */
const SMITH_SLOTS = { template: 0, base: 1, addition: 2, result: 3 } as const;

/** netherite_X 在锻造台上的三样材料(模板、底料 diamond_X、锭);不是锻造升级产物时返回 null */
export function smithingInputs(item: string): string[] | null {
  const kind = item.startsWith('netherite_') ? item.slice('netherite_'.length) : '';
  return NETHERITE_UPGRADES.includes(kind) ? [NETHERITE_TEMPLATE, `diamond_${kind}`, NETHERITE_INGOT] : null;
}

/**
 * 下界合金装备不在合成配方表里,要在锻造台上升级钻石件。每件消耗模板、钻石件、锭各一个,
 * 钻石件的附魔与耐久跟到产物上。产量按包里净增算。
 */
async function smithNetherite(
  bot: Bot, item: string, parts: string[], count: number, ctx: SkillContext,
): Promise<string> {
  const label = zhName(item);
  const [template, base, ingot] = parts;
  const have = parts.map((name) => ({ name, n: invCount(bot, (x) => x === name) }));
  const short = have.filter((h) => h.n < count);
  if (short.length > 0) {
    const bag = have.map((h) => `${zhName(h.name)} ${h.n} 个`).join('、');
    const stock = invCount(bot, (x) => x === item);
    if (stock >= count) {
      return `没现做${label}:锻造台升级要的材料不齐(包里${bag});不过包里本来就有 ${stock} 个,够这一步要的 ${count} 个了`;
    }
    throw new SkillBlocked(
      `${label}要在锻造台上升级:${parts.map((p) => zhName(p)).join(' + ')} 各 1 个出 1 件,` +
        `做 ${count} 件各要 ${count} 个;包里${bag}`,
    );
  }
  const station = await ensureStation(bot, SMITHING_STATION, ctx);
  const cell = { x: station.x, y: station.y, z: station.z };
  const before = invCount(bot, (x) => x === item);
  const { win } = await openStationWindow(bot, ctx, cell, SMITHING_STATION.kinds, SMITHING_STATION.label);
  let done = 0;
  try {
    for (let n = 0; n < count; n++) {
      checkAbort(ctx);
      await putIntoStation(bot, win, (x) => x === template, SMITH_SLOTS.template, zhName(template));
      await putIntoStation(bot, win, (x) => x === base, SMITH_SLOTS.base, zhName(base));
      await putIntoStation(bot, win, (x) => x === ingot, SMITH_SLOTS.addition, zhName(ingot));
      await sleep(WINDOW_SETTLE_MS);
      if (!win.slots[SMITH_SLOTS.result]) {
        throw new SkillBlocked(
          `${station.note};锻造台的产出槽没出东西:${parts.map((p) => zhName(p)).join(' + ')} 都放进去了` +
            (done > 0 ? `(之前已升级 ${done} 件)` : ''),
          [], 'server',
        );
      }
      await (bot as unknown as { clickWindow(s: number, b: number, m: number): Promise<void> })
        .clickWindow(SMITH_SLOTS.result, 0, 1);
      await sleep(WINDOW_SETTLE_MS);
      done += 1;
    }
  } finally {
    try { bot.closeWindow(win as never); } catch { /* 已关 */ }
  }
  const gained = invCount(bot, (x) => x === item) - before;
  if (gained <= 0) {
    throw new SkillBlocked(`${station.note};在锻造台上升级了 ${done} 次,包里${label}一个都没多`, [], 'server');
  }
  const result = bot.inventory.items().find((i) => i.name === item) ?? null;
  const held = await equipIfHandheld(bot, item);
  return `${station.note};在锻造台上升级出 ${gained} 件${label}(${stationItemFacts(bot, result)})` +
    (gained < count ? `(要 ${count} 件,只多出 ${gained} 件)` : '') +
    (held ? ',已经拿在手上' : '');
}

export function nameOfId(bot: Bot, id: number): string {
  return (bot.registry.items as Record<number, { name: string }>)[id]?.name ?? '';
}

/**
 * 合成的工具或武器自动切换到主手。
 * 换手失败不回滚已完成的合成,并通过返回值报告。
 */
export async function equipIfHandheld(bot: Bot, itemName: string): Promise<boolean> {
  if (!HANDHELD_SUFFIXES.some((s) => itemName.endsWith(s))) return false;
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return false;
  try {
    await bot.equip(item, 'hand');
    return true;
  } catch {
    return false;
  }
}

/** 等背包扣掉那一个食物的上限:原版进食动画 1.61 秒,余量给背包同步 */
export const EAT_SETTLE_MS = 2_500;

export async function consumeHeldFood(bot: Bot, foodName: string): Promise<string> {
  // 牛奶这类东西不给饱食度,拿 food 读数当结果就是编:它的结果是状态效果没了、
  // 手里剩个空桶(见 DRINKABLES)。判成没成仍用同一条「包里少了一个」的因果事实。
  const drink = DRINKABLES[foodName] ?? null;
  const before = bot.food;
  const bagBefore = invCount(bot, (n) => n === foodName);
  const emptyBefore = drink ? invCount(bot, (n) => n === drink.empty) : 0;
  try {
    await bot.consume();
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'Food is full') return `饥饿已经是 ${bot.food}/20,吃不下,没吃`;
    throw new SkillBlocked(`吃不下去: ${zhErrorText(message)}`);
  }
  // consume() 可被 heldItemChanged 提前 resolve；food 也可能因跑步、死亡或重生变化。
  // 进食以所选食物库存减少作为因果判据。
  const settle = Date.now() + EAT_SETTLE_MS;
  while (invCount(bot, (n) => n === foodName) === bagBefore && Date.now() < settle) await sleep(50);
  // 回执同时报告进食前后读数，即使两次读数相同。
  if (invCount(bot, (n) => n === foodName) >= bagBefore) {
    throw new SkillBlocked(
      drink
        ? `举着${zhName(foodName)}喝了一下,但包里还是 ${bagBefore} 个,没喝进去`
        : `啃了一口${zhName(foodName)},但包里还是 ${bagBefore} 个、饥饿 ${before} → ${bot.food}/20,没吃进去`,
    );
  }
  if (drink) {
    // 空桶回没回包里也照报:她下一步要拿它去装水/装奶,数得出来才算这一口有交代
    const emptyAfter = invCount(bot, (n) => n === drink.empty);
    const back = emptyAfter > emptyBefore
      ? `,${zhName(drink.empty)}回到包里(现在 ${emptyAfter} 个)`
      : `,但包里的${zhName(drink.empty)}还是 ${emptyAfter} 个`;
    // 不记进食时刻:这一口不管饱,`[口粮]` 那行说「上次进食」就得是真吃过东西
    return `喝了${drink.label},${drink.effect}${back}`;
  }
  noteAte(bot);
  return `吃了一个${zhName(foodName)},饥饿 ${before} → ${bot.food}/20`;
}

export async function skillEat(bot: Bot, itemName: string): Promise<string> {
  const foods = (bot.registry.foodsByName ?? {}) as Record<string, unknown>;
  if (!foods[itemName] && !DRINKABLES[itemName]) {
    throw new SkillBlocked(notFoodText(bot, itemName));
  }
  // eat 的 item 是完整物品 id。这里不做后缀或模糊匹配，避免把另一样食物替换进来。
  const food = bot.inventory.items().find((item) => item.name === itemName && item.count > 0);
  if (!food) {
    // 手边还有什么能吃是她下一单要用的事实;一样都没有就是「包里没有任何食物」那一句
    throw new SkillBlocked(`包里没有点名的${zhName(itemName)};${edibleInBag(bot) ?? '包里没有任何食物'}`);
  }
  await bot.equip(food, 'hand');
  return consumeHeldFood(bot, itemName);
}

/** 按名字拿到手上 */
export async function equipNamed(bot: Bot, name: string): Promise<string> {
  const item = bot.inventory.items().find((i) => i.name === name || i.name.endsWith(`_${name}`));
  if (!item) throw new SkillBlocked(`包里没有${zhName(name)}`);
  await bot.equip(item, 'hand');
  return item.name;
}

/**
 * equipEmpty 优先切换到空快捷栏，再将主手物品移入背包。
 * 背包也满时会将主手栈丢到地上，回执须说明。
 */
export async function emptyHand(bot: Bot): Promise<string> {
  const held = bot.heldItem;
  if (!held) return '主手本来就是空的';
  const before = invCount(bot, (n) => n === held.name);
  await bot.unequip('hand');
  const left = invCount(bot, (n) => n === held.name);
  if (left < before) {
    return `主手腾空了;包是满的,${zhName(held.name)}×${before - left}被扔在了脚下`;
  }
  return `主手腾空了(原来拿的是${zhName(held.name)})`;
}

/**
 * 副手腾空:副手物品挪回背包。mineflayer 的 unequip 在包里既没空格、也没有能并进去的
 * 同种未满一摞时把它扔到地上,这种包况下不腾,受阻说明;并进去一部分后余下的被扔掉时照实报。
 */
async function emptyOffHand(bot: Bot): Promise<string> {
  const held = offHandItem(bot);
  if (!held) return '副手本来就是空的';
  const bag = bot.inventory.items();
  if (bag.length >= INVENTORY_SLOTS && !bag.some((i) => i.type === held.type && i.count < i.stackSize)) {
    throw new SkillBlocked(
      `包里 ${INVENTORY_SLOTS} 格全满,副手的${pickLabel(pickTargetOf(held, bot.registry as never))}放不回包里;` +
      '没腾,它还挂在副手',
    );
  }
  const before = invCount(bot, (n) => n === held.name);
  await bot.unequip('off-hand');
  const left = invCount(bot, (n) => n === held.name);
  if (left < before + held.count) {
    return `副手腾空了;包是满的,${zhName(held.name)}×${before + held.count - left}被扔在了脚下`;
  }
  return `副手腾空了(原来挂的是${zhName(held.name)})`;
}

/** item 缺省时腾空 hand 指的那只手(默认主手)；air 别名由 parseEquip 归一化。 */
export async function skillEquip(bot: Bot, call: Extract<SkillCall, { skill: 'equip' }>): Promise<string> {
  const want = call.item;
  if (!want) return call.hand === 'off' ? emptyOffHand(bot) : emptyHand(bot);
  // 精确名优先;退而求其次才用后缀(iron→iron_pickaxe),`includes` 会让
  // equip "iron" 命中哪一件全看物品栏顺序,那不是她说的意思
  const items = bot.inventory.items();
  const item = invItemNamed(bot, want, call.pick);
  const fromOffHand = !!item && item === offHandItem(bot);
  const worn = item && !fromOffHand ? null : equippedAlready(bot, want, call.hand, call.pick);
  if (worn) return `${zhName(worn.name)}本来就${worn.where}`;
  if (!item) {
    const same = items.filter((i) => namedLike(want, i.name));
    if (call.pick && same.length > 0) throw noSuchItem(bot, want, call.pick, same);
    const near = items.filter((i) => i.name.includes(want)).map((i) => zhName(i.name));
    throw new SkillBlocked(
      `包里没有${zhName(want)}` + (near.length > 0 ? `;名字带这几个字的有:${near.join('、')}` : ''),
    );
  }
  const dest = call.hand === 'off' ? 'off-hand' : call.hand === 'main' ? 'hand' : equipDestOf(item.name, bot.registry);
  await bot.equip(item, dest);
  // 点名拿的时候回执念全标签:「拿起了弓」答不了「拿的是无限那把吗」
  const what = call.pick ? pickLabel(pickTargetOf(item, bot.registry as never)) : zhName(item.name);
  if (dest === 'hand' && fromOffHand) {
    // 从副手挪到快捷栏时,目标格原有的东西会被换进副手
    const nowOff = offHandItem(bot);
    return `把副手的${what}换到了主手;` +
      (nowOff ? `快捷栏那格原来的${pickLabel(pickTargetOf(nowOff, bot.registry as never))}换进了副手` : '副手空了');
  }
  if (dest === 'hand') return `手里拿起了${what}`;
  if (dest === 'off-hand') return `${what}挂上了副手`;
  return `穿上了${what}`;
}

