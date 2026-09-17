/**
 * 把东西放下去:贴哪一面、站哪儿放得着、放完回读确认,以及随手补光与耗材许可。
 *
 * 只管一格一格地放与站位,放什么、放成什么形状由技能族决定。
 */
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { chestBlockName, matchItemName, matchMaterialName } from './chests.ts';
import { blockStateItem } from './blueprint-registry.ts';
import { BLOCK_FACES, cellOnFace, resolveAnchors, type BlockFace, type Cell } from './geometry.ts';
import { isDark, isNight, pocketScan, sampleLight } from './terrain.ts';
import {
  BUILD_CELL_CAP, FACE_TRY_ORDER, LIQUIDS, NO_PLACE_REFERENCE, PLACE_REACH, blockAtCell, cellKeyOf,
  cellText, chebyshev, dimensionOf, feetOf, refCellOf, shapeCells, skyBlocked, solidAt,
} from './cell-facts.ts';
import {
  Aborted, SkillBlocked, checkAbort, sleep, type BlueprintSite, type ResourcePlacementPermit,
  type SkillContext,
} from './skill-context.ts';
import { zhName } from './names.ts';
import { gotoGoal } from './travel.ts';
import { invCount, type InvItem } from './inventory.ts';
import { forgetPlaced } from './placed-ledger.ts';
import { contentsText, type PlaceCall, zhErrorText } from './receipt.ts';
import { FALLBACK_DEFAULTS, isGravityBlock } from './policy.ts';
import { type PositionXYZ } from './blueprint.ts';

const { goals } = pathfinderPkg;

/**
 * 放置验收按「目标方块由这份材料放出」匹配。
 * 材料选择仍走精确 ID；落地方块再经 registry 映回物品，收住 torch→wall_torch 等原版形态转换。
 */
export function matchPlacedMaterialName(bot: Bot, material: string, blockName: string): boolean {
  if (matchMaterialName(bot.registry, material, blockName)) return true;
  if (!blockName) return false;
  const placedBy = blockStateItem(`minecraft:${blockName}`).item;
  return placedBy !== null && matchMaterialName(bot.registry, material, placedBy);
}

/** 封闭空腔报告数值；只有非露天探查才报告与更大空间连通。 */
export function pushPocketLine(bot: Bot, lines: string[], cells: Cell[], airCells: Cell[]): void {
  if (airCells.length === 0) return;
  const read = (x: number, y: number, z: number) => {
    const b = bot.blockAt(new Vec3(x, y, z));
    return b ? { name: b.name, solid: b.boundingBox === 'block' } : null;
  };
  const pocket = pocketScan(read, airCells);
  if (pocket !== null) {
    lines.push(`这片空气是封死的,连它外面一共约 ${pocket} 格。`);
    return;
  }
  const cx = Math.round(cells.reduce((s, c) => s + c.x, 0) / cells.length);
  const cy = Math.round(cells.reduce((s, c) => s + c.y, 0) / cells.length);
  const cz = Math.round(cells.reduce((s, c) => s + c.z, 0) / cells.length);
  if (skyBlocked(bot, cx, cy + 1, cz)) {
    lines.push('这片空气连着更大的空间(灌了 128 格还没摸到边)。');
  }
}

/**
 * 跳起来把方块垫到自己脚下。成功 = 脚下那一格变成了要放的东西。
 *
 * 判据不能是"那一格实心了":火把、树苗这些没有碰撞箱,按实心判会把放成功的一律当失败
 * (`placeIntoCell` 早就改过,这里漏了)。给了 material 就按名字比对,不给(垫脚上行)
 * 仍按实心判——那条路要的就是站得上去。
 */
export async function jumpPlaceBelow(bot: Bot, ctx: SkillContext, material?: string): Promise<boolean> {
  const feet = bot.entity.position.floored();
  const below = bot.blockAt(feet.offset(0, -1, 0));
  if (!below || below.boundingBox !== 'block') return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    checkAbort(ctx);
    await bot.lookAt(feet.offset(0.5, 0, 0.5), true);
    bot.setControlState('jump', true);
    const airborne = Date.now() + 1_200;
    while (bot.entity.position.y - feet.y < 0.95 && Date.now() < airborne) await sleep(50);
    try {
      await bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch {
      /* 时机不对就再跳一次 */
    }
    bot.setControlState('jump', false);
    await sleep(400);
    const now = bot.blockAt(feet);
    if (!now) continue;
    if (material ? matchPlacedMaterialName(bot, material, now.name) : now.boundingBox === 'block') return true;
  }
  return false;
}

/** 垫脚失败时报告脚下格实际内容，不选择清理或绕行方案。 */
export function padFailure(bot: Bot): string {
  const feet = feetOf(bot);
  const here = bot.blockAt(new Vec3(feet.x, feet.y, feet.z));
  const below = bot.blockAt(new Vec3(feet.x, feet.y - 1, feet.z));
  // 人在哪由调用方报一次;这里只说那一格的实情
  const at = '垫不上脚下那一格';
  if (!below || below.boundingBox !== 'block') {
    return `${at}:下面 ${cellText({ x: feet.x, y: feet.y - 1, z: feet.z })} 是` +
      `${below ? zhName(below.name) : '没加载的区块'},没有能贴着放的实心面`;
  }
  if (here && here.name !== 'air') return `${at}:那一格现在是${zhName(here.name)}`;
  return `${at}:那一格是空气,连放 3 次服务端都没认`;
}

/** 贴这一面放时的参照方块;得是实心方块且不在原版确定性拒绝的名单里,否则 null */
export function usableReference(bot: Bot, cell: Cell, face: BlockFace): ReturnType<Bot['blockAt']> {
  const ref = blockAtCell(bot, refCellOf(cell, face));
  if (!ref || ref.boundingBox !== 'block' || NO_PLACE_REFERENCE.has(ref.name)) return null;
  return ref;
}

/**
 * 六个面里第一个能当参照的;一个都没有时 null。
 *
 * 归因用:`placeIntoCell` 的 null 混着两件事 —— 一包都没发出去(没有参照面)与
 * 发了三包被服务端拒。两者她要换的招不一样,回执不许都写成「服务端不认」。
 */
export function placeReferenceFace(bot: Bot, cell: Cell, face?: BlockFace): BlockFace | null {
  return (face ? [face] : FACE_TRY_ORDER).find((f) => usableReference(bot, cell, f) !== null) ?? null;
}

/**
 * 把一块材料放进指定格,返回贴的是哪一面(放不上返回 null)。
 *
 * 放置在原版里就是(参照方块,面)这一对:给了 `face` 就只点那一面,她说了贴哪儿
 * 就不必猜;没给就按 `FACE_TRY_ORDER` 挨个试,回执照实报最后贴上的是哪一面。
 * 成没成看的是"那一格变成了要放的东西",不是"那一格实心了" ——
 * 火把、树苗、种子这些没有碰撞箱,按实心判会把放成功的一律当失败。
 */
export async function placeIntoCell(
  bot: Bot, cell: Cell, material: string, ctx: SkillContext, face?: BlockFace,
): Promise<BlockFace | null> {
  const became = (): boolean => {
    const b = blockAtCell(bot, cell);
    return b != null && matchPlacedMaterialName(bot, material, b.name);
  };
  // 潜行着放:mineflayer 的 _genericPlace 从不告诉服务端"我按着 shift"(它源码里那行
  // `// TODO: tell the server that we are sneaking while doing this` 还在)。不潜行时
  // 右键交互方块,服务端执行的是打开它而不是放方块——参照是门/箱子/工作台/熔炉时,
  // 六个面全试完也放不上一块。
  bot.setControlState('sneak', true);
  try {
    for (const f of face ? [face] : FACE_TRY_ORDER) {
      checkAbort(ctx);
      // 原版拒绝以耕地或作物作为此放置的参照面，跳过无效面。
      const ref = usableReference(bot, cell, f);
      if (!ref) continue;
      const [dx, dy, dz] = BLOCK_FACES[f];
      try {
        await bot.placeBlock(ref, new Vec3(dx, dy, dz));
      } catch {
        continue;
      }
      await sleep(150);
      if (became()) return f;
    }
  } finally {
    bot.setControlState('sneak', false);
  }
  return null;
}

/**
 * 放置前重新确认手持物，寻路挖掘可能已经换成工具；缺料返回 false。
 * 材料名按 build 同一规则匹配完整名或材料后缀。
 */
export async function ensureHolding(bot: Bot, material: string): Promise<boolean> {
  const fits = (n: string): boolean => matchMaterialName(bot.registry, material, n);
  if (bot.heldItem && fits(bot.heldItem.name)) return true;
  const item = bot.inventory.items().find((i) => fits(i.name));
  if (!item) return false;
  await bot.equip(item, 'hand');
  return true;
}

/** 扫掉落物的范围:脚边这一坑,不是半个区块 */
export const SWEEP_RANGE = 6;
export const SWEEP_DY = 3;

/**
 * 挖完在原地扫一遍掉落物:东西落在刚挖开的那个坑里,站在坑外挖的人不会自己捡。
 *
 * 范围必须卡死。放宽到 12 格时寻路会为了一件飘到高处的掉落物垫柱子爬上去,
 * 再把刚挖空的格子填回来——捡回的还不够填回去的。
 */
export async function sweepDrops(bot: Bot, ctx: SkillContext): Promise<void> {
  for (let i = 0; i < 6; i++) {
    checkAbort(ctx);
    const me = bot.entity.position;
    let nearest: { pos: { x: number; y: number; z: number }; d: number } | null = null;
    for (const id of Object.keys(bot.entities)) {
      const e = bot.entities[id];
      if (!e?.position || (e.name !== 'item' && e.name !== 'item_stack')) continue;
      if (Math.abs(e.position.y - me.y) > SWEEP_DY) continue;
      const d = Math.hypot(e.position.x - me.x, e.position.z - me.z);
      if (d > 1.2 && d <= SWEEP_RANGE && (!nearest || d < nearest.d)) nearest = { pos: e.position, d };
    }
    if (!nearest) return;
    await gotoGoal(bot, new goals.GoalNear(nearest.pos.x, nearest.pos.y, nearest.pos.z, 0.5), ctx)
      .catch(() => undefined);
    await sleep(250);
  }
}

/**
 * 维持条件:干活途中世界不对劲时,就地补一个有界的小动作,然后接着做原来那件事。
 *
 * 与反射层的分界是"要不要放下手上这件事":反射(岩浆、低血、溺水)打断并接管,
 * 走 `preempt()`;维持不打断,补一格、插一根,回到原来那一步。
 *
 * 三条,每条由四件事定义 —— 什么时候触发、补什么、料从哪来、没料就不做。
 * 料一律从常驻规矩(`mc_policy`)取,做过的进收工回执报数,没做成的单独可报。
 */
export type UpkeepKind = 'footing' | 'climb' | 'light';

/** 这一处补光属于哪个场合;`travel` 那一类由 `mc_policy` 的 `lightWhen` 决定做不做 */
export type LightOccasion = 'dig' | 'travel';

/** 一条条件的料:名单从设置来,包里有没有当场看。没料就不做,不是失败 */
export type Stock = { item: InvItem } | { why: string };

export type PermittedStock =
  | { item: InvItem; permit: Extract<ResourcePlacementPermit, { ok: true }> }
  | { why: string };

export function permitPlacement(ctx: SkillContext, item: string, preview = false): ResourcePlacementPermit {
  // 试算不动世界:走只读判据,不取 permit —— 取了会在放置结算期把"上一块材料还在
  // 结算,这次放置稍后再试"塞进预览文案,而预览本来就不放任何东西
  if (preview) {
    const decision = ctx.previewResourcePlacement?.(item) ?? { ok: true };
    return decision.ok ? { ok: true, finish: () => {} } : { ok: false, reason: decision.reason ?? '' };
  }
  return ctx.permitResourcePlacement?.(item) ?? { ok: true, finish: () => {} };
}

/** 按策略优先级选择有库存且获放置许可的第一种材料。 */
export function permittedStockFor(
  bot: Bot,
  names: string[] | null,
  label: string,
  ctx: SkillContext,
  preview = false,
): PermittedStock {
  if (!names) return { why: `${label}名单是空的(设置里关了)` };
  const items = bot.inventory.items();
  let denied = '';
  for (const name of names) {
    const item = items.find((candidate) => matchItemName(name, candidate.name));
    if (!item) continue;
    const permit = permitPlacement(ctx, item.name, preview);
    if (permit.ok) return { item, permit };
    denied ||= permit.reason;
  }
  return denied
    ? { why: denied }
    : { why: `${label}名单里的方块包里都没有(${names.map((n) => zhName(n)).join('、')})` };
}

/**
 * 插下去到服务端把新光照推回来之间有一拍,这段时间那一片读到的还是黑。
 * 离上一根火把这么近就不再判黑:原版火把光源 14、每格衰减 1,6 格外仍有 8。
 */
export const TORCH_SPACING = 6;
/** 亮度众数要按面连通漫 96 格,挖一块查一次不值;两秒一次跟得上走路的速度 */
export const LIGHT_CHECK_MS = 2_000;
/**
 * 火把先贴四面墙,贴不住才落到地上。
 * 竖井里脚下那一格就是下一铲,插在地上一挖就跟着掉;墙上那根整条井都留得住。
 */
export const TORCH_FACES: readonly BlockFace[] = ['north', 'south', 'west', 'east', 'up'];

/** 一次技能执行期间的维持条件账:做成几次、上一次没做成是为什么 */
export class Upkeep {
  private padded = 0;
  private lit = 0;
  private litName = 'torch';
  private lastTorch: Cell | null = null;
  /**
   * 上次补光失败的格；与只记录成功的 lastTorch 分开去重。
   * 脚下格改变后失效，不使用时间冷却。
   */
  private lastLightMiss: Cell | null = null;
  private lastLightCheck = 0;
  private readonly missed = new Map<UpkeepKind, string>();

  constructor(private readonly bot: Bot, private readonly ctx: SkillContext) {}

  /** 脚下没底 → 把那一格垫上。垫成了才 true;没料/服务端不认/落在工地里都进 `why` */
  async footing(cell: Cell): Promise<boolean> {
    // 身体占据的放置格会被服务端拒绝，须在发包前检查 occupiedByMe。
    if (occupiedByMe(this.bot, cell)) {
      this.missed.set('footing', `${cellText(cell)} 是我自己站着的那一格,人在里面放不进方块`);
      return false;
    }
    const site = siteAtCell(this.ctx, cell);
    if (site) {
      this.missed.set('footing', siteRefusalText(site, cell));
      return false;
    }
    // 只擦进去几厘米也拒。退半步是这一格唯一的自救,退不开就点名,不发那一包
    if (hitboxBlocks(this.bot, cell) && !(await stepOffCell(this.bot, this.ctx, cell))) {
      this.missed.set('footing', `${cellText(cell)} 被我自己的身子压着一角,退不开半步,放不进方块`);
      return false;
    }
    const stock = permittedStockFor(this.bot, scaffoldNames(this.ctx), '垫脚', this.ctx);
    if ('why' in stock) {
      this.missed.set('footing', stock.why);
      return false;
    }
    let placed = false;
    try {
      await this.bot.equip(stock.item, 'hand');
      placed = (await placeIntoCell(this.bot, cell, stock.item.name, this.ctx)) !== null;
    } finally {
      stock.permit.finish(placed);
    }
    if (!placed) {
      this.missed.set('footing', placeReferenceFace(this.bot, cell) === null
        ? `${cellText(cell)} 六个面都没有能贴着放的实心方块,这一包没发出去`
        : `拿${zhName(stock.item.name)}放了,服务端不认`);
      return false;
    }
    this.padded++;
    return true;
  }

  /** 上不去 → 跳起来把方块垫到自己脚下。占位的是谁由 `padFailure` 点名 */
  async climb(): Promise<boolean> {
    // 垫的是脚这一格(jumpPlaceBelow 跳起来往 feet 里放),判的也是它
    const feet = feetOf(this.bot);
    const site = siteAtCell(this.ctx, feet);
    if (site) {
      this.missed.set('climb', siteRefusalText(site, feet));
      return false;
    }
    const stock = permittedStockFor(this.bot, scaffoldNames(this.ctx), '垫脚', this.ctx);
    if ('why' in stock) {
      this.missed.set('climb', stock.why);
      return false;
    }
    let placed = false;
    try {
      await this.bot.equip(stock.item, 'hand');
      placed = await jumpPlaceBelow(this.bot, this.ctx, stock.item.name);
    } finally {
      stock.permit.finish(placed);
    }
    if (!placed) {
      this.missed.set('climb', padFailure(this.bot));
      return false;
    }
    return true;
  }

  /**
   * 连通区域光照众数 ≤1 时补光，与快照的黑暗判据一致。
   * avoid 标出接下来要挖的格，不能用作火把支撑面。
   * dig 场合补光；travel 场合仅在 lightWhen 为 anywhere 时补光。
   */
  async light(avoid?: (c: Cell) => boolean, occasion: LightOccasion = 'dig'): Promise<void> {
    if (this.ctx.noLight) return;
    if (occasion === 'travel' && (this.ctx.policy?.get().lightWhen ?? 'dig') !== 'anywhere') return;
    const names = lightNames(this.ctx);
    if (!names) return;
    const now = Date.now();
    if (now - this.lastLightCheck < LIGHT_CHECK_MS) return;
    this.lastLightCheck = now;
    const feet = feetOf(this.bot);
    if (this.lastTorch && chebyshev(feet, this.lastTorch) < TORCH_SPACING) return;
    if (this.lastLightMiss && cellKeyOf(this.lastLightMiss) === cellKeyOf(feet)) return;
    if (!isDark(sampleLight(this.bot, isNight(this.bot.time?.timeOfDay ?? 0)))) return;
    const occupied = blockAtCell(this.bot, feet);
    if (occupied && names.some((name) => matchPlacedMaterialName(this.bot, name, occupied.name))) {
      this.lastTorch = feet;
      return;
    }
    // 与 build 共用 boundingBox 为 block 的占位判据；耕地和塌落沙砾可能落在脚下取整格内。
    if (occupied && occupied.boundingBox === 'block') {
      this.lastLightMiss = feet;
      this.missed.set('light', `我站的这一格 ${occupantText(this.bot, feet)},火把插不进去`);
      return;
    }
    const stock = permittedStockFor(this.bot, names, '照明', this.ctx);
    if ('why' in stock) {
      this.missed.set('light', stock.why);
      return;
    }
    let on: BlockFace | null = null;
    try {
      await this.bot.equip(stock.item, 'hand');
      for (const f of TORCH_FACES) {
        if (avoid?.(refCellOf(feet, f))) continue;
        on = await placeIntoCell(this.bot, feet, stock.item.name, this.ctx, f);
        if (on) break;
      }
    } finally {
      stock.permit.finish(on !== null);
    }
    if (!on) {
      this.lastLightMiss = feet;
      this.missed.set('light', `拿${zhName(stock.item.name)}放了,四面墙和脚下都没贴住`);
      return;
    }
    // 有意插下去的那一根由这里点名报数,不能再被贴成「路上垫脚/搭路用掉了」
    forgetPlaced(this.bot, feet);
    this.lit++;
    this.litName = stock.item.name;
    this.lastTorch = feet;
    this.lastLightMiss = null;
  }

  /** 上一次没做成是为什么;这一趟没试过就是空串 */
  why(kind: UpkeepKind): string {
    return this.missed.get(kind) ?? '';
  }

  /**
   * 做过的事进收工回执。`climb` 不在这里 —— 它的次数就是调用方自己的进度数
   * (塔的格数、爬到露天上来的格数),再报一遍就是同一件事说两遍。
   */
  tally(): string[] {
    const out: string[] = [];
    if (this.padded > 0) out.push(`路上有 ${this.padded} 格没底,垫上了`);
    if (this.lit > 0) out.push(`顺手插了 ${this.lit} 根${zhName(this.litName)}`);
    const darkWhy = this.missed.get('light');
    if (darkWhy) out.push(`有一段黑着没插上:${darkWhy}`);
    return out;
  }
}

/**
 * 一格放不上时,那一格里现在是什么。
 *
 * 六面都试过还是没放上,原因几乎总在这一格自己身上:火把、墙上火把、树苗、作物这些
 * 没有碰撞箱、`classify` 当空格,可服务端顶不掉,放几次都白搭。回执必须点名占位的是谁——
 * 只说"剩 1 格放不上"读不出下一步该拆什么。
 */
export function occupantOf(bot: Bot, c: Cell): string {
  const b = blockAtCell(bot, c);
  if (!b) return '区块没加载';
  if (b.name === 'air') return '是空气,服务端就是不认';
  return `现在是${zhName(b.name)}`;
}

export function occupantText(bot: Bot, c: Cell): string {
  return `${cellText(c)} ${occupantOf(bot, c)}`;
}

/**
 * 多格家具的占位:床横着占两格、门与高草竖着占两格。
 *
 * 不维护表——从 minecraft-data 的方块状态推:`part:head/foot` = 横向两格(16 种床),
 * `half:upper/lower` = 纵向两格(30 种门/高草/大蕨/向日葵…)。
 * 楼梯活板门那 76 种的 `half` 是 `top/bottom`,只占半格,两个值集合交集为 0,不会误判。
 */
export type Footprint = 'single' | 'horizontal' | 'vertical';

export function footprintOf(bot: Bot, material: string): Footprint {
  const def = (bot.registry.blocksByName as Record<string, { states?: Array<{ name: string; values?: string[] }> } | undefined>)[material];
  for (const s of def?.states ?? []) {
    if (s.name === 'part' && s.values?.includes('head')) return 'horizontal';
    if (s.name === 'half' && s.values?.includes('upper')) return 'vertical';
  }
  return 'single';
}

/** 一格能不能让东西占进去:空着(或能被顶掉),且脚下踩得住 */
export function footFree(bot: Bot, c: Cell): boolean {
  const b = blockAtCell(bot, c);
  return b != null && b.boundingBox !== 'block';
}

/**
 * 多格家具放不下时的现场:附近哪些位置的占位是**够的**。
 * 她从快照里看不到"哪儿有连续两格空位",只能靠一次次试——这是照实回报,不是代她决定。
 */
export function footprintScene(bot: Bot, center: Cell, material: string, fp: Footprint): string[] {
  const R = 8;
  const label = zhName(material);
  const fits: Array<{ text: string; d: number }> = [];
  const me = bot.entity?.position ?? { x: center.x, y: center.y, z: center.z };
  const pairs: Array<[number, number, number]> = fp === 'vertical'
    ? [[0, 1, 0]]
    : [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
  for (let dx = -R; dx <= R; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -R; dz <= R; dz++) {
        const a = { x: center.x + dx, y: center.y + dy, z: center.z + dz };
        if (!footFree(bot, a)) continue;
        if (!solidAt(bot, { x: a.x, y: a.y - 1, z: a.z })) continue;
        for (const [ox, oy, oz] of pairs) {
          const b = { x: a.x + ox, y: a.y + oy, z: a.z + oz };
          if (!footFree(bot, b)) continue;
          if (fp === 'horizontal' && !solidAt(bot, { x: b.x, y: b.y - 1, z: b.z })) continue;
          fits.push({
            text: `${cellText(a)}+${cellText(b)}`,
            d: Math.hypot(a.x + 0.5 - me.x, a.y - me.y, a.z + 0.5 - me.z),
          });
          break;
        }
      }
    }
  }
  const how = fp === 'vertical' ? '上下连续两格空、脚下实心' : '横着连续两格空、脚下都实心';
  if (fits.length === 0) return [`${R} 格内没有${how}的位置,放不下${label}`];
  // 候选只按距离排序，不作位置优劣推荐。
  fits.sort((p, q) => p.d - q.d);
  const shown = fits.slice(0, FOOTPRINT_SPOTS_MAX);
  return [
    `${label}要占两格。${R} 格内${how}的位置有 ${fits.length} 处:${shown.map((f) => f.text).join('、')}`
    + (fits.length > shown.length ? `(共 ${fits.length} 处,按远近取前 ${shown.length})` : ''),
  ];
}

/** 候选位置一次列几处;排序判据是离她多远,越靠前越近 */
export const FOOTPRINT_SPOTS_MAX = 5;

/** 一处要放的地方:落点那一格,以及她指名的贴面(没指名 = null,由执行器挑) */
export interface BuildSpot { cell: Cell; face: BlockFace | null }

/**
 * build 的两种入参落到同一批落点上:贴面形态给的是(参照方块,面),落点由这一对算出来;
 * 格子清单/形状形态给的是落点本身,贴哪一面由执行器挑。
 */
export function buildSpots(bot: Bot, call: PlaceCall): BuildSpot[] {
  const spots: BuildSpot[] = [];
  if ('on' in call) {
    const refs = resolveAnchors(call.on.map((o) => o.at), feetOf(bot));
    if (!Array.isArray(refs)) throw new SkillBlocked(refs.error);
    for (const [i, ref] of refs.entries()) {
      spots.push({ cell: cellOnFace(ref, call.on[i].face), face: call.on[i].face });
    }
  } else {
    for (const cell of shapeCells(bot, call.shape, call.anchors, call.fill, BUILD_CELL_CAP)) {
      spots.push({ cell, face: null });
    }
  }
  const seen = new Set<string>();
  return spots.filter((s) => {
    const k = cellKeyOf(s.cell);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 走到"放得上这一格"的位置。落脚点不能选在要填的那一格里:GoalNear(c,2) 常把人送到
 * 目标格上站着,服务端随即以"那儿有个玩家"拒掉这一次放置。GoalPlaceBlock 的 `isStandingIn`
 * 把脚与脑袋两格都算作站在里面,并按视线求交挑落脚点,与服务端那一次射线判定同口径。
 */
export async function gotoPlaceable(bot: Bot, s: BuildSpot, ctx: SkillContext): Promise<boolean> {
  // GoalPlaceBlock 的 faces 是"参照方块相对落点的方位",与面向量正好反向;
  // 不指名面时由它自己兜六个面。facing 也一律兜默认(不限朝向)
  const opts: Record<string, unknown> = { range: PLACE_REACH, LOS: true };
  if (s.face) {
    const [dx, dy, dz] = BLOCK_FACES[s.face];
    opts.faces = [new Vec3(-dx, -dy, -dz)];
  }
  try {
    await gotoGoal(
      bot,
      new goals.GoalPlaceBlock(
        new Vec3(s.cell.x, s.cell.y, s.cell.z), bot.world,
        opts as unknown as ConstructorParameters<typeof goals.GoalPlaceBlock>[2],
      ),
      ctx,
    );
    return true;
  } catch (err) {
    if (err instanceof Aborted) throw err;
    return false;
  }
}

/** 那一格现在是我自己占着的(脚或脑袋) */
export function occupiedByMe(bot: Bot, c: Cell): boolean {
  const f = feetOf(bot);
  return f.x === c.x && f.z === c.z && (f.y === c.y || f.y + 1 === c.y);
}

/** 玩家碰撞箱:0.6 见方、1.8 高,以脚下坐标为底面中心 */
export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;
/** 「刚好贴着格子边」不算重叠:碰撞箱与方块共面时原版放得进去 */
export const HITBOX_EPS = 1e-3;

/**
 * 实体碰撞箱与格子擦边也算重叠，原版 isUnobstructed 会拒绝放置。
 * occupiedByMe 的中心格判断不足以覆盖宽 0.6 格的身体跨入邻格。
 */
export function hitboxBlocks(bot: Bot, c: Cell): boolean {
  const p = bot.entity?.position;
  if (!p) return false;
  const w = PLAYER_HALF_WIDTH;
  const e = HITBOX_EPS;
  return p.x - w < c.x + 1 - e && p.x + w > c.x + e
    && p.z - w < c.z + 1 - e && p.z + w > c.z + e
    && p.y < c.y + 1 - e && p.y + PLAYER_HEIGHT > c.y + e;
}

/**
 * 放下去会不会占住身位。原版只对**有碰撞箱**的方块查 `isUnobstructed`:火把、树苗、
 * 地毯这些放在自己身上照样成,不该为它们绕路。方块表里查不到这个名字(物品 id 与
 * 方块 id 不同名的那几样)时按占位算。
 */
export function materialCollides(bot: Bot, material: string): boolean {
  const byName = bot.registry.blocksByName as Record<string, { boundingBox?: string } | undefined>;
  return byName[material.replace(/^minecraft:/, '')]?.boundingBox !== 'empty';
}

/**
 * 站得进人:这一格与它上面一格都容得下身子,脚下有实心底,三格都不是液体。
 * 岩浆的 boundingBox 是 empty,液体判据缺一格就等于把人往里送。
 */
export function standableCell(bot: Bot, c: Cell): boolean {
  const feet = blockAtCell(bot, c);
  const head = blockAtCell(bot, { x: c.x, y: c.y + 1, z: c.z });
  const below = blockAtCell(bot, { x: c.x, y: c.y - 1, z: c.z });
  if (!feet || !head || !below) return false;
  if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty' || below.boundingBox !== 'block') return false;
  return !LIQUIDS.has(feet.name) && !LIQUIDS.has(head.name) && !LIQUIDS.has(below.name);
}

/**
 * 身子擦进了要放的那一格时,退到哪一格去。按「退开之后不再重叠」排序,只收站得住的。
 *
 * 候选只取同层四邻:上下两层要么是要放的那一格本身、要么得先垫先挖,不属于"退半步"。
 */
export function stepOffCandidates(bot: Bot, c: Cell): Cell[] {
  const feet = feetOf(bot);
  return [
    { x: feet.x + 1, y: feet.y, z: feet.z }, { x: feet.x - 1, y: feet.y, z: feet.z },
    { x: feet.x, y: feet.y, z: feet.z + 1 }, { x: feet.x, y: feet.y, z: feet.z - 1 },
  ]
    // 站在格子正中时半宽 0.3 够不到一格开外,只要不与 `c` 同列就不会再重叠
    .filter((s) => !(s.x === c.x && s.z === c.z))
    .filter((s) => standableCell(bot, s))
    .sort((a, b) => Math.hypot(b.x - c.x, b.z - c.z) - Math.hypot(a.x - c.x, a.z - c.z));
}

/**
 * 把身子从 `c` 里挪出来。已经不重叠时直接 true;挪不开时 false,由调用方点名。
 *
 * 走的是寻路一格(GoalBlock),不是按方向键:方向键会和寻路器抢控制权,而这一步
 * 常发生在寻路器正挂着目标的时候。
 */
export async function stepOffCell(bot: Bot, ctx: SkillContext, c: Cell): Promise<boolean> {
  if (!hitboxBlocks(bot, c)) return true;
  for (const spot of stepOffCandidates(bot, c).slice(0, 2)) {
    checkAbort(ctx);
    try {
      await gotoGoal(bot, new goals.GoalBlock(spot.x, spot.y, spot.z), ctx);
    } catch (err) {
      if (err instanceof Aborted) throw err;
      continue;
    }
    if (!hitboxBlocks(bot, c)) return true;
  }
  return !hitboxBlocks(bot, c);
}

/** 放方块:只放贴得住的格,近的先;轮到自己站的那格就跳起来垫脚下,顶在脑袋上就先挪开一步 */
/** 几何试算报告目标区域内登记过的工作站和容器，仅报事实，不阻止操作。 */
export function stationNotes(bot: Bot, ctx: SkillContext, cells: readonly Cell[]): string[] {
  const recs = ctx.chests?.inCells(dimensionOf(bot), cells) ?? [];
  return recs.map((r) => {
    const what = zhName(chestBlockName(r));
    const origin = r.placedAt !== undefined
      ? `你${ctx.clock ? ` ${ctx.clock(r.placedAt)}` : ''}放的`
      : '你开过的';
    const inside = r.items.length > 0 ? `,里面:${contentsText(r.items)}` : '';
    return `这片罩住了${origin}${what} (${r.x}, ${r.y}, ${r.z})${inside}。`;
  });
}

/**
 * 放置结果以目标格的服务端回读为准；`bot.placeBlock` resolve 不代表服务端已接受
 * （已在 mineflayer-fixes 里包成"回读确认才算数"）。
 */
/** 无法放置工作站时，说明所放物品、用途及可尝试的下一步。 */
export function placeNoSpotText(bot: Bot, block: string, station: Station | null): string {
  const what = zhName(block);
  const left = invCount(bot, (n) => n === block || n.endsWith(`_${block}`));
  const forWhom = station ? `,是这一步给${station.label}用的` : '';
  return `要放的是${what}${forWhom}(包里还有 ${left} 个),` +
    '但脚边一圈八格没有一个「本身是空气、脚下又是实心」的位置 —— ' +
    '站在坑里、贴着墙、脚边是水或草叶都会这样。' +
    `先 goto 挪到一块开阔的平地再来,或者 excavate 把脚边那一格挖开腾出位置;` +
    `${station ? `附近有现成的${station.label}的话直接走过去用也行。` : ''}`;
}

/** 刚放下的那条船在哪儿:只认落点附近 4 格内的,别把水面上远处那条报成这一条 */
export function nearestBoat(bot: Bot, near: Cell): Cell | null {
  const at = new Vec3(near.x + 0.5, near.y, near.z + 0.5);
  let best: Cell | null = null;
  let bestD = 4;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e?.position || !/boat|raft/.test(e.name ?? '')) continue;
    const d = e.position.distanceTo(at);
    if (d >= bestD) continue;
    bestD = d;
    // 实体坐标取整用 floor:船停在 x=1.5 时它就在 (1,…) 这一格,round 会报成隔壁那格
    best = { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) };
  }
  return best;
}

/**
 * 垫脚材料名单；显式空名单返回 null，表示禁用。
 * 未设置时使用 policy.defaults()，与寻路器共用 cfg.scaffoldBlocks；未接 World 才用 FALLBACK_DEFAULTS。
 */
export function scaffoldNames(ctx: SkillContext): string[] | null {
  const listed = ctx.policy?.get().scaffold;
  if (listed && listed.length === 0) return null;
  const names = listed ?? (ctx.policy?.defaults() ?? FALLBACK_DEFAULTS).scaffold;
  // 重力方块剔掉,与寻路器那一半同源(bridge 给 scafoldingBlocks 时也剔):垫下去失去支撑
  // 就整块落地,垫不住。分叉的代价是受阻回执把沙砾、红沙当合法垫脚料原样念给她。
  const usable = names.filter((n) => !isGravityBlock(n));
  if (usable.length === 0) return null;
  // 在建工地材料软降到末位，其他候选耗尽时仍可使用。
  const material = siteMaterials(ctx);
  if (material.size === 0) return usable;
  return [...usable.filter((n) => !material.has(n)), ...usable.filter((n) => material.has(n))];
}

/**
 * 在建的蓝图工地:已绑定锚点、游标还没走完的那些。
 *
 * 它们同时是三条规矩的取数口(全部只管"垫",不管走、挖、有意放置):工地建材垫脚
 * 降位(`scaffoldNames`)、工地体积禁垫(`siteAtCell`)、收工回收(`reclaimSiteScaffold`)。
 */
export function activeSites(ctx: SkillContext): BlueprintSite[] {
  const desk = ctx.blueprints?.();
  if (!desk) return [];
  const out: BlueprintSite[] = [];
  for (const key of desk.keys()) {
    const site = desk.get(key);
    if (site && site.anchor && site.cursor < site.plan.steps.length) out.push(site);
  }
  return out;
}

/** 在建工地要用到的物品名 */
export function siteMaterials(ctx: SkillContext): Set<string> {
  const out = new Set<string>();
  for (const site of activeSites(ctx)) {
    for (const step of site.plan.steps) out.add(step.item);
  }
  return out;
}

/** 工地体积:锚点到锚点 + 尺寸 − 1,含端点两格 */
export function siteBox(site: BlueprintSite, anchor: PositionXYZ): { min: PositionXYZ; max: PositionXYZ } {
  const s = site.blueprint.size_xyz;
  return { min: [...anchor], max: [anchor[0] + s[0] - 1, anchor[1] + s[1] - 1, anchor[2] + s[2] - 1] };
}

export function inBox(box: { min: PositionXYZ; max: PositionXYZ }, c: { x: number; y: number; z: number }): boolean {
  return c.x >= box.min[0] && c.x <= box.max[0]
    && c.y >= box.min[1] && c.y <= box.max[1]
    && c.z >= box.min[2] && c.z <= box.max[2];
}

/**
 * 返回垫脚或搭路落点所在的工地，无命中时为 null。
 * 蓝图施工与显式放置不使用此约束。
 */
export function siteAtCell(ctx: SkillContext, cell: { x: number; y: number; z: number }): BlueprintSite | null {
  // escape.active 时允许在工地内垫脚，放置仍记入 reclaimSiteScaffold 回收账。
  if (ctx.escape.active) return null;
  return siteAtCellAnywhere(ctx, cell);
}

/** 不带自救豁免的原判定:surface 数「为脱困垫进工地几块」用它 */
export function siteAtCellAnywhere(ctx: SkillContext, cell: { x: number; y: number; z: number }): BlueprintSite | null {
  for (const site of activeSites(ctx)) {
    if (inBox(siteBox(site, site.anchor!), cell)) return site;
  }
  return null;
}

export function siteRefusalText(site: BlueprintSite, cell: { x: number; y: number; z: number }): string {
  return `${cellText(cell)} 在蓝图「${site.key}」工地里,不垫`;
}

/** 插一根用哪些;`null` = 这条关着 */
export function lightNames(ctx: SkillContext): string[] | null {
  const listed = ctx.policy?.get().light;
  if (listed && listed.length === 0) return null;
  return listed ?? (ctx.policy?.defaults() ?? FALLBACK_DEFAULTS).light;
}

/**
 * 在邻格脚下垫一块,好让脚边放置有实心底。只垫一格,不自动连铺。
 *
 * 只走四个正方向。斜角贴不住:参照方块是脚下那一格,而 mineflayer 把面向量按
 * y→z→x 折成单轴(`generic_place.js` 的 `vectorToDirection`),`(1,0,1)` 发出去
 * 是"+z 面",服务端把方块放在 `stand+(0,0,1)`,回读却盯着 `stand+(1,0,1)` ——
 * 必然回读不到,还在别处留一块。
 */
export async function padAdjacent(bot: Bot, ctx: SkillContext, block: string, station: Station | null): Promise<boolean> {
  const stock = permittedStockFor(bot, scaffoldNames(ctx), '垫脚', ctx);
  // 垫脚是"腾位置"这条路的最后一手:它也走不通时,受阻文案要说的是整件事
  // (在放什么、为谁放、该怎么办),不是"垫脚料没有"这半句
  if ('why' in stock) {
    throw new SkillBlocked(`${placeNoSpotText(bot, block, station)}(想就地垫一格腾位置也不行:${stock.why})`);
  }
  let placed = false;
  try {
    const me = bot.entity.position.floored();
    const stand = bot.blockAt(me.offset(0, -1, 0));
    if (!stand || stand.boundingBox !== 'block') return false;
    await bot.equip(stock.item, 'hand');
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      checkAbort(ctx);
      const spot = me.offset(dx, 0, dz);
      const at = bot.blockAt(spot);
      const below = bot.blockAt(spot.offset(0, -1, 0));
      if (!at || at.name !== 'air' || !below || below.boundingBox === 'block') continue;
      // 落的是 spot 下面那一格;在建工地体积里不垫
      if (siteAtCell(ctx, { x: spot.x, y: spot.y - 1, z: spot.z })) continue;
      try {
        await bot.placeBlock(stand, new Vec3(dx, 0, dz));
      } catch {
        continue;
      }
      await sleep(200);
      const now = bot.blockAt(spot.offset(0, -1, 0));
      if (now && now.boundingBox === 'block') {
        placed = true;
        return true;
      }
    }
    return false;
  } finally {
    stock.permit.finish(placed);
  }
}

/**
 * 脚边八选一放一块。**只给 craft/smelt 内部用**:她说的是"合成木镐",
 * 工作台放哪不在她的意图里,World 自己找地方是机械兜底。
 * 她显式指定位置的 place/use 不走这条,那条路的位置由她定。
 *
 * 兜底本身没错,错在它是哑的:放成之后把这一条从 `placedLedger` 摘掉,
 * 由调用方在回执里点名报出来(craft 的 `made`、smelt 的自备工作站一句)。
 * 台账剩下的才是寻路器垫脚/搭路的耗材。
 */
export async function placeBlockNearby(
  bot: Bot,
  block: string,
  ctx: SkillContext,
  pad = false,
  /** 这一块是为哪一族工作站放的;受阻文案据此说清"为谁放"(null = 没有上文) */
  station: Station | null = null,
): Promise<{ x: number; y: number; z: number; name: string; block: NonNullable<ReturnType<Bot['blockAt']>> }> {
  const item = bot.inventory.items().find((i) => i.name === block || i.name.endsWith(`_${block}`));
  if (!item) throw new SkillBlocked(`包里没有${zhName(block)}`);
  await bot.equip(item, 'hand');
  const me = bot.entity.position.floored();
  let tried = 0;
  let lastError = '';
  let vanished = false;
  // _genericPlace 不代发潜行状态；须先按 sneak，避免右键参照方块触发交互。
  bot.setControlState('sneak', true);
  try {
    // 找脚边一圈:空气且下面是实心的位置
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      checkAbort(ctx);
      const spot = me.offset(dx, 0, dz);
      const at = bot.blockAt(spot);
      const below = bot.blockAt(spot.offset(0, -1, 0));
      if (!at || at.name !== 'air' || !below || below.boundingBox !== 'block') continue;
      // 服务端撤回物品后应报告持有物失配,避免将其误报为位置不可放置。
      const held = bot.heldItem;
      if (!held || (held.name !== block && !held.name.endsWith(`_${block}`))) {
        ctx.diag?.write({
          lane: 'skill', event: 'place-not-held', taskId: ctx.taskId,
          msg: `要放${zhName(block)},手上却是${held ? zhName(held.name) : '空的'}`,
          data: { block, held: held?.name ?? null, inv: invCount(bot, (n) => n === block) },
        });
        throw new SkillBlocked(
          `要放${zhName(block)},手上却是${held ? zhName(held.name) : '空的'}(包和服务器对不上)`,
        );
      }
      tried++;
      try {
        await bot.placeBlock(below, new Vec3(0, 1, 0));
      } catch (err) {
        lastError = zhErrorText((err as Error).message);
        continue;
      }
      // 回读:服务端认了才算放下了
      await sleep(200);
      const now = bot.blockAt(spot);
      if (now && now.name !== 'air') {
        ctx.diag?.write({
          lane: 'skill', event: 'place-ok', taskId: ctx.taskId,
          msg: `${zhName(now.name)}放在了 (${spot.x}, ${spot.y}, ${spot.z})`,
          data: { block, spot: { x: spot.x, y: spot.y, z: spot.z }, readBack: now.name, tried },
        });
        forgetPlaced(bot, spot);
        return { x: spot.x, y: spot.y, z: spot.z, name: now.name, block: now };
      }
      vanished = true;
      ctx.diag?.write({
        lane: 'skill', event: 'place-vanished', taskId: ctx.taskId,
        msg: `${zhName(block)}放置没报错,回读 (${spot.x}, ${spot.y}, ${spot.z}) 还是空气`,
        data: { block, spot: { x: spot.x, y: spot.y, z: spot.z }, held: invCount(bot, (n) => n === block) },
      });
    }
  } finally {
    bot.setControlState('sneak', false);
  }
  const left = invCount(bot, (n) => n === block || n.endsWith(`_${block}`));
  const stock = `包里还有 ${left} 个`;
  if (vanished) {
    throw new SkillBlocked(`放了${zhName(block)},回读那一格还是空气,服务端没认。${stock}`);
  }
  if (tried > 0) {
    throw new SkillBlocked(`脚边 ${tried} 个位置都放不下${zhName(block)}(${lastError || '放置被拒'})。${stock}`);
  }
  if (pad) {
    const padded = await padAdjacent(bot, ctx, block, station);
    if (padded) return placeBlockNearby(bot, block, ctx, false, station);
  }
  throw new SkillBlocked(placeNoSpotText(bot, block, station));
}

/** 一族工作站:认哪些方块、回执里怎么称呼、一座都没有时往哪指 */
export type Station = { kinds: readonly string[]; label: string; hint: string };

/** 合成要的那一座 */
export const CRAFTING_STATION: Station = {
  kinds: ['crafting_table'], label: '工作台', hint: '先 craft 一个工作台(4 块木板)',
};

/** 烧炼要的那一座;哪种炉子能烧哪样由服务端说了算,这里只是"找个炉子" */
export const FURNACE_STATION: Station = {
  kinds: ['furnace', 'smoker', 'blast_furnace'], label: '炉子', hint: '先 craft 一个熔炉(8 个圆石)',
};

export function findStations(
  bot: Bot,
  range: number,
  kinds: readonly string[],
): Array<{ x: number; y: number; z: number; name: string; d: number }> {
  const ids = kinds
    .map((n) => (bot.registry.blocksByName as Record<string, { id: number } | undefined>)[n]?.id)
    .filter((id): id is number => id !== undefined);
  if (ids.length === 0) return [];
  const me = bot.entity.position;
  const out: Array<{ x: number; y: number; z: number; name: string; d: number }> = [];
  for (const p of bot.findBlocks({ matching: ids, maxDistance: range, count: 16 })) {
    const b = bot.blockAt(p);
    if (!b) continue;
    out.push({ x: p.x, y: p.y, z: p.z, name: b.name, d: p.distanceTo(me) });
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

export type StationAt = {
  x: number; y: number; z: number;
  name: string;
  block: NonNullable<ReturnType<Bot['blockAt']>>;
  /** 用了哪一座、包里还剩几个:这一步在世界里做的事,由调用方原样写进回执 */
  note: string;
  /** 这一座是这一步自备放下的(已入容器账本,placedAt 可查) */
  placed: boolean;
};

/**
 * 优先使用可及的现成工作站，否则就地放自备工作站；没有自备时才走向现成工作站。
 * 回执报告现成位置、距离和库存；自备工作站由 note 单独报告，不计寻路耗材。
 */
export async function ensureStation(
  bot: Bot,
  station: Station,
  ctx: SkillContext,
  // skip 报出「这一座为什么不能用」(比如炉子还烧着别的);null = 能用。
  // 被跳过的事实全部进回执/受阻文案——跳过是事实判断(它干不了这活),不是权衡
  opts?: { skip?: (c: { x: number; y: number; z: number }) => string | null },
): Promise<StationAt> {
  const { kinds, label, hint } = station;
  const stock = (): number => kinds.reduce((n, k) => n + invCount(bot, (x) => x === k), 0);
  const skipped: string[] = [];
  let near: ReturnType<typeof findStations>[number] | null = null;
  for (const s of findStations(bot, 32, kinds)) {
    const why = opts?.skip?.(s) ?? null;
    if (why) { skipped.push(why); continue; }
    near = s;
    break;
  }
  const skipNote = skipped.length > 0 ? `${skipped.join(';')};` : '';
  const nearWhere = near ? `(${near.x}, ${near.y}, ${near.z}),约 ${Math.round(near.d)} 格外` : null;
  const carried = kinds.find((k) => invCount(bot, (n) => n === k) > 0) ?? null;
  const inReach = near !== null && near.d <= PLACE_REACH;
  if (near && (carried === null || inReach)) {
    await gotoGoal(bot, new goals.GoalNear(near.x, near.y, near.z, 2), ctx);
    const block = bot.blockAt(new Vec3(near.x, near.y, near.z));
    if (block && kinds.includes(block.name)) {
      ctx.diag?.write({
        lane: 'craft', event: 'station-reuse', taskId: ctx.taskId,
        msg: `用现成的${zhName(block.name)} (${near.x}, ${near.y}, ${near.z})`,
        data: { at: { x: near.x, y: near.y, z: near.z }, name: block.name, dist: near.d, carried: stock() },
      });
      return {
        x: near.x, y: near.y, z: near.z, name: block.name, block, placed: false,
        note: skipNote + (inReach
          ? `用了手边现成的${zhName(block.name)} ${nearWhere}(包里还有 ${stock()} 个,没动)`
          : `包里没有${label},走过去用了现成的那个 ${nearWhere}`),
      };
    }
  }
  if (!carried) {
    throw new SkillBlocked(skipNote + (near
      ? `走到 (${near.x}, ${near.y}, ${near.z}) 那一格,${label}已经不在了;包里也没有。${hint}`
      : `32 格内没有${skipped.length > 0 ? '别的' : ''}${kinds.map((k) => zhName(k)).join('或')},包里也没有。${hint}`));
  }
  const spot = await placeBlockNearby(bot, carried, ctx, true, station);
  if (spot.name !== carried) {
    throw new SkillBlocked(`要放${zhName(carried)},那一格回读到的是${zhName(spot.name)},没放成`);
  }
  // 自备工作站按 placedAt 登记，供几何试算报告区域内已有设施。
  ctx.chests?.rememberStation(dimensionOf(bot), spot, spot.name, Date.now());
  return {
    x: spot.x, y: spot.y, z: spot.z, name: spot.name, block: spot.block, placed: true,
    note: skipNote + `放下了一个${zhName(spot.name)} (${spot.x}, ${spot.y}, ${spot.z})(包里还有 ${stock()} 个;` +
      `${nearWhere ? `附近现成的那个在 ${nearWhere},这趟没去` : `32 格内没有现成的${label}`})`,
  };
}

