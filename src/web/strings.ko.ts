import type { en } from './strings.ts';

export const serverText: Partial<typeof en> = {
  paused: '일시 중지됨: 이벤트는 그대로 저장되어 대기열에 쌓이지만 깨우기는 전달되지 않습니다',
  resumed: '재개됨: 쌓인 이벤트를 한 번에 전달합니다',
  exitSupervised: '프로세스가 곧 종료되며 런처가 바로 다시 시작합니다',
  exitSupervisedPaused: '프로세스가 곧 종료되며 런처가 바로 다시 시작합니다. 다시 시작한 뒤에는 이벤트 전달이 일시 중지되어 있으니 실행 상태에서 재개하세요',
  exitUnsupervised: '프로세스가 곧 종료됩니다. 런처 루프가 감지되지 않았으므로 직접 다시 시작해야 합니다',
  shutdownSkipped: (n: number, labels: string[]) => `로컬 종료는 끝났지만 ${n}개 단계가 완료되지 않았습니다: ${labels.join(', ')}`,
  shutdownComplete: (n: number) => `로컬 종료 완료(${n}개 단계 모두 완료)`,
  externalUnverified: (items: string[]) => `; [P0] ${items.join('; ')}`,
  externalItem: (label: string, status: string, detail: string, manualAction: string) =>
    `${label}=${status}(${detail}). 수동 조치: ${manualAction}`,
  externalVerified: '; 외부 상태 점검에서 모두 종료가 확인되었습니다',
};
