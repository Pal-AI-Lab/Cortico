import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  loading: 'Lädt…',
  optionCurrent: '(aktuell)',
  ownerPersona: 'Persona',
  chooseFile: 'Datei wählen',
  chooseDirectory: 'Verzeichnis wählen',
  recommendedDir: (dir: string) => `Empfohlenes Verzeichnis: ${dir}`,
  download: 'Herunterladen',
  on: 'An',
  leaveBlank: 'Leer lassen',
  saving: 'Speichert…',
  saveFailed: (err: string) => 'Fehlgeschlagen: ' + err,
  emptyDefault: 'Keine Konfigurationsfelder auf dieser Seite.',
  noSchema: 'Keine Konfigurationsfelder angegeben.',
  restartWorld: 'gilt nach World-Neustart',
  restartProcess: 'gilt nach Neustart',
  loadFailed: (err: string) => 'Konfiguration konnte nicht geladen werden: ' + err,
};
