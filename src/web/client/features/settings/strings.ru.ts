import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  general: 'Общие',
  generalDesc: 'Языковые настройки консоли.',
  language: 'Язык интерфейса / Language',
  languageDesc: 'Сохраняется в этом браузере; вступает в силу после перезагрузки страницы.',
  reloadTitle: 'Сменить язык интерфейса?',
  reloadBody: 'Страница перезагрузится, несохранённые изменения будут потеряны. Бот продолжит работу.',
  access: 'Доступ',
  accessDesc: 'Эта консоль защищена паролем доступа; вход сохраняется в cookie этого браузера.',
  signOut: 'Выйти',
  appearance: 'Внешний вид',
  appearanceDesc: 'Тема консоли, светлый/тёмный режим и пользовательские палитры.',

  pageTitle: 'Настройки',
  sectionsAria: 'Разделы настроек',
  navLabel: 'Настройки',
};
