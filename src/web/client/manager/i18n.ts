import { LANGUAGE } from '../core/language.ts';
import { languageTag } from '../../../core/language.ts';
import { translationLanguages, translations } from './locales.ts';
export const locale = languageTag(LANGUAGE);
export function translate(language: string, key: string, ...values: unknown[]): string {
    const index = translationLanguages.indexOf(language as typeof translationLanguages[number]);
    const text = index < 0 ? key : translations[key]?.[index] ?? key;
    return text.replace(/\{(\d+)\}/g, (match, i) => i < values.length ? String(values[i]) : match);
}
export function t(key: string, ...values: unknown[]): string { return translate(LANGUAGE, key, ...values); }
