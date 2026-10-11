import type { WorldDefinition } from '../../world.ts';
import { TERMINAL_DEFAULTS, type TerminalConfigSection } from './config.ts';
import { TerminalWorld } from './world.ts';

export const TERMINAL: WorldDefinition<TerminalConfigSection> = {
  id: 'terminal',
  label: '终端对话',
  defaults: () => ({ ...TERMINAL_DEFAULTS }),
  create: (ctx) => new TerminalWorld({
    timezone: ctx.timezone,
    botName: ctx.botName,
    cfg: ctx.cfg,
  }),
};
