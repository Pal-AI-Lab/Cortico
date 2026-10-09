import type { en } from './strings.ts';

export const text: Partial<typeof en> = {
  configTitle: 'Terminal · PIN de la console',
  configDescription:
    "Le PIN est l'identifiant derrière les instructions de la console : le World appose sur chaque message du terminal un "
    + 'marqueur [console|PIN:……], et les mêmes chiffres vont dans le préfixe système du bot pour comparaison. Une correspondance est suivie ; '
    + 'tout ce qui se dit console sans correspondance est une entrée externe ordinaire. '
    + 'Les opérateurs ne saisissent jamais le PIN à la main et ne devraient pas le mentionner ailleurs.',
  pinTitle: 'PIN de la console (six chiffres)',
  pinDescription:
    "Vide = désactivé : les messages ne portent aucun marqueur et le préfixe n'a aucun PIN à comparer. "
    + "Toute valeur qui n'est pas composée de six chiffres compte comme non définie (le badge de la console indique « Format incorrect »).",
  lampLabel: 'Canal de discussion',
  lampOnline: (n) => `${n} en ligne`,
  lampNobody: 'Personne en ligne',
  badgeOnline: 'En ligne',
  badgeOnlineValue: (n) => (n > 1 ? `${n} personnes` : `${n} personne`),
  badgePin: 'PIN',
  pinEnabled: 'Activé',
  pinMalformed: 'Format incorrect',
  pinUnset: 'Non défini',
  moduleLabel: 'Discussion du terminal',
  promptDocTitle: "Terminal · Prompt d'environnement",
  promptDocDescription: "Faits permanents sur l'environnement de discussion du terminal.",
  pinVarDescription: "PIN de la console de cette session (worlds.terminal.pin) ; remplacé par le texte par défaut du modèle s'il n'est pas défini ou mal formé.",
  greeting: 'Connecté. Envoyez {type:"hello", name:"votre nom"} pour vous présenter.',
  botOffline: 'bot hors ligne',
  left: (name) => `${name} a quitté la discussion`,
  joined: (name) => `${name} a rejoint la discussion`,
  notJson: "Le message n'est pas du JSON valide ; ignoré",
  malformed: 'Message mal formé ; ignoré',
  emptyName: 'Le nom ne doit pas être vide',
  hello: (name) => `Bonjour, ${name}.`,
  helloFirst: "Envoyez d'abord hello pour définir un nom",
  imagesRejected: (reason) => `Images non envoyées : ${reason}`,
  botNotConnected: "Le bot n'est pas encore connecté ; message non remis",
  deliveryFailed: (err) => `Message non remis : ${err}`,
  modelBlind: (model) => `Le modèle actuel ${model} n'accepte pas les images ; le bot ne voit que la description textuelle de chaque image`,
  unknownType: (type) => `Type de message inconnu : ${type}`,
  imagesNotArray: 'images doit être un tableau',
  tooManyImages: (max) => `${max} images au maximum par message`,
  unsupportedImage: (mime) => `Format d'image non pris en charge : ${mime}`,
  imageNoBase64: "Il manque le contenu base64 de l'image",
  imageEmpty: "Le contenu de l'image est vide",
  imageTooLarge: (mb) => `Une image dépasse ${mb} Mo`,
  unknownPanel: (panel) => `Canal inconnu : ${panel}`,
};
