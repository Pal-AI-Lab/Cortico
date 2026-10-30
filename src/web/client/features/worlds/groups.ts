/**
 * The user's arrangement of the World library: named groups and the order of Worlds within and
 * between them, kept in the window's localStorage. Keys are `WorldLibraryItem.key`.
 */
export interface WorldGroup { id: string; name: string; collapsed: boolean; items: string[] }
export interface WorldLayout {
  /** Top-level order: item keys and `group:<id>` tokens. */
  top: string[];
  groups: Record<string, WorldGroup>;
}
export type LayoutEntry = { key: string } | { group: WorldGroup; keys: string[] };

export const LAYOUT_STORAGE_KEY = 'cortico.world-groups.v1';
const groupToken = (id: string) => `group:${id}`;
const groupOf = (token: string) => token.startsWith('group:') ? token.slice(6) : undefined;

function emptyLayout(): WorldLayout { return { top: [], groups: {} }; }

export function readLayout(storage: Pick<Storage, 'getItem'> | undefined): WorldLayout | undefined {
  try {
    const value = JSON.parse(storage?.getItem(LAYOUT_STORAGE_KEY) ?? 'null');
    if (!value || !Array.isArray(value.top) || typeof value.groups !== 'object' || !value.groups) return undefined;
    const groups: Record<string, WorldGroup> = {};
    for (const [id, group] of Object.entries(value.groups as Record<string, Partial<WorldGroup>>)) {
      if (typeof group?.name === 'string' && Array.isArray(group.items)) groups[id] = { id, name: group.name, collapsed: !!group.collapsed, items: group.items.filter((key): key is string => typeof key === 'string') };
    }
    return { top: value.top.filter((token: unknown): token is string => typeof token === 'string' && (!groupOf(token) || !!groups[groupOf(token)!])), groups };
  } catch { return undefined; }
}

export function writeLayout(storage: Pick<Storage, 'setItem'> | undefined, layout: WorldLayout): void {
  try { storage?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)); } catch { /* Storage may be unavailable. */ }
}

/**
 * Places `keys` by the layout. Keys the layout has never seen go first, by name; with no saved
 * layout at all, the given order is kept. Returns the entries to draw and the layout that records
 * every key.
 */
export function arrangeLayout(saved: WorldLayout | undefined, keys: readonly string[], nameOf: (key: string) => string): { entries: LayoutEntry[]; layout: WorldLayout } {
  const layout: WorldLayout = saved ? { top: [...saved.top], groups: Object.fromEntries(Object.entries(saved.groups).map(([id, group]) => [id, { ...group, items: [...group.items] }])) } : emptyLayout();
  const known = new Set([...layout.top, ...Object.values(layout.groups).flatMap(group => group.items)]);
  const fresh = keys.filter(key => !known.has(key));
  if (saved) fresh.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  layout.top = saved ? [...fresh, ...layout.top] : [...keys];
  for (const id of Object.keys(layout.groups)) if (!layout.top.includes(groupToken(id))) layout.top.push(groupToken(id));
  const present = new Set(keys);
  const entries: LayoutEntry[] = layout.top.flatMap((token): LayoutEntry[] => {
    const id = groupOf(token);
    if (id) return [{ group: layout.groups[id], keys: layout.groups[id].items.filter(key => present.has(key)) }];
    return present.has(token) ? [{ key: token }] : [];
  });
  return { entries, layout };
}

/** Moves an item into a group (or the top level when `groupId` is null), before `before` or at the end. */
export function moveItem(layout: WorldLayout, key: string, groupId: string | null, before: string | null): void {
  layout.top = layout.top.filter(token => token !== key);
  for (const group of Object.values(layout.groups)) group.items = group.items.filter(item => item !== key);
  const list = groupId ? layout.groups[groupId].items : layout.top;
  const at = before === null ? -1 : list.indexOf(before);
  list.splice(at < 0 ? list.length : at, 0, key);
}

/** Moves a group at the top level, before the item key or `group:<id>` token `before`, or to the end. */
export function moveGroup(layout: WorldLayout, id: string, before: string | null): void {
  const token = groupToken(id);
  layout.top = layout.top.filter(item => item !== token);
  const at = before === null ? -1 : layout.top.indexOf(before);
  layout.top.splice(at < 0 ? layout.top.length : at, 0, token);
}

export function addGroup(layout: WorldLayout, name: string, id: string): WorldGroup {
  const group = { id, name, collapsed: false, items: [] };
  layout.groups[id] = group; layout.top.unshift(groupToken(id));
  return group;
}

/** Removes the group; its items take its place at the top level. */
export function removeGroup(layout: WorldLayout, id: string): void {
  const group = layout.groups[id];
  if (!group) return;
  const at = layout.top.indexOf(groupToken(id));
  layout.top.splice(at < 0 ? layout.top.length : at, 1, ...group.items);
  delete layout.groups[id];
}

export { groupToken };
