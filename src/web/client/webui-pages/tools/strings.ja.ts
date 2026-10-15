import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  ioGroup: (name: string | undefined) => `IO ツール · ${name}`,
  groupCore: 'ネイティブ操作 · core',
  groupPersona: '記憶 / ファイルツール · Persona',
  noDescription: '（ツールの説明がありません）',
  paramCount: (n: number) => `パラメーター ${n} 個`,
  paramHeadPath: 'パラメーターのパス',
  paramHeadType: '型',
  paramHeadConstraint: '制約',
  paramHeadDesc: '説明',
  required: '必須',
  optional: '任意',
  noParams: 'このツールはパラメーターを宣言していません',
  copySchema: 'schema をコピー',
  fullSchema: '完全な JSON Schema',
  toolsTitle: 'ツールライブラリ',
  toolsDesc: '現在モデルに提供しているツール定義です。読み取り専用です。',
  toolCount: (n: number) => `${n} 個`,
  toolsFilter: 'ツール名や説明で絞り込み…',
  toolsEmpty: 'ツール表は空です。メインループが起動するとここに表示されます',
  loadFailed: (msg: string) => `ツール表の API を利用できません：${msg}`,
};
