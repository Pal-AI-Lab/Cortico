import type { consoleEn, panelEn } from './strings.ts';

export const consoleText: Partial<typeof consoleEn> = {
  orientation: 'Come esiste la Persona e note sulla sua metacognizione.',
  constitution: 'I principi a lungo termine della Persona. Le modifiche hanno effetto dopo il ricaricamento del prefisso di sistema o quando inizia un nuovo contesto.',
  memoryNote: 'Convenzioni di Memory: come sono archiviati i file del bot e quando riemergono da soli.',
  workspaceLabel: 'Area di lavoro (file di memoria scritti dal bot stesso)',
  workspaceNote: "Tutti i file dell'area di lavoro tranne la costituzione vengono eliminati in modo irreversibile; la costituzione e i checkpoint della Persona restano invariati",
  workspaceStat: (n: number) => `${n} file (esclusa la costituzione)`,
  workspaceCleared: (n: number) => `${n} file dell'area di lavoro ${n === 1 ? 'eliminato' : 'eliminati'}; la costituzione resta invariata`,
  firstTurnUser: 'Primo turno · input utente',
  firstTurnUserDesc: "Il messaggio user del primo turno sintetico. Se questo o la risposta è vuoto, l'intero turno non viene inserito.",
  firstTurnThinking: 'Primo turno · ragionamento',
  firstTurnThinkingDesc: "Il ragionamento (reasoning_content) del primo turno assistant sintetico; vuoto = il turno non ne contiene. Il dialetto openai-responses-compat non restituisce il ragionamento, quindi questa parte non viene mai inviata a tali endpoint.",
  firstTurnReply: 'Primo turno · risposta',
  firstTurnReplyDesc: 'Il testo della risposta assistant del primo turno sintetico.',
};
export const panelText: Partial<typeof panelEn> = {
  workspace: 'Area di lavoro',
  workspaceDesc: "Il salvataggio crea un commit nel repository Git dell'area di lavoro, con autore operator.",
  history: 'Cronologia versioni',
};
