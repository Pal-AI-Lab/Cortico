import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  protocolMismatch: (server: string, page: string) =>
    `Version du protocole de la console incohérente : serveur ${server}, cette page ${page}.`
    + ' Forcez le rechargement de la page.',
  pageFailed: (pageId: string) => `Impossible d'ouvrir « ${pageId} »`,
  noPage: (pageId: string) => `Page de console introuvable : « ${pageId} »`,
  noPageHint: "Vérifiez l'adresse de la page et l'état d'activation du module.",
  noPanels: (label: string) => `« ${label} » ne déclare aucun panneau.`,
  noSuchPanel: (label: string, wanted: string) => `« ${label} » n'a pas de panneau « ${wanted} »`,
  provides: (list: string) => 'Panneaux disponibles : ' + list,
  panelFailed: (title: string) => `Échec du chargement du panneau « ${title} »`,
  configEmpty: 'Groupes de configuration indisponibles.',
  configTitle: 'Configuration',
  configDesc: "Les modifications sont enregistrées automatiquement dans config.json. Les réglages marqués comme nécessitant un redémarrage s'appliquent après redémarrage ; les autres s'appliquent immédiatement.",
  assembly: 'Assemblage',
  notInstalled: 'Indisponible',
  notActivated: 'non activé',
  hidden: 'masqué',
  reloadPrefix: 'Préfixe à recharger · cliquez pour recharger',
  open: 'Ouvrir',
  configTab: 'Configuration',
  promptsTab: 'Modèles de prompt',
  storageTab: 'Données',
  toolsTab: 'Outils',
  storageTitle: 'Données',
  storageDesc: "Éléments de stockage déclarés par cette page ; la portée et le résultat d'un effacement dépendent de chaque élément.",
  reloadTitle: 'Recharger le préfixe système ?',
  reloadBody: 'Relit toutes les sources du préfixe et remplace le préfixe système de la session actuelle. Les messages de conversation existants sont conservés.',
  prefixReloaded: 'Préfixe rechargé',
  noBundle: (pageId: string) =>
    `Bundle de panneaux manquant pour « ${pageId} ». Pour les pages du dépôt, arrêtez d'abord le bot, puis lancez pnpm build:web ;`
    + ' pour les paquets sous extensions/, compilez dans le répertoire du paquet et redémarrez le processus.',
  badBundleUrl: (pageId: string) => `URL du bundle de panneaux de « ${pageId} » invalide ; chargement refusé`,
  bundleLoadFailed: (pageId: string, err: string) => `Échec du chargement du bundle de panneaux de « ${pageId} » : ${err}`,
  badDefaultExport: (pageId: string) => `Le bundle de panneaux de « ${pageId} » n'a pas d'export default valide ; attendu { panels: { … } }`,
  none: '(aucun)',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `Le bundle de panneaux de « ${pageId} » n'a pas de panneau « ${panelId} ». Panneaux disponibles : ${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `Le panneau « ${panelId} » de « ${pageId} » n'a pas de méthode mount`,
  noBuiltinPanel: (name: string, known: string) =>
    `Panneau intégré « ${name} » introuvable. Panneaux disponibles : ${known}`,
};
