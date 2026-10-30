import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Diagnóstico',
  navGroup: 'Core',
  pageTitle: 'Diagnóstico',
  subRun: 'Execução',
  subRunlog: 'Log de execução',
  subData: 'Limpar dados',
  perPage: 'Por página',
  prevPage: '‹ Anterior',
  nextPage: 'Próxima ›',
  shown: (from: number, to: number, total: number, more: boolean) => `Mostrando ${from}–${to} de ${total}${more ? '+' : ''}`,
  pageOf: (page: number, pages: number, more: boolean) => `${page} / ${pages}${more ? '+' : ''}`,
  sectionSessions: 'Sessões',
  sectionEvents: 'Eventos',
  chipDelivered: 'entregue ',
  chipRoundsPre: 'este lote ',
  chipRoundsPost: ' rodadas',
  subConfig: 'Configuração',
  configEmpty: 'O Core não tem configurações ajustáveis.',
  netOffline: 'API inacessível',

  // events.ts
  eventsDesc: 'Registros de eventos que o agente pode consultar.',
  allSources: 'Todas as fontes',
  sourceTitle: 'Filtre por fonte. As opções vêm dos eventos carregados.',
  showArchive: 'Mostrar arquivo bruto',
  showArchiveTitle: 'Incluir eventos arquivados que não são entregues diretamente ao contexto',
  evHeadTime: 'Hora',
  evHeadSource: 'Fonte',
  evHeadType: 'Tipo',
  evHeadText: 'Texto',
  noEvents: 'Ainda não há eventos',

  // runlog.ts
  currentRun: 'Execução atual',
  allLevels: 'Todos os níveis',
  areaPlaceholder: 'Prefixo de área, ex.: worlds.minecraft', // arch-allow: 日志区域筛选框的示例前缀,只是示意文字
  grepPlaceholder: 'Regex; corresponde à mensagem e aos dados',
  roundPlaceholder: 'Rodada',
  refresh: 'Atualizar',
  logHeadTime: 'Hora',
  logHeadLevel: 'Nível',
  logHeadArea: 'Área',
  logHeadMsg: 'Mensagem',
  noLog: 'Nenhuma entrada de log',
  copyEntry: 'Copiar entrada',

  // sessions.ts
  sessionsDesc: 'Uso de tokens e acertos de cache de cada sessão neste processo. As contagens recomeçam do zero ao reiniciar, e só as 8 sessões temporárias encerradas mais recentes são mantidas. Para o histórico entre reinícios, veja “Uso e custo”.',
  sesHeadStatus: 'Status',
  sesHeadCalls: 'Chamadas',
  sesHeadInput: 'tok de entrada',
  sesHeadCache: 'Acertos de cache',
  sesHeadOutput: 'tok de saída',
  sesHeadMsgs: 'Mensagens',
  noSessions: 'Ainda não há sessões',
  running: 'não encerrada',
  ended: 'encerrada',
};
