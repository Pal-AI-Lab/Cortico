import type { en } from './strings.ts';

const pluralRules = new Intl.PluralRules('ru');
const plural = (n: number, one: string, few: string, many: string) => {
  const form = pluralRules.select(n);
  return form === 'one' ? one : form === 'many' ? many : few;
};

export const text: Partial<typeof en> = {
  configTitle: 'Терминал · PIN консоли',
  configDescription:
    'PIN подтверждает указания консоли: модуль помечает каждое сообщение терминала меткой '
    + '[console|PIN:……], а те же цифры попадают в её системный префикс для сравнения. При совпадении указание выполняется; '
    + 'всё, что называет себя консолью без совпадения, считается обычным внешним вводом. '
    + 'Операторы никогда не вводят PIN вручную и не должны упоминать его в других местах.',
  pinTitle: 'PIN консоли (шесть цифр)',
  pinDescription:
    'Пусто = отключено: сообщения не получают метку, а в префиксе нет PIN для сравнения. '
    + 'Любое значение, кроме шести цифр, считается незаданным (значок консоли показывает «Неверный формат»).',
  lampLabel: 'Канал чата',
  lampOnline: (n: number) => `В сети: ${n}`,
  lampNobody: 'Никого нет в сети',
  badgeOnline: 'В сети',
  badgeOnlineValue: (n: number) => `${n} ${plural(n, 'человек', 'человека', 'человек')}`,
  badgePin: 'PIN',
  pinEnabled: 'Включён',
  pinMalformed: 'Неверный формат',
  pinUnset: 'Не задан',
  moduleLabel: 'Чат терминала',
  promptDocTitle: 'Терминал · Промпт окружения',
  promptDocDescription: 'Постоянные факты об окружении чата в терминале.',
  pinVarDescription: 'PIN консоли этой сессии (worlds.terminal.pin); если он не задан или имеет неверный формат, подставляется текст шаблона по умолчанию.',
  greeting: 'Подключено. Отправьте {type:"hello", name:"ваше имя"}, чтобы представиться.',
  botOffline: 'бот не в сети',
  left: (name: string) => `${name} покидает чат`,
  joined: (name: string) => `${name} входит в чат`,
  notJson: 'Сообщение не является корректным JSON; проигнорировано',
  malformed: 'Неверный формат сообщения; проигнорировано',
  emptyName: 'Имя не может быть пустым',
  hello: (name: string) => `Здравствуйте, ${name}.`,
  helloFirst: 'Сначала отправьте hello, чтобы задать имя',
  imagesRejected: (reason: string) => `Изображения не отправлены: ${reason}`,
  botNotConnected: 'Бот ещё не подключён; сообщение не доставлено',
  deliveryFailed: (err: string) => `Сообщение не доставлено: ${err}`,
  modelBlind: (model: string) => `Текущая модель ${model} не принимает изображения, поэтому ей доступно только текстовое описание каждого изображения`,
  unknownType: (type: string) => `Неизвестный тип сообщения: ${type}`,
  imagesNotArray: 'images должно быть массивом',
  tooManyImages: (max: number) => `Максимум изображений в одном сообщении: ${max}`,
  unsupportedImage: (mime: string) => `Неподдерживаемый формат изображения: ${mime}`,
  imageNoBase64: 'У изображения нет содержимого base64',
  imageEmpty: 'Содержимое изображения пусто',
  imageTooLarge: (mb: number) => `Изображение больше ${mb} МБ`,
  unknownPanel: (panel: string) => `Неизвестный канал: ${panel}`,
};
