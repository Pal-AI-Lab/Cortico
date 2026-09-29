/**
 * Minecraft World 的浏览器插件 —— 挂载 / 皮肤 / 存档与玩法 / 权限与作弊 /
 * World 日志五个面板。
 *
 * 这个文件只做两件事:**装配**(把五个面板接到局部 id 上)与**共享 helper**
 * (各面板都要的一行回执、错误措辞,以及服务端各方法的返回形状)。
 * 面板本体各在自己的文件里。
 *
 * 与外界的依赖只有一条:`client-panel.ts` 里的类型与 `toDisposable`。没有
 * import 控制台内部模块,没有 `fetch`,没有 `document.body`,没有 `window.__*`
 * ——数据面一律走 `ctx.invoke` / `ctx.invokeBinary`,DOM 一律用 `ctx.ui` 的原语,
 * 定时器一律走 `ctx.interval`,ObjectURL 一律交给 `ctx.own`。
 *
 * `style.css` 是本 provider 自己的样式:只放 `ctx.ui` 没有对应原语的那几块
 * (挂载行状态词的配色、并排表单、保留换行的正文段、图片预览),用 `mc-` 前缀
 * 避开控制台的通用 class。
 *
 * **服务端那边的 panel id 与方法名一个字都没改。** 挂载面板管的是三条链路
 * (游戏服务器 / 观察者客户端 / 玩家客户端),它们各自的 `state` / `start` / `stop`
 * 早就在那儿了;这里只是在方法名前面缀上是哪一条(`server.state`、`client.start`),
 * 好让三条链路共处一个局部 id。
 */

import type {
  ConsoleClientBundle,
  ConsolePanelContext,
} from '../../../web/shared/client-panel.ts';
import './style.css';
import { accessPanel } from './access.ts';
import { skinPanel } from './skin.ts';
import { mountPanel } from './mount.ts';
import { worldPanel } from './world.ts';
import { logPanel } from './log.ts';

// ---------------------------------------------------------------------------
// 共享类型:服务端 `MinecraftWorld.invokePanel` 各方法的返回形状
// ---------------------------------------------------------------------------

/** 三条链路共有的那几项。托管进程没起时 `pid` 为 null,外部起的照样可能就绪。 */
interface MinecraftLaneCommon {
  /** `stopped` / `starting` / `running` / `error` */
  phase: string;
  detail: string | null;
  pid: number | null;
}

/** `mount.server.*` */
export interface MinecraftServerState extends MinecraftLaneCommon {
  address: string;
  /** 端口当下可连(外部自己起的服务器也算) */
  reachable: boolean;
  serverDir: string;
  configured: boolean;
  /** bot 是否以这台服务器为连接目标:启动按钮置真,停止按钮置假;远程服务器恒为真 */
  wanted: boolean;
}

/** `mount.client.*`。客户端没有可探的端口,判据是"窗口出来了没"。 */
export interface MinecraftClientState extends MinecraftLaneCommon {
  enabled: boolean;
  windowReady: boolean;
  gameDir: string;
  versionId: string;
  username: string;
  configured: boolean;
  command: string | null;
}

interface MinecraftGameSettings {
  gamemode: string;
  difficulty: string;
  hardcore: boolean;
  pvp: boolean;
  spawnMonsters: boolean;
  /** 空 = 随机 */
  levelSeed: string;
  levelName: string;
  /** 世界类型;只在世界第一次生成时起作用 */
  levelType: string;
  /** 生成器细则 JSON(超平坦层配方 / 单群系名) */
  generatorSettings: string;
  generateStructures: boolean;
  allowNether: boolean;
  spawnProtection: number;
  viewDistance: number;
  simulationDistance: number;
  maxWorldSize: number;
}

/** 存档目录的 level.dat 自述;读不出来的项为 null */
interface MinecraftLevelDatInfo {
  levelName: string | null;
  lastPlayed: number | null;
  seed: string | null;
  gameType: number | null;
  difficulty: number | null;
  hardcore: boolean | null;
  version: string | null;
  /** flat / amplified / large_biomes / normal */
  generator: string | null;
  dayTime: number | null;
}

export interface MinecraftWorldInfo {
  name: string;
  /** 目录里有 level.dat = 已经生成过 */
  generated: boolean;
  /** 最后活跃(ISO):优先 level.dat 的 LastPlayed,退回文件 mtime */
  modified: string | null;
  sizeBytes: number;
  /** 已生成的附属维度:nether / the_end */
  dimensions: string[];
  info: MinecraftLevelDatInfo | null;
}

/** `world.state` */
export interface MinecraftWorldState {
  configured: boolean;
  serverDir: string;
  /** 服务器跑着(含外部起的):只有难度与默认游戏模式能热改 */
  live: boolean;
  /** 由 World 托管;只有托管进程提供控制台 stdin */
  hosted: boolean;
  worlds: MinecraftWorldInfo[];
  settings: MinecraftGameSettings;
  /** 超平坦层配方的常用预设(服务端那一份词表) */
  flatPresets: ReadonlyArray<{ id: string; label: string; note: string; json: string }>;
  /** 世界类型的中文词表(同上) */
  levelTypes: ReadonlyArray<{ value: string; label: string; note: string }>;
  detail: string | null;
}

/** `access.state` 名单里的一位 */
export interface MinecraftAccessMember {
  name: string;
  /** bot=她自己 / camera=观察者摄像机 / player=人的客户端 / other=名单里别的名字 */
  role: 'bot' | 'camera' | 'player' | 'other';
  op: boolean;
  /** 名单里那条的权限等级;不在名单里为 0 */
  level: number;
}

/** `access.state` */
export interface MinecraftAccessState {
  configured: boolean;
  serverDir: string;
  /** 服务器跑着(含外部起的) */
  live: boolean;
  /** 由 World 托管:跑着的时候名单也能经控制台 op/deop 当场改 */
  hosted: boolean;
  /** worlds.minecraft.local.cheats:每次启动前把三个名字补进名单 */
  autoOp: boolean;
  members: MinecraftAccessMember[];
  settings: {
    opPermissionLevel: number;
    enableCommandBlock: boolean;
    allowFlight: boolean;
    onlineMode: boolean;
    whiteList: boolean;
  };
  detail: string | null;
}

/** `skin.state` 里某个角色选着的那张 */
interface MinecraftSkinInfo {
  width: number;
  height: number;
  bytes: number;
  /** 选中的时刻(ISO) */
  at: string;
}

/** `skin.state` 里的一个角色:她自己,或人那份客户端 */
export interface MinecraftSkinRole {
  role: 'bot' | 'player';
  /** 皮肤按这个账号名铺进游戏目录 */
  username: string;
  /** 选着的那张;null = 没选 */
  skin: MinecraftSkinInfo | null;
  /** 两份游戏目录里此刻铺着的正是这张 */
  installed: { camera: boolean; player: boolean };
}

/** `skin.state` */
export interface MinecraftSkinState {
  roles: MinecraftSkinRole[];
  dirs: { camera: string; player: string };
  /** CustomSkinLoader 装了没:没装则皮肤铺得再对也不会被读 */
  mod: { camera: boolean; player: boolean };
  /** 客户端正跑着:换了皮肤要它重进一次服务器才刷新 */
  live: { camera: boolean; player: boolean };
  detail: string | null;
}

/** `log.entries` 的一条 */
export interface MinecraftLogEntry {
  seq: number;
  ts: string;
  lane: string;
  event: string;
  msg: string;
  taskId?: number;
  durMs?: number;
}

// ---------------------------------------------------------------------------
// 共享 helper
// ---------------------------------------------------------------------------

/** 错误 → 一句人话。`ConsoleInvokeError` 带的就是服务端的中文措辞。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 一行回执(`.msgline`),三个面板都有一条。`say(null)` 清空。 */
export interface MinecraftMsgLine {
  el: HTMLDivElement;
  say(text?: string | null, bad?: boolean): void;
}

export function msgLine(ctx: ConsolePanelContext, cls?: string): MinecraftMsgLine {
  const el = ctx.ui.msgline('');
  if (cls) el.classList.add(cls);
  return {
    el,
    say(text, bad) {
      el.textContent = text ?? '';
      el.classList.toggle('bad', bad === true);
    },
  };
}

// ---------------------------------------------------------------------------

const bundle: ConsoleClientBundle = {
  // 键是**局部** panel id,与服务端 `console().panels[].id` 一一对应。
  panels: {
    mount: mountPanel,
    skin: skinPanel,
    world: worldPanel,
    access: accessPanel,
    log: logPanel,
  },
};

export default bundle;
