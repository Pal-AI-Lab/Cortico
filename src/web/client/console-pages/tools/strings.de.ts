import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  ioGroup: (name: string | undefined) => `IO-Tools · ${name}`,
  groupCore: 'Native Aktionen · core',
  groupPersona: 'Memory-/Datei-Tools · Persona',
  noDescription: '(keine Tool-Beschreibung)',
  paramCount: (n: number) => `${n} Parameter`,
  paramHeadPath: 'Pfad',
  paramHeadType: 'Typ',
  paramHeadConstraint: 'Einschränkung',
  paramHeadDesc: 'Beschreibung',
  required: 'erforderlich',
  optional: 'optional',
  noParams: 'Dieses Tool deklariert keine Parameter',
  copySchema: 'Schema kopieren',
  fullSchema: 'Vollständiges JSON-Schema',
  toolsTitle: 'Tool-Bibliothek',
  toolsDesc: 'Aktuelle Tool-Definitionen, die dem Modell bereitgestellt werden. Schreibgeschützt.',
  toolCount: (n: number) => `${n} ${n === 1 ? 'Tool' : 'Tools'}`,
  toolsFilter: 'Nach Tool-Name oder Beschreibung filtern…',
  toolsEmpty: 'Die Tool-Tabelle ist leer; sie erscheint hier, sobald die Hauptschleife startet',
  loadFailed: (msg: string) => `Endpunkt der Tool-Tabelle nicht verfügbar: ${msg}`,
};
