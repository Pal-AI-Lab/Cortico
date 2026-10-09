import type { en } from './strings.ts';

export const serverText: Partial<typeof en> = {
  paused: 'En pausa: los eventos se siguen guardando y encolando, no se entrega ningún despertar',
  resumed: 'Reanudado: los eventos acumulados se entregan en un solo lote',
  exitSupervised: 'El proceso está por salir; el lanzador lo volverá a iniciar',
  exitSupervisedPaused: 'El proceso está por salir; el lanzador lo volverá a iniciar con la entrega de eventos en pausa, así que reanúdala desde el control de ejecución',
  exitUnsupervised: 'El proceso está por salir; no se detectó un ciclo de lanzador, así que hay que volver a iniciarlo manualmente',
  shutdownSkipped: (n: number, labels: string[]) =>
    `El apagado local terminó, pero ${n === 1 ? '1 paso no se completó' : `${n} pasos no se completaron`}: ${labels.join(', ')}`,
  shutdownComplete: (n: number) => `Apagado local terminado (se completaron los ${n} pasos)`,
  externalUnverified: (items: string[]) => `; [P0] ${items.join('; ')}`,
  externalItem: (label: string, status: string, detail: string, manualAction: string) =>
    `${label}=${status} (${detail}). Acción manual: ${manualAction}`,
  externalVerified: '; todas las comprobaciones de estado externo confirmaron el cierre',
};
