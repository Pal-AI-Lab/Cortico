import type { en } from './strings.ts';

export const serverText: Partial<typeof en> = {
  paused: "En pause : les événements sont toujours stockés et mis en file, aucun réveil n'est livré",
  resumed: "Repris : l'arriéré est livré en un seul lot",
  exitSupervised: 'Le processus va se terminer ; le lanceur le redémarrera',
  exitSupervisedPaused: "Le processus va se terminer ; le lanceur le redémarrera avec la livraison des événements en pause, reprenez-la dans l'état d'exécution",
  exitUnsupervised: 'Le processus va se terminer ; aucune boucle de lanceur détectée, il faut le redémarrer à la main',
  shutdownSkipped: (n: number, labels: string[]) => `Arrêt local terminé, mais ${n} étape${n > 1 ? 's' : ''} non terminée${n > 1 ? 's' : ''} : ${labels.join(', ')}`,
  shutdownComplete: (n: number) => `Arrêt local terminé (${n} étape${n > 1 ? 's' : ''} sur ${n} terminée${n > 1 ? 's' : ''})`,
  externalUnverified: (items: string[]) => ` ; [P0] ${items.join(' ; ')}`,
  externalItem: (label: string, status: string, detail: string, manualAction: string) =>
    `${label}=${status} (${detail}). Action manuelle : ${manualAction}`,
  externalVerified: " ; chaque contrôle d'état externe a confirmé l'arrêt",
};
