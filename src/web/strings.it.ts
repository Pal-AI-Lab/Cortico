import type { en } from './strings.ts';

export const serverText: Partial<typeof en> = {
  paused: 'In pausa: gli eventi vengono ancora archiviati e accodati, nessun risveglio viene consegnato',
  resumed: 'Ripreso: gli eventi arretrati vengono consegnati in un unico batch',
  exitSupervised: 'Il processo sta per terminare; il launcher lo riavvierà',
  exitSupervisedPaused: 'Il processo sta per terminare; il launcher lo riavvierà con la consegna degli eventi in pausa, riprendila nello stato di esecuzione',
  exitUnsupervised: 'Il processo sta per terminare; nessun ciclo del launcher rilevato, quindi va riavviato a mano',
  shutdownSkipped: (n: number, labels: string[]) => `Arresto locale terminato, ma ${n} ${n === 1 ? 'passaggio non è stato completato' : 'passaggi non sono stati completati'}: ${labels.join(', ')}`,
  shutdownComplete: (n: number) => `Arresto locale terminato (${n === 1 ? '1 passaggio completato' : `tutti i ${n} passaggi completati`})`,
  externalUnverified: (items: string[]) => `; [P0] ${items.join('; ')}`,
  externalItem: (label: string, status: string, detail: string, manualAction: string) =>
    `${label}=${status} (${detail}). Azione manuale: ${manualAction}`,
  externalVerified: '; tutti i controlli dello stato esterno hanno confermato la fine',
};
