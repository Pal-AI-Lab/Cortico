import type { consoleEn, panelEn } from './strings.ts';

export const consoleText: Partial<typeof consoleEn> = {
  orientation: 'Persona의 존재 방식과 메타인지에 대한 설명.',
  constitution: 'Persona의 장기 원칙. 시스템 프리픽스를 다시 불러오거나 새 컨텍스트를 시작하면 적용됩니다.',
  memoryNote: '기억 규칙: 봇의 파일이 어떻게 저장되고 언제 저절로 떠오르는지.',
  workspaceLabel: '작업 공간(봇이 직접 쓴 기억 파일)',
  workspaceNote: '헌법을 제외한 모든 작업 공간 파일을 되돌릴 수 없게 삭제합니다. 헌법과 인격 체크포인트는 건드리지 않습니다',
  workspaceStat: (n: number) => `파일 ${n}개(헌법 제외)`,
  workspaceCleared: (n: number) => `작업 공간 파일 ${n}개를 삭제했습니다. 헌법은 건드리지 않았습니다`,
  firstTurnUser: '첫 턴 · 사용자 입력',
  firstTurnUserDesc: '합성한 첫 턴의 user 메시지입니다. 이것과 응답 중 하나라도 비어 있으면 턴 전체를 넣지 않습니다.',
  firstTurnThinking: '첫 턴 · 추론',
  firstTurnThinkingDesc: '합성한 첫 assistant 턴의 추론(reasoning_content)입니다. 비어 있으면 그 턴에 추론이 없습니다. openai-responses-compat 방언은 추론을 회신하지 않으므로 이런 엔드포인트에서는 이 부분이 전송되지 않습니다.',
  firstTurnReply: '첫 턴 · 응답',
  firstTurnReplyDesc: '합성한 첫 턴의 assistant 응답 본문입니다.',
};

export const panelText: Partial<typeof panelEn> = {
  workspace: '작업 공간',
  workspaceDesc: '저장하면 operator 이름으로 작업 공간 Git 저장소에 커밋됩니다.',
  history: '버전 기록',
};
