import { pick } from '../../core/language.ts';

const zh = {
  pageTitle: '模型提供商',
  modulesAria: '供应模块',
  needHost: "模型提供商设置不可用。",
  loading: '读取供应模块…',
  none: '没有已注册的供应模块。',
  navLabel: '模型提供商',
  navGroup: 'Core',
};

const en: typeof zh = {
  pageTitle: 'LLM Provider',
  modulesAria: 'Provider modules',
  needHost: "LLM provider settings unavailable.",
  loading: 'Loading provider modules…',
  none: 'No provider modules registered.',
  navLabel: 'LLM Provider',
  navGroup: 'Core',
};

export const S = pick({ zh, en });
