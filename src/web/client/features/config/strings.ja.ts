import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  loading: '読み込み中…',
  optionCurrent: '（現在）',
  ownerPersona: 'Persona',
  chooseFile: 'ファイルを選択',
  chooseDirectory: 'ディレクトリを選択',
  recommendedDir: (dir: string) => `推奨ディレクトリ：${dir}`,
  download: 'ダウンロード',
  on: 'オン',
  leaveBlank: '空欄のまま',
  saving: '保存中…',
  saveFailed: (err: string) => '失敗：' + err,
  emptyDefault: 'このページには設定項目がありません。',
  noSchema: '設定項目が提供されていません。',
  restartWorld: 'World の再起動後に反映',
  restartProcess: '再起動後に反映',
  loadFailed: (err: string) => '設定項目を読み込めませんでした：' + err,
};
