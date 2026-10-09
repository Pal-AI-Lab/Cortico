import type { en } from './strings.ts';

export const serverText: Partial<typeof en> = {
  paused: '一時停止しました：イベントは通常どおり保存されキューに入りますが、ウェイクは配信されません',
  resumed: '再開しました：滞留していたイベントをまとめて配信します',
  exitSupervised: 'プロセスはまもなく終了し、ランチャーがすぐに再起動します',
  exitSupervisedPaused: 'プロセスはまもなく終了し、ランチャーがすぐに再起動します。再起動後はイベント配信が一時停止しているため、実行状態から再開してください',
  exitUnsupervised: 'プロセスはまもなく終了します。ランチャーのループが検出されなかったため、手動で再起動する必要があります',
  shutdownSkipped: (n: number, labels: string[]) => `ローカルのシャットダウンは完了しましたが、${n} 個の手順が完了していません：${labels.join('、')}`,
  shutdownComplete: (n: number) => `ローカルのシャットダウンが完了しました（全 ${n} 手順が完了）`,
  externalUnverified: (items: string[]) => `。[P0] ${items.join('。')}`,
  externalItem: (label: string, status: string, detail: string, manualAction: string) =>
    `${label}=${status}（${detail}）。手動対応：${manualAction}`,
  externalVerified: '。外部状態のチェックではすべて終了を確認しました',
};
