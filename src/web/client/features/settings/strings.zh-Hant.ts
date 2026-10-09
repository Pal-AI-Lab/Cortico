import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  general: '一般',
  generalDesc: '控制台語言偏好。',
  language: '介面語言 / Language',
  languageDesc: '僅儲存在目前瀏覽器，重新整理頁面後生效。',
  reloadTitle: '切換介面語言？',
  reloadBody: '頁面將重新整理，未儲存的編輯會遺失。Bot 將繼續執行。',
  access: '存取',
  accessDesc: '這個控制台設定了存取密碼;登入狀態儲存在目前瀏覽器的 Cookie 裡。',
  signOut: '登出',
  appearance: '外觀',
  appearanceDesc: '控制台主題、明暗模式與自訂配色。',

  pageTitle: '設定',
  sectionsAria: '設定分區',
  navLabel: '設定',
};
