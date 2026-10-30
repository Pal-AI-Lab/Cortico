import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: '実行診断',
  navGroup: 'Core',
  pageTitle: '実行診断',
  subRun: '実行',
  subRunlog: '実行ログ',
  subData: 'データの消去',
  perPage: '1 ページの表示数',
  prevPage: '‹ 前へ',
  nextPage: '次へ ›',
  shown: (from: number, to: number, total: number, more: boolean) => `${total}${more ? '+' : ''} 件中 ${from}–${to} 件を表示`,
  pageOf: (page: number, pages: number, more: boolean) => `${page} / ${pages}${more ? '+' : ''}`,
  sectionSessions: 'セッション',
  sectionEvents: 'イベント',
  chipDelivered: '配信 ',
  chipRoundsPre: '今回のバッチ ',
  chipRoundsPost: ' ラウンド',
  subConfig: '設定',
  configEmpty: 'Core に調整できる設定はありません。',
  netOffline: 'API に接続できません',

  // events.ts
  eventsDesc: 'イベントの記録です。エージェントが検索できます。',
  allSources: 'すべてのソース',
  sourceTitle: 'ソースで絞り込みます。候補は読み込み済みのイベントから取得します。',
  showArchive: '生のアーカイブを表示',
  showArchiveTitle: 'アーカイブのみで、コンテキストに直接配信されていないイベントも含める',
  evHeadTime: '時刻',
  evHeadSource: 'ソース',
  evHeadType: '種類',
  evHeadText: '本文',
  noEvents: 'イベントはまだありません',

  // runlog.ts
  currentRun: '現在の実行',
  allLevels: 'すべてのレベル',
  areaPlaceholder: '領域のプレフィックス（例：worlds.minecraft）', // arch-allow: 日志区域筛选框的示例前缀,只是示意文字
  grepPlaceholder: '正規表現。メッセージと data に一致',
  roundPlaceholder: 'ラウンド',
  refresh: '更新',
  logHeadTime: '時刻',
  logHeadLevel: 'レベル',
  logHeadArea: '領域',
  logHeadMsg: 'メッセージ',
  noLog: 'ログはまだありません',
  copyEntry: 'この項目をコピー',

  // sessions.ts
  sessionsDesc: 'このプロセス内の各セッションの token 使用量とキャッシュヒットです。再起動するとゼロから数え直し、終了した一時セッションは直近 8 個だけ残ります。再起動をまたいだ統計は「使用量とコスト」を参照してください。',
  sesHeadStatus: '状態',
  sesHeadCalls: '呼び出し',
  sesHeadInput: '入力 tok',
  sesHeadCache: 'キャッシュヒット',
  sesHeadOutput: '出力 tok',
  sesHeadMsgs: 'メッセージ',
  noSessions: 'セッションはまだありません',
  running: '未終了',
  ended: '終了',
};
