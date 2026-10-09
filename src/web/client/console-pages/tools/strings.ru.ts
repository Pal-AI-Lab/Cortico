import type { en } from './strings.ts';

const pluralRules = new Intl.PluralRules('ru');
const plural = (n: number, one: string, few: string, many: string) => {
  const form = pluralRules.select(n);
  return form === 'one' ? one : form === 'many' ? many : few;
};

export const S: Partial<typeof en> = {
  ioGroup: (name: string | undefined) => `Инструменты IO · ${name}`,
  groupCore: 'Встроенные действия · core',
  groupPersona: 'Инструменты памяти / файлов · Persona',
  noDescription: '(нет описания инструмента)',
  paramCount: (n: number) => `${n} ${plural(n, 'параметр', 'параметра', 'параметров')}`,
  paramHeadPath: 'Путь',
  paramHeadType: 'Тип',
  paramHeadConstraint: 'Ограничение',
  paramHeadDesc: 'Описание',
  required: 'обязательный',
  optional: 'необязательный',
  noParams: 'Этот инструмент не объявляет параметров',
  copySchema: 'Копировать схему',
  fullSchema: 'Полный JSON Schema',
  toolsTitle: 'Библиотека инструментов',
  toolsDesc: 'Определения инструментов, которые сейчас доступны модели. Только для чтения.',
  toolCount: (n: number) => `${n} ${plural(n, 'инструмент', 'инструмента', 'инструментов')}`,
  toolsFilter: 'Фильтр по имени или описанию инструмента…',
  toolsEmpty: 'Таблица инструментов пуста; она появится здесь после запуска главного цикла',
  loadFailed: (msg: string) => `Эндпоинт таблицы инструментов недоступен: ${msg}`,
};
