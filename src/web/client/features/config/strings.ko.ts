import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  loading: '불러오는 중…',
  optionCurrent: '(현재)',
  ownerPersona: 'Persona',
  chooseFile: '파일 선택',
  chooseDirectory: '디렉터리 선택',
  recommendedDir: (dir: string) => `권장 디렉터리: ${dir}`,
  download: '다운로드',
  on: '켬',
  leaveBlank: '비워 두기',
  saving: '저장 중…',
  saveFailed: (err: string) => '실패: ' + err,
  emptyDefault: '이 페이지에는 설정 항목이 없습니다.',
  noSchema: '제공된 설정 항목이 없습니다.',
  restartWorld: 'World 재시작 후 적용',
  restartProcess: '재시작 후 적용',
  loadFailed: (err: string) => '설정 항목을 불러오지 못했습니다: ' + err,
};
