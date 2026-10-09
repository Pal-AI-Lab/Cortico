/**
 * 控制台默认语言依次读取 config.language、进程环境和系统 locale。
 * locale 按 languageOfLocale 归到受支持的语言，缺失时用中文；请求可另行选择语言。
 */
import { describe, it, expect } from 'vitest';
import {
  LANGUAGES, baseLanguage, detectLanguage, languageOfLocale, languageTag, pick, resolveLanguage, systemLanguage,
  type Language,
} from '../../src/core/language.ts';
import { coreConfigGroup, CORE_CONFIG_GROUP } from '../../src/core/config.ts';
import { coerceGroupValues } from '../../src/core/config-schema.ts';

describe('languageOfLocale', () => {
  it('系统区域与浏览器标签按表归到受支持的语言,不支持的归 en,空值算未知;每种语言的代码与 <html lang> 标签读回它自己', () => {
    const table: Record<string, Language> = {
      zh: 'zh', 'zh-CN': 'zh', ZH_cn: 'zh', ' zh-SG ': 'zh', 'zh-Hans-HK': 'zh', 'zh_CN.UTF-8': 'zh',
      'zh-TW': 'zh-Hant', 'zh-HK': 'zh-Hant', zh_MO: 'zh-Hant', 'zh-Hant': 'zh-Hant', 'zh-Hant-TW': 'zh-Hant',
      'zh_TW.UTF-8': 'zh-Hant',
      'en-US': 'en', 'ja-JP': 'ja', ko_KR: 'ko', 'fr-CA': 'fr', 'de-DE': 'de', 'it-IT': 'it', 'ru-RU': 'ru',
      es: 'es-419', 'es-ES': 'es-419', 'es-MX': 'es-419', pt: 'pt-BR', 'pt-PT': 'pt-BR', pt_br: 'pt-BR',
      'nl-NL': 'en', C: 'en',
    };
    for (const [tag, language] of Object.entries(table)) expect(languageOfLocale(tag), tag).toBe(language);
    expect(languageOfLocale('')).toBeUndefined();
    expect(languageOfLocale(undefined)).toBeUndefined();
    for (const language of LANGUAGES) {
      expect(languageOfLocale(language)).toBe(language);
      expect(languageOfLocale(languageTag(language))).toBe(language);
    }
  });
});

describe('detectLanguage / resolveLanguage', () => {
  it('环境变量压过系统区域;不认识的值当没设', () => {
    expect(detectLanguage({ CORTICO_LANGUAGE: 'en' }, 'zh-CN')).toBe('en');
    expect(detectLanguage({ CORTICO_LANGUAGE: 'zh' }, 'en-US')).toBe('zh');
    expect(detectLanguage({ CORTICO_LANGUAGE: 'fr' }, 'en-US')).toBe('fr');
    expect(detectLanguage({ CORTICO_LANGUAGE: 'fr-FR' }, 'en-US')).toBe('en');
    expect(detectLanguage({}, 'zh-CN')).toBe('zh');
    expect(detectLanguage({}, 'en-US')).toBe('en');
  });

  it('区域读不到时保持中文', () => {
    expect(detectLanguage({}, undefined)).toBe('zh');
    expect(detectLanguage({}, '')).toBe('zh');
  });

  it('配置值赢过系统读数;非法配置值忽略', () => {
    expect(resolveLanguage('zh')).toBe('zh');
    expect(resolveLanguage('en')).toBe('en');
    expect(resolveLanguage('auto')).toBe(systemLanguage());
    expect(resolveLanguage(undefined)).toBe(systemLanguage());
  });

  it('系统读数进程内只读一次', () => {
    expect(systemLanguage()).toBe(systemLanguage());
  });
});

describe('pick 与串表', () => {
  it('按语言取表', () => {
    const table = { zh: { a: '甲' }, en: { a: 'A' } };
    expect(pick('zh', table).a).toBe('甲');
    expect(pick('en', table).a).toBe('A');
  });

  it('表里没有的语言读回退表(繁体读中文,其余读英文);部分译文按顶层键补齐,非对象值整值替换', () => {
    const zh = { a: '甲', b: '乙', nested: { x: '子' } };
    const en: typeof zh = { a: 'A', b: 'B', nested: { x: 'X' } };
    for (const language of LANGUAGES) {
      expect(pick(language, { zh, en }), language).toBe(baseLanguage(language) === 'zh' ? zh : en);
    }
    expect(pick('zh-Hant', { zh, en })).toBe(zh);
    expect(pick('ja', { zh, en })).toBe(en);
    const ja: Partial<typeof en> = { a: 'ア' };
    const hant: Partial<typeof zh> = { b: '乙(繁)', nested: { x: '子(繁)' } };
    expect(pick('ja', { zh, en, ja })).toEqual({ a: 'ア', b: 'B', nested: { x: 'X' } });
    expect(pick('zh-Hant', { zh, en, 'zh-Hant': hant })).toEqual({ a: '甲', b: '乙(繁)', nested: { x: '子(繁)' } });
    expect(pick('ja', { zh: '中', en: 'E', ja: 'J' })).toBe('J');
    expect(pick('ko', { zh: '中', en: 'E', ja: 'J' })).toBe('E');
  });

  it('core 配置组两种语言结构一致,只有文案不同', () => {
    const zh = coreConfigGroup('zh');
    const en = coreConfigGroup('en');
    expect(zh).toEqual(CORE_CONFIG_GROUP);
    expect(Object.keys(en.schema.properties)).toEqual(Object.keys(zh.schema.properties));
    for (const key of Object.keys(zh.schema.properties)) {
      const { title: _t1, description: _d1, 'x-suffix': _s1, ...zhRest } = zh.schema.properties[key];
      const { title: _t2, description: _d2, 'x-suffix': _s2, ...enRest } = en.schema.properties[key];
      expect(enRest).toEqual(zhRest);
      expect(en.schema.properties[key].title).not.toBe(zh.schema.properties[key].title);
    }
  });

  it('校验回执按语言措辞,缺省中文', () => {
    const group = coreConfigGroup('en');
    expect(coerceGroupValues(group, { 'batching.maxBatchSize': 0 }, 'en'))
      .toEqual({ error: 'Batch size limit cannot be less than 1' });
    expect(coerceGroupValues(coreConfigGroup('zh'), { 'batching.maxBatchSize': 0 }))
      .toEqual({ error: '单批上限 不能小于 1' });
  });
});
