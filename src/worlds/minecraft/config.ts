import type { ConfigGroup } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import { text } from './strings.ts';

export const MINECRAFT_DEFAULTS = {
  // enabled 由Persona的装配层显式开启。
  enabled: false,
  /** 连接方式;auto 按 local.serverDir 是否填写推定,见 serverModeOf */
  serverMode: 'auto' as MinecraftServerModeSetting,
  /** 服务器地址(私服 dry-run 默认本机) */
  host: '127.0.0.1',
  port: 25565,
  /** 游戏内用户名(offline 模式直接生效) */
  username: 'corti',
  /**
   * 全链路的版本约定:服务器(Paper)、观察者客户端(Fabric+SpectatorPlus)、
   * mineflayer 协议必须使用同一版本。1.20.6 是 SpectatorPlus(观察者附身时补渲
   * HUD/手臂/手持)客户端模组支持的 1.20.x 最高版;1.20.5+ 需要 Java 21。
   */
  version: '1.20.6',
  /** prismarine-viewer 网页端口(OBS 浏览器源 + 画面源之一);0=不开 */
  viewerPort: 7792,
  /** 挂载面板启停的本地服务器(空 = 未配置,按钮会提示去配置) */
  local: {
    /** World 启动时拉起本地服务器并连接;运行中由挂载面板启停。 */
    startWithWorld: false,
    /** 含 server.jar 的目录 */
    serverDir: '',
    /** java 路径;空 = 自动(serverDir 邻近 jdk → PATH) */
    javaPath: '',
    /** 服务器 JVM 参数 */
    jvmArgs: '-Xms1G -Xmx2G',
    /**
     * 作弊权限:托管启动服务器前把她、摄像机、玩家三个名字补进 ops.json(4 级)。
     * 专用服没有单人存档那个「开作弊」开关,能不能下 /tp、/gamemode 全看这份名单。
     * 关掉则只按名单现状来(既不补也不删),名单本身在「权限与作弊」面板里改。
     */
    cheats: true,
  },
  world: {
    /** 世界变化节流 tick(秒) */
    tickSec: 8,
    /** 位移超过多少格才值得说 */
    moveThreshold: 12,
    /** 世界快照进上下文的最短间隔(秒)。快照是投递成文事件:搭车走,发车刻现拿 */
    snapshotSec: 10,
    /** 分段去重下强制发一次全量快照的间隔(秒),给增量流的基线兜底 */
    snapshotAnchorSec: 600,
  },
  /**
   * 寻路垫脚/搭路可用的方块,顺序即优先级。列表外的方块寻路器不会当垫脚用——
   * 圆石等兼作合成材料的方块,不想被路上消耗就从这里拿掉。
   */
  scaffoldBlocks: ['dirt', 'cobblestone'],
  /** 受理时报告前置试算的否定结果，出队时重查并阻断 hard；关闭后不执行这两次试算。 */
  precheck: true,
  /** 受理回执附上相同任务的上次终态。 */
  priorOutcome: true,
  reflex: {
    /** 受击反击 */
    fightBack: true,
    /** 生命低于此值就脱离战斗;不还手也照样跑 */
    fleeHealth: 10,
    /** 两次受击反应的最短间隔 */
    reactCooldownSec: 8,
    antiDrown: true,
    /**
     * 挨烧就跑。这一条不能交给主脑:岩浆浇脸、蹭到流动岩浆柱都是环境自己找上门,
     * 20 血在岩浆里只够活两秒半,等她下一轮想明白再动人已经烧没了。挖掘绕开岩浆
     * 是预防,预防挡不住被浇的那种。
     */
    antiLava: true,
  },
  /**
   * 被打或敌对进入 engageRadius 时，按策略及血线决定交战；沿用 reflex.fleeHealth。
   * 战斗期间挂起任务，结束后从断点恢复，事件照常投递。关闭后受击交回反射层。
   */
  combat: {
    enabled: true,
    /** 触发半径:敌对贴到这么近才动手 */
    engageRadius: 3,
    /** 追击上限(格) */
    chaseMax: 6,
    /** E3 硬时长闸(秒):到点强制交还,防止刷怪笼/夜晚开阔地"永久失声" */
    maxSec: 30,
    /**
     * 理想间距(格)。僵尸有效攻击距离 p99=2.40、玩家上限 3.0,安全带宽约 0.6:
     * 2.88 几乎无敌(台架值),2.6 会偶尔挨打、看起来像个会玩的人——这是观感旋钮
     */
    space: 2.6,
    /** E4:5 分钟滑窗里战斗时长占比超过此百分数就强制冷却 */
    busyRatio: 60,
    /** E4 触发后多少秒内不自动进场 */
    cooldownSec: 60,
  },
  /** 观察者客户端:真客户端 + 观察者模式跟着 bot,支持光影/模组 */
  client: {
    enabled: false,
    /** .minecraft 目录 */
    gameDir: '',
    /** versions/ 下的版本 id;空 = 目录里唯一那个(装了 Fabric/Iris 就填那个整合版 id) */
    versionId: '',
    /**
     * java 路径;空 = PATH 上的 java。版本要与游戏对上:1.20.6 用 Java 21。
     * 更高的 JDK 会让游戏自带的 LWJGL 3.3.3 认不出 JNI 版本(启动日志里有
     * Unsupported JNI version 警告),之后随机原生崩溃。
     */
    javaPath: '',
    jvmArgs: '-Xmx4G',
    /** 摄像机账号名(必须与 bot 的名字不同) */
    username: 'CortiCam',
    width: 1280,
    height: 720,
    /** 启动即直连服务器(1.20+ 走 quickPlay,更早走 --server/--port) */
    autoJoin: true,
    /** 自动把摄像机切观察者模式并附身到 bot */
    autoSpectate: true,
    /** 周期性重下 spectate 指令(bot 死亡/重连会掉);0=只在事件点下 */
    resyncSec: 30,
    /** 摄像机进程崩了自动重启的上限(10 分钟窗口内);0=不重启 */
    restartMax: 3,
    /**
     * 启动前调整该游戏目录的设置:options.txt(失焦不暂停、跳引导屏、主音量拉满)
     * 与 SpectatorPlus 的 client.json(openScreens 按 syncGui 写)
     */
    noPauseOnLostFocus: true,
    /** GUI 演出:bot 开箱子/合成/熔炉时把那张界面同步到摄像机画面上(重启客户端生效) */
    syncGui: true,
  },
  /** 演出节拍:同步 GUI 开着时把容器操作放慢到人手速度;预算封顶防慢动作长镜头 */
  show: {
    clickMs: 200,
    dwellOpenMs: 400,
    dwellResultMs: 600,
    dwellCloseMs: 300,
    reopenGapMs: 600,
    budgetMs: 6000,
  },
  /**
   * 玩家客户端:以普通玩家身份再开一份客户端进同一个服务器,人跟她一起玩。
   * 与观察者摄像机是两份进程、两个账号名,谁都不影响谁。
   */
  player: {
    /** 开着则 World 启动时一并拉起;关着也能在挂载面板里手动启停 */
    enabled: false,
    /** 玩家账号名(离线),必须与 bot 和摄像机都不同 */
    username: 'Player',
    /** .minecraft 目录;空 = 用观察者客户端那一份 */
    gameDir: '',
    /** versions/ 下的版本 id;空 = 目录里唯一那个 */
    versionId: '',
    /** java 路径;空 = 用观察者客户端那一份 */
    javaPath: '',
    jvmArgs: '-Xmx4G',
    width: 1280,
    height: 720,
    /** 启动即直连服务器;关掉就停在主菜单自己进 */
    autoJoin: true,
    /** 进服后把这个玩家传送到 bot 旁边(服务器控制台优先,退回 bot 的 op 指令) */
    teleportToBot: true,
  },
} as const;

/**
 * 实际生效的连接方式。local:World 启停 `local.serverDir` 里的服务器,bot 随之连接;
 * external:只控制 bot 到 host:port 的连接,本地服务器目录不参与。
 */
export type MinecraftServerMode = 'local' | 'external';
export type MinecraftServerModeSetting = MinecraftServerMode | 'auto';
export const MINECRAFT_SERVER_MODES: readonly MinecraftServerModeSetting[] = ['auto', 'local', 'external'];

/**
 * auto 时服务器目录非空即本地托管。调用方传受管进程锁定的目录,运行中清空配置不会把
 * 已启动的进程当成外部服务器。
 */
export function serverModeOf(setting: MinecraftServerModeSetting, serverDir: string): MinecraftServerMode {
  if (setting === 'local' || setting === 'external') return setting;
  return serverDir.trim() !== '' ? 'local' : 'external';
}

export interface MinecraftConfigSection {
  enabled: boolean;
  serverMode: MinecraftServerModeSetting;
  host: string;
  port: number;
  username: string;
  version: string;
  viewerPort: number;
  local: {
    startWithWorld: boolean;
    serverDir: string;
    javaPath: string;
    jvmArgs: string;
    cheats: boolean;
  };
  world: { tickSec: number; moveThreshold: number; snapshotSec: number; snapshotAnchorSec: number };
  /** 寻路垫脚方块名单,顺序即优先级;列表外的不当垫脚用 */
  scaffoldBlocks: readonly string[];
  /** 前置试算：受理时报告否定，出队时阻断 hard；默认开启。 */
  precheck: boolean;
  /** 受理回执附相同任务的上次终态；默认开启。 */
  priorOutcome: boolean;
  reflex: {
    fightBack: boolean; fleeHealth: number;
    reactCooldownSec: number; antiDrown: boolean; antiLava: boolean;
  };
  combat: {
    enabled: boolean; engageRadius: number; chaseMax: number; maxSec: number;
    space: number; busyRatio: number; cooldownSec: number;
  };
  client: {
    enabled: boolean; gameDir: string; versionId: string; javaPath: string; jvmArgs: string;
    username: string; width: number; height: number;
    autoJoin: boolean; autoSpectate: boolean; resyncSec: number; restartMax: number;
    noPauseOnLostFocus: boolean; syncGui: boolean;
  };
  /** 容器操作的 GUI 演出节拍(摄像机开着且 syncGui 开着时生效) */
  show: {
    clickMs: number; dwellOpenMs: number; dwellResultMs: number;
    dwellCloseMs: number; budgetMs: number; reopenGapMs: number;
  };
  player: {
    enabled: boolean; username: string; gameDir: string; versionId: string; javaPath: string;
    jvmArgs: string; width: number; height: number; autoJoin: boolean; teleportToBot: boolean;
  };
}

/**
 * java 路径旋钮的选择器过滤。只有 Windows 的 java 带 `.exe`;在别的平台上按这个后缀过滤,
 * `/usr/bin/java` 会被对话框挡在外面(见 web/path-picker.ts 的 validatePickedPath)。
 */
const JAVA_PATH_PICKER = process.platform === 'win32'
  ? { kind: 'file' as const, extensions: ['.exe'] }
  : { kind: 'file' as const };

/** 连接方式、连接目标与本地服务器。文案按界面语言给;id / owner / 键与取值规则各语言一致。 */
export function minecraftConfigGroup(language: Language): ConfigGroup {
  const t = text(language).connection;
  return {
    id: 'world:minecraft',
    owner: 'world:minecraft',
    schema: {
      type: 'object',
      title: t.title,
      description: t.description,
      properties: {
        'worlds.minecraft.serverMode': {
          type: 'string', title: t.serverModeTitle, enum: [...MINECRAFT_SERVER_MODES], 'x-hot': true,
          description: t.serverModeDescription,
        },
        'worlds.minecraft.host': { type: 'string', title: t.hostTitle, 'x-hot': true },
        'worlds.minecraft.port': { type: 'integer', title: t.portTitle, minimum: 1, maximum: 65535, 'x-hot': true },
        'worlds.minecraft.username': {
          type: 'string', title: t.usernameTitle, 'x-hot': true,
          description: t.usernameDescription,
        },
        'worlds.minecraft.version': {
          type: 'string', title: t.versionTitle, 'x-hot': true,
          description: t.versionDescription,
        },
        'worlds.minecraft.viewerPort': {
          type: 'integer', title: t.viewerPortTitle, minimum: 0, maximum: 65535, 'x-hot': false,
          description: t.viewerPortDescription,
        },
        'worlds.minecraft.local.serverDir': {
          type: 'string', title: t.serverDirTitle, 'x-hot': false,
          description: t.serverDirDescription,
          'x-path': { kind: 'directory', recommendedDir: '../Cortico-Resources/minecraft/server' },
        },
        'worlds.minecraft.local.startWithWorld': {
          type: 'boolean', title: t.startWithWorldTitle, 'x-hot': false,
          description: t.startWithWorldDescription,
        },
        'worlds.minecraft.local.javaPath': {
          type: 'string', title: t.javaPathTitle, 'x-hot': true,
          description: t.javaPathDescription,
          'x-path': JAVA_PATH_PICKER,
        },
        'worlds.minecraft.local.jvmArgs': {
          type: 'string', title: t.jvmArgsTitle, 'x-hot': true,
          description: t.jvmArgsDescription,
        },
        'worlds.minecraft.local.cheats': {
          type: 'boolean', title: t.cheatsTitle, 'x-hot': true,
          description: t.cheatsDescription,
        },
      },
    },
  };
}

export function minecraftRhythmConfigGroup(language: Language): ConfigGroup {
  const { rhythm: t, blocks } = text(language);
  return {
    id: 'world:minecraft:rhythm',
    owner: 'world:minecraft',
    schema: {
      type: 'object',
      title: t.title,
      description: t.description,
      properties: {
        'worlds.minecraft.world.tickSec': {
          type: 'integer', title: t.tickSecTitle, minimum: 5, maximum: 300, 'x-suffix': 's', 'x-hot': true,
        },
        'worlds.minecraft.world.moveThreshold': {
          type: 'integer', title: t.moveThresholdTitle, minimum: 4, maximum: 200, 'x-suffix': blocks, 'x-hot': true,
        },
        'worlds.minecraft.world.snapshotSec': {
          type: 'integer', title: t.snapshotSecTitle, minimum: 5, maximum: 300, 'x-suffix': 's', 'x-hot': true,
          description: t.snapshotSecDescription,
        },
        'worlds.minecraft.world.snapshotAnchorSec': {
          type: 'integer', title: t.snapshotAnchorSecTitle, minimum: 60, maximum: 3600, 'x-suffix': 's', 'x-hot': true,
          description: t.snapshotAnchorSecDescription,
        },
        'worlds.minecraft.precheck': {
          type: 'boolean', title: t.precheckTitle, 'x-hot': true,
          description: t.precheckDescription,
        },
        'worlds.minecraft.priorOutcome': {
          type: 'boolean', title: t.priorOutcomeTitle, 'x-hot': true,
          description: t.priorOutcomeDescription,
        },
        'worlds.minecraft.reflex.fightBack': {
          type: 'boolean', title: t.fightBackTitle, 'x-hot': true,
          description: t.fightBackDescription,
        },
        'worlds.minecraft.reflex.fleeHealth': {
          type: 'integer', title: t.fleeHealthTitle, minimum: 0, maximum: 20, 'x-hot': true,
          description: t.fleeHealthDescription,
        },
        'worlds.minecraft.reflex.reactCooldownSec': {
          type: 'integer', title: t.reactCooldownSecTitle, minimum: 1, maximum: 120, 'x-suffix': 's', 'x-hot': true,
        },
        'worlds.minecraft.reflex.antiDrown': { type: 'boolean', title: t.antiDrownTitle, 'x-hot': true },
        'worlds.minecraft.reflex.antiLava': {
          type: 'boolean', title: t.antiLavaTitle, 'x-hot': true,
          description: t.antiLavaDescription,
        },
        'worlds.minecraft.combat.enabled': {
          type: 'boolean', title: t.combatTitle, 'x-hot': true,
          description: t.combatDescription,
        },
        'worlds.minecraft.combat.engageRadius': {
          type: 'integer', title: t.engageRadiusTitle, minimum: 2, maximum: 8, 'x-suffix': blocks, 'x-hot': true,
          description: t.engageRadiusDescription,
        },
        'worlds.minecraft.combat.chaseMax': {
          type: 'integer', title: t.chaseMaxTitle, minimum: 4, maximum: 24, 'x-suffix': blocks, 'x-hot': true,
        },
        'worlds.minecraft.combat.maxSec': {
          type: 'integer', title: t.maxSecTitle, minimum: 10, maximum: 300, 'x-suffix': 's', 'x-hot': true,
          description: t.maxSecDescription,
        },
        'worlds.minecraft.combat.space': {
          type: 'number', title: t.spaceTitle, minimum: 2.0, maximum: 2.95, 'x-suffix': blocks, 'x-hot': true,
          description: t.spaceDescription,
        },
        'worlds.minecraft.combat.busyRatio': {
          type: 'integer', title: t.busyRatioTitle, minimum: 10, maximum: 100, 'x-suffix': '%', 'x-hot': true,
          description: t.busyRatioDescription,
        },
        'worlds.minecraft.combat.cooldownSec': {
          type: 'integer', title: t.cooldownSecTitle, minimum: 10, maximum: 600, 'x-suffix': 's', 'x-hot': true,
          description: t.cooldownSecDescription,
        },
        'worlds.minecraft.show.clickMs': {
          type: 'integer', title: t.clickMsTitle, minimum: 0, maximum: 2000, 'x-suffix': 'ms', 'x-hot': true,
          description: t.clickMsDescription,
        },
        'worlds.minecraft.show.dwellOpenMs': {
          type: 'integer', title: t.dwellOpenMsTitle, minimum: 0, maximum: 3000, 'x-suffix': 'ms', 'x-hot': true,
          description: t.dwellOpenMsDescription,
        },
        'worlds.minecraft.show.dwellResultMs': {
          type: 'integer', title: t.dwellResultMsTitle, minimum: 0, maximum: 5000, 'x-suffix': 'ms', 'x-hot': true,
          description: t.dwellResultMsDescription,
        },
        'worlds.minecraft.show.dwellCloseMs': {
          type: 'integer', title: t.dwellCloseMsTitle, minimum: 0, maximum: 3000, 'x-suffix': 'ms', 'x-hot': true,
        },
        'worlds.minecraft.show.reopenGapMs': {
          type: 'integer', title: t.reopenGapMsTitle, minimum: 0, maximum: 3000, 'x-suffix': 'ms', 'x-hot': true,
          description: t.reopenGapMsDescription,
        },
        'worlds.minecraft.show.budgetMs': {
          type: 'integer', title: t.budgetMsTitle, minimum: 0, maximum: 30000, 'x-suffix': 'ms', 'x-hot': true,
          description: t.budgetMsDescription,
        },
      },
    },
  };
}

/** 画面与观察者客户端 */
export function minecraftClientConfigGroup(language: Language): ConfigGroup {
  const { client: t, times } = text(language);
  return {
    id: 'world:minecraft:client',
    owner: 'world:minecraft',
    schema: {
      type: 'object',
      title: t.title,
      description: t.description,
      properties: {
        'worlds.minecraft.client.enabled': {
          type: 'boolean', title: t.enabledTitle, 'x-hot': false,
          description: t.enabledDescription,
        },
        'worlds.minecraft.client.gameDir': {
          type: 'string', title: t.gameDirTitle, 'x-hot': false,
          description: t.gameDirDescription,
          'x-path': { kind: 'directory', recommendedDir: '../Cortico-Resources/minecraft/client' },
        },
        'worlds.minecraft.client.versionId': {
          type: 'string', title: t.versionIdTitle, 'x-hot': true,
          description: t.versionIdDescription,
        },
        'worlds.minecraft.client.javaPath': {
          type: 'string', title: t.javaPathTitle, 'x-hot': true,
          description: t.javaPathDescription,
          'x-path': JAVA_PATH_PICKER,
        },
        'worlds.minecraft.client.jvmArgs': {
          type: 'string', title: t.jvmArgsTitle, 'x-hot': true,
          description: t.jvmArgsDescription,
        },
        'worlds.minecraft.client.username': {
          type: 'string', title: t.usernameTitle, 'x-hot': true,
          description: t.usernameDescription,
        },
        'worlds.minecraft.client.width': {
          type: 'integer', title: t.widthTitle, minimum: 320, maximum: 3840, 'x-suffix': 'px', 'x-hot': true,
        },
        'worlds.minecraft.client.height': {
          type: 'integer', title: t.heightTitle, minimum: 240, maximum: 2160, 'x-suffix': 'px', 'x-hot': true,
        },
        'worlds.minecraft.client.autoJoin': {
          type: 'boolean', title: t.autoJoinTitle, 'x-hot': true,
        },
        'worlds.minecraft.client.autoSpectate': {
          type: 'boolean', title: t.autoSpectateTitle, 'x-hot': true,
          description: t.autoSpectateDescription,
        },
        'worlds.minecraft.client.resyncSec': {
          type: 'integer', title: t.resyncSecTitle, minimum: 0, maximum: 600, 'x-suffix': 's', 'x-hot': true,
          description: t.resyncSecDescription,
        },
        'worlds.minecraft.client.restartMax': {
          type: 'integer', title: t.restartMaxTitle, minimum: 0, maximum: 10, 'x-suffix': times, 'x-hot': true,
          description: t.restartMaxDescription,
        },
        'worlds.minecraft.client.noPauseOnLostFocus': {
          type: 'boolean', title: t.noPauseOnLostFocusTitle, 'x-hot': true,
          description: t.noPauseOnLostFocusDescription,
        },
        'worlds.minecraft.client.syncGui': {
          type: 'boolean', title: t.syncGuiTitle, 'x-hot': false,
          description: t.syncGuiDescription,
        },
      },
    },
  };
}

/** 人自己进服那一份客户端。 */
export function minecraftPlayerConfigGroup(language: Language): ConfigGroup {
  const t = text(language).player;
  return {
    id: 'world:minecraft:player',
    owner: 'world:minecraft',
    schema: {
      type: 'object',
      title: t.title,
      description: t.description,
      properties: {
        'worlds.minecraft.player.enabled': {
          type: 'boolean', title: t.enabledTitle, 'x-hot': false,
          description: t.enabledDescription,
        },
        'worlds.minecraft.player.username': {
          type: 'string', title: t.usernameTitle, 'x-hot': true,
          description: t.usernameDescription,
        },
        'worlds.minecraft.player.gameDir': {
          type: 'string', title: t.gameDirTitle, 'x-hot': false,
          description: t.gameDirDescription,
          'x-path': { kind: 'directory', recommendedDir: '../Cortico-Resources/minecraft/client-player' },
        },
        'worlds.minecraft.player.versionId': {
          type: 'string', title: t.versionIdTitle, 'x-hot': true,
          description: t.versionIdDescription,
        },
        'worlds.minecraft.player.javaPath': {
          type: 'string', title: t.javaPathTitle, 'x-hot': true,
          description: t.javaPathDescription,
          'x-path': JAVA_PATH_PICKER,
        },
        'worlds.minecraft.player.jvmArgs': { type: 'string', title: t.jvmArgsTitle, 'x-hot': true },
        'worlds.minecraft.player.width': {
          type: 'integer', title: t.widthTitle, minimum: 320, maximum: 3840, 'x-suffix': 'px', 'x-hot': true,
        },
        'worlds.minecraft.player.height': {
          type: 'integer', title: t.heightTitle, minimum: 240, maximum: 2160, 'x-suffix': 'px', 'x-hot': true,
        },
        'worlds.minecraft.player.autoJoin': {
          type: 'boolean', title: t.autoJoinTitle, 'x-hot': true,
          description: t.autoJoinDescription,
        },
        'worlds.minecraft.player.teleportToBot': {
          type: 'boolean', title: t.teleportToBotTitle, 'x-hot': true,
          description: t.teleportToBotDescription,
        },
      },
    },
  };
}
