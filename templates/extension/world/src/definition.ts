import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { EXAMPLE_DEFAULTS, type ExampleConfigSection } from './config.ts';
import { EXAMPLE_TOOL_DECLS, ExampleWorld } from './world.ts';

export const EXAMPLE: WorldDefinition<ExampleConfigSection> = {
  id: 'example',
  label: 'Example',
  defaults: () => ({ ...EXAMPLE_DEFAULTS }),
  // `ctx.cfg` 是 `worlds.example` 的活引用:热改的键现读即生效。
  create: (ctx) => new ExampleWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),
  // 自描述:可能出现的全部工具与会推出的全部事件,不进提示词。
  describe: {
    tools: describeTools(EXAMPLE_TOOL_DECLS, {
      example_echo: { zh: '把一段文字加上配置的开头一句原样返回。', en: 'Returns the given text prefixed with the configured greeting.' },
    }),
    events: [
      { type: 'example.started', description: { zh: 'World 挂载完成。', en: 'The World was mounted.' } },
    ],
  },
};
