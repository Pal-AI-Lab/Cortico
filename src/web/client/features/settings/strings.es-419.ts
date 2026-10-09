import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  general: 'General',
  generalDesc: 'Preferencias de idioma de la consola.',
  language: 'Idioma de la interfaz / Language',
  languageDesc: 'Se guarda en este navegador; se aplica al recargar.',
  reloadTitle: '¿Cambiar el idioma de la interfaz?',
  reloadBody: 'La página se recargará y se perderán las ediciones sin guardar. El bot seguirá funcionando.',
  access: 'Acceso',
  accessDesc: 'Esta consola está protegida con una contraseña de acceso; la sesión iniciada se guarda en una cookie de este navegador.',
  signOut: 'Cerrar sesión',
  appearance: 'Apariencia',
  appearanceDesc: 'Tema de la consola, modo claro/oscuro y paletas personalizadas.',

  pageTitle: 'Configuración',
  sectionsAria: 'Secciones de configuración',
  navLabel: 'Configuración',
};
