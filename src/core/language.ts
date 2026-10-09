/**
 * Console text uses the language supplied with each browser request.
 * The initial default uses a recognized config.language, then CORTICO_LANGUAGE,
 * then the system locale mapped by languageOfLocale; an unavailable locale falls back to zh.
 * The environment/locale result is cached once.
 * The browser can override the initial <html lang> value and sends its choice in the
 * console language header or query parameter. Panels receive ConsolePanelContext.language.
 * Owners render request text in that language through pick.
 * This setting does not select or translate model-facing text.
 */
export type Language = 'zh' | 'zh-Hant' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es-419' | 'pt-BR' | 'it' | 'ru';

/** Picker order. `zh` is Simplified Chinese. */
export const LANGUAGES: readonly Language[] = ['zh', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es-419', 'pt-BR', 'it', 'ru'];

/** Each language's name written in that language. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  zh: '简体中文',
  'zh-Hant': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  'es-419': 'Español (Latinoamérica)',
  'pt-BR': 'Português (Brasil)',
  it: 'Italiano',
  ru: 'Русский',
};

/** The languages every string table carries. */
export type BaseLanguage = 'zh' | 'en';

/** Languages a string table may omit or translate in part. */
export type OptionalLanguage = Exclude<Language, BaseLanguage>;

export function isLanguage(value: unknown): value is Language {
  return (LANGUAGES as readonly unknown[]).includes(value);
}

/** The table a missing translation is read from: zh-Hant falls back to zh, every other language to en. */
export function baseLanguage(language: Language): BaseLanguage {
  return language === 'zh' || language === 'zh-Hant' ? 'zh' : 'en';
}

/** BCP 47 tag for `<html lang>`; zh is written zh-CN. */
export function languageTag(language: Language): string {
  return language === 'zh' ? 'zh-CN' : language;
}

/**
 * BCP 47 / POSIX tag → language, case-insensitive, `-` or `_` between subtags. Traditional
 * Chinese is zh-Hant or a TW / HK / MO region; any es is es-419, any pt is pt-BR; any other
 * nonempty tag is en. Empty input is "unknown", not English.
 */
export function languageOfLocale(tag: string | null | undefined): Language | undefined {
  const t = (tag ?? '').trim().toLowerCase().replace(/[.@].*$/, '');
  if (!t) return undefined;
  const [primary, second] = t.split(/[-_]/);
  switch (primary) {
    case 'zh': return second === 'hant' || second === 'tw' || second === 'hk' || second === 'mo' ? 'zh-Hant' : 'zh';
    case 'es': return 'es-419';
    case 'pt': return 'pt-BR';
    case 'ja': case 'ko': case 'fr': case 'de': case 'it': case 'ru': return primary;
    default: return 'en';
  }
}

/** Pure form of the system read, for tests. */
export function detectLanguage(
  env: Record<string, string | undefined>,
  locale: string | null | undefined,
): Language {
  const forced = env.CORTICO_LANGUAGE;
  if (isLanguage(forced)) return forced;
  return languageOfLocale(locale) ?? 'zh';
}

let systemMemo: Language | undefined;

/** The environment/locale read, performed once and then fixed for the process lifetime. */
export function systemLanguage(): Language {
  if (systemMemo === undefined) {
    // `process` is reached through globalThis so this file also type-checks under the DOM lib.
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    let locale: string | undefined;
    try {
      locale = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      locale = undefined;
    }
    systemMemo = detectLanguage(env, locale);
  }
  return systemMemo;
}

/** A configured value wins over the system read; anything unrecognised is ignored. */
export function resolveLanguage(configured: unknown): Language {
  return isLanguage(configured) ? configured : systemLanguage();
}

/**
 * An optional language's entry. A plain-object value may leave out top-level keys, which then
 * come from the base language; objects nested inside it are given whole, as are other values.
 */
export type Translation<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly unknown[] ? T
  : T extends object ? Partial<T>
  : T;

/** One value per language: zh and en are required, every other language is optional. */
export type LanguageTable<T> =
  & { readonly [L in BaseLanguage]: T }
  & { readonly [L in OptionalLanguage]?: Translation<NoInfer<T>> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Select a language's value. A language the table lacks reads its base language
 * (`baseLanguage`); a partial plain-object entry is completed from the base language's
 * object, top-level keys only.
 */
export function pick<T>(language: Language, table: LanguageTable<T>): T {
  const base = table[baseLanguage(language)];
  if (language === 'zh' || language === 'en') return base;
  const own: unknown = table[language];
  if (own === undefined) return base;
  if (!isPlainObject(own) || !isPlainObject(base)) return own as T;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(own)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as T;
}
