import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  sectionDisk: 'data/ em disco (persiste após reiniciar)',
  sectionMemory: 'Em memória (apagado ao reiniciar)',
  nukeAll: '⚠ Limpar todo o armazenamento do servidor',
  clear: 'Limpar',
  dangerTitle: (label: string) => `⚠ Perigoso: ${label}`,
  dangerBody: (note: string) => `${note}\n\nLimpar de forma irreversível?`,
  clearTitle: (label: string) => `Limpar “${label}”?`,
  cleared: 'Limpo',
  clearFailed: (err: string) => 'Falha ao limpar: ' + err,
  nukeTitle: '⚠⚠ Limpar todo o armazenamento',
  nukeBody: 'Limpa todos os itens de armazenamento do servidor, não só os listados nesta página. Não é possível desfazer. Será limpo:',
  partialFailed: (keys: string) => 'Falha parcial: ' + keys,
  nukedAll: (count: number) => `✓ Tudo limpo (${count} ${count === 1 ? 'item' : 'itens'})`,
  nukeFailed: (err: string) => 'Falha ao limpar tudo: ' + err,
  noList: '(O servidor não tem uma lista de armazenamento montada)',
  empty: 'Esta página não tem itens de armazenamento',
  loadFailed: (err: string) => 'Falha ao carregar a lista de armazenamento: ' + err,
  loading: 'Carregando…',
};
