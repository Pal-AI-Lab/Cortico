/**
 * 回执的说法:这一步是什么、受阻那一刻的现场、核验结论怎么念。
 *
 * 只出文本,不改世界也不发包;两处(bagNow、noDropMaterials)读背包是为了把读数写进那句话。
 * 判据在各技能族,这里只负责措辞。
 */
import type { Bot } from 'mineflayer';
import { zhDimension, zhEntity, zhName } from './names.ts';
import { INVENTORY_SLOTS } from './inventory.ts';
import { DIRECTION_ZH, narrateInventory, type Direction, type ItemStack } from './terrain.ts';
import { SkillBlocked } from './skill-context.ts';
import { NEAR_DEFAULT, type Expectation, type SkillCall } from './skills.ts';
import { FACE_ZH, SHAPE_ZH } from './cell-facts.ts';
import { DRINKABLES, readEnchants } from './item-facts.ts';
import { equipDestOf } from './tools.ts';
import { type Anchor, type BoxFill, type ShapeName } from './geometry.ts';
import { LIQUIDS, type RegionReading } from './cell-facts.ts';
import { minHarvestTool } from './tools.ts';

/**
 * mineflayer/pathfinder 的英文报错翻成中文再进事件:上下文里除方块/物品 id 之外
 * 不该混进英文,而反复出现的报错原文是最大的一处渗入。
 * 认不出的报错原样保留(排查后再补映射)。
 */
export function zhErrorText(msg: string): string {
  if (/path was stopped/i.test(msg)) return '寻路半途被叫停';
  // A* 超时只表示限时内未搜完，不能据此断言目标太远或无路。
  if (/took to+ long to decide/i.test(msg)) return '限时内没算完';
  if (/goal was changed/i.test(msg)) return '目标中途被更换';
  if (/no path to the goal/i.test(msg)) return '找不到可行路线';
  if (/digging aborted/i.test(msg)) return '挖到一半被打断了';
  if (/timeout|timed? out/i.test(msg)) return '超时';
  if (/must be holding an item to place/i.test(msg)) return '手上没有东西可放';
  // mineflayer-fixes 的英文错误供寻路器兼容 catch 识别；此处转换为回执文案。
  {
    const still = /no block has been placed\s*:\s*the block is still (\w+)/i.exec(msg);
    if (still) {
      return still[1] === 'air' || still[1] === 'undefined'
        ? '放下去了但那一格还是空的(服务端没接受这次放置)'
        : `放不上:那一格还是${zhName(still[1])}`;
    }
  }
  // 主物品栏共 36 格：9 格快捷栏和 27 格背包。
  if (/unable to withdraw.*inventory is full/i.test(msg)) return `背包 ${INVENTORY_SLOTS} 格全满了,取不出来`;
  if (/destination full/i.test(msg)) return '那一边没空位了(箱子满了或包满了)';
  if (/can't find .* in slots/i.test(msg)) return '窗口里已经找不到这样东西了';
  if (/fishing cancelled/i.test(msg)) return '浮标没了,这竿作废(被收走或钩到了别处)';
  return msg;
}

/** 受阻是谁说的:非 SkillBlocked 的一律算机器自己的问题 */
export function blockedSourceOf(err: unknown): 'server' | 'local' {
  return err instanceof SkillBlocked ? err.source : 'local';
}

/** build 的「她自己点格子」两形态(贴面 / 锚点);蓝图形态另走 skillBuildBlueprint */
export type PlaceCall = Extract<SkillCall, { skill: 'build'; material: string }>;
/** build 的蓝图形态 */
export type BlueprintCall = Extract<SkillCall, { skill: 'build'; blueprint: string }>;

/** heldItem 由调用方提供，供 use 未指定 item 时呈现实际手持物。 */
export function describeSkill(c: SkillCall, heldItem?: string | null): string {
  const tool = 'tool' in c && c.tool
    ? `(${c.tool === 'fastest' ? '最快工具' : `指定${zhName(c.tool)}`})`
    : '';
  switch (c.skill) {
    case 'goto': {
      const where = c.groundY ? `(${c.at[0]},${c.at[2]}) 的地表` : `坐标 ${anchorsText([c.at])}`;
      const dimension = c.dimension ? `[${zhDimension(c.dimension)}] ` : '';
      return c.dryRun ? `探路到 ${dimension}${where}` : `去${dimension}${where}`;
    }
    case 'transit': return `穿过 ${anchorsText([c.at])} 的下界传送门`;
    case 'goto_player': return `去 ${c.name} 身边`;
    case 'follow': return `跟着 ${c.name}`;
    case 'find': return c.direction
      ? `朝${DIRECTION_ZH[c.direction]}找${zhThing(c.target)}(最多 ${c.distance} 格${untilText(c.until)})`
      : `在周围 ${c.distance} 格内找${zhThing(c.target)}`;
    case 'flee': return `远离敌对生物(拉开 ${c.distance} 格)`;
    case 'surface': return '脱离水体或向上到露天';
    case 'collect': return `采集 ${c.count} 个${zhName(c.block)}${c.buried ? '(可挖过去)' : ''}${tool}`;
    case 'fish': return `钓一竿${c.at ? `(在 ${anchorsText([c.at])})` : ''}`;
    case 'build': {
      // 一步可以下 16 处;任务名每份快照都要重发一遍,列全就是 16 份坐标的常驻开销
      const head = c.dryRun ? '试算:' : '';
      const more = (n: number): string => (n > LABEL_SPOTS ? `等 ${n} 处` : '');
      if ('blueprint' in c) {
        const where = c.at ? `,锚点 ${anchorsText([c.at])}` : '';
        const stop = c.stopAfter === undefined ? '' : `,施工到第 ${c.stopAfter} 层`;
        return `${head}按蓝图「${c.blueprint}」施工${where}${stop}`;
      }
      if ('on' in c) {
        const where = c.on.slice(0, LABEL_SPOTS)
          .map((o) => `${anchorsText([o.at])} 的${FACE_ZH[o.face]}面`).join('、');
        return `${head}把${zhName(c.material)}贴着${where}${more(c.on.length)}放`;
      }
      if (!c.shape) {
        return `${head}把${zhName(c.material)}放到 ${anchorsText(c.anchors.slice(0, LABEL_SPOTS))}${more(c.anchors.length)}`;
      }
      return `${head}沿${SHAPE_ZH[c.shape]}搭${fillText(c)}${zhName(c.material)} ${anchorsText(c.anchors)}`;
    }
    case 'excavate': return `${c.dryRun ? '试算:' : ''}挖开${fillText(c)}${SHAPE_ZH[c.shape]} ${anchorsText(c.anchors)}${tool}`;
    case 'tunnel':
      return `${c.dryRun ? '试算:' : ''}挖${c.spiral ? '螺旋楼梯' : '通道'}到 ${anchorsText([c.at])}` +
        `${c.until && c.until.length > 0 ? `(${untilText(c.until).replace(/^,/, '')})` : ''}${tool}`;
    case 'probe': return `探查${fillText(c)}${SHAPE_ZH[c.shape]} ${anchorsText(c.anchors)}`;
    case 'use': {
      const what = c.item ? `用${zhName(c.item)}` : heldItem ? `用${zhName(heldItem)}` : '空手';
      const n = (c.times ?? 1) > 1 ? ` ${c.times} 次` : '';
      if (c.target) {
        if (c.index === undefined) return `${what}右键${zhEntity(c.target)}${n}`;
        return `按${zhEntity(c.target)}报价 ${c.index} 号成交${n}`;
      }
      if (c.text !== undefined && c.at) {
        return `在 ${anchorsText([c.at])} 的告示牌${c.back ? '背面' : ''}上写 ${signLinesText(c.text)}`;
      }
      if (c.at) return `${what}右键 ${anchorsText([c.at])}${n}`;
      return `${what}右键${n}`;
    }
    case 'craft':
      return c.grid
        ? `按自己摆的格子合成 ${c.count} 次(${gridText(c.grid)})`
        : `合成 ${c.count} 个${zhName(c.item ?? '')}`;
    case 'smelt':
      return `烧 ${c.count} 个${zhName(c.input)}(烧${zhName(c.fuel)})`;
    case 'brew':
      return `酿 ${c.count} 瓶${zhName(c.bottle)}(加${zhName(c.input)})`;
    case 'enchant':
      return c.index === undefined
        ? `看${zhName(c.item)}在 ${anchorsText([c.at])} 的附魔报价`
        : `给${zhName(c.item)}按第 ${c.index} 档附魔`;
    case 'eat': return DRINKABLES[c.item] ? `喝${DRINKABLES[c.item]!.label}` : `吃${zhName(c.item)}`;
    case 'ride': {
      if (c.off) return '从坐骑上下来';
      if (c.target && c.to) return `骑${zhEntity(c.target)}去 ${anchorsText([c.to])}`;
      if (c.target) return `骑上${zhEntity(c.target)}`;
      return `驾着坐骑去 ${anchorsText([c.to!])}`;
    }
    case 'anvil':
      return c.op === 'rename'
        ? `铁砧:给${zhName(c.item)}改名「${c.name}」`
        : `铁砧:把${zhName(c.item)}和${zhName(c.with ?? '')}合一起`;
    case 'grindstone':
      return `砂轮:磨${zhName(c.item)}${c.with ? `+${zhName(c.with)}` : ''}`;
    case 'attack': return `攻击${zhEntity(c.target)}${c.mode && c.mode !== 'auto' ? `(${c.mode})` : ''}`;
    case 'equip': {
      if (!c.item) return '把主手腾空';
      return equipDestOf(c.item) === 'hand' ? `拿出${zhName(c.item)}` : `穿上${zhName(c.item)}`;
    }
    case 'pickup': return c.item ? `捡起附近的${zhName(c.item)}` : '捡起附近的掉落物';
    case 'toss':
      return `扔掉 ${c.count} 个${zhName(c.item)}${c.at ? `,朝 ${anchorsText([c.at])}` : ''}`;
    case 'lead': {
      if (c.off) return '松开牵着的活物';
      const who = c.target ? zhEntity(c.target) : '牵着的活物';
      const tie = c.tie ? `,系到 ${anchorsText([c.tie])} 的栅栏上` : '';
      if (c.to) return `用拴绳把${who}牵去 ${anchorsText([c.to])}${tie}`;
      return c.tie ? `把${who}${tie.slice(1)}` : `用拴绳拴住${who}`;
    }
    case 'stow': return `把 ${c.count} 个${zhName(c.item)}存进箱子`;
    case 'take': {
      if (!c.at) return `从箱子取出 ${c.count ?? 1} 个${zhName(c.item!)}`;
      const spot = anchorsText([c.at]);
      return c.item ? `从 ${spot} 的容器取出 ${c.count ?? 1} 个${zhName(c.item)}` : `掏空 ${spot} 的容器`;
    }
    case 'chat': return `说: ${c.text}`;
  }
}

/** `until` 早停名单进任务描述的那半句;没声明就一个字都不加 */
export function untilText(until: readonly string[] | undefined): string {
  if (!until || until.length === 0) return '';
  return `,碰到${until.map((n) => (n.startsWith('#') ? n : zhName(n))).join('/')}就停`;
}

/** 她自己摆的合成格进任务描述的样子:按行写,空位写「·」 */
export function gridText(grid: string[][]): string {
  return grid.map((row) => row.map((n) => (n ? zhName(n) : '·')).join(' ')).join(' / ');
}

export const FILL_ZH: Record<BoxFill, string> = { solid: '实心', outline: '空壳', edges: '框架' };

/** 长方体的 fill 写入任务描述；其他形状返回空串。 */
export function fillText(c: { shape?: ShapeName; fill?: BoxFill }): string {
  return c.shape === 'box' ? FILL_ZH[c.fill ?? 'solid'] : '';
}

/** 任务名里最多列几处放置;再多只报处数(名字随每份快照重发) */
export const LABEL_SPOTS = 3;

/** 锚点序列进任务描述的样子:她写的原样;解析成哪一格由执行回执报 */
export function anchorsText(anchors: readonly Anchor[]): string {
  return anchors.map((a) => `(${a.join(',')})`).join('→');
}

/** 方块/物品名优先,实体名兜底:find 的 target 两类都收 */
export function zhThing(name: string): string {
  const asItem = zhName(name);
  return asItem !== name ? asItem : zhEntity(name);
}

/**
 * 期望进回执的样子。判据一律写成对世界的陈述,不带人称——这一句会出现在
 * 每一步的回执里,读的人要能不看调用就知道拿什么在量。
 */
export function describeExpect(e: Expectation): string {
  if ('has' in e) return `背包内${zhName(e.has.item)} ≥${e.has.count}`;
  if ('near' in e) return `距 (${e.near.join(',')}) ${e.within ?? NEAR_DEFAULT} 格内`;
  if ('holding' in e) return `主手持有${zhName(e.holding.item)}`;
  return `(${e.at.join(',')}) 为${zhName(e.block)}`;
}

/** expect 的评估结果:达成与否 + 两档实测值(短的进回执回显,长的进受阻说明) */
export interface ExpectVerdict {
  met: boolean;
  actual: string;
  /** 回显用的极短读数(一个数、一个物名、一个距离),与 describeExpect 同一量纲 */
  measured: string;
  /** 这一判是按**这一步的增量**下的(采集):读数与措辞都不是存量口径 */
  gain?: boolean;
}

/**
 * 核验达成与落空均逐步回执；readAt 是该步执行核验的实测时刻。
 * 任务终态可能晚于核验，回执重放原读数，不重读世界。
 */
export function verdictNote(e: Expectation, v: ExpectVerdict, readAt?: string): string {
  const what = v.gain && 'has' in e ? `这一步进包${zhName(e.has.item)} ≥${e.has.count}` : describeExpect(e);
  return `该步按「${what}」核验:${v.met ? '达成' : '落空'}`
    + `(实测 ${v.measured}${readAt ? `,读于 ${readAt}` : ''})`;
}

/** 动作受阻而目标已满足时，并列报告两项事实；既有存量不能证明本步产出。 */
export function blockedText(
  call: SkillCall,
  reason: string,
  expect: Expectation | null | undefined,
  verdict: ExpectVerdict | null,
  /** 受阻那一刻手里真正拿着什么;只用来给 use 的头部换主语(见 describeSkill) */
  heldItem?: string | null,
  /** 这份实测是什么时候读的(见 verdictNote) */
  readAt?: string,
): string {
  const head = `${describeSkill(call, heldItem)}没做成(${reason})`;
  if (!verdict || !expect) return head;
  if (!verdict.met) return `${head};${verdictNote(expect, verdict, readAt)}`;
  // 紧跟失败原因说明期望是否已满足，并区分已有存量与本步增量。
  if ('has' in expect) {
    if (verdict.gain) {
      return `${head};不过这一趟进包 ${verdict.measured} 个${zhName(expect.has.item)},` +
        `够这一步要的 ${expect.has.count} 个了`;
    }
    return `${head};不过包里现在有 ${verdict.measured} 个${zhName(expect.has.item)},` +
      `已经够这一步要的 ${expect.has.count} 个了 —— 没做成的是这一趟的动作,不是东西不够`;
  }
  return `${head};不过「${describeExpect(expect)}」这个条件现在本来就是满足的`
    + `(实测 ${verdict.measured}${readAt ? `,读于 ${readAt}` : ''})`;
}

/**
 * 这一步是不是卡在「东西」上。判据是受阻/缺口那句话里的固定字样,而这些字样全是
 * 执行器自己写死的措辞:`包里没有X`、`包里凑不齐`、`包里的货不够`、`包里没有任何食物`、
 * `背包 36 格全满了`、`包满了,没处放`,以及核验句里的 `背包内X ≥N`。
 * 走不过去、那一格不是箱子这类非物品受阻不在内。
 */
export function blockedOnItems(why: string): boolean {
  return ['包里', '包满了', '全满了', '背包内'].some((mark) => why.includes(mark));
}

/** 物品类受阻时附当前全量背包，与快照共用渲染，只报告事实。 */
export function bagNow(bot: Bot): string {
  const items: ItemStack[] = bot.inventory.items().map((it) => {
    const ench = readEnchants(it as never, bot.registry as never);
    return { name: it.name, count: it.count, ...(ench.length > 0 ? { enchantments: ench } : {}) };
  });
  return `\n[背包] ${items.length > 0 ? narrateInventory(items) : '空的'}`;
}

/** 空位跌到这个数(含)就该知道包快满了 */
export const BAG_LOW_FREE = 5;

/** 立牌/挂牌/墙上牌,十几种木头各一套,统一按后缀认。 */
export const SIGN_RE = /(^|_)(wall_)?(hanging_)?sign$/;

export const SIGN_LINE_MARKS = ['①', '②', '③', '④'];

/** 逐行显示牌面文字并注明行数；任务描述与回读共用格式。 */
export function signLinesText(text: string): string {
  const ls = text.split('\n');
  return `${ls.length} 行:${ls.map((l, i) => `${SIGN_LINE_MARKS[i] ?? `(${i + 1})`}${l === '' ? '(空行)' : l}`).join(' ')}`;
}

/** 耗时的人读写法:不到一秒给一位小数,不到一分钟报秒,再长报「3m20s」 */
export function fmtDur(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 > 0 ? `${s % 60}s` : ''}`;
}

export function contentsText(items: ItemStack[]): string {
  if (items.length === 0) return '空的';
  return items
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((i) => `${zhName(i.name)}×${i.count}`)
    .join('、');
}

/**
 * 现有的家伙什(含空手)挖了也不掉东西的材质,各自点名原版要哪一级。
 * 试算是"出发前"字面意义上的那一刻,挖掘等级这条事实本该在这里就说清。
 */
export function noDropMaterials(bot: Bot, reading: RegionReading): string[] {
  const toolTypes: Array<number | null> = [null, ...bot.inventory.items().map((i) => i.type)];
  const out: string[] = [];
  for (const [name, e] of reading.counts) {
    if (LIQUIDS.has(name)) continue;
    if (typeof e.sample.canHarvest !== 'function') continue;
    if (toolTypes.some((t) => e.sample.canHarvest(t))) continue;
    const need = minHarvestTool(bot, name);
    out.push(need ? `${zhName(name)}(要${zhName(need)}及以上)` : zhName(name));
  }
  return out;
}

/** 材质构成一句话:量大在前,矿石带最近坐标 */
export function compositionText(reading: RegionReading): string {
  const parts = [...reading.counts.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 10)
    .map(([name, e]) => {
      const spot = name.endsWith('_ore') ? `(最近的在 (${e.nearest.x}, ${e.nearest.y}, ${e.nearest.z}))` : '';
      return `${zhName(name)}×${e.n}${spot}`;
    });
  const rest = reading.counts.size - Math.min(reading.counts.size, 10);
  if (rest > 0) parts.push(`另有 ${rest} 种少量`);
  if (reading.air.length > 0) parts.push(`空气×${reading.air.length}`);
  return parts.length > 0 ? parts.join('、') : '什么都没有';
}

