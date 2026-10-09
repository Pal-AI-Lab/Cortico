import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  ioGroup: (name: string | undefined) => `Outils IO · ${name}`,
  groupCore: 'Actions natives · core',
  groupPersona: 'Outils mémoire / fichiers · Persona',
  noDescription: "(aucune description d'outil)",
  paramCount: (n: number) => `${n} paramètre${n > 1 ? 's' : ''}`,
  paramHeadPath: 'Chemin',
  paramHeadType: 'Type',
  paramHeadConstraint: 'Contrainte',
  paramHeadDesc: 'Description',
  required: 'requis',
  optional: 'facultatif',
  noParams: 'Cet outil ne déclare aucun paramètre',
  copySchema: 'Copier le schéma',
  fullSchema: 'Schéma JSON complet',
  toolsTitle: "Bibliothèque d'outils",
  toolsDesc: 'Définitions des outils actuellement fournies au modèle. Lecture seule.',
  toolCount: (n: number) => `${n} outil${n > 1 ? 's' : ''}`,
  toolsFilter: "Filtrer par nom ou description d'outil…",
  toolsEmpty: 'La table des outils est vide ; elle apparaît ici dès le démarrage de la boucle principale',
  loadFailed: (msg: string) => `Endpoint de la table des outils indisponible : ${msg}`,
};
