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
  autoSaves: 'Änderungen werden automatisch gespeichert.',
  saved: 'Gespeichert.',
  worldRestartPending: 'Einige Änderungen wirken erst nach dem Neustart der World.',
  leaveBlank: 'Leer lassen',
  saving: 'Speichert…',
  saveFailed: (err: string) => 'Fehlgeschlagen: ' + err,
  emptyDefault: 'Keine Konfigurationsfelder auf dieser Seite.',
  noSchema: 'Keine Konfigurationsfelder angegeben.',
  restartWorld: 'gilt nach World-Neustart',
  restartProcess: 'gilt nach Neustart',
  loadFailed: (err: string) => 'Konfiguration konnte nicht geladen werden: ' + err,
};
