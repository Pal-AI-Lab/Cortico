import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: '執行診斷',
  navGroup: 'Core',
  pageTitle: '執行診斷',
  subRun: '執行',
  subRunlog: '執行日誌',
  subData: '資料清理',
  perPage: '每頁顯示',
  prevPage: '‹ 上一頁',
  nextPage: '下一頁 ›',
  shown: (from: number, to: number, total: number, more: boolean) => `顯示 ${from}–${to}，共 ${total}${more ? '+' : ''} 條`,
  pageOf: (page: number, pages: number, more: boolean) => `${page} / ${pages}${more ? '+' : ''}`,
  sectionSessions: '會話',
  sectionEvents: '事件',
  chipDelivered: '投遞 ',
  chipRoundsPre: '本批 ',
  chipRoundsPost: ' 輪',
  subConfig: '設定',
  configEmpty: 'Core 沒有可調設定。',
  netOffline: '介面無法連線',

  // events.ts
  eventsDesc: '事件記錄，agent 可查詢。',
  allSources: '全部來源',
  sourceTitle: '依來源篩選。候選項目取自已載入的事件。',
  showArchive: '顯示原始封存',
  showArchiveTitle: '包括僅封存、未直接投遞到上下文的事件',
  evHeadTime: '時間',
  evHeadSource: '來源',
  evHeadType: '類型',
  evHeadText: '正文',
  noEvents: '暫無事件',

  // runlog.ts
  currentRun: '目前 run',
  allLevels: '全部層級',
  areaPlaceholder: '區域前綴,如 worlds.minecraft', // arch-allow: 日志区域筛选框的示例前缀,只是示意文字
  grepPlaceholder: '正規表示式,比對內容與 data',
  roundPlaceholder: '輪次',
  refresh: '重新整理',
  logHeadTime: '時間',
  logHeadLevel: '層級',
  logHeadArea: '區域',
  logHeadMsg: '內容',
  noLog: '暫無日誌',
  copyEntry: '複製這一條',

  // sessions.ts
  sessionsDesc: '本次處理程序內各 session 的 token 用量與快取命中，重新啟動後從零計數；已結束的臨時 session 只保留最近 8 個。跨重新啟動的統計見「用量與成本」。',
  sesHeadStatus: '狀態',
  sesHeadCalls: '呼叫',
  sesHeadInput: '輸入 tok',
  sesHeadCache: '快取命中',
  sesHeadOutput: '輸出 tok',
  sesHeadMsgs: '訊息',
  noSessions: '暫無 session',
  running: '未結束',
  ended: '已結束',
};
