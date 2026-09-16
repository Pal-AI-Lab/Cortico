import { pick } from '../../core/language.ts';

const zh = {
  ioGroup: (name: string | undefined) => `IO 工具 · ${name}`,
  groupCore: '原生动作 · core',
  groupPersona: '记忆 / 文件工具 · Persona',
  noDescription: '（未填写工具说明）',
  paramCount: (n: number) => `${n} 个参数`,
  paramHeadPath: '参数路径',
  paramHeadType: '类型',
  paramHeadConstraint: '约束',
  paramHeadDesc: '说明',
  required: '必填',
  optional: '可选',
  noParams: '这个工具没有声明参数',
  copySchema: '复制 schema',
  fullSchema: '完整 JSON Schema',
  toolsTitle: '工具库',
  toolsDesc: '当前提供给模型的工具定义，只读。',
  toolCount: (n: number) => `${n} 个`,
  toolsFilter: '筛选工具名或说明…',
  toolsEmpty: '工具表为空——主循环启动后会在这里出现',
  loadFailed: (msg: string) => `工具表接口不可用：${msg}`,
};

const en: typeof zh = {
  ioGroup: (name: string | undefined) => `IO tools · ${name}`,
  groupCore: 'Native actions · core',
  groupPersona: 'Memory / file tools · Persona',
  noDescription: '(no tool description)',
  paramCount: (n: number) => `${n} params`,
  paramHeadPath: 'Path',
  paramHeadType: 'Type',
  paramHeadConstraint: 'Constraint',
  paramHeadDesc: 'Description',
  required: 'required',
  optional: 'optional',
  noParams: 'This tool declares no parameters',
  copySchema: 'Copy schema',
  fullSchema: 'Full JSON Schema',
  toolsTitle: 'Tool library',
  toolsDesc: 'Current tool definitions provided to the model. Read-only.',
  toolCount: (n: number) => `${n} tools`,
  toolsFilter: 'Filter by tool name or description…',
  toolsEmpty: 'Tool table is empty — it appears here once the main loop starts',
  loadFailed: (msg: string) => `Tool table endpoint unavailable: ${msg}`,
};

export const S = pick({ zh, en });
