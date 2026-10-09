/**
 * The console's language on the browser side. The server stamps its default on `<html lang>`;
 * a preference saved in this browser overrides it. Strings are selected at module load time,
 * so changing the preference reloads the page. Every request and every WebSocket handshake
 * carries the value back (`languageHeaders` / `withLanguage`), and the server renders its own
 * console text in it.
 */
import {
  isLanguage, languageOfLocale, languageTag, pick as pickFor, type Language, type LanguageTable,
} from '../../../core/language.ts';
import { CONSOLE_LANGUAGE_HEADER, CONSOLE_LANGUAGE_QUERY } from '../../shared/console-protocol.ts';

export type { Language };

const STORAGE_KEY = 'cortico.console.language';

export function saveLanguage(language: Language, storage: Pick<Storage, 'setItem'>): void {
  storage.setItem(STORAGE_KEY, language);
}

export function readLanguage(doc: Document): Language {
  let preference: string | null = null;
  try {
    preference = doc.defaultView?.localStorage.getItem(STORAGE_KEY) ?? null;
  } catch {
    // Storage may be unavailable in private browsing; retain the server default.
  }
  const language = isLanguage(preference) ? preference : languageOfLocale(doc.documentElement.lang) ?? 'zh';
  doc.documentElement.lang = languageTag(language);
  return language;
}

function readStamp(): Language {
  try {
    return readLanguage(document);
  } catch {
    return 'zh';
  }
}

export const LANGUAGE: Language = readStamp();

/** Select this page's language from a table declared as `zh`, `en: typeof zh` and optional translations. */
export function pick<T>(table: LanguageTable<T>): T {
  return pickFor(LANGUAGE, table);
}

/** The header every HTTP request carries. */
export function languageHeaders(): Record<string, string> {
  return { [CONSOLE_LANGUAGE_HEADER]: LANGUAGE };
}

/** A WebSocket path with the language attached as a query parameter (the handshake cannot carry headers). */
export function withLanguage(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${CONSOLE_LANGUAGE_QUERY}=${LANGUAGE}`;
}
