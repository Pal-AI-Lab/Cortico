import type { botEn, assemblyEn } from './strings.ts';

export const botText: Partial<typeof botEn> = {
  noFile: '(無檔案)',
  storage: {
    events: {
      label: '事件庫(本次執行的分片)',
      note: '清除本次執行的事件記錄，保留此前執行的記錄；游標不回退',
      stat: (count: number, cursor: number, size: string) => `${count}條(游標至 ${cursor}) / ${size}`,
      cleared: (n: number) => `已清除本次執行的${n}條事件`,
    },
    session: {
      label: '主session(目前對話上下文)',
      note: '清除對話上下文並重新開場，保留 Memory 和事件庫。正在處理批次時等該批結束後執行',
      stat: (records: number, ktok: number, size: string) => `${records}條 / ~${ktok}k tok / ${size}`,
      cleared: 'session已清空重開(system前綴+開場訊息)',
    },
    runlog: {
      label: '執行日誌(本次執行)',
      note: '清除本次執行的日誌，保留此前執行的日誌。執行日誌不進入模型上下文',
      cleared: '執行日誌已清空',
    },
    usage: {
      label: 'token用量流水(成本頁資料來源)',
      note: '清除全部模型用量與成本記錄，成本頁從後續寫入的記錄重新累計。這些記錄不進入模型上下文',
      stat: (n: number, size: string) => `${n}條 / ${size}`,
      cleared: (n: number) => `已清除${n}條用量記錄`,
    },
    toolcalls: {
      label: '工具呼叫流水(工具名/原始參數/回執)',
      note: '清除本次執行的工具呼叫日誌，不改變模型上下文中的工具回執',
      cleared: '工具呼叫流水已清空',
    },
    state: {
      label: 'Core 狀態',
      note: '清除 Persona 狀態、交接時間和模型連續失敗記錄，保留投遞游標與 World 可見性',
      stat: (n: number, lastHandoff: string) => `人格狀態${n}項 / 上次交接${lastHandoff}`,
      never: '無',
      cleared: 'core狀態已重設為預設',
    },
    wakes: {
      label: '持久計時器',
      note: '全部計時器取消(不產生通知)',
      stat: (n: number) => `${n}個待觸發`,
      cleared: (n: number) => `已取消${n}個計時器`,
    },
    tracker: {
      label: 'session統計(usage/快取命中)',
      note: '清零統計，保留正在執行的 session 條目',
      stat: (n: number) => `${n}個session`,
      cleared: 'session統計已清零',
    },
    pending: {
      label: '待投遞事件',
      note:
        '捨棄待投遞的事件，保留事件庫記錄。延遲產生正文的佇列項目保留；已捨棄項目不會在重新啟動後補投',
      stat: (n: number) => `${n}條待投遞`,
      cleared: (n: number) => `已捨棄${n}條待投遞事件`,
    },
    media: {
      label: '附件庫(事件與工具回執裡的圖片、音訊)',
      note: '刪除全部附件檔案，保留引用它們的事件與 session 記錄；刪掉的附件在上下文裡只剩文字說明',
      stat: (n: number, size: string) => `${n}份 / ${size}`,
      cleared: (n: number) => `已刪除${n}份附件`,
    },
  },
  config: {
    unknownGroup: (id: string) => `沒有這一組設定: ${id}`,
    updated: (title: string, file: string) => `${title}已更新,已寫回 ${file}`,
  },
  prompts: {
    unknown: (key: string) => `未知提示詞範本: ${key}`,
    packageReadOnly: (title: string) => `${title} 是唯讀的擴充套件範本`,
    conflict: (title: string) => `${title} 已在別處被修改,請重新載入後再儲存`,
    saved: (title: string) => `已儲存 ${title}`,
    savedOverride: (title: string) => `已儲存 ${title} 的部署覆蓋檔案`,
    notEnvPrompt: (title: string) => `${title} 沒有可還原的預設範本`,
    alreadyDefault: (title: string) => `${title} 本來就在用 World 預設`,
    reset: (title: string) => `已刪除 ${title} 的部署覆蓋檔案`,
  },
  visibility: {
    shown: (id: string) => `${id} 對 agent 重新可見。事件投遞已恢復;前綴段與工具要等前綴重新載入才回來。`,
    hidden: (id: string) => `${id} 已對 agent 隱藏。新事件不再喚醒 agent(仍照常寫入資料庫);前綴段與工具要等前綴重新載入才撤下。`,
    prefixReloaded: (kept: number) => `系統前綴與工具表已重新載入，保留目前session的${kept}條既有訊息`,
  },
  shutdown: {
    pause: '暫停事件投遞',
    worlds: '停止 World',
    core: '停止 Persona',
    modulesTimedOut: 'World 停止逾時',
    stepTimedOut: (seconds: number) => `逾時(${seconds} 秒)`,
    externalState: (worldId: string) => `${worldId} 外部狀態`,
    stopIncomplete: (detail: string) => `World 停止未完成，不能採用外部核驗快取:${detail}`,
    cacheReadFailed: (detail: string) => `讀取已快取的關機驗證結果失敗:${detail}`,
    manualCheck: '請檢查對應外部服務是否已停止。',
    llm: '停止 Provider 實例',
    flush: '儲存 Core 狀態',
    web: '關閉控制台',
    summarySkipped: '本機關機步驟未全部完成',
    summaryComplete: '本機關機步驟全部完成',
    summaryUnverified: (items: string[]) => `本機關機完成,但外部狀態未確認結束:${items.join('、')}(需人工確認)`,
  },
};

export const assemblyText: Partial<typeof assemblyEn> = {
  constructFailed: (detail: string) => `建構失敗: ${detail}`,
  notImplemented: '本機沒有找到這個 World 的實作。',
  unknownWorld: (id: string) => `未知 World: ${id}`,
  alreadyRunning: (label: string) => `${label} 已啟用`,
  prebuilt: (label: string) => `${label} 是預建實例,不經裝配層啟用`,
  activated: (label: string, id: string) => `${label}（${id}）已啟用`,
  deactivated: (label: string, id: string) => `${label}（${id}）已停用`,
  notActive: (label: string) => `${label} 未啟用,沒有可重新啟動的實例`,
  restarted: (label: string) => `${label} 已重新啟動`,
  toolClash: (other: string, names: string[]) => `工具名與 ${other} 撞名,拒絕掛載: ${names.join(', ')}`,
  toolReserved: (names: string[]) => `工具名已被 Core 或 Persona 占用,拒絕掛載: ${names.join(', ')}`,
  unbound: '裝配層尚未綁定 core',
};
