import type { coreGroupEn, validationEn } from './strings.ts';

export const coreGroupText: Partial<typeof coreGroupEn> = {
  title: '事件合批、推理與日誌',
  description: '',
  displayName: {
    title: '顯示名稱',
    description: '控制台標題與 bot 發出的訊息用這個名字。控制台立刻跟上;已經掛載的 World 在自己重新啟動後才跟上。',
  },
  quietGap: {
    title: '安靜視窗',
    description: '參與合批的事件在最後一項到達後等待此時長；達到批次時限或數量上限時提前投遞。',
  },
  minBatchAge: {
    title: '最短合批時間',
    description: '參與合批的事件從第一項到達起至少等待此時長；批次時限和數量上限優先。',
  },
  maxBatchAge: {
    title: '最長合批時間',
    description: '從第一項到達起，合批等待不超過此時長。',
  },
  maxBatchSize: {
    title: '單批上限',
    suffix: '條',
    description: '外部事件和候選達到此數量時立即投遞；不計延遲算繪項目和 piggyback 項目。',
  },
  keepPastThinking: {
    title: '保留歷史思維鏈',
    description: '啟用後，provider 可回傳相容的歷史推理；關閉後請求不含歷史推理。已儲存的 session 不變。',
  },
  logFile: {
    title: '日誌寫入磁碟門檻',
    description: '低於此層級的記錄不寫入 data/runs/<run>/log.jsonl。',
  },
  logConsole: {
    title: '日誌列印門檻',
    description: '低於這一級的記錄不印到控制台視窗。',
  },
  logAreas: {
    title: '依區域覆蓋寫入磁碟門檻',
    description: '以逗號分隔 `區域=層級`，例如 `core.loop=trace,console=warn`；支援 `.*`。最長符合前綴優先，未符合的區域使用預設門檻。',
  },
  usageRate: {
    title: (code: string) => `用量報告匯率 ${code}`,
    description: '1 美元可兌換多少該貨幣。「用量與成本」頁選擇這種貨幣時，沒有原價的呼叫按此換算；0 表示不換算。',
  },
};

export const validationText: Partial<typeof validationEn> = {
  notNumber: (label: string) => `${label} 必須是數值`,
  below: (label: string, min: number) => `${label} 不能小於 ${min}`,
  above: (label: string, max: number) => `${label} 不能大於 ${max}`,
  notInEnum: (label: string, options: string) => `${label} 只能是 ${options}`,
  needsPair: (label: string) => `${label} 需要兩個數`,
  first: (label: string) => `${label} 第一項`,
  second: (label: string) => `${label} 第二項`,
  pairOrder: (label: string) => `${label} 的第一項不能大於第二項`,
  empty: (label: string) => `${label} 不能為空`,
};
