import { pick, type Language } from '../../core/language.ts';

/** 给操作员看的文案:控制台露出、配置组、面板回执、世界生成词表。 */
const zh = {
  // ── console():显示名、灯、徽标、链接 ───────────────────────────────
  label: 'Minecraft',
  server: '服务器',
  task: '任务',
  view: '画面',
  notStarted: '未启动',
  disconnected: '已断开',
  notConnected: '未连接',
  idle: '空闲',
  clientView: '客户端主视角',
  viewer: 'viewer',
  none: '无',
  connecting: '连接中',
  unreachable: (address: string, failure: string | null) => `连不上 ${address}${failure ? `(${failure})` : ''}`,
  openView: '打开画面',
  // 子进程代理在引擎报上状态之前的那一颗
  engine: '引擎',
  engineStarting: '启动中',
  // ── 面板声明 ───────────────────────────────────────────────────────
  panels: {
    mount: { title: '挂载', description: '连接方式;本地服务器的启停或外部服务器的连接;观察者客户端与玩家客户端的启停。' },
    skin: { title: '皮肤', description: '她和玩家各穿哪一张皮肤:选一张 PNG,由客户端读(离线服自己没有材质)。' },
    world: { title: '存档与玩法', description: '换存档、开新世界、调难度与游戏模式。' },
    access: { title: '权限与作弊', description: '谁有作弊权限(ops.json),以及命令方块、正版验证这类服务器项。' },
    log: { title: 'World 日志', description: '一场试玩的现场:下过的令、投递、每一步的结局。' },
  },
  // ── 存储清单 ───────────────────────────────────────────────────────
  storage: {
    'minecraft-chests': {
      label: '容器账本',
      note: 'stow/take/use 开过的箱子、炉子的槽位与到期估计、自备的工作站;清了下次当没开过。不是地标',
    },
    'minecraft-deaths': {
      label: '死亡账本',
      note: '这个世界今天死了几次、累计几次;死亡回执报序号,她写记忆提到死亡时回执带上这个读数。清了当没死过',
    },
    'minecraft-explored': {
      label: '探索覆盖账本',
      note: 'find 边走边找收工时按方向记历史最远与末端群系,摘要进环境提示词;清了当哪儿都没去过。不是地标',
    },
    'minecraft-works': {
      label: '成果登记',
      note: '她亲手做成的格:建成的蓝图、锄成的耕地、种下的作物。寻路不往登记格头顶垫,'
        + 'excavate 与放置只把它摆进回执不拦人;清了当这些地方她没建过。不是地标',
    },
    'minecraft-policy': {
      label: '常驻规矩(mc_policy)',
      note: '垫脚/照明名单与场合、赶路取向、收着不用的家伙什、主动交战条件;清了六格全回默认',
    },
    'minecraft-blueprints': {
      label: '蓝图表',
      note: '装载过的蓝图设计(palette + 矩阵),外加每个世界里那几张图的施工锚点与进度。'
        + '设计没有世界性、跨世界留着;清了等于她画的图全没了,要重新出图或重新 save',
    },
    'minecraft-pwsr': {
      label: '暂态表(目标/路标等)',
      note: 'PWSR 暂态:她从笔记投影进来的目标与路标,外加蓝图施工进度那张视图,按世界分命名空间。'
        + '本来就不跨重启,清了等于提前进了下一场',
    },
  },
  // ── 提示词模板 ─────────────────────────────────────────────────────
  envPromptTitle: 'Minecraft · 环境提示词',
  envPromptDescription: 'Minecraft World 的常驻事实（技能序列、世界观察、反射层）。',
  worldVar: '世界身份:本地托管=「当前存档:名字」,外部服务器=「当前服务器:地址」。她的位置类记忆按它划界。',
  exploredVar: '探索覆盖摘要(8 方向历史最远与末端群系);一处没探过时为空。',
  policyVar: 'mc_policy 六格里与默认不同的那几条;全默认时为空。',
  cameraVar: '观察者摄像机说明;没开客户端时为空。措辞在「摄像机说明」那份里改。',
  cameraNoteTitle: 'Minecraft · 摄像机说明',
  cameraNoteDescription: '开了观察者客户端时,追加到环境提示词末尾的那一段。',
  // ── 面板调用的错误与回执 ───────────────────────────────────────────
  unknownMethod: (panel: string, method: string) => `未知面板方法: ${panel}.${method}`,
  unknownPanel: (panel: string) => `未知面板: ${panel}`,
  reconnectLocal: '本地托管时使用「停止」与「启动」重新连接',
  noServerDirLocal: '先在本 World 配置里填 worlds.minecraft.local.serverDir',
  noServerDirExternal: '连接外部服务器时，存档与权限由那台服务器管理；本地托管（worlds.minecraft.local.serverDir）才能在这里修改',
  refusalLocal: '没配服务器目录,改不了',
  refusalExternal: '外部服务器的设置无法在这里修改',
  stopFirst: (what: string) => `${what}要先把服务器停下来`,
  whatSelect: '换存档',
  whatCreate: '开新存档',
  nextStartLoads: (name: string) => `下次启动进「${name}」`,
  worldExists: (name: string) => `「${name}」已经存在,直接选它就行`,
  seedPart: (seed: string) => `种子 ${seed}`,
  noStructures: '不生成结构',
  willGenerate: (name: string, how: string) => `下次启动会生成新世界「${name}」(${how})`,
  propertiesWritten: '已写入 server.properties,下次启动生效',
  difficulty: '难度',
  defaultGamemode: '默认游戏模式',
  list: (items: string[]) => items.join('、'),
  liveHostedOnly: '服务器跑着,只有难度和默认游戏模式能当场改;别的要先停机',
  liveExternal: '服务器是外部起的,没有控制台可用;要改就先停机改文件',
  appliedLive: (items: string) => `${items}已当场生效(只对本轮有效,没写进 server.properties)`,
  needName: '要先写个名字',
  badName: '游戏名里不会有空格或引号,确认一下',
  liveExternalOps: '服务器是外部起的,没有控制台可用;要改名单就先停机',
  opSent: (on: boolean, who: string) => `已让服务器${on ? '授权' : '收回'} ${who} 的作弊权限(当场生效)`,
  consoleWriteFailed: '控制台写不进去,试试重启服务器',
  opUnchanged: (on: boolean, who: string) => `${who} 本来就${on ? '有' : '没有'}作弊权限`,
  opWritten: (on: boolean, who: string) => `${on ? '已授权' : '已收回'} ${who} 的作弊权限,下次启动生效`,
  stopForProperties: '这几项服务器只在启动时读,要先把它停下来',
  skinCamera: '摄像机',
  skinPlayerClient: '玩家客户端',
  skinsLive: (who: string[]) => `已铺好;${who.join('与')}正跑着,要它重进一次服务器才换得过来`,
  skinsNextStart: '已铺好,下次启动客户端生效',
  skinCleared: '已撤回,那个账号回到原版随机皮肤',
  skinNone: '本来就没选',
  noSuchRole: (role: string) => `没有这个角色: ${role}`,
  noSkinYet: '这个角色还没选皮肤',
  tpNoPlayer: '没配玩家名,不知道要传谁',
  tpSameName: (who: string) => `玩家名与 bot 同名(${who}),传送不了`,
  tpDone: (who: string, target: string) => `已把 ${who} 传送到 ${target} 旁边`,
  tpNoBot: '服务器不是本 World 托管的,而 bot 还没连上:传送没人下得了',
  tpViaBot: (who: string, target: string) => `已借 bot 的权限下 /tp ${who} ${target}(bot 不是 op 时服务器会拒)`,
  // ── 「存档与玩法」:世界类型、超平坦预设、存档名与生成器细则的校验 ──
  levelTypes: {
    'minecraft:normal': { label: '默认', note: '原版地形' },
    'minecraft:flat': { label: '超平坦', note: '按生成器细则逐层铺;不填就是原版那三层' },
    'minecraft:large_biomes': { label: '大型生物群系', note: '同样的地形,群系尺度放大' },
    'minecraft:amplified': { label: '放大化', note: '极端高山地形,吃性能' },
    'minecraft:single_biome_surface': {
      label: '单一生物群系',
      note: '整个世界一个群系,群系名写在生成器细则里({"biome":"minecraft:desert"})',
    },
  },
  flatPresets: {
    classic: { label: '经典平坦', note: '基岩 + 2 层泥土 + 草方块,平原群系' },
    void: { label: '虚空', note: '只有一层空气,出生点一小块平台' },
    tunnelers: { label: '隧道世界', note: '基岩 + 230 层石头,整个世界都是可挖的岩层' },
    minable: { label: '可挖平坦', note: '基岩 + 59 层石头 + 泥土草皮:地表是平的,底下有矿脉' },
  },
  nameEmpty: '存档名不能为空',
  nameTooLong: '存档名太长(最多 64 字)',
  nameBadChars: '存档名里不能有 \\ / : * ? " < > |',
  nameReserved: '这个名字不能用',
  genNotJson: (message: string) => `生成器细则不是合法 JSON: ${message}`,
  genNotObject: '生成器细则要是一个 JSON 对象(如 {"layers":[…],"biome":"…"})',
  // ── 配置组 ─────────────────────────────────────────────────────────
  blocks: '格',
  times: '次',
  connection: {
    title: 'Minecraft · 连接',
    description: '地址、端口、用户名和版本在下次连接时采用：外部服务器在挂载面板点击「重连」，'
      + '本地托管停止并重新启动服务器。服务器路径在下次启动服务器时采用。',
    serverModeTitle: '连接方式',
    serverModeDescription: 'local = 本 World 启停本地服务器目录里的服务器；external = 只连接下面的地址和端口，'
      + '不使用本地服务器目录；auto = 填写了本地服务器目录按 local，否则按 external。'
      + '改动后 bot 断开当前连接，在挂载面板里重新启动或连接。',
    hostTitle: '服务器地址',
    portTitle: '端口',
    usernameTitle: '游戏内用户名',
    usernameDescription: 'bot 以离线账号登录；服务器须关闭正版验证（online-mode=false）。',
    versionTitle: '协议版本',
    versionDescription: 'mineflayer 按此版本连接,要与服务器一致。',
    viewerPortTitle: 'viewer 端口',
    viewerPortDescription: '0=不开。prismarine-viewer 的网页:OBS 浏览器源与"viewer"帧源都吃它。',
    serverDirTitle: '本地服务器目录',
    serverDirDescription: '含 server.jar 的目录;运行中修改会在停止并重新启动后采用。',
    startWithWorldTitle: '随 World 启动服务器',
    startWithWorldDescription: '开=World 启动时拉起本地服务器并连接。未配置服务器目录时不起作用。',
    javaPathTitle: '服务器 java 路径',
    javaPathDescription: '空 = 自动:服务器目录邻近的 jdk/,再退回 PATH 上的 java。',
    jvmArgsTitle: '服务器 JVM 参数',
    jvmArgsDescription: '空格分隔,下次启动生效。默认 -Xms1G -Xmx2G。',
    cheatsTitle: '自动授权作弊权限',
    cheatsDescription: '本 World 每次启动服务器前,把她、摄像机、玩家补进管理员名单(ops.json,4 级)。'
      + '关掉则只按名单现状来。名单与相关的服务器项在「权限与作弊」面板里改。',
  },
  rhythm: {
    title: 'Minecraft · 节奏与反射',
    description:
      '节流决定多久才值得说一次话;反射是不经 LLM 的自保,做了什么一律事后汇报。都热改即生效。',
    tickSecTitle: '世界节流 tick',
    moveThresholdTitle: '位移播报阈值',
    snapshotSecTitle: '世界快照间隔',
    snapshotSecDescription: '世界快照随下一批事件投递，不单独唤醒；投递时读取世界状态。此值为快照的最短间隔。',
    snapshotAnchorSecTitle: '快照全量锚间隔',
    snapshotAnchorSecDescription: '快照按段去重,只发有变化的段;距上一份全量超过此间隔就强制发一次全量,给增量流的基线兜底(上下文截断后也会强制全量)。',
    precheckTitle: '前置试算',
    precheckDescription: '受理任务时先纯读试算一遍,把「现在就做不成」的步当场写进受理回执(只报否定);每一步动手前再试算一次,判死的步不动手。关掉则回到旧行为:照跑、跑完才知道。',
    priorOutcomeTitle: '受理回执带上次下场',
    priorOutcomeDescription: '下同一件事(技能+目标相同,不看坐标数量)时,受理回执捎一句 15 分钟内上次是什么下场;上次成了就不出声。补的是已经被上下文交接压掉的那一段。关掉则受理回执只说这一单。',
    fightBackTitle: '受击反击',
    fightBackDescription: '关掉则挨打不还手,打不打交给主脑决定;血线以下的脱离不受它影响。',
    fleeHealthTitle: '脱离战斗血线',
    fleeHealthDescription: '生命低于此值就撤,不恋战。反击关着也照样撤。只管会还手的(玩家和敌对生物):打猪打鱼这类找吃的不受血线约束。',
    reactCooldownSecTitle: '受击反应冷却',
    antiDrownTitle: '防溺水上浮',
    antiLavaTitle: '挨烧自动逃离',
    antiLavaDescription: '碰到岩浆/火就立刻手动冲出去,再交给寻路器。判定看碰撞箱压着什么,'
      + '不是脚下那格——贴着岩浆边缘走时人已经在掉血而中心格还是空气。关掉则烧死为止。',
    combatTitle: '战斗模式(夜间自保)',
    combatDescription: '被打或敌对贴到触发半径内就接管移动与出手打完这一场,期间任务挂起、'
      + '事件照常推(夺手不夺嘴)。不主动招惹。关掉退回"受击反击"那套 10 秒挥两下。',
    engageRadiusTitle: '战斗触发半径',
    engageRadiusDescription: '敌对贴到这么近才动手;不是先手圈,是"找上门"的判据。',
    chaseMaxTitle: '战斗追击上限',
    maxSecTitle: '战斗硬时长',
    maxSecDescription: '到点强制收手交还,哪怕怪还在——刷怪笼旁边"索得到敌"永久为真,没有这道闸就是直播失声。',
    spaceTitle: '战斗理想间距',
    spaceDescription: '僵尸有效攻击距离约 2.2-2.4 格、出手上限 3.0。2.88 几乎不挨打(更强),'
      + '2.6 偶尔挨打(更像人)。这是观感旋钮。',
    busyRatioTitle: '战斗占比闸',
    busyRatioDescription: '5 分钟滑窗里战斗时长占比超过此值就强制冷却,不再自动进场——怪一波接一波的地方该换地方,不该无限打。',
    cooldownSecTitle: '战斗冷却',
    cooldownSecDescription: '占比闸触发后这么久内不自动进场(挨打了照样还手)。',
    clickMsTitle: '演出·逐格间隔',
    clickMsDescription: 'GUI 演出开着时,逐格摆料/逐栈存取之间停这么久。0=瞬时。'
      + '摄像机没开或「GUI 演出」关着时,整套节拍自动归零。',
    dwellOpenMsTitle: '演出·开窗停顿',
    dwellOpenMsDescription: '打开容器界面后，等待此时长再操作。',
    dwellResultMsTitle: '演出·产物亮相',
    dwellResultMsDescription: '合成材料摆齐后停一拍,让产出槽在画面上亮一会儿再收。',
    dwellCloseMsTitle: '演出·关窗停顿',
    reopenGapMsTitle: '演出·再开窗间隔',
    reopenGapMsDescription: '关闭容器界面到下次打开的最短间隔，不计入单次预算。',
    budgetMsTitle: '演出·单次预算',
    budgetMsDescription: '一单操作的节拍总预算,超了剩余步骤恢复瞬时——整箱掏空不会变成慢动作长镜头。',
  },
  client: {
    title: 'Minecraft · 观察者客户端',
    description:
      '真游戏窗口以观察者模式跟着 bot,与观众同一幅画面(含光影/模组),代价是一份客户端进程。' +
      '观众看到的画面由 OBS 采集这扇窗口或 viewer 网页,不经 World。',
    enabledTitle: '观察者客户端',
    enabledDescription: '开启后 World 启动时一并拉起客户端;也可以在挂载面板里单独启停。',
    gameDirTitle: '.minecraft 目录',
    gameDirDescription: '未配置时观察者客户端起不来。运行中修改会在停止并重新启动后采用。',
    versionIdTitle: '版本 id',
    versionIdDescription: '空 = versions/ 下唯一那个。Fabric+Iris 这类填整合版目录名,继承关系自动解。',
    javaPathTitle: '客户端 java 路径',
    javaPathDescription:
      '空 = PATH 上的 java。版本要与游戏对上:1.20.6 用 Java 21。更高的 JDK 会让游戏自带的 '
      + 'LWJGL 3.3.3 认不出 JNI 版本(启动日志里有 Unsupported JNI version 警告),之后随机原生崩溃。',
    jvmArgsTitle: '客户端 JVM 参数',
    jvmArgsDescription: '空格分隔。开光影建议 -Xmx4G 起。',
    usernameTitle: '摄像机账号名',
    usernameDescription: '离线账号,必须与 bot 的游戏内用户名不同。',
    widthTitle: '窗口宽',
    heightTitle: '窗口高',
    autoJoinTitle: '启动即进服',
    autoSpectateTitle: '自动观察者附身',
    autoSpectateDescription: '进服后把摄像机切 spectator 并附身到 bot。经服务器控制台下指令;外部服务器则借 bot 的 op 权限。',
    resyncSecTitle: '附身重下间隔',
    resyncSecDescription: 'bot 死亡/重连会掉附身,周期性重下;0=只在进服与重生这些事件点下。',
    restartMaxTitle: '崩溃自动重启上限',
    restartMaxDescription: '异常退出后自动重启，等待时间从 30 秒起逐次加倍；超过重启上限后停止重试并报警。'
      + '相邻两次异常退出间隔超过 10 分钟时重置计数。0 表示禁用自动重启。',
    noPauseOnLostFocusTitle: '调整启动选项',
    noPauseOnLostFocusDescription: '启动前改该游戏目录的设置。options.txt:关 pauseOnLostFocus(alt+tab 切走不弹暂停菜单)、'
      + '跳过首启引导屏、主音量拉满(为 0 时游戏整个没声)。'
      + 'SpectatorPlus:同步屏幕按「GUI 演出」开关写。'
      + '指向你自己常玩的 .minecraft 时记得关掉这个开关。',
    syncGuiTitle: 'GUI 演出',
    syncGuiDescription: 'bot 开箱子/合成/熔炉时,把那张界面同步到摄像机画面上'
      + '(SpectatorPlus 的 Open Synced Screens),配合「节奏与反射」里的演出节拍,'
      + '观众能看到逐格摆料、产物出现、收回的全过程。徒手 2x2 合成协议上没有窗口,'
      + '演不了。客户端重启生效。',
  },
  player: {
    title: 'Minecraft · 玩家客户端',
    description:
      '以普通玩家身份再开一份客户端进同一个服务器,跟她一起玩。与观察者摄像机是两份进程、'
      + '两个账号名。默认用摄像机那份 .minecraft;要装不同的 World 就另指一个目录。'
      + '进服的时刻由 bot 的玩家列表看到,那一刻把人传送到她旁边。',
    enabledTitle: '玩家客户端',
    enabledDescription: '开启后 World 启动时一并拉起;也可以在挂载面板里单独启停。',
    usernameTitle: '玩家名',
    usernameDescription: '离线账号,必须与 bot 和摄像机的名字都不同。传送认的就是这个名字。',
    gameDirTitle: '.minecraft 目录',
    gameDirDescription: '空 = 用观察者客户端那一份。两份客户端共用一个目录时设置文件是共享的:'
      + '谁最后启动谁说了算,要各自成套只能各给一个目录。natives 仍按账号分开,不会抢同一组 DLL。'
      + '共用时启动前会把聊天可见性掰回 FULL——摄像机为画面干净关掉的聊天连命令行一起关,'
      + '人进了服 T 和 / 都按不动。',
    versionIdTitle: '版本 id',
    versionIdDescription: '空 = versions/ 下唯一那个。要与服务器同版本。',
    javaPathTitle: 'java 路径',
    javaPathDescription: '空 = 用观察者客户端那一份。',
    jvmArgsTitle: 'JVM 参数',
    widthTitle: '窗口宽',
    heightTitle: '窗口高',
    autoJoinTitle: '启动即进服',
    autoJoinDescription: '关掉就停在主菜单,自己从多人游戏里进。',
    teleportToBotTitle: '进服传送到她旁边',
    teleportToBotDescription: '经服务器控制台下 tp;外部服务器则借 bot 的 op 权限。挂载面板里也能随时手动传一次。',
  },
};

export const en: typeof zh = {
  label: 'Minecraft',
  server: 'Server',
  task: 'Task',
  view: 'View',
  notStarted: 'Not started',
  disconnected: 'Disconnected',
  notConnected: 'Not connected',
  idle: 'Idle',
  clientView: 'Client first-person',
  viewer: 'viewer',
  none: 'None',
  connecting: 'Connecting',
  unreachable: (address, failure) => `Cannot reach ${address}${failure ? ` (${failure})` : ''}`,
  openView: 'Open view',
  engine: 'Engine',
  engineStarting: 'Starting',
  panels: {
    mount: {
      title: 'Bring-up',
      description: 'Connection mode; start and stop the local server or connect to an external one; '
        + 'start and stop the spectator and player clients.',
    },
    skin: {
      title: 'Skins',
      description: 'Which skin the bot and the player wear: pick a PNG for the clients to read '
        + '(an offline server has no skin textures).',
    },
    world: { title: 'Worlds & rules', description: 'Switch saves, create a new world, set difficulty and game mode.' },
    access: {
      title: 'Cheats & permissions',
      description: 'Who has cheat permissions (ops.json), and server settings such as command blocks and account verification.',
    },
    log: { title: 'World log', description: 'A session\'s record: commands issued, deliveries, and the outcome of each step.' },
  },
  storage: {
    'minecraft-chests': {
      label: 'Container ledger',
      note: 'Chests opened by stow/take/use, furnace slots with estimated finish times, and workstations the bot placed. '
        + 'Clearing treats them as never opened. Not landmarks',
    },
    'minecraft-deaths': {
      label: 'Death ledger',
      note: 'Deaths in this world today and in total. The death receipt reports the count, and receipts for memory '
        + 'writes that mention a death include this reading. Clearing resets it to no deaths',
    },
    'minecraft-explored': {
      label: 'Exploration ledger',
      note: 'When a find search ends, records the farthest distance reached per direction and the biome there; '
        + 'a summary goes into the environment prompt. Clearing treats every place as unvisited. Not landmarks',
    },
    'minecraft-works': {
      label: 'Works register',
      note: 'Blocks the bot made: built blueprints, tilled farmland, planted crops. Pathfinding does not pillar on top of '
        + 'registered blocks; excavate and placement only mention them in receipts and do not refuse. '
        + 'Clearing forgets that the bot built them. Not landmarks',
    },
    'minecraft-policy': {
      label: 'Standing rules (mc_policy)',
      note: 'Scaffold and lighting block lists and when to use them, travel preference, reserved tools, '
        + 'conditions for starting fights. Clearing resets all six to defaults',
    },
    'minecraft-blueprints': {
      label: 'Blueprints',
      note: 'Loaded blueprint designs (palette + matrix), plus each world\'s build anchors and progress for them. '
        + 'Designs are not tied to a world and persist across worlds. Clearing deletes every design the bot drew; '
        + 'they must be designed or saved again',
    },
    'minecraft-pwsr': {
      label: 'Transient tables (goals, waypoints, etc.)',
      note: 'PWSR transient state: goals and waypoints the bot projected from its notes, plus the blueprint build progress '
        + 'view, namespaced per world. It does not survive a restart; clearing it is the same as starting the next session early',
    },
  },
  envPromptTitle: 'Minecraft · Environment prompt',
  envPromptDescription: 'Standing facts for the Minecraft World (skill sequences, world observation, reflexes).',
  worldVar: 'World identity: the save name for a hosted local server, the server address for an external one. '
    + 'The bot\'s location memories are scoped by it.',
  exploredVar: 'Exploration summary (farthest distance and end biome in 8 directions); empty before any exploration.',
  policyVar: 'The mc_policy entries (of six) that differ from the defaults; empty when all are default.',
  cameraVar: 'Spectator camera note; empty when the client is off. Edit its wording in the Camera note document.',
  cameraNoteTitle: 'Minecraft · Camera note',
  cameraNoteDescription: 'Appended to the end of the environment prompt when the spectator client is on.',
  unknownMethod: (panel, method) => `Unknown panel method: ${panel}.${method}`,
  unknownPanel: (panel) => `Unknown panel: ${panel}`,
  reconnectLocal: 'When hosting locally, use Stop and Start to reconnect',
  noServerDirLocal: 'Set worlds.minecraft.local.serverDir in this World\'s config first',
  noServerDirExternal: 'With an external server, saves and permissions are managed on that server; '
    + 'they can be edited here only when hosting locally (worlds.minecraft.local.serverDir)',
  refusalLocal: 'No server directory configured; cannot change',
  refusalExternal: 'External server settings cannot be changed here',
  stopFirst: (what) => `Stop the server before ${what}`,
  whatSelect: 'switching saves',
  whatCreate: 'creating a new save',
  nextStartLoads: (name) => `Next start loads "${name}"`,
  worldExists: (name) => `"${name}" already exists; select it instead`,
  seedPart: (seed) => `seed ${seed}`,
  noStructures: 'no structures',
  willGenerate: (name, how) => `Next start generates the new world "${name}" (${how})`,
  propertiesWritten: 'Written to server.properties; takes effect on next start',
  difficulty: 'Difficulty',
  defaultGamemode: 'Default game mode',
  list: (items) => items.join(', '),
  liveHostedOnly: 'The server is running: only difficulty and default game mode can change now; stop it for the rest',
  liveExternal: 'The server was started outside this World and has no console; stop it and edit the file',
  appliedLive: (items) => `${items} applied now (this run only, not written to server.properties)`,
  needName: 'Enter a name first',
  badName: 'Game names cannot contain spaces or quotes',
  liveExternalOps: 'The server was started outside this World and has no console; stop it to change the list',
  opSent: (on, who) => (on
    ? `Server granted cheat permissions to ${who} (effective now)`
    : `Server revoked cheat permissions from ${who} (effective now)`),
  consoleWriteFailed: 'Could not write to the server console; try restarting the server',
  opUnchanged: (on, who) => (on ? `${who} already has cheat permissions` : `${who} has no cheat permissions`),
  opWritten: (on, who) => (on
    ? `Granted cheat permissions to ${who}; takes effect on next start`
    : `Revoked cheat permissions from ${who}; takes effect on next start`),
  stopForProperties: 'The server reads these only at startup; stop it first',
  skinCamera: 'camera',
  skinPlayerClient: 'player client',
  skinsLive: (who) => `Installed; the ${who.join(' and ')} ${who.length > 1 ? 'are' : 'is'} running `
    + 'and must rejoin the server to show it',
  skinsNextStart: 'Installed; takes effect the next time the client starts',
  skinCleared: 'Removed; that account is back to a random default skin',
  skinNone: 'No skin was selected',
  noSuchRole: (role) => `Unknown role: ${role}`,
  noSkinYet: 'No skin selected for this role',
  tpNoPlayer: 'No player name configured; nobody to teleport',
  tpSameName: (who) => `The player name is the same as the bot's (${who}); cannot teleport`,
  tpDone: (who, target) => `Teleported ${who} next to ${target}`,
  tpNoBot: 'The server is not hosted by this World and the bot is not connected; nobody can issue the teleport',
  tpViaBot: (who, target) => `Sent /tp ${who} ${target} with the bot's permission (the server refuses if the bot is not an op)`,
  levelTypes: {
    'minecraft:normal': { label: 'Default', note: 'Vanilla terrain' },
    'minecraft:flat': { label: 'Superflat', note: 'Layers from the generator settings; empty = the vanilla three layers' },
    'minecraft:large_biomes': { label: 'Large biomes', note: 'Same terrain with larger biomes' },
    'minecraft:amplified': { label: 'Amplified', note: 'Extreme mountain terrain; performance-heavy' },
    'minecraft:single_biome_surface': {
      label: 'Single biome',
      note: 'One biome for the whole world, named in the generator settings ({"biome":"minecraft:desert"})',
    },
  },
  flatPresets: {
    classic: { label: 'Classic flat', note: 'Bedrock + 2 dirt + grass block, plains biome' },
    void: { label: 'The void', note: 'A single layer of air with a small platform at spawn' },
    tunnelers: { label: 'Tunnelers\' dream', note: 'Bedrock + 230 stone; the whole world is minable rock' },
    minable: { label: 'Minable flat', note: 'Bedrock + 59 stone + dirt and grass: a flat surface with ore below' },
  },
  nameEmpty: 'Save name cannot be empty',
  nameTooLong: 'Save name too long (max 64 characters)',
  nameBadChars: 'Save name cannot contain \\ / : * ? " < > |',
  nameReserved: 'This name is not allowed',
  genNotJson: (message) => `Generator settings are not valid JSON: ${message}`,
  genNotObject: 'Generator settings must be a JSON object (e.g. {"layers":[…],"biome":"…"})',
  blocks: 'blocks',
  times: 'times',
  connection: {
    title: 'Minecraft · Connection',
    description: 'Address, port, username and version take effect on the next connection: for an external server, '
      + 'click "Reconnect" in the Bring-up panel; when hosting locally, stop and start the server. '
      + 'The server path takes effect the next time the server starts.',
    serverModeTitle: 'Connection mode',
    serverModeDescription: 'local = this World starts and stops the server in the local server directory; '
      + 'external = connect only to the address and port below, without the local server directory; '
      + 'auto = local when a local server directory is set, otherwise external. '
      + 'A change disconnects the bot; start or connect again in the Bring-up panel.',
    hostTitle: 'Server address',
    portTitle: 'Port',
    usernameTitle: 'In-game username',
    usernameDescription: 'The bot logs in with an offline account; the server must have account verification off (online-mode=false).',
    versionTitle: 'Protocol version',
    versionDescription: 'mineflayer connects with this version; it must match the server.',
    viewerPortTitle: 'Viewer port',
    viewerPortDescription: '0 = off. The prismarine-viewer web page, used by the OBS browser source and the "viewer" frame source.',
    serverDirTitle: 'Local server directory',
    serverDirDescription: 'The directory containing server.jar. A change while running takes effect after a stop and restart.',
    startWithWorldTitle: 'Start server with the World',
    startWithWorldDescription: 'On = start the local server and connect when the World starts. No effect without a server directory.',
    javaPathTitle: 'Server java path',
    javaPathDescription: 'Empty = auto: a jdk/ next to the server directory, then java on PATH.',
    jvmArgsTitle: 'Server JVM arguments',
    jvmArgsDescription: 'Space-separated; takes effect on the next start. Default -Xms1G -Xmx2G.',
    cheatsTitle: 'Grant cheat permissions automatically',
    cheatsDescription: 'Before each server start by this World, add the bot, camera and player to the operator list '
      + '(ops.json, level 4). Off = use the list as it is. Edit the list and related server settings in the '
      + 'Cheats & permissions panel.',
  },
  rhythm: {
    title: 'Minecraft · Pacing & reflexes',
    description: 'Throttling sets how often a change is worth reporting. Reflexes are self-preservation without the LLM; '
      + 'every reflex action is reported afterwards. All take effect immediately.',
    tickSecTitle: 'World throttle tick',
    moveThresholdTitle: 'Movement report threshold',
    snapshotSecTitle: 'World snapshot interval',
    snapshotSecDescription: 'A world snapshot is delivered with the next batch of events and never wakes the bot on its own; '
      + 'world state is read at delivery. This is the minimum interval between snapshots.',
    snapshotAnchorSecTitle: 'Full snapshot interval',
    snapshotAnchorSecDescription: 'Snapshots are deduplicated per section and only changed sections are sent. Once this long '
      + 'has passed since the last full snapshot, a full one is sent to reset the baseline (a context truncation also forces one).',
    precheckTitle: 'Pre-check',
    precheckDescription: 'On accepting a task, run a read-only dry run and list the steps that cannot succeed right now in the '
      + 'acceptance receipt (failures only); dry-run again before each step and skip steps judged impossible. '
      + 'Off = run every step and learn the outcome afterwards.',
    priorOutcomeTitle: 'Prior outcome in receipt',
    priorOutcomeDescription: 'When the same task is issued again (same skill and target, ignoring coordinates and counts), '
      + 'the acceptance receipt adds the outcome of the previous attempt within 15 minutes; nothing is added if it succeeded. '
      + 'This restores what a context handoff dropped. Off = the receipt covers only the current task.',
    fightBackTitle: 'Fight back when hit',
    fightBackDescription: 'Off = no counterattack when hit; the main model decides whether to fight. '
      + 'Fleeing below the flee health is unaffected.',
    fleeHealthTitle: 'Flee health',
    fleeHealthDescription: 'Retreat when health drops below this value, even with fight-back off. Applies only to opponents '
      + 'that hit back (players and hostile mobs); hunting pigs or fish for food is not limited by it.',
    reactCooldownSecTitle: 'Hit reaction cooldown',
    antiDrownTitle: 'Surface to avoid drowning',
    antiLavaTitle: 'Escape when burning',
    antiLavaDescription: 'On touching lava or fire, move out immediately by direct control, then hand over to the pathfinder. '
      + 'The check uses what the hitbox overlaps, because walking along a lava edge deals damage while the block '
      + 'underfoot is still air. Off = burns until death.',
    combatTitle: 'Combat mode (night self-defense)',
    combatDescription: 'When hit, or when a hostile mob comes within the trigger radius, take over movement and attacks until '
      + 'the fight ends; the task is paused and events are still delivered, so the bot can still talk. Never starts a fight. '
      + 'Off = fall back to "Fight back when hit", two swings within 10 seconds.',
    engageRadiusTitle: 'Combat trigger radius',
    engageRadiusDescription: 'Fight only when a hostile mob comes this close. It detects a mob that came to the bot; '
      + 'the bot never strikes first within it.',
    chaseMaxTitle: 'Max chase distance',
    maxSecTitle: 'Max combat duration',
    maxSecDescription: 'At the limit, stop fighting and hand control back even if mobs remain. Next to a spawner a target is '
      + 'always available, and without this limit the bot would go silent on stream.',
    spaceTitle: 'Combat spacing',
    spaceDescription: 'A zombie\'s effective attack range is about 2.2-2.4 blocks, at most 3.0. At 2.88 the bot almost never '
      + 'gets hit (stronger); at 2.6 it gets hit now and then (more human). This only changes how the fight looks.',
    busyRatioTitle: 'Combat share limit',
    busyRatioDescription: 'When combat takes more than this share of a sliding 5-minute window, force a cooldown and stop '
      + 'entering fights automatically. Where mobs come in endless waves, the bot should move elsewhere.',
    cooldownSecTitle: 'Combat cooldown',
    cooldownSecDescription: 'After the share limit triggers, do not enter fights automatically for this long (still fights back when hit).',
    clickMsTitle: 'Show · Slot interval',
    clickMsDescription: 'With GUI show on, pause this long between placing each ingredient or moving each stack. 0 = instant. '
      + 'All show timings drop to zero when the camera is off or "GUI show" is off.',
    dwellOpenMsTitle: 'Show · Pause after opening',
    dwellOpenMsDescription: 'Wait this long after opening a container screen before acting.',
    dwellResultMsTitle: 'Show · Result display',
    dwellResultMsDescription: 'After all ingredients are placed, pause so the result slot stays on screen before it is taken.',
    dwellCloseMsTitle: 'Show · Pause before closing',
    reopenGapMsTitle: 'Show · Reopen gap',
    reopenGapMsDescription: 'Minimum gap between closing a container screen and opening the next; not counted in the per-task budget.',
    budgetMsTitle: 'Show · Per-task budget',
    budgetMsDescription: 'Total show time for one operation; once exceeded, the remaining steps run instantly, '
      + 'so emptying a whole chest does not turn into a long slow-motion shot.',
  },
  client: {
    title: 'Minecraft · Spectator client',
    description: 'A real game window follows the bot in spectator mode and shows the same picture viewers see '
      + '(including shaders and mods), at the cost of one client process. OBS captures this window or the viewer page '
      + 'for the audience; the World is not involved.',
    enabledTitle: 'Spectator client',
    enabledDescription: 'On = start the client when the World starts. It can also be started and stopped in the Bring-up panel.',
    gameDirTitle: '.minecraft directory',
    gameDirDescription: 'Required for the spectator client to start. A change while running takes effect after a stop and restart.',
    versionIdTitle: 'Version id',
    versionIdDescription: 'Empty = the only one under versions/. For Fabric+Iris and similar, enter the combined version\'s '
      + 'directory name; inheritance is resolved automatically.',
    javaPathTitle: 'Client java path',
    javaPathDescription: 'Empty = java on PATH. The version must match the game: 1.20.6 uses Java 21. A newer JDK makes the '
      + 'bundled LWJGL 3.3.3 reject the JNI version (an Unsupported JNI version warning in the startup log), '
      + 'followed by random native crashes.',
    jvmArgsTitle: 'Client JVM arguments',
    jvmArgsDescription: 'Space-separated. With shaders, use at least -Xmx4G.',
    usernameTitle: 'Camera account name',
    usernameDescription: 'Offline account; must differ from the bot\'s in-game username.',
    widthTitle: 'Window width',
    heightTitle: 'Window height',
    autoJoinTitle: 'Join server on launch',
    autoSpectateTitle: 'Spectate the bot automatically',
    autoSpectateDescription: 'After joining, switch the camera to spectator and attach it to the bot. Commands go through the '
      + 'server console; on an external server they use the bot\'s op permission.',
    resyncSecTitle: 'Spectate resync interval',
    resyncSecDescription: 'Bot death or reconnection detaches the camera, so the command is reissued periodically. '
      + '0 = only on join and respawn.',
    restartMaxTitle: 'Crash restart limit',
    restartMaxDescription: 'Restart automatically after an abnormal exit, waiting 30 seconds and doubling each time; past the '
      + 'limit, stop retrying and raise an alert. The count resets when two abnormal exits are more than 10 minutes apart. '
      + '0 disables automatic restart.',
    noPauseOnLostFocusTitle: 'Adjust launch options',
    noPauseOnLostFocusDescription: 'Before launch, change settings in this game directory. options.txt: turn off '
      + 'pauseOnLostFocus (no pause menu after alt+tab), skip the first-launch screens, set master volume to maximum '
      + '(at 0 the game is silent). SpectatorPlus: synced screens follow the "GUI show" switch. '
      + 'Turn this off when pointing at a .minecraft you play with yourself.',
    syncGuiTitle: 'GUI show',
    syncGuiDescription: 'When the bot uses a chest, crafting table or furnace, mirror that screen onto the camera view '
      + '(SpectatorPlus Open Synced Screens). With the show timings under Pacing & reflexes, viewers see each ingredient '
      + 'placed and the result appear and get taken. 2x2 inventory crafting has no window in the protocol and cannot be shown. '
      + 'Takes effect after a client restart.',
  },
  player: {
    title: 'Minecraft · Player client',
    description: 'A second client joins the same server as a regular player to play alongside the bot. It is a separate '
      + 'process and account from the spectator camera. Uses the camera\'s .minecraft by default; point it at another '
      + 'directory for a different install. When the bot\'s player list shows the player joining, the player is '
      + 'teleported next to the bot.',
    enabledTitle: 'Player client',
    enabledDescription: 'On = start with the World. It can also be started and stopped in the Bring-up panel.',
    usernameTitle: 'Player name',
    usernameDescription: 'Offline account; must differ from both the bot and the camera. Teleporting targets this name.',
    gameDirTitle: '.minecraft directory',
    gameDirDescription: 'Empty = the spectator client\'s directory. Two clients sharing a directory share its settings files, '
      + 'and the last one launched wins; give each its own directory for separate settings. Natives stay separate per '
      + 'account, so the two never load the same DLLs. When shared, chat visibility is reset to FULL before launch: '
      + 'the camera hides chat for a clean picture, which also disables commands, so T and / would do nothing for the player.',
    versionIdTitle: 'Version id',
    versionIdDescription: 'Empty = the only one under versions/. Must match the server version.',
    javaPathTitle: 'Java path',
    javaPathDescription: 'Empty = the spectator client\'s.',
    jvmArgsTitle: 'JVM arguments',
    widthTitle: 'Window width',
    heightTitle: 'Window height',
    autoJoinTitle: 'Join server on launch',
    autoJoinDescription: 'Off = stays on the main menu; join from Multiplayer yourself.',
    teleportToBotTitle: 'Teleport to the bot on join',
    teleportToBotDescription: 'Issues tp through the server console; on an external server it uses the bot\'s op permission. '
      + 'The Bring-up panel can also teleport manually at any time.',
  },
};

export const text = (language: Language) => pick(language, { zh, en });
