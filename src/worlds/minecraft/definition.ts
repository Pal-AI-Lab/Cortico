import type { WorldDefinition } from '../../world.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from './config.ts';
import { MinecraftWorldProxy } from './proxy.ts';

export const MINECRAFT: WorldDefinition<MinecraftConfigSection> = {
  id: 'minecraft',
  label: 'Minecraft',
  defaults: () => structuredClone(MINECRAFT_DEFAULTS as unknown as MinecraftConfigSection),
  // The child process isolates Mineflayer physics and pathfinding from the main loop.
  create: (ctx) =>
    new MinecraftWorldProxy({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      botName: ctx.botName,
      dataDir: ctx.dataDir,
    }),
};
