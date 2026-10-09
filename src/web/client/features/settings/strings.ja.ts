import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  general: '一般',
  generalDesc: 'コンソールの言語設定。',
  language: '表示言語 / Language',
  languageDesc: 'このブラウザーにのみ保存され、ページの再読み込み後に反映されます。',
  reloadTitle: '表示言語を切り替えますか？',
  reloadBody: 'ページが再読み込みされ、保存していない編集内容は失われます。ボットは動作を続けます。',
  access: 'アクセス',
  accessDesc: 'このコンソールにはアクセスパスワードが設定されています。ログイン状態はこのブラウザーの Cookie に保存されます。',
  signOut: 'ログアウト',
  appearance: '外観',
  appearanceDesc: 'コンソールのテーマ、ライト／ダークモード、カスタム配色。',

  pageTitle: '設定',
  sectionsAria: '設定のセクション',
  navLabel: '設定',
};
