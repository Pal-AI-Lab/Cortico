/** Model choices are bot-owned; framework console surfaces are derived by `createBot`. */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { BotDefinition, BotParts } from 'cortico/bot.ts';
import type { CoreConfig, World, ModelSpec } from 'cortico/core/types.ts';
import type { LoadedConfig } from 'cortico/deploy.ts';
import { CORE_DEFAULTS } from 'cortico/core/config.ts';
import type { WorldDeclaration } from 'cortico/world.ts';
import type { TerminalConfigSection } from 'cortico/worlds/terminal/config.ts';
import { CORMINI_CONTEXT_DEFAULTS, Cormini, type ContextStagePolicy } from './persona/persona.ts';
import { contextStageConfigGroup } from './persona/config.ts';

const HERE = resolve(import.meta.dirname);

/** 层 2 给云端那条端点的模型档:全局端点表里没写时用它。 */
const DEEPSEEK_SPEC: ModelSpec = { model: 'deepseek-flash', thinking: false, contextWindow: 1_000_000 };

export interface CorminiConfig extends CoreConfig {
  /** 阶段长度三项与首轮对话开关归 Persona,摘思维链归 core;同住 context 段。 */
  context: CoreConfig['context'] & ContextStagePolicy;
  rounds: { soft: number; hard: number };
  /** null disables baseline wakeups. */
  tick: { intervalMinutes: number | null };
  worlds: {
    terminal: TerminalConfigSection;
  };
}

/** 这个Persona为之设计的渠道:只有终端。 */
const DECLARES: readonly WorldDeclaration[] = ['terminal'];

function build(loaded: LoadedConfig<CorminiConfig>, worlds: World[]): BotParts<CorminiConfig> {
  const cfg = loaded.config;

  const persona = new Cormini({
    memoryDir: loaded.memoryDir,
    context: () => cfg.context,
    rounds: { ...cfg.rounds },
    seedConstitution: readFileSync(resolve(HERE, 'persona/CONSTITUTION.seed.md'), 'utf8'),
    worlds: worlds,
    // 部署侧的自述覆盖:存在就用它,控制台保存也落到那边(见 PromptDocDecl.deploymentPath)。
    orientationOverrideFile: resolve(loaded.rootDir, 'prompts', 'ORIENTATION.md'),
    // 首轮对话是部署者自己写的,与 ORIENTATION 覆盖同住 prompts/;代码包不带。
    firstTurnDir: resolve(loaded.rootDir, 'prompts'),
    // Read per wakeup so console changes take effect immediately.
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
      configGroups: [contextStageConfigGroup('cormini')],
      // 阶段预算与软预警线(终端页上下文圈的分母与黄线);计数与物理上限由 core 报
      status: () => ({ context: { maxTokens: cfg.context.maxTokens, softRatio: cfg.context.softRatio } }),
    },
  };
}

const definition: BotDefinition<CorminiConfig> = {
  id: 'cormini',
  memoryName: 'GitMem',
  declares: DECLARES,
  defaults: () => ({
    ...CORE_DEFAULTS,
    displayName: '可缇mini',
    providers: {
      ...structuredClone(CORE_DEFAULTS.providers),
      // 模型归 provider:这条端点默认跑哪个模型是部署事实,Persona不参与。
      deepseek: { ...structuredClone(CORE_DEFAULTS.providers.deepseek), spec: { ...DEEPSEEK_SPEC } },
    },
    web: { port: 7788 },
    paths: { memory: 'workspace', data: 'data' },
    batching: { ...CORE_DEFAULTS.batching },
    // session 阶段长度属于人格配置。
    context: { ...CORMINI_CONTEXT_DEFAULTS, ...CORE_DEFAULTS.context },
    tick: { intervalMinutes: null },
    rounds: { soft: 6, hard: 12 },
  } as unknown as CorminiConfig),
  build,
};

export default definition;
