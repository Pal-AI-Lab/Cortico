/** 实体元数据字段位置取自 registry.entitiesByName 的 metadataKeys。 */
import type { Bot } from 'mineflayer';
import { matchBlockIds } from './travel.ts';
import { zhName } from './names.ts';

export interface NamedStack { name?: string }

export interface FactEntity {
  name?: string;
  metadata?: unknown[];
}

export interface FactBot {
  entity?: { uuid?: string } | null;
  /** 登录时玩家 UUID 优先取 bot.player，其次取实体或协议客户端。 */
  player?: { uuid?: string } | null;
  _client?: { uuid?: string } | null;
  inventory?: { slots?: Array<NamedStack | null | undefined> };
  registry?: {
    entitiesByName?: Record<string, { metadataKeys?: string[] } | undefined>;
  };
}

export function metaOf(bot: FactBot, entity: FactEntity, key: string): unknown {
  const name = entity.name;
  if (!name) return undefined;
  const keys = bot.registry?.entitiesByName?.[name]?.metadataKeys ?? [];
  const at = keys.indexOf(key);
  return at >= 0 ? entity.metadata?.[at] : undefined;
}

/** 可驯服实体与对应道具。消耗道具只能证明使用发生，驯服结果须读取主人元数据。 */
export const TAME_ITEMS: Readonly<Record<string, readonly string[]>> = {
  wolf: ['bone'],
  cat: ['cod', 'salmon'],
  ocelot: ['cod', 'salmon'],
  parrot: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds', 'pitcher_pod'],
};

/** 繁殖交互使用的实体与食物表；物品消耗不作为幼体出生的证明。 */
export const FEED_ITEMS: Readonly<Record<string, readonly string[]>> = {
  cow: ['wheat'],
  mooshroom: ['wheat'],
  sheep: ['wheat'],
  goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion'],
  chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds', 'pitcher_pod'],
  // 1.20.5 起狼的食物是 #wolf_food 物品标签:全部生熟肉(含腐肉)+全部鱼类
  wolf: ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'rotten_flesh', 'cod', 'salmon', 'cooked_cod', 'cooked_salmon', 'tropical_fish', 'pufferfish'],
  cat: ['cod', 'salmon', 'tropical_fish', 'pufferfish'],
  horse: ['golden_carrot', 'golden_apple', 'hay_block'],
  donkey: ['golden_carrot', 'golden_apple', 'hay_block'],
  llama: ['hay_block'],
  armadillo: ['spider_eye'],
  panda: ['bamboo'],
  turtle: ['seagrass'],
  fox: ['sweet_berries', 'glow_berries'],
  bee: ['dandelion', 'poppy', 'sunflower'],
  frog: ['slime_ball'],
  sniffer: ['torchflower_seeds'],
  camel: ['cactus'],
  strider: ['warped_fungus'],
  hoglin: ['crimson_fungus'],
  axolotl: ['tropical_fish_bucket'],
};

/** 这只活物现在的主人 UUID;没被驯服/读不到元数据返回 null。 */
export function readTamedBy(bot: FactBot, entity: FactEntity): string | null {
  const raw = metaOf(bot, entity, 'owneruuid');
  // 协议把"没有主人"编成缺席的 optional;不同版本的 protodef 分别给 undefined/null/''
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string') return raw;
  // OptionalUUID 有时解成 { present, value } 或者裸的 UUID 对象
  const obj = raw as { value?: unknown; present?: unknown };
  if (obj.present === false) return null;
  const inner = obj.value ?? raw;
  return typeof inner === 'string' && inner !== '' ? inner : null;
}

/**
 * 主人 UUID 与当前玩家一致时返回 true；缺少任一身份时返回 false。
 * 登录阶段 bot.entity.uuid 可能缺失，优先使用 bot.player.uuid，并保留实体与协议客户端来源。
 */
export function tamedByMe(bot: FactBot, entity: FactEntity): boolean {
  const owner = readTamedBy(bot, entity);
  const me = bot.player?.uuid ?? bot.entity?.uuid ?? bot._client?.uuid;
  return owner !== null && typeof me === 'string' && me !== '' && owner === me;
}

/** TamableAnimal flags 的 0x01 位表示坐下；缺少该字段时返回 null。 */
export function readSitting(bot: FactBot, entity: FactEntity): boolean | null {
  const raw = metaOf(bot, entity, 'flags');
  if (typeof raw !== 'number') return null;
  return (raw & 0x01) !== 0;
}

/** 猪和炽足兽读取 saddle；马科读取 flags 的 0x04 位。字段不可用时返回 null。 */
export function readSaddled(bot: FactBot, entity: FactEntity): boolean | null {
  const direct = metaOf(bot, entity, 'saddle');
  if (typeof direct === 'boolean') return direct;
  if (typeof direct === 'number') return direct !== 0;
  if (entity.name === 'horse' || entity.name === 'donkey' || entity.name === 'mule') {
    const flags = metaOf(bot, entity, 'flags');
    return typeof flags === 'number' ? (flags & 0x04) !== 0 : null;
  }
  return null;
}

/** 马科的「驯服」位:'flags' 的 0x02。不是马科或读不到返回 null。 */
export function readHorseTamed(bot: FactBot, entity: FactEntity): boolean | null {
  if (entity.name !== 'horse' && entity.name !== 'donkey' && entity.name !== 'mule') return null;
  const flags = metaOf(bot, entity, 'flags');
  return typeof flags === 'number' ? (flags & 0x02) !== 0 : null;
}

/** 羊毛元数据的低四位是颜色,第五位(0x10)是"剪过了"。 */
export const WOOL_COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
] as const;

/** 染料 item 名 → 颜色名;不是染料返回 null。 */
export function dyeColorOf(item: string | null | undefined): string | null {
  if (!item || !item.endsWith('_dye')) return null;
  const color = item.slice(0, -'_dye'.length);
  return (WOOL_COLORS as readonly string[]).includes(color) ? color : null;
}

/** 这只羊现在的颜色;读不到返回 null。 */
export function readSheepColor(bot: FactBot, entity: FactEntity): string | null {
  const raw = metaOf(bot, entity, 'wool');
  if (typeof raw !== 'number') return null;
  return WOOL_COLORS[raw & 0x0f] ?? null;
}
/** 可攻击目标名限定为实体类型 ID 或在线玩家名。 */
/** use.target 只接受活物；无效目标的回执说明可接受类型及改用 at 的方块写法。 */
export function unknownUseTargetText(bot: Bot, target: string): string {
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

export function isKnownTarget(bot: Bot, name: string): boolean {
  const n = name.toLowerCase();
  const entities = (bot.registry as unknown as { entitiesByName?: Record<string, unknown> }).entitiesByName;
  if (entities?.[n]) return true;
  return Object.keys(bot.players ?? {}).some((p) => p.toLowerCase() === n);
}

