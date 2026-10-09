import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  ioGroup: (name: string | undefined) => `IO 도구 · ${name}`,
  groupCore: '기본 동작 · core',
  groupPersona: '기억 / 파일 도구 · Persona',
  noDescription: '(도구 설명 없음)',
  paramCount: (n: number) => `매개변수 ${n}개`,
  paramHeadPath: '매개변수 경로',
  paramHeadType: '유형',
  paramHeadConstraint: '제약',
  paramHeadDesc: '설명',
  required: '필수',
  optional: '선택',
  noParams: '이 도구는 매개변수를 선언하지 않았습니다',
  copySchema: 'schema 복사',
  fullSchema: '전체 JSON Schema',
  toolsTitle: '도구 라이브러리',
  toolsDesc: '현재 모델에 제공하는 도구 정의이며 읽기 전용입니다.',
  toolCount: (n: number) => `${n}개`,
  toolsFilter: '도구 이름이나 설명으로 필터…',
  toolsEmpty: '도구 표가 비어 있습니다. 메인 루프가 시작되면 여기에 나타납니다',
  loadFailed: (msg: string) => `도구 표 API를 사용할 수 없습니다: ${msg}`,
};
