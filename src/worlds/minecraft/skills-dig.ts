/**
 * 挖开与挖穿:excavate 按形状挖,tunnel 挖一条能走的通道、竖井、塔或螺旋楼梯。
 *
 * 通道以走得通为终态判据,不以挖够格数为准。
 */
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { type SkillCall } from './skills.ts';
import { Aborted, SkillBlocked, checkAbort, type SkillContext } from './skill-context.ts';
import {
  AIR_NAMES, EXCAVATE_CELL_CAP, LIQUIDS, SHAPE_ZH, blockAtCell, cellKeyOf, cellText, dimensionOf,
  feetOf, nearLavaAt, readRegion, resolveAt, shapeCells, type RegionReading,
} from './cell-facts.ts';
import { compositionText, noDropMaterials } from './receipt.ts';
import {
  Upkeep, hitboxBlocks, permittedStockFor, placeReferenceFace, scaffoldNames, stationNotes,
  sweepDrops,
} from './placement.ts';
import { worksNote } from './works.ts';
import { zhName } from './names.ts';
import { invCount, invSnapshot, lootNote } from './inventory.ts';
import { rasterize, type Cell } from './geometry.ts';
import { digBlock, gotoGoal, settleOnGround } from './travel.ts';
import { LEDGER_GUARD_BLOCKS, ledgerBlockFact } from './placed-ledger.ts';
import { CONTAINER_FIND, FURNACE_KINDS } from './chests.ts';
import { chooseTool, equipToolFor, miningToolPlan, nearBreak } from './tools.ts';
import { UNTIL_DIG_RADIUS, type UntilHit, untilBlockIds, untilHit, untilUnknownNote } from './until.ts';

const { goals } = pathfinderPkg;

/** 按形状清空间:自上而下、近的先;液体不按方块挖。 */
export async function skillExcavate(bot: Bot, call: Extract<SkillCall, { skill: 'excavate' }>, ctx: SkillContext): Promise<string> {
  const cells = shapeCells(bot, call.shape, call.anchors, call.fill, EXCAVATE_CELL_CAP);
  if (call.dryRun) {
    const reading = readRegion(bot, cells);
    const lines = [`试算${SHAPE_ZH[call.shape]}(共 ${cells.length} 格): ${compositionText(reading)}。`];
    const noDrop = noDropMaterials(bot, reading);
    if (noDrop.length > 0) lines.push(`现在的家伙挖 ${noDrop.join('、')} 不掉东西,挖碎就没了。`);
    lines.push(...miningToolPlanNotes(bot, reading, ctx, call.tool));
    lines.push(...stationNotes(bot, ctx, cells));
    const hit = worksNote(
      ctx.works?.inCells(dimensionOf(bot), cells) ?? [],
      (ms) => ctx.clock?.(ms) ?? new Date(ms).toISOString().slice(11, 19),
    );
    if (hit) lines.push(`${hit}。`);
    if (reading.unloaded > 0) lines.push(`${reading.unloaded} 格区块没加载。`);
    return lines.join('') + '没动工';
  }
  const me = bot.entity.position;
  const targets = cells
    .filter((c) => {
      const block = blockAtCell(bot, c);
      return block !== null && !AIR_NAMES.has(block.name) && !LIQUIDS.has(block.name);
    })
    .sort((a, b) => b.y - a.y
      || (Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z)));
  if (targets.length === 0) {
    // 液体不是挖掘目标；整片只有液体时必须明确受阻，不能报已经清空。
    const reading = readRegion(bot, cells);
    if (reading.counts.size === 0 && reading.unloaded === 0) {
      return `那片 ${cells.length} 格本来就是空的,不用挖`;
    }
    const bits = [compositionText(reading)];
    if (reading.unloaded > 0) bits.push(`${reading.unloaded} 格区块没加载`);
    throw new SkillBlocked(
      `一块都没挖:那片 ${cells.length} 格里没有挖得动的方块,但也不是空的(${bits.join(';')})`,
      [...reading.counts].slice(0, 3).map(([n, e]) => `${zhName(n)}×${e.n},最近的在 ${cellText(e.nearest)}`),
    );
  }
  // 不接受沿自身站立列连续下挖；单格支撑仍须满足下方实心判据。
  // 原地下降使用逐格等待落稳的 tunnel 竖井。
  const feetAtStart = feetOf(bot);
  const ownColumn = targets.filter((c) => c.x === feetAtStart.x && c.z === feetAtStart.z && c.y < feetAtStart.y);
  if (ownColumn.length >= 2 && ownColumn.some((c) => c.y === feetAtStart.y - 1)) {
    const bottom = Math.min(...ownColumn.map((c) => c.y));
    throw new SkillBlocked(
      `这列在你脚下(人在 ${cellText(feetAtStart)},要挖的 ${ownColumn.length} 格从脚下一直到 y${bottom}),先站到旁边再挖;要就地往下挖用 tunnel 竖井`,
    );
  }

  const keep = new Upkeep(bot, ctx);
  const invBefore = invSnapshot(bot);
  // 跳过账本中仍有物料的容器或工作站，并在回执说明；空账本不构成保护条件。
  const ledgered = new Set(
    (ctx.chests?.inCells(dimensionOf(bot), targets) ?? [])
      .filter((r) => r.items.length > 0)
      .map((r) => `${r.x},${r.y},${r.z}`),
  );
  // 成果登记只补充回执，不改变显式指定格的挖掘去留。
  const worksHit = ctx.works?.inCells(dimensionOf(bot), targets) ?? [];
  let guarded = 0;
  let guardedSample = '';
  /** 护住的里面有没有 take 掏不了的工作站(工作台):出路跟箱/炉不是同一条 */
  let guardedStation = false;
  let guardedAt: Cell | null = null;
  let dug = 0;
  let noDrop = 0;
  let noDropSample = '';
  let undiggable = 0;
  let undiggableSample = '';
  let nearLava = 0;
  let underfoot = 0;
  let underfootBelow = '';
  let unreachable: Cell | null = null;
  let unreachableN = 0;
  // 这一片里的格子火把一律不贴:还没挖的贴上去回头连火把一起挖掉,已经挖空的那些
  // 本来就该空着,贴进去等于自己给自己造障碍
  const inRegion = new Set(targets.map(cellKeyOf));
  for (const c of targets) {
    checkAbort(ctx);
    await settleOnGround(bot, ctx, 1_500);
    let b = blockAtCell(bot, c);
    if (!b || AIR_NAMES.has(b.name) || LIQUIDS.has(b.name)) continue; // 挖别处时已经塌了/通了
    if (ledgered.has(`${c.x},${c.y},${c.z}`) && LEDGER_GUARD_BLOCKS.has(b.name)) {
      guarded++;
      guardedSample = `(${c.x}, ${c.y}, ${c.z}) 的${zhName(b.name)}`;
      guardedAt = c;
      if (!FURNACE_KINDS.has(b.name) && !CONTAINER_FIND.includes(b.name)) guardedStation = true;
      continue;
    }
    if (b.diggable === false) { undiggable++; undiggableSample = b.name; continue; }
    // 邻接危险闸只检查岩浆，不因相邻水格阻断。
    if (nearLavaAt(bot, c)) {
      nearLava++;
      continue;
    }
    // 挖自身脚下支撑格前，必须确认再下一格实心；与 tunnel 竖井共用落脚规则。
    const feetNow = feetOf(bot);
    if (c.x === feetNow.x && c.y === feetNow.y - 1 && c.z === feetNow.z) {
      const below = blockAtCell(bot, { x: c.x, y: c.y - 1, z: c.z });
      if (!below || below.boundingBox !== 'block') {
        underfoot++;
        underfootBelow = below ? zhName(below.name) : '没加载的区块';
        continue;
      }
    }
    if (!bot.canDigBlock(b)) {
      try {
        await gotoGoal(bot, new goals.GoalNear(c.x, c.y, c.z, 2), ctx);
      } catch (err) {
        if (err instanceof Aborted) throw err;
        unreachable = unreachable ?? c;
        unreachableN++;
        continue;
      }
      b = blockAtCell(bot, c);
      if (!b || AIR_NAMES.has(b.name) || LIQUIDS.has(b.name)) continue;
      if (!bot.canDigBlock(b)) { unreachable = unreachable ?? c; unreachableN++; continue; }
    }
    await equipToolFor(bot, b, ctx, miningToolPlan(call.tool));
    if (typeof b.canHarvest === 'function' && !b.canHarvest(bot.heldItem?.type ?? null)) {
      noDrop++;
      noDropSample = b.name;
    }
    await digBlock(bot, b, ctx);
    // 挖掉了就从登记上划掉:留着它下一趟会拿一格空气冒充她的成果
    ctx.works?.forget(dimensionOf(bot), c.x, c.y, c.z);
    dug++;
    ctx.progress?.(dug, targets.length);
    await keep.light((cc) => inRegion.has(cellKeyOf(cc)));
  }
  // 收尾走一趟掉落物:挖是站在坑外挖的,东西落进坑里没人捡。不扫的话 5×5×5 那种体量
  // 只有七成进包 —— 挖掉了不等于到手,而回执报的是到手那个数。
  if (dug > 0) await sweepDrops(bot, ctx);
  const notes: string[] = [];
  if (dug > 0) notes.push(lootNote(invBefore, bot));
  if (noDrop > 0) notes.push(`其中 ${noDrop} 块(如${zhName(noDropSample)})手上的工具挖了不掉东西,挖碎了就没了`);
  if (guarded > 0) {
    // 工作台不适用 take；拆除须先接近到可见位置，再 collect 指名方块。
    const how = guardedStation && guardedAt
      ? `要拆的话先 goto 到它跟前(挨着 ${cellText(guardedAt)} 那一格)再 collect 指名方块`
      : '要拆的话先 take 掏空再 collect';
    notes.push(`${guarded} 格是账本里的容器/工作站(${guardedSample}),没动它;${how}`);
  }
  const worksLine = worksNote(worksHit, (ms) => ctx.clock?.(ms) ?? new Date(ms).toISOString().slice(11, 19));
  if (worksLine) notes.push(worksLine);
  if (nearLava > 0) notes.push(`${nearLava} 块紧贴着岩浆,没动`);
  if (underfoot > 0) notes.push(`${underfoot} 格是我此刻站着的支撑(它下面是${underfootBelow}),没动`);
  if (undiggable > 0) notes.push(`${undiggable} 块是${zhName(undiggableSample)},根本挖不动`);
  if (unreachableN > 0 && unreachable) notes.push(`${unreachableN} 块够不着(最近的在 (${unreachable.x}, ${unreachable.y}, ${unreachable.z}))`);
  notes.push(...keep.tally());
  const tail = `${notes.length > 0 ? `${notes.join(';')}。` : ''}挖完人在 ${cellText(feetOf(bot))}`;
  if (dug === 0) throw new SkillBlocked(`一块都没挖成:${notes.join(';') || '全都够不着'}`);
  return `挖开了 ${dug}/${targets.length} 块。${tail}`;
}

/**
 * tunnel 施工 1 格宽、2 格高的可通行通道；斜向坡度不得超过 45°。
 * 水平位移为零时，向下为竖井、向上为垫脚塔；三种形态均以通行为终态判据。
 */
/**
 * 螺旋楼梯第 i 步(1 起)的落脚格:绕「脚下这格 + 它的 +x/+z 邻格」组成的 2×2
 * 井筒转,每步升降 1。四步一圈,同一根角柱两次落脚差 4 格 —— 每步挖落脚、头顶、
 * 再上一格共 3 格,圈与圈之间正好剩一格实心当上一圈的地板,上下都走得通
 * (下行是普通台阶,上行是 1 格跳,跳跃余量就是那第 3 格)。
 */
/** 2×2 井筒的四种摆法:脚下这一格当井筒的哪个角(井筒最小角相对脚下的偏移) */
export type SpiralCorner = readonly [number, number];
export const SPIRAL_CORNERS: readonly SpiralCorner[] = [[0, 0], [-1, 0], [0, -1], [-1, -1]];

/** 井筒的四根角柱,按绕行顺序排,脚下这一格排在第 0 位 */
export function spiralQuad(start: Cell, corner: SpiralCorner): Array<{ x: number; z: number }> {
  const [bx, bz] = [start.x + corner[0], start.z + corner[1]];
  const ring = [{ x: bx, z: bz }, { x: bx + 1, z: bz }, { x: bx + 1, z: bz + 1 }, { x: bx, z: bz + 1 }];
  const at = ring.findIndex((c) => c.x === start.x && c.z === start.z);
  return [...ring.slice(at), ...ring.slice(0, at)];
}

export function spiralFoot(start: Cell, i: number, up: boolean, corner: SpiralCorner): Cell {
  const col = spiralQuad(start, corner)[i % 4];
  return { x: col.x, y: start.y + (up ? i : -i), z: col.z };
}

/** 螺旋楼梯全程要挖的格子(每步 3 格),供试算与「接下来要挖的格子」名单用 */
export function spiralCells(start: Cell, steps: number, up: boolean, corner: SpiralCorner): Cell[] {
  const out: Cell[] = [];
  for (let i = 1; i <= steps; i++) {
    const f = spiralFoot(start, i, up, corner);
    out.push(f, { x: f.x, y: f.y + 1, z: f.z }, { x: f.x, y: f.y + 2, z: f.z });
  }
  return out;
}

/** 第一圈按已有实心、可垫脚、液体或身体占位排序选择井筒方向；同分取 +x/+z。 */
export function pickSpiralCorner(bot: Bot, start: Cell, up: boolean, steps: number): SpiralCorner {
  const turn = Math.min(4, steps);
  const score = (corner: SpiralCorner): number => {
    let s = 0;
    for (let i = 1; i <= turn; i++) {
      const f = spiralFoot(start, i, up, corner);
      for (const c of [f, { x: f.x, y: f.y + 1, z: f.z }, { x: f.x, y: f.y + 2, z: f.z }]) {
        const b = blockAtCell(bot, c);
        if (!b) s -= 2;
        else if (LIQUIDS.has(b.name)) s -= 4;
      }
      const under = { x: f.x, y: f.y - 1, z: f.z };
      const below = blockAtCell(bot, under);
      if (!below) s -= 2;
      else if (LIQUIDS.has(below.name)) s -= 4;
      else if (below.boundingBox === 'block') s += 2;
      else if (placeReferenceFace(bot, under) !== null) s += 1;
      if (i === 1 && hitboxBlocks(bot, under)) s -= 1;
    }
    return s;
  };
  let best = SPIRAL_CORNERS[0];
  let bestScore = score(best);
  for (const corner of SPIRAL_CORNERS.slice(1)) {
    const s = score(corner);
    if (s > bestScore) { best = corner; bestScore = s; }
  }
  return best;
}

/** dryRun 的工具预案；只读背包与方块数据，不换手。 */
export function miningToolPlanNotes(
  bot: Bot,
  reading: RegionReading,
  ctx: SkillContext,
  requested: string | undefined,
): string[] {
  const plan = miningToolPlan(requested);
  if (plan.mode === 'exact'
    && !bot.inventory.items().some((item) => item.name === plan.item && item.count > 0)) {
    return [`工具预案:包里没有本步指定的${zhName(plan.item)},不会改用别的工具。`];
  }
  const notes = new Set<string>();
  for (const [name, entry] of reading.counts) {
    if (LIQUIDS.has(name)) continue;
    const decision = chooseTool(bot, entry.sample, ctx, plan);
    if (decision.error) {
      notes.add(`工具预案:${decision.error}。`);
      continue;
    }
    if (!decision.pick) {
      notes.add(decision.need
        ? `工具预案:包里没有能保住${zhName(name)}掉落的${zhName(decision.need)}。`
        : `工具预案:${zhName(name)}无需工具,会换下手上的耐久工具。`);
      continue;
    }
    const mode = plan.mode === 'economy' ? '节约模式'
      : plan.mode === 'fastest' ? '本步 fastest'
        : '本步精确指定';
    const durability = nearBreak(decision.pick);
    const drop = decision.canDrop
      ? ''
      : `,挖碎不掉东西${decision.need ? `(要${zhName(decision.need)}及以上)` : ''}`;
    const worn = durability ? `,只剩 ${durability.left}/${durability.max} 耐久` : '';
    const reserve = decision.reserve?.reason === 'override' ? ',会覆盖 reserve'
      : decision.reserve ? ',只有动用 reserve 里的它才能保住掉落' : '';
    notes.add(`工具预案:${mode}用${zhName(decision.pick.name)}挖${zhName(name)}${drop}${worn}${reserve}。`);
    if (notes.size >= 6) break;
  }
  return [...notes];
}

/**
 * tunnel 不挖传送面或门框，维度通道由 transit 处理。
 * 普通黑曜石不属于维度通道边界，单独按材料限制报告。
 */
export const TRANSIT_BOUNDARY_BLOCKS = new Set([
  'nether_portal', 'end_portal', 'end_gateway', 'end_portal_frame',
]);

/** 挖不动(或慢到不值当)就停下的硬块。只陈述挖不动这件事,不冒充维度语义。 */
export const TUNNEL_HARD_BLOCKS = new Set(['obsidian', 'crying_obsidian']);

/** tunnel 撞上这一格该说的那句话;不该停就是 null */
export function tunnelStopWord(name: string, cc: Cell): string | null {
  if (TRANSIT_BOUNDARY_BLOCKS.has(name)) {
    return `挖到 (${cc.x}, ${cc.y}, ${cc.z}) 的${zhName(name)}跟前,这是维度通道边界,停在这。`;
  }
  if (TUNNEL_HARD_BLOCKS.has(name)) {
    return `挖到 (${cc.x}, ${cc.y}, ${cc.z}) 的${zhName(name)}跟前,当前这把家伙挖不动它,停在这。`;
  }
  return null;
}

export async function skillTunnel(bot: Bot, call: Extract<SkillCall, { skill: 'tunnel' }>, ctx: SkillContext): Promise<string> {
  const start = feetOf(bot);
  const target = resolveAt(bot, call.at);
  const run = Math.max(Math.abs(target.x - start.x), Math.abs(target.z - start.z));
  const rise = target.y - start.y;
  const vertical = run === 0;
  const spiral = call.spiral === true && vertical;
  const kind = spiral ? '螺旋楼梯' : !vertical ? '通道' : rise > 0 ? '塔' : '竖井';
  if (vertical && rise === 0) throw new SkillBlocked('终点就是脚下这一格');
  if (call.spiral === true && !vertical) {
    throw new SkillBlocked(
      `spiral 是垂直升降用的螺旋楼梯,at 要放正上/正下(现在横向差着 ${run} 格);斜着走用不带 spiral 的通道`,
    );
  }
  if (!vertical && Math.abs(rise) > run) {
    throw new SkillBlocked(
      `坡度超过 45°:横 ${run} 格要升降 ${Math.abs(rise)} 格。` +
      '基本垂直的升降可以把 at 放正上/正下,加 "spiral":true 挖成上下都能走的螺旋楼梯',
    );
  }
  const floorRaw = rasterize('line', [start, target], 'solid');
  if (!Array.isArray(floorRaw)) throw new SkillBlocked(floorRaw.error);
  const floor = floorRaw;
  const planned = floor.length - 1;
  const corner: SpiralCorner = spiral
    ? pickSpiralCorner(bot, start, rise > 0, planned)
    : SPIRAL_CORNERS[0];
  if (call.dryRun) {
    if (spiral) {
      const carve = spiralCells(start, planned, rise > 0, corner);
      const reading = readRegion(bot, carve);
      const shaft = spiralQuad(start, corner);
      const xs = shaft.map((c) => c.x);
      const zs = shaft.map((c) => c.z);
      const lines = [`试算螺旋楼梯(${rise > 0 ? '升' : '降'} ${planned} 格,` +
        `绕 (${Math.min(...xs)}..${Math.max(...xs)}, ${Math.min(...zs)}..${Math.max(...zs)}) 的 2×2 井筒转,` +
        `要挖 ${carve.length} 格)` +
        `: ${compositionText(reading)}。`];
      const noDrop = noDropMaterials(bot, reading);
      if (noDrop.length > 0) lines.push(`现在的家伙挖 ${noDrop.join('、')} 不掉东西。`);
      lines.push(...miningToolPlanNotes(bot, reading, ctx, call.tool));
      lines.push(...stationNotes(bot, ctx, carve));
      return lines.join('') + '没动工';
    }
    // 塔要挖的是每一格的头顶(脚下那条是垫出来的),竖井挖脚下那条,斜通道两条都挖
    const carve = vertical
      ? floor.slice(1).map((c) => ({ x: c.x, y: rise > 0 ? c.y + 1 : c.y, z: c.z }))
      : floor.flatMap((c) => [c, { x: c.x, y: c.y + 1, z: c.z }]);
    const reading = readRegion(bot, carve);
    const head = vertical
      ? `试算${kind}(${planned} 格,要挖 ${carve.length} 格)`
      : `试算通道(${planned} 步,连头顶共 ${carve.length} 格)`;
    const lines = [`${head}: ${compositionText(reading)}。`];
    if (rise > 0 && vertical) {
      const stock = permittedStockFor(bot, scaffoldNames(ctx), '垫脚', ctx, true);
      if ('why' in stock) {
        lines.push(`要垫 ${planned} 格,${stock.why}。`);
      } else {
        stock.permit.finish(false);
        lines.push(`要垫 ${planned} 格,包里有 ${invCount(bot, (n) => n === stock.item.name)} 个${zhName(stock.item.name)}。`);
      }
    }
    const noDrop = noDropMaterials(bot, reading);
    if (noDrop.length > 0) lines.push(`现在的家伙挖 ${noDrop.join('、')} 不掉东西。`);
    lines.push(...miningToolPlanNotes(bot, reading, ctx, call.tool));
    lines.push(...stationNotes(bot, ctx, carve));
    return lines.join('') + '没动工';
  }

  const keep = new Upkeep(bot, ctx);
  const invBefore = invSnapshot(bot);
  let steps = 0;
  let noDrop = 0;
  let noDropSample = '';
  const digCell = async (c: Cell): Promise<void> => {
    const b = blockAtCell(bot, c);
    if (!b || b.boundingBox !== 'block') return;
    // 挖开前检查六个正邻格的岩浆，覆盖侧面和后方。
    if (nearLavaAt(bot, c)) stop(`(${c.x}, ${c.y}, ${c.z}) 紧贴着岩浆,不敢挖,停在这。`);
    await equipToolFor(bot, b, ctx, miningToolPlan(call.tool));
    if (typeof b.canHarvest === 'function' && !b.canHarvest(bot.heldItem?.type ?? null)) {
      noDrop++;
      noDropSample = b.name;
    }
    await digBlock(bot, b, ctx);
  };
  /** 挖到哪一格、维持条件补了什么、掉了什么:挖通与没挖通两边共用的现场事实 */
  const facts = (): string[] => {
    // 塔的每一格是垫出来的,不是挖出来的;单位也跟着换,免得读成"挖了几步"
    // (螺旋楼梯往上也是挖出来的,只有塌空那几格才垫)
    const did = !spiral && vertical && rise > 0 ? '垫了' : '挖了';
    const notes = [`${kind}${did} ${steps}/${planned} ${vertical ? '格' : '步'},人在 ${cellText(feetOf(bot))}`];
    if (steps > 0) notes.push(lootNote(invBefore, bot));
    if (noDrop > 0) notes.push(`其中 ${noDrop} 块(如${zhName(noDropSample)})挖了不掉东西`);
    notes.push(...keep.tally());
    return notes;
  };
  /** 走到终点那一格叫什么:三种形状各一个说法,成句与受阻句共用 */
  const arrive = !vertical ? '挖通' : rise > 0 ? '到顶' : '到底';
  const through = (): string => `${facts().join(';')}。${arrive}了`;
  /**
   * 早停名单:每挖完一格看一眼周身。命中是**正常收束**不是受阻 —— 她要的就是
   * 「往下挖到碰见铁矿为止」,碰见了这一单就做完了(终点判据随之作废,见 deriveExpect)。
   */
  const stop2 = call.until && call.until.length > 0 ? untilBlockIds(bot, call.until) : null;
  const stopNote = stop2 ? untilUnknownNote(stop2.unknown) : '';
  const earlyText = (h: UntilHit): string =>
    `${facts().join(';')}。在 (${h.x}, ${h.y}, ${h.z}) 碰到了${h.what},停在这` +
    `(没${arrive},until 说到这儿为止)${stopNote}`;
  const early = (): UntilHit | null =>
    (stop2 ? untilHit(bot, stop2.ids, UNTIL_DIG_RADIUS, false) : null);
  /** 未到终点即受阻，分别报告实际挖掘位置、垫脚量和停止原因。 */
  const stop = (why: string): never => {
    throw new SkillBlocked(`${kind}没${arrive}:${why}`, facts());
  };
  /**
   * 前方无支撑时，先尝试在有正交实心参照的缺口垫脚。
   * 无法垫脚则先平移一步，再从新落点重铺剩余路线；不得反转此顺序。
   */
  const footing = async (next: Cell, cur: Cell): Promise<Cell | null> => {
    const under = { x: next.x, y: next.y - 1, z: next.z };
    if (await keep.footing(under)) return next;
    if (next.y >= cur.y) return null;
    const level = { x: next.x, y: cur.y, z: next.z };
    const below = blockAtCell(bot, { x: level.x, y: level.y - 1, z: level.z });
    if (below?.boundingBox === 'block') return level;
    if (await keep.footing({ x: level.x, y: level.y - 1, z: level.z })) return level;
    return null;
  };

  /**
   * 螺旋楼梯:一步一格绕井筒转,判据仍是走到终点那一格(y 到位即到,水平位置
   * 在井筒的四根角柱里)。每步先验落脚——底下塌空就垫,垫不上路就断在这一格;
   * 往上一样是挖(地板通常就是原生石头),只有塌空那几格才动垫脚料。
   */
  if (spiral) {
    const up = rise > 0;
    const all = spiralCells(start, planned, up, corner);
    while (steps < planned) {
      checkAbort(ctx);
      const i = steps + 1;
      const next = spiralFoot(start, i, up, corner);
      const carve: Cell[] = [next, { x: next.x, y: next.y + 1, z: next.z }, { x: next.x, y: next.y + 2, z: next.z }];
      for (const cc of carve) {
        const b = blockAtCell(bot, cc);
        if (!b) return stop(`(${cc.x}, ${cc.y}, ${cc.z}) 的区块还没加载出来。`);
        if (LIQUIDS.has(b.name)) return stop(`挖到 (${cc.x}, ${cc.y}, ${cc.z}) 碰上${zhName(b.name)},停在这。`);
        const boundary = tunnelStopWord(b.name, cc);
        if (boundary) return stop(boundary);
        const guard = ledgerBlockFact(bot, ctx, cc);
        if (guard) return stop(`挖到${guard}跟前,里头的东西不能跟着挖没,停在这。`);
      }
      const under = { x: next.x, y: next.y - 1, z: next.z };
      const below = blockAtCell(bot, under);
      if (!below) return stop(`落脚 (${under.x}, ${under.y}, ${under.z}) 的区块还没加载出来。`);
      if (LIQUIDS.has(below.name)) return stop(`下一级台阶底下就是${zhName(below.name)},停在这。`);
      if (below.boundingBox !== 'block' && !(await keep.footing(under))) {
        // 螺旋垫的是井筒里侧邻格,要一个贴得住的参照面;塔垫的是自己脚下那一格
        // (跳起来放,参照是脚底那一块),悬空里上行只有塔走得通
        return stop(
          `下一级台阶 (${next.x}, ${next.y}, ${next.z}) 底下塌空,垫也没垫上(${keep.why('footing')}),`
          + '楼梯断在这一格。同一段路走塔(at 放正上方、不带 spiral)垫的是自己脚下那一格,不吃邻格的参照面',
        );
      }
      for (const cc of carve) await digCell(cc);
      try {
        await gotoGoal(bot, new goals.GoalBlock(next.x, next.y, next.z), ctx);
      } catch (err) {
        if (err instanceof Aborted) throw err;
        return stop(`挖开了却${up ? '跳不上去' : '下不去'}(${(err as Error).message})。`);
      }
      steps++;
      ctx.progress?.(steps, planned);
      const h = early();
      if (h) return earlyText(h);
      // 火把不贴在接下来要挖的格子上(与斜通道同一条教训)
      const ahead = new Set(all.slice(steps * 3).map(cellKeyOf));
      await keep.light((c) => ahead.has(cellKeyOf(c)));
    }
    const feet = feetOf(bot);
    if (feet.y !== target.y) return stop(`该到 y=${target.y},人在 ${cellText(feet)}。`);
    return through();
  }

  /**
   * 竖井与塔:一格一格,判据仍是走到终点那一格。
   *
   * 往下先看要挖的那一格底下还有没有底 —— 没有就是挖穿进了空腔,再挖就是往下掉,
   * 停在这里报事实(竖井是单程的,回来靠往上的塔;要能走回头路,发单时用 spiral)。
   * 往上没有路可走,每一格由 `climb` 垫出来,垫不上就是没到顶。
   */
  if (vertical) {
    const up = rise > 0;
    // 每一格按当下脚底重算,不照发车时那张表:塔是靠垫脚往上挪的,人挪没挪到位当场就得知道
    while (steps < planned) {
      checkAbort(ctx);
      const here = feetOf(bot);
      const next = { x: target.x, y: here.y + (up ? 1 : -1), z: target.z };
      const carve: Cell[] = [next, { x: next.x, y: next.y + 1, z: next.z }];
      for (const cc of carve) {
        const b = blockAtCell(bot, cc);
        if (!b) return stop(`(${cc.x}, ${cc.y}, ${cc.z}) 的区块还没加载出来。`);
        if (LIQUIDS.has(b.name)) return stop(`挖到 (${cc.x}, ${cc.y}, ${cc.z}) 碰上${zhName(b.name)},停在这。`);
        const boundary = tunnelStopWord(b.name, cc);
        if (boundary) return stop(boundary);
        const guard = ledgerBlockFact(bot, ctx, cc);
        if (guard) return stop(`挖到${guard}跟前,里头的东西不能跟着挖没,停在这。`);
      }
      if (!up) {
        const under = { x: next.x, y: next.y - 1, z: next.z };
        const below = blockAtCell(bot, under);
        if (!below) return stop(`再往下 (${under.x}, ${under.y}, ${under.z}) 的区块还没加载出来。`);
        if (LIQUIDS.has(below.name)) return stop(`再往下就是${zhName(below.name)},停在这。`);
        if (below.boundingBox !== 'block' && !(await keep.footing(under))) {
          return stop(`挖开 (${next.x}, ${next.y}, ${next.z}) 下面就是空的,垫也没垫上(${keep.why('footing')}),再挖就是往下掉。`);
        }
      }
      for (const cc of carve) await digCell(cc);
      if (up) {
        // 上升前检查新脚格和头格的正邻岩浆；原为空气时 digCell 不会检查它们。
        for (const cc of carve) {
          if (nearLavaAt(bot, cc)) return stop(`(${cc.x}, ${cc.y}, ${cc.z}) 紧贴着岩浆,不敢上去,停在这。`);
        }
        if (!(await keep.climb())) return stop(`${keep.why('climb')},上不去了。`);
        await settleOnGround(bot, ctx, 1_500);
        const feet = feetOf(bot);
        if (feet.x !== next.x || feet.y !== next.y || feet.z !== next.z) {
          return stop(`垫上了却没站上去:该在 ${cellText(next)},人在 ${cellText(feet)}。`);
        }
      } else {
        try {
          await gotoGoal(bot, new goals.GoalBlock(next.x, next.y, next.z), ctx);
        } catch (err) {
          if (err instanceof Aborted) throw err;
          return stop(`挖开了却下不去(${(err as Error).message})。`);
        }
      }
      steps++;
      ctx.progress?.(steps, planned);
      const h = early();
      if (h) return earlyText(h);
      // 塔不插:下一格垫的正是现在脚底这一格,插在这儿就是自己占住自己的垫脚格
      if (!up) await keep.light();
    }
    const feet = feetOf(bot);
    if (feet.y !== target.y) return stop(`该到 ${cellText(target)},人在 ${cellText(feet)}。`);
    return through();
  }

  let cur = start;
  let plan = floor;
  let i = 1;
  while (i < plan.length) {
    checkAbort(ctx);
    let next = plan[i];
    const support = blockAtCell(bot, { x: next.x, y: next.y - 1, z: next.z });
    if (!support) return stop('前面的区块还没加载出来。');
    if (LIQUIDS.has(support.name)) return stop(`再往前脚下就是${zhName(support.name)},停在这。`);
    let replanned = false;
    if (support.boundingBox !== 'block') {
      const fixed = await footing(next, cur);
      if (!fixed) return stop(`前面 (${next.x}, ${next.y}, ${next.z}) 脚下悬空,垫脚也没垫上(${keep.why('footing')}),路断在这一格。`);
      replanned = fixed.y !== next.y;
      next = fixed;
    }
    const carve: Cell[] = [next, { x: next.x, y: next.y + 1, z: next.z }];
    if (next.y > cur.y) carve.push({ x: cur.x, y: cur.y + 2, z: cur.z }); // 上台阶要跳,头顶留一格
    for (const cc of carve) {
      const b = blockAtCell(bot, cc);
      if (b && LIQUIDS.has(b.name)) return stop(`挖到 (${cc.x}, ${cc.y}, ${cc.z}) 碰上${zhName(b.name)},停在这。`);
      const boundary = b ? tunnelStopWord(b.name, cc) : null;
      if (boundary) return stop(boundary);
      const guard = ledgerBlockFact(bot, ctx, cc);
      if (guard) return stop(`挖到${guard}跟前,里头的东西不能跟着挖没,停在这。`);
    }
    for (const cc of carve) await digCell(cc);
    try {
      await gotoGoal(bot, new goals.GoalBlock(next.x, next.y, next.z), ctx);
    } catch (err) {
      if (err instanceof Aborted) throw err;
      return stop(`挖开了却走不过去(${(err as Error).message})。`);
    }
    cur = next;
    steps++;
    ctx.progress?.(steps, planned);
    const h = early();
    if (h) return earlyText(h);
    if (replanned) {
      const rest = rasterize('line', [cur, target], 'solid');
      if (!Array.isArray(rest) || rest.length < 2) {
        if (cur.x === target.x && cur.y === target.y && cur.z === target.z) return through();
        // 走平避开的那一格塌方也带走了高度:横向到了终点头上/脚下,通道并没有到终点
        const dy = target.y - cur.y;
        return stop(`走平之后横向到了终点${dy < 0 ? '上方' : '下方'} ${Math.abs(dy)} 格,${cellText(target)} 还是没通。`);
      }
      plan = rest;
      i = 1;
    } else i++;
    // 路线重铺后再收集后续脚格和头格，避免将它们用作火把支撑。
    const ahead = new Set(plan.slice(i)
      .flatMap((c) => [cellKeyOf(c), cellKeyOf({ x: c.x, y: c.y + 1, z: c.z })]));
    await keep.light((c) => ahead.has(cellKeyOf(c)));
  }
  return through();
}

