import { describeTools, type WorldDefinition } from '../../world.ts';
import { type WebSearchConfigSection, WEBSEARCH_DEFAULTS, WEBSEARCH_SECRET } from './config.ts';
import { WEBSEARCH_TOOL_DECLS, WebSearchWorld } from './world.ts';


export const WEBSEARCH: WorldDefinition<WebSearchConfigSection> = {
  id: 'websearch',
  label: 'WebSearch',
  defaults: () => ({ ...WEBSEARCH_DEFAULTS }),
  create: (ctx) =>
    new WebSearchWorld({
      apiKey: ctx.secret(WEBSEARCH_SECRET),
      country: ctx.cfg.country,
      searchLang: ctx.cfg.searchLang,
      uiLang: ctx.cfg.uiLang,
      safesearch: ctx.cfg.safesearch,
      timeoutMs: ctx.cfg.timeoutMs,
    }),
  describe: {
    tools: describeTools(WEBSEARCH_TOOL_DECLS, {
      web_search: {
        zh: '用 Brave Search 搜网页、新闻、图片或视频,拿回带来源的几条结果。',
        en: 'Searches the web, news, images or videos through Brave Search and returns a few results with sources.',
      },
    }),
    events: [],
  },
};
