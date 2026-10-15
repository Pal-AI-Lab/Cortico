import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  general: 'Général',
  generalDesc: 'Préférences de langue de la WebUI.',
  language: 'Langue / Language',
  languageDesc: 'Enregistré dans ce navigateur ; prend effet après rechargement.',
  reloadTitle: "Changer la langue de l'interface ?",
  reloadBody: 'La page va se recharger et les modifications non enregistrées seront perdues. Le bot continuera de fonctionner.',
  access: 'Accès',
  accessDesc: "Cette WebUI est protégée par un mot de passe d'accès ; la connexion est conservée dans un cookie de ce navigateur.",
  signOut: 'Se déconnecter',
  appearance: 'Apparence',
  appearanceDesc: 'Thème de la WebUI, mode clair/sombre et palettes personnalisées.',

  pageTitle: 'Paramètres',
  sectionsAria: 'Sections des paramètres',
  navLabel: 'Paramètres',
};
