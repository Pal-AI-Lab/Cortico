import type { ExtensionView } from '../extensions/index.ts';
import type { WorldView } from './index.ts';

export interface WorldLibraryItem {
  key: string;
  label: string;
  world?: WorldView;
  extension?: ExtensionView;
}

/** Installed or removed since the process started, and not running as it is: it waits in its own group. */
export function needsRestart(item: WorldLibraryItem): boolean {
  return item.extension?.state === 'removed' || (item.extension?.state === 'pending-restart' && !updatePending(item));
}

/** A new version installed over one the process loaded: the loaded one goes on as it was until the process restarts. */
export function updatePending(item: WorldLibraryItem): boolean {
  return item.extension?.state === 'pending-restart' && item.extension.loaded;
}

/** Pending downloads lead the list; every other item retains the server's assembly order. */
export function worldLibrary(worlds: readonly WorldView[], extensions: readonly ExtensionView[], recent: readonly string[] = []): WorldLibraryItem[] {
  const available = extensions.filter(item => item.kind === 'world' || !item.kind);
  const used = new Set<string>();
  const items: WorldLibraryItem[] = worlds.map(world => {
    const extension = available.find(item => item.worldId === world.id);
    if (extension) used.add(extension.name);
    return { key: extension?.name ?? `world:${world.id}`, label: world.label || extension?.metadata?.displayName || world.id, world, extension };
  });
  for (const extension of available) if (!used.has(extension.name)) {
    items.push({ key: extension.name, label: extension.metadata?.displayName || extension.label || extension.worldId || extension.name, extension });
  }
  const rank = (item: WorldLibraryItem) => {
    if (!needsRestart(item)) return recent.length + 1;
    const index = recent.indexOf(item.key);
    return index < 0 ? recent.length : index;
  };
  return items.sort((a, b) => rank(a) - rank(b));
}
