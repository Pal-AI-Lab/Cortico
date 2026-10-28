import { describeTools, type WorldDefinition } from '../../world.ts';
import { type WebSearchConfigSection, WEBSEARCH_DEFAULTS, WEBSEARCH_SECRETS } from './config.ts';
import { WEBSEARCH_TOOL_DECLS, WebSearchWorld } from './world.ts';


export const WEBSEARCH: WorldDefinition<WebSearchConfigSection> = {
  id: 'websearch',
  copy: {connection: {keys: [], secrets: Object.values(WEBSEARCH_SECRETS)}},
  label: 'WebSearch',
  defaults: () => ({ ...WEBSEARCH_DEFAULTS }),
  create: (ctx) =>
    new WebSearchWorld({
      cfg: ctx.cfg,
      secret: (name) => ctx.secret(name),
      storeSecret: (name, value) => ctx.storeSecret(name, value),
    }),
  describe: {
    tools: describeTools(WEBSEARCH_TOOL_DECLS, {
      web_search: {
        zh: '用 Brave Search 或 DeepSeek 搜网页，拿回带来源的几条结果。',
        en: 'Searches the web through Brave Search or DeepSeek and returns a few results with sources.',
      },
    }),
    events: [],
  },
};
