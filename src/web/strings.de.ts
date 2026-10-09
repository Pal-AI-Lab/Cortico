import type { en } from './strings.ts';

export const serverText: Partial<typeof en> = {
  paused: 'Pausiert: Ereignisse werden weiter gespeichert und eingereiht, es wird kein Wecken zugestellt',
  resumed: 'Fortgesetzt: Der Rückstau wird in einem Batch zugestellt',
  exitSupervised: 'Der Prozess wird gleich beendet; der Launcher startet ihn neu',
  exitSupervisedPaused: 'Der Prozess wird gleich beendet; der Launcher startet ihn mit pausierter Ereigniszustellung neu, setze sie im Laufstatus fort',
  exitUnsupervised: 'Der Prozess wird gleich beendet; keine Launcher-Schleife erkannt, daher muss er manuell neu gestartet werden',
  shutdownSkipped: (n: number, labels: string[]) => `Lokales Herunterfahren beendet, aber ${n} ${n === 1 ? 'Schritt wurde' : 'Schritte wurden'} nicht abgeschlossen: ${labels.join(', ')}`,
  shutdownComplete: (n: number) => `Lokales Herunterfahren beendet (${n === 1 ? '1 Schritt' : `alle ${n} Schritte`} abgeschlossen)`,
  externalUnverified: (items: string[]) => `; [P0] ${items.join('; ')}`,
  externalItem: (label: string, status: string, detail: string, manualAction: string) =>
    `${label}=${status} (${detail}). Manuelle Aktion: ${manualAction}`,
  externalVerified: '; alle externen Zustandsprüfungen haben das Ende bestätigt',
};
