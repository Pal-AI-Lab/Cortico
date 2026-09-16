/** 默认导出 BotDefinition；deployment.json 的 bot 字段引用包名，多份部署可使用同一个包。 */
import { resolve } from 'node:path';
import type { BotDefinition, BotParts } from 'cortico/bot.ts';
import type { CoreConfig, World } from 'cortico/core/types.ts';
import type { LoadedConfig } from 'cortico/core/config.ts';
import { CORE_DEFAULTS } from 'cortico/core/config.ts';
import type { WorldDeclaration } from 'cortico/world.ts';
import { ExamplePersona } from './persona/persona.ts';

const HERE = resolve(import.meta.dirname);

export interface ExampleConfig extends CoreConfig {
  /** 一轮唤醒里模型最多调几次工具:软上限提醒收尾,硬上限强制收尾。归 Persona。 */
  rounds: { soft: number; hard: number };
}

/** 这个 Persona 为之设计的渠道:只有终端。有实现没声明的 World 是部署侧选配,默认关。 */
const DECLARES: readonly WorldDeclaration[] = ['terminal'];

function build(loaded: LoadedConfig<ExampleConfig>, worlds: World[]): BotParts<ExampleConfig> {
  const cfg = loaded.config;
  return {
    persona: new ExamplePersona({
      memoryDir: loaded.memoryDir,
      packageDir: HERE,
      worlds,
      rounds: () => cfg.rounds,
    }),
  };
}

const definition: BotDefinition<ExampleConfig> = {
  id: 'example',
  memoryName: 'MEMORY.md',
  declares: DECLARES,
  // 层 1+2:框架默认 ← 这个 bot 的建议。World 段不在这里,启动器按本机实现补。
  defaults: () => ({
    ...structuredClone(CORE_DEFAULTS),
    displayName: 'Example',
    web: { port: 7790 },
    paths: { memory: 'memory', data: 'data' },
    rounds: { soft: 6, hard: 12 },
  }),
  build,
};

export default definition;
