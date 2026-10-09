import type { consoleEn, panelEn } from './strings.ts';

const pluralRules = new Intl.PluralRules('ru');
const plural = (n: number, one: string, few: string, many: string) => {
  const form = pluralRules.select(n);
  return form === 'one' ? one : form === 'many' ? many : few;
};

export const consoleText: Partial<typeof consoleEn> = {
  orientation: 'Способ существования Persona и пояснения о её метапознании.',
  constitution: 'Долгосрочные принципы Persona. Изменения вступают в силу после перезагрузки системного префикса или с началом нового контекста.',
  memoryNote: 'Соглашения о памяти: как хранятся файлы бота и когда они всплывают сами.',
  workspaceLabel: 'Рабочая область (файлы памяти, которые бот написал сам)',
  workspaceNote: 'Все файлы рабочей области, кроме конституции, удаляются безвозвратно; конституция и контрольные точки личности не затрагиваются',
  workspaceStat: (n: number) => `${n} ${plural(n, 'файл', 'файла', 'файлов')} (кроме конституции)`,
  workspaceCleared: (n: number) => `${plural(n, 'Удалён', 'Удалено', 'Удалено')} ${n} ${plural(n, 'файл', 'файла', 'файлов')} рабочей области; конституция не затронута`,
  firstTurnUser: 'Первый ход · ввод пользователя',
  firstTurnUserDesc: 'Сообщение пользователя в синтезированном первом ходе. Если оно или ответ пусты, ход целиком не внедряется.',
  firstTurnThinking: 'Первый ход · рассуждение',
  firstTurnThinkingDesc: 'Рассуждение (reasoning_content) синтезированного первого хода ассистента; пусто = ход без рассуждения. Диалект openai-responses-compat не возвращает рассуждения, поэтому на такие эндпоинты эта часть не отправляется.',
  firstTurnReply: 'Первый ход · ответ',
  firstTurnReplyDesc: 'Текст ответа ассистента в синтезированном первом ходе.',
};
export const panelText: Partial<typeof panelEn> = {
  workspace: 'Рабочая область',
  workspaceDesc: 'При сохранении создаётся коммит в Git-репозитории рабочей области от имени operator.',
  history: 'История версий',
  saved: 'Сохранено',
  removed: 'Удалено',
  renamed: 'Переименовано',
  committed: (done: string, hash: string) => `${done}, коммит ${hash}`,
  notCommitted: (done: string) => `${done} (в git не закоммичено: нет изменений или git недоступен)`,
  missingArg: (what: string) => `Не указано: ${what}`,
  movedOrDeleted: 'Файл перемещён или удалён',
  changedBeforeSave: 'Файл изменён в другом месте; перезагрузите его перед сохранением',
  changedBeforeRemove: 'Файл изменён в другом месте; перезагрузите его перед удалением',
  changedBeforeRename: 'Файл изменён в другом месте; перезагрузите его перед переименованием',
  fileMissing: (path: string) => `Файл не существует: ${path}`,
  isDirectory: (path: string) => `${path} — это папка, а не файл`,
  tooLargeToPreview: 'Файл больше 1MB, предпросмотр не показывается',
  binaryFile: 'Двоичный файл, предпросмотр не показывается',
  contentNotString: 'content должен быть строкой',
  nulInText: 'Текст не должен содержать символы NUL',
  tooLargeToSave: 'Файл больше 1MB и не сохранён',
  nameTaken: 'Файл с таким именем уже существует',
  unknownMethod: (panel: string, method: string) => `Неизвестный метод панели: ${panel}.${method}`,
  unknownPanel: (panel: string) => `Неизвестная панель: ${panel}`,
};
