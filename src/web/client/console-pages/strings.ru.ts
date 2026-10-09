import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  protocolMismatch: (server: string, page: string) =>
    `Версия протокола консоли не совпадает: сервер ${server}, эта страница ${page}.`
    + ' Принудительно обновите страницу.',
  pageFailed: (pageId: string) => `Не удалось открыть «${pageId}»`,
  noPage: (pageId: string) => `Страница консоли не найдена: «${pageId}»`,
  noPageHint: 'Проверьте адрес страницы и состояние активации модуля.',
  noPanels: (label: string) => `«${label}» не объявляет ни одной панели.`,
  noSuchPanel: (label: string, wanted: string) => `У «${label}» нет панели «${wanted}»`,
  provides: (list: string) => 'Доступные панели: ' + list,
  panelFailed: (title: string) => `Не удалось загрузить панель «${title}»`,
  configEmpty: 'Группы настроек недоступны.',
  configTitle: 'Конфигурация',
  configDesc: 'Изменения автоматически сохраняются в config.json. Параметры с пометкой о перезапуске применяются после перезапуска, остальные сразу.',
  assembly: 'Сборка',
  notInstalled: 'Недоступно',
  notActivated: 'не активировано',
  hidden: 'скрыто',
  reloadPrefix: 'Префикс устарел · нажмите, чтобы перезагрузить',
  open: 'Открыть',
  configTab: 'Конфигурация',
  promptsTab: 'Шаблоны промптов',
  storageTab: 'Данные',
  toolsTab: 'Инструменты',
  storageTitle: 'Данные',
  storageDesc: 'Элементы хранилища, объявленные этой страницей; что охватывает очистка и что она возвращает, определяет каждый элемент.',
  reloadTitle: 'Перезагрузить системный префикс?',
  reloadBody: 'Заново читает все источники префикса и заменяет системный префикс текущей сессии. Существующие сообщения разговора сохраняются.',
  prefixReloaded: 'Префикс перезагружен',
  noBundle: (pageId: string) =>
    `Нет сборки панелей для «${pageId}». Для страниц репозитория сначала остановите бота, затем выполните pnpm build:web;`
    + ' для пакетов в extensions/ соберите пакет в его папке и перезапустите процесс.',
  badBundleUrl: (pageId: string) => `URL сборки панелей «${pageId}» недопустим; загрузка отклонена`,
  bundleLoadFailed: (pageId: string, err: string) => `Не удалось загрузить сборку панелей «${pageId}»: ${err}`,
  badDefaultExport: (pageId: string) => `В сборке панелей «${pageId}» нет корректного экспорта default; ожидается { panels: { … } }`,
  none: '(нет)',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `В сборке панелей «${pageId}» нет панели «${panelId}». Доступные панели: ${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `У панели «${panelId}» страницы «${pageId}» нет метода mount`,
  noBuiltinPanel: (name: string, known: string) =>
    `Встроенная панель «${name}» не найдена. Доступные панели: ${known}`,
};
