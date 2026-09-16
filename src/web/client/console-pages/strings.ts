import { pick } from '../core/language.ts';

const zh = {
  protocolMismatch: (server: string, page: string) =>
    `控制台协议版本不一致：服务端 ${server}，页面 ${page}。请强制刷新页面。`,
  pageFailed: (pageId: string) => `页面「${pageId}」打开失败`,
  noPage: (pageId: string) => `控制台页面不存在：「${pageId}」`,
  noPageHint: '请检查页面地址及模块激活状态。',
  noPanels: (label: string) => `「${label}」没有声明任何面板。`,
  noSuchPanel: (label: string, wanted: string) => `「${label}」没有面板「${wanted}」`,
  provides: (list: string) => '可用面板：' + list,
  panelFailed: (title: string) => `面板「${title}」加载失败`,
  configEmpty: '配置组不可用。',
  configTitle: '配置',
  configDesc: '修改自动保存到 config.json。标注需重启的配置在重启后生效，其余立即生效。',
  assembly: '装配',
  notInstalled: "不可用",
  notActivated: '未激活',
  hidden: '已隐藏',
  reloadPrefix: '前缀待重载 · 点此重载',
  open: '打开',
  configTab: '配置',
  promptsTab: '提示词模板',
  storageTab: '数据',
  toolsTab: '工具表',
  storageTitle: '数据',
  storageDesc: '本页声明的存储项;清除范围与结果由各项的实现决定。',
  reloadTitle: '重载 system 前缀？',
  reloadBody: '重读全部前缀源并替换当前 session 的系统前缀，保留已有对话。',
  prefixReloaded: '前缀已重载',
  noBundle: (pageId: string) =>
    `「${pageId}」缺少面板构建产物。仓内页面请先停止 bot，再运行 pnpm build:web；`
    + 'extensions/ 下的扩展请在包目录构建，再重启进程。',
  badBundleUrl: (pageId: string) => `「${pageId}」的面板产物地址不合法，已拒绝加载`,
  bundleLoadFailed: (pageId: string, err: string) => `「${pageId}」的面板产物加载失败: ${err}`,
  badDefaultExport: (pageId: string) => `「${pageId}」的面板产物缺少有效的 default 导出，格式应为 { panels: { … } }`,
  none: '(无)',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `「${pageId}」的面板产物中没有「${panelId}」。可用面板：${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `「${pageId}」的面板「${panelId}」缺少 mount 方法`,
  noBuiltinPanel: (name: string, known: string) =>
    `内置面板「${name}」不存在。可用面板：${known}`,
};

const en: typeof zh = {
  protocolMismatch: (server: string, page: string) =>
    `Console protocol version mismatch: server ${server}, this page ${page}.`
    + ' Force a page refresh.',
  pageFailed: (pageId: string) => `Could not open "${pageId}"`,
  noPage: (pageId: string) => `Console page not found: "${pageId}"`,
  noPageHint: 'Check the page address and module activation status.',
  noPanels: (label: string) => `"${label}" declares no panels.`,
  noSuchPanel: (label: string, wanted: string) => `"${label}" has no panel "${wanted}"`,
  provides: (list: string) => 'Available panels: ' + list,
  panelFailed: (title: string) => `Panel "${title}" failed to load`,
  configEmpty: 'Configuration groups unavailable.',
  configTitle: 'Config',
  configDesc: 'Changes are saved to config.json automatically. Settings marked as requiring a restart apply after restarting; the rest apply immediately.',
  assembly: 'Assembly',
  notInstalled: "Unavailable",
  notActivated: 'not activated',
  hidden: 'hidden',
  reloadPrefix: 'Prefix drifted · click to reload',
  open: 'Open',
  configTab: 'Config',
  promptsTab: 'Prompt templates',
  storageTab: 'Data',
  toolsTab: 'Tools',
  storageTitle: 'Data',
  storageDesc: 'Storage items declared by this page; what a clear covers and returns is up to each item.',
  reloadTitle: 'Reload the system prefix?',
  reloadBody: 'Re-reads all prefix sources and replaces the current session\'s system prefix. Existing conversation messages are kept.',
  prefixReloaded: 'Prefix reloaded',
  noBundle: (pageId: string) =>
    `Panel bundle missing for "${pageId}". For repository pages, stop the bot first, then run pnpm build:web;`
    + ' for packages under extensions/, build in the package directory and restart the process.',
  badBundleUrl: (pageId: string) => `Panel bundle URL of "${pageId}" is invalid; refused to load`,
  bundleLoadFailed: (pageId: string, err: string) => `Panel bundle of "${pageId}" failed to load: ${err}`,
  badDefaultExport: (pageId: string) => `Panel bundle of "${pageId}" has no valid default export; expected { panels: { … } }`,
  none: '(none)',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `Panel bundle of "${pageId}" has no panel "${panelId}". Available panels: ${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `Panel "${panelId}" of "${pageId}" is missing the mount method`,
  noBuiltinPanel: (name: string, known: string) =>
    `Built-in panel "${name}" not found. Available panels: ${known}`,
};

export const S = pick({ zh, en });
