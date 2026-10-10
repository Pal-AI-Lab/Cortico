import type { coreGroupEn, validationEn } from './strings.ts';

export const coreGroupText: Partial<typeof coreGroupEn> = {
  title: 'Ereignis-Batching, Denkprozess und Protokollierung',
  description: '',
  displayName: {
    title: 'Anzeigename',
    description: 'Wird als Konsolentitel und als Absendername der Nachrichten des Bots verwendet. Die Konsole übernimmt ihn sofort; eine eingehängte World erst bei ihrem Neustart.',
  },
  quietGap: {
    title: 'Ruhefenster',
    description: 'So lange nach dem letzten gebündelten Element warten; die Zeit- und Größenlimits des Batches können früher ausliefern.',
  },
  minBatchAge: {
    title: 'Mindestalter des Batches',
    description: 'Nach dem ersten gebündelten Element mindestens so lange warten; die Zeit- und Größenlimits des Batches haben Vorrang.',
  },
  maxBatchAge: {
    title: 'Höchstalter des Batches',
    description: 'Begrenzt die Bündelungsverzögerung ab dem ersten Element auf diese Dauer.',
  },
  maxBatchSize: {
    title: 'Batch-Größenlimit',
    suffix: 'Einträge',
    description: 'Ausliefern, sobald externe Ereignisse und Kandidaten diese Anzahl erreichen; verzögert gerenderte und piggyback-Einträge zählen nicht.',
  },
  keepPastThinking: {
    title: 'Früheren Denkprozess behalten',
    description: 'Erlaubt dem Anbieter, kompatiblen früheren Denkprozess erneut zu senden. Ist die Option deaktiviert, enthalten Anfragen keinen früheren Denkprozess. Gespeicherte Sessions bleiben unverändert.',
  },
  logFile: {
    title: 'Schwelle für Logdatei',
    description: 'Einträge unter dieser Stufe werden nicht in data/runs/<run>/log.jsonl geschrieben.',
  },
  logConsole: {
    title: 'Schwelle für Log-Ausgabe',
    description: 'Einträge unter dieser Stufe werden nicht im Konsolenfenster ausgegeben.',
  },
  logAreas: {
    title: 'Dateischwellen je Bereich',
    description: 'Kommagetrennt `Bereich=Stufe`, etwa `core.loop=trace,console=warn`; `.*` wird unterstützt. Das längste passende Präfix gilt. Bereiche ohne Treffer nutzen die Standardschwelle.',
  },
  usageRate: {
    title: (code: string) => `Umrechnungskurs im Verbrauchsbericht: ${code}`,
    description: 'Wie viel 1 USD in dieser Währung wert ist. Zeigt „Verbrauch & Kosten“ diese Währung, werden Aufrufe ohne Preis in ihr zu diesem Kurs umgerechnet; 0 schaltet die Umrechnung aus.',
  },
};
export const validationText: Partial<typeof validationEn> = {
  notNumber: (label: string) => `${label} muss eine Zahl sein`,
  below: (label: string, min: number) => `${label} darf nicht kleiner als ${min} sein`,
  above: (label: string, max: number) => `${label} darf nicht größer als ${max} sein`,
  notInEnum: (label: string, options: string) => `${label} muss einer der Werte ${options} sein`,
  needsPair: (label: string) => `${label} braucht zwei Zahlen`,
  first: (label: string) => `${label} (erster Wert)`,
  second: (label: string) => `${label} (zweiter Wert)`,
  pairOrder: (label: string) => `${label}: Der erste Wert darf den zweiten nicht übersteigen`,
  empty: (label: string) => `${label} darf nicht leer sein`,
};
