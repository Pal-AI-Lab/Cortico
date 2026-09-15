import { pick } from '../../core/language.ts';

const zh = {
  navGroup: '系统',
  general: '通用',
  generalDesc: '控制台语言偏好。',
  language: '界面语言 / Language',
  languageDesc: '仅保存在当前浏览器，刷新页面后生效。',
  reloadTitle: '切换界面语言？',
  reloadBody: '页面将刷新，未保存的编辑会丢失。Bot 将继续运行。',
  appearance: '外观',
  appearanceDesc: '控制台主题、明暗模式与自定义配色。',
  runtime: '运行参数',
  runtimeDesc: 'Core 运行参数。',
  storage: '存储',
  storageDesc: '存储用量与清理。',
  pageTitle: '设置',
  sectionsAria: '设置分区',
  navLabel: '设置',
};

const en: typeof zh = {
  navGroup: 'System',
  general: 'General',
  generalDesc: 'Console language preferences.',
  language: '界面语言 / Language',
  languageDesc: 'Saved in this browser; takes effect after reloading.',
  reloadTitle: 'Change interface language?',
  reloadBody: 'The page will reload and unsaved edits will be lost. The bot will keep running.',
  appearance: 'Appearance',
  appearanceDesc: 'Console theme, light/dark mode and custom palettes.',
  runtime: 'Runtime parameters',
  runtimeDesc: 'Core runtime parameters.',
  storage: 'Storage',
  storageDesc: 'Storage usage and cleanup.',
  pageTitle: 'Settings',
  sectionsAria: 'Settings sections',
  navLabel: 'Settings',
};

export const S = pick({ zh, en });
