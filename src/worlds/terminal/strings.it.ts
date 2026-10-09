import type { en } from './strings.ts';

export const text: Partial<typeof en> = {
  configTitle: 'Terminale · PIN della console',
  configDescription:
    'Il PIN è la credenziale alla base delle istruzioni della console: il World appone a ogni messaggio del terminale un '
    + 'marcatore [console|PIN:……] e le stesse cifre entrano nel prefisso di sistema del bot per il confronto. Se corrisponde, viene eseguito; '
    + 'tutto ciò che si dichiara console senza corrispondere è un normale input esterno. '
    + 'Gli operatori non digitano mai il PIN a mano e non dovrebbero menzionarlo altrove.',
  pinTitle: 'PIN della console (sei cifre)',
  pinDescription:
    'Vuoto = disattivato: i messaggi non hanno marcatore e il prefisso non contiene alcun PIN da confrontare. '
    + 'Qualsiasi valore che non sia di sei cifre conta come non impostato (il badge della console indica «Formato non valido»).',
  lampLabel: 'Canale di chat',
  lampOnline: (n) => `${n} in linea`,
  lampNobody: 'Nessuno in linea',
  badgeOnline: 'In linea',
  badgeOnlineValue: (n) => (n === 1 ? '1 persona' : `${n} persone`),
  badgePin: 'PIN',
  pinEnabled: 'Attivato',
  pinMalformed: 'Formato non valido',
  pinUnset: 'Non impostato',
  moduleLabel: 'Chat del terminale',
  promptDocTitle: "Terminale · Prompt dell'ambiente",
  promptDocDescription: "Fatti permanenti sull'ambiente di chat del terminale.",
  pinVarDescription: 'Il PIN della console di questa sessione (worlds.terminal.pin); se non impostato o non valido diventa il testo predefinito del template.',
  greeting: 'Connesso. Invia {type:"hello", name:"il tuo nome"} per presentarti.',
  botOffline: 'bot disconnesso',
  left: (name) => `${name} ha lasciato la chat`,
  joined: (name) => `${name} è entrato nella chat`,
  notJson: 'Il messaggio non è JSON valido; ignorato',
  malformed: 'Messaggio non valido; ignorato',
  emptyName: 'Il nome non può essere vuoto',
  hello: (name) => `Ciao, ${name}.`,
  helloFirst: 'Invia prima hello per impostare un nome',
  imagesRejected: (reason) => `Immagini non inviate: ${reason}`,
  botNotConnected: 'Il bot non è ancora connesso; messaggio non consegnato',
  deliveryFailed: (err) => `Messaggio non consegnato: ${err}`,
  modelBlind: (model) => `Il modello attuale ${model} non accetta immagini; il bot vede solo la descrizione testuale di ogni immagine`,
  unknownType: (type) => `Tipo di messaggio sconosciuto: ${type}`,
  imagesNotArray: 'images deve essere un array',
  tooManyImages: (max) => `Al massimo ${max} immagini per messaggio`,
  unsupportedImage: (mime) => `Formato immagine non supportato: ${mime}`,
  imageNoBase64: "Manca il contenuto base64 dell'immagine",
  imageEmpty: "Il contenuto dell'immagine è vuoto",
  imageTooLarge: (mb) => `Una singola immagine supera ${mb} MB`,
  unknownPanel: (panel) => `Canale sconosciuto: ${panel}`,
};
