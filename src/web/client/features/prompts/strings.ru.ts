import type { en } from './strings.ts';

const pluralRules = new Intl.PluralRules('ru');
const plural = (n: number, one: string, few: string, many: string) => {
  const form = pluralRules.select(n);
  return form === 'one' ? one : form === 'many' ? many : few;
};

export const S: Partial<typeof en> = {
  // index.ts
  title: 'Системный промпт',
  introDesc: 'Ctrl+S сохраняет шаблоны; перезагрузите, чтобы обновить префикс текущей сессии. Разделы из кода доступны только для чтения.',
  reloadSession: 'Перезагрузить текущую сессию',
  reloading: 'Перезагрузка…',
  prefixReloaded: 'Префикс перезагружен',
  leaveUnsaved: 'Несохранённые изменения будут потеряны. Уйти?',
  saving: 'Сохранение…',
  saved: 'Сохранено',
  saveFailedFor: (title: string, msg: string) => `Не удалось сохранить ${title}: ${msg}`,
  savedList: (names: string) => `✓ Сохранено: ${names}; вступит в силу после перезагрузки`,
  dirtyCount: (n: number) => `Несохранённых изменений: ${n} (Ctrl+S)`,
  fillNowMultiline: 'Текущее значение (многострочный блок)',
  fillNow: 'Текущее значение',
  varUnreported: 'Переменная не передана; её заполнитель остаётся без изменений.',
  varEmpty: '(сейчас пусто; используется текст по умолчанию)',
  flagEditable: (key, origin) =>
    `Редактируемый: ${key}${origin === 'deployment' ? ' (переопределение этого развёртывания)' : origin === 'package' ? ' (переопределение пакета; при сохранении станет переопределением этого развёртывания)' : origin === 'module' ? ' (значение World по умолчанию; при сохранении станет переопределением этого развёртывания)' : ''}`,
  flagReadonly: 'Из кода, только для чтения',
  sourceMissing: (key: string) => `Источник «${key}» не найден`,
  fromCode: 'Из кода',
  originDeployment: 'Переопределение этого развёртывания',
  originPackage: 'Переопределение пакета бота',
  originWorld: 'Значение World по умолчанию',
  listSep: ', ',
  warnSep: '; ',
  prefixEmpty: 'Сейчас префикс пуст',
  prefixUnavailable: 'Предпросмотр префикса недоступен.',
  prefixStats: (n: number, tok: string) => `${n} ${plural(n, 'блок', 'блока', 'блоков')} · после отрисовки около ${tok} token`,
  loadFailed: (msg: string) => `Ошибка загрузки: ${msg}`,

  // view.ts
  warnUnknownVars: (list: string) => `Для ${list} не передано значение; заполнители остаются без изменений`,
  warnUnusedVars: (list: string) => `${list}: объявлено, но не используется`,
  varPanelTitle: 'Заполнители этого шаблона',
  multiline: 'многострочный',
  varUnreportedShort: 'Переменная не передана',
  varEmptyShort: '(сейчас пусто; используется текст по умолчанию)',
  leaveUnsavedNamed: (names: string) => `Есть несохранённые изменения шаблонов (${names}). Уйти и отменить их?`,
  editableTemplate: 'редактируемый шаблон',
  cardDescDefault: 'Сохраняется в исходный файл; для текущей сессии вступает в силу после перезагрузки системного префикса.',
  loadedFromDeployment: 'Загружено переопределение развёртывания.',
  loadedFromPackage: 'Загружено переопределение пакета бота; при сохранении записывается переопределение развёртывания.',
  loadedFromWorld: 'Загружено значение World по умолчанию; при сохранении записывается переопределение развёртывания.',
  loadedFromSource: 'Загружено из исходного файла',
  unsaved: '● Не сохранено',
  saveToFile: 'Сохранить в файл',
  resetToWorld: 'Удалить переопределение развёртывания',
  savedResult: (result: string) => `✓ ${result}; вступит в силу после перезагрузки префикса`,
  saveFailed: (msg: string) => `Не удалось сохранить: ${msg}`,
  saveFailedToast: 'Не удалось сохранить',
  resetTitle: (title: string) => `Удалить переопределение развёртывания для «${title}»?`,
  resetBody: 'После удаления используется переопределение пакета бота, а если в пакете его нет, значение World по умолчанию. Несохранённые изменения будут потеряны.',
  resetting: 'Восстановление…',
  resetDone: 'Переопределение развёртывания удалено',
  resetFailed: (msg: string) => `Не удалось восстановить: ${msg}`,
  resetFailedToast: 'Не удалось восстановить',
  noTemplatesScoped: 'У этого владельца нет редактируемых шаблонов',
  noTemplates: 'Нет редактируемых шаблонов промптов',
  templatesLoadFailed: (msg: string) => `Не удалось загрузить шаблоны: ${msg}`,

  // editor.ts
  saveHintDirty: 'Ctrl+S, чтобы сохранить',
};
