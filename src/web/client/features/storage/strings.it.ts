import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  sectionDisk: 'Persistito in data/ (resta dopo il riavvio)',
  sectionMemory: 'In memoria (azzerato al riavvio)',
  nukeAll: "⚠ Cancella tutta l'archiviazione del server",
  clear: 'Cancella',
  dangerTitle: (label: string) => `⚠ Pericoloso: ${label}`,
  dangerBody: (note: string) => `${note}\n\nCancellare in modo irreversibile?`,
  clearTitle: (label: string) => `Cancellare «${label}»?`,
  cleared: 'Cancellato',
  clearFailed: (err: string) => 'Cancellazione non riuscita: ' + err,
  nukeTitle: "⚠⚠ Cancella tutta l'archiviazione",
  nukeBody: "Cancella ogni elemento di archiviazione sul server, non solo quelli elencati in questa pagina. L'operazione non può essere annullata. Verranno cancellati:",
  partialFailed: (keys: string) => 'Non riuscito in parte: ' + keys,
  nukedAll: (count: number) => `✓ Tutto cancellato (${count} ${count === 1 ? 'elemento' : 'elementi'})`,
  nukeFailed: (err: string) => 'Cancellazione totale non riuscita: ' + err,
  noList: '(Il server non ha montato alcun elenco di archiviazione)',
  empty: 'Questa pagina non ha elementi di archiviazione',
  loadFailed: (err: string) => "Caricamento dell'elenco di archiviazione non riuscito: " + err,
  loading: 'Caricamento…',
};
