import { pick } from '../../core/language.ts';
import { S as zhHant } from './strings.zh-Hant.ts';
import { S as ja } from './strings.ja.ts';
import { S as ko } from './strings.ko.ts';
import { S as fr } from './strings.fr.ts';
import { S as de } from './strings.de.ts';
import { S as es419 } from './strings.es-419.ts';
import { S as ptBR } from './strings.pt-BR.ts';
import { S as it } from './strings.it.ts';
import { S as ru } from './strings.ru.ts';

const zh = {
  myWorlds: "我的 World",
  marketTab: "扩展市场",
  extensionList: "扩展列表",
  filterByName: "按名字筛选",
  allStates: "全部状态",
  noMatches: "没有符合筛选的扩展。",
  newGroup: "新建分组",
  groupDefaultName: "新分组",
  renameGroup: "重命名分组",
  deleteGroup: "删除分组（扩展保留）",
  pendingNote: "以上扩展需重启进程后生效。",
  packageInfo: "扩展信息",
  updateAvailable: (from: string, to: string) => `有更新：${from} → ${to}`,
  hideFromSidebar: "左栏隐藏",
  showInSidebar: "左栏显示",
  builtinAlwaysOn: "内置扩展始终开启。",
  modeOff: "已停用",
  modeRunning: "仅运行",
  modeAttached: "已接入",

  navLabel: 'World 扩展',
  introTitle: 'World 扩展',
  prefixReloadFailed: (msg: string) => `前缀重载失败: ${msg}`,
  toggleFailed: (msg: string) => `切换失败: ${msg}`,
  visibilityTitle: (name: string, visible: boolean) => visible ? `对 agent 显示「${name}」？` : `对 agent 隐藏「${name}」？`,
  visibilityBody: (visible: boolean): string => visible
    ? "显示后，Bot 可以使用这个 World 提供的工具和信息，并收到它发来的消息。更改会立即用于当前对话，聊天记录不受影响。"
    : "隐藏后，Bot 将看不到这个 World 提供的工具和信息，也不再收到它发来的消息；这个 World 本身仍会继续运行。更改会立即用于当前对话，聊天记录不受影响。",
  deactivateTitle: (name: string) => `停用「${name}」?`,
  deactivateBody: "停用后，该 World 会立即停止运行，它提供的工具和环境信息将不再提供给 Bot。",
  restartTitle: (name: string) => `重启「${name}」?`,
  restartBody: "停止并重建 World，应用标有「重启 World 生效」的配置。托管进程与连接会停止后重新启动。",
  missingReasonDefault: "无法加载这个 World。",
  activateWorld: '激活 World',
  inactiveNoteManual: (id: string) => `本地有实现但没装配。要启用,把 config.json 里 worlds.${id}.enabled 修改为 true 后重启。`,
  hideFromAgent: '对 agent 隐藏',
  showToAgent: '对 agent 显示',
  restartWorld: '重启 World',
  deactivateWorld: '停用 World',
  prefixPending: '前缀待重载',
  noWorlds: '没有任何 World',
  listLoadFailed: (msg: string) => `World 清单加载失败: ${msg}`,
  loading: '加载中…',
};

export const en: typeof zh = {
  myWorlds: "My Worlds",
  marketTab: "Extension market",
  extensionList: "Extensions",
  filterByName: "Filter by name",
  allStates: "All states",
  noMatches: "No extensions match the filter.",
  newGroup: "New group",
  groupDefaultName: "New group",
  renameGroup: "Rename group",
  deleteGroup: "Delete group (keeps extensions)",
  pendingNote: "The extensions above take effect after the process restarts.",
  packageInfo: "Extension info",
  updateAvailable: (from: string, to: string) => `Update available: ${from} → ${to}`,
  hideFromSidebar: "Hide from sidebar",
  showInSidebar: "Show in sidebar",
  builtinAlwaysOn: "Built-in Worlds are always on.",
  modeOff: "Stopped",
  modeRunning: "Running only",
  modeAttached: "Connected",

  navLabel: 'World extensions',
  introTitle: 'World extensions',
  prefixReloadFailed: (msg: string) => `Prefix reload failed: ${msg}`,
  toggleFailed: (msg: string) => `Toggle failed: ${msg}`,
  visibilityTitle: (name: string, visible: boolean) => visible ? `Show "${name}" to the agent?` : `Hide "${name}" from the agent?`,
  visibilityBody: (visible: boolean): string => visible
    ? "The bot will be able to use this World’s tools and information and receive its messages. The change applies to the current conversation right away; the chat history stays."
    : "The bot will no longer see this World’s tools and information or receive its messages; the World itself keeps running. The change applies to the current conversation right away; the chat history stays.",
  deactivateTitle: (name: string) => `Deactivate "${name}"?`,
  deactivateBody: "The World stops running immediately, and its tools and context are no longer available to the bot.",
  restartTitle: (name: string) => `Restart "${name}"?`,
  restartBody: "Stops and rebuilds the World to apply settings marked for World restart. Managed processes and connections stop and restart.",
  missingReasonDefault: "Could not load this World.",
  activateWorld: 'Activate World',
  inactiveNoteManual: (id: string) => `Implemented locally but not assembled. To enable it, set worlds.${id}.enabled to true in config.json and restart.`,
  hideFromAgent: 'Hide from agent',
  showToAgent: 'Show to agent',
  restartWorld: 'Restart World',
  deactivateWorld: 'Deactivate World',
  prefixPending: 'Prefix reload pending',
  noWorlds: 'No worlds',
  listLoadFailed: (msg: string) => `Failed to load World list: ${msg}`,
  loading: 'Loading…',
};

export const S = pick({
  zh, en, 'zh-Hant': zhHant, ja, ko, fr, de, 'es-419': es419, 'pt-BR': ptBR, it, ru,
});
