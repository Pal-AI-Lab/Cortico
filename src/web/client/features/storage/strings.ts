import { pick } from '../../core/language.ts';

const zh = {
  sectionDisk: '落盘 data/（重启后仍在）',
  sectionMemory: '内存暂存（重启即清零）',
  nukeAll: '⚠ 一键清空全部',
  clear: '清除',
  dangerTitle: (label: string) => `⚠ 危险操作：${label}`,
  dangerBody: (note: string) => `${note}\n\n确定不可恢复地清除？`,
  clearTitle: (label: string) => `清除「${label}」？`,
  cleared: '已清除',
  clearFailed: (err: string) => '清除失败: ' + err,
  nukeTitle: '⚠⚠ 一键清空全部存储',
  nukeBody: '清除服务端清单里的全部存储项,含各 World 与 Memory 页的。此操作无法撤销。',
  partialFailed: (keys: string) => '部分失败: ' + keys,
  nukedAll: (count: number) => `✓ 已全部清空（${count} 项）`,
  nukeFailed: (err: string) => '一键清空失败: ' + err,
  noList: '(服务端未挂载存储清单)',
  empty: '这一页没有存储项',
  loadFailed: (err: string) => '存储清单加载失败: ' + err,
  loading: '加载中…',
};

const en: typeof zh = {
  sectionDisk: 'Persisted data/ (survives restart)',
  sectionMemory: 'In-memory (cleared on restart)',
  nukeAll: '⚠ Clear everything',
  clear: 'Clear',
  dangerTitle: (label: string) => `⚠ Dangerous: ${label}`,
  dangerBody: (note: string) => `${note}\n\nClear irreversibly?`,
  clearTitle: (label: string) => `Clear "${label}"?`,
  cleared: 'Cleared',
  clearFailed: (err: string) => 'Clear failed: ' + err,
  nukeTitle: '⚠⚠ Clear all storage',
  nukeBody: 'Clear every storage item on the server, including those of World and Memory pages. This cannot be undone.',
  partialFailed: (keys: string) => 'Partially failed: ' + keys,
  nukedAll: (count: number) => `✓ Everything cleared (${count} items)`,
  nukeFailed: (err: string) => 'Clear all failed: ' + err,
  noList: '(The server has no storage list mounted)',
  empty: 'This page has no storage items',
  loadFailed: (err: string) => 'Failed to load storage list: ' + err,
  loading: 'Loading…',
};

export const S = pick({ zh, en });
