import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  protocolMismatch: (server: string, page: string) =>
    `Versione del protocollo della console non corrispondente: server ${server}, questa pagina ${page}.`
    + ' Forza il ricaricamento della pagina.',
  pageFailed: (pageId: string) => `Impossibile aprire «${pageId}»`,
  noPage: (pageId: string) => `Pagina della console non trovata: «${pageId}»`,
  noPageHint: "Controlla l'indirizzo della pagina e lo stato di attivazione del modulo.",
  noPanels: (label: string) => `«${label}» non dichiara alcun pannello.`,
  noSuchPanel: (label: string, wanted: string) => `«${label}» non ha il pannello «${wanted}»`,
  provides: (list: string) => 'Pannelli disponibili: ' + list,
  panelFailed: (title: string) => `Caricamento del pannello «${title}» non riuscito`,
  configEmpty: 'Gruppi di configurazione non disponibili.',
  configTitle: 'Configurazione',
  configDesc: 'Le modifiche vengono salvate automaticamente in config.json. Le impostazioni che richiedono un riavvio si applicano dopo il riavvio; le altre subito.',
  assembly: 'Assemblaggio',
  notInstalled: 'Non disponibile',
  notActivated: 'non attivato',
  hidden: 'nascosto',
  reloadPrefix: 'Prefisso da ricaricare · clicca per ricaricare',
  open: 'Apri',
  configTab: 'Configurazione',
  promptsTab: 'Template di prompt',
  storageTab: 'Dati',
  toolsTab: 'Strumenti',
  storageTitle: 'Dati',
  storageDesc: 'Elementi di archiviazione dichiarati da questa pagina; cosa copre e restituisce una cancellazione dipende da ciascun elemento.',
  reloadTitle: 'Ricaricare il prefisso di sistema?',
  reloadBody: 'Rilegge tutte le fonti del prefisso e sostituisce il prefisso di sistema della sessione attuale. I messaggi della conversazione esistenti vengono conservati.',
  prefixReloaded: 'Prefisso ricaricato',
  noBundle: (pageId: string) =>
    `Bundle dei pannelli mancante per «${pageId}». Per le pagine del repository, arresta prima il bot, poi esegui pnpm build:web;`
    + ' per i pacchetti in extensions/, esegui la build nella directory del pacchetto e riavvia il processo.',
  badBundleUrl: (pageId: string) => `URL del bundle dei pannelli di «${pageId}» non valido; caricamento rifiutato`,
  bundleLoadFailed: (pageId: string, err: string) => `Caricamento del bundle dei pannelli di «${pageId}» non riuscito: ${err}`,
  badDefaultExport: (pageId: string) => `Il bundle dei pannelli di «${pageId}» non ha un export default valido; atteso { panels: { … } }`,
  none: '(nessuno)',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `Il bundle dei pannelli di «${pageId}» non ha il pannello «${panelId}». Pannelli disponibili: ${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `Il pannello «${panelId}» di «${pageId}» non ha il metodo mount`,
  noBuiltinPanel: (name: string, known: string) =>
    `Pannello integrato «${name}» non trovato. Pannelli disponibili: ${known}`,
};
