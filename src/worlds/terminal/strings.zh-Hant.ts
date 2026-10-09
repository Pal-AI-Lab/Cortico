import type { en } from './strings.ts';

export const text: Partial<typeof en> = {
  configTitle: '終端 · 控制台口令',
  configDescription:
    '口令是控制台指示的憑證:World 給每則終端訊息自動加上 [console|PIN:……] 標記,'
    + '同一串數字進她的系統前綴供比對。對得上的照辦,自稱控制台卻對不上的當一般外部輸入。'
    + '操作員不用手打口令,也不該在別處提起它。',
  pinTitle: '控制台口令(六位數字)',
  pinDescription:
    '空 = 不啟用:訊息不帶標記,前綴裡也沒有可比對的口令。不是六位數字的值一律當未設定'
    + '(控制台徽標會說「格式不對」)。',
  lampLabel: '對話通道',
  lampOnline: (n: number) => `${n} 人在線`,
  lampNobody: '無人在線',
  badgeOnline: '在線',
  badgeOnlineValue: (n: number) => `${n} 人`,
  badgePin: '口令',
  pinEnabled: '已啟用',
  pinMalformed: '格式不對',
  pinUnset: '未設定',
  moduleLabel: '終端對話',
  promptDocTitle: '終端 · 環境提示詞',
  promptDocDescription: '終端對話環境的常駐事實。',
  pinVarDescription: '本場的控制台口令(worlds.terminal.pin);沒設定或形狀不對時展開成範本裡的預設文案。',
  greeting: '已連線。請傳送 {type:"hello", name:"你的名字"} 報上名字。',
  botOffline: 'bot下線',
  left: (name: string) => `${name} 離開了對話`,
  joined: (name: string) => `${name} 進入了對話`,
  notJson: '訊息不是有效的JSON,已忽略',
  malformed: '訊息格式不對,已忽略',
  emptyName: '名字不能為空',
  hello: (name: string) => `你好,${name}。`,
  helloFirst: '請先傳送 hello 設定名字',
  imagesRejected: (reason: string) => `圖片未傳送: ${reason}`,
  botNotConnected: 'bot尚未連線,訊息未送達',
  deliveryFailed: (err: string) => `訊息未送達: ${err}`,
  modelBlind: (model: string) => `目前模型 ${model} 不接收影像,她只看到每張圖的文字說明`,
  unknownType: (type: string) => `未知訊息類型: ${type}`,
  imagesNotArray: 'images 必須是陣列',
  tooManyImages: (max: number) => `一則訊息最多 ${max} 張圖`,
  unsupportedImage: (mime: string) => `不支援的圖片格式: ${mime}`,
  imageNoBase64: '圖片缺少 base64 內容',
  imageEmpty: '圖片內容為空',
  imageTooLarge: (mb: number) => `單張圖片超過 ${mb}MB`,
  unknownPanel: (panel: string) => `未知通道: ${panel}`,
};
