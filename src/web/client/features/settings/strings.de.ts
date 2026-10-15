import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  general: 'Allgemein',
  generalDesc: 'Spracheinstellungen der WebUI.',
  language: 'Sprache / Language',
  languageDesc: 'In diesem Browser gespeichert; gilt nach dem Neuladen.',
  reloadTitle: 'Oberflächensprache ändern?',
  reloadBody: 'Die Seite wird neu geladen, ungespeicherte Änderungen gehen verloren. Der Bot läuft weiter.',
  access: 'Zugang',
  accessDesc: 'Diese WebUI ist durch ein Zugangspasswort geschützt; die Anmeldung bleibt in einem Cookie in diesem Browser gespeichert.',
  signOut: 'Abmelden',
  appearance: 'Darstellung',
  appearanceDesc: 'WebUI-Theme, Hell-/Dunkelmodus und eigene Farbpaletten.',

  pageTitle: 'Einstellungen',
  sectionsAria: 'Einstellungsbereiche',
  navLabel: 'Einstellungen',
};
