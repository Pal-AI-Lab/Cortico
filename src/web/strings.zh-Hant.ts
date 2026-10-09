import type { en } from './strings.ts';

export const serverText: Partial<typeof en> = {
  paused: '已暫停:事件照常寫入資料庫排隊,不投遞喚醒',
  resumed: '已繼續:積壓事件一次性投遞',
  exitSupervised: '處理程序即將結束,啟動器隨即重新啟動',
  exitSupervisedPaused: '處理程序即將結束,啟動器隨即重新啟動;回來時事件投遞是暫停的,要在執行狀態裡按繼續',
  exitUnsupervised: '處理程序即將結束;沒有偵測到啟動器迴圈,需要手動重新啟動',
  shutdownSkipped: (n: number, labels: string[]) => `本機關機完成,但有 ${n} 步沒走完:${labels.join('、')}`,
  shutdownComplete: (n: number) => `本機關機完成(${n} 步全部走完)`,
  externalUnverified: (items: string[]) => `；[P0] ${items.join('；')}`,
  externalItem: (label: string, status: string, detail: string, manualAction: string) =>
    `${label}=${status}（${detail}）。人工處理:${manualAction}`,
  externalVerified: '；外部狀態檢查均已驗證結束',
};
