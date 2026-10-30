/**
 * Two small bits of state the World list shares with the window shell:
 * - which active Worlds the sidebar leaves out (localStorage, kept across restarts), and
 * - which World page was opened from the list (sessionStorage), so that visit's header offers a way back.
 */
const HIDDEN_KEY = 'cortico.world-nav-hidden.v1';
const RETURN_KEY = 'cortico.world-return';
/** Fired on the window when the hidden set changes. */
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
