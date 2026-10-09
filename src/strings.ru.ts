import type { botEn, assemblyEn } from './strings.ts';

const pluralRules = new Intl.PluralRules('ru');
const plural = (n: number, one: string, few: string, many: string) => {
  const form = pluralRules.select(n);
  return form === 'one' ? one : form === 'many' ? many : few;
};

export const botText: Partial<typeof botEn> = {
  noFile: '(нет файла)',
  storage: {
    events: {
      label: 'Хранилище событий (фрагмент этого запуска)',
      note: 'Очищает события этого запуска и сохраняет события более ранних запусков; курсор не откатывается',
      stat: (count: number, cursor: number, size: string) => `${count} ${plural(count, 'запись', 'записи', 'записей')} (курсор на ${cursor}) / ${size}`,
      cleared: (n: number) => `Очищено событий этого запуска: ${n}`,
    },
    session: {
      label: 'Основная сессия (текущий контекст разговора)',
      note: 'Очищает разговор и заново открывает сессию, сохраняя Memory и хранилище событий. Если идёт обработка пакета, выполняется после её завершения',
      stat: (records: number, ktok: number, size: string) => `${records} ${plural(records, 'запись', 'записи', 'записей')} / ~${ktok}k tok / ${size}`,
      cleared: 'Сессия очищена и открыта заново (системный префикс + вступительное сообщение)',
    },
    runlog: {
      label: 'Журнал запуска (этот запуск)',
      note: 'Очищает журнал этого запуска и сохраняет журналы более ранних запусков. Журнал запуска не попадает в контекст модели',
      cleared: 'Журнал запуска очищен',
    },
    usage: {
      label: 'Журнал расхода token (источник страницы затрат)',
      note: 'Очищает все записи о расходе и стоимости моделей; итоги начнут считаться заново с записей, сделанных после этого. Эти записи не попадают в контекст модели',
      stat: (n: number, size: string) => `${n} ${plural(n, 'запись', 'записи', 'записей')} / ${size}`,
      cleared: (n: number) => `Очищено записей о расходе: ${n}`,
    },
    toolcalls: {
      label: 'Журнал вызовов инструментов (имя инструмента / исходные аргументы / результат)',
      note: 'Очищает журнал вызовов инструментов этого запуска, не меняя результаты инструментов в контексте модели',
      cleared: 'Журнал вызовов инструментов очищен',
    },
    state: {
      label: 'Состояние Core',
      note: 'Очищает состояние Persona, время передачи контекста и записи о последовательных сбоях модели; сохраняет курсор доставки и видимость World',
      stat: (n: number, lastHandoff: string) => `Записей состояния личности: ${n} / последняя передача контекста: ${lastHandoff}`,
      never: 'нет',
      cleared: 'Состояние Core сброшено к значениям по умолчанию',
    },
    wakes: {
      label: 'Постоянные таймеры',
      note: 'Отменяет все таймеры (уведомления не создаются)',
      stat: (n: number) => `Ожидают срабатывания: ${n}`,
      cleared: (n: number) => `Отменено таймеров: ${n}`,
    },
    tracker: {
      label: 'Статистика сессий (расход / попадания в кэш)',
      note: 'Обнуляет статистику и сохраняет записи активных сессий',
      stat: (n: number) => `${n} ${plural(n, 'сессия', 'сессии', 'сессий')}`,
      cleared: 'Статистика сессий обнулена',
    },
    pending: {
      label: 'Ожидающие события',
      note:
        'Отбрасывает ожидающие события и сохраняет записи в архиве. Элементы отложенной отрисовки остаются в очереди; отброшенные элементы не будут доставлены повторно после перезапуска',
      stat: (n: number) => `Ожидают доставки: ${n}`,
      cleared: (n: number) => `Отброшено ожидающих событий: ${n}`,
    },
    media: {
      label: 'Хранилище вложений (изображения и аудио из событий и результатов инструментов)',
      note: 'Удаляет все файлы вложений и сохраняет записи событий и сессий, которые на них ссылаются; от удалённого вложения в контексте остаётся только текстовое описание',
      stat: (n: number, size: string) => `${n} ${plural(n, 'файл', 'файла', 'файлов')} / ${size}`,
      cleared: (n: number) => `Удалено вложений: ${n}`,
    },
  },
  config: {
    unknownGroup: (id: string) => `Нет такой группы настроек: ${id}`,
    updated: (title: string, file: string) => `${title}: обновлено и записано в ${file}`,
  },
  prompts: {
    unknown: (key: string) => `Неизвестный шаблон промпта: ${key}`,
    packageReadOnly: (title: string) => `${title}: шаблон пакета расширения, только для чтения`,
    conflict: (title: string) => `${title}: изменено в другом месте; перезагрузите перед сохранением`,
    saved: (title: string) => `Сохранено: ${title}`,
    savedOverride: (title: string) => `Сохранено переопределение развёртывания для ${title}`,
    notEnvPrompt: (title: string) => `У ${title} нет шаблона по умолчанию для восстановления`,
    alreadyDefault: (title: string) => `${title} уже использует значение World по умолчанию`,
    reset: (title: string) => `Удалено переопределение развёртывания для ${title}`,
  },
  visibility: {
    shown: (id: string) => `${id} снова виден агенту. Доставка событий возобновлена; его сегмент префикса и инструменты вернутся после перезагрузки префикса.`,
    hidden: (id: string) => `${id} теперь скрыт от агента. Новые события больше не пробуждают агента (но по-прежнему сохраняются); его сегмент префикса и инструменты будут убраны после перезагрузки префикса.`,
    prefixReloaded: (kept: number) => `Системный префикс и таблица инструментов перезагружены; сохранено сообщений текущей сессии: ${kept}`,
  },
  shutdown: {
    pause: 'Приостановить доставку событий',
    worlds: 'Остановить World',
    core: 'Остановить Persona',
    modulesTimedOut: 'Истекло время остановки World',
    stepTimedOut: (seconds: number) => `Истекло время ожидания (${seconds} с)`,
    externalState: (worldId: string) => `Внешнее состояние ${worldId}`,
    stopIncomplete: (detail: string) => `Остановка World не завершена, поэтому кэшированную внешнюю проверку использовать нельзя: ${detail}`,
    cacheReadFailed: (detail: string) => `Не удалось прочитать кэшированную проверку выключения: ${detail}`,
    manualCheck: 'Проверьте, остановлен ли соответствующий внешний сервис.',
    llm: 'Остановить экземпляры провайдеров',
    flush: 'Сохранить состояние Core',
    web: 'Закрыть консоль',
    summarySkipped: 'Локальные шаги выключения выполнены не полностью',
    summaryComplete: 'Локальное выключение завершено: все шаги выполнены',
    summaryUnverified: (items: string[]) => `Локальное выключение завершено, но завершение внешнего состояния не подтверждено: ${items.join(', ')} (нужна ручная проверка)`,
  },
};

export const assemblyText: Partial<typeof assemblyEn> = {
  constructFailed: (detail: string) => `Ошибка создания: ${detail}`,
  notImplemented: 'Реализация этого World локально не найдена.',
  unknownWorld: (id: string) => `Неизвестный World: ${id}`,
  alreadyRunning: (label: string) => `${label}: уже включено`,
  prebuilt: (label: string) => `${label}: готовый экземпляр, он не активируется через сборку`,
  activated: (label: string, id: string) => `${label} (${id}): включено`,
  deactivated: (label: string, id: string) => `${label} (${id}): отключено`,
  notActive: (label: string) => `${label}: не активно, перезапускать нечего`,
  restarted: (label: string) => `${label}: перезапущено`,
  toolClash: (other: string, names: string[]) => `Имена инструментов совпадают с ${other}, подключение отклонено: ${names.join(', ')}`,
  toolReserved: (names: string[]) => `Имена инструментов уже заняты Core или Persona, подключение отклонено: ${names.join(', ')}`,
  unbound: 'Слой сборки ещё не привязан к core',
};
