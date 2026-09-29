import type { ConfigGroup } from '../../core/types.ts';

export const MINECRAFT_DEFAULTS = {
  // enabled 由Persona的装配层显式开启。
  enabled: false,
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

export interface MinecraftConfigSection {
  enabled: boolean;
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

/** 连接与本地服务器:重启生效的那些 */
export const MINECRAFT_CONFIG_GROUP: ConfigGroup = {
  id: 'world:minecraft',
  owner: 'world:minecraft',
  schema: {
    type: 'object',
    title: 'Minecraft · 连接',
    description: '连接项要重启 World 才生效；服务器路径在下次启动服务器时采用。',
    properties: {
      'worlds.minecraft.host': { type: 'string', title: '服务器地址', 'x-hot': false },
      'worlds.minecraft.port': { type: 'integer', title: '端口', minimum: 1, maximum: 65535, 'x-hot': false },
      'worlds.minecraft.username': { type: 'string', title: '游戏内用户名', 'x-hot': false },
      'worlds.minecraft.version': {
        type: 'string', title: '协议版本', 'x-hot': false,
        description: 'mineflayer 按此版本连接,要与服务器一致。',
      },
      'worlds.minecraft.viewerPort': {
        type: 'integer', title: 'viewer 端口', minimum: 0, maximum: 65535, 'x-hot': false,
        description: '0=不开。prismarine-viewer 的网页:OBS 浏览器源与"viewer"帧源都吃它。',
      },
      'worlds.minecraft.local.serverDir': {
        type: 'string', title: '本地服务器目录', 'x-hot': false,
        description: '含 server.jar 的目录;运行中修改会在停止并重新启动后采用。',
        'x-path': { kind: 'directory', recommendedDir: '../Cortico-Resources/minecraft/server' },
      },
      'worlds.minecraft.local.startWithWorld': {
        type: 'boolean', title: '随 World 启动服务器', 'x-hot': false,
        description: '开=World 启动时拉起本地服务器并连接。未配置服务器目录时不起作用。',
      },
      'worlds.minecraft.local.javaPath': {
        type: 'string', title: '服务器 java 路径', 'x-hot': true,
        description: '空 = 自动:服务器目录邻近的 jdk/,再退回 PATH 上的 java。',
        'x-path': JAVA_PATH_PICKER,
      },
      'worlds.minecraft.local.jvmArgs': {
        type: 'string', title: '服务器 JVM 参数', 'x-hot': true,
        description: '空格分隔,下次启动生效。默认 -Xms1G -Xmx2G。',
      },
      'worlds.minecraft.local.cheats': {
        type: 'boolean', title: '自动授权作弊权限', 'x-hot': true,
        description: '本 World 每次启动服务器前,把她、摄像机、玩家补进管理员名单(ops.json,4 级)。'
          + '关掉则只按名单现状来。名单与相关的服务器项在「权限与作弊」面板里改。',
      },
    },
  },
};

export const MINECRAFT_RHYTHM_CONFIG_GROUP: ConfigGroup = {
  id: 'world:minecraft:rhythm',
  owner: 'world:minecraft',
  schema: {
    type: 'object',
    title: 'Minecraft · 节奏与反射',
    description:
      '节流决定多久才值得说一次话;反射是不经 LLM 的自保,做了什么一律事后汇报。都热改即生效。',
    properties: {
      'worlds.minecraft.world.tickSec': {
        type: 'integer', title: '世界节流 tick', minimum: 5, maximum: 300, 'x-suffix': 's', 'x-hot': true,
      },
      'worlds.minecraft.world.moveThreshold': {
        type: 'integer', title: '位移播报阈值', minimum: 4, maximum: 200, 'x-suffix': '格', 'x-hot': true,
      },
      'worlds.minecraft.world.snapshotSec': {
        type: 'integer', title: '世界快照间隔', minimum: 5, maximum: 300, 'x-suffix': 's', 'x-hot': true,
        description: '世界快照随下一批事件投递，不单独唤醒；投递时读取世界状态。此值为快照的最短间隔。',
      },
      'worlds.minecraft.world.snapshotAnchorSec': {
        type: 'integer', title: '快照全量锚间隔', minimum: 60, maximum: 3600, 'x-suffix': 's', 'x-hot': true,
        description: '快照按段去重,只发有变化的段;距上一份全量超过此间隔就强制发一次全量,给增量流的基线兜底(上下文截断后也会强制全量)。',
      },
      'worlds.minecraft.precheck': {
        type: 'boolean', title: '前置试算', 'x-hot': true,
        description: '受理任务时先纯读试算一遍,把「现在就做不成」的步当场写进受理回执(只报否定);每一步动手前再试算一次,判死的步不动手。关掉则回到旧行为:照跑、跑完才知道。',
      },
      'worlds.minecraft.priorOutcome': {
        type: 'boolean', title: '受理回执带上次下场', 'x-hot': true,
        description: '下同一件事(技能+目标相同,不看坐标数量)时,受理回执捎一句 15 分钟内上次是什么下场;上次成了就不出声。补的是已经被上下文交接压掉的那一段。关掉则受理回执只说这一单。',
      },
      'worlds.minecraft.reflex.fightBack': {
        type: 'boolean', title: '受击反击', 'x-hot': true,
        description: '关掉则挨打不还手,打不打交给主脑决定;血线以下的脱离不受它影响。',
      },
      'worlds.minecraft.reflex.fleeHealth': {
        type: 'integer', title: '脱离战斗血线', minimum: 0, maximum: 20, 'x-hot': true,
        description: '生命低于此值就撤,不恋战。反击关着也照样撤。只管会还手的(玩家和敌对生物):打猪打鱼这类找吃的不受血线约束。',
      },
      'worlds.minecraft.reflex.reactCooldownSec': {
        type: 'integer', title: '受击反应冷却', minimum: 1, maximum: 120, 'x-suffix': 's', 'x-hot': true,
      },
      'worlds.minecraft.reflex.antiDrown': { type: 'boolean', title: '防溺水上浮', 'x-hot': true },
      'worlds.minecraft.reflex.antiLava': {
        type: 'boolean', title: '挨烧自动逃离', 'x-hot': true,
        description: '碰到岩浆/火就立刻手动冲出去,再交给寻路器。判定看碰撞箱压着什么,'
          + '不是脚下那格——贴着岩浆边缘走时人已经在掉血而中心格还是空气。关掉则烧死为止。',
      },
      'worlds.minecraft.combat.enabled': {
        type: 'boolean', title: '战斗模式(夜间自保)', 'x-hot': true,
        description: '被打或敌对贴到触发半径内就接管移动与出手打完这一场,期间任务挂起、'
          + '事件照常推(夺手不夺嘴)。不主动招惹。关掉退回"受击反击"那套 10 秒挥两下。',
      },
      'worlds.minecraft.combat.engageRadius': {
        type: 'integer', title: '战斗触发半径', minimum: 2, maximum: 8, 'x-suffix': '格', 'x-hot': true,
        description: '敌对贴到这么近才动手;不是先手圈,是"找上门"的判据。',
      },
      'worlds.minecraft.combat.chaseMax': {
        type: 'integer', title: '战斗追击上限', minimum: 4, maximum: 24, 'x-suffix': '格', 'x-hot': true,
      },
      'worlds.minecraft.combat.maxSec': {
        type: 'integer', title: '战斗硬时长', minimum: 10, maximum: 300, 'x-suffix': 's', 'x-hot': true,
        description: '到点强制收手交还,哪怕怪还在——刷怪笼旁边"索得到敌"永久为真,没有这道闸就是直播失声。',
      },
      'worlds.minecraft.combat.space': {
        type: 'number', title: '战斗理想间距', minimum: 2.0, maximum: 2.95, 'x-suffix': '格', 'x-hot': true,
        description: '僵尸有效攻击距离约 2.2-2.4 格、出手上限 3.0。2.88 几乎不挨打(更强),'
          + '2.6 偶尔挨打(更像人)。这是观感旋钮。',
      },
      'worlds.minecraft.combat.busyRatio': {
        type: 'integer', title: '战斗占比闸', minimum: 10, maximum: 100, 'x-suffix': '%', 'x-hot': true,
        description: '5 分钟滑窗里战斗时长占比超过此值就强制冷却,不再自动进场——怪一波接一波的地方该换地方,不该无限打。',
      },
      'worlds.minecraft.combat.cooldownSec': {
        type: 'integer', title: '战斗冷却', minimum: 10, maximum: 600, 'x-suffix': 's', 'x-hot': true,
        description: '占比闸触发后这么久内不自动进场(挨打了照样还手)。',
      },
      'worlds.minecraft.show.clickMs': {
        type: 'integer', title: '演出·逐格间隔', minimum: 0, maximum: 2000, 'x-suffix': 'ms', 'x-hot': true,
        description: 'GUI 演出开着时,逐格摆料/逐栈存取之间停这么久。0=瞬时。'
          + '摄像机没开或「GUI 演出」关着时,整套节拍自动归零。',
      },
      'worlds.minecraft.show.dwellOpenMs': {
        type: 'integer', title: '演出·开窗停顿', minimum: 0, maximum: 3000, 'x-suffix': 'ms', 'x-hot': true,
        description: '打开容器界面后，等待此时长再操作。',
      },
      'worlds.minecraft.show.dwellResultMs': {
        type: 'integer', title: '演出·产物亮相', minimum: 0, maximum: 5000, 'x-suffix': 'ms', 'x-hot': true,
        description: '合成材料摆齐后停一拍,让产出槽在画面上亮一会儿再收。',
      },
      'worlds.minecraft.show.dwellCloseMs': {
        type: 'integer', title: '演出·关窗停顿', minimum: 0, maximum: 3000, 'x-suffix': 'ms', 'x-hot': true,
      },
      'worlds.minecraft.show.reopenGapMs': {
        type: 'integer', title: '演出·再开窗间隔', minimum: 0, maximum: 3000, 'x-suffix': 'ms', 'x-hot': true,
        description: '关闭容器界面到下次打开的最短间隔，不计入单次预算。',
      },
      'worlds.minecraft.show.budgetMs': {
        type: 'integer', title: '演出·单次预算', minimum: 0, maximum: 30000, 'x-suffix': 'ms', 'x-hot': true,
        description: '一单操作的节拍总预算,超了剩余步骤恢复瞬时——整箱掏空不会变成慢动作长镜头。',
      },
    },
  },
};

/** 画面与观察者客户端 */
export const MINECRAFT_CLIENT_CONFIG_GROUP: ConfigGroup = {
  id: 'world:minecraft:client',
  owner: 'world:minecraft',
  schema: {
    type: 'object',
    title: 'Minecraft · 观察者客户端',
    description:
      '真游戏窗口以观察者模式跟着 bot,与观众同一幅画面(含光影/模组),代价是一份客户端进程。' +
      '观众看到的画面由 OBS 采集这扇窗口或 viewer 网页,不经 World。',
    properties: {
      'worlds.minecraft.client.enabled': {
        type: 'boolean', title: '观察者客户端', 'x-hot': false,
        description: '开启后 World 启动时一并拉起客户端;也可以在挂载面板里单独启停。',
      },
      'worlds.minecraft.client.gameDir': {
        type: 'string', title: '.minecraft 目录', 'x-hot': false,
        description: '未配置时观察者客户端起不来。运行中修改会在停止并重新启动后采用。',
        'x-path': { kind: 'directory', recommendedDir: '../Cortico-Resources/minecraft/client' },
      },
      'worlds.minecraft.client.versionId': {
        type: 'string', title: '版本 id', 'x-hot': true,
        description: '空 = versions/ 下唯一那个。Fabric+Iris 这类填整合版目录名,继承关系自动解。',
      },
      'worlds.minecraft.client.javaPath': {
        type: 'string', title: '客户端 java 路径', 'x-hot': true,
        description:
          '空 = PATH 上的 java。版本要与游戏对上:1.20.6 用 Java 21。更高的 JDK 会让游戏自带的 '
          + 'LWJGL 3.3.3 认不出 JNI 版本(启动日志里有 Unsupported JNI version 警告),之后随机原生崩溃。',
        'x-path': JAVA_PATH_PICKER,
      },
      'worlds.minecraft.client.jvmArgs': {
        type: 'string', title: '客户端 JVM 参数', 'x-hot': true,
        description: '空格分隔。开光影建议 -Xmx4G 起。',
      },
      'worlds.minecraft.client.username': {
        type: 'string', title: '摄像机账号名', 'x-hot': true,
        description: '离线账号,必须与 bot 的游戏内用户名不同。',
      },
      'worlds.minecraft.client.width': {
        type: 'integer', title: '窗口宽', minimum: 320, maximum: 3840, 'x-suffix': 'px', 'x-hot': true,
      },
      'worlds.minecraft.client.height': {
        type: 'integer', title: '窗口高', minimum: 240, maximum: 2160, 'x-suffix': 'px', 'x-hot': true,
      },
      'worlds.minecraft.client.autoJoin': {
        type: 'boolean', title: '启动即进服', 'x-hot': true,
      },
      'worlds.minecraft.client.autoSpectate': {
        type: 'boolean', title: '自动观察者附身', 'x-hot': true,
        description: '进服后把摄像机切 spectator 并附身到 bot。经服务器控制台下指令;外部服务器则借 bot 的 op 权限。',
      },
      'worlds.minecraft.client.resyncSec': {
        type: 'integer', title: '附身重下间隔', minimum: 0, maximum: 600, 'x-suffix': 's', 'x-hot': true,
        description: 'bot 死亡/重连会掉附身,周期性重下;0=只在进服与重生这些事件点下。',
      },
      'worlds.minecraft.client.restartMax': {
        type: 'integer', title: '崩溃自动重启上限', minimum: 0, maximum: 10, 'x-suffix': '次', 'x-hot': true,
        description: '异常退出后自动重启，等待时间从 30 秒起逐次加倍；超过重启上限后停止重试并报警。'
          + '相邻两次异常退出间隔超过 10 分钟时重置计数。0 表示禁用自动重启。',
      },
      'worlds.minecraft.client.noPauseOnLostFocus': {
        type: 'boolean', title: '调整启动选项', 'x-hot': true,
        description: '启动前改该游戏目录的设置。options.txt:关 pauseOnLostFocus(alt+tab 切走不弹暂停菜单)、'
          + '跳过首启引导屏、主音量拉满(为 0 时游戏整个没声)。'
          + 'SpectatorPlus:同步屏幕按「GUI 演出」开关写。'
          + '指向你自己常玩的 .minecraft 时记得关掉这个开关。',
      },
      'worlds.minecraft.client.syncGui': {
        type: 'boolean', title: 'GUI 演出', 'x-hot': false,
        description: 'bot 开箱子/合成/熔炉时,把那张界面同步到摄像机画面上'
          + '(SpectatorPlus 的 Open Synced Screens),配合「节奏与反射」里的演出节拍,'
          + '观众能看到逐格摆料、产物出现、收回的全过程。徒手 2x2 合成协议上没有窗口,'
          + '演不了。客户端重启生效。',
      },
    },
  },
};

/** 人自己进服那一份客户端。 */
export const MINECRAFT_PLAYER_CONFIG_GROUP: ConfigGroup = {
  id: 'world:minecraft:player',
  owner: 'world:minecraft',
  schema: {
    type: 'object',
    title: 'Minecraft · 玩家客户端',
    description:
      '以普通玩家身份再开一份客户端进同一个服务器,跟她一起玩。与观察者摄像机是两份进程、'
      + '两个账号名。默认用摄像机那份 .minecraft;要装不同的 World 就另指一个目录。'
      + '进服的时刻由 bot 的玩家列表看到,那一刻把人传送到她旁边。',
    properties: {
      'worlds.minecraft.player.enabled': {
        type: 'boolean', title: '玩家客户端', 'x-hot': false,
        description: '开启后 World 启动时一并拉起;也可以在挂载面板里单独启停。',
      },
      'worlds.minecraft.player.username': {
        type: 'string', title: '玩家名', 'x-hot': true,
        description: '离线账号,必须与 bot 和摄像机的名字都不同。传送认的就是这个名字。',
      },
      'worlds.minecraft.player.gameDir': {
        type: 'string', title: '.minecraft 目录', 'x-hot': false,
        description: '空 = 用观察者客户端那一份。两份客户端共用一个目录时设置文件是共享的:'
          + '谁最后启动谁说了算,要各自成套只能各给一个目录。natives 仍按账号分开,不会抢同一组 DLL。'
          + '共用时启动前会把聊天可见性掰回 FULL——摄像机为画面干净关掉的聊天连命令行一起关,'
          + '人进了服 T 和 / 都按不动。',
        'x-path': { kind: 'directory', recommendedDir: '../Cortico-Resources/minecraft/client-player' },
      },
      'worlds.minecraft.player.versionId': {
        type: 'string', title: '版本 id', 'x-hot': true,
        description: '空 = versions/ 下唯一那个。要与服务器同版本。',
      },
      'worlds.minecraft.player.javaPath': {
        type: 'string', title: 'java 路径', 'x-hot': true,
        description: '空 = 用观察者客户端那一份。',
        'x-path': JAVA_PATH_PICKER,
      },
      'worlds.minecraft.player.jvmArgs': { type: 'string', title: 'JVM 参数', 'x-hot': true },
      'worlds.minecraft.player.width': {
        type: 'integer', title: '窗口宽', minimum: 320, maximum: 3840, 'x-suffix': 'px', 'x-hot': true,
      },
      'worlds.minecraft.player.height': {
        type: 'integer', title: '窗口高', minimum: 240, maximum: 2160, 'x-suffix': 'px', 'x-hot': true,
      },
      'worlds.minecraft.player.autoJoin': {
        type: 'boolean', title: '启动即进服', 'x-hot': true,
        description: '关掉就停在主菜单,自己从多人游戏里进。',
      },
      'worlds.minecraft.player.teleportToBot': {
        type: 'boolean', title: '进服传送到她旁边', 'x-hot': true,
        description: '经服务器控制台下 tp;外部服务器则借 bot 的 op 权限。挂载面板里也能随时手动传一次。',
      },
    },
  },
};
