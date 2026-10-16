import { describeTools, type WorldDefinition } from '../../world.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from './config.ts';
import { MinecraftWorldProxy } from './proxy.ts';
import { MINECRAFT_TOOL_DECLS } from './world.ts';

export const MINECRAFT: WorldDefinition<MinecraftConfigSection> = {
  id: 'minecraft',
  label: 'Minecraft',
  defaults: () => structuredClone(MINECRAFT_DEFAULTS as unknown as MinecraftConfigSection),
  // The child process isolates Mineflayer physics and pathfinding from the main loop.
  create: (ctx) =>
    new MinecraftWorldProxy({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      botName: ctx.botName,
      dataDir: ctx.dataDir,
    }),
  describe: {
    tools: describeTools(MINECRAFT_TOOL_DECLS, {
      mc_do: {
        zh: '把一件活排进工作队列:走路、挖掘、采集、合成、建造、战斗等技能按顺序执行。',
        en: 'Queues a piece of work as an ordered list of skills such as walking, digging, gathering, crafting, building and fighting.',
      },
      mc_scout: {
        zh: '用与 mc_do 相同的技能做一次只读试跑,看能不能走到、能不能建,不改动世界。',
        en: 'Dry-runs the same skills as mc_do to see whether a route or build would work, without changing the world.',
      },
      mc_policy: {
        zh: '设定干活的常驻规矩,立即生效。',
        en: 'Sets standing rules for how work is done; takes effect immediately.',
      },
      mc_goal: {
        zh: '登记并跟踪当前世界里的目标,最多五个。',
        en: 'Records and tracks up to five goals in the current world.',
      },
      mc_map: {
        zh: '给当前世界里的地点命名登记,最多 24 处,读回时带方位与距离。',
        en: 'Names and records up to 24 places in the current world; reading them back gives bearing and distance.',
      },
      mc_blueprint: {
        zh: '设计、载入或丢弃建筑与机关的蓝图,mc_do 的建造照载入的蓝图施工。',
        en: 'Designs, loads or drops blueprints for buildings and machines; mc_do builds from the loaded one.',
      },
      mc_check: {
        zh: '交一组断言给世界核对,只返回与事实不符的条目。',
        en: 'Checks a list of assertions against the world and returns only the ones that do not hold.',
      },
      mc_view_map: {
        zh: '看身上带的一张地图:图片、比例、探索程度与图上标记的坐标。',
        en: 'Looks at a carried map: the picture, scale, explored share and the world coordinates of its markers.',
      },
      mc_bag: { zh: '读当前背包内容。', en: 'Reads the current inventory.' },
      mc_queue: { zh: '读工作队列:正在做的任务、做到哪一步、后面排着什么。', en: 'Reads the work queue: the running task, its current step and what waits behind it.' },
      mc_blocked: { zh: '读最近几次没做成的步骤及原因。', en: 'Reads the last few steps that failed and why.' },
      mc_stop: { zh: '清空工作队列,停下手上的活。', en: 'Clears the work queue and stops the current task.' },
      mc_escape: {
        zh: '作弊传送到最近的安全点(床、出生点或登记的家)并清空队列,只用于卡死脱困。',
        en: 'Cheat-teleports to the nearest safe anchor (bed, spawn or a recorded home) and clears the queue; meant only for getting unstuck.',
      },
    }),
    events: [
      {
        type: 'minecraft.task',
        description: {
          zh: '工作队列里一件任务的结局:完成、部分完成、受阻或撤销,以及战斗反射的汇报。',
          en: 'The outcome of a queued task (done, partial, blocked or cancelled), and reports from combat reflexes.',
        },
      },
      {
        type: 'minecraft.task.progress',
        description: { zh: '正在执行的任务的进度读数。', en: 'A progress reading of the running task.' },
        tags: ['snapshot'],
      },
      {
        type: 'minecraft.chat',
        description: {
          zh: '游戏内聊天、私聊、系统消息与动作栏文字;被点名或私聊时立即投递,bot 自己的发言只记录。',
          en: "In-game chat, private messages, system messages and action bar text; delivered at once on a mention or a private message, the bot's own lines only recorded.",
        },
      },
      {
        type: 'minecraft.event',
        description: {
          zh: '游戏里发生的事:受伤、战斗、死亡、睡觉、升级、效果结束、附近出现的生物,以及游戏引擎崩溃重启。',
          en: 'Things that happen in the game: damage, combat, death, sleeping, levelling up, effects ending, nearby mobs, and game engine crashes and restarts.',
        },
      },
      {
        type: 'minecraft.world',
        description: {
          zh: '自上次汇报以来位置、生命值、背包等读数的变化。',
          en: 'Changes in position, health, inventory and other readings since the last report.',
        },
      },
      {
        type: 'minecraft.world.snapshot',
        description: {
          zh: '定期的世界快照:周围环境、背包、队列、目标与地点,随下一批事件送达。',
          en: 'A periodic world snapshot (surroundings, inventory, queue, goals and places), sent with the next batch.',
        },
        trigger: 'piggyback',
        tags: ['snapshot'],
      },
    ],
  },
};
