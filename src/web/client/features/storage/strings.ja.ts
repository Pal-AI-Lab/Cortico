import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  sectionDisk: 'ディスク上の data/（再起動後も残る）',
  sectionMemory: 'メモリ上の一時データ（再起動で消える）',
  nukeAll: '⚠ サーバーのストレージをすべて消去',
  clear: '消去',
  dangerTitle: (label: string) => `⚠ 危険な操作：${label}`,
  dangerBody: (note: string) => `${note}\n\n元に戻せません。消去しますか？`,
  clearTitle: (label: string) => `「${label}」を消去しますか？`,
  cleared: '消去しました',
  clearFailed: (err: string) => '消去に失敗しました：' + err,
  nukeTitle: '⚠⚠ ストレージをすべて消去',
  nukeBody: 'このページに表示されている項目だけでなく、サーバーの一覧にあるすべてのストレージ項目を消去します。この操作は元に戻せません。消去される項目：',
  partialFailed: (keys: string) => '一部失敗：' + keys,
  nukedAll: (count: number) => `✓ すべて消去しました（${count} 項目）`,
  nukeFailed: (err: string) => '一括消去に失敗しました：' + err,
  noList: '（サーバーにストレージ一覧がマウントされていません）',
  empty: 'このページにはストレージ項目がありません',
  loadFailed: (err: string) => 'ストレージ一覧を読み込めませんでした：' + err,
  loading: '読み込み中…',
};
