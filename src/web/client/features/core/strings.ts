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
  // index.ts
  navLabel: '运行诊断',
  navGroup: 'Core',
  pageTitle: '运行诊断',
  subRun: '运行',
  subRunlog: '运行日志',
  subData: '数据清理',
  perPage: '每页显示',
  prevPage: '‹ 上一页',
  nextPage: '下一页 ›',
  shown: (from: number, to: number, total: number, more: boolean) => `显示 ${from}–${to}，共 ${total}${more ? '+' : ''} 条`,
  pageOf: (page: number, pages: number, more: boolean) => `${page} / ${pages}${more ? '+' : ''}`,
  sectionSessions: '会话',
  sectionEvents: '事件',
  chipDelivered: '投递 ',
  chipRoundsPre: '本批 ',
  chipRoundsPost: ' 轮',
  subConfig: '配置',
  configEmpty: 'Core 没有可调配置。',
  netOffline: '接口不可达',

  // events.ts
  eventsDesc: '事件记录，agent 可查询。',
  allSources: '全部来源',
  sourceTitle: '按来源过滤。候选项取自已加载的事件。',
  showArchive: '显示原始归档',
  showArchiveTitle: '包括仅归档、未直接投递到上下文的事件',
  evHeadTime: '时间',
  evHeadSource: '来源',
  evHeadType: '类型',
  evHeadText: '正文',
  noEvents: '暂无事件',

  // runlog.ts
  currentRun: '当前 run',
  allLevels: '全部级别',
  areaPlaceholder: '区域前缀,如 worlds.minecraft', // arch-allow: 日志区域筛选框的示例前缀,只是示意文字
  grepPlaceholder: '正则,匹配内容与 data',
  roundPlaceholder: '轮次',
  refresh: '刷新',
  logHeadTime: '时间',
  logHeadLevel: '级别',
  logHeadArea: '区域',
  logHeadMsg: '内容',
  noLog: '暂无日志',
  copyEntry: '复制这一条',

  // sessions.ts
  sessionsDesc: '本次进程内各 session 的 token 用量与缓存命中，重启后从零计数；已结束的临时 session 只保留最近 8 个。跨重启的统计见「用量与成本」。',
  sesHeadStatus: '状态',
  sesHeadCalls: '调用',
  sesHeadInput: '输入 tok',
  sesHeadCache: '缓存命中',
  sesHeadOutput: '输出 tok',
  sesHeadMsgs: '消息',
  noSessions: '暂无 session',
  running: '未结束',
  ended: '已结束',
};

export const en: typeof zh = {
  // index.ts
  navLabel: 'Diagnostics',
  navGroup: 'Core',
  pageTitle: 'Diagnostics',
  subRun: 'Run',
  subRunlog: 'Run log',
  subData: 'Clear data',
  perPage: 'Per page',
  prevPage: '‹ Previous',
  nextPage: 'Next ›',
  shown: (from: number, to: number, total: number, more: boolean) => `Showing ${from}–${to} of ${total}${more ? '+' : ''}`,
  pageOf: (page: number, pages: number, more: boolean) => `${page} / ${pages}${more ? '+' : ''}`,
  sectionSessions: 'Sessions',
  sectionEvents: 'Events',
  chipDelivered: 'delivered ',
  chipRoundsPre: 'this batch ',
  chipRoundsPost: ' rounds',
  subConfig: 'Config',
  configEmpty: 'Core has no tunable settings.',
  netOffline: 'API unreachable',

  // events.ts
  eventsDesc: 'Event records, queryable by the agent.',
  allSources: 'All sources',
  sourceTitle: 'Filter by source. The choices come from loaded events.',
  showArchive: 'Show raw archive',
  showArchiveTitle: 'Include archived events that are not delivered directly to the context',
  evHeadTime: 'Time',
  evHeadSource: 'Source',
  evHeadType: 'Type',
  evHeadText: 'Text',
  noEvents: 'No events yet',

  // runlog.ts
  currentRun: 'Current run',
  allLevels: 'All levels',
  areaPlaceholder: 'Area prefix, e.g. worlds.minecraft', // arch-allow: 日志区域筛选框的示例前缀,只是示意文字
  grepPlaceholder: 'Regex, matches message and data',
  roundPlaceholder: 'Round',
  refresh: 'Refresh',
  logHeadTime: 'Time',
  logHeadLevel: 'Level',
  logHeadArea: 'Area',
  logHeadMsg: 'Message',
  noLog: 'No log entries',
  copyEntry: 'Copy entry',

  // sessions.ts
  sessionsDesc: 'Token usage and cache hits for each session in this process. Counts restart from zero on restart, and only the 8 most recent ended temporary sessions are kept. For history across restarts, see "Usage & cost".',
  sesHeadStatus: 'Status',
  sesHeadCalls: 'Calls',
  sesHeadInput: 'Input tok',
  sesHeadCache: 'Cache hit',
  sesHeadOutput: 'Output tok',
  sesHeadMsgs: 'Messages',
  noSessions: 'No sessions yet',
  running: 'not ended',
  ended: 'ended',
};

export const S = pick({
  zh, en, 'zh-Hant': zhHant, ja, ko, fr, de, 'es-419': es419, 'pt-BR': ptBR, it, ru,
});
