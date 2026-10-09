import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  sectionDisk: 'Persisté dans data/ (survit au redémarrage)',
  sectionMemory: 'En mémoire (effacé au redémarrage)',
  nukeAll: '⚠ Effacer tout le stockage du serveur',
  clear: 'Effacer',
  dangerTitle: (label: string) => `⚠ Dangereux : ${label}`,
  dangerBody: (note: string) => `${note}\n\nEffacer de façon irréversible ?`,
  clearTitle: (label: string) => `Effacer « ${label} » ?`,
  cleared: 'Effacé',
  clearFailed: (err: string) => "Échec de l'effacement : " + err,
  nukeTitle: '⚠⚠ Effacer tout le stockage',
  nukeBody: 'Efface tous les éléments de stockage du serveur, pas seulement ceux listés sur cette page. Cette action est irréversible. Seront effacés :',
  partialFailed: (keys: string) => 'Échec partiel : ' + keys,
  nukedAll: (count: number) => `✓ Tout effacé (${count} élément${count > 1 ? 's' : ''})`,
  nukeFailed: (err: string) => "Échec de l'effacement total : " + err,
  noList: "(Le serveur n'a monté aucune liste de stockage)",
  empty: "Cette page n'a aucun élément de stockage",
  loadFailed: (err: string) => 'Échec du chargement de la liste de stockage : ' + err,
  loading: 'Chargement…',
};
