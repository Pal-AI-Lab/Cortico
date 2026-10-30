import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Diagnose',
  navGroup: 'Core',
  pageTitle: 'Diagnose',
  subRun: 'Lauf',
  subRunlog: 'Laufprotokoll',
  subData: 'Daten löschen',
  perPage: 'Pro Seite',
  prevPage: '‹ Zurück',
  nextPage: 'Weiter ›',
  shown: (from: number, to: number, total: number, more: boolean) => `${from}–${to} von ${total}${more ? '+' : ''}`,
  pageOf: (page: number, pages: number, more: boolean) => `${page} / ${pages}${more ? '+' : ''}`,
  sectionSessions: 'Sessions',
  sectionEvents: 'Ereignisse',
  chipDelivered: 'zugestellt ',
  chipRoundsPre: 'dieser Batch ',
  chipRoundsPost: ' Runden',
  subConfig: 'Konfiguration',
  configEmpty: 'Der Core hat keine einstellbaren Werte.',
  netOffline: 'API nicht erreichbar',

  // events.ts
  eventsDesc: 'Ereignisdatensätze, vom Agenten abfragbar.',
  allSources: 'Alle Quellen',
  sourceTitle: 'Nach Quelle filtern. Die Auswahl stammt aus geladenen Ereignissen.',
  showArchive: 'Rohes Archiv anzeigen',
  showArchiveTitle: 'Archivierte Ereignisse einbeziehen, die nicht direkt in den Kontext zugestellt werden',
  evHeadTime: 'Zeit',
  evHeadSource: 'Quelle',
  evHeadType: 'Typ',
  evHeadText: 'Text',
  noEvents: 'Noch keine Ereignisse',

  // runlog.ts
  currentRun: 'Aktueller Lauf',
  allLevels: 'Alle Stufen',
  areaPlaceholder: 'Bereichspräfix, z. B. worlds.minecraft', // arch-allow: Beispielpräfix im Bereichsfilter des Laufprotokolls, nur Platzhaltertext
  grepPlaceholder: 'Regex, prüft Meldung und data',
  roundPlaceholder: 'Runde',
  refresh: 'Aktualisieren',
  logHeadTime: 'Zeit',
  logHeadLevel: 'Stufe',
  logHeadArea: 'Bereich',
  logHeadMsg: 'Meldung',
  noLog: 'Keine Protokolleinträge',
  copyEntry: 'Eintrag kopieren',

  // sessions.ts
  sessionsDesc: 'Token-Verbrauch und Cache-Treffer je Session in diesem Prozess. Die Zähler beginnen beim Neustart bei null, und nur die 8 zuletzt beendeten temporären Sessions bleiben erhalten. Für den Verlauf über Neustarts hinweg siehe „Verbrauch & Kosten“.',
  sesHeadStatus: 'Status',
  sesHeadCalls: 'Aufrufe',
  sesHeadInput: 'Eingabe-tok',
  sesHeadCache: 'Cache-Treffer',
  sesHeadOutput: 'Ausgabe-tok',
  sesHeadMsgs: 'Nachrichten',
  noSessions: 'Noch keine Sessions',
  running: 'nicht beendet',
  ended: 'beendet',
};
