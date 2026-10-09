import type { en } from './strings.ts';

export const text: Partial<typeof en> = {
  configTitle: 'Terminal · PIN de la consola',
  configDescription:
    'El PIN es la credencial detrás de las instrucciones de la consola: el World marca cada mensaje de la terminal con '
    + '[console|PIN:……], y los mismos dígitos van en el prefijo del sistema del bot para compararlos. Lo que coincide se obedece; '
    + 'cualquier cosa que diga ser la consola sin coincidir es una entrada externa común. '
    + 'Los operadores nunca escriben el PIN a mano y no deberían mencionarlo en otro lugar.',
  pinTitle: 'PIN de la consola (seis dígitos)',
  pinDescription:
    'Vacío = desactivado: los mensajes no llevan marca y el prefijo no tiene un PIN con qué comparar. '
    + 'Cualquier valor que no sea de seis dígitos cuenta como sin configurar (la insignia de la consola dice “Mal formado”).',
  lampLabel: 'Canal de chat',
  lampOnline: (n: number) => `${n} en línea`,
  lampNobody: 'Nadie en línea',
  badgeOnline: 'En línea',
  badgeOnlineValue: (n: number) => (n === 1 ? '1 persona' : `${n} personas`),
  badgePin: 'PIN',
  pinEnabled: 'Activado',
  pinMalformed: 'Mal formado',
  pinUnset: 'Sin configurar',
  moduleLabel: 'Chat de terminal',
  promptDocTitle: 'Terminal · Prompt del entorno',
  promptDocDescription: 'Hechos permanentes sobre el entorno de chat de la terminal.',
  pinVarDescription: 'El PIN de la consola de esta sesión (worlds.terminal.pin); si no está configurado o está mal formado, se expande al texto predeterminado de la plantilla.',
  greeting: 'Conectado. Envía {type:"hello", name:"tu nombre"} para presentarte.',
  botOffline: 'bot desconectado',
  left: (name: string) => `${name} salió del chat`,
  joined: (name: string) => `${name} entró al chat`,
  notJson: 'El mensaje no es JSON válido; se ignoró',
  malformed: 'Mensaje mal formado; se ignoró',
  emptyName: 'El nombre no puede estar vacío',
  hello: (name: string) => `Hola, ${name}.`,
  helloFirst: 'Primero envía hello para definir un nombre',
  imagesRejected: (reason: string) => `Imágenes no enviadas: ${reason}`,
  botNotConnected: 'El bot aún no está conectado; el mensaje no se entregó',
  deliveryFailed: (err: string) => `Mensaje no entregado: ${err}`,
  modelBlind: (model: string) => `El modelo actual ${model} no acepta imágenes; el bot solo ve la descripción de texto de cada imagen`,
  unknownType: (type: string) => `Tipo de mensaje desconocido: ${type}`,
  imagesNotArray: 'images debe ser un arreglo',
  tooManyImages: (max: number) => `Máximo ${max} ${max === 1 ? 'imagen' : 'imágenes'} por mensaje`,
  unsupportedImage: (mime: string) => `Formato de imagen no compatible: ${mime}`,
  imageNoBase64: 'A la imagen le falta su contenido base64',
  imageEmpty: 'El contenido de la imagen está vacío',
  imageTooLarge: (mb: number) => `Una imagen supera los ${mb}MB`,
  unknownPanel: (panel: string) => `Canal desconocido: ${panel}`,
};
