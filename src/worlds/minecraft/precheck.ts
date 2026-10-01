/**
 * 前置试算以纯读判据判断步骤当前是否可执行。
 *
 * 受理时检查全部步骤，hard/soft 否定结果均进入回执，全通过则静默，不改变执行。
 * 出队时在每步动手前重查；hard 命中即停在该步，soft 只报告。
 * hard 表示当前可证失败的材料、几何等条件；区块未加载或活物暂不在场归 soft。
 *
 * 不 equip、place、寻路或发包；goto 的路线试算成本较高，只由 dryRun 显式调用。
 */
import type { Bot } from 'mineflayer';
import type { SkillCall } from './skills.ts';
import type { Cell } from './geometry.ts';
import { matchItemName } from './chests.ts';
import { equippedAlready } from './tools.ts';
import { itemsInReach, offHandItem } from './inventory.ts';
import { DRINKABLES } from './item-facts.ts';
import { itemMatchesPick, pickMissText, pickTargetOf } from './item-pick.ts';
import { zhDimension, zhEntity, zhName } from './names.ts';
import { bestRangedWeapon, hasRangedLos, hasUsableArrows, type RangedTarget } from './ranged.ts';

type PrecheckLevel = 'hard' | 'soft';

interface PrecheckNote {
  level: PrecheckLevel;
  /** 给她看的一句话;不带「没做成」这类完成体措辞,因为还没动工 */
  text: string;
  /** 判据代号,给台架与日志对账用 */
  rule: string;
}

/** 背包里这件东西有几个。名字口径复用 chests.matchItemName,不自造第二套 */
function hasItem(bot: Bot, name: string, pick?: string): number {
  let n = 0;
  for (const it of bot.inventory.items()) {
    if ((matchItemName(name, it.name) || zhName(it.name) === name)
      && itemMatchesPick(pick, it, bot.registry as never)) n += it.count;
  }
  return n;
}

/** 副手挂着的那件合不合这个名字与挑选词;equip 能把它换到主手 */
function offHandHas(bot: Bot, name: string, pick?: string): boolean {
  const off = offHandItem(bot);
  return !!off && (matchItemName(name, off.name) || zhName(off.name) === name)
    && itemMatchesPick(pick, off, bot.registry as never);
}

/**
 * 读方块经 deps.blockAt 调用执行器的 blockAtCell，由它构造 Vec3。
 * Mineflayer 要求坐标具有 floored()，不能传普通坐标对象。
 */
type BlockLike = { name: string; boundingBox?: string } | null | undefined;

/** 缺口并列时最多列几条配方;超出的只报条数,不糊一屏 */
const CRAFT_TIED_MAX = 3;

/**
 * craft:配方齐不齐。与 skillCraft 问的是同一份数据(bot.recipesAll + 背包),
 * 所以它说凑不齐,真跑也一定凑不齐 —— 台架 `bench-precheck.ts` 锁死这条蕴含。
 */
function precheckCraft(bot: Bot, call: Extract<SkillCall, { skill: 'craft' }>): PrecheckNote | null {
  if (call.grid) return null; // 自摆配方不预判
  const item = call.item ?? '';
  const def = bot.registry?.itemsByName?.[item];
  if (!def) return { level: 'hard', text: `不认识「${item}」这种物品`, rule: 'craft.unknownItem' };
  const label = zhName(def.name);
  let all: Array<{ delta?: Array<{ id: number; count: number }> }> = [];
  try {
    all = (bot.recipesAll?.(def.id, null, true as never) ?? []) as never;
  } catch { return null; }
  if (all.length === 0) return null; // 没配方是另一类受阻,交给技能自己说
  const have = new Map<number, number>();
  for (const it of bot.inventory.items()) have.set(it.type, (have.get(it.type) ?? 0) + it.count);
  const needsOf = (r: { delta?: Array<{ id: number; count: number }> }): Map<number, number> => {
    const need = new Map<number, number>();
    for (const d of r.delta ?? []) if (d.count < 0) need.set(d.id, (need.get(d.id) ?? 0) + -d.count);
    return need;
  };
  const ready = all.find((r) => [...needsOf(r)].every(([id, n]) => (have.get(id) ?? 0) >= n));
  if (ready) return null;
  const options = all.map((r) => {
    const need = needsOf(r);
    const miss = [...need]
      .map(([id, n]) => ({ id, gap: n - (have.get(id) ?? 0) }))
      .filter((x) => x.gap > 0);
    return { miss, total: miss.reduce((a, b) => a + b.gap, 0) };
  });
  const gapsOf = (o: { miss: Array<{ id: number; gap: number }> }): string => o.miss
    .map((x) => `${zhName(bot.registry.items[x.id]?.name ?? String(x.id))}×${x.gap}`)
    .join('、');
  // 最小缺口并列时列出所有并列配方，与 skillCraft 使用相同的“或”连接语义。
  const min = Math.min(...options.map((o) => o.total));
  const tied = [...new Set(options.filter((o) => o.total === min).map(gapsOf))];
  const more = tied.length > CRAFT_TIED_MAX ? `;还有 ${tied.length - CRAFT_TIED_MAX} 条配方缺口一样多` : '';
  const gaps = tied.slice(0, CRAFT_TIED_MAX).join(' 或 ');
  return { level: 'hard', text: `做${label}还差 ${gaps}${more}`, rule: 'craft.short' };
}

/** eat:点名的食物是否存在。与 skillEat 共用精确物品 id 口径。 */
function precheckEat(
  bot: Bot,
  call: Extract<SkillCall, { skill: 'eat' }>,
  deps: PrecheckDeps,
): PrecheckNote | null {
  const foods = (bot.registry?.foodsByName ?? {}) as Record<string, unknown>;
  // 牛奶桶不给饱食度、不在 foods 表里,但它是喝得掉的(见 DRINKABLES)
  if (!foods[call.item] && !DRINKABLES[call.item]) {
    return { level: 'hard', text: notFoodText(bot, call.item), rule: 'eat.notFood' };
  }
  if (!bot.inventory.items().some((i) => i.name === call.item && i.count > 0)) {
    const edible = edibleInBag(bot);
    return edible
      ? { level: 'hard', text: `包里没有点名的${zhName(call.item)};${edible}`, rule: 'eat.noStock' }
      : { level: 'hard', text: rationText(bot, deps), rule: 'eat.none' };
  }
  // 吃饱了是这一步的正常结局,执行器不会调用 consume()。
  if (bot.food >= 20) return null;
  return null;
}

/** 返回背包可食物清单，空清单返回 null；用于点名食物缺失后的受阻说明。 */
export function edibleInBag(bot: Bot): string | null {
  const foods = (bot.registry?.foodsByName ?? {}) as Record<string, unknown>;
  const counts = new Map<string, number>();
  for (const it of bot.inventory.items()) {
    if (it.count > 0 && foods[it.name]) counts.set(it.name, (counts.get(it.name) ?? 0) + it.count);
  }
  if (counts.size === 0) return null;
  return `包里能吃的有:${[...counts].map(([n, c]) => `${zhName(n)}×${c}`).join('、')}`;
}

/** 未知物品 id 的受阻说明，同时列出背包内词根相同的候选。 */
export function notFoodText(bot: Bot, item: string): string {
  const known = (bot.registry?.itemsByName ?? {}) as Record<string, unknown>;
  // 物品表没装出来时认不出"这个 id 不存在",退回旧说法:宁可少说不说错
  const head = Object.keys(known).length === 0 || known[item]
    ? `${zhName(item)}不是可进食物品`
    : `没有 ${item} 这样的物品`;
  const roots = new Set(item.split('_').filter((t) => t !== 'raw' && t !== 'item' && t !== 'block'));
  const like = [...new Set(bot.inventory.items()
    .filter((i) => i.count > 0 && i.name !== item)
    .filter((i) => i.name.split('_').some((t) => roots.has(t)))
    .map((i) => i.name))];
  const near = like.length > 0
    ? `;包里名字最像的是 ${like.map((n) => `${n}(${zhName(n)})`).join('、')}`
    : '';
  return `${head}${near}`;
}

/** 无食物时的事实读数，由 renderPrecheckNotes 渲染为独立的 [口粮] 行。 */
function rationText(bot: Bot, deps: PrecheckDeps): string {
  const ate = deps.lastAte?.() ?? null;
  const since = ate === null ? '这一场还没吃过东西' : `上次进食 ${Math.round((Date.now() - ate) / 60_000)} 分钟前`;
  return `包里没有任何食物;${since};饱食度 ${Math.round(bot.food ?? 0)}/20;生命 ${Math.ceil(bot.health ?? 0)}/20`;
}

/** 玩家主物品栏格数:9 格快捷栏 + 27 格背包。盔甲四槽与副手不在其中 */
export const PLAYER_SLOTS = 36;

/**
 * 空格数。按**槽位**数,不按名字合并 —— 附魔件与工具堆叠上限是 1,每件各占一格,
 * 合并名字会把「三把镐」算成一格。
 */
function freeSlots(bot: Bot): number {
  return Math.max(0, PLAYER_SLOTS - bot.inventory.items().length);
}

/** 这件东西一格能摞几个;registry 读不到时按 64(原版多数如此) */
function stackMaxOf(bot: Bot, name: string): number {
  return (bot.registry?.itemsByName?.[name]?.stackSize as number | undefined) ?? 64;
}

/**
 * 再进 `count` 个 `name` 还要几格空位:先填包里已有的未满栈,剩下的按堆叠上限分格。
 * 纯算术,不问世界。
 */
function slotsNeeded(bot: Bot, name: string, count: number): number {
  const stackMax = stackMaxOf(bot, name);
  let room = 0;
  for (const it of bot.inventory.items()) {
    if (matchItemName(name, it.name)) room += Math.max(0, stackMax - it.count);
  }
  return Math.ceil(Math.max(0, count - room) / stackMax);
}

/**
 * 报告背包剩余格数与本步所需格数，不自动插入 toss。
 * collect/pickup 的掉落种类在试算时未知，仅在背包无空格时报。
 */
function precheckSlots(bot: Bot, call: SkillCall): PrecheckNote | null {
  const free = freeSlots(bot);
  const count = Math.max(1, Number((call as { count?: number }).count ?? 1));
  const item = (call as { item?: string }).item;
  if (item) {
    const need = slotsNeeded(bot, item, count);
    if (need <= free) return null;
    return {
      level: 'soft',
      text: `包里剩 ${free} 格空位,这一步${zhName(item)}×${count} 预计要占 ${need} 格`,
      rule: `${call.skill}.slots`,
    };
  }
  if (free > 0) return null;
  return {
    level: 'soft',
    text: `包里 ${PLAYER_SLOTS} 格全满了,这一步是往包里装东西`,
    rule: `${call.skill}.slotsFull`,
  };
}

/**
 * 背包里有没有这件东西:equip / use item / stow / toss 共用。
 * 名字口径与执行器的 invItemNamed 逐条同源(精确 → _后缀 → 前缀_),
 * 提示语也照抄技能的模糊命中那一句 —— 同一件事只有一个说法。
 */
function precheckHasItem(
  bot: Bot, item: string, verb: string, rule: string, pick?: string,
): PrecheckNote | null {
  if (!item) return null;
  if (hasItem(bot, item, pick) > 0) return null;
  // 有同 id 的几件而挑选词一件没中:那几件各自是什么,当场摆出来
  if (pick && hasItem(bot, item) > 0) {
    const same = bot.inventory.items()
      .filter((i) => matchItemName(item, i.name))
      .map((i) => pickTargetOf(i, bot.registry as never));
    return { level: 'hard', text: pickMissText('包里', item, pick, same), rule };
  }
  const near = bot.inventory.items().filter((i) => i.name.includes(item)).map((i) => zhName(i.name));
  const hint = near.length > 0 ? `;名字带这几个字的有:${near.join('、')}` : '';
  return { level: 'hard', text: `包里没有${zhName(item)},${verb}不了${hint}`, rule };
}

/** 五个「从包里拿东西下手」的技能:判据同一条,只有动词不同 */
function precheckItemStep(bot: Bot, call: SkillCall, verb: string): PrecheckNote | null {
  const c = call as { item?: string; pick?: string };
  return precheckHasItem(bot, c.item ?? '', verb, `${call.skill}.noStock`, c.pick);
}

/** 点名物品缺货但目标格已是该方块时，受阻文案与执行器一致。 */
function precheckUseItemAt(
  bot: Bot,
  call: { item?: string; at?: unknown },
  deps: PrecheckDeps,
): PrecheckNote | null {
  const item = String(call.item ?? '');
  if (!item || hasItem(bot, item) > 0) return null;
  const cell = call.at === undefined ? null : deps.resolve(call.at);
  const b = (cell ? deps.blockAt(cell) : null) as BlockLike;
  if (b && cell && matchItemName(item, b.name)) {
    return {
      level: 'hard',
      text: `包里没有${zhName(item)};不过 (${cell.x},${cell.y},${cell.z}) 那一格本身就是${zhName(b.name)}——要右键它不用带 item`,
      rule: 'use.itemIsTheBlock',
    };
  }
  return precheckHasItem(bot, item, '用', 'use.noStock');
}

/** 人在哪个维度。与执行器 dimensionOf 同一条读法;一行属性读,不为它牵一条跨文件的线 */
function dimensionOf(bot: Bot): string {
  return String(bot.game?.dimension ?? 'overworld');
}

/**
 * surface 在下界不成立:顶上到 y=127 全是基岩,「露天」这件事不存在。
 * 执行器本来就当场驳回(skillSurface 的下界闸),这里只是把同一条判据提到受理刻说,
 * 终态不变 —— 省掉的是她排好一整单、跑到这一步才发现。
 */
function precheckSurfaceHere(bot: Bot): PrecheckNote | null {
  if (!dimensionOf(bot).includes('nether')) return null;
  return {
    level: 'hard',
    text: '在下界用不了 surface:顶上到 y=127 全是基岩,没有露天可去',
    rule: 'surface.nether',
  };
}

/**
 * 床只在主世界能睡,在下界/末地点它当场爆炸。
 *
 * **soft 不 hard**:执行器有意不拦这一下(打末影龙就是拿床当伤害手段,见 skillUse 的
 * bedBoom 注释),这里跟着不闸,只把后果提前到受理刻说清 —— 现有回执要等炸完才有
 * 一句解释,而炸掉的可能是自己脚边那道传送门。
 */
function precheckBedHere(
  bot: Bot,
  call: { at?: unknown },
  deps: PrecheckDeps,
): PrecheckNote | null {
  if (call.at === undefined) return null;
  const dim = dimensionOf(bot);
  if (dim.includes('overworld')) return null;
  const cell = deps.resolve(call.at);
  if (!cell) return null;
  const b = deps.blockAt(cell) as BlockLike;
  if (!b || !b.name.endsWith('_bed')) return null;
  return {
    level: 'soft',
    text: `(${cell.x},${cell.y},${cell.z}) 是${zhName(b.name)};床在${zhDimension(dim)}点下去会当场爆炸`
      + '(炸伤自己,也炸掉旁边的方块),躺不下',
    rule: 'use.bedExplodes',
  };
}

/** 种子族:锄地/种地的目标格口径判据认这些(与执行器的 SEED_CROP 同一批 id) */
const SEEDS = new Set([
  'wheat_seeds', 'beetroot_seeds', 'carrot', 'potato', 'melon_seeds', 'pumpkin_seeds',
  'torchflower_seeds', 'pitcher_pod', 'nether_wart',
]);

/** 锄地、种地应指向土格；目标偏到上方空气时只报告可能偏差，不修改坐标。 */
function precheckSoilCell(
  bot: Bot,
  call: { item?: string; at?: unknown },
  deps: PrecheckDeps,
): PrecheckNote | null {
  const item = String(call.item ?? '');
  if (call.at === undefined) return null;
  if (!item.endsWith('_hoe') && !SEEDS.has(item)) return null;
  const cell = deps.resolve(call.at);
  if (!cell) return null;
  const b = deps.blockAt(cell) as BlockLike;
  if (!b || b.name !== 'air') return null;
  const what = item.endsWith('_hoe') ? '锄头' : '种子';
  return {
    level: 'soft',
    text: `(${cell.x},${cell.y},${cell.z}) 是空气;${what}要指着土那一格(可能是 (${cell.x},${cell.y - 1},${cell.z}))`,
    rule: 'use.soilCell',
  };
}

/** tunnel 坡度判据与 skillTunnel 一致：Math.abs(rise) > run 表示超过 45°。 */
function precheckTunnel(bot: Bot, call: Extract<SkillCall, { skill: 'tunnel' }>, resolve: (a: unknown) => Cell | null): PrecheckNote | null {
  const p = bot.entity?.position;
  if (!p) return null;
  const start = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  const target = resolve(call.at);
  if (!target) return null;
  const run = Math.max(Math.abs(target.x - start.x), Math.abs(target.z - start.z));
  const rise = target.y - start.y;
  if (run === 0 && rise === 0) return { level: 'hard', text: '终点就是脚下这一格', rule: 'tunnel.here' };
  if (run !== 0 && Math.abs(rise) > run) {
    return { level: 'hard', text: `坡度超过 45°:横 ${run} 格要升降 ${Math.abs(rise)} 格`, rule: 'tunnel.slope' };
  }
  return null;
}

/** 深层作业判据线:目标 y 在这以下就是深板岩层,岩浆湖密度陡增 */
const DEEP_KIT_Y = 0;

/**
 * tunnel/excavate 的目标深度或 collect 的当前深度 y ≤ 0 且缺水桶时，
 * 以 soft 报告深度和缺失事实，不阻断执行。
 */
function precheckDeepKit(bot: Bot, call: SkillCall, deps: PrecheckDeps): PrecheckNote | null {
  let y: number | null = null;
  if (call.skill === 'tunnel') {
    y = deps.resolve((call as { at?: unknown }).at)?.y ?? null;
  } else if (call.skill === 'excavate') {
    const cells = deps.cellsOf(call);
    if (cells && cells.length > 0) y = Math.min(...cells.map((c) => c.y));
  } else if (call.skill === 'collect') {
    // collect 没有目标坐标,就地找块:看她现在站的深度
    y = bot.entity?.position ? Math.floor(bot.entity.position.y) : null;
  }
  if (y === null || y > DEEP_KIT_Y) return null;
  if (hasItem(bot, 'water_bucket') > 0) return null;
  return {
    level: 'soft',
    text: `这一步在 y=${y}(深板岩层),包里没有水桶;还没动工`,
    rule: `${call.skill}.deepNoWater`,
  };
}

function precheckBuild(
  bot: Bot,
  call: Extract<SkillCall, { skill: 'build' }>,
  deps: PrecheckDeps,
): PrecheckNote | null {
  // 蓝图允许盖到料尽，不适用单一材料的缺料判据。
  if ('blueprint' in call) return null;
  const mat = call.material;
  // BoatItem 通过使用物品并由服务端沿玩家视线做射线放置，不响应 use_item_on。
  // 船和竹筏应走 useBoat，不能按普通方块逐面放置。
  if (/_(boat|raft)$/.test(mat)) {
    return {
      level: 'hard',
      text: `${zhName(mat)}不是方块,build 放不出来(服务端按视线射线生成,只认「使用物品」);`
        + `改用 {"skill":"use","item":"${mat}","at":[x,y,z]} 指一格水面/地面`,
      rule: 'build.notBlock',
    };
  }
  const have = hasItem(bot, mat);
  // 贴面形态:参照方块不实心 ⇒ 那一处根本贴不上
  if ('on' in call && Array.isArray(call.on)) {
    const bad: Cell[] = [];
    let unloaded = 0;
    for (const spot of call.on) {
      const ref = deps.resolve(spot.at);
      if (!ref) continue;
      const rb = deps.blockAt(ref) as BlockLike;
      if (!rb) { unloaded++; continue; }
      if (rb.boundingBox !== 'block') bad.push(ref);
    }
    if (bad.length > 0) {
      const list = bad.slice(0, 3).map((c) => `(${c.x},${c.y},${c.z})`).join('、');
      return { level: 'hard', text: `${bad.length} 处贴不住(${list} 不是实心方块)`, rule: 'build.noRef' };
    }
    if (have === 0) return { level: 'hard', text: `包里没有${zhName(mat)}`, rule: 'build.noStock' };
    if (unloaded > 0) return { level: 'soft', text: `${unloaded} 处的区块没加载,读不到`, rule: 'build.unloaded' };
    return null;
  }
  // 锚点形态:先看料
  const cells = deps.cellsOf(call);
  if (have === 0) return { level: 'hard', text: `包里没有${zhName(mat)}`, rule: 'build.noStock' };
  if (cells && cells.length > 0) {
    // 只数还需要动手的格(已经是该方块/被占的不算)
    let todo = 0;
    let unloaded = 0;
    for (const c of cells) {
      const b = deps.blockAt(c) as BlockLike;
      if (!b) { unloaded++; continue; }
      if (b.name === mat) continue;
      if (b.boundingBox === 'block') continue;
      todo++;
    }
    if (todo > have) {
      return { level: 'hard', text: `要放 ${todo} 块${zhName(mat)},包里只有 ${have} 个,差 ${todo - have}`, rule: 'build.short' };
    }
    if (unloaded > 0) return { level: 'soft', text: `${unloaded} 格区块没加载,读不到`, rule: 'build.unloaded' };
  }
  return null;
}

/** 活物当前不在目标半径内仅报告 soft；它可能在步骤执行前进入范围。 */
function precheckTarget(bot: Bot, target: string, radius: number, rule: string): PrecheckNote | null {
  if (!target) return null;
  const want = String(target).toLowerCase();
  let near = 0;
  const p = bot.entity?.position;
  if (!p) return null;
  for (const e of Object.values(bot.entities ?? {})) {
    const n = String((e as { name?: string }).name ?? '').toLowerCase();
    if (n !== want) continue;
    const q = (e as { position?: { x: number; y: number; z: number } }).position;
    if (!q) continue;
    if (Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) <= radius) near++;
  }
  if (near > 0) return null;
  return { level: 'soft', text: `${radius} 格内这会儿没有${zhEntity(target)}`, rule };
}

function attackEntity(bot: Bot, target: string): RangedTarget | null {
  const want = target.toLowerCase();
  const p = bot.entity?.position;
  if (!p) return null;
  let best: { target: RangedTarget; distance: number } | null = null;
  for (const entity of Object.values(bot.entities ?? {})) {
    const e = entity as {
      id?: number; name?: string; username?: string; type?: string;
      position?: { x: number; y: number; z: number }; height?: number; width?: number;
    };
    const label = e.type === 'player' ? e.username : e.name;
    if (typeof e.id !== 'number' || !e.position || label?.toLowerCase() !== want) continue;
    const distance = Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z);
    if (distance > 32 || (best && best.distance <= distance)) continue;
    best = {
      target: {
        id: e.id, position: e.position,
        ...(e.height === undefined ? {} : { height: e.height }),
        ...(e.width === undefined ? {} : { width: e.width }),
      },
      distance,
    };
  }
  return best?.target ?? null;
}

/** 强制远程的确定性缺口；auto/melee 不在试算阶段替任务选择武器。 */
function precheckAttack(bot: Bot, call: Extract<SkillCall, { skill: 'attack' }>): PrecheckNote | null {
  if (call.mode !== 'ranged' && call.mode !== 'kite') return precheckTarget(bot, call.target, 32, 'attack.noTarget');
  if (!bestRangedWeapon(bot)) {
    return { level: 'hard', text: '包里没有可用的弓;强制远程不会改用近战', rule: 'attack.noBow' };
  }
  if (!hasUsableArrows(bot)) {
    return { level: 'hard', text: '包里没有普通箭;强制远程不会改用近战', rule: 'attack.noArrow' };
  }
  const target = attackEntity(bot, call.target);
  if (!target) return precheckTarget(bot, call.target, 32, 'attack.noTarget');
  if (!hasRangedLos(bot, target)) {
    return { level: 'hard', text: `现在看不见${zhEntity(call.target)}的射线;强制远程不会改用近战`, rule: 'attack.noLos' };
  }
  return null;
}

export interface PrecheckDeps {
  /** 锚点 → 绝对格(执行器的 resolveAt) */
  resolve: (a: unknown) => Cell | null;
  /** 形状 → 格清单(执行器的 shapeCells);拿不到就返回 null,那一条判据跳过 */
  cellsOf: (c: SkillCall) => Cell[] | null;
  /** 读一格方块(执行器的 blockAtCell —— 它内部 new Vec3,不能直接传普通对象) */
  blockAt: (cell: Cell) => { name: string; boundingBox?: string } | null | undefined;
  /** 这一场上次吃东西的时刻(epoch ms);这一场还没吃过为 null。`[口粮]` 那行的四个数之一 */
  lastAte?: () => number | null;
}

type MiningCall = Extract<SkillCall, { skill: 'collect' | 'excavate' | 'tunnel' }>;

/** 已知目标的挖掘步骤在动工前排除缺工具与必然无掉落。 */
/**
 * lead 的三条:拴上那一下要包里真有绳(hard,缺了这一步一定驳回);要拴的那只这会儿
 * 在不在身边(soft,活物会自己走过来);`tie` 指的那一格是不是栅栏(hard —— 只有栅栏
 * 系得住绳,栅栏门和墙都不行,这条现在就可证)。
 */
function precheckLead(
  bot: Bot,
  call: { target?: string; tie?: unknown; off?: true },
  deps: PrecheckDeps,
): PrecheckNote | null {
  if (call.off) return null;
  if (call.target) {
    const stock = precheckHasItem(bot, 'lead', '拴', 'lead.noStock');
    if (stock) return stock;
  }
  if (call.tie !== undefined) {
    const cell = deps.resolve(call.tie);
    const b = cell ? (deps.blockAt(cell) as BlockLike) : null;
    if (cell && b && !(b.name.endsWith('_fence') || b.name === 'nether_brick_fence')) {
      return {
        level: 'hard',
        text: `(${cell.x},${cell.y},${cell.z}) 是${zhName(b.name)},绳系不上去——只有栅栏系得住(栅栏门不行)`,
        rule: 'lead.notFence',
      };
    }
  }
  return call.target ? precheckTarget(bot, call.target, 32, 'lead.noTarget') : null;
}

function precheckMiningTool(bot: Bot, call: SkillCall, deps: PrecheckDeps): PrecheckNote | null {
  if (call.skill !== 'collect' && call.skill !== 'excavate' && call.skill !== 'tunnel') return null;
  const tool = (call as MiningCall).tool;
  // 与执行器 chooseTool 同一个范围:包里加副手
  const inventory = itemsInReach(bot);
  const exact = tool && tool !== 'fastest'
    ? inventory.find((entry) => entry.name === tool && entry.count > 0)
    : null;
  if (tool && tool !== 'fastest' && !exact) {
    return {
      level: 'hard',
      text: `包里没有本步指定的${zhName(tool)};不会改用别的工具`,
      rule: `${call.skill}.toolNoStock`,
    };
  }
  const blocks = new Set<string>();
  if (call.skill === 'collect') blocks.add(call.block);
  if (call.skill === 'excavate') {
    for (const cell of deps.cellsOf(call) ?? []) {
      const block = deps.blockAt(cell);
      if (block && block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') blocks.add(block.name);
    }
  }
  const registry = bot.registry as unknown as {
    blocksByName?: Record<string, { harvestTools?: Record<string, unknown> } | undefined>;
    items?: Record<number, { name?: string } | undefined>;
  };
  for (const block of blocks) {
    const harvest = Object.keys(registry.blocksByName?.[block]?.harvestTools ?? {});
    if (harvest.length === 0) continue;
    const names = harvest.map((id) => registry.items?.[Number(id)]?.name).filter((name): name is string => !!name);
    const rank = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];
    const required = rank.flatMap((tier) => names.filter((name) => name.startsWith(tier)))[0] ?? names[0];
    if (!exact && inventory.some((item) => harvest.includes(String(item.type)))) continue;
    if (!exact) {
      return {
        level: 'hard',
        text: `包里没有能保住${zhName(block)}掉落的工具${required ? `,要${zhName(required)}及以上` : ''};还没动方块`,
        rule: `${call.skill}.toolNoDrop`,
      };
    }
    if (harvest.includes(String(exact.type))) continue;
    return {
      level: 'hard',
      text: `本步指定的${zhName(exact.name)}挖${zhName(block)}不掉东西${required ? `,要${zhName(required)}及以上` : ''};不会改用别的工具`,
      rule: `${call.skill}.toolNoDrop`,
    };
  }
  return null;
}

/**
 * 单步试算；全部通过或未覆盖时返回 null。goto 路线试算由 dryRun 单独处理。
 * 每步至多返回一条，hard 优先于 soft。
 */
export function precheckStep(bot: Bot, call: SkillCall, deps: PrecheckDeps): PrecheckNote | null {
  if (!bot?.inventory) return null;
  if ((call as { dryRun?: boolean }).dryRun) return null; // 试算本身不用再试算
  try {
    const tool = precheckMiningTool(bot, call, deps);
    if (tool) return tool;
    switch (call.skill) {
      case 'craft': return precheckCraft(bot, call as never) ?? precheckSlots(bot, call);
      case 'eat': return precheckEat(bot, call, deps);
      case 'build': return precheckBuild(bot, call as never, deps);
      case 'tunnel': return precheckTunnel(bot, call as never, deps.resolve) ?? precheckDeepKit(bot, call, deps);
      case 'excavate': return precheckDeepKit(bot, call, deps);
      case 'equip':
        return call.item && (equippedAlready(bot, call.item, call.hand, call.pick) || offHandHas(bot, call.item, call.pick))
          ? null : precheckItemStep(bot, call, '拿');
      case 'toss': return precheckItemStep(bot, call, '扔');
      case 'stow': return precheckItemStep(bot, call, '存');
      case 'anvil': return precheckItemStep(bot, call, '用');
      case 'grindstone': return precheckItemStep(bot, call, '磨');
      case 'take': return precheckSlots(bot, call);
      case 'collect': return precheckSlots(bot, call) ?? precheckDeepKit(bot, call, deps);
      case 'pickup': return precheckSlots(bot, call);
      case 'surface': return precheckSurfaceHere(bot);
      case 'lead': return precheckLead(bot, call as never, deps);
      case 'use': {
        const item = (call as { item?: string }).item;
        if (item) {
          return precheckUseItemAt(bot, call as { item?: string; at?: unknown }, deps)
            ?? precheckSoilCell(bot, call as { item?: string; at?: unknown }, deps)
            ?? precheckBedHere(bot, call as { at?: unknown }, deps);
        }
        const tgt = (call as { target?: string }).target;
        if (tgt) return precheckTarget(bot, tgt, 32, 'use.noTarget');
        return precheckBedHere(bot, call as { at?: unknown }, deps);
      }
      case 'attack': return precheckAttack(bot, call);
      default: return null;
    }
  } catch {
    return null; // 试算自己不许成为故障源
  }
}

/**
 * 整单试算(受理刻)。只收否定,全通返回空数组 —— 1418 次受理都挂一段试算,
 * 她会调不动也会读吐;只报否定才让信号稀缺、token 成本近零。
 */
export function precheckSteps(bot: Bot, steps: SkillCall[], deps: PrecheckDeps): Array<{ index: number; note: PrecheckNote }> {
  const out: Array<{ index: number; note: PrecheckNote }> = [];
  for (let i = 0; i < steps.length; i++) {
    const note = precheckStep(bot, steps[i], deps);
    if (note) out.push({ index: i, note });
  }
  return out;
}

/** 受理回执注明“还没动工”，区分预检与执行结果；只报事实，不修改任务。 */
export function renderPrecheckNotes(hits: Array<{ index: number; note: PrecheckNote }>): string | null {
  if (hits.length === 0) return null;
  // 「包里没有任何食物」不与「你没有锄头」同排版:它是全场最高频的一条,混排三场
  // 无人升级。拎成独立前缀行,格式照 `[现场]`——那句是水桶 25 次失败里唯一没让她跑偏的。
  const ration = hits.find((h) => h.note.rule === 'eat.none');
  const rest = hits.filter((h) => h.note.rule !== 'eat.none');
  const hard = rest.filter((h) => h.note.level === 'hard');
  const soft = rest.filter((h) => h.note.level === 'soft');
  const one = (h: { index: number; note: PrecheckNote }): string => `第 ${h.index + 1} 步${h.note.text}`;
  const parts: string[] = [];
  if (hard.length > 0) parts.push(`试算(还没动工):${hard.map(one).join(';')}`);
  if (soft.length > 0) parts.push(`另外:${soft.map(one).join(';')}`);
  const body = parts.join('。');
  if (!ration) return body;
  const line = `[口粮] ${ration.note.text}`;
  return body ? `${line}\n${body}` : line;
}
