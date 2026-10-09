import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  ioGroup: (name: string | undefined) => `Herramientas IO · ${name}`,
  groupCore: 'Acciones nativas · core',
  groupPersona: 'Herramientas de memoria / archivos · Persona',
  noDescription: '(sin descripción de la herramienta)',
  paramCount: (n: number) => `${n} ${n === 1 ? 'parámetro' : 'parámetros'}`,
  paramHeadPath: 'Ruta',
  paramHeadType: 'Tipo',
  paramHeadConstraint: 'Restricción',
  paramHeadDesc: 'Descripción',
  required: 'obligatorio',
  optional: 'opcional',
  noParams: 'Esta herramienta no declara parámetros',
  copySchema: 'Copiar esquema',
  fullSchema: 'JSON Schema completo',
  toolsTitle: 'Biblioteca de herramientas',
  toolsDesc: 'Definiciones de herramientas que se proporcionan actualmente al modelo. Solo lectura.',
  toolCount: (n: number) => `${n} ${n === 1 ? 'herramienta' : 'herramientas'}`,
  toolsFilter: 'Filtrar por nombre o descripción de la herramienta…',
  toolsEmpty: 'La tabla de herramientas está vacía; aparecerá aquí cuando se inicie el ciclo principal',
  loadFailed: (msg: string) => `El endpoint de la tabla de herramientas no está disponible: ${msg}`,
};
