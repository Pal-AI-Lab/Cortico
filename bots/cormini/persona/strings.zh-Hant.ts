import type { consoleEn, panelEn } from './strings.ts';

export const consoleText: Partial<typeof consoleEn> = {
  orientation: 'Persona的存在方式與後設認知說明。',
  constitution: 'Persona 的長期原則。重新載入系統前綴或開始新上下文後生效。',
  memoryNote: '記憶約定:bot 的檔案怎麼存、什麼時候會自動浮現。',
  workspaceLabel: '工作區(bot 自己寫的記憶檔案)',
  workspaceNote: '憲法之外的全部工作區檔案不可復原地刪除;憲法與人格檢查點不動',
  workspaceStat: (n: number) => `${n}個檔案(憲法之外)`,
  workspaceCleared: (n: number) => `已刪除 ${n} 個工作區檔案;憲法未動`,
  firstTurnUser: '首輪·使用者輸入',
  firstTurnUserDesc: '合成首輪對話的 user 訊息。與回覆任一為空則整輪不注入。',
  firstTurnThinking: '首輪·思維鏈',
  firstTurnThinkingDesc: '合成首輪 assistant 的思維鏈(reasoning_content);為空則該輪不帶。註:openai-responses-compat 方言不回傳思維鏈,這段在該類端點上不出線。',
  firstTurnReply: '首輪·回覆',
  firstTurnReplyDesc: '合成首輪對話的 assistant 回覆正文。',
};

export const panelText: Partial<typeof panelEn> = {
  workspace: '工作區',
  workspaceDesc: '儲存時以 operator 署名提交到工作區的 Git 儲存庫。',
  history: '版本歷史',
};
