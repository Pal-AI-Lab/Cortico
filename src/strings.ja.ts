import type { botEn, assemblyEn } from './strings.ts';

export const botText: Partial<typeof botEn> = {
  noFile: '（ファイルなし）',
  storage: {
    events: {
      label: 'イベントストア（今回の実行の分割ファイル）',
      note: '今回の実行のイベント記録を消去し、以前の実行の記録は残します。カーソルは巻き戻りません',
      stat: (count: number, cursor: number, size: string) => `${count} 件（カーソル ${cursor} まで） / ${size}`,
      cleared: (n: number) => `今回の実行のイベントを ${n} 件消去しました`,
    },
    session: {
      label: 'メインセッション（現在の会話コンテキスト）',
      note: '会話コンテキストを消去してセッションを開き直します。Memory とイベントストアは残します。バッチの処理中はそのバッチの終了後に実行します',
      stat: (records: number, ktok: number, size: string) => `${records} 件 / ~${ktok}k tok / ${size}`,
      cleared: 'セッションを消去して開き直しました（system プレフィックス + 開始メッセージ）',
    },
    runlog: {
      label: '実行ログ（今回の実行）',
      note: '今回の実行のログを消去し、以前の実行のログは残します。実行ログはモデルのコンテキストに入りません',
      cleared: '実行ログを消去しました',
    },
    usage: {
      label: 'token 使用量の記録（コストページのデータ元）',
      note: 'モデルの使用量とコストの記録をすべて消去します。コストページは以降に書き込まれる記録から集計し直します。これらの記録はモデルのコンテキストに入りません',
      stat: (n: number, size: string) => `${n} 件 / ${size}`,
      cleared: (n: number) => `使用量の記録を ${n} 件消去しました`,
    },
    toolcalls: {
      label: 'ツール呼び出しの記録（ツール名 / 元の引数 / 結果）',
      note: '今回の実行のツール呼び出しログを消去します。モデルのコンテキスト内のツール結果は変わりません',
      cleared: 'ツール呼び出しの記録を消去しました',
    },
    state: {
      label: 'Core の状態',
      note: 'Persona の状態、引き継ぎ時刻、モデルの連続失敗の記録を消去します。配信カーソルと World の表示状態は残します',
      stat: (n: number, lastHandoff: string) => `Persona の状態 ${n} 項目 / 前回の引き継ぎ ${lastHandoff}`,
      never: 'なし',
      cleared: 'Core の状態を既定値に戻しました',
    },
    wakes: {
      label: '永続タイマー',
      note: 'すべてのタイマーを取り消します（通知は発生しません）',
      stat: (n: number) => `${n} 個が発火待ち`,
      cleared: (n: number) => `タイマーを ${n} 個取り消しました`,
    },
    tracker: {
      label: 'セッション統計（使用量 / キャッシュヒット）',
      note: '統計をリセットし、実行中のセッションの項目は残します',
      stat: (n: number) => `${n} 個のセッション`,
      cleared: 'セッション統計をリセットしました',
    },
    pending: {
      label: '配信待ちのイベント',
      note:
        '配信待ちのイベントを破棄し、イベントストアの記録は残します。本文を後から生成するキュー項目は残ります。破棄した項目は再起動後も再配信されません',
      stat: (n: number) => `${n} 件が配信待ち`,
      cleared: (n: number) => `配信待ちのイベントを ${n} 件破棄しました`,
    },
    media: {
      label: '添付ファイルストア（イベントとツール結果の画像・音声）',
      note: '添付ファイルをすべて削除し、それらを参照するイベントとセッションの記録は残します。削除された添付ファイルはコンテキスト内に説明文だけが残ります',
      stat: (n: number, size: string) => `${n} 個 / ${size}`,
      cleared: (n: number) => `添付ファイルを ${n} 個削除しました`,
    },
  },
  config: {
    unknownGroup: (id: string) => `この設定グループはありません：${id}`,
    updated: (title: string, file: string) => `${title} を更新し、${file} に書き戻しました`,
  },
  prompts: {
    unknown: (key: string) => `不明なプロンプトテンプレート：${key}`,
    packageReadOnly: (title: string) => `${title} は読み取り専用の拡張パッケージのテンプレートです`,
    conflict: (title: string) => `${title} は別の場所で変更されています。再読み込みしてから保存してください`,
    saved: (title: string) => `${title} を保存しました`,
    savedOverride: (title: string) => `${title} のデプロイ上書きファイルを保存しました`,
    notEnvPrompt: (title: string) => `${title} には復元できる既定のテンプレートがありません`,
    alreadyDefault: (title: string) => `${title} は既に World の既定を使っています`,
    reset: (title: string) => `${title} のデプロイ上書きファイルを削除しました`,
  },
  visibility: {
    shown: (id: string) => `${id} はエージェントから再び見えるようになりました。イベント配信は再開しました。プレフィックスのセクションとツールはプレフィックスの再読み込み後に戻ります。`,
    hidden: (id: string) => `${id} をエージェントから隠しました。新しいイベントでエージェントを起こすことはなくなります（イベントは通常どおり保存されます）。プレフィックスのセクションとツールはプレフィックスの再読み込み後に取り除かれます。`,
    prefixReloaded: (kept: number) => `システムプレフィックスとツール表を再読み込みしました。現在のセッションの既存メッセージ ${kept} 件は保持しています`,
  },
  shutdown: {
    pause: 'イベント配信を一時停止',
    worlds: 'World を停止',
    core: 'Persona を停止',
    modulesTimedOut: 'World の停止がタイムアウトしました',
    stepTimedOut: (seconds: number) => `${seconds} 秒でタイムアウトしました`,
    externalState: (worldId: string) => `${worldId} の外部状態`,
    stopIncomplete: (detail: string) => `World の停止が完了していないため、キャッシュされた外部検証の結果は使えません：${detail}`,
    cacheReadFailed: (detail: string) => `キャッシュされたシャットダウン検証の結果を読み込めませんでした：${detail}`,
    manualCheck: '対応する外部サービスが停止しているか確認してください。',
    llm: 'プロバイダーインスタンスを停止',
    flush: 'Core の状態を保存',
    web: 'コンソールを閉じる',
    summarySkipped: 'ローカルのシャットダウン手順が一部完了していません',
    summaryComplete: 'ローカルのシャットダウン手順がすべて完了しました',
    summaryUnverified: (items: string[]) => `ローカルのシャットダウンは完了しましたが、外部状態の終了は確認できていません：${items.join('、')}（手動での確認が必要）`,
  },
};

export const assemblyText: Partial<typeof assemblyEn> = {
  constructFailed: (detail: string) => `構築に失敗しました：${detail}`,
  notImplemented: 'この World の実装がローカルに見つかりません。',
  unknownWorld: (id: string) => `不明な World：${id}`,
  alreadyRunning: (label: string) => `${label} は既に有効です`,
  prebuilt: (label: string) => `${label} は事前構築されたインスタンスのため、構成層からは有効化しません`,
  activated: (label: string, id: string) => `${label}（${id}）を有効化しました`,
  deactivated: (label: string, id: string) => `${label}（${id}）を無効化しました`,
  notActive: (label: string) => `${label} は有効化されていないため、再起動できるインスタンスがありません`,
  restarted: (label: string) => `${label} を再起動しました`,
  toolClash: (other: string, names: string[]) => `ツール名が ${other} と重複しているため、マウントを拒否しました：${names.join(', ')}`,
  toolReserved: (names: string[]) => `ツール名が Core または Persona で使用済みのため、マウントを拒否しました：${names.join(', ')}`,
  unbound: '構成層はまだ core にバインドされていません',
};
