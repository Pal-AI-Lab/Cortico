import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  protocolMismatch: (server: string, page: string) =>
    `控制台協定版本不一致：伺服器端 ${server}，頁面 ${page}。請強制重新整理頁面。`,
  pageFailed: (pageId: string) => `頁面「${pageId}」開啟失敗`,
  noPage: (pageId: string) => `控制台頁面不存在：「${pageId}」`,
  noPageHint: '請檢查頁面位址及模組啟用狀態。',
  noPanels: (label: string) => `「${label}」沒有宣告任何面板。`,
  noSuchPanel: (label: string, wanted: string) => `「${label}」沒有面板「${wanted}」`,
  provides: (list: string) => '可用面板：' + list,
  panelFailed: (title: string) => `面板「${title}」載入失敗`,
  configEmpty: '設定群組無法使用。',
  configTitle: '設定',
  configDesc: '修改自動儲存到 config.json。標註需重新啟動的設定在重新啟動後生效，其餘立即生效。',
  assembly: '裝配',
  notInstalled: '無法使用',
  notActivated: '未啟用',
  hidden: '已隱藏',
  reloadPrefix: '前綴待重新載入 · 點此重新載入',
  open: '開啟',
  configTab: '設定',
  promptsTab: '提示詞範本',
  storageTab: '資料',
  toolsTab: '工具表',
  storageTitle: '資料',
  storageDesc: '本頁宣告的儲存項目;清除範圍與結果由各項目的實作決定。',
  reloadTitle: '重新載入 system 前綴？',
  reloadBody: '重新讀取全部前綴來源並取代目前 session 的系統前綴，保留既有對話。',
  prefixReloaded: '前綴已重新載入',
  noBundle: (pageId: string) =>
    `「${pageId}」缺少面板建置產物。儲存庫內頁面請先停止 bot，再執行 pnpm build:web；`
    + 'extensions/ 下的擴充功能請在套件目錄建置，再重新啟動處理程序。',
  badBundleUrl: (pageId: string) => `「${pageId}」的面板產物位址不合法，已拒絕載入`,
  bundleLoadFailed: (pageId: string, err: string) => `「${pageId}」的面板產物載入失敗: ${err}`,
  badDefaultExport: (pageId: string) => `「${pageId}」的面板產物缺少有效的 default 匯出，格式應為 { panels: { … } }`,
  none: '(無)',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `「${pageId}」的面板產物中沒有「${panelId}」。可用面板：${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `「${pageId}」的面板「${panelId}」缺少 mount 方法`,
  noBuiltinPanel: (name: string, known: string) =>
    `內建面板「${name}」不存在。可用面板：${known}`,
};
