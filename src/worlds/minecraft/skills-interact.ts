/**
 * 右键这个世界:use 及其各种形态(点格子、对活物、写告示牌、上船、与猪灵交易),
 * 以及 ride、lead、anvil、grindstone。
 *
 * 右键的结果一律回读世界或背包再报,不按客户端预测说话。
 */
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { BLOCK_FACES, cellOnFace, type BlockFace, type Cell } from './geometry.ts';
import {
  AIR_NAMES, LIQUIDS, blockAtCell, blockProp, cellText, dimensionOf, feetOf, resolveAt,
} from './cell-facts.ts';
import { zhDimension, zhEntity, zhName } from './names.ts';
import { SIGN_RE, signLinesText, zhThing } from './receipt.ts';
import { Aborted, SkillBlocked, SkillNoop, checkAbort, sleep, type SkillContext } from './skill-context.ts';
import {
  FEED_ITEMS, TAME_ITEMS, dyeColorOf, isKnownTarget, readHorseTamed, readSaddled, readSheepColor,
  readSitting, readTamedBy, tamedByMe, unknownUseTargetText,
} from './entity-facts.ts';
import { HOE_TILLED, SHOVEL_PATH } from './blueprint-registry.ts';
import {
  askedLabel, invCount, invGains, invLosses, invSnapshot, itemAsked, noSuchItem, type InvPred,
} from './inventory.ts';
import { SEED_CROP, noteTilled, noteWork } from './placed-ledger.ts';
import { isBabyPiglin } from './piglin.ts';
import { DIRECTION_ZH, bearing, droppedStackOf } from './terrain.ts';
import { findEntity, gotoGoal, reachCell } from './travel.ts';
import { type SkillCall } from './skills.ts';
import { skillTrade } from './skills-gather.ts';
import { consumeHeldFood, equipNamed } from './skills-craft.ts';
import { matchItemName } from './chests.ts';
import {
  ANVIL_BLOCKS, STATION_FIND_R, WINDOW_SETTLE_MS, findStationCell, openStationWindow,
  putIntoStation, rememberWindow, stationItemFacts,
} from './containers.ts';
import { isSpawnAnchorBlock } from './policy.ts';
import { DRINKABLES } from './item-facts.ts';
import { nearestBoat } from './placement.ts';
import { itemMatchesPick } from './item-pick.ts';

const { goals } = pathfinderPkg;

/** 投掷类:朝 at 看一眼然后甩出去,不是往那一格放东西 */
export const THROWN = new Set([
  'splash_potion', 'lingering_potion', 'ender_pearl', 'snowball', 'egg',
  'experience_bottle', 'eye_of_ender', 'trident',
]);

export function isThrown(name: string): boolean {
  return THROWN.has(name) || name.startsWith('splash_') || name.startsWith('lingering_');
}

/** 船与竹筏(含带箱版):所有木种一个后缀就认全,新木种不必回来加名字 */
export function isBoat(name: string): boolean {
  return name.endsWith('_boat') || name.endsWith('_raft');
}

/** 不写 at 放船时,按视线找落点面的射线上限(原版 BoatItem 的射线约 5 格) */
export const BOAT_CURSOR_RANGE = 5;

/** activateBlock 缺省点击顶面；效果表以此面计算外侧一格的位置。 */
export const USE_FACE: BlockFace = 'up';

/** 面名 → activateBlock 收的方向向量。 */
export function faceVector(face: BlockFace): Vec3 {
  const [x, y, z] = BLOCK_FACES[face];
  return new Vec3(x, y, z);
}

/**
 * 往一块告示牌上写字。原版这件事分两步:**先右键把编辑框打开**(服务端由此记住
 * "现在是谁在编辑这块牌子"),客户端再把四行字发回去;跳过第一步的 update_sign
 * 服务端一律丢掉。上蜡的牌子编辑不了,原版连编辑框都不开——先说清楚,别发一个
 * 注定被丢掉的包。
 *
 * 验收读的是写完之后服务端回灌的方块实体:`getSignText()` 给 [正面, 背面]。
 * 读回来的那一份原样进回执 —— 这是她第一次能确认"观众看到的是这几个字"。
 */
export async function writeSign(
  bot: Bot, cell: Cell, target: NonNullable<ReturnType<Bot['blockAt']>>, text: string, back: boolean,
): Promise<string> {
  const where = `${cellText(cell)} 的${zhName(target.name)}`;
  if (!SIGN_RE.test(target.name)) {
    throw new SkillBlocked(`${where}不是告示牌,写不了字(text 只对告示牌有用)`);
  }
  // 上蜡记在方块实体的 is_waxed 里(不是 block state),读不到就当没上过——这一层不猜
  const entityNbt = (target as unknown as { blockEntity?: Record<string, unknown> }).blockEntity;
  if (entityNbt?.is_waxed === 1 || entityNbt?.is_waxed === true) {
    throw new SkillBlocked(`${where}上过蜡,原版不让再编辑;先拿斧子右键把蜡刮掉`);
  }
  const side = back ? '背面' : '正面';
  const readSide = (b: ReturnType<Bot['blockAt']>): string | null => {
    const sign = b as unknown as { getSignText?: () => Array<string | undefined> } | null;
    if (!sign || typeof sign.getSignText !== 'function') return null;
    const both = sign.getSignText();
    const one = back ? both[1] : both[0];
    return typeof one === 'string' ? one.replace(/\s+$/, '') : null;
  };
  // 第一步:打开编辑框。空手右键才是"编辑",手上拿着染料/荧光墨囊/蜂巢时原版做的
  // 是别的事(改色/发光/上蜡),那几件当场拦下来,不然写不进去还看不出为什么。
  const held = bot.heldItem?.name ?? null;
  if (held && (dyeColorOf(held) !== null || held === 'glow_ink_sac' || held === 'ink_sac' || held === 'honeycomb')) {
    throw new SkillBlocked(
      `手上拿着${zhName(held)}时右键牌子做的是改色/发光/上蜡,不是打开编辑框;先 {"skill":"equip"} 空手再来写`,
    );
  }
  await bot.activateBlock(target);
  await sleep(USE_SETTLE_MS);
  bot.updateSign(target, text, back);
  await sleep(USE_SETTLE_MS);
  let now = readSide(bot.blockAt(new Vec3(cell.x, cell.y, cell.z)));
  if (now === null || now !== text.replace(/\s+$/, '')) {
    await sleep(USE_SETTLE_MS);
    now = readSide(bot.blockAt(new Vec3(cell.x, cell.y, cell.z)));
  }
  const wrote = signLinesText(text);
  if (now === null) {
    return `往${where}${side}写了 ${wrote};读不回牌子上的字(这个版本的方块实体没给),写没写上核不了`;
  }
  if (now !== text.replace(/\s+$/, '')) {
    throw new SkillBlocked(
      `往${where}${side}写了 ${wrote},读回来是${now === '' ? '(空的)' : ` ${signLinesText(now)}`}`,
      ['要看到的是:牌子上的字与写进去的一致'],
      'server',
    );
  }
  return `${where}${side}现在写着 ${signLinesText(now)}`;
}

/** 右键之后给服务端回话的时间;第一次没读到就再等一拍(睡着、上鞍要一个来回) */
export const USE_SETTLE_MS = 400;

/** 右键之后世界该变成什么样;`want` 与实测读数成对进回执 */
export interface UseProbe {
  /** 期望读到什么 */
  want: string;
  /** 右键之后读一次:办成了没有,以及实测读到的是什么 */
  read(): { met: boolean; actual: string };
}

/**
 * 锄地要求正上方 isAir，空碰撞形状的草、火把等也会阻挡。
 * rooted_dirt 不要求头顶空气；farmland 已是目标状态，两者放行。
 */
export function hoeCoverBlocked(bot: Bot, cell: Cell, target: string): string | null {
  if (HOE_TILLED[target] === undefined || target === 'rooted_dirt' || target === 'farmland') return null;
  const above = blockAtCell(bot, { x: cell.x, y: cell.y + 1, z: cell.z });
  if (!above || AIR_NAMES.has(above.name)) return null;
  return `${cellText(cell)} 头上盖着${zhName(above.name)},锄不动;先把它清掉`;
}

/** 空桶舀哪一格出哪一桶;流动的水舀不起来,读数自己会说(把握:确定) */
export const BUCKET_FILL: Record<string, string> = {
  water: 'water_bucket',
  lava: 'lava_bucket',
  powder_snow: 'powder_snow_bucket',
};

/** 满桶倒出去就变回空桶(把握:确定) */
export const FULL_BUCKETS = new Set(['water_bucket', 'lava_bucket', 'powder_snow_bucket']);

/** 打火石点上去是自身 lit 翻牌、而不是外面出火的那几种(把握:比较确定) */
export const LIT_BY_FIRE = /^(soul_)?campfire$|candle(_cake)?$/;

/** 点着之后外面那一格是什么:一般出火,灵魂沙族出灵魂火,黑曜石框里当场成传送门(把握:确定) */
export const FIRE_BLOCKS = new Set(['fire', 'soul_fire', 'nether_portal']);

/**
 * 右键就翻牌的开关族与它翻的那个属性。**判据是"翻了没有"而不是"翻成了哪一面"**——
 * 翻牌不需要知道她想要开还是想要关,而铁门/铁活板门空手翻不动,正是要判出来的那一类。
 * 按钮不在表里:它按下去自己会弹回来(石按钮 1 秒),读数是赛跑,判不了(把握:确定)。
 */
export const TOGGLES: ReadonlyArray<{ re: RegExp; prop: string }> = [
  { re: /(^|_)door$/, prop: 'open' },
  { re: /(^|_)trapdoor$/, prop: 'open' },
  { re: /_fence_gate$/, prop: 'open' },
  { re: /^lever$/, prop: 'powered' },
];

/** 挤得出奶的(把握:牛/哞菇确定,山羊比较确定) */
export const MILKABLE = new Set(['cow', 'mooshroom', 'goat']);

/** 上得了鞍的。**没驯服的马驴上不了**,鞍留在包里,读数自己会说(把握:比较确定) */
export const SADDLEABLE = new Set(['horse', 'donkey', 'mule', 'pig', 'strider', 'camel']);

/**
 * 读一格变成了什么;本来就是那样也算办成(与 build「本来就是火把」同一条)。
 * `where` 是读数在回执里怎么称呼这一格:被点的那一格叫「那一格」(回执头一句已经
 * 报过坐标),读外面一格的那几条要报出坐标,否则看不出读的是 y+1。
 */
export function probeCell(
  bot: Bot,
  cell: Cell,
  accept: (name: string) => boolean,
  want: string,
  where = '那一格',
): UseProbe {
  const was = blockAtCell(bot, cell)?.name ?? null;
  return {
    want,
    read: () => {
      const b = blockAtCell(bot, cell);
      if (!b) return { met: false, actual: `${cellText(cell)} 那里区块没加载` };
      const met = accept(b.name);
      const verb = b.name !== was ? '现在是' : met ? '本来就是' : '还是';
      return { met, actual: `${where}${verb}${zhName(b.name)}` };
    },
  };
}

/** 读包:某一类东西的净增(gain)或净减 */
export function probeInv(
  bot: Bot,
  pred: (name: string) => boolean,
  gain: boolean,
  label: string,
  want: string,
): UseProbe {
  const was = invCount(bot, pred);
  return {
    want,
    read: () => {
      const now = invCount(bot, pred);
      return { met: gain ? now > was : now < was, actual: `包里${label} ${was} → ${now} 个` };
    },
  };
}

/** 读被点那一格的方块状态属性(原版属性名直给);属性读不到就整条判不了,由调用方退回现状 */
export function probeProp(
  bot: Bot,
  cell: Cell,
  key: string,
  met: (was: string, now: string | null) => boolean,
  want: string,
): UseProbe | null {
  const was = blockProp(blockAtCell(bot, cell), key);
  if (was === null) return null;
  return {
    want,
    read: () => {
      const now = blockProp(blockAtCell(bot, cell), key);
      return { met: met(was, now), actual: `${key} ${was} → ${now ?? '(读不到)'}` };
    },
  };
}

/**
 * 按物品与目标确定右键效果的观测位置：床读 sleeping，种子读耕地上方。
 * 无法确定时返回 null，仅报告事实并记 debug。
 */
export function useProbeAt(
  bot: Bot, item: string | null, cell: Cell, target: string, ctx?: SkillContext, face: BlockFace = USE_FACE,
): UseProbe | null {
  const out = cellOnFace(cell, face);

  // 床、门、拉杆这几条与手上拿什么无关:原版里非潜行右键交互方块一律走交互
  if (/(^|_)bed$/.test(target)) {
    return {
      want: '躺下睡着',
      read: () => {
        if (bot.isSleeping === true) return { met: true, actual: '躺下了' };
        // startSleepInBed 先设置重生点，再判断能否睡眠；白天也可能改点但未入睡。
        const spawn = ctx?.spawnNote?.() ?? null;
        return {
          met: false,
          actual: `没躺下(现在 dayTime ${Math.round(bot.time?.timeOfDay ?? 0)})${spawn ? `,${spawn}` : ''}`,
        };
      },
    };
  }
  for (const t of TOGGLES) {
    if (t.re.test(target)) {
      return probeProp(bot, cell, t.prop, (was, now) => now !== null && now !== was, `${t.prop} 翻个面`);
    }
  }

  if (item === null) return null;
  if (item.endsWith('_hoe')) {
    const tilled = HOE_TILLED[target];
    return tilled ? probeCell(bot, cell, (n) => n === tilled, `${cellText(cell)} 变成${zhName(tilled)}`) : null;
  }
  if (item.endsWith('_shovel')) {
    const path = SHOVEL_PATH[target];
    return path ? probeCell(bot, cell, (n) => n === path, `${cellText(cell)} 变成${zhName(path)}`) : null;
  }
  const crop = SEED_CROP[item];
  if (crop !== undefined) {
    return target === 'farmland'
      ? probeCell(bot, out, (n) => n === crop, `${cellText(out)} 长出${zhName(crop)}`, `${cellText(out)} `)
      : null;
  }
  if (item === 'nether_wart') {
    return target === 'soul_sand'
      ? probeCell(bot, out, (n) => n === 'nether_wart', `${cellText(out)} 长出下界疣`, `${cellText(out)} `)
      : null;
  }
  if (item === 'bucket') {
    const filled = BUCKET_FILL[target];
    return filled
      ? probeInv(bot, (n) => n === filled, true, zhName(filled), `包里多一个${zhName(filled)}`)
      : null;
  }
  // 玻璃瓶只从水源装得到水;装满出来的物品 id 是 potion(水瓶与药水同名,靠内容区分)
  if (item === 'glass_bottle') {
    return target === 'water'
      ? probeInv(bot, (n) => n === 'potion', true, '水瓶', '包里多一个水瓶(物品 id 是 potion)')
      : null;
  }
  if (FULL_BUCKETS.has(item)) {
    return probeInv(bot, (n) => n === 'bucket', true, '空桶', '手上那桶倒出去,包里多一个空桶');
  }
  if (item === 'flint_and_steel' || item === 'fire_charge') {
    // 打火石点的是一个方块的面,空气与液体没有面可点
    if (AIR_NAMES.has(target) || LIQUIDS.has(target)) return null;
    if (target === 'tnt') return probeCell(bot, cell, (n) => AIR_NAMES.has(n), 'TNT 点着飞出去,那一格空出来');
    if (LIT_BY_FIRE.test(target)) return probeProp(bot, cell, 'lit', (_was, now) => now === 'true', 'lit 变 true');
    return probeCell(bot, out, (n) => FIRE_BLOCKS.has(n), `${cellText(out)} 烧起来`, `${cellText(out)} `);
  }
  if (item === 'bone_meal') {
    // 满龄的作物再撒骨粉原版什么都不发生、骨粉也不消耗,所以 age 没往上走就是没催动
    return probeProp(bot, cell, 'age', (was, now) => now !== null && Number(now) > Number(was), 'age 往上走一档');
  }
  // 唱片放进唱片机:方块自己的 has_record 翻牌,比"包里少了一张唱片"更靠近观众听见的那件事
  if (item !== null && item.startsWith('music_disc_') && target === 'jukebox') {
    return probeProp(bot, cell, 'has_record', (_was, now) => now === 'true', 'has_record 变 true(开始放了)');
  }
  // 篝火烤东西:原版一次只收一件,烤不下(四个位置满了/这东西不能烤)时**不消耗**
  if (item !== null && CAMPFIRES.has(target) && (bot.registry?.foodsByName as Record<string, unknown> | undefined)?.[item]) {
    return probeInv(bot, (n) => n === item, false, zhName(item), `${zhName(item)}被放上篝火(包里少一个)`);
  }
  // 展示框与画不是方块,是贴在某一面上的实体:世界侧读不到,读"包里少了一个"
  if (item !== null && WALL_ENTITY_ITEMS.has(item)) {
    return probeInv(bot, (n) => n === item, false, zhName(item), `${zhName(item)}挂上去(包里少一个)`);
  }
  return null;
}

/** 烤东西的那两种火堆(把握:确定) */
export const CAMPFIRES = new Set(['campfire', 'soul_campfire']);

/** 画只允许侧面，展示框允许六面；此类物品需明确放置面。 */
export const WALL_ENTITY_ITEMS = new Set(['item_frame', 'glow_item_frame', 'painting']);

/** (手上这样东西 × 右键的那只活物)→ 右键之后该读哪儿;判不了返回 null */
export function useProbeOn(bot: Bot, item: string | null, target: string, entity?: unknown): UseProbe | null {
  if (item === 'shears' && target === 'sheep') {
    return probeInv(bot, (n) => n.endsWith('_wool'), true, '羊毛', '包里多出羊毛');
  }
  if (item === 'bucket' && MILKABLE.has(target)) {
    return probeInv(bot, (n) => n === 'milk_bucket', true, '奶桶', '包里多一桶奶');
  }
  if (item === 'saddle' && SADDLEABLE.has(target)) {
    return probeInv(bot, (n) => n === 'saddle', false, '鞍', '鞍从包里装到它身上');
  }
  // 染羊:原版只在"颜色真的变了"时才消耗染料,所以读回它现在的颜色是精确判据
  const dye = dyeColorOf(item);
  if (dye !== null && target === 'sheep') {
    return {
      want: `这只羊身上变成${zhName(`${dye}_wool`)}`,
      read: () => {
        const now = readSheepColor(bot as never, (entity ?? {}) as never);
        if (now === null) return { met: false, actual: '读不到它身上的羊毛颜色' };
        return { met: now === dye, actual: `它现在身上是${zhName(`${now}_wool`)}` };
      },
    };
  }
  return null;
}

/**
 * 右键活物之后附在回执尾巴上的**事实**(不判成没成)。驯服与喂食都是"这一下被
 * 接受了"与"目标状态到了没有"两回事:骨头每次都会被吃掉而驯服是随机的(原版 1/3),
 * 喂食则相反——**喂不进去就不消耗**。把这两条规则连同当下读数一起说清,
 * 她自己就能判断该不该再来一次;判断本身不替她做。
 */
export function useNoteOn(bot: Bot, item: string | null, target: string, entity: unknown): string {
  if (!item) {
    // 驯服类空手交互按服务端元数据回报坐姿等状态。
    if (TAME_ITEMS[target] === undefined) return '';
    const sit = readSitting(bot as never, entity as never);
    return sit === null ? '' : `;它现在${sit ? '坐着' : '站着'}`;
  }
  if ((TAME_ITEMS[target] ?? []).includes(item)) {
    const owner = readTamedBy(bot as never, entity as never);
    const mine = tamedByMe(bot as never, entity as never);
    const state = owner === null ? '它现在还没有主人' : mine ? '它认你当主人了' : '它已经有别的主人了';
    return `;${state}(${zhName(item)}每次都会被吃掉,驯服成不成是随机的,没成就再来一次)`;
  }
  if ((FEED_ITEMS[target] ?? []).includes(item)) {
    return `;原版喂不进去就不会消耗${zhName(item)}——包里少了 1 个就是这一口被接受了,一个没少说明它现在吃不进去`
      + '(未成年、刚繁殖过还在冷却、或者不吃这个)';
  }
  return '';
}

/** 右键骑乘后报告当前坐骑并说明 ride 用法，不自动下车。 */
export function leaveVehicle(bot: Bot, target: string): string {
  const vehicle = (bot as unknown as { vehicle?: { name?: string } | null }).vehicle;
  if (!vehicle) return '';
  return `;人已经骑在${zhEntity(target)}身上了:驾着走用 {"skill":"ride","to":[x,y,z]},下来用 {"skill":"ride","off":true}`;
}

/**
 * 落在效果表外的那一对记一条。**这张表要长出来只能靠它**:下一场直接按
 * `use-off-table` 就数得出还缺哪些对,不必再从全场回执里反推。
 */
export function noteOffTable(ctx: SkillContext, item: string | null, target: string): void {
  ctx.diag?.write({
    lane: 'skill', event: 'use-off-table', taskId: ctx.taskId,
    msg: `${item ? zhName(item) : '空手'}右键${zhThing(target)}:效果表里没这一对,只报事实`,
    data: { item, target },
  });
}

/**
 * 睡着之后等到醒。上限按一个游戏夜给足余量:原版躺下被受理后 101 tick(约 5 秒)
 * 就天亮,60 秒是它的十几倍;真卡在这上限里(别人不睡、被打断)就自己起来,
 * 不能把整条队列拖在床上。
 */
export const BED_WAKE_MS = 60_000;
export const BED_WAKE_POLL_MS = 250;

/**
 * 躺下之后不返回,等到醒 —— 这一步还没结束,后面那一步的寻路就动不了身。
 * 被抢占(战斗/mc_stop/World 停机)当场收工:那些抢占本来就该把人从床上叫起来。
 * 返回回执里的那半句(等了多久、是自己醒的还是到点起的)。
 */
export async function waitForWake(bot: Bot, ctx: SkillContext): Promise<string> {
  if (bot.isSleeping !== true) return '';
  const from = Date.now();
  // 周期进度事件在这段时间里要换一句话说:人不动是因为在睡,不是卡住了
  ctx.sleeping = true;
  try {
    while (bot.isSleeping === true && Date.now() - from < BED_WAKE_MS && !ctx.aborted()) {
      await sleep(BED_WAKE_POLL_MS);
    }
  } finally {
    ctx.sleeping = false;
  }
  const secs = Math.round((Date.now() - from) / 1000);
  if (bot.isSleeping !== true) return `,一直躺到醒(${secs}s,这段时间没动身)`;
  try {
    await bot.wake();
  } catch {
    /* 已经不在床上了 */
  }
  return `,躺了 ${secs}s 还没到天亮,自己起来了`;
}

/** 读一次;没读到就再等一拍读第二次(服务端回话可能落在第一次读之后) */
export async function settleProbe(probe: UseProbe): Promise<{ met: boolean; actual: string }> {
  const first = probe.read();
  if (first.met) return first;
  await sleep(USE_SETTLE_MS);
  return probe.read();
}

/** 一次右键在包里留下的痕迹:进包的与用掉的都报。一样没动返回空串,不占一句话 */
export function useInvNote(before: Map<string, number>, bot: Bot): string {
  const parts: string[] = [];
  const gains = invGains(before, bot);
  const losses = invLosses(before, bot);
  if (gains.length > 0) parts.push(`进包:${gains.join('、')}`);
  if (losses.length > 0) parts.push(`用掉:${losses.join('、')}`);
  return parts.join(';');
}

export const PIGLIN_ACCEPT_MS = 1_500;
export const PIGLIN_GIFT_MS = 10_000;

export function adultPiglins(bot: Bot, radius: number): Array<NonNullable<Bot['entities'][string]>> {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter((e): e is NonNullable<Bot['entities'][string]> => Boolean(
      e?.isValid && e.name === 'piglin' && e.position
      && e.position.distanceTo(me) <= radius && !isBabyPiglin(bot, e),
    ))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
}

export function piglinDrops(
  bot: Bot,
  beforeIds: ReadonlySet<number>,
  near: { x: number; y: number; z: number },
): Array<{ id: number; name: string; count: number; x: number; y: number; z: number }> {
  const out: Array<{ id: number; name: string; count: number; x: number; y: number; z: number }> = [];
  const center = new Vec3(near.x, near.y, near.z);
  for (const e of Object.values(bot.entities)) {
    if (!e?.isValid || typeof e.id !== 'number' || beforeIds.has(e.id) || !e.position) continue;
    const stack = droppedStackOf(e);
    if (!stack || e.position.distanceTo(center) > 5) continue;
    out.push({ id: e.id, name: stack.name, count: stack.count, x: e.position.x, y: e.position.y, z: e.position.z });
  }
  return out;
}

/** 给金后的数秒延迟属于这次交互的一部分；看到实际回礼或明确超时才结束。 */
export async function barterPiglinOnce(bot: Bot, ctx: SkillContext): Promise<string> {
  const adults = adultPiglins(bot, 32);
  if (adults.length === 0) {
    const babies = Object.values(bot.entities).filter((e) =>
      e?.isValid && e.name === 'piglin' && e.position.distanceTo(bot.entity.position) <= 32
      && isBabyPiglin(bot, e));
    if (babies.length > 0) throw new SkillBlocked('附近只有幼年猪灵;它不会以物易物,金锭没有交出去');
    throw new SkillNoop('附近 32 格内没有成年猪灵');
  }
  const piglin = adults[0];
  await gotoGoal(bot, new goals.GoalFollow(piglin, 2), ctx).catch(() => undefined);
  checkAbort(ctx);
  if (!piglin.isValid) throw new SkillBlocked('走到跟前时成年猪灵已经走了');
  await bot.lookAt(piglin.position.offset(0, (piglin.height ?? 1) * 0.5, 0));

  const beforeInv = invSnapshot(bot);
  const beforeGold = invCount(bot, (name) => name === 'gold_ingot');
  const beforeIds = new Set(Object.values(bot.entities)
    .map((e) => e?.id)
    .filter((id): id is number => typeof id === 'number'));
  const clickAt = { x: piglin.position.x, y: piglin.position.y, z: piglin.position.z };
  await bot.useOn(piglin);

  const acceptedUntil = Date.now() + PIGLIN_ACCEPT_MS;
  while (Date.now() < acceptedUntil && invCount(bot, (name) => name === 'gold_ingot') >= beforeGold) {
    checkAbort(ctx);
    await sleep(100);
  }
  const afterGold = invCount(bot, (name) => name === 'gold_ingot');
  if (afterGold >= beforeGold) {
    throw new SkillBlocked('成年猪灵没有收下金锭:包里的金锭数量没变,这次没有成交', [], 'server');
  }

  const giftUntil = Date.now() + PIGLIN_GIFT_MS;
  while (Date.now() < giftUntil) {
    checkAbort(ctx);
    const gains = invGains(beforeInv, bot);
    if (gains.length > 0) {
      return `成年猪灵收了金锭×${beforeGold - afterGold},回礼已经进包:${gains.join('、')}`;
    }
    const drops = piglinDrops(bot, beforeIds, piglin.isValid ? piglin.position : clickAt);
    if (drops.length > 0) {
      await sleep(300);
      const settled = piglinDrops(bot, beforeIds, piglin.isValid ? piglin.position : clickAt);
      const seen = settled.length > 0 ? settled : drops;
      return `成年猪灵收了金锭×${beforeGold - afterGold},回礼落在地上:`
        + seen.map((d) => `${zhName(d.name)}×${d.count} (${Math.round(d.x)}, ${Math.round(d.y)}, ${Math.round(d.z)})`).join('、')
        + '。这一步没有替你捡';
    }
    await sleep(100);
  }
  throw new SkillBlocked(
    `成年猪灵已经收走金锭×${beforeGold - afterGold},但 ${Math.round(PIGLIN_GIFT_MS / 1000)} 秒内没观察到回礼;金锭已消耗,结果未知`,
    [],
    'server',
  );
}

/** 未被效果表识别的空气或液体交互按受阻回报；桶类使用由专门分支处理。 */
export function nothingThere(bot: Bot, cell: Cell, name: string, label: string): SkillBlocked {
  const below = { x: cell.x, y: cell.y - 1, z: cell.z };
  const b = blockAtCell(bot, below);
  return new SkillBlocked(
    `${cellText(cell)} 那一格是${AIR_NAMES.has(name) ? '空气' : zhName(name)},${label}右键它不产生任何动作`,
    [`下面一格 ${cellText(below)} 是${b ? zhName(b.name) : '(区块没加载)'}`],
  );
}

/**
 * 右键 `times` 次(缺省 1)。每次都重新拿一次手上那样东西,所以东西中途用完
 * 就停在那一次:做成几次是事实,报出来;一次都没做成才是受阻(与 build
 * 「一块都没放上就是受阻」同一条)。
 */
export async function skillUse(bot: Bot, call: Extract<SkillCall, { skill: 'use' }>, ctx: SkillContext): Promise<string> {
  // 商人的"右键"开出来的是报价窗口,交易两段式走自己那条路(times 在那边是成交几次)
  if (call.target === 'villager' || call.target === 'wandering_trader') {
    return skillTrade(bot, { ...call, target: call.target }, ctx);
  }
  const times = call.times ?? 1;
  let last = '';
  let done = 0;
  const receipts: string[] = [];
  // times > 1 时同时回报整段库存净差与最后一次现场读数。
  const beforeSpan = invSnapshot(bot);
  const spanNote = () => {
    const net = useInvNote(beforeSpan, bot);
    return `这 ${done} 次合计${net ? `(${net})` : '包里一样没动'}`;
  };
  for (let i = 0; i < times; i += 1) {
    try {
      last = await useOnce(bot, call, ctx);
      receipts.push(last);
      done += 1;
    } catch (err) {
      if (err instanceof Aborted || done === 0) throw err;
      if (call.target === 'piglin' && call.item === 'gold_ingot') {
        ctx.partial?.(`第 ${done + 1} 次交易没有得到可确认的回礼:${(err as Error).message}`);
      }
      const finished = call.target === 'piglin' && call.item === 'gold_ingot'
        ? `已完成:${receipts.join('；')}`
        : `${spanNote()}。最后一次:${last}`;
      return `右键了 ${done}/${times} 次,第 ${done + 1} 次停下:${(err as Error).message}。${finished}`;
    }
  }
  if (times === 1) return last;
  return call.target === 'piglin' && call.item === 'gold_ingot'
    ? `交易了 ${done}/${times} 次:${receipts.join('；')}`
    : `右键了 ${done}/${times} 次,${spanNote()}。最后一次:${last}`;
}

/** 一次右键:三种宾语(某一格 / 某只活物 / 手上这样东西本身) */
export async function useOnce(bot: Bot, call: Extract<SkillCall, { skill: 'use' }>, ctx: SkillContext): Promise<string> {
  // 未指定 item 时，按当前实际手持物回报。
  let held: string | null;
  if (call.item) {
    try {
      held = await equipNamed(bot, call.item);
    } catch (err) {
      // 点名物品缺货而 at 格本身就是该物品时，回执提示直接右键该格的写法。
      if (err instanceof SkillBlocked && call.at) {
        const cell = resolveAt(bot, call.at);
        const b = blockAtCell(bot, cell);
        if (b && matchItemName(call.item, b.name)) {
          throw new SkillBlocked(
            `${err.message};不过 ${cellText(cell)} 那一格本身就是${zhName(b.name)}——` +
            `要右键它不用带 item,写 {"skill":"use","at":[${cell.x},${cell.y},${cell.z}]} 空手点它就行`,
          );
        }
      }
      throw err;
    }
  } else {
    held = bot.heldItem?.name ?? null;
  }
  const label = held ? zhName(held) : '空手';

  if (call.target === 'piglin_brute' && held === 'gold_ingot') {
    throw new SkillBlocked('猪灵蛮兵不接受以物易物,金锭没有交出去');
  }
  if (call.target === 'piglin' && held === 'gold_ingot') return barterPiglinOnce(bot, ctx);

  if (call.target) {
    if (!isKnownTarget(bot, call.target)) throw new SkillBlocked(unknownUseTargetText(bot, call.target));
    const entity = findEntity(bot, call.target, 32);
    if (!entity) throw new SkillNoop(`附近 32 格内没有${zhEntity(call.target)}`);
    await gotoGoal(bot, new goals.GoalFollow(entity, 2), ctx).catch(() => undefined);
    checkAbort(ctx);
    if (!entity.isValid) throw new SkillBlocked(`${zhEntity(call.target)}走了`);
    await bot.lookAt(entity.position.offset(0, (entity.height ?? 1) * 0.5, 0));
    const beforeInv = invSnapshot(bot);
    const probe = useProbeOn(bot, held, call.target, entity);
    await bot.useOn(entity);
    await sleep(USE_SETTLE_MS);
    const head = `${label}右键了${zhEntity(call.target)}`;
    const note = useInvNote(beforeInv, bot);
    const facts = useNoteOn(bot, held, call.target, entity) + leaveVehicle(bot, call.target);
    if (!probe) {
      noteOffTable(ctx, held, call.target);
      return `${head}。${note || '包里一样没动'}${facts}`;
    }
    const v = await settleProbe(probe);
    if (!v.met) throw new SkillBlocked(`${head},${v.actual}${facts}`, [`要看到的是:${probe.want}`], 'server');
    return `${head},${v.actual}${note ? `。${note}` : ''}${facts}`;
  }

  // 放船未指定 at 时使用当前视线命中的方块；无命中则受阻。
  if (held && isBoat(held) && !call.at) {
    const cur = bot.blockAtCursor?.(BOAT_CURSOR_RANGE);
    if (!cur) {
      throw new SkillBlocked(
        `手上是${label}而没给 at,视线 ${BOAT_CURSOR_RANGE} 格内又没有方块;放船要么看着水面/地面,要么给 at 指一格落点`,
      );
    }
    return await useBoat(bot, { x: cur.position.x, y: cur.position.y, z: cur.position.z }, held, label);
  }

  if (call.at) {
    const cell = resolveAt(bot, call.at);
    // 投掷物的 at 是落点方向,不是要改的那一格
    if (held && isThrown(held)) {
      const before = invCount(bot, (n) => n === held);
      await aimThenUse(bot, new Vec3(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5));
      await sleep(300);
      return `朝 ${cellText(cell)} 扔了${label};包里还有 ${invCount(bot, (n) => n === held)} 个(扔前 ${before})`;
    }
    await reachCell(bot, cell, ctx);
    checkAbort(ctx);
    const target = blockAtCell(bot, cell);
    if (!target) throw new SkillBlocked(`${cellText(cell)} 所在区块没加载`);
    // 船由 BoatItem 的 use 沿玩家视线生成，不能通过 use_item_on 放置。
    if (held && isBoat(held)) return await useBoat(bot, cell, held, label);
    if (held?.endsWith('_hoe')) {
      const covered = hoeCoverBlocked(bot, cell, target.name);
      if (covered) throw new SkillBlocked(covered);
    }
    const bucketFluid = held === 'bucket' && (target.name === 'water' || target.name === 'lava');
    const fluidLevel = bucketFluid ? blockProp(target, 'level') : null;
    const fluidSource = bucketFluid ? fluidLevel === '0' : false;
    const fluidFact = bucketFluid
      ? `level=${fluidLevel ?? '(读不到)'}, source=${fluidSource ? 'true' : 'false'}`
      : '';
    // 空桶只舀原版源方块。先读 block state 再发 use 包，流动液体不会消耗一次无效右键。
    if (bucketFluid && !fluidSource) {
      throw new SkillBlocked(
        `${cellText(cell)} 的${zhName(target.name)}是流动液体或来源状态不可读(${fluidFact});空桶只舀 level=0 的源方块`,
      );
    }
    // 写牌子先走独立牌面验收，不进入通用效果表的表外记录。
    if (call.text !== undefined) return await writeSign(bot, cell, target, call.text, call.back === true);
    // 空手右键告示牌打开 open_sign_editor；它不是窗口包，rememberWindow 无法观察。
    if (!held && SIGN_RE.test(target.name)) {
      await bot.activateBlock(target);
      await sleep(USE_SETTLE_MS);
      return `空手右键了 ${cellText(cell)} 的${zhName(target.name)}:这一下把编辑框打开了,没写字;要写字就在同一条 use 里给 text`;
    }
    // (item, 目标方块) 表决定去哪儿读;表外那一对退回「报事实不下结论」
    const probe = useProbeAt(bot, held, cell, target.name, ctx, call.face);
    if (!probe) {
      // 空桶没有“对任意方块试一下”的安全泛型语义。粉雪、水源和岩浆源都在效果表里；
      // 其余方块若无明确 handler，库存不变不能再被记作 done。
      if (held === 'bucket') {
        throw new SkillBlocked(`${cellText(cell)} 的${zhName(target.name)}没有空桶可执行的明确操作,没有使用`);
      }
      if (AIR_NAMES.has(target.name) || LIQUIDS.has(target.name)) {
        throw nothingThere(bot, cell, target.name, label);
      }
      noteOffTable(ctx, held, target.name);
    }
    // BucketItem 使用 use_item，由服务端沿视线选液源或放置点；activateBlock 仅发
    // use_item_on，不能完成桶类操作。满桶可倒入空气或实心面的外侧，空桶须满足液源条件。
    const pouring = held !== null && FULL_BUCKETS.has(held);
    // 粉雪没有液体 level，单独走粉雪桶 handler；玻璃瓶装水不使用空桶的源方块契约。
    const scoopingPowderSnow = held === 'bucket' && target.name === 'powder_snow';
    const fillingBottle = held === 'glass_bottle' && target.name === 'water';
    const filling = bucketFluid || scoopingPowderSnow || fillingBottle;
    if (filling || pouring) {
      const beforeScoop = invSnapshot(bot);
      // 瞄点照船那一套:实心格瞄它的顶面(液体落在上面那格),空气/液体格瞄这一格自己
      const solidHere = !AIR_NAMES.has(target.name) && !LIQUIDS.has(target.name);
      await aimThenUse(
        bot,
        solidHere
          ? new Vec3(cell.x + 0.5, cell.y + 1, cell.z + 0.5)
          : new Vec3(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5),
      );
      await sleep(USE_SETTLE_MS);
      const scoopHead = `${label}右键了 ${cellText(cell)} 的${zhName(target.name)}`
        + `${fluidFact ? `(${fluidFact})` : ''}`;
      const scoopNote = useInvNote(beforeScoop, bot);
      // 桶倒空了、水却一格都不留:下界的水放出来当场蒸发。如实说,不拦
      const vapor = held === 'water_bucket' && dimensionOf(bot).includes('nether')
        ? ';水在下界会立刻蒸发,那一格不会留下水'
        : '';
      if (probe) {
        const v = await settleProbe(probe);
        // 失败路径同样带上背包增减:少了这一句,25 次倒水失败她只看得见「空桶 0 → 0」,
        // 看不见「水桶 1 → 1、还在包里」这个把病因指出来的事实
        if (!v.met) {
          throw new SkillBlocked(
            `${scoopHead},${v.actual}${scoopNote ? `。${scoopNote}` : ''}${vapor}`,
            [`要看到的是:${probe.want}`],
            'server',
          );
        }
        return `${scoopHead},${v.actual}${scoopNote ? `。${scoopNote}` : ''}${vapor}`;
      }
      return `${scoopHead}。${scoopNote || '包里一样没动'}${vapor}`;
    }
    const beforeInv = invSnapshot(bot);
    await bot.activateBlock(target, call.face ? faceVector(call.face) : undefined);
    await sleep(USE_SETTLE_MS);
    // 容器窗口关闭前，将实际读到的内容写入容器账本。
    let seen = '';
    if (bot.currentWindow) {
      seen = rememberWindow(bot, ctx, cell, target.name, bot.currentWindow);
      bot.closeWindow(bot.currentWindow);
    }
    // 床只在主世界能睡:下界与末地点它当场爆炸。不拦她(打龙就是拿这个当伤害手段),
    // 只把这件事说清 —— 现有回执只有「躺下了/没躺下」,读不出人是被自己炸的
    const bedBoom = target.name.endsWith('_bed') && !dimensionOf(bot).includes('overworld')
      ? `;床在${zhDimension(dimensionOf(bot))}这个维度会爆炸,不会躺下`
      : '';
    const head = `${label}右键了 ${cellText(cell)} 的${zhName(target.name)}${bedBoom}`;
    const note = useInvNote(beforeInv, bot);
    if (!probe) {
      // 右键箱子是开一下看看、按钮按下去自己弹回来:原版里这些本来就没有"成没成"
      const after = blockAtCell(bot, cell);
      const changed = after && after.stateId !== target.stateId ? `,那一格现在是${zhName(after.name)}` : '';
      return `${head}${changed}。${note || '包里一样没动'}${seen}`;
    }
    const v = await settleProbe(probe);
    // 失败路径与成功路径报同一份背包增减:存量事实往往就是病因所在
    if (!v.met) {
      throw new SkillBlocked(
        `${head},${v.actual}${note ? `。${note}` : ''}`,
        [`要看到的是:${probe.want}`],
        'server',
      );
    }
    // 入睡后等待醒来再结束本步，避免后续寻路在睡眠期间取得身体。
    const slept = isSpawnAnchorBlock(target.name) ? await waitForWake(bot, ctx) : '';
    // 锄成耕地的那一格记一笔;再锄同一格说明它被踩回去过(见 tilledOf)
    const retilled = held?.endsWith('_hoe') && target.name !== 'farmland' && HOE_TILLED[target.name] === 'farmland'
      ? noteTilled(bot, cell)
      : '';
    noteWork(bot, ctx, held, cell, target.name);
    return `${head},${v.actual}${slept}${note ? `。${note}` : ''}${seen}${retilled}`;
  }

  if (!held) throw new SkillBlocked('空手又没给 at/target');
  if (held === 'eye_of_ender') return throwEnderEye(bot, ctx);
  // 手上是吃的/喝的就走真进食通道:通用兜底按一下 1.2 秒就松手,喝完一桶奶要 1.61 秒,
  // 从那条路走的奶永远喝不下去(只会回一句「这样东西没有登记的使用效果」)
  if ((bot.registry?.foodsByName as Record<string, unknown> | undefined)?.[held] || DRINKABLES[held]) {
    return consumeHeldFood(bot, held);
  }
  // 通用使用按整包前后差值回报；无变化时明确无法确认效果。
  const beforeInv = invSnapshot(bot);
  await bot.activateItem();
  await sleep(1_200);
  bot.deactivateItem();
  await sleep(200);
  const note = useInvNote(beforeInv, bot);
  return note
    ? `用了${label};${note}`
    : `拿着${label}按了一下使用;包里一样没动,这样东西没有登记的使用效果,光凭库存读不出有没有发生什么`;
}

/**
 * 扔一颗末影之眼,盯着它飞。原版:它朝要塞方向飞出去再落下,20% 概率碎掉。
 * 现有 `use` 只报「包里少了一个」,而她要的那个读数在飞行途中 —— 飞向哪边、飞多远。
 * 纯观测:一个「往那边走」都不说。
 */
/**
 * lookAt 先改本地朝向；等待物理 tick 发出朝向包后再发送 use_item。
 * 1.20.6 的 use_item 仅含 hand/sequence，1.21.2 才加入朝向字段。
 * physicsTick 与 updatePosition 同步执行，waitForTicks 续体在整次 tick 结束后恢复。
 */
export async function aimThenUse(bot: Bot, point: Vec3): Promise<void> {
  await bot.lookAt(point, true);
  await bot.waitForTicks(1);
  await bot.activateItem();
}

/** 原版末影之眼飞 40–80 刻(2–4 秒)就消失,盯 6 秒足够,盯不到就说盯不到 */
export const ENDER_EYE_WATCH_MS = 6_000;

export async function throwEnderEye(bot: Bot, ctx: SkillContext): Promise<string> {
  const from = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
  const before = invCount(bot, (n) => n === 'eye_of_ender');
  await bot.activateItem();
  const deadline = Date.now() + ENDER_EYE_WATCH_MS;
  let last: { x: number; y: number; z: number } | null = null;
  let seen = false;
  while (Date.now() < deadline) {
    checkAbort(ctx);
    const eye = Object.values(bot.entities)
      .find((e) => e?.name === 'eye_of_ender' && e.position);
    if (eye?.position) {
      seen = true;
      last = { x: eye.position.x, y: eye.position.y, z: eye.position.z };
    } else if (seen) break;
    await sleep(150);
  }
  const after = invCount(bot, (n) => n === 'eye_of_ender');
  if (!last) return `扔出去了,但一路没看见那颗末影之眼(包里 ${before} → ${after} 个)`;
  const dist = Math.round(Math.hypot(last.x - from.x, last.z - from.z));
  const dir = bearing(last.x - from.x, last.z - from.z);
  const dy = Math.round(last.y - from.y);
  const drop = Object.values(bot.entities).some(
    (e) => e?.name === 'item' && e.position
      && Math.hypot(e.position.x - last!.x, e.position.y - last!.y, e.position.z - last!.z) <= 4,
  );
  const fell = drop
    ? '落地了,地上有掉落物'
    : '没看见它落地(20% 概率会碎,也可能落在视野外)';
  return `末影之眼朝${dir ? DIRECTION_ZH[dir] : '正上下'}飞了 ${dist} 格`
    + `${dy === 0 ? '' : `,${dy > 0 ? '升' : '降'}了 ${Math.abs(dy)} 格`}`
    + `,最后看见它在 (${Math.round(last.x)}, ${Math.round(last.y)}, ${Math.round(last.z)});${fell}。`
    + `包里 ${before} → ${after} 个`;
}

/**
 * 放一条船:瞄准托住它的那个面按「使用物品」,再按包里少没少、附近多没多出一条船来报。
 *
 * `at` 给空气格就瞄它脚下那格的顶面(船落进 `at` 这一格),给实心格就瞄这一格自己的
 * 顶面(船落在它上面)。两种写法都成立,回执报船最后落在哪儿,不必她先猜对哪一格。
 */
export async function useBoat(bot: Bot, cell: Cell, held: string, label: string): Promise<string> {
  const here = blockAtCell(bot, cell);
  const solidHere = here !== null && !AIR_NAMES.has(here.name) && !LIQUIDS.has(here.name);
  const face = { x: cell.x, y: solidHere ? cell.y + 1 : cell.y, z: cell.z };
  const under = blockAtCell(bot, { x: face.x, y: face.y - 1, z: face.z });
  if (!under || AIR_NAMES.has(under.name)) {
    throw new SkillBlocked(
      `${cellText(face)} 底下是${under ? zhName(under.name) : '(区块没加载)'},没有能托住船的面`,
    );
  }
  const before = invCount(bot, (n) => n === held);
  await aimThenUse(bot, new Vec3(face.x + 0.5, face.y, face.z + 0.5));
  await sleep(USE_SETTLE_MS);
  const after = invCount(bot, (n) => n === held);
  if (after >= before) {
    throw new SkillBlocked(
      `朝 ${cellText(face)} 放${label},船没出来:包里还是 ${after} 条`,
      [`瞄的是 ${cellText({ x: face.x, y: face.y - 1, z: face.z })} 的${zhName(under.name)}顶面`],
      'server',
    );
  }
  const boat = nearestBoat(bot, face);
  if (boat) return `${label}放在 ${cellText(boat)};包里 ${before} → ${after} 条`;
  // 不做「包里少了=放成了」的二级软假设:两个读数分开说,落点没读到就是没读到
  return `朝 ${cellText(face)} 放${label}:包里 ${before} → ${after} 条,但附近 4 格内没扫到船的实体,船落在哪儿没读到`;
}

// ======================== ride:上/驾/下坐骑 ========================

/** ride 找坐骑的半径,与 use 的活物半径一致 */
export const RIDE_FIND_R = 32;
/** 驾驭:到点判定(水平距离) */
export const RIDE_ARRIVE_R = 2.5;
/** 驾驭:这么久推进不足 1 格就按卡死收场(下车+如实回执) */
export const RIDE_STALL_MS = 20_000;
/** 驾驭:发包节拍(与游戏 tick 同步) */
export const RIDE_TICK_MS = 50;
/**
 * 支持驾驭的载具及每物理 tick 的步长，单位为格。
 * 马的位置包受服务端纠偏，暂不支持驾驭；仍支持骑乘和下车。
 */
export const RIDE_STEP: Readonly<Record<string, number>> = {
  pig: 0.12, strider: 0.12, boat: 0.3, chest_boat: 0.3,
};
export const RIDE_STEP_DEFAULT = 0.12;
/** 驾驭这一种要手持的道具(服务端认「受控」的前提;拿掉它坐骑就不听使唤) */
export const RIDE_CONTROL_ITEM: Readonly<Record<string, string>> = {
  pig: 'carrot_on_a_stick', strider: 'warped_fungus_on_a_stick',
};

export interface VehicleEntity { name?: string; position: Vec3; height?: number }
export interface RideClient {
  write(name: string, data: Record<string, unknown>): void;
  on(name: string, fn: (p: { x: number; y: number; z: number }) => void): void;
  removeListener(name: string, fn: (p: { x: number; y: number; z: number }) => void): void;
}

export function vehicleOf(bot: Bot): VehicleEntity | null {
  return (bot as unknown as { vehicle?: VehicleEntity | null }).vehicle ?? null;
}

export async function skillRide(bot: Bot, call: Extract<SkillCall, { skill: 'ride' }>, ctx: SkillContext): Promise<string> {
  if (call.off) {
    const v = vehicleOf(bot);
    if (!v) throw new SkillNoop('没骑着任何东西');
    const name = zhEntity(v.name ?? '坐骑');
    bot.dismount();
    const t0 = Date.now();
    while (vehicleOf(bot) && Date.now() - t0 < 3000) await sleep(100);
    if (vehicleOf(bot)) throw new SkillBlocked(`从${name}上下不来:发了下坐骑的包,3 秒后人还在上面`, [], 'server');
    await sleep(300); // 等服务端把人摆到下车点
    return `从${name}上下来了,人在 ${cellText(feetOf(bot))}`;
  }

  if (call.target) {
    const riding = vehicleOf(bot);
    if (riding) {
      if ((riding.name ?? '') !== call.target) {
        throw new SkillBlocked(`人还骑在${zhEntity(riding.name ?? '坐骑')}上;先 {"skill":"ride","off":true} 下来再骑别的`);
      }
    } else {
      if (!isKnownTarget(bot, call.target)) throw new SkillBlocked(unknownUseTargetText(bot, call.target));
      const entity = findEntity(bot, call.target, RIDE_FIND_R);
      if (!entity) throw new SkillNoop(`附近 ${RIDE_FIND_R} 格内没有${zhEntity(call.target)}`);
      await gotoGoal(bot, new goals.GoalFollow(entity, 2), ctx).catch(() => undefined);
      checkAbort(ctx);
      if (!entity.isValid) throw new SkillBlocked(`${zhEntity(call.target)}走了`);
      // 手上拿着食物/鞍右键会变成喂食/上鞍,空手骑最稳;驾驭用的钓竿骑上之后再拿
      try { await bot.unequip('hand'); } catch { /* 本来就空手 */ }
      await bot.lookAt(entity.position.offset(0, (entity.height ?? 1) * 0.5, 0));
      bot.mount(entity as never);
      const t0 = Date.now();
      while (!vehicleOf(bot) && Date.now() - t0 < 3000) await sleep(100);
      if (!vehicleOf(bot)) {
        const saddled = readSaddled(bot as never, entity as never);
        const tamed = readHorseTamed(bot as never, entity as never);
        const facts: string[] = [];
        if (saddled !== null) facts.push(`它身上${saddled ? '有' : '没有'}鞍`);
        if (tamed !== null) facts.push(`${tamed ? '驯服过' : '还没驯服(没驯服的马会把人颠下来)'}`);
        throw new SkillBlocked(`右键了${zhEntity(call.target)},3 秒内没坐上去${facts.length > 0 ? `。${facts.join(',')}` : ''}`, [], 'server');
      }
    }
  }

  const vehicle = vehicleOf(bot);
  if (!vehicle) {
    throw new SkillBlocked('要驾着走得先骑上:同一步给 target,或先来一步 {"skill":"ride","target":"..."}');
  }
  if (!call.to) {
    const saddleNote = readSaddled(bot as never, vehicle as never) === false && RIDE_CONTROL_ITEM[vehicle.name ?? '']
      ? ';它没上鞍,原版没鞍驾驭不了'
      : '';
    return `骑上${zhEntity(vehicle.name ?? '坐骑')}了(它在 ${cellText(cellOfVec(vehicle.position))})${saddleNote};`
      + '驾着走用 {"skill":"ride","to":[x,y,z]},下来用 {"skill":"ride","off":true}';
  }
  return await rideDrive(bot, ctx, resolveAt(bot, call.to));
}

export function cellOfVec(p: Vec3): Cell {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

/** 拴绳那件物品的英文 id;与 needs 闸共用同一个常量,不在两处各写一遍字面量 */
export const LEAD_ITEM = 'lead';
export const LEAD_FIND_R = 32;
/** 右键之后等服务端认拴上的窗口 */
export const LEAD_ATTACH_MS = 3_000;
/**
 * 一段牵多远。整段直接交给寻路器会把人拉出绳长:原版超 10 格绳就断,而寻路器
 * 一口气能跑几十格。分段走 + 每段等它跟上,才是「稳定牵到」而不是「走到了但它掉在半路」。
 */
export const LEAD_HOP = 8;
/** 原版绳绷断的距离;超过这个数就当断了去核实,不再往前走 */
export const LEAD_SNAP = 10;
/** 一段走完之后它离我多远就停下等 */
export const LEAD_FOLLOW_R = 6;
/**
 * 人自己要走到离终点多近。**不是 tolerance** —— tolerance 是「它到了没有」的验收圈,
 * 人停在那个圈边上,拖在身后一两格的它就永远差着那一两格进不来。人走到终点上,
 * 它跟到身后,才落进圈里。
 */
export const LEAD_ARRIVE_R = 1;
/** 等它跟上的上限 */
export const LEAD_CATCHUP_MS = 8_000;
/** 整段牵引的上限 */
export const LEAD_DRAG_MS = 150_000;

/**
 * 我正牵着的那只。
 *
 * 上游把 `attach_entity` 记进了 `entity.vehicle`(见 mineflayer entities.js)——名字是
 * 历史遗留:1.9 起载具走 `set_passengers`,这个包**只用于拴绳**。所以「它的 vehicle 是我」
 * 就是「它被我牵着」,这是我们唯一拿得到的服务端拴绳信号。反过来我骑东西时是
 * `bot.entity.vehicle = 坐骑`,方向相反,不会误判。
 */
export function leashedByMe(bot: Bot): NonNullable<Bot['entities'][string]> | null {
  const meId = bot.entity?.id;
  if (meId === undefined) return null;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position) continue;
    const v = (e as { vehicle?: { id?: number } | null }).vehicle;
    if (v && v.id === meId) return e;
  }
  return null;
}

export function stillLeashed(bot: Bot, e: { id?: number } | null): boolean {
  const held = leashedByMe(bot);
  return Boolean(held && e && held.id === e.id);
}

export function leadCount(bot: Bot): number {
  return invCount(bot, (n) => n === LEAD_ITEM);
}

export function distTo(bot: Bot, p: Vec3 | Cell): number {
  const me = bot.entity.position;
  return Math.hypot(me.x - (p as Vec3).x, me.y - (p as Vec3).y, me.z - (p as Vec3).z);
}

/** 栅栏能系绳,栅栏门不能;墙(wall)也不行。名字判据照原版的 fence 族。 */
export function isLeashableFence(name: string): boolean {
  return name.endsWith('_fence') || name === 'nether_brick_fence';
}

/** 拴上:走到跟前、右键、等服务端认。两条独立证据(拴绳少一根 / 它的 vehicle 是我)。 */
export async function leadAttach(bot: Bot, target: string, ctx: SkillContext): Promise<{
  entity: NonNullable<Bot['entities'][string]>;
  text: string;
}> {
  if (!isKnownTarget(bot, target)) throw new SkillBlocked(unknownUseTargetText(bot, target));
  if (leadCount(bot) === 0) throw new SkillBlocked('包里没有拴绳(lead):四根线加一颗黏液球搓一根');
  const entity = findEntity(bot, target, LEAD_FIND_R);
  if (!entity) throw new SkillNoop(`附近 ${LEAD_FIND_R} 格内没有${zhEntity(target)}`);
  const already = (entity as { vehicle?: { id?: number } | null }).vehicle;
  if (already && already.id !== bot.entity?.id) {
    throw new SkillBlocked(`${zhEntity(target)}身上已经拴着别人的绳了,拴不上第二根`);
  }
  await gotoGoal(bot, new goals.GoalFollow(entity, 2), ctx).catch(() => undefined);
  checkAbort(ctx);
  if (!entity.isValid) throw new SkillBlocked(`走到跟前时${zhEntity(target)}已经走了`);

  await equipNamed(bot, LEAD_ITEM);
  const beforeLeads = leadCount(bot);
  await bot.lookAt(entity.position.offset(0, (entity.height ?? 1) * 0.5, 0));
  await bot.useOn(entity);

  const until = Date.now() + LEAD_ATTACH_MS;
  while (Date.now() < until) {
    checkAbort(ctx);
    if (stillLeashed(bot, entity)) break;
    await sleep(100);
  }
  const spent = beforeLeads - leadCount(bot);
  if (!stillLeashed(bot, entity)) {
    // 绳少了一根但没收到 attach 包 = 服务端接了、我们没看见;绳没少 = 它根本拴不上
    if (spent > 0) {
      throw new SkillBlocked(
        `拴绳少了 ${spent} 根,但 ${LEAD_ATTACH_MS / 1000} 秒内没收到「拴上了」的确认;`
        + `${zhEntity(target)}现在在 ${cellText(cellOfVec(entity.position))},状态未知`,
        [], 'server',
      );
    }
    throw new SkillBlocked(
      `右键了${zhEntity(target)},绳一根没少,没拴上——原版拴不住的有村民、大部分敌对生物、`
      + '还有已经被别人牵着的',
      [], 'server',
    );
  }
  return {
    entity,
    text: `拴上${zhEntity(target)}了(它在 ${cellText(cellOfVec(entity.position))},拴绳还剩 ${leadCount(bot)} 根)`,
  };
}

/** 分段牵着走。每段之后核两件事:绳还在不在、它跟上了没有。 */
export async function leadDrag(
  bot: Bot,
  entity: NonNullable<Bot['entities'][string]>,
  to: Cell,
  tolerance: number,
  ctx: SkillContext,
): Promise<string> {
  const who = zhEntity(entity.name ?? '它');
  const goalVec = new Vec3(to.x + 0.5, to.y, to.z + 0.5);
  const petDist = (): number => (entity.isValid ? entity.position.distanceTo(goalVec) : Infinity);
  const deadline = Date.now() + LEAD_DRAG_MS;
  let hops = 0;

  for (;;) {
    checkAbort(ctx);
    if (!stillLeashed(bot, entity)) {
      const where = entity.isValid ? cellText(cellOfVec(entity.position)) : '看不见了';
      throw new SkillBlocked(
        `牵到一半绳脱开了(走了 ${hops} 段):${who}在 ${where},我在 ${cellText(feetOf(bot))};`
        + '绳会掉在脱开的地方,用 pickup 捡回来',
        [], 'server',
      );
    }
    if (petDist() <= tolerance) break;
    if (Date.now() > deadline) {
      throw new SkillBlocked(
        `牵了 ${hops} 段、${Math.round(LEAD_DRAG_MS / 1000)} 秒还没到:`
        + `${who}离 ${cellText(to)} 还有 ${petDist().toFixed(1)} 格,我在 ${cellText(feetOf(bot))}`,
      );
    }

    const meLeft = distTo(bot, goalVec);
    if (meLeft > LEAD_ARRIVE_R) {
      // 一段 = 让寻路器把我带到「离终点还剩 (现在的距离 − LEAD_HOP)」的那个圈上,
      // 到不了终点就停在半路。不自己造中途路点,免得点落在山体/空中
      const ring = Math.max(LEAD_ARRIVE_R, Math.ceil(meLeft) - LEAD_HOP);
      await gotoGoal(bot, new goals.GoalNear(to.x, to.y, to.z, ring), ctx).catch(() => undefined);
      hops++;
      checkAbort(ctx);

      // 等它跟上。绳是软的,人站着不动它自己会走过来
      const wait = Date.now() + LEAD_CATCHUP_MS;
      while (Date.now() < wait) {
        checkAbort(ctx);
        if (!stillLeashed(bot, entity)) break;
        const gap = entity.position.distanceTo(bot.entity.position);
        if (gap <= LEAD_FOLLOW_R) break;
        if (gap > LEAD_SNAP) break; // 已经超过原版绳长,下一轮的脱开判据会说清
        await sleep(200);
      }

      // 这一段一步没推进 —— 路被堵死,再走多少段也是同一个结果
      if (meLeft - distTo(bot, goalVec) < 0.5) {
        const gap = entity.isValid ? entity.position.distanceTo(bot.entity.position).toFixed(1) : '?';
        throw new SkillBlocked(
          `牵不动了(走了 ${hops} 段,这一段一步没推进):我在 ${cellText(feetOf(bot))}、`
          + `${who}在我 ${gap} 格外,离 ${cellText(to)} 还有 ${petDist().toFixed(1)} 格`,
        );
      }
      continue;
    }

    // 人已经站在终点上了,只差它。这一段把等待走满,它还进不来就是它不肯再近
    const wait = Date.now() + LEAD_CATCHUP_MS;
    while (Date.now() < wait && stillLeashed(bot, entity) && petDist() > tolerance) {
      checkAbort(ctx);
      await sleep(200);
    }
    if (stillLeashed(bot, entity) && petDist() > tolerance) {
      const gap = entity.position.distanceTo(bot.entity.position).toFixed(1);
      throw new SkillBlocked(
        `我已经站在 ${cellText(to)} 了,${who}跟到我 ${gap} 格外就不再近,`
        + `离目标还有 ${petDist().toFixed(1)} 格、超出 tolerance ${tolerance} 格;`
        + '把 tolerance 放宽,或者直接给 tie 系到旁边的栅栏上',
      );
    }
  }
  return `把${who}牵到 ${cellText(to)} 了(它现在离目标 ${petDist().toFixed(1)} 格,${tolerance} 格内算到),走了 ${hops} 段`;
}

/** 松开:空手右键它。绳会掉在地上,照实说要捡。 */
export async function leadRelease(bot: Bot, entity: NonNullable<Bot['entities'][string]>, ctx: SkillContext): Promise<string> {
  const who = zhEntity(entity.name ?? '它');
  try { await bot.unequip('hand'); } catch { /* 本来就空手 */ }
  checkAbort(ctx);
  await bot.lookAt(entity.position.offset(0, (entity.height ?? 1) * 0.5, 0));
  await bot.useOn(entity);
  const until = Date.now() + LEAD_ATTACH_MS;
  while (Date.now() < until && stillLeashed(bot, entity)) {
    checkAbort(ctx);
    await sleep(100);
  }
  if (stillLeashed(bot, entity)) {
    throw new SkillBlocked(`空手右键了${who},${LEAD_ATTACH_MS / 1000} 秒后绳还牵着`, [], 'server');
  }
  return `松开${who}了,它留在 ${cellText(cellOfVec(entity.position))};绳掉在那儿,用 {"skill":"pickup","item":"lead"} 捡`;
}

/** 系到栅栏上:走到栅栏边右键它。系上之后它的绳头就不在我手里了。 */
export async function leadTie(
  bot: Bot,
  entity: NonNullable<Bot['entities'][string]>,
  tie: Cell,
  ctx: SkillContext,
): Promise<string> {
  const who = zhEntity(entity.name ?? '它');
  const fence = blockAtCell(bot, tie);
  if (!fence) throw new SkillBlocked(`${cellText(tie)} 区块没加载,看不到那儿是什么`);
  if (!isLeashableFence(fence.name)) {
    throw new SkillBlocked(
      `${cellText(tie)} 是${zhName(fence.name)},绳系不上去——原版只有栅栏能系(栅栏门也不行)`,
    );
  }
  await gotoGoal(bot, new goals.GoalNear(tie.x, tie.y, tie.z, 2), ctx).catch(() => undefined);
  checkAbort(ctx);
  if (!stillLeashed(bot, entity)) {
    throw new SkillBlocked(`走到栅栏边时绳已经脱开了,${who}没系上`, [], 'server');
  }
  await bot.lookAt(new Vec3(tie.x + 0.5, tie.y + 0.5, tie.z + 0.5));
  await bot.activateBlock(fence);
  const until = Date.now() + LEAD_ATTACH_MS;
  while (Date.now() < until && stillLeashed(bot, entity)) {
    checkAbort(ctx);
    await sleep(100);
  }
  if (stillLeashed(bot, entity)) {
    throw new SkillBlocked(
      `右键了 ${cellText(tie)} 的${zhName(fence.name)},${LEAD_ATTACH_MS / 1000} 秒后绳头还在我手里,没系上`,
      [], 'server',
    );
  }
  const where = entity.isValid ? cellText(cellOfVec(entity.position)) : '看不见了';
  return `把${who}系到 ${cellText(tie)} 的${zhName(fence.name)}上了,它现在在 ${where},跑不远了`;
}

/**
 * 拴绳:拴上 → 分段牵到 → 松开/系栅栏。三段各自可单独成立(她可以分步下单)。
 *
 * 为什么要分段走:原版绳超 10 格就断,而寻路器一口气跑几十格。整段丢给 goto 的结果
 * 是「人到了、它断在半路」——那正是这个技能要解决的事,所以分段与等它跟上是本体,
 * 不是保守起见的额外保护。
 */
export async function skillLead(bot: Bot, call: Extract<SkillCall, { skill: 'lead' }>, ctx: SkillContext): Promise<string> {
  if (call.off) {
    const held = leashedByMe(bot);
    if (!held) throw new SkillNoop('现在没牵着任何活物');
    return await leadRelease(bot, held, ctx);
  }

  const parts: string[] = [];
  let entity = leashedByMe(bot);
  if (call.target) {
    if (entity && (entity.name ?? '') !== call.target) {
      throw new SkillBlocked(
        `手里还牵着${zhEntity(entity.name ?? '一只活物')};先 {"skill":"lead","off":true} 松开再拴别的`,
      );
    }
    if (!entity) {
      const got = await leadAttach(bot, call.target, ctx);
      entity = got.entity;
      parts.push(got.text);
    }
  }
  if (!entity) {
    throw new SkillBlocked('手里没牵着东西:同一步给 target,或先来一步 {"skill":"lead","target":"..."}');
  }

  if (call.to) {
    parts.push(await leadDrag(bot, entity, resolveAt(bot, call.to), call.tolerance ?? 3, ctx));
  }
  if (call.tie) {
    parts.push(await leadTie(bot, entity, resolveAt(bot, call.tie), ctx));
  } else if (call.to && !call.keep) {
    parts.push(await leadRelease(bot, entity, ctx));
  }
  return parts.join(';');
}

/**
 * 落地那一格的 y:从当前高度 +1 往下扫到 -3,找「脚下实心、本格与头上非实心」。
 * 找不到(区块没加载/前面是墙或深坑)返回 null,由调用方按停滞收场。
 */
export function rideGroundY(bot: Bot, x: number, yNow: number, z: number): number | null {
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  const yBase = Math.floor(yNow);
  for (let dy = 1; dy >= -3; dy -= 1) {
    const yy = yBase + dy;
    const here = blockAtCell(bot, { x: fx, y: yy, z: fz });
    const below = blockAtCell(bot, { x: fx, y: yy - 1, z: fz });
    if (!here || !below) return null;
    const standable = !AIR_NAMES.has(below.name) && !LIQUIDS.has(below.name);
    if (AIR_NAMES.has(here.name) && standable) return yy;
    // 船浮在水格上沿；已在水面时沿用当前高度，从岸上入水时使用水面上沿高度。
    if (AIR_NAMES.has(here.name) && below.name === 'water') return Math.min(yNow, yy);
    if (here.name === 'water') return yy + 1;
  }
  return null;
}

/**
 * 玩家控制的载具由骑手客户端发送 vehicle_move 绝对坐标，服务端做碰撞和纠偏。
 * Mineflayer 无载具物理，此处每 tick 小步移动并转向；仅转头不能驱动载具。
 */
export async function rideDrive(bot: Bot, ctx: SkillContext, to: Cell): Promise<string> {
  const vehicle = vehicleOf(bot);
  if (!vehicle) throw new SkillBlocked('人不在坐骑上');
  const vname = vehicle.name ?? '';
  const zhV = zhEntity(vname || '坐骑');
  if (RIDE_STEP[vname] === undefined) {
    throw new SkillBlocked(
      `${zhV}骑得上,但驾着走这版还不支持(位置协议在测试服务器上没验过关);`
      + '能驾的是猪(要鞍+胡萝卜钓竿)和船;下来用 {"skill":"ride","off":true}',
    );
  }
  const control = RIDE_CONTROL_ITEM[vname];
  if (control) {
    try {
      await equipNamed(bot, control);
    } catch (err) {
      throw new SkillBlocked(`驾${zhV}要手持${zhName(control)}:${(err as Error).message};不拿它${zhV}不听使唤`);
    }
    if (readSaddled(bot as never, vehicle as never) === false) {
      throw new SkillBlocked(`这只${zhV}没上鞍,原版没鞍驾驭不了;先 {"skill":"use","item":"saddle","target":"${vname}"} 上鞍`);
    }
  }
  const step = RIDE_STEP[vname] ?? RIDE_STEP_DEFAULT;
  const client = (bot as unknown as { _client: RideClient })._client;
  const pos = vehicle.position.clone();
  const start = { x: pos.x, z: pos.z };
  let corrections = 0;
  const onCorrect = (p: { x: number; y: number; z: number }): void => {
    corrections += 1;
    pos.set(p.x, p.y, p.z);
  };
  client.on('vehicle_move', onCorrect);
  const startedAt = Date.now();
  const startDist = Math.hypot(to.x + 0.5 - pos.x, to.z + 0.5 - pos.z);
  // 3 倍标称速度余量 + 15s 底;驾驭不该比走路更能耗时间
  const capMs = 15_000 + (startDist / (step * 20)) * 3_000;
  let mark = { x: pos.x, z: pos.z, at: startedAt };
  let stalledWhy: string | null = null;
  try {
    for (;;) {
      checkAbort(ctx);
      if (!vehicleOf(bot)) { stalledWhy = '人从坐骑上掉下来了(服务端把人卸了下来)'; break; }
      const dx = to.x + 0.5 - pos.x;
      const dz = to.z + 0.5 - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= RIDE_ARRIVE_R) break;
      if (Date.now() - startedAt > capMs) {
        stalledWhy = `跑满了时限(${Math.round(capMs / 1000)}s)还没到`;
        break;
      }
      if (Date.now() - mark.at >= RIDE_STALL_MS) {
        const moved = Math.hypot(pos.x - mark.x, pos.z - mark.z);
        if (moved < 1) {
          stalledWhy = `${Math.round(RIDE_STALL_MS / 1000)} 秒只挪了 ${moved.toFixed(1)} 格(前面多半有墙/深坑)`;
          break;
        }
        mark = { x: pos.x, z: pos.z, at: Date.now() };
      }
      const ux = dx / dist;
      const uz = dz / dist;
      const nx = pos.x + ux * Math.min(step, dist);
      const nz = pos.z + uz * Math.min(step, dist);
      const ny = rideGroundY(bot, nx, pos.y, nz);
      if (ny === null) {
        stalledWhy = '前面那一格落不了脚(悬崖/墙/区块没加载)';
        break;
      }
      // notchian yaw:0=+Z,-90=+X
      const yaw = -Math.atan2(ux, uz) * (180 / Math.PI);
      client.write('look', { yaw, pitch: 0, onGround: false });
      client.write('vehicle_move', { x: nx, y: ny, z: nz, yaw, pitch: 0 });
      pos.set(nx, ny, nz);
      vehicle.position.set(nx, ny, nz);
      // 骑手位置跟着坐骑走:别的读数(距离、快照)不该停在上马那一格
      bot.entity.position.set(nx, ny + 0.6, nz);
      await sleep(RIDE_TICK_MS);
    }
  } finally {
    client.removeListener('vehicle_move', onCorrect);
  }
  const ridden = Math.round(Math.hypot(pos.x - start.x, pos.z - start.z));
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const where = cellText(cellOfVec(pos));
  const left = Math.round(Math.hypot(to.x + 0.5 - pos.x, to.z + 0.5 - pos.z));
  const fixNote = corrections > 0 ? `;路上服务端纠了 ${corrections} 次位置` : '';
  if (stalledWhy) {
    try { bot.dismount(); } catch { /* 已不在坐骑上 */ }
    await sleep(500);
    throw new SkillBlocked(
      `骑着${zhV}走了 ${ridden} 格停在 ${where},离目标还 ${left} 格:${stalledWhy};已经下来了${fixNote}`,
      [], 'server',
    );
  }
  return `骑着${zhV}到了 ${where}(走了 ${ridden} 格、${secs}s,离目标 ${left} 格),人还骑着;下来用 {"skill":"ride","off":true}${fixNote}`;
}

// ======================== anvil / grindstone:通用窗口协议 ========================

export async function skillAnvil(bot: Bot, call: Extract<SkillCall, { skill: 'anvil' }>, ctx: SkillContext): Promise<string> {
  const cell = call.at ? resolveAt(bot, call.at) : findStationCell(bot, ANVIL_BLOCKS);
  if (!cell) throw new SkillBlocked(`附近 ${STATION_FIND_R} 格内没有铁砧;放一个再来,或用 at 指一格`);
  const reg = bot.registry as never;
  const mainPred: InvPred = (n, it) => n === call.item && itemMatchesPick(call.pick, it, reg);
  const withPred: InvPred = (n, it) => n === call.with && itemMatchesPick(call.withPick, it, reg);
  const main = bot.inventory.items().find((i) => mainPred(i.name, i));
  if (!main) {
    throw noSuchItem(bot, call.item, call.pick, bot.inventory.items().filter((i) => i.name === call.item));
  }
  const withOne = call.with === undefined
    ? null
    : bot.inventory.items().find((i) => withPred(i.name, i)) ?? null;
  if (call.op !== 'rename') {
    // 两件同种合修:左右两格不能是同一件,所以要两件都符合
    const twoOfAKind = call.with === call.item && call.pick === call.withPick;
    const matched = bot.inventory.items().filter((i) => withPred(i.name, i)).length;
    if (matched < (twoOfAKind ? 2 : 1)) {
      throw twoOfAKind
        ? new SkillBlocked(`包里只有一件${itemAsked(call.item, call.pick)},两件同种才能合`)
        : noSuchItem(bot, call.with!, call.withPick, bot.inventory.items().filter((i) => i.name === call.with));
    }
  }
  const lvl0 = bot.experience.level;
  const before = invSnapshot(bot);
  // 这一单要几级:铁砧窗口的 property 0(craft_progress_bar 包)
  let costShown: number | null = null;
  const client = (bot as unknown as { _client: RideClient })._client;
  const onProp = (p: { property?: number; value?: number } & { x: number; y: number; z: number }): void => {
    if (p.property === 0 && typeof p.value === 'number' && p.value > 0) costShown = p.value;
  };
  (client as unknown as { on(n: string, f: unknown): void }).on('craft_progress_bar', onProp);
  const { win, blockName } = await openStationWindow(bot, ctx, cell, ANVIL_BLOCKS, '铁砧');
  let out: { name: string } | null = null;
  try {
    await putIntoStation(bot, win, mainPred, 0, itemAsked(call.item, call.pick));
    await sleep(300);
    if (call.op !== 'rename') {
      await putIntoStation(bot, win, withPred, 1, itemAsked(call.with!, call.withPick));
    } else {
      // 原版改名:客户端敲字发 name_item,服务端据此填产出槽
      client.write('name_item', { name: call.name ?? '' });
    }
    await sleep(WINDOW_SETTLE_MS);
    out = win.slots[2] as { name: string } | null;
    if (!out) {
      throw new SkillBlocked(
        call.op === 'rename'
          ? `铁砧不认这个名字:产出槽没出东西(写的是「${call.name}」)`
          : `铁砧的产出槽没出东西:${askedLabel(bot, call.item, call.pick, main)}`
            + `+${askedLabel(bot, call.with!, call.withPick, withOne)} 这一对按原版做不出结果`,
        [], 'server',
      );
    }
    const outFacts = stationItemFacts(bot, out);
    await (bot as unknown as { clickWindow(s: number, b: number, m: number): Promise<void> }).clickWindow(2, 0, 1);
    await sleep(WINDOW_SETTLE_MS);
    // 产出留在读数里,取没取到由下面的等级/库存判
    void outFacts;
  } finally {
    (client as unknown as { removeListener(n: string, f: unknown): void }).removeListener('craft_progress_bar', onProp);
    try { bot.closeWindow(win as never); } catch { /* 已关 */ }
  }
  await sleep(400);
  const lvl1 = bot.experience.level;
  const spent = lvl0 - lvl1;
  if (spent <= 0) {
    const gate = costShown !== null ? `这一单显示要 ${costShown} 级,你现在 ${lvl1} 级` : `你现在 ${lvl1} 级`;
    const changed = invGains(before, bot).length > 0 || invLosses(before, bot).length > 0;
    if (!changed) {
      throw new SkillBlocked(`铁砧的产出没拿到手:经验一级没扣、包里一样没动(${gate};等级不够时原版不给取)`, [], 'server');
    }
  }
  const result = bot.inventory.items().find((i) => i.name === (out?.name ?? call.item));
  const anvilNow = blockAtCell(bot, cell)?.name ?? null;
  const wear = anvilNow === blockName
    ? ''
    : anvilNow && (ANVIL_BLOCKS as readonly string[]).includes(anvilNow)
      ? `;铁砧磨损了一级(现在是${zhName(anvilNow)})`
      : ';铁砧这一下用碎了,那一格已经空了';
  const head = call.op === 'rename'
    ? `在 ${cellText(cell)} 的${zhName(blockName)}上把${askedLabel(bot, call.item, call.pick, main)}改名成「${call.name}」`
    : `在 ${cellText(cell)} 的${zhName(blockName)}上把${askedLabel(bot, call.item, call.pick, main)}`
      + `和${askedLabel(bot, call.with!, call.withPick, withOne)}合了`;
  return `${head}:产物${result ? `${zhName(result.name)}(${stationItemFacts(bot, result)})` : '已入包'};`
    + `花了 ${Math.max(spent, 0)} 级经验(${lvl0} → ${lvl1})${wear}`;
}

export async function skillGrindstone(bot: Bot, call: Extract<SkillCall, { skill: 'grindstone' }>, ctx: SkillContext): Promise<string> {
  const cell = call.at ? resolveAt(bot, call.at) : findStationCell(bot, ['grindstone']);
  if (!cell) throw new SkillBlocked(`附近 ${STATION_FIND_R} 格内没有砂轮;放一个再来,或用 at 指一格`);
  const reg = bot.registry as never;
  const mainPred: InvPred = (n, it) => n === call.item && itemMatchesPick(call.pick, it, reg);
  const withPred: InvPred = (n, it) => n === call.with && itemMatchesPick(call.withPick, it, reg);
  const main = bot.inventory.items().find((i) => mainPred(i.name, i));
  if (!main) {
    throw noSuchItem(bot, call.item, call.pick, bot.inventory.items().filter((i) => i.name === call.item));
  }
  const beforeFacts = stationItemFacts(bot, main);
  const pts0 = bot.experience.points;
  const { win } = await openStationWindow(bot, ctx, cell, ['grindstone'], '砂轮');
  let out: { name: string } | null = null;
  try {
    await putIntoStation(bot, win, mainPred, 0, itemAsked(call.item, call.pick));
    if (call.with) {
      await sleep(200);
      await putIntoStation(bot, win, withPred, 1, itemAsked(call.with, call.withPick));
    }
    await sleep(WINDOW_SETTLE_MS);
    out = win.slots[2] as { name: string } | null;
    if (!out) {
      throw new SkillBlocked(
        call.with
          ? `砂轮的产出槽没出东西:${askedLabel(bot, call.item, call.pick, main)}`
            + `+${itemAsked(call.with, call.withPick)} 这一对按原版磨不出结果(两件得是同种工具)`
          : `砂轮的产出槽没出东西:${askedLabel(bot, call.item, call.pick, main)}按原版磨不出结果`,
        [], 'server',
      );
    }
    await (bot as unknown as { clickWindow(s: number, b: number, m: number): Promise<void> }).clickWindow(2, 0, 1);
    await sleep(WINDOW_SETTLE_MS);
  } finally {
    try { bot.closeWindow(win as never); } catch { /* 已关 */ }
  }
  await sleep(400); // 经验球飞过来要一拍
  const result = bot.inventory.items().find((i) => i.name === (out?.name ?? call.item));
  const gained = bot.experience.points - pts0;
  const xpNote = gained > 0 ? `;返还了 ${gained} 点经验(附魔按原版比例折算)` : ';没有经验返还';
  return `在 ${cellText(cell)} 的砂轮上磨了${askedLabel(bot, call.item, call.pick, main)}`
    + `${call.with ? `+${itemAsked(call.with, call.withPick)}` : ''}:`
    + `磨之前(${beforeFacts}),磨完(${result ? stationItemFacts(bot, result) : '产物读不到'})${xpNote}`;
}

