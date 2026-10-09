import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  ioGroup: (name: string | undefined) => `Ferramentas IO · ${name}`,
  groupCore: 'Ações nativas · core',
  groupPersona: 'Ferramentas de memória / arquivos · Persona',
  noDescription: '(sem descrição da ferramenta)',
  paramCount: (n: number) => `${n} ${n === 1 ? 'parâmetro' : 'parâmetros'}`,
  paramHeadPath: 'Caminho',
  paramHeadType: 'Tipo',
  paramHeadConstraint: 'Restrição',
  paramHeadDesc: 'Descrição',
  required: 'obrigatório',
  optional: 'opcional',
  noParams: 'Esta ferramenta não declara parâmetros',
  copySchema: 'Copiar esquema',
  fullSchema: 'JSON Schema completo',
  toolsTitle: 'Biblioteca de ferramentas',
  toolsDesc: 'Definições de ferramentas fornecidas atualmente ao modelo. Somente leitura.',
  toolCount: (n: number) => `${n} ${n === 1 ? 'ferramenta' : 'ferramentas'}`,
  toolsFilter: 'Filtrar por nome ou descrição da ferramenta…',
  toolsEmpty: 'A tabela de ferramentas está vazia; ela aparece aqui quando o loop principal iniciar',
  loadFailed: (msg: string) => `Endpoint da tabela de ferramentas indisponível: ${msg}`,
};
