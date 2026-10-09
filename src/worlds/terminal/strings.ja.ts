import type { en } from './strings.ts';

export const text: Partial<typeof en> = {
  configTitle: 'ターミナル · コンソール PIN',
  configDescription:
    'PIN はコンソールからの指示を裏付ける認証情報です。World はターミナルの各メッセージに [console|PIN:……] マーカーを自動で付け、'
    + '同じ数字をボットのシステムプレフィックスにも入れて照合させます。一致すれば指示に従い、コンソールを名乗っても一致しないものは通常の外部入力として扱います。'
    + 'オペレーターが PIN を手で入力する必要はなく、他の場所で PIN に触れるべきでもありません。',
  pinTitle: 'コンソール PIN（6 桁の数字）',
  pinDescription:
    '空欄 = 無効：メッセージにマーカーは付かず、プレフィックスにも照合用の PIN はありません。6 桁の数字でない値はすべて未設定として扱います'
    + '（コンソールのバッジには「形式が不正」と表示されます）。',
  lampLabel: '会話チャネル',
  lampOnline: (n: number) => `${n} 人がオンライン`,
  lampNobody: 'オンラインの人はいません',
  badgeOnline: 'オンライン',
  badgeOnlineValue: (n: number) => `${n} 人`,
  badgePin: 'PIN',
  pinEnabled: '有効',
  pinMalformed: '形式が不正',
  pinUnset: '未設定',
  moduleLabel: 'ターミナルでの会話',
  promptDocTitle: 'ターミナル · 環境プロンプト',
  promptDocDescription: 'ターミナルでの会話環境についての常設の事実。',
  pinVarDescription: 'このセッションのコンソール PIN（worlds.terminal.pin）。未設定または形式が不正な場合は、テンプレートの既定の文面に展開されます。',
  greeting: '接続しました。{type:"hello", name:"あなたの名前"} を送信して名乗ってください。',
  botOffline: 'ボットがオフラインになりました',
  left: (name: string) => `${name} が会話から退出しました`,
  joined: (name: string) => `${name} が会話に参加しました`,
  notJson: 'メッセージが有効な JSON ではないため、無視しました',
  malformed: 'メッセージの形式が正しくないため、無視しました',
  emptyName: '名前を空にすることはできません',
  hello: (name: string) => `こんにちは、${name}。`,
  helloFirst: '先に hello を送信して名前を設定してください',
  imagesRejected: (reason: string) => `画像は送信されませんでした：${reason}`,
  botNotConnected: 'ボットがまだ接続されていないため、メッセージは届いていません',
  deliveryFailed: (err: string) => `メッセージは届いていません：${err}`,
  modelBlind: (model: string) => `現在のモデル ${model} は画像を受け付けないため、ボットには各画像の説明文だけが見えます`,
  unknownType: (type: string) => `不明なメッセージの種類：${type}`,
  imagesNotArray: 'images は配列である必要があります',
  tooManyImages: (max: number) => `1 件のメッセージに添付できる画像は最大 ${max} 枚です`,
  unsupportedImage: (mime: string) => `対応していない画像形式：${mime}`,
  imageNoBase64: '画像に base64 の内容がありません',
  imageEmpty: '画像の内容が空です',
  imageTooLarge: (mb: number) => `1 枚の画像が ${mb}MB を超えています`,
  unknownPanel: (panel: string) => `不明なチャネル：${panel}`,
};
