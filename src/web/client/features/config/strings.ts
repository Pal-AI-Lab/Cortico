import { pick } from '../../core/language.ts';

const zh = {
  loading: '加载中…',
  optionCurrent: '(当前)',
  ownerPersona: 'Persona',
  chooseFile: '选择文件',
  chooseDirectory: '选择目录',
  recommendedDir: (dir: string) => `推荐目录：${dir}`,
  download: '下载',
  on: '开启',
  leaveBlank: '留空',
  saving: '保存中…',
  saveFailed: (err: string) => '失败: ' + err,
  emptyDefault: "此页没有配置项。",
  noSchema: "未提供配置项。",
  restartWorld: '重启 World 生效',
  restartProcess: '重启生效',
  loadFailed: (err: string) => '配置项加载失败: ' + err,
};

const en: typeof zh = {
  loading: 'Loading…',
  optionCurrent: '(current)',
  ownerPersona: 'Persona',
  chooseFile: 'Choose file',
  chooseDirectory: 'Choose directory',
  recommendedDir: (dir: string) => `Recommended directory: ${dir}`,
  download: 'Download',
  on: 'On',
  leaveBlank: 'Leave blank',
  saving: 'Saving…',
  saveFailed: (err: string) => 'Failed: ' + err,
  emptyDefault: "No configuration fields on this page.",
  noSchema: "No configuration fields provided.",
  restartWorld: 'takes effect after World restart',
  restartProcess: 'takes effect after restart',
  loadFailed: (err: string) => 'Failed to load config: ' + err,
};

export const S = pick({ zh, en });
