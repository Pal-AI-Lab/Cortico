import type { botEn, assemblyEn } from './strings.ts';

const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const botText: Partial<typeof botEn> = {
  noFile: '(nenhum arquivo)',
  storage: {
    events: {
      label: 'Armazenamento de eventos (fragmento desta execução)',
      note: 'Limpa os eventos desta execução e mantém os de execuções anteriores; o cursor não retrocede',
      stat: (count: number, cursor: number, size: string) => `${count} ${s(count, 'registro', 'registros')} (cursor em ${cursor}) / ${size}`,
      cleared: (n: number) => (n === 1 ? '1 evento desta execução foi limpo' : `${n} eventos desta execução foram limpos`),
    },
    session: {
      label: 'Sessão principal (contexto da conversa atual)',
      note: 'Limpa a conversa e reabre a sessão, mantendo a Memory e o armazenamento de eventos. Se um lote estiver em andamento, executa depois que ele terminar',
      stat: (records: number, ktok: number, size: string) => `${records} ${s(records, 'registro', 'registros')} / ~${ktok}k tok / ${size}`,
      cleared: 'Sessão limpa e reaberta (prefixo de sistema + mensagem de abertura)',
    },
    runlog: {
      label: 'Log de execução (esta execução)',
      note: 'Limpa os logs desta execução e mantém os de execuções anteriores. Os logs de execução não entram no contexto do modelo',
      cleared: 'Log de execução limpo',
    },
    usage: {
      label: 'Registro de uso de tokens (fonte da página de custos)',
      note: 'Limpa todos os registros de uso e custo dos modelos; os totais recomeçam com os registros gravados depois. Esses registros não entram no contexto do modelo',
      stat: (n: number, size: string) => `${n} ${s(n, 'registro', 'registros')} / ${size}`,
      cleared: (n: number) => (n === 1 ? '1 registro de uso foi limpo' : `${n} registros de uso foram limpos`),
    },
    toolcalls: {
      label: 'Registro de chamadas de ferramentas (nome da ferramenta / argumentos brutos / resultado)',
      note: 'Limpa os logs de chamadas de ferramentas desta execução sem alterar os resultados de ferramentas no contexto do modelo',
      cleared: 'Registro de chamadas de ferramentas limpo',
    },
    state: {
      label: 'Estado do Core',
      note: 'Limpa o estado da Persona, o horário da transferência e os registros de falhas consecutivas do modelo; mantém o cursor de entrega e a visibilidade dos Worlds',
      stat: (n: number, lastHandoff: string) => `${n} ${s(n, 'entrada', 'entradas')} de estado da personalidade / última transferência ${lastHandoff}`,
      never: 'nenhuma',
      cleared: 'Estado do Core redefinido para o padrão',
    },
    wakes: {
      label: 'Temporizadores persistentes',
      note: 'Cancela todos os temporizadores (nenhuma notificação é gerada)',
      stat: (n: number) => `${n} ${s(n, 'pendente', 'pendentes')}`,
      cleared: (n: number) => (n === 1 ? '1 temporizador cancelado' : `${n} temporizadores cancelados`),
    },
    tracker: {
      label: 'Estatísticas de sessões (uso / acertos de cache)',
      note: 'Zera as estatísticas e mantém as entradas das sessões ativas',
      stat: (n: number) => `${n} ${s(n, 'sessão', 'sessões')}`,
      cleared: 'Estatísticas de sessões zeradas',
    },
    pending: {
      label: 'Eventos pendentes',
      note:
        'Descarta os eventos pendentes e mantém os registros arquivados. Itens de renderização adiada continuam na fila; itens descartados não serão reenviados após reiniciar',
      stat: (n: number) => `${n} ${s(n, 'pendente', 'pendentes')}`,
      cleared: (n: number) => (n === 1 ? '1 evento pendente descartado' : `${n} eventos pendentes descartados`),
    },
    media: {
      label: 'Armazenamento de anexos (imagens e áudio de eventos e resultados de ferramentas)',
      note: 'Exclui todos os arquivos de anexo e mantém os registros de eventos e de sessão que os referenciam; um anexo excluído deixa apenas sua descrição em texto no contexto',
      stat: (n: number, size: string) => `${n} ${s(n, 'arquivo', 'arquivos')} / ${size}`,
      cleared: (n: number) => (n === 1 ? '1 anexo excluído' : `${n} anexos excluídos`),
    },
  },
  config: {
    unknownGroup: (id: string) => `Grupo de configuração inexistente: ${id}`,
    updated: (title: string, file: string) => `${title} atualizado e gravado em ${file}`,
  },
  prompts: {
    unknown: (key: string) => `Modelo de prompt desconhecido: ${key}`,
    packageReadOnly: (title: string) => `${title} é um modelo somente leitura de um pacote de extensão`,
    conflict: (title: string) => `${title} foi modificado em outro lugar; recarregue antes de salvar`,
    saved: (title: string) => `${title} salvo`,
    savedOverride: (title: string) => `Substituição da implantação salva para ${title}`,
    notEnvPrompt: (title: string) => `${title} não tem um modelo padrão para restaurar`,
    alreadyDefault: (title: string) => `${title} já usa o padrão do World`,
    reset: (title: string) => `Substituição da implantação removida para ${title}`,
  },
  visibility: {
    shown: (id: string) => `${id} está visível para o agente novamente. A entrega de eventos foi retomada; o segmento de prefixo e as ferramentas voltam quando o prefixo for recarregado.`,
    hidden: (id: string) => `${id} agora está oculto para o agente. Novos eventos não despertam mais o agente (continuam sendo armazenados); o segmento de prefixo e as ferramentas são removidos quando o prefixo for recarregado.`,
    prefixReloaded: (kept: number) => `Prefixo de sistema e tabela de ferramentas recarregados; ${kept === 1 ? '1 mensagem existente da sessão atual mantida' : `${kept} mensagens existentes da sessão atual mantidas`}`,
  },
  shutdown: {
    pause: 'Pausar a entrega de eventos',
    worlds: 'Parar os Worlds',
    core: 'Parar a Persona',
    modulesTimedOut: 'Tempo esgotado ao parar os Worlds',
    externalState: (worldId: string) => `Estado externo de ${worldId}`,
    stopIncomplete: (detail: string) => `A parada do World não terminou, então a verificação externa em cache não pode ser usada: ${detail}`,
    cacheReadFailed: (detail: string) => `Falha ao ler a verificação de desligamento em cache: ${detail}`,
    manualCheck: 'Verifique se o serviço externo correspondente parou.',
    llm: 'Parar as instâncias de provedor',
    flush: 'Salvar o estado do Core',
    web: 'Fechar o console',
    summarySkipped: 'Etapas de desligamento local incompletas',
    summaryComplete: 'Desligamento local concluído: todas as etapas foram concluídas',
    summaryUnverified: (items: string[]) => `O desligamento local terminou, mas não foi confirmado que o estado externo terminou: ${items.join(', ')} (requer confirmação manual)`,
  },
};

export const assemblyText: Partial<typeof assemblyEn> = {
  constructFailed: (detail: string) => `Falha na construção: ${detail}`,
  notImplemented: 'Nenhuma implementação deste World foi encontrada localmente.',
  unknownWorld: (id: string) => `World desconhecido: ${id}`,
  alreadyRunning: (label: string) => `${label} já está ativado`,
  prebuilt: (label: string) => `${label} é uma instância pré-construída e não é ativada pela montagem`,
  activated: (label: string, id: string) => `${label} (${id}) ativado`,
  deactivated: (label: string, id: string) => `${label} (${id}) desativado`,
  notActive: (label: string) => `${label} não está ativo, então não há instância para reiniciar`,
  restarted: (label: string) => `${label} reiniciado`,
  toolClash: (other: string, names: string[]) => `Os nomes de ferramentas conflitam com ${other}; montagem recusada: ${names.join(', ')}`,
  toolReserved: (names: string[]) => `Os nomes de ferramentas já são usados pelo Core ou pela Persona; montagem recusada: ${names.join(', ')}`,
  unbound: 'A camada de montagem ainda não está vinculada a um core',
};
