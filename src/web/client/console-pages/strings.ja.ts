import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  protocolMismatch: (server: string, page: string) =>
    `コンソールのプロトコルバージョンが一致しません：サーバー ${server}、このページ ${page}。`
    + 'ページを強制的に再読み込みしてください。',
  pageFailed: (pageId: string) => `ページ「${pageId}」を開けませんでした`,
  noPage: (pageId: string) => `コンソールのページが見つかりません：「${pageId}」`,
  noPageHint: 'ページのアドレスとモジュールの有効化状態を確認してください。',
  noPanels: (label: string) => `「${label}」はパネルを宣言していません。`,
  noSuchPanel: (label: string, wanted: string) => `「${label}」にはパネル「${wanted}」がありません`,
  provides: (list: string) => '利用できるパネル：' + list,
  panelFailed: (title: string) => `パネル「${title}」を読み込めませんでした`,
  configEmpty: '設定グループを利用できません。',
  configTitle: '設定',
  configDesc: '変更は config.json に自動保存されます。再起動が必要と表示された設定は再起動後に、それ以外はすぐに反映されます。',
  assembly: '構成',
  notInstalled: '利用不可',
  notActivated: '無効',
  hidden: '非表示',
  reloadPrefix: 'プレフィックスの再読み込み待ち · クリックして再読み込み',
  open: '開く',
  configTab: '設定',
  promptsTab: 'プロンプトテンプレート',
  storageTab: 'データ',
  toolsTab: 'ツール',
  storageTitle: 'データ',
  storageDesc: 'このページが宣言しているストレージ項目です。消去の範囲と結果は各項目の実装によって決まります。',
  reloadTitle: 'システムプレフィックスを再読み込みしますか？',
  reloadBody: 'すべてのプレフィックスのソースを読み直し、現在のセッションのシステムプレフィックスを置き換えます。既存の会話は保持されます。',
  prefixReloaded: 'プレフィックスを再読み込みしました',
  noBundle: (pageId: string) =>
    `「${pageId}」のパネルのビルド成果物がありません。リポジトリ内のページは、先にボットを停止してから pnpm build:web を実行してください。`
    + 'extensions/ 以下の拡張機能は、パッケージのディレクトリでビルドしてからプロセスを再起動してください。',
  badBundleUrl: (pageId: string) => `「${pageId}」のパネル成果物の URL が不正なため、読み込みを拒否しました`,
  bundleLoadFailed: (pageId: string, err: string) => `「${pageId}」のパネル成果物を読み込めませんでした：${err}`,
  badDefaultExport: (pageId: string) => `「${pageId}」のパネル成果物に有効な default エクスポートがありません。形式は { panels: { … } } である必要があります`,
  none: '（なし）',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `「${pageId}」のパネル成果物に「${panelId}」がありません。利用できるパネル：${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `「${pageId}」のパネル「${panelId}」に mount メソッドがありません`,
  noBuiltinPanel: (name: string, known: string) =>
    `組み込みパネル「${name}」が見つかりません。利用できるパネル：${known}`,
};
