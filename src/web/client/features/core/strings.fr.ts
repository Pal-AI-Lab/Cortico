import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Diagnostic',
  navGroup: 'Core',
  pageTitle: 'Diagnostic',
  subRun: 'Exécution',
  subRunlog: "Journal d'exécution",
  subData: 'Effacer les données',
  perPage: 'Par page',
  prevPage: '‹ Précédent',
  nextPage: 'Suivant ›',
  shown: (from: number, to: number, total: number, more: boolean) => `${from}–${to} sur ${total}${more ? '+' : ''}`,
  pageOf: (page: number, pages: number, more: boolean) => `${page} / ${pages}${more ? '+' : ''}`,
  sectionSessions: 'Sessions',
  sectionEvents: 'Événements',
  chipDelivered: 'livré ',
  chipRoundsPre: 'ce lot ',
  chipRoundsPost: ' tours',
  subConfig: 'Configuration',
  configEmpty: "Le Core n'a aucun réglage ajustable.",
  netOffline: 'API injoignable',

  // events.ts
  eventsDesc: "Enregistrements d'événements, consultables par l'agent.",
  allSources: 'Toutes les sources',
  sourceTitle: 'Filtrer par source. Les choix proviennent des événements chargés.',
  showArchive: "Afficher l'archive brute",
  showArchiveTitle: 'Inclure les événements archivés qui ne sont pas livrés directement au contexte',
  evHeadTime: 'Heure',
  evHeadSource: 'Source',
  evHeadType: 'Type',
  evHeadText: 'Texte',
  noEvents: "Aucun événement pour l'instant",

  // runlog.ts
  currentRun: 'Exécution actuelle',
  allLevels: 'Tous les niveaux',
  areaPlaceholder: 'Préfixe de zone, par ex. worlds.minecraft', // arch-allow: exemple de préfixe du filtre de zone du journal, texte indicatif seulement
  grepPlaceholder: 'Regex, appliquée au message et à data',
  roundPlaceholder: 'Tour',
  refresh: 'Actualiser',
  logHeadTime: 'Heure',
  logHeadLevel: 'Niveau',
  logHeadArea: 'Zone',
  logHeadMsg: 'Message',
  noLog: 'Aucune entrée de journal',
  copyEntry: "Copier l'entrée",

  // sessions.ts
  sessionsDesc: "Utilisation des tokens et succès de cache de chaque session dans ce processus. Les compteurs repartent de zéro au redémarrage, et seules les 8 dernières sessions temporaires terminées sont conservées. Pour l'historique entre redémarrages, voir « Utilisation et coûts ».",
  sesHeadStatus: 'État',
  sesHeadCalls: 'Appels',
  sesHeadInput: 'tok entrée',
  sesHeadCache: 'Succès de cache',
  sesHeadOutput: 'tok sortie',
  sesHeadMsgs: 'Messages',
  noSessions: "Aucune session pour l'instant",
  running: 'non terminée',
  ended: 'terminée',
};
