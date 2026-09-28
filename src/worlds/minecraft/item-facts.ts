/**
 * 读取物品的附魔与耐久，支持组件数据和 NBT。
 * 当前 1.20.6 注册表的 maxDurability 数据不完整，耐久上限使用下方原版公式表。
 */

/** 附魔 ID 去掉 minecraft: 前缀；level 为数值等级。 */
export interface ItemEnchant {
  name: string;
  level: number;
}

/** 剩余耐久与上限,单位是原版的「点」 */
export interface Durability {
  left: number;
  max: number;
}

export interface ItemLike {
  name: string;
  count?: number;
  componentMap?: Map<string, { type?: string; data?: unknown }>;
  nbt?: unknown;
}

export interface EnchantRegistry {
  enchantments?: Record<number, { name?: string } | undefined>;
}

const TOOL_MAX: Record<string, number> = {
  wooden: 59, stone: 131, iron: 250, golden: 32, diamond: 1561, netherite: 2031,
};
const TOOL_KIND = new Set(['pickaxe', 'axe', 'shovel', 'hoe', 'sword']);

/** 盔甲耐久 = 材质基数 × 部位系数(原版公式) */
const ARMOR_BASE: Record<string, number> = {
  leather: 5, chainmail: 15, iron: 15, golden: 7, diamond: 33, netherite: 37,
};
const ARMOR_SLOT: Record<string, number> = {
  helmet: 11, chestplate: 16, leggings: 15, boots: 13,
};

/** 不按材质×部位算的那几件 */
const WHOLE_MAX: Record<string, number> = {
  shield: 336, bow: 384, crossbow: 465, trident: 250, elytra: 432,
  fishing_rod: 64, flint_and_steel: 64, shears: 238, brush: 64,
  carrot_on_a_stick: 25, warped_fungus_on_a_stick: 100,
  turtle_helmet: 275,
};

/** 这件东西的耐久上限;不带耐久的物品返回 null */
export function maxDurabilityOf(id: string): number | null {
  const name = id.replace(/^minecraft:/, '');
  const whole = WHOLE_MAX[name];
  if (whole !== undefined) return whole;
  const cut = name.lastIndexOf('_');
  if (cut < 0) return null;
  const head = name.slice(0, cut);
  const tail = name.slice(cut + 1);
  if (TOOL_KIND.has(tail) && TOOL_MAX[head] !== undefined) return TOOL_MAX[head];
  const slot = ARMOR_SLOT[tail];
  const base = ARMOR_BASE[head];
  if (slot !== undefined && base !== undefined) return base * slot;
  return null;
}

function componentData(item: ItemLike, type: string): unknown {
  return item.componentMap?.get(type)?.data;
}

/** NBT compound 里取一个键的裸值;层级对不上就返回 undefined */
function nbtValue(node: unknown, key: string): unknown {
  const v = (node as { value?: Record<string, { value?: unknown }> } | undefined)?.value;
  return v?.[key]?.value;
}

/** 已损耗的耐久点数;读不到返回 null(与「没损耗」是两回事) */
export function readDamage(item: ItemLike): number | null {
  const comp = componentData(item, 'damage');
  if (typeof comp === 'number') return comp;
  const raw = nbtValue(item.nbt, 'Damage');
  return typeof raw === 'number' ? raw : null;
}

/** 剩余耐久；不带耐久的物品返回 null。缺失 damage 组件或 NBT Damage 字段按零损耗处理。 */
export function readDurability(item: ItemLike): Durability | null {
  const max = maxDurabilityOf(item.name);
  if (max === null) return null;
  return { left: Math.max(0, max - (readDamage(item) ?? 0)), max };
}

/** 从 stored_enchantments 和 enchantments 读取附魔。 */
export function readEnchants(item: ItemLike, registry?: EnchantRegistry | null): ItemEnchant[] {
  const out: ItemEnchant[] = [];
  for (const type of ['enchantments', 'stored_enchantments']) {
    const data = componentData(item, type) as { enchantments?: Array<{ id?: unknown; level?: unknown }> } | undefined;
    for (const e of data?.enchantments ?? []) {
      const name = enchantName(e.id, registry);
      if (name !== null && typeof e.level === 'number') out.push({ name, level: e.level });
    }
  }
  if (out.length > 0) return out;
  for (const key of ['Enchantments', 'StoredEnchantments']) {
    const list = nbtValue(item.nbt, key) as { value?: Array<Record<string, { value?: unknown }>> } | undefined;
    for (const e of list?.value ?? []) {
      const name = enchantName(e.id?.value, registry);
      const lvl = e.lvl?.value;
      if (name !== null && typeof lvl === 'number') out.push({ name, level: lvl });
    }
  }
  return out;
}

/** 附魔 id 可能是字符串(NBT 时代)或注册表序号(组件时代);查不出名字就不报这一条 */
function enchantName(id: unknown, registry?: EnchantRegistry | null): string | null {
  if (typeof id === 'string') return id.replace(/^minecraft:/, '');
  if (typeof id !== 'number') return null;
  return registry?.enchantments?.[id]?.name ?? null;
}

/** 已开图地图的编号(map_id 组件或旧版 NBT 的 map);空地图和别的物品返回 null */
export function readMapId(item: ItemLike): number | null {
  const comp = componentData(item, 'map_id');
  if (typeof comp === 'number') return comp;
  const raw = nbtValue(item.nbt, 'map');
  return typeof raw === 'number' ? raw : null;
}

/**
 * 原版 1.20.6 药水注册表,下标即序号(服务端 --reports 的 registries.json 核对过)。
 * minecraft-data 不带这张表。long_/strong_ 念成基础名加「延长」「II」。
 */
const POTION_KINDS = [
  'water', 'mundane', 'thick', 'awkward', 'night_vision', 'long_night_vision', 'invisibility',
  'long_invisibility', 'leaping', 'long_leaping', 'strong_leaping', 'fire_resistance',
  'long_fire_resistance', 'swiftness', 'long_swiftness', 'strong_swiftness', 'slowness',
  'long_slowness', 'strong_slowness', 'turtle_master', 'long_turtle_master', 'strong_turtle_master',
  'water_breathing', 'long_water_breathing', 'healing', 'strong_healing', 'harming', 'strong_harming',
  'poison', 'long_poison', 'strong_poison', 'regeneration', 'long_regeneration', 'strong_regeneration',
  'strength', 'long_strength', 'strong_strength', 'weakness', 'long_weakness', 'luck', 'slow_falling',
  'long_slow_falling', 'wind_charged', 'weaving', 'oozing', 'infested',
] as const;

const POTION_ZH: Record<string, string> = {
  water: '水瓶', mundane: '平凡的药水', thick: '浓稠的药水', awkward: '粗制的药水',
  night_vision: '夜视', invisibility: '隐身', leaping: '跳跃', fire_resistance: '抗火',
  swiftness: '迅捷', slowness: '缓慢', turtle_master: '神龟', water_breathing: '水肺',
  healing: '治疗', harming: '伤害', poison: '剧毒', regeneration: '再生', strength: '力量',
  weakness: '虚弱', luck: '幸运', slow_falling: '缓降', wind_charged: '蓄风', weaving: '盘丝',
  oozing: '渗浆', infested: '寄生',
};

/** 药水内容的中文名:「水瓶」「粗制的药水」「抗火·延长」「力量II」;不是药水或读不到返回 null */
export function readPotionName(item: ItemLike): string | null {
  const id = readPotionId(item);
  if (id === null) return null;
  const kind = POTION_KINDS[id];
  if (!kind) return `内容 #${id}`;
  const base = kind.replace(/^(long|strong)_/, '');
  const zh = POTION_ZH[base] ?? base;
  if (kind.startsWith('long_')) return `${zh}·延长`;
  if (kind.startsWith('strong_')) return `${zh}II`;
  return zh;
}

/** 读取药水内容的注册表序号；缺失时返回 null。名字见 readPotionName。 */
export function readPotionId(item: ItemLike): number | null {
  const data = componentData(item, 'potion_contents') as { potionId?: unknown } | undefined;
  return typeof data?.potionId === 'number' ? data.potionId : null;
}

/** 一样能喝下去、但不给饱食度的东西 */
interface Drinkable {
  /** 回执里的量词说法:「喝了一桶奶」 */
  label: string;
  /** 喝完剩在包里的空容器物品 id */
  empty: string;
  /** 消耗后的效果说明。 */
  effect: string;
}

/** 补充 foods 表未包含、但 Mineflayer consume() 支持的无饱食度饮品。 */
export const DRINKABLES: Readonly<Record<string, Drinkable>> = {
  milk_bucket: {
    label: '一桶奶',
    empty: 'bucket',
    effect: '身上的状态效果被清光(增益也一起清掉)',
  },
};
