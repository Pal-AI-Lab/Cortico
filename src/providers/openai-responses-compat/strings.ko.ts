import type { en, panelEn } from './strings.ts';

export const text: Partial<typeof en> = {
  description: 'Responses API 호환 모델 서비스에 연결합니다.',
  extraHeaders: '추가 요청 헤더(JSON 객체)',
  extraBody: '추가 요청 본문(JSON 객체)',
  endpointPath: 'Responses 엔드포인트 경로',
  endpointPathDescription: '공급자 URL 기준 상대 경로이며 기본값은 /responses입니다.',
  endpointPathSlash: '엔드포인트 경로는 /로 시작해야 합니다',
  extraHeadersObject: '추가 요청 헤더는 문자열에서 문자열로 대응하는 객체여야 합니다',
  extraBodyObject: '추가 요청 본문 필드는 객체여야 합니다',
  reasoningReplay: '추론 회신 형식',
  reasoningReplayDescription: 'encrypted는 서명된 블록을, plaintext는 추론 텍스트를 돌려보냅니다. 어느 쪽을 받는지는 엔드포인트에 달려 있으니 확실하지 않으면 테스트하세요.',
  reasoningReplayValue: '추론 회신 형식은 encrypted 또는 plaintext여야 합니다',
  syntheticReasoningText: '합성 추론 텍스트',
  syntheticReasoningTextDescription: (fallback: string) =>
    `plaintext로 회신할 때 출처 기록이 없는 도구 호출 앞에 채워 넣는 추론이며, 모델이 읽습니다. 비워 두면 기본값 "${fallback}"을(를) 씁니다. 엔드포인트는 빈 문자열과 공백뿐인 문자열을 거부합니다.`,
  syntheticReasoningTextValue: '합성 추론 텍스트는 빈 문자열이나 공백뿐일 수 없습니다: 엔드포인트가 요청 전체를 거부합니다',
  reasoningPanel: '추론',
  reasoningPanelDescription: '추론을 업스트림으로 돌려보내는 형식.',
  bodyRequired: '요청 본문이 필요합니다',
  instanceNameRequired: '엔드포인트 이름이 필요합니다',
  unknownPanel: '알 수 없는 패널',
  unknownMethod: '알 수 없는 작업',
  modelRequired: '먼저 모델을 선택하세요',
  thinkingOff: '이 엔드포인트는 추론이 꺼져 있어 회신 형식이 적용되지 않습니다',
};

export const panel: Partial<typeof panelEn> = {
  title: '추론',
  encrypted: '암호화',
  plaintext: '평문',
  detect: '잘 모르겠으니 테스트',
  detecting: '테스트 중',
  saved: '저장했습니다',
  accepted: '수락됨',
  rejected: (status: number | null, error: string) => `거부됨${status ? ` ${status}` : ''}: ${error}`,
  skipped: '테스트 안 함',
  outcome: (bare: string, withReasoning: string) => `추론 없는 합성 호출: ${bare}; 평문 추론 포함: ${withReasoning}`,
  applied: (label: string) => `${label}(으)로 설정했습니다`,
  undetermined: '판단할 수 없어 설정을 바꾸지 않았습니다',
  detected: (outcome: string, conclusion: string) => `${outcome}. ${conclusion}`,
};
