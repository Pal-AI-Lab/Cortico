import type { coreGroupEn, validationEn } from './strings.ts';

export const coreGroupText: Partial<typeof coreGroupEn> = {
  title: '이벤트 일괄 처리, 추론, 로그',
  description: '',
  displayName: {
    title: '표시 이름',
    description: '콘솔 제목과 봇이 보내는 메시지의 보낸 사람 이름으로 쓰입니다. 콘솔에는 바로 반영되고, 마운트된 World에는 그 World가 재시작된 뒤 반영됩니다.',
  },
  quietGap: {
    title: '조용한 구간',
    description: '일괄 처리 대상 이벤트는 마지막 항목이 도착한 뒤 이 시간만큼 기다립니다. 배치 시간 한도나 개수 한도에 이르면 더 일찍 전달합니다.',
  },
  minBatchAge: {
    title: '최소 배치 시간',
    description: '일괄 처리 대상 이벤트는 첫 항목이 도착한 뒤 최소 이 시간만큼 기다립니다. 배치 시간 한도와 개수 한도가 우선합니다.',
  },
  maxBatchAge: {
    title: '최대 배치 시간',
    description: '첫 항목이 도착한 뒤 일괄 처리 대기는 이 시간을 넘지 않습니다.',
  },
  maxBatchSize: {
    title: '배치당 한도',
    suffix: '개',
    description: '외부 이벤트와 후보가 이 개수에 이르면 바로 전달합니다. 나중에 본문을 생성하는 항목과 piggyback 항목은 세지 않습니다.',
  },
  keepPastThinking: {
    title: '이전 추론 유지',
    description: '켜면 공급자가 호환되는 이전 추론을 다시 보낼 수 있습니다. 끄면 요청에 이전 추론을 넣지 않습니다. 저장된 세션은 바뀌지 않습니다.',
  },
  logFile: {
    title: '로그 파일 기록 기준',
    description: '이 수준보다 낮은 기록은 data/runs/<run>/log.jsonl에 쓰지 않습니다.',
  },
  logConsole: {
    title: '로그 출력 기준',
    description: '이 수준보다 낮은 기록은 콘솔 창에 출력하지 않습니다.',
  },
  logAreas: {
    title: '영역별 파일 기록 기준 재정의',
    description: '쉼표로 구분한 `영역=수준` 형식입니다. 예: `core.loop=trace,console=warn`. `.*`를 지원합니다. 가장 길게 일치하는 접두사가 우선하며, 일치하지 않는 영역은 기본 기준을 씁니다.',
  },
  usageRate: {
    title: (code: string) => `사용량 보고 환율: ${code}`,
    description: '1 USD가 이 통화로 얼마인지 지정합니다. 「사용량 및 비용」에서 이 통화를 선택하면 이 통화 가격이 없는 호출을 이 환율로 환산합니다. 0이면 환산하지 않습니다.',
  },
};

export const validationText: Partial<typeof validationEn> = {
  notNumber: (label: string) => `${label}은(는) 숫자여야 합니다`,
  below: (label: string, min: number) => `${label}은(는) ${min}보다 작을 수 없습니다`,
  above: (label: string, max: number) => `${label}은(는) ${max}보다 클 수 없습니다`,
  notInEnum: (label: string, options: string) => `${label}은(는) ${options} 중 하나여야 합니다`,
  needsPair: (label: string) => `${label}에는 숫자 두 개가 필요합니다`,
  first: (label: string) => `${label}(첫째 값)`,
  second: (label: string) => `${label}(둘째 값)`,
  pairOrder: (label: string) => `${label}: 첫째 값은 둘째 값보다 클 수 없습니다`,
  empty: (label: string) => `${label}은(는) 비워 둘 수 없습니다`,
};
