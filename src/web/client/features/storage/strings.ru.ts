import type { en } from './strings.ts';

const pluralRules = new Intl.PluralRules('ru');
const plural = (n: number, one: string, few: string, many: string) => {
  const form = pluralRules.select(n);
  return form === 'one' ? one : form === 'many' ? many : few;
};

export const S: Partial<typeof en> = {
  sectionDisk: 'data/ на диске (сохраняется после перезапуска)',
  sectionMemory: 'В памяти (очищается при перезапуске)',
  nukeAll: '⚠ Очистить всё хранилище сервера',
  clear: 'Очистить',
  dangerTitle: (label: string) => `⚠ Опасно: ${label}`,
  dangerBody: (note: string) => `${note}\n\nОчистить безвозвратно?`,
  clearTitle: (label: string) => `Очистить «${label}»?`,
  cleared: 'Очищено',
  clearFailed: (err: string) => 'Не удалось очистить: ' + err,
  nukeTitle: '⚠⚠ Очистить всё хранилище',
  nukeBody: 'Очищает все элементы хранилища на сервере, а не только перечисленные на этой странице. Отменить нельзя. Будет очищено:',
  partialFailed: (keys: string) => 'Частичный сбой: ' + keys,
  nukedAll: (count: number) => `✓ Всё очищено (${count} ${plural(count, 'элемент', 'элемента', 'элементов')})`,
  nukeFailed: (err: string) => 'Не удалось очистить всё: ' + err,
  noList: '(На сервере не подключён список хранилища)',
  empty: 'На этой странице нет элементов хранилища',
  loadFailed: (err: string) => 'Не удалось загрузить список хранилища: ' + err,
  loading: 'Загрузка…',
};
