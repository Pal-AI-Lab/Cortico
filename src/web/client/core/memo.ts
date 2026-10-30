import type { WebUiMemo } from '../../shared/client-panel.ts';

/** Values kept in localStorage under `prefix`; without storage (private mode, full quota) they last this session. */
export function createMemo(prefix: string): WebUiMemo {
  const fallback = new Map<string, unknown>();
  return {
    get<T>(key: string, dflt: T): T {
      const k = prefix + key;
      // a value written this session wins: when localStorage refused it, only the map has it
      if (fallback.has(k)) return fallback.get(k) as T;
      try {
        const raw = localStorage.getItem(k);
        return raw === null ? dflt : (JSON.parse(raw) as T);
      } catch {
        return dflt;
      }
    },
    set(key: string, value: unknown): void {
      const k = prefix + key;
      fallback.set(k, value);
      try {
        localStorage.setItem(k, JSON.stringify(value));
      } catch { /* kept in memory for this session */ }
    },
  };
}
