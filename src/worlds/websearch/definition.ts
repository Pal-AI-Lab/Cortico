import type { WorldDefinition } from '../../world.ts';
import { type WebSearchConfigSection, WEBSEARCH_DEFAULTS, WEBSEARCH_SECRET } from './config.ts';
import { WebSearchWorld } from './world.ts';


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
};
