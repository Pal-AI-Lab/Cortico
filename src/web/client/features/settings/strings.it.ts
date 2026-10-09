import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  general: 'Generali',
  generalDesc: 'Preferenze di lingua della console.',
  language: 'Lingua / Language',
  languageDesc: 'Salvata in questo browser; ha effetto dopo il ricaricamento.',
  reloadTitle: "Cambiare la lingua dell'interfaccia?",
  reloadBody: 'La pagina verrà ricaricata e le modifiche non salvate andranno perse. Il bot continuerà a funzionare.',
  access: 'Accesso',
  accessDesc: "Questa console è protetta da una password di accesso; l'accesso resta salvato in un cookie di questo browser.",
  signOut: 'Esci',
  appearance: 'Aspetto',
  appearanceDesc: 'Tema della console, modalità chiara/scura e tavolozze personalizzate.',

  pageTitle: 'Impostazioni',
  sectionsAria: 'Sezioni delle impostazioni',
  navLabel: 'Impostazioni',
};
