/**
 * 异步执行器:任务队列 + 逐步派发 + 自保反射。
 *
 * mc_do 的契约在这里落地:排队立即返回,技能后台跑,完成/受阻/被抢占一律经
 * report 回调交给 World 转成 minecraft.task 事件。一件做完接着做下一件;
 * 反射不经 LLM,做了什么事后汇报。技能一律经 `getBot()` 现取 bot(重连后实例会换)。
 *
 * 技能的契约面(SkillCall/parseSteps/SKILL_DOC/schema)住在 skills.ts 的注册表里,
 * 实现分在 skills-*.ts 各族,`runSkill` 是唯一派发口。公共面经本文件转口,
 * 调用方不必分辨两处。
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
import { CONTAINER_FIND, FURNACE_KINDS } from './chests.ts';
import { skillExcavate, skillTunnel } from './skills-dig.ts';
import { reachCell } from './travel.ts';
import {
  ANVIL_BLOCKS, STATION_FIND_R, WINDOW_SETTLE_MS, containerStacks, findContainers, findStationCell,
  furnaceDoneAt, knownChestNote, noContainerNearby, openNearbyContainer, openStationWindow,
  openWindowGuarded, orderForStow, orderForTake, putIntoStation, rememberChest, rememberWindow,
  slotStack, smeltPerItemMs, stationItemFacts, type GenericWindow,
} from './containers.ts';
import {
  consumeHeldFood, craftItemDef, craftNeeds, equipNamed, skillCraft, skillEat, skillEquip,
  type CraftRecipeLike,
} from './skills-craft.ts';
import { isKnownTarget, unknownUseTargetText } from './entity-facts.ts';
import { skillAttack } from './melee.ts';
import {
  LEAD_ITEM, isBoat, skillAnvil, skillGrindstone, skillLead, skillRide, skillUse,
} from './skills-interact.ts';
import {
  LAPIS, skillBrew, skillEnchant, skillPickup, skillSmelt, skillStow, skillTake, skillToss,
  skillTransit,
} from './skills-container.ts';
import {
  hasDryFooting, skillBuild, skillBuildBlueprint, skillSurfaceLand, stableDryFooting,
  surfaceStateText, withBlueprintGain,
} from './skills-build.ts';
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
