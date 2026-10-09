import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  loading: 'Cargando…',
  optionCurrent: '(actual)',
  ownerPersona: 'Persona',
  chooseFile: 'Elegir archivo',
  chooseDirectory: 'Elegir directorio',
  recommendedDir: (dir: string) => `Directorio recomendado: ${dir}`,
  download: 'Descargar',
  on: 'Activado',
  leaveBlank: 'Dejar vacío',
  saving: 'Guardando…',
  saveFailed: (err: string) => 'Error: ' + err,
  emptyDefault: 'Esta página no tiene campos de configuración.',
  noSchema: 'No se proporcionaron campos de configuración.',
  restartWorld: 'se aplica al reiniciar el World',
  restartProcess: 'se aplica al reiniciar',
  loadFailed: (err: string) => 'No se pudo cargar la configuración: ' + err,
};
