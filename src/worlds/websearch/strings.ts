import { pick, type Language } from '../../core/language.ts';

/** 给操作员看的文案。 */
const zh = {
  // ── 配置组 ─────────────────────────────────────────────────────────
  configTitle: 'WebSearch · 检索偏好',
  configDescription: 'Brave Search 的地区与语言;改完重启生效(客户端构造时固定)。',
  countryTitle: '结果地区',
  countryDescription: 'ISO 两位国家码,如 CN / US。',
  searchLangTitle: '搜索语言',
  searchLangDescription: '如 zh-hans。',
  uiLangTitle: '响应语言',
  uiLangDescription: '如 zh-CN。',
  safesearchTitle: '安全搜索',
  safesearchDescription: '过滤强度。',
  timeoutTitle: '请求超时',
  timeoutDescription: '单次搜索请求的超时。',
  // ── WebUI 露出 ─────────────────────────────────────────────────────
  moduleLabel: 'WebSearch',
  key: '密钥',
  keySet: '已配置',
  keyUnset: '未配置',
  keyUnsetBadge: '未配置(工具仍在,调用会提示)',
  promptDocTitle: 'WebSearch · 环境提示词',
  promptDocDescription: '搜索工具 World 的可选常驻环境;留空时不进入系统前缀。',
};

export const en: typeof zh = {
  configTitle: 'WebSearch · Search preferences',
  configDescription: 'Brave Search region and language. Changes take effect after a restart (fixed when the client is created).',
  countryTitle: 'Result region',
  countryDescription: 'Two-letter ISO country code, e.g. CN / US.',
  searchLangTitle: 'Search language',
  searchLangDescription: 'e.g. zh-hans.',
  uiLangTitle: 'Response language',
  uiLangDescription: 'e.g. zh-CN.',
  safesearchTitle: 'Safe search',
  safesearchDescription: 'Filter strength.',
  timeoutTitle: 'Request timeout',
  timeoutDescription: 'Timeout for one search request.',
  moduleLabel: 'WebSearch',
  key: 'API key',
  keySet: 'Set',
  keyUnset: 'Not set',
  keyUnsetBadge: 'Not set (the tool stays available and reports this when called)',
  promptDocTitle: 'WebSearch · Environment prompt',
  promptDocDescription: 'Optional standing environment for the search World. Left empty, it stays out of the system prefix.',
};

export const text = (language: Language) => pick(language, { zh, en });
