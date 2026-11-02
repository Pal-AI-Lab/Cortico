/**
 * Small bits of state the World list shares with the window shell:
 * - which active Worlds the sidebar leaves out (localStorage, kept across restarts),
 * - the order of the World pages in 我的 World, which the sidebar follows (localStorage), and
 * - which World page was opened from the list (sessionStorage), so that visit's header offers a way back.
 */
const HIDDEN_KEY = 'cortico.world-nav-hidden.v1';
const ORDER_KEY = 'cortico.world-nav-order.v1';
const RETURN_KEY = 'cortico.world-return';
/** Fired on the window when the hidden set or the order changes. */
export const NAV_HIDDEN_EVENT = 'cortico:world-nav-hidden';

export function navHidden(win: Window): Set<string> {
  try {
    const value = JSON.parse(win.localStorage.getItem(HIDDEN_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set(); }
}

export function setNavHidden(win: Window, pageId: string, hidden: boolean): void {
  const ids = navHidden(win);
  if (hidden) ids.add(pageId); else ids.delete(pageId);
  try { win.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids])); } catch { /* Storage may be unavailable. */ }
  win.dispatchEvent(new Event(NAV_HIDDEN_EVENT));
}

/** The World page ids in the order 我的 World shows them; empty until that page has been drawn once. */
export function navOrder(win: Window): string[] {
  try {
    const value = JSON.parse(win.localStorage.getItem(ORDER_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

/** Records the order; the sidebar is told only when it changed. */
export function setNavOrder(win: Window, pageIds: readonly string[]): void {
  if (JSON.stringify(navOrder(win)) === JSON.stringify(pageIds)) return;
  try { win.localStorage.setItem(ORDER_KEY, JSON.stringify(pageIds)); } catch { return; }
  win.dispatchEvent(new Event(NAV_HIDDEN_EVENT));
}

/** Sorts World pages by the recorded order. Pages it does not know yet go first, as new rows do in 我的 World. */
export function inNavOrder<T>(win: Window, pages: readonly T[], idOf: (page: T) => string): T[] {
  const rank = new Map(navOrder(win).map((id, index) => [id, index]));
  return pages.map((page, index) => ({ page, index, at: rank.get(idOf(page)) ?? -1 }))
    .sort((a, b) => a.at - b.at || a.index - b.index).map(({ page }) => page);
}

export function markReturn(win: Window, pageId: string): void {
  try { win.sessionStorage.setItem(RETURN_KEY, pageId); } catch { /* Storage may be unavailable. */ }
}

/** Whether `pageId` was just opened from the World list. The mark is used up: the next visit asks afresh. */
export function takeReturn(win: Window, pageId: string): boolean {
  try {
    const marked = win.sessionStorage.getItem(RETURN_KEY);
    win.sessionStorage.removeItem(RETURN_KEY);
    return marked === pageId;
  } catch { return false; }
}
