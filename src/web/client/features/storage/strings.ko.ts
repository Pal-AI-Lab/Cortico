import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  sectionDisk: '디스크의 data/(재시작 후에도 유지)',
  sectionMemory: '메모리 임시 저장(재시작하면 비워짐)',
  nukeAll: '⚠ 서버 저장소 전체 비우기',
  clear: '지우기',
  dangerTitle: (label: string) => `⚠ 위험한 작업: ${label}`,
  dangerBody: (note: string) => `${note}\n\n되돌릴 수 없습니다. 지우시겠습니까?`,
  clearTitle: (label: string) => `"${label}"을(를) 지우시겠습니까?`,
  cleared: '지웠습니다',
  clearFailed: (err: string) => '지우지 못했습니다: ' + err,
  nukeTitle: '⚠⚠ 저장소 전체 비우기',
  nukeBody: '이 페이지에 표시된 항목뿐 아니라 서버 목록의 모든 저장 항목을 지웁니다. 이 작업은 되돌릴 수 없습니다. 지울 항목:',
  partialFailed: (keys: string) => '일부 실패: ' + keys,
  nukedAll: (count: number) => `✓ 모두 비웠습니다(${count}개 항목)`,
  nukeFailed: (err: string) => '전체 비우기 실패: ' + err,
  noList: '(서버에 저장소 목록이 마운트되어 있지 않음)',
  empty: '이 페이지에는 저장 항목이 없습니다',
  loadFailed: (err: string) => '저장소 목록을 불러오지 못했습니다: ' + err,
  loading: '불러오는 중…',
};
