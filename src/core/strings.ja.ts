import type { coreGroupEn, validationEn } from './strings.ts';

export const coreGroupText: Partial<typeof coreGroupEn> = {
  title: 'イベントのバッチ化、推論、ログ',
  description: '',
  displayName: {
    title: '表示名',
    description: 'コンソールのタイトルと、ボットが送るメッセージの送信者名に使います。コンソールにはすぐ反映され、マウント済みの World にはその World の再起動後に反映されます。',
  },
  quietGap: {
    title: '静止ウィンドウ',
    description: 'バッチ対象のイベントは、最後の項目が届いてからこの時間だけ待ちます。バッチの時間上限または件数上限に達すると、それより早く配信します。',
  },
  minBatchAge: {
    title: '最短バッチ時間',
    description: 'バッチ対象のイベントは、最初の項目が届いてから少なくともこの時間待ちます。バッチの時間上限と件数上限が優先されます。',
  },
  maxBatchAge: {
    title: '最長バッチ時間',
    description: '最初の項目が届いてから、バッチの待ち時間はこの時間を超えません。',
  },
  maxBatchSize: {
    title: '1 バッチの上限',
    suffix: '件',
    description: '外部イベントと候補がこの件数に達するとすぐに配信します。後から本文を生成する項目と piggyback 項目は数えません。',
  },
  keepPastThinking: {
    title: '過去の思考を保持',
    description: '有効にすると、プロバイダーは互換性のある過去の推論を送り返せます。無効にすると、リクエストに過去の推論を含めません。保存済みのセッションは変わりません。',
  },
  logFile: {
    title: 'ログのファイル出力しきい値',
    description: 'このレベル未満の記録は data/runs/<run>/log.jsonl に書き込みません。',
  },
  logConsole: {
    title: 'ログの表示しきい値',
    description: 'このレベル未満の記録はコンソールウィンドウに表示しません。',
  },
  logAreas: {
    title: '領域ごとのファイル出力しきい値の上書き',
    description: 'カンマ区切りの `領域=レベル` で指定します（例：`core.loop=trace,console=warn`）。`.*` に対応しています。最も長く一致したプレフィックスが優先され、一致しない領域は既定のしきい値を使います。',
  },
  usageRate: {
    title: (code: string) => `使用量レポートの為替レート：${code}`,
    description: '使用量レポートで米ドルとこの通貨を換算するときのレートです。1 米ドルがこの通貨でいくらかを指定し、初期値は 2026-10-10 の仲値です。0 にするとこの通貨は換算しません。',
  },
};

export const validationText: Partial<typeof validationEn> = {
  notNumber: (label: string) => `${label} は数値である必要があります`,
  below: (label: string, min: number) => `${label} は ${min} 未満にできません`,
  above: (label: string, max: number) => `${label} は ${max} より大きくできません`,
  notInEnum: (label: string, options: string) => `${label} は ${options} のいずれかである必要があります`,
  needsPair: (label: string) => `${label} には 2 つの数値が必要です`,
  first: (label: string) => `${label}（1 つ目）`,
  second: (label: string) => `${label}（2 つ目）`,
  pairOrder: (label: string) => `${label}：1 つ目の値は 2 つ目の値より大きくできません`,
  empty: (label: string) => `${label} は空にできません`,
};
