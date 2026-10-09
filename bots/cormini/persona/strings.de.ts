import type { consoleEn, panelEn } from './strings.ts';

export const consoleText: Partial<typeof consoleEn> = {
  orientation: 'Wie die Persona existiert, und Hinweise zu ihrer Metakognition.',
  constitution: 'Die langfristigen Grundsätze der Persona. Änderungen gelten nach einem Neuladen des Systempräfixes oder ab einem neuen Kontext.',
  memoryNote: 'Memory-Konventionen: wie die Dateien des Bots gespeichert werden und wann sie von selbst auftauchen.',
  workspaceLabel: 'Arbeitsbereich (Memory-Dateien, die der Bot selbst geschrieben hat)',
  workspaceNote: 'Alle Dateien im Arbeitsbereich außer der Verfassung werden unwiderruflich gelöscht; Verfassung und Persona-Checkpoints bleiben unberührt',
  workspaceStat: (n: number) => `${n} ${n === 1 ? 'Datei' : 'Dateien'} (außer der Verfassung)`,
  workspaceCleared: (n: number) => `${n} ${n === 1 ? 'Datei' : 'Dateien'} im Arbeitsbereich gelöscht; die Verfassung bleibt unberührt`,
  firstTurnUser: 'Erste Runde · Nutzereingabe',
  firstTurnUserDesc: 'Die user-Nachricht der synthetischen ersten Runde. Ist sie oder die Antwort leer, wird die ganze Runde nicht eingefügt.',
  firstTurnThinking: 'Erste Runde · Denkprozess',
  firstTurnThinkingDesc: 'Der Denkprozess (reasoning_content) der synthetischen ersten assistant-Runde; leer = die Runde enthält keinen. Der Dialekt openai-responses-compat gibt keinen Denkprozess zurück, daher wird dieser Teil an solche Endpunkte nie gesendet.',
  firstTurnReply: 'Erste Runde · Antwort',
  firstTurnReplyDesc: 'Der Antworttext des assistant in der synthetischen ersten Runde.',
};
export const panelText: Partial<typeof panelEn> = {
  workspace: 'Arbeitsbereich',
  workspaceDesc: 'Speichern erstellt einen Commit im Git-Repository des Arbeitsbereichs, mit operator als Autor.',
  history: 'Versionsverlauf',
};
