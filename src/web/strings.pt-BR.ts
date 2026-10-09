import type { en } from './strings.ts';

export const serverText: Partial<typeof en> = {
  paused: 'Pausado: os eventos continuam sendo armazenados e enfileirados, nenhum despertar é entregue',
  resumed: 'Retomado: os eventos acumulados são entregues em um único lote',
  exitSupervised: 'O processo vai encerrar; o inicializador vai iniciá-lo de novo',
  exitSupervisedPaused: 'O processo vai encerrar; o inicializador vai iniciá-lo de novo com a entrega de eventos pausada, então retome-a no controle de execução',
  exitUnsupervised: 'O processo vai encerrar; nenhum loop de inicializador foi detectado, então é preciso iniciá-lo de novo manualmente',
  shutdownSkipped: (n: number, labels: string[]) =>
    `O desligamento local terminou, mas ${n === 1 ? '1 etapa não foi concluída' : `${n} etapas não foram concluídas`}: ${labels.join(', ')}`,
  shutdownComplete: (n: number) => `Desligamento local concluído (todas as ${n} etapas concluídas)`,
  externalUnverified: (items: string[]) => `; [P0] ${items.join('; ')}`,
  externalItem: (label: string, status: string, detail: string, manualAction: string) =>
    `${label}=${status} (${detail}). Ação manual: ${manualAction}`,
  externalVerified: '; todas as verificações de estado externo confirmaram o encerramento',
};
