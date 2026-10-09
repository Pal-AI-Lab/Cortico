import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  protocolMismatch: (server: string, page: string) =>
    `콘솔 프로토콜 버전이 일치하지 않습니다: 서버 ${server}, 이 페이지 ${page}.`
    + ' 페이지를 강력 새로 고침하세요.',
  pageFailed: (pageId: string) => `"${pageId}" 페이지를 열지 못했습니다`,
  noPage: (pageId: string) => `콘솔 페이지를 찾을 수 없습니다: "${pageId}"`,
  noPageHint: '페이지 주소와 모듈 활성화 상태를 확인하세요.',
  noPanels: (label: string) => `"${label}"은(는) 패널을 선언하지 않았습니다.`,
  noSuchPanel: (label: string, wanted: string) => `"${label}"에 "${wanted}" 패널이 없습니다`,
  provides: (list: string) => '사용 가능한 패널: ' + list,
  panelFailed: (title: string) => `"${title}" 패널을 불러오지 못했습니다`,
  configEmpty: '설정 그룹을 사용할 수 없습니다.',
  configTitle: '설정',
  configDesc: '변경 사항은 config.json에 자동 저장됩니다. 재시작이 필요하다고 표시된 설정은 재시작 후에, 나머지는 즉시 적용됩니다.',
  assembly: '구성',
  notInstalled: '사용 불가',
  notActivated: '비활성',
  hidden: '숨김',
  reloadPrefix: '프리픽스 다시 불러오기 대기 · 클릭하여 다시 불러오기',
  open: '열기',
  configTab: '설정',
  promptsTab: '프롬프트 템플릿',
  storageTab: '데이터',
  toolsTab: '도구',
  storageTitle: '데이터',
  storageDesc: '이 페이지가 선언한 저장 항목입니다. 지우는 범위와 결과는 각 항목의 구현에 따라 다릅니다.',
  reloadTitle: '시스템 프리픽스를 다시 불러오시겠습니까?',
  reloadBody: '모든 프리픽스 소스를 다시 읽어 현재 세션의 시스템 프리픽스를 교체합니다. 기존 대화는 유지됩니다.',
  prefixReloaded: '프리픽스를 다시 불러왔습니다',
  noBundle: (pageId: string) =>
    `"${pageId}"의 패널 빌드 결과물이 없습니다. 저장소 안의 페이지는 먼저 봇을 중지한 뒤 pnpm build:web을 실행하세요.`
    + ' extensions/ 아래의 확장은 패키지 디렉터리에서 빌드한 뒤 프로세스를 재시작하세요.',
  badBundleUrl: (pageId: string) => `"${pageId}"의 패널 결과물 URL이 올바르지 않아 불러오기를 거부했습니다`,
  bundleLoadFailed: (pageId: string, err: string) => `"${pageId}"의 패널 결과물을 불러오지 못했습니다: ${err}`,
  badDefaultExport: (pageId: string) => `"${pageId}"의 패널 결과물에 올바른 default 내보내기가 없습니다. 형식은 { panels: { … } }이어야 합니다`,
  none: '(없음)',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `"${pageId}"의 패널 결과물에 "${panelId}"이(가) 없습니다. 사용 가능한 패널: ${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `"${pageId}"의 "${panelId}" 패널에 mount 메서드가 없습니다`,
  noBuiltinPanel: (name: string, known: string) =>
    `기본 제공 패널 "${name}"을(를) 찾을 수 없습니다. 사용 가능한 패널: ${known}`,
};
