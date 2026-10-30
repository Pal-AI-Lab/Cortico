import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  protocolMismatch: (server: string, page: string) =>
    `Версия протокола WebUI не совпадает: сервер ${server}, эта страница ${page}.`
    + ' Принудительно обновите страницу.',
  pageFailed: (pageId: string) => `Не удалось открыть «${pageId}»`,
  noPage: (pageId: string) => `Страница WebUI не найдена: «${pageId}»`,
  noPageHint: 'Проверьте адрес страницы и состояние активации модуля.',
  noPanels: (label: string) => `«${label}» не объявляет ни одной панели.`,
  noSuchPanel: (label: string, wanted: string) => `У «${label}» нет панели «${wanted}»`,
  provides: (list: string) => 'Доступные панели: ' + list,
  panelFailed: (title: string) => `Не удалось загрузить панель «${title}»`,
  configEmpty: 'Группы настроек недоступны.',
  backToWorlds: "Назад к расширениям World",
  notInstalled: 'Недоступно',
  notActivated: 'не активировано',
  hidden: 'скрыто',
  reloadPrefix: 'Префикс устарел · нажмите, чтобы перезагрузить',
  undeclaredTools: (names: string) => `Инструменты, не объявленные в describe: ${names}`,
  undeclaredEvents: (names: string) => `События, не объявленные в describe: ${names}`,
  open: 'Открыть',
  configTab: 'Конфигурация',
  promptsTab: 'Шаблоны промптов',
  storageTab: 'Очистка данных',
  toolsTab: 'Инструменты',
  memoryDesc: 'Файлы памяти, которые бот пишет сам, и история каждого изменения.',
  memoryTitle: 'Память',
  personaTitle: 'Персона',
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
