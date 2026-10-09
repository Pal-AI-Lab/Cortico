import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  protocolMismatch: (server: string, page: string) =>
    `A versão do protocolo do console não confere: servidor ${server}, esta página ${page}.`
    + ' Force a atualização da página.',
  pageFailed: (pageId: string) => `Não foi possível abrir “${pageId}”`,
  noPage: (pageId: string) => `Página do console não encontrada: “${pageId}”`,
  noPageHint: 'Verifique o endereço da página e o status de ativação do módulo.',
  noPanels: (label: string) => `“${label}” não declara nenhum painel.`,
  noSuchPanel: (label: string, wanted: string) => `“${label}” não tem o painel “${wanted}”`,
  provides: (list: string) => 'Painéis disponíveis: ' + list,
  panelFailed: (title: string) => `Falha ao carregar o painel “${title}”`,
  configEmpty: 'Grupos de configuração indisponíveis.',
  configTitle: 'Configuração',
  configDesc: 'As alterações são salvas automaticamente em config.json. As configurações marcadas como exigindo reinício valem após reiniciar; as demais valem na hora.',
  assembly: 'Montagem',
  notInstalled: 'Indisponível',
  notActivated: 'não ativado',
  hidden: 'oculto',
  reloadPrefix: 'Prefixo desatualizado · clique para recarregar',
  open: 'Abrir',
  configTab: 'Configuração',
  promptsTab: 'Modelos de prompt',
  storageTab: 'Dados',
  toolsTab: 'Ferramentas',
  storageTitle: 'Dados',
  storageDesc: 'Itens de armazenamento declarados por esta página; o que uma limpeza abrange e retorna depende de cada item.',
  reloadTitle: 'Recarregar o prefixo de sistema?',
  reloadBody: 'Relê todas as fontes do prefixo e substitui o prefixo de sistema da sessão atual. As mensagens existentes da conversa são mantidas.',
  prefixReloaded: 'Prefixo recarregado',
  noBundle: (pageId: string) =>
    `Falta o pacote de painéis de “${pageId}”. Para páginas do repositório, pare o bot primeiro e depois execute pnpm build:web;`
    + ' para pacotes em extensions/, compile no diretório do pacote e reinicie o processo.',
  badBundleUrl: (pageId: string) => `A URL do pacote de painéis de “${pageId}” é inválida; carregamento recusado`,
  bundleLoadFailed: (pageId: string, err: string) => `Falha ao carregar o pacote de painéis de “${pageId}”: ${err}`,
  badDefaultExport: (pageId: string) => `O pacote de painéis de “${pageId}” não tem uma exportação default válida; esperado { panels: { … } }`,
  none: '(nenhum)',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `O pacote de painéis de “${pageId}” não tem o painel “${panelId}”. Painéis disponíveis: ${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `O painel “${panelId}” de “${pageId}” não tem o método mount`,
  noBuiltinPanel: (name: string, known: string) =>
    `Painel integrado “${name}” não encontrado. Painéis disponíveis: ${known}`,
};
