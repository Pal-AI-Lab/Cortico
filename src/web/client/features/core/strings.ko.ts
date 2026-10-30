import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: '실행 진단',
  navGroup: 'Core',
  pageTitle: '실행 진단',
  subRun: '실행',
  subRunlog: '실행 로그',
  subData: '데이터 정리',
  perPage: '페이지당 표시',
  prevPage: '‹ 이전',
  nextPage: '다음 ›',
  shown: (from: number, to: number, total: number, more: boolean) => `전체 ${total}${more ? '+' : ''}개 중 ${from}–${to} 표시`,
  pageOf: (page: number, pages: number, more: boolean) => `${page} / ${pages}${more ? '+' : ''}`,
  sectionSessions: '세션',
  sectionEvents: '이벤트',
  chipDelivered: '전달 ',
  chipRoundsPre: '이번 배치 ',
  chipRoundsPost: '라운드',
  subConfig: '설정',
  configEmpty: 'Core에는 조정할 수 있는 설정이 없습니다.',
  netOffline: 'API에 연결할 수 없음',

  // events.ts
  eventsDesc: '이벤트 기록이며 에이전트가 조회할 수 있습니다.',
  allSources: '모든 소스',
  sourceTitle: '소스로 필터링합니다. 후보는 불러온 이벤트에서 가져옵니다.',
  showArchive: '원본 보관 기록 표시',
  showArchiveTitle: '보관만 되고 컨텍스트에 직접 전달되지 않은 이벤트도 포함',
  evHeadTime: '시간',
  evHeadSource: '소스',
  evHeadType: '유형',
  evHeadText: '본문',
  noEvents: '아직 이벤트가 없습니다',

  // runlog.ts
  currentRun: '현재 실행',
  allLevels: '모든 수준',
  areaPlaceholder: '영역 접두사, 예: worlds.minecraft', // arch-allow: 日志区域筛选框的示例前缀,只是示意文字
  grepPlaceholder: '정규식, 메시지와 data에 일치',
  roundPlaceholder: '라운드',
  refresh: '새로 고침',
  logHeadTime: '시간',
  logHeadLevel: '수준',
  logHeadArea: '영역',
  logHeadMsg: '메시지',
  noLog: '로그 항목이 없습니다',
  copyEntry: '이 항목 복사',

  // sessions.ts
  sessionsDesc: '이 프로세스 안 각 세션의 token 사용량과 캐시 적중입니다. 재시작하면 0부터 다시 세며, 끝난 임시 세션은 최근 8개만 남깁니다. 재시작을 넘는 통계는 "사용량 및 비용"을 확인하세요.',
  sesHeadStatus: '상태',
  sesHeadCalls: '호출',
  sesHeadInput: '입력 tok',
  sesHeadCache: '캐시 적중',
  sesHeadOutput: '출력 tok',
  sesHeadMsgs: '메시지',
  noSessions: '아직 세션이 없습니다',
  running: '진행 중',
  ended: '종료됨',
};
