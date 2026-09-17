/**
 * 进出容器与工作站:pickup、toss、stow、take、smelt、enchant、brew、transit。
 *
 * 每一次存取都以回读槽位为准;开窗与账本在 containers.ts。
 */
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import {
  INVENTORY_SLOTS, awaitInvConfirm, invCount, invCountIn, invGains, invGainsSplit, invSnapshot,
  itemAsked, itemPredOf, lootNote, moveExactSlot, noSuchItem, playerInvIn, type InvItem,
  type InvPred,
} from './inventory.ts';
import { isSpawnAnchorBlock } from './policy.ts';
import { roman, zhDimension, zhEnchant, zhName } from './names.ts';
import { Aborted, SkillBlocked, SkillNoop, checkAbort, sleep, type SkillContext } from './skill-context.ts';
import { AIR_NAMES, LIQUIDS, blockAtCell, cellText, dimensionOf, feetOf, resolveAt } from './cell-facts.ts';
import { droppedStackOf, type ItemStack } from './terrain.ts';
import { CONTAINER_FIND, FURNACE_KINDS, matchItemName } from './chests.ts';
import { dropGoal, gotoGoal } from './travel.ts';
import { type SkillCall } from './skills.ts';
import { pickMissText, pickTargetOf, pickedText, type PickTarget } from './item-pick.ts';
import {
  containerStacks, findContainers, furnaceDoneAt, noContainerNearby, openNearbyContainer,
  openWindowGuarded, orderForStow, orderForTake, rememberChest, slotStack, smeltPerItemMs,
  type GenericWindow,
} from './containers.ts';
import { contentsText, zhErrorText } from './receipt.ts';
import { ShowPacer } from './show.ts';
import { type Anchor, type Cell } from './geometry.ts';
import { FURNACE_STATION, ensureStation, type Station, type StationAt } from './placement.ts';
import { readEnchants, readPotionId, type ItemEnchant } from './item-facts.ts';
import { normalizeDimension } from './escape.ts';

const { goals } = pathfinderPkg;

/** 这一步净增的东西里哪些是重生锚(床/重生锚的物品形态) */
export function gainedAnchors(before: Map<string, number>, bot: Bot): string[] {
  const out: string[] = [];
  for (const [name, n] of invSnapshot(bot)) {
    if (n > (before.get(name) ?? 0) && isSpawnAnchorBlock(name)) out.push(zhName(name));
  }
  return out;
}

/** 床或重生锚进入、离开背包时，报告物品形态，并提示重生点依赖已放置且有效的床或锚。 */
export function anchorInHandNote(bot: Bot, ctx: SkillContext, names: string[], verb: string): string {
  if (names.length === 0) return '';
  const anchor = ctx.spawnAnchor?.();
  const where = anchor
    ? `(重生点记在${anchor.dimension ? zhDimension(anchor.dimension) : '维度未明'} `
      + `${cellText({ x: Math.floor(anchor.x), y: Math.floor(anchor.y), z: Math.floor(anchor.z) })})`
    : '(现在已经没有个人重生点了)';
  return ` —— ${verb}的${names.join('、')}是你的重生锚${where},它已经不在原来那一格摆着了,` +
    '重生点随之作废;放回去再睡一次才算数。';
}

export async function skillPickup(bot: Bot, ctx: SkillContext, item?: string): Promise<string> {
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
export const TOSS_RANGE = { min: 4, max: 8 } as const;
/** 抛远的仰角(弧度)。mineflayer 的 pitch 是**负值朝上**,抬头 30–45° 取中间偏上的 40° */
export const TOSS_PITCH = -(40 * Math.PI) / 180;
/** 找方向时按这个角度间隔扫一圈(度) */
export const TOSS_YAW_STEP = 30;

/** `toss` 带 at 时的瞄准上限:手扔的抛物线大致就到这儿,再远只是把东西丢在半路 */
export const TOSS_AIM_MAX = 8;

/**
 * toss 按当前 yaw/pitch 给物品初速度，须预先转向。
 * 纯读已加载格，在 min..max 范围检查落点及头格均为空气；选最长畅通方向，同距取首。
 * 无合格方向返回 null，调用方就地丢弃；不寻路或修改方块。
 */
export function planTossThrow(bot: Bot): { yaw: number; distance: number } | null {
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
export function yawCompass(yaw: number): string {
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  // 屏幕坐标里 -Z 是北、+X 是东;atan2 取正东为 0 再按 45° 分档
  const deg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  return names[Math.round(deg / 45) % 8];
}

export async function skillToss(
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

/** 一次开窗里存一样东西的账 */
export interface StowEntry {
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
export const STOW_BATCH_MAX = 6;

/** 相邻 stow 仅在 orderForStow 仍选同一首选箱子时共用窗口，不改变选箱策略。 */
export function collectStowBatch(
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
export function stowReceipt(
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

export async function skillStow(
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
export async function skillTakeAt(
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
export async function awaitGainsConfirm(
  bot: Bot,
  names: readonly string[],
  beforeTotal: number,
  ctx: SkillContext,
): Promise<'confirmed' | 'timeout' | 'rolled-back'> {
  const total = (): number => names.reduce((s, n) => s + invCount(bot, (x) => x === n), 0);
  const conf = await awaitInvConfirm(total, beforeTotal, 1, ctx);
  return conf.status;
}

export async function takeFromFurnace(
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

export async function takeFromChestAt(
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

export async function skillTake(bot: Bot, call: Extract<SkillCall, { skill: 'take' }>, ctx: SkillContext): Promise<string> {
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
export function pickSmeltInput(bot: Bot, item: string) {
  return bot.inventory.items()
    .filter((i) => matchItemName(item, i.name))
    .sort((a, b) => b.count - a.count)[0];
}

/**
 * smelt 下料并点火后结束，不等待世界侧烧炼或宣称实际产量。
 * 回执提供炉位、投入量、预计完成时间和取货方式；expectedDoneAt 到期由账本通知。
 * 未开窗炉子的槽位不持续同步，实际产物须取货时读取。
 */
export async function skillSmelt(
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
export const BOOKSHELF_RING: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
];

export function countBookshelves(bot: Bot, cell: Cell): number {
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
export interface EnchantOffer {
  level: number;
  hint: ItemEnchant | null;
}

export interface EnchantWindow {
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
export async function awaitOffers(win: EnchantWindow, ctx: SkillContext): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    checkAbort(ctx);
    if (win.enchantments.every((e) => e.level >= 0)) return true;
    await sleep(80);
  }
  return false;
}

export function offerText(i: number, o: EnchantOffer): string {
  const known = o.hint ? `${zhEnchant(o.hint.name)}${roman(o.hint.level)}、` : '';
  return `  ${i + 1} 档 需 ${o.level} 级 + ${i + 1} 青金石:${known}[未知]`;
}

export const LAPIS = 'lapis_lazuli';

/**
 * 附魔台:只看三档报价,或按一档下手。
 *
 * 必须自开窗口:`use` 右键附魔台开出来的窗口在 skillUse 里被无条件 closeWindow,
 * 而 rememberWindow 只认容器族与炉子族。这里走 mineflayer 的 openEnchantmentTable,
 * 收尾一律把物品与青金石取回来再关窗。
 *
 * **不推荐哪一档**:三档的数字与书架数都是事实,选哪档是她的权衡。
 */
export async function skillEnchant(
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
export const BREW_BOTTLE_SLOTS = [0, 1, 2] as const;
export const BREW_INPUT_SLOT = 3;
export const BREW_FUEL_SLOT = 4;

/** 原版一轮酿造 400 刻 = 20 秒,与瓶数无关 */
export const BREW_ROUND_MS = 20_000;

export const BREW_STATION: Station = {
  kinds: ['brewing_stand'], label: '酿造台', hint: '先 craft 一个酿造台(1 根烈焰棒 + 3 块圆石)',
};

/** 一件药水念成「药水(内容 #N)」;`#N` 是原版药水注册表序号,不是药水都不带这个尾巴 */
export function potionText(stack: { name: string; count: number } | null): string {
  if (!stack) return '空';
  const id = readPotionId(stack as never);
  return `${zhName(stack.name)}${id === null ? '' : `(内容 #${id})`}×${stack.count}`;
}

/** 三个瓶位现在各是什么;同内容的合并计数 */
export function bottleText(win: GenericWindow, loaded: number): string {
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
export async function skillBrew(
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
export async function takeFromBrewingStand(
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
export async function skillTransit(
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

