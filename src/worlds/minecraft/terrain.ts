/**
 * 世界快照与文本渲染(纯逻辑)。
 *
 * `WorldSnapshot` 是从 mineflayer bot 抽出的平面数据。抽取(`snapshotFromBot`)
 * 刻意薄:所有判断(什么算显著、怎么措辞)都在纯函数侧,可直接单测。
 *
 * 渲染出口是 `narrateWorld`:一律中文、写成话,进世界快照事件与其余事件正文。
 */
import { Vec3 } from 'vec3';
import { nowIso } from '../../core/util.ts';
import {
  type Durability, type ItemEnchant, type ItemLike, readDurability, readEnchants, readPotionName,
} from './item-facts.ts';
import {
  roman, VILLAGER_PROFESSION_ZH, zhBiome, zhDimension, zhEffect, zhEnchant, zhEntity, zhName,
} from './names.ts';
import { piglinIsHostile } from './piglin.ts';

/** 八方位罗盘。北=-z 南=+z 东=+x 西=-x,与 move 技能同一套词。 */
export type Direction =
  | 'north' | 'south' | 'east' | 'west'
  | 'northeast' | 'northwest' | 'southeast' | 'southwest';

export const DIRECTIONS: Record<Direction, [number, number]> = {
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  northeast: [1, -1], northwest: [-1, -1], southeast: [1, 1], southwest: [-1, 1],
};

export const DIRECTION_ZH: Record<Direction, string> = {
  north: '北', south: '南', east: '东', west: '西',
  northeast: '东北', northwest: '西北', southeast: '东南', southwest: '西南',
};

const COMPASS: Direction[] = [
  'south', 'southwest', 'west', 'northwest', 'north', 'northeast', 'east', 'southeast',
];

/** XZ 位移 → 八方位。原地(dx=dz=0)返回 null。 */
export function bearing(dx: number, dz: number): Direction | null {
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return null;
  // atan2(-dx, dz) 让 +z(南) 落在 0,顺时针每 45° 一格
  const angle = Math.atan2(-dx, dz) * (180 / Math.PI);
  const idx = Math.round(((angle % 360) + 360) % 360 / 45) % 8;
  return COMPASS[idx];
}

/** 视线偏航角(mineflayer 的 yaw) → 八方位 */
export function facingOf(yaw: number): Direction {
  return bearing(-Math.sin(yaw), Math.cos(yaw)) ?? 'south';
}

/**
 * 视线偏航角 → 罗盘度数,北=0 东=90 南=180 西=270。
 * 八方位只有 45° 的分辨率;转头 20° 画面就换了一半,度数才对得上。
 */
export function facingDegrees(yaw: number): number {
  const deg = (Math.atan2(-Math.sin(yaw), -Math.cos(yaw)) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360);
}

/** 俯仰(mineflayer 的 pitch,弧度,正数是低头) → 一句话;平视返回 null */
export function pitchPhrase(pitch: number): string | null {
  const deg = (pitch * 180) / Math.PI;
  if (deg > 45) return '几乎盯着脚下';
  if (deg > 20) return '低头看着地面';
  if (deg < -45) return '仰头看天';
  if (deg < -20) return '抬头往上看';
  return null;
}

/** 运动状态:由速度与落地判断,不猜 */
type Motion = 'still' | 'walking' | 'sprinting' | 'swimming' | 'falling' | 'rising';

interface EntityInfo {
  name: string;
  kind: 'player' | 'hostile' | 'animal' | 'other';
  distance: number;
  /** 相对我的水平方位;正上下方为 null */
  direction: Direction | null;
  /** 相对我的高度差,四舍五入到格 */
  dy: number;
  /** 主视角射线可及(false = 只听得见动静,渲染时不给精确距离坐标) */
  visible: boolean;
  /** 掉落物实体上读到的物品;没有元数据时缺省 */
  item?: ItemStack;
  /** 一眼可见的身份注(村民职业/小孩);没有就缺省 */
  note?: string;
}

export interface ItemStack {
  name: string;
  count: number;
  /** 这一摞身上的附魔;没附魔的物品不填。附魔件不可堆叠,每件占一格 */
  enchantments?: ItemEnchant[];
  /** 药水、喷溅药水、滞留药水、药箭装的是什么(readPotionName);别的物品不填 */
  potion?: string;
}

/** 装备槽。手上那件走 `heldItem`,这里只收穿在身上的与副手 */
export type GearSlot = 'head' | 'chest' | 'legs' | 'feet' | 'offhand';

export interface GearPiece {
  slot: GearSlot;
  name: string;
  /** 不带耐久的物品(南瓜头)、或损耗读不到时为 null */
  durability: Durability | null;
  enchantments: ItemEnchant[];
}

interface StatusEffect {
  /** minecraft-data 的 effect name(驼峰) */
  name: string;
  /** 原版 amplifier + 1,即她看见的那个罗马数字的值 */
  level: number;
  /** 剩余秒数;信标那种一直续的照报当刻读数 */
  seconds: number;
}

export interface WorldSnapshot {
  position: { x: number; y: number; z: number };
  dimension: string;
  health: number;
  food: number;
  oxygen: number;
  /** 头部在水中(氧气只有此时才有意义,元数据在旱地上会残留旧值) */
  inWater: boolean;
  /** 物品栏已从服务器同步到(登录后 window_items 未到之前不能把空栏当空) */
  invSynced: boolean;
  /** 0–24000;13000–23000 为夜 */
  timeOfDay: number;
  /** 抽这份快照时的现实时刻,部署时区的 nowIso 串;与游戏内的 timeOfDay 无关 */
  realTime: string;
  /** 她周身那一小片连通空间的亮度众数,0–15;采不到样时为 null */
  light: number | null;
  raining: boolean;
  biome: string;
  gameMode: string;
  heldItem: string | null;
  inventory: ItemStack[];
  /** 经验条上那个整数;附魔的门槛按它算 */
  xpLevel: number;
  /** 穿在身上的与副手,空槽不占条目 */
  equipment: GearPiece[];
  /** 身上的状态效果,空着就没有条目 */
  effects: StatusEffect[];
  /** 近处实体,按距离升序,已截断 */
  entities: EntityInfo[];
  /** 截断掉了几条:她无从分辨"没报"是没有还是没给,这个数把两者分开 */
  entitiesOmitted: number;
  /** 脚下方块 */
  standingOn: string | null;
  /** 周围可见方块种类摘要(种类 → 最近的那一块;容器可多块);带绝对坐标 */
  nearbyBlocks: Array<{
    name: string; distance: number; direction: Direction | null; dy: number;
    x: number; y: number; z: number;
    /** 容器账本:数组=上次看见的内容,null=没开过;非容器不填 */
    contents?: ItemStack[] | null;
    /** 作物龄期:原版 age 方块状态的原值与满龄,不归一化;仅农作物填 */
    age?: { value: number; max: number };
    /** 耕地水分:原版 moisture 方块状态的原值与满值(0–7),不折成布尔;仅耕地填 */
    moisture?: { value: number; max: number };
  }>;
  players: string[];
  /** 8 向 8 格外的地形起伏采样;平地和未加载方向不占条目 */
  terrain: TerrainSample[];
  /** 这一份有没有扫过方块与地形;false = 没扫,不是"扫了没有" */
  blocksScanned: boolean;
  /** 正在怎么动 */
  motion: Motion;
  /** 水平速度(格/秒),用来说"走"还是"跑" */
  speed: number;
  /** 视线朝向 */
  facing: Direction;
  /** 正在往哪个方向移动;没动为 null */
  heading: Direction | null;
  onGround: boolean;
}

/** `unloaded` = 那个方向的区块没加载,没读到;与"读到了、是平的"不是一回事 */
type TerrainKind = 'up' | 'down' | 'water' | 'solid' | 'unloaded';

interface TerrainSample {
  direction: Direction;
  /** 那边的落脚面相对我脚下的高差(格);solid/water 时为参考值 */
  dy: number;
  kind: TerrainKind;
}

export function isNight(timeOfDay: number): boolean {
  return timeOfDay >= 13000 && timeOfDay < 23000;
}

/**
 * 现实世界的此刻,报到分。她在直播:游戏里的昼夜与现实几点是两件事,
 * 而"播了多久""是不是该收了"只有后者答得上。
 */
function realTimePhrase(realTime: string): string {
  const month = Number(realTime.slice(5, 7));
  const day = Number(realTime.slice(8, 10));
  return `现实世界现在是 ${month} 月 ${day} 日 ${realTime.slice(11, 16)}。`;
}

export function timePhrase(timeOfDay: number): string {
  if (timeOfDay < 1000) return '清晨';
  if (timeOfDay < 6000) return '上午';
  if (timeOfDay < 9000) return '正午前后';
  if (timeOfDay < 12000) return '下午';
  if (timeOfDay < 13000) return '黄昏';
  if (timeOfDay < 18000) return '深夜';
  if (timeOfDay < 23000) return '后半夜';
  return '黎明前';
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** 天黑之后天光照不亮东西:眼睛看到的亮度要按这个数扣 */
const NIGHT_SKY_PENALTY = 11;
/** 众数落在这个数以内才算"全黑":0 是纯黑,1 也已经什么都看不见 */
const DARK_LIGHT = 1;

/**
 * 周身黑不黑。采不到样(null)不算黑:读不到与真的黑分不开时不猜。
 * 快照那句话与照明维持条件的触发用的是同一个判据。
 */
export function isDark(light: WorldSnapshot['light']): boolean {
  return light !== null && light <= DARK_LIGHT;
}

/**
 * 周身黑不黑,只报这一件事。
 *
 * 不报具体读数:几点几她不用关心,能不能看见才是。亮的时候一个字都不加,
 * 只有她周身那一小片连通空间的亮度众数(见 `sampleLight`)确实压到 ≤1 才说这一句。
 */
function lightPhrase(light: WorldSnapshot['light']): string {
  return isDark(light) ? '四周一片漆黑，什么都看不见。' : '';
}

function healthPhrase(h: number): string {
  if (h >= 20) return '状态很好';
  if (h >= 15) return '还算精神';
  if (h >= 10) return '受了点伤';
  if (h >= 6) return '伤得不轻';
  return '快撑不住了';
}

function foodPhrase(f: number): string {
  if (f >= 18) return '不饿';
  if (f >= 10) return '有点饿';
  if (f >= 6) return '饿了';
  return '快饿坏了';
}

function motionPhrase(s: WorldSnapshot): string {
  const where = s.heading ? `朝${DIRECTION_ZH[s.heading]}` : '';
  switch (s.motion) {
    case 'still': return '我站着没动';
    case 'walking': return `我正${where}走着`;
    case 'sprinting': return `我正${where}跑着`;
    case 'swimming': return `我正${where}游着`;
    case 'falling': return '我正在往下掉';
    case 'rising': return '我正在往上浮';
  }
}

/** 某个东西在我的哪个方向、多远;高度差明显时点出来 */
function whereIs(direction: Direction | null, distance: number, dy: number): string {
  const vertical = dy >= 3 ? '上方' : dy <= -3 ? '下方' : '';
  if (!direction) return vertical ? `正${vertical} ${fmt(distance)} 格` : '就在脚边';
  return `${DIRECTION_ZH[direction]}边${vertical} ${fmt(distance)} 格`;
}

/**
 * 快照的一段:语义同类且更新节奏同档的字段聚在一段。
 * `cmp` 是比对键——显示抖动(动物乱走半格、地形采样毛刺)已量化掉,
 * 键不同才算"这段变了";显示文本在判定变了之后用当刻新鲜值。
 */
interface SnapshotSegment {
  key: 'place' | 'clock' | 'realclock' | 'body' | 'gear' | 'equip' | 'life' | 'structure' | 'terrain' | 'players';
  /** 完整句子;空串=本段当下无内容(目前只有 structure 可能为空) */
  text: string;
  cmp: string;
}

/** 距离量化到 2 格档(比对键用) */
function distBucket(d: number): number {
  return Math.round(d / 2);
}

/** 高度差量化成三档,与 whereIs 的 ±3 格口径一致 */
function dyBand(dy: number): string {
  return dy >= 3 ? '高' : dy <= -3 ? '低' : '平';
}

/**
 * 世界快照正文,按段给出(分段去重的数据源)。一律中文,写成话:
 * 在哪、现在什么时辰、身上什么情况、带着什么、周围有什么、地形如何。
 */
/**
 * 快照实质变化指纹；位置按调用方阈值单独比较，重生点由 World 加入比对键。
 * 血量向上取整、饥饿四舍五入；敌对生物只计可见者数量及最近者的方向、距离档。
 * 掉落物与和平生物不计入，避免持续移动触发快照。
 */
export function snapshotFingerprint(s: WorldSnapshot): string {
  const hostiles = s.entities.filter((e) => e.kind === 'hostile' && e.visible);
  const nearest = hostiles.length > 0
    ? hostiles.reduce((a, b) => (a.distance <= b.distance ? a : b))
    : null;
  return [
    s.dimension, s.gameMode,
    `hp${Math.ceil(s.health)}`, `fd${Math.round(s.food)}`,
    s.inWater ? `o${Math.round(s.oxygen)}` : 'dry',
    timePhrase(s.timeOfDay), isNight(s.timeOfDay) ? 'night' : 'day',
    s.raining ? 'rain' : 'clear',
    s.light === null ? 'l?' : `l${s.light}`,
    s.invSynced ? 'inv' : 'nosync',
    s.heldItem ?? 'bare',
    s.inventory.map((i) => `${i.name}x${i.count}`).sort().join(','),
    // 穿着什么、身上有什么效果:一件盔甲耗尽消失、中毒开始与抗火到期都不是她下的令,
    // 快照不报她就无从知道。耐久与剩余秒不进(每秒都在动,进了这道闸就等于没有)
    s.equipment.map((p) => `${p.slot}:${p.name}`).sort().join(','),
    s.effects.map((e) => `${e.name}${e.level}`).sort().join(','),
    s.standingOn ?? 'air', s.biome,
    `hostile${hostiles.length}${nearest ? `@${nearest.direction ?? '-'}${distBucket(nearest.distance)}` : ''}`,
  ].join('|');
}

/**
 * `prevBag` 是上一份**真发出去**的快照里的背包;给了就只印与它不同的条目,
 * 不给(全量锚那一拍、还没有基线)就整份印。比对键与它无关,始终按当刻存量算 ——
 * 否则"变了一次之后就不再重发"或"没变却每拍重发"两头都会出。
 */
export function narrateWorldSegments(
  s: WorldSnapshot,
  near?: string | null,
  prevBag?: ItemStack[] | null,
): SnapshotSegment[] {
  const p = s.position;
  const segs: SnapshotSegment[] = [];

  // 报我脚下那一格的整数格坐标:她写 at/anchors 用的就是这个口径,
  // 中间不该再插一次她自己做的取整(-31.5 向下取整是 -32,四舍五入会给出 -31)
  //
  // `near` 是坐标的相对化(「离「家」82 格」),由持有路标表的 World 算好递进来 ——
  // 路标是她投影进来的暂态语义,不是世界读数,进不了 WorldSnapshot(与重生点、
  // 目标尾行同一个待遇)。没有近处路标时这一段一个字都不占。
  const place =
    `我在${zhBiome(s.biome)}，脚下是${s.standingOn ? zhName(s.standingOn) : '空的'}，` +
    `站在格 (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})${near ? `，${near}` : ''}，` +
    `${zhDimension(s.dimension)}。` +
    `${motionPhrase(s)}，面朝${DIRECTION_ZH[s.facing]}。`;
  segs.push({ key: 'place', text: place, cmp: place });

  const night = isNight(s.timeOfDay);
  const rain = s.raining ? '，在下雨' : '';
  const clock = `现在是${timePhrase(s.timeOfDay)}${night ? '，天黑着' : ''}${rain}。`;
  // 时辰、天候、明暗是同一类环境读数;明暗只有"黑/不黑"两态,那句话本身就是比对键
  const lit = lightPhrase(s.light);
  segs.push({
    key: 'clock',
    text: lit ? `${clock}${lit}` : clock,
    cmp: `${clock}|${lit}`,
  });

  // 自成一段:现实时钟每分钟都在走,与几个游戏小时才翻一次的时辰不同档,
  // 混在一段里会把整段环境读数拖着一起重发
  const real = realTimePhrase(s.realTime);
  segs.push({ key: 'realclock', text: real, cmp: real });

  const oxygen = s.inWater && s.oxygen < 20 ? `，泡在水里，氧气还剩 ${Math.round(s.oxygen)}/20` : '';
  const body =
    `${healthPhrase(s.health)}（生命 ${Math.ceil(s.health)}/20），` +
    `${foodPhrase(s.food)}（饥饿 ${Math.round(s.food)}/20）${oxygen}。`;
  segs.push({ key: 'body', text: body, cmp: body });

  const bagFull = s.inventory.length > 0
    ? `包里有：${narrateInventory(s.inventory)}。`
    : '包里什么都没有。';
  let gear: string;
  if (s.invSynced) {
    const held = s.heldItem ? `手里拿着${zhName(s.heldItem)}` : '两手空空';
    gear = `${held}。${prevBag ? narrateBagChange(prevBag, s.inventory) : bagFull}`;
  } else {
    gear = '背包还在从服务器同步，这份清单还没到。';
  }
  segs.push({
    key: 'gear',
    text: gear,
    cmp: s.invSynced ? `${s.heldItem ?? 'bare'}|${bagFull}` : 'nosync',
  });

  // 装备与状态自成一段:背包每挖一块土就变,盔甲与效果几十分钟才动一次,
  // 混进 gear 段等于四个槽位每拍重印一遍
  segs.push({ key: 'equip', text: narrateEquip(s), cmp: equipCmp(s) });

  const seen = s.entities.filter((e) => e.visible);
  const heard = s.entities.filter((e) => !e.visible);
  const seenMobs = seen.filter((e) => !isDroppedItem(e));
  const seenDrops = seen.filter((e) => isDroppedItem(e));
  const lifeLines: string[] = [];
  if (seenMobs.length > 0) {
    lifeLines.push(
      '看得见的：' +
        seenMobs
          .map((e) => {
            const tag = e.kind === 'hostile' ? '（会打我）' : e.kind === 'player' ? '（玩家）' : e.note ? `（${e.note}）` : '';
            return `${whereIs(e.direction, e.distance, e.dy)}有${zhEntity(e.name)}${tag}`;
          })
          .join('、') +
        '。',
    );
  }
  if (s.entitiesOmitted > 0) lifeLines.push(`另有 ${s.entitiesOmitted} 个更远的没列进来。`);
  lifeLines.push(...narrateDrops(seenDrops));
  if (heard.length > 0) {
    // 隔着方块只给方位不给距离坐标:听声辨位有这个精度,没有那个精度
    const sounds = [...new Set(heard.map(
      (e) => `${e.direction ? DIRECTION_ZH[e.direction] + '边' : '附近'}有${zhEntity(e.name)}的动静`,
    ))];
    lifeLines.push(`听得见动静的：${sounds.join('、')}。`);
  }
  const lifeCmp = [
    ...seenMobs.map((e) => `见:${e.name}${e.note ? `(${e.note})` : ''}|${e.direction ?? '脚边'}|${distBucket(e.distance)}|${dyBand(e.dy)}`).sort(),
    ...seenDrops.map((e) =>
      `落:${e.item?.name ?? 'item'}|${e.direction ?? '脚边'}|${distBucket(e.distance)}|${dyBand(e.dy)}|${e.item?.count ?? 1}`,
    ).sort(),
    ...[...new Set(heard.map((e) => `闻:${e.name}|${e.direction ?? '附近'}`))].sort(),
  ].join(';');
  segs.push({ key: 'life', text: lifeLines.join('\n'), cmp: lifeCmp });

  const structLines: string[] = [];
  // 「根本没扫」与「扫过没看见」必须分开说:把前者说成"没有"就是让她在错误
  // 世界观上做正确推理,那种错不会报错,只会把她带进死路。遮挡那一条不在这里
  // 重复——常驻前缀(ENV_PROMPT.md)每轮都在说
  if (!s.blocksScanned) {
    structLines.push('这一份没扫方块和地形，周围有什么不知道。');
  } else {
    structLines.push(
      s.nearbyBlocks.length > 0
        ? '看得见的：' +
            s.nearbyBlocks
              .map((b) => `${whereIs(b.direction, b.distance, b.dy)}是${zhName(b.name)}${blockSuffix(b)}`)
              .join('、') +
            '。'
        : '16 格内露出来的只有天然地形。',
    );
  }
  const structCmp = s.nearbyBlocks.map((b) =>
    `块:${b.name}|${b.direction ?? '脚边'}|${distBucket(b.distance)}|${dyBand(b.dy)}|${contentsCmp(b.contents)}|${stateCmpOf(b)}`,
  ).sort().join(';');
  segs.push({ key: 'structure', text: structLines.join('\n'), cmp: structCmp });

  // 地形独立成段，比对键固定为常量，只随全量锚出现，不随近处方块变化重发。
  let terrainText = '';
  if (s.terrain.length > 0) {
    const solids = s.terrain.filter((t) => t.kind === 'solid');
    const unloaded = s.terrain.filter((t) => t.kind === 'unloaded');
    const rest = s.terrain.filter((t) => t.kind !== 'solid' && t.kind !== 'unloaded');
    const seg: string[] = [];
    // 地下常态是八向全实心,逐向罗列没有信息量
    if (solids.length >= 6) seg.push('四面八方基本都是实心山体');
    else seg.push(...solids.map((t) => `${DIRECTION_ZH[t.direction]}边是实心山体`));
    seg.push(...rest.map((t) => {
      const d = DIRECTION_ZH[t.direction];
      switch (t.kind) {
        case 'up': return `${d}边高出约 ${t.dy} 格`;
        case 'down': return t.dy <= -(TERRAIN_DOWN + 1) ? `${d}边是深沟或悬崖` : `${d}边低 ${-t.dy} 格`;
        case 'water': return `${d}边是水面`;
        default: return undefined;
      }
    }).filter((x): x is string => x !== undefined));
    // 采到了、是平的 ≠ 根本没采到。八向都有条目时两者都不存在
    const tails: string[] = [];
    if (unloaded.length > 0) {
      tails.push(`${unloaded.map((t) => DIRECTION_ZH[t.direction]).join('、')}边区块没加载，没读到`);
    }
    const covered = new Set(s.terrain.map((t) => t.direction));
    const flat = (Object.keys(DIRECTIONS) as Direction[]).filter((d) => !covered.has(d));
    if (flat.length > 0) tails.push(`${flat.map((d) => DIRECTION_ZH[d]).join('、')}边读到了，是平的`);
    terrainText = `地形：${seg.join('、')}${tails.length > 0 ? `；${tails.join('；')}` : ''}。`;
  }
  segs.push({ key: 'terrain', text: terrainText, cmp: '地形只随全量锚发' });

  // players 里已经不含我自己(抽快照时连同摄像机一起滤掉了)
  const others = s.players.filter(Boolean);
  segs.push({
    key: 'players',
    text: others.length > 0 ? `服务器上还有：${others.join('、')}。` : '服务器上只有我一个人。',
    cmp: [...others].sort().join('、'),
  });
  return segs;
}

/**
 * 世界快照事件与其余事件正文那一份(全量形态):各段按序拼接。
 */
export function narrateWorld(s: WorldSnapshot, near?: string | null): string {
  return narrateWorldSegments(s, near).map((g) => g.text).filter(Boolean).join('\n');
}

function isDroppedItem(e: EntityInfo): boolean {
  return e.name === 'item' || e.name === 'Item' || e.name === 'item_stack' || e.item != null;
}

function dropLabel(stack: ItemStack | undefined): string {
  const name = stack?.name && stack.name !== 'item' ? zhName(stack.name) : zhEntity('item');
  return `${name}×${stack?.count ?? 1}`;
}

function dropWhere(e: EntityInfo): string {
  if (!e.direction && Math.abs(e.dy) < 3) return '脚边有掉落物';
  return `${whereIs(e.direction, e.distance, e.dy)}附近有掉落物`;
}

/** 同方位、距离差不多的几堆合成一句;不同方向各写一句 */
function narrateDrops(drops: EntityInfo[]): string[] {
  if (drops.length === 0) return [];
  const groups = new Map<string, EntityInfo[]>();
  for (const e of drops) {
    const key = `${e.direction ?? '脚边'}|${distBucket(e.distance)}|${dyBand(e.dy)}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  return [...groups.values()]
    .map((group) => {
      const nearest = group.reduce((a, b) => (a.distance <= b.distance ? a : b));
      const merged = new Map<string, number>();
      for (const e of group) {
        const name = e.item?.name ?? 'item';
        merged.set(name, (merged.get(name) ?? 0) + (e.item?.count ?? 1));
      }
      const list = [...merged.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => dropLabel({ name, count }))
        .join('、');
      return { d: nearest.distance, text: `${dropWhere(nearest)}：${list}。` };
    })
    .sort((a, b) => a.d - b.d)
    .map((g) => g.text);
}

/**
 * 近处方块的括注:作物龄期 / 耕地水分 / 容器账本,互斥。
 *
 * 作物报原版的 age 方块状态本身(`age 6/7`),不换算成自造的量纲:模型知道
 * 小麦 age 6 差一档就熟,不知道"约9成熟"是什么,中间那次翻译只能由它自己编。
 */
function blockSuffix(b: WorldSnapshot['nearbyBlocks'][number]): string {
  if (b.age) return `（age ${b.age.value}/${b.age.max}）`;
  if (b.moisture) return `（moisture ${b.moisture.value}/${b.moisture.max}）`;
  return containerSuffix(b.contents);
}

/**
 * 作物 age 以括注为比对键，只在服务端随机刻推进。
 * moisture 显示原值，比对键只认 > 0 是否水合：四格内有水时置 7，无水时逐随机刻
 * 递减；降到 0 且无作物时耕地退回泥土，生长判据取水合与否。
 */
function stateCmpOf(b: WorldSnapshot['nearbyBlocks'][number]): string {
  if (b.age) return blockSuffix(b);
  if (b.moisture) return b.moisture.value > 0 ? '湿' : '干';
  return '';
}

function containerSuffix(contents: ItemStack[] | null | undefined): string {
  if (contents === undefined) return '';
  if (contents === null) return '（没开过）';
  if (contents.length === 0) return '（空的）';
  return `（${narrateInventory(contents)}）`;
}

function contentsCmp(contents: ItemStack[] | null | undefined): string {
  if (contents === undefined) return '';
  if (contents === null) return '未开';
  return contents.map((i) => `${i.name}×${i.count}`).sort().join(',');
}

/** 附魔括号:`(效率IV·耐久III)`;没附魔返回空串 */
export function enchantSuffix(enchants: readonly ItemEnchant[] | undefined): string {
  if (!enchants || enchants.length === 0) return '';
  return `（${enchants.map((e) => `${zhEnchant(e.name)}${roman(e.level)}`).join('·')}）`;
}

const GEAR_SLOT_ZH: Record<GearSlot, string> = {
  head: '头', chest: '胸', legs: '腿', feet: '脚', offhand: '副手',
};
const WORN_ORDER: GearSlot[] = ['head', 'chest', 'legs', 'feet'];

function gearPhrase(p: GearPiece): string {
  const dura = p.durability ? ` ${p.durability.left}/${p.durability.max}` : '';
  return `${GEAR_SLOT_ZH[p.slot]}${zhName(p.name)}${enchantSuffix(p.enchantments)}${dura}`;
}

function effectPhrase(e: StatusEffect): string {
  const lvl = e.level > 1 ? roman(e.level) : '';
  return `${zhEffect(e.name)}${lvl}还有 ${e.seconds} 秒`;
}

/** 经验、身上穿的、状态效果。没有效果就不出那一句 */
function narrateEquip(s: WorldSnapshot): string {
  const worn = WORN_ORDER
    .map((slot) => s.equipment.find((p) => p.slot === slot))
    .filter((p): p is GearPiece => p !== undefined);
  const off = s.equipment.find((p) => p.slot === 'offhand');
  const bits = [`经验 ${s.xpLevel} 级。`];
  bits.push(worn.length > 0 ? `穿着：${worn.map(gearPhrase).join('、')}。` : '身上没穿护甲。');
  if (off) bits.push(`${gearPhrase(off)}。`);
  if (s.effects.length > 0) bits.push(`状态：${s.effects.map(effectPhrase).join('、')}。`);
  return bits.join('');
}

/**
 * 装备段的比对键。耐久按一成一档、效果剩余只在跌破 30 秒时翻 ——
 * 两者都是每秒都在动的读数,进了键这段就每拍重印。
 */
function equipCmp(s: WorldSnapshot): string {
  const gear = s.equipment
    .map((p) => {
      const wear = p.durability ? Math.round((p.durability.left / p.durability.max) * 10) : '-';
      return `${p.slot}:${p.name}${enchantSuffix(p.enchantments)}:${wear}`;
    })
    .sort()
    .join(',');
  const eff = s.effects
    .map((e) => `${e.name}${e.level}${e.seconds <= 30 ? '!' : ''}`)
    .sort()
    .join(',');
  return `xp${s.xpLevel}|${gear}|${eff}`;
}

/**
 * 物品栏聚合成"圆石×19、泥土×14"的中文列表。
 *
 * 附魔件各自成条并附括号(`钻石镐(效率IV·耐久III)`):原版里带不同附魔的同名物品
 * **不能堆叠**,按名字合并会把三把各不相同的镐念成一样东西。
 */
export function narrateInventory(items: ItemStack[]): string {
  return listStacks([...mergedStacks(items).values()]);
}

/** 按「名字 + 附魔后缀」并栈:这个键就是原版里能不能堆在一起的那条线 */
function mergedStacks(items: ItemStack[]): Map<string, { count: number; label: string }> {
  const merged = new Map<string, { count: number; label: string }>();
  for (const it of items) {
    const suffix = enchantSuffix(it.enchantments) + (it.potion ? `（${it.potion}）` : '');
    const key = `${it.name}${suffix}`;
    const cur = merged.get(key);
    if (cur) cur.count += it.count;
    else merged.set(key, { count: it.count, label: `${zhName(it.name)}${suffix}` });
  }
  return merged;
}

function listStacks(v: { count: number; label: string }[]): string {
  return v.sort((a, b) => b.count - a.count).map((s) => `${s.label}×${s.count}`).join('、');
}

/**
 * gear 段只报告相对上一份快照有变化的背包条目，数值为当前存量；消失的物品单列。
 * 进出流水由 inventoryDelta 的 minecraft.world 事件报告。
 */
function narrateBagChange(prev: ItemStack[], cur: ItemStack[]): string {
  const before = mergedStacks(prev);
  const after = mergedStacks(cur);
  const changed = [...after.entries()].filter(([k, v]) => before.get(k)?.count !== v.count).map(([, v]) => v);
  const gone = [...before.entries()].filter(([k]) => !after.has(k)).map(([, v]) => v.label);
  const parts: string[] = [];
  if (changed.length > 0) parts.push(`包里变的：${listStacks(changed)}`);
  if (gone.length > 0) parts.push(`${gone.join('、')}没了`);
  return parts.length > 0 ? `${parts.join('，')}。` : '';
}

function countByName(items: ItemStack[]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const it of items) merged.set(it.name, (merged.get(it.name) ?? 0) + it.count);
  return merged;
}

/**
 * 物品栏变化独立核对执行器回执，并附带变化后的总数；无变化时返回 null。
 * 总数不受事件迟到或合批影响，可直接判断目标数量是否满足。
 */
function inventoryDelta(prev: ItemStack[], cur: ItemStack[]): string | null {
  const before = countByName(prev);
  const after = countByName(cur);
  const gained: string[] = [];
  const lost: string[] = [];
  for (const [name, n] of after) {
    const d = n - (before.get(name) ?? 0);
    if (d > 0) gained.push(`${zhName(name)}×${d}(共 ${n})`);
  }
  for (const [name, n] of before) {
    const d = n - (after.get(name) ?? 0);
    if (d > 0) lost.push(`${zhName(name)}×${d}(剩 ${after.get(name) ?? 0})`);
  }
  const parts: string[] = [];
  if (gained.length > 0) parts.push(`包里多了 ${gained.join('、')}`);
  if (lost.length > 0) parts.push(`${gained.length > 0 ? '' : '包里'}少了 ${lost.join('、')}`);
  return parts.length > 0 ? parts.join(',') : null;
}

interface WorldDelta {
  /** 值得说的变化;全空 = 不值得推 minecraft.world 事件。 */
  notes: string[];
  /**
   * 变化只有物品栏增减。采集途中每个节流窗都会多几格土,这类帧单独把她叫醒
   * 只换来一句无话可说,调用方据此选搭车档。
   */
  inventoryOnly: boolean;
}

/**
 * 两个快照之间"值得说"的变化。
 */
export function worldDelta(
  prev: WorldSnapshot,
  cur: WorldSnapshot,
  moveThreshold: number,
): WorldDelta {
  const notes: string[] = [];
  let inventoryNotes = 0;
  const sameDimension = prev.dimension.replace(/^minecraft:/, '') === cur.dimension.replace(/^minecraft:/, '');
  if (sameDimension) {
    const dx = cur.position.x - prev.position.x;
    const dy = cur.position.y - prev.position.y;
    const dz = cur.position.z - prev.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist >= moveThreshold) {
      const dir = bearing(dx, dz);
      const way = dir ? `往${DIRECTION_ZH[dir]}` : '';
      notes.push(
        `${way}走了 ${fmt(dist)} 格,现在在 (${fmt(cur.position.x)}, ${fmt(cur.position.y)}, ${fmt(cur.position.z)})`,
      );
    }
  }
  if (sameDimension && cur.biome !== prev.biome) notes.push(`走进了${zhBiome(cur.biome)}`);
  if (sameDimension && cur.raining !== prev.raining) notes.push(cur.raining ? '开始下雨了' : '雨停了');

  // 初次同步前的空物品栏不是有效基线。
  if (prev.invSynced && cur.invSynced) {
    const inv = inventoryDelta(prev.inventory, cur.inventory);
    if (inv) {
      notes.push(inv);
      inventoryNotes++;
    }
  }
  // 此处只报告饥饿变化;伤害事件由包含攻击者信息和反射去重的 World 播报处理。
  if (foodPhrase(cur.food) !== foodPhrase(prev.food)) {
    notes.push(`${foodPhrase(cur.food)}(饥饿 ${Math.round(cur.food)}/20)`);
  }

  // 敌对/友好实体的进出由 World 的接近状态机报告(16 进/24 出滞回),不在摘要里重复。
  return { notes, inventoryOnly: notes.length > 0 && notes.length === inventoryNotes };
}

/** 昼夜转换检测:跨过夜幕(13000)或黎明(23000)返回一句话,否则 null */
export function dayNightTransition(prevTime: number, curTime: number): string | null {
  const wasNight = isNight(prevTime);
  const nowNight = isNight(curTime);
  if (!wasNight && nowNight) return '夜幕降临了,敌对生物会开始出现。';
  if (wasNight && !nowNight) return '天亮了。';
  return null;
}

const HOSTILE_NAMES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch',
  'slime', 'phantom', 'drowned', 'husk', 'stray', 'pillager', 'vindicator',
  'ravager', 'vex', 'evoker', 'silverfish', 'zombie_villager', 'guardian',
  'elder_guardian', 'shulker', 'blaze', 'ghast', 'magma_cube', 'hoglin',
  'zoglin', 'piglin_brute', 'wither_skeleton', 'warden',
]);

export function classifyEntity(type: string | undefined, name: string | undefined): EntityInfo['kind'] {
  if (type === 'player') return 'player';
  if (name && HOSTILE_NAMES.has(name)) return 'hostile';
  if (type === 'animal' || type === 'mob' || type === 'water_creature') return 'animal';
  return 'other';
}

/**
 * 快照里不值得列的实体:飞行中/插在地上的射弹。怪物丢的三叉戟规则上捡不起来,
 * 列出来只会引出反复去捡;挨打由受击事件与生命值说,不靠数地上的箭。
 */
const NOISE_ENTITIES = new Set([
  'arrow', 'spectral_arrow', 'trident', 'snowball', 'egg', 'ender_pearl',
  'fireball', 'small_fireball', 'dragon_fireball', 'wither_skull',
  'potion', 'experience_bottle', 'llama_spit', 'shulker_bullet',
]);

/** 近处方块播报排除的天然地形与植被集合。 */
const BG_EXACT = new Set([
  'air', 'cave_air', 'void_air',
  'stone', 'cobblestone', 'mossy_cobblestone', 'deepslate', 'cobbled_deepslate',
  'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'gravel', 'bedrock',
  'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium', 'dirt_path', 'mud',
  'sand', 'red_sand', 'sandstone', 'red_sandstone', 'smooth_sandstone', 'smooth_red_sandstone',
  'clay', 'snow', 'snow_block',
  'netherrack', 'basalt', 'smooth_basalt', 'blackstone', 'end_stone', 'dripstone_block',
  'terracotta',
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'lily_pad',
  'moss_block', 'moss_carpet', 'hanging_roots', 'glow_lichen', 'sculk_vein', 'sculk',
  'azalea', 'flowering_azalea', 'big_dripleaf', 'small_dripleaf', 'big_dripleaf_stem',
  'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant',
]);
const BG_RE = [/_leaves$/, /_terracotta$/, /_sapling$/, /^frosted_ice$/];

/** 判成背景也照报:水与岩浆是路况,后四样是碰上就掉血的 */
const FORCE_REPORT = new Set(['water', 'lava', 'fire', 'magma_block', 'powder_snow', 'cobweb']);

/** 天然背景 = 永不进"看得见的"。其余一律报。 */
export function isBackground(name: string): boolean {
  // 竹笋同时命中 /_sapling$/,但它是伸手就变成物品的可采集物,不是背景;
  // registry 全部 1060 个方块名里这是唯一一处例外
  if (name === 'bamboo_sapling') return false;
  return BG_EXACT.has(name) || BG_RE.some((re) => re.test(name));
}

/**
 * 该报的方块 id 全集。按 registry 记忆化:表是判据算出来的常量,
 * 每帧重算等于把 1060 次正则匹配摊进每份快照。
 * 不含水与岩浆——它们半径 16 内动辄上千格,混进全局调用会把 count 淹掉,各自单扫。
 */
const reportableCache = new WeakMap<object, Set<number>>();
function reportableIds(blocksByName: Record<string, { id: number }>): Set<number> {
  const hit = reportableCache.get(blocksByName);
  if (hit) return hit;
  const ids = new Set<number>();
  for (const [name, def] of Object.entries(blocksByName)) {
    if (name === 'water' || name === 'lava') continue;
    if (FORCE_REPORT.has(name) || !isBackground(name)) ids.add(def.id);
  }
  reportableCache.set(blocksByName, ids);
  return ids;
}

/** 农作物的满龄:age 达到即可收割。beetroots 只有 0–3。 */
export const CROP_MAX_AGE: Record<string, number> = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };

/** 耕地 moisture 的满值:四格内有水就置 7,没水每次随机刻掉一档 */
const FARMLAND_MAX_MOISTURE = 7;

/**
 * 快照「近处」可并列多块的容器;其余种类仍只报最近看得见的一块。
 * 炉子族也在列:账本里有槽位读数就随行显示(「熔炉(粗铁×8、煤×2)」),
 * 没开过照容器的口径写「没开过」——15:57 她连撞两次右键问炉子里有什么都拿不到答案。
 */
const CONTAINER_BLOCKS = new Set([
  'chest', 'trapped_chest', 'barrel', 'ender_chest',
  'furnace', 'smoker', 'blast_furnace',
]);
const CONTAINER_NEARBY_CAP = 4;

/** 头部所在方块是不是水体(含气泡柱与自带水的水草/海带):溺水判定的前提 */
export const WATER_BLOCKS = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);

/** 感知半径(格):看得见的按视线算,看不见的按听觉算,这个距离外一律不存在于感知里 */
const AUDIBLE_RANGE = 16;

/**
 * `classifyEntity` 判成 animal、原版里却不发闲置音的水生动物:看不见时连"动静"都没有。
 *
 * 只列水生这一类,是因为其余"看不见就不该报"的实体已经被 `kind === 'other'` 那半条
 * 判据挡住了:mineflayer 的 `entity.type` 直接取 minecraft-data 的 `type`
 * (entities.js:163),展示框/发光展示框/画是 `other`、盔甲架是 `living`,三者都不在
 * `classifyEntity` 认的 animal/mob/water_creature 里,落到 `other`。
 */
const SILENT_ENTITIES = new Set([
  'squid', 'glow_squid', 'salmon', 'cod', 'tropical_fish', 'pufferfish', 'tadpole',
]);

/**
 * 视线射线允许穿过各色普通玻璃、玻璃板与铁栏杆的碰撞箱。
 * tinted_glass、树叶和门不在豁免集内。
 */
const SEE_THROUGH_BLOCKS = new Set([
  'glass', 'glass_pane', 'iron_bars',
  ...['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
    'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
    .flatMap((c) => [`${c}_stained_glass`, `${c}_stained_glass_pane`]),
]);

/** 这块方块挡不挡视线;`SEE_THROUGH_BLOCKS` 之外按碰撞形状判。 */
function blocksSight(name: string | null | undefined): boolean {
  return name != null && !SEE_THROUGH_BLOCKS.has(name);
}

/**
 * 主视角能看见这块方块。感知面(世界快照摘要/find 扫描/collect 选目标)必须
 * 过这一关,findBlocks 只按区块索引查、无视遮挡,直接用等于穿墙。
 * 射线到方块中心,只露一角的方块可能漏判——宁可保守,不开挂。
 *
 * 透光集只做加法:先问 mineflayer 的原判据,它说看得见就看得见;只有它说"被挡"
 * 时才自己补一条射线,追问挡住的是不是玻璃。这样规则只会变得更宽、不会变严,
 * 也不必替换那条久经考验的判据。
 */
export function canSeeBlockAt(bot: any, p: { x: number; y: number; z: number }): boolean {
  const block = bot.blockAt(p as never);
  if (block == null) return false;
  if (bot.canSeeBlock(block) === true) return true;
  const me = bot.entity;
  const ey = me.position.y + (me.eyeHeight ?? 1.62);
  // 眼睛到方块中心,长度和方向用同一条向量算:mineflayer 原版拿"到方块角"的距离
  // 当射程、方向却指向中心,射线会在贴边的目标上差一点点停住。
  const dx = block.position.x + 0.5 - me.position.x;
  const dy = block.position.y + 0.5 - ey;
  const dz = block.position.z + 0.5 - me.position.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return true;
  const isTarget = (q: { x: number; y: number; z: number } | null | undefined): boolean =>
    q != null && q.x === block.position.x && q.y === block.position.y && q.z === block.position.z;
  const match = (hit: any, iter: any): boolean => {
    // 目标自己永远算命中,否则射线从它身上穿过去继续找
    if (isTarget(hit.position)) return true;
    if (!blocksSight(hit.name)) return false;
    return iter.intersect(hit.shapes, hit.position) != null;
  };
  const eye = new Vec3(me.position.x, ey, me.position.z);
  const dir = new Vec3(dx / dist, dy / dist, dz / dist);
  return isTarget(bot.world.raycast(eye, dir, dist, match)?.position);
}

/**
 * 主视角能看见这个实体:眼睛到实体半身高的射线不被方块挡。
 * 水没有碰撞形状,射线穿水——清水里的鱼算看得见。
 */
export function canSeeEntity(bot: any, e: any): boolean {
  const me = bot.entity;
  // raycast 的迭代器要求真 Vec3(内部调 .minus/.plus),裸 {x,y,z} 会在首次求交时崩
  const eye = new Vec3(me.position.x, me.position.y + (me.height ?? 1.62), me.position.z);
  const tgt = new Vec3(e.position.x, e.position.y + (e.height ?? 1) * 0.5, e.position.z);
  const delta = tgt.minus(eye);
  const dist = delta.norm();
  if (dist < 1) return true;
  // 与方块同一条透光集:隔窗看见村民和隔窗看见箱子是同一件事
  const match = (hit: any, iter: any): boolean =>
    blocksSight(hit?.name) && iter.intersect(hit.shapes, hit.position) != null;
  return bot.world.raycast(eye, delta.scaled(1 / dist), dist, match) === null;
}

/**
 * 村民职业按元数据中 villagerData 的形状识别；幼体位按 1.20.6 的下标 16 读取。
 * 读不到的身份信息不报告，非村民返回 null。
 */
export function villagerNote(e: { name?: string; metadata?: unknown[] }): string | null {
  if (e?.name !== 'villager') return null;
  const meta = e.metadata;
  if (!Array.isArray(meta)) return null;
  if (meta[16] === true) return '小孩';
  for (const m of meta) {
    if (m && typeof m === 'object' && 'villagerProfession' in (m as Record<string, unknown>)) {
      const id = (m as { villagerProfession: number }).villagerProfession;
      return VILLAGER_PROFESSION_ZH[id] ?? `职业#${id}`;
    }
  }
  return null;
}

/** 地形采样距离(格)与扫描的纵向范围 */
const TERRAIN_DIST = 8;
const TERRAIN_UP = 6;
const TERRAIN_DOWN = 8;

/**
 * 8 向 TERRAIN_DIST 格外找落脚面:从上往下扫第一处"上空下实"。
 * |高差|<3 的平缓地和未加载的方向不出条目;整列实心报山体,先见水面报水。
 */
function sampleTerrain(bot: any, feet: { x: number; y: number; z: number }): TerrainSample[] {
  const out: TerrainSample[] = [];
  const feetY = Math.floor(feet.y);
  for (const direction of Object.keys(DIRECTIONS) as Direction[]) {
    const [dx, dz] = DIRECTIONS[direction];
    const norm = Math.hypot(dx, dz);
    const cx = Math.floor(feet.x + (dx / norm) * TERRAIN_DIST);
    const cz = Math.floor(feet.z + (dz / norm) * TERRAIN_DIST);
    // 初始视为"上方未知":顶格就是实心时不冒认落脚面,整列实心走山体分支
    let prevEmpty = false;
    let sample: TerrainSample | null = null;
    let loaded = true;
    let sawEmpty = false;
    for (let y = feetY + TERRAIN_UP; y >= feetY - TERRAIN_DOWN; y--) {
      const b = bot.blockAt(new Vec3(cx, y, cz));
      if (!b) { loaded = false; break; }
      const empty = b.boundingBox === 'empty';
      if (empty) sawEmpty = true;
      if (prevEmpty && b.name === 'water') {
        sample = { direction, dy: y + 1 - feetY, kind: 'water' };
        break;
      }
      if (prevEmpty && !empty) {
        sample = { direction, dy: y + 1 - feetY, kind: y + 1 - feetY >= 0 ? 'up' : 'down' };
        break;
      }
      prevEmpty = empty;
    }
    if (!loaded) {
      out.push({ direction, dy: 0, kind: 'unloaded' });
      continue;
    }
    if (!sample) {
      // 扫描范围内没有落脚面:整列实心 = 山体;整列悬空 = 深沟/悬崖
      sample = sawEmpty
        ? { direction, dy: -(TERRAIN_DOWN + 1), kind: 'down' }
        : { direction, dy: TERRAIN_UP + 1, kind: 'solid' };
    }
    if (sample.kind === 'up' || sample.kind === 'down') {
      if (Math.abs(sample.dy) < 3) continue; // 平缓不占条目
    }
    out.push(sample);
  }
  return out;
}

/** 采样半径(切比雪夫):她周身这一小片,够判断眼前黑不黑,又不至于把半条隧道算进来 */
const LIGHT_RADIUS = 4;
/** 采样格数上限:BFS 由近及远,到点就收手(露天时几格之内答案就已经定了) */
const LIGHT_CELLS = 96;
/** 连通只认六个面——光照就是这么传的,斜着穿墙角不算连通 */
const LIGHT_FACES: Array<[number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/**
 * 她周身那一小片连通空间的亮度众数。
 *
 * 从脚和头两格出发按面连通往外漫,只走透光的格(墙挡住的亮不算她看得见的亮);
 * 每格取"眼睛看到的亮度"= max(方块光, 天光扣夜间惩罚),最后取众数。
 * 并列取大的那个:宁可漏报黑,也不要再来一次"踩着火把说眼前一片漆黑"。
 *
 * 不能只读脚下那一格:不透光方块内部存的光照恒为 0,她卡进方块、或站在耕地
 * 这类矮碰撞箱上时,脚那一格就是方块自己——读到的 0 是数据对、问题问错。
 * 采不到样就报 null 不猜:区块没加载时 prismarine 的 world 两路都返回 0,
 * 跟真的全黑分不开;她整个人被埋住时根本没有可采的空间。
 */
export function sampleLight(bot: any, night: boolean): WorldSnapshot['light'] {
  const w = bot.world;
  if (typeof w?.getBlockLight !== 'function' || typeof w.getSkyLight !== 'function') return null;
  const origin = bot.entity.position.floored();
  const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;
  // 区块没加载时 blockAt 给 null:既走不过去,也不当成空气
  const open = (p: unknown): boolean => {
    const b = bot.blockAt(p, false);
    return Boolean(b) && b.boundingBox !== 'block';
  };
  const seen = new Set<string>();
  const queue: any[] = [];
  for (const start of [origin, origin.offset(0, 1, 0)]) {
    if (seen.has(key(start))) continue;
    seen.add(key(start));
    if (open(start)) queue.push(start);
  }
  const counts = new Map<number, number>();
  try {
    let sampled = 0;
    while (queue.length > 0 && sampled < LIGHT_CELLS) {
      const p = queue.shift();
      const block = w.getBlockLight(p);
      const sky = w.getSkyLight(p);
      if (!Number.isFinite(block) || !Number.isFinite(sky)) continue;
      const lit = Math.max(0, Math.min(15, Math.round(
        Math.max(block, night ? sky - NIGHT_SKY_PENALTY : sky),
      )));
      counts.set(lit, (counts.get(lit) ?? 0) + 1);
      sampled++;
      for (const [dx, dy, dz] of LIGHT_FACES) {
        const q = p.offset(dx, dy, dz);
        const far = Math.max(
          Math.abs(q.x - origin.x), Math.abs(q.y - origin.y), Math.abs(q.z - origin.z),
        );
        if (far > LIGHT_RADIUS || seen.has(key(q))) continue;
        seen.add(key(q));
        if (open(q)) queue.push(q);
      }
    }
  } catch {
    return null;
  }
  let mode: number | null = null;
  let best = 0;
  for (const [lit, n] of counts) {
    if (n > best || (n === best && mode !== null && lit > mode)) {
      mode = lit;
      best = n;
    }
  }
  return mode;
}

/**
 * 使用 rainState 判断降雨。Mineflayer 的 isRaining 按 game_state_change reason 1/2
 * 的常量名更新布尔值，与原版实际行为极性相反。
 * reason 7 的 rain_level_change 提供 0–1 雨量，存入 rainState；进服和重生时会重发。
 */
export function isRaining(bot: any): boolean {
  const level = (bot as { rainState?: unknown }).rainState;
  return typeof level === 'number' && Number.isFinite(level) && level > 0;
}

/** 脚**所在**那一格是这些时,快照的「脚下是X」报它而不是脚下那一格(见 standingOn) */
const LIQUID_UNDERFOOT = new Set(['water', 'lava', 'bubble_column']);

/** 头部(脚上一格)在水中。氧气元数据只有此时可信:上岸后服务器不再推,旧值一直残留。 */
export function headInWater(bot: any): boolean {
  const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  return head != null && WATER_BLOCKS.has(head.name);
}

/** 身子泡在水里(脚所在格或头所在格是水)。水里 onGround 恒假、疾跑无效,战斗姿态与撤退选路都要认它 */
export function bodyInWater(bot: any): boolean {
  const feet = bot.blockAt(bot.entity.position);
  if (feet != null && WATER_BLOCKS.has(feet.name)) return true;
  return headInWater(bot);
}

/**
 * 从水里找登岸格:脚下实心、脚与头都不是水也不是实心。由近及远逐圈扫,同一圈里
 * 优先背离 `from`(怪群质心)那一侧——对着追兵上岸等于把背身白送给它。
 */
export function findBankCell(
  bot: any, from: { x: number; z: number } | null, maxR = 16,
): { x: number; y: number; z: number } | null {
  const me = bot.entity.position;
  const base = me.floored();
  const ax = from ? me.x - from.x : 0;
  const az = from ? me.z - from.z : 0;
  const alen = Math.hypot(ax, az) || 1;
  for (let r = 2; r <= maxR; r += 2) {
    let best: { x: number; y: number; z: number } | null = null;
    let bestDot = -Infinity;
    for (let dx = -r; dx <= r; dx += 2) {
      for (let dz = -r; dz <= r; dz += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (let dy = 2; dy >= -1; dy--) {
          const x = base.x + dx, y = base.y + dy, z = base.z + dz;
          const below = bot.blockAt(new Vec3(x, y - 1, z));
          const feet = bot.blockAt(new Vec3(x, y, z));
          const head = bot.blockAt(new Vec3(x, y + 1, z));
          if (!below || !feet || !head) continue;
          if (below.boundingBox !== 'block') continue;
          if (feet.boundingBox !== 'empty' || WATER_BLOCKS.has(feet.name)) continue;
          if (head.boundingBox !== 'empty' || WATER_BLOCKS.has(head.name)) continue;
          const d = Math.hypot(dx, dz) || 1;
          const dot = (dx * ax + dz * az) / (d * alen);
          if (dot > bestDot) { bestDot = dot; best = { x, y, z }; }
          break;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * 一步做完人还泡在水里时补在回执末尾的一句:脚下水多深、最近能站的干地在哪。
 * 不在水里、或者坐着船,返回空串。
 */
export function wetNote(bot: any): string {
  // 物理引擎的 isInWater 在水面上逐刻翻,不能拿它判;直接读脚和头那两格
  const cell = (dy: number) => bot.blockAt?.(bot.entity.position.offset(0, dy, 0));
  if (bot.vehicle || ![cell(0), cell(1)].some((b) => b != null && WATER_BLOCKS.has(b.name))) return '';
  const base = bot.entity.position.floored();
  let depth = 0;
  while (depth < 32) {
    const b = bot.blockAt(new Vec3(base.x, base.y - depth, base.z));
    if (!b || !WATER_BLOCKS.has(b.name)) break;
    depth++;
  }
  const bank = findBankCell(bot, null, 16);
  return `。人现在泡在水里(脚下水深 ${depth} 格,`
    + (bank ? `最近能站的干地 (${bank.x}, ${bank.y}, ${bank.z}))` : '16 格内没有能站的岸)');
}

/** 碰上就烧人的方块:碰撞箱压上去即掉血(combat 的 standable 与这里共用一份口径) */
export const BURNING_BLOCKS = new Set(['lava', 'fire', 'soul_fire']);
/** 只有站在上面才烧的:单独查脚下那一格 */
export const SCORCHING_FLOOR = new Set(['magma_block']);
/** 玩家碰撞箱:半径 0.3、高 1.8。0.1 是余量——贴着岩浆边缘走就已经在挨烧了 */
const HITBOX_R = 0.3;
const TOUCH_MARGIN = 0.1;
const PLAYER_HEIGHT = 1.8;
/** 实体共享元数据第 0 字节的第 0 位 = 身上着火 */
const FIRE_FLAG = 0x01;

export interface HazardCell {
  x: number; y: number; z: number;
  name: string;
  /** 到人(脚部坐标)的距离,格 */
  distance: number;
}

interface HazardTouch {
  /** 碰撞箱压着的最近一格烧人方块;null = 没碰上 */
  touching: HazardCell | null;
  /** 脚那格就是岩浆:人在往下沉,得一直往上游 */
  submerged: boolean;
  /** 身上着火;元数据读不到时为 false */
  onFire: boolean;
}

function cellOf(from: { x: number; y: number; z: number }, x: number, y: number, z: number, name: string): HazardCell {
  return {
    x, y, z, name,
    distance: Math.hypot(from.x - (x + 0.5), from.y - (y + 0.5), from.z - (z + 0.5)),
  };
}

/**
 * 按碰撞箱及水平余量检测接触的烧灼方块，供反射心跳读取。
 * 没有侧面接触时另查脚下的灼热表面。
 */
export function hazardTouch(bot: any): HazardTouch {
  const p = bot.entity.position;
  const base = p.floored();
  const reach = HITBOX_R + TOUCH_MARGIN;
  // 脚往上抬 0.05 格再取整:站在方块顶面时坐标常是整数,直接 floor 会读到脚下的实心方块
  const dy0 = Math.floor(p.y + 0.05) - base.y;
  const dy1 = Math.floor(p.y + PLAYER_HEIGHT - 0.1) - base.y;
  let touching: HazardCell | null = null;
  let submerged = false;
  for (let dx = Math.floor(p.x - reach) - base.x; dx <= Math.floor(p.x + reach) - base.x; dx++) {
    for (let dz = Math.floor(p.z - reach) - base.z; dz <= Math.floor(p.z + reach) - base.z; dz++) {
      for (let dy = dy0; dy <= dy1; dy++) {
        const b = bot.blockAt(base.offset(dx, dy, dz));
        if (b == null || !BURNING_BLOCKS.has(b.name)) continue;
        const c = cellOf(p, base.x + dx, base.y + dy, base.z + dz, b.name);
        if (touching === null || c.distance < touching.distance) touching = c;
        if (dx === 0 && dz === 0 && dy === dy0 && b.name === 'lava') submerged = true;
      }
    }
  }
  if (touching === null) {
    const floor = bot.blockAt(base.offset(0, dy0 - 1, 0));
    if (floor != null && SCORCHING_FLOOR.has(floor.name)) {
      touching = cellOf(p, base.x, base.y + dy0 - 1, base.z, floor.name);
    }
  }
  return { touching, submerged, onFire: onFire(bot) };
}

/** 身上着不着火。元数据在部分版本/重连后读不到,读不到就当没着火,判定另有碰撞箱那条路兜底 */
function onFire(bot: any): boolean {
  const flags = bot.entity?.metadata?.[0];
  return typeof flags === 'number' && (flags & FIRE_FLAG) !== 0;
}

/** 半径内所有烧人的方块,近的在前。只在真挨烧时才扫,不进心跳 */
export function hazardsWithin(bot: any, radius: number): HazardCell[] {
  const p = bot.entity.position;
  const base = p.floored();
  const r = Math.ceil(radius);
  const found: HazardCell[] = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const b = bot.blockAt(base.offset(dx, dy, dz));
        if (b == null || !BURNING_BLOCKS.has(b.name)) continue;
        const c = cellOf(p, base.x + dx, base.y + dy, base.z + dz, b.name);
        if (c.distance <= radius) found.push(c);
      }
    }
  }
  return found.sort((a, b) => a.distance - b.distance);
}

/** 半径内最近的烧人方块 */
export function nearestHazard(bot: any, radius: number): HazardCell | null {
  return hazardsWithin(bot, radius)[0] ?? null;
}

/**
 * 逃生落脚格离每一处危险都至少这么远才算安全。传给 findEscapeCell 的危险格要扫到
 * 搜索半径再加这一段,否则窗口边上的候选格看不见窗口外紧挨着它的岩浆。
 */
export const ESCAPE_SAFE_GAP = 3;
/** 逃生路线的抽样点数:够挡住"落脚点是安全的、可是路上还要蹚一遍岩浆" */
const ROUTE_SAMPLES = 4;

/**
 * 逃生格距每处危险至少 ESCAPE_SAFE_GAP 格，直线路径须通过危险格采样检查。
 * 距离评分兼顾远离危险与就近；默认要求脚下实心、脚与头可容身且无火和水。
 * preferWater 为 true 时优先水格，并允许水格下无实心支撑；找不到返回 null。
 * keep 是上一拍选定的落脚格:仍满足间距与可站就沿用,不随人挪动后的扫描窗口丢掉。
 */
export function findEscapeCell(
  bot: any,
  hazards: HazardCell[],
  maxR: number,
  preferWater = false,
  keep: { x: number; y: number; z: number } | null = null,
): { x: number; y: number; z: number } | null {
  if (hazards.length === 0) return null;
  const gapOf = (x: number, y: number, z: number): number => {
    let gap = Infinity;
    for (const h of hazards) {
      const d = Math.hypot(x - h.x, y - h.y, z - h.z);
      if (d < gap) gap = d;
    }
    return gap;
  };
  if (keep !== null && gapOf(keep.x, keep.y, keep.z) >= ESCAPE_SAFE_GAP
    && standableFor(bot, new Vec3(keep.x, keep.y, keep.z), preferWater)) {
    return keep;
  }
  const p = bot.entity.position;
  const base = p.floored();
  const blocked = new Set(hazards.map((h) => `${h.x},${h.y},${h.z}`));
  let best: { cell: { x: number; y: number; z: number }; score: number } | null = null;
  for (let dx = -maxR; dx <= maxR; dx++) {
    for (let dz = -maxR; dz <= maxR; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const x = base.x + dx, y = base.y + dy, z = base.z + dz;
        const gap = gapOf(x, y, z);
        if (gap < ESCAPE_SAFE_GAP) continue;
        // 打分只用距离,便宜;读块的两道校验留到确定它比现任更好之后再做
        let score = gap * 2 - Math.hypot(dx, dy, dz);
        if (preferWater) {
          // 着火时水格压倒一切距离分;这一读只在着火时发生,不动常规路径的成本
          const feetB = bot.blockAt(base.offset(dx, dy, dz));
          if (feetB != null && WATER_BLOCKS.has(feetB.name)) score += WATER_ESCAPE_PRIORITY;
        }
        if (best !== null && score <= best.score) continue;
        if (!routeClear(p, { x, y, z }, blocked)) continue;
        if (!standableFor(bot, base.offset(dx, dy, dz), preferWater)) continue;
        best = { cell: { x, y, z }, score };
      }
    }
  }
  return best?.cell ?? null;
}

/** 着火找水时给水格加的分:要压倒 `gap * 2` 能给出的任何值(gap ≤ 2·maxR ≈ 8) */
const WATER_ESCAPE_PRIORITY = 100;

/** 从人到落脚格的直线上抽几个点,踩到火的路线不要 */
function routeClear(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  blocked: Set<string>,
): boolean {
  for (let i = 1; i <= ROUTE_SAMPLES; i++) {
    const t = i / (ROUTE_SAMPLES + 1);
    const x = Math.floor(from.x + (to.x + 0.5 - from.x) * t);
    const y = Math.floor(from.y + (to.y - from.y) * t);
    const z = Math.floor(from.z + (to.z + 0.5 - from.z) * t);
    if (blocked.has(`${x},${y},${z}`) || blocked.has(`${x},${y + 1},${z}`)) return false;
  }
  return true;
}

/**
 * 逃生落脚格的可站判定:脚下实心,脚与头两格空且不烧人、不是液体。
 * `preferWater` 时水是资产不是障碍:脚泡进水里火就灭,人会浮,不要求脚下实心。
 */
function standableFor(
  bot: any,
  feet: { offset(dx: number, dy: number, dz: number): unknown },
  preferWater = false,
): boolean {
  const below = bot.blockAt(feet.offset(0, -1, 0));
  const at = bot.blockAt(feet.offset(0, 0, 0));
  const head = bot.blockAt(feet.offset(0, 1, 0));
  if (below == null || at == null || head == null) return false; // 没加载的格不当逃生点
  if (preferWater && WATER_BLOCKS.has(at.name)
    && head.boundingBox !== 'block' && !BURNING_BLOCKS.has(head.name)) {
    return true;
  }
  if (below.boundingBox !== 'block' || SCORCHING_FLOOR.has(below.name)) return false;
  for (const b of [at, head]) {
    if (b.boundingBox === 'block') return false;
    if (BURNING_BLOCKS.has(b.name)) return false;
    if (!preferWater && WATER_BLOCKS.has(b.name)) return false;
  }
  return true;
}

/** 探路分诊用的最小方块读数;null = 区块未加载 */
interface ProbeBlockInfo { name: string; solid: boolean }
export type BlockReader = (x: number, y: number, z: number) => ProbeBlockInfo | null;

/**
 * GoalNear(range=1) 的候选落脚格:目标格自身 + 六个正邻格里,能站人的那些。
 * 能站 = 脚与头两格都不是实心,且脚下实心(或脚泡在水里,浮着也算到了)。
 * 一格都没有 = 这个目标在当前地形下根本没处落脚(树冠/墙里的典型形态)——
 * A* 对这种目标只会以 timeout 收场,报不出这句真话,而预检 O(27) 就能报。
 * 任何一格读数缺失(未加载)时把那格当能站,宁可不下结论也不误诊。
 */
export function standCellsAround(
  read: BlockReader,
  t: { x: number; y: number; z: number },
): Array<{ x: number; y: number; z: number }> {
  const candidates = [
    { x: t.x, y: t.y, z: t.z },
    { x: t.x + 1, y: t.y, z: t.z }, { x: t.x - 1, y: t.y, z: t.z },
    { x: t.x, y: t.y + 1, z: t.z }, { x: t.x, y: t.y - 1, z: t.z },
    { x: t.x, y: t.y, z: t.z + 1 }, { x: t.x, y: t.y, z: t.z - 1 },
  ];
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (const c of candidates) {
    const feet = read(c.x, c.y, c.z);
    const head = read(c.x, c.y + 1, c.z);
    const below = read(c.x, c.y - 1, c.z);
    if (!feet || !head || !below) { out.push(c); continue; }
    const passable = !feet.solid && !head.solid;
    const support = below.solid || WATER_BLOCKS.has(feet.name);
    if (passable && support) out.push(c);
  }
  return out;
}

/**
 * 从落脚格向外灌水(六邻 BFS,只走非实心格):cap 内没摸到边 = 目标被封在小死角,
 * 返回死角大小;触到 cap 或摸到未加载区块 = 开阔地/下不了结论,返回 null。
 * 只做连通性不做完整移动规则——1 格缝也算通,宁可漏报"封死"也不误报。
 */
export function pocketScan(
  read: BlockReader,
  seeds: Array<{ x: number; y: number; z: number }>,
  cap = 128,
): number | null {
  const visited = new Set<string>();
  const queue: Array<{ x: number; y: number; z: number }> = [];
  for (const s of seeds) {
    const key = `${s.x},${s.y},${s.z}`;
    if (!visited.has(key)) { visited.add(key); queue.push(s); }
  }
  while (queue.length > 0) {
    if (visited.size >= cap) return null;
    const c = queue.shift()!;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
      const key = `${n.x},${n.y},${n.z}`;
      if (visited.has(key)) continue;
      const b = read(n.x, n.y, n.z);
      if (!b) return null;
      if (b.solid) continue;
      visited.add(key);
      queue.push(n);
    }
  }
  return visited.size;
}

/**
 * 掉落物实体上的物品。优先 `getDroppedItem()`(prismarine-entity 的口径);
 * 没有元数据时记成不明掉落物,不猜。
 */
export function droppedStackOf(
  e: {
    name?: string;
    getDroppedItem?: () => { name?: string; count?: number; itemId?: number; itemCount?: number } | null;
    heldItem?: { name?: string; count?: number };
    item?: { name?: string; count?: number };
    metadata?: unknown;
  },
  items?: Record<number, { name: string }>,
): ItemStack | null {
  const n = e.name;
  if (n !== 'item' && n !== 'Item' && n !== 'item_stack') return null;
  let raw: { name?: string; count?: number; itemId?: number; itemCount?: number } | null = null;
  if (typeof e.getDroppedItem === 'function') {
    try { raw = e.getDroppedItem(); } catch { raw = null; }
  }
  if (!raw) raw = e.heldItem ?? e.item ?? null;
  if (!raw && Array.isArray(e.metadata)) {
    const hit = e.metadata.find((m) =>
      m && typeof m === 'object' && ('name' in m || 'itemId' in m || 'itemCount' in m),
    );
    if (hit && typeof hit === 'object') raw = hit as typeof raw;
  }
  if (!raw) return { name: 'item', count: 1 };
  let name = typeof raw.name === 'string' ? raw.name.replace(/^minecraft:/, '') : '';
  if (!name && typeof raw.itemId === 'number' && items?.[raw.itemId]) name = items[raw.itemId].name;
  if (!name) name = 'item';
  const count = typeof raw.count === 'number' ? raw.count
    : typeof raw.itemCount === 'number' ? raw.itemCount
    : 1;
  return { name, count };
}

/**
 * 作物 age / 耕地 moisture 读进快照条目。属性值随 prismarine 版本可能是字符串,
 * 数值化失败(含假实现没有 getProperties)就不填,渲染侧按无括注处理。
 */
function blockState(
  bot: any,
  name: string,
  p: { x: number; y: number; z: number },
): { age?: { value: number; max: number }; moisture?: { value: number; max: number } } {
  const max = CROP_MAX_AGE[name];
  if (max === undefined && name !== 'farmland') return {};
  const b = bot.blockAt(p as never);
  const props = typeof b?.getProperties === 'function' ? b.getProperties() : undefined;
  if (name === 'farmland') {
    const moisture = Number(props?.moisture);
    return Number.isFinite(moisture) ? { moisture: { value: moisture, max: FARMLAND_MAX_MOISTURE } } : {};
  }
  const age = Number(props?.age);
  return Number.isFinite(age) ? { age: { value: age, max } } : {};
}

/**
 * 那一格是农作物时读它的 age(原版方块状态原值);不是作物或读不出返回 null。
 * probe 的命中清单与 collect 的「只收熟的」都用它——同一份读数,两处不各写各的。
 */
export function cropAgeAt(
  bot: any,
  p: { x: number; y: number; z: number },
): { value: number; max: number } | null {
  const b = bot.blockAt(p as never);
  if (!b) return null;
  const max = CROP_MAX_AGE[b.name as string];
  if (max === undefined) return null;
  const props = typeof b.getProperties === 'function' ? b.getProperties() : undefined;
  const age = Number(props?.age);
  return Number.isFinite(age) ? { value: age, max } : null;
}

/**
 * 感知半径内 age 到顶的农作物。到期事件的观察源:作物的成熟**只能观察,不能倒计时**
 * ——随机刻是 `randomTickSpeed/4096` 的几何分布再乘生长点数判定,报「按估计几秒后熟」
 * 就是在编数(熔炉那种确定性 200 刻一件才可以估)。
 */
export function scanMatureCrops(
  bot: any,
  maxDistance = 16,
): Array<{ x: number; y: number; z: number; name: string; age: number; max: number }> {
  const out: Array<{ x: number; y: number; z: number; name: string; age: number; max: number }> = [];
  for (const [name, max] of Object.entries(CROP_MAX_AGE)) {
    const id = bot.registry?.blocksByName?.[name]?.id;
    if (id === undefined) continue;
    for (const p of bot.findBlocks({ matching: [id], maxDistance, count: 64 })) {
      const age = cropAgeAt(bot, p);
      if (age && age.value >= age.max) out.push({ x: p.x, y: p.y, z: p.z, name, age: age.value, max });
    }
  }
  return out;
}

/** 那一格所在的群系名;区块未加载(或注册表缺群系表)时 'unknown'。 */
export function biomeAt(bot: any, pos: { x: number; y: number; z: number }): string {
  try {
    const b = bot.blockAt(pos as never);
    const rec = b && bot.registry?.biomes?.[b.biome.id];
    return rec ? rec.name : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Captures a flat Mineflayer snapshot. Inventory data is trusted only after `invSynced`;
 * `scanBlocks: false` omits the block scan.
 */
/**
 * 玩家物品栏窗口里的装备槽下标(原版协议固定值):5–8 是头胸腿脚,45 是副手。
 * `bot.inventory.items()` 只给主物品栏,这五格一格都不在里面。
 */
const GEAR_SLOT_INDEX: ReadonlyArray<[GearSlot, number]> = [
  ['head', 5], ['chest', 6], ['legs', 7], ['feet', 8], ['offhand', 45],
];

function readEquipment(bot: any): GearPiece[] {
  const slots = bot.inventory?.slots;
  if (!slots) return [];
  const out: GearPiece[] = [];
  for (const [slot, idx] of GEAR_SLOT_INDEX) {
    const it = slots[idx] as ItemLike | null | undefined;
    if (!it?.name) continue;
    out.push({
      slot, name: it.name, durability: readDurability(it), enchantments: readEnchants(it, bot.registry),
    });
  }
  return out;
}

/** 效果时长是刻,20 刻一秒;查不出名字的效果按 `effect_<id>` 照报,不吞 */
function readEffects(bot: any): StatusEffect[] {
  const raw = bot.entity?.effects;
  if (!raw) return [];
  const out: StatusEffect[] = [];
  for (const key of Object.keys(raw)) {
    const e = raw[key];
    if (!e || typeof e.duration !== 'number' || e.duration <= 0) continue;
    out.push({
      name: bot.registry?.effects?.[e.id]?.name ?? `effect_${e.id}`,
      level: (e.amplifier ?? 0) + 1,
      seconds: Math.round(e.duration / 20),
    });
  }
  return out.sort((a, b) => b.seconds - a.seconds);
}

export function snapshotFromBot(
  bot: any,
  opts?: {
    maxEntities?: number;
    invSynced?: boolean;
    scanBlocks?: boolean;
    /** 现实时刻按哪个时区报;缺省东八区 */
    timezone?: string;
    chestOf?: (dimension: string, p: { x: number; y: number; z: number }) => { items: ItemStack[] } | undefined;
  },
): WorldSnapshot {
  const maxEntities = opts?.maxEntities ?? 12;
  const me = bot.entity;
  const pos = me.position;

  const entities: EntityInfo[] = [];
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e || e === me || !e.position) continue;
    const d = e.position.distanceTo(pos);
    // 距离闸只有 AUDIBLE_RANGE 这一道(旧的 24 格 entityRange 闸已并进来)
    if (d > AUDIBLE_RANGE) continue;
    const name = e.type === 'player' ? (e.username ?? 'player') : (e.name ?? e.displayName ?? 'unknown');
    // 飞行中/插在地上的射弹:看得见也不报
    if (e.name && NOISE_ENTITIES.has(e.name)) continue;
    const kind = e.name === 'piglin' && piglinIsHostile(bot, e)
      ? 'hostile'
      : classifyEntity(e.type, e.name);
    const visible = canSeeEntity(bot, e);
    // 看不见的还得发得出声:落到 other 的(掉落物、经验球、矿车、展示框、盔甲架)
    // 与不发闲置音的水生动物都不进
    if (!visible && (kind === 'other' || SILENT_ENTITIES.has(name))) continue;
    const stack = droppedStackOf(e, bot.registry?.items);
    const note = villagerNote(e);
    entities.push({
      name,
      kind,
      distance: d,
      direction: bearing(e.position.x - pos.x, e.position.z - pos.z),
      dy: Math.round(e.position.y - pos.y),
      visible,
      ...(stack ? { item: stack } : {}),
      ...(note ? { note } : {}),
    });
  }
  entities.sort((a, b) => a.distance - b.distance);

  const nearbyBlocks: WorldSnapshot['nearbyBlocks'] = [];
  const registry = bot.registry;
  const dimension = String(bot.game.dimension ?? 'overworld');
  const containers: WorldSnapshot['nearbyBlocks'] = [];
  if (opts?.scanBlocks !== false) {
    // 判据取代白名单之后扫描也塌成三次:水一次、岩浆一次(各自占满自己的 count),
    // 剩下所有该报的一次全局调用。count 2048 是实测值——150 个采样点上复现
    // "每种最近 8 处"所需的全局 count 最大 1542,不够时只会少报、不会多报。
    const spots = new Map<string, Array<{ x: number; y: number; z: number; distanceTo(o: unknown): number }>>();
    const record = (found: Array<{ x: number; y: number; z: number }>): void => {
      for (const p of found) {
        const name = bot.blockAt(p as never)?.name;
        if (!name) continue;
        const group = spots.get(name);
        if (group) group.push(p as never);
        else spots.set(name, [p as never]);
      }
    };
    for (const bulk of ['water', 'lava']) {
      const id = registry.blocksByName[bulk]?.id;
      if (id === undefined) continue;
      record(bot.findBlocks({ matching: [id], maxDistance: 16, count: 8 }));
    }
    // matching 传判据函数而不是 id 数组:mineflayer 对数组是 indexOf 线性查
    // (blocks.js:117),L6 下这张表有 900 多项、又几乎每个 section 都命中调色板筛,
    // 逐格线性比会把每份快照拖成上亿次比较。函数形态是它原生支持的,Set 查是 O(1)。
    const ids = reportableIds(registry.blocksByName);
    if (ids.size > 0) {
      record(bot.findBlocks({
        matching: ((b: { type: number } | null) => b !== null && ids.has(b.type)) as never,
        maxDistance: 16,
        count: 2048,
      }));
    }

    for (const [blockName, group] of spots) {
      // findBlocks 按区块索引查、无视遮挡;摘要只报射线可及的。按距离先排,
      // 拿到要的那几块就收手——射线不便宜,不能对着上千格逐个打
      group.sort((a, b) => a.distanceTo(pos) - b.distanceTo(pos));
      const container = CONTAINER_BLOCKS.has(blockName);
      const want = container ? CONTAINER_NEARBY_CAP : 1;
      const visible: typeof group = [];
      for (const p of group) {
        if (!canSeeBlockAt(bot, p)) continue;
        visible.push(p);
        if (visible.length >= want) break;
      }
      for (const spot of visible) {
        const common = {
          name: blockName,
          distance: spot.distanceTo(pos),
          direction: bearing(spot.x - pos.x, spot.z - pos.z),
          dy: Math.round(spot.y - pos.y),
          x: spot.x, y: spot.y, z: spot.z,
        };
        if (container) {
          const rec = opts?.chestOf?.(dimension, spot);
          containers.push({ ...common, contents: rec ? rec.items : opts?.chestOf ? null : undefined });
        } else {
          nearbyBlocks.push({ ...common, ...blockState(bot, blockName, spot) });
        }
      }
    }
  }
  containers.sort((a, b) => a.distance - b.distance);
  nearbyBlocks.push(...containers.slice(0, CONTAINER_NEARBY_CAP));
  nearbyBlocks.sort((a, b) => a.distance - b.distance);

  // 脚所在格为液体时报告该格，否则报告脚下格；inWater 只检查头部，不能识别浅水。
  const feetBlock = bot.blockAt(pos);
  const below = feetBlock && LIQUID_UNDERFOOT.has(feetBlock.name)
    ? feetBlock
    : bot.blockAt(pos.offset(0, -1, 0));
  const biome = biomeAt(bot, pos);

  const inWater = headInWater(bot);
  const vel = me.velocity ?? { x: 0, y: 0, z: 0 };
  // 速度是每 tick 的位移,×20 换成格/秒
  const speed = Math.hypot(vel.x, vel.z) * 20;
  const vy = vel.y * 20;
  const onGround = Boolean(me.onGround);
  const motion: Motion =
    inWater && speed > 0.5 ? 'swimming'
      : !onGround && vy < -1.5 ? 'falling'
        : !onGround && vy > 1.5 ? 'rising'
          : speed < 0.5 ? 'still'
            : speed > 5.2 ? 'sprinting' : 'walking';

  // 亮度按"眼睛看到的"算,天光入夜要扣,所以采样得先知道是不是夜里
  const timeOfDay = bot.time?.timeOfDay ?? 0;

  return {
    position: { x: pos.x, y: pos.y, z: pos.z },
    dimension: String(bot.game.dimension ?? 'overworld'),
    health: bot.health ?? 20,
    food: bot.food ?? 20,
    // 旱地上的氧气读数是残留旧值,一律按满算;水下才用真实值(截到 0–20)
    oxygen: inWater ? Math.max(0, Math.min(20, bot.oxygenLevel ?? 20)) : 20,
    inWater,
    invSynced: opts?.invSynced ?? true,
    timeOfDay,
    realTime: nowIso(opts?.timezone ?? 'Asia/Shanghai'),
    light: sampleLight(bot, isNight(timeOfDay)),
    raining: isRaining(bot),
    biome,
    gameMode: String(bot.game.gameMode ?? 'survival'),
    heldItem: bot.heldItem ? bot.heldItem.name : null,
    inventory: (bot.inventory?.items() ?? []).map((it: any) => {
      const ench = readEnchants(it, bot.registry);
      const potion = readPotionName(it);
      return {
        name: it.name, count: it.count,
        ...(ench.length > 0 ? { enchantments: ench } : {}), ...(potion ? { potion } : {}),
      };
    }),
    xpLevel: bot.experience?.level ?? 0,
    equipment: readEquipment(bot),
    effects: readEffects(bot),
    entities: entities.slice(0, maxEntities),
    entitiesOmitted: Math.max(0, entities.length - maxEntities),
    standingOn: below ? below.name : null,
    nearbyBlocks,
    blocksScanned: opts?.scanBlocks !== false,
    players: Object.keys(bot.players ?? {}),
    terrain: opts?.scanBlocks === false ? [] : sampleTerrain(bot, pos),
    motion,
    speed,
    facing: facingOf(me.yaw ?? 0),
    heading: speed < 0.5 ? null : bearing(vel.x, vel.z),
    onGround,
  };
}
