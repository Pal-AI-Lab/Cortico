/**
 * 找东西与拿东西:collect、find、fish、trade、probe。
 *
 * 共同点是先看见再动手,看不见的一律照实报,不靠穿墙情报凑答案。
 */
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import {
  CROP_MAX_AGE, DIRECTIONS, DIRECTION_ZH, bearing, biomeAt, canSeeBlockAt, canSeeEntity, cropAgeAt,
  isNight, type Direction, villagerNote,
} from './terrain.ts';
import { Aborted, SkillBlocked, checkAbort, sleep, type SkillContext } from './skill-context.ts';
import {
  digBlock, dropGoal, gotoGoal, levelTravelGoal, matchBlockIds, routeNote, withRouteScene,
} from './travel.ts';
import {
  INVENTORY_SLOTS, PICKUP_SETTLE_MS, dropNamesOf, invCount, invGains, invSnapshot,
} from './inventory.ts';
import { Upkeep, pushPocketLine, standableCell } from './placement.ts';
import { zhEntity, zhName } from './names.ts';
import { equipToolFor, harvestFact, miningToolPlan } from './tools.ts';
import { bestWeapon } from './melee.ts';
import { type FindKind } from './search-observation.ts';
import { type Cell } from './geometry.ts';
import {
  AIR_NAMES, LIQUIDS, PROBE_CELLWISE_MAX, PROBE_CELL_CAP, PROBE_WHERE_CELL_CAP, SHAPE_ZH,
  blockAtCell, blockNamesOf, blockProp, cellText, cropAgeOfCell, dimensionOf, feetOf, fnv32,
  readRegion, resolveAt, shapeCells, skyBlocked,
} from './cell-facts.ts';
import {
  FIND_STATIC_MAX, PROBE_WHERE_SHOWN, UNTIL_CATEGORIES, UNTIL_CATEGORY_DOC, type SkillCall,
} from './skills.ts';
import { compositionText, zhErrorText, zhThing } from './receipt.ts';
import { UNTIL_TRAVEL_RADIUS, type UntilHit, untilBlockIds, untilHit, untilUnknownNote } from './until.ts';
import { PLAYER_SLOTS } from './precheck.ts';
import pathfinderPkg from 'mineflayer-pathfinder';

const { goals } = pathfinderPkg;

/**
 * 目标其实是掉落物的常见错位:世界里几乎不会自然生成这些方块,agent 点名采集时
 * 找不着/够不着,真相是"去挖来源方块"。受阻回执把这条机械事实带上(不替它决策)。
 */
export const DROP_SOURCE_HINT: Record<string, string> = {
  cobblestone: '圆石不是自然生成的方块,是用镐挖石头掉出来的',
  cobbled_deepslate: '深板岩圆石不是自然生成的方块,是用镐挖深板岩掉出来的',
};

/**
 * collect 在 findBlocks 结果上执行视线检查；区块索引查询本身不检查遮挡。
 * 4.5 格内、非 air 的空碰撞形状方块可直接视为可见，避免射线穿过草花命中后方地面。
 */
export function collectVisible(bot: Bot, p: { x: number; y: number; z: number }): boolean {
  if (canSeeBlockAt(bot, p)) return true;
  const b = bot.blockAt(p as never);
  if (!b || b.boundingBox !== 'empty' || b.name === 'air') return false;
  const me = bot.entity.position;
  return Math.hypot(me.x - (p.x + 0.5), me.y - (p.y + 0.5), me.z - (p.z + 0.5)) <= 4.5;
}

export async function skillCollect(
  bot: Bot,
  block: string,
  count: number,
  ctx: SkillContext,
  buried = false,
  mature = false,
  tool?: string,
): Promise<string> {
  const ids = matchBlockIds(bot, block);
  if (ids.length === 0) throw new SkillBlocked(categoryScopeText(block) ?? `不认识「${block}」这种方块`);
  const sourceHint = DROP_SOURCE_HINT[block];
  const isTarget = (n: string) => ids.some((id) => (bot.registry.blocks as Record<number, { name: string }>)[id]?.name === n);
  const gains = dropNamesOf(bot, ids);
  const countGains = (): number => invCount(bot, (n) => gains.has(n));
  const before = countGains();
  let dug = 0;
  let ranOut = false;
  /** mature 提前收手时还剩几格没长成的:收工回执照实带上 */
  let ranOutImmature = 0;
  // 挖掘等级:选定目标那一刻(还没起步)就读得出的一句事实,进这一步的每一份回执。
  // undefined = 还没读过,null = 读过且够级。
  let toolFact: string | null | undefined;
  // buried 通道的打洞记账:同一处挖到跟前还看不见就别再打,不无限打洞
  let tunnels = 0;
  let lastTunnelKey: string | null = null;
  // 采集途中的补光:lightWhen:"anywhere" 才做,默认这条不响
  const keep = new Upkeep(bot, ctx);
  const litTail = (): string => {
    const t = keep.tally();
    return t.length > 0 ? `;${t.join(';')}` : '';
  };
  for (let i = 0; i < count; i++) {
    checkAbort(ctx);
    // 只挖看得见的。扫到多少与看得见多少分开记:前者不进回执(那是穿墙情报),
    // 后者才是她的感知面。
    const scanned = bot.findBlocks({ matching: ids, maxDistance: 48, count: mature ? 64 : 16 });
    const found = scanned.filter((q) => collectVisible(bot, q));
    let pos: (typeof found)[number] | undefined = found[0];
    // 只收成熟项时按 age 达上限筛选，未成熟格保留。
    let immature = 0;
    let bestAge: { value: number; max: number } | null = null;
    let noAge = 0;
    if (mature) {
      pos = undefined;
      for (const p of found) {
        const age = cropAgeAt(bot, p);
        if (age === null) { noAge++; continue; }
        if (age.value >= age.max) { pos = p; break; }
        immature++;
        if (!bestAge || age.value > bestAge.value) bestAge = age;
      }
    }
    if (!pos) {
      if (dug === 0) {
        if (immature > 0) {
          throw new SkillBlocked(
            `48 格内的${zhName(block)}都还没长成(看得见 ${immature} 格,最高 age ${bestAge!.value}/${bestAge!.max}),没动它们`,
          );
        }
        if (mature && noAge > 0) {
          throw new SkillBlocked(`${zhName(block)}没有 age 状态,"只收熟的"用不上;去掉 mature 就照常挖`);
        }
        const scene: string[] = [];
        if (lastTunnelKey) scene.push(`已经挖到 (${lastTunnelKey}) 跟前,那儿也没有`);
        // 「扫得到但一处都看不见」与「压根没有」是两件事,措辞分开;但都不报
        // 看不见那些的坐标与处数——那正是要收掉的穿墙情报。
        throw new SkillBlocked(
          `附近看不见${mature ? '熟着的' : ''}${zhName(block)}` +
          `${sourceHint ? `。${sourceHint}` : ''}。${findEmptyHint(bot, ctx, block, false)}`,
          scene,
        );
      }
      if (immature > 0) ranOutImmature = immature;
      ranOut = true;
      break;
    }
    if (toolFact === undefined) {
      // 出发前选工具并读取挖掘等级，提前提供掉落条件。
      const first = bot.blockAt(pos);
      if (first) {
        await equipToolFor(bot, first, ctx, miningToolPlan(tool));
        toolFact = harvestFact(bot, first);
      }
    }
    try {
      // GoalLookAtBlock 的射线无法命中空碰撞形状；这类目标按距离走近，
      // 由 digBlock 的 canDigBlock 按服务端 5.1 格可及判据决定能否挖掘。
      const goal = bot.blockAt(pos)?.boundingBox === 'empty'
        ? new goals.GoalNear(pos.x, pos.y, pos.z, 2)
        : new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 });
      await gotoGoal(bot, goal, ctx);
    } catch (err) {
      if (err instanceof Aborted) throw err;
      // "buried":true = 她读过受阻现场之后的显式决定:看得见但走不过去,就挖条路过去。
      // 它管的是"够不够得着",不是"看不看得见"——目标早在上面过了视线闸。
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (buried && tunnels < 4 && lastTunnelKey !== key) {
        lastTunnelKey = key;
        tunnels++;
        routeNote(bot, ctx, pos);
        await gotoGoal(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 1), ctx).catch(() => undefined);
        dropGoal(bot, 'task', '挪到位,接着挖', ctx.diag);
        i--;
        continue;
      }
      if (dug === 0 && sourceHint && err instanceof SkillBlocked) {
        throw withRouteScene(bot, ctx, new SkillBlocked(`${err.message}。${sourceHint}`, err.scene), pos, [
          `看得见的${zhName(block)}在 (${pos.x}, ${pos.y}, ${pos.z})`,
        ]);
      }
      // 树冠这类"看得见够不着":带上目标坐标高差与三种走法的试算,她自己决定垫不垫
      throw withRouteScene(bot, ctx, err, pos, [
        `看得见的${zhName(block)}在 (${pos.x}, ${pos.y}, ${pos.z})`,
      ]);
    }
    // 挖掘前撤掉寻路目标，避免 LookAt 随方块变化重算并调用 stopDigging。
    dropGoal(bot, 'task', '挖掘期间寻路器歇手', ctx.diag);
    const target = bot.blockAt(pos);
    if (!target || !isTarget(target.name)) continue; // 移动期间目标方块可能被移除或掉落。
    checkAbort(ctx);
    await equipToolFor(bot, target, ctx, miningToolPlan(tool));
    await digBlock(bot, target, ctx);
    dug++;
    ctx.progress?.(dug, count);
    // 原版掉落物生成后 10 tick 才可拾取；等待实际入包，并设上限以容纳概率无掉落。
    await gotoGoal(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 1), ctx).catch(() => undefined);
    const mark = countGains();
    for (let waited = 0; waited < PICKUP_SETTLE_MS && countGains() === mark; waited += 100) {
      checkAbort(ctx);
      await sleep(100);
    }
    await keep.light(undefined, 'travel');
  }
  // 挖掘等级不够时它是"入包 0 个"唯一说得出口的解释,凡是回执都带上
  const toolTail = toolFact ? `。${toolFact}` : '';
  const gained = countGains() - before;
  if (gained <= 0) {
    // 挖掉方块与物品入包分别报告；collect 入包为零时不能算完成。
    if (dug <= 0) {
      throw new SkillBlocked(`一块${zhName(block)}都没挖到,入包 0 个`, toolFact ? [toolFact] : [], 'server');
    }
    // 概率掉落方块(drops 简表为空):挖成了没掉东西是正常结局,这一条不动
    const blocksReg = bot.registry.blocks as unknown as Record<number, { drops?: unknown[] }>;
    const certain = ids.some((id) => (blocksReg[id]?.drops ?? []).length > 0);
    if (!certain) {
      return `挖了 ${dug} 块${zhName(block)};这东西只按概率掉物品,这次一个都没掉${toolTail}${litTail()}`;
    }
    // 入包为零时检查是否包满，明确受阻来源。
    const full = bot.inventory.items().length >= INVENTORY_SLOTS;
    throw new SkillBlocked(
      full
        ? `挖掉了 ${dug} 块${zhName(block)}${dug < count ? `(要 ${count} 块)` : ''},` +
          `但背包 ${INVENTORY_SLOTS} 格全满了,掉的东西进不来,都落在挖矿的地方了${toolTail}`
        : `挖掉了 ${dug} 块${zhName(block)}${dug < count ? `(要 ${count} 块)` : ''},` +
          `方块已经不在了,但一个都没进包:掉落物没捡到${toolTail}`,
      toolFact ? [toolFact] : [], 'server',
    );
  }
  // 部分完成必须显式报告,防止后续步骤误判所需库存已经到齐。
  if (dug < count) {
    const why = ranOutImmature > 0
      ? `熟着的就这些,还有 ${ranOutImmature} 格没长成的留在地里`
      : ranOut ? '近处再没有看得见的了' : '有几块走到跟前就不在了';
    const spent = ranOut && ranOutImmature === 0 ? exhaustedMarkNote(bot, ctx, block) : '';
    ctx.partial?.(`要 ${count} 块只挖到 ${dug} 块`);
    return `挖了 ${dug} 块${zhName(block)}(要 ${count} 块),入包 ${gained} 个;${why}${spent}${toolTail}${litTail()}`;
  }
  return `挖了 ${dug} 块${zhName(block)},实际入包 ${gained} 个${toolTail}${litTail()}`;
}

/** 「这里有你登记的路标」按这个半径算:一处资源点的量级,不是一片地区 */
export const EXHAUSTED_MARK_RADIUS = 32;

/** 采空时并列报告附近已登记的路标，不自动修改路标 note。 */
export function exhaustedMarkNote(bot: Bot, ctx: SkillContext, block: string): string {
  const here = ctx.marks?.()?.around(bot.entity.position, EXHAUSTED_MARK_RADIUS) ?? [];
  if (here.length === 0) return '';
  const names = here.map((m) => `「${m.name}」(记于 ${ctx.clock?.(m.at) ?? '不知道什么时候'})`).join('、');
  return `;这一片的${zhName(block)}挖完了,这里有你登记的路标${names}`;
}

/** find 边走边找的扫描步长,小于感知半径,避免跨越目标。 */
export const EXPLORE_LEG = 24;

/** 站着扫一单最多报几处 */
export const FIND_HITS_MAX = 8;

/** 一般生成在建筑物里的方块:找不到时该说的是「进屋/隔窗才看得见」 */
export const INDOOR_TARGETS = new Set([
  'chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker',
  'crafting_table', 'bookshelf', 'brewing_stand', 'lectern', 'smithing_table',
]);

/** 找不到可见目标时，按目标类别和当前现场提供探索提示。 */
export function findEmptyHint(bot: Bot, ctx: SkillContext, target: string, isEntity: boolean): string {
  if (!isEntity && INDOOR_TARGETS.has(target)) {
    return `${zhName(target)}这类多半在屋里,隔着墙看不见——走到门口或者窗户跟前才照得见`;
  }
  if (!isEntity && /(_ore|ancient_debris)$/.test(target)) {
    return `埋在石头里的${zhName(target)}看不见,得先挖开:tunnel 挖一条过去、或者顺着洞穴走,` +
      '暴露在洞壁上的才找得到';
  }
  const risks = travelRisks(bot, ctx);
  if (risks.length === 0) {
    return isEntity
      ? '活物会跑,换个方向走一段再找,或者等它们自己晃过来'
      : '给个 direction 走一段再找,站着只看得到眼前这一圈';
  }
  return `${isEntity ? '这会儿附近没有' : '原地看不见'};要走过去找就加 direction ——` +
    `但${risks.join('、')},这一趟要想清楚`;
}

/**
 * 出这一趟门当下的三个读数:天光、手上有没有趁手的家伙、有没有重生点。
 * 只报读数,一条都不构成拦阻(「出发前试算只拦事实,不拦权衡」)。
 */
export function travelRisks(bot: Bot, ctx: SkillContext): string[] {
  const out: string[] = [];
  if (isNight(bot.time?.timeOfDay ?? 0)) out.push('现在是夜里');
  if (!bestWeapon(bot)) out.push('你空着手(包里没有趁手的家伙)');
  if (!(ctx.spawnAnchor?.() ?? null)) out.push('你现在没有重生点');
  return out;
}

/** find 的一次扫描命中:在哪、叫什么、是不是活物 */
export interface ExploreHit { x: number; y: number; z: number; what: string; entity: boolean }

export function findKind(hit: ExploreHit | null, entityName: string | null): FindKind {
  return hit?.entity || entityName !== null ? 'entity' : 'block';
}

/** 方块周围最近的可站落点，包含方块上方；没有则返回 null，方块占用格本身不可站。 */
export function approachCell(bot: Bot, c: Cell): Cell | null {
  const me = bot.entity.position;
  return [
    { x: c.x, y: c.y + 1, z: c.z },
    { x: c.x + 1, y: c.y, z: c.z }, { x: c.x - 1, y: c.y, z: c.z },
    { x: c.x, y: c.y, z: c.z + 1 }, { x: c.x, y: c.y, z: c.z - 1 },
  ]
    .filter((s) => standableCell(bot, s))
    .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y, a.z - me.z)
      - Math.hypot(b.x - me.x, b.y - me.y, b.z - me.z))[0] ?? null;
}

export function findHitText(bot: Bot, hit: ExploreHit): string {
  const point = `(${hit.x}, ${hit.y}, ${hit.z})`;
  if (hit.entity) return `seenAt=${point}(它会动,这是看见那一刻的位置)`;
  const stand = approachCell(bot, hit);
  return `blockAt=${point}(目标方块占用格,不是可站落点` +
    `${stand ? `;贴着它站得住的是 ${cellText(stand)},goto 走这一格` : ''})`;
}

export function findAgeText(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
}

export function findHistoryNote(ctx: SkillContext, target: string, kind: FindKind): string {
  const hit = ctx.search.history.recall(ctx.search.scope(), target, kind);
  if (!hit) return '';
  const point = `(${hit.at[0]}, ${hit.at[1]}, ${hit.at[2]})`;
  const where = hit.kind === 'entity'
    ? `seenAt=${point};活物此后可能已经移动`
    : `blockAt=${point};这是目标方块占用格,不是可站落点`;
  return `;真实历史观察:${findAgeText(hit.ageMs)}曾看见${hit.what},${where},现在没有复见,只能当过期线索`;
}

export function rememberFindHit(ctx: SkillContext, target: string, hit: ExploreHit): void {
  ctx.search.history.remember(ctx.search.scope(), {
    target,
    kind: findKind(hit, null),
    what: hit.what,
    at: [hit.x, hit.y, hit.z],
  });
}

/** target 是不是实体类型 id(sheep、cow、zombie);玩家不算,找玩家有 goto_player */
export function matchEntityName(bot: Bot, name: string): string | null {
  const n = name.toLowerCase();
  const entities = (bot.registry as unknown as { entitiesByName?: Record<string, unknown> }).entitiesByName;
  return entities?.[n] ? n : null;
}

/**
 * `#logs` 这种写法只在 `until` 名单里认。原文案「不认识「#logs」这种方块或实体」
 * 让她把一个还能用的能力从工具箱里划掉了(笔记原文:「#ores 标签执行器不认」)。
 * 不认识别的词时返回 null,由调用方说自己那句。
 */
export function categoryScopeText(target: string): string | null {
  if (!target.startsWith('#')) return null;
  const key = target.slice(1);
  const known = UNTIL_CATEGORIES[key] !== undefined;
  const example = key === 'logs' ? 'oak_log' : key === 'ores' ? 'iron_ore' : null;
  return `「${target}」是 until 名单的写法${known ? '' : `(名单只有 ${UNTIL_CATEGORY_DOC})`};`
    + `target 这里写裸名 ${key.replace(/s$/, '')}${example ? ` 或具体 id ${example}` : ''}`;
}

/** 朝指定方向循环移动并扫描;调用方决定目标与方向。方块与实体走同一条感知规则。 */
export async function skillFind(
  bot: Bot,
  target: string,
  direction: Direction | undefined,
  distance: number,
  ctx: SkillContext,
  /** 行军途中的早停名单:路上碰到这里头任何一样就正常收束(站着扫用不上) */
  until?: readonly string[],
): Promise<string> {
  const ids = matchBlockIds(bot, target);
  const entityName = ids.length === 0 ? matchEntityName(bot, target) : null;
  if (ids.length === 0 && entityName === null) {
    throw new SkillBlocked(categoryScopeText(target) ?? `不认识「${target}」这种方块或实体`);
  }
  ctx.search.history.sync(ctx.search.scope());
  const start = { x: bot.entity.position.x, z: bot.entity.position.z };
  const finish = (text: string, hit: ExploreHit | null): string => {
    if (hit) rememberFindHit(ctx, target, hit);
    return text;
  };

  const scan = (): ExploreHit | null => {
    // 与 collect/世界快照同一条感知规则:看得见才算找到
    if (entityName) {
      let best: ExploreHit | null = null;
      let bestD = 48;
      for (const key of Object.keys(bot.entities)) {
        const e = bot.entities[key];
        if (!e?.position || e === bot.entity) continue;
        if ((e.name ?? '').toLowerCase() !== entityName) continue;
        const d = e.position.distanceTo(bot.entity.position);
        if (d < bestD && canSeeEntity(bot, e)) {
          bestD = d;
          const note = villagerNote(e as never);
          best = {
            x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z),
            what: `${zhEntity(entityName)}${note ? `(${note})` : ''}`, entity: true,
          };
        }
      }
      return best;
    }
    const found = bot.findBlocks({ matching: ids, maxDistance: 48, count: 16 });
    const p = found.find((q) => canSeeBlockAt(bot, q));
    // 回执使用扫描到的实际方块名:target 可能来自不可靠的视觉识别
    return p ? { x: p.x, y: p.y, z: p.z, what: zhName(bot.blockAt(p)?.name ?? target), entity: false } : null;
  };

  /** 站着扫用:这一刻看得见的全部,按距离排。 */
  const scanAll = (radius: number): ExploreHit[] => {
    const me = bot.entity.position;
    const out: ExploreHit[] = [];
    if (entityName) {
      for (const key of Object.keys(bot.entities)) {
        const e = bot.entities[key];
        if (!e?.position || e === bot.entity) continue;
        if ((e.name ?? '').toLowerCase() !== entityName) continue;
        if (e.position.distanceTo(bot.entity.position) > radius) continue;
        if (!canSeeEntity(bot, e)) continue;
        const note = villagerNote(e as never);
        out.push({
          x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z),
          what: `${zhEntity(entityName)}${note ? `(${note})` : ''}`, entity: true,
        });
      }
    } else {
      for (const q of bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 })) {
        if (!canSeeBlockAt(bot, q)) continue;
        out.push({ x: q.x, y: q.y, z: q.z, what: zhName(bot.blockAt(q)?.name ?? target), entity: false });
      }
    }
    const d2 = (h: ExploreHit): number => Math.hypot(h.x - me.x, h.y - me.y, h.z - me.z);
    return out.sort((a, b) => d2(a) - d2(b));
  };

  // 站着扫:不给 direction 就是这一档。不挪地方、不进探索账本,只报这一刻看得见的。
  if (direction === undefined) {
    const radius = Math.min(distance, FIND_STATIC_MAX);
    // 站着不走路,早停无从谈起 —— 收下了却没用上的参数必须自己说出来,
    // 不然它就是一次静默吃掉(这条链上最贵的一类失败)
    const idle = until && until.length > 0
      ? `(写了 until,但这一趟是站着看一眼、人不动,碰不到东西也就没得停;要它管用得给 direction)`
      : '';
    const capped = (distance > FIND_STATIC_MAX
      ? `(站着最远只看得到 ${FIND_STATIC_MAX} 格;要更远得给 direction 走过去)`
      : '') + idle;
    const hits = scanAll(radius);
    if (hits.length === 0) {
      const kind = findKind(null, entityName);
      return finish(
        `当前观察:在周围 ${radius} 格内没看见${zhThing(target)}${capped};` +
          `这只说明当前已加载且视线可达的观察面没有命中,不表示目标不存在` +
          `${findHistoryNote(ctx, target, kind)}。${findEmptyHint(bot, ctx, target, entityName !== null)}`,
        null,
      );
    }
    const me = bot.entity.position;
    const feet = feetOf(bot);
    const shown = hits.slice(0, FIND_HITS_MAX).map((h) => {
      const dir = bearing(h.x - me.x, h.z - me.z);
      const dy = h.y - feet.y;
      const vertical = dy >= 3 ? '上方' : dy <= -3 ? '下方' : '';
      const where = dir ? `${DIRECTION_ZH[dir]}边${vertical}` : (vertical || '脚边');
      const away = Math.round(Math.hypot(h.x - me.x, h.y - me.y, h.z - me.z));
      return `${h.what}${findHitText(bot, h)},我${where} ${away} 格`;
    });
    const more = hits.length - shown.length;
    return finish(
      `当前观察:在周围 ${radius} 格内看见 ${hits.length} 处${zhThing(target)}${capped}: ` +
        `${shown.join('、')}${more > 0 ? `,另有 ${more} 处` : ''}`,
      hits[0],
    );
  }

  const walked = (): number => {
    const p = bot.entity.position;
    return Math.hypot(p.x - start.x, p.z - start.z);
  };

  /** 收工(走满/命中)落覆盖账本;原地命中(没走)不算探过 */
  const settle = (): void => {
    const d = Math.round(walked());
    if (d > 0) ctx.explored?.(dimensionOf(bot), direction, d, biomeAt(bot, bot.entity.position));
  };

  const [dx, dz] = DIRECTIONS[direction];
  const norm = Math.hypot(dx, dz);
  /** 初始全向扫描命中时，回执使用命中点的实际方位与距离。 */
  const hitHere = scan();
  if (hitHere) {
    const p = bot.entity.position;
    const dir = bearing(hitHere.x - p.x, hitHere.z - p.z);
    const away = Math.round(Math.hypot(hitHere.x - p.x, hitHere.z - p.z));
    const where = dir ? `在我${DIRECTION_ZH[dir]}边 ${away} 格` : '就在脚边';
    return finish(
      `还没往${DIRECTION_ZH[direction]}走就看见了;请求的${DIRECTION_ZH[direction]}向行军尚未发生;` +
        `这次命中来自出发点的初始全向观察,` +
        `不是${DIRECTION_ZH[direction]}向搜索结果:${hitHere.what}${where},${findHitText(bot, hitHere)}`,
      hitHere,
    );
  }

  // 赶路途中的补光:lightWhen:"anywhere" 才做,默认这条不响
  const keep = new Upkeep(bot, ctx);
  const litTail = (): string => {
    const t = keep.tally();
    return t.length > 0 ? `;${t.join(';')}` : '';
  };
  // 早停名单:每走完一段扫一次。命中是**正常收束**,不是受阻——她要的就是"走到
  // 碰见铁矿为止",走到那儿这一步就做完了
  const stop = until && until.length > 0 ? untilBlockIds(bot, until) : null;
  const stopNote = stop ? untilUnknownNote(stop.unknown) : '';
  const stopHit = (): UntilHit | null =>
    (stop ? untilHit(bot, stop.ids, UNTIL_TRAVEL_RADIUS, true) : null);
  for (let travelled = 0; travelled < distance; travelled += EXPLORE_LEG) {
    checkAbort(ctx);
    await keep.light(undefined, 'travel');
    const leg = Math.min(EXPLORE_LEG, distance - travelled);
    const p = bot.entity.position;
    const x = Math.round(p.x + (dx / norm) * leg);
    const z = Math.round(p.z + (dz / norm) * leg);
    const legGoal = levelTravelGoal(x, z);
    try {
      await gotoGoal(bot, legGoal, ctx);
    } catch (err) {
      if (err instanceof Aborted) throw err;
      const hit = scan();
      if (hit) {
        settle();
        const moved = Math.round(walked());
        return finish(
          `朝${DIRECTION_ZH[direction]}走了 ${moved} 格后走不动了,不过当前看见${hit.what},${findHitText(bot, hit)}`,
          hit,
        );
      }
      // 试算必须使用本段实际下达的 legGoal。
      throw withRouteScene(bot, ctx, new SkillBlocked(
        `朝${DIRECTION_ZH[direction]}走了 ${Math.round(walked())} 格就走不过去了(` +
        `${(err as Error).message}),当前沿走过路线的可见面没看见${zhThing(target)},` +
        `不表示目标不存在${findHistoryNote(ctx, target, findKind(null, entityName))}`,
      ), { x, y: feetOf(bot).y, z }, [], legGoal);
    }
    const hit = scan();
    if (hit) {
      const p2 = bot.entity.position;
      settle();
      const moved = Math.round(walked());
      return finish(
        `朝${DIRECTION_ZH[direction]}走了 ${moved} 格,当前看见了${hit.what},${findHitText(bot, hit)};` +
          `我现在在 (${Math.round(p2.x)}, ${Math.round(p2.y)}, ${Math.round(p2.z)})${litTail()}`,
        hit,
      );
    }
    const early = stopHit();
    if (early) {
      const p2 = bot.entity.position;
      settle();
      const moved = Math.round(walked());
      return finish(
        `朝${DIRECTION_ZH[direction]}走了 ${moved} 格,` +
          `在 (${early.x}, ${early.y}, ${early.z}) 碰到了${early.what},停在这` +
          `(当前观察还没看见${zhThing(target)},不表示目标不存在);` +
          `我现在在 (${Math.round(p2.x)}, ${Math.round(p2.y)}, ${Math.round(p2.z)})${litTail()}${stopNote}`,
        null,
      );
    }
  }
  const p = bot.entity.position;
  settle();
  // 视线扫描只能报告这条路线未见目标，不能排除整个方向；
  // 室内目标可能被墙挡住，附按类别生成的探索提示。
  const indoorTail = `。${findEmptyHint(bot, ctx, target, entityName !== null)}`;
  // 净位移为零时须明确未离开出发点，不能声称已搜索完路线。
  const w = Math.round(walked());
  const how = w === 0
    ? `朝${DIRECTION_ZH[direction]}这一趟没走出去(要走 ${distance} 格,人还在出发点),请求方向尚未实际搜索`
    : `朝${DIRECTION_ZH[direction]}走满了 ${w} 格,沿走过路线的当前可见面一路没看见${zhThing(target)}`;
  return finish(
    `${how}${stop ? `,也没碰到 until 名单里的东西${stopNote}` : ''};` +
      `这不表示目标不存在,也不能据此断言整个方向没有目标${findHistoryNote(ctx, target, findKind(null, entityName))};` +
      `我现在在 (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})${litTail()}${indoorTail}`,
    null,
  );
}

/** 一竿从抛出到咬钩的等待上限;原版浮标 5-30s 咬钩,到点按空军收竿 */
export const FISH_WAIT_MS = 45_000;
/** 浮标上方不见天时的等待上限；原版每 tick 有一半概率暂停倒计时，期望等待翻倍。 */
export const FISH_WAIT_COVERED_MS = 60_000;
/** 找水面的扫描半径:开阔水域按定义离岸 ≥3 格,8 格只够到岸沿 */
export const FISH_SCAN_R = 12;
/** 此直线距离内的水面免视线检查，允许岸壁上方向脚下水面投竿。 */
export const FISH_NEAR_R = 4;
/** 咬钩收线后战利品从浮标飞回入包的等待 */
export const FISH_LOOT_SETTLE_MS = 1_500;

/** 抛竿等待上限:浮标上方有遮盖就按原版的减半倒计时放宽 */
export function fishWaitMs(covered: boolean): number {
  return covered ? FISH_WAIT_COVERED_MS : FISH_WAIT_MS;
}

/** 原版开阔水域判定里算「在水里」的方块:水源、水草(碰撞箱为空且必带水源) */
export const OPEN_WATER_INSIDE = new Set(['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column']);

export type OpenWaterLayer = 'inside' | 'above' | 'invalid';

/**
 * 原版 FishingHook.calculateOpenWater:以浮标格为中心 5×5,从下一层到上两层逐层看,
 * 每层要么整层是水源(或水草),要么整层是空气/睡莲;最底那层必须是水,之后只允许
 * 从水到空气转一次。等价于「周围 5×5 至少 2 格深、岸不在 2 格内」。宝藏只在这种
 * 水里出;咬钩本身不看它。
 */
export function isOpenFishingWater(bot: Bot, c: Cell): boolean {
  const layerType = (y: number): OpenWaterLayer => {
    let seen: OpenWaterLayer | null = null;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(new Vec3(c.x + dx, y, c.z + dz));
        if (!b) return 'invalid';
        let t: OpenWaterLayer;
        if (AIR_NAMES.has(b.name) || b.name === 'lily_pad') t = 'above';
        else if (b.name === 'water') t = blockProp(b, 'level') === '0' ? 'inside' : 'invalid';
        else if (OPEN_WATER_INSIDE.has(b.name)) t = 'inside';
        else t = 'invalid';
        if (t === 'invalid') return 'invalid';
        if (seen !== null && seen !== t) return 'invalid';
        seen = t;
      }
    }
    return seen ?? 'invalid';
  };
  let prev: OpenWaterLayer = 'invalid';
  for (let dy = -1; dy <= 2; dy++) {
    const t = layerType(c.y + dy);
    if (t === 'invalid') return false;
    if (t === 'above' && prev === 'invalid') return false;
    if (t === 'inside' && prev === 'above') return false;
    prev = t;
  }
  return true;
}

/** 选点结果:选中的水面格,以及它是不是开阔水域(有开阔水域就一定选它) */
export interface FishingSpot { cell: Cell; open: boolean }

/**
 * 候选水面上方须非实心且非液体，优先开阔水域，再按距离选择。
 * FISH_NEAR_R 内免视线检查；更远候选须可见或沿水面连接到可见/近处水格。
 */
export function findFishingSpot(bot: Bot, maxDistance: number): FishingSpot | null {
  const water = (bot.registry.blocksByName as Record<string, { id: number } | undefined>).water;
  if (!water) throw new SkillBlocked('这个世界没有水这种方块');
  const me = bot.entity.position;
  // 只要水面格:深处的水格再多也不是落点。半径 12 的一片湖水面约 450 格,上限放宽到装得下
  const surface = (b: { name: string; position: Vec3 }): boolean => {
    const above = bot.blockAt(b.position.offset(0, 1, 0));
    return !!above && above.boundingBox !== 'block' && !LIQUIDS.has(above.name);
  };
  const found = bot.findBlocks({ matching: [water.id], maxDistance, count: 512, useExtraInfo: surface })
    .filter((p) => surface({ name: 'water', position: p }));
  if (found.length === 0) return null;
  const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;
  const byKey = new Map<string, Vec3>();
  for (const p of found) byKey.set(key(p), p);
  // 看得见的与近处的先入席,再沿水面 8 邻域(允许上下一格的落差)扩到同一片水
  const seen = new Set<string>();
  const queue: Vec3[] = [];
  for (const p of found) {
    if (p.distanceTo(me) <= FISH_NEAR_R || canSeeBlockAt(bot, p)) { seen.add(key(p)); queue.push(p); }
  }
  while (queue.length > 0) {
    const p = queue.pop()!;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          const k = `${p.x + dx},${p.y + dy},${p.z + dz}`;
          if (seen.has(k)) continue;
          const q = byKey.get(k);
          if (!q) continue;
          seen.add(k);
          queue.push(q);
        }
      }
    }
  }
  const visible = found.filter((p) => seen.has(key(p)));
  if (visible.length === 0) return null;
  const nearest = (list: Vec3[]): Vec3 => list.reduce((a, b) => (b.distanceTo(me) < a.distanceTo(me) ? b : a));
  const open = visible.filter((p) => isOpenFishingWater(bot, { x: p.x, y: p.y, z: p.z }));
  const pick = open.length > 0 ? nearest(open) : nearest(visible);
  return { cell: { x: pick.x, y: pick.y, z: pick.z }, open: open.length > 0 };
}

/** 最近一格看得见的水面(上方不是实心也不是液体);着火找水复用,半径可放大 */
export function findFishingWater(bot: Bot, maxDistance = FISH_SCAN_R): Cell {
  const spot = findFishingSpot(bot, maxDistance);
  if (!spot) throw new SkillBlocked(`${maxDistance} 格内没看见能下竿的水面`);
  return spot.cell;
}

/** 这片水没有开阔水域时回执里的那句事实 */
export const NO_OPEN_WATER_NOTE = '这片水没有开阔水域,只能钓岸边(不出宝藏)';

/**
 * 浮标的服务端弹道:出手速度是 0.6 + 0.5/cos(仰角)(竖直分量取 tan(仰角),被钳在 ±5),
 * 之后每 tick 先位移、再乘阻力 0.92、再吃重力 0.03。直线瞄准会系统性抛短——
 * 瞄 3 格外落 2.7 格、瞄 8 格外落 5.9 格——而最近那格水就在岸沿,短一截就砸在岸上。
 * 所以抛竿前按这套物理搜一个真能落进水里的仰角。
 */
export const BOBBER_DRAG = 0.92;
export const BOBBER_GRAVITY = 0.03;
/** 竖直分量 tan(仰角) 被服务端钳在 ±5(≈78.7°),再陡也不会更陡 */
export const BOBBER_TAN_CLAMP = 5;
/** 浮标出手点在眼睛处、沿水平朝向前 0.3 格 */
export const BOBBER_SPAWN_FWD = 0.3;
/** 一竿最多模拟这么多 tick,以及浮标离人多远就被服务端收走 */
export const BOBBER_MAX_TICKS = 120;
export const BOBBER_MAX_DIST = 32;
/** 搜仰角的范围与步长(度);正为抬头 */
export const AIM_MIN_DEG = -80;
export const AIM_MAX_DEG = 45;
export const AIM_STEP_DEG = 1;

export type BobberHit =
  | { hit: 'water'; x: number; y: number; z: number; dist: number }
  | { hit: 'solid' | 'unloaded' | 'lost' };

/** 落点搜索用的方块视图:只要名字和挡不挡路 */
export type BlockPeek = (x: number, y: number, z: number) => { name: string; solid: boolean } | null;

/**
 * 从 eye 沿水平朝向 (hx, hz)、以 elev 弧度的仰角抛一竿,模拟到落点。
 * 逐 tick 走位移并细分采样:先碰到水算落水,先碰到实心算落地。
 */
export function simulateBobber(
  eye: { x: number; y: number; z: number },
  hx: number,
  hz: number,
  elev: number,
  peek: BlockPeek,
): BobberHit {
  const tan = Math.max(-BOBBER_TAN_CLAMP, Math.min(BOBBER_TAN_CLAMP, Math.tan(elev)));
  const d3 = Math.hypot(1, tan);
  const m = 0.6 / d3 + 0.5;
  let vx = hx * m;
  let vy = tan * m;
  let vz = hz * m;
  let px = eye.x + hx * BOBBER_SPAWN_FWD;
  let py = eye.y;
  let pz = eye.z + hz * BOBBER_SPAWN_FWD;
  for (let t = 0; t < BOBBER_MAX_TICKS; t++) {
    const n = Math.max(1, Math.ceil(Math.hypot(vx, vy, vz) / 0.25));
    for (let s = 1; s <= n; s++) {
      const qx = px + (vx * s) / n;
      const qy = py + (vy * s) / n;
      const qz = pz + (vz * s) / n;
      const b = peek(Math.floor(qx), Math.floor(qy), Math.floor(qz));
      if (!b) return { hit: 'unloaded' };
      if (b.name === 'water') {
        return { hit: 'water', x: qx, y: qy, z: qz, dist: Math.hypot(qx - eye.x, qz - eye.z) };
      }
      if (b.solid) return { hit: 'solid' };
    }
    px += vx; py += vy; pz += vz;
    vx *= BOBBER_DRAG;
    vz *= BOBBER_DRAG;
    vy = vy * BOBBER_DRAG - BOBBER_GRAVITY;
    if (Math.hypot(px - eye.x, py - eye.y, pz - eye.z) > BOBBER_MAX_DIST) return { hit: 'lost' };
  }
  return { hit: 'lost' };
}

/** 一个候选抛法:仰角(弧度)与它预测的落水点离目标格中心多远 */
export type AimPlan = { elev: number; dist: number; miss: number };

/**
 * 搜出所有能落进水里的仰角,按落点离目标格多近排序。
 * 空表示这个站位怎么抛都进不了水(该换个站位或换个目标)。
 */
export function planFishingCasts(bot: Bot, target: Cell): AimPlan[] {
  const me = bot.entity.position;
  const eye = { x: me.x, y: me.y + ((bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62), z: me.z };
  const tx = target.x + 0.5;
  const ty = target.y + 0.9;
  const tz = target.z + 0.5;
  const dx = tx - eye.x;
  const dz = tz - eye.z;
  const h = Math.hypot(dx, dz);
  // 正下方的水没有水平朝向可言,给个任意朝向,让近乎垂直的抛法照样能搜出来
  const hx = h < 1e-6 ? 1 : dx / h;
  const hz = h < 1e-6 ? 0 : dz / h;
  // 一次搜要问上千次方块,同一格只查一遍
  const memo = new Map<string, { name: string; solid: boolean } | null>();
  const peek: BlockPeek = (x, y, z) => {
    const key = `${x},${y},${z}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const b = bot.blockAt(new Vec3(x, y, z));
    const v = b ? { name: b.name, solid: b.boundingBox === 'block' } : null;
    memo.set(key, v);
    return v;
  };
  const plans: AimPlan[] = [];
  for (let deg = AIM_MIN_DEG; deg <= AIM_MAX_DEG; deg += AIM_STEP_DEG) {
    const elev = (deg * Math.PI) / 180;
    const r = simulateBobber(eye, hx, hz, elev, peek);
    if (r.hit !== 'water') continue;
    plans.push({ elev, dist: r.dist, miss: Math.hypot(r.x - tx, r.y - ty, r.z - tz) });
  }
  plans.sort((a, b) => a.miss - b.miss);
  return plans;
}

/** 我这一竿的浮标:附近唯一一个 fishing_bobber 实体 */
export function findBobber(bot: Bot): NonNullable<Bot['entities'][string]> | null {
  const me = bot.entity.position;
  let best: NonNullable<Bot['entities'][string]> | null = null;
  let bestD = Infinity;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e?.position || e.name !== 'fishing_bobber') continue;
    const d = e.position.distanceTo(me);
    if (d <= BOBBER_MAX_DIST + 4 && d < bestD) { bestD = d; best = e; }
  }
  return best;
}

/** 浮标此刻所在的那一格 */
export function bobberCell(bot: Bot): { name: string; x: number; y: number; z: number } | null {
  const e = findBobber(bot);
  if (!e) return null;
  const p = e.position;
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  const z = Math.floor(p.z);
  const b = bot.blockAt(new Vec3(x, y, z));
  return { name: b?.name ?? 'unknown', x, y, z };
}

/** 抛出后等浮标停下来的上限;飞行一般 10~30 tick */
export const BOBBER_SETTLE_MS = 2_000;
/** 落点不是水就收竿换仰角重抛,一次 fish 最多抛这么多竿 */
export const FISH_CAST_TRIES = 3;

/**
 * 等浮标停稳并回报它停在哪一格。落进水里立刻回;落在地上要连着几次读数不动才算停。
 * 始终看不见浮标实体(实体没同步过来)回 null——那种情况不拦着,照旧等咬钩。
 */
export async function settleBobber(bot: Bot, ctx: SkillContext): Promise<{ name: string; x: number; y: number; z: number } | null> {
  const deadline = Date.now() + BOBBER_SETTLE_MS;
  let last: string | null = null;
  let stable = 0;
  while (Date.now() < deadline) {
    checkAbort(ctx);
    await sleep(100);
    const at = bobberCell(bot);
    if (!at) { last = null; stable = 0; continue; }
    if (at.name === 'water') return at;
    const key = `${at.x},${at.y},${at.z}`;
    if (key === last) {
      stable++;
      if (stable >= 3) return at;
    } else {
      last = key;
      stable = 0;
    }
  }
  return bobberCell(bot);
}

/**
 * 钓一竿。`bot.fish()` 抛竿等浮标粒子,咬钩时它自己收线并 resolve;它没有超时,
 * 也没有取消入口——中止/超时靠再挥一次竿收回浮标,浮标销毁后 fish() 以
 * "Fishing cancelled" 收场。收获按物品栏差分照实报。
 *
 * `bot.fish()` 只等咬钩粒子,不看浮标落在哪:落岸上就白等满 45 秒再谎报「没鱼咬钩」。
 * 所以仰角自己按弹道搜(见 planFishingCasts),抛完先看浮标真停在哪一格,
 * 不是水就立刻收竿换下一个仰角重抛。
 */
export async function skillFish(bot: Bot, call: Extract<SkillCall, { skill: 'fish' }>, ctx: SkillContext): Promise<string> {
  checkAbort(ctx);
  let water: Cell;
  /** 目标格不是开阔水域时跟在回执后面的事实;是开阔水域就没有这一句 */
  let openNote = '';
  if (call.at) {
    water = resolveAt(bot, call.at);
    const b = blockAtCell(bot, water);
    if (!b) throw new SkillBlocked(`${cellText(water)} 那里区块没加载`);
    if (b.name !== 'water') throw new SkillBlocked(`${cellText(water)} 不是水,是${zhName(b.name)}`);
    if (!isOpenFishingWater(bot, water)) {
      openNote = `;${cellText(water)} 不是开阔水域(周围 5×5 不够 2 格深或岸在 2 格内),只出鱼不出宝藏`;
    }
  } else {
    const spot = findFishingSpot(bot, FISH_SCAN_R);
    if (!spot) throw new SkillBlocked(`${FISH_SCAN_R} 格内没看见能下竿的水面`);
    water = spot.cell;
    if (!spot.open) openNote = `;${NO_OPEN_WATER_NOTE}`;
  }
  const rod = bot.inventory.items().find((i) => i.name === 'fishing_rod');
  if (!rod) throw new SkillBlocked('包里没有钓竿');
  await bot.equip(rod, 'hand');

  // 原地有可行抛竿轨迹时不移动；否则走近后重新求抛物线，避免直接走入水面格。
  let plans = planFishingCasts(bot, water);
  if (plans.length === 0) {
    const me = bot.entity.position;
    if (Math.hypot(me.x - water.x, me.y - water.y, me.z - water.z) > 3.5) {
      try {
        await gotoGoal(bot, new goals.GoalNear(water.x, water.y, water.z, 3), ctx);
      } catch (err) {
        throw withRouteScene(bot, ctx, err, water);
      }
      plans = planFishingCasts(bot, water);
    }
  }
  if (plans.length === 0) {
    throw new SkillBlocked(`站在这抛不进 ${cellText(water)} 的水里(挡着或够不着),换个站位或换一片开阔水面`);
  }
  const here = bot.entity.position;
  const yaw = Math.atan2(-(water.x + 0.5 - here.x), -(water.z + 0.5 - here.z));

  const before = invSnapshot(bot);
  let outcome = '';
  let strayCell: { name: string; x: number; y: number; z: number } | null = null;
  /** 浮标头顶到世界顶之间有实心遮盖:原版倒计时减半,等待上限随之放宽 */
  let covered = false;
  let waitMs = FISH_WAIT_MS;
  let casts = 0;
  for (const plan of plans.slice(0, FISH_CAST_TRIES)) {
    checkAbort(ctx);
    casts++;
    await bot.look(yaw, plan.elev, true);
    const cast = bot.fish().then(() => 'caught' as const, (e: Error) => `失败:${e.message}`);
    // 先看浮标真落在哪:落岸上就收竿换下一个仰角,不白等 45 秒
    const landed = await Promise.race([cast.then(() => null), settleBobber(bot, ctx)]);
    if (landed && landed.name !== 'water') {
      strayCell = landed;
      bot.activateItem(); // 收竿销毁浮标,挂着的 fish() 以 Fishing cancelled 收场
      // 浮标销毁包没来的话 fish() 会一直挂着,不等它,让下一竿的 fish() 去取消它
      await Promise.race([cast.catch(() => undefined), sleep(500)]);
      continue;
    }
    strayCell = null;
    // 浮标实体没同步过来时读不到它头顶,按露天等
    covered = landed !== null && skyBlocked(bot, landed.x, landed.y + 1, landed.z);
    waitMs = fishWaitMs(covered);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const r = await Promise.race([cast, sleep(250).then(() => null)]);
      if (r !== null) { outcome = r; break; }
      if (ctx.aborted() || Date.now() >= deadline) {
        bot.activateItem(); // 收竿;浮标销毁让还挂着的 fish() 取消掉
        if (ctx.aborted()) throw new Aborted(ctx.abortedBy?.() ?? null);
        outcome = 'timeout';
        break;
      }
    }
    break;
  }
  if (strayCell) {
    throw new SkillBlocked(
      `抛了 ${casts} 竿,浮标都落在 (${strayCell.x}, ${strayCell.y}, ${strayCell.z}) 的${zhName(strayCell.name)}上、没进水里;` +
      '换个站位或指一片更开阔的水面',
    );
  }
  const notes = `${covered ? ';这里浮标头顶看不到天,咬钩慢' : ''}${openNote}`;
  if (outcome === 'caught') {
    await sleep(FISH_LOOT_SETTLE_MS);
    const gains = invGains(before, bot);
    if (gains.length > 0) return `钓上来${gains.join('、')}${notes}`;
    // 战利品从浮标飞回；背包无空位时可能落在脚边。
    const used = bot.inventory.items().length;
    return used >= PLAYER_SLOTS
      ? `咬钩了也收了线,包满了(${PLAYER_SLOTS} 格全占着),战利品掉在脚边${notes}`
      : `咬钩了也收了线,东西没进包(包里还有 ${PLAYER_SLOTS - used} 格空位)${notes}`;
  }
  if (outcome === 'timeout') {
    throw new SkillBlocked(`在 ${cellText(water)} 抛竿等了 ${Math.round(waitMs / 1000)} 秒没鱼咬钩,收竿了${notes}`);
  }
  throw new SkillBlocked(`这竿没钓成: ${zhErrorText(outcome.replace(/^失败:/, ''))}`);
}

/** trade 的实体查找半径与 attack 一致 */
export const TRADE_FIND_R = 32;
/** 开交易窗的等待上限;没职业的村民右键无响应 */
export const TRADE_OPEN_MS = 5_000;
// 报价包在各协议世代下的三个名字(mineflayer 按 supportFeature 三选一注册监听)
export const TRADE_LIST_PACKETS = ['trade_list', 'minecraft:trader_list', 'MC|TrList'];
export type PacketListener = (...args: unknown[]) => void;
export interface PacketEmitter {
  listeners(name: string): PacketListener[];
  removeListener(name: string, fn: PacketListener): void;
}

/** mineflayer 的 openVillager 返回值里这里用得到的面 */
export interface VillagerWindow {
  trades: Array<{
    inputItem1: { name: string; count: number };
    inputItem2?: { name: string; count: number } | null;
    hasItem2: boolean;
    outputItem: { name: string; count: number };
    realPrice?: number;
    tradeDisabled: boolean;
    nbTradeUses: number;
    maximumNbTradeUses: number;
  }> | null;
  trade(index: number, count: number): Promise<void>;
}

/** 报价一行:「1号:24小麦→1绿宝石」;卖断货标锁死 */
export function tradeLine(t: NonNullable<VillagerWindow['trades']>[number], i: number): string {
  const ins = [`${t.realPrice ?? t.inputItem1.count}${zhName(t.inputItem1.name)}`];
  if (t.hasItem2 && t.inputItem2) ins.push(`${t.inputItem2.count}${zhName(t.inputItem2.name)}`);
  const locked = t.tradeDisabled || t.maximumNbTradeUses - t.nbTradeUses <= 0;
  return `${i + 1}号:${ins.join('+')}→${t.outputItem.count}${zhName(t.outputItem.name)}${locked ? '(锁死)' : ''}`;
}

/**
 * 村民交易两段式:无 index 只报菜单不成交,带 index 按单成交、回执报实收实付。
 * 入口在 `use target:"villager"` —— 交易本来就是"右键这个活物",不该另立技能名。
 * openVillager 断言实体是 villager;流浪商人共用同一套商人窗口与报价包,
 * 借道时临时对上它认的 entityType,开完窗即还原。
 */
export async function skillTrade(
  bot: Bot,
  call: { target: string; index?: number; times?: number },
  ctx: SkillContext,
): Promise<string> {
  checkAbort(ctx);
  const me = bot.entity.position;
  let entity: NonNullable<Bot['entities'][string]> | null = null;
  let bestD = Infinity;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e?.position || e.name !== call.target) continue;
    if (!canSeeEntity(bot, e)) continue;
    const d = e.position.distanceTo(me);
    if (d <= TRADE_FIND_R && d < bestD) { bestD = d; entity = e; }
  }
  if (!entity) throw new SkillBlocked(`附近 ${TRADE_FIND_R} 格内没看见${zhEntity(call.target)}`);
  if (bestD > 3.5) await gotoGoal(bot, new goals.GoalFollow(entity, 2), ctx).catch(() => undefined);
  checkAbort(ctx);
  if (entity.position.distanceTo(bot.entity.position) > 4.5) {
    throw new SkillBlocked(`走不到${zhEntity(call.target)}身边(它在 ${Math.round(entity.position.distanceTo(bot.entity.position))} 格外)`);
  }

  const before = invSnapshot(bot);
  const registry = bot.registry as unknown as { entitiesByName?: Record<string, { id: number } | undefined> };
  const villagerId = registry.entitiesByName?.villager?.id;
  const eAny = entity as unknown as { entityType?: number };
  const origType = eAny.entityType;
  // 村民身份以实体元数据为准，回执同时说明所点实体及其身份。
  const note = villagerNote(entity as never);
  const who = `${zhEntity(call.target)}${note ? `(${note})` : ''}`;
  // openVillager 在等窗之前就往 _client 挂了个 async 的报价包监听器,只在窗口 close 时摘。
  // 窗没开出来这条路上它留在原地,手里攥着一个必然 reject 的 promise;下一次真收到报价包时
  // 它就地抛出,而 EventEmitter 不接返回值 —— 无人认领的 rejection 会掀掉整个引擎子进程。
  const client = (bot as unknown as { _client: PacketEmitter })._client;
  const kept = new Map(TRADE_LIST_PACKETS.map((name) => [name, new Set(client.listeners(name))]));
  let win: VillagerWindow | null;
  try {
    if (villagerId !== undefined) eAny.entityType = villagerId;
    const opening = (bot as unknown as { openVillager(e: unknown): Promise<VillagerWindow> })
      .openVillager(entity);
    opening.catch(() => undefined);
    win = await Promise.race([opening, sleep(TRADE_OPEN_MS).then(() => null)]);
  } finally {
    eAny.entityType = origType;
  }
  if (!win) {
    for (const name of TRADE_LIST_PACKETS) {
      for (const fn of client.listeners(name)) {
        if (!kept.get(name)!.has(fn)) client.removeListener(name, fn);
      }
    }
    // 开不出窗按身份分开说:无业/傻子/小孩是原版规则,照实说;有职业的开不出来
    // 不编理由,报事实并点名右键的是哪一只,免得她把锅扣到镜头里另一只村民头上
    const why = note === '还没有职业' || note === '傻子' ? `${note}的村民做不了买卖`
      : note === '小孩' ? '小孩做不了买卖'
      : note ? `它是${note},按理有报价,这次没等到,原因这份回执说不清`
      : '它的职业没读出来,原因也说不清';
    throw new SkillBlocked(`右键了${who}(在 ${cellText({ x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z) })}),等了 ${TRADE_OPEN_MS / 1000} 秒交易窗没开出来:${why}`);
  }

  const close = (): void => { bot.closeWindow(win as never); };
  const trades = win.trades;
  if (!trades || trades.length === 0) {
    close();
    throw new SkillBlocked(`${who}一条报价都没有`);
  }
  if (call.index === undefined) {
    close();
    return `${who}的报价:${trades.map(tradeLine).join(';')}。没成交,要买带 "index" 再来一单`;
  }
  const idx = call.index - 1;
  if (idx < 0 || idx >= trades.length) {
    close();
    throw new SkillBlocked(`报价只有 ${trades.length} 条,没有 ${call.index} 号`);
  }
  const t = trades[idx];
  const left = t.maximumNbTradeUses - t.nbTradeUses;
  if (t.tradeDisabled || left <= 0) {
    close();
    throw new SkillBlocked(`${call.index} 号报价(${tradeLine(t, idx)})锁死了,卖断货,换一条或等它补货`);
  }
  const times = Math.min(call.times ?? 1, left);
  try {
    await win.trade(idx, times);
  } catch (err) {
    close();
    const msg = (err as Error).message;
    if (/not enough item/i.test(msg)) {
      throw new SkillBlocked(`付不起 ${call.index} 号(${tradeLine(t, idx)}):包里的货不够`);
    }
    if (/trade blocked/i.test(msg)) {
      throw new SkillBlocked(`${call.index} 号报价锁死了,卖断货`);
    }
    throw new SkillBlocked(`没成交: ${zhErrorText(msg)}`);
  }
  close();
  // 开窗期间 bot.inventory 是旧账,关窗灌回后差分才作数
  await sleep(150);
  const gains: string[] = [];
  const paid: string[] = [];
  const after = invSnapshot(bot);
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const name of names) {
    const d = (after.get(name) ?? 0) - (before.get(name) ?? 0);
    if (d > 0) gains.push(`${zhName(name)}×${d}`);
    else if (d < 0) paid.push(`${zhName(name)}×${-d}`);
  }
  const clamp = times < (call.times ?? 1) ? `(额度只剩 ${left} 次,按 ${times} 次成交)` : '';
  return `按 ${call.index} 号成交 ${times} 次${clamp}:付出${paid.length > 0 ? paid.join('、') : '?(账上没见少)'},` +
    `进账${gains.length > 0 ? gains.join('、') : '?(账上没见多)'}`;
}

/* ========== 锚点几何技能族:probe / build / excavate / tunnel ========== */

/** 那一格是作物就带上原版 age 原值;不是作物给空串(与快照的括注同一形式) */
export function probeAgeText(bot: Bot, c: Cell): string {
  const age = cropAgeOfCell(bot, c);
  return age ? `(age ${age.value}/${age.max})` : '';
}

/** probe.where 直接检查指定区域的区块数据，不经过视线闸；零匹配也明确回报。 */
export function probeWhereText(
  bot: Bot,
  call: Extract<SkillCall, { skill: 'probe' }>,
  where: readonly string[],
  pre: ReadonlyArray<{ c: Cell; name: string | null }>,
  unloaded: number,
): string {
  const want = untilBlockIds(bot, where);
  const names = blockNamesOf(bot, want.ids);
  const me = bot.entity.position;
  const found = new Map<string, Cell[]>();
  for (const e of pre) {
    if (e.name === null || !names.has(e.name)) continue;
    const list = found.get(e.name) ?? [];
    list.push(e.c);
    found.set(e.name, list);
  }
  const lines = [...found]
    .map(([name, at]) => {
      at.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y, a.z - me.z)
        - Math.hypot(b.x - me.x, b.y - me.y, b.z - me.z));
      const shown = at.slice(0, PROBE_WHERE_SHOWN).map(cellText).join('、');
      return `${zhName(name)}×${at.length}${at.length > PROBE_WHERE_SHOWN ? `,最近的 ${shown}` : `:${shown}`}`;
    })
    .sort();
  const head = `探查${SHAPE_ZH[call.shape]}(共 ${pre.length} 格)里点名的那几样`;
  const body = lines.length > 0 ? `: ${lines.join(';')}` : ':一样都没有';
  const miss = names.size === 0 ? '(点名的这几样一个都认不出来)' : '';
  const tail = unloaded > 0 ? `。${unloaded} 格区块没加载,那几格没读到` : '';
  return `${head}${miss}${body}${untilUnknownNote(want.unknown)}${tail}。这一档直接读区块,不受遮挡与视线限制`;
}

/**
 * 探查:只读不动。≤27 格逐格列坐标,大体积报聚合构成;"target" 只报命中格。
 * 同参重复探查且读数没变时只回「与上次相同」——差分记在执行器上,跨任务有效,重启清。
 */
export async function skillProbe(bot: Bot, call: Extract<SkillCall, { skill: 'probe' }>, ctx: SkillContext): Promise<string> {
  checkAbort(ctx);
  const locating = call.where !== undefined && call.where.length > 0;
  const cells = shapeCells(
    bot, call.shape, call.anchors, call.fill, locating ? PROBE_WHERE_CELL_CAP : PROBE_CELL_CAP,
  );
  const pre = cells.map((c) => {
    const b = blockAtCell(bot, c);
    return { c, name: b?.name ?? null };
  });
  const unloaded = pre.filter((e) => e.name === null).length;
  if (call.where !== undefined && locating) return probeWhereText(bot, call, call.where, pre, unloaded);

  const memo = ctx.probeMemo;
  const geoKey = fnv32(`${call.shape}|${cells.map((c) => `${c.x},${c.y},${c.z}`).join(';')}`);
  // 作物的 age 进指纹:名字没变、龄期跳档也是新读数,不然「熟了没」永远回「与上次相同」
  const readHash = fnv32(pre.map((e) => {
    if (e.name === null) return '?';
    return e.name in CROP_MAX_AGE ? `${e.name}@${cropAgeOfCell(bot, e.c)?.value ?? '?'}` : e.name;
  }).join(','));
  if (memo?.last && memo.last.key === geoKey && memo.last.hash === readHash) {
    memo.last.count += 1;
    return `与上次探查相同(第 ${memo.last.count} 次)。上次: ${memo.last.summary}`;
  }

  const head = `探查${SHAPE_ZH[call.shape]}(共 ${cells.length} 格)`;
  const lines: string[] = [];
  if (cells.length <= PROBE_CELLWISE_MAX) {
    const listed = pre.filter((e) => e.name !== null && !AIR_NAMES.has(e.name));
    const airCells = pre.filter((e) => e.name !== null && AIR_NAMES.has(e.name)).map((e) => e.c);
    if (listed.length === 0) {
      lines.push(`${head}: 全是空气。`);
    } else {
      const airTail = airCells.length > 0 ? `;其余 ${airCells.length} 格是空气` : '';
      lines.push(`${head},逐格: ${listed.map((e) => `(${e.c.x},${e.c.y},${e.c.z}):${zhName(e.name!)}${probeAgeText(bot, e.c)}`).join('、')}${airTail}。`);
    }
    pushPocketLine(bot, lines, cells, airCells);
  } else {
    const reading = readRegion(bot, cells);
    lines.push(`${head}: ${compositionText(reading)}。`);
    pushPocketLine(bot, lines, cells, reading.air);
  }
  if (unloaded > 0) lines.push(`${unloaded} 格区块没加载,没读到。`);
  const text = lines.join('');
  if (memo) memo.last = { key: geoKey, hash: readHash, count: 1, summary: lines[0] };
  return text;
}

