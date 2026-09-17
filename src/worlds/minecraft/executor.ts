/**
 * 异步执行器:任务队列 + 代码技能库 + 自保反射。
 *
 * mc_do 的契约在这里落地:排队立即返回,技能后台跑,完成/受阻/被抢占一律经
 * report 回调交给 World 转成 minecraft.task 事件。一件做完接着做下一件;
 * 反射不经 LLM,做了什么事后汇报。技能一律经 `getBot()` 现取 bot(重连后实例会换)。
 *
 * 技能的契约面(SkillCall/parseSteps/SKILL_DOC/schema)住在 skills.ts 的注册表里,
 * 长出新技能时四面同步;这里只管执行。公共面经本文件转口,调用方不必分辨两处。
 */
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { Logger } from '../../core/types.ts';
import { nowIso } from '../../core/util.ts';
import type { MinecraftLog } from './log.ts';
import {
  BLOCK_FACES, cellOnFace, rasterize, resolveAnchors,
  type Anchor, type AnchorCoord, type BlockFace, type BoxFill, type Cell, type ShapeName,
} from './geometry.ts';
import {
  CHEST_BLOCKS, ChestBook, FURNACE_BLOCKS, chestBlockName,
  hasItem, hasRoom, matchItemName, matchMaterialName, type ChestRecord,
} from './chests.ts';
import { worksNote, WorksBook, type WorkHit } from './works.ts';
import {
  DRINKABLES, readDurability, readEnchants, readPotionId,
  type EnchantRegistry, type ItemEnchant, type ItemLike,
} from './item-facts.ts';
import {
  itemMatchesPick, pickLabel, pickMissText, pickTargetOf, pickedText, type PickTarget,
} from './item-pick.ts';
import {
  FEED_ITEMS, TAME_ITEMS, dyeColorOf, readHorseTamed, readSaddled, readSheepColor, readSitting, readTamedBy, tamedByMe,
} from './entity-facts.ts';
import { roman, zhDimension, zhEnchant, zhEntity, zhName } from './names.ts';
import {
  CROP_MAX_AGE, DIRECTIONS, DIRECTION_ZH, bearing, biomeAt, canSeeBlockAt, canSeeEntity,
  bodyInWater, cropAgeAt, droppedStackOf, findEscapeCell, hazardTouch, hazardsWithin, headInWater,
  isDark, isNight, narrateInventory, nearestHazard, pocketScan, sampleLight, villagerNote, WATER_BLOCKS,
  type Direction, type HazardCell, type ItemStack,
} from './terrain.ts';
import {
  FIND_STATIC_MAX, NEAR_DEFAULT, PROBE_WHERE_SHOWN, UNTIL_CATEGORIES, UNTIL_CATEGORY_DOC,
  type AttackMode, type Expectation, type QueueMode, type SkillCall,
} from './skills.ts';
import {
  FALLBACK_DEFAULTS, isGravityBlock, isSpawnAnchorBlock,
  type PolicyDefaults, type PolicySettings,
} from './policy.ts';
import { HOE_TILLED, SHOVEL_PATH, blockStateItem } from './blueprint-registry.ts';
import { ShowPacer, type ShowTempo } from './show.ts';
import {
  PLAYER_SLOTS, edibleInBag, notFoodText, precheckSteps, renderPrecheckNotes, type PrecheckDeps,
} from './precheck.ts';
import { normalizeDimension } from './escape.ts';
import { isBabyPiglin, piglinIsHostile } from './piglin.ts';
import {
  blockIdOf, normalizeBlockName, renderLayerMap,
  type NormalizedBlueprint, type PositionXYZ,
} from './blueprint.ts';
import {
  billForSteps, blueprintProgress, blueprintStepStateMatches, diffBlueprint, renderBlueprintAdvisories,
  stepCountThroughLayer, stepToBuildCall, summarizeReadback, toWorld,
  type BlueprintCheckCell, type BlueprintConflict, type BlueprintDiff, type BlueprintPlan, type BlueprintStep,
  type ItemTally, type ReadbackEntry,
} from './blueprint-plan.ts';
import {
  HYBRID_MELEE_AT, KITE_MAX_RANGE, KITE_MIN_RANGE,
  bestRangedWeapon, chooseHybridWeapon, hasRangedLos, hasUsableArrows,
  type BowEvent, type BowShotResult, type HybridWeapon, type RangedTarget,
} from './ranged.ts';
import { FindObservationCache, type FindKind, type SearchScope } from './search-observation.ts';
import {
  Aborted, SkillBlocked, SkillNoop, checkAbort, dangerNoteText, sleep,
  type BlueprintDesk, type BlueprintSite, type BlueprintSurvey, type BodyStateProbe,
  type MarkDesk, type ProbeMemo, type ReserveHit, type ResourcePlacementGate,
  type ResourcePlacementPermit, type ResourcePlacementPreview, type RouteProbe,
  type SkillContext, type TargetDiag, type TaskAttackLease, type TaskRangedActions,
  type ToolTrace,
} from './skill-context.ts';

const { goals } = pathfinderPkg;

export {
  NEAR_DEFAULT, parseNoteText, parseQueueMode, parseScoutSteps, parseSteps,
  QUEUE_MODES, QUEUE_SCHEMA,
  SCOUT_SKILL_DOC, SCOUT_SKILL_NAMES, SCOUT_STEP_SCHEMA,
  SKILL_DOC, SKILL_NAMES, SKILL_STEP_SCHEMA,
} from './skills.ts';
export type {
  Expectation, MarkLookup, ParseNote, QueueMode, SkillCall, StepBounds,
} from './skills.ts';
export { dangerNoteText } from './skill-context.ts';
export { describeSkill, zhErrorText } from './receipt.ts';
export { dropOwnedGoal, goalOwnerKind, releaseBody, renderRouteMenu, setOwnedGoal } from './travel.ts';
export { HOSTILE, bestWeapon, meleeCooldownMs } from './melee.ts';
export {
  findFishingSpot, fishWaitMs, isOpenFishingWater, planFishingCasts,
} from './skills-gather.ts';
export type {
  BlueprintDesk, BlueprintSurvey, MarkDesk, ResourcePlacementGate, ResourcePlacementPermit,
  RouteProbe, TargetDiag,
} from './skill-context.ts';
import {
  AIR_NAMES, BUILD_CELL_CAP, EXCAVATE_CELL_CAP, FACE_TRY_ORDER, FACE_ZH, LIQUIDS, NEIGHBORS6,
  NO_PLACE_REFERENCE, PLACE_REACH, PROBE_CELLWISE_MAX, PROBE_CELL_CAP, PROBE_WHERE_CELL_CAP,
  SHAPE_ZH, blockAtCell, blockNamesOf, cellKeyOf, cellText, chebyshev, cropAgeOfCell, faceText,
  feetOf, fnv32, nearLavaAt, readRegion, refAt, refCellOf, resolveAt, shapeCells, skyBlocked,
  solidAt, surfaceFeetAt, type RegionReading,
} from './cell-facts.ts';
import {
  CRAFT_SETTLE_MS, INVENTORY_SLOTS, PICKUP_SETTLE_MS, askedLabel, awaitCraftGain, awaitInvConfirm,
  dropNamesOf, invCount, invCountById, invCountIn, invGains, invGainsSplit, invItemNamed,
  invLosses, invSnapshot, itemAsked, itemPredOf, lootNote, moveExactSlot, namedLike, noSuchItem,
  playerInvIn, probabilisticDropsOf, type InvItem, type InvPred,
} from './inventory.ts';
import {
  chooseTool, equipToolFor, harvestFact, minHarvestTool, miningToolPlan, nearBreak, reserveNote,
  toolTraceNote,
} from './tools.ts';
import {
  BAG_LOW_FREE, SIGN_RE, bagNow, blockedOnItems, blockedSourceOf, blockedText, describeSkill,
  gridText, signLinesText, type BlueprintCall, type ExpectVerdict, type PlaceCall, verdictNote,
  zhErrorText, zhThing,
} from './receipt.ts';
import { HANDHELD_SUFFIXES, equipDestOf } from './tools.ts';
import { dimensionOf } from './cell-facts.ts';
import { fmtDur } from './receipt.ts';
import {
  FLEE_DEADLINE_MS, clearEscapeGoalOwner, digBackoffScene, digBlock, dropGoal, escapeIntent,
  findEntity, fmtDist, gotoGoal, levelTravelGoal, matchBlockIds, readStamp, releaseBody,
  renderRouteMenu, routeNote, setOwnedGoal, type DistanceMetric, withRouteScene,
} from './travel.ts';
import {
  HOSTILE, MELEE_CHASE, MELEE_REACH, REFLEX_HURT_FALLBACK_RANGE, STRAFE_MS, aimAt,
  attackCooldownMs, attackStats, bestWeapon, forcedRangedIssue, hostilesAround, meleeSwing,
  nearestHostileTo, nearestHostileWithin, pressMelee, pressRanged, rangedBlockedText,
  rangedTargetOf, releaseMelee, type HostileRead, type HurtSource, underwaterOxygenNote,
} from './melee.ts';
import {
  LEDGER_GUARD_BLOCKS, SEED_CROP, forgetPlaced, lastAteOf, ledgerBlockFact, noteAte, noteTilled,
  noteWork, placeMarksOf, placedLedgerOf, placedNote,
} from './placed-ledger.ts';
import {
  CRAFTING_STATION, FURNACE_STATION, Upkeep, buildSpots, ensureHolding, ensureStation, footprintOf,
  footprintScene, gotoPlaceable, hitboxBlocks, inBox, jumpPlaceBelow, matchPlacedMaterialName,
  materialCollides, nearestBoat, occupantOf, occupantText, occupiedByMe, permitPlacement,
  permittedStockFor, placeIntoCell, placeReferenceFace, pushPocketLine, scaffoldNames,
  siteAtCellAnywhere, siteBox, standableCell, stationNotes, stepOffCell, sweepDrops,
  type BuildSpot, type Station, type StationAt,
} from './placement.ts';
import { contentsText } from './receipt.ts';
import {
  UNTIL_DIG_RADIUS, UNTIL_TRAVEL_RADIUS, type UntilHit, untilBlockIds, untilHit, untilUnknownNote,
} from './until.ts';
import { blockProp } from './cell-facts.ts';
import { compositionText, noDropMaterials } from './receipt.ts';
import { settleOnGround } from './travel.ts';
import {
  findFishingWater, skillCollect, skillFind, skillFish, skillProbe, skillTrade,
} from './skills-gather.ts';
/**
 * 评估一步的 expect:读包、位置或方块,报达成与实测值。
 * 锚点以评估时刻脚下为原点解析;解析不出的锚点按落空处理,实测值写解析错误。
 * 物品/方块名与技能同一口径(类别名 log/planks/ore 也认)。
 */
function evaluateExpect(bot: Bot, e: Expectation, gainBase?: number): ExpectVerdict {
  if ('has' in e) {
    const n = invCount(bot, (name) => matchItemName(e.has.item, name));
    if (gainBase !== undefined) {
      const got = n - gainBase;
      return {
        met: got >= e.has.count,
        actual: `这一步进包${zhName(e.has.item)}×${got}(包里现在 ${n} 个)`,
        measured: String(got),
        gain: true,
      };
    }
    return { met: n >= e.has.count, actual: `包里${zhName(e.has.item)}×${n}`, measured: String(n) };
  }
  if ('holding' in e) {
    const held = bot.heldItem?.name ?? null;
    return {
      met: held !== null && matchItemName(e.holding.item, held),
      actual: held ? `手上是${zhName(held)}` : '手上是空的',
      measured: held ? zhName(held) : '空手',
    };
  }
  const resolved = resolveAnchors(['near' in e ? e.near : e.at], feetOf(bot));
  if (!Array.isArray(resolved)) return { met: false, actual: resolved.error, measured: resolved.error };
  const cell = resolved[0];
  if ('near' in e) {
    const feet = feetOf(bot);
    const dist = Math.hypot(feet.x - cell.x, feet.y - cell.y, feet.z - cell.z);
    // 锚点与脚下同高时报告水平距离，否则报告三维直线距离；单位为格。
    const metric: DistanceMetric = feet.y === cell.y ? '水平' : '直线';
    const shown = `${metric} ${fmtDist(Math.round(dist * 10) / 10)} 格`;
    return {
      met: dist <= (e.within ?? NEAR_DEFAULT),
      actual: `我在 ${cellText(feet)},离 ${cellText(cell)} 还有 ${shown}`,
      measured: shown,
    };
  }
  const block = blockAtCell(bot, cell);
  if (!block) return { met: false, actual: `${cellText(cell)} 那里区块没加载`, measured: '区块未加载' };
  return {
    met: matchPlacedMaterialName(bot, e.block, block.name),
    actual: `${cellText(cell)} 那一格是${zhName(block.name)}`,
    measured: zhName(block.name),
  };
}

/**
 * 技能的产出与入料:一张表,两个消费者 —— 裁决按产出推后置状态(deriveExpect),
 * 依赖闸按「后一步的入料 ∩ 前一步的产出」判因果。两半各自单独查得到。
 *
 * 名字一律是**物品 id 口径**:collect 给的是掉落物名(挖 stone 进包的是 cobblestone,
 * 按方块名去数永远数出 0)。只有服务端才知道的一律给空表 —— smelt 的产物名要等
 * 输出槽第一次出东西、craft 摆格子的产出槽出什么算什么、fish 钓上来什么不定。
 * `bot` 为 null 时只回调用里写得出的那些(掉落表与配方表都在 registry 上)。
 */
export function skillProduces(call: SkillCall, bot: Bot | null): string[] {
  switch (call.skill) {
    case 'collect': {
      const item = bot ? collectDropName(bot, call.block) : call.block;
      return item ? [item] : [];
    }
    case 'craft': return !call.grid && call.item ? [call.item] : [];
    // at 形态是掏空那一格容器,取出来什么开窗才知道
    case 'take': return call.item ? [call.item] : [];
    case 'pickup': return call.item ? [call.item] : [];
    default: return [];
  }
}

/** 同上的另一半:这一步要消耗的东西。craft 的直接材料在配方表里,没有 bot 就报不出 */
export function skillNeeds(call: SkillCall, bot: Bot | null): string[] {
  switch (call.skill) {
    // 蓝图形态要哪些料由图说了算(一整张图十几样),不进因果闸这张窄表
    case 'build': return 'material' in call ? [call.material] : [];
    case 'craft': {
      if (call.grid) return [...new Set(call.grid.flat().filter((n) => n !== ''))];
      return bot && call.item ? craftInputNames(bot, call.item) : [];
    }
    case 'smelt': return [call.input, call.fuel];
    case 'brew': return [call.input, call.bottle, call.fuel];
    case 'enchant': return [call.item, LAPIS];
    case 'anvil': return call.with ? [call.item, call.with] : [call.item];
    case 'grindstone': return call.with ? [call.item, call.with] : [call.item];
    // 驾猪要手持胡萝卜钓竿(不消耗,但没有它这一步走不了)
    case 'ride': return call.to && call.target === 'pig' ? ['carrot_on_a_stick'] : [];
    // 拴上那一下要包里有绳(会被消耗成拴在它身上的那根);松开／牵着走都不再要
    case 'lead': return call.target ? [LEAD_ITEM] : [];
    case 'use': return call.item ? [call.item] : [];
    case 'equip': return call.item ? [call.item] : [];
    case 'eat': return [call.item];
    case 'toss': case 'stow': return [call.item];
    default: return [];
  }
}

/**
 * collect 一块 `block` 可能进包的所有掉落名;只给因果闸用。裁决用的 collectDropName
 * 在多样掉落时报 null(数不准就不数),而「后一步要不要用这一步的产出」只问有没有:
 * 小麦掉小麦+种子,搓面包用的正是那份小麦。
 */
function collectDropNamesAll(bot: Bot, block: string): string[] {
  const byName = bot.registry.blocksByName as unknown as
    Record<string, { name?: string; drops?: unknown[] } | undefined> | undefined;
  if (!byName) return [];
  const items = bot.registry.items as unknown as Record<number, { name: string } | undefined>;
  const dropsOf = (def: { drops?: unknown[] } | undefined): string[] => (def?.drops ?? [])
    .map((d) => (typeof d === 'number' ? d : (d as { drop?: number } | null)?.drop))
    .map((id) => (id === undefined ? null : items[id]?.name ?? null))
    .filter((n): n is string => n !== null);
  const def = byName[block];
  if (def) return [...new Set(dropsOf(def))];
  const names = new Set<string>();
  for (const d of Object.values(byName)) {
    if (d?.name && matchItemName(block, d.name)) for (const n of dropsOf(d)) names.add(n);
  }
  return [...names];
}

/**
 * 未声明 needs 时，依赖本步消耗与更早步骤产出有交集的那些步骤。
 * 物品名经 matchItemName 双向匹配，兼容类别名与具体名称。
 */
export function causalNeeds(
  steps: readonly SkillCall[],
  index: number,
  bot: Bot | null,
): Array<{ step: number; items: string[] }> {
  const needs = skillNeeds(steps[index], bot);
  if (needs.length === 0) return [];
  const out: Array<{ step: number; items: string[] }> = [];
  for (let j = 0; j < index; j++) {
    const prev = steps[j];
    const produces = prev.skill === 'collect' && bot ? collectDropNamesAll(bot, prev.block) : skillProduces(prev, bot);
    const meet = [...new Set(needs.filter((n) =>
      produces.some((p) => matchItemName(n, p) || matchItemName(p, n))))];
    if (meet.length > 0) out.push({ step: j + 1, items: meet });
  }
  return out;
}

/**
 * collect 一块 `block` 进包的是什么。照 minecraft-data 自己的掉落表正向查,
 * 不写死 cobblestone→stone 这类映射。掉落表为空(草掉种子这类概率掉落)或不止一样时
 * 返回 null —— 数不准就不数。
 *
 * 类别名(log/ore/wool)不在方块表里,**只有整类都掉自己时**才按类别名数:`log` 掉的是
 * `oak_log`(matchItemName 认得出),而 `ore` 掉的是煤与原矿、`leaves` 干脆什么都不掉,
 * 拿类别名去数它们永远数出 0。
 */
function collectDropName(bot: Bot, block: string): string | null {
  // 推导不许抛:裁决点有一处在 catch 分支里,从那儿抛出去就是整条任务再不回执
  const byName = bot.registry.blocksByName as unknown as
    Record<string, { name?: string; drops?: unknown[] } | undefined> | undefined;
  if (!byName) return null;
  const soleDrop = (def: { drops?: unknown[] } | undefined): string | null => {
    const drops = def?.drops ?? [];
    if (drops.length !== 1) return null;
    const d = drops[0];
    const id = typeof d === 'number' ? d : (d as { drop?: number } | null)?.drop;
    if (id === undefined) return null;
    return (bot.registry.items as unknown as Record<number, { name: string } | undefined>)[id]?.name ?? null;
  };
  const def = byName[block];
  if (def) return soleDrop(def);
  const members = Object.values(byName)
    .filter((d): d is { name: string; drops?: unknown[] } => !!d?.name && matchItemName(block, d.name));
  if (members.length === 0) return null;
  return members.every((m) => {
    const name = soleDrop(m);
    return name !== null && matchItemName(block, name);
  }) ? block : null;
}

/** craft 的直接材料:同一样东西的几种摆法各要什么,取并集(哪一条走得通由技能自己挑) */
function craftInputNames(bot: Bot, item: string): string[] {
  const def = craftItemDef(bot, item);
  if (!def) return [];
  const items = bot.registry.items as unknown as Record<number, { name: string } | undefined>;
  const all = bot.recipesAll(def.id, null, true as never) as unknown as CraftRecipeLike[];
  const names = new Set<string>();
  for (const r of all) for (const [id] of craftNeeds(r)) {
    const n = items[id]?.name;
    if (n) names.add(n);
  }
  return [...names];
}

/**
 * 未声明 expect 时按技能推导后置状态；推不准返回 null，交给技能裁决。
 * 相对锚点不推导，因开工与核验时的位置可能不同。
 * 当前期望形态无法表达的状态不推导；equip 的 holding 只覆盖手持，不覆盖盔甲和盾。
 */
export function deriveExpect(bot: Bot, call: SkillCall): Expectation | null {
  if ('dryRun' in call && call.dryRun) return null; // 试算不动世界,没有后置状态
  switch (call.skill) {
    case 'goto': {
      const [x, y, z] = call.at;
      if (typeof x !== 'number' || typeof z !== 'number') return null;
      // [x,z] 形态的 y 是执行那一刻的地表读数、调用里根本没有;`~` 让它按脚下解析,
      // 判定就收成了纯水平距离。缺省半径 2 对 goto 自己的 GoalNear(1) 留一格余量
      if (call.groundY) return { near: [x, '~', z] };
      return typeof y === 'number' ? { near: [x, y, z] } : null;
    }
    case 'tunnel': {
      // 声明了 until:终点不再是判据 —— 碰到名单里的东西提前收束是这一单的正常结局,
      // 拿「人到终点」去核验会把她要的那个结果判成落空
      if (call.until && call.until.length > 0) return null;
      if (!absAnchor(call.at)) return null;
      // 终点为当前脚下格时，near 恒真，不能用于核验是否挖通；冻结后的相对锚点也适用。
      const c = anchorCell(call.at);
      const p = bot.entity?.position;
      if (p && Math.floor(p.x) === c.x && Math.floor(p.y) === c.y && Math.floor(p.z) === c.z) return null;
      return { near: call.at };
    }
    // collect.count 计方块，掉落数量、名称及归属均可能不同，因此不推导物品存量期望。
    // 技能按块数与入包数回报；craft.count 计产出物品，可在下方推导。
    case 'collect': return null;
    case 'craft': {
      const item = skillProduces(call, bot)[0];
      return item ? { has: { item, count: call.count } } : null;
    }
    case 'build': {
      const cell = soleBuildCell(call);
      if (!cell || !('material' in call)) return null;
      // 落地的方块名不一定等于材料名(火把贴墙成 wall_torch),matchItemName 收得住;
      // 但材料本身得是个方块 —— 种子放下去长出来的是 wheat,按 wheat_seeds 比对必然落空
      if (!(bot.registry.blocksByName as unknown as Record<string, unknown> | undefined)?.[call.material]) return null;
      return { block: call.material, at: [cell.x, cell.y, cell.z] };
    }
    case 'excavate': {
      // 锚点全同才推:那时候不论什么形状都只有这一格,不必栅格化(受阻分支上还要再算一遍,
      // 一个大 box 在这儿铺开就是白烧)。多格的挖不完是正常结局,技能自己按块数报
      const cell = soleAnchorCell(call.anchors);
      return cell ? { block: 'air', at: [cell.x, cell.y, cell.z] } : null;
    }
    // use 的判据是 (item, 目标方块) → 后置读数那张表,住在 use 自己那儿
    case 'use': return null;
    case 'equip': {
      // 腾手(不写 item)不推:副手与装备槽不动的语义由技能自己说
      if (!call.item) return null;
      const found = invItemNamed(bot, call.item);
      // 落在装备槽的(盔甲/鞘翅/盾)不在手上,holding 判不了;包里没有的也不推,
      // 让「包里没有X」自己说话
      if (!found || equipDestOf(found.name, bot.registry) !== 'hand') return null;
      return { holding: { item: found.name } };
    }
    default: return null;
  }
}

/** 采集开工前的库存基线，用于核验本步增量；显式 expect 按其声明语义处理。 */
function collectGainBase(bot: Bot, call: SkillCall): number | null {
  if (call.skill !== 'collect' || call.expect !== undefined) return null;
  const e = deriveExpect(bot, call);
  return e && 'has' in e ? invCount(bot, (name) => matchItemName(e.has.item, name)) : null;
}

/**
 * 推导的 near/block 状态可将技能受阻改判为完成；has 存量不能证明本步增量。
 * 显式声明的 expect 按调用方判据裁决。
 */
function mayOverturnBlocked(e: Expectation): boolean {
  return !('has' in e);
}

/** 三个分量都是数字 = 绝对坐标,两次解析指的是同一格 */
function absAnchor(a: Anchor): boolean {
  return a.every((c) => typeof c === 'number');
}

function anchorCell(a: Anchor): Cell {
  return { x: a[0] as number, y: a[1] as number, z: a[2] as number };
}

/** 只有一处、且是绝对坐标时的那一格;否则 null */
function soleAnchorCell(anchors: readonly Anchor[]): Cell | null {
  if (anchors.length === 0 || !anchors.every(absAnchor)) return null;
  const first = anchorCell(anchors[0]);
  return anchors.every((a) => {
    const c = anchorCell(a);
    return c.x === first.x && c.y === first.y && c.z === first.z;
  }) ? first : null;
}

/**
 * build 这一单只落一格时,落在哪。贴面形态的落点是「参照方块 + 面向量」,
 * 格子形态的落点就是锚点本身;形状形态与多格形态都不推 —— 搭了多少报多少是
 * 它的正常结局(README「一块都没放上才是受阻」)。
 */
function soleBuildCell(call: Extract<SkillCall, { skill: 'build' }>): Cell | null {
  // 蓝图形态一单就是几十上百步,「只落一格」这个前提根本不成立
  if ('blueprint' in call) return null;
  if ('on' in call) {
    if (call.on.length !== 1 || !absAnchor(call.on[0].at)) return null;
    return cellOnFace(anchorCell(call.on[0].at), call.on[0].face);
  }
  if (call.shape) return null;
  return soleAnchorCell(call.anchors);
}

/** 运行中步骤的周期进度间隔;每份带位置与净位移,agent 据此自行判断有没有卡住 */
const PROGRESS_EVERY_MS = 30_000;

/** 「同一件事上次什么下场」的有效期:再往前的账她多半已经换了打法 */
const PRIOR_OUTCOME_WINDOW_MS = 15 * 60_000;

/** 受阻头名的统计窗口与起报门槛(见 Executor.blockedHeadline) */
const BLOCKED_HEADLINE_WINDOW_MS = 60 * 60_000;
const BLOCKED_HEADLINE_MIN = 5;

/** 陆上 surface 一次爬升的时限;到点如实报爬到哪 */
const SURFACE_CLIMB_MS = 90_000;

/**
 * 陆上 surface:头顶有实心遮盖就挖开头顶两格再垫脚上一格,循环到露天。
 * 头顶压着液体不捅穿;挖不动(基岩)、没垫脚方块、限时到,都带着已爬格数受阻。
 */
async function skillSurfaceLand(bot: Bot, ctx: SkillContext): Promise<string> {
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
function hasDryFooting(bot: Bot): boolean {
  const entity = bot.entity as Bot['entity'] & { isInWater?: boolean; isInLava?: boolean };
  return entity.onGround
    && entity.isInWater !== true
    && entity.isInLava !== true
    && !headInWater(bot)
    && !bodyInWater(bot);
}

/** surface 的可观测后置条件；水中分支的成功不蕴含看得到天空。 */
function surfaceStateText(bot: Bot): string {
  const feet = feetOf(bot);
  const outOfLiquid = !headInWater(bot) && !bodyInWater(bot);
  const standing = hasDryFooting(bot);
  const skyVisible = !skyBlocked(bot, feet.x, feet.y + 2, feet.z);
  const finalY = Number(bot.entity.position.y.toFixed(2));
  return `out_of_liquid=${outOfLiquid},standing=${standing},sky_visible=${skyVisible},final_y=${finalY}`;
}

async function stableDryFooting(bot: Bot, ctx: SkillContext): Promise<boolean> {
  if (!hasDryFooting(bot)) return false;
  await sleep(300);
  checkAbort(ctx);
  return hasDryFooting(bot);
}

async function skillBuild(bot: Bot, call: PlaceCall, ctx: SkillContext): Promise<string> {
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
function pillarStandNote(bot: Bot, cells: readonly Cell[]): string | null {
  const [c0] = cells;
  if (cells.length < 2 || !cells.every((c) => c.x === c0.x && c.z === c0.z)) return null;
  const feet = feetOf(bot);
  if (feet.x === c0.x && feet.z === c0.z) return null;
  return `这一根立在 (${c0.x}, ${c0.z}) 那一列,人不在它上面(横着差 ` +
    `${Math.round(Math.hypot(feet.x - c0.x, feet.z - c0.z))} 格),中间是空的;` +
    '要站上自己搭的那一根,用 tunnel 的塔(at 放正上方、不带 spiral)';
}

/** 门框材料集合；放置回执须区分黑曜石与哭泣的黑曜石。 */
const PORTAL_FRAME_MATERIALS = new Set(['obsidian', 'crying_obsidian']);

/**
 * 门框那一批放完之后的机械核对:逐格回读真名,报「实际是:黑曜石×N」。
 * 走 registry 的精确名比对,不经 matchMaterialName —— 这一句的价值全在它不模糊。
 */
function portalFrameTally(bot: Bot, material: string, placedKeys: readonly string[]): string | null {
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
const BLUEPRINT_READBACK_CAP = 4096;
/** dryRun 的逐层字符图最多打几行(含图例);再多她读不完,也是常驻上下文开销 */
const BLUEPRINT_MAP_ROWS = 40;
/** 连着这么多步没推进就提前收工:再往下多半是同一处障碍,空转的每一步都是钱 */
const BLUEPRINT_FAIL_STREAK = 5;
/** 清场受阻时最多把几段 excavate 回执并进现场;再多是常驻上下文开销 */
const CLEAR_NOTE_CAP = 4;

/**
 * 清场回读后允许再清一轮的残留上限。超过它就抛:那说明拖住清场的不是蔓延速度,
 * 再清一轮也追不上。轮数硬上限一轮 —— 无上限的重试就是真死循环。
 */
const CLEAR_RESIDUE_CAP = 5;

/** 抛错时残留格最多逐格列几行;剩下的报个数,不无界往上下文里灌 */
const CLEAR_RESIDUE_LIST_CAP = 24;

/** 残留格逐格摆出来:哪一格、现在是什么、该是什么 */
function conflictCellLines(conflicts: readonly BlueprintConflict[]): string[] {
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
const CLEAR_BLOCK_MARKS = ['够不着', '没动它', '根本挖不动', '紧贴着岩浆', '挖了不掉东西'];

/**
 * 世界那一格的完整状态串(属性名排序,与蓝图侧的规范化同一口径)。
 * 回读三分类要它 —— 只比 type 分不出「楼梯朝向被服务端改了」与「根本没完成」。
 */
function worldStateAt(bot: Bot, cell: Cell): string | null {
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
const SELF_COMPUTED_PROPS = new Set(['north', 'south', 'east', 'west', 'up', 'shape', 'in_wall']);

/** 回读比对用的状态串:摘掉邻接自算的属性,别的照比 */
function readbackState(state: string): string {
  const at = state.indexOf('[');
  if (at === -1) return normalizeBlockName(state);
  const id = normalizeBlockName(state.slice(0, at));
  const kept = state.slice(at + 1, -1).split(',')
    .filter((p) => !SELF_COMPUTED_PROPS.has(p.slice(0, p.indexOf('='))));
  return kept.length === 0 ? id : `${id}[${kept.join(',')}]`;
}

/** 一步落在世界的哪几格:单格报一格,多格报两端 */
function stepSpanText(step: BlueprintStep, anchor: PositionXYZ): string {
  const from = toWorld(anchor, step.from);
  const to = toWorld(anchor, step.to);
  const one = from.every((v, i) => v === to[i]);
  const cell = (p: PositionXYZ): string => cellText({ x: p[0], y: p[1], z: p[2] });
  return one ? cell(from) : `${cell(from)}–${cell(to)}`;
}

/** 背包现读成 ItemTally(三分账单的「随身」一栏) */
function carriedTally(bot: Bot): ItemTally {
  return Object.fromEntries(invSnapshot(bot));
}

/** 三分账单渲染:缺的排前面,只报前几样 */
function blueprintBillText(steps: readonly BlueprintStep[], carried: ItemTally, stored: ItemTally): string {
  const bill = billForSteps(steps, { carried, stored });
  if (bill.lines.length === 0) return '这一段一块都不用放';
  const lines = bill.lines.slice(0, 5).map((l) =>
    `${zhName(l.item)} 要 ${l.need}(随身 ${l.carried}、在箱 ${l.stored}`
    + `${l.missing > 0 ? `、还缺 ${l.missing}` : '、够了'})`);
  const rest = bill.lines.length > 5 ? `;另有 ${bill.lines.length - 5} 样` : '';
  return `${lines.join(';')}${rest}`;
}

/** 「能连着施工到第 k/N 步(到第 y 层)」;层号按那一步所在的层报 */
function reachText(steps: readonly BlueprintStep[], reach: number, total: number, base: number): string {
  if (steps.length === 0) return '这一段没有成形步骤';
  if (reach === 0) return '手上的料一步都不够,第一步就得停';
  const last = steps[reach - 1];
  return `手上的料能连着施工到第 ${base + reach}/${total} 步(第 ${last.y} 层)`;
}

function blueprintCellCount(blueprint: NormalizedBlueprint): number {
  return blueprint.layers.reduce(
    (total, layer) => total + layer.reduce((rows, row) => rows + row.length, 0),
    0,
  );
}

function readBlueprintWorld(bot: Bot, site: BlueprintSite, anchor: PositionXYZ): BlueprintDiff {
  return diffBlueprint(
    site.blueprint,
    site.plan,
    anchor,
    (x, y, z) => worldStateAt(bot, { x, y, z }),
    { checkAir: true, sampleLimit: blueprintCellCount(site.blueprint) },
  );
}

function surveyFromDiff(diff: BlueprintDiff): BlueprintSurvey {
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
function conflictRuns(conflicts: readonly BlueprintConflict[]): Array<[PositionXYZ, PositionXYZ]> {
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
async function clearBlueprintConflicts(
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

function stepWorldCells(step: BlueprintStep, anchor: PositionXYZ): PositionXYZ[] {
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
function noteBlueprintWork(bot: Bot, ctx: SkillContext, site: BlueprintSite, anchor: PositionXYZ): void {
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

function blueprintCellDone(bot: Bot, step: BlueprintStep, pos: PositionXYZ): boolean {
  const actual = worldStateAt(bot, { x: pos[0], y: pos[1], z: pos[2] });
  return actual !== null && blueprintStepStateMatches(step, actual);
}

function verifyBlueprintStepChecks(
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

async function runBlueprintStep(
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
async function withBlueprintGain(
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
async function reclaimSiteScaffold(
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

async function skillBuildBlueprint(
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

/** 按形状清空间:自上而下、近的先;液体不按方块挖。 */
async function skillExcavate(bot: Bot, call: Extract<SkillCall, { skill: 'excavate' }>, ctx: SkillContext): Promise<string> {
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
type SpiralCorner = readonly [number, number];
const SPIRAL_CORNERS: readonly SpiralCorner[] = [[0, 0], [-1, 0], [0, -1], [-1, -1]];

/** 井筒的四根角柱,按绕行顺序排,脚下这一格排在第 0 位 */
function spiralQuad(start: Cell, corner: SpiralCorner): Array<{ x: number; z: number }> {
  const [bx, bz] = [start.x + corner[0], start.z + corner[1]];
  const ring = [{ x: bx, z: bz }, { x: bx + 1, z: bz }, { x: bx + 1, z: bz + 1 }, { x: bx, z: bz + 1 }];
  const at = ring.findIndex((c) => c.x === start.x && c.z === start.z);
  return [...ring.slice(at), ...ring.slice(0, at)];
}

function spiralFoot(start: Cell, i: number, up: boolean, corner: SpiralCorner): Cell {
  const col = spiralQuad(start, corner)[i % 4];
  return { x: col.x, y: start.y + (up ? i : -i), z: col.z };
}

/** 螺旋楼梯全程要挖的格子(每步 3 格),供试算与「接下来要挖的格子」名单用 */
function spiralCells(start: Cell, steps: number, up: boolean, corner: SpiralCorner): Cell[] {
  const out: Cell[] = [];
  for (let i = 1; i <= steps; i++) {
    const f = spiralFoot(start, i, up, corner);
    out.push(f, { x: f.x, y: f.y + 1, z: f.z }, { x: f.x, y: f.y + 2, z: f.z });
  }
  return out;
}

/** 第一圈按已有实心、可垫脚、液体或身体占位排序选择井筒方向；同分取 +x/+z。 */
function pickSpiralCorner(bot: Bot, start: Cell, up: boolean, steps: number): SpiralCorner {
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
function miningToolPlanNotes(
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
const TRANSIT_BOUNDARY_BLOCKS = new Set([
  'nether_portal', 'end_portal', 'end_gateway', 'end_portal_frame',
]);

/** 挖不动(或慢到不值当)就停下的硬块。只陈述挖不动这件事,不冒充维度语义。 */
const TUNNEL_HARD_BLOCKS = new Set(['obsidian', 'crying_obsidian']);

/** tunnel 撞上这一格该说的那句话;不该停就是 null */
function tunnelStopWord(name: string, cc: Cell): string | null {
  if (TRANSIT_BOUNDARY_BLOCKS.has(name)) {
    return `挖到 (${cc.x}, ${cc.y}, ${cc.z}) 的${zhName(name)}跟前,这是维度通道边界,停在这。`;
  }
  if (TUNNEL_HARD_BLOCKS.has(name)) {
    return `挖到 (${cc.x}, ${cc.y}, ${cc.z}) 的${zhName(name)}跟前,当前这把家伙挖不动它,停在这。`;
  }
  return null;
}

async function skillTunnel(bot: Bot, call: Extract<SkillCall, { skill: 'tunnel' }>, ctx: SkillContext): Promise<string> {
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

/**
 * `bot.craft` 吃的配方数据面(见 mineflayer-fixes 的覆写版):
 * 只是"哪一格放哪个 id"的摆位指令,**不是许可证** —— 产出由服务端裁决。
 */
interface CraftRecipeLike {
  result: { id: number | null; count: number };
  inShape?: Array<Array<{ id: number } | null>> | null;
  ingredients?: Array<{ id: number }> | null;
  requiresTable: boolean;
}

/** 一份配方一次要吃掉的材料(按 id 计数) */
function craftNeeds(r: CraftRecipeLike): Map<number, number> {
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
function craftItemDef(bot: Bot, item: string): { id: number; name: string } | undefined {
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
function recipeFromGrid(bot: Bot, grid: string[][]): CraftRecipeLike {
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

async function skillCraft(
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

  const gains = invGains(before, bot);
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

function nameOfId(bot: Bot, id: number): string {
  return (bot.registry.items as Record<number, { name: string }>)[id]?.name ?? '';
}

/**
 * 合成的工具或武器自动切换到主手。
 * 换手失败不回滚已完成的合成,并通过返回值报告。
 */
async function equipIfHandheld(bot: Bot, itemName: string): Promise<boolean> {
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
const EAT_SETTLE_MS = 2_500;

async function consumeHeldFood(bot: Bot, foodName: string): Promise<string> {
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

async function skillEat(bot: Bot, itemName: string): Promise<string> {
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

/** 可攻击目标名限定为实体类型 ID 或在线玩家名。 */
/** use.target 只接受活物；无效目标的回执说明可接受类型及改用 at 的方块写法。 */
function unknownUseTargetText(bot: Bot, target: string): string {
  const head = `use 的 target 只认活物(生物、玩家),「${target}」不是活物`;
  const ids = matchBlockIds(bot, target);
  if (ids.length === 0) return `${head};要右键一格方块的话写 {"skill":"use","at":[x,y,z]}`;
  // 现场恰好找得到那一格就把坐标一并给出:她照抄就能用
  const near = bot.findBlocks({ matching: ids, maxDistance: 16, count: 1 })[0] ?? null;
  if (!near) {
    return `${head},它是方块 —— 右键方块写 {"skill":"use","at":[x,y,z]};` +
      `那一格在哪先用 {"skill":"find","target":"${target}","distance":16} 问一句`;
  }
  return `${head},它是方块 —— 右键它写 {"skill":"use","at":[${near.x},${near.y},${near.z}]}` +
    `(${zhName(target)}就在那一格,16 格内看得见的最近一处)`;
}

function isKnownTarget(bot: Bot, name: string): boolean {
  const n = name.toLowerCase();
  const entities = (bot.registry as unknown as { entitiesByName?: Record<string, unknown> }).entitiesByName;
  if (entities?.[n]) return true;
  return Object.keys(bot.players ?? {}).some((p) => p.toLowerCase() === n);
}

async function skillAttack(
  bot: Bot,
  target: string,
  mode: AttackMode = 'auto',
  ctx: SkillContext,
): Promise<string> {
  if (!isKnownTarget(bot, target)) {
    throw new SkillBlocked(`不认识「${target}」这种东西,认不出要打谁`);
  }
  const entity = findEntity(bot, target, 32);
  // 要打的东西不在场 = 无事可做:没打输,是没得打(见 SkillNoop)
  if (!entity) throw new SkillNoop(`附近 32 格内没有${zhEntity(target)}`);
  const ranged = ctx.attack.ranged;
  const forcedRanged = mode === 'ranged' || mode === 'kite';
  if (forcedRanged) {
    const issue = forcedRangedIssue(bot, rangedTargetOf(entity));
    if (!ranged || issue) {
      throw new SkillBlocked(`${issue ?? '远程控制器现在不可用'};${mode} 不会改用近战`);
    }
  }
  // 血线撤退只针对可能还手的目标；玩家、敌对生物及主动攻击的普通猪灵均适用。
  const attackName = entity.name ?? '';
  const dangerous = entity.type === 'player'
    || HOSTILE.has(attackName)
    // 这一步是**主动**打它:攻击本身就是挑衅,金甲带来的中立当场作废,所以 provoked 传真
    || (attackName === 'piglin' && piglinIsHostile(bot, entity, true));
  const stats = ctx.attack.acquire(entity.id);
  const deadline = Date.now() + 45_000;
  let lastSwing = 0;
  let inMelee = false;
  let strafeLeft = false;
  let strafeAt = 0;
  let weapon: HybridWeapon = forcedRanged ? 'ranged' : 'melee';
  let desperate = false;
  let retreatFailed = false;
  const equipMelee = async (): Promise<void> => {
    ranged?.abort();
    const best = bestWeapon(bot);
    if (best) await bot.equip(best, 'hand').catch(() => undefined);
  };
  if (weapon === 'melee') await equipMelee();
  try {
    while (!stats.dead && entity.isValid && Date.now() < deadline) {
      checkAbort(ctx);
      if (stats.disconnected) throw new SkillBlocked(`连接断了,主动攻击已取消;${attackStats(stats)}`);
      const floor = ctx.fleeHealth();
      if (!desperate && dangerous && floor > 0 && (bot.health ?? 20) < floor) {
        // 撤退是任务的一部分:走完再汇报,不能丢下一个方向就报错收工
        releaseMelee(bot);
        ranged?.abort();
        ctx.escape.active = true;
        const hp = Math.ceil(bot.health ?? 0);
        const start = bot.entity.position.clone();
        const hurtMark = stats.hurts;
        const away = bot.entity.position.minus(entity.position).normalize().scaled(24);
        const dest = bot.entity.position.plus(away);
        let pathError: string | null = null;
        await gotoGoal(bot, levelTravelGoal(dest.x, dest.z), ctx).catch((error: unknown) => {
          if (error instanceof Aborted) throw error;
          pathError = error instanceof Error ? zhErrorText(error.message) : String(error);
        });
        const p = bot.entity.position;
        const moved = p.distanceTo(start);
        const distance = entity.position.distanceTo(p);
        const hurtAgain = stats.hurts > hurtMark;
        const safe = moved >= 3 && distance >= KITE_MIN_RANGE && !hurtAgain;
        if (stats.dead || !entity.isValid) break;
        if (safe) {
          throw new SkillBlocked(
            `${stats.swings > 0 ? '打到一半' : `没跟${zhEntity(target)}动手`},生命 ${hp}/20 低于撤退线;` +
              `确认撤开 ${Math.round(moved * 10) / 10} 格,现在离目标 ${Math.round(distance * 10) / 10} 格` +
              `${pathError ? `(${pathError})` : ''};${attackStats(stats)}${underwaterOxygenNote(bot)}`,
          );
        }
        // 跑不动或撤退中还在掉血时，血线的前提已经失效；本步继续持有身体回身还手。
        desperate = true;
        retreatFailed = true;
        ctx.escape.active = false;
        weapon = forcedRanged ? 'ranged' : 'melee';
        if (weapon === 'melee') await equipMelee();
        ctx.diag?.write({
          lane: 'skill', event: 'attack-cornered', taskId: ctx.taskId,
          msg: `主动攻击撤退失败:只挪 ${Math.round(moved * 10) / 10} 格${hurtAgain ? ',仍在受击' : ''},回身还手`,
          data: { target, mode, moved, distance, hurtAgain, pathError },
        });
        continue;
      }
      const d = entity.position.distanceTo(bot.entity.position);
      const rangedReady = Boolean(ranged?.ready(bot));
      const nextWeapon = forcedRanged
        ? 'ranged'
        : mode === 'melee' ? 'melee' : chooseHybridWeapon(weapon, d, rangedReady);
      if (nextWeapon !== weapon) {
        weapon = nextWeapon;
        releaseMelee(bot);
        if (weapon === 'melee') await equipMelee();
      }

      if (weapon === 'ranged') {
        inMelee = false;
        dropGoal(bot, 'task', '改用远程,寻路器让位', ctx.diag);
        if (!rangedReady || !ranged) {
          if (forcedRanged) {
            throw new SkillBlocked(`${forcedRangedIssue(bot, rangedTargetOf(entity)) ?? '远程控制器现在不可用'};${mode} 不会改用近战;${attackStats(stats)}`);
          }
          weapon = 'melee';
          await equipMelee();
          continue;
        }
        if (Date.now() >= strafeAt) {
          strafeLeft = !strafeLeft;
          strafeAt = Date.now() + STRAFE_MS;
        }
        await aimAt(bot, entity);
        pressRanged(bot, d, mode, strafeLeft);
        // kite 先把过近距离拉开；ranged/auto 只需高于弓控制器的安全下限。
        if ((mode === 'kite' && d < KITE_MIN_RANGE) || d <= HYBRID_MELEE_AT) {
          await sleep(50);
          continue;
        }
        const result = await ranged.shoot(rangedTargetOf(entity), stats.token);
        checkAbort(ctx);
        // entityDead can arrive while the bow controller is still settling its draw.
        // The target's terminal event owns that race; a late shoot result must not spend
        // an arrow in the task receipt or start a fallback attack.
        if (stats.dead) break;
        if (result.kind === 'released') {
          stats.arrows += 1;
          continue;
        }
        if (forcedRanged) {
          throw new SkillBlocked(`${rangedBlockedText(result)};${mode} 不会改用近战;${attackStats(stats)}`);
        }
        if (
          result.reason === 'aborted' &&
          ['bot_lost', 'lease', 'death', 'target_lost'].includes(result.cause ?? '')
        ) {
          throw new SkillBlocked(`${rangedBlockedText(result)};${attackStats(stats)}`);
        }
        weapon = 'melee';
        await equipMelee();
        continue;
      }

      if (d > MELEE_CHASE) {
        inMelee = false;
        releaseMelee(bot);
        await gotoGoal(bot, new goals.GoalFollow(entity, 2), ctx).catch(() => undefined);
        continue;
      }
      if (!inMelee) {
        dropGoal(bot, 'task', '够得着了,自己打', ctx.diag);
        inMelee = true;
      }
      if (Date.now() >= strafeAt) {
        strafeLeft = !strafeLeft;
        strafeAt = Date.now() + STRAFE_MS;
      }
      await aimAt(bot, entity);
      pressMelee(bot, entity, dangerous ? strafeLeft : null);
      if (d <= MELEE_REACH && Date.now() - lastSwing >= attackCooldownMs(bot)) {
        await meleeSwing(bot, entity, () => {
          stats.lastSwingAt = Date.now();
          stats.lastSwingTargetId = entity.id;
          stats.swings += 1;
        });
        lastSwing = Date.now();
      } else {
        await sleep(50);
      }
    }
  } finally {
    releaseMelee(bot);
    ranged?.abort();
    ctx.escape.active = false;
    ctx.attack.release(stats);
  }
  if (stats.dead) {
    return `打死了${zhEntity(target)}(${attackStats(stats)})${retreatFailed ? ';撤退没走开后回身打完' : ''}${underwaterOxygenNote(bot)}`;
  }
  if (!entity.isValid) {
    throw new SkillBlocked(`交手中${zhEntity(target)}离开了视野,没有把“消失”算成击杀;${attackStats(stats)}${underwaterOxygenNote(bot)}`);
  }
  if (entity.isValid) {
    throw new SkillBlocked(
      `${attackStats(stats)}没打死${zhEntity(target)},超时收手${underwaterOxygenNote(bot)}`,
    );
  }
  throw new SkillBlocked(`没有确认${zhEntity(target)}死亡;${attackStats(stats)}`);
}

/** 按名字拿到手上 */
async function equipNamed(bot: Bot, name: string): Promise<string> {
  const item = bot.inventory.items().find((i) => i.name === name || i.name.endsWith(`_${name}`));
  if (!item) throw new SkillBlocked(`包里没有${zhName(name)}`);
  await bot.equip(item, 'hand');
  return item.name;
}

/**
 * equipEmpty 优先切换到空快捷栏，再将主手物品移入背包。
 * 背包也满时会将主手栈丢到地上，回执须说明。
 */
async function emptyHand(bot: Bot): Promise<string> {
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

/** item 缺省时腾空主手；air 别名由 parseEquip 归一化。 */
async function skillEquip(bot: Bot, call: Extract<SkillCall, { skill: 'equip' }>): Promise<string> {
  const want = call.item;
  if (!want) return emptyHand(bot);
  // 精确名优先;退而求其次才用后缀(iron→iron_pickaxe),`includes` 会让
  // equip "iron" 命中哪一件全看物品栏顺序,那不是她说的意思
  const items = bot.inventory.items();
  const item = invItemNamed(bot, want, call.pick);
  if (!item) {
    const same = items.filter((i) => namedLike(want, i.name));
    if (call.pick && same.length > 0) throw noSuchItem(bot, want, call.pick, same);
    const near = items.filter((i) => i.name.includes(want)).map((i) => zhName(i.name));
    throw new SkillBlocked(
      `包里没有${zhName(want)}` + (near.length > 0 ? `;名字带这几个字的有:${near.join('、')}` : ''),
    );
  }
  const dest = equipDestOf(item.name, bot.registry);
  await bot.equip(item, dest);
  // 点名拿的时候回执念全标签:「拿起了弓」答不了「拿的是无限那把吗」
  const what = call.pick ? pickLabel(pickTargetOf(item, bot.registry as never)) : zhName(item.name);
  if (dest === 'hand') return `手里拿起了${what}`;
  if (dest === 'off-hand') return `${what}挂上了副手`;
  return `穿上了${what}`;
}

/** 走到够得着那一格的地方 */
async function reachCell(bot: Bot, c: Cell, ctx: SkillContext): Promise<void> {
  const me = bot.entity.position;
  const d = Math.hypot(me.x - (c.x + 0.5), me.y - (c.y + 0.5), me.z - (c.z + 0.5));
  if (d <= PLACE_REACH) return;
  await gotoGoal(bot, new goals.GoalNear(c.x, c.y, c.z, 2), ctx);
}

/** 投掷类:朝 at 看一眼然后甩出去,不是往那一格放东西 */
const THROWN = new Set([
  'splash_potion', 'lingering_potion', 'ender_pearl', 'snowball', 'egg',
  'experience_bottle', 'eye_of_ender', 'trident',
]);

function isThrown(name: string): boolean {
  return THROWN.has(name) || name.startsWith('splash_') || name.startsWith('lingering_');
}

/** 船与竹筏(含带箱版):所有木种一个后缀就认全,新木种不必回来加名字 */
function isBoat(name: string): boolean {
  return name.endsWith('_boat') || name.endsWith('_raft');
}

/** 不写 at 放船时,按视线找落点面的射线上限(原版 BoatItem 的射线约 5 格) */
const BOAT_CURSOR_RANGE = 5;

/** activateBlock 缺省点击顶面；效果表以此面计算外侧一格的位置。 */
const USE_FACE: BlockFace = 'up';

/** 面名 → activateBlock 收的方向向量。 */
function faceVector(face: BlockFace): Vec3 {
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
async function writeSign(
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
const USE_SETTLE_MS = 400;

/** 右键之后世界该变成什么样;`want` 与实测读数成对进回执 */
interface UseProbe {
  /** 期望读到什么 */
  want: string;
  /** 右键之后读一次:办成了没有,以及实测读到的是什么 */
  read(): { met: boolean; actual: string };
}

/**
 * 锄地要求正上方 isAir，空碰撞形状的草、火把等也会阻挡。
 * rooted_dirt 不要求头顶空气；farmland 已是目标状态，两者放行。
 */
function hoeCoverBlocked(bot: Bot, cell: Cell, target: string): string | null {
  if (HOE_TILLED[target] === undefined || target === 'rooted_dirt' || target === 'farmland') return null;
  const above = blockAtCell(bot, { x: cell.x, y: cell.y + 1, z: cell.z });
  if (!above || AIR_NAMES.has(above.name)) return null;
  return `${cellText(cell)} 头上盖着${zhName(above.name)},锄不动;先把它清掉`;
}

/** 空桶舀哪一格出哪一桶;流动的水舀不起来,读数自己会说(把握:确定) */
const BUCKET_FILL: Record<string, string> = {
  water: 'water_bucket',
  lava: 'lava_bucket',
  powder_snow: 'powder_snow_bucket',
};

/** 满桶倒出去就变回空桶(把握:确定) */
const FULL_BUCKETS = new Set(['water_bucket', 'lava_bucket', 'powder_snow_bucket']);

/** 打火石点上去是自身 lit 翻牌、而不是外面出火的那几种(把握:比较确定) */
const LIT_BY_FIRE = /^(soul_)?campfire$|candle(_cake)?$/;

/** 点着之后外面那一格是什么:一般出火,灵魂沙族出灵魂火,黑曜石框里当场成传送门(把握:确定) */
const FIRE_BLOCKS = new Set(['fire', 'soul_fire', 'nether_portal']);

/**
 * 右键就翻牌的开关族与它翻的那个属性。**判据是"翻了没有"而不是"翻成了哪一面"**——
 * 翻牌不需要知道她想要开还是想要关,而铁门/铁活板门空手翻不动,正是要判出来的那一类。
 * 按钮不在表里:它按下去自己会弹回来(石按钮 1 秒),读数是赛跑,判不了(把握:确定)。
 */
const TOGGLES: ReadonlyArray<{ re: RegExp; prop: string }> = [
  { re: /(^|_)door$/, prop: 'open' },
  { re: /(^|_)trapdoor$/, prop: 'open' },
  { re: /_fence_gate$/, prop: 'open' },
  { re: /^lever$/, prop: 'powered' },
];

/** 挤得出奶的(把握:牛/哞菇确定,山羊比较确定) */
const MILKABLE = new Set(['cow', 'mooshroom', 'goat']);

/** 上得了鞍的。**没驯服的马驴上不了**,鞍留在包里,读数自己会说(把握:比较确定) */
const SADDLEABLE = new Set(['horse', 'donkey', 'mule', 'pig', 'strider', 'camel']);

/**
 * 读一格变成了什么;本来就是那样也算办成(与 build「本来就是火把」同一条)。
 * `where` 是读数在回执里怎么称呼这一格:被点的那一格叫「那一格」(回执头一句已经
 * 报过坐标),读外面一格的那几条要报出坐标,否则看不出读的是 y+1。
 */
function probeCell(
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
function probeInv(
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
function probeProp(
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
function useProbeAt(
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
const CAMPFIRES = new Set(['campfire', 'soul_campfire']);

/** 画只允许侧面，展示框允许六面；此类物品需明确放置面。 */
const WALL_ENTITY_ITEMS = new Set(['item_frame', 'glow_item_frame', 'painting']);

/** (手上这样东西 × 右键的那只活物)→ 右键之后该读哪儿;判不了返回 null */
function useProbeOn(bot: Bot, item: string | null, target: string, entity?: unknown): UseProbe | null {
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
function useNoteOn(bot: Bot, item: string | null, target: string, entity: unknown): string {
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
function leaveVehicle(bot: Bot, target: string): string {
  const vehicle = (bot as unknown as { vehicle?: { name?: string } | null }).vehicle;
  if (!vehicle) return '';
  return `;人已经骑在${zhEntity(target)}身上了:驾着走用 {"skill":"ride","to":[x,y,z]},下来用 {"skill":"ride","off":true}`;
}

/**
 * 落在效果表外的那一对记一条。**这张表要长出来只能靠它**:下一场直接按
 * `use-off-table` 就数得出还缺哪些对,不必再从全场回执里反推。
 */
function noteOffTable(ctx: SkillContext, item: string | null, target: string): void {
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
const BED_WAKE_MS = 60_000;
const BED_WAKE_POLL_MS = 250;

/**
 * 躺下之后不返回,等到醒 —— 这一步还没结束,后面那一步的寻路就动不了身。
 * 被抢占(战斗/mc_stop/World 停机)当场收工:那些抢占本来就该把人从床上叫起来。
 * 返回回执里的那半句(等了多久、是自己醒的还是到点起的)。
 */
async function waitForWake(bot: Bot, ctx: SkillContext): Promise<string> {
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
async function settleProbe(probe: UseProbe): Promise<{ met: boolean; actual: string }> {
  const first = probe.read();
  if (first.met) return first;
  await sleep(USE_SETTLE_MS);
  return probe.read();
}

/** 一次右键在包里留下的痕迹:进包的与用掉的都报。一样没动返回空串,不占一句话 */
function useInvNote(before: Map<string, number>, bot: Bot): string {
  const parts: string[] = [];
  const gains = invGains(before, bot);
  const losses = invLosses(before, bot);
  if (gains.length > 0) parts.push(`进包:${gains.join('、')}`);
  if (losses.length > 0) parts.push(`用掉:${losses.join('、')}`);
  return parts.join(';');
}

const PIGLIN_ACCEPT_MS = 1_500;
const PIGLIN_GIFT_MS = 10_000;

function adultPiglins(bot: Bot, radius: number): Array<NonNullable<Bot['entities'][string]>> {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter((e): e is NonNullable<Bot['entities'][string]> => Boolean(
      e?.isValid && e.name === 'piglin' && e.position
      && e.position.distanceTo(me) <= radius && !isBabyPiglin(bot, e),
    ))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
}

function piglinDrops(
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
async function barterPiglinOnce(bot: Bot, ctx: SkillContext): Promise<string> {
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
function nothingThere(bot: Bot, cell: Cell, name: string, label: string): SkillBlocked {
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
async function skillUse(bot: Bot, call: Extract<SkillCall, { skill: 'use' }>, ctx: SkillContext): Promise<string> {
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
async function useOnce(bot: Bot, call: Extract<SkillCall, { skill: 'use' }>, ctx: SkillContext): Promise<string> {
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
async function aimThenUse(bot: Bot, point: Vec3): Promise<void> {
  await bot.lookAt(point, true);
  await bot.waitForTicks(1);
  await bot.activateItem();
}

/** 原版末影之眼飞 40–80 刻(2–4 秒)就消失,盯 6 秒足够,盯不到就说盯不到 */
const ENDER_EYE_WATCH_MS = 6_000;

async function throwEnderEye(bot: Bot, ctx: SkillContext): Promise<string> {
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
async function useBoat(bot: Bot, cell: Cell, held: string, label: string): Promise<string> {
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
const RIDE_FIND_R = 32;
/** 驾驭:到点判定(水平距离) */
const RIDE_ARRIVE_R = 2.5;
/** 驾驭:这么久推进不足 1 格就按卡死收场(下车+如实回执) */
const RIDE_STALL_MS = 20_000;
/** 驾驭:发包节拍(与游戏 tick 同步) */
const RIDE_TICK_MS = 50;
/**
 * 支持驾驭的载具及每物理 tick 的步长，单位为格。
 * 马的位置包受服务端纠偏，暂不支持驾驭；仍支持骑乘和下车。
 */
const RIDE_STEP: Readonly<Record<string, number>> = {
  pig: 0.12, strider: 0.12, boat: 0.3, chest_boat: 0.3,
};
const RIDE_STEP_DEFAULT = 0.12;
/** 驾驭这一种要手持的道具(服务端认「受控」的前提;拿掉它坐骑就不听使唤) */
const RIDE_CONTROL_ITEM: Readonly<Record<string, string>> = {
  pig: 'carrot_on_a_stick', strider: 'warped_fungus_on_a_stick',
};

interface VehicleEntity { name?: string; position: Vec3; height?: number }
interface RideClient {
  write(name: string, data: Record<string, unknown>): void;
  on(name: string, fn: (p: { x: number; y: number; z: number }) => void): void;
  removeListener(name: string, fn: (p: { x: number; y: number; z: number }) => void): void;
}

function vehicleOf(bot: Bot): VehicleEntity | null {
  return (bot as unknown as { vehicle?: VehicleEntity | null }).vehicle ?? null;
}

async function skillRide(bot: Bot, call: Extract<SkillCall, { skill: 'ride' }>, ctx: SkillContext): Promise<string> {
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

function cellOfVec(p: Vec3): Cell {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

/** 拴绳那件物品的英文 id;与 needs 闸共用同一个常量,不在两处各写一遍字面量 */
const LEAD_ITEM = 'lead';
const LEAD_FIND_R = 32;
/** 右键之后等服务端认拴上的窗口 */
const LEAD_ATTACH_MS = 3_000;
/**
 * 一段牵多远。整段直接交给寻路器会把人拉出绳长:原版超 10 格绳就断,而寻路器
 * 一口气能跑几十格。分段走 + 每段等它跟上,才是「稳定牵到」而不是「走到了但它掉在半路」。
 */
const LEAD_HOP = 8;
/** 原版绳绷断的距离;超过这个数就当断了去核实,不再往前走 */
const LEAD_SNAP = 10;
/** 一段走完之后它离我多远就停下等 */
const LEAD_FOLLOW_R = 6;
/**
 * 人自己要走到离终点多近。**不是 tolerance** —— tolerance 是「它到了没有」的验收圈,
 * 人停在那个圈边上,拖在身后一两格的它就永远差着那一两格进不来。人走到终点上,
 * 它跟到身后,才落进圈里。
 */
const LEAD_ARRIVE_R = 1;
/** 等它跟上的上限 */
const LEAD_CATCHUP_MS = 8_000;
/** 整段牵引的上限 */
const LEAD_DRAG_MS = 150_000;

/**
 * 我正牵着的那只。
 *
 * 上游把 `attach_entity` 记进了 `entity.vehicle`(见 mineflayer entities.js)——名字是
 * 历史遗留:1.9 起载具走 `set_passengers`,这个包**只用于拴绳**。所以「它的 vehicle 是我」
 * 就是「它被我牵着」,这是我们唯一拿得到的服务端拴绳信号。反过来我骑东西时是
 * `bot.entity.vehicle = 坐骑`,方向相反,不会误判。
 */
function leashedByMe(bot: Bot): NonNullable<Bot['entities'][string]> | null {
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

function stillLeashed(bot: Bot, e: { id?: number } | null): boolean {
  const held = leashedByMe(bot);
  return Boolean(held && e && held.id === e.id);
}

function leadCount(bot: Bot): number {
  return invCount(bot, (n) => n === LEAD_ITEM);
}

function distTo(bot: Bot, p: Vec3 | Cell): number {
  const me = bot.entity.position;
  return Math.hypot(me.x - (p as Vec3).x, me.y - (p as Vec3).y, me.z - (p as Vec3).z);
}

/** 栅栏能系绳,栅栏门不能;墙(wall)也不行。名字判据照原版的 fence 族。 */
function isLeashableFence(name: string): boolean {
  return name.endsWith('_fence') || name === 'nether_brick_fence';
}

/** 拴上:走到跟前、右键、等服务端认。两条独立证据(拴绳少一根 / 它的 vehicle 是我)。 */
async function leadAttach(bot: Bot, target: string, ctx: SkillContext): Promise<{
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
async function leadDrag(
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
async function leadRelease(bot: Bot, entity: NonNullable<Bot['entities'][string]>, ctx: SkillContext): Promise<string> {
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
async function leadTie(
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
async function skillLead(bot: Bot, call: Extract<SkillCall, { skill: 'lead' }>, ctx: SkillContext): Promise<string> {
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
function rideGroundY(bot: Bot, x: number, yNow: number, z: number): number | null {
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
async function rideDrive(bot: Bot, ctx: SkillContext, to: Cell): Promise<string> {
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

/** 三种磨损态的铁砧都认 */
const ANVIL_BLOCKS = ['anvil', 'chipped_anvil', 'damaged_anvil'] as const;
/** 找工作方块的半径,与 smelt 找炉子一个量级 */
const STATION_FIND_R = 16;
/** 放料/取货后等服务端回灌窗口槽位 */
const WINDOW_SETTLE_MS = 600;

interface StationWindow {
  id: number;
  type: string;
  slots: Array<{ name: string; type: number; count: number } | null>;
  inventoryStart: number;
  inventoryEnd: number;
}

function findStationCell(bot: Bot, names: readonly string[]): Cell | null {
  const reg = bot.registry.blocksByName as unknown as Record<string, { id: number } | undefined>;
  const ids = names.map((n) => reg[n]?.id).filter((n): n is number => typeof n === 'number');
  if (ids.length === 0) return null;
  const found = bot.findBlocks({ matching: ids, maxDistance: STATION_FIND_R, count: 1 });
  return found.length > 0 ? { x: found[0].x, y: found[0].y, z: found[0].z } : null;
}

/** 走到 cell、开它的窗;那一格不是这种工作方块当场说清 */
async function openStationWindow(
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
async function putIntoStation(
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
function stationItemFacts(bot: Bot, item: { name: string } | null): string {
  if (!item) return '';
  const parts: string[] = [];
  const dur = readDurability(item as never);
  if (dur) parts.push(`耐久 ${dur.left}/${dur.max}`);
  const ench = readEnchants(item as never, bot.registry as never);
  parts.push(ench.length > 0 ? `附魔 ${ench.map((e) => `${e.name}${e.level}`).join('、')}` : '没有附魔');
  return parts.join(',');
}

async function skillAnvil(bot: Bot, call: Extract<SkillCall, { skill: 'anvil' }>, ctx: SkillContext): Promise<string> {
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

async function skillGrindstone(bot: Bot, call: Extract<SkillCall, { skill: 'grindstone' }>, ctx: SkillContext): Promise<string> {
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

/** 这一步净增的东西里哪些是重生锚(床/重生锚的物品形态) */
function gainedAnchors(before: Map<string, number>, bot: Bot): string[] {
  const out: string[] = [];
  for (const [name, n] of invSnapshot(bot)) {
    if (n > (before.get(name) ?? 0) && isSpawnAnchorBlock(name)) out.push(zhName(name));
  }
  return out;
}

/** 床或重生锚进入、离开背包时，报告物品形态，并提示重生点依赖已放置且有效的床或锚。 */
function anchorInHandNote(bot: Bot, ctx: SkillContext, names: string[], verb: string): string {
  if (names.length === 0) return '';
  const anchor = ctx.spawnAnchor?.();
  const where = anchor
    ? `(重生点记在${anchor.dimension ? zhDimension(anchor.dimension) : '维度未明'} `
      + `${cellText({ x: Math.floor(anchor.x), y: Math.floor(anchor.y), z: Math.floor(anchor.z) })})`
    : '(现在已经没有个人重生点了)';
  return ` —— ${verb}的${names.join('、')}是你的重生锚${where},它已经不在原来那一格摆着了,` +
    '重生点随之作废;放回去再睡一次才算数。';
}

async function skillPickup(bot: Bot, ctx: SkillContext, item?: string): Promise<string> {
  const before = invSnapshot(bot);
  // 刚打死的东西掉落物实体还没生成:先等一小会儿再判"附近有没有"
  await sleep(500);
  let walked = 0;
  for (let i = 0; i < 8; i++) {
    checkAbort(ctx);
    const me = bot.entity.position;
    let nearest: { pos: { x: number; y: number; z: number }; d: number } | null = null;
    for (const id of Object.keys(bot.entities)) {
      const e = bot.entities[id];
      if (!e?.position || (e.name !== 'item' && e.name !== 'item_stack')) continue;
      const stack = droppedStackOf(e);
      if (item && (!stack || !matchItemName(item, stack.name))) continue;
      const d = e.position.distanceTo(me);
      if (d <= 24 && (!nearest || d < nearest.d)) nearest = { pos: e.position, d };
    }
    if (!nearest) break;
    await gotoGoal(bot, new goals.GoalNear(nearest.pos.x, nearest.pos.y, nearest.pos.z, 0.5), ctx).catch(() => undefined);
    walked++;
    await sleep(300);
  }
  const anchorNote = anchorInHandNote(bot, ctx, gainedAnchors(before, bot), '捡起来');
  // 指定物品时，验收按同一匹配规则区分目标增量与沿途拾得。
  if (item !== undefined) {
    const { wanted, alongside } = invGainsSplit(before, bot, item);
    const along = alongside.length > 0 ? `;顺手带进包的:${alongside.join('、')}` : '';
    if (wanted.length > 0) return `捡了 ${wanted.join('、')}${along}${anchorNote}`;
    if (alongside.length > 0) {
      return `没捡到${zhName(item)}${along.replace(/^;/, ',')}${anchorNote}`;
    }
  }
  const gains = invGains(before, bot);
  if (gains.length > 0) return `捡了 ${gains.join('、')}${anchorNote}`;
  if (walked > 0) return `走了 ${walked} 处掉落物,一样都没进包`;
  // 地上本来就没有可捡的 = 无事可做,不是没做成(见 SkillNoop)
  throw new SkillNoop(item ? `附近没有${zhName(item)}掉落物,包里也没多出什么` : '附近没有掉落物,包里也没多出什么');
}

/** 抛远的落点找多远(格);近端要出得了自己的拾取半径(原版 ~1 格),远端别丢到看不见的地方 */
const TOSS_RANGE = { min: 4, max: 8 } as const;
/** 抛远的仰角(弧度)。mineflayer 的 pitch 是**负值朝上**,抬头 30–45° 取中间偏上的 40° */
const TOSS_PITCH = -(40 * Math.PI) / 180;
/** 找方向时按这个角度间隔扫一圈(度) */
const TOSS_YAW_STEP = 30;

/** `toss` 带 at 时的瞄准上限:手扔的抛物线大致就到这儿,再远只是把东西丢在半路 */
const TOSS_AIM_MAX = 8;

/**
 * toss 按当前 yaw/pitch 给物品初速度，须预先转向。
 * 纯读已加载格，在 min..max 范围检查落点及头格均为空气；选最长畅通方向，同距取首。
 * 无合格方向返回 null，调用方就地丢弃；不寻路或修改方块。
 */
function planTossThrow(bot: Bot): { yaw: number; distance: number } | null {
  // 读不了方块、或转不了头(台架的裸 bot)= 没有合格方向可挑,退回就地扔
  if (typeof bot.blockAt !== 'function' || typeof bot.look !== 'function') return null;
  const me = bot.entity.position;
  const eyeY = Math.floor(me.y + 1);
  let best: { yaw: number; distance: number } | null = null;
  for (let deg = 0; deg < 360; deg += TOSS_YAW_STEP) {
    const rad = (deg * Math.PI) / 180;
    // mineflayer 的 yaw:0 = -Z(北),向 -X 增大。这两行与 skillFish 的算法同一套
    const dx = -Math.sin(rad);
    const dz = -Math.cos(rad);
    let reach = 0;
    for (let d = TOSS_RANGE.min; d <= TOSS_RANGE.max; d++) {
      const cell = { x: Math.floor(me.x + dx * d), y: eyeY, z: Math.floor(me.z + dz * d) };
      const at = blockAtCell(bot, cell);
      const above = blockAtCell(bot, { ...cell, y: cell.y + 1 });
      const clear = (b: ReturnType<Bot['blockAt']>): boolean =>
        b !== null && b.boundingBox === 'empty' && !LIQUIDS.has(b.name);
      if (!clear(at) || !clear(above)) break;
      reach = d;
    }
    if (reach > 0 && (!best || reach > best.distance)) best = { yaw: rad, distance: reach };
  }
  return best;
}

/** yaw 弧度 → 八向汉字。只用来在回执里说清「往哪边扔的」 */
function yawCompass(yaw: number): string {
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  // 屏幕坐标里 -Z 是北、+X 是东;atan2 取正东为 0 再按 45° 分档
  const deg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  return names[Math.round(deg / 45) % 8];
}

async function skillToss(
  bot: Bot,
  call: Extract<SkillCall, { skill: 'toss' }>,
  ctx: SkillContext,
): Promise<string> {
  const { item, count, pick } = call;
  const pred = itemPredOf(bot, item, pick);
  const have = invCount(bot, pred);
  if (have === 0) throw noSuchItem(bot, item, pick);
  const want = Math.min(count, have);
  let left = want;
  let tossed = 0;
  // 先转向再扔。两种瞄法:
  //   · 给了 at —— 朝那一格扔(以物易物把金锭扔到猪灵脚边就是这一形态)
  //   · 没给 —— 自己挑一个开阔方向,让抛物线把东西送出自己的拾取半径(见 planTossThrow)
  const aim = call.at === undefined ? null : resolveAt(bot, call.at);
  let where: string;
  if (aim) {
    const me = bot.entity.position;
    const flat = Math.hypot(aim.x + 0.5 - me.x, aim.z + 0.5 - me.z);
    if (flat > TOSS_AIM_MAX) {
      throw new SkillBlocked(
        `${cellText(aim)} 离我 ${flat.toFixed(1)} 格,手扔够不着(最远约 ${TOSS_AIM_MAX} 格);先走近再扔`,
      );
    }
    if (typeof bot.lookAt === 'function') {
      checkAbort(ctx);
      await bot.lookAt(new Vec3(aim.x + 0.5, aim.y + 0.5, aim.z + 0.5), true);
    }
    // 落点不承诺:抛物线的终点是服务端算的,这里只说得出朝哪儿扔的、隔多远
    where = `,朝 ${cellText(aim)} 扔的(隔 ${flat.toFixed(1)} 格);东西按抛物线落在那个方向,不保证正好落在那一格`;
  } else {
    const throwTo = planTossThrow(bot);
    if (throwTo) {
      checkAbort(ctx);
      await bot.look(throwTo.yaw, TOSS_PITCH, true);
    }
    where = throwTo
      ? `,朝${yawCompass(throwTo.yaw)}抬头抛出去,那个方向 ${throwTo.distance} 格内是空的`
      : ',周围 4–8 格没找到又空又开阔的方向,就在脚边扔的';
  }
  const picked: PickTarget[] = [];
  for (const it of bot.inventory.items().filter((i) => pred(i.name, i))) {
    if (left <= 0) break;
    const n = Math.min(it.count, left);
    const before = invCount(bot, (name) => name === it.name);
    // 点名的那一件按槽位扔(bot.toss 按类型找槽,同 id 的几件在它眼里没分别)
    if (pick !== undefined && it.count === 1) await bot.tossStack(it as never);
    else await bot.toss(it.type, it.metadata ?? null, n);
    const moved = before - invCount(bot, (name) => name === it.name);
    if (moved <= 0) break;
    tossed += moved;
    left -= moved;
    if (pick !== undefined) picked.push(pickTargetOf(it, bot.registry as never));
  }
  if (tossed === 0) throw new SkillBlocked(`${zhName(item)}没扔出去`);
  const anchor = isSpawnAnchorBlock(item) ? anchorInHandNote(bot, ctx, [zhName(item)], '扔掉') : '';
  // 往哪边扔的照实说;没找到开阔方向时说清是就地扔的(否则她会以为东西在几格外)
  return `扔掉了${picked.length > 0 ? pickedText(picked) : zhName(item)}×${tossed}${where}${anchor}`;
}

/** 箱子族在世界里的扫描名单;与账本认箱子的口径同一份(见 chests.ts CHEST_BLOCKS) */
const CONTAINER_FIND: readonly string[] = CHEST_BLOCKS;

function findContainers(bot: Bot, range: number): Array<{ x: number; y: number; z: number; name: string; d: number }> {
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
function knownChestNote(bot: Bot, chests: ChestBook | undefined): string | null {
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
function noContainerNearby(bot: Bot, ctx: SkillContext): SkillBlocked {
  return new SkillBlocked(`32 格内没有箱子${knownChestNote(bot, ctx.chests) ?? ''}`);
}

/**
 * 箱内容按「名字 + 附魔」并栈,与背包同一条线(原版里带不同附魔的同名物品不能堆叠)。
 * 只按名字并,五本各不相同的附魔书会念成「附魔书×5」:数量读得到,哪一本在里面读不到,
 * 于是也点不了名(见 item-pick)。
 */
function containerStacks(win: {
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

function rememberChest(
  ctx: SkillContext,
  bot: Bot,
  pos: { x: number; y: number; z: number },
  win: Parameters<typeof containerStacks>[0],
): { items: ItemStack[]; usedSlots: number; slots: number } {
  const snap = containerStacks(win, bot.registry as never);
  ctx.chests?.remember(dimensionOf(bot), pos, snap.items, snap.usedSlots, snap.slots);
  return snap;
}

const FURNACE_KINDS = new Set<string>(FURNACE_BLOCKS);

/**
 * 原版烧一件的耗时:熔炉 200 刻(10 秒);高炉与烟熏炉减半(100 刻)。
 * 这是确定性数值,所以熔炉的到期**可以**估;作物不行(随机刻),别把这条挪去作物。
 */
function smeltPerItemMs(blockName: string): number {
  return blockName === 'furnace' ? 10_000 : 5_000;
}

/** 槽位有料不能证明正在烧炼;估时需要炉火和进度读数同时确认。 */
function furnaceDoneAt(win: unknown, input: ItemStack | null, blockName: string, now: number): number | null {
  const { fuel, progress } = win as { fuel?: number | null; progress?: number | null };
  return input && typeof fuel === 'number' && fuel > 0 && typeof progress === 'number' && progress > 0
    ? now + (input.count - progress) * smeltPerItemMs(blockName)
    : null;
}

/** 窗口 slots 里的一格转成账本的 ItemStack;空格与读不出都算 null */
function slotStack(win: unknown, i: number): ItemStack | null {
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
function rememberWindow(
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

function orderForStow(
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

function orderForTake(
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
function isWindowIdentityError(err: unknown): boolean {
  return err instanceof Error && / window used as a /i.test(err.message);
}

/**
 * 开容器前退役遗留窗口；返回窗口身份不符时关闭并重开一次，连续失败才受阻。
 * 此处校验窗口身份，窗口状态版本由 mineflayer-fixes 的 stateId 守卫处理。
 */
async function openWindowGuarded<T>(bot: Bot, ctx: SkillContext, open: () => Promise<T>): Promise<T> {
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

async function openNearbyContainer(
  bot: Bot,
  spot: { x: number; y: number; z: number; name: string },
  ctx: SkillContext,
): Promise<Awaited<ReturnType<Bot['openContainer']>>> {
  await gotoGoal(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 2), ctx);
  const block = bot.blockAt(new Vec3(spot.x, spot.y, spot.z));
  if (!block) throw new SkillBlocked(`${zhName(spot.name)}不见了`);
  return openWindowGuarded(bot, ctx, () => bot.openContainer(block));
}

/** 一次开窗里存一样东西的账 */
interface StowEntry {
  /** 并进来的是这一单里的第几步(0 起);当前这一步是 null */
  stepIndex: number | null;
  item: string;
  count: number;
  /** 挑选词;不写 = 同 id 的几件不分辨 */
  pick?: string;
  pred: InvPred;
  /** 真正点走的那几件各自是什么。只在写了挑选词时记:回执要点名挑中的是哪几件 */
  picked: PickTarget[];
  /** 开窗前那本账(开着窗 bot.inventory 是冻的),关窗后拿它对账 */
  invBefore: number;
  deposited: number;
  /** 点不动的时候服务端/mineflayer 给的原话,翻好了带进回执:不拿猜测顶替 */
  failure: string | null;
  snap: ReturnType<typeof rememberChest>;
}

/** 一次开窗最多并几步:并太多这扇窗要开很久,反射抢占的窗口也跟着变大 */
const STOW_BATCH_MAX = 6;

/** 相邻 stow 仅在 orderForStow 仍选同一首选箱子时共用窗口，不改变选箱策略。 */
function collectStowBatch(
  bot: Bot,
  ctx: SkillContext,
  found: Parameters<typeof orderForStow>[0],
  target: { x: number; y: number; z: number },
): Array<{ stepIndex: number; item: string; count: number; pick?: string }> {
  const b = ctx.batch;
  const out: Array<{ stepIndex: number; item: string; count: number; pick?: string }> = [];
  if (!b) return out;
  for (let i = b.index + 1; i < b.steps.length && out.length < STOW_BATCH_MAX - 1; i++) {
    const s = b.steps[i];
    if (s.skill !== 'stow') break;
    // 她自己写了闸门或判据的步不并:并进来就等于替她跳过 needs、替她免掉 expect 裁决。
    // 缺省的因果闸不用管——它拦的是「上游没产出」,而下一行的包里没有正好覆盖那种情况。
    if (s.needs !== undefined || s.expect !== undefined) break;
    // 包里没有这样东西:别并,让它自己跑自己报「包里没有X」
    if (invCount(bot, itemPredOf(bot, s.item, s.pick)) === 0) break;
    const chest = orderForStow(found, ctx, bot, s.item)[0];
    if (!chest || chest.x !== target.x || chest.y !== target.y || chest.z !== target.z) break;
    out.push({ stepIndex: i, item: s.item, count: s.count, ...(s.pick ? { pick: s.pick } : {}) });
  }
  return out;
}

/** 一样东西的回执;ok=false 的那句在当前步是 SkillBlocked 的理由,并进来的步则不并 */
function stowReceipt(
  where: string,
  e: StowEntry,
  conf: Awaited<ReturnType<typeof awaitInvConfirm>> | null,
  /**
   * 这次开窗里同一样东西一共点走了几个。
   *
   * 双记账(点击侧 `deposited` / 库存侧 `conf.moved`)本身是对的:两个数不等正是它
   * 要暴露的 `copyInventory` 回灌差异。坏在措辞——一样东西拆成两堆点走时,两行
   * 「点走 64…少了 70」「点走 6…少了 70」读起来像搬了两次 70 个。
   * 合成一句「本次开窗合计」之后,两个数各自对应的量纲一眼看得出来。
   */
  windowTotal: number,
): { ok: boolean; text: string } {
  const name = zhName(e.item);
  // 点名存的时候,回执里那个名字得是**挑中的那几件**;只说 id 等于没回答「存的是哪本」
  const what = e.picked.length > 0 ? pickedText(e.picked) : name;
  const tail = `。箱里现在：${contentsText(e.snap.items)}`;
  if (e.deposited === 0) {
    return {
      ok: false,
      text: `${where}存不进${name}:${e.failure ?? '窗口里一格都没动(箱子满了或对不上)'}${tail}`,
    };
  }
  const want = Math.min(e.count, e.invBefore);
  const short = e.deposited < want && e.failure ? `;剩下的没存进去:${e.failure}` : '';
  const head = `往${where}存了${what}×${e.deposited}${short}`;
  if (conf === null) {
    return { ok: true, text: `${head},没来得及对账就被打断了,存没存进以箱里为准${tail}` };
  }
  if (conf.status === 'timeout') {
    return {
      ok: true,
      text: `${head},但关窗后包里的账没跟着变(服务端没回灌确认),存没存进以箱里为准${tail}`,
    };
  }
  if (conf.status === 'rolled-back') {
    return { ok: false, text: `往${where}存${name}×${e.deposited}被服务端收回了,包里一个都没少${tail}` };
  }
  if (conf.moved !== windowTotal) {
    return {
      ok: true,
      text: `${head};本次开窗合计:点走 ${windowTotal},关窗后包里少了 ${conf.moved}${tail}`,
    };
  }
  return { ok: true, text: `${head}${tail}` };
}

async function skillStow(
  bot: Bot, call: Extract<SkillCall, { skill: 'stow' }>, ctx: SkillContext,
): Promise<string> {
  const { item, count, pick } = call;
  if (invCount(bot, itemPredOf(bot, item, pick)) === 0) throw noSuchItem(bot, item, pick);
  const found = findContainers(bot, 32);
  if (found.length === 0) throw noContainerNearby(bot, ctx);
  const target = orderForStow(found, ctx, bot, item)[0];
  const where = `(${target.x}, ${target.y}, ${target.z}) 的${zhName(target.name)}`;
  const plan: Array<{ stepIndex: number | null; item: string; count: number; pick?: string }> = [
    { stepIndex: null, item, count, ...(pick ? { pick } : {}) },
    ...collectStowBatch(bot, ctx, found, target),
  ];
  const show = new ShowPacer(ctx.showTempo?.() ?? null);
  let chest;
  try {
    await show.openGap();
    chest = await openNearbyContainer(bot, target, ctx);
  } catch (err) {
    if (err instanceof Aborted || err instanceof SkillBlocked) throw err;
    throw new SkillBlocked(`打不开 ${where}: ${zhErrorText((err as Error).message)}`);
  }
  const entries: StowEntry[] = [];
  /** 抢占落在半路:已经点进去的那几样照样要关窗对账、照样要落回执,不能当没发生过 */
  let aborted: Aborted | null = null;
  try {
    await show.beat('open');
    // 进度只能照窗口自己的账读(见 playerInvIn);每轮重取,别拿旧数组接着走
    const view = playerInvIn(bot, chest);
    for (const p of plan) {
      const pred = itemPredOf(bot, p.item, p.pick);
      const e: StowEntry = {
        stepIndex: p.stepIndex, item: p.item, count: p.count, pick: p.pick, pred, picked: [],
        invBefore: invCount(bot, pred), deposited: 0, failure: null,
        snap: { items: [], usedSlots: 0, slots: 27 },
      };
      entries.push(e);
      const want = Math.min(p.count, invCountIn(view, pred));
      try {
        while (e.deposited < want) {
          checkAbort(ctx);
          const it = view.items().find((i) => pred(i.name, i));
          if (!it) break;
          const n = Math.min(it.count, want - e.deposited);
          const before = invCountIn(view, (name) => name === it.name);
          // undefined = 按类型搬(没点名,或这一摞不止一件);数字 = 点名搬进这一格;
          // null = 该点名搬,可箱里没有空格了
          const into = e.pick !== undefined && it.count === 1 ? chest.firstEmptyContainerSlot() : undefined;
          if (into === null) {
            e.failure = '箱子里没有空格了,点名的那件放不进去';
            break;
          }
          try {
            if (into === undefined) await chest.deposit(it.type, it.metadata ?? null, n);
            else await moveExactSlot(bot, it.slot, into);
          } catch (err) {
            if (err instanceof Aborted) throw err;
            e.failure = zhErrorText((err as Error).message);
            break;
          }
          const moved = before - invCountIn(view, (name) => name === it.name);
          if (moved <= 0) break;
          e.deposited += moved;
          if (e.pick !== undefined) e.picked.push(pickTargetOf(it, bot.registry as never));
          await show.beat('click');
        }
      } catch (err) {
        if (!(err instanceof Aborted)) throw err;
        aborted = err;
      }
      // 每样各存一份关窗时刻的箱内容:三条回执同刻送达,各说各那一步做完时箱里有什么
      e.snap = rememberChest(ctx, bot, target, chest);
      if (aborted) break;
    }
    await show.beat('close');
  } finally {
    chest.close();
  }

  // close() 里的 copyInventory() 才把窗口那本账灌回 bot.inventory,这时才对得上。
  // 并窗只并开关窗,不并对账:一样东西一笔 before/after,双记账一格不少。
  const done: Array<{ e: StowEntry; text: string; ok: boolean }> = [];
  for (const e of entries) {
    let conf: Awaited<ReturnType<typeof awaitInvConfirm>> | null = null;
    if (e.deposited > 0) {
      try {
        conf = await awaitInvConfirm(() => invCount(bot, e.pred), e.invBefore, -1, ctx);
      } catch (err) {
        if (!(err instanceof Aborted)) throw err;
        aborted ??= err; // 对账途中被抢占:回执降级成「没来得及对账」,不假装确认过
      }
    }
    ctx.diag?.write({
      lane: 'skill', event: e.deposited === 0 ? 'stow-none' : 'stow-done', taskId: ctx.taskId,
      msg: `${where}:窗口里点走${zhName(e.item)} ${e.deposited} 个,关窗后包里少了 ${conf?.moved ?? 0} 个`,
      data: {
        at: target, item: e.item, want: Math.min(e.count, e.invBefore), deposited: e.deposited,
        confirmed: conf?.moved ?? 0, status: conf?.status ?? 'none', failure: e.failure,
        batchedInto: e.stepIndex === null ? null : (ctx.batch?.index ?? null),
      },
    });
    // 同物品的拆堆和并窗数量累计到整个窗口，再与窗口库存变化比较。
    const windowTotal = entries
      .filter((x) => matchItemName(e.item, x.item) || matchItemName(x.item, e.item))
      .reduce((n, x) => n + x.deposited, 0);
    const r = stowReceipt(where, e, conf, windowTotal);
    done.push({ e, ...r });
  }

  // 并进来的步:成了才登记(登记的那一步不会再跑)。没成的不登记——它自己跑一趟,
  // 自己报自己的理由;它一格都没动过,重跑不会重复扣料。
  const first = done[0];
  for (const d of done.slice(1)) {
    if (!d.ok || d.e.stepIndex === null) continue;
    ctx.batch?.absorb(d.e.stepIndex, `(跟第 ${(ctx.batch.index ?? 0) + 1} 步同一次开窗)${d.text}`);
  }
  if (aborted) throw aborted;
  if (!first.ok) throw new SkillBlocked(first.text);
  // 存进箱子的床同样离开了地面:重生点跟着作废,这一句不能省
  const anchor = isSpawnAnchorBlock(item) ? anchorInHandNote(bot, ctx, [zhName(item)], '存走') : '';
  return `${first.text}${anchor}`;
}

/**
 * take 的 at 形态:点名哪一格容器。炉子族走 openFurnace(输出 + 没烧完的料 + 剩的
 * 燃料),箱子族走 openContainer(不带 item 就整箱掏空)。提前取不是灾难——拿到几个
 * 算几个,槽里现在有几个照实说。
 */
async function skillTakeAt(
  bot: Bot,
  call: Extract<SkillCall, { skill: 'take' }>,
  ctx: SkillContext,
): Promise<string> {
  const cell = resolveAt(bot, call.at!);
  await gotoGoal(bot, new goals.GoalNear(cell.x, cell.y, cell.z, 2), ctx);
  checkAbort(ctx);
  const block = blockAtCell(bot, cell);
  if (!block) throw new SkillBlocked(`${cellText(cell)} 所在区块没加载`);
  if (FURNACE_KINDS.has(block.name)) return takeFromFurnace(bot, call, cell, block, ctx);
  if (block.name === 'brewing_stand') return takeFromBrewingStand(bot, call, cell, block, ctx);
  if (CONTAINER_FIND.includes(block.name)) return takeFromChestAt(bot, call, cell, block, ctx);
  throw new SkillBlocked(`${cellText(cell)} 那一格是${zhName(block.name)},不是箱子、炉子或酿造台,take 掏不了它`);
}

/** 关窗之后等包里的账跟上:多种东西一起取时对着这几样的总数等 */
async function awaitGainsConfirm(
  bot: Bot,
  names: readonly string[],
  beforeTotal: number,
  ctx: SkillContext,
): Promise<'confirmed' | 'timeout' | 'rolled-back'> {
  const total = (): number => names.reduce((s, n) => s + invCount(bot, (x) => x === n), 0);
  const conf = await awaitInvConfirm(total, beforeTotal, 1, ctx);
  return conf.status;
}

async function takeFromFurnace(
  bot: Bot,
  call: Extract<SkillCall, { skill: 'take' }>,
  cell: Cell,
  block: NonNullable<ReturnType<Bot['blockAt']>>,
  ctx: SkillContext,
): Promise<string> {
  const where = `(${cell.x}, ${cell.y}, ${cell.z}) 的${zhName(block.name)}`;
  const show = new ShowPacer(ctx.showTempo?.() ?? null);
  await show.openGap();
  let furnace: Awaited<ReturnType<Bot['openFurnace']>>;
  try {
    furnace = await openWindowGuarded(bot, ctx, () => bot.openFurnace(block));
  } catch (err) {
    if (err instanceof Aborted || err instanceof SkillBlocked) throw err;
    throw new SkillBlocked(`打不开 ${where}: ${zhErrorText((err as Error).message)}`);
  }
  const before = invSnapshot(bot);
  const pred: InvPred | null = call.item ? itemPredOf(bot, call.item, call.pick) : null;
  const parts: string[] = [];
  const takenNames = new Set<string>();
  let leftBehind: string | null = null;
  try {
    await show.beat('open');
    const grab = async (
      label: string,
      read: () => { name: string; count: number } | null,
      out: () => Promise<unknown>,
    ): Promise<void> => {
      const s = read();
      if (!s) return;
      if (pred && !pred(s.name, s as never)) {
        leftBehind = leftBehind ?? `${zhName(s.name)}×${s.count} 不是要取的,留在炉里`;
        return;
      }
      checkAbort(ctx);
      await out().catch(() => undefined);
      if (!read()) {
        parts.push(`${label}${zhName(s.name)}×${s.count}`);
        takenNames.add(s.name);
        await show.beat('click');
      }
    };
    await grab('输出槽的', () => furnace.outputItem() ?? null, () => furnace.takeOutput());
    await grab('没烧完的', () => furnace.inputItem() ?? null, () => furnace.takeInput());
    await grab('没烧掉的燃料', () => furnace.fuelItem() ?? null, () => furnace.takeFuel());
    // 槽位剩什么重新入账;估时还需确认炉火与进度。
    const state = {
      input: furnace.inputItem() ?? null,
      fuel: furnace.fuelItem() ?? null,
      output: furnace.outputItem() ?? null,
    };
    const now = Date.now();
    ctx.chests?.rememberFurnace(
      dimensionOf(bot), cell, block.name, state, now,
      furnaceDoneAt(furnace, state.input, block.name, now),
    );
    await show.beat('close');
  } finally {
    furnace.close();
  }
  ctx.diag?.write({
    lane: 'skill', event: parts.length === 0 ? 'take-none' : 'take-done', taskId: ctx.taskId,
    msg: `${where}:取走 ${parts.length} 个槽(${parts.join('、') || '空'})`,
    data: { at: cell, from: block.name, parts, item: call.item ?? null },
  });
  if (parts.length === 0) {
    throw new SkillBlocked(
      call.item
        ? `${where}三个槽里没有${zhName(call.item)}${leftBehind ? `(${leftBehind})` : ''}`
        : `${where}三个槽都是空的,没东西可取`,
    );
  }
  const names = [...takenNames];
  const beforeTotal = names.reduce((s, n) => s + (before.get(n) ?? 0), 0);
  const status = await awaitGainsConfirm(bot, names, beforeTotal, ctx);
  const head = `从${where}取了:${parts.join('、')}${leftBehind ? `;${leftBehind}` : ''}`;
  if (status === 'rolled-back') {
    throw new SkillBlocked(`${head};但被服务端收回了,包里没多`, [], 'server');
  }
  if (status === 'timeout') {
    return `${head};关窗后包里的账还没跟着变(服务端没回灌确认),拿没拿到以包里为准`;
  }
  return `${head};包里多了 ${invGains(before, bot).join('、') || '(没读出增量)'}`;
}

async function takeFromChestAt(
  bot: Bot,
  call: Extract<SkillCall, { skill: 'take' }>,
  cell: Cell,
  block: NonNullable<ReturnType<Bot['blockAt']>>,
  ctx: SkillContext,
): Promise<string> {
  const where = `(${cell.x}, ${cell.y}, ${cell.z}) 的${zhName(block.name)}`;
  const show = new ShowPacer(ctx.showTempo?.() ?? null);
  await show.openGap();
  let chest: Awaited<ReturnType<Bot['openContainer']>>;
  try {
    chest = await openWindowGuarded(bot, ctx, () => bot.openContainer(block));
  } catch (err) {
    if (err instanceof Aborted || err instanceof SkillBlocked) throw err;
    throw new SkillBlocked(`打不开 ${where}: ${zhErrorText((err as Error).message)}`);
  }
  const before = invSnapshot(bot);
  const pred: InvPred = call.item ? itemPredOf(bot, call.item, call.pick) : (): boolean => true;
  const want = call.item ? call.count ?? 1 : Infinity;
  const taken = new Map<string, number>();
  let took = 0;
  let failure: string | null = null;
  let noRoom = false;
  let snap: ReturnType<typeof rememberChest> = { items: [], usedSlots: 0, slots: 27 };
  try {
    await show.beat('open');
    const matches = (typeof chest.containerItems === 'function' ? chest.containerItems() : [])
      .filter((i: InvItem) => pred(i.name, i));
    const view = playerInvIn(bot, chest);
    for (const it of matches) {
      if (took >= want) break;
      checkAbort(ctx);
      const n = Math.min(it.count, want - took);
      const beforeN = invCountIn(view, (name) => name === it.name);
      try {
        await chest.withdraw(it.type, it.metadata ?? null, n);
      } catch (err) {
        if (err instanceof Aborted) throw err;
        if (/inventory is full/i.test((err as Error).message)) noRoom = true;
        failure = zhErrorText((err as Error).message);
        break;
      }
      const moved = invCountIn(view, (name) => name === it.name) - beforeN;
      if (moved <= 0) break;
      took += moved;
      taken.set(it.name, (taken.get(it.name) ?? 0) + moved);
      await show.beat('click');
    }
    snap = rememberChest(ctx, bot, cell, chest);
    await show.beat('close');
  } finally {
    chest.close();
  }
  ctx.diag?.write({
    lane: 'skill', event: took === 0 ? 'take-none' : 'take-done', taskId: ctx.taskId,
    msg: `${where}:窗口里点出 ${took} 个`,
    data: { at: cell, item: call.item ?? null, took, failure, noRoom },
  });
  const inside = `箱里现在:${contentsText(snap.items)}`;
  if (took === 0) {
    if (noRoom) {
      throw new SkillBlocked(`背包 ${INVENTORY_SLOTS} 格全满了,${where}的东西取不出来。${inside}`);
    }
    throw new SkillBlocked(
      call.item
        ? `${where}里没取到${zhName(call.item)}${failure ? `(${failure})` : ''}。${inside}`
        : `${where}是空的,没东西可取${failure ? `(${failure})` : ''}`,
    );
  }
  const names = [...taken.keys()];
  const beforeTotal = names.reduce((s, n) => s + (before.get(n) ?? 0), 0);
  const status = await awaitGainsConfirm(bot, names, beforeTotal, ctx);
  const what = [...taken].map(([n, c]) => `${zhName(n)}×${c}`).join('、');
  const short = call.item && took < (call.count ?? 1)
    ? `(要 ${call.count ?? 1} 个,${noRoom ? '背包满了,没处放' : '箱里就这么多'})`
    : '';
  const head = `从${where}取出${what}${short}${failure && !short ? `(没取完:${failure})` : ''}`;
  if (status === 'rolled-back') {
    throw new SkillBlocked(`${head};但被服务端收回了,包里没多。${inside}`, [], 'server');
  }
  if (status === 'timeout') {
    return `${head};关窗后包里的账还没跟着变(服务端没回灌确认),以包里为准。${inside}`;
  }
  return `${head}。${inside}`;
}

async function skillTake(bot: Bot, call: Extract<SkillCall, { skill: 'take' }>, ctx: SkillContext): Promise<string> {
  if (call.at) return skillTakeAt(bot, call, ctx);
  const item = call.item!; // parse 保证:没有 at 就一定有 item
  const count = call.count ?? 1;
  const pred = itemPredOf(bot, item, call.pick);
  const found = findContainers(bot, 32);
  if (found.length === 0) throw noContainerNearby(bot, ctx);
  const ordered = orderForTake(found, ctx, bot, item);
  const notes: string[] = [];
  let got = 0;
  let unconfirmed = 0;
  /** 拿不出来是因为包满了:这一条决定结论句的主语,不能让"箱子里没取到"顶上去 */
  let noRoom = false;
  // 巡回取最多开 3 口箱:一单共享一份节拍预算,不按箱翻倍
  const show = new ShowPacer(ctx.showTempo?.() ?? null);
  for (const target of ordered.slice(0, 3)) {
    if (got >= count) break;
    checkAbort(ctx);
    const at = `(${target.x}, ${target.y}, ${target.z})`;
    let chest;
    try {
      await show.openGap();
      chest = await openNearbyContainer(bot, target, ctx);
    } catch (err) {
      if (err instanceof Aborted) throw err;
      notes.push(`${at} 打不开`);
      continue;
    }
    // 开窗期间 bot.inventory 冻在开窗前那本账,正好是 close() 之后要对的账底
    const invBefore = invCount(bot, pred);
    let took = 0;
    /** 点不动的时候服务端/mineflayer 给的原话:不拿猜测顶替 */
    let failure: string | null = null;
    let empty = false;
    let snap: ReturnType<typeof rememberChest>;
    let beforeOpen: ReturnType<typeof containerStacks>;
    try {
      await show.beat('open');
      beforeOpen = containerStacks(chest, bot.registry as never);
      const matches = (typeof chest.containerItems === 'function' ? chest.containerItems() : [])
        .filter((i: InvItem) => pred(i.name, i));
      if (matches.length === 0) {
        empty = true;
      } else {
        // 进度只能照窗口自己的账读(见 playerInvIn)
        const view = playerInvIn(bot, chest);
        for (const it of matches) {
          if (got + took >= count) break;
          checkAbort(ctx);
          const n = Math.min(it.count, count - got - took);
          const before = invCountIn(view, (name) => name === it.name);
          // 点名的那一件按槽位掏(withdraw 按类型找槽,同 id 的几件对它没分别)
          const into = call.pick !== undefined && it.count === 1 ? chest.firstEmptyInventorySlot() : undefined;
          if (into === null) {
            noRoom = true;
            failure = '背包里没有空格了';
            break;
          }
          try {
            if (into === undefined) await chest.withdraw(it.type, it.metadata ?? null, n);
            else await moveExactSlot(bot, it.slot, into);
          } catch (err) {
            if (err instanceof Aborted) throw err;
            if (/inventory is full/i.test((err as Error).message)) noRoom = true;
            failure = zhErrorText((err as Error).message);
            break;
          }
          const moved = invCountIn(view, (name) => name === it.name) - before;
          if (moved <= 0) break;
          took += moved;
          await show.beat('click');
        }
      }
      snap = rememberChest(ctx, bot, target, chest);
      await show.beat('close');
    } finally {
      chest.close();
    }

    if (empty) {
      // 有同 id 的几件而挑选词一件没中:摆出箱里那几件各自是什么,别只说「没有」
      const same = beforeOpen!.items.filter((i) => matchItemName(item, i.name));
      notes.push(call.pick && same.length > 0
        ? pickMissText(`${at} `, item, call.pick, same)
        : `${at} 没有${zhName(item)}`);
      continue;
    }
    // close() 里的 copyInventory() 才把窗口那本账灌回 bot.inventory
    const conf = took > 0
      ? await awaitInvConfirm(() => invCount(bot, pred), invBefore, 1, ctx)
      : null;
    ctx.diag?.write({
      lane: 'skill', event: took === 0 ? 'take-none' : 'take-done', taskId: ctx.taskId,
      msg: `${at}:窗口里点出${zhName(item)} ${took} 个,关窗后包里多了 ${conf?.moved ?? 0} 个`,
      data: {
        at: target, item, took, confirmed: conf?.moved ?? 0,
        status: conf?.status ?? 'none', failure,
      },
    });
    if (took === 0) {
      notes.push(
        `${at} 有${zhName(item)}但${failure ?? '窗口里一格都没动'}。开箱时：${contentsText(beforeOpen.items)}`,
      );
      continue;
    }
    got += took;
    const short = failure ? `(没取够:${failure})` : '';
    if (conf!.status === 'confirmed') {
      notes.push(`${at} 取出${zhName(item)}×${took}${short}，箱里现在：${contentsText(snap.items)}`);
      continue;
    }
    unconfirmed += took;
    notes.push(
      conf!.status === 'rolled-back'
        ? `${at} 取的${zhName(item)}×${took}被服务端收回了,包里没多。箱里现在：${contentsText(snap.items)}`
        : `${at} 取出${zhName(item)}×${took}，但关窗后包里的账还没跟着变(服务端没回灌确认)。箱里现在：${contentsText(snap.items)}`,
    );
  }
  if (got === 0) {
    // 包满时以背包容量为受阻原因，不能表述为箱内没有目标物。
    const lead = noRoom
      ? `背包 ${INVENTORY_SLOTS} 格全满了,${itemAsked(item, call.pick)}取不出来`
      : `附近箱子里没取到${itemAsked(item, call.pick)}`;
    throw new SkillBlocked(`${lead}。${notes.join('；')}`);
  }
  // 差多少说多少:`取出了×4` 对一句「要 16 个」是半截事实,她会当成到齐了往下走
  const short = got < count ? `(要 ${count} 个,${noRoom ? '背包满了,没处放' : '附近箱子里就取到这些'})` : '';
  const head = `从箱子取出了${zhName(item)}×${got}${short}`;
  if (unconfirmed > 0) {
    return `${head};其中 ${unconfirmed} 个服务端还没回灌确认。${notes.join('；')}`;
  }
  return `${head}。${notes.join('；')}`;
}

/** 输入槽只有一格:同一次只烧一种,包里符合的挑最多的那一摞 */
function pickSmeltInput(bot: Bot, item: string) {
  return bot.inventory.items()
    .filter((i) => matchItemName(item, i.name))
    .sort((a, b) => b.count - a.count)[0];
}

/**
 * smelt 下料并点火后结束，不等待世界侧烧炼或宣称实际产量。
 * 回执提供炉位、投入量、预计完成时间和取货方式；expectedDoneAt 到期由账本通知。
 * 未开窗炉子的槽位不持续同步，实际产物须取货时读取。
 */
async function skillSmelt(
  bot: Bot,
  item: string,
  count: number,
  fuelName: string,
  ctx: SkillContext,
  pinAt?: Anchor,
): Promise<string> {
  const input = pickSmeltInput(bot, item);
  if (!input) throw new SkillBlocked(`包里没有${zhName(item)}`);
  // 要烧的那样东西自己不当燃料:同一摞既进输入槽又进燃料槽,账对不上,
  // 而且一句 smelt log 能把要烧的原木先烧光
  if (matchItemName(fuelName, input.name)) {
    throw new SkillBlocked(`${zhName(input.name)}正是要烧的东西,不能拿它自己当燃料`);
  }
  const fuelItem = bot.inventory.items()
    .filter((i) => i.name !== input.name && matchItemName(fuelName, i.name))
    .sort((a, b) => b.count - a.count)[0];
  if (!fuelItem) throw new SkillBlocked(`包里没有${zhName(fuelName)}`);
  const want = Math.min(count, invCount(bot, (n) => n === input.name));
  // 燃料多塞不亏:没烧掉的那部分收尾时 takeFuel 拿得回来,所以不必算每样烧几秒
  const fuelUse = Math.min(invCount(bot, (n) => n === fuelItem.name), 64);

  let at: StationAt;
  if (pinAt) {
    // 指定了炉子就用那一座:她点名的决定不再被"就近"覆盖
    const cell = resolveAt(bot, pinAt);
    await gotoGoal(bot, new goals.GoalNear(cell.x, cell.y, cell.z, 2), ctx);
    const block = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
    if (!block || !FURNACE_KINDS.has(block.name)) {
      throw new SkillBlocked(
        `(${cell.x}, ${cell.y}, ${cell.z}) 那一格是${block ? zhName(block.name) : '没加载的区块'},不是炉子`,
      );
    }
    at = {
      x: cell.x, y: cell.y, z: cell.z, name: block.name, block, placed: false,
      note: `用了指定的${zhName(block.name)} (${cell.x}, ${cell.y}, ${cell.z})`,
    };
  } else {
    // 还烧着别的东西的炉子不挑(账本口径:输入槽有别的料且没到点)。同料的炉子照常
    // 复用——往里续料是同一炉的事。被跳过的每一座连着原因进回执
    const now = Date.now();
    const busy = new Map<string, string>();
    for (const r of ctx.chests?.loadedFurnaces(dimensionOf(bot)) ?? []) {
      const f = r.furnace;
      if (!f?.input || f.input.name === input.name) continue;
      if (f.expectedDoneAt !== null && f.expectedDoneAt <= now) continue;
      busy.set(`${r.x},${r.y},${r.z}`, `(${r.x}, ${r.y}, ${r.z}) 那座输入槽还留着${zhName(f.input.name)}`);
    }
    at = await ensureStation(bot, FURNACE_STATION, ctx, {
      skip: (c) => busy.get(`${c.x},${c.y},${c.z}`) ?? null,
    });
  }
  // 用的是哪一座、包里还剩几个,由工作站那一步自己报;自备的不是路上的耗材
  const station = `${at.note};`;
  const atLog = { x: at.x, y: at.y, z: at.z, name: at.name };
  const show = new ShowPacer(ctx.showTempo?.() ?? null);
  await show.openGap();
  let furnace: Awaited<ReturnType<Bot['openFurnace']>>;
  try {
    furnace = await openWindowGuarded(bot, ctx, () => bot.openFurnace(at.block));
  } catch (err) {
    if (err instanceof Aborted || err instanceof SkillBlocked) throw err;
    throw new SkillBlocked(`${station}打不开 (${at.x}, ${at.y}, ${at.z}) 的${zhName(at.name)}: ${zhErrorText((err as Error).message)}`);
  }

  const where = `(${at.x}, ${at.y}, ${at.z}) 的${zhName(at.name)}`;
  const cell = { x: at.x, y: at.y, z: at.z };
  let staleNote = '';
  /** 正常收尾和中断都将当前窗口实际槽位写入容器账本。 */
  const record = (): {
    input: ItemStack | null; fuel: ItemStack | null; output: ItemStack | null;
    doneAt: number | null; fuelLevel: number; progress: number;
  } => {
    const state = {
      input: furnace.inputItem() ?? null,
      fuel: furnace.fuelItem() ?? null,
      output: furnace.outputItem() ?? null,
    };
    const now = Date.now();
    const doneAt = furnaceDoneAt(furnace, state.input, at.name, now);
    ctx.chests?.rememberFurnace(dimensionOf(bot), cell, at.name, state, now, doneAt);
    return { ...state, doneAt, fuelLevel: furnace.fuel, progress: furnace.progress };
  };
  let loaded: ReturnType<typeof record>;
  try {
    try {
      await show.beat('open');
      // 上一炉的残留:成品先收走,否则新产物挤不进输出槽;还烧着别的就不硬塞
      const stale = furnace.outputItem();
      if (stale) {
        const staleName = stale.name;
        const staleCount = stale.count;
        await furnace.takeOutput().catch(() => undefined);
        const remaining = furnace.outputItem();
        const taken = staleCount - (remaining?.name === staleName ? remaining.count : 0);
        staleNote = taken > 0
          ? `先收走了上一炉剩在输出槽的${zhName(staleName)}×${taken};`
          : `上一炉的${zhName(staleName)}×${staleCount}仍在输出槽;`;
        await show.beat('click');
      }
      const leftover = furnace.inputItem();
      if (leftover && leftover.name !== input.name) {
        throw new SkillBlocked(`${where}输入槽还留着${zhName(leftover.name)},先处理已有原料`);
      }
      try {
        await furnace.putFuel(fuelItem.type, fuelItem.metadata ?? null, fuelUse);
        await show.beat('click');
        await furnace.putInput(input.type, input.metadata ?? null, want);
        // 炉火点起来在画面上亮一拍再关窗
        await show.beat('result');
      } catch (err) {
        if (err instanceof Aborted) throw err;
        throw new SkillBlocked(`往${where}里放东西失败: ${zhErrorText((err as Error).message)}`);
      }
    } finally {
      loaded = record();
    }
  } finally {
    furnace.close();
  }
  const perS = smeltPerItemMs(at.name) / 1000;
  const slot = (s: ItemStack | null): string => s ? `${zhName(s.name)}×${s.count}` : '空';
  const slots = `输入槽${slot(loaded.input)},燃料槽${slot(loaded.fuel)},输出槽${slot(loaded.output)}`;
  const burning = loaded.fuelLevel > 0 ? '炉火读数正在燃烧' : '未确认炉火正在燃烧';
  const progress = loaded.progress > 0 ? `烧炼进度读数 ${Math.round(loaded.progress * 100)}%` : '未确认烧炼进度';
  ctx.diag?.write({
    lane: 'craft', event: 'smelt-loaded', taskId: ctx.taskId,
    msg: `${where}:${slots};${burning},${progress}`,
    data: {
      at: atLog, requested: { input: input.name, want, fuel: fuelItem.name, fuelUse },
      ...loaded, expectedDoneAt: loaded.doneAt,
    },
  });
  const etaClock = loaded.doneAt !== null && ctx.clock ? `${ctx.clock(loaded.doneAt)} 左右,` : '';
  const estimate = loaded.doneAt === null ? '当前不估完成时间。'
    : `若燃料持续足够,预计 ${etaClock}${Math.max(0, Math.round((loaded.doneAt - Date.now()) / 1000))} 秒后出完,到时提醒查看。`;
  return `${station}在${where}下料后读到:${staleNote}${slots}。${burning},${progress}。` +
    `${zhName(at.name)}烧一件约 ${perS} 秒。${estimate}` +
    `取货:{"skill":"take","at":[${at.x},${at.y},${at.z}],"all":true}`;
}

// ── 附魔台 ────────────────────────────────────────────────────────────────────

/**
 * 附魔台周围哪些格算书架。原版判据:八个相邻方向各看一次,那个方向脚下与齐头两格
 * **都得是空气**(中间挡了火把/方块整条就不算),然后数它外面那一圈的书架。
 * 吃满是 15 座,再多不涨。
 */
const BOOKSHELF_RING: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
];

function countBookshelves(bot: Bot, cell: Cell): number {
  const shelf = (dx: number, dy: number, dz: number): number =>
    (blockAtCell(bot, { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz })?.name === 'bookshelf' ? 1 : 0);
  const seen = new Set<string>();
  let n = 0;
  const take = (dx: number, dy: number, dz: number): void => {
    const key = `${dx},${dy},${dz}`;
    if (seen.has(key)) return;
    seen.add(key);
    n += shelf(dx, dy, dz);
  };
  for (const [dx, dz] of BOOKSHELF_RING) {
    const gapLow = blockAtCell(bot, { x: cell.x + dx, y: cell.y, z: cell.z + dz });
    const gapHigh = blockAtCell(bot, { x: cell.x + dx, y: cell.y + 1, z: cell.z + dz });
    if (!gapLow || !gapHigh || !AIR_NAMES.has(gapLow.name) || !AIR_NAMES.has(gapHigh.name)) continue;
    for (const dy of [0, 1]) {
      take(dx * 2, dy, dz * 2);
      if (dx !== 0 && dz !== 0) {
        take(dx * 2, dy, dz);
        take(dx, dy, dz * 2);
      }
    }
  }
  return n;
}

/** 附魔窗口的三档报价;`level` 是门槛等级,`hint` 是原版下手前显示的那一条附魔 */
interface EnchantOffer {
  level: number;
  hint: ItemEnchant | null;
}

interface EnchantWindow {
  enchantments: Array<{ level: number; expected: { enchant: number; level: number } }>;
  enchant(choice: number): Promise<unknown>;
  putTargetItem(item: unknown): Promise<void>;
  putLapis(item: unknown): Promise<void>;
  targetItem(): { name: string; slot: number } | null;
  close(): void;
  slots: Array<{ name: string; count: number; slot: number } | null>;
  items(): Array<{ name: string; count: number; slot: number }>;
}

/** 三档报价都到齐(原版靠 craft_progress_bar 分条推过来)才读得出;超时就说没读到 */
async function awaitOffers(win: EnchantWindow, ctx: SkillContext): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    checkAbort(ctx);
    if (win.enchantments.every((e) => e.level >= 0)) return true;
    await sleep(80);
  }
  return false;
}

function offerText(i: number, o: EnchantOffer): string {
  const known = o.hint ? `${zhEnchant(o.hint.name)}${roman(o.hint.level)}、` : '';
  return `  ${i + 1} 档 需 ${o.level} 级 + ${i + 1} 青金石:${known}[未知]`;
}

const LAPIS = 'lapis_lazuli';

/**
 * 附魔台:只看三档报价,或按一档下手。
 *
 * 必须自开窗口:`use` 右键附魔台开出来的窗口在 skillUse 里被无条件 closeWindow,
 * 而 rememberWindow 只认容器族与炉子族。这里走 mineflayer 的 openEnchantmentTable,
 * 收尾一律把物品与青金石取回来再关窗。
 *
 * **不推荐哪一档**:三档的数字与书架数都是事实,选哪档是她的权衡。
 */
async function skillEnchant(
  bot: Bot,
  call: Extract<SkillCall, { skill: 'enchant' }>,
  ctx: SkillContext,
): Promise<string> {
  const cell = resolveAt(bot, call.at);
  await gotoGoal(bot, new goals.GoalNear(cell.x, cell.y, cell.z, 2), ctx);
  checkAbort(ctx);
  const block = blockAtCell(bot, cell);
  if (!block) throw new SkillBlocked(`${cellText(cell)} 所在区块没加载`);
  if (block.name !== 'enchanting_table') {
    throw new SkillBlocked(`${cellText(cell)} 那一格是${zhName(block.name)},不是附魔台`);
  }
  const target = bot.inventory.items().find((i) => i.name === call.item);
  if (!target) throw new SkillBlocked(`包里没有${zhName(call.item)}`);
  const already = readEnchants(target as never, bot.registry as never);
  const lapisHave = invCount(bot, (n) => n === LAPIS);
  const shelves = countBookshelves(bot, cell);
  const levelBefore = bot.experience?.level ?? 0;
  const where = `附魔台 (${cell.x}, ${cell.y}, ${cell.z})`;

  const win = await openWindowGuarded(
    bot, ctx, () => bot.openEnchantmentTable(block) as unknown as Promise<EnchantWindow>,
  );
  let offers: EnchantOffer[] = [];
  let done = '';
  try {
    const inWindow = (name: string) => win.items().find((i) => i.name === name);
    const item = inWindow(call.item);
    if (!item) throw new SkillBlocked(`包里没有${zhName(call.item)}`);
    await win.putTargetItem(item);
    const lapis = lapisHave > 0 ? inWindow(LAPIS) : undefined;
    if (lapis) await win.putLapis(lapis);
    if (!(await awaitOffers(win, ctx))) {
      throw new SkillBlocked(
        `${where}:放上${zhName(call.item)}${lapisHave > 0 ? `与青金石×${lapisHave}` : '(包里没有青金石)'}后,` +
        `服务端没给出报价。${already.length > 0 ? '这件东西已经附过魔,附魔台不收' : '等了 3 秒没读到'}`,
      );
    }
    offers = win.enchantments.map((e) => ({
      level: e.level,
      hint: e.expected.enchant >= 0
        ? {
          name: (bot.registry as unknown as { enchantments?: Record<number, { name?: string }> })
            .enchantments?.[e.expected.enchant]?.name ?? `#${e.expected.enchant}`,
          level: Math.max(1, e.expected.level),
        }
        : null,
    }));
    if (call.index !== undefined) {
      const i = call.index - 1;
      const need = call.index;
      const blockedBy: string[] = [];
      if (offers[i].level <= 0) blockedBy.push(`${call.index} 档这会儿没有报价`);
      if (levelBefore < offers[i].level) blockedBy.push(`要 ${offers[i].level} 级,现在 ${levelBefore} 级`);
      if (levelBefore < need) blockedBy.push(`还要至少 ${need} 级`);
      if (lapisHave < need) blockedBy.push(`要 ${need} 个青金石,包里 ${lapisHave} 个`);
      if (blockedBy.length > 0) {
        throw new SkillBlocked(`${where}:${call.index} 档下不了手——${blockedBy.join(';')}`);
      }
      await win.enchant(i);
      await sleep(300);
      const after = win.targetItem();
      const got = after ? readEnchants(after as never, bot.registry as never) : [];
      done = `第 ${call.index} 档下手了:${zhName(call.item)} → `
        + `${got.length > 0 ? got.map((e) => `${zhEnchant(e.name)}${roman(e.level)}`).join('·') : '读不到附魔'}`;
    }
  } finally {
    // 东西一律取回来:窗口一关服务端会把留在槽里的丢在地上
    const left = win.targetItem();
    if (left) await bot.putAway(left.slot).catch(() => undefined);
    for (const s of [win.slots[1]]) if (s) await bot.putAway(s.slot).catch(() => undefined);
    win.close();
    await sleep(200);
  }
  const levelAfter = bot.experience?.level ?? 0;
  const lapisAfter = invCount(bot, (n) => n === LAPIS);
  const head = `${where}:等级 ${levelBefore} · 青金石 ${lapisHave} 个 · 周围有效书架 ${shelves} 座(吃满 15 座)`;
  const menu = offers.map((o, i) => offerText(i, o)).join('\n');
  const rule = '「需 N 级」是门槛;真扣掉的是档位号那么多级与同样多的青金石。'
    + '原版下手前每档只显示一条附魔,[未知] 是它没显示的那部分。';
  if (!done) {
    const worn = already.length > 0
      ? `\n${zhName(call.item)}身上已经有${already.map((e) => `${zhEnchant(e.name)}${roman(e.level)}`).join('·')}。`
      : '';
    return `${head}\n${menu}\n${rule}${worn}\n只看了报价,没下手。`;
  }
  return `${head}\n${menu}\n${done};等级 ${levelBefore} → ${levelAfter};青金石 ${lapisHave} → ${lapisAfter}。\n${rule}`;
}

// ── 酿造台 ────────────────────────────────────────────────────────────────────

/** 酿造台的窗口槽位(原版固定):0-2 三个瓶位,3 材料位,4 燃料位 */
const BREW_BOTTLE_SLOTS = [0, 1, 2] as const;
const BREW_INPUT_SLOT = 3;
const BREW_FUEL_SLOT = 4;

/** 原版一轮酿造 400 刻 = 20 秒,与瓶数无关 */
const BREW_ROUND_MS = 20_000;

const BREW_STATION: Station = {
  kinds: ['brewing_stand'], label: '酿造台', hint: '先 craft 一个酿造台(1 根烈焰棒 + 3 块圆石)',
};

interface GenericWindow {
  slots: Array<{ name: string; count: number; slot: number } | null>;
  items(): Array<{ name: string; count: number; slot: number }>;
  close(): void;
}

/** 一件药水念成「药水(内容 #N)」;`#N` 是原版药水注册表序号,不是药水都不带这个尾巴 */
function potionText(stack: { name: string; count: number } | null): string {
  if (!stack) return '空';
  const id = readPotionId(stack as never);
  return `${zhName(stack.name)}${id === null ? '' : `(内容 #${id})`}×${stack.count}`;
}

/** 三个瓶位现在各是什么;同内容的合并计数 */
function bottleText(win: GenericWindow, loaded: number): string {
  if (loaded === 0) return '空';
  const bits = BREW_BOTTLE_SLOTS
    .map((s) => win.slots[s] ?? null)
    .filter((s): s is { name: string; count: number; slot: number } => s !== null)
    .map((s) => potionText(s));
  return bits.length > 0 ? bits.join('、') : `${loaded} 瓶`;
}

/**
 * 酿造:走到台边下料点火就走,与 smelt 同构(寻址三态 + 异步好了提醒 + take 取货)。
 *
 * 三段材料链、红石萤石互斥这些原版规矩不在这里判 —— 判了就是替她决定这一瓶该怎么配。
 * 台子收不收这一对材料由服务端说了算,回执报下料前后槽里各是什么。
 */
async function skillBrew(
  bot: Bot,
  call: Extract<SkillCall, { skill: 'brew' }>,
  ctx: SkillContext,
): Promise<string> {
  const bottleHave = invCount(bot, (n) => n === call.bottle);
  if (bottleHave === 0) throw new SkillBlocked(`包里没有${zhName(call.bottle)}`);
  if (invCount(bot, (n) => n === call.input) === 0) throw new SkillBlocked(`包里没有${zhName(call.input)}`);

  let at: StationAt;
  if (call.at) {
    const cell = resolveAt(bot, call.at);
    await gotoGoal(bot, new goals.GoalNear(cell.x, cell.y, cell.z, 2), ctx);
    const block = blockAtCell(bot, cell);
    if (!block || block.name !== 'brewing_stand') {
      throw new SkillBlocked(
        `${cellText(cell)} 那一格是${block ? zhName(block.name) : '没加载的区块'},不是酿造台`,
      );
    }
    at = {
      x: cell.x, y: cell.y, z: cell.z, name: block.name, block, placed: false,
      note: `用了指定的酿造台 ${cellText(cell)}`,
    };
  } else {
    at = await ensureStation(bot, BREW_STATION, ctx);
  }
  const cell = { x: at.x, y: at.y, z: at.z };
  const where = `酿造台 ${cellText(cell)}`;
  const show = new ShowPacer(ctx.showTempo?.() ?? null);
  await show.openGap();
  let win: GenericWindow;
  try {
    win = await openWindowGuarded(bot, ctx, () => bot.openContainer(at.block) as unknown as Promise<GenericWindow>);
  } catch (err) {
    if (err instanceof Aborted || err instanceof SkillBlocked) throw err;
    throw new SkillBlocked(`${at.note};打不开${where}: ${zhErrorText((err as Error).message)}`);
  }
  const want = Math.min(call.count, bottleHave);
  let loaded = 0;
  let fuelPut = 0;
  try {
    await show.beat('open');
    const grab = (name: string) => win.items().find((i) => i.name === name);
    const inSlot = (slot: number) => win.slots[slot] ?? null;
    // 烧着才酿:燃料槽空了就补一份,已经有燃料就不再塞
    if (!inSlot(BREW_FUEL_SLOT)) {
      const fuel = grab(call.fuel);
      if (fuel) {
        await bot.moveSlotItem(fuel.slot, BREW_FUEL_SLOT).catch(() => undefined);
        fuelPut = inSlot(BREW_FUEL_SLOT)?.count ?? 0;
      }
    }
    for (const slot of BREW_BOTTLE_SLOTS.slice(0, want)) {
      if (inSlot(slot)) { loaded++; continue; }
      const bottle = grab(call.bottle);
      if (!bottle) break;
      await bot.moveSlotItem(bottle.slot, slot).catch(() => undefined);
      if (inSlot(slot)) loaded++;
      await show.beat('click');
    }
    const ingredient = grab(call.input);
    if (ingredient && !inSlot(BREW_INPUT_SLOT)) {
      await bot.moveSlotItem(ingredient.slot, BREW_INPUT_SLOT).catch(() => undefined);
      await show.beat('result');
    }
    if (!inSlot(BREW_INPUT_SLOT)) {
      throw new SkillBlocked(`${at.note};${where}的材料位没放进${zhName(call.input)},台子不收它`);
    }
    if (loaded === 0) throw new SkillBlocked(`${at.note};${where}的三个瓶位一个都没放进${zhName(call.bottle)}`);
  } finally {
    const state = {
      input: slotStack(win, BREW_INPUT_SLOT),
      fuel: slotStack(win, BREW_FUEL_SLOT),
      output: slotStack(win, BREW_BOTTLE_SLOTS[0]),
    };
    const now = Date.now();
    ctx.chests?.rememberFurnace(
      dimensionOf(bot), cell, 'brewing_stand', state, now,
      state.input && loaded > 0 ? now + BREW_ROUND_MS : null,
    );
    win.close();
  }
  const fuelNote = fuelPut > 0
    ? `燃料槽放了${zhName(call.fuel)}×${fuelPut}(一份烧 20 轮)`
    : `燃料槽本来就有${zhName(win.slots[BREW_FUEL_SLOT]?.name ?? call.fuel)}`;
  const etaClock = ctx.clock ? `${ctx.clock(Date.now() + BREW_ROUND_MS)} 左右` : '20 秒后';
  ctx.diag?.write({
    lane: 'craft', event: 'brew-start', taskId: ctx.taskId,
    msg: `${where}:${loaded} 瓶${call.bottle} + ${call.input}`,
    data: { at: cell, bottles: loaded, input: call.input, fuel: call.fuel, fuelPut },
  });
  return `${at.note};在${where}下了料:瓶位${bottleText(win, loaded)},材料位${zhName(call.input)},${fuelNote}。`
    + `一轮约 20 秒(${etaClock}好,有事件提醒);这段时间不用守着。`
    + `取货:{"skill":"take","at":[${cell.x},${cell.y},${cell.z}],"all":true}`;
}

/** 酿造台取货:三个瓶位 + 剩下的材料与燃料,一律 shift 回包里 */
async function takeFromBrewingStand(
  bot: Bot,
  call: Extract<SkillCall, { skill: 'take' }>,
  cell: Cell,
  block: NonNullable<ReturnType<Bot['blockAt']>>,
  ctx: SkillContext,
): Promise<string> {
  const where = `${cellText(cell)} 的酿造台`;
  const show = new ShowPacer(ctx.showTempo?.() ?? null);
  await show.openGap();
  let win: GenericWindow;
  try {
    win = await openWindowGuarded(bot, ctx, () => bot.openContainer(block) as unknown as Promise<GenericWindow>);
  } catch (err) {
    if (err instanceof Aborted || err instanceof SkillBlocked) throw err;
    throw new SkillBlocked(`打不开 ${where}: ${zhErrorText((err as Error).message)}`);
  }
  const before = invSnapshot(bot);
  const pred: InvPred | null = call.item ? itemPredOf(bot, call.item, call.pick) : null;
  const took: string[] = [];
  let leftBehind: string | null = null;
  try {
    await show.beat('open');
    for (const slot of [...BREW_BOTTLE_SLOTS, BREW_INPUT_SLOT, BREW_FUEL_SLOT]) {
      const s = win.slots[slot];
      if (!s) continue;
      if (pred && !pred(s.name, s as never)) {
        leftBehind = leftBehind ?? `${zhName(s.name)}×${s.count} 不是要取的,留在台里`;
        continue;
      }
      checkAbort(ctx);
      const label = potionText(s);
      await bot.putAway(s.slot).catch(() => undefined);
      if (!win.slots[slot]) {
        took.push(label);
        await show.beat('click');
      }
    }
    const state = {
      input: slotStack(win, BREW_INPUT_SLOT),
      fuel: slotStack(win, BREW_FUEL_SLOT),
      output: slotStack(win, BREW_BOTTLE_SLOTS[0]),
    };
    ctx.chests?.rememberFurnace(dimensionOf(bot), cell, 'brewing_stand', state, Date.now(), null);
  } finally {
    win.close();
  }
  if (took.length === 0) {
    throw new SkillBlocked(`${where}里没有取到东西${leftBehind ? `(${leftBehind})` : '(五个槽都空着)'}`);
  }
  await awaitGainsConfirm(bot, [], 0, ctx).catch(() => undefined);
  return `从${where}取了 ${took.join('、')}${leftBehind ? `;${leftBehind}` : ''}。${lootNote(before, bot)}`;
}

/**
 * 显式穿门只认当前维度里实际读到的下界传送门方块。寻路负责到门边，最后踏进
 * 门里的动作由这一步自己完成；维度未改变前绝不把“到了门口”当成完成。
 */
async function skillTransit(
  bot: Bot,
  call: Extract<SkillCall, { skill: 'transit' }>,
  ctx: SkillContext,
): Promise<string> {
  const portal = resolveAt(bot, call.at);
  const block = blockAtCell(bot, portal);
  if (!block) throw new SkillBlocked(`${cellText(portal)} 所在区块没加载`);
  if (block.name !== 'nether_portal') {
    throw new SkillBlocked(`${cellText(portal)} 是${zhName(block.name)},不是下界传送门方块`);
  }

  const fromDimension = normalizeDimension(dimensionOf(bot));
  await gotoGoal(bot, new goals.GoalNear(portal.x, portal.y, portal.z, 1), ctx);
  checkAbort(ctx);
  const reread = blockAtCell(bot, portal);
  if (reread?.name !== 'nether_portal') {
    throw new SkillBlocked(`走到门边时 ${cellText(portal)} 已经不是下界传送门了`);
  }

  dropGoal(bot, 'task', '到门边了,自己走进去', ctx.diag);
  await bot.lookAt(new Vec3(portal.x + 0.5, portal.y + 0.8, portal.z + 0.5), true);
  const deadline = Date.now() + 20_000;
  try {
    while (normalizeDimension(dimensionOf(bot)) === fromDimension) {
      checkAbort(ctx);
      if (Date.now() >= deadline) {
        throw new SkillBlocked(`已经走进 ${cellText(portal)} 的门里等了 20 秒,维度仍是${zhDimension(fromDimension)}`);
      }
      const feet = feetOf(bot);
      const bodyInPortal = blockAtCell(bot, feet)?.name === 'nether_portal'
        || blockAtCell(bot, { x: feet.x, y: feet.y + 1, z: feet.z })?.name === 'nether_portal';
      bot.setControlState('forward', !bodyInPortal);
      await sleep(100);
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
  }

  const changedAt = Date.now();
  let last = bot.entity.position.clone();
  let stableAt = changedAt;
  while (Date.now() - changedAt < 3_000) {
    checkAbort(ctx);
    await sleep(100);
    const now = bot.entity.position;
    if (now.distanceTo(last) > 0.1) {
      last = now.clone();
      stableAt = Date.now();
    }
    if (Date.now() - changedAt >= 600 && Date.now() - stableAt >= 400) break;
  }
  const toDimension = normalizeDimension(dimensionOf(bot));
  const arrived = feetOf(bot);
  return `穿门成功:${zhDimension(fromDimension)} ${cellText(portal)} → `
    + `${zhDimension(toDimension)} ${cellText(arrived)}(两端都由这次维度切换实测)`;
}

/** flee 的自身时限那一路。定时器 unref,不拖住进程退出 */
function fleeDeadline(startedAt: number): Promise<'timeout'> {
  return new Promise<'timeout'>((resolve) => {
    const left = Math.max(0, FLEE_DEADLINE_MS - (Date.now() - startedAt));
    const timer = setTimeout(() => resolve('timeout'), left);
    timer.unref?.();
  });
}

/**
 * flee 超时那一条受阻文案。全是读数:逃了多久、离出发点多远(离要求的还差多少)、
 * 当初那只现在多远、身边此刻还剩几只。
 *
 * 不写"逃不掉""换个法子"这类结论 —— 换不换招是她的决定(IO 回报三原则)。
 */
function fleeTimeoutText(
  bot: Bot,
  want: number,
  started: HostileRead,
  from: { x: number; y: number; z: number },
  startedAt: number,
): string {
  const at = bot.entity.position;
  const moved = Math.hypot(at.x - from.x, at.z - from.z);
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const chaser = started.e.isValid === false || !started.e.position
    ? `当初那只${zhEntity(started.e.name ?? '它')}已经不在实体表里`
    : `当初那只${zhEntity(started.e.name ?? '它')}起手 ${Math.round(started.d)} 格、现在 `
      + `${Math.round(started.e.position.distanceTo(at))} 格`;
  const foes = hostilesAround(bot, at);
  const around = foes.length === 0
    ? '此刻 32 格内没有敌对生物了'
    : `此刻 32 格内还有 ${foes.length} 只:`
      + foes.slice(0, 3).map((f) => `${zhEntity(f.e.name ?? '它')} ${Math.round(f.d)} 格`).join('、')
      + (foes.length > 3 ? '……' : '');
  return `没拉开:逃了 ${secs} 秒,离出发那儿 ${Math.round(moved)} 格(这一单要的是 ${want} 格),`
    + `人在 ${cellText(feetOf(bot))};${chaser};${around}`;
}

async function runSkill(bot: Bot, call: SkillCall, ctx: SkillContext): Promise<string> {
  switch (call.skill) {
    case 'goto': {
      if (call.dimension
        && normalizeDimension(dimensionOf(bot)) !== normalizeDimension(call.dimension)) {
        throw new SkillBlocked(
          `这处坐标属于${zhDimension(call.dimension)},我当前在${zhDimension(dimensionOf(bot))};`
          + '先用 transit 穿门,不能把两边坐标直接拿来算路',
        );
      }
      const target = call.groundY ? surfaceFeetAt(bot, call.at) : resolveAt(bot, call.at);
      if (call.dryRun) {
        const probes = ctx.probeRoutes?.(target);
        if (!probes || probes.length === 0) throw new SkillBlocked('探路器不可用(没连上服务器)');
        const me = bot.entity.position;
        const startDist = Math.hypot(me.x - target.x, me.y - target.y, me.z - target.z);
        return renderRouteMenu(probes, target, { startDist, diag: ctx.probeTarget?.(target) ?? null });
      }
      const note = routeNote(bot, ctx, target);
      const startedAt = Date.now();
      try {
        await gotoGoal(bot, new goals.GoalNear(target.x, target.y, target.z, 1), ctx);
      } catch (err) {
        // 失败回执同时保留出发点的三档试算与当前位置的 withRouteScene 诊断，标明各自位置。
        throw withRouteScene(
          bot, ctx, err, target,
          [...digBackoffScene(ctx, startedAt), ...(note ? [note] : [])],
        );
      }
      return `到了 ${cellText(feetOf(bot))}${note ? `。\n${note}` : ''}`;
    }
    case 'transit': return skillTransit(bot, call, ctx);
    case 'find': return skillFind(bot, call.target, call.direction, call.distance, ctx, call.until);
    case 'goto_player': {
      if (!isKnownTarget(bot, call.name)) throw new SkillBlocked(`${call.name} 不在线`);
      const e = findEntity(bot, call.name, 128);
      if (!e) throw new SkillBlocked(`${call.name} 在线但不在附近 128 格内`);
      await gotoGoal(bot, new goals.GoalFollow(e, 2), ctx);
      return `到 ${call.name} 身边了`;
    }
    case 'follow': {
      if (!isKnownTarget(bot, call.name)) throw new SkillBlocked(`${call.name} 不在线`);
      const e = findEntity(bot, call.name, 128);
      if (!e) throw new SkillBlocked(`${call.name} 在线但不在附近 128 格内`);
      setOwnedGoal(bot, new goals.GoalFollow(e, 3), 'task', `跟着 ${call.name}`, { dynamic: true, diag: ctx.diag });
      // 持续任务:挂着直到被顶替/叫停
      while (!ctx.aborted() && e.isValid) await sleep(500);
      dropGoal(bot, 'task', '跟随结束', ctx.diag);
      if (!e.isValid) return `${call.name} 不见了,停止跟随`;
      throw new Aborted(ctx.abortedBy?.() ?? null);
    }
    case 'flee': {
      const me = bot.entity.position;
      const nearest = nearestHostileTo(bot, me);
      if (!nearest) throw new SkillNoop('附近 32 格内没有敌对生物,不用逃');
      ctx.escape.active = true;
      const from = { x: me.x, y: me.y, z: me.z };
      const startedAt = Date.now();
      const away = me.minus(nearest.e.position);
      const flat = Math.hypot(away.x, away.z) || 1;
      const x = Math.round(me.x + (away.x / flat) * call.distance);
      const z = Math.round(me.z + (away.z / flat) * call.distance);
      const fleeGoal = levelTravelGoal(x, z);
      try {
        // 这一步自己的时限(见 FLEE_DEADLINE_MS):到点撤目标、按事实收工,
        // 不熬满 gotoGoal 借来的两分钟。迟到的 gotoGoal 拒绝单独接住,
        // 不让它在超时胜出之后变成未捕获拒绝。
        const travel = gotoGoal(bot, fleeGoal, ctx).then(() => 'arrived' as const);
        travel.catch(() => undefined);
        const outcome = await Promise.race([travel, fleeDeadline(startedAt)]);
        if (outcome === 'timeout') {
          dropGoal(bot, 'task', 'flee 到了自身时限', ctx.diag);
          throw new SkillBlocked(fleeTimeoutText(bot, call.distance, nearest, from, startedAt));
        }
      } catch (err) {
        // 试算与行军判同一个目标(见 levelTravelGoal):逃跑受阻的现场要说得出
        // 这条路到底能推进到哪儿
        throw withRouteScene(bot, ctx, err, { x, y: feetOf(bot).y, z }, [], fleeGoal);
      }
      const at = bot.entity.position;
      return `甩开了${zhEntity(nearest.e.name ?? '它')},现在在 (${Math.round(at.x)}, ${Math.round(at.y)}, ${Math.round(at.z)})`;
    }
    case 'surface': {
      // 下界 y=127 是基岩顶,「露天」这件事不存在;不拦她耗满 8 秒跳键才发现
      if (dimensionOf(bot).includes('nether')) {
        throw new SkillBlocked('下界没有露天,这个技能在这儿用不了(顶上到 y=127 全是基岩)');
      }
      if (!headInWater(bot) && !bodyInWater(bot)) return skillSurfaceLand(bot, ctx);
      ctx.escape.active = true;
      // 换气与寻找落脚点分别裁决；循环重申 jump，避免被顶替任务迟到的 finally 清掉。
      const breathe = Date.now() + 8_000;
      while (headInWater(bot) && Date.now() < breathe && !ctx.aborted()) {
        bot.setControlState('jump', true);
        await sleep(200);
      }
      checkAbort(ctx);
      // 只有实际出水才能报告浮上水面；超时时保留 jump，交给随后的登岸寻路。
      const surfaced = !headInWater(bot);
      if (surfaced) bot.setControlState('jump', false);
      const head = surfaced
        ? '我浮上了水面'
        : `按着上浮 8 秒还没出水,人在 ${cellText(feetOf(bot))}(氧气 ${bot.oxygenLevel ?? 20}/20)`;
      // 跳键不许漏出这个技能:它会污染后续所有任务。松开推迟到登岸这一程走完为止,
      // 超时那条出口正靠它继续上浮。
      try {
        const land = findNearbyAirColumn(bot, 32, landSearchUp(bot));
        if (!land) {
          throw new SkillBlocked(`${head},但 32 格内没找到可站立的岸;只换到气,还没有脱离液体`);
        }
        try {
          await gotoGoal(bot, new goals.GoalBlock(land.x, land.y, land.z), ctx);
        } catch (err) {
          if (err instanceof Aborted) throw err;
          throw new SkillBlocked(`${head},但游不到看见的那处岸(${(err as Error).message});还没有脱离液体`);
        }
        if (!(await stableDryFooting(bot, ctx))) {
          throw new SkillBlocked(`${head};我游到了岸边但没有稳定站上干燥落脚格,还没有脱离液体`);
        }
        const feet = feetOf(bot);
        const skyVisible = !skyBlocked(bot, feet.x, feet.y + 2, feet.z);
        const state = surfaceStateText(bot);
        return skyVisible
          ? `我脱离液体并站稳了,这里能看见天空;${state}`
          : `我脱离液体并站稳了,这里仍有遮盖,没有回到露天;${state}`;
      } finally {
        bot.setControlState('jump', false);
      }
    }
    case 'collect':
      return withBlueprintGain(bot, ctx, () =>
        skillCollect(bot, call.block, call.count, ctx, call.buried === true, call.mature === true, call.tool));
    case 'fish': return skillFish(bot, call, ctx);
    case 'build':
      return 'blueprint' in call ? skillBuildBlueprint(bot, call, ctx) : skillBuild(bot, call, ctx);
    case 'excavate': return skillExcavate(bot, call, ctx);
    case 'tunnel': return skillTunnel(bot, call, ctx);
    case 'probe': return skillProbe(bot, call, ctx);
    case 'use': return skillUse(bot, call, ctx);
    case 'ride': return skillRide(bot, call, ctx);
    case 'anvil': return skillAnvil(bot, call, ctx);
    case 'grindstone': return skillGrindstone(bot, call, ctx);
    case 'craft': return skillCraft(bot, call, ctx);
    case 'smelt': return skillSmelt(bot, call.input, call.count, call.fuel, ctx, call.at);
    case 'brew': return skillBrew(bot, call, ctx);
    case 'enchant': return skillEnchant(bot, call, ctx);
    case 'eat': return skillEat(bot, call.item);
    case 'attack': return skillAttack(bot, call.target, call.mode ?? 'auto', ctx);
    case 'equip': return skillEquip(bot, call);
    case 'pickup': return withBlueprintGain(bot, ctx, () => skillPickup(bot, ctx, call.item));
    case 'toss': return skillToss(bot, call, ctx);
    case 'lead': return skillLead(bot, call, ctx);
    case 'stow': return skillStow(bot, call, ctx);
    case 'take': return withBlueprintGain(bot, ctx, () => skillTake(bot, call, ctx));
    case 'chat': {
      bot.chat(call.text);
      return `说了: ${call.text}`;
    }
  }
}

/** 执行器 → World 的汇报。text 已渲染好,World 包成 minecraft.task 事件。 */
export interface TaskReport {
  /** partial 表示动作已有成果，但声明的量未完成。 */
  /** cancelled 表示被叫停、顶替或停机取消，未经过正常 finish 的任务终态。 */
  kind: 'done' | 'partial' | 'blocked' | 'superseded' | 'reflex' | 'cancelled';
  text: string;
  /** 这条汇报说的是哪个任务;反射不属于任何任务,没有 */
  taskId?: number;
  /** 这条汇报已经讲明了掉血的来由;World 据此不再复述一遍掉血播报 */
  hurt?: boolean;
}

/** 中止标记；设置 aborted 的调用方同时记录抢占来源 by。 */
interface AbortFlag {
  aborted: boolean;
  by: string | null;
  /** 死亡边界推进后，旧异步执行即使迟到也不能写回或继续泵队列。 */
  epoch: number;
}

/** 已落地步骤的终态；供未运行 finish 的取消路径通过 reportCancelled 回报各步结果。 */
interface StepLanding {
  /** 1 起的步号 */
  step: number;
  /** 这一步是什么(describeSkill 的说法,与受理回执同一口径) */
  what: string;
  /** 与 needs 闸门读的 outcomes 同一套判词 */
  outcome: StepOutcome;
  /** 一句原因(截短);做成的那几步没有 */
  why: string | null;
  /**
   * 结局回执里这一步那一行,完整。断点续做的单靠它把断点之前的步原样摆回 finish()
   * 的回执 —— 那几步没在别处报过,续做后的结局回执是它们唯一的出口。
   */
  line: string;
}

/** 一步落地的终态。闸门、账本、结局回执三处同一套判词 */
type StepOutcome = 'ok' | 'noop' | 'partial' | 'fail' | 'skip';

/** 被切断那一刻补的一条:正在跑的那一步。只出现在终态回投里,不进账本 */
interface CutLanding {
  step: number;
  what: string;
  outcome: 'cut';
  why: string | null;
}

/** 一条回投里最多列几步。多出来的只报个数 —— 12 步的单不该把上下文吃掉 */
const STEP_LANDING_CAP = 6;

/** 一步终态的判词。与 priorOutcomes 的 kind 同一套说法,两处不再各说各的 */
const STEP_LANDING_ZH: Readonly<Record<StepOutcome | 'cut', string>> = {
  ok: '做成了',
  partial: '做了一部分',
  noop: '没什么可做的',
  fail: '没做成',
  skip: '跳过了',
  cut: '做到一半被撤',
};

/**
 * 步骤终态回投那一段。跟着 `cancelled`/`superseded` 那条报告走 —— 它们本来就
 * 不唤醒(World 侧 `r.kind !== 'cancelled'`)、按攒批投递,所以这一段不新增任何一次
 * 唤醒,只是把已经发生过的事实塞进同一条事件里。
 */
function renderStepLandings(landings: readonly (StepLanding | CutLanding)[], stepCount: number): string {
  if (landings.length === 0) return '';
  const shown = landings.slice(-STEP_LANDING_CAP);
  const omitted = landings.length - shown.length;
  const one = (l: StepLanding | CutLanding): string =>
    `第 ${l.step}/${stepCount} 步 ${l.what}:${STEP_LANDING_ZH[l.outcome]}`
    + (l.why ? `(${l.why})` : '');
  return `各步下场:${omitted > 0 ? `前 ${omitted} 步略;` : ''}${shown.map(one).join(';')}。`;
}

/** 回投里的原因只留一句;整段受阻文案进这里会把回执撑爆 */
function shortWhy(why: string | null | undefined): string | null {
  if (!why) return null;
  const head = why.split('\n')[0].trim();
  return head.length > 40 ? `${head.slice(0, 40)}…` : head;
}

/** 排着队还没轮到的一件事 */
interface QueuedTask {
  id: number;
  steps: SkillCall[];
  /**
   * 已经落地的各步终态。挂在任务上而不是 ctx 上:战斗/环境挂起会重建 RunningTask,
   * 挂在 ctx 上的话断点续做之后前半程的账就没了。
   */
  stepLog?: StepLanding[];
  /** 受理那一刻;与 startedAt 之差就是排队等了多久,结局回执分开报两段 */
  enqueuedAt: number;
  /** 首次开跑时刻。断点续做的单带着它:结局回执的时刻段与排队时长按第一次开跑算 */
  startedAt?: number;
  /**
   * 战斗/环境挂起后续做:从这一步开始跑。之前的步不重跑,终态与回执行都照 stepLog
   * 里记的,进闸门、进结局回执。
   */
  resumeFrom?: number;
  /** 做到一半被打断且不可重跑的那一步(craft/smelt 这类);恢复时按没做成算 */
  interrupted?: number | null;
  /**
   * 挂起那一刻正在跑的那一步(1 起)与它的计数进度。只有 `suspend()` 冻的断点有,
   * 步边界冻结时没有步在跑。续做的 collect 按它扣掉已挖的数(见 resumedCollect),
   * 断点被撤时进终态回投。
   */
  progress?: { step: number; count: { done: number; total: number } | null };
  /** 这一单有意放下的落点(build 逐格登记;见 run 里的说明)。跟着任务走,续做不丢 */
  intended?: Set<string>;
  /**
   * 被更早一步顺手做掉的步 → 那一步的回执。挂在任务上而不是 ctx 上,是因为战斗
   * 挂起会重建 ctx:东西已经进箱子了,恢复后那一步再跑一遍只会报「包里没有X」。
   */
  absorbed?: Map<number, string>;
  /** 冻结断点的拥有者；仅同一组可恢复。战斗通过 busyWith 持有断点，深坠 hold 的释放不得恢复它。 */
  frozenBy?: QueueFreezeOwner;
}

/**
 * 队列断点的冻结者组。
 *
 * `queue` = 环境危机与深坠:两者各持**自己**的 queueHold 槽(见 QueueHoldSlot),
 * 但断点只有一个,归组不归槽 —— 谁先把当前任务挂起,断点就是这一组的,另一槽
 * 的释放不会替它解冻(队列要两槽都空才开闸,所以先后并不改变结果)。
 * `combat` = 战斗:它不持 queueHold,走 busyWith 闸,与上面那一组互不相干。
 */
export type QueueFreezeOwner = 'combat' | 'queue';

/**
 * environment/fall 各持自己的冻结令牌，各自释放并独立计时。
 * 两槽都空后才恢复队列。
 */
type QueueHoldSlot = 'environment' | 'fall';

/**
 * 这一步被打断后能不能从头重跑。goto/collect/build/excavate 这类幂等(build 重放
 * 已放好的格是 no-op、collect 按打断前的进度扣掉已挖的数续采,见 resumedCollect);
 * craft/smelt/toss/stow/take 重跑会重复扣料/重复转移,use 带 times>1 或商人成交
 * 同理——不重跑,按没做成算,下游按 needs 闸门自然处置。
 */
function reRunnable(call: SkillCall | undefined): boolean {
  if (!call) return true;
  switch (call.skill) {
    case 'craft': case 'smelt': case 'toss': case 'stow': case 'take': case 'brew': case 'transit': return false;
    // 只看报价那一形没有副作用,重跑无妨;下过手的那一形扣了等级与青金石,不重跑
    case 'enchant': return call.index === undefined;
    case 'use': return (call.times ?? 1) <= 1 && call.index === undefined;
    default: return true;
  }
}

/**
 * 断点续做时 collect 这一步实际要跑的形态。collect 的 count 是"这一趟挖几块",从进门
 * 那一刻起算,原样重进会把打断前挖到的再挖一遍(6/10 被打断,续做再挖 10 块)。
 * build/excavate/tunnel 的进度按几何续做,已挖已放的格重放是 no-op,不在此列。
 * 返回 null = 这一步不按剩余数续做。
 */
function resumedCollect(
  task: QueuedTask,
  i: number,
): { call: SkillCall; done: number; total: number; remaining: number; note: string } | null {
  const call = task.steps[i];
  const p = task.progress;
  if (call?.skill !== 'collect' || !p || p.step !== i + 1 || !p.count) return null;
  const { done, total } = p.count;
  const remaining = total - done;
  return {
    call: { ...call, count: remaining },
    done, total, remaining,
    note: remaining > 0
      ? `打断前已挖到 ${done}/${total} 块,接着挖剩下的 ${remaining} 块`
      : `打断前已挖够 ${total} 块`,
  };
}

interface RunningTask extends QueuedTask {
  /** 在跑的那一件账本一定在场(pump 建的时候补齐) */
  stepLog: StepLanding[];
  flag: AbortFlag;
  /** 由技能置位(flee/surface/战斗撤退):正在逃的任务反射不抢占 */
  escape: { active: boolean };
  startedAt: number;
  /** 做到第几步(0 起);进心跳那行,让agent知道一件事走到哪了 */
  stepIndex: number;
  /** 当前这一步是什么时候开始的 */
  stepStartedAt: number;
  /** 当前步骤的计数进度(collect/build/excavate/tunnel);非计数类为 null */
  count: { done: number; total: number } | null;
}

/**
 * 首步相对锚点入队即冻结，只解析带 ~ 的分量；无效表达式留给执行时报错。
 * 后续步骤和 expect 锚点仍在各自执行或评估时解析。
 */
export function freezeFirstStep(
  steps: readonly SkillCall[],
  origin: Cell,
): { steps: SkillCall[]; changed: boolean; origin: Cell } {
  if (steps.length === 0) return { steps: [...steps], changed: false, origin };
  let changed = false;
  const fz = (a: Anchor): Anchor => {
    if (a.every((c) => typeof c === 'number')) return a;
    const r = resolveAnchors([a], origin);
    if (!Array.isArray(r)) return a;
    changed = true;
    return [r[0].x, r[0].y, r[0].z];
  };
  const s0 = steps[0];
  let head: SkillCall = s0;
  switch (s0.skill) {
    case 'goto': case 'transit': case 'tunnel':
      head = { ...s0, at: fz(s0.at) };
      break;
    case 'fish':
      head = s0.at ? { ...s0, at: fz(s0.at) } : s0;
      break;
    case 'use':
      head = s0.at ? { ...s0, at: fz(s0.at) } : s0;
      break;
    case 'take':
      head = s0.at ? { ...s0, at: fz(s0.at) } : s0;
      break;
    case 'build':
      // 蓝图形态的 at 是锚点(蓝图 [0,0,0] 落哪儿),同样按下单那一刻的位置冻结
      head = 'blueprint' in s0
        ? (s0.at ? { ...s0, at: fz(s0.at) } : s0)
        : 'on' in s0
          ? { ...s0, on: s0.on.map((p) => ({ ...p, at: fz(p.at) })) }
          : { ...s0, anchors: s0.anchors.map(fz) };
      break;
    case 'excavate':
      head = { ...s0, anchors: s0.anchors.map(fz) };
      break;
    case 'probe':
      // 找块形态(radius)没有锚点,没什么可冻结的
      head = s0.anchors !== undefined ? { ...s0, anchors: s0.anchors.map(fz) } : s0;
      break;
    default:
      break;
  }
  if (!changed) return { steps: [...steps], changed: false, origin };
  return { steps: [head, ...steps.slice(1)], changed: true, origin };
}

/** 技能序列渲染成的一句话,回执与心跳里都用它指代这件事 */
function labelOf(task: QueuedTask): string {
  return task.steps.map((c) => describeSkill(c)).join(';');
}

/** 被新单顶替的任务须说明是否一步未执行，以及已执行到哪一步。 */
function cancelledNote(who: string, stepIndex: number, total: number, step: string): string {
  if (stepIndex <= 0) {
    return `⚠ 已叫停${who},它**一步都没跑过**就被这一单顶掉了 —— 它卡在第 1/${total} 步「${step}」`;
  }
  return `已叫停${who},它做到第 ${stepIndex + 1}/${total} 步`;
}

/** 任务同类签名由技能名和主目标原始 id 组成，不含坐标与数量。 */
function taskSignature(steps: readonly SkillCall[]): string {
  return steps.map((c) => {
    const o = c as unknown as Record<string, unknown>;
    const what = ['target', 'block', 'item', 'material', 'input', 'name']
      .map((k) => o[k])
      .find((v) => typeof v === 'string');
    return what ? `${c.skill}:${what as string}` : c.skill;
  }).join('>');
}

/** 同类任务的上次未达成终态：blocked、partial 或 noop。 */
interface PriorOutcome {
  kind: 'blocked' | 'partial' | 'noop';
  why: string;
  at: number;
}

/** 受理回顾只报告同类任务上次未达成的结果，注明为回顾，不作为当前可执行性的判据。 */
/** 同类签名不含坐标，因此回顾文案中的旧坐标须替换为“那一处”，避免冒充本次现场。 */
function maskCoords(why: string): string {
  return why.replace(/\(\s*-?\d+\s*,\s*-?\d+\s*,\s*-?\d+\s*\)/g, '那一处');
}

/** 打转账的一份快照:这一签名下过几次、跨了多久、其中几次真开跑过第 1 步 */
interface RoundaboutSnapshot {
  times: number;
  spanMs: number;
  ranBefore: number;
}

function priorOutcomeNote(prev: PriorOutcome, now: number, round: RoundaboutSnapshot | null): string {
  const mins = Math.round((now - prev.at) / 60_000);
  const when = mins <= 1 ? '刚才' : `${mins} 分钟前`;
  const how = prev.kind === 'partial' ? '好像只做成了一半'
    : prev.kind === 'noop' ? '当时没什么可做的'
      : '好像没做成';
  /* 报告窗口内同类任务的提交与实际开跑次数，不推荐行动。 */
  const spanMin = round ? Math.round(round.spanMs / 60_000) : 0;
  const span = spanMin >= 1 ? `${spanMin} 分钟内` : '这几分钟里';
  const tail = round && round.times >= 2
    ? `;这是${span}第 ${round.times} 次下同形状的单,`
      + (round.ranBefore === 0
        ? `前 ${round.times - 1} 次一步都没跑过`
        : `前 ${round.times - 1} 次里有 ${round.ranBefore} 次跑过第 1 步`)
    : '';
  return `${when}下过同类的单(按技能和目标算,不看坐标),${how}:${maskCoords(prev.why)}${tail}`;
}

/** 拦截重生锚破坏后，在此窗口内原样重发同一任务视为确认。 */
const SPAWN_CONFIRM_WINDOW_MS = 10 * 60_000;

/** 原版 1.20.6 的中毒食物后果；首次只报告并拒单，确认窗口内原样重发才受理。 */
const POISON_FOODS: Readonly<Record<string, string>> = {
  pufferfish: '河豚吃了会中毒 60 秒(血一路掉到只剩 1 才停)、饥饿 15 秒、反胃 15 秒',
  spider_eye: '蜘蛛眼吃了会中毒 5 秒(掉 4 点血,最低到 1)',
  poisonous_potato: '毒马铃薯吃了有六成概率中毒 5 秒(掉 4 点血,最低到 1)',
};
/** 毒食确认窗口:比重生锚短 —— 「刚被拦、马上重发」才算她拍板要吃 */
const POISON_CONFIRM_WINDOW_MS = 3 * 60_000;

/** 重力方块头顶保护高度，单位为格；只限制自身列贴近身体的这一段。 */
const GRAVITY_OVERHEAD = 3;

/**
 * 这一步的形状会动到哪些格。只覆盖几何族(build/excavate/tunnel):
 * 别的技能没有"一片格子"这个概念,返回 null 表示这道闸不管它。
 * 算不出来(锚点写错、超规模)也返回 null —— 闸不许成为第二个报错源,
 * 那些错由技能自己在出队刻照原样说。
 */
/**
 * 一段行军走满时的落点(方向单位向量 × distance)。这是**上界**,不是预测:
 * 路上碰到早停名单就正常收束,真走满才到这儿。坐标不取整 —— 它本来就是估算,
 * 取整只会让"约 130 格"看起来比它实际有的精度更硬。
 */
function marchEnd(feet: Cell, direction: Direction, distance: number): { x: number; y: number; z: number } {
  const [dx, dz] = DIRECTIONS[direction];
  const norm = Math.hypot(dx, dz) || 1;
  return { x: feet.x + (dx / norm) * distance, y: feet.y, z: feet.z + (dz / norm) * distance };
}

/**
 * 一步的代表性目标格(危险区陈述用):她写的 `at`,或形状族的第一个锚点。
 * 算不出来返回 null —— 陈述缺一句无所谓,报错才是问题。
 */
function targetCellOf(bot: Bot, call: SkillCall): Cell | null {
  try {
    const at = (call as { at?: unknown }).at;
    if (at !== undefined && at !== null) return resolveAt(bot, at as Anchor);
    const anchors = (call as { anchors?: unknown }).anchors;
    if (Array.isArray(anchors) && anchors.length > 0) return resolveAt(bot, anchors[0] as Anchor);
  } catch {
    return null;
  }
  return null;
}

function shapeFootprint(bot: Bot, call: SkillCall, desk?: BlueprintDesk | null): Cell[] | null {
  // 试算一格都不动:两道受理刻的闸都不该拦它(与 precheckStep 同一条豁免)
  if ((call as { dryRun?: boolean }).dryRun) return null;
  try {
    if (call.skill === 'excavate') {
      return shapeCells(bot, call.shape, call.anchors, call.fill, EXCAVATE_CELL_CAP);
    }
    if (call.skill === 'build') {
      if ('blueprint' in call) return blueprintFootprint(bot, call, desk).map((c) => c.cell);
      if ('on' in call) {
        return call.on.map((spot) => cellOnFace(resolveAt(bot, spot.at), spot.face));
      }
      return shapeCells(bot, call.shape, call.anchors, call.fill, BUILD_CELL_CAP);
    }
    if (call.skill === 'tunnel') {
      // 与 skillTunnel 同源:塔挖头顶那条、竖井挖脚下那条、斜通道两条都挖
      const start = feetOf(bot);
      const target = resolveAt(bot, call.at);
      const line = rasterize('line', [start, target], 'solid');
      if (!Array.isArray(line)) return null;
      const rise = target.y - start.y;
      const vertical = Math.max(Math.abs(target.x - start.x), Math.abs(target.z - start.z)) === 0;
      return vertical
        ? line.slice(1).map((c) => ({ x: c.x, y: rise > 0 ? c.y + 1 : c.y, z: c.z }))
        : line.flatMap((c) => [c, { x: c.x, y: c.y + 1, z: c.z }]);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 一张蓝图这一单会动到哪些格、每格放的是什么物品。
 *
 * 两道受理刻的闸(重生锚、重力方块)按它算 —— 蓝图那一单的落点全在图里,
 * 闸不认识图就等于对这条路整个失效:一张把床罩进去的图会一路盖到重生点作废。
 * 锚点取她这一单给的 `at`,没给就取本世界的施工绑定;两者都没有(第一次盖又忘了
 * 给锚点)时返回空 —— 那一单本来就跑不起来,由技能自己在出队刻说清。
 */
function blueprintFootprint(
  bot: Bot,
  call: BlueprintCall,
  desk?: BlueprintDesk | null,
): Array<{ cell: Cell; item: string }> {
  const site = desk?.get(call.blueprint) ?? null;
  if (!site) return [];
  const anchor: PositionXYZ | null = call.at
    ? (() => { const c = resolveAt(bot, call.at as Anchor); return [c.x, c.y, c.z] as PositionXYZ; })()
    : site.anchor;
  if (!anchor) return [];
  const limit = call.stopAfter === undefined
    ? site.plan.steps.length
    : stepCountThroughLayer(site.plan.steps, call.stopAfter);
  const out: Array<{ cell: Cell; item: string }> = [];
  for (const step of site.plan.steps) {
    if (step.index >= limit) break;
    for (let y = step.from[1]; y <= step.to[1]; y++) {
      for (let z = step.from[2]; z <= step.to[2]; z++) {
        for (let x = step.from[0]; x <= step.to[0]; x++) {
          const pos = toWorld(anchor, [x, y, z]);
          out.push({ cell: { x: pos[0], y: pos[1], z: pos[2] }, item: step.item });
        }
      }
    }
  }
  return out;
}

/** 重生锚保护格包括锚点、下方支撑，以及可读取的另一半床。 */
function spawnGuardCells(bot: Bot, anchor: { x: number; y: number; z: number }): Cell[] {
  const at: Cell = { x: Math.floor(anchor.x), y: Math.floor(anchor.y), z: Math.floor(anchor.z) };
  const cells: Cell[] = [at, { x: at.x, y: at.y - 1, z: at.z }];
  for (const [dx, , dz] of NEIGHBORS6) {
    if (dx === 0 && dz === 0) continue;
    const c = { x: at.x + dx, y: at.y, z: at.z + dz };
    const b = blockAtCell(bot, c);
    if (b && isSpawnAnchorBlock(b.name)) cells.push(c);
  }
  return cells;
}

/** 识别自身头顶的相对锚点表达式，不依赖当前位置。 */
function isOverheadAnchor(a: Anchor): boolean {
  const rel = (v: AnchorCoord): number | null => {
    if (typeof v !== 'string' || !/^~-?\d*$/.test(v)) return null;
    return v === '~' ? 0 : Number(v.slice(1));
  };
  const dy = rel(a[1]);
  return rel(a[0]) === 0 && rel(a[2]) === 0 && dy !== null && dy > 0 && dy <= GRAVITY_OVERHEAD;
}

/** 这一单是不是「显式指名对重生锚那一格动手」——那条路给确认,不是驳回 */
function namesSpawnAnchor(bot: Bot, call: SkillCall, guard: readonly Cell[]): boolean {
  // collect 按名字点名床/重生锚:她说的就是这个东西,不是顺带罩上的
  if (call.skill === 'collect') return isSpawnAnchorBlock(call.block);
  if (call.skill !== 'excavate') return false;
  const cells = shapeFootprint(bot, call, null);
  // 就那一格:形状语言里"指名"只有这一种写法
  return cells !== null && cells.length === 1
    && guard.some((g) => g.x === cells[0].x && g.y === cells[0].y && g.z === cells[0].z);
}

/** 一个对象里"真写了"的键:值是 undefined/null 的不算(schema 是扁平字段池,填 null 是照 schema 写的) */
function liveKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined && o[k] !== null);
}

/** 语义相等：对象忽略键序，数组按序，标量按值比较。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const ka = liveKeys(oa);
    const kb = liveKeys(ob);
    return ka.length === kb.length && ka.every((k) => kb.includes(k) && sameValue(oa[k], ob[k]));
  }
  return false;
}

/**
 * 受理回念只显示解析、冻结后与原输入不同的字段；被丢弃字段由 parseNoteText 报告。
 * 无原输入可比较时回念完整步骤。
 */
/** 这个值是不是「相对锚点」写法(带 `~` 的那种) */
function isRelativeAnchor(v: unknown): boolean {
  return Array.isArray(v) && v.some((c) => typeof c === 'string' && c.startsWith('~'));
}

/** 这个值是不是一串纯数坐标 */
function isAbsoluteAnchor(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((c) => typeof c === 'number');
}

/**
 * 相对锚点冻结的差异提到首句；补默认值注明按该值理解。
 * 路标解析结果置尾段；其他差异并列显示原输入与实际值。
 */
interface EchoParts {
  /** 提首句的那一类 */
  hoist: string | null;
  /** 留在尾段的那些 */
  tail: string | null;
}

function echoDiff(steps: readonly SkillCall[], wrote: unknown): EchoParts {
  if (!Array.isArray(wrote) || wrote.length !== steps.length) {
    return { hoist: null, tail: steps.length === 1 ? JSON.stringify(steps[0]) : JSON.stringify(steps) };
  }
  const hoisted: string[] = [];
  const parts: string[] = [];
  const marks: string[] = [];
  for (const [i, step] of steps.entries()) {
    const raw = wrote[i];
    const one = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const at = steps.length > 1 ? `第 ${i + 1} 步的 ` : '';
    const fields: string[] = [];
    for (const [key, val] of Object.entries(step as unknown as Record<string, unknown>)) {
      // skill 名必须一字不差才解析得出这一步,不可能有差别
      if (val === undefined || key === 'skill') continue;
      const hers = one[key];
      if (hers === undefined || hers === null) {
        fields.push(`${key} 你没写,我按 ${JSON.stringify(val)} 理解`);
      } else if (sameValue(val, hers)) {
        continue;
      } else if (isRelativeAnchor(hers) && isAbsoluteAnchor(val)) {
        hoisted.push(`${at}${key} 你写 ${JSON.stringify(hers)}、我按 ${JSON.stringify(val)} 跑`);
      } else if (typeof hers === 'string' && isAbsoluteAnchor(val)) {
        marks.push(`${at}${key} 路标「${hers}」= ${JSON.stringify(val)}`);
      } else {
        fields.push(`${key} 你写 ${JSON.stringify(hers)}、我按 ${JSON.stringify(val)} 跑`);
      }
    }
    if (fields.length > 0) parts.push(`${at}${fields.join(',')}`);
  }
  const tailBits = [
    parts.length > 0 ? `跟你写的不一样:${parts.join(';')}` : null,
    marks.length > 0 ? marks.join(';') : null,
  ].filter(Boolean);
  return {
    hoist: hoisted.length > 0 ? `相对锚点已折成绝对坐标:${hoisted.join(';')}` : null,
    tail: tailBits.length > 0 ? tailBits.join('。') : null,
  };
}

/**
 * 步行速度,格/秒。原版玩家平地走路 4.317 格/秒(疾跑 5.612,寻路器默认的
 * `Movements` 走的是走路姿态)。用这个固定值而不是本场均速:均速把绕路、挖掘、
 * 卡住全算了进去,拿它乘直线距离得到的既不是直线时长也不是实走时长。
 */
const WALK_BLOCKS_PER_SEC = 4.317;

/** 长途 goto 的距离阈值，单位为格。 */
const LONG_GOTO_BLOCKS = 100;

/** 直线距离 → 步行时长的人读写法 */
function fmtWalk(blocks: number): string {
  const sec = blocks / WALK_BLOCKS_PER_SEC;
  return sec < 90 ? `${Math.round(sec)} 秒` : `${Math.round(sec / 60)} 分钟`;
}

/** 队列此刻的样子。世界快照末行与任务结局回执都读它;没有"查队列"的工具 */
/**
 * 一步没做成的原文记录。四个字段全是**已经写好的那几句**原样搬过来,
 * 不改写、不归因(worlds-report-facts)。
 */
export interface BlockedRecord {
  /** 发生时刻(epoch ms);渲染成 HH:MM:SS 由调用方按自己的时区做 */
  at: number;
  /** 哪一单:`任务#12「造墙」` 这样的标签 */
  task: string;
  /** 哪一步:多步任务带步号;单步任务就是那一步本身 */
  step: string;
  /** 技能自己报的那句原话 */
  why: string;
}

/** 受阻原文账留几条。只读原语一次报 5 条,留一倍余量给「上一屏」 */
const BLOCKED_LOG_MAX = 10;

export interface QueueStatus {
  /** elapsedMs 是**这一步**跑了多久;整条任务的那份另给 taskElapsedMs */
  running: {
    id: number; label: string; step: string; stepIndex: number; stepCount: number; elapsedMs: number;
    /** 受理到现在。只看步骤耗时读不出「这一单已经磨了二十分钟」 */
    taskElapsedMs: number;
    count: { done: number; total: number } | null;
    pos: { x: number; y: number; z: number } | null;
  } | null;
  waiting: Array<{ id: number; label: string }>;
  /** 身体当前被反射或战斗持有的原因；未占用时为 null，供受理及队列回执共用。 */
  hold?: string | null;
}

/**
 * 队列渲染成一句话。给agent的每一处都用同一句:两处措辞不同的同一件事读起来
 * 就像两件事。
 */
export function renderQueue(q: QueueStatus): string {
  const r = q.running;
  // 两个耗时只在走起来之后才有读数:受理刻(replace 下单占 976/1338)两个数恒为
  // 「已跑 0s,整单已跑 0.0s」,印出来只是把「刚开跑」说第二遍
  const stepS = r ? Math.round(r.elapsedMs / 1000) : 0;
  const head = r
    ? `正在做任务#${r.id}「${r.label}」` +
      `(第 ${r.stepIndex + 1}/${r.stepCount} 步:${r.step}` +
      `${stepS > 0 ? `,已跑 ${stepS}s` : ''}` +
      `${r.taskElapsedMs >= 1000 ? `,整单已跑 ${fmtDur(r.taskElapsedMs)}` : ''}` +
      `${r.count ? `,进度 ${r.count.done}/${r.count.total}` : ''})` +
      `${r.pos ? `,我在 (${r.pos.x}, ${r.pos.y}, ${r.pos.z})` : ''}`
    // 手上没有**任务**不等于手空着:反射/战斗持身时照实点名占着它的是谁
    : q.hold
      ? `手上是${q.hold}(不是任务),队列头空着`
      : '手上没有在做的事';
  if (q.waiting.length === 0) return `${head};后面没有排着的了`;
  return `${head};后面排着 ${q.waiting.map((t) => `任务#${t.id}「${t.label}」`).join('、')}`;
}

/** 运行中任务的一份进度(周期捎带投递;计数过半那份升为常规攒批) */
export interface TaskProgress {
  taskId: number;
  label: string;
  stepIndex: number;
  stepCount: number;
  step: string;
  elapsedS: number;
  pos: { x: number; y: number; z: number } | null;
  /** 距上一份进度的净位移(格);第一份从步骤起点算。原地打转时这个数接近 0 */
  movedBlocks: number | null;
  count: { done: number; total: number } | null;
  /** 计数刚过半的那一份 */
  half: boolean;
  /** 这一刻人正躺在床上等醒:进度文案换一句说,别把"没挪窝"报成卡住 */
  sleeping?: boolean;
}

interface ExecutorOptions {
  getBot: () => Bot | null;
  report: (r: TaskReport) => void;
  log: Logger;
  /** 任务号发号器 */
  nextId: () => number;
  /** 回执里 HH:MM:SS 按哪个时区渲染;不给按东八区(与世界快照的现实时间同一默认) */
  timezone?: string;
  /** 战斗中生命跌破此值就收手撤退(与反射的脱战血线同源);不给 = 不撤 */
  fleeHealth?: () => number;
  /** 主动 attack 与被动战斗层共用的弓控制器出口；租约由执行器单独持有。 */
  ranged?: TaskRangedActions;
  /**
   * 前置试算开关(默认开)。返回 false 时受理刻不试算、出队刻不闸 —— 台架做 A/B 用,
   * 也留给控制台在判据出问题时一键退回旧行为。
   */
  precheck?: () => boolean;
  /**
   * 受理回执里捎带「上一次同样这一单是什么下场」(默认开)。
   * 它补的是**已经滑出上下文**的那一段——同一单隔了几十轮再下,上一次的终态
   * 早被交接压掉了。关掉退回旧行为(受理单只说这一单)。
   */
  priorOutcome?: () => boolean;
  /** World 日志;不给就不记 */
  diag?: MinecraftLog;
  /** 运行中步骤的进度快照(30s 周期 + 计数过半) */
  onProgress?: (p: TaskProgress) => void;
  /** 常驻规矩(mc_policy;World 持有并落盘) */
  policy?: SkillContext['policy'];
  /** 普通放置逐块取得许可；用于执行器外部持有的数量保留账。 */
  permitResourcePlacement?: ResourcePlacementGate;
  /** 试算的只读材料判据;不占串行闸 */
  previewResourcePlacement?: ResourcePlacementPreview;
  /** 路线试算(goto 的 dryRun 与受阻现场的三种走法用) */
  probeRoutes?: SkillContext['probeRoutes'];
  /** 目标点分诊(探路误诊断的另一半) */
  probeTarget?: SkillContext['probeTarget'];
  /** 挖掘失败退避账的取用面(桥持有);不接 = 这个部署没有退避(台架) */
  digBackoffSince?: SkillContext['digBackoffSince'];
  /**
   * 零位移探针里 World 那一半(战斗会话、环境 owner)。只读;不接 = 那两格记 null。
   * 队列冻结与断点由执行器自己补进去,见 `run()` 里的 `bodyState`。
   */
  bodyState?: () => Pick<BodyStateProbe, 'combatActive' | 'environmentOwnerKind'>;
  /** 清空冻结两槽后通知反射作废旧令牌；危机持续时需重新申请租约。 */
  onHoldsReleased?: () => void;
  /** 开过的箱子账本 */
  chests?: ChestBook;
  /** 成果登记(World 持久化) */
  works?: WorksBook;
  /** 探索覆盖账本落账(World 持久化) */
  explored?: SkillContext['explored'];
  /**
   * 身体现在被谁占着(战斗会话):非 null 时 pump 不开新任务,受理回执照实说
   * 「排上了,腾出手就做」。返回的字符串就是那个"在忙什么"。
   */
  busyWith?: () => string | null;
  /** 容器 GUI 演出节拍(SkillContext 同名字段的来源) */
  showTempo?: SkillContext['showTempo'];
  /** 任务做完且队列空了:兜底关掉忘关的容器窗口(GUI 演出的窗口卫生) */
  onDrain?: () => void;
  /** 白天点床时重生点已经悄悄搬走了没有(World 持有 set_spawn 的时刻) */
  spawnNote?: SkillContext['spawnNote'];
  /** 个人重生点那一格(World 持有);受理刻的重生锚闸与技能回执共读一份 */
  spawnAnchor?: SkillContext['spawnAnchor'];
  /** 蓝图施工面(World 持有);build 的蓝图形态、两道受理刻的闸与采集搭车共读一份 */
  blueprints?: SkillContext['blueprints'];
  /**
   * 路标表的取用面(World 持有 mc_map);不接 = 这个部署没有路标(台架),
   * 受理回执里那两句相对化与危险区陈述整段不出现。
   */
  marks?: () => MarkDesk;
  /**
   * `queue:"now"` 夺手时让战斗会话当场交还身体(CombatSession.standDown)。
   * 返回刚才在做什么;本来就没在打返回 null。不接 = 没有战斗层(台架)。
   */
  stopCombat?: () => string | null;
  /** Search cache namespace. A realm or connection-generation change invalidates all sightings. */
  searchContext?: () => { connectionGeneration: number; realm: string };
}

interface QueueHoldToken {
  readonly owner: symbol;
}

interface QueueResumeResult {
  released: boolean;
  note: string | null;
}

/**
 * 队列按提交顺序执行，步骤依赖规则见 StepBounds。
 * 单步受阻不撤后续任务，撤单由队列操作、自保抢占或生命周期处理决定。
 */
export class Executor {
  private task: RunningTask | null = null;
  private queue: QueuedTask[] = [];
  /**
   * 两个独立的冻结槽(见 QueueHoldSlot):环境危机一张、深坠一张,各自释放,
   * **都空了**队列才开闸。队列内容在冻结期间原样保留。
   */
  private readonly queueHolds: Record<QueueHoldSlot, { token: QueueHoldToken; reason: string } | null> = {
    environment: null,
    fall: null,
  };
  private stopped = false;
  private executionEpoch = 0;
  private activeAttack: TaskAttackLease | null = null;
  /** 战斗挂起中的任务(断点冻结,战后 resume 放回队头续做) */
  private frozen: QueuedTask | null = null;
  /** probe 差分单槽:mc_stop 不清,换执行器(重启)才清 */
  private readonly probeMemo: { last: ProbeMemo | null } = { last: null };
  /**
   * 每种「同一件事」上一次的下场。键是整单的技能+目标序列(见 taskSignature),
   * 只留没做成/做了一半的那些 —— 成功不入账,受理刻也就不会为它出声。
   */
  private readonly priorOutcomes = new Map<string, PriorOutcome>();
  /** 同类签名在 15 分钟内的提交时刻及开跑首步次数；与 priorOutcomes 共用键和窗口。 */
  private readonly roundabout = new Map<string, { submits: number[]; ran: number }>();
  /** 受阻理由的滚动账:归并键 → 发生时刻(见 blockedHeadline;头条只报次数,不留原文) */
  private readonly blockedReasons = new Map<string, { at: number[] }>();
  /**
   * 受阻原文按新到旧保留最近 BLOCKED_LOG_MAX 条，供只读查询使用。
   * blockedReasons 使用去坐标的归并键计数，此处保留完整原因。
   */
  private readonly blockedRecords: BlockedRecord[] = [];
  /** Real sightings are short-lived context, not PWSR or persisted memory. */
  private readonly findHistory = new FindObservationCache();
  /**
   * 重生锚闸的确认单槽:上一次被拦下的那一单是什么、什么时候拦的。
   * 原样重发即确认(见 SPAWN_CONFIRM_WINDOW_MS);换了单就换这一槽。
   */
  private spawnConfirm: { key: string; at: number } | null = null;
  /** 毒食闸的确认单槽,语义同 spawnConfirm(窗口见 POISON_CONFIRM_WINDOW_MS) */
  private poisonConfirm: { key: string; at: number } | null = null;
  /**
   * 「包快满了」这条提醒的击发状态:true = 还没报过,跌破就报;报完置 false,
   * 空位回到 BAG_LOW_FREE 以上再重新上膛(见 `bagLowNote`)。
   */
  private bagLowArmed = true;

  constructor(private readonly opts: ExecutorOptions) {}

  /** 当前任务在做什么;空闲为 null */
  get current(): string | null {
    return this.task ? labelOf(this.task) : null;
  }

  /** 当前任务(带任务号与已跑时长);空闲为 null */
  get currentTask(): { id: number; label: string; elapsedMs: number } | null {
    const t = this.task;
    return t ? { id: t.id, label: labelOf(t), elapsedMs: Date.now() - t.startedAt } : null;
  }

  status(): QueueStatus {
    const t = this.task;
    const p = this.opts.getBot()?.entity?.position;
    return {
      running: t
        ? {
            id: t.id,
            label: labelOf(t),
            step: describeSkill(t.steps[Math.min(t.stepIndex, t.steps.length - 1)]),
            stepIndex: t.stepIndex,
            stepCount: t.steps.length,
            elapsedMs: Date.now() - t.stepStartedAt,
            taskElapsedMs: Date.now() - t.startedAt,
            count: t.count,
            pos: p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null,
          }
        : null,
      waiting: [
        ...(this.frozen ? [{ id: this.frozen.id, label: `${labelOf(this.frozen)}(被打断,待续)` }] : []),
        ...this.queue.map((q) => ({ id: q.id, label: labelOf(q) })),
      ],
      // 与受理句读同一份来源(见 submit 里的 hold),两处不再各说各的
      hold: this.holdReason() ?? this.opts.busyWith?.() ?? null,
    };
  }

  /** 挂钟时刻 HH:MM:SS。一场就是一天,不带日期 */
  private clock(ms: number): string {
    return nowIso(this.opts.timezone ?? 'Asia/Shanghai', new Date(ms)).slice(11, 19);
  }

  /**
 * replace 撤销待办并接在当前任务后；append 排尾；now 中断当前任务并排首。
 * 回执说明撤销与中断对象；身体仍被自保持有时继续排队。
 * wrote 仅用于与解析、冻结后的步骤比较，差异按字段回念，无原文则完整回念。
 */
  submit(steps: SkillCall[], mode: QueueMode = 'replace', wrote?: unknown): string {
    if (this.stopped) return '[mc_do 失败] World 未启动';
    const id = this.opts.nextId();
    const at = Date.now();
    // 首步的相对锚点按受理位置冻结；后续步骤仍按各自执行时的位置解析。
    const p = this.opts.getBot()?.entity?.position;
    const frozen = p ? freezeFirstStep(steps, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }) : null;
    const task: QueuedTask = { id, steps: [...(frozen?.steps ?? steps)], enqueuedAt: at };
    // 两道受理刻驳回排在入队之前:队列一个字都不动,任务号也不发出去。
    // 它们与前置试算不同档 —— 试算只报否定不改变执行,这两条是"这一单不能受理"。
    const refused = this.spawnGuardNote(task.steps, at) ?? this.gravityGuardNote(task.steps)
      ?? this.poisonGuardNote(task.steps, at);
    const echo = echoDiff(task.steps, wrote);
    const echoText = [echo.hoist, echo.tail].filter(Boolean).join('。');
    if (refused) return `[${this.clock(at)}] 这一单我没接:${refused}${echoText ? `\n${echoText}` : ''}`;
    // 受理了才进打转账;没接的那几单不算她"下过一次"。快照要在 pump 之前取
    const round = this.noteSubmitted(taskSignature(task.steps), at);
    // 受理刻试算必须冻结在开工前。equip 会同步把装备移出背包，开工后重读会误报缺货。
    const precheck = this.precheckNote(task.steps);
    const dropped = mode === 'replace' ? this.queue.splice(0) : [];
    // queue:"now" = 手上的事全放下,战斗也一样。先让战斗交还身体(挂起的那件会被
    // resume 放回队头),再 interrupt 掐掉手上这件,最后这一单插到队头 —— 顺序反了
    // 就会是"刚解冻的旧任务排在急件前面"。
    const combatCut = mode === 'now' ? this.opts.stopCombat?.() ?? null : null;
    const cut = mode === 'now' ? this.interrupt() : null;
    if (mode === 'now') this.queue.unshift(task);
    else this.queue.push(task);
    const ahead = this.queue.indexOf(task) + (this.task ? 1 : 0) + (this.frozen ? 1 : 0);
    this.opts.diag?.write({
      lane: 'task', event: 'enqueue', taskId: id,
      msg: `受理任务#${id}「${labelOf(task)}」(${mode},前面还有 ${ahead} 件)`,
      data: {
        steps, mode, ahead, cut,
        dropped: dropped.map((d) => ({ id: d.id, label: labelOf(d) })),
      },
    });
    // 缺省的 replace 撤掉的那几件各补一条结局:受理回执点名只活在这一个上下文窗口里
    for (const d of dropped) this.reportCancelled(d, `新任务#${id} 顶替`, null);
    this.pump();
    // 身体被战斗占着时如实说"排上了":此刻队列闸着,说"已开始"就是说假话。
    // queue:"now" 可以打断普通交战，但低血或尚未安全结束的撤退仍会持有身体。
    // 交还动作之后重读 busyWith，避免把实际仍在排队的急件说成已经开跑。
    const hold = this.holdReason() ?? this.opts.busyWith?.() ?? null;
    /* 受理回执只说明收下或排队状态，不宣称完成，也不估计无依据的任务时长。 */
    const place = hold !== null
      ? `任务#${id} 排上了(${hold},腾出手就做${ahead > 0 ? `,前面还有 ${ahead} 件` : ''})`
      : ahead === 0
        // 入队回执注明首步内容；各步实际结果由后续事件报告。
        ? `任务#${id} 收下了,排在第 1/${task.steps.length} 步:${describeSkill(task.steps[0])}`
        : mode === 'now'
          ? `任务#${id} 插到队头,前面只剩 ${ahead} 件`
          : `任务#${id} 排进队尾,前面还有 ${ahead} 件`;
    const notes = [
      // 她自己圈过的危险区排在这一组最前面:这是关于世界的事实,别的几句是关于队列的
      this.dangerNote(task.steps),
      // 战斗被这一单打断了:照实说一句,别让"怎么突然不打了"成为她要自己解释的事
      combatCut ? `战斗被这单打断了(刚才${combatCut},已经放开手)` : null,
      cut,
      // 排着的那几件按定义一步都没跑过:点破它,别让"撤掉了"读起来像"做完换下一件"
      dropped.length > 0
        ? `撤掉了排在后面的 ${dropped.map((d) => `任务#${d.id}「${labelOf(d)}」`).join('、')}(都还没轮到跑第 1 步)`
        : null,
      // 差异回念之外，注明首步冻结所用原点及后续步骤仍延迟解析。
      frozen?.changed
        ? `第 1 步的 ~ 是按你下这一单时站的地方 ${cellText(frozen.origin)} 算的(后面各步还是到做那一刻再算)`
        : null,
      // 带 direction 的 find 会行军；受理时报告距离及走满后的重生点距离。
      this.marchNote(task.steps),
      // 长途 goto 的空间代价:直线多远、走路要多久。原点用她下这一单时站的那一格
      // (与第 1 步锚点冻结同源),不是 pump 之后的位置
      this.hikeNote(task.steps, frozen?.origin ?? null),
    ].filter(Boolean);
    /** 回执先列重要现场事实和警告，受理状态置后。 */
    const warn = [
      // 受理试算只读并报告否定结果，不改变执行。
      precheck,
      // 同一件事上次的下场:补的是已经滑出上下文的那一段
      this.priorNote(task.steps, at, round),
      // 相对锚点转为绝对坐标的差异优先呈现。
      echo.hoist,
    ].filter(Boolean);
    return `[${this.clock(at)}] ${warn.length > 0 ? `⚠ ${warn.join(';')} → ` : ''}` +
      `${place}。${echo.tail ?? ''}` +
      `${notes.length > 0 ? `\n${notes.join(';')}。` : ''}`;
  }

  /**
   * 带 direction 的 `find` 是一个真实的行军循环(见 skillFind),不是原地扫一眼。
   * 受理刻把这一步的空间代价当场说出来:朝哪走、最多几格、走满时离重生点多远。
   *
   * 只报读数,不劝阻也不拦 —— 走不走是她的权衡(「出发前试算只拦事实,不拦权衡」)。
   * 重生点距离按**走满**算(方向单位向量 × distance),那是这一步的上界。
   *
   * 重生点之外再附一句离最近路标多远(「离『家』约 130 格」):重生点是系统给的
   * 一个点,路标是她自己命名的地方 —— 后者才是她盘算"走这一趟离家多远"时用的尺子。
   */
  private marchNote(steps: SkillCall[]): string | null {
    const legs = steps.filter(
      (c): c is Extract<SkillCall, { skill: 'find' }> => c.skill === 'find' && c.direction !== undefined,
    );
    if (legs.length === 0) return null;
    const anchor = this.opts.spawnAnchor?.() ?? null;
    const bot = this.opts.getBot();
    const feet = bot?.entity ? feetOf(bot) : null;
    /** 成对报告行军前后距出发点最近路标的距离。 */
    const drift = (at: Cell, end: Cell): string | null => {
      const from = this.opts.marks?.().nearest(at) ?? null;
      if (!from) return null;
      const was = Math.round(Math.hypot(at.x - from.x, at.z - from.z));
      const will = Math.round(Math.hypot(end.x - from.x, end.z - from.z));
      return `离「${from.name}」从 ${was} 格变成约 ${will} 格`;
    };
    const one = (c: Extract<SkillCall, { skill: 'find' }>): string => {
      const head = `这一步会朝${DIRECTION_ZH[c.direction!]}走最多 ${c.distance} 格`;
      if (!feet) {
        return anchor ? `${head}(离重生点多远算不出来:还没连上服务器)` : `${head},走满时你现在没有重生点`;
      }
      const end = marchEnd(feet, c.direction!, c.distance);
      // 上界估算:是估算这件事必须写在字面上(「约」)
      const near = drift(feet, end) ?? this.opts.marks?.().near(end, true) ?? null;
      if (!anchor) {
        return near ? `${head},走满时${near}(你现在没有重生点)` : `${head},走满时你现在没有重生点`;
      }
      if (anchor.dimension
        && normalizeDimension(anchor.dimension) !== normalizeDimension(dimensionOf(bot!))) {
        return `${head},重生点在${zhDimension(anchor.dimension)},不和当前维度计算直线距离${near ? `;走满时${near}` : ''}`;
      }
      const away = Math.round(Math.hypot(end.x - anchor.x, end.z - anchor.z));
      return `${head},走满时离重生点 ${cellText(anchor)} 约 ${away} 格${near ? `、${near}` : ''}`;
    };
    return legs.map(one).join(';');
  }

  /** 受理时报告长途 goto 的直线距离和步行估时，不自动拆航点或阻断。 */
  private hikeNote(steps: SkillCall[], origin: Cell | null): string | null {
    if (origin === null) return null;
    const out: string[] = [];
    const bot = this.opts.getBot();
    const dimension = bot ? normalizeDimension(dimensionOf(bot)) : null;
    for (const c of steps) {
      if (c.skill !== 'goto') continue;
      if (dimension && c.dimension && normalizeDimension(c.dimension) !== dimension) continue;
      const resolved = resolveAnchors([c.at], origin);
      if (!Array.isArray(resolved)) continue;
      // 水平距离:goto [x,z] 的 y 要到执行那一刻才解,竖直分量在受理刻本来就是假的
      const dist = Math.hypot(resolved[0].x - origin.x, resolved[0].z - origin.z);
      if (dist <= LONG_GOTO_BLOCKS) continue;
      out.push(`这一步直线 ${Math.round(dist)} 格,步行约 ${fmtWalk(dist)}(平地不绕路、不挖不垫的下限)`);
    }
    return out.length > 0 ? out.join(';') : null;
  }

  /**
   * 受理刻的危险区陈述:这一单的目标点/行军终点落进了**她自己圈的**危险区。
   *
   * **措辞铁律(PWSR 主客观纪律):** 只说「你标记的危险区」这个事实,永远不写成
   * 系统的判断(不出现"危险""建议"这类词),也不拦不劝 —— 走不走是她的权衡。
   * 圈是她画的,她比系统更清楚圈里为什么危险,以及这一趟值不值。
   */
  private dangerNote(steps: SkillCall[]): string | null {
    try {
      const desk = this.opts.marks?.();
      if (!desk) return null;
      const bot = this.opts.getBot();
      if (!bot?.entity) return null;
      const target = new Set<string>();
      const march = new Set<string>();
      const feet = feetOf(bot);
      for (const call of steps) {
        if (call.skill === 'find' && call.direction !== undefined) {
          for (const n of desk.danger(marchEnd(feet, call.direction, call.distance))) march.add(n);
          continue;
        }
        const cell = targetCellOf(bot, call);
        if (cell) for (const n of desk.danger(cell)) target.add(n);
      }
      return [
        dangerNoteText([...target], '目标'),
        dangerNoteText([...march], '走满时的行军终点'),
      ].filter(Boolean).join(';') || null;
    } catch {
      return null; // 陈述不许成为故障源:算不出来就不说
    }
  }

  /**
   * 前置试算使用执行器的锚点解析、形状展开、方块读取与进食记录。
   * 全部包成不抛的形式:试算自己绝不许成为故障源。
   */
  private precheckDeps(bot: Bot): PrecheckDeps {
    return {
      resolve: (a) => { try { return resolveAt(bot, a as Anchor); } catch { return null; } },
      cellsOf: (c) => {
        try {
          const b = c as PlaceCall;
          if (!('anchors' in b)) return null;
          return shapeCells(bot, b.shape, b.anchors, b.fill, BUILD_CELL_CAP);
        } catch { return null; }
      },
      blockAt: (cell) => blockAtCell(bot, cell),
      lastAte: () => lastAteOf(bot),
    };
  }

  /**
   * 受理回执里的「上次这一单什么下场」那一句;没有旧账、旧账太老或开关关着时静默。
   *
   * 15 分钟窗口:再往前的账她多半已经换了打法,拿出来只会误导。
   * 顺手清掉过期项——这张表按签名开条目,一场几百种,不清会一直长。
   */
  private priorNote(steps: SkillCall[], now: number, round: RoundaboutSnapshot | null): string | null {
    if (this.opts.priorOutcome?.() === false) return null;
    for (const [k, v] of this.priorOutcomes) if (now - v.at > PRIOR_OUTCOME_WINDOW_MS) this.priorOutcomes.delete(k);
    const prev = this.priorOutcomes.get(taskSignature(steps));
    return prev ? priorOutcomeNote(prev, now, round) : null;
  }

  /**
   * 记录窗口内同类签名的提交与首步开跑次数，仅报告事实。
   * 必须在 pump() 前取快照，避免将本次开跑计入先前尝试。
   */
  private noteSubmitted(sig: string, at: number): RoundaboutSnapshot {
    for (const [k, v] of this.roundabout) {
      v.submits = v.submits.filter((t) => at - t <= PRIOR_OUTCOME_WINDOW_MS);
      if (v.submits.length === 0) this.roundabout.delete(k);
    }
    const entry = this.roundabout.get(sig) ?? { submits: [], ran: 0 };
    const ranBefore = entry.ran;
    const first = entry.submits[0] ?? at;
    entry.submits.push(at);
    this.roundabout.set(sig, entry);
    return { times: entry.submits.length, spanMs: at - first, ranBefore };
  }

  /** 这一签名的单真开跑了(第 1 步进了执行循环) */
  private noteStarted(sig: string): void {
    const entry = this.roundabout.get(sig);
    if (entry) entry.ran += 1;
  }

  /**
   * 受理时保护重生锚；返回提示则拒单，null 放行。
   * 几何操作间接覆盖锚点时拒单；显式点名首次警告并拒单，确认窗口内同签名同锚点重发放行。
   * 寻路保护由 bridge 处理，拾取后的状态由 pickup 回报。
   */
  private spawnGuardNote(steps: SkillCall[], now: number): string | null {
    try {
      return this.spawnGuardVerdict(steps, now);
    } catch {
      return null; // 闸不许成为第二个故障源:算不出来就放行,由技能自己在出队刻说
    }
  }

  private spawnGuardVerdict(steps: SkillCall[], now: number): string | null {
    const anchor = this.opts.spawnAnchor?.();
    if (!anchor) return null;
    const bot = this.opts.getBot();
    if (!bot?.entity) return null;
    if (anchor.dimension
      && normalizeDimension(anchor.dimension) !== normalizeDimension(dimensionOf(bot))) return null;
    const guard = spawnGuardCells(bot, anchor);
    const at = cellText(guard[0]);
    for (let i = 0; i < steps.length; i++) {
      const call = steps[i];
      const where = steps.length > 1 ? `第 ${i + 1} 步` : '这一单';
      if (namesSpawnAnchor(bot, call, guard)) {
        const key = `${taskSignature(steps)}@${cellKeyOf(guard[0])}`;
        const prev = this.spawnConfirm;
        if (prev && prev.key === key && now - prev.at <= SPAWN_CONFIRM_WINDOW_MS) {
          this.spawnConfirm = null;
          this.opts.diag?.write({
            lane: 'task', event: 'spawn-anchor-confirmed',
            msg: `重生锚 ${at}:同样的单再下一次,按确认放行`,
            data: { key, steps },
          });
          return null;
        }
        this.spawnConfirm = { key, at: now };
        this.opts.diag?.write({
          lane: 'task', event: 'spawn-anchor-hold',
          msg: `重生锚 ${at}:显式指名要动它,先警告等确认`,
          data: { key, steps },
        });
        return `${where}要动的 ${at} 就是你的重生锚。它一离开地面,重生点当场作废,` +
          '死了会回世界出生点。真要搬走就再下一次一模一样的单,我照做;换个目标的话这一单作废。';
      }
      const cells = shapeFootprint(bot, call, this.opts.blueprints?.() ?? null);
      const hit = cells?.find((c) => guard.some((g) => g.x === c.x && g.y === c.y && g.z === c.z));
      if (!hit) continue;
      this.opts.diag?.write({
        lane: 'task', event: 'spawn-anchor-refused',
        msg: `重生锚 ${at}:形状罩住 ${cellText(hit)},驳回`,
        data: { step: i + 1, hit, anchor, steps },
      });
      return `${where}的形状罩住了 ${cellText(hit)} —— 你的重生锚在 ${at},` +
        '罩住它或它脚下那一格,重生点就当场作废了。避开那几格重下这一单;' +
        '真要拆,单独下一条只对准那一格的 excavate,我会先跟你确认。';
    }
    return null;
  }

  /**
   * 受理刻的毒食闸。eat 点名 POISON_FOODS 里的东西:第一次只回后果、不接单;
   * 确认窗口内原样重发即接。单槽语义与重生锚闸相同 —— 换了单就换槽。
   */
  private poisonGuardNote(steps: SkillCall[], now: number): string | null {
    // 不带 at/target 的 use 拿着食物就是吃(consumeHeldFood),同一道门
    const eats = (c: SkillCall): string | null => (
      c.skill === 'eat' ? c.item
        : c.skill === 'use' && c.item && !c.at && !c.target ? c.item
          : null);
    const hit = steps.findIndex((c) => POISON_FOODS[eats(c) ?? ''] !== undefined);
    if (hit < 0) return null;
    const call = { item: eats(steps[hit])! };
    const key = `${taskSignature(steps)}@${call.item}`;
    const prev = this.poisonConfirm;
    if (prev && prev.key === key && now - prev.at <= POISON_CONFIRM_WINDOW_MS) {
      this.poisonConfirm = null;
      this.opts.diag?.write({
        lane: 'task', event: 'poison-food-confirmed',
        msg: `${zhName(call.item)}:同样的单再下一次,按确认放行`,
        data: { key, steps },
      });
      return null;
    }
    this.poisonConfirm = { key, at: now };
    this.opts.diag?.write({
      lane: 'task', event: 'poison-food-hold',
      msg: `${zhName(call.item)}:eat 点名毒食,先报后果等确认`,
      data: { key, steps },
    });
    const where = steps.length > 1 ? `第 ${hit + 1} 步` : '这一单';
    return `${where}要吃的是${zhName(call.item)}:${POISON_FOODS[call.item]},没吃。` +
      '确定要吃就再下一次一模一样的单,我照吃;换个目标的话这一单作废。';
  }

  /**
   * 受理时拒绝在自身碰撞箱正上方放置重力方块的整单任务。
   * 必须先于 skillBuild 的移身操作检查，避免移身后放置绕过保护。
   */
  private gravityGuardNote(steps: SkillCall[]): string | null {
    try {
      return this.gravityGuardVerdict(steps);
    } catch {
      return null; // 同上:闸算不出来就放行
    }
  }

  private gravityGuardVerdict(steps: SkillCall[]): string | null {
    if (!steps.some((c) => c.skill === 'build' && ('blueprint' in c || isGravityBlock(c.material)))) {
      return null;
    }
    const bot = this.opts.getBot();
    if (!bot?.entity) return null;
    const desk = this.opts.blueprints?.() ?? null;
    const feet = feetOf(bot);
    const overheadCell = (c: Cell): boolean =>
      c.x === feet.x && c.z === feet.z && c.y > feet.y && c.y <= feet.y + GRAVITY_OVERHEAD;
    for (let i = 0; i < steps.length; i++) {
      const call = steps[i];
      if (call.skill !== 'build') continue;
      // 蓝图形态:哪一格放的是沙砾这类由 IR 步自己说,闸认的还是「落点在不在我头顶」
      if ('blueprint' in call) {
        const bad = blueprintFootprint(bot, call, desk)
          .find((c) => isGravityBlock(c.item) && overheadCell(c.cell));
        if (!bad) continue;
        this.opts.diag?.write({
          lane: 'task', event: 'gravity-overhead-refused',
          msg: `蓝图「${call.blueprint}」要把 ${bad.item} 放在头顶 ${cellText(bad.cell)},驳回`,
          data: { step: i + 1, blueprint: call.blueprint, material: bad.item, hit: bad.cell, feet },
        });
        return `${steps.length > 1 ? `第 ${i + 1} 步` : '这一单'}那张图会把${zhName(bad.item)}放在 `
          + `${cellText(bad.cell)},那是我头顶这一柱上的格子。${zhName(bad.item)}下面没有支撑就整块掉下来,`
          + '落到头上会把我埋住闷死。挪一格锚点,或者先走开再让它盖那一层。';
      }
      if (!isGravityBlock(call.material)) continue;
      const overhead = 'anchors' in call && call.anchors.some((a) => isOverheadAnchor(a));
      const hit = overhead
        ? { x: feet.x, y: feet.y + 1, z: feet.z }
        : shapeFootprint(bot, call, desk)?.find(overheadCell);
      if (!hit) continue;
      this.opts.diag?.write({
        lane: 'task', event: 'gravity-overhead-refused',
        msg: `${call.material} 要放在头顶 ${cellText(hit)},驳回`,
        data: { step: i + 1, material: call.material, hit, feet },
      });
      return `${steps.length > 1 ? `第 ${i + 1} 步` : '这一单'}要把${zhName(call.material)}放在 ${cellText(hit)},` +
        `那是我头顶这一柱上的格子。${zhName(call.material)}下面没有支撑就整块掉下来,` +
        '落到头上会把我埋住闷死。换个不在我头顶的位置,或者换一种不会掉的材料。';
    }
    return null;
  }

  /** 受理回执里的试算那一句;全通返回 null(静默) */
  private precheckNote(steps: SkillCall[]): string | null {
    if (this.opts.precheck?.() === false) return null;
    const bot = this.opts.getBot();
    if (!bot) return null;
    const hits = precheckSteps(bot, steps, this.precheckDeps(bot));
    if (hits.length > 0) {
      this.opts.diag?.write({
        lane: 'task', event: 'precheck',
        msg: `受理刻试算命中 ${hits.length} 条`,
        data: { hits: hits.map((h) => ({ step: h.index + 1, ...h.note })) },
      });
    }
    return renderPrecheckNotes(hits);
  }

  /**
   * `queue:"now"` 的中断路径:掐掉手上这件(结局由受理回执点名,不另发汇报)。
   * 正在逃的任务不抢——逃岩浆的时候不插火把,急件在队头等它逃完。
   */
  private interrupt(): string | null {
    const t = this.task;
    const frozen = this.frozen;
    if (!t && !frozen) return null;
    if (t && this.escaping) {
      return `手上这件正在自保(任务#${t.id}「${labelOf(t)}」),不抢它;它脱身之后立刻做这件`;
    }
    const notes: string[] = [];
    if (t) {
      const at = this.progressOf(t);
      this.abortTask(t, '被 queue:"now" 的新任务顶替');
      this.reportCancelled(t, 'queue:"now" 的新任务顶替', at);
      notes.push(cancelledNote(
        `任务#${t.id}「${labelOf(t)}」`,
        t.stepIndex,
        t.steps.length,
        describeSkill(t.steps[Math.min(t.stepIndex, t.steps.length - 1)]),
      ) + `${t.count ? `(进度 ${t.count.done}/${t.count.total})` : ''}`);
    }
    if (frozen) {
      this.frozen = null;
      // suspend 的旧 RunningTask 可能还在同一调用栈里；同一个任务只补一条终态。
      if (!t || t.id !== frozen.id) {
        const at = Executor.frozenProgress(frozen);
        this.reportCancelled(frozen, 'queue:"now" 的新任务顶替', at);
        const stepIndex = at ? at.step - 1 : 0;
        notes.push(cancelledNote(
          `战斗中待续的任务#${frozen.id}「${labelOf(frozen)}」`,
          stepIndex,
          frozen.steps.length,
          describeSkill(frozen.steps[Math.min(stepIndex, frozen.steps.length - 1)]),
        ));
      }
    }
    return notes.join(';');
  }

  /** 队列空着且没在做事就开下一件;身体被战斗占着时闸住(resume 时再泵) */
  private pump(): void {
    if (this.stopped || this.task || this.holdReason() !== null) return;
    if (this.opts.busyWith?.()) return;
    const next = this.queue.shift();
    if (!next) return;
    // 反射自保时会在没有任务的情况下下寻路目标;新任务一律接管,否则一边合成
    // 一边被上一轮的逃跑路线带着走
    dropGoal(this.opts.getBot(), 'task', `新任务#${next.id}接管身体`, this.opts.diag);
    const flag: AbortFlag = { aborted: false, by: null, epoch: this.executionEpoch };
    const now = Date.now();
    // 打转账只记第一次开跑:断点续做是同一单接着跑,不是又下了一单
    if (next.startedAt === undefined) this.noteStarted(taskSignature(next.steps));
    this.task = {
      ...next, stepLog: next.stepLog ?? [], flag, escape: { active: false },
      startedAt: next.startedAt ?? now, stepIndex: 0, stepStartedAt: now, count: null,
    };
    this.opts.diag?.write({
      lane: 'task', event: 'start', taskId: next.id,
      msg: `开始任务#${next.id}「${labelOf(next)}」`,
      data: { steps: next.steps, waiting: this.queue.length },
    });
    void this.run(this.task, flag);
  }

  /**
   * 可恢复夺手:当前任务断点挂起,不是抢占——preempt 会撤空整条队列。当前步骤走
   * checkAbort 通道中止;不可重跑的步(reRunnable)恢复时按没做成算。战斗由 busyWith
   * 闸住，环境危机另持 queueHold，二者都在安全交还后续做。
   */
  suspend(by = '战斗', owner: QueueFreezeOwner = 'combat'): void {
    if (this.stopped || this.frozen) return;
    const t = this.task;
    if (!t) return;
    this.abortTask(t, by);
    const idem = reRunnable(t.steps[t.stepIndex]);
    this.frozen = {
      id: t.id, steps: t.steps, enqueuedAt: t.enqueuedAt, startedAt: t.startedAt,
      resumeFrom: idem ? t.stepIndex : t.stepIndex + 1,
      interrupted: idem ? null : t.stepIndex,
      progress: { step: t.stepIndex + 1, count: t.count },
      // 已经做掉的步跟着任务走:重建 ctx 会丢,重跑会报假失败
      absorbed: t.absorbed,
      // 各步终态的账同理:挂起前跑成的那几步,断点被撤时还得说得出来
      stepLog: t.stepLog,
      intended: t.intended,
      frozenBy: owner,
    };
    this.opts.diag?.write({
      lane: 'task', event: 'suspend', taskId: t.id,
      msg: `任务#${t.id}「${labelOf(t)}」在第 ${t.stepIndex + 1} 步被挂起(${by}),交还身体后续做`,
      data: { stepIndex: t.stepIndex, reRunnable: idem, by },
    });
  }

  /**
   * 步边界上的冻结:这一步**还没开跑**,断点就落在它自己身上。
   *
   * 与 `suspend()` 的差别只在断点算法:那一条是"跑到一半被夺手",非幂等步按做了一半
   * 算(`resumeFrom = stepIndex + 1`、记 `interrupted`);这一条是"还没开工就被拦下",
   * 无论幂等与否都从这一步原样重来。
   */
  private freezeBeforeStep(t: RunningTask, i: number, why: string): boolean {
    // 断点只有一个槽。已经被别人(战斗)占着时不抢,照旧往下跑 —— 抢了等于把那一单丢掉
    if (this.stopped || this.frozen) return false;
    this.frozen = {
      id: t.id, steps: t.steps, enqueuedAt: t.enqueuedAt, startedAt: t.startedAt,
      resumeFrom: i, interrupted: null,
      absorbed: t.absorbed, stepLog: t.stepLog, intended: t.intended, frozenBy: 'queue',
    };
    this.abortTask(t, why);
    this.opts.diag?.write({
      lane: 'task', event: 'hold-step-boundary', taskId: t.id,
      msg: `任务#${t.id}「${labelOf(t)}」的第 ${i + 1} 步没开工:队列还冻着(${why}),等安全了再从这一步接着做`,
      data: { stepIndex: i, why },
    });
    return true;
  }

  /**
   * 战斗收工:解冻,挂起的任务放回队头从断点续做。返回给她的一句说明。
   *
   * `owner` 是解冻者组。断点归哪一组冻就只由哪一组解:别人的断点原样冻着,
   * 只把队列推一下。
   */
  resume(owner: QueueFreezeOwner = 'combat'): string | null {
    const f = this.frozen;
    if (f && f.frozenBy !== undefined && f.frozenBy !== owner) {
      this.pump();
      return null;
    }
    this.frozen = null;
    if (f) this.queue.unshift(f);
    this.pump();
    if (!f) return null;
    const at = f.resumeFrom ?? 0;
    const step = describeSkill(f.steps[Math.min(at, f.steps.length - 1)]);
    const carried = resumedCollect(f, at);
    return f.interrupted !== null && f.interrupted !== undefined
      ? `刚才任务#${f.id} 的第 ${f.interrupted + 1} 步做到一半被打断,那一步不重做(重做会再扣一次料),后面的接着来`
      : `刚才做到一半的任务#${f.id} 接着做(第 ${at + 1} 步:${step}${carried ? `,${carried.note}` : ''})`;
  }

  /**
   * mc_stop：停止当前任务、撤销队列(挂起待续的也算)；全空返回 null。
   */
  clear(): string | null {
    const t = this.task;
    const dropped = this.queue.splice(0);
    if (this.frozen) {
      dropped.unshift(this.frozen);
      this.frozen = null;
    }
    // 撤空队列时同时作废深坠与环境冻结令牌；旧持有者的恢复调用随之失效。
    const held = this.holdReason();
    this.releaseAllHolds();
    if (!t && dropped.length === 0) {
      if (held === null) return null;
      this.opts.diag?.write({
        lane: 'task', event: 'cleared',
        msg: `mc_stop 解除了队列冻结(${held})`,
        data: { dropped: [], releasedHold: held },
      });
      return `队列本来就空着;顺带解除了队列冻结(${held})`;
    }
    if (t) {
      const at = this.progressOf(t);
      this.abortTask(t, 'mc_stop');
      this.reportCancelled(t, 'mc_stop 叫停', at);
    }
    // 被撤销的排队任务各自投递终态，供后续轮次读取。
    for (const d of dropped) {
      this.reportCancelled(d, 'mc_stop 撤单', Executor.frozenProgress(d));
    }
    this.opts.diag?.write({
      lane: 'task', event: 'cleared', taskId: t?.id,
      msg: `叫停${t ? `任务#${t.id}「${labelOf(t)}」` : ''}${dropped.length > 0 ? `,撤掉排着的 ${dropped.length} 件` : ''}`
        + (held !== null ? `,并解除队列冻结(${held})` : ''),
      data: { dropped: dropped.map((d) => ({ id: d.id, label: labelOf(d) })), releasedHold: held },
    });
    return [
      t ? `已叫停任务#${t.id}「${labelOf(t)}」` : null,
      dropped.length > 0 ? `撤掉了排在后面的 ${dropped.map((d) => `任务#${d.id}「${labelOf(d)}」`).join('、')}` : null,
      held !== null ? `队列冻结(${held})也解除了` : null,
    ].filter(Boolean).join(';');
  }

  /** 两槽合起来的一句冻结理由;都空着为 null。同时冻着就两条都说 */
  private holdReason(): string | null {
    const bits = [this.queueHolds.environment?.reason, this.queueHolds.fall?.reason].filter(Boolean);
    return bits.length > 0 ? bits.join('、') : null;
  }

  /** 两槽一起清空(mc_stop / 抢占 / 死亡 / 断线 / 停机):留哪一张都够把队列关死 */
  private releaseAllHolds(): void {
    const had = this.queueHolds.environment !== null || this.queueHolds.fall !== null;
    this.queueHolds.environment = null;
    this.queueHolds.fall = null;
    // 回边:反射那边的令牌已经作废,别让它拿着旧票挡住这一轮危机的重新冻结
    if (had) this.opts.onHoldsReleased?.();
  }

  /**
   * 一槽释放。**另一槽还握着就不解冻断点** —— 两件事的解冻条件不同(环境要危险
   * 解除,深坠要稳定落脚),先满足的那一条不替另一条作数。两槽都空了才 `resume`。
   */
  private releaseHold(slot: QueueHoldSlot, token: QueueHoldToken): QueueResumeResult {
    if (this.queueHolds[slot]?.token !== token) return { released: false, note: null };
    this.queueHolds[slot] = null;
    const other = this.holdReason();
    if (other !== null) {
      this.opts.diag?.write({
        lane: 'task', event: 'hold-partial-release',
        msg: `${slot === 'fall' ? '深坠' : '环境'}那一槽解了,另一槽还冻着(${other}),队列不开闸`,
        data: { slot, stillHeld: other, frozenId: this.frozen?.id ?? null },
      });
      return { released: true, note: null };
    }
    return { released: true, note: this.resume('queue') };
  }

  /** 终止当前危险任务并保留排队计划；恢复由安全落脚事件显式触发。 */
  stopCurrent(reason: string): QueueHoldToken {
    const token: QueueHoldToken = { owner: Symbol('queue-hold') };
    this.queueHolds.fall = { token, reason };
    const task = this.task;
    if (!task) return token;
    const progress = this.progressOf(task);
    this.abortTask(task, reason);
    this.reportCancelled(task, reason, progress);
    return token;
  }

  /** 环境危机冻结当前断点和整条队列；逃逸技能本身继续完成脱身。 */
  pauseForEnvironment(reason: string): QueueHoldToken {
    const token: QueueHoldToken = { owner: Symbol('environment-hold') };
    this.queueHolds.environment = { token, reason };
    const task = this.task;
    if (!task?.escape.active) this.suspend(`环境:${reason}`, 'queue');
    const selfRescue = task?.escape.active === true;
    this.opts.diag?.write({
      lane: 'task', event: 'environment-hold', taskId: task?.id ?? this.frozen?.id,
      msg: task && selfRescue
        ? `环境危机接管(${reason}),任务#${task.id}正在自救,后续队列冻结到安全落脚`
        : task
          ? `环境危机接管(${reason}),任务#${task.id}与队列冻结到安全落脚`
        : `环境危机接管(${reason}),队列冻结到安全落脚`,
      data: { reason, taskId: task?.id ?? null, frozenId: this.frozen?.id ?? null, selfRescue },
    });
    return token;
  }

  /** 只接受当前环境租约；有效释放会把冻结断点放回队首(除非深坠那一槽还冻着)。 */
  resumeAfterEnvironment(token: QueueHoldToken): QueueResumeResult {
    const out = this.releaseHold('environment', token);
    if (!out.released) return out;
    this.opts.diag?.write({
      lane: 'task', event: 'environment-resume',
      msg: out.note ?? '环境安全租约已释放,队列可以继续',
      data: { resumedTask: out.note !== null, stillHeld: this.holdReason() },
    });
    return out;
  }

  /** 安全落脚后继续仍在队列中的计划(除非环境那一槽还冻着)。 */
  resumeQueue(token: QueueHoldToken): boolean {
    return this.releaseHold('fall', token).released;
  }

  /** 主动 attack 正持有身体；被动三格巡检与受击接管据此让位。 */
  get attacking(): boolean {
    const step = this.task?.steps[this.task.stepIndex];
    return this.task !== null && (this.activeAttack !== null || step?.skill === 'attack');
  }

  ownsRanged(ownerToken: unknown): boolean {
    return this.attacking && this.activeAttack?.dead === false &&
      this.activeAttack.disconnected === false && ownerToken === this.activeAttack.token;
  }

  acceptsRangedHit(targetId: number, at = Date.now()): boolean {
    const attack = this.activeAttack;
    return attack !== null && attack.targetId === targetId && this.ownsRanged(attack.token) && !(
      attack.lastSwingTargetId === targetId && at - attack.lastSwingAt <= 1_500
    );
  }

  onBowEvent(event: BowEvent): void {
    if (event.kind !== 'hit' || !this.ownsRanged(event.ownerToken)) return;
    const attack = this.activeAttack!;
    if (event.targetId === attack.targetId) attack.rangedHits += 1;
  }

  noteCombatTargetHurt(targetId: number): void {
    const attack = this.activeAttack;
    if (!attack || targetId !== attack.lastSwingTargetId) return;
    if (Date.now() - attack.lastSwingAt > 1_500) return;
    attack.meleeHits += 1;
    attack.lastSwingTargetId = -1;
  }

  noteCombatTargetDead(targetId: number): void {
    const attack = this.activeAttack;
    if (!attack || attack.targetId !== targetId) return;
    attack.dead = true;
    this.opts.ranged?.abort();
    dropGoal(this.opts.getBot(), 'task', '交战目标死了', this.opts.diag);
  }

  /** 连接消失会使旧 Bot 上的当前、冻结和排队工作全部失效。 */
  onConnectionLost(reason = 'Minecraft 连接断开'): void {
    this.executionEpoch += 1;
    this.findHistory.clear();
    const current = this.task;
    const frozen = this.frozen;
    const queued = this.queue.splice(0);
    if (current) {
      current.flag.aborted = true;
      current.flag.by = reason;
    }
    if (this.activeAttack) this.activeAttack.disconnected = true;
    this.cancelActiveAttack();
    this.task = null;
    this.frozen = null;
    this.releaseAllHolds();
    dropGoal(this.opts.getBot(), 'link', '连接断开', this.opts.diag);

    const reported = new Set<number>();
    if (current) {
      reported.add(current.id);
      this.reportCancelled(current, reason, this.progressOf(current));
    }
    if (frozen && !reported.has(frozen.id)) {
      reported.add(frozen.id);
      this.reportCancelled(frozen, reason, Executor.frozenProgress(frozen));
    }
    for (const task of queued) {
      if (reported.has(task.id)) continue;
      reported.add(task.id);
      this.reportCancelled(task, reason, null);
    }
    this.opts.diag?.write({
      lane: 'task', event: 'connection-cancelled', taskId: current?.id ?? frozen?.id ?? queued[0]?.id,
      msg: `${reason}，取消旧连接上的工作(${current ? 1 : 0} 当前、${frozen ? 1 : 0} 冻结、${queued.length} 排队)`,
      data: {
        epoch: this.executionEpoch,
        current: current?.id ?? null,
        frozen: frozen?.id ?? null,
        queued: queued.map((task) => task.id),
      },
    });
  }

  claimsCombat(targetId: number): boolean {
    return this.activeAttack?.targetId === targetId;
  }

  /** 受击仍归当前主动 attack；返回 true 让反射与被动会话不要再开第二套动作。 */
  onCombatHurt(attackerId: number, _name: string): boolean {
    const attack = this.activeAttack;
    if (!this.task || this.task.steps[this.task.stepIndex]?.skill !== 'attack') return false;
    if (!attack) {
      this.opts.diag?.write({
        lane: 'skill', event: 'attack-hurt', taskId: this.task.id,
        msg: `主动攻击起步时受击,归任务#${this.task.id}处理`,
        data: { attackerId, targetId: null, hurts: 1 },
      });
      return true;
    }
    attack.hurts += 1;
    attack.lastHurtAt = Date.now();
    this.opts.diag?.write({
      lane: 'skill', event: 'attack-hurt', taskId: this.task.id,
      msg: `主动攻击中受击,归任务#${this.task.id}处理`,
      data: { attackerId, targetId: attack.targetId, hurts: attack.hurts },
    });
    return true;
  }

  private acquireAttack(targetId: number): TaskAttackLease {
    this.cancelActiveAttack();
    const lease: TaskAttackLease = {
      token: {}, targetId,
      swings: 0, meleeHits: 0, arrows: 0, rangedHits: 0,
      hurts: 0, lastHurtAt: 0, lastSwingAt: 0, lastSwingTargetId: -1,
      dead: false, disconnected: false,
    };
    this.activeAttack = lease;
    return lease;
  }

  private releaseAttack(lease: TaskAttackLease): void {
    if (this.activeAttack !== lease) return;
    this.opts.ranged?.abort();
    this.activeAttack = null;
  }

  private cancelActiveAttack(): void {
    if (!this.activeAttack) return;
    this.opts.ranged?.abort();
    this.activeAttack = null;
  }

  /** 死亡是执行边界：旧身体上的当前、冻结和排队工作全部失效。 */
  cancelForDeath(): void {
    this.executionEpoch += 1;
    this.findHistory.clear();
    this.cancelActiveAttack();
    const current = this.task;
    const frozen = this.frozen;
    const queued = this.queue.splice(0);
    if (current) {
      current.flag.aborted = true;
      current.flag.by = '死亡';
    }
    this.task = null;
    this.frozen = null;
    // 深坠/环境冻结的令牌随死亡作废;它单独出一句,泛化的 death-cancelled 对不上账
    // (「任务受理了却永不开跑」与「死亡撤单」在案卷里长得一模一样)
    const held = this.holdReason();
    this.releaseAllHolds();
    releaseBody(this.opts.getBot(), '死亡', this.opts.diag, 'link');
    const holdText = held ? `;当时队列还冻结着(${held}),那份排队计划因死亡作废` : '';
    this.opts.diag?.write({
      lane: 'task', event: 'death-cancelled', taskId: current?.id ?? frozen?.id ?? queued[0]?.id,
      msg: `死亡取消了当前与待执行工作(${current ? 1 : 0} 当前、${frozen ? 1 : 0} 冻结、${queued.length} 排队)`
        + holdText,
      data: {
        epoch: this.executionEpoch,
        current: current?.id ?? null,
        frozen: frozen?.id ?? null,
        queued: queued.map((task) => task.id),
        releasedHold: held,
      },
    });
    if (held !== null) {
      this.opts.report({
        kind: 'superseded',
        text: `死的时候队列还冻着(${held}),排在里面的计划因死亡作废,想接着做要重新排。`,
        taskId: current?.id ?? frozen?.id ?? queued[0]?.id,
      });
    }
  }

  /** 当前任务占用逃逸路径时为 true;反射层据此避免重复抢占。 */
  get escaping(): boolean {
    const t = this.task;
    if (!t) return false;
    // eat 属于回血自救，低血反射不得抢占。
    return t.escape.active || t.steps[t.stepIndex]?.skill === 'eat';
  }

  /**
   * 自保反射接管寻路前终止当前任务及其排队任务;已处于逃逸状态的任务不被抢占。
   * 本方法不清除寻路目标,由紧随其后的反射 setGoal 替换旧目标。
   */
  preempt(reason: string): void {
    if (this.stopped) return;
    const t = this.task;
    if (t?.escape.active) return;
    // 抢占撤空队列时作废两种冻结令牌；旧令牌的恢复调用无效。
    const held = this.holdReason();
    this.releaseAllHolds();
    // 战斗窗口里没有"当前任务",但挂起待续的与排着的照样要撤:
    // 环境自保夺权(岩浆/溺水)之后,按原地写的计划已经不知道自己在哪了
    if (!t && !this.frozen && this.queue.length === 0) {
      if (held !== null) {
        this.opts.diag?.write({
          lane: 'task', event: 'preempted',
          msg: `自保反射接管(${reason}),队列空着,顺带解除了队列冻结(${held})`,
          data: { reason, dropped: 0, releasedHold: held },
        });
      }
      return;
    }
    // 寻路目标由紧随其后的反射 setGoal 替换,这里不撤(见方法头注)
    if (t) {
      t.flag.aborted = true;
      t.flag.by = `自保反射:${reason}`;
      this.cancelActiveAttack();
      this.task = null;
    }
    const dropped = this.queue.splice(0);
    if (this.frozen) {
      dropped.unshift(this.frozen);
      this.frozen = null;
    }
    // 抢占绕过 finish()，须在此投递各步骤终态。
    const landings = t ? Executor.landingsAtCut(t, this.progressOf(t)) : [];
    const text = (t
      ? `任务#${t.id}「${labelOf(t)}」被自保反射抢占(${reason}),已中断。`
      : `自保反射接管了(${reason})。`) +
      (dropped.length > 0 ? `排在后面的 ${dropped.length} 件也撤了,想接着做要重新排。` : '') +
      (t ? renderStepLandings(landings, t.steps.length) : '') +
      this.furnaceNote();
    this.opts.diag?.write({
      lane: 'task', event: 'preempted', taskId: t?.id ?? dropped[0]?.id, msg: text,
      data: { reason, dropped: dropped.length, releasedHold: held, landings },
    });
    this.opts.report({ kind: 'superseded', text, taskId: t?.id ?? dropped[0]?.id });
  }

  /** 抢占回执附带账上仍有原料或成品的炉子，并标明是上次看见的数量。 */
  private furnaceNote(): string {
    const bot = this.opts.getBot();
    if (!bot?.game) return '';
    const cooking = this.opts.chests?.loadedFurnaces(String(bot.game.dimension ?? 'overworld')) ?? [];
    if (cooking.length === 0) return '';
    const one = (r: (typeof cooking)[number]): string => {
      const f = r.furnace!;
      const bits = [
        f.input ? `${zhName(f.input.name)}×${f.input.count} 没烧完` : null,
        f.output ? `输出槽有${zhName(f.output.name)}×${f.output.count}` : null,
      ].filter(Boolean);
      return `(${r.x}, ${r.y}, ${r.z}) 的${zhName(r.name ?? 'furnace')}里账上还有:${bits.join('、')}`;
    };
    return `另外,${cooking.map(one).join(';')}。`;
  }

  /**
   * 主动撤销任务时投递 cancelled 终态及各步骤结果，不改变队列或启动 pump。
   * 此同步路径绕过 finish() 的迟到回调保护，由清空、顶替和停机入口调用。
   * progress 为 null 表示任务尚未开始；结果按批投递，不单独唤醒模型。
   */
  private reportCancelled(
    task: QueuedTask,
    by: string,
    progress: { step: number; count: { done: number; total: number } | null } | null,
  ): void {
    const head = task.steps.length > 1 ? `任务#${task.id}「${labelOf(task)}」` : `任务#${task.id}`;
    const where = progress
      ? `做到第 ${progress.step}/${task.steps.length} 步` +
        `${progress.count ? `(进度 ${progress.count.done}/${progress.count.total})` : ''}`
      : '一步都没开始';
    const landings = Executor.landingsAtCut(task, progress);
    const ledger = renderStepLandings(landings, task.steps.length);
    const text = `${head}没做完:${where},被${by}。${ledger}`;
    this.opts.diag?.write({
      lane: 'task', event: 'cancelled', taskId: task.id, msg: text,
      data: { by, landings },
    });
    this.opts.report({ kind: 'cancelled', text, taskId: task.id });
  }

  /**
   * 断点被撤时的进度读数(reportCancelled 用)。`suspend()` 冻的断点带着正在跑的那一步
   * 与它的计数进度;步边界冻的没有步在跑,只报已落地的步数。
   */
  private static frozenProgress(
    f: QueuedTask,
  ): { step: number; count: { done: number; total: number } | null } | null {
    if (f.progress) return f.progress;
    const landed = f.resumeFrom ?? 0;
    return landed > 0 ? { step: landed, count: null } : null;
  }

  /**
   * 被切断那一刻的各步终态。已落地的照抄,**正在跑的那一步**补一条「做到一半被撤」
   * —— 它确实开跑过,说成"跳过"或干脆不提都不是事实。
   *
   * 只有"紧接着已落地那几步的下一步"才算正在跑的那一步(`step === 已落地数 + 1`)。
   * 非幂等步被战斗挂起时 `resumeFrom` 会跨过它,`progress.step` 因此指向一个**还没
   * 开跑**的步 —— 那一格不许编,被打断的那一步由 `interrupted` 自己认领。
   */
  private static landingsAtCut(
    task: QueuedTask,
    progress: { step: number; count: { done: number; total: number } | null } | null,
  ): Array<StepLanding | CutLanding> {
    const log: Array<StepLanding | CutLanding> = [...(task.stepLog ?? [])];
    const cut = (step: number, why: string | null): void => {
      const call = task.steps[step - 1];
      if (!call || log.some((l) => l.step === step)) return;
      log.push({ step, what: describeSkill(call), outcome: 'cut', why });
    };
    if (typeof task.interrupted === 'number') {
      cut(task.interrupted + 1, '做到一半被打断,重做会重复扣料');
    }
    if (progress && progress.step === log.length + 1) {
      cut(progress.step, progress.count ? `进度 ${progress.count.done}/${progress.count.total}` : null);
    }
    return log;
  }

  /** 正在跑的那一单当下的进度读数(reportCancelled 用) */
  private progressOf(t: RunningTask): { step: number; count: { done: number; total: number } | null } {
    return { step: t.stepIndex + 1, count: t.count };
  }

  /** 手上这件被谁打飞的记在 flag 上:skill/aborted 那条日志的 `by` 只有这一个来源 */
  private abortTask(t: RunningTask, by: string): void {
    t.flag.aborted = true;
    t.flag.by = by;
    this.cancelActiveAttack();
    this.task = null;
    releaseBody(this.opts.getBot(), `中止任务#${t.id}(${by})`, this.opts.diag);
  }

  /** 停止后丢弃所有任务;迟到回调不得修改状态或发送报告。 */
  shutdown(): void {
    // 停机先同步报告现存任务的取消终态，再置 stopped；finish 据此忽略迟到回调。
    if (this.task) this.reportCancelled(this.task, 'World 停止', this.progressOf(this.task));
    for (const d of [...(this.frozen ? [this.frozen] : []), ...this.queue]) {
      this.reportCancelled(d, 'World 停止', Executor.frozenProgress(d));
    }
    this.stopped = true;
    this.findHistory.clear();
    this.cancelActiveAttack();
    if (this.task) {
      this.task.flag.aborted = true;
      this.task.flag.by = 'World 停止';
    }
    this.task = null;
    this.queue = [];
    this.frozen = null;
    this.releaseAllHolds();
    // 停止 World 时同时交还身体(目标、控制键、挖掘、右键)。
    releaseBody(this.opts.getBot(), 'World 停止', this.opts.diag, 'link');
  }

  private async run(task: RunningTask, flag: AbortFlag): Promise<void> {
    const { id } = task;
    // 单步任务的标签就是它的回执:"任务#1「用剪刀右键羊」完成: 剪刀右键了羊"
    // 把同一件事说了两遍。多步任务才需要标签列出全程,好让"受阻于第几件"有参照。
    const label = (): string => `${task.steps.length > 1 ? `任务#${id}「${labelOf(task)}」` : `任务#${id}`}`;
    /**
     * 结局回执的时刻段:受理 → 结束、总耗时(含排队等待),排过队才多报排的那一段。
     * 她没有别的时钟——一张床被空手右键 45 次横跨 6 小时,回执一字不差;
     * done 到下一次 mc_do 的 p90 是 46 秒也只有这里看得出来。
     */
    const span = (): string => {
      const end = Date.now();
      const queued = task.startedAt - task.enqueuedAt;
      return `[${this.clock(task.enqueuedAt)}→${this.clock(end)} 共 ${fmtDur(end - task.enqueuedAt)}` +
        `${queued >= 1000 ? `,排队 ${fmtDur(queued)}` : ''}] `;
    };
    /**
     * 一步的回执行开头:步号 + 回念解析后的那一步 + 这一步用了多久。
     *
     * 步号与单步耗时都只在多步任务里出现:单步任务的整条 span 已经把总耗时说了,
     * 再报一遍这一步的用时就是同一个数说两遍(README「一件事只说一遍」)。
     */
    const stepLabel = (i: number): string =>
      `${task.steps.length > 1 ? `第 ${i + 1} 步 ` : ''}${JSON.stringify(task.steps[i])}`;
    const stepHead = (i: number, stepStart: number): string =>
      (task.steps.length > 1
        ? `${stepLabel(i)} 用时 ${fmtDur(Date.now() - stepStart)}`
        : stepLabel(i));
    /** 多步分行列,单步就跟在冒号后面 */
    const listOf = (entries: string[]): string =>
      entries.length > 1 ? `\n${entries.join('\n')}` : ` ${entries.join('')}`;
    if (flag.aborted || this.stopped || flag.epoch !== this.executionEpoch) return;
    const bot = this.opts.getBot();
    if (!bot) {
      this.finish(flag, { kind: 'blocked', text: `${span()}${label()}执行不了:当前没连上服务器。`, taskId: id });
      return;
    }
    const ctx: SkillContext = {
      aborted: () => flag.aborted || this.stopped || flag.epoch !== this.executionEpoch,
      abortedBy: () => flag.by ?? (this.stopped ? 'World 停止' : null),
      log: this.opts.log,
      fleeHealth: this.opts.fleeHealth ?? (() => 0),
      escape: task.escape,
      attack: {
        acquire: (targetId) => this.acquireAttack(targetId),
        release: (lease) => this.releaseAttack(lease),
        ranged: this.opts.ranged,
      },
      diag: this.opts.diag,
      taskId: id,
      clock: (ms) => this.clock(ms),
      policy: this.opts.policy,
      permitResourcePlacement: this.opts.permitResourcePlacement,
      previewResourcePlacement: this.opts.previewResourcePlacement,
      reserveHits: [],
      probeRoutes: this.opts.probeRoutes,
      probeTarget: this.opts.probeTarget,
      digBackoffSince: this.opts.digBackoffSince,
      bodyState: () => ({
        combatActive: this.opts.bodyState?.().combatActive ?? false,
        environmentOwnerKind: this.opts.bodyState?.().environmentOwnerKind ?? null,
        queueHold: this.holdReason(),
        frozenTaskId: this.frozen?.id ?? null,
      }),
      chests: this.opts.chests,
      works: this.opts.works,
      probeMemo: this.probeMemo,
      explored: this.opts.explored,
      search: {
        history: this.findHistory,
        scope: () => {
          const external = this.opts.searchContext?.();
          return {
            connectionGeneration: external?.connectionGeneration ?? this.executionEpoch,
            realm: external?.realm ?? 'current',
            dimension: normalizeDimension(dimensionOf(bot)),
          };
        },
      },
      showTempo: this.opts.showTempo,
      spawnNote: this.opts.spawnNote,
      spawnAnchor: this.opts.spawnAnchor,
      blueprints: this.opts.blueprints,
      marks: this.opts.marks,
    };
    const results: string[] = [];
    /** 同一根因导致的连续跳步合并为一条回执，保留最早失败步骤的编号。 */
    interface SkipRun { from: number; to: number; root: number; rootOutcome: string; whys: string[]; calls: SkillCall[] }
    /** 没做成的与被跳过的步:一份回执里一起报;跳过的按连续段记(见 SkipRun) */
    const blockedSteps: Array<string | SkipRun> = [];
    /** 被跳过的步序(1 起)→ 拖垮它的根因步序:跳过链要追到真正没做成的那一步 */
    const skipRoot = new Map<number, number>();
    const renderBlocked = (e: string | SkipRun): string => {
      if (typeof e === 'string') return e;
      if (e.from === e.to) return `${stepLabel(e.from)} 跳过(${e.whys[0]})`;
      const n = e.to - e.from + 1;
      const rootWhy = e.rootOutcome === 'noop' ? '没什么可做的' : '没做成';
      return `第 ${e.from + 1}~${e.to + 1} 步 没跑(第 ${e.root} 步${rootWhy},这 ${n} 步一环扣一环都要用它的产出):`
        + e.calls.map((c) => JSON.stringify(c)).join(';');
    };
    /**
     * 无事可做的步:陈述句单独成段,不进「没做成」那一堆。
     * 它不影响任务终态——一单里只有这类,任务照样是「完成」。
     */
    const noopSteps: string[] = [];
    /** 做了一部分的步:缺口点名,任务终态降成「做了一部分」 */
    const partialSteps: string[] = [];
    /** 这一单头一次卡住的理由;进「同一件事上次什么下场」的账(见 priorOutcomes) */
    let firstWhy: string | null = null;
    /** 这一单各步受阻理由的归并键;头条按它比对(见 blockedHeadline) */
    const myBlockedKeys = new Set<string>();
    /** 这一单有没有卡在「东西」上:有就在终态回执末尾贴一份当刻全量背包(见 bagNow) */
    let bagDue = false;
    const scenes: string[] = [];
    const steps = task.steps;
    let expectedDimension = normalizeDimension(dimensionOf(bot));
    let transitBoundary: number | null = null;
    /** 各步在验收后的结局。显式依赖要求 ok/partial；自动因果边还可凭现有入料放行。 */
    const outcomes: StepOutcome[] = [];
    /**
     * 一步落地:记进 outcomes(闸门读它),同时记一笔终态账(见 StepLanding)。
     * 两处必须同一刻写,否则被叫停时那本账与实际跑到哪一步对不上号。
     * `line` 是这一步进结局回执的那一行,断点续做时原样摆回去。
     */
    const land = (i: number, outcome: StepOutcome, why: string | null, line: string): void => {
      outcomes.push(outcome);
      task.stepLog.push({
        step: i + 1, what: describeSkill(steps[i]), outcome, why: shortWhy(why), line,
      });
    };
    /**
     * 本任务有意放置的落点，跨步骤保留。
     * 回收脚手架按坐标豁免这些格子，包括后续步骤在同格重新登记的放置记录。
     */
    const intended = task.intended ??= new Set<string>();
    for (let i = 0; i < steps.length; i++) {
      const call = steps[i];
      if (ctx.aborted()) return;
      // 环境冻结在步骤边界生效：当前自救步骤可完成，后续步骤等待 resumeAfterEnvironment。
      const heldBefore = this.holdReason();
      if (heldBefore !== null && this.freezeBeforeStep(task, i, `环境冻结:${heldBefore}`)) return;
      if (transitBoundary !== null) {
        const why = `第 ${transitBoundary} 步没有完成可信的维度穿越，后续步骤不能在错误维度继续`;
        const line = `${stepLabel(i)} 跳过(${why})`;
        land(i, 'skip', why, line);
        blockedSteps.push(line);
        this.opts.diag?.write({
          lane: 'skill', event: 'dimension-tail-blocked', taskId: id,
          msg: `第 ${i + 1} 步「${describeSkill(call)}」跳过:${why}`,
          data: {
            call, transitStep: transitBoundary, expectedDimension,
            actualDimension: normalizeDimension(dimensionOf(bot)),
          },
        });
        continue;
      }
      const beforeDimension = normalizeDimension(dimensionOf(bot));
      if (beforeDimension !== expectedDimension) {
        transitBoundary = i + 1;
        const why = `维度在没有成功 transit 的情况下从${zhDimension(expectedDimension)}变成了${zhDimension(beforeDimension)}`;
        const line = `${stepLabel(i)} 没执行(${why}；为防止把另一维坐标当当前维度坐标，整条尾巴已停)`;
        land(i, 'fail', why, line);
        firstWhy ??= why;
        blockedSteps.push(line);
        this.opts.diag?.write({
          lane: 'skill', event: 'dimension-unexpected', taskId: id,
          msg: `第 ${i + 1} 步前检测到${why}`,
          data: { call, expectedDimension, actualDimension: beforeDimension },
        });
        continue;
      }
      // 战斗挂起后的续做:被打断的非幂等步不重跑(重跑会重复扣料),按没做成算;
      // 更早的步战前已做完,按做成计入闸门,结局回执不重述
      if (i === task.interrupted) {
        const line = `${stepLabel(i)} 做到一半被打断,没重做(这一步重做会重复扣料),按没做成算`;
        land(i, 'fail', '做到一半被打断,没重做(重做会重复扣料)', line);
        blockedSteps.push(line);
        if (call.skill === 'transit') transitBoundary = i + 1;
        continue;
      }
      if (i < (task.resumeFrom ?? 0)) {
        // 断点之前的步:终态照账本进闸门,回执行照账本进结局回执。这一单只有 finish()
        // 一个出口,断点之前那几步的下场没在别处报过;闸门读到「做成」会放行注定落空的
        // 下游。账本按步序记,每一步落地恰一次,第 i 步就是 stepLog[i]。
        const landed = task.stepLog[i];
        outcomes.push(landed.outcome);
        switch (landed.outcome) {
          case 'ok': results.push(landed.line); break;
          case 'partial': partialSteps.push(landed.line); break;
          case 'noop': noopSteps.push(landed.line); firstWhy ??= landed.why; break;
          case 'skip': blockedSteps.push(landed.line); break;
          case 'fail':
            blockedSteps.push(landed.line);
            firstWhy ??= landed.why;
            if (landed.why) {
              myBlockedKeys.add(Executor.blockedKey(landed.why));
              bagDue ||= blockedOnItems(landed.why);
            }
            break;
        }
        continue;
      }
      // 更早一步顺手做掉的(stow 并窗):东西已经在箱子里了。必须抢在 needs 闸与出队刻
      // 试算之前——试算会照着「包里没有X」判死一件其实已经做成的事。回执用登记的那句,
      // 它自带自己那一笔关窗对账,比 deriveExpect 推出来的判据更硬,不再另裁一次。
      const absorbed = task.absorbed?.get(i);
      if (absorbed !== undefined) {
        const line = `${stepLabel(i)}: ${absorbed}`;
        land(i, 'ok', null, line);
        results.push(line);
        this.opts.diag?.write({
          lane: 'skill', event: 'done', taskId: id, durMs: 0,
          msg: `${describeSkill(call)}: ${absorbed}`,
          data: { call, result: absorbed, absorbed: true },
        });
        continue;
      }
      // 显式 needs 优先；省略时按 causalNeeds 建立产出与消费之间的依赖。
      const causal = call.needs === undefined ? causalNeeds(steps, i, bot) : null;
      const needs = call.needs ?? causal!.map((c) => c.step);
      // 因果边的入料包里本来就有时不拦:闸拦的是「注定落空」,料在手上这一步就不是
      const inBag = (items: string[]): boolean => items.every((n) =>
        bot.inventory.items().some((it) => it.count > 0 && (matchItemName(n, it.name) || matchItemName(it.name, n))));
      const upstreamFailed = (n: number): boolean => outcomes[n - 1] !== 'ok' && outcomes[n - 1] !== 'partial';
      const unmet = needs.find((n) =>
        upstreamFailed(n) && !causal?.some((c) => c.step === n && inBag(c.items)));
      /** 上游没成但入料在包里、因而照跑的那条边 */
      const stocked = unmet === undefined
        ? causal?.find((c) => upstreamFailed(c.step) && inBag(c.items)) ?? null
        : null;
      if (unmet !== undefined) {
        // 跳过链追到根:上游自己也是被跳过的,拖垮它的是更早那一步
        const root = skipRoot.get(unmet) ?? unmet;
        // 上游是「无事可做」而不是「没做成」时照实说:两者都拦下游,但说成没做成
        // 会让她以为那一步走错了,转头去修一件根本没坏的事
        const upstream = outcomes[root - 1] === 'noop' ? '那一步没什么可做的'
          : outcomes[root - 1] === 'skip' ? '那一步没跑' : '那一步没做成';
        const chained = root === unmet ? upstream : `那一步没跑(卡在第 ${root} 步)`;
        const why = causal
          ? `要用第 ${unmet} 步的${(causal.find((c) => c.step === unmet)?.items ?? []).map(zhName).join('、')},${chained}`
          : `依赖的第 ${unmet} 步${outcomes[unmet - 1] === 'noop' ? '没什么可做的' : outcomes[unmet - 1] === 'skip' ? '没跑' : '没做成'}`;
        skipRoot.set(i + 1, root);
        land(i, 'skip', why, `${stepLabel(i)} 跳过(${why})`);
        // 跳过的那一步压根没跑,没有"用时"可报;紧接着上一段、同一根因的并进那一段
        const last = blockedSteps[blockedSteps.length - 1];
        if (typeof last === 'object' && last.to === i - 1 && last.root === root) {
          last.to = i;
          last.whys.push(why);
          last.calls.push(call);
        } else {
          blockedSteps.push({ from: i, to: i, root, rootOutcome: outcomes[root - 1], whys: [why], calls: [call] });
        }
        this.opts.diag?.write({
          lane: 'skill', event: 'skip', taskId: id,
          msg: `第 ${i + 1} 步「${describeSkill(call)}」跳过:${why}`,
          data: { call, needs, failed: unmet, root, causal: causal?.find((c) => c.step === unmet)?.items ?? null },
        });
        if (call.skill === 'transit') transitBoundary = i + 1;
        continue;
      }
      // 兜底说明:缺省闸门下前一步没做成、但这一步不消费它的产出(或要用的料包里本来
      // 就有)——照跑,并说明为什么(不说这一句,她会以为闸门坏了或这一步不该跑)
      const ranFree = stocked !== null
        ? `(第 ${stocked.step} 步没做成;要用的${stocked.items.map(zhName).join('、')}包里本来就有,照做了)`
        : causal !== null && i > 0 && outcomes[i - 1] !== 'ok' && outcomes[i - 1] !== 'partial'
          ? `(第 ${i} 步没做成;这一步不用它的产出,照做了)`
          : '';
      // 断点续做的 collect:只挖打断前没挖到的那些;打断前就已挖够的不再进技能
      const carried = resumedCollect(task, i);
      if (carried && carried.remaining <= 0) {
        const line = `${stepLabel(i)}: ${carried.note},没再挖`;
        land(i, 'ok', null, line);
        results.push(line);
        this.opts.diag?.write({
          lane: 'skill', event: 'done', taskId: id, durMs: 0,
          msg: `${describeSkill(call)}: ${carried.note}`,
          data: { call, resumed: { done: carried.done, total: carried.total } },
        });
        continue;
      }
      const run = carried?.call ?? call;
      const carriedNote = carried ? `(${carried.note})` : '';
      task.stepIndex = i;
      task.escape.active = false; // 逃生标记只属于置位它的那一步
      // 续做步从打断前的读数起算:第一次进度回调之前再被挂起,断点里的进度也不能是空
      task.count = carried ? { done: carried.done, total: carried.total } : null;
      const startedAt = Date.now();
      task.stepStartedAt = startedAt;
      const at = bot.entity?.position;
      this.opts.diag?.write({
        lane: 'skill', event: 'begin', taskId: id,
        msg: `第 ${i + 1} 步 ${describeSkill(call)}`,
        data: {
          call,
          from: at ? { x: Math.round(at.x), y: Math.round(at.y), z: Math.round(at.z) } : null,
        },
      });
      let lastProgressPos = at ? { x: at.x, y: at.y, z: at.z } : null;
      let halfSent = false;
      const sendProgress = (half: boolean): void => {
        if (ctx.aborted()) return;
        const p = bot.entity?.position ?? null;
        const moved = p && lastProgressPos
          ? Math.hypot(p.x - lastProgressPos.x, p.y - lastProgressPos.y, p.z - lastProgressPos.z)
          : null;
        if (p) lastProgressPos = { x: p.x, y: p.y, z: p.z };
        this.opts.onProgress?.({
          taskId: id,
          label: labelOf(task),
          stepIndex: i,
          stepCount: task.steps.length,
          step: describeSkill(call),
          elapsedS: Math.round((Date.now() - startedAt) / 1000),
          pos: p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null,
          movedBlocks: moved === null ? null : Math.round(moved * 10) / 10,
          count: task.count,
          half,
          ...(ctx.sleeping ? { sleeping: true } : {}),
        });
      };
      // 续做的 collect 按剩余数跑,进度读数加回打断前那一段:心跳与再次挂起看的都是整单的数
      const offset = carried?.done ?? 0;
      ctx.progress = (done, total) => {
        const count = { done: done + offset, total: total + offset };
        task.count = count;
        if (!halfSent && count.total > 1 && count.done * 2 >= count.total && count.done < count.total) {
          halfSent = true;
          sendProgress(true);
        }
      };
      const progressTimer = setInterval(() => sendProgress(false), PROGRESS_EVERY_MS);
      progressTimer.unref?.();
      const placedMark = placeMarksOf(bot);
      const reserveMark = ctx.reserveHits!.length;
      ctx.toolTrace = { last: undefined, notes: [], near: new Set() };
      const toolAndReserve = (): string =>
        toolTraceNote(ctx.toolTrace) + reserveNote(ctx.reserveHits!, reserveMark);
      ctx.intended = intended;
      const gainBase = collectGainBase(bot, call) ?? undefined;
      // 这一步能不能顺手把后面几步也做掉(目前只有 stow 用):它自己看剩下的步
      ctx.batch = {
        steps, index: i,
        absorb: (n, receipt) => { (task.absorbed ??= new Map()).set(n, receipt); },
      };
      /** 这一步登记的缺口(build 放不满);null = 没登记过 */
      let gapNote: string | null = null;
      ctx.partial = (gap) => { gapNote = gap; };
      try {
        const skillResult = await runSkill(bot, run, ctx);
        if (ctx.aborted()) return;
        const afterDimension = normalizeDimension(dimensionOf(bot));
        if (call.skill === 'transit') {
          expectedDimension = afterDimension;
        } else if (afterDimension !== expectedDimension) {
          transitBoundary = i + 1;
          const why = `${describeSkill(call)}执行期间未经 transit 从${zhDimension(expectedDimension)}进入了${zhDimension(afterDimension)}`;
          const line = `${stepHead(i, startedAt)}: ${why}；本步不按完成，整条尾巴已停`;
          land(i, 'fail', why, line);
          firstWhy ??= why;
          blockedSteps.push(line);
          this.opts.diag?.write({
            lane: 'skill', event: 'dimension-unexpected', taskId: id, durMs: Date.now() - startedAt,
            msg: why,
            data: { call, expectedDimension, actualDimension: afterDimension },
          });
          continue;
        }
        const result = skillResult
          + placedNote(bot, placedMark, call.skill, intended)
          + toolAndReserve();
        // 期望在场时它才是裁决:技能报成也可能被期望落空推翻。她没声明就由执行器推
        const expect = call.expect ?? deriveExpect(bot, call);
        const verdict = expect ? evaluateExpect(bot, expect, gainBase) : null;
        // 核验与这一步同一刻跑,句子却随终态回执一起重放:读数时刻要跟着句子走
        const readAt = verdict ? this.clock(Date.now()) : undefined;
        if (verdict && !verdict.met) {
          this.opts.diag?.write({
            lane: 'skill', event: 'blocked', taskId: id, durMs: Date.now() - startedAt,
            msg: `${describeSkill(call)}期望落空: ${verdict.actual}`,
            data: { call, result, expect, derived: call.expect === undefined, actual: verdict.actual, readAt },
          });
          const note = verdictNote(expect!, verdict, readAt);
          const line = `${stepHead(i, startedAt)}: ${describeSkill(call)}没做成(技能报「${result}」);${note}`;
          land(i, 'fail', note, line);
          bagDue ||= blockedOnItems(note);
          blockedSteps.push(line);
          if (call.skill === 'transit') transitBoundary = i + 1;
          continue;
        }
        this.opts.diag?.write({
          lane: 'skill', event: 'done', taskId: id, durMs: Date.now() - startedAt,
          msg: `${describeSkill(call)}: ${result}`,
          data: { call, result, ...(verdict ? { expect, derived: call.expect === undefined, actual: verdict.actual } : {}) },
        });
        // 技能登记了缺口 = 做了一部分:回执与任务终态都要说,别混进「完成」。
        // 例外:她**显式声明**的期望已达成时裁决权在期望(存量口径,与「技能报受阻
        // 但期望已达成」对称)——缺口的读数仍留在句子里,只是终态不再按半成算。
        const gap: string | null = verdict?.met && call.expect !== undefined ? null : gapNote;
        // 达成也回显:她拿不到正向确认时,重发是唯一可用的确认手段
        const line = `${stepHead(i, startedAt)}: ${result}${ranFree}${carriedNote}`
          + `${verdict ? `;${verdictNote(expect!, verdict, readAt)}` : ''}`
          + `${gap ? `;${gap}` : ''}`;
        land(i, gap ? 'partial' : 'ok', gap, line);
        if (gap) partialSteps.push(line);
        else results.push(line);
      } catch (err) {
        const aborted = err instanceof Aborted || ctx.aborted();
        if (aborted) {
          // 顶替/叫停的汇报已由发起方发过;Aborted 不评估 expect
          const by = (err instanceof Aborted ? err.by : null) ?? ctx.abortedBy?.() ?? null;
          this.opts.diag?.write({
            lane: 'skill', event: 'aborted', taskId: id, durMs: Date.now() - startedAt,
            msg: `${describeSkill(call)}被打断${by ? `(${by})` : ''}`,
            data: { call, error: (err as Error).message, by },
          });
          return;
        }
        const blocked = err instanceof SkillBlocked ? err : null;
        if (call.skill === 'transit') transitBoundary = i + 1;
        const reason = blocked ? blocked.message : `技能内部错误: ${zhErrorText((err as Error).message)}`;
        // 技能报阻但期望已达成(战利品自己进了包、人已经在目的地):按达成算
        const expect = call.expect ?? deriveExpect(bot, call);
        const verdict = expect ? evaluateExpect(bot, expect, gainBase) : null;
        const readAt = verdict ? this.clock(Date.now()) : undefined;
        if (verdict?.met && (call.expect !== undefined || mayOverturnBlocked(expect!))) {
          this.opts.diag?.write({
            lane: 'skill', event: 'done', taskId: id, durMs: Date.now() - startedAt,
            msg: `${describeSkill(call)}技能报受阻但期望已达成: ${verdict.actual}`,
            data: { call, error: reason, expect, derived: call.expect === undefined, actual: verdict.actual },
          });
          const line = `${stepHead(i, startedAt)}: `
            + `${describeSkill(call)}:技能报受阻(${reason});${verdictNote(expect!, verdict, readAt)}${toolAndReserve()}`;
          land(i, 'ok', null, line);
          results.push(line);
        } else if (err instanceof SkillNoop) {
          // 无事可做:条件不成立所以什么都没发生。陈述句、不进失败堆、不阻断下游。
          this.opts.diag?.write({
            lane: 'skill', event: 'noop', taskId: id, durMs: Date.now() - startedAt,
            msg: `${describeSkill(call)}无事可做: ${reason}`,
            data: { call, why: reason, ...(verdict ? { actual: verdict.actual } : {}) },
          });
          const line = `${stepHead(i, startedAt)}: ${reason},这一步没什么可做的${toolAndReserve()}`;
          land(i, 'noop', reason, line);
          firstWhy ??= reason;
          noopSteps.push(line);
        } else {
          this.opts.diag?.write({
            lane: 'skill', event: 'blocked', taskId: id, durMs: Date.now() - startedAt,
            msg: `${describeSkill(call)}受阻: ${(err as Error).message}`,
            data: {
              call, error: (err as Error).message, source: blockedSourceOf(err),
              ...(verdict ? { actual: verdict.actual } : {}),
            },
          });
          const line = `${stepHead(i, startedAt)}: `
            + `${blockedText(call, reason, expect, verdict, bot.heldItem?.name ?? null, readAt)}${toolAndReserve()}${carriedNote}`;
          land(i, 'fail', reason, line);
          firstWhy ??= reason;
          this.noteBlockedReason(reason, Date.now(), {
            task: label(),
            step: steps.length > 1 ? `第 ${i + 1} 步 ${describeSkill(call)}` : describeSkill(call),
          });
          // 这一单自己撞上的是哪几类:头条只在与其中一类同类时才上浮(见 blockedHeadline)
          myBlockedKeys.add(Executor.blockedKey(reason));
          // 判据只看受阻的**原因**:blockedText 尾巴上那句「不过包里现在有 N 个,够了」
          // 说的是东西不缺,拿它当"卡在东西上"就反了
          bagDue ||= blockedOnItems(reason);
          blockedSteps.push(line);
          if (blocked && blocked.scene.length > 0) scenes.push(...blocked.scene);
        }
      } finally {
        clearInterval(progressTimer);
        ctx.progress = undefined;
      }
    }
    // 现场事实单独成段:结论说发生了什么,现场说当时都知道什么
    const scene = scenes.length > 0 ? `\n[现场] ${scenes.join('\n[现场] ')}` : '';
    // 无事可做的那几步单独成段:它们既不是做成也不是没做成,混进哪一堆都会读歪
    const nothingToDo = noopSteps.length > 0 ? `\n没什么可做的:${listOf(noopSteps)}` : '';
    // 「同一件事上次什么下场」入账:只记没达到目的的,达到了就把旧账抹掉
    // (上次没成这次成了,再拿旧账去提醒她就是散布过期事实)。
    // 一步没成、全程无事可做也算没达到目的 —— 找牛找了 20 分钟一头没见着,
    // 任务层面是「做完了」,可她想要的那件事一次没发生。
    const sig = taskSignature(steps);
    const kind: PriorOutcome['kind'] | null = blockedSteps.length > 0 ? 'blocked'
      : partialSteps.length > 0 ? 'partial'
        : results.length === 0 && noopSteps.length > 0 ? 'noop'
          : null;
    if (kind) this.priorOutcomes.set(sig, { kind, why: firstWhy ?? '没说清为什么', at: Date.now() });
    else this.priorOutcomes.delete(sig);
    // 终态四分。没做成 > 做了一部分 > 完成:一单里最重的那个结局说了算。
    // 无事可做不影响终态——一单全是「附近没有掉落物」,那一单就是做完了。
    if (blockedSteps.length === 0 && partialSteps.length === 0) {
      this.finish(flag, {
        kind: 'done',
        text: `${span()}${label()}完成:${listOf(results)}${nothingToDo}${scene}`,
        taskId: id,
      });
      return;
    }
    const doneSoFar = results.length > 0 ? `\n做成的:${listOf(results)}` : '';
    if (blockedSteps.length === 0) {
      this.finish(flag, {
        kind: 'partial',
        text: `${span()}${label()}做了一部分:${listOf(partialSteps)}${doneSoFar}${nothingToDo}${scene}`,
        taskId: id,
      });
      return;
    }
    const halfDone = partialSteps.length > 0 ? `\n做了一部分的:${listOf(partialSteps)}` : '';
    // 头名理由上浮:只在这一单自己就撞在那一类上时才拼(见 blockedHeadline)
    const headline = this.blockedHeadline(Date.now(), myBlockedKeys);
    this.finish(flag, {
      // 存在受阻或跳过的步骤时，任务终态为 blocked。
      kind: 'blocked',
      text: `${headline ?? ''}${span()}${label()}:${listOf(blockedSteps.map(renderBlocked))}${halfDone}${doneSoFar}${nothingToDo}${scene}`
        + `${bagDue ? bagNow(bot) : ''}`,
      taskId: id,
    });
  }

  /**
   * 受阻理由归并用的键:坐标、数字、方块名后缀都摘掉,只留"这是哪一类受阻"。
   * 只做字面归并,不做归因。
   */
  private static blockedKey(why: string): string {
    return why
      .replace(/\(\s*-?\d+\s*,\s*-?\d+\s*,\s*-?\d+\s*\)/g, '')
      .replace(/-?\d+(\.\d+)?/g, '')
      .replace(/\s+/g, '')
      .slice(0, 60);
  }

  /** 受阻原文账,新的在前(见 blockedRecords) */
  blockedLog(): readonly BlockedRecord[] {
    return this.blockedRecords;
  }

  /**
   * 「包里只剩 N 格」这一行,附在任务终态回执末尾。
   *
   * 补的是 precheck 那条格位警告够不着的那一段:precheck 只在**这一步要往包里装东西**
   * 时才算格位(`包里剩 N 格空位,这一步…预计要占 M 格`),于是挖了一路矿、包早就快满了,
   * 只要下一单不是装东西的,她一个字都读不到,直到某一步真的被「包满了,没处放」驳回。
   *
   * 防刷屏是**状态机**不是节流:一次「跌破 5 格」只说一次,空位回到 5 格以上再跌破
   * 才说第二次。所以捡两格土又扔掉不会来回念,而真的从宽裕挖到快满一定会被说到一次。
   *
   * 只报两个数与账上最近的那个箱子(复用 `knownChestNote` 的同一份口径与措辞),
   * 去不去清、清什么、就地放个新箱子还是走回去,都是她的权衡。
   */
  private bagLowNote(bot: Bot): string {
    // 物品栏还没到手(登录后 window_items 未到、台架的裸 bot):没有读数就不出声,
    // 更不能把"读不到"当成"空的"报成一句「只剩 36 格」
    const items = bot.inventory?.items?.();
    if (!items) return '';
    const free = Math.max(0, PLAYER_SLOTS - items.length);
    if (free > BAG_LOW_FREE) {
      this.bagLowArmed = true;
      return '';
    }
    if (!this.bagLowArmed) return '';
    this.bagLowArmed = false;
    const chest = knownChestNote(bot, this.opts.chests);
    return `\n[背包] 包里只剩 ${free} 格空位,快满了${chest ?? ';账上本维度还没有记过箱子'}`;
  }

  private noteBlockedReason(why: string, at: number, where?: { task: string; step: string }): void {
    if (where) {
      this.blockedRecords.unshift({ at, task: where.task, step: where.step, why });
      if (this.blockedRecords.length > BLOCKED_LOG_MAX) this.blockedRecords.length = BLOCKED_LOG_MAX;
    }
    const key = Executor.blockedKey(why);
    const cut = at - BLOCKED_HEADLINE_WINDOW_MS;
    for (const [k, v] of this.blockedReasons) {
      v.at = v.at.filter((t) => t > cut);
      if (v.at.length === 0) this.blockedReasons.delete(k);
    }
    const entry = this.blockedReasons.get(key) ?? { at: [] };
    entry.at.push(at);
    this.blockedReasons.set(key, entry);
  }

  /**
   * 报告一小时内与本单受阻原因相同的累计次数。
   * 候选仅取本单遇到的归并类；达到门槛后选次数最多的一类，头条只报次数，原因保留在步骤结果中。
   */
  private blockedHeadline(at: number, mine: ReadonlySet<string>): string | null {
    const cut = at - BLOCKED_HEADLINE_WINDOW_MS;
    let top = 0;
    for (const key of mine) {
      const count = this.blockedReasons.get(key)?.at.filter((t) => t > cut).length ?? 0;
      if (count >= BLOCKED_HEADLINE_MIN && count > top) top = count;
    }
    if (top === 0) return null;
    const mins = Math.round(BLOCKED_HEADLINE_WINDOW_MS / 60_000);
    return `⚠ 这一类受阻在过去 ${mins} 分钟里已经是第 ${top} 次\n`;
  }

  /** 任务终结后继续队列，受阻不自动撤销后续任务；撤单由 mc_stop 决定。 */
  private finish(flag: AbortFlag, report: TaskReport): void {
    if (this.stopped || flag.aborted || flag.epoch !== this.executionEpoch) return;
    const t = this.task?.flag === flag ? this.task : null;
    if (t) this.task = null;
    // 「包快满了」只搭**跑完了的那一单**的车:顶替/撤单那两种终态说的是「这一单没了」,
    // 往上贴一行背包读数只会把那句话冲淡。状态机本身照常在这三种终态上推进。
    const bot = this.opts.getBot();
    const bagLow = bot && (report.kind === 'done' || report.kind === 'partial' || report.kind === 'blocked')
      ? this.bagLowNote(bot)
      : '';
    const text = `${report.text}${bagLow}`;
    this.opts.diag?.write({
      lane: 'task', event: report.kind, taskId: report.taskId, msg: text,
    });
    this.opts.report({ ...report, text });
    this.pump();
    // pump 没接到新任务 = 队列空了:兜底关掉忘关的容器窗口(窗口卫生)
    if (!this.task && this.queue.length === 0) this.opts.onDrain?.();
  }
}

/** 反射层的阈值与开关。一律现读,控制台热改即生效。 */
interface ReflexOptions {
  getBot: () => Bot | null;
  report: (r: TaskReport) => void;
  log: Logger;
  /** 低血等不可恢复接管仍走破坏性抢占。 */
  preempt: (reason: string) => void;
  /** 岩浆、溺水和窒息接管时冻结任务断点与队列。 */
  pauseEnvironment: (reason: string) => QueueHoldToken | null;
  /** 所有环境危险清除并稳定落脚后恢复冻结断点。 */
  resumeEnvironment: (token: QueueHoldToken) => QueueResumeResult;
  /** 深坠落只终止当前危险任务，排队与冻结计划继续保留。 */
  stopFallTask: (reason: string) => QueueHoldToken | null;
  /** 深坠落后仅在稳定干燥落脚时恢复排队计划。 */
  resumeAfterFall: (token: QueueHoldToken) => boolean;
  /** 执行器的当前任务正在逃(flee/surface/战斗撤退):受击反应整个让路,不添乱 */
  escapeActive?: () => boolean;
  /** 受击是否反击(关掉则反射不还手,打不打由主脑决定) */
  fightBack: () => boolean;
  /** 反击时生命低于此值改为脱离战斗 */
  fleeHealth: () => number;
  /** 两次受击反应之间的最短间隔(秒) */
  reactCooldownSec: () => number;
  /** 防溺水上浮 */
  antiDrown: () => boolean;
  /** 挨烧就跑(岩浆、火);关掉则连手动冲刺一起松手 */
  antiLava: () => boolean;
  /**
   * 战斗会话接手受击:返回 true = 会话开打/已在打(反射不再自己抡,也不用
   * 反应冷却);false = 会话进不了场(关着/冷却/环境自保),退回反射的降级行为。
   */
  combatHurt?: (attackerId: number, name: string) => boolean;
  /** World 日志;不给就不记 */
  diag?: MinecraftLog;
}

/**
 * 挨烧与防溺水逐心跳检查；受击挂钩按 SLOW_EVERY 分频。
 */
const REFLEX_TICK_MS = 200;

/** 逃跑方向:背对危险格的水平反方向,取 6 格远处一个供 lookAt 用的瞄点 */
function awayFrom(p: { x: number; y: number; z: number }, hazard: { x: number; y: number; z: number }): Vec3 {
  const dx = p.x - (hazard.x + 0.5);
  const dz = p.z - (hazard.z + 0.5);
  const len = Math.hypot(dx, dz);
  // 正正好站在危险格中心(陷进去了):没有方向可言,随便挑一个走出去
  if (len < 1e-6) return new Vec3(p.x + 6, p.y + 1.6, p.z);
  return new Vec3(p.x + (dx / len) * 6, p.y + 1.6, p.z + (dz / len) * 6);
}
const SLOW_EVERY = 5;

/**
 * 会把人埋住并持续窒息的下落方块。比 `isGravityBlock` 窄:铁砧/龙蛋/钟乳石也会掉,
 * 但不是整方块,压不出窒息伤害,挖它们脱不了困。
 */
function isSuffocatingFaller(name: string): boolean {
  return name === 'sand' || name === 'red_sand' || name === 'gravel'
    || name === 'suspicious_sand' || name === 'suspicious_gravel'
    || name.endsWith('_concrete_powder');
}

/** 原版摔落伤害从超过 3 格起算;落体记录用同一条线,免得每次跳跃都记一笔 */
const FALL_DAMAGE_BLOCKS = 3;
/** 超过这段落差后，原任务落点与路径前提均已失效。 */
const FALL_TASK_STOP_BLOCKS = 6;
/** 连续稳定三次以上心跳才交还队列，过滤边缘触地与史莱姆反弹。 */
const FALL_SAFE_FOOTING_MS = 600;
/** 环境与深坠冻结租约各自的超时阈值；到期释放对应槽并报告现场，另一槽仍可保持队列冻结。 */
const HOLD_WATCHDOG_MS = 60_000;
/**
 * 反射自己下的逃生目标允许零推进多久。
 *
 * 这三条路(登岸、逃岩浆、低血脱离)都是裸 `setGoal`,不经 `gotoGoal`,没有 deadline
 * 也没有收尾校验;而空路径之后寻路器的 `pathUpdated` 闩锁让它**永不重算**——
 * 目标一旦不可达就是死等。到点撤销目标,交回各反射自己的重试节奏重下。
 */
const ESCAPE_STALL_MS = 5_000;
/** 与 FALL_SAFE_MOVE 同口径:小于这个数的位移是站桩时的抖动,不算推进 */
const ESCAPE_STALL_MOVE = 0.08;
const FALL_SAFE_MOVE = 0.08;
const FALL_UNSAFE_BLOCKS = new Set([
  'cactus', 'sweet_berry_bush', 'wither_rose', 'powder_snow',
  'campfire', 'soul_campfire', 'magma_block', 'fire', 'soul_fire', 'lava',
]);

function safeFallFooting(bot: Bot): boolean {
  if ((bot.health ?? 0) <= 0 || !hasDryFooting(bot)) return false;
  const touch = hazardTouch(bot);
  if (touch.touching !== null || touch.onFire) return false;
  const p = bot.entity.position;
  for (let x = Math.floor(p.x - 0.31); x <= Math.floor(p.x + 0.31); x++) {
    for (let z = Math.floor(p.z - 0.31); z <= Math.floor(p.z + 0.31); z++) {
      for (let y = Math.floor(p.y - 0.05); y <= Math.floor(p.y + 1.79); y++) {
        const block = blockAtCell(bot, { x, y, z });
        if (block && FALL_UNSAFE_BLOCKS.has(block.name)) return false;
      }
    }
  }
  return true;
}

export class Reflexes {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private busyFighting = false;
  private lastHurtReactAt = 0;
  private ticks = 0;
  private hurtHandler: ((
    entity: { id: number },
    source?: HurtSource,
  ) => void) | null = null;
  private deathHandler: (() => void) | null = null;
  private hookedBot: Bot | null = null;
  private environmentHold: QueueHoldToken | null = null;
  /** 当前环境租约起租时刻；0 表示没有计时中的环境租约。 */
  private environmentHoldSince = 0;
  /** 看门狗强制解冻过这一轮环境危机:危机彻底解除前不再重新冻结队列。 */
  private environmentForfeited = false;
  /** 执行器单边清空了冻结两槽(mc_stop 等):下一拍要为仍在的危机重申一张新租约。 */
  private environmentHoldStale = false;
  private environmentSafe: {
    since: number;
    at: { x: number; y: number; z: number };
  } | null = null;
  /** 反射自己下的逃生目标:哪条反射下的、什么目标、上次见到推进是什么时候、当时人在哪 */
  private escapeGoal: {
    kind: 'drown' | 'lava' | 'flee';
    goal: InstanceType<typeof goals.Goal>;
    since: number;
    at: { x: number; y: number; z: number };
    /** 目标格(登岸/换气点):零推进撤销后进本轮溺水的排除集,不再重选 */
    target?: Cell;
  } | null = null;

  constructor(private readonly opts: ReflexOptions) {}

  /** 环境自保正在进行：战斗会话据此让位、也不进场。 */
  get envActive(): boolean {
    return this.environmentOwnerKind !== null;
  }

  /** 影子全身租约与战斗让位共用的当前环境 owner。 */
  get environmentOwnerKind(): 'lava' | 'drown' | 'suffocation' | null {
    if (this.lavaEscape !== null) return 'lava';
    if (this.drowning) return 'drown';
    if (this.buried !== null) return 'suffocation';
    return null;
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), REFLEX_TICK_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // 停在逃跑中途:方向键留在按下状态,人会一直朝那边走
    const bot = this.opts.getBot();
    if (bot?.entity && this.lavaEscape !== null && !this.lavaEscape.handedOff) this.releaseDash(bot);
    this.lavaEscape = null;
    if (bot?.entity && this.buried !== null) bot.setControlState('jump', false);
    this.buried = null;
    this.drowning = false;
    this.environmentHold = null;
    this.environmentHoldSince = 0;
    this.environmentForfeited = false;
    this.environmentHoldStale = false;
    this.environmentSafe = null;
    this.escapeGoal = null;
    // 反射停了就不再有"正在救命的目标",登记必须跟着撤,否则 releaseBody 会一直
    // 认为那张还归反射用、谁也撤不掉它
    if (bot) clearEscapeGoalOwner(bot);
    this.fall = null;
    this.fallBot = null;
    if (this.hookedBot && this.hurtHandler) {
      this.hookedBot.removeListener('entityHurt', this.hurtHandler as never);
    }
    if (this.hookedBot && this.deathHandler) {
      this.hookedBot.removeListener('death', this.deathHandler as never);
    }
    this.hookedBot = null;
  }

  private tick(): void {
    if (this.stopped) return;
    const bot = this.opts.getBot();
    if (!bot?.entity) return;
    const slow = this.ticks++ % SLOW_EVERY === 0;
    if (slow) this.hookHurt(bot);
    // 防溺水与防烧在各自开关启用时逐心跳检查；关闭防烧时调用 endLavaEscape 收尾。
    // 执行器清空冻结后，持续危机会重申环境租约，仍受 beginEnvironment 的超时放弃限制。
    if (this.environmentHoldStale) {
      this.environmentHoldStale = false;
      if (this.environmentOwnerKind !== null && this.environmentHold === null) {
        this.beginEnvironment(`${Reflexes.ownerText(this.environmentOwnerKind)}危机还在,重申队列冻结`);
      }
    }
    if (this.opts.antiDrown()) void this.antiDrown(bot);
    if (this.opts.antiLava()) void this.antiLava(bot);
    else this.endLavaEscape(bot, false);
    if (this.buried !== null) void this.antiSuffocate(bot);
    this.watchFall(bot);
    this.resumeEnvironmentWhenSafe(bot);
    this.watchHolds(bot);
    this.watchEscapeGoal(bot);
  }

  /**
   * 下一个逃生目标并开始盯它。裸 `setGoal` 的三条路都走这里,免得再出现
   * 「下完就没人管」的目标。
   */
  private setEscapeGoal(
    bot: Bot, kind: 'drown' | 'lava' | 'flee', goal: InstanceType<typeof goals.Goal>, target?: Cell,
  ): void {
    // 同步登记给 releaseBody:别人交还身体时不许把正在救命的这一张撤掉。
    // 下达与登记是同一处(setOwnedGoal 记的就是 escape 这一档),两本账合成一本
    setOwnedGoal(bot, goal, 'escape', escapeIntent(kind), { diag: this.opts.diag });
    const p = bot.entity.position;
    this.escapeGoal = { kind, goal, since: Date.now(), at: { x: p.x, y: p.y, z: p.z }, target };
  }

  /**
   * 逃生目标看门狗:零推进超过 ESCAPE_STALL_MS 就撤掉重下。
   *
   * 重下不新造节奏 —— 溺水把「每 8 秒找一次岸」的钟归零(下一拍就重找),岩浆退回
   * 手动冲刺那条既有兜底(冲够 DASH_MS 再交给寻路器),只有低血脱离没有自己的
   * 节拍,原地重下同一个目标(dropGoal 已经把 `pathUpdated` 闩锁解开,这一下会真重算)。
   */
  private watchEscapeGoal(bot: Bot): void {
    const esc = this.escapeGoal;
    if (esc === null) return;
    // 目标已经被别人换掉/撤掉了:这张不再归我看
    if (bot.pathfinder?.goal !== undefined && bot.pathfinder.goal !== esc.goal) {
      this.escapeGoal = null;
      return;
    }
    const now = Date.now();
    const p = bot.entity.position;
    const moved = Math.hypot(p.x - esc.at.x, p.y - esc.at.y, p.z - esc.at.z);
    if (moved > ESCAPE_STALL_MOVE) {
      esc.since = now;
      esc.at = { x: p.x, y: p.y, z: p.z };
      return;
    }
    if (now - esc.since < ESCAPE_STALL_MS) return;
    this.escapeGoal = null;
    dropGoal(bot, 'escape', `${escapeIntent(esc.kind)}零推进,撤了重下`, this.opts.diag);
    const what = escapeIntent(esc.kind);
    this.opts.diag?.write({
      lane: 'reflex', event: 'escape-goal-stalled',
      msg: `${what}的逃生目标 ${Math.round(ESCAPE_STALL_MS / 1000)} 秒零推进,已撤销重下`,
      data: {
        kind: esc.kind, stallMs: now - esc.since,
        position: bot.entity.position, health: bot.health,
      },
    });
    if (esc.kind === 'drown') {
      // 将零推进的登岸格列入本轮排除集，避免重试再次选中。
      if (esc.target) this.drownExcluded.add(cellKeyOf(esc.target));
      this.lastDrownEscapeAt = 0; // 下一拍 routeDrownToLand 重新找岸
    } else if (esc.kind === 'lava' && this.lavaEscape !== null) {
      this.lavaEscape.handedOff = false; // 退回手动冲刺,冲够 DASH_MS 再交寻路器
      this.lavaEscape.startedAt = now;
    } else if (esc.kind === 'flee') {
      this.setEscapeGoal(bot, 'flee', esc.goal);
    }
  }

  /**
   * 执行器清空冻结后丢弃失效令牌，并标记下一拍重新申请。
   * environmentForfeited 保留超时放弃状态，限制持续危机对队列的占用。
   */
  invalidateEnvironmentHold(): void {
    if (this.environmentHold === null) return;
    this.environmentHold = null;
    this.environmentHoldSince = 0;
    this.environmentSafe = null;
    const kind = this.environmentOwnerKind;
    this.environmentHoldStale = kind !== null;
    this.opts.diag?.write({
      lane: 'reflex', event: 'environment-hold-invalidated',
      msg: `执行器清空了冻结租约,反射的旧令牌作废`
        + (kind !== null ? `;${Reflexes.ownerText(kind)}危机还在,下一拍重申` : ''),
      data: { owner: kind, willReassert: kind !== null },
    });
  }

  private beginEnvironment(reason: string): void {
    if (this.environmentHold !== null) return;
    // 这一轮危机的冻结已被看门狗强制解冻过:再冻一次等于下一拍又把队列关死
    if (this.environmentForfeited) return;
    this.environmentHold = this.opts.pauseEnvironment(reason);
    this.environmentSafe = null;
    if (this.environmentHold !== null) this.environmentHoldSince = Date.now();
  }

  /** 环境 owner 的中文说法,只出现在回报里。 */
  private static ownerText(kind: 'lava' | 'drown' | 'suffocation' | null): string {
    if (kind === 'lava') return '岩浆';
    if (kind === 'drown') return '溺水';
    if (kind === 'suffocation') return '窒息';
    return '危险已解除';
  }

  /** 脚下那一格的方块名:强制解冻要说清当时人踩在什么上面。 */
  private footingText(bot: Bot): string {
    const feet = feetOf(bot);
    const below = blockAtCell(bot, { x: feet.x, y: feet.y - 1, z: feet.z });
    return below ? zhName(below.name) : '读不到的方块';
  }

  /**
   * 冻结看门狗。深坠与环境两条 hold 都只在"稳定干燥落脚"时解冻,超时强制交还队列。
   * 走反射心跳,不另开定时器。环境侧解冻后置 forfeited,否则下一拍 beginEnvironment
   * 立刻再冻一次;深坠侧直接丢掉本轮落体记录,重新起跳会重新计数。
   */
  private watchHolds(bot: Bot): void {
    const now = Date.now();
    if (this.environmentHold === null && this.environmentOwnerKind === null) {
      this.environmentForfeited = false;
    }
    const envToken = this.environmentHold;
    if (envToken !== null && this.environmentHoldSince !== 0
      && now - this.environmentHoldSince >= HOLD_WATCHDOG_MS) {
      const heldSec = Math.round((now - this.environmentHoldSince) / 1000);
      const kind = this.environmentOwnerKind;
      const footing = this.footingText(bot);
      this.environmentHold = null;
      this.environmentHoldSince = 0;
      this.environmentSafe = null;
      this.environmentForfeited = true;
      const resumed = this.opts.resumeEnvironment(envToken);
      // 令牌对不上号时这一下并没有解冻任何东西(冻结已换租约或已被撤),照实说
      const text = `[反射] 环境冻结(${Reflexes.ownerText(kind)})超过 ${heldSec} 秒仍未稳定落脚,`
        + (resumed.released ? '已解冻队列;' : '这张租约已经失效,没有可解冻的队列;')
        + `当时脚下是${footing},人在 ${cellText(feetOf(bot))}。`
        + (resumed.released && resumed.note ? `${resumed.note}。` : '');
      this.opts.diag?.write({
        lane: 'reflex', event: 'hold-timeout', msg: text,
        data: {
          hold: 'environment', owner: kind, footing, heldSec, resumed,
          position: bot.entity.position, health: bot.health,
        },
      });
      this.opts.report({ kind: 'reflex', text });
    }
    const fall = this.fall;
    if (fall?.stopped === true && fall.hold !== null && fall.holdSince !== 0
      && now - fall.holdSince >= HOLD_WATCHDOG_MS) {
      const heldSec = Math.round((now - fall.holdSince) / 1000);
      const footing = this.footingText(bot);
      const token = fall.hold;
      this.fall = null;
      const released = this.opts.resumeAfterFall(token);
      const text = `[反射] 深坠冻结超过 ${heldSec} 秒仍未稳定落脚,`
        + (released ? '已解冻队列;' : '这张租约已经失效,没有可解冻的队列;')
        + `当时脚下是${footing},人在 ${cellText(feetOf(bot))}。`;
      this.opts.diag?.write({
        lane: 'reflex', event: 'hold-timeout', msg: text,
        data: {
          hold: 'fall', footing, heldSec, released,
          position: bot.entity.position, health: bot.health,
        },
      });
      this.opts.report({ kind: 'reflex', text });
    }
  }

  /** 所有环境 owner 都退出并稳定干燥落脚后，才把断点交还给执行器。 */
  private resumeEnvironmentWhenSafe(bot: Bot): void {
    const token = this.environmentHold;
    if (token === null) return;
    if (this.environmentOwnerKind !== null || !safeFallFooting(bot)) {
      this.environmentSafe = null;
      return;
    }
    const now = Date.now();
    const p = bot.entity.position;
    const moved = this.environmentSafe === null
      ? Infinity
      : Math.hypot(
          p.x - this.environmentSafe.at.x,
          p.y - this.environmentSafe.at.y,
          p.z - this.environmentSafe.at.z,
        );
    if (this.environmentSafe === null || moved > FALL_SAFE_MOVE) {
      this.environmentSafe = { since: now, at: { x: p.x, y: p.y, z: p.z } };
      return;
    }
    if (now - this.environmentSafe.since < FALL_SAFE_FOOTING_MS) return;
    this.environmentHold = null;
    this.environmentHoldSince = 0;
    this.environmentSafe = null;
    const resumed = this.opts.resumeEnvironment(token);
    this.opts.diag?.write({
      lane: 'reflex', event: 'environment-safe',
      msg: `环境危机后已在 ${cellText(feetOf(bot))} 稳定落脚,`
        + (resumed.released ? '恢复执行权' : '旧恢复租约已失效'),
      data: { position: bot.entity.position, health: bot.health, resumed },
    });
    if (resumed.released && resumed.note) {
      this.opts.report({
        kind: 'reflex',
        text: `[反射] 已稳定脱离环境危险;${resumed.note}。`,
      });
    }
  }

  /**
   * 危险已经解除、但脚下永远不会干(开阔水域游着换气)时就地交还队列。
   * 稳定落脚那条路要求 `safeFallFooting`,在水里恒假,只等它等于永久冻结。
   */
  private releaseEnvironmentHoldNow(bot: Bot, why: string): void {
    const token = this.environmentHold;
    if (token === null || this.environmentOwnerKind !== null) return;
    this.environmentHold = null;
    this.environmentHoldSince = 0;
    this.environmentSafe = null;
    const resumed = this.opts.resumeEnvironment(token);
    this.opts.diag?.write({
      lane: 'reflex', event: 'environment-safe',
      msg: `${why},` + (resumed.released ? '恢复执行权' : '旧恢复租约已失效'),
      data: { position: bot.entity.position, health: bot.health, resumed, why },
    });
    if (resumed.released && resumed.note) {
      this.opts.report({ kind: 'reflex', text: `[反射] ${why};${resumed.note}。` });
    }
  }

  /** 受击反应挂在 bot 事件上;重连换 bot 后重挂 */
  private hookHurt(bot: Bot): void {
    if (this.hookedBot === bot) return;
    if (this.hookedBot && this.hurtHandler) {
      this.hookedBot.removeListener('entityHurt', this.hurtHandler as never);
    }
    if (this.hookedBot && this.deathHandler) {
      this.hookedBot.removeListener('death', this.deathHandler as never);
    }
    this.hookedBot = bot;
    const handler = (
      entity: { id: number },
      source?: HurtSource,
    ) => {
      if (entity.id !== bot.entity?.id) return;
      void this.onHurt(bot, source);
    };
    this.hurtHandler = handler;
    this.deathHandler = () => {
      this.fall = null;
      this.environmentHold = null;
      this.environmentHoldSince = 0;
      this.environmentForfeited = false;
      this.environmentHoldStale = false;
      this.environmentSafe = null;
      this.drowning = false;
      this.submergedAt = 0;
      this.surfacedAt = 0;
      this.drownExcluded.clear();
      // 氧气元数据死后停在旧值,复活后服务端不一定补发:读数再变之前只信水下计时
      this.oxygenTrusted = false;
      this.lavaEscape = null;
      this.buried = null;
      this.escapeGoal = null;
      clearEscapeGoalOwner(bot);
    };
    bot.on('entityHurt', handler as never);
    bot.on('death', this.deathHandler as never);
  }

  /** 着火时检测火源的半径；范围内仍有火源则继续脱离。 */
  private static readonly ON_FIRE_HAZARD_R = 3;
  /** 找逃生落脚格的扫描半径 */
  private static readonly ESCAPE_SCAN_R = 4;
  /** 先手动冲这么久再把目标交给寻路器:A* 一次要几百毫秒到两秒,岩浆等不起 */
  private static readonly DASH_MS = 1_200;
  private static readonly LAVA_REPORT_MS = 20_000;

  /** 同一片岩浆的两次接触算不算一轮:间隔超过这个数就重新计数 */
  private static readonly LAVA_BOUT_GAP_MS = 30_000;

  /**
   * 连续无危险接触且熄火满 600ms 才结算 lava-clear，期间不交还执行权。
   * 600ms 约三次心跳，用于过滤危险边缘的采样抖动。
   */
  private static readonly LAVA_CLEAR_DWELL_MS = 600;

  private lastLavaReportAt = 0;
  private lavaEscape: {
    startedAt: number; handedOff: boolean; reported: boolean;
    /** 头一次读到「不碰、也不烧」的时刻;再碰到就清回 null(见 LAVA_CLEAR_DWELL_MS) */
    clearSince: number | null;
  } | null = null;
  /**
   * 一轮岩浆的进出计次。只有火也熄灭才记 clear；短暂离开碰撞格但仍燃烧不结算。
   * 同一片危险区内再次接触仍用计次区分，避免把反复进出读成多次成功。
   */
  private lavaBout = { count: 0, firstAt: 0, lastClearAt: 0 };

  /**
   * 挨烧就跑。触发口径是"碰撞箱压着烧人的方块",不是"脚下那格是岩浆"——贴着岩浆池
   * 边缘走的时候人已经在掉血,而中心格还是空气,这是真机上最常见的中招方式;流动
   * 岩浆柱蹭到身上同理。身上着火且火源还在近处也算,那说明刚蹭进去、下一跳还会挨。
   */
  private async antiLava(bot: Bot): Promise<void> {
    const touch = hazardTouch(bot);
    const hazard = touch.touching
      ?? (touch.onFire ? nearestHazard(bot, Reflexes.ON_FIRE_HAZARD_R) : null);
    if (hazard === null) {
      this.endLavaEscape(bot, touch.onFire);
      return;
    }
    const now = Date.now();
    const p = bot.entity.position;
    if (this.lavaEscape === null) {
      this.beginEnvironment('逃离岩浆');
      // 正在飞的寻路多半就是把人送进来的那条;先撤掉,免得它把人拽回去
      dropGoal(bot, 'escape', '踩进岩浆,撤掉正在飞的那条路', this.opts.diag);
      this.escapeGoal = null;
      this.lavaEscape = { startedAt: now, handedOff: false, reported: false, clearSince: null };
      const fresh = this.lavaBout.count === 0
        || now - this.lavaBout.lastClearAt > Reflexes.LAVA_BOUT_GAP_MS;
      if (fresh) this.lavaBout = { count: 1, firstAt: now, lastClearAt: 0 };
      else this.lavaBout.count += 1;
    }
    const esc = this.lavaEscape;
    // 又碰上了:上一拍那点"没碰到"不算数,驻留窗口从头计
    esc.clearSince = null;
    // 交给寻路器之后还在烧,说明它没把人带出去;收回来自己跑,别在火里等 A*
    if (esc.handedOff && now - esc.startedAt >= Reflexes.DASH_MS * 2) {
      esc.handedOff = false;
      esc.startedAt = now;
      dropGoal(bot, 'escape', '交给寻路器还在烧,收回来自己跑', this.opts.diag);
      this.escapeGoal = null;
    }
    // 落脚点逐 tick 复算:流动岩浆还在铺开,上一 tick 的安全格这一 tick 未必安全。
    // 身上着着火时水格是最高优先的落脚点(preferWater),不再被当障碍排除
    const cell = findEscapeCell(
      bot, hazardsWithin(bot, Reflexes.ESCAPE_SCAN_R), Reflexes.ESCAPE_SCAN_R, touch.onFire,
    );
    if (!esc.handedOff) {
      if (cell !== null && now - esc.startedAt >= Reflexes.DASH_MS) {
        // 冲开一段之后多半已经出了岩浆,这时候再让寻路器把人送到落脚点
        esc.handedOff = true;
        this.releaseDash(bot);
        this.setEscapeGoal(bot, 'lava', new goals.GoalBlock(cell.x, cell.y, cell.z));
      } else {
        this.dashAway(bot, hazard, cell, touch.submerged);
      }
    }
    if (now - this.lastLavaReportAt < Reflexes.LAVA_REPORT_MS) return;
    this.lastLavaReportAt = now;
    esc.reported = true;
    const what = zhName(hazard.name);
    const how = touch.touching === null
      ? `身上着火了,${what}就在 ${hazard.distance.toFixed(1)} 格外`
      : touch.submerged ? `整个人陷进${what}里了` : `碰到${what}了(${hazard.distance.toFixed(1)} 格)`;
    this.opts.diag?.write({
      lane: 'reflex', event: 'lava',
      msg: `${how},正在往 ${cell ? `(${cell.x}, ${cell.y}, ${cell.z})` : '反方向'} 逃`,
      data: {
        position: p, hazard, cell, onFire: touch.onFire,
        submerged: touch.submerged, health: bot.health,
        bout: this.lavaBout.count, boutMs: now - this.lavaBout.firstAt,
      },
    });
    this.opts.report({
      kind: 'reflex',
      hurt: true,
      text: `[反射] ${how}!正在逃离。生命 ${Math.ceil(bot.health ?? 0)}/20。`,
    });
  }

  /**
   * 手动冲刺:寻路器算一条路要几百毫秒到两秒,岩浆里只有两秒半可活,这段时间
   * 只能自己按方向键。有落脚格就朝它冲,没有就照着危险的反方向硬冲。
   */
  private dashAway(
    bot: Bot,
    hazard: HazardCell,
    cell: { x: number; y: number; z: number } | null,
    submerged: boolean,
  ): void {
    const p = bot.entity.position;
    const aim = cell !== null
      ? new Vec3(cell.x + 0.5, cell.y + 1.6, cell.z + 0.5)
      : awayFrom(p, hazard);
    void bot.lookAt(aim, true).catch(() => undefined);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    // 陷进岩浆里是往下沉的,得一直按跳才浮得上来;要跨上去的落脚格同理
    bot.setControlState('jump', submerged || (cell !== null && cell.y > Math.floor(p.y)));
  }

  private releaseDash(bot: Bot): void {
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    bot.setControlState('jump', false);
  }

  /** 身上还烧着时找水的扫描半径;着火满时长 8 秒,值得看远一点 */
  private static readonly BURN_WATER_SCAN_R = 16;
  /** 两次找水之间的最短间隔:找块 + 下目标不便宜,寻路器也需要时间跑 */
  private static readonly BURN_SEEK_MS = 2_000;
  private lastBurnSeekAt = 0;

  /** 脱离岩浆后若仍着火，保留本轮逃生控制并优先寻找水格。 */
  private seekWaterWhileBurning(bot: Bot): void {
    if (bodyInWater(bot)) return; // 已经泡进水里,火这就灭,等 clear 分支收尾
    const now = Date.now();
    if (now - this.lastBurnSeekAt < Reflexes.BURN_SEEK_MS) return;
    this.lastBurnSeekAt = now;
    // 已有在飞的逃生目标:watchEscapeGoal 在盯零推进,不重下
    if (this.escapeGoal !== null) return;
    let water: Cell | null = null;
    try {
      water = findFishingWater(bot, Reflexes.BURN_WATER_SCAN_R);
    } catch {
      water = null;
    }
    if (water === null) {
      this.opts.diag?.write({
        lane: 'reflex', event: 'burning-no-water',
        msg: `身上还着着火,${Reflexes.BURN_WATER_SCAN_R} 格内没看见水`,
        data: { position: bot.entity.position, health: bot.health },
      });
      return;
    }
    this.opts.diag?.write({
      lane: 'reflex', event: 'burning-seek-water',
      msg: `身上还着着火,去 (${water.x}, ${water.y}, ${water.z}) 的水里灭火`,
      data: { water, position: bot.entity.position, health: bot.health },
    });
    this.setEscapeGoal(bot, 'lava', new goals.GoalBlock(water.x, water.y, water.z));
  }

  /** 离开危险格、火已熄灭,并且这个状态连着站住 `LAVA_CLEAR_DWELL_MS` 之后才算这一轮逃离完成。 */
  private endLavaEscape(bot: Bot, stillOnFire: boolean): void {
    const esc = this.lavaEscape;
    if (esc === null) return;
    if (stillOnFire) {
      // 远离火源后不必再背着火源乱跑,但燃烧状态仍属同一轮逃生,不能写 lava-clear
      // 或报完成 —— 也不能松手:继续接管,把人往最近的水里带。
      if (!esc.handedOff) this.releaseDash(bot);
      esc.clearSince = null;
      this.seekWaterWhileBurning(bot);
      return;
    }
    const now = Date.now();
    // 驻留窗口:单 tick 无接触撑不住「我出来了」这句断言(见 LAVA_CLEAR_DWELL_MS)。
    // 窗口里身体仍归环境自保 —— 不结算、不写 lava-clear、不交还执行权;
    // 但冲刺这一刻就松开:窗口是给断言用的,不是让她再往前冲半秒。
    if (esc.clearSince === null) {
      esc.clearSince = now;
      if (!esc.handedOff) this.releaseDash(bot);
    }
    if (now - esc.clearSince < Reflexes.LAVA_CLEAR_DWELL_MS) return;
    this.lavaEscape = null;
    if (!esc.handedOff) this.releaseDash(bot);
    const p = bot.entity.position;
    this.lavaBout.lastClearAt = now;
    const bout = this.lavaBout.count;
    this.opts.diag?.write({
      lane: 'reflex', event: 'lava-clear',
      // 第 2 次起仍该读成「又出来了一次」,不是「又成功了一次」
      msg: `脱离了 (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}),`
        + `火也灭了,生命 ${Math.ceil(bot.health ?? 0)}/20`
        + (bout > 1
          ? `;本轮第 ${bout} 次脱离(首次接触已过 ${fmtDur(now - this.lavaBout.firstAt)})`
          : ''),
      data: {
        position: p, onFire: false, health: bot.health, ms: now - esc.startedAt,
        dwellMs: Reflexes.LAVA_CLEAR_DWELL_MS,
        bout, boutMs: now - this.lavaBout.firstAt,
      },
    });
    // 灭火后仍在水中且没有其他环境身份时立即释放环境租约；其余路径按稳定落脚窗口处理。
    if (bodyInWater(bot)) this.releaseEnvironmentHoldNow(bot, '火灭了,人在水里(不等干燥落脚)');
    if (!esc.reported) return;
    this.opts.report({
      kind: 'reflex',
      hurt: true,
      text: `[反射] 从火里出来了,火也灭了。生命 ${Math.ceil(bot.health ?? 0)}/20。`,
    });
  }

  /** 两条环境伤害日志之间的最短间隔;掉血播报归 World,这里只记诊断 */
  private static readonly ENV_HURT_LOG_MS = 5_000;
  private lastEnvHurtAt = 0;

  /**
   * 环境伤害:岩浆、火、摔落、窒息……没有可打的对象。反射能做的是立刻重查一次
   * 挨烧(等下一个 tick 太晚)并把现场记下来。掉血这件事本身由 World 播报,不复述。
   */
  private onEnvironmentHurt(bot: Bot, now: number): void {
    if (this.opts.antiLava()) void this.antiLava(bot);
    // hurting=true:实心方块闷头那一路(圆石/石头)只在掉血时起手,口径在这条挂钩上
    void this.antiSuffocate(bot, true);
    if (now - this.lastEnvHurtAt < Reflexes.ENV_HURT_LOG_MS) return;
    this.lastEnvHurtAt = now;
    const touch = hazardTouch(bot);
    const hazard = touch.touching ?? nearestHazard(bot, Reflexes.ON_FIRE_HAZARD_R);
    this.opts.diag?.write({
      lane: 'reflex', event: 'env-hurt',
      msg: `在掉血但周围没有敌人(生命 ${Math.ceil(bot.health ?? 0)}/20)`
        + (hazard ? `,${zhName(hazard.name)}就在 ${hazard.distance.toFixed(1)} 格` : '')
        + (touch.onFire ? ',身上着着火' : ''),
      data: {
        health: bot.health, onFire: touch.onFire, touching: touch.touching,
        hazard, position: bot.entity.position,
      },
    });
  }

  private buried: { startedAt: number; block: string; digging: boolean; reported: boolean } | null = null;

  /**
   * 环境伤害入口启动窒息自救，启动后逐心跳复查头部方块。
   * 下落方块直接进入处理分支；其他方块须为不透明实心块且本次受伤或已有自救状态。
   * 身体所有权沿用环境身份优先级，队列冻结受 beginEnvironment 约束。
   * 下落方块优先寻找可用横向出口，找不到时挖头部格；其他窒息方块直接挖头部格。
   */
  private async antiSuffocate(bot: Bot, hurting = false): Promise<void> {
    const headPos = bot.entity.position.offset(0, 1, 0);
    const head = bot.blockAt(headPos);
    const faller = head !== null && isSuffocatingFaller(head.name);
    // transparent 排除铁砧/台阶这类非整方块:头在它们的格里不窒息,掉血多半是砸击
    // 伤害,挖它们脱不了困(玻璃也被这条排除 —— 宁可漏这种罕见形态,不误挖铁砧)
    const solid = head !== null && !faller && head.boundingBox === 'block'
      && head.transparent !== true
      && (hurting || this.buried !== null);
    if (head === null || (!faller && !solid)) {
      const was = this.buried;
      if (was === null) return;
      this.buried = null;
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
      this.opts.diag?.write({
        lane: 'reflex', event: 'buried-clear',
        msg: `从${zhName(was.block)}里挖出来了,生命 ${Math.ceil(bot.health ?? 0)}/20`,
        data: {
          block: was.block, position: bot.entity.position,
          health: bot.health, ms: Date.now() - was.startedAt,
        },
      });
      return;
    }
    const now = Date.now();
    if (this.buried === null) {
      this.beginEnvironment(faller ? '被埋住,往上挖' : '头卡在实心方块里,挖开脱身');
      // 把人送进沙砾层的多半就是正在飞的那条路;不撤掉它会一边挖一边被拽回去
      dropGoal(bot, 'escape', '被埋住,撤掉正在飞的那条路', this.opts.diag);
      this.buried = { startedAt: now, block: head.name, digging: false, reported: false };
      this.opts.diag?.write({
        lane: 'reflex', event: 'buried',
        msg: `头${faller ? '顶' : ''}是${zhName(head.name)},被${faller ? '埋' : '闷'}住了`
          + `(生命 ${Math.ceil(bot.health ?? 0)}/20),正在挖开脱身`,
        data: { block: head.name, solid, position: bot.entity.position, health: bot.health },
      });
    }
    const esc = this.buried;
    bot.setControlState('jump', true);
    if (!esc.reported) {
      esc.reported = true;
      this.opts.report({
        kind: 'reflex',
        hurt: true,
        text: `[反射] ${faller ? `被${zhName(head.name)}埋住了!正在挖开脱身` : `头卡在${zhName(head.name)}里,在掉血!正在挖开脱身`}。生命 ${Math.ceil(bot.health ?? 0)}/20。`,
      });
    }
    if (esc.digging) return;
    esc.digging = true;
    try {
      if (faller) {
        // 横向出口:头层四邻里第一个非下落方块的格。挖穿走出去,重力填不回来
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const side = bot.blockAt(headPos.offset(dx, 0, dz));
          if (side === null || isSuffocatingFaller(side.name)) continue;
          if (side.boundingBox === 'block' && side.diggable === false) continue;
          const aim = headPos.offset(dx, 0, dz);
          void bot.lookAt(new Vec3(Math.floor(aim.x) + 0.5, Math.floor(aim.y) + 0.5, Math.floor(aim.z) + 0.5), true)
            .catch(() => undefined);
          bot.setControlState('forward', true);
          if (side.boundingBox === 'block') {
            await bot.dig(side, true);
            return;
          }
          // 头层出口已通:脚层那格还实心就把它也挖穿,人才走得出去
          const feetSide = bot.blockAt(bot.entity.position.offset(dx, 0, dz));
          if (feetSide && feetSide.boundingBox === 'block' && feetSide.diggable !== false) {
            await bot.dig(feetSide, true);
          }
          return;
        }
        // 没有可用横向出口时，尝试挖开头部格。
        bot.setControlState('forward', false);
      }
      await bot.dig(head, true);
    } catch {
      // 挖这一下没成(方块已经塌走/够不着):下一拍重读头顶再来,不在这里分诊
    } finally {
      if (this.buried !== null) this.buried.digging = false;
    }
  }

  private fallBot: Bot | null = null;
  private fall: {
    fromY: number;
    logged: boolean;
    /** 已经为这一轮深坠叫停过任务(不论有没有拿到冻结租约),不再重复叫停 */
    handled: boolean;
    /** 队列真被冻住了才为 true:拿不到租约时没有冻结可言,落地也别报"冻结保持" */
    stopped: boolean;
    hold: QueueHoldToken | null;
    holdSince: number;
    safeSince: number | null;
    safeAt: { x: number; y: number; z: number } | null;
  } | null = null;

  /** 深坠落使原路径失效；反射不尝试空中动作，只停止任务与寻路。 */
  private watchFall(bot: Bot): void {
    if (this.fallBot !== bot) {
      this.fallBot = bot;
      this.fall = null;
    }
    const y = bot.entity.position.y;
    const falling = !bot.entity.onGround && (bot.entity.velocity?.y ?? 0) < 0 && !bodyInWater(bot);
    if (!falling) {
      if (this.fall?.stopped) {
        if (this.environmentOwnerKind !== null || !safeFallFooting(bot)) {
          this.fall.safeSince = null;
          this.fall.safeAt = null;
          return;
        }
        const now = Date.now();
        const p = bot.entity.position;
        const moved = this.fall.safeAt === null
          ? Infinity
          : Math.hypot(p.x - this.fall.safeAt.x, p.y - this.fall.safeAt.y, p.z - this.fall.safeAt.z);
        if (this.fall.safeSince === null || moved > FALL_SAFE_MOVE) {
          this.fall.safeSince = now;
          this.fall.safeAt = { x: p.x, y: p.y, z: p.z };
          return;
        }
        if (now - this.fall.safeSince < FALL_SAFE_FOOTING_MS) return;
        const resumed = this.fall.hold !== null && this.opts.resumeAfterFall(this.fall.hold);
        // 令牌对不上号有两种可能:执行器换了冻结租约,或者 mc_stop/抢占已经把冻结
        // 清掉了。反射这边分不出来,措辞就只说租约失效,不替队列断言还冻着。
        this.opts.diag?.write({
          lane: 'reflex', event: 'falling-safe',
          msg: `深坠落后已在 ${cellText(feetOf(bot))} 稳定落脚,`
            + (resumed ? '排队计划恢复' : '旧恢复租约已失效'),
          data: { position: bot.entity.position, health: bot.health, resumed },
        });
      }
      this.fall = null;
      return;
    }
    if (this.fall === null) {
      this.fall = {
        fromY: y, logged: false, handled: false, stopped: false,
        hold: null, holdSince: 0, safeSince: null, safeAt: null,
      };
      return;
    }
    this.fall.safeSince = null;
    this.fall.safeAt = null;
    if (y > this.fall.fromY) this.fall.fromY = y;
    const drop = this.fall.fromY - y;
    if (!this.fall.logged && drop >= FALL_DAMAGE_BLOCKS) {
      this.fall.logged = true;
      this.opts.diag?.write({
        lane: 'reflex', event: 'falling',
        msg: `正在自由落体,已掉 ${drop.toFixed(1)} 格(生命 ${Math.ceil(bot.health ?? 0)}/20)`,
        data: { fromY: this.fall.fromY, y, drop, health: bot.health, position: bot.entity.position },
      });
    }
    if (this.fall.handled || drop < FALL_TASK_STOP_BLOCKS) return;
    // 目标的数值 y 至少比当前位置低 FALL_TASK_STOP_BLOCKS 时，本轮深坠不撤销寻路。
    // 判据不区分目标类型；GoalFollow 等带数值 y 的目标也可豁免。
    const goal = bot.pathfinder?.goal as { y?: unknown } | undefined;
    if (goal && typeof goal.y === 'number' && goal.y <= y - FALL_TASK_STOP_BLOCKS) {
      this.fall.handled = true; // 这一轮落体不再评估:目的地没变,判据也不会变
      this.opts.diag?.write({
        lane: 'reflex', event: 'falling-en-route',
        msg: `深坠落已掉 ${drop.toFixed(1)} 格,但寻路目标就在下方(y=${goal.y}),原单继续`,
        data: {
          fromY: this.fall.fromY, y, drop, goalY: goal.y,
          health: bot.health, position: bot.entity.position,
        },
      });
      return;
    }
    this.fall.handled = true;
    const hold = this.opts.stopFallTask(`深坠落超过 ${FALL_TASK_STOP_BLOCKS} 格`);
    // 拿不到冻结租约(执行器不在)时队列根本没被冻:不进冻结态,免得落地那一拍
    // 报出"旧恢复租约已失效,当前冻结保持"这种与事实相反的话
    this.fall.hold = hold;
    this.fall.stopped = hold !== null;
    this.fall.holdSince = hold !== null ? Date.now() : 0;
    dropGoal(bot, 'fall', '深坠,原路径的前提已经不成立', this.opts.diag);
    this.opts.diag?.write({
      lane: 'reflex', event: 'falling-stop',
      msg: `深坠落已掉 ${drop.toFixed(1)} 格,原任务与路径已停止`
        + (hold === null ? '(没有可冻结的队列)' : ',排队计划冻结到安全落脚'),
      data: {
        fromY: this.fall.fromY, y, drop, threshold: FALL_TASK_STOP_BLOCKS,
        held: hold !== null, health: bot.health, position: bot.entity.position,
      },
    });
  }

  private drowning = false;
  private lastDrownReportAt = 0;
  private lastDrownEscapeAt = 0;
  private submergedAt = 0;
  /** 危机中头出水的起点;氧气读数不可信时靠它判「已经在换气」 */
  private surfacedAt = 0;
  private lastSubmergedDiagAt = 0;
  /** 死亡后的氧气读数可能停留在旧值；再次观察到 air_supply 变化前视为不可信。 */
  private oxygenTrusted = true;
  private oxygenSeen: number | null = null;
  /** 本轮溺水里零推进撤销过的目标格,登岸/换气点都不再选它;危机解除清空 */
  private readonly drownExcluded = new Set<string>();

  private async antiDrown(bot: Bot): Promise<void> {
    const now = Date.now();
    const headWet = headInWater(bot);
    const rawOxygen = bot.oxygenLevel ?? null;
    if (rawOxygen !== this.oxygenSeen) {
      this.oxygenSeen = rawOxygen;
      this.oxygenTrusted = true;
    }
    const oxygen = Math.max(0, Math.min(20, rawOxygen ?? 20));
    // 头部出水后按落脚或换气条件清除溺水状态；环境租约由剩余危机与落脚稳定性决定。
    if (!headWet) {
      if (!this.drowning) {
        this.submergedAt = 0;
        return;
      }
      if (this.surfacedAt === 0) this.surfacedAt = now;
      bot.setControlState('jump', false);
      const dry = hasDryFooting(bot);
      // 头部出水后，干燥落脚或可信氧气达到 15/20 即清除溺水状态；氧气不可信时要求连续出水三秒。
      // 仍在水中且无其他环境身份时立即释放环境租约；干燥落脚走稳定窗口，登岸交给正常寻路。
      const breathing = this.oxygenTrusted ? oxygen >= 15 : now - this.surfacedAt >= SURFACED_CLEAR_MS;
      if (dry || breathing) {
        const why = this.oxygenTrusted ? `氧气回满 ${oxygen}/20` : `已出水 ${Math.round((now - this.surfacedAt) / 1000)} 秒`;
        this.drowning = false;
        this.submergedAt = 0;
        this.surfacedAt = 0;
        this.drownExcluded.clear();
        this.opts.diag?.write({
          lane: 'reflex', event: 'drown-clear',
          msg: dry
            ? `离开水体并站稳了(氧气 ${oxygen}/20)`
            : `头出水且${why}(脚下还是水)`,
          data: { oxygen, oxygenTrusted: this.oxygenTrusted, dryFooting: dry, position: bot.entity.position },
        });
        // 站稳那条路由 resumeEnvironmentWhenSafe 按稳定窗口交还;水面上没有那个窗口
        if (!dry) this.releaseEnvironmentHoldNow(bot, `头出水且${why}`);
        return;
      }
      if (!this.opts.escapeActive?.()) {
        this.beginEnvironment('防溺水上浮找岸');
        this.routeDrownToLand(bot, now, oxygen);
      }
      return;
    }
    this.surfacedAt = 0;
    if (this.submergedAt === 0) this.submergedAt = now;
    const submergedMs = now - this.submergedAt;
    // 低频记录水下反射的等待原因：入水宽限、氧气充足或读数未刷新。
    if (now - this.lastSubmergedDiagAt >= SUBMERGED_DIAG_MS) {
      this.lastSubmergedDiagAt = now;
      this.opts.diag?.write({
        lane: 'reflex', event: 'drown-submerged',
        msg: `头在水下 ${(submergedMs / 1000).toFixed(1)}s,氧气读数 ${rawOxygen ?? '无'}${this.oxygenTrusted ? '' : '(复活后没刷新,不信)'}${this.drowning ? ',逃生中' : ''}`,
        data: {
          headWet, oxygenLevel: rawOxygen, oxygenTrusted: this.oxygenTrusted,
          submergedMs, drowning: this.drowning, position: bot.entity.position,
        },
      });
    }
    if (!this.drowning) {
      // 入水后的前 2 秒忽略氧气读数,等待实体元数据更新。
      if (submergedMs < 2_000) return;
      // 氧气读数是主判据;读数不可信或一直不跌时按水下时长兜底(20 口气原版 15 秒耗尽)
      const lowOxygen = this.oxygenTrusted && oxygen <= 6;
      if (!lowOxygen && submergedMs < SUBMERGED_TRIGGER_MS) return;
      const why = lowOxygen
        ? `快溺水了(氧气 ${oxygen}/20,已沉 ${Math.round(submergedMs / 1000)}s)`
        : `头在水下已 ${Math.round(submergedMs / 1000)} 秒${this.oxygenTrusted ? `,氧气读数 ${oxygen}/20` : ',氧气读数复活后没刷新'}`;
      this.opts.diag?.write({
        lane: 'reflex', event: 'drown-trigger',
        msg: `${why},开始上浮`,
        data: {
          oxygen, rawOxygen, oxygenTrusted: this.oxygenTrusted, byTimer: !lowOxygen,
          position: bot.entity.position, submergedMs,
        },
      });
      this.drowning = true;
      this.drownExcluded.clear();
      if (now - this.lastDrownReportAt > 20_000) {
        this.lastDrownReportAt = now;
        this.opts.report({ kind: 'reflex', hurt: true, text: `[反射] ${why},正在上浮找岸。` });
      }
    }
    // 持续上浮,并每 8s 尝试给寻路器一个换气点或登岸点
    bot.setControlState('jump', true);
    // surface 任务持有寻路目标时，反射只保留上浮按键，避免双方覆盖目标。
    if (this.opts.escapeActive?.()) return;
    this.beginEnvironment('防溺水上浮找岸');
    this.routeDrownToLand(bot, now, oxygen);
  }

  /**
   * 两级目标:自己这一列头顶被实心盖住时先游到头顶是空气的水面格换气,再找登岸点;
   * 两级都排除本轮零推进过的格,登岸点还要求头高那一层到它之间没有实心阻隔。
   */
  private routeDrownToLand(bot: Bot, now: number, oxygen: number): void {
    if (now - this.lastDrownEscapeAt <= 8_000) return;
    this.lastDrownEscapeAt = now;
    const up = landSearchUp(bot);
    const excluded = (c: Cell): boolean => this.drownExcluded.has(cellKeyOf(c));
    const breath = findBreathingCell(bot, BREATH_SEARCH_R, up, excluded);
    if (breath) {
      this.opts.diag?.write({
        lane: 'reflex', event: 'drown-breath',
        msg: `头顶被盖住,先游到 (${breath.x}, ${breath.y}, ${breath.z}) 的水面换气`,
        data: { breath, position: bot.entity.position, oxygen, excluded: [...this.drownExcluded] },
      });
      this.setEscapeGoal(bot, 'drown', new goals.GoalBlock(breath.x, breath.y, breath.z), breath);
      return;
    }
    const land = findNearbyAirColumn(bot, 12, up, excluded);
    // 诊断区分朝岸移动与原地上浮,以检测横向位置没有进展的逃生循环。
    this.opts.diag?.write({
      lane: 'reflex', event: land ? 'drown-swim' : 'drown-noland',
      msg: land
        ? `往 (${land.x}, ${land.y}, ${land.z}) 的登岸点游`
        : '附近找不到能上去的岸,只能继续上浮换气',
      data: { land, position: bot.entity.position, oxygen, excluded: [...this.drownExcluded] },
    });
    if (land) {
      this.setEscapeGoal(bot, 'drown', new goals.GoalBlock(land.x, land.y, land.z), land);
    }
  }

  private async onHurt(
    bot: Bot,
    source?: HurtSource,
  ): Promise<void> {
    const now = Date.now();
    // 1.20+ damage_event 自带实际攻击源，有就用它，最准。
    const attacker = source && source.id !== bot.entity?.id
      ? source
      // animation/entity_status 产生的 entityHurt 可能不带 source。
      // 缺少来源时，以六格内最近的非玩家敌对生物作为反击候选。
      : nearestHostileWithin(bot, REFLEX_HURT_FALLBACK_RANGE);
    if (!attacker) { this.onEnvironmentHurt(bot, now); return; }
    const distance = attacker.position.distanceTo(bot.entity.position);
    // 战斗会话在场就归它:反击、血线撤退、退出闸门都是它的(反射这套 10 秒挥两下
    // 保留为 combat.enabled 关掉时的降级行为)
    if (this.opts.combatHurt?.(attacker.id, attacker.name ?? '')) return;
    // 撤退阈值独立于反击开关;关闭反击只禁止攻击,不禁止逃逸。
    const bleedingOut = (bot.health ?? 20) < this.opts.fleeHealth();
    if (!this.opts.fightBack() && !bleedingOut) return;
    if (this.opts.escapeActive?.()) return; // 已有逃逸路径时不叠加反击或直线逃逸。
    if (this.busyFighting || now - this.lastHurtReactAt < this.opts.reactCooldownSec() * 1000) return;
    this.lastHurtReactAt = now;
    this.busyFighting = true;
    this.opts.diag?.write({
      lane: 'reflex', event: 'hurt',
      msg: `被${zhEntity(attacker.name ?? '?')}打到,生命 ${Math.ceil(bot.health ?? 0)}/20`,
      data: { attacker: attacker.name, distance: Number(distance.toFixed(1)), health: bot.health, bleedingOut },
    });
    try {
      if ((bot.health ?? 20) < this.opts.fleeHealth()) {
        // 血少:脱离
        this.opts.preempt('血量过低,脱离战斗');
        const away = bot.entity.position.minus(attacker.position).normalize().scaled(16);
        const dest = bot.entity.position.plus(away);
        this.setEscapeGoal(bot, 'flee', levelTravelGoal(dest.x, dest.z));
        this.opts.report({
          kind: 'reflex',
          hurt: true,
          text: `[反射] 被 ${attacker.name} 打到只剩 ${Math.ceil(bot.health)}/20 血,正在脱离战斗!`,
          });
      } else {
        const weapon = bestWeapon(bot);
        if (weapon) await bot.equip(weapon, 'hand').catch(() => undefined);
        const deadline = Date.now() + 10_000;
        let swings = 0;
        let lastSwing = 0;
        let strafeLeft = false;
        let strafeAt = 0;
        try {
          while (attacker.isValid && Date.now() < deadline && !this.stopped) {
            if ((bot.health ?? 0) <= 0) break; // 人都死了,别再对着空气挥
            const d = attacker.position.distanceTo(bot.entity.position);
            if (d > 3.5) break; // 它跑了/被打退,不追:追击是主脑的决策,不归反射
            if (Date.now() >= strafeAt) {
              strafeLeft = !strafeLeft;
              strafeAt = Date.now() + STRAFE_MS;
            }
            await aimAt(bot, attacker);
            pressMelee(bot, attacker, strafeLeft);
            if (d <= MELEE_REACH && Date.now() - lastSwing >= attackCooldownMs(bot)) {
              await meleeSwing(bot, attacker);
              swings++;
              lastSwing = Date.now();
            } else {
              await new Promise((r) => setTimeout(r, 50));
            }
          }
        } finally {
          releaseMelee(bot);
        }
        this.opts.report({
          kind: 'reflex',
          hurt: true,
          text: `[反射] 被 ${attacker.name} 攻击,反击了 ${swings} 下${attacker.isValid ? ',它还活着' : ',击杀了它'}。生命 ${Math.ceil(bot.health)}/20。`,
          });
      }
    } finally {
      this.busyFighting = false;
    }
  }
}

/** 找岸往上看几格的硬上限:再高的水柱不是「快淹死了」,是掉进了海沟 */
const LAND_SEARCH_UP_CAP = 24;

/** 登岸搜索的垂直范围按当前位置上方水柱高度确定，限制在 3–24 格。 */
function landSearchUp(bot: Bot): number {
  const base = bot.entity.position.floored();
  for (let dy = 0; dy <= LAND_SEARCH_UP_CAP; dy += 1) {
    const b = bot.blockAt(base.offset(0, dy, 0));
    if (!b || !LIQUIDS.has(b.name)) return Math.max(3, dy);
  }
  return LAND_SEARCH_UP_CAP;
}

/** 换气点的水平搜索半径:氧气 6→0 只有 6 秒,游得到的距离就这么远 */
const BREATH_SEARCH_R = 6;
/** 水下计时兜底:头在水下连续这么久就按溺水处理,不看氧气读数 */
const SUBMERGED_TRIGGER_MS = 10_000;
/** 氧气读数不可信时,头出水连续这么久算已换到气 */
const SURFACED_CLEAR_MS = 3_000;
const SUBMERGED_DIAG_MS = 2_000;

/** 从自己这一列到目标列的水平直线上,y 这一层有没有实心方块;每半格采样,起止列的格由调用方验 */
function rowClear(bot: Bot, from: Cell, toX: number, toZ: number, y: number): boolean {
  const dx = toX - from.x;
  const dz = toZ - from.z;
  const steps = Math.ceil(Math.hypot(dx, dz) * 2);
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    if (solidAt(bot, { x: Math.floor(from.x + 0.5 + dx * t), y, z: Math.floor(from.z + 0.5 + dz * t) })) return false;
  }
  return true;
}

/**
 * 登岸路线先沿当前列上浮到目标头高，再水平直行。
 * 上浮段检查头部经过的各格，水平段检查脚、头两层的实心阻隔。
 */
function reachableFromWater(bot: Bot, me: Cell, to: Cell): boolean {
  const headY = to.y + 1;
  for (let y = Math.min(me.y + 1, headY); y <= Math.max(me.y + 1, headY); y += 1) {
    if (solidAt(bot, { x: me.x, y, z: me.z })) return false;
  }
  return rowClear(bot, me, to.x, to.z, headY) && rowClear(bot, me, to.x, to.z, to.y);
}

/**
 * 同一水体里头顶是空气的水面格,按环由近及远;返回的是脚该到的那一格(头在它上方的空气里)。
 * 自己这一列头顶就通(按住跳就能换气)时返回 null。「同一水体」按头高那一层的直线全是水判。
 */
function findBreathingCell(
  bot: Bot, maxR: number, maxUp: number, excluded: (c: Cell) => boolean,
): Cell | null {
  const base = bot.entity.position.floored();
  const me: Cell = { x: base.x, y: base.y, z: base.z };
  /** 该列从头高往上第一格非水的 y;水一直到 maxUp 之外返回 null */
  const surfaceOf = (dx: number, dz: number): number | null => {
    for (let dy = 1; dy <= maxUp + 1; dy += 1) {
      const b = bot.blockAt(base.offset(dx, dy, dz));
      if (!b || !WATER_BLOCKS.has(b.name)) return dy === 1 ? null : base.y + dy;
    }
    return null;
  };
  const open = (y: number, dx: number, dz: number): boolean => {
    const b = bot.blockAt(base.offset(dx, y - base.y, dz));
    return b !== null && b.name === 'air';
  };
  const own = surfaceOf(0, 0);
  if (own !== null && open(own, 0, 0)) return null;
  for (let r = 1; r <= maxR; r += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dz = -r; dz <= r; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const y = surfaceOf(dx, dz);
        if (y === null || !open(y, dx, dz)) continue;
        const feet: Cell = { x: base.x + dx, y: y - 1, z: base.z + dz };
        if (excluded(feet)) continue;
        // 头高那一层直线全是水:隔着岸壁的另一片水过不了这一关
        if (!rowClear(bot, me, feet.x, feet.z, me.y + 1)) continue;
        return feet;
      }
    }
  }
  return null;
}

/**
 * 寻找最近的可站立登岸点；脚下有支撑、脚头不在水中且路线无实心阻隔。
 * maxUp 由实测水柱确定，搜索从半径一格逐圈扩展；找不到返回 null。
 */
function findNearbyAirColumn(
  bot: Bot, maxR = 12, maxUp = 3, excluded: (c: Cell) => boolean = () => false,
): { x: number; y: number; z: number } | null {
  const base = bot.entity.position.floored();
  const me: Cell = { x: base.x, y: base.y, z: base.z };
  for (let r = 1; r <= maxR; r += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dz = -r; dz <= r; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (let dy = maxUp; dy >= -1; dy--) {
          const feet = base.offset(dx, dy, dz);
          const below = bot.blockAt(feet.offset(0, -1, 0));
          const at = bot.blockAt(feet);
          const head = bot.blockAt(feet.offset(0, 1, 0));
          if (!below || !at || !head) continue;
          if (below.boundingBox !== 'block' || at.name !== 'air' || head.name !== 'air') continue;
          const cell: Cell = { x: feet.x, y: feet.y, z: feet.z };
          if (excluded(cell) || !reachableFromWater(bot, me, cell)) continue;
          return cell;
        }
      }
    }
  }
  return null;
}
