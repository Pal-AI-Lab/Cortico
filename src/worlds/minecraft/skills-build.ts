/**
 * 搭起来:build 按她点的格子或形状放,蓝图形态按编译好的步序施工并回读对账。
 *
 * 落脚、贴面与补光在 placement.ts;这里管的是放什么、放成什么形状、放到第几步。
 */
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import {
  Aborted, SkillBlocked, checkAbort, sleep, type BlueprintSite, type BlueprintSurvey,
  type SkillContext,
} from './skill-context.ts';
import {
  AIR_NAMES, EXCAVATE_CELL_CAP, FACE_ZH, LIQUIDS, NEIGHBORS6, NO_PLACE_REFERENCE, PLACE_REACH,
  SHAPE_ZH, blockAtCell, cellKeyOf, cellText, dimensionOf, faceText, feetOf, nearLavaAt, refAt,
  refCellOf, resolveAt, skyBlocked, solidAt,
} from './cell-facts.ts';
import {
  Upkeep, buildSpots, ensureHolding, footprintOf, footprintScene, gotoPlaceable, hitboxBlocks,
  inBox, jumpPlaceBelow, matchPlacedMaterialName, materialCollides, occupantOf, occupantText,
  occupiedByMe, permitPlacement, placeIntoCell, siteAtCellAnywhere, siteBox, stationNotes,
  stepOffCell, sweepDrops, type BuildSpot,
} from './placement.ts';
import { digBlock, gotoGoal, readStamp, settleOnGround } from './travel.ts';
import { zhName } from './names.ts';
import { equipToolFor } from './tools.ts';
import { bodyInWater, headInWater } from './terrain.ts';
import { type BlueprintCall, type PlaceCall } from './receipt.ts';
import { isBoat, skillUse } from './skills-interact.ts';
import { invCount, invSnapshot } from './inventory.ts';
import { matchMaterialName } from './chests.ts';
import { type BlockFace, type Cell } from './geometry.ts';
import {
  billForSteps, blueprintProgress, blueprintStepStateMatches, diffBlueprint,
  renderBlueprintAdvisories, stepCountThroughLayer, stepToBuildCall, summarizeReadback, toWorld,
  type BlueprintCheckCell, type BlueprintConflict, type BlueprintDiff, type BlueprintStep,
  type ItemTally, type ReadbackEntry,
} from './blueprint-plan.ts';
import {
  blockIdOf, normalizeBlockName, renderLayerMap, type NormalizedBlueprint, type PositionXYZ,
} from './blueprint.ts';
import { skillExcavate } from './skills-dig.ts';
import { placedLedgerOf } from './placed-ledger.ts';

const { goals } = pathfinderPkg;

/** 陆上 surface 一次爬升的时限;到点如实报爬到哪 */
export const SURFACE_CLIMB_MS = 90_000;

/**
 * 陆上 surface:头顶有实心遮盖就挖开头顶两格再垫脚上一格,循环到露天。
 * 头顶压着液体不捅穿;挖不动(基岩)、没垫脚方块、限时到,都带着已爬格数受阻。
 */
export async function skillSurfaceLand(bot: Bot, ctx: SkillContext): Promise<string> {
  if (!skyBlocked(bot, feetOf(bot).x, feetOf(bot).y + 2, feetOf(bot).z)) {
    return `我已经在露天了;${surfaceStateText(bot)}`;
  }
  ctx.escape.active = true;
  const keep = new Upkeep(bot, ctx);
  const deadline = Date.now() + SURFACE_CLIMB_MS;
  let climbed = 0;
  let paddedInSite = 0;
  const where = (): string => `,我在 ${cellText(feetOf(bot))}`;
  for (;;) {
    checkAbort(ctx);
    await settleOnGround(bot, ctx, 1_500);
    const feet = feetOf(bot);
    if (!skyBlocked(bot, feet.x, feet.y + 2, feet.z)) break;
    if (Date.now() > deadline) {
      throw new SkillBlocked(`我往上爬了 ${climbed} 格还没到露天,限时到了${where()}`);
    }
    for (const dy of [1, 2]) {
      const cc = { x: feet.x, y: feet.y + dy, z: feet.z };
      const b = blockAtCell(bot, cc);
      if (!b) throw new SkillBlocked(`我往上爬了 ${climbed} 格,头顶 (${cc.x}, ${cc.y}, ${cc.z}) 区块没加载${where()}`);
      if (LIQUIDS.has(b.name)) {
        throw new SkillBlocked(`我往上爬了 ${climbed} 格,头顶 (${cc.x}, ${cc.y}, ${cc.z}) 是${zhName(b.name)},不敢捅穿${where()}`);
      }
      if (b.boundingBox !== 'block') continue;
      if (b.diggable === false) throw new SkillBlocked(`我往上爬了 ${climbed} 格,头顶是${zhName(b.name)},挖不动${where()}`);
      const above = blockAtCell(bot, { x: cc.x, y: cc.y + 1, z: cc.z });
      if (above && LIQUIDS.has(above.name)) {
        throw new SkillBlocked(`我往上爬了 ${climbed} 格,(${cc.x}, ${cc.y}, ${cc.z}) 上面压着${zhName(above.name)},不敢捅穿${where()}`);
      }
      // 挖开前检查六个正邻格，覆盖正上方柱检查不到的侧邻岩浆。
      if (nearLavaAt(bot, cc)) {
        throw new SkillBlocked(`我往上爬了 ${climbed} 格,头顶 (${cc.x}, ${cc.y}, ${cc.z}) 旁边贴着岩浆,不敢捅${where()}`);
      }
      await equipToolFor(bot, b, ctx);
      await digBlock(bot, b, ctx);
    }
    // 垫脚上升前再对新落脚格与新头顶格各查一圈:柱子本身可能全程无料可挖(挖前闸
    // 摸不到),挖邻格也可能放出流动岩浆 —— 人升上去才贴上就是死#3 的形状
    for (const dy of [1, 2]) {
      const cc = { x: feet.x, y: feet.y + dy, z: feet.z };
      if (nearLavaAt(bot, cc)) {
        throw new SkillBlocked(`我往上爬了 ${climbed} 格,再上一格的落脚处 (${cc.x}, ${cc.y}, ${cc.z}) 旁边贴着岩浆,不敢上去${where()}`);
      }
    }
    if (!(await keep.climb())) {
      throw new SkillBlocked(`我往上爬了 ${climbed} 格,${keep.why('climb')},上不去了${where()}`);
    }
    // 垫进脚下的这一格落在工地体积里(自救豁免放行的):记数,回执里说清楚
    if (siteAtCellAnywhere(ctx, feet)) paddedInSite++;
    climbed++;
  }
  return `我爬到露天了,上来 ${climbed} 格${where()}`
    + (paddedInSite > 0 ? `;为脱困在蓝图工地体积里垫了 ${paddedInSite} 块` : '')
    + `;${surfaceStateText(bot)}`;
}

/** 水中 surface 的完成条件：身体已离水，脚下有可站立支撑，并且短时复读不回水。 */
export function hasDryFooting(bot: Bot): boolean {
  const entity = bot.entity as Bot['entity'] & { isInWater?: boolean; isInLava?: boolean };
  return entity.onGround
    && entity.isInWater !== true
    && entity.isInLava !== true
    && !headInWater(bot)
    && !bodyInWater(bot);
}

/** surface 的可观测后置条件；水中分支的成功不蕴含看得到天空。 */
export function surfaceStateText(bot: Bot): string {
  const feet = feetOf(bot);
  const outOfLiquid = !headInWater(bot) && !bodyInWater(bot);
  const standing = hasDryFooting(bot);
  const skyVisible = !skyBlocked(bot, feet.x, feet.y + 2, feet.z);
  const finalY = Number(bot.entity.position.y.toFixed(2));
  return `out_of_liquid=${outOfLiquid},standing=${standing},sky_visible=${skyVisible},final_y=${finalY}`;
}

export async function stableDryFooting(bot: Bot, ctx: SkillContext): Promise<boolean> {
  if (!hasDryFooting(bot)) return false;
  await sleep(300);
  checkAbort(ctx);
  return hasDryFooting(bot);
}

export async function skillBuild(bot: Bot, call: PlaceCall, ctx: SkillContext): Promise<string> {
  const spots = buildSpots(bot, call);
  const cells = spots.map((s) => s.cell);
  const shape = 'on' in call ? undefined : call.shape;
  const faceGiven = spots.some((s) => s.face !== null);
  const one = cells.length === 1;
  // 一处一处下的单(贴面、不写 shape 的格子清单)也一处一处回报;形状是连片的,按形状报
  const listed = shape === undefined && !one;
  const what = one ? cellText(cells[0]) : shape ? SHAPE_ZH[shape] : `这 ${cells.length} 格`;
  const spanText = one ? cellText(cells[0])
    : shape ? `${SHAPE_ZH[shape]}那 ${cells.length} 格` : `这 ${cells.length} 格`;
  const label = zhName(call.material);
  // BoatItem 由服务端沿玩家视线处理 use_item，不响应普通方块的 use_item_on。
  // 此处指向 useBoat，不代为放置。
  if (isBoat(call.material)) {
    throw new SkillBlocked(
      `${label}不是方块,build 放不出来(服务端按视线射线生成,只认「使用物品」)`,
      [`改用 {"skill":"use","item":"${call.material}","at":[x,y,z]} 指一格水面/地面`],
    );
  }
  const stock = () => invCount(bot, (n) => matchMaterialName(bot.registry, call.material, n));
  const classify = () => {
    const todo: BuildSpot[] = [];
    /** 开工前就定了局的那些格:一处一句,给逐处回报用 */
    const settled = new Map<string, string>();
    // 已经是目标方块的格计为已完成。
    let already = 0;
    let occupied = 0;
    let unloaded = 0;
    for (const s of spots) {
      const b = blockAtCell(bot, s.cell);
      if (!b) { unloaded++; settled.set(cellKeyOf(s.cell), '区块没加载'); }
      else if (matchPlacedMaterialName(bot, call.material, b.name)) {
        already++;
        settled.set(cellKeyOf(s.cell), `本来就是${label}`);
      }
      else if (b.boundingBox === 'block') { occupied++; settled.set(cellKeyOf(s.cell), `现在是${zhName(b.name)}`); }
      else todo.push(s);
    }
    return { todo, already, occupied, unloaded, settled };
  };
  const first = classify();
  if (call.dryRun) {
    const have = stock();
    const bits = [
      `共 ${cells.length} 格`,
      `${first.already} 格已经是${label}`,
      `${first.occupied} 格被别的方块占着`,
      `要放 ${first.todo.length} 块`,
      have >= first.todo.length ? `包里${label}有 ${have} 个,够` : `包里${label}只有 ${have} 个,差 ${first.todo.length - have}`,
    ];
    // 贴面形态的"贴得住不"在出发前就读得出来:参照方块不是实心的,那一处根本贴不上
    const noRef = spots.filter((s) => s.face !== null && !solidAt(bot, refCellOf(s.cell, s.face)));
    if (noRef.length > 0) {
      bits.push(`${noRef.length} 处贴不住(${noRef.slice(0, 3).map((s) => cellText(refCellOf(s.cell, s.face as BlockFace))).join('、')} 不是实心方块)`);
    }
    if (first.unloaded > 0) bits.push(`${first.unloaded} 格区块没加载`);
    const stations = stationNotes(bot, ctx, cells);
    return `试算${what}: ${bits.join(';')}。${stations.join('')}没动工`;
  }
  if (first.todo.length === 0) {
    if (first.already === cells.length) {
      return one ? `${cellText(cells[0])} 本来就是${label}` : `${spanText}已经都是${label}了`;
    }
    const bits = [`${first.already} 格已经是${label}`, `${first.occupied} 格被别的方块占着`];
    if (first.unloaded > 0) bits.push(`${first.unloaded} 格区块没加载`);
    const blockers = cells
      .filter((c) => !matchPlacedMaterialName(bot, call.material, blockAtCell(bot, c)?.name ?? ''))
      .slice(0, 3)
      .map((c) => occupantText(bot, c));
    // 标出回读时刻，便于区分稍后核验得到的新读数。
    throw new SkillBlocked(
      `一块都没放上:${spanText}没有一格空着(${bits.join(',')};读于 ${readStamp()})`,
      blockers,
    );
  }
  if (stock() === 0) throw new SkillBlocked(`包里没有${label}`);

  // 本单落点登记在案:这一趟寻路垫在落点之外的那些块是耗材,由执行器照报
  for (const c of cells) ctx.intended?.add(cellKeyOf(c));
  const total = first.todo.length;
  const remaining = new Map(first.todo.map((s) => [cellKeyOf(s.cell), s]));
  /** 放成了的那些格:贴的是哪一面 */
  const stuck = new Map<string, string>();
  /** 这一趟真动过手的那些格:没放上时才说得出"都试过了" */
  const tried = new Set<string>();
  let placed = 0;
  /** 收不了工时的原因;空串 = 全放完了 */
  let halt = '';
  while (remaining.size > 0) {
    checkAbort(ctx);
    const item = bot.inventory.items()
      .find((i) => matchMaterialName(bot.registry, call.material, i.name));
    if (!item) { halt = `${label}用完了`; break; }
    await bot.equip(item, 'hand');
    const me = bot.entity.position;
    let feet = feetOf(bot);
    // 边界:贴得住的那些格才放得上。指名了面就只认那一面的参照方块,没指名就看六个面里有没有实心的
    const frontier = [...remaining.values()]
      .filter((s) => (s.face !== null
        ? refAt(bot, refCellOf(s.cell, s.face))
        : NEIGHBORS6.some(([dx, dy, dz]) => refAt(bot, { x: s.cell.x + dx, y: s.cell.y + dy, z: s.cell.z + dz }))))
      // 自下而上,同层里近的先。按三维距离排会把几何层的顺序冲掉:同一柱先放上高处那格,
      // 低处那格就成了「贴着上面那格的下面吊着盖」,够不着的高处还要逼寻路垫脚
      // (0824 场 72 个跨层 build 段里 50 个先高后低)。
      .sort((a, b) => a.cell.y - b.cell.y
        || Math.hypot(a.cell.x + 0.5 - me.x, a.cell.z + 0.5 - me.z)
        - Math.hypot(b.cell.x + 0.5 - me.x, b.cell.z + 0.5 - me.z));
    if (frontier.length === 0) {
      // 六个面都贴不住时,还得说出占着那一格的是自己的脑袋——不然读起来像世界的问题
      const head = [...remaining.values()]
        .every((s) => s.cell.x === feet.x && s.cell.z === feet.z && s.cell.y === feet.y + 1);
      // 耕地与作物不能作为参照面；须区别此限制与没有实心方块。
      const soilRef = [...remaining.values()]
        .flatMap((s) => NEIGHBORS6.map(([dx, dy, dz]) =>
          blockAtCell(bot, { x: s.cell.x + dx, y: s.cell.y + dy, z: s.cell.z + dz })))
        .find((b) => b !== null && NO_PLACE_REFERENCE.has(b.name));
      halt = head
        ? `剩下的那一格 ${cellText({ x: feet.x, y: feet.y + 1, z: feet.z })} 顶在我脑袋上,` +
          '而且六个面都没有能贴着放的实心方块'
        : soilRef
          ? `剩下的 ${remaining.size} 格贴不住:挨着的是${zhName(soilRef.name)},` +
            '原版不收耕地与作物当放置参照面,这一下发出去服务端必拒,没发'
          : faceGiven
            ? `剩下的 ${remaining.size} 格,指名的那一面不是实心方块,贴不住`
            : `剩下的 ${remaining.size} 格六个面都没有能贴着放的实心方块`;
      break;
    }
    let progressed = false;
    let headOnly = 0;
    for (const s of frontier) {
      checkAbort(ctx);
      const c = s.cell;
      const key = cellKeyOf(c);
      if (occupiedByMe(bot, c)) {
        // 脚或头占据落点时，距离近仍须重新落位，避免身体阻挡放置。
        await gotoPlaceable(bot, s, ctx);
        feet = feetOf(bot);
      }
      if (occupiedByMe(bot, c)) {
        if (c.y === feet.y + 1) { headOnly++; continue; }
        if (s.face === null || s.face === 'up') {
          // 挪不开的脚下格才跳起来垫;贴的永远是脚下那一块的上面,指名了别的面时这条路不适用
          if (!(await ensureHolding(bot, call.material))) { halt = `${label}用完了`; break; }
          const permit = permitPlacement(ctx, bot.heldItem?.name ?? item.name);
          if (!permit.ok) { halt = permit.reason; break; }
          let landed = false;
          try {
            landed = await jumpPlaceBelow(bot, ctx, call.material);
          } finally {
            permit.finish(landed);
          }
          if (landed) {
            remaining.delete(key);
            stuck.set(key, faceText(refCellOf(c, 'up'), 'up'));
            progressed = true;
            break;
          }
          tried.add(key);
          continue;
        }
      }
      const p = bot.entity.position;
      if (Math.hypot(c.x + 0.5 - p.x, c.y - p.y, c.z + 0.5 - p.z) > PLACE_REACH
        && !(await gotoPlaceable(bot, s, ctx))) continue;
      // 对占身位的材料，中心格外的碰撞箱擦边也须避开；gotoPlaceable 只保证可及距离。
      if (materialCollides(bot, call.material) && hitboxBlocks(bot, c)
        && !(await stepOffCell(bot, ctx, c))) { tried.add(key); continue; }
      if (!(await ensureHolding(bot, call.material))) { halt = `${label}用完了`; break; }
      const permit = permitPlacement(ctx, bot.heldItem?.name ?? item.name);
      if (!permit.ok) { halt = permit.reason; break; }
      tried.add(key);
      let landed: BlockFace | null = null;
      try {
        landed = await placeIntoCell(bot, c, call.material, ctx, s.face ?? undefined);
      } finally {
        permit.finish(landed !== null);
      }
      if (landed) {
        remaining.delete(key);
        stuck.set(key, faceText(refCellOf(c, landed), landed));
        progressed = true;
        break;
      }
    }
    if (halt) break;
    if (progressed) {
      placed++;
      ctx.progress?.(placed, total);
    } else if (headOnly > 0 && headOnly === frontier.length) {
      halt = `剩 ${remaining.size} 格顶在我脑袋上,挪了一步也没挪开`;
      break;
    } else {
      // 点名占位的是谁:"剩 N 格放不上"读不出下一步该拆什么
      halt = `剩 ${remaining.size} 格放不上,${faceGiven ? '指名的那一面' : '六个面都'}试过了:` +
        `${frontier.slice(0, 3).map((s) => occupantText(bot, s.cell)).join('、')}`;
      break;
    }
  }
  /** 逐处回报:一处贴不住不牵连别处 */
  const spotLine = (s: BuildSpot): string => {
    const key = cellKeyOf(s.cell);
    const ok = stuck.get(key);
    if (ok) return `${cellText(s.cell)} ${ok}放上了`;
    const settled = first.settled.get(key);
    if (settled) return `${cellText(s.cell)} ${settled}`;
    if (s.face !== null && !solidAt(bot, refCellOf(s.cell, s.face))) {
      const ref = refCellOf(s.cell, s.face);
      const b = blockAtCell(bot, ref);
      return `${cellText(s.cell)} 贴不住:${cellText(ref)} 是${b ? zhName(b.name) : '没加载的区块'},不是实心方块`;
    }
    if (!tried.has(key)) return `${cellText(s.cell)} 没轮到:${halt}`;
    return `${cellText(s.cell)} ${s.face ? `${FACE_ZH[s.face]}面试过了` : '六个面都试过了'},` +
      `服务端没认:${occupantOf(bot, s.cell)}`;
  };
  const notes: string[] = [];
  if (first.already > 0) notes.push(`${first.already} 格本来就是${label},跳过`);
  if (first.occupied > 0) notes.push(`${first.occupied} 格被别的方块占着,跳过`);
  if (first.unloaded > 0) notes.push(`${first.unloaded} 格区块没加载`);
  const frame = portalFrameTally(bot, call.material, [...stuck.keys()]);
  if (frame) notes.push(frame);
  const pillar = placed > 0 ? pillarStandNote(bot, cells) : null;
  if (pillar) notes.push(pillar);
  const where = `。现在人在 ${cellText(feetOf(bot))}`;
  const tail = `${notes.length > 0 ? `;${notes.join(';')}` : ''}${where}`;
  // 一处一处下的单,一处一处回报:一处贴不住不牵连另外几处
  const spotLines = shape === undefined ? spots.map(spotLine) : [];
  if (halt && placed === 0) {
    // 床/门这类占两格的:她从快照里看不到"哪儿有连续两格空位",把附近够用的位置报出来
    const fp = footprintOf(bot, call.material);
    const scene = fp === 'single' ? [] : footprintScene(bot, first.todo[0].cell, call.material, fp);
    throw new SkillBlocked(`一块都没放上:${halt}${tail}`, [...spotLines, ...scene], 'server');
  }
  // 缺口以 remaining 中计划放置但未完成的格计；原已存在的目标方块不计缺口。
  const gap = [...remaining.values()].map((s) => cellText(s.cell));
  if (gap.length > 0) {
    ctx.partial?.(`${label}还差 ${gap.length} 处没放上(${gap.slice(0, 6).join('、')}${gap.length > 6 ? '…' : ''})`);
  }
  if (listed) return `放上了 ${placed}/${cells.length} 处:${spotLines.join(';')}${where}`;
  const along = shape ? `沿${SHAPE_ZH[shape]}` : '';
  if (halt) return `${one ? '' : along}放了 ${placed}/${total} 块${label},停在:${halt}${tail}`;
  const how = stuck.get(cellKeyOf(cells[0]));
  return one
    ? `${cellText(cells[0])} 放下了${label}${how ? `,${how}` : ''};包里还有 ${stock()} 个${tail}`
    : `${along}放好了 ${total} 块${label}${tail}`;
}

/**
 * 单列柱完成后报告当前所站列；已在目标列则返回 null。
 * build 可从旁边的临时支撑柱放置，不保证站上目标柱；攀上目标柱使用 tunnel 的塔形态。
 */
export function pillarStandNote(bot: Bot, cells: readonly Cell[]): string | null {
  const [c0] = cells;
  if (cells.length < 2 || !cells.every((c) => c.x === c0.x && c.z === c0.z)) return null;
  const feet = feetOf(bot);
  if (feet.x === c0.x && feet.z === c0.z) return null;
  return `这一根立在 (${c0.x}, ${c0.z}) 那一列,人不在它上面(横着差 ` +
    `${Math.round(Math.hypot(feet.x - c0.x, feet.z - c0.z))} 格),中间是空的;` +
    '要站上自己搭的那一根,用 tunnel 的塔(at 放正上方、不带 spiral)';
}

/** 门框材料集合；放置回执须区分黑曜石与哭泣的黑曜石。 */
export const PORTAL_FRAME_MATERIALS = new Set(['obsidian', 'crying_obsidian']);

/**
 * 门框那一批放完之后的机械核对:逐格回读真名,报「实际是:黑曜石×N」。
 * 走 registry 的精确名比对,不经 matchMaterialName —— 这一句的价值全在它不模糊。
 */
export function portalFrameTally(bot: Bot, material: string, placedKeys: readonly string[]): string | null {
  if (!PORTAL_FRAME_MATERIALS.has(material) || placedKeys.length === 0) return null;
  const tally = new Map<string, number>();
  for (const key of placedKeys) {
    const [x, y, z] = key.split(',').map(Number);
    const b = blockAtCell(bot, { x, y, z });
    const name = b?.name ?? '(读不到)';
    tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  const bits = [...tally].map(([name, n]) => `${name === '(读不到)' ? name : zhName(name)}×${n}`);
  return `门框材料实际是:${bits.join('、')}`;
}

// ── 蓝图施工 ──────────────────────────────────────────────────────────────────

/** 回读一次最多读几格;超了就读前面这些,回执如实说读了多少 */
export const BLUEPRINT_READBACK_CAP = 4096;
/** dryRun 的逐层字符图最多打几行(含图例);再多她读不完,也是常驻上下文开销 */
export const BLUEPRINT_MAP_ROWS = 40;
/** 连着这么多步没推进就提前收工:再往下多半是同一处障碍,空转的每一步都是钱 */
export const BLUEPRINT_FAIL_STREAK = 5;
/** 清场受阻时最多把几段 excavate 回执并进现场;再多是常驻上下文开销 */
export const CLEAR_NOTE_CAP = 4;

/**
 * 清场回读后允许再清一轮的残留上限。超过它就抛:那说明拖住清场的不是蔓延速度,
 * 再清一轮也追不上。轮数硬上限一轮 —— 无上限的重试就是真死循环。
 */
export const CLEAR_RESIDUE_CAP = 5;

/** 抛错时残留格最多逐格列几行;剩下的报个数,不无界往上下文里灌 */
export const CLEAR_RESIDUE_LIST_CAP = 24;

/** 残留格逐格摆出来:哪一格、现在是什么、该是什么 */
export function conflictCellLines(conflicts: readonly BlueprintConflict[]): string[] {
  const zh = (state: string): string => zhName(blockIdOf(state).replace('minecraft:', ''));
  const lines = conflicts.slice(0, CLEAR_RESIDUE_LIST_CAP).map((c) =>
    `${cellText({ x: c.pos[0], y: c.pos[1], z: c.pos[2] })} 现在是${zh(c.actual)},该是${zh(c.expect)}`);
  const rest = conflicts.length - lines.length;
  return rest > 0 ? [...lines, `另外 ${rest} 格同样没清掉`] : lines;
}

/**
 * 清场回执里表示「这几格没挖成」的那几类事实,按 skillExcavate 的措辞取。
 *
 * 略去的段落不是「都一样」:够不着/账本护住/挖不动混在里头,只报段数会把诊断整类吞掉。
 */
export const CLEAR_BLOCK_MARKS = ['够不着', '没动它', '根本挖不动', '紧贴着岩浆', '挖了不掉东西'];

/**
 * 世界那一格的完整状态串(属性名排序,与蓝图侧的规范化同一口径)。
 * 回读三分类要它 —— 只比 type 分不出「楼梯朝向被服务端改了」与「根本没完成」。
 */
export function worldStateAt(bot: Bot, cell: Cell): string | null {
  const b = blockAtCell(bot, cell);
  if (!b) return null;
  const raw = typeof b.getProperties === 'function'
    ? (b.getProperties() as Record<string, unknown>)
    : {};
  const entries = Object.entries(raw)
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort((l, r) => l[0].localeCompare(r[0]));
  return entries.length === 0
    ? b.name
    : `${b.name}[${entries.map(([k, v]) => `${k}=${v}`).join(',')}]`;
}

/** 服务端按邻接方块计算的连接、形状和 in_wall 属性，放置方无法指定最终值。 */
export const SELF_COMPUTED_PROPS = new Set(['north', 'south', 'east', 'west', 'up', 'shape', 'in_wall']);

/** 回读比对用的状态串:摘掉邻接自算的属性,别的照比 */
export function readbackState(state: string): string {
  const at = state.indexOf('[');
  if (at === -1) return normalizeBlockName(state);
  const id = normalizeBlockName(state.slice(0, at));
  const kept = state.slice(at + 1, -1).split(',')
    .filter((p) => !SELF_COMPUTED_PROPS.has(p.slice(0, p.indexOf('='))));
  return kept.length === 0 ? id : `${id}[${kept.join(',')}]`;
}

/** 一步落在世界的哪几格:单格报一格,多格报两端 */
export function stepSpanText(step: BlueprintStep, anchor: PositionXYZ): string {
  const from = toWorld(anchor, step.from);
  const to = toWorld(anchor, step.to);
  const one = from.every((v, i) => v === to[i]);
  const cell = (p: PositionXYZ): string => cellText({ x: p[0], y: p[1], z: p[2] });
  return one ? cell(from) : `${cell(from)}–${cell(to)}`;
}

/** 背包现读成 ItemTally(三分账单的「随身」一栏) */
export function carriedTally(bot: Bot): ItemTally {
  return Object.fromEntries(invSnapshot(bot));
}

/** 三分账单渲染:缺的排前面,只报前几样 */
export function blueprintBillText(steps: readonly BlueprintStep[], carried: ItemTally, stored: ItemTally): string {
  const bill = billForSteps(steps, { carried, stored });
  if (bill.lines.length === 0) return '这一段一块都不用放';
  const lines = bill.lines.slice(0, 5).map((l) =>
    `${zhName(l.item)} 要 ${l.need}(随身 ${l.carried}、在箱 ${l.stored}`
    + `${l.missing > 0 ? `、还缺 ${l.missing}` : '、够了'})`);
  const rest = bill.lines.length > 5 ? `;另有 ${bill.lines.length - 5} 样` : '';
  return `${lines.join(';')}${rest}`;
}

/** 「能连着施工到第 k/N 步(到第 y 层)」;层号按那一步所在的层报 */
export function reachText(steps: readonly BlueprintStep[], reach: number, total: number, base: number): string {
  if (steps.length === 0) return '这一段没有成形步骤';
  if (reach === 0) return '手上的料一步都不够,第一步就得停';
  const last = steps[reach - 1];
  return `手上的料能连着施工到第 ${base + reach}/${total} 步(第 ${last.y} 层)`;
}

export function blueprintCellCount(blueprint: NormalizedBlueprint): number {
  return blueprint.layers.reduce(
    (total, layer) => total + layer.reduce((rows, row) => rows + row.length, 0),
    0,
  );
}

export function readBlueprintWorld(bot: Bot, site: BlueprintSite, anchor: PositionXYZ): BlueprintDiff {
  return diffBlueprint(
    site.blueprint,
    site.plan,
    anchor,
    (x, y, z) => worldStateAt(bot, { x, y, z }),
    { checkAir: true, sampleLimit: blueprintCellCount(site.blueprint) },
  );
}

export function surveyFromDiff(diff: BlueprintDiff): BlueprintSurvey {
  return {
    at: Date.now(),
    matched: diff.matched,
    missing: diff.missing,
    unknown: diff.unknown,
    wrongBlock: diff.conflictCounts['wrong-block'],
    shouldBeAir: diff.conflictCounts['should-be-air'],
    // should-be-air 的 actual 带着完整属性串,zhName 译不了;先取纯 type 再译
    samples: diff.conflicts.slice(0, 8).map((conflict) =>
      `${cellText({ x: conflict.pos[0], y: conflict.pos[1], z: conflict.pos[2] })} `
      + `${zhName(blockIdOf(conflict.actual).replace('minecraft:', ''))}`
      + `→${zhName(blockIdOf(conflict.expect).replace('minecraft:', ''))}`),
  };
}

/** 冲突格按同一 y/z 上相邻的 x 合成线段，每段不超过 excavate 的一单上限。 */
export function conflictRuns(conflicts: readonly BlueprintConflict[]): Array<[PositionXYZ, PositionXYZ]> {
  const positions = [...new Map(conflicts.map((entry) => [entry.pos.join(','), entry.pos])).values()]
    .sort((left, right) => left[1] - right[1] || left[2] - right[2] || left[0] - right[0]);
  const runs: Array<[PositionXYZ, PositionXYZ]> = [];
  for (const pos of positions) {
    const last = runs[runs.length - 1];
    if (last && last[0][1] === pos[1] && last[0][2] === pos[2]
      && last[1][0] + 1 === pos[0] && last[1][0] - last[0][0] + 1 < EXCAVATE_CELL_CAP) {
      last[1] = [...pos] as PositionXYZ;
    } else {
      runs.push([[...pos] as PositionXYZ, [...pos] as PositionXYZ]);
    }
  }
  return runs;
}

/** 清理冲突格，并将每段 excavate 的回执写入 notes。 */
export async function clearBlueprintConflicts(
  bot: Bot,
  conflicts: readonly BlueprintConflict[],
  ctx: SkillContext,
  notes: string[],
): Promise<void> {
  const liquid = conflicts.filter((entry) => LIQUIDS.has(blockIdOf(entry.actual).replace('minecraft:', '')));
  if (liquid.length > 0) {
    throw new SkillBlocked(
      `清场范围里有 ${liquid.length} 格液体,不能当普通方块挖掉`,
      liquid.slice(0, 3).map((entry) =>
        `${cellText({ x: entry.pos[0], y: entry.pos[1], z: entry.pos[2] })} 是`
        + zhName(entry.actual.replace('minecraft:', ''))),
    );
  }
  for (const [from, to] of conflictRuns(conflicts)) {
    notes.push(await skillExcavate(bot, {
      skill: 'excavate',
      shape: 'box',
      fill: 'solid',
      anchors: [[...from], [...to]],
    }, {
      ...ctx,
      progress: undefined,
      batch: undefined,
      noLight: true,
    }));
  }
}

export function stepWorldCells(step: BlueprintStep, anchor: PositionXYZ): PositionXYZ[] {
  const cells: PositionXYZ[] = [];
  for (let y = step.from[1]; y <= step.to[1]; y++) {
    for (let z = step.from[2]; z <= step.to[2]; z++) {
      for (let x = step.from[0]; x <= step.to[0]; x++) cells.push(toWorld(anchor, [x, y, z]));
    }
  }
  return cells;
}

/**
 * 整张图完工时把它占的格落进成果登记。只登记世界里读得到、且不是空气的那些 ——
 * 图里本来就该空着的格(门洞、屋内空间)不是成果。
 */
export function noteBlueprintWork(bot: Bot, ctx: SkillContext, site: BlueprintSite, anchor: PositionXYZ): void {
  if (!ctx.works) return;
  const cells: Array<{ x: number; y: number; z: number; kind: 'blueprint'; block: string; site: string }> = [];
  for (const step of site.plan.steps) {
    for (const pos of stepWorldCells(step, anchor)) {
      const b = blockAtCell(bot, { x: pos[0], y: pos[1], z: pos[2] });
      if (!b || AIR_NAMES.has(b.name)) continue;
      cells.push({ x: pos[0], y: pos[1], z: pos[2], kind: 'blueprint', block: b.name, site: site.key });
    }
  }
  ctx.works.noteMany(dimensionOf(bot), cells);
}

export function blueprintCellDone(bot: Bot, step: BlueprintStep, pos: PositionXYZ): boolean {
  const actual = worldStateAt(bot, { x: pos[0], y: pos[1], z: pos[2] });
  return actual !== null && blueprintStepStateMatches(step, actual);
}

export function verifyBlueprintStepChecks(
  bot: Bot,
  step: BlueprintStep,
  anchor: PositionXYZ,
  checks: readonly BlueprintCheckCell[],
): void {
  for (const check of checks) {
    if (check.mainStep !== step.index) continue;
    const pos = toWorld(anchor, check.pos);
    const actual = worldStateAt(bot, { x: pos[0], y: pos[1], z: pos[2] });
    if (actual !== null && blockIdOf(actual) === blockIdOf(check.state)) continue;
    throw new SkillBlocked(
      `${cellText({ x: pos[0], y: pos[1], z: pos[2] })} 的从部件该是 ${blockIdOf(check.state)},`
        + `回读是 ${actual ?? '区块没加载'}`,
    );
  }
}

export async function runBlueprintStep(
  bot: Bot,
  step: BlueprintStep,
  anchor: PositionXYZ,
  ctx: SkillContext,
): Promise<string | null> {
  const innerCtx: SkillContext = {
    ...ctx,
    progress: undefined,
    batch: undefined,
  };
  if (step.method.kind === 'place') {
    let gap: string | null = null;
    await skillBuild(bot, stepToBuildCall(step, anchor) as PlaceCall, {
      ...innerCtx,
      partial: (why) => { gap = why; },
    });
    if (gap !== null) return gap;
    const postUse = step.method.postUse;
    if (!postUse) return null;
    for (const pos of stepWorldCells(step, anchor)) {
      for (let attempt = 0; attempt < postUse.maxUses && !blueprintCellDone(bot, step, pos); attempt++) {
        await skillUse(bot, { skill: 'use', at: [...pos] }, innerCtx);
      }
      if (!blueprintCellDone(bot, step, pos)) {
        throw new SkillBlocked(
          `${cellText({ x: pos[0], y: pos[1], z: pos[2] })} 的 ${postUse.property}`
          + `没能调到 ${postUse.value}`,
        );
      }
    }
    return null;
  }

  for (const pos of stepWorldCells(step, anchor)) {
    if (blueprintCellDone(bot, step, pos)) continue;
    if (step.method.baseItem) {
      // 已经是任何一样可转换基材就不必补:锄头对草方块与泥土产出的耕地完全一样
      const current = blockAtCell(bot, { x: pos[0], y: pos[1], z: pos[2] })?.name ?? null;
      if (current === null || !step.method.baseItem.includes(current)) {
        await skillBuild(bot, {
          skill: 'build',
          material: step.method.baseItem[0],
          anchors: [[...pos]],
        }, innerCtx);
      }
    }
    const target: PositionXYZ = step.method.target === 'below'
      ? [pos[0], pos[1] - 1, pos[2]]
      : pos;
    await skillUse(bot, { skill: 'use', item: step.method.item, at: [...target] }, innerCtx);
    if (!blueprintCellDone(bot, step, pos)) {
      throw new SkillBlocked(
        `${cellText({ x: pos[0], y: pos[1], z: pos[2] })} 回读没有变成 ${blockIdOf(step.state)}`,
      );
    }
  }
  return null;
}

/**
 * collect/pickup/take 仅在活跃蓝图缺口减小或可多施工几步时附收益说明。
 * 活跃图为目标点名的图或唯一已装载图；只报读数，不给行动建议。
 */
export async function withBlueprintGain(
  bot: Bot,
  ctx: SkillContext,
  run: () => Promise<string>,
): Promise<string> {
  const desk = ctx.blueprints?.();
  const key = desk?.activeKey() ?? null;
  const site = key !== null && desk ? desk.get(key) : null;
  if (!desk || !site) return run();
  const stored = desk.stored();
  const rest = site.plan.steps.slice(site.cursor);
  if (rest.length === 0) return run();
  const before = billForSteps(rest, { carried: carriedTally(bot), stored });
  const text = await run();
  const after = billForSteps(rest, { carried: carriedTally(bot), stored });
  const bits: string[] = [];
  for (const line of before.lines) {
    if (line.missing <= 0 || bits.length >= 2) continue;
    const now = after.lines.find((l) => l.item === line.item);
    if (!now || now.missing >= line.missing) continue;
    bits.push(`还缺${zhName(line.item)} ${line.missing}→${now.missing}`);
  }
  const gained = after.reachableSteps - before.reachableSteps;
  if (gained > 0) {
    const last = rest[after.reachableSteps - 1];
    bits.push(`够再往前施工 ${gained} 步(到第 ${last.y} 层)了`);
  }
  return bits.length === 0 ? text : `${text}(${site.key} ${bits.join(';')})`;
}

/**
 * 按已装载的蓝图盖。
 *
 * 每一步都是一条**标准 build 调用**(stepToBuildCall 产出的 box+solid),交给
 * `skillBuild` 原样执行 —— 放置、贴面挑选、垫脚、「本来就是这个方块」这些口径
 * 一份都不重写。受理刻的重生锚闸与重力闸在 `submit` 那一层按整张图的落点算过。
 */
/**
 * 收工回收本趟垫入工地体积的方块，工地外垫脚保留作路。
 * 台账名称与当前方块不符时不动；先挖远处，脚下支撑最后处理并先移出工地。
 */
export async function reclaimSiteScaffold(
  bot: Bot,
  ctx: SkillContext,
  box: { min: PositionXYZ; max: PositionXYZ },
  /** 开工前台账里已有的那些条目(按对象身份) */
  before: ReadonlySet<object>,
): Promise<string> {
  const seen = new Set<string>();
  const targets = placedLedgerOf(bot).filter((p) => {
    if (before.has(p) || !inBox(box, p) || ctx.intended?.has(cellKeyOf(p))) return false;
    const key = cellKeyOf(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (targets.length === 0) return '';
  const me = bot.entity.position;
  targets.sort((a, b) => Math.hypot(b.x - me.x, b.y - me.y, b.z - me.z)
    - Math.hypot(a.x - me.x, a.y - me.y, a.z - me.z));

  /** 台账点名的那一块还在原地才挖 */
  const digOne = async (p: { name: string; x: number; y: number; z: number }): Promise<boolean> => {
    let b = blockAtCell(bot, p);
    if (!b || b.name !== p.name) return false;
    if (!bot.canDigBlock(b)) {
      try {
        await gotoGoal(bot, new goals.GoalNear(p.x, p.y, p.z, 2), ctx);
      } catch (err) {
        if (err instanceof Aborted) throw err;
        return false;
      }
      b = blockAtCell(bot, p);
      if (!b || b.name !== p.name || !bot.canDigBlock(b)) return false;
    }
    await equipToolFor(bot, b, ctx);
    await digBlock(bot, b, ctx);
    return true;
  };
  /** 人正站在这一块上吗(它是脚下那一格) */
  const underfoot = (p: { x: number; y: number; z: number }): boolean => {
    const feet = feetOf(bot);
    return p.x === feet.x && p.z === feet.z && p.y === feet.y - 1;
  };

  let dug = 0;
  let left: typeof targets[number] | null = null;
  for (const p of targets) {
    checkAbort(ctx);
    if (underfoot(p)) { left = p; continue; }
    if (await digOne(p)) dug++;
  }
  if (left) {
    if (underfoot(left)) {
      // 挪出工地再挖:从最近的一面往外三格
      const feet = feetOf(bot);
      const out = [
        { d: feet.x - box.min[0], c: { x: box.min[0] - 3, y: feet.y, z: feet.z } },
        { d: box.max[0] - feet.x, c: { x: box.max[0] + 3, y: feet.y, z: feet.z } },
        { d: feet.z - box.min[2], c: { x: feet.x, y: feet.y, z: box.min[2] - 3 } },
        { d: box.max[2] - feet.z, c: { x: feet.x, y: feet.y, z: box.max[2] + 3 } },
      ].sort((a, b) => a.d - b.d)[0].c;
      try {
        await gotoGoal(bot, new goals.GoalNear(out.x, out.y, out.z, 2), ctx);
      } catch (err) {
        if (err instanceof Aborted) throw err;
      }
    }
    if (!underfoot(left) && await digOne(left)) dug++;
  }
  if (dug > 0) await sweepDrops(bot, ctx);
  return dug === 0 ? '' : `顺手清掉了工地里的垫脚 ${dug} 块。`;
}

export async function skillBuildBlueprint(
  bot: Bot,
  call: BlueprintCall,
  ctx: SkillContext,
): Promise<string> {
  const desk = ctx.blueprints?.();
  const site = desk?.get(call.blueprint) ?? null;
  if (!desk || !site) {
    throw new SkillBlocked(
      `蓝图「${call.blueprint}」这边没装载,施工不了`,
      [
        '笔记里存过设计要求的话,mc_blueprint 的 design 重新出一张图;',
        '手上有现成数据就 mc_blueprint 的 save 交回来;',
        `装载着哪几份看 mc_blueprint{}(现在:${desk?.keys().join('、') || '一份都没有'})`,
      ],
    );
  }
  const seat = call.at ? resolveAt(bot, call.at) : null;
  const anchor: PositionXYZ | null = seat
    ? [seat.x, seat.y, seat.z]
    : site.anchor;
  if (!anchor) {
    throw new SkillBlocked(
      `第一次施工「${site.key}」要给 at:蓝图 [0,0,0](最低层、最西、最北那一格)落在世界的哪一格`,
      [`这张图 ${site.blueprint.size_xyz.join('×')},往东 ${site.blueprint.size_xyz[0]} 格、`
        + `往上 ${site.blueprint.size_xyz[1]} 格、往南 ${site.blueprint.size_xyz[2]} 格铺开`],
    );
  }
  const moved = site.anchor !== null && site.anchor.some((v, i) => v !== anchor[i]);
  const started = site.startedAt === undefined ? site.anchor !== null : site.startedAt !== null;
  const firstStart = moved || !started;
  const needsSurvey = site.blueprint.site_mode === 'retrofit'
    && (moved || site.anchor === null || (!started && !site.survey));
  const total = site.plan.steps.length;
  const limit = call.stopAfter === undefined
    ? total
    : stepCountThroughLayer(site.plan.steps, call.stopAfter);
  let diff = readBlueprintWorld(bot, site, anchor);
  const head = `「${site.key}」${site.name ? `「${site.name}」` : ''}`
    + `(${site.blueprint.size_xyz.join('×')},共 ${total} 步 / ${site.plan.placeCells} 格,`
    + `锚点 ${cellText({ x: anchor[0], y: anchor[1], z: anchor[2] })})`;
  const unknownNote = diff.unknown > 0
    ? `;${diff.unknown} 格区块没加载,读不到——这几格既没算已建也没算还缺`
    : '';
  const conflictNote = diff.conflicts.length > 0
    ? `冲突 ${diff.conflictCounts['wrong-block'] + diff.conflictCounts['should-be-air']} 格`
      + `(${diff.conflicts.slice(0, 3).map((c) =>
        `${cellText({ x: c.pos[0], y: c.pos[1], z: c.pos[2] })} 现在是${zhName(c.actual.replace('minecraft:', ''))}`
          + `${c.kind === 'should-be-air' ? ',那儿该空着' : `,该是${zhName(c.expect.replace('minecraft:', ''))}`}`)
        .join('、')})`
    : '没有冲突格';

  // ── 试算:不动工,只把账摊开 ────────────────────────────────────────────
  if (call.dryRun) {
    const todo = diff.remaining.filter((s) => s.index < limit);
    const carried = carriedTally(bot);
    const stored = desk.stored();
    const bill = billForSteps(todo, { carried, stored });
    const lines = [
      `试算${head}:已经对上 ${diff.matched} 格,还差 ${diff.missing} 格(${todo.length} 步)`
        + `;${conflictNote}${unknownNote}。`,
      `料:${blueprintBillText(todo, carried, stored)}。`,
      `${reachText(todo, bill.reachableSteps, total, total - diff.remaining.length)}`
        + `${bill.reachableStepsWithStored > bill.reachableSteps
          ? `;把箱里那些也取来能到第 ${total - diff.remaining.length + bill.reachableStepsWithStored} 步` : ''}。`,
      call.stopAfter === undefined ? '' : `这一单只施工到第 ${call.stopAfter} 层(前 ${limit} 步)。`,
      site.blueprint.site_mode === 'new'
        ? diff.conflicts.length > 0
          ? `这是新建工地;那 ${diff.conflicts.length} 个冲突格须审阅后带 confirm:true 才会清掉并施工。`
          : '这是新建工地;现场没有冲突格。'
        : needsSurvey
          ? '这是改造工地;第一次真实调用只保存现场探测,不会改方块。'
          : diff.conflicts.length > 0
            ? '这是改造工地;冲突须审阅后带 confirm:true 才会清掉并施工。'
            : '这是改造工地;初探已经完成,现场没有需要确认的冲突。',
      firstStart ? '这个世界里还没正式开工,动工时会把这个锚点记进施工绑定。' : '',
      moved ? '锚点跟上次那次不一样:真下这一单等于换地方重新施工,进度从头算。' : '',
      // 图外现场才决定得了的前提(作物下的耕地、门下的地基):试算是她动工前唯一一次核对的机会
      site.plan.advisories.length > 0
        ? `这几条得靠现场满足(编译期看不见工地):\n${renderBlueprintAdvisories(site.plan.advisories)}`
        : '',
    ].filter(Boolean);
    const map = renderLayerMap(site.blueprint);
    const rows = map.layers.reduce((n, l) => n + l.rows.length + 1, map.legend.length + 1);
    if (rows <= BLUEPRINT_MAP_ROWS) {
      lines.push('逐层图(`.`=空气,行是北→南,列是西→东):');
      lines.push(...map.legend.map((l) => `  ${l.char} = ${l.state}(${l.cells} 格)`));
      for (const layer of map.layers) {
        lines.push(`  第 ${layer.y} 层(${layer.nonAirCells} 格):`);
        lines.push(...layer.rows.map((r) => `    ${r}`));
      }
    } else {
      lines.push(`这张图 ${map.layers.length} 层,逐层图打出来 ${rows} 行,太长了没打。`);
    }
    return `${lines.join('\n')}\n没动工`;
  }

  // ── 改造初探与清场 ──────────────────────────────────────────────────────
  if (needsSurvey) {
    const survey = surveyFromDiff(diff);
    desk.survey(site.key, anchor, survey);
    const conflicts = survey.wrongBlock + survey.shouldBeAir;
    return [
      `${head}:我完成并保存了初始探测;这一次没有改动任何方块。`,
      `已符合 ${survey.matched} 格,待施工 ${survey.missing} 格,冲突 ${conflicts} 格`
        + `${survey.unknown > 0 ? `,另有 ${survey.unknown} 格区块没加载` : ''}。`,
      survey.samples.length > 0 ? `冲突样本:${survey.samples.join('、')}。` : '',
      conflicts > 0
        ? '先审阅现场；接受清掉这些冲突格就用同一锚点再 build 并带 confirm:true，'
          + '要保留现场就用同一个键重新 design，探测结果会带给修订轮。'
        : '现场没有冲突；用同一锚点再 build 就会正式施工。',
    ].filter(Boolean).join('\n');
  }

  if (diff.unknown > 0) {
    throw new SkillBlocked(`${head}有 ${diff.unknown} 格区块没加载,不能安全清场或施工`);
  }
  // 回收的账从这里起:清场那一段走路垫进来的也算这一趟的(见 reclaimSiteScaffold)
  const box = siteBox(site, anchor);
  const ledgerBefore = new Set<object>(placedLedgerOf(bot));
  const conflictTotal = diff.conflictCounts['wrong-block'] + diff.conflictCounts['should-be-air'];
  // 所有工地模式均对清除既有冲突格执行确认闸。
  /** 她显式要跳过的冲突格:不清场、不拦,放置阶段自然绕过它们 */
  const skipped = conflictTotal > 0 && call.skipConflicts === true ? [...diff.conflicts] : [];
  if (conflictTotal > 0 && skipped.length === 0 && call.confirm !== true) {
    throw new SkillBlocked(
      `${head}的现场比蓝图多出 ${conflictTotal} 个冲突格;没有自动清掉`,
      [
        ...surveyFromDiff(diff).samples,
        '接受清掉这些格就原调用加 confirm:true;'
        + '只想先把能放的放上就加 skipConflicts:true;要保留它们就同键重新 design',
      ],
    );
  }

  let cleared = 0;
  if (conflictTotal > 0 && skipped.length === 0) {
    /** 清场每一段自己说了什么;受阻时并进外层文案,不然「没动它」这类原因就没了 */
    const clearNotes: string[] = [];
    const said = (): string[] => {
      const seen = [...new Set(clearNotes)];
      if (seen.length <= CLEAR_NOTE_CAP) return seen;
      const rest = seen.slice(CLEAR_NOTE_CAP);
      const kinds = CLEAR_BLOCK_MARKS.filter((m) => rest.some((n) => n.includes(m))).length;
      return [
        ...seen.slice(0, CLEAR_NOTE_CAP),
        `另外 ${rest.length} 段清场回执略去${kinds > 0 ? `,含 ${kinds} 类没展示的受阻原因` : ''}`,
      ];
    };
    const clear = async (targets: readonly BlueprintConflict[]): Promise<void> => {
      try {
        await clearBlueprintConflicts(bot, targets, ctx, clearNotes);
      } catch (err) {
        if (err instanceof Aborted) throw err;
        throw new SkillBlocked(`蓝图清场停下了:${(err as Error).message}`, said());
      }
    };
    const before = new Set(diff.conflicts.map((c) => c.pos.join(',')));
    await clear(diff.conflicts);
    cleared = conflictTotal;
    diff = readBlueprintWorld(bot, site, anchor);
    let left = diff.conflictCounts['wrong-block'] + diff.conflictCounts['should-be-air'];
    // 可容忍的剩余冲突须全部为清场期间新出现的格，数量不超过 CLEAR_RESIDUE_CAP。
    const fresh = diff.conflicts.every((c) => !before.has(c.pos.join(',')));
    if (left > 0 && left <= CLEAR_RESIDUE_CAP && fresh && diff.unknown === 0) {
      await clear(diff.conflicts);
      cleared += left;
      diff = readBlueprintWorld(bot, site, anchor);
      left = diff.conflictCounts['wrong-block'] + diff.conflictCounts['should-be-air'];
    }
    if (diff.unknown > 0 || left > 0) {
      throw new SkillBlocked(
        `清场后回读仍有 ${left} 个冲突格、${diff.unknown} 格读不到,没有开始放置`,
        [...conflictCellLines(diff.conflicts), ...said()],
      );
    }
  }

  /** 她要跳过的那些格:回执点名,别让「跳过了」成为她要自己猜的事 */
  const skipNote = skipped.length === 0
    ? ''
    : `按你说的跳过了 ${skipped.length} 个冲突格,它们原样留着:`
      + `${conflictCellLines(skipped).join(';')}。`;

  // ── 开工 ────────────────────────────────────────────────────────────────
  if (firstStart) desk.bind(site.key, anchor);
  const roadmark = firstStart
    ? '我已经把开工位置写入施工绑定；现在我要用 mc_map 的 set 给这处工地登记名字和锚点，免得之后忘了在哪。'
    : '';
  const done = new Set(diff.doneSteps);
  const todo = site.plan.steps.filter((s) => s.index < limit && !done.has(s.index));
  const cursorOf = (): number => {
    let n = 0;
    while (done.has(n)) n++;
    return n;
  };
  if (todo.length === 0) {
    desk.progress(site.key, cursorOf());
    const whole = limit >= total;
    return [
      `${head}:${whole ? '整张图' : `到第 ${call.stopAfter} 层这一段`}已经跟世界对上了,`
        + `没有要补的格${cleared > 0 ? `;我这次清掉了 ${cleared} 个冲突格,清场完成` : ';我没有改动方块'}。`,
      skipNote,
      await reclaimSiteScaffold(bot, ctx, box, ledgerBefore),
      roadmark,
    ].filter(Boolean).join('\n');
  }

  let placed = 0;
  /** 这一趟做成的是哪几步(索引);回执要点名,不然 placed 与 cursor 两个数读起来自相矛盾 */
  const placedSteps: number[] = [];
  /** 提前收工的理由;空串 = 这一趟把 todo 走完了 */
  let halt = '';
  /** 没推进的那些步:一步一条,收工时全报出来 */
  const failures: Array<{ index: number; text: string }> = [];
  let streak = 0;
  for (const step of todo) {
    checkAbort(ctx);
    let why: string | null = null;
    try {
      const gap = await runBlueprintStep(bot, step, anchor, ctx);
      if (gap !== null) why = `只放上一部分:${gap}`;
      else verifyBlueprintStepChecks(bot, step, anchor, site.plan.checks);
    } catch (err) {
      if (err instanceof Aborted) throw err;
      why = `停下了:${(err as Error).message}`;
    }
    if (why !== null) {
      // 单步失败不终止整张蓝图，继续尝试后续步骤。
      failures.push({
        index: step.index,
        text: `第 ${step.index + 1}/${total} 步(${zhName(step.item)} ${stepSpanText(step, anchor)})${why}`,
      });
      streak++;
      if (streak >= BLUEPRINT_FAIL_STREAK) { halt = `连着 ${streak} 步没推进,先收工`; break; }
      continue;
    }
    streak = 0;
    done.add(step.index);
    placed++;
    placedSteps.push(step.index);
    ctx.progress?.(placed, todo.length);
  }
  const cursor = cursorOf();
  // 进度是**机械变化**:写回缓存,但一个字都不催她去改笔记(PWSR 收紧第二条)
  desk.progress(site.key, cursor);

  // ── 回读验收(完成或阶段停都做) ────────────────────────────────────────
  const entries: ReadbackEntry[] = [];
  let capped = false;
  for (const step of site.plan.steps) {
    if (!done.has(step.index)) continue;
    for (let y = step.from[1]; y <= step.to[1] && !capped; y++) {
      for (let z = step.from[2]; z <= step.to[2] && !capped; z++) {
        for (let x = step.from[0]; x <= step.to[0]; x++) {
          if (entries.length >= BLUEPRINT_READBACK_CAP) { capped = true; break; }
          const pos = toWorld(anchor, [x, y, z]);
          const state = worldStateAt(bot, { x: pos[0], y: pos[1], z: pos[2] });
          entries.push({
            pos,
            expected: readbackState(step.state),
            actual: state === null ? null : readbackState(state),
          });
        }
      }
    }
  }
  // 从部件(门上半格、床头)不单独出步,但漏了它就是没完成:主部件那一步认了才核对
  for (const check of site.plan.checks) {
    if (!done.has(check.mainStep) || entries.length >= BLUEPRINT_READBACK_CAP) continue;
    const pos = toWorld(anchor, check.pos);
    const state = worldStateAt(bot, { x: pos[0], y: pos[1], z: pos[2] });
    entries.push({
      pos,
      expected: readbackState(check.state),
      actual: state === null ? null : readbackState(state),
    });
  }
  const back = summarizeReadback(entries);
  const drift = Object.entries(back.driftProperties)
    .sort((l, r) => r[1] - l[1]).slice(0, 2)
    .map(([what, n]) => `${what}×${n}`).join('、');
  const failed = back.failedSamples.slice(0, 3).map((e) =>
    `${cellText({ x: e.pos[0], y: e.pos[1], z: e.pos[2] })} 该是 ${e.expected},现在是 ${e.actual ?? '读不到'}`);
  const readback = entries.length === 0
    ? ''
    : `回读 ${back.exact}/${back.total} 格逐格全同`
      + `${back.drift > 0 ? `,drift ${back.drift}${drift ? `(${drift})` : ''}` : ''}`
      + `${back.failed > 0 ? `,失败 ${back.failed}(${failed.join(';')})` : ''}`
      + `${capped ? `(只回读了前 ${BLUEPRINT_READBACK_CAP} 格)` : ''}。`;

  // 回收放在回读之后:回读量的是施工结果,垫脚不该混进那一笔
  const reclaimed = await reclaimSiteScaffold(bot, ctx, box, ledgerBefore);

  const progress = blueprintProgress(site.plan.steps, cursor);
  const stillMissing = blueprintBillText(
    site.plan.steps.filter((s) => !done.has(s.index)),
    carriedTally(bot), desk.stored(),
  );
  const left = total - cursor;
  if (failures.length > 0) {
    ctx.partial?.(`蓝图「${site.key}」还差 ${left} 步没完成(游标 ${cursor}/${total})`);
  }
  const failNote = failures.length === 0
    ? ''
    : `没推进 ${failures.length} 步:${failures.slice(0, 5).map((f) => f.text).join(';')}`
      + `${failures.length > 5
        ? `;另有第 ${failures.slice(5).map((f) => f.index + 1).join('、')} 步同样没推进`
        : ''}${halt ? `。${halt}` : ''}。`;
  const stopNote = call.stopAfter !== undefined && failures.length === 0 && cursor >= limit
    ? `按你说的停在第 ${call.stopAfter} 层(第 ${limit}/${total} 步)`
    : '';
  const doneNote = failures.length === 0 && !stopNote && cursor >= total ? '整张图施工完了' : '';
  // 完工后写入长期成果登记；activeSites 在施工游标完成时结束。
  if (cursor >= total) noteBlueprintWork(bot, ctx, site, anchor);
  // placed 计已完成步骤，不要求连续；cursor 是 done 的连续前缀长度，两者分别报告。
  const placedList = placedSteps.length === 0 ? ''
    : `(第 ${placedSteps.slice(0, 8).map((i) => i + 1).join('、')} 步`
      + `${placedSteps.length > 8 ? ` 等 ${placedSteps.length} 步` : ''})`;
  // 游标停在哪一步、为什么停:第 cursor+1 步没做成,它后面做成的都不计进游标。
  // 「放上了 4 步而游标只到 3」不是数字打架,是这一句没说出口
  const gapNote = cursor < limit
    ? `;游标卡在第 ${cursor + 1} 步没做成上,排在它后面的步就算放上了也不往前推游标`
    : '';
  return [
    `${head}:我这一趟放上了 ${placed} 步${placedList}`
      + `,游标到 ${cursor}/${total}`
      + `(${Math.round(progress.ratio * 100)}%${progress.layer.y === null ? '' : `,正在第 ${progress.layer.y} 层`})`
      + `${gapNote}`
      + `${doneNote ? `,${doneNote}` : ''}${stopNote ? `,${stopNote}` : ''}。`,
    failNote,
    cleared > 0 ? `开工前清掉了 ${cleared} 个冲突格。` : '',
    skipNote,
    readback,
    reclaimed,
    left > 0 ? `还剩 ${left} 步;料:${stillMissing}。` : '',
    unknownNote ? `${unknownNote.replace(/^;/, '')}。` : '',
    `我现在在 ${cellText(feetOf(bot))}`,
    roadmark,
  ].filter(Boolean).join('\n');
}

