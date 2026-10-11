import type { WorldDefinition } from '../../world.ts';
import { TERMINAL_DEFAULTS, type TerminalConfigSection } from './config.ts';
import { TerminalWorld } from './world.ts';
import { text } from './strings.ts';

export const TERMINAL: WorldDefinition<TerminalConfigSection> = {
  id: 'terminal',
  label: text('zh').moduleLabel,
  localize: (language) => ({ label: text(language).moduleLabel }),
  defaults: () => ({ ...TERMINAL_DEFAULTS }),
  create: (ctx) => new TerminalWorld({
    timezone: ctx.timezone,
    botName: ctx.botName,
    cfg: ctx.cfg,
  }),
};
