import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { BotDefinition, BotParts } from 'cortico/bot.ts';
import type { ConfigGroup, CoreConfig, World, ModelSpec } from 'cortico/core/types.ts';
import type { LoadedConfig } from 'cortico/deploy.ts';
import { CORE_DEFAULTS } from 'cortico/core/config.ts';
import type { WorldDeclaration, WorldSection } from 'cortico/world.ts';
import type { TerminalConfigSection } from 'cortico/worlds/terminal/config.ts';
import type { BilibiliConfigSection } from 'cortico/worlds/bilibili/config.ts';
import type { MinecraftConfigSection } from 'cortico/worlds/minecraft/config.ts';
import { CortiV } from './persona/persona.ts';
import type { ContextStagePolicy } from '../cormini/persona/persona.ts';
import { contextStageConfigGroup } from '../cormini/persona/config.ts';

const HERE = resolve(import.meta.dirname);

/**
 * 层 2 给云端那条端点的模型档:全局端点表里没写时用它。
 *
 * `maxTokens` 是单轮生成的硬封顶:云端供应商有服务端默认上限,但 llama-server
 * 默认**无限生成**——本地模型在工具 JSON 里复读时若不封顶,这一轮永不结束。
 */
const DEEPSEEK_SPEC: ModelSpec = {
  model: 'deepseek-flash',
  thinking: false,
  contextWindow: 1_000_000,
  maxTokens: 4096,
};

/** 存在方式自述的源文件;控制台「Persona」页可编辑,重载前缀即生效。 */
const ORIENTATION_FILE = resolve(HERE, 'persona/ORIENTATION.md');

/**
 * 这个Persona为之设计的渠道。实现由启动器并进来(仓内目录加扩展),哪些挂载由 config.json 的
 * `worlds.<id>.enabled` 决定,控制台可热切;`vtuber` 与 `asr` 是扩展包,没装时是灰卡。
 */
const DECLARES: readonly WorldDeclaration[] = ['terminal', 'vtuber', 'bilibili', 'asr', 'minecraft', 'pvz', 'canvas'];

/**
 * 上下文与交接容量配置归Persona，控制台表单与 bots/cormini/persona/config.ts 共用。
 */
export const CORTIV_CONTEXT_CONFIG_GROUP: ConfigGroup = contextStageConfigGroup('cortiv');

/** 关闭后台构思时，World 的 cognition 句柄不可用。 */
export const CORTIV_COGNITION_CONFIG_GROUP: ConfigGroup = {
  id: 'cortiv-cognition',
  owner: 'persona',
  schema: {
    type: 'object',
    title: '后台构思(代想)',
    description:
      '允许 World 请求后台构思并接收结果。同一时刻处理一项，前台继续运行；费用与用量记入「代想」session。',
    properties: {
      'cognition.enabled': {
        type: 'boolean',
        title: '允许 World 请托后台思考',
        'x-hot': true,
        description:
          '开:World 可以请她想事情(如 Minecraft 的蓝图设计),用的是主档模型、'
          + '最多 8 轮工具循环、整体 15 分钟封顶。'
          + '关:这个能力对 World 直接消失(不是报错),World 各自走自己的兜底路子。'
          + '改完立刻生效,不用重启。',
      },
    },
  },
};

export interface CortiVConfig extends CoreConfig {
  /** 阶段长度三项归Persona,摘思维链与首轮对话两项归 core;同住 context 段。 */
  context: CoreConfig['context'] & ContextStagePolicy;
  rounds: { soft: number; hard: number };
  cognition: { enabled: boolean };
  tick: {
    /** null disables baseline wakeups. */
    intervalMinutes: number | null;
  };
  worlds: {
    terminal: TerminalConfigSection;
    /** 外部包 `cortico-world-vtuber` 的段:形状归那个包,Persona只知道它在。 */
    vtuber: WorldSection & Record<string, unknown>;
    bilibili: BilibiliConfigSection;
    minecraft: MinecraftConfigSection;
    /** 扩展包 `cortico-world-pvz` 的段,同上。 */
    pvz: WorldSection & Record<string, unknown>;
    /** 扩展包 `cortico-world-asr` 的段,同上。 */
    asr: WorldSection & Record<string, unknown>;
    /** 扩展包 `cortico-world-canvas` 的段,同上。 */
    canvas: WorldSection & Record<string, unknown>;
  };
}

function build(loaded: LoadedConfig<CortiVConfig>, worlds: World[]): BotParts<CortiVConfig> {
  const cfg = loaded.config;

  // CortiV(可缇Corti):直播 memory 系统(观众档案首见唤起/软边界速记/交接后并行梦)
  // 是类自身的行为,不走构造开关。
  const persona = new CortiV({
    memoryDir: loaded.memoryDir,
    context: () => cfg.context,
    rounds: { ...cfg.rounds },
    seedConstitution: readFileSync(resolve(HERE, 'persona/CONSTITUTION.seed.md'), 'utf8'),
    worlds: worlds,
    // Persona把它自报为可编辑的静态前缀源(Persona卡),前缀也从它现读。
    orientationFile: ORIENTATION_FILE,
    // 部署侧的自述覆盖:存在就用它,控制台保存也落到那边(见 PromptDocDecl.deploymentPath)。
    orientationOverrideFile: resolve(loaded.rootDir, 'prompts', 'ORIENTATION.md'),
    // 首轮对话是部署者自己写的,与 ORIENTATION 覆盖同住 prompts/;代码包不带。
    firstTurnDir: resolve(loaded.rootDir, 'prompts'),
    // 现读:控制台上关掉,下一次 World 来请托时句柄就已经不在了(不用重启)。
    cognitionEnabled: () => cfg.cognition.enabled,
    tickDelayMs: () =>
      cfg.tick.intervalMinutes === null ? null : cfg.tick.intervalMinutes * 60_000,
  });

  return {
    persona,
    onStart: () => {
      persona.startRhythm();
    },
    onStop: () => {
      persona.stopRhythm();
    },
    console: {
      configGroups: [CORTIV_CONTEXT_CONFIG_GROUP, CORTIV_COGNITION_CONFIG_GROUP],
      // 阶段预算与软预警线(终端页上下文圈的分母与黄线);计数与物理上限由 core 报
      status: () => ({ context: { maxTokens: cfg.context.maxTokens, softRatio: cfg.context.softRatio } }),
    },
  };
}

const definition: BotDefinition<CortiVConfig> = {
  id: 'cortiv',
  // 记忆系统与 Cormini 同一套(工作区即记忆,Git 记账)。
  memoryName: 'GitMem',
  declares: DECLARES,
  defaults: () => ({
    ...CORE_DEFAULTS,
    displayName: '可缇Corti',
    // 端点表是全局部署事实(`<部署根>/providers/`),不归代码包:本机那条 `local`
    // (端口、llama-server 路径、采样参数)已经搬出去了。这里只剩层 1 那两条默认。
    providers: {
      ...structuredClone(CORE_DEFAULTS.providers),
      // 模型归 provider:这条端点默认跑哪个模型是部署事实,Persona不参与。
      deepseek: { ...structuredClone(CORE_DEFAULTS.providers.deepseek), spec: { ...DEEPSEEK_SPEC } },
    },
    web: { port: 7789 },
    paths: { memory: 'workspace', data: 'data' },
    batching: { ...CORE_DEFAULTS.batching },
    // 交接阈值(塞满多少就交接)。这只是**层 2 建议值** —— config.json 的 context 段
    // 压过它(deploy.ts 的四层深合并),控制台「可缇Corti → 参数」改的也是那一份。
    // 别把它跟 provider 那份 spec 的 contextWindow(模型物理窗口)或 maxTokens
    // (单轮生成上限)搞混:那两样归 provider,Persona拿不到。
    context: { maxTokens: 64000, keepRatio: 1 / 4, softRatio: 0.85, firstTurn: false, ...CORE_DEFAULTS.context },
    tick: { intervalMinutes: 45 },
    // 默认开:蓝图设计就走这条,关掉它 Minecraft 那边的 design 只能如实拒收。
    cognition: { enabled: true },
    rounds: { soft: 6, hard: 12 },
    // World 段不在这里:实现的默认值由启动器补。人格身份与演出选择
    // (`minecraft.username`、`vtuber.delayedSources`、要不要开视觉)在
    // bots/cortiv/worlds/<id>/config.json,本机事实(凭证、程序路径、设备、开没开)
    // 在这份部署的 config.json。
  } as unknown as CortiVConfig),
  build,
};

export default definition;
