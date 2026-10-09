import type { coreGroupEn, validationEn } from './strings.ts';

export const coreGroupText: Partial<typeof coreGroupEn> = {
  title: 'Raggruppamento eventi, ragionamento e log',
  description: '',
  displayName: {
    title: 'Nome visualizzato',
    description: "Usato per il titolo della console e come nome del mittente nei messaggi inviati dal bot. La console lo applica subito; un World montato lo fa al riavvio di quel World.",
  },
  quietGap: {
    title: 'Finestra di quiete',
    description: "Attendi questo tempo dopo l'arrivo dell'ultimo elemento raggruppato; i limiti di durata e dimensione del batch possono anticipare la consegna.",
  },
  minBatchAge: {
    title: 'Età minima del batch',
    description: "Attendi almeno questo tempo dopo l'arrivo del primo elemento raggruppato; i limiti di durata e dimensione del batch hanno la precedenza.",
  },
  maxBatchAge: {
    title: 'Età massima del batch',
    description: 'Limita il ritardo di raggruppamento a questa durata dal primo elemento.',
  },
  maxBatchSize: {
    title: 'Dimensione massima del batch',
    suffix: 'elementi',
    description: 'Consegna quando eventi esterni e candidati raggiungono questo numero; gli elementi a rendering differito e piggyback non contano.',
  },
  keepPastThinking: {
    title: 'Conserva ragionamento passato',
    description: 'Consente al provider di reinviare il ragionamento passato compatibile. Se disattivato, le richieste lo omettono. Le sessioni salvate non cambiano.',
  },
  logFile: {
    title: 'Soglia file di log',
    description: 'Le voci sotto questo livello non vengono scritte in data/runs/<run>/log.jsonl.',
  },
  logConsole: {
    title: 'Soglia di stampa del log',
    description: 'Le voci sotto questo livello non vengono stampate nella finestra della console.',
  },
  logAreas: {
    title: 'Soglie file per area',
    description: "`area=livello` separati da virgole, ad esempio `core.loop=trace,console=warn`; `.*` è supportato. Si applica il prefisso corrispondente più lungo. Le aree senza corrispondenza usano la soglia predefinita.",
  },
};
export const validationText: Partial<typeof validationEn> = {
  notNumber: (label: string) => `${label} deve essere un numero`,
  below: (label: string, min: number) => `${label} non può essere minore di ${min}`,
  above: (label: string, max: number) => `${label} non può essere maggiore di ${max}`,
  notInEnum: (label: string, options: string) => `${label} deve essere uno tra ${options}`,
  needsPair: (label: string) => `${label} richiede due numeri`,
  first: (label: string) => `${label} (primo valore)`,
  second: (label: string) => `${label} (secondo valore)`,
  pairOrder: (label: string) => `${label}: il primo valore non può superare il secondo`,
  empty: (label: string) => `${label}: il valore non può essere vuoto`,
};
