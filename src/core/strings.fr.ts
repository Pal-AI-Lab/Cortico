import type { coreGroupEn, validationEn } from './strings.ts';

export const coreGroupText: Partial<typeof coreGroupEn> = {
  title: 'Regroupement des événements, raisonnement et journalisation',
  description: '',
  displayName: {
    title: 'Nom affiché',
    description: "Utilisé pour le titre de la console et comme nom d'expéditeur des messages envoyés par le bot. La console l'applique immédiatement ; un World monté le fait au redémarrage de ce World.",
  },
  quietGap: {
    title: 'Fenêtre de calme',
    description: "Attendre ce délai après l'arrivée du dernier élément regroupé ; les limites de durée et de taille du lot peuvent déclencher une livraison plus tôt.",
  },
  minBatchAge: {
    title: 'Âge minimal du lot',
    description: "Attendre au moins ce délai après l'arrivée du premier élément regroupé ; les limites de durée et de taille du lot sont prioritaires.",
  },
  maxBatchAge: {
    title: 'Âge maximal du lot',
    description: 'Limiter le délai de regroupement à cette durée à partir du premier élément.',
  },
  maxBatchSize: {
    title: 'Taille maximale du lot',
    suffix: 'éléments',
    description: 'Livrer lorsque les événements externes et les candidats atteignent ce nombre ; les éléments à rendu différé et piggyback ne sont pas comptés.',
  },
  keepPastThinking: {
    title: 'Conserver le raisonnement passé',
    description: "Autoriser le fournisseur à renvoyer le raisonnement passé compatible. Désactivé, les requêtes omettent le raisonnement passé. Les sessions enregistrées ne changent pas.",
  },
  logFile: {
    title: 'Seuil du fichier journal',
    description: "Les entrées sous ce niveau ne sont pas écrites dans data/runs/<run>/log.jsonl.",
  },
  logConsole: {
    title: "Seuil d'affichage du journal",
    description: "Les entrées sous ce niveau ne sont pas affichées dans la fenêtre de console.",
  },
  logAreas: {
    title: 'Seuils fichier par zone',
    description: "`zone=niveau` séparés par des virgules, par exemple `core.loop=trace,console=warn` ; `.*` est pris en charge. Le préfixe correspondant le plus long s'applique. Les zones sans correspondance utilisent le seuil par défaut.",
  },
  usageRate: {
    title: (code: string) => `Taux du rapport d'utilisation : ${code}`,
    description: "Taux auquel le rapport d'utilisation convertit entre l'USD et cette devise : valeur de 1 USD dans cette devise, au départ le cours médian du 2026-10-10. 0 exclut cette devise de la conversion.",
  },
};
export const validationText: Partial<typeof validationEn> = {
  notNumber: (label: string) => `${label} doit être un nombre`,
  below: (label: string, min: number) => `${label} ne peut pas être en dessous de ${min}`,
  above: (label: string, max: number) => `${label} ne peut pas dépasser ${max}`,
  notInEnum: (label: string, options: string) => `${label} doit être l'une des valeurs ${options}`,
  needsPair: (label: string) => `${label} nécessite deux nombres`,
  first: (label: string) => `${label} (1re valeur)`,
  second: (label: string) => `${label} (2e valeur)`,
  pairOrder: (label: string) => `${label} : la première valeur ne peut pas dépasser la seconde`,
  empty: (label: string) => `${label} ne peut pas être vide`,
};
