import type { en } from './strings.ts';

export const text: Partial<typeof en> = {
  configTitle: 'Terminal · Konsolen-PIN',
  configDescription:
    'Die PIN ist der Nachweis hinter Konsolenanweisungen: Die World versieht jede Terminalnachricht mit einer '
    + 'Markierung [console|PIN:……], und dieselben Ziffern stehen zum Abgleich im Systempräfix des Bots. Bei Übereinstimmung wird gehorcht; '
    + 'was sich ohne Übereinstimmung als Konsole ausgibt, ist gewöhnliche externe Eingabe. '
    + 'Operatoren tippen die PIN nie von Hand und sollten sie nirgendwo sonst erwähnen.',
  pinTitle: 'Konsolen-PIN (sechs Ziffern)',
  pinDescription:
    'Leer = deaktiviert: Nachrichten tragen keine Markierung, und das Präfix enthält keine PIN zum Abgleich. '
    + 'Jeder Wert, der nicht aus sechs Ziffern besteht, gilt als nicht gesetzt (das Konsolen-Badge zeigt „Ungültiges Format“).',
  lampLabel: 'Chat-Kanal',
  lampOnline: (n) => `${n} online`,
  lampNobody: 'Niemand online',
  badgeOnline: 'Online',
  badgeOnlineValue: (n) => (n === 1 ? '1 Person' : `${n} Personen`),
  badgePin: 'PIN',
  pinEnabled: 'Aktiviert',
  pinMalformed: 'Ungültiges Format',
  pinUnset: 'Nicht gesetzt',
  moduleLabel: 'Terminal-Chat',
  promptDocTitle: 'Terminal · Umgebungs-Prompt',
  promptDocDescription: 'Feststehende Fakten zur Terminal-Chat-Umgebung.',
  pinVarDescription: 'Die Konsolen-PIN dieser Session (worlds.terminal.pin); wird zum Standardtext der Vorlage, wenn sie nicht gesetzt oder ungültig ist.',
  greeting: 'Verbunden. Sende {type:"hello", name:"dein Name"}, um dich vorzustellen.',
  botOffline: 'Bot offline',
  left: (name) => `${name} hat den Chat verlassen`,
  joined: (name) => `${name} ist dem Chat beigetreten`,
  notJson: 'Nachricht ist kein gültiges JSON; ignoriert',
  malformed: 'Ungültige Nachricht; ignoriert',
  emptyName: 'Der Name darf nicht leer sein',
  hello: (name) => `Hallo, ${name}.`,
  helloFirst: 'Sende zuerst hello, um einen Namen festzulegen',
  imagesRejected: (reason) => `Bilder nicht gesendet: ${reason}`,
  botNotConnected: 'Der Bot ist noch nicht verbunden; Nachricht nicht zugestellt',
  deliveryFailed: (err) => `Nachricht nicht zugestellt: ${err}`,
  modelBlind: (model) => `Das aktuelle Modell ${model} akzeptiert keine Bilder; der Bot sieht nur die Textbeschreibung jedes Bildes`,
  unknownType: (type) => `Unbekannter Nachrichtentyp: ${type}`,
  imagesNotArray: 'images muss ein Array sein',
  tooManyImages: (max) => `Höchstens ${max} Bilder pro Nachricht`,
  unsupportedImage: (mime) => `Nicht unterstütztes Bildformat: ${mime}`,
  imageNoBase64: 'Dem Bild fehlt der base64-Inhalt',
  imageEmpty: 'Der Bildinhalt ist leer',
  imageTooLarge: (mb) => `Ein einzelnes Bild überschreitet ${mb} MB`,
  unknownPanel: (panel) => `Unbekannter Kanal: ${panel}`,
};
