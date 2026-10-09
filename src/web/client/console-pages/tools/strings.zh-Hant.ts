import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  ioGroup: (name: string | undefined) => `IO 工具 · ${name}`,
  groupCore: '原生動作 · core',
  groupPersona: '記憶 / 檔案工具 · Persona',
  noDescription: '（未填寫工具說明）',
  paramCount: (n: number) => `${n} 個參數`,
  paramHeadPath: '參數路徑',
  paramHeadType: '類型',
  paramHeadConstraint: '約束',
  paramHeadDesc: '說明',
  required: '必填',
  optional: '選填',
  noParams: '這個工具沒有宣告參數',
  copySchema: '複製 schema',
  fullSchema: '完整 JSON Schema',
  toolsTitle: '工具庫',
  toolsDesc: '目前提供給模型的工具定義，唯讀。',
  toolCount: (n: number) => `${n} 個`,
  toolsFilter: '篩選工具名稱或說明…',
  toolsEmpty: '工具表為空——主迴圈啟動後會在這裡出現',
  loadFailed: (msg: string) => `工具表介面無法使用：${msg}`,
};
