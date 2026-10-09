import type { en, panelEn } from './strings.ts';

export const text: Partial<typeof en> = {
  description: 'Responses API 互換のモデルサービスに接続します。',
  extraHeaders: '追加リクエストヘッダー（JSON オブジェクト）',
  extraBody: '追加リクエストボディ（JSON オブジェクト）',
  endpointPath: 'Responses エンドポイントのパス',
  endpointPathDescription: 'プロバイダー URL からの相対パス。既定値は /responses です。',
  endpointPathSlash: 'エンドポイントのパスは / で始まる必要があります',
  extraHeadersObject: '追加リクエストヘッダーは文字列から文字列へのオブジェクトである必要があります',
  extraBodyObject: '追加リクエストボディのフィールドはオブジェクトである必要があります',
  reasoningReplay: '思考の返送形式',
  reasoningReplayDescription: 'encrypted は署名付きブロックを、plaintext は推論テキストを返送します。どちらを受け付けるかはエンドポイント次第なので、不明な場合はテストしてください。',
  reasoningReplayValue: '思考の返送形式は encrypted または plaintext である必要があります',
  syntheticReasoningText: '合成推論テキスト',
  syntheticReasoningTextDescription: (fallback: string) =>
    `plaintext で返送するとき、記録元のないツール呼び出しの前に補う推論テキストです。モデルはこれを読みます。空欄の場合は既定の「${fallback}」を使います。エンドポイントは空文字列と空白だけの文字列を拒否します。`,
  syntheticReasoningTextValue: '合成推論テキストは空文字列や空白だけにはできません：エンドポイントがリクエスト全体を拒否します',
  reasoningPanel: '思考',
  reasoningPanelDescription: '思考を上流へ返送する形式。',
  bodyRequired: 'リクエストボディが必要です',
  instanceNameRequired: 'エンドポイント名が必要です',
  unknownPanel: '不明なパネルです',
  unknownMethod: '不明な操作です',
  modelRequired: '先にモデルを選択してください',
  thinkingOff: 'このエンドポイントは思考がオフのため、返送形式は関係ありません',
};

export const panel: Partial<typeof panelEn> = {
  title: '思考',
  encrypted: '暗号化',
  plaintext: '平文',
  detect: 'わからないのでテストする',
  detecting: 'テスト中',
  saved: '保存しました',
  accepted: '受理',
  rejected: (status: number | null, error: string) => `拒否${status ? ` ${status}` : ''}：${error}`,
  skipped: '未テスト',
  outcome: (bare: string, withReasoning: string) => `思考なしの合成呼び出し：${bare}。平文の思考あり：${withReasoning}`,
  applied: (label: string) => `${label}に設定しました`,
  undetermined: '判定できなかったため、設定は変更していません',
  detected: (outcome: string, conclusion: string) => `${outcome}。${conclusion}`,
};
