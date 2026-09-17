/**
 * 合成、放置与挖掘以服务端确认为准。
 * 合成产物仅采用服务端槽位更新；放置仅在目标格回读成功后完成；
 * 挖掘只认服务端把那一格改掉,mineflayer 到点自己写空气的那一笔按下不发。
 * 全局 stateId 只认当前打开窗口的包;windowId=-2 的 `set_slot` 没有对应容器,整包拦截。
 *
 * 合成期间光标必须随时可以清空:prismarine-windows 对"手上拿着 A 去点装着 B 的格子"
 * 一律本地换位，原版服务端不换。一次换位两边状态就此分家，之后所有合成都在错的格子上做。
 *
 * 光照段随包到来时必须按 nibble 原序落位,prismarine-chunk 把它当长整型数组读了。
 *
 * 水平碰撞停在离方块面 `WALL_GAP` 处:服务端拒绝包围盒恰好贴着方块侧面的位置(见 `installWallGap`)。
 */
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import type { Logger } from '../../core/types.ts';
import type { MinecraftLog } from './log.ts';
import { readEnchants, type ItemLike } from './item-facts.ts';
import { blockStateItem } from './blueprint-registry.ts';
import { setNameRegistry, zhName } from './names.ts';
import { PLACE_MISS_TTL_MS } from './pathfinder-perf.ts';
import { ShowPacer, type ShowTempo } from './show.ts';
import { dropOwnedGoal } from './executor.ts';

/** 单次点击等待服务端确认的上限。 */
const CLICK_ACK_MS = 400;
/** 摆好材料之后等产出槽被服务端填上的上限 */
const RESULT_WAIT_MS = 1_500;
/** 右键工作台到窗口开出来的上限 */
const WINDOW_OPEN_MS = 2_000;
/** 单次放置等待目标格变化的上限。 */
const PLACE_CONFIRM_MS = 400;
/** 一次放置最多重发几遍 */
const PLACE_TRIES = 3;
/** 挖掘等服务端把那一格改掉的上限:按 digTime 放大,给服务端的补挖留出余量 */
const DIG_CONFIRM_MIN_MS = 8_000;
const DIG_CONFIRM_FACTOR = 3;
/** 悬空起挖等落地的上限:一格下落 ~250ms 足够;水里 onGround 恒假,不等 */
const DIG_GROUND_WAIT_MS = 600;
/** 服务端认账比本地定时器晚这么多就记一条:整片挖掘不刷屏,慢的那些留痕 */
const DIG_SLOW_ACK_MS = 200;
/**
 * 水平碰撞停在离方块面这么远的地方。服务端只要缝隙大于零就收(实测 1e-7 也收),
 * 取 1e-5 让坐标到三千万格时的浮点误差也吃不掉它。
 */
export const WALL_GAP = 1e-5;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 合成配方在这里只用得到这几项;prismarine-recipe 实例的平面形状 */
interface CraftRecipe {
  /** `id: null` = 不预设产物:她自己摆的格子,产出槽出什么就是什么 */
  result: { id: number | null; count: number; metadata?: number | null };
  /** 行内空位写 null(prismarine 用 id:-1,两种都认) */
  inShape?: Array<Array<{ id: number } | null>> | null;
  ingredients?: Array<{ id: number }> | null;
  requiresTable: boolean;
}

/** 挖掘目标方块;免得为一个类型引入 prismarine-block 依赖 */
type DigBlock = Bot['targetDigBlock'];

/** prismarine-windows 的 Window,只标出这里用到的面 */
interface WindowLike {
  id: number;
  type: string;
  slots: Array<{ type: number; count: number; metadata?: number | null; nbt?: unknown } | null>;
  selectedItem: { type: number; count: number; metadata?: number | null; nbt?: unknown } | null;
  inventoryStart: number;
  inventoryEnd: number;
  findInventoryItem(item: number, metadata: number | null, notFull?: boolean): { slot: number } | null;
  findItemRange(
    start: number, end: number, itemType: number, metadata?: number | null,
    notFull?: boolean, nbt?: unknown,
  ): { slot: number } | null;
  firstEmptySlotRange(start: number, end: number): number | null;
}

/** 装了修补的 bot 才有的内部面 */
interface PatchedBot extends Bot {
  _genericPlace(
    referenceBlock: unknown, faceVector: unknown, options: Record<string, unknown>,
  ): Promise<unknown>;
  /** blocks.js 挂在 bot 上的方块写入口:插件从外面写本地世界只有这一条路 */
  _updateBlockState(point: DigBlock['position'], stateId: number): void;
  /**
   * 已确认放置的方块台账(环形,留最近 256 条)。寻路器垫脚/搭路也走 placeBlock,
   * 执行器按步骤前后的长度差把"路上放了什么"写进回执。
   */
  placedLedger?: Array<{ name: string; x: number; y: number; z: number }>;
  /**
   * 三次放置均未确认的落点，was 为回读方块名。
   * 直接技能将其写入回执；寻路另记 pathSupportFailure 并终止当前移动段。
   */
  placeMisses?: Array<{ was: string; x: number; y: number; z: number; at: number }>;
  /** 最近一次寻路支撑未确认；执行器按 seq 区分本段路径与旧失败。 */
  pathSupportFailure?: { seq: number; generation: number; was: string; x: number; y: number; z: number };
  /**
   * 此刻有几笔寻路支撑放置在飞。纯诊断读数(零位移探针要的那一格),不参与任何判据 ——
   * 所有权已经改成按 flight 记,不再有"当前那一次"这种全局单槽。
   */
  pathPlacementActive?: number;
}

/**
 * 必须通过 `bot.loadPlugin` 在内建插件之后注入。`inject_allowed` 之前的替换会被
 * `craft.js` 覆盖;安装成功写入确认日志。
 */
export function installMineflayerFixes(
  bot: Bot,
  log: Logger,
  diag?: MinecraftLog,
  showTempo?: () => ShowTempo | null,
): void {
  if (typeof bot.craft !== 'function' || typeof bot.placeBlock !== 'function') {
    log.error(
      'mineflayer 修补装得太早:bot.craft/placeBlock 还不存在,说明内建插件尚未注入,' +
      '这次替换会被随后的注入覆盖掉。应经 bot.loadPlugin 装,别在 createBot 之后直接调',
    );
  }

  /**
   * 仅在合成和放置窗口记录包流,避免高频 set_slot 覆盖诊断信号。
   * 而要看的恰恰是"这两件事发生的那几百毫秒里,服务端往回说了什么"。
   */
  let tracing = 0;
  const trace = (event: string, msg: string, data?: Record<string, unknown>): void => {
    if (tracing <= 0) return;
    diag?.write({ lane: 'craft', event, msg, data });
  };

  // 中文名拼名器在这里才第一次拿得到 registry:拼得出中文名 ≠ 这个 id 存在,
  // 装上之后 `deepslate_cobblestone` 那类假 id 会在回执里带出原始 id(names.ts 模块头)
  setNameRegistry(bot.registry as unknown as Parameters<typeof setNameRegistry>[0] | undefined);
  fixFoodComponentSchema(bot, log);
  fixPotionContentsSchema(bot, log);
  fixToolTierMaterials(bot, log);
  installComponentDigTime(bot);
  installStateIdGuard(bot, diag, () => tracing > 0);
  installPacketTrace(bot, trace);
  installConfirmedPlace(bot as PatchedBot, diag, (n) => { tracing += n; });
  installConfirmedDig(bot as PatchedBot, log, diag);
  installDiggingLatchRelease(bot, diag);
  installConfirmedCraft(bot, diag, trace, (n) => { tracing += n; }, showTempo);
  installLightRelay(bot, log, diag);
  installDismountFix(bot, diag);
  installWallGap();
  log.info(`mineflayer 修补已装上:合成取服务端产物、放置短超时重发、附魔按组件格式计入挖掘、挖掘等服务端改掉那一格、stateId 认当前窗口、光照段重新落位、水平碰撞留缝${diag ? '' : '(没给 World 日志,包流不留痕)'}`);
}

/** 原型上的标记:同一进程里多个连接、多份模块实例只改一次 */
const WALL_GAP_MARK = Symbol.for('cortico.minecraft.wallGap');

interface PhysicsBox {
  minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
  computeOffsetX(other: PhysicsBox, offset: number): number;
  computeOffsetZ(other: PhysicsBox, offset: number): number;
}

/**
 * 1.21.11 的服务端把「包围盒恰好贴着方块侧面」的位置当成撞进方块:不打 moved wrongly,
 * 静默把人传送回上一个好位置(1.21.10 及更早照收)。prismarine-physics 的碰撞解算恰好停在
 * 贴面处,于是贴墙、上台阶、贴墙起跳每一拍都被打回,人钉在原地。竖直方向贴面照收,这里只改 X/Z:
 * 朝方块走的那一步停在离面 `WALL_GAP` 处;已经贴着(服务端传送来的位置就是贴面的)
 * 再往里走时退开同样的距离。bot 的物理与寻路器的模拟共用这一个类,一处改两处生效。
 */
export function installWallGap(): void {
  const mfRequire = createRequire(createRequire(import.meta.url).resolve('mineflayer/package.json'));
  const AABB = mfRequire('prismarine-physics/lib/aabb.js') as { prototype: PhysicsBox & { [WALL_GAP_MARK]?: true } };
  const proto = AABB.prototype;
  if (proto[WALL_GAP_MARK]) return;
  // this 是方块的盒子,other 是正在挪的实体的盒子(prismarine-physics 这么调)
  proto.computeOffsetX = function (this: PhysicsBox, other: PhysicsBox, offsetX: number): number {
    if (other.maxY > this.minY && other.minY < this.maxY && other.maxZ > this.minZ && other.minZ < this.maxZ) {
      if (offsetX > 0 && other.maxX <= this.minX + WALL_GAP) {
        offsetX = Math.min(this.minX - other.maxX - WALL_GAP, offsetX);
      } else if (offsetX < 0 && other.minX >= this.maxX - WALL_GAP) {
        offsetX = Math.max(this.maxX - other.minX + WALL_GAP, offsetX);
      }
    }
    return offsetX;
  };
  proto.computeOffsetZ = function (this: PhysicsBox, other: PhysicsBox, offsetZ: number): number {
    if (other.maxX > this.minX && other.minX < this.maxX && other.maxY > this.minY && other.minY < this.maxY) {
      if (offsetZ > 0 && other.maxZ <= this.minZ + WALL_GAP) {
        offsetZ = Math.min(this.minZ - other.maxZ - WALL_GAP, offsetZ);
      } else if (offsetZ < 0 && other.minZ >= this.maxZ - WALL_GAP) {
        offsetZ = Math.max(this.maxZ - other.minZ + WALL_GAP, offsetZ);
      }
    }
    return offsetZ;
  };
  proto[WALL_GAP_MARK] = true;
}

/**
 * set_passengers 中当前载具的乘客名单不再包含自己时，清空 bot.vehicle。
 * 此补丁补齐 mineflayer 仅处理上车名单的下车路径。
 */
function installDismountFix(bot: Bot, diag?: MinecraftLog): void {
  const client = bot._client as unknown as {
    on(name: string, fn: (p: { entityId: number; passengers: number[] }) => void): void;
  };
  client.on('set_passengers', ({ entityId, passengers }) => {
    const vehicle = (bot as unknown as { vehicle: { id?: number } | null }).vehicle;
    if (!vehicle || vehicle.id !== entityId) return;
    if (passengers.includes(bot.entity.id)) return;
    (bot as unknown as { vehicle: unknown }).vehicle = null;
    bot.emit('dismount' as never, vehicle as never);
    diag?.write({ lane: 'skill', event: 'dismount-fix', msg: '载具乘客名单里不再有自己,补清 bot.vehicle(mineflayer 只处理上车那一半)' });
  });
}

type PathfinderBlock = {
  digTime(
    itemType: number | null,
    creative: boolean,
    inWater: boolean,
    notOnGround: boolean,
    enchantments: Array<{ name: string; lvl: number }>,
    effects: unknown,
  ): number;
};

/**
 * 寻路挖掘只在新工具严格更快时换手，同速时返回当前手持物。
 * 规划侧将 null 按徒手成本计价；返回当前物品可保持正确成本，执行侧同槽 equip 不发包。
 */
export function installPathfinderToolSelection(bot: Bot, log: Logger): void {
  const pathfinder = (bot as unknown as {
    pathfinder?: { bestHarvestTool?: (block: PathfinderBlock) => ItemLike | null };
  }).pathfinder;
  if (typeof pathfinder?.bestHarvestTool !== 'function') {
    log.warn('寻路选工具修补没装上:pathfinder 尚未注入');
    return;
  }

  const hotbarStart = (bot.inventory as unknown as { hotbarStart?: number }).hotbarStart ?? 36;
  const inHotbar = (item: ItemLike & { slot?: number }): boolean =>
    typeof item.slot === 'number' && item.slot >= hotbarStart && item.slot < hotbarStart + 9;
  const digTime = (block: PathfinderBlock, item: (ItemLike & { type: number }) | null): number =>
    block.digTime(
      item?.type ?? null,
      false,
      false,
      false,
      item ? readEnchants(item, bot.registry).map((entry) => ({ name: entry.name, lvl: entry.level })) : [],
      bot.entity.effects,
    );

  pathfinder.bestHarvestTool = (block): ItemLike | null => {
    const held = bot.heldItem as (ItemLike & { type: number; slot?: number }) | null;
    // 空手时基线就是 null,规划侧读成徒手、执行侧读成不换手,两边都正确
    let best: (ItemLike & { type: number; slot?: number }) | null = held;
    let fastest = digTime(block, held);
    for (const item of bot.inventory.items() as Array<ItemLike & { type: number; slot?: number }>) {
      if (held && item.slot === held.slot) continue;
      const time = digTime(block, item);
      // 同速那一支只为把选择挪进快捷栏:手上那把已在快捷栏(常态)就不动,免得洗背包
      if (time < fastest || (time === fastest && best !== null && !inHotbar(best) && inHotbar(item))) {
        fastest = time;
        best = item;
      }
    }
    return best;
  };
  log.info('寻路选工具修正:只有严格加快挖掘才换手,同速原样回报手上那把(计价按它算,执行侧不换手)');
}

/**
 * 移除 1.20.6 food 组件表中不属于该版本的 usingConvertsTo 字段，避免 trade_list 解析错位。
 * 登录前修改共享协议表；字段缺席时保持原表。
 */
function fixFoodComponentSchema(bot: Bot, log: Logger): void {
  const food = slotComponentFields(bot, 'food');
  if (!food) return;
  const i = food.findIndex((f) => f?.name === 'usingConvertsTo');
  if (i < 0) return;
  food.splice(i, 1);
  log.info('协议表修正:1.20.6 food 组件摘除 usingConvertsTo,村民报价包(trade_list)解析恢复');
}

/**
 * 移除旧版本 potion_contents 表中提前出现的 customName 字段。
 * 1.20.6 仅发送 potionId、customColor、customEffects；多读字段会使含药水物品的整包解析失败。
 */
function fixPotionContentsSchema(bot: Bot, log: Logger): void {
  const potion = slotComponentFields(bot, 'potion_contents');
  if (!potion) return;
  const i = potion.findIndex((f) => f?.name === 'customName');
  if (i < 0) return;
  potion.splice(i, 1);
  log.info('协议表修正:1.20.6 potion_contents 组件摘除 customName,带药水/水瓶的物品栏包不再被静默丢弃');
}

/** SlotComponent 表里某个组件的字段数组(原地可改);表不在或形状不对给 null。 */
function slotComponentFields(bot: Bot, component: string): Array<{ name?: string }> | null {
  const proto = (bot as unknown as { registry?: { protocol?: { types?: Record<string, unknown> } } }).registry?.protocol;
  const slotComponent = proto?.types?.SlotComponent as
    | [string, Array<{ name?: string; type?: unknown }>]
    | undefined;
  const data = slotComponent?.[1]?.find?.((f) => f?.name === 'data');
  const fields = (data?.type as [string, { fields?: Record<string, unknown> }] | undefined)?.[1]?.fields;
  const def = fields?.[component] as [string, Array<{ name?: string }>] | undefined;
  return Array.isArray(def?.[1]) ? def[1] : null;
}

/**
 * 按 harvestTools 的工具类别修复 incorrect_for_*_tool 被误填为 material 的注册表条目。
 * 仅更新挖掘速度材质，保留 harvestTools 的掉落等级约束。
 * 登录前修改共享数据；没有异常材质时不作改动。
 */
function fixToolTierMaterials(bot: Bot, log: Logger): void {
  const reg = (bot as unknown as {
    registry?: {
      blocksArray?: Array<{ material?: string; harvestTools?: Record<string, boolean> }>;
      materials?: Record<string, Record<string, number>>;
      items?: Record<number, { name?: string } | undefined>;
    };
  }).registry;
  const blocks = reg?.blocksArray;
  const materials = reg?.materials;
  if (!Array.isArray(blocks) || !materials) return;
  let fixed = 0;
  const kinds = new Set<string>();
  for (const b of blocks) {
    if (typeof b.material !== 'string' || !b.material.startsWith('incorrect_for_')) continue;
    const tools = Object.keys(b.harvestTools ?? {});
    if (tools.length === 0) continue;
    // 同一方块的名单必然同类;混了类别就不猜,留着原样
    const kindSet = new Set(tools.map((id) => toolKindOfItem(reg?.items?.[Number(id)]?.name ?? '')));
    if (kindSet.size !== 1) continue;
    const kind = [...kindSet][0];
    if (!materials[`mineable/${kind}`]) continue;
    b.material = `mineable/${kind}`;
    fixed++;
    kinds.add(kind);
  }
  if (fixed > 0) {
    log.info(
      `挖掘速度表修正:${fixed} 种方块的 material 由 incorrect_for_*_tool 换回 ` +
      `mineable/${[...kinds].join('|')}(铁矿配铁镐 4.55 秒→0.75 秒,不再空挥)`,
    );
  }
}

/** `stone_pickaxe` → pickaxe、`shears` → shears */
function toolKindOfItem(itemName: string): string {
  const i = itemName.lastIndexOf('_');
  return i < 0 ? itemName : itemName.slice(i + 1);
}

type DigTimeItem = ItemLike & { type: number; enchants?: unknown };

/**
 * 组件时代的附魔先规范成 prismarine-block 的数组形状。
 * prismarine-item 1.18.0 会把组件的整份 `{enchantments,showTooltip}` 当成 `item.enchants`
 * 返回；mineflayer 4.37.1 随后对它调用 `concat`,附魔工具因此在起挖前直接抛错。
 */
function installComponentDigTime(bot: Bot): void {
  if (typeof bot.digTime !== 'function' || typeof bot.getEquipmentDestSlot !== 'function') return;
  const original = bot.digTime.bind(bot);
  const componentShaped = (item: DigTimeItem | null | undefined): boolean => {
    const data = item?.componentMap?.get('enchantments')?.data;
    return data !== undefined && !Array.isArray(data);
  };
  const normalized = (item: DigTimeItem | null | undefined): Array<{ name: string; lvl: number }> =>
    item ? readEnchants(item, bot.registry).map((e) => ({ name: e.name, lvl: e.level })) : [];

  bot.digTime = ((block): number => {
    const held = bot.heldItem as DigTimeItem | null;
    const headSlot = bot.getEquipmentDestSlot('head');
    const head = bot.inventory.slots[headSlot] as DigTimeItem | null | undefined;
    if (!componentShaped(held) && !componentShaped(head)) return original(block);

    const eye = (bot as unknown as { _getBlockAtEyeLevel(): { name?: string } | null })._getBlockAtEyeLevel();
    return block.digTime(
      held?.type ?? null,
      bot.game.gameMode === 'creative',
      eye?.name === 'water' || eye?.name === 'flowing_water',
      !bot.entity.onGround,
      [...normalized(held), ...normalized(head)],
      bot.entity.effects,
    );
  }) as Bot['digTime'];
}

/**
 * 全局 stateId 只认当前打开窗口那条流。
 *
 * mineflayer 用任意 set_slot/window_items 的 stateId 顶掉全局值,而点击一律带
 * 全局值发出;开着工作台时窗口 0 的更新(副手槽 45 是常客)会让每次点击都带上
 * 错的 stateId,服务端按失步整窗回灌。windowId 与当前窗口对不上的包内容照常
 * 透传,stateId 改写成当前窗口最近一次的值;windowId=-2 没有对应容器,整包拦下。
 */
function installStateIdGuard(bot: Bot, diag: MinecraftLog | undefined, tracing: () => boolean): void {
  const client = bot._client as unknown as {
    emit(name: string, ...args: unknown[]): boolean;
  };
  const origEmit = client.emit.bind(client);
  let dropped = 0;
  let rewritten = 0;
  let goodStateId: number | null = null;
  client.emit = (name: string, ...args: unknown[]): boolean => {
    if (name === 'set_slot' || name === 'window_items') {
      const pkt = args[0] as { windowId?: number; stateId?: number; slot?: number } | undefined;
      if (pkt && name === 'set_slot' && pkt.windowId === -2) {
        dropped++;
        if (tracing()) {
          diag?.write({
            lane: 'craft', event: 'stateid-guard',
            msg: `拦下一个 windowId=-2 的 set_slot(它带的 stateId=${pkt.stateId})`,
            data: { stateId: pkt.stateId, slot: pkt.slot, droppedSoFar: dropped },
          });
        }
        return true;
      }
      if (pkt && typeof pkt.stateId === 'number') {
        const curId = (bot.currentWindow as { id?: number } | null)?.id ?? 0;
        if (pkt.windowId === curId) {
          goodStateId = pkt.stateId;
        } else if (goodStateId !== null && pkt.stateId !== goodStateId) {
          rewritten++;
          if (tracing()) {
            diag?.write({
              lane: 'craft', event: 'stateid-rewrite',
              msg: `${name} 窗口${pkt.windowId} 带的 stateId=${pkt.stateId} 不属于当前窗口${curId},改回 ${goodStateId}`,
              data: { windowId: pkt.windowId, was: pkt.stateId, now: goodStateId, rewrittenSoFar: rewritten },
            });
          }
          pkt.stateId = goodStateId;
        }
      }
    }
    return origEmit(name, ...args);
  };
}

/** 合成/放置那几百毫秒里的包流:发出去的点击、收回来的窗口更新 */
function installPacketTrace(
  bot: Bot,
  trace: (event: string, msg: string, data?: Record<string, unknown>) => void,
): void {
  const client = bot._client as unknown as {
    write(name: string, params: Record<string, unknown>): void;
    on(name: string, cb: (pkt: Record<string, unknown>) => void): void;
  };
  const origWrite = client.write.bind(client);
  client.write = (name: string, params: Record<string, unknown>): void => {
    if (name === 'window_click') {
      const changed = params.changedSlots as unknown[] | undefined;
      trace('click-out', `点击 窗口${params.windowId} 槽${params.slot} 键${params.mouseButton} 模式${params.mode}`, {
        windowId: params.windowId, stateId: params.stateId, slot: params.slot,
        mouseButton: params.mouseButton, mode: params.mode,
        changedSlots: changed?.length ?? 0,
        cursor: params.cursorItem,
      });
    } else if (name === 'block_place') {
      trace('place-out', `放置包 → ${JSON.stringify(params.location)} 面${params.direction}`, {
        location: params.location, direction: params.direction, sequence: params.sequence,
      });
    }
    origWrite(name, params);
  };
  client.on('set_slot', (pkt) => {
    trace('slot-in', `set_slot 窗口${pkt.windowId} 槽${pkt.slot} stateId=${pkt.stateId}`, {
      windowId: pkt.windowId, stateId: pkt.stateId, slot: pkt.slot,
    });
  });
  client.on('window_items', (pkt) => {
    const items = pkt.items as unknown[] | undefined;
    trace('items-in', `window_items 窗口${pkt.windowId} stateId=${pkt.stateId}(整窗回灌)`, {
      windowId: pkt.windowId, stateId: pkt.stateId, count: items?.length ?? 0,
    });
  });
}

/** 线路上一段光照是 2048 字节的 nibble 数组:一字节两格,低半字节在前 */
const LIGHT_SECTION_BYTES = 2048;
/** BitArray 存同一段用 512 个 32 位字 */
const LIGHT_SECTION_WORDS = LIGHT_SECTION_BYTES / 4;

/** 一段光照:只用得到底下那块字。 */
interface LightSection { data: Uint32Array }

/** 随 map_chunk / update_light 一起到的光照字段 */
interface LightPacket {
  skyLight?: unknown;
  blockLight?: unknown;
  skyLightMask?: unknown;
  blockLightMask?: unknown;
  emptySkyLightMask?: unknown;
  emptyBlockLightMask?: unknown;
}

/** 装了光照段的列;`sections[i]` 的 i 与掩码位一一对应(0 是比世界底还低的那层) */
interface LightColumn {
  skyLightSections: Array<LightSection | null>;
  blockLightSections: Array<LightSection | null>;
}

/**
 * 掩码位。protodef 把 i64 解成 [高 32 位, 低 32 位] 一对;掩码只有二十几位,
 * 但位号仍按 64 位一格数。
 */
function maskBit(mask: unknown, index: number): boolean {
  if (!Array.isArray(mask)) return false;
  const word: unknown = mask[index >> 6];
  const bit = index & 63;
  if (typeof word === 'bigint') return ((word >> BigInt(bit)) & 1n) === 1n;
  if (!Array.isArray(word)) return false;
  const [hi, lo] = word as [number, number];
  return bit >= 32 ? ((hi >>> (bit - 32)) & 1) === 1 : ((lo >>> bit) & 1) === 1;
}

/**
 * 把随包来的光照字节按原序重写进已装好的段里,返回重写了几段。
 *
 * 走法要与上游一字不差:掩码位与"全零位"都没有的段跳过(包里没这段),
 * 全零段包里也不带数据数组,只有掩码位为 1 的段才按序取走一份。
 */
function relightSections(
  sections: Array<LightSection | null>, arrays: unknown, mask: unknown, emptyMask: unknown,
): number {
  if (!Array.isArray(arrays)) return 0;
  let next = 0;
  let fixed = 0;
  for (let i = 0; i < sections.length; i++) {
    const empty = maskBit(emptyMask, i);
    if (!maskBit(mask, i) && !empty) continue;
    if (empty) continue;
    const raw = arrays[next++] as ArrayLike<number> | undefined;
    const section = sections[i];
    if (!section || !raw || raw.length !== LIGHT_SECTION_BYTES) continue;
    if (!(section.data instanceof Uint32Array) || section.data.length !== LIGHT_SECTION_WORDS) continue;
    // 小端机上 Uint32Array 视图的字节序就是 nibble 的原序:这正是上游读存盘光照
    // (_loadBlockLightNibbles)用的那套布局,读回来的 get(i) 才落在第 i 格上
    const bytes = new Uint8Array(LIGHT_SECTION_BYTES);
    bytes.set(raw);
    section.data.set(new Uint32Array(bytes.buffer));
    fixed++;
  }
  return fixed;
}

/**
 * 光照段按原始 nibble 顺序写入，每段为 2048 字节。
 * 覆盖上游按大端长整型读入的布局，避免每八字节倒序导致坐标错配。
 */
function installLightRelay(bot: Bot, log: Logger, diag?: MinecraftLog): void {
  const client = bot._client as unknown as {
    on(name: string, cb: (pkt: LightPacket & Record<string, unknown>) => void): void;
  };
  let announced = false;
  let warned = false;
  const apply = (cx: number, cz: number, pkt: LightPacket): void => {
    // bot.world 要到 login 包才创建(晚于插件注入),只能在事件时刻取——这两个包都在 login 之后
    const world = bot.world as unknown as { getColumn(x: number, z: number): LightColumn | null } | undefined;
    if (typeof world?.getColumn !== 'function') {
      if (!warned) {
        warned = true;
        log.warn('bot.world 没有 getColumn,光照段重新落位没生效:亮度读数不可信');
      }
      return;
    }
    const column = world.getColumn(cx, cz);
    if (!column) return;
    const fixed =
      relightSections(column.skyLightSections, pkt.skyLight, pkt.skyLightMask, pkt.emptySkyLightMask) +
      relightSections(column.blockLightSections, pkt.blockLight, pkt.blockLightMask, pkt.emptyBlockLightMask);
    if (fixed === 0 || announced) return;
    announced = true;
    diag?.write({
      lane: 'link', event: 'light-relay',
      msg: `光照段已按 nibble 原序重写(首个区块 ${cx},${cz} 改了 ${fixed} 段)`,
      data: { chunkX: cx, chunkZ: cz, sections: fixed },
    });
  };
  client.on('map_chunk', (pkt) => apply(Number(pkt.x), Number(pkt.z), pkt));
  client.on('update_light', (pkt) => apply(Number(pkt.chunkX), Number(pkt.chunkZ), pkt));
  log.debug('光照段重新落位已挂上 map_chunk/update_light');
}

/**
 * 放置方块使用短超时和原位重试,避免触发寻路器全量重算。
 *
 * 重发是安全的:每次先回读那一格,已经变了就直接收工;真的放成了而回包慢的话,
 * 第二次的放置目标已经被自己的方块占着,服务端照样不会放出第二块。
 */
function installConfirmedPlace(
  bot: PatchedBot, diag: MinecraftLog | undefined, setTracing: (delta: number) => void,
): void {
  let pathGeneration = 0;
  interface PathPlacementFlight {
    promise: Promise<void>;
    joined: number;
    generation: number;
    at: { x: number; y: number; z: number };
  }
  const pathPlacementFlights = new Map<string, PathPlacementFlight>();
  bot.on('goal_updated', () => { pathGeneration += 1; });
  // 代次 = 「还是不是原来那一段路」。换目标只是换代的一半:同一个目标内上游还会因
  // stuck / block_updated / chunk_loaded / dig_error 反复 resetPath 重铺路,旧路上的
  // 支撑那时已经作废,它迟到的失败不该去撤新铺的那一条。`path_reset`(index.js:124)
  // 是这些重铺唯一的外部信号。它只在 `path.length > 0` 时发 —— 路本来就是空的那几次
  // 不换代,但那种时候也没有支撑在飞,漏不着。
  bot.on('path_reset', () => { pathGeneration += 1; });
  bot.placeBlock = async (referenceBlock, faceVector): Promise<void> => {
    // `async` 不能省:`referenceBlock.position.plus(...)` 的参数异常在同步函数里会
    // 当场 throw,而调用方(含 pathfinder 自己)一律按 rejected promise 接 `.catch()`,
    // 同步抛出全部漏接。函数体内没有 await,下面的合并窗口仍然是同步的。
    const dest = referenceBlock.position.plus(faceVector);
    const generation = bot.pathfinder?.isBuilding?.() === true ? pathGeneration : null;
    if (generation === null) return placeConfirmed(referenceBlock, faceVector, dest, null);

    // 合并键只认「哪一代的哪一格」,不认参照面:同一格从两个面放,先到的那次放成了
    // 第二次也无事可做(回读已经变了),放不成则两个面多半同因(那一格被占/够不着);
    // 把参照面纳入键会让两次真的并行发包,同一格扣两份料,正是合并要挡的事。
    // 代价是"A 面放不成、B 面本来能放成"那一支会被一起判失败,失败侧本就重试三次并
    // 每次回读,损失有界。
    const key = `${generation}:${dest.x},${dest.y},${dest.z}`;
    const current = pathPlacementFlights.get(key);
    if (current) {
      current.joined += 1;
      return current.promise;
    }

    const flight: PathPlacementFlight = {
      promise: Promise.resolve(), joined: 0, generation,
      at: { x: dest.x, y: dest.y, z: dest.z },
    };
    bot.pathPlacementActive = (bot.pathPlacementActive ?? 0) + 1;
    flight.promise = placeConfirmed(referenceBlock, faceVector, dest, { key, flight }).finally(() => {
      bot.pathPlacementActive = Math.max(0, (bot.pathPlacementActive ?? 1) - 1);
      if (pathPlacementFlights.get(key) === flight) pathPlacementFlights.delete(key);
      if (flight.joined > 0) {
        diag?.write({
          lane: 'skill', event: 'path-support-coalesced',
          msg: `寻路支撑 (${flight.at.x}, ${flight.at.y}, ${flight.at.z}) 的 ${flight.joined + 1} 个重叠请求合并成一次放置`,
          data: { generation: flight.generation, at: flight.at, calls: flight.joined + 1 },
        });
      }
    });
    pathPlacementFlights.set(key, flight);
    return flight.promise;
  };

  async function placeConfirmed(
    referenceBlock: Parameters<PatchedBot['placeBlock']>[0],
    faceVector: Parameters<PatchedBot['placeBlock']>[1],
    dest: Parameters<Bot['blockAt']>[0],
    pathPlacement: { key: string; flight: PathPlacementFlight } | null,
  ): Promise<void> {
    const before = bot.blockAt(dest);
    const startedAt = Date.now();
    // 直接技能复用放置负缓存：同格、方块名未变且在 TTL 内则拒绝重试。
    // 寻路放置已在搜索层排除，仍通过 flight 记录确认与所有权。
    if (pathPlacement === null) {
      const stale = recentPlaceMiss(bot, dest);
      if (stale !== null) {
        diag?.write({
          lane: 'skill', event: 'place-miss-cached',
          msg: `(${dest.x}, ${dest.y}, ${dest.z}) ${Math.round(stale.agoMs / 1000)} 秒前放过三次都没确认,`
            + `那一格现在还是${zhName(stale.was)}:这次不发包`,
          data: { at: { x: dest.x, y: dest.y, z: dest.z }, was: stale.was, agoMs: stale.agoMs },
        });
        throw new Error(`No block has been placed : the block is still ${stale.was}`);
      }
    }
    // 期望落地的是哪一样:`_genericPlace` 放的就是手上这件。取得到方块名才校验身份,
    // 取不到(水桶、红石粉、种子这类"物品名 ≠ 方块名"的)一律降级为旧口径并在 diag 标注
    const want = placedBlockExpectation(bot);
    setTracing(1);
    try {
      for (let attempt = 1; attempt <= PLACE_TRIES; attempt++) {
        // 重试前回读目标位置;前次放置的迟到回包不得触发重复放置。
        const ok = attempt > 1 && changedAt(bot, dest, before, want)
          ? true
          : await placeOnce(bot, referenceBlock, faceVector, dest, before, want);
        if (ok) {
          diag?.write({
            lane: 'skill', event: 'place-confirmed', durMs: Date.now() - startedAt,
            msg: `放置在第 ${attempt} 次回读到了 (${dest.x}, ${dest.y}, ${dest.z})`
              + (want === null ? '(没校验落地的是不是要放的那样)' : ''),
            data: {
              attempt, at: { x: dest.x, y: dest.y, z: dest.z },
              want, identityChecked: want !== null, placed: bot.blockAt(dest)?.name ?? null,
            },
          });
          const placed = bot.blockAt(dest);
          if (placed) {
            const ledger = (bot.placedLedger ??= []);
            ledger.push({ name: placed.name, x: dest.x, y: dest.y, z: dest.z });
            if (ledger.length > 256) ledger.splice(0, ledger.length - 256);
          }
          // 保持 placeBlock 的 blockPlaced 事件契约;mineflayer 类型表未声明该事件。
          (bot as unknown as { emit(n: string, ...a: unknown[]): void })
            .emit('blockPlaced', before, bot.blockAt(dest));
          return;
        }
      }
    } finally {
      setTracing(-1);
    }
    const was = before?.name ?? 'air';
    const misses = (bot.placeMisses ??= []);
    // at 供寻路器的被拒格黑名单判时效(pathfinder-perf 模块头第 8 条)
    misses.push({ was, x: dest.x, y: dest.y, z: dest.z, at: Date.now() });
    if (misses.length > 256) misses.splice(0, misses.length - 256);
    // 寻路支撑未获服务端确认时撤销目标，避免再次使用未成立的承重条件。
    // 每次放置由自己的 flight 持有所有权；代次校验用于排除迟到结果。
    const owns = pathPlacement !== null
      && pathPlacementFlights.get(pathPlacement.key) === pathPlacement.flight
      && pathGeneration === pathPlacement.flight.generation;
    if (owns) {
      const seq = (bot.pathSupportFailure?.seq ?? 0) + 1;
      bot.pathSupportFailure = {
        seq, generation: pathPlacement.flight.generation, was,
        x: dest.x, y: dest.y, z: dest.z,
      };
      // 撤的是谁的目标要说得出来:这一路与 executor/combat/反射共用同一本所有权账
      dropOwnedGoal(bot, 'path-support', `搭路支撑 (${dest.x}, ${dest.y}, ${dest.z}) 三次未确认`, diag);
      diag?.write({
        lane: 'skill', event: 'path-support-unconfirmed',
        msg: `寻路支撑 (${dest.x}, ${dest.y}, ${dest.z}) 未确认,已取消当前移动段`,
        data: {
          seq, generation: pathPlacement.flight.generation, was,
          at: { x: dest.x, y: dest.y, z: dest.z },
        },
      });
    }
    // 现场几何随案卷:拒放的规律(台架实测"越贴身越拒",脚下低一格 0%)要靠
    // 人在哪、离目标多远、有没有潜行这几个数才能对上号,只有坐标断不了案
    const feet = bot.entity?.position;
    const eye = feet ? { x: feet.x, y: feet.y + 1.62, z: feet.z } : null;
    diag?.write({
      lane: 'skill', event: 'place-unconfirmed', durMs: Date.now() - startedAt,
      msg: `放了 ${PLACE_TRIES} 次,(${dest.x}, ${dest.y}, ${dest.z}) 回读`
        + (want !== null && bot.blockAt(dest)?.name !== (before?.name ?? null)
          ? `变成了${bot.blockAt(dest)?.name ?? '空气'},不是要放的 ${want}`
          : `还是${before?.name ?? '空气'}`),
      data: {
        at: { x: dest.x, y: dest.y, z: dest.z },
        was: before?.name ?? null,
        want, identityChecked: want !== null, now: bot.blockAt(dest)?.name ?? null,
        feet: feet ? { x: Number(feet.x.toFixed(2)), y: Number(feet.y.toFixed(2)), z: Number(feet.z.toFixed(2)) } : null,
        eyeDist: eye
          ? Number(Math.hypot(eye.x - (dest.x + 0.5), eye.y - (dest.y + 0.5), eye.z - (dest.z + 0.5)).toFixed(2))
          : null,
        sneak: (bot as unknown as { controlState?: Record<string, boolean> }).controlState?.sneak ?? null,
        face: faceVector && typeof faceVector === 'object'
          ? { x: (faceVector as { x: number }).x, y: (faceVector as { y: number }).y, z: (faceVector as { z: number }).z }
          : null,
        held: bot.heldItem?.name ?? null,
      },
    });
    // 保持 mineflayer 错误文本,供寻路器沿兼容的 catch 分支处理。
    throw new Error(`No block has been placed : the block is still ${before?.name}`);
  }
}

async function placeOnce(
  bot: PatchedBot,
  referenceBlock: unknown,
  faceVector: unknown,
  dest: { x: number; y: number; z: number },
  before: { type: number } | null,
  want: string | null,
): Promise<boolean> {
  await bot._genericPlace(referenceBlock, faceVector, { swingArm: 'right' });
  return waitBlockChanged(bot, dest, before, PLACE_CONFIRM_MS, want);
}

/**
 * 手上这件东西放下去应当变成哪个方块名;答不出返回 null。
 *
 * 只在 registry 里 `blocksByName` 直接有同名方块时答得出 —— 水桶→水、红石粉→红石线、
 * 种子→小麦这类"物品名 ≠ 方块名"的一律不答,宁可退回旧口径也不能把真放置判成失败。
 */
function placedBlockExpectation(bot: Bot): string | null {
  const held = (bot.heldItem as { name?: string } | null)?.name;
  if (!held) return null;
  const blocks = (bot.registry as unknown as { blocksByName?: Record<string, unknown> } | null)?.blocksByName;
  return blocks?.[held] === undefined ? null : held;
}

/**
 * 确认落地方块与目标物品同名，或映射到同一物品形态。
 * want 为 null 时只能确认目标格发生变化，不能断言材料身份。
 */
function placedAsWanted(name: string, want: string): boolean {
  if (name === want) return true;
  if (!name) return false;
  return blockStateItem(`minecraft:${name}`).item === want;
}

function changedAt(
  bot: Bot,
  dest: { x: number; y: number; z: number },
  before: { type: number } | null,
  want: string | null = null,
): boolean {
  const now = bot.blockAt(dest as never) as { type: number; name: string } | null;
  if (want !== null) return now !== null && placedAsWanted(now.name, want);
  if (!now || !before) return now !== before;
  return now.type !== before.type;
}

async function waitBlockChanged(
  bot: Bot, dest: { x: number; y: number; z: number }, before: { type: number } | null, ms: number,
  want: string | null = null,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (changedAt(bot, dest, before, want)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
}

/**
 * 这一格最近有没有被三连拒过、且还是当时那种方块。有就返回那一笔,没有返回 null。
 * 判据与寻路搜索黑名单(pathfinder-perf `getNeighbors`)逐字同一套,共用一个 TTL 常量。
 */
function recentPlaceMiss(
  bot: PatchedBot, dest: { x: number; y: number; z: number },
): { was: string; agoMs: number } | null {
  const misses = bot.placeMisses;
  if (!misses || misses.length === 0) return null;
  const now = Date.now();
  // 同一格可能有多笔,以最近的一笔为准
  for (let i = misses.length - 1; i >= 0; i--) {
    const m = misses[i];
    if (m.x !== dest.x || m.y !== dest.y || m.z !== dest.z) continue;
    const agoMs = now - m.at;
    if (agoMs > PLACE_MISS_TTL_MS) return null;
    // 世界变过了就放行重试:黑名单挡的是"什么都没变的重试",不是这一格本身
    return (bot.blockAt(dest as never)?.name ?? 'air') === m.was ? { was: m.was, agoMs } : null;
  }
  return null;
}

/**
 * 挖掘以服务端改掉那一格为准。
 *
 * mineflayer 的挖掘是开环的:发一次 start,按 `bot.digTime` 起一个本地定时器,到点发
 * finish,并且**自己把那格写成空气**(digging.js 里的 `bot._updateBlockState(pos, 0)`)。
 * 那一笔假更新触发它自己挂的位置监听,`bot.dig()` 就此 resolve —— 服务端同不同意都
 * 一样。服务端那头是另一本账:它按 tick 自算破坏进度,收到 finish 时进度不到 0.7 就
 * 不破坏,而是把这格挂进延迟破坏自己接着挖。两本账一分家,就是"回执是假的"、"挖了
 * 没掉",以及观察端看到的"一路没有裂纹,然后方块突然掉下来"。
 *
 * 这里把那一笔假更新按下不发(本地世界照真的留着),只补出 digging.js 在等的那个位置
 * 事件让 `bot.dig()` 照常返回,然后自己等服务端真的把那一格改掉。判据是"那格变成了
 * 别的东西",不是"必须变成空气":含水方块挖完留下的是水。
 *
 * 等不到就抛错,**绝不自动重挖**:每发一次 start,服务端的破坏进度就清零一次,重挖周期
 * 短于真实耗时的话那一格永远挖不动。要不要再来一次交给上面决定。
 *
 * 拦得住是因为只有 digging.js 从外面调 `bot._updateBlockState`;blocks.js 处理服务端方块
 * 包走的是模块内的同名闭包,不经过 bot 上这一层。
 */
function installConfirmedDig(bot: PatchedBot, log: Logger, diag?: MinecraftLog): void {
  if (typeof bot.dig !== 'function' || typeof bot._updateBlockState !== 'function') {
    log.warn('挖掘确认没装上:bot.dig / bot._updateBlockState 还不存在,说明内建插件尚未注入');
    return;
  }
  const origDig = bot.dig.bind(bot) as (b: DigBlock, f?: boolean | 'ignore', d?: unknown) => Promise<void>;
  const origUpdate = bot._updateBlockState.bind(bot);

  /** 手上这一次挖掘;不在挖时为 null。mineflayer 本身也只允许同时挖一格。 */
  let digging: { key: string; before: { type: number; name: string } | null; confirmed: boolean } | null = null;

  bot._updateBlockState = (point, stateId): void => {
    if (digging && stateId === 0 && posKey(point) === digging.key) {
      // 世界不动;digging.js 的收尾只看 newBlock.type === 0,补一个空气壳让它收工。
      const emitter = bot.world as unknown as { emit(name: string, ...args: unknown[]): boolean };
      emitter.emit(`blockUpdate:${point}`, bot.blockAt(point), { type: 0, name: 'air', position: point });
      return;
    }
    origUpdate(point, stateId);
  };

  bot.on('blockUpdate', (_oldBlock, newBlock) => {
    if (!digging || !newBlock?.position) return;
    if (posKey(newBlock.position) !== digging.key) return;
    if (newBlock.type === digging.before?.type) return; // 同一种方块的重发不算确认
    digging.confirmed = true;
  });

  bot.dig = (async (block: DigBlock, forceLook?: boolean | 'ignore', digFace?: unknown): Promise<void> => {
    const pos = block.position;
    // 非水中悬空时，开挖前最多等 DIG_GROUND_WAIT_MS 毫秒落地，再按当刻姿态计算挖掘时长。
    // 超时仍照常开挖；水下不等待落地，保留水下速度惩罚。
    const airborne = (): boolean => {
      const e = bot.entity as { onGround?: boolean; isInWater?: boolean } | undefined;
      return e?.onGround === false && e.isInWater !== true;
    };
    if (airborne()) {
      const t0 = Date.now();
      while (airborne() && Date.now() - t0 < DIG_GROUND_WAIT_MS) await sleep(20);
      const waited = Date.now() - t0;
      if (waited >= 100) {
        diag?.write({
          lane: 'skill', event: 'dig-ground-wait', durMs: waited,
          msg: `悬空起挖:等了 ${(waited / 1000).toFixed(1)} 秒${airborne() ? '还没落地,照旧开挖' : '落了地'}再算挖掘时长`,
          data: { at: { x: pos.x, y: pos.y, z: pos.z }, landed: !airborne() },
        });
      }
    }
    const before = bot.blockAt(pos);
    const digMs = bot.digTime(block);
    const budget = Number.isFinite(digMs)
      ? Math.max(DIG_CONFIRM_MIN_MS, digMs * DIG_CONFIRM_FACTOR)
      : DIG_CONFIRM_MIN_MS;
    const mine = { key: posKey(pos), before, confirmed: false };
    const at = `(${pos.x}, ${pos.y}, ${pos.z})`;
    const was = before ? zhName(before.name) : '那一格';
    const startedAt = Date.now();
    digging = mine;
    try {
      await origDig(block, forceLook, digFace);
      // mineflayer 认为挖完了的时刻;它与服务端认账的时刻差多少,正是这条链要盯的数
      const localDone = Date.now();
      const deadline = localDone + budget;
      while (!mine.confirmed && !(before && changedAt(bot, pos, before))) {
        if (Date.now() >= deadline) {
          diag?.write({
            lane: 'skill', event: 'dig-unconfirmed', durMs: Date.now() - startedAt,
            msg: `等了 ${(budget / 1000).toFixed(1)} 秒,服务端没把 ${at} 的${was}挖掉`,
            data: { at: { x: pos.x, y: pos.y, z: pos.z }, was: before?.name ?? null, digMs, budgetMs: budget },
          });
          throw new Error(
            `服务端没认这一下:等了 ${(budget / 1000).toFixed(1)} 秒,${at} 还是${was}` +
            '(可能够不着、被保护,或者服务端那头还在自己补挖)',
          );
        }
        await sleep(20);
      }
      const waitedMs = Date.now() - localDone;
      if (waitedMs >= DIG_SLOW_ACK_MS) {
        diag?.write({
          lane: 'skill', event: 'dig-late-ack', durMs: Date.now() - startedAt,
          msg: `${at} 的${was}:本地按 ${(digMs / 1000).toFixed(1)} 秒挖完,服务端又晚了 ${(waitedMs / 1000).toFixed(1)} 秒才认账`,
          data: { at: { x: pos.x, y: pos.y, z: pos.z }, was: before?.name ?? null, digMs, waitedMs },
        });
      }
    } finally {
      if (digging === mine) digging = null;
    }
  }) as unknown as Bot['dig'];
}

/**
 * stopDigging 返回后，若寻路器仍认为在挖且没有 targetDigBlock，补调用中止监听。
 * 此状态可出现在寻路器等待 equip 时；上游的空目标返回不会清除 digging 闩锁。
 * 仅调用零参数监听器：其他监听器需要真实方块来更新挖掘退避账。
 */
function installDiggingLatchRelease(bot: Bot, diag?: MinecraftLog): void {
  type Digger = (...args: unknown[]) => unknown;
  const noop = ((): void => undefined) as Digger;
  let impl: Digger = typeof bot.stopDigging === 'function' ? (bot.stopDigging as Digger) : noop;
  let released = 0;
  const wrapped = (...args: unknown[]): unknown => {
    const had = bot.targetDigBlock ?? null;
    const out = impl.apply(bot, args);
    if (had !== null) return out; // 真中止过:事件由 digging.js 自己发,不重复
    if (bot.pathfinder?.isMining?.() !== true) return out;
    const listeners = (bot as unknown as { listeners(name: string): unknown[] })
      .listeners('diggingAborted') as Digger[];
    const blind = listeners.filter((fn) => typeof fn === 'function' && fn.length === 0);
    for (const fn of blind) fn.call(bot);
    released += 1;
    diag?.write({
      lane: 'path', event: 'dig-latch-released',
      msg: '寻路器自认在挖、身上却没有挖掘目标(equip 窗口里被 resetPath 撞上):' +
        `已补一记中止解开闩锁,${blind.length === 0 ? '但没有监听器接' : '否则会一直零位移'}`,
      data: { listeners: blind.length, releasedSoFar: released },
    });
    return out;
  };
  // `bot.stopDigging` 每开一次 `dig()` 就被换成那一次的闭包、abort 之后又换回 noop
  // (digging.js:165/188/260),所以只能包在存取器上,包一次函数会被下一次挖掘顶掉。
  Object.defineProperty(bot, 'stopDigging', {
    configurable: true,
    enumerable: true,
    get: () => wrapped,
    set: (fn: Digger) => { if (typeof fn === 'function') impl = fn; },
  });
}

/** 方块位置的比较键;写入与事件来自不同来源,只认整数坐标 */
function posKey(p: { x: number; y: number; z: number }): string {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

/**
 * 合成产物仅取服务端更新。每种材料放置完后归还余量，材料切换时游标必须为空。
 */
function installConfirmedCraft(
  bot: Bot,
  diag: MinecraftLog | undefined,
  trace: (event: string, msg: string, data?: Record<string, unknown>) => void,
  setTracing: (delta: number) => void,
  showTempo?: () => ShowTempo | null,
): void {
  bot.craft = async (recipe, count, craftingTable): Promise<void> => {
    const r = recipe as unknown as CraftRecipe;
    const times = Math.max(1, Number(count ?? 1));
    if (r.requiresTable && !craftingTable) {
      throw new Error('Recipe requires craftingTable, but one was not supplied');
    }
    // 开始前关闭遗留窗口；clickWindow 始终以 bot.currentWindow 为目标。
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
    setTracing(1);
    let opened: WindowLike | null = null;
    // 演出节拍:只有工作台窗口在摄像机上看得见(窗口 0 的徒手合成协议上没有开窗,
    // 白等没人看);预算由这一整次 bot.craft 共享,times 大时后面的轮次自动恢复瞬时
    const show = new ShowPacer(r.requiresTable ? showTempo?.() ?? null : null);
    const startedAt = Date.now();
    try {
      for (let i = 0; i < times; i++) {
        let window: WindowLike;
        if (r.requiresTable) {
          const firstOpen = opened === null;
          // 上一次关窗离现在太近就先空开:同步屏那边看是一次闪屏(见 show.ts openGap)
          if (firstOpen) await show.openGap();
          opened ??= await openCraftingTable(bot, craftingTable as never);
          window = opened;
          if (firstOpen) await show.beat('open');
        } else {
          window = bot.inventory as unknown as WindowLike;
        }
        await craftOnce(bot, window, r, trace, show);
      }
      diag?.write({
        lane: 'craft', event: 'confirmed', durMs: Date.now() - startedAt,
        msg: `按服务端给的产物做完了 ${times} 次` +
          (r.result.id === null ? '(她自己摆的格子)' : `(物品 #${r.result.id})`),
        data: { item: r.result.id, times, table: r.requiresTable },
      });
    } finally {
      // 工作台窗口一关,格子里的材料由服务端退回背包;窗口 0 关不掉,只能自己拿回来,
      // 否则失败时摆进去的材料会一直不在背包清单里。腾空失败不能盖掉合成本身的错。
      if (opened) {
        await show.beat('close');
        bot.closeWindow(opened as never);
      } else {
        await clearGrid(bot, bot.inventory as unknown as WindowLike, trace).catch(() => undefined);
      }
      setTracing(-1);
    }
  };
}

async function openCraftingTable(bot: Bot, block: never): Promise<WindowLike> {
  const window = await new Promise<WindowLike | null>((resolve) => {
    const timer = setTimeout(() => {
      bot.removeListener('windowOpen', onOpen);
      resolve(null);
    }, WINDOW_OPEN_MS);
    function onOpen(w: unknown): void {
      clearTimeout(timer);
      resolve(w as WindowLike);
    }
    bot.once('windowOpen', onOpen);
    void Promise.resolve(bot.activateBlock(block)).catch(() => undefined);
  });
  if (!window) throw new Error('右键了工作台,窗口没开出来');
  if (!window.type.startsWith('minecraft:crafting')) {
    throw new Error(`开出来的不是工作台窗口(${window.type})`);
  }
  return window;
}

/** 徒手是 2x2,工作台是 3x3 */
function gridWidth(window: WindowLike): number {
  return window.type === 'minecraft:inventory' ? 2 : 3;
}

function itemLabel(bot: Bot, id: number): string {
  const name = (bot.registry.items as Record<number, { name?: string } | undefined>)[id]?.name;
  return name ? zhName(name) : `物品 #${id}`;
}

/** 配方 → 每个格子该放什么。格子号 1 起,产出槽是 0 */
function gridPlan(window: WindowLike, recipe: CraftRecipe): Map<number, number> {
  const width = gridWidth(window);
  const plan = new Map<number, number>();
  if (recipe.inShape) {
    for (let y = 0; y < recipe.inShape.length; y++) {
      const row = recipe.inShape[y];
      for (let x = 0; x < row.length; x++) {
        const cell = row[x];
        if (!cell || cell.id === -1) continue;
        plan.set(1 + x + width * y, cell.id);
      }
    }
  } else if (recipe.ingredients) {
    let slot = 1;
    for (const ing of recipe.ingredients) plan.set(slot++, ing.id);
  }
  if (plan.size > width * width) throw new Error('配方摆不进这个合成格');
  return plan;
}

async function craftOnce(
  bot: Bot, window: WindowLike, recipe: CraftRecipe,
  trace: (event: string, msg: string, data?: Record<string, unknown>) => void,
  show?: ShowPacer,
): Promise<void> {
  const plan = gridPlan(window, recipe);
  if (plan.size === 0) throw new Error('这个配方没有材料可摆');
  await clearGrid(bot, window, trace);

  // 按材料分组,一种一趟
  const bySource = new Map<number, number[]>();
  for (const [slot, id] of plan) {
    const list = bySource.get(id);
    if (list) list.push(slot);
    else bySource.set(id, [slot]);
  }

  for (const [id, destSlots] of bySource) {
    let from: number | null = null;
    for (const dest of destSlots) {
      if (!window.selectedItem || window.selectedItem.type !== id) {
        await stashCursor(bot, window, from, id);
        const src = window.findInventoryItem(id, null, false);
        if (!src) throw new Error(`包里没有可用的${itemLabel(bot, id)}`);
        from = src.slot;
        await click(bot, src.slot, 0, 0); // 左键拿起整摞
      }
      await click(bot, dest, 1, 0); // 右键放一个进格子
      await show?.beat('click');
    }
    await stashCursor(bot, window, from, id); // 余下的放回原处,进下一种材料时光标是空的
  }

  const result = await waitForResult(window, recipe.result.id, RESULT_WAIT_MS);
  trace('result-slot', result
    ? `产出槽出现了物品 #${result.type}×${result.count}(服务端给的)`
    : `等了 ${RESULT_WAIT_MS}ms 产出槽还是空的`, { want: recipe.result.id, got: result?.type ?? null });
  if (!result) {
    // 材料已经摆进格子了,调用方的 finally 负责腾空
    const per = new Map<number, number>();
    for (const id of plan.values()) per.set(id, (per.get(id) ?? 0) + 1);
    const laid = [...per].map(([id, n]) => `${itemLabel(bot, id)}×${n}`).join('、');
    throw new Error(`材料摆上去了(${laid}),等了 ${RESULT_WAIT_MS}ms 服务端没有给出产物`);
  }

  await show?.beat('result'); // 产出槽在摄像机画面上亮一拍再收
  await click(bot, 0, 0, 0); // 拿起真产物;不伪造,changedSlots 才和服务端对得上
  if (!window.selectedItem) throw new Error('产物槽点了,产物没到手上');

  const merge = window.findItemRange(
    window.inventoryStart, window.inventoryEnd, result.type, result.metadata, true, result.nbt,
  );
  const dest = merge ? merge.slot : window.firstEmptySlotRange(window.inventoryStart, window.inventoryEnd);
  if (dest === null || dest === undefined) throw new Error('包满了,产物没地方放');
  await click(bot, dest, 0, 0);
}

/**
 * 点一下就往下走。
 *
 * `bot.clickWindow` 对合成格的点击会去等 `updateSlot:0`,**那个等待没有超时**——
 * 配方在服务端没配上时它就永远挂着。原版客户端发点击本来也不等回话,这里发出去
 * 之后最多等 CLICK_ACK_MS 就继续。
 */
async function click(bot: Bot, slot: number, mouseButton: number, mode: number): Promise<void> {
  const pending = bot.clickWindow(slot, mouseButton, mode);
  pending.catch(() => undefined); // 被放弃的那次不能变成未处理拒绝
  await Promise.race([pending, sleep(CLICK_ACK_MS)]);
}

/**
 * 将光标物品放回来源格或背包空格，防止后续点击按交换物品处理；无处可放时报错。
 * 仅当光标材质符合 expectedType 时可回来源格，避免回灌换位后混入其他材料。
 */
async function stashCursor(
  bot: Bot, window: WindowLike, preferred: number | null, expectedType?: number,
): Promise<void> {
  if (!window.selectedItem) return;
  const backOk = expectedType === undefined || window.selectedItem.type === expectedType;
  if (preferred !== null && backOk && !window.slots[preferred]) {
    await click(bot, preferred, 0, 0);
    if (!window.selectedItem) return;
  }
  const empty = window.firstEmptySlotRange(window.inventoryStart, window.inventoryEnd);
  if (empty !== null && empty !== undefined) {
    await click(bot, empty, 0, 0);
    if (!window.selectedItem) return;
  }
  const held = window.selectedItem;
  throw new Error(`包满了,手上还攥着${itemLabel(bot, held.type)}×${held.count},放不回背包`);
}

/**
 * 开工前腾空合成格。
 *
 * 窗口 0 从不关闭,上一次合成剩在 2x2 格子里的材料会一直留着,连重连都留着。往占着的
 * 格子右键放料只在本地换位,服务端不动 —— 服务端格子里始终是旧材料,产出槽永远不出货,
 * 而客户端认为整摞材料进了格子,`findInventoryItem` 从此报"包里没有可用的 X"。
 */
async function clearGrid(
  bot: Bot, window: WindowLike,
  trace: (event: string, msg: string, data?: Record<string, unknown>) => void,
): Promise<void> {
  const width = gridWidth(window);
  for (let slot = 1; slot <= width * width; slot++) {
    const left = window.slots[slot];
    if (!left) continue;
    await stashCursor(bot, window, null);
    await click(bot, slot, 0, 0);
    await stashCursor(bot, window, null);
    trace('grid-clear', `合成格 ${slot} 里还剩着上次的物品 #${left.type}×${left.count},先拿出来`, {
      slot, item: left.type, count: left.count,
    });
  }
}

/** `itemId === null` = 收任意产物:她自己摆的格子,产出什么由服务端说了算 */
async function waitForResult(
  window: WindowLike, itemId: number | null, ms: number,
): Promise<WindowLike['slots'][number]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const item = window.slots[0];
    if (item && (itemId === null || item.type === itemId)) return item;
    if (Date.now() >= deadline) return null;
    await sleep(25);
  }
}
