import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  sectionDisk: 'data/ en disco (se conserva al reiniciar)',
  sectionMemory: 'En memoria (se borra al reiniciar)',
  nukeAll: '⚠ Borrar todo el almacenamiento del servidor',
  clear: 'Borrar',
  dangerTitle: (label: string) => `⚠ Peligroso: ${label}`,
  dangerBody: (note: string) => `${note}\n\n¿Borrar de forma irreversible?`,
  clearTitle: (label: string) => `¿Borrar “${label}”?`,
  cleared: 'Borrado',
  clearFailed: (err: string) => 'Error al borrar: ' + err,
  nukeTitle: '⚠⚠ Borrar todo el almacenamiento',
  nukeBody: 'Borra todos los elementos de almacenamiento del servidor, no solo los que aparecen en esta página. No se puede deshacer. Se borrará:',
  partialFailed: (keys: string) => 'Falló en parte: ' + keys,
  nukedAll: (count: number) => `✓ Todo borrado (${count} ${count === 1 ? 'elemento' : 'elementos'})`,
  nukeFailed: (err: string) => 'Error al borrar todo: ' + err,
  noList: '(El servidor no tiene montada una lista de almacenamiento)',
  empty: 'Esta página no tiene elementos de almacenamiento',
  loadFailed: (err: string) => 'No se pudo cargar la lista de almacenamiento: ' + err,
  loading: 'Cargando…',
};
