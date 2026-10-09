import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  sectionDisk: 'Persistiert in data/ (übersteht Neustart)',
  sectionMemory: 'Im Arbeitsspeicher (beim Neustart geleert)',
  nukeAll: '⚠ Gesamten Server-Speicher leeren',
  clear: 'Leeren',
  dangerTitle: (label: string) => `⚠ Gefährlich: ${label}`,
  dangerBody: (note: string) => `${note}\n\nUnwiderruflich leeren?`,
  clearTitle: (label: string) => `„${label}“ leeren?`,
  cleared: 'Geleert',
  clearFailed: (err: string) => 'Leeren fehlgeschlagen: ' + err,
  nukeTitle: '⚠⚠ Gesamten Speicher leeren',
  nukeBody: 'Leert jeden Speichereintrag auf dem Server, nicht nur die auf dieser Seite aufgeführten. Das kann nicht rückgängig gemacht werden. Wird geleert:',
  partialFailed: (keys: string) => 'Teilweise fehlgeschlagen: ' + keys,
  nukedAll: (count: number) => `✓ Alles geleert (${count} ${count === 1 ? 'Eintrag' : 'Einträge'})`,
  nukeFailed: (err: string) => 'Alles leeren fehlgeschlagen: ' + err,
  noList: '(Auf dem Server ist keine Speicherliste eingehängt)',
  empty: 'Diese Seite hat keine Speichereinträge',
  loadFailed: (err: string) => 'Speicherliste konnte nicht geladen werden: ' + err,
  loading: 'Lädt…',
};
