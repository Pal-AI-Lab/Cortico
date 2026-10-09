import type { botEn, assemblyEn } from './strings.ts';

const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const botText: Partial<typeof botEn> = {
  noFile: '(sin archivo)',
  storage: {
    events: {
      label: 'Almacén de eventos (fragmento de esta ejecución)',
      note: 'Borra los eventos de esta ejecución y conserva los de ejecuciones anteriores; el cursor no retrocede',
      stat: (count: number, cursor: number, size: string) => `${count} ${s(count, 'registro', 'registros')} (cursor en ${cursor}) / ${size}`,
      cleared: (n: number) => (n === 1 ? 'Se borró 1 evento de esta ejecución' : `Se borraron ${n} eventos de esta ejecución`),
    },
    session: {
      label: 'Sesión principal (contexto de la conversación actual)',
      note: 'Borra la conversación y vuelve a abrir la sesión, conservando Memory y el almacén de eventos. Si hay un lote en curso, se ejecuta cuando termine',
      stat: (records: number, ktok: number, size: string) => `${records} ${s(records, 'registro', 'registros')} / ~${ktok}k tok / ${size}`,
      cleared: 'Sesión borrada y reabierta (prefijo del sistema + mensaje de apertura)',
    },
    runlog: {
      label: 'Registro de ejecución (esta ejecución)',
      note: 'Borra los registros de esta ejecución y conserva los de ejecuciones anteriores. Los registros de ejecución no se incluyen en el contexto del modelo',
      cleared: 'Registro de ejecución borrado',
    },
    usage: {
      label: 'Libro de uso de tokens (fuente de la página de costos)',
      note: 'Borra todos los registros de uso y costo de los modelos; los totales se reinician con los registros que se escriban después. Estos registros no se incluyen en el contexto del modelo',
      stat: (n: number, size: string) => `${n} ${s(n, 'registro', 'registros')} / ${size}`,
      cleared: (n: number) => (n === 1 ? 'Se borró 1 registro de uso' : `Se borraron ${n} registros de uso`),
    },
    toolcalls: {
      label: 'Libro de llamadas a herramientas (nombre de herramienta / argumentos originales / resultado)',
      note: 'Borra los registros de llamadas a herramientas de esta ejecución sin cambiar los resultados de herramientas en el contexto del modelo',
      cleared: 'Libro de llamadas a herramientas borrado',
    },
    state: {
      label: 'Estado de Core',
      note: 'Borra el estado de la Persona, la hora del traspaso y los registros de fallos consecutivos del modelo; conserva el cursor de entrega y la visibilidad de los Worlds',
      stat: (n: number, lastHandoff: string) => `${n} ${s(n, 'entrada', 'entradas')} de estado de la personalidad / último traspaso ${lastHandoff}`,
      never: 'ninguno',
      cleared: 'Estado de Core restablecido a los valores predeterminados',
    },
    wakes: {
      label: 'Temporizadores persistentes',
      note: 'Cancela todos los temporizadores (no se generan notificaciones)',
      stat: (n: number) => `${n} ${s(n, 'pendiente', 'pendientes')}`,
      cleared: (n: number) => (n === 1 ? 'Se canceló 1 temporizador' : `Se cancelaron ${n} temporizadores`),
    },
    tracker: {
      label: 'Estadísticas de sesiones (uso / aciertos de caché)',
      note: 'Restablece las estadísticas y conserva las entradas de las sesiones activas',
      stat: (n: number) => `${n} ${s(n, 'sesión', 'sesiones')}`,
      cleared: 'Estadísticas de sesiones en cero',
    },
    pending: {
      label: 'Eventos pendientes',
      note:
        'Descarta los eventos pendientes y conserva los registros archivados. Los elementos de renderizado diferido siguen en cola; los elementos descartados no se volverán a entregar tras reiniciar',
      stat: (n: number) => `${n} ${s(n, 'pendiente', 'pendientes')}`,
      cleared: (n: number) => (n === 1 ? 'Se descartó 1 evento pendiente' : `Se descartaron ${n} eventos pendientes`),
    },
    media: {
      label: 'Almacén de adjuntos (imágenes y audio de eventos y resultados de herramientas)',
      note: 'Elimina todos los archivos adjuntos y conserva los registros de eventos y de sesión que los referencian; un adjunto eliminado deja solo su descripción de texto en el contexto',
      stat: (n: number, size: string) => `${n} ${s(n, 'archivo', 'archivos')} / ${size}`,
      cleared: (n: number) => (n === 1 ? 'Se eliminó 1 adjunto' : `Se eliminaron ${n} adjuntos`),
    },
  },
  config: {
    unknownGroup: (id: string) => `No existe el grupo de configuración: ${id}`,
    updated: (title: string, file: string) => `${title} se actualizó y se escribió en ${file}`,
  },
  prompts: {
    unknown: (key: string) => `Plantilla de prompt desconocida: ${key}`,
    packageReadOnly: (title: string) => `${title} es una plantilla de paquete de extensión de solo lectura`,
    conflict: (title: string) => `${title} se modificó en otro lugar; recarga antes de guardar`,
    saved: (title: string) => `Se guardó ${title}`,
    savedOverride: (title: string) => `Se guardó la sobrescritura del despliegue de ${title}`,
    notEnvPrompt: (title: string) => `${title} no tiene una plantilla predeterminada para restaurar`,
    alreadyDefault: (title: string) => `${title} ya usa el valor predeterminado del World`,
    reset: (title: string) => `Se eliminó la sobrescritura del despliegue de ${title}`,
  },
  visibility: {
    shown: (id: string) => `${id} vuelve a ser visible para el agente. La entrega de eventos se reanudó; su segmento de prefijo y sus herramientas vuelven cuando se recarga el prefijo.`,
    hidden: (id: string) => `${id} ahora está oculto para el agente. Los eventos nuevos ya no despiertan al agente (se siguen guardando); su segmento de prefijo y sus herramientas se quitan cuando se recarga el prefijo.`,
    prefixReloaded: (kept: number) => `Prefijo del sistema y tabla de herramientas recargados; ${kept === 1 ? 'se conservó 1 mensaje existente' : `se conservaron ${kept} mensajes existentes`} de la sesión actual`,
  },
  shutdown: {
    pause: 'Pausar la entrega de eventos',
    worlds: 'Detener los Worlds',
    core: 'Detener la Persona',
    modulesTimedOut: 'Se agotó el tiempo al detener los Worlds',
    stepTimedOut: (seconds: number) => `Se agotó el tiempo tras ${seconds} s`,
    externalState: (worldId: string) => `Estado externo de ${worldId}`,
    stopIncomplete: (detail: string) => `La detención del World no terminó, así que no se puede usar la verificación externa en caché: ${detail}`,
    cacheReadFailed: (detail: string) => `No se pudo leer la verificación de apagado en caché: ${detail}`,
    manualCheck: 'Comprueba si el servicio externo correspondiente se detuvo.',
    llm: 'Detener las instancias de proveedor',
    flush: 'Guardar el estado de Core',
    web: 'Cerrar la consola',
    summarySkipped: 'Pasos de apagado local incompletos',
    summaryComplete: 'Apagado local terminado: se completaron todos los pasos',
    summaryUnverified: (items: string[]) => `El apagado local terminó, pero no se confirmó que el estado externo haya terminado: ${items.join(', ')} (requiere confirmación manual)`,
  },
};

export const assemblyText: Partial<typeof assemblyEn> = {
  constructFailed: (detail: string) => `Falló la construcción: ${detail}`,
  notImplemented: 'No se encontró localmente una implementación de este World.',
  unknownWorld: (id: string) => `World desconocido: ${id}`,
  alreadyRunning: (label: string) => `${label} ya está activado`,
  prebuilt: (label: string) => `${label} es una instancia precompilada y no se activa mediante el ensamblado`,
  activated: (label: string, id: string) => `${label} (${id}) activado`,
  deactivated: (label: string, id: string) => `${label} (${id}) desactivado`,
  notActive: (label: string) => `${label} no está activo, así que no hay instancia que reiniciar`,
  restarted: (label: string) => `${label} reiniciado`,
  toolClash: (other: string, names: string[]) => `Los nombres de herramientas coinciden con ${other}; se rechaza el montaje: ${names.join(', ')}`,
  toolReserved: (names: string[]) => `Core o la Persona ya usan estos nombres de herramientas; se rechaza el montaje: ${names.join(', ')}`,
  unbound: 'La capa de ensamblado aún no está vinculada a un core',
};
