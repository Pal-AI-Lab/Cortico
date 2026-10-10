import type { coreGroupEn, validationEn } from './strings.ts';

export const coreGroupText: Partial<typeof coreGroupEn> = {
  title: 'Agrupamento de eventos, raciocínio e logs',
  description: '',
  displayName: {
    title: 'Nome de exibição',
    description: 'Usado no título do console e como nome do remetente nas mensagens que o bot envia. O console aplica na hora; um World montado aplica quando esse World reinicia.',
  },
  quietGap: {
    title: 'Janela de silêncio',
    description: 'Aguarda este tempo após a chegada do último item do lote; os limites de tempo e de tamanho do lote podem antecipar a entrega.',
  },
  minBatchAge: {
    title: 'Tempo mínimo de lote',
    description: 'Aguarda pelo menos este tempo após a chegada do primeiro item do lote; os limites de tempo e de tamanho do lote têm prioridade.',
  },
  maxBatchAge: {
    title: 'Tempo máximo de lote',
    description: 'Limita a espera do agrupamento a esta duração a partir do primeiro item.',
  },
  maxBatchSize: {
    title: 'Tamanho máximo do lote',
    suffix: 'itens',
    description: 'Entrega quando os eventos externos e os candidatos atingem esta quantidade; itens de renderização adiada e piggyback não contam.',
  },
  keepPastThinking: {
    title: 'Manter raciocínio anterior',
    description: 'Permite que o provedor reenvie o raciocínio anterior compatível. Quando desativado, as requisições omitem o raciocínio anterior. As sessões salvas não mudam.',
  },
  logFile: {
    title: 'Limite do arquivo de log',
    description: 'Registros abaixo deste nível não são gravados em data/runs/<run>/log.jsonl.',
  },
  logConsole: {
    title: 'Limite de impressão de logs',
    description: 'Registros abaixo deste nível não são impressos na janela do console.',
  },
  logAreas: {
    title: 'Limites de arquivo por área',
    description: '`área=nível` separados por vírgula, por exemplo `core.loop=trace,console=warn`; `.*` é aceito. Vale o prefixo correspondente mais longo. Áreas sem correspondência usam o limite padrão.',
  },
  usageRate: {
    title: (code: string) => `Câmbio do relatório de uso: ${code}`,
    description: 'Quanto vale 1 USD nesta moeda. Quando “Uso e custo” mostra esta moeda, as chamadas sem preço nela são convertidas por este câmbio; 0 desativa a conversão.',
  },
};

export const validationText: Partial<typeof validationEn> = {
  notNumber: (label: string) => `${label} deve ser um número`,
  below: (label: string, min: number) => `${label} não pode ser menor que ${min}`,
  above: (label: string, max: number) => `${label} não pode ser maior que ${max}`,
  notInEnum: (label: string, options: string) => `${label} deve ser um destes: ${options}`,
  needsPair: (label: string) => `${label} requer dois números`,
  first: (label: string) => `${label} (primeiro valor)`,
  second: (label: string) => `${label} (segundo valor)`,
  pairOrder: (label: string) => `${label}: o primeiro valor não pode exceder o segundo`,
  empty: (label: string) => `${label} não pode ficar vazio`,
};
