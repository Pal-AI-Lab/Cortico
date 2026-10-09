import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  protocolMismatch: (server: string, page: string) =>
    `La versión del protocolo de la consola no coincide: servidor ${server}, esta página ${page}.`
    + ' Fuerza la recarga de la página.',
  pageFailed: (pageId: string) => `No se pudo abrir “${pageId}”`,
  noPage: (pageId: string) => `No se encontró la página de la consola: “${pageId}”`,
  noPageHint: 'Revisa la dirección de la página y el estado de activación del módulo.',
  noPanels: (label: string) => `“${label}” no declara paneles.`,
  noSuchPanel: (label: string, wanted: string) => `“${label}” no tiene el panel “${wanted}”`,
  provides: (list: string) => 'Paneles disponibles: ' + list,
  panelFailed: (title: string) => `No se pudo cargar el panel “${title}”`,
  configEmpty: 'Los grupos de configuración no están disponibles.',
  configTitle: 'Configuración',
  configDesc: 'Los cambios se guardan automáticamente en config.json. Los ajustes marcados como que requieren reinicio se aplican al reiniciar; el resto se aplica de inmediato.',
  assembly: 'Ensamblado',
  notInstalled: 'No disponible',
  notActivated: 'no activado',
  hidden: 'oculto',
  reloadPrefix: 'El prefijo cambió · haz clic para recargar',
  open: 'Abrir',
  configTab: 'Configuración',
  promptsTab: 'Plantillas de prompt',
  storageTab: 'Datos',
  toolsTab: 'Herramientas',
  storageTitle: 'Datos',
  storageDesc: 'Elementos de almacenamiento que declara esta página; qué abarca un borrado y qué devuelve depende de cada elemento.',
  reloadTitle: '¿Recargar el prefijo del sistema?',
  reloadBody: 'Vuelve a leer todas las fuentes del prefijo y reemplaza el prefijo del sistema de la sesión actual. Los mensajes existentes de la conversación se conservan.',
  prefixReloaded: 'Prefijo recargado',
  noBundle: (pageId: string) =>
    `Falta el paquete de paneles de “${pageId}”. Para páginas del repositorio, detén primero el bot y luego ejecuta pnpm build:web;`
    + ' para paquetes en extensions/, compila en el directorio del paquete y reinicia el proceso.',
  badBundleUrl: (pageId: string) => `La URL del paquete de paneles de “${pageId}” no es válida; se rechazó la carga`,
  bundleLoadFailed: (pageId: string, err: string) => `No se pudo cargar el paquete de paneles de “${pageId}”: ${err}`,
  badDefaultExport: (pageId: string) => `El paquete de paneles de “${pageId}” no tiene una exportación default válida; se esperaba { panels: { … } }`,
  none: '(ninguno)',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `El paquete de paneles de “${pageId}” no tiene el panel “${panelId}”. Paneles disponibles: ${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `Al panel “${panelId}” de “${pageId}” le falta el método mount`,
  noBuiltinPanel: (name: string, known: string) =>
    `No se encontró el panel integrado “${name}”. Paneles disponibles: ${known}`,
};
