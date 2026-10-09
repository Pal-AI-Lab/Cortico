import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  loading: '載入中…',
  optionCurrent: '(目前)',
  ownerPersona: 'Persona',
  chooseFile: '選擇檔案',
  chooseDirectory: '選擇目錄',
  recommendedDir: (dir: string) => `建議目錄：${dir}`,
  download: '下載',
  on: '開啟',
  leaveBlank: '留空',
  saving: '儲存中…',
  saveFailed: (err: string) => '失敗: ' + err,
  emptyDefault: '此頁沒有設定項目。',
  noSchema: '未提供設定項目。',
  restartWorld: '重新啟動 World 生效',
  restartProcess: '重新啟動生效',
  loadFailed: (err: string) => '設定項目載入失敗: ' + err,
};
