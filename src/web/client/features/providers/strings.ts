import { pick } from '../../core/language.ts';

const zh = {
  pageTitle: '语言模型',
  modulesAria: '供应模块',
  needHost: "语言模型设置不可用。",
  loading: '读取供应模块…',
  none: '没有已注册的供应模块。',
  navLabel: '语言模型',
  navGroup: 'Core',
};

const en: typeof zh = {
  pageTitle: 'LLM',
  modulesAria: 'Provider modules',
  needHost: "LLM settings unavailable.",
  loading: 'Loading provider modules…',
  none: 'No provider modules registered.',
  navLabel: 'LLM',
  navGroup: 'Core',
};

export const S = pick({ zh, en });
