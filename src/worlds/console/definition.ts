import type { WorldDefinition } from '../../world.ts';
import { CONSOLE_DEFAULTS, type ConsoleConfigSection } from './config.ts';
import { ConsoleWorld } from './world.ts';

export const CONSOLE: WorldDefinition<ConsoleConfigSection> = {
  id: 'console',
  label: '控制台对话',
  defaults: () => ({ ...CONSOLE_DEFAULTS }),
  create: (ctx) => new ConsoleWorld({
    timezone: ctx.timezone,
    botName: ctx.botName,
    cfg: ctx.cfg,
  }),
};
