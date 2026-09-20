import { pick, type Language } from '../../core/language.ts';

/** Server side: ConfigGroup titles, panel titles and validation errors. */
const zh = {
  endpointPath: 'Responses 端点路径',
  endpointPathDescription: '相对供应地址;默认 /responses。',
  endpointPathSlash: '端点路径必须以 / 开头',
  extraHeadersObject: '附加请求头必须是字符串到字符串的对象',
  extraBodyObject: '附加请求体字段必须是对象',
  reasoningReplay: 'CoT 加密模式',
  reasoningReplayDescription: '闭源服务大多为加密,开源模型大多为明文,请调整开关以匹配。',
  reasoningReplayValue: 'CoT 加密模式只能是 encrypted 或 plaintext',
  reasoningPanel: '思维链',
  reasoningPanelDescription: '思维链回传给上游的形态。',
  bodyRequired: '需要请求体',
  instanceNameRequired: '需要端点名',
  unknownPanel: '未知面板',
  unknownMethod: '未知操作',
  modelRequired: '先选模型',
  thinkingOff: '这条端点关着思维链,回传形态无关',
};
const en: typeof zh = {
  endpointPath: 'Responses endpoint path',
  endpointPathDescription: 'Relative to the provider URL; default /responses.',
  endpointPathSlash: 'The endpoint path must start with /',
  extraHeadersObject: 'Extra headers must be an object of strings',
  extraBodyObject: 'Extra body fields must be an object',
  reasoningReplay: 'CoT encryption mode',
  reasoningReplayDescription: 'Closed services mostly return encrypted reasoning, open models mostly plaintext. Set the switch to match.',
  reasoningReplayValue: 'CoT encryption mode must be encrypted or plaintext',
  reasoningPanel: 'Reasoning',
  reasoningPanelDescription: 'The form in which reasoning is sent back to the endpoint.',
  bodyRequired: 'Request body required',
  instanceNameRequired: 'Endpoint name required',
  unknownPanel: 'Unknown panel',
  unknownMethod: 'Unknown method',
  modelRequired: 'Choose a model first',
  thinkingOff: 'Reasoning is off on this endpoint; the replay form does not apply',
};
export type Text = typeof zh;
export const text = (language: Language) => pick(language, { zh, en });

/** Client side: the reasoning section of the endpoint page. */
const panelZh = {
  title: '思维链',
  encrypted: '加密',
  plaintext: '明文',
  detect: '我不知道,测一下',
  detecting: '探测中',
  saved: '已保存',
  accepted: '通过',
  rejected: (status: number | null, error: string) => `被拒${status ? ` ${status}` : ''}:${error}`,
  skipped: '未测',
  outcome: (bare: string, withReasoning: string) => `不带思维链的合成调用:${bare};带明文思维链:${withReasoning}`,
  applied: (label: string) => `已设为${label}`,
  undetermined: '判断不出,设置未改',
};
const panelEn: typeof panelZh = {
  title: 'Reasoning',
  encrypted: 'Encrypted',
  plaintext: 'Plaintext',
  detect: 'Not sure, test it',
  detecting: 'Testing',
  saved: 'Saved',
  accepted: 'accepted',
  rejected: (status: number | null, error: string) => `rejected${status ? ` ${status}` : ''}: ${error}`,
  skipped: 'not tested',
  outcome: (bare: string, withReasoning: string) => `Synthetic call without reasoning: ${bare}; with plaintext reasoning: ${withReasoning}`,
  applied: (label: string) => `Set to ${label}`,
  undetermined: 'Undetermined; the setting is unchanged',
};
export const panel = { zh: panelZh, en: panelEn };
