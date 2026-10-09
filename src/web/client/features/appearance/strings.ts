import { pick } from '../../core/language.ts';
import { S as zhHant } from './strings.zh-Hant.ts';
import { S as ja } from './strings.ja.ts';
import { S as ko } from './strings.ko.ts';
import { S as fr } from './strings.fr.ts';
import { S as de } from './strings.de.ts';
import { S as es419 } from './strings.es-419.ts';
import { S as ptBR } from './strings.pt-BR.ts';
import { S as it } from './strings.it.ts';
import { S as ru } from './strings.ru.ts';

const zh = {
  pageTitle: '外观',
  deleteScheme: '删除方案',
  schemeSheetTitle: '颜色方案',
  schemeSheetDesc: "选择立即应用并保存在当前浏览器。",
  switchedMode: (label: string) => `已切换到「${label}」`,
  switchedScheme: (name: string) => `✓ 已切换到「${name}」`,
  paletteSheetTitle: '调色盘',
  paletteSheetDesc: "预览仅修改当前浅色或深色配色；保存后保留。",
  schemeName: '方案名',
  colorAria: (label: string) => `${label}颜色`,
  hexAria: (label: string) => `${label}十六进制颜色`,
  previewing: '● 正在预览，尚未保存',
  resetPreview: '撤销预览',
  previewReset: '已撤销未保存的调色预览',
  confirmDelete: '再次点击确认删除',
  aboutToDelete: (name: string) => `即将删除「${name}」；再次点击确认。`,
  deleteCancelled: '已取消删除',
  deleted: (name: string) => `已删除自定义方案，并切回「${name}」`,
  copyAsNew: '复制为新方案',
  copySuffix: ' 副本',
  customSuffix: ' 自定义',
  copied: '✓ 已复制为新的自定义方案',
  saveScheme: '保存方案',
  savedVariant: (appearance: string) => `✓ 当前${appearance}变体已保存`,
  customName: (name: string) => `${name} 自定义`,
  savedAsCustom: '✓ 内置方案已另存为自定义',
  builtin: '内置',
  custom: '自定义',
  saveCurrent: '保存当前方案',
  saveAsCustom: '另存为自定义',
  builtinHint: '内置方案不可覆盖；调色后可另存为自定义。',
  saveFailed: (reason: string) => `配色没能存进部署：${reason}`,
  customHint: '自定义方案可直接保存；浅色与黑夜变体互相独立。',
  specimenTitle: '组件试色',
  thinkLabel: '思考',
  thinkBody: "思考文本预览",
  monologBody: "正文预览",
  chartAria: '图表系列色预览',
  navLabel: '外观',
};

export const en: typeof zh = {
  pageTitle: 'Appearance',
  deleteScheme: 'Delete scheme',
  schemeSheetTitle: 'Color scheme',
  schemeSheetDesc: "Selection applies immediately and is saved in this browser.",
  switchedMode: (label: string) => `Switched to "${label}"`,
  switchedScheme: (name: string) => `✓ Switched to "${name}"`,
  paletteSheetTitle: 'Palette',
  paletteSheetDesc: "Preview edits only the current light or dark palette. Save to keep the changes.",
  schemeName: 'Scheme name',
  colorAria: (label: string) => `${label} color`,
  hexAria: (label: string) => `${label} hex color`,
  previewing: '● Previewing, not saved yet',
  resetPreview: 'Discard preview',
  previewReset: 'Unsaved palette preview discarded',
  confirmDelete: 'Click again to confirm deletion',
  aboutToDelete: (name: string) => `About to delete "${name}"; click again to confirm.`,
  deleteCancelled: 'Deletion cancelled',
  deleted: (name: string) => `Custom scheme deleted, switched back to "${name}"`,
  copyAsNew: 'Copy as new scheme',
  copySuffix: ' copy',
  customSuffix: ' custom',
  copied: '✓ Copied as a new custom scheme',
  saveScheme: 'Save scheme',
  savedVariant: (appearance: string) => `✓ Current ${appearance} variant saved`,
  customName: (name: string) => `${name} custom`,
  savedAsCustom: '✓ Built-in scheme saved as a custom scheme',
  builtin: 'Built-in',
  custom: 'Custom',
  saveCurrent: 'Save current scheme',
  saveAsCustom: 'Save as custom',
  builtinHint: 'Built-in schemes cannot be overwritten; edit the palette and save as custom.',
  saveFailed: (reason: string) => `The palette was not saved to the deployment: ${reason}`,
  customHint: 'Custom schemes save directly; the light and dark variants are independent.',
  specimenTitle: 'Component specimen',
  thinkLabel: 'Reasoning',
  thinkBody: "Reasoning text preview",
  monologBody: "Message text preview",
  chartAria: 'Chart series color preview',
  navLabel: 'Appearance',
};

export const S = pick({
  zh, en, 'zh-Hant': zhHant, ja, ko, fr, de, 'es-419': es419, 'pt-BR': ptBR, it, ru,
});
