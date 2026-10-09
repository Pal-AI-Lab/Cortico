import type { botEn, assemblyEn } from './strings.ts';

export const botText: Partial<typeof botEn> = {
  noFile: '(파일 없음)',
  storage: {
    events: {
      label: '이벤트 저장소(이번 실행의 분할 파일)',
      note: '이번 실행의 이벤트 기록을 지우고 이전 실행의 기록은 남깁니다. 커서는 되돌아가지 않습니다',
      stat: (count: number, cursor: number, size: string) => `${count}건(커서 ${cursor}까지) / ${size}`,
      cleared: (n: number) => `이번 실행의 이벤트 ${n}건을 지웠습니다`,
    },
    session: {
      label: '기본 세션(현재 대화 컨텍스트)',
      note: '대화 컨텍스트를 지우고 세션을 다시 엽니다. Memory와 이벤트 저장소는 남깁니다. 배치를 처리하는 중이면 그 배치가 끝난 뒤 실행합니다',
      stat: (records: number, ktok: number, size: string) => `${records}건 / ~${ktok}k tok / ${size}`,
      cleared: '세션을 비우고 다시 열었습니다(system 프리픽스 + 시작 메시지)',
    },
    runlog: {
      label: '실행 로그(이번 실행)',
      note: '이번 실행의 로그를 지우고 이전 실행의 로그는 남깁니다. 실행 로그는 모델 컨텍스트에 들어가지 않습니다',
      cleared: '실행 로그를 비웠습니다',
    },
    usage: {
      label: 'token 사용량 기록(비용 페이지 데이터 원본)',
      note: '모든 모델 사용량과 비용 기록을 지웁니다. 비용 페이지는 이후 기록되는 항목부터 다시 집계합니다. 이 기록은 모델 컨텍스트에 들어가지 않습니다',
      stat: (n: number, size: string) => `${n}건 / ${size}`,
      cleared: (n: number) => `사용량 기록 ${n}건을 지웠습니다`,
    },
    toolcalls: {
      label: '도구 호출 기록(도구 이름 / 원본 인수 / 결과)',
      note: '이번 실행의 도구 호출 로그를 지웁니다. 모델 컨텍스트 안의 도구 결과는 바뀌지 않습니다',
      cleared: '도구 호출 기록을 비웠습니다',
    },
    state: {
      label: 'Core 상태',
      note: 'Persona 상태, 인계 시간, 모델 연속 실패 기록을 지웁니다. 전달 커서와 World 표시 여부는 남깁니다',
      stat: (n: number, lastHandoff: string) => `Persona 상태 ${n}개 / 마지막 인계 ${lastHandoff}`,
      never: '없음',
      cleared: 'Core 상태를 기본값으로 재설정했습니다',
    },
    wakes: {
      label: '영구 타이머',
      note: '모든 타이머를 취소합니다(알림은 생기지 않음)',
      stat: (n: number) => `${n}개 대기 중`,
      cleared: (n: number) => `타이머 ${n}개를 취소했습니다`,
    },
    tracker: {
      label: '세션 통계(사용량 / 캐시 적중)',
      note: '통계를 0으로 되돌리고 실행 중인 세션 항목은 남깁니다',
      stat: (n: number) => `세션 ${n}개`,
      cleared: '세션 통계를 0으로 되돌렸습니다',
    },
    pending: {
      label: '전달 대기 이벤트',
      note:
        '전달 대기 중인 이벤트를 버리고 이벤트 저장소의 기록은 남깁니다. 본문을 나중에 생성하는 대기열 항목은 남습니다. 버린 항목은 재시작 후에도 다시 전달되지 않습니다',
      stat: (n: number) => `${n}건 전달 대기`,
      cleared: (n: number) => `전달 대기 이벤트 ${n}건을 버렸습니다`,
    },
    media: {
      label: '첨부 파일 저장소(이벤트와 도구 결과의 이미지, 오디오)',
      note: '모든 첨부 파일을 삭제하고, 이를 참조하는 이벤트와 세션 기록은 남깁니다. 삭제된 첨부 파일은 컨텍스트에 텍스트 설명만 남습니다',
      stat: (n: number, size: string) => `${n}개 / ${size}`,
      cleared: (n: number) => `첨부 파일 ${n}개를 삭제했습니다`,
    },
  },
  config: {
    unknownGroup: (id: string) => `이 설정 그룹이 없습니다: ${id}`,
    updated: (title: string, file: string) => `${title}을(를) 업데이트하고 ${file}에 다시 기록했습니다`,
  },
  prompts: {
    unknown: (key: string) => `알 수 없는 프롬프트 템플릿: ${key}`,
    packageReadOnly: (title: string) => `${title}은(는) 읽기 전용 확장 패키지 템플릿입니다`,
    conflict: (title: string) => `${title}이(가) 다른 곳에서 수정되었습니다. 다시 불러온 뒤 저장하세요`,
    saved: (title: string) => `${title}을(를) 저장했습니다`,
    savedOverride: (title: string) => `${title}의 배포 재정의 파일을 저장했습니다`,
    notEnvPrompt: (title: string) => `${title}에는 복원할 기본 템플릿이 없습니다`,
    alreadyDefault: (title: string) => `${title}은(는) 이미 World 기본값을 쓰고 있습니다`,
    reset: (title: string) => `${title}의 배포 재정의 파일을 삭제했습니다`,
  },
  visibility: {
    shown: (id: string) => `${id}이(가) 에이전트에게 다시 보입니다. 이벤트 전달이 재개되었으며, 프리픽스 섹션과 도구는 프리픽스를 다시 불러온 뒤 돌아옵니다.`,
    hidden: (id: string) => `${id}을(를) 에이전트에게서 숨겼습니다. 새 이벤트가 더 이상 에이전트를 깨우지 않습니다(이벤트는 그대로 저장됨). 프리픽스 섹션과 도구는 프리픽스를 다시 불러온 뒤 제거됩니다.`,
    prefixReloaded: (kept: number) => `시스템 프리픽스와 도구 표를 다시 불러왔습니다. 현재 세션의 기존 메시지 ${kept}개는 유지했습니다`,
  },
  shutdown: {
    pause: '이벤트 전달 일시 중지',
    worlds: 'World 중지',
    core: 'Persona 중지',
    modulesTimedOut: 'World 중지 시간 초과',
    stepTimedOut: (seconds: number) => `${seconds}초 후 시간 초과`,
    externalState: (worldId: string) => `${worldId} 외부 상태`,
    stopIncomplete: (detail: string) => `World 중지가 완료되지 않아 캐시된 외부 검증 결과를 쓸 수 없습니다: ${detail}`,
    cacheReadFailed: (detail: string) => `캐시된 종료 검증 결과를 읽지 못했습니다: ${detail}`,
    manualCheck: '해당 외부 서비스가 중지되었는지 확인하세요.',
    llm: '공급자 인스턴스 중지',
    flush: 'Core 상태 저장',
    web: '콘솔 닫기',
    summarySkipped: '로컬 종료 단계 중 일부가 완료되지 않음',
    summaryComplete: '로컬 종료 완료: 모든 단계 완료',
    summaryUnverified: (items: string[]) => `로컬 종료는 끝났지만 외부 상태의 종료가 확인되지 않았습니다: ${items.join(', ')}(직접 확인 필요)`,
  },
};

export const assemblyText: Partial<typeof assemblyEn> = {
  constructFailed: (detail: string) => `생성 실패: ${detail}`,
  notImplemented: '이 World의 구현을 로컬에서 찾지 못했습니다.',
  unknownWorld: (id: string) => `알 수 없는 World: ${id}`,
  alreadyRunning: (label: string) => `${label}은(는) 이미 활성화되어 있습니다`,
  prebuilt: (label: string) => `${label}은(는) 미리 만들어진 인스턴스라 구성 계층에서 활성화하지 않습니다`,
  activated: (label: string, id: string) => `${label}(${id}) 활성화됨`,
  deactivated: (label: string, id: string) => `${label}(${id}) 비활성화됨`,
  notActive: (label: string) => `${label}이(가) 활성화되어 있지 않아 재시작할 인스턴스가 없습니다`,
  restarted: (label: string) => `${label} 재시작됨`,
  toolClash: (other: string, names: string[]) => `도구 이름이 ${other}와(과) 겹쳐 마운트를 거부했습니다: ${names.join(', ')}`,
  toolReserved: (names: string[]) => `도구 이름을 Core나 Persona가 이미 쓰고 있어 마운트를 거부했습니다: ${names.join(', ')}`,
  unbound: '구성 계층이 아직 core에 바인딩되지 않았습니다',
};
