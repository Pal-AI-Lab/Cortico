import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  protocolMismatch: (server: string, page: string) =>
    `Konsolen-Protokollversion stimmt nicht überein: Server ${server}, diese Seite ${page}.`
    + ' Erzwinge ein Neuladen der Seite.',
  pageFailed: (pageId: string) => `„${pageId}“ konnte nicht geöffnet werden`,
  noPage: (pageId: string) => `Konsolenseite nicht gefunden: „${pageId}“`,
  noPageHint: 'Prüfe die Seitenadresse und den Aktivierungsstatus des Moduls.',
  noPanels: (label: string) => `„${label}“ deklariert keine Panels.`,
  noSuchPanel: (label: string, wanted: string) => `„${label}“ hat kein Panel „${wanted}“`,
  provides: (list: string) => 'Verfügbare Panels: ' + list,
  panelFailed: (title: string) => `Panel „${title}“ konnte nicht geladen werden`,
  configEmpty: 'Konfigurationsgruppen nicht verfügbar.',
  configTitle: 'Konfiguration',
  configDesc: 'Änderungen werden automatisch in config.json gespeichert. Als neustartpflichtig markierte Einstellungen gelten nach einem Neustart, alle anderen sofort.',
  assembly: 'Assemblierung',
  notInstalled: 'Nicht verfügbar',
  notActivated: 'nicht aktiviert',
  hidden: 'verborgen',
  reloadPrefix: 'Präfix veraltet · zum Neuladen klicken',
  open: 'Öffnen',
  configTab: 'Konfiguration',
  promptsTab: 'Prompt-Vorlagen',
  storageTab: 'Daten',
  toolsTab: 'Tool-Tabelle',
  storageTitle: 'Daten',
  storageDesc: 'Von dieser Seite deklarierte Speichereinträge; was ein Leeren umfasst und zurückgibt, bestimmt jeder Eintrag selbst.',
  reloadTitle: 'Systempräfix neu laden?',
  reloadBody: 'Liest alle Präfixquellen neu ein und ersetzt das Systempräfix der aktuellen Session. Bestehende Gesprächsnachrichten bleiben erhalten.',
  prefixReloaded: 'Präfix neu geladen',
  noBundle: (pageId: string) =>
    `Panel-Bundle für „${pageId}“ fehlt. Bei Seiten aus dem Repository stoppe zuerst den Bot und führe dann pnpm build:web aus;`
    + ' bei Paketen unter extensions/ baue im Paketverzeichnis und starte den Prozess neu.',
  badBundleUrl: (pageId: string) => `Panel-Bundle-URL von „${pageId}“ ist ungültig; Laden abgelehnt`,
  bundleLoadFailed: (pageId: string, err: string) => `Panel-Bundle von „${pageId}“ konnte nicht geladen werden: ${err}`,
  badDefaultExport: (pageId: string) => `Panel-Bundle von „${pageId}“ hat keinen gültigen default-Export; erwartet { panels: { … } }`,
  none: '(keine)',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `Panel-Bundle von „${pageId}“ enthält kein Panel „${panelId}“. Verfügbare Panels: ${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `Dem Panel „${panelId}“ von „${pageId}“ fehlt die mount-Methode`,
  noBuiltinPanel: (name: string, known: string) =>
    `Integriertes Panel „${name}“ nicht gefunden. Verfügbare Panels: ${known}`,
};
