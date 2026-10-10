import type { coreGroupEn, validationEn } from './strings.ts';

export const coreGroupText: Partial<typeof coreGroupEn> = {
  title: 'Agrupación de eventos, razonamiento y registros',
  description: '',
  displayName: {
    title: 'Nombre visible',
    description: 'Se usa como título de la consola y como nombre del remitente en los mensajes que envía el bot. La consola lo aplica de inmediato; un World montado lo aplica cuando ese World se reinicia.',
  },
  quietGap: {
    title: 'Ventana de silencio',
    description: 'Espera este tiempo después de que llega el último elemento del lote; los límites de tiempo y tamaño del lote pueden adelantar la entrega.',
  },
  minBatchAge: {
    title: 'Tiempo mínimo de lote',
    description: 'Espera al menos este tiempo después de que llega el primer elemento del lote; los límites de tiempo y tamaño del lote tienen prioridad.',
  },
  maxBatchAge: {
    title: 'Tiempo máximo de lote',
    description: 'Limita la espera de agrupación a esta duración desde el primer elemento.',
  },
  maxBatchSize: {
    title: 'Tamaño máximo del lote',
    suffix: 'elementos',
    description: 'Entrega en cuanto los eventos externos y los candidatos alcanzan esta cantidad; no cuentan los elementos de renderizado diferido ni los piggyback.',
  },
  keepPastThinking: {
    title: 'Conservar razonamiento previo',
    description: 'Permite que el proveedor reenvíe el razonamiento previo compatible. Si está desactivado, las solicitudes omiten el razonamiento previo. Las sesiones guardadas no cambian.',
  },
  logFile: {
    title: 'Umbral del archivo de registro',
    description: 'Los registros por debajo de este nivel no se escriben en data/runs/<run>/log.jsonl.',
  },
  logConsole: {
    title: 'Umbral de impresión de registros',
    description: 'Los registros por debajo de este nivel no se imprimen en la ventana de la consola.',
  },
  logAreas: {
    title: 'Umbrales de archivo por área',
    description: '`área=nivel` separados por comas, por ejemplo `core.loop=trace,console=warn`; se admite `.*`. Se aplica el prefijo coincidente más largo. Las áreas sin coincidencia usan el umbral predeterminado.',
  },
  usageRate: {
    title: (code: string) => `Tipo de cambio del informe de uso: ${code}`,
    description: 'Cuánto vale 1 USD en esta moneda. Cuando «Uso y costo» muestra esta moneda, las llamadas sin precio en ella se convierten a este tipo; 0 desactiva la conversión.',
  },
};

export const validationText: Partial<typeof validationEn> = {
  notNumber: (label: string) => `${label} debe ser un número`,
  below: (label: string, min: number) => `${label} no puede ser menor que ${min}`,
  above: (label: string, max: number) => `${label} no puede ser mayor que ${max}`,
  notInEnum: (label: string, options: string) => `${label} debe ser uno de: ${options}`,
  needsPair: (label: string) => `${label} requiere dos números`,
  first: (label: string) => `${label} (primer valor)`,
  second: (label: string) => `${label} (segundo valor)`,
  pairOrder: (label: string) => `${label}: el primer valor no puede superar al segundo`,
  empty: (label: string) => `${label} no puede estar vacío`,
};
