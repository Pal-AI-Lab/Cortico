import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  sectionDisk: '寫入磁碟 data/（重新啟動後仍在）',
  sectionMemory: '記憶體暫存（重新啟動即清零）',
  nukeAll: '⚠ 一鍵清空伺服器端全部儲存',
  clear: '清除',
  dangerTitle: (label: string) => `⚠ 危險操作：${label}`,
  dangerBody: (note: string) => `${note}\n\n確定不可復原地清除？`,
  clearTitle: (label: string) => `清除「${label}」？`,
  cleared: '已清除',
  clearFailed: (err: string) => '清除失敗: ' + err,
  nukeTitle: '⚠⚠ 一鍵清空全部儲存',
  nukeBody: '清除伺服器端清單裡的全部儲存項目，不只是本頁列出的這些。此操作無法復原。將清除：',
  partialFailed: (keys: string) => '部分失敗: ' + keys,
  nukedAll: (count: number) => `✓ 已全部清空（${count} 項）`,
  nukeFailed: (err: string) => '一鍵清空失敗: ' + err,
  noList: '(伺服器端未掛載儲存清單)',
  empty: '這一頁沒有儲存項目',
  loadFailed: (err: string) => '儲存清單載入失敗: ' + err,
  loading: '載入中…',
};
