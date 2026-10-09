import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  loading: 'Chargement…',
  optionCurrent: '(actuel)',
  ownerPersona: 'Persona',
  chooseFile: 'Choisir un fichier',
  chooseDirectory: 'Choisir un répertoire',
  recommendedDir: (dir: string) => `Répertoire recommandé : ${dir}`,
  download: 'Télécharger',
  on: 'Activé',
  leaveBlank: 'Laisser vide',
  saving: 'Enregistrement…',
  saveFailed: (err: string) => 'Échec : ' + err,
  emptyDefault: 'Aucun champ de configuration sur cette page.',
  noSchema: 'Aucun champ de configuration fourni.',
  restartWorld: 'appliqué au redémarrage du World',
  restartProcess: 'appliqué au redémarrage',
  loadFailed: (err: string) => 'Échec du chargement de la configuration : ' + err,
};
