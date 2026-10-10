import { pick, type Language } from './language.ts';
import { coreGroupText as coreGroupZhHant, validationText as validationZhHant } from './strings.zh-Hant.ts';
import { coreGroupText as coreGroupJa, validationText as validationJa } from './strings.ja.ts';
import { coreGroupText as coreGroupKo, validationText as validationKo } from './strings.ko.ts';
import { coreGroupText as coreGroupFr, validationText as validationFr } from './strings.fr.ts';
import { coreGroupText as coreGroupDe, validationText as validationDe } from './strings.de.ts';
import { coreGroupText as coreGroupEs419, validationText as validationEs419 } from './strings.es-419.ts';
import { coreGroupText as coreGroupPtBR, validationText as validationPtBR } from './strings.pt-BR.ts';
import { coreGroupText as coreGroupIt, validationText as validationIt } from './strings.it.ts';
import { coreGroupText as coreGroupRu, validationText as validationRu } from './strings.ru.ts';

/** Core 配置组的标题与说明。 */
const coreGroupZh = {
  title: "事件合批、推理与日志",
  description: "",
  displayName: {
    title: '展示名',
    description: '控制台标题与 bot 发出的消息用这个名字。控制台立刻跟上;已经挂载的 World 在自己重启后才跟上。',
  },
  quietGap: {
    title: '安静窗口',
    description: "参与合批的事件在最后一项到达后等待此时长；达到批次时限或数量上限时提前投递。",
  },
  minBatchAge: {
    title: "最短合批时间",
    description: "参与合批的事件从第一项到达起至少等待此时长；批次时限和数量上限优先。",
  },
  maxBatchAge: {
    title: "最长合批时间",
    description: "从第一项到达起，合批等待不超过此时长。",
  },
  maxBatchSize: {
    title: '单批上限',
    suffix: '条',
    description: "外部事件和候选达到此数量时立即投递；不计延迟渲染项和 piggyback 项。",
  },
  keepPastThinking: {
    title: '保留历史思维链',
    description: "启用后，provider 可回传兼容的历史推理；关闭后请求不含历史推理。已保存的 session 不变。",
  },
  logFile: {
    title: '日志落盘门槛',
    description: "低于此级别的记录不写入 data/runs/<run>/log.jsonl。",
  },
  logConsole: {
    title: '日志打印门槛',
    description: '低于这一级的记录不打到控制台窗口。',
  },
  logAreas: {
    title: '按区域覆盖落盘门槛',
    description: "以逗号分隔 `区域=级别`，例如 `core.loop=trace,console=warn`；支持 `.*`。最长匹配前缀优先，未匹配的区域使用默认门槛。",
  },
  usageRate: {
    title: (code: string) => `用量报告汇率 ${code}`,
    description: '用量报告在 USD 与该货币之间换算时用这个汇率：1 美元合多少该货币，初始值取 2026-10-10 的中间价。0 表示该货币不参与换算。',
  },
};
export const coreGroupEn: typeof coreGroupZh = {
  title: "Event batching, reasoning and logging",
  description: "",
  displayName: {
    title: 'Display name',
    description: 'Used for the console title and as the sender name on messages the bot sends. The console picks it up at once; a mounted World does so when that World restarts.',
  },
  quietGap: {
    title: 'Quiet window',
    description: "Wait this long after the last batched item arrives; the batch time and size limits can trigger earlier delivery.",
  },
  minBatchAge: {
    title: 'Minimum batch age',
    description: "Wait at least this long after the first batched item arrives; the batch time and size limits take precedence.",
  },
  maxBatchAge: {
    title: "Maximum batch age",
    description: "Limit batching delay to this duration from the first item.",
  },
  maxBatchSize: {
    title: 'Batch size limit',
    suffix: 'items',
    description: "Deliver when external events and candidates reach this count; deferred rendering and piggyback items are excluded.",
  },
  keepPastThinking: {
    title: 'Keep past reasoning',
    description: "Allow the provider to replay compatible past reasoning. When disabled, requests omit past reasoning. Saved sessions are unchanged.",
  },
  logFile: {
    title: 'Log file threshold',
    description: "Records below this level are not written to data/runs/<run>/log.jsonl.",
  },
  logConsole: {
    title: 'Log print threshold',
    description: 'Records below this level are not printed to the console window.',
  },
  logAreas: {
    title: 'Per-area file threshold overrides',
    description: "Comma-separated `area=level`, such as `core.loop=trace,console=warn`; `.*` is supported. The longest matching prefix applies. Unmatched areas use the default threshold.",
  },
  usageRate: {
    title: (code: string) => `Usage report rate: ${code}`,
    description: 'The rate the usage report converts between USD and this currency at: how much of it 1 USD is worth, initially the mid-market rate of 2026-10-10. 0 keeps this currency out of conversion.',
  },
};
export const coreGroupText = (language: Language) => pick(language, {
  zh: coreGroupZh, en: coreGroupEn, 'zh-Hant': coreGroupZhHant, ja: coreGroupJa, ko: coreGroupKo,
  fr: coreGroupFr, de: coreGroupDe, 'es-419': coreGroupEs419, 'pt-BR': coreGroupPtBR,
  it: coreGroupIt, ru: coreGroupRu,
});

/** 校验回执的措辞。`label` 是声明方给的 title,已经是当前语言。 */
const validationZh = {
  notNumber: (label: string) => `${label} 必须是数值`,
  below: (label: string, min: number) => `${label} 不能小于 ${min}`,
  above: (label: string, max: number) => `${label} 不能大于 ${max}`,
  notInEnum: (label: string, options: string) => `${label} 只能是 ${options}`,
  needsPair: (label: string) => `${label} 需要两个数`,
  first: (label: string) => `${label} 第一项`,
  second: (label: string) => `${label} 第二项`,
  pairOrder: (label: string) => `${label} 的第一项不能大于第二项`,
  empty: (label: string) => `${label} 不能为空`,
};
export const validationEn: typeof validationZh = {
  notNumber: (label: string) => `${label} must be a number`,
  below: (label: string, min: number) => `${label} cannot be less than ${min}`,
  above: (label: string, max: number) => `${label} cannot be greater than ${max}`,
  notInEnum: (label: string, options: string) => `${label} must be one of ${options}`,
  needsPair: (label: string) => `${label} needs two numbers`,
  first: (label: string) => `${label} (first)`,
  second: (label: string) => `${label} (second)`,
  pairOrder: (label: string) => `${label}: the first value cannot exceed the second`,
  empty: (label: string) => `${label} cannot be empty`,
};
export const validationText = (language: Language) => pick(language, {
  zh: validationZh, en: validationEn, 'zh-Hant': validationZhHant, ja: validationJa,
  ko: validationKo, fr: validationFr, de: validationDe, 'es-419': validationEs419,
  'pt-BR': validationPtBR, it: validationIt, ru: validationRu,
});
