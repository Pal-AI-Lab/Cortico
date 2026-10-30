import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Diagnostica',
  navGroup: 'Core',
  pageTitle: 'Diagnostica',
  subRun: 'Esecuzione',
  subRunlog: 'Log di esecuzione',
  subData: 'Cancella dati',
  perPage: 'Per pagina',
  prevPage: '‹ Precedente',
  nextPage: 'Successiva ›',
  shown: (from: number, to: number, total: number, more: boolean) => `${from}–${to} di ${total}${more ? '+' : ''}`,
  pageOf: (page: number, pages: number, more: boolean) => `${page} / ${pages}${more ? '+' : ''}`,
  sectionSessions: 'Sessioni',
  sectionEvents: 'Eventi',
  chipDelivered: 'consegnati ',
  chipRoundsPre: 'questo batch ',
  chipRoundsPost: ' turni',
  subConfig: 'Configurazione',
  configEmpty: 'Il Core non ha impostazioni regolabili.',
  netOffline: 'API non raggiungibile',

  // events.ts
  eventsDesc: "Record degli eventi, consultabili dall'agente.",
  allSources: 'Tutte le fonti',
  sourceTitle: 'Filtra per fonte. Le opzioni provengono dagli eventi caricati.',
  showArchive: "Mostra l'archivio grezzo",
  showArchiveTitle: 'Includi gli eventi archiviati non consegnati direttamente al contesto',
  evHeadTime: 'Ora',
  evHeadSource: 'Fonte',
  evHeadType: 'Tipo',
  evHeadText: 'Testo',
  noEvents: 'Ancora nessun evento',

  // runlog.ts
  currentRun: 'Esecuzione attuale',
  allLevels: 'Tutti i livelli',
  areaPlaceholder: 'Prefisso di area, ad es. worlds.minecraft', // arch-allow: prefisso di esempio nel filtro per area del log, solo testo indicativo
  grepPlaceholder: 'Regex, confronta messaggio e data',
  roundPlaceholder: 'Turno',
  refresh: 'Aggiorna',
  logHeadTime: 'Ora',
  logHeadLevel: 'Livello',
  logHeadArea: 'Area',
  logHeadMsg: 'Messaggio',
  noLog: 'Nessuna voce di log',
  copyEntry: 'Copia voce',

  // sessions.ts
  sessionsDesc: 'Uso dei token e hit della cache per ogni sessione in questo processo. I conteggi ripartono da zero al riavvio e vengono conservate solo le 8 sessioni temporanee terminate più recenti. Per la cronologia tra i riavvii, vedi «Uso e costi».',
  sesHeadStatus: 'Stato',
  sesHeadCalls: 'Chiamate',
  sesHeadInput: 'tok in ingresso',
  sesHeadCache: 'Hit della cache',
  sesHeadOutput: 'tok in uscita',
  sesHeadMsgs: 'Messaggi',
  noSessions: 'Ancora nessuna sessione',
  running: 'non terminata',
  ended: 'terminata',
};
