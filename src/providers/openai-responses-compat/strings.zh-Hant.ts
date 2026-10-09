import type { en, panelEn } from './strings.ts';

export const text: Partial<typeof en> = {
  description: '連線相容 Responses API 的模型服務。',
  extraHeaders: '附加請求標頭（JSON object）',
  extraBody: '附加請求內容（JSON object）',
  endpointPath: 'Responses 端點路徑',
  endpointPathDescription: '相對供應位址;預設 /responses。',
  endpointPathSlash: '端點路徑必須以 / 開頭',
  extraHeadersObject: '附加請求標頭必須是字串到字串的物件',
  extraBodyObject: '附加請求內容欄位必須是物件',
  reasoningReplay: '思維鏈回傳形態',
  reasoningReplayDescription: '加密回簽章區塊,明文回推理文字;上游接受哪種由端點決定,不確定就探測。',
  reasoningReplayValue: '思維鏈回傳形態只能是 encrypted 或 plaintext',
  syntheticReasoningText: '合成推理填充',
  syntheticReasoningTextDescription: (fallback: string) =>
    `明文回傳時,沒有記錄來源的工具呼叫前補的那一段推理,模型會讀到。留空用預設「${fallback}」;端點拒收空字串與全空白。`,
  syntheticReasoningTextValue: '合成推理填充不能是空字串或全空白:端點會拒收整個請求',
  reasoningPanel: '思維鏈',
  reasoningPanelDescription: '思維鏈回傳給上游的形態。',
  bodyRequired: '需要請求內容',
  instanceNameRequired: '需要端點名稱',
  unknownPanel: '未知面板',
  unknownMethod: '未知操作',
  modelRequired: '先選模型',
  thinkingOff: '這個端點關著思維鏈,回傳形態無關',
};

export const panel: Partial<typeof panelEn> = {
  title: '思維鏈',
  encrypted: '加密',
  plaintext: '明文',
  detect: '我不知道,測一下',
  detecting: '探測中',
  saved: '已儲存',
  accepted: '通過',
  rejected: (status: number | null, error: string) => `被拒${status ? ` ${status}` : ''}:${error}`,
  skipped: '未測',
  outcome: (bare: string, withReasoning: string) => `不帶思維鏈的合成呼叫:${bare};帶明文思維鏈:${withReasoning}`,
  applied: (label: string) => `已設為${label}`,
  undetermined: '判斷不出,設定未改',
};
