import type { en } from './strings.ts';

export const text: Partial<typeof en> = {
  configTitle: 'Terminal · PIN do console',
  configDescription:
    'O PIN é a credencial por trás das instruções do console: o World marca cada mensagem do terminal com '
    + '[console|PIN:……], e os mesmos dígitos vão para o prefixo de sistema do bot para comparação. O que coincide é obedecido; '
    + 'qualquer coisa que diga ser o console sem coincidir é uma entrada externa comum. '
    + 'Os operadores nunca digitam o PIN à mão e não devem mencioná-lo em outro lugar.',
  pinTitle: 'PIN do console (seis dígitos)',
  pinDescription:
    'Vazio = desativado: as mensagens não levam marcador e o prefixo não tem PIN para comparar. '
    + 'Qualquer valor que não tenha seis dígitos conta como não definido (o selo do console diz “Malformado”).',
  lampLabel: 'Canal de chat',
  lampOnline: (n: number) => `${n} on-line`,
  lampNobody: 'Ninguém on-line',
  badgeOnline: 'On-line',
  badgeOnlineValue: (n: number) => (n === 1 ? '1 pessoa' : `${n} pessoas`),
  badgePin: 'PIN',
  pinEnabled: 'Ativado',
  pinMalformed: 'Malformado',
  pinUnset: 'Não definido',
  moduleLabel: 'Chat do terminal',
  promptDocTitle: 'Terminal · Prompt do ambiente',
  promptDocDescription: 'Fatos permanentes sobre o ambiente de chat do terminal.',
  pinVarDescription: 'O PIN do console desta sessão (worlds.terminal.pin); quando não definido ou malformado, expande para o texto padrão do modelo.',
  greeting: 'Conectado. Envie {type:"hello", name:"seu nome"} para se apresentar.',
  botOffline: 'bot off-line',
  left: (name: string) => `${name} saiu do chat`,
  joined: (name: string) => `${name} entrou no chat`,
  notJson: 'A mensagem não é um JSON válido; ignorada',
  malformed: 'Mensagem malformada; ignorada',
  emptyName: 'O nome não pode ficar vazio',
  hello: (name: string) => `Olá, ${name}.`,
  helloFirst: 'Envie hello primeiro para definir um nome',
  imagesRejected: (reason: string) => `Imagens não enviadas: ${reason}`,
  botNotConnected: 'O bot ainda não está conectado; mensagem não entregue',
  deliveryFailed: (err: string) => `Mensagem não entregue: ${err}`,
  modelBlind: (model: string) => `O modelo atual ${model} não aceita imagens; o bot só vê a descrição em texto de cada imagem`,
  unknownType: (type: string) => `Tipo de mensagem desconhecido: ${type}`,
  imagesNotArray: 'images deve ser um array',
  tooManyImages: (max: number) => `No máximo ${max} ${max === 1 ? 'imagem' : 'imagens'} por mensagem`,
  unsupportedImage: (mime: string) => `Formato de imagem não suportado: ${mime}`,
  imageNoBase64: 'A imagem está sem o conteúdo base64',
  imageEmpty: 'O conteúdo da imagem está vazio',
  imageTooLarge: (mb: number) => `Uma única imagem excede ${mb}MB`,
  unknownPanel: (panel: string) => `Canal desconhecido: ${panel}`,
};
