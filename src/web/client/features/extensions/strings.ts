import { pick } from '../../core/language.ts';

const zh = {
  navLabel: '扩展',
  navGroup: 'Core',
  introTitle: '扩展',
  introDesc: '从 npm 安装第三方 World、LLM Provider 和 bot 包。安装、卸载后需重启进程才能生效。',

  installedTitle: '已安装',
  refresh: '↻ 刷新',
  restartProcess: '重启进程',

  stateLoaded: '已加载',
  stateFailed: '加载失败',
  statePendingRestart: '待重启',
  stateRemoved: '已卸载,待重启',
  stateIdle: '已装,本部署未用',

  groupWorldDesc: '连接外部环境。',
  groupProviderDesc: '连接模型服务。',
  groupBotDesc: '提供 Persona 与 bot 装配。将包名填入 deployment.json 的 bot 字段；每个进程运行一个 bot。',
  groupUnknownTitle: '未识别',
  groupUnknownDesc: 'package.json 缺少有效的 cortico 声明。',

  restartConfirmTitle: '重启进程?',
  restartNoLoopTitle: '需要手动启动',
  restartConfirmBody: '进程将重启。',
  restartNoLoopBody: '进程将退出，需要手动重新启动。继续？',
  finishingToast: '正在关闭…',
  stepIncomplete: '未完成',
  doneRestartSupervised: '已退出，等待重新启动',
  doneRestart: '已退出',
  resultDefault: '关闭步骤已执行。',
  noReceipt: (msg: string) => `未收到关闭结果（${msg}）；进程可能已退出。`,

  uninstallTitle: (name: string) => `卸载「${name}」?`,
  uninstallBody: (name: string) => `从 extensions/ 卸载 ${name}，重启进程后生效。`,
  uninstalling: '正在卸载…',
  uninstalled: '已卸载',
  uninstallFailed: (msg: string) => `卸载失败: ${msg}`,
  uninstall: '卸载',

  installing: '正在安装…',
  installed: '已安装',
  installFailed: (msg: string) => `安装失败: ${msg}`,
  installedRestartTitle: '已安装,现在重启进程加载它?',
  installedRestartNote: '进程将重启。',
  installedNoLoopNote: '进程将退出，需要手动重新启动。',

  panelLoaded: '自定义面板已加载',
  noteIdle: '当前部署未引用此扩展。',
  noteConsoleMissing: '缺少浏览器构建产物。请在扩展目录构建，再重启进程。',

  sumLoaded: (n: number) => `已加载 ${n}`,
  sumPending: (n: number) => `待重启 ${n}`,
  sumFailed: (n: number) => `加载失败 ${n}`,
  noExtensions: '还没装任何扩展',
  listLoadFailed: (msg: string) => `扩展清单加载失败: ${msg}`,
  loading: '加载中…',

  searchTitle: '从 npm 安装',
  searchDesc: '扩展拥有与框架相同的文件和网络权限。',
  searchPlaceholder: '关键字;留空列出全部',
  search: '搜索',
  searchKeywordNote: (keyword: string) => `列出 npm 上带 ${keyword} 关键字的包。`,
  searching: '搜索中…',
  noHits: '没有匹配的包',
  hitCount: (n: number) => `${n} 个包`,
  searchFailed: (msg: string) => `搜索失败: ${msg}`,
  hitMeta: (version: string, downloads: number, publisher?: string) =>
    `${version} · 月下载 ${downloads}${publisher ? ` · ${publisher}` : ''}`,
  linkRepo: '仓库',
  linkHome: '主页',
  install: '安装',
  alreadyInstalled: '已安装',

  manualTitle: '手动安装',
  manualDesc: '包名（可带 @版本）或含 package.json 的本机目录。本机目录通过链接安装。',
  manualPlaceholder: '@scope/name@1.2.0 或 ../my-module',
  manualEmpty: '先填包名或目录',
};

const en: typeof zh = {
  navLabel: 'Extensions',
  navGroup: 'Core',
  introTitle: 'Extensions',
  introDesc: 'Install third-party Worlds, LLM providers and bot packages from npm. '
    + 'Installations and removals take effect after restarting the process.',

  installedTitle: 'Installed',
  refresh: '↻ Refresh',
  restartProcess: 'Restart process',

  stateLoaded: 'Loaded',
  stateFailed: 'Load failed',
  statePendingRestart: 'Restart pending',
  stateRemoved: 'Uninstalled, restart pending',
  stateIdle: 'Installed, unused by this deployment',

  groupWorldDesc: 'Connects to an external environment.',
  groupProviderDesc: 'Connects to a model service.',
  groupBotDesc: 'Provides a Persona and bot assembly. Set the package name in the bot field of deployment.json; each process runs one bot.',
  groupUnknownTitle: 'Unrecognised',
  groupUnknownDesc: 'package.json has no valid cortico declaration.',

  restartConfirmTitle: 'Restart the process?',
  restartNoLoopTitle: 'Manual startup required',
  restartConfirmBody: 'The process will restart.',
  restartNoLoopBody: 'The process will exit and must be restarted manually. Continue?',
  finishingToast: 'Shutting down…',
  stepIncomplete: 'incomplete',
  doneRestartSupervised: 'Exited; waiting to restart',
  doneRestart: 'Exited',
  resultDefault: 'Shutdown steps executed.',
  noReceipt: (msg: string) => `No shutdown result received (${msg}); the process may have exited.`,

  uninstallTitle: (name: string) => `Uninstall "${name}"?`,
  uninstallBody: (name: string) => `Uninstall ${name} from extensions/. Takes effect after restarting the process.`,
  uninstalling: 'Uninstalling…',
  uninstalled: 'Uninstalled',
  uninstallFailed: (msg: string) => `Uninstall failed: ${msg}`,
  uninstall: 'Uninstall',

  installing: 'Installing…',
  installed: 'Installed',
  installFailed: (msg: string) => `Install failed: ${msg}`,
  installedRestartTitle: 'Installed. Restart the process now to load it?',
  installedRestartNote: 'The process will restart.',
  installedNoLoopNote: 'The process will exit and must be restarted manually.',

  panelLoaded: 'Custom panel loaded',
  noteIdle: 'This deployment does not reference the extension.',
  noteConsoleMissing: 'Browser bundle missing. Build in the extension directory and restart the process.',

  sumLoaded: (n: number) => `${n} loaded`,
  sumPending: (n: number) => `${n} restart pending`,
  sumFailed: (n: number) => `${n} failed`,
  noExtensions: 'No extensions installed yet',
  listLoadFailed: (msg: string) => `Extension list failed to load: ${msg}`,
  loading: 'Loading…',

  searchTitle: 'Install from npm',
  searchDesc: 'Extensions have the same file and network access as the framework.',
  searchPlaceholder: 'Keyword; empty lists everything',
  search: 'Search',
  searchKeywordNote: (keyword: string) => `Lists npm packages carrying the ${keyword} keyword.`,
  searching: 'Searching…',
  noHits: 'No matching packages',
  hitCount: (n: number) => `${n} packages`,
  searchFailed: (msg: string) => `Search failed: ${msg}`,
  hitMeta: (version: string, downloads: number, publisher?: string) =>
    `${version} · ${downloads}/month${publisher ? ` · ${publisher}` : ''}`,
  linkRepo: 'Repository',
  linkHome: 'Homepage',
  install: 'Install',
  alreadyInstalled: 'Installed',

  manualTitle: 'Manual install',
  manualDesc: 'A package name (optionally @version) or a local directory containing package.json. Local directories are installed as links.',
  manualPlaceholder: '@scope/name@1.2.0 or ../my-module',
  manualEmpty: 'Fill in a package name or directory first',
};

export const S = pick({ zh, en });
