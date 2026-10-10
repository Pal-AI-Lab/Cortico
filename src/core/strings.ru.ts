import type { coreGroupEn, validationEn } from './strings.ts';

export const coreGroupText: Partial<typeof coreGroupEn> = {
  title: 'Пакетирование событий, рассуждения и журнал',
  description: '',
  displayName: {
    title: 'Отображаемое имя',
    description: 'Используется в заголовке консоли и как имя отправителя в сообщениях, которые отправляет бот. Консоль применяет его сразу; подключённый World применяет его после своего перезапуска.',
  },
  quietGap: {
    title: 'Окно тишины',
    description: 'Ожидание после прихода последнего элемента пакета; ограничения пакета по времени и размеру могут ускорить доставку.',
  },
  minBatchAge: {
    title: 'Минимальное время пакета',
    description: 'Ожидание не меньше этого времени после прихода первого элемента пакета; ограничения пакета по времени и размеру имеют приоритет.',
  },
  maxBatchAge: {
    title: 'Максимальное время пакета',
    description: 'Ограничивает задержку пакетирования этим временем от первого элемента.',
  },
  maxBatchSize: {
    title: 'Максимальный размер пакета',
    suffix: 'элем.',
    description: 'Доставка, как только внешние события и кандидаты достигают этого числа; элементы отложенной отрисовки и piggyback не учитываются.',
  },
  keepPastThinking: {
    title: 'Сохранять прошлые рассуждения',
    description: 'Разрешает провайдеру передавать совместимые прошлые рассуждения. Если выключено, запросы не содержат прошлых рассуждений. Сохранённые сессии не меняются.',
  },
  logFile: {
    title: 'Порог записи журнала в файл',
    description: 'Записи ниже этого уровня не пишутся в data/runs/<run>/log.jsonl.',
  },
  logConsole: {
    title: 'Порог вывода журнала',
    description: 'Записи ниже этого уровня не выводятся в окно консоли.',
  },
  logAreas: {
    title: 'Пороги записи в файл по областям',
    description: '`область=уровень` через запятую, например `core.loop=trace,console=warn`; поддерживается `.*`. Применяется самый длинный совпадающий префикс. Для остальных областей действует порог по умолчанию.',
  },
  usageRate: {
    title: (code: string) => `Курс в отчёте о расходе: ${code}`,
    description: 'Сколько стоит 1 USD в этой валюте. Когда «Расход и затраты» показывает эту валюту, вызовы без цены в ней пересчитываются по этому курсу; 0 отключает пересчёт.',
  },
};

export const validationText: Partial<typeof validationEn> = {
  notNumber: (label: string) => `${label}: должно быть числом`,
  below: (label: string, min: number) => `${label}: не может быть меньше ${min}`,
  above: (label: string, max: number) => `${label}: не может быть больше ${max}`,
  notInEnum: (label: string, options: string) => `${label}: допустимые значения ${options}`,
  needsPair: (label: string) => `${label}: нужны два числа`,
  first: (label: string) => `${label} (первое значение)`,
  second: (label: string) => `${label} (второе значение)`,
  pairOrder: (label: string) => `${label}: первое значение не может быть больше второго`,
  empty: (label: string) => `${label}: не может быть пустым`,
};
