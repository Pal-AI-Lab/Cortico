import type { consoleEn, panelEn } from './strings.ts';

export const consoleText: Partial<typeof consoleEn> = {
  orientation: 'Como a Persona existe e notas sobre sua metacognição.',
  constitution: 'Os princípios de longo prazo da Persona. As alterações valem após recarregar o prefixo de sistema ou quando um novo contexto começa.',
  memoryNote: 'Convenções de memória: como os arquivos dela são armazenados e quando surgem por conta própria.',
  workspaceLabel: 'Espaço de trabalho (arquivos de memória que ela mesma escreveu)',
  workspaceNote: 'Todos os arquivos do espaço de trabalho, exceto a constituição, são excluídos sem possibilidade de recuperação; a constituição e os pontos de controle da personalidade não são alterados',
  workspaceStat: (n: number) => `${n} arquivo${n === 1 ? '' : 's'} (além da constituição)`,
  workspaceCleared: (n: number) => `${n} arquivo${n === 1 ? '' : 's'} do espaço de trabalho ${n === 1 ? 'excluído' : 'excluídos'}; a constituição não foi alterada`,
  firstTurnUser: 'Primeiro turno · entrada do usuário',
  firstTurnUserDesc: 'A mensagem de usuário do primeiro turno sintetizado. Se ela ou a resposta estiver vazia, o turno inteiro não é injetado.',
  firstTurnThinking: 'Primeiro turno · raciocínio',
  firstTurnThinkingDesc: 'O raciocínio (reasoning_content) do primeiro turno sintetizado do assistente; vazio = o turno não leva nenhum. O dialeto openai-responses-compat não retorna raciocínio, então esta parte nunca é enviada para esses endpoints.',
  firstTurnReply: 'Primeiro turno · resposta',
  firstTurnReplyDesc: 'O texto de resposta do assistente no primeiro turno sintetizado.',
};
export const panelText: Partial<typeof panelEn> = {
  workspace: 'Espaço de trabalho',
  workspaceDesc: 'Salvar faz um commit no repositório Git do espaço de trabalho, com operator como autor.',
  history: 'Histórico de versões',
};
