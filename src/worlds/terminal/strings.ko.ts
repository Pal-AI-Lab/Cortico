import type { en } from './strings.ts';

export const text: Partial<typeof en> = {
  configTitle: '터미널 · 콘솔 PIN',
  configDescription:
    'PIN은 콘솔 지시를 뒷받침하는 자격 증명입니다. World는 모든 터미널 메시지에 [console|PIN:……] 표시를 자동으로 붙이고, '
    + '같은 숫자를 봇의 시스템 프리픽스에도 넣어 대조하게 합니다. 일치하면 지시를 따르고, 콘솔이라고 주장하지만 일치하지 않으면 일반 외부 입력으로 취급합니다. '
    + '운영자는 PIN을 직접 입력할 필요가 없으며 다른 곳에서 PIN을 언급해서도 안 됩니다.',
  pinTitle: '콘솔 PIN(숫자 여섯 자리)',
  pinDescription:
    '비워 두면 사용 안 함: 메시지에 표시가 붙지 않고 프리픽스에도 대조할 PIN이 없습니다. 숫자 여섯 자리가 아닌 값은 모두 설정되지 않은 것으로 봅니다'
    + '(콘솔 배지에 "형식 오류"로 표시됨).',
  lampLabel: '대화 채널',
  lampOnline: (n: number) => `${n}명 접속 중`,
  lampNobody: '접속한 사람 없음',
  badgeOnline: '접속',
  badgeOnlineValue: (n: number) => `${n}명`,
  badgePin: 'PIN',
  pinEnabled: '사용 중',
  pinMalformed: '형식 오류',
  pinUnset: '설정 안 됨',
  moduleLabel: '터미널 대화',
  promptDocTitle: '터미널 · 환경 프롬프트',
  promptDocDescription: '터미널 대화 환경에 대한 상시 사실.',
  pinVarDescription: '이번 세션의 콘솔 PIN(worlds.terminal.pin)입니다. 설정되지 않았거나 형식이 맞지 않으면 템플릿의 기본 문구로 펼쳐집니다.',
  greeting: '연결되었습니다. {type:"hello", name:"이름"}을 보내 이름을 알려 주세요.',
  botOffline: '봇 오프라인',
  left: (name: string) => `${name} 님이 대화에서 나갔습니다`,
  joined: (name: string) => `${name} 님이 대화에 들어왔습니다`,
  notJson: '메시지가 올바른 JSON이 아니어서 무시했습니다',
  malformed: '메시지 형식이 맞지 않아 무시했습니다',
  emptyName: '이름은 비워 둘 수 없습니다',
  hello: (name: string) => `안녕하세요, ${name} 님.`,
  helloFirst: '먼저 hello를 보내 이름을 설정하세요',
  imagesRejected: (reason: string) => `이미지를 보내지 않았습니다: ${reason}`,
  botNotConnected: '봇이 아직 연결되지 않아 메시지가 전달되지 않았습니다',
  deliveryFailed: (err: string) => `메시지가 전달되지 않았습니다: ${err}`,
  modelBlind: (model: string) => `현재 모델 ${model}은(는) 이미지를 받지 않으므로 봇은 각 이미지의 텍스트 설명만 봅니다`,
  unknownType: (type: string) => `알 수 없는 메시지 유형: ${type}`,
  imagesNotArray: 'images는 배열이어야 합니다',
  tooManyImages: (max: number) => `메시지 하나에 이미지는 최대 ${max}장입니다`,
  unsupportedImage: (mime: string) => `지원하지 않는 이미지 형식: ${mime}`,
  imageNoBase64: '이미지에 base64 내용이 없습니다',
  imageEmpty: '이미지 내용이 비어 있습니다',
  imageTooLarge: (mb: number) => `이미지 한 장이 ${mb}MB를 넘습니다`,
  unknownPanel: (panel: string) => `알 수 없는 채널: ${panel}`,
};
