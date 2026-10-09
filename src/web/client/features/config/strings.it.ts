import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  loading: 'Caricamento…',
  optionCurrent: '(attuale)',
  ownerPersona: 'Persona',
  chooseFile: 'Scegli file',
  chooseDirectory: 'Scegli directory',
  recommendedDir: (dir: string) => `Directory consigliata: ${dir}`,
  download: 'Scarica',
  on: 'Attivo',
  leaveBlank: 'Lascia vuoto',
  saving: 'Salvataggio…',
  saveFailed: (err: string) => 'Non riuscito: ' + err,
  emptyDefault: 'Nessun campo di configurazione in questa pagina.',
  noSchema: 'Nessun campo di configurazione fornito.',
  restartWorld: 'valido dopo il riavvio del World',
  restartProcess: 'valido dopo il riavvio',
  loadFailed: (err: string) => 'Caricamento della configurazione non riuscito: ' + err,
};
