import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  loading: 'Carregando…',
  optionCurrent: '(atual)',
  ownerPersona: 'Persona',
  chooseFile: 'Escolher arquivo',
  chooseDirectory: 'Escolher diretório',
  recommendedDir: (dir: string) => `Diretório recomendado: ${dir}`,
  download: 'Baixar',
  on: 'Ativado',
  leaveBlank: 'Deixar em branco',
  saving: 'Salvando…',
  saveFailed: (err: string) => 'Falha: ' + err,
  emptyDefault: 'Esta página não tem campos de configuração.',
  noSchema: 'Nenhum campo de configuração fornecido.',
  restartWorld: 'vale após reiniciar o World',
  restartProcess: 'vale após reiniciar',
  loadFailed: (err: string) => 'Falha ao carregar a configuração: ' + err,
};
