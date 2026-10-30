import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Диагностика',
  navGroup: 'Core',
  pageTitle: 'Диагностика',
  subRun: 'Запуск',
  subRunlog: 'Журнал запуска',
  subData: 'Очистка данных',
  perPage: 'На странице',
  prevPage: '‹ Назад',
  nextPage: 'Далее ›',
  shown: (from: number, to: number, total: number, more: boolean) => `Показано ${from}–${to} из ${total}${more ? '+' : ''}`,
  pageOf: (page: number, pages: number, more: boolean) => `${page} / ${pages}${more ? '+' : ''}`,
  sectionSessions: 'Сессии',
  sectionEvents: 'События',
  chipDelivered: 'доставлено ',
  chipRoundsPre: 'этот пакет: ',
  chipRoundsPost: ' раундов',
  subConfig: 'Конфигурация',
  configEmpty: 'У Core нет настраиваемых параметров.',
  netOffline: 'API недоступен',

  // events.ts
  eventsDesc: 'Записи событий, доступные агенту для запросов.',
  allSources: 'Все источники',
  sourceTitle: 'Фильтр по источнику. Варианты берутся из загруженных событий.',
  showArchive: 'Показать сырой архив',
  showArchiveTitle: 'Включить архивные события, которые не доставляются в контекст напрямую',
  evHeadTime: 'Время',
  evHeadSource: 'Источник',
  evHeadType: 'Тип',
  evHeadText: 'Текст',
  noEvents: 'Событий пока нет',

  // runlog.ts
  currentRun: 'Текущий запуск',
  allLevels: 'Все уровни',
  areaPlaceholder: 'Префикс области, например worlds.minecraft', // arch-allow: 日志区域筛选框的示例前缀,只是示意文字
  grepPlaceholder: 'Регулярное выражение по сообщению и данным',
  roundPlaceholder: 'Раунд',
  refresh: 'Обновить',
  logHeadTime: 'Время',
  logHeadLevel: 'Уровень',
  logHeadArea: 'Область',
  logHeadMsg: 'Сообщение',
  noLog: 'Записей журнала нет',
  copyEntry: 'Копировать запись',

  // sessions.ts
  sessionsDesc: 'Расход token и попадания в кэш по каждой сессии этого процесса. После перезапуска счёт начинается с нуля; из завершённых временных сессий хранятся только 8 последних. Историю между перезапусками см. в разделе «Расход и затраты».',
  sesHeadStatus: 'Состояние',
  sesHeadCalls: 'Вызовы',
  sesHeadInput: 'Вход, tok',
  sesHeadCache: 'Попадания в кэш',
  sesHeadOutput: 'Выход, tok',
  sesHeadMsgs: 'Сообщения',
  noSessions: 'Сессий пока нет',
  running: 'не завершена',
  ended: 'завершена',
};
