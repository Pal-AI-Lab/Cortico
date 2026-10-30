import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Diagnóstico',
  navGroup: 'Core',
  pageTitle: 'Diagnóstico',
  subRun: 'Ejecución',
  subRunlog: 'Registro de ejecución',
  subData: 'Borrar datos',
  perPage: 'Por página',
  prevPage: '‹ Anterior',
  nextPage: 'Siguiente ›',
  shown: (from: number, to: number, total: number, more: boolean) => `Mostrando ${from}–${to} de ${total}${more ? '+' : ''}`,
  pageOf: (page: number, pages: number, more: boolean) => `${page} / ${pages}${more ? '+' : ''}`,
  sectionSessions: 'Sesiones',
  sectionEvents: 'Eventos',
  chipDelivered: 'entregado ',
  chipRoundsPre: 'este lote ',
  chipRoundsPost: ' rondas',
  subConfig: 'Configuración',
  configEmpty: 'Core no tiene ajustes configurables.',
  netOffline: 'No se puede acceder a la API',

  // events.ts
  eventsDesc: 'Registros de eventos que el agente puede consultar.',
  allSources: 'Todas las fuentes',
  sourceTitle: 'Filtra por fuente. Las opciones vienen de los eventos cargados.',
  showArchive: 'Mostrar archivo sin procesar',
  showArchiveTitle: 'Incluir los eventos archivados que no se entregan directamente al contexto',
  evHeadTime: 'Hora',
  evHeadSource: 'Fuente',
  evHeadType: 'Tipo',
  evHeadText: 'Texto',
  noEvents: 'Aún no hay eventos',

  // runlog.ts
  currentRun: 'Ejecución actual',
  allLevels: 'Todos los niveles',
  areaPlaceholder: 'Prefijo de área, p. ej. worlds.minecraft', // arch-allow: 日志区域筛选框的示例前缀,只是示意文字
  grepPlaceholder: 'Regex; coincide con el mensaje y los datos',
  roundPlaceholder: 'Ronda',
  refresh: 'Actualizar',
  logHeadTime: 'Hora',
  logHeadLevel: 'Nivel',
  logHeadArea: 'Área',
  logHeadMsg: 'Mensaje',
  noLog: 'No hay entradas de registro',
  copyEntry: 'Copiar entrada',

  // sessions.ts
  sessionsDesc: 'Uso de tokens y aciertos de caché de cada sesión en este proceso. Los conteos vuelven a cero al reiniciar y solo se conservan las 8 sesiones temporales terminadas más recientes. Para el historial entre reinicios, consulta “Uso y costo”.',
  sesHeadStatus: 'Estado',
  sesHeadCalls: 'Llamadas',
  sesHeadInput: 'tok de entrada',
  sesHeadCache: 'Aciertos de caché',
  sesHeadOutput: 'tok de salida',
  sesHeadMsgs: 'Mensajes',
  noSessions: 'Aún no hay sesiones',
  running: 'sin terminar',
  ended: 'terminada',
};
