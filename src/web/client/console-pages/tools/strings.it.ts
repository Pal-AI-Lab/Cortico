import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  ioGroup: (name: string | undefined) => `Strumenti IO · ${name}`,
  groupCore: 'Azioni native · core',
  groupPersona: 'Strumenti memoria / file · Persona',
  noDescription: '(nessuna descrizione dello strumento)',
  paramCount: (n: number) => `${n} ${n === 1 ? 'parametro' : 'parametri'}`,
  paramHeadPath: 'Percorso',
  paramHeadType: 'Tipo',
  paramHeadConstraint: 'Vincolo',
  paramHeadDesc: 'Descrizione',
  required: 'obbligatorio',
  optional: 'facoltativo',
  noParams: 'Questo strumento non dichiara parametri',
  copySchema: 'Copia schema',
  fullSchema: 'Schema JSON completo',
  toolsTitle: 'Libreria strumenti',
  toolsDesc: 'Definizioni degli strumenti attualmente fornite al modello. Sola lettura.',
  toolCount: (n: number) => `${n} ${n === 1 ? 'strumento' : 'strumenti'}`,
  toolsFilter: 'Filtra per nome o descrizione dello strumento…',
  toolsEmpty: 'La tabella degli strumenti è vuota; compare qui quando parte il ciclo principale',
  loadFailed: (msg: string) => `Endpoint della tabella strumenti non disponibile: ${msg}`,
};
