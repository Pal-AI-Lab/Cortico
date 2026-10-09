import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  general: 'Geral',
  generalDesc: 'Preferências de idioma do console.',
  language: 'Idioma da interface / Language',
  languageDesc: 'Salvo neste navegador; vale após recarregar.',
  reloadTitle: 'Mudar o idioma da interface?',
  reloadBody: 'A página será recarregada e as edições não salvas serão perdidas. O bot continuará em execução.',
  access: 'Acesso',
  accessDesc: 'Este console é protegido por uma senha de acesso; o login fica salvo em um cookie neste navegador.',
  signOut: 'Sair',
  appearance: 'Aparência',
  appearanceDesc: 'Tema do console, modo claro/escuro e paletas personalizadas.',

  pageTitle: 'Configurações',
  sectionsAria: 'Seções das configurações',
  navLabel: 'Configurações',
};
