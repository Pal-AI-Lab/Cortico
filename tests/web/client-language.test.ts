/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLanguage, saveLanguage, withLanguage } from '../../src/web/client/core/language.ts';
import { LANGUAGES, languageTag } from '../../src/core/language.ts';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = 'en';
});
afterEach(() => vi.restoreAllMocks());

describe('console language preference', () => {
  it('uses the server stamp until a preference is saved', () => {
    expect(readLanguage(document)).toBe('en');
    document.documentElement.lang = 'zh-CN';
    expect(readLanguage(document)).toBe('zh');
    document.documentElement.lang = 'zh-Hant';
    expect(readLanguage(document)).toBe('zh-Hant');
    document.documentElement.lang = 'ja';
    expect(readLanguage(document)).toBe('ja');
  });

  it.each(LANGUAGES)('retains %s across a new page load', (language) => {
    saveLanguage(language, localStorage);
    document.documentElement.lang = language === 'en' ? 'zh-CN' : 'en';
    expect(readLanguage(document)).toBe(language);
    expect(document.documentElement.lang).toBe(languageTag(language));
  });

  it('ignores an invalid stored preference', () => {
    localStorage.setItem('cortico.console.language', 'xx');
    expect(readLanguage(document)).toBe('en');
  });

  it('uses the server default when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readLanguage(document)).toBe('en');
  });

  it('attaches the language to a WebSocket path as a query parameter', () => {
    expect(withLanguage('/ws/x')).toMatch(/^\/ws\/x\?language=(zh|en)$/);
    expect(withLanguage('/ws/x?a=1')).toMatch(/^\/ws\/x\?a=1&language=(zh|en)$/);
  });

  it('reports storage failure instead of silently losing the choice', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    expect(() => saveLanguage('zh', localStorage)).toThrow('full');
  });
});
