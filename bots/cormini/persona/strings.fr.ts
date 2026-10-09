import type { consoleEn, panelEn } from './strings.ts';

export const consoleText: Partial<typeof consoleEn> = {
  orientation: "Mode d'existence de la Persona et notes de métacognition.",
  constitution: "Principes à long terme de la Persona. Les modifications prennent effet après un rechargement du préfixe système ou au début d'un nouveau contexte.",
  memoryNote: "Conventions de Memory : comment les fichiers du bot sont stockés et quand ils remontent d'eux-mêmes.",
  workspaceLabel: "Espace de travail (fichiers de mémoire écrits par le bot lui-même)",
  workspaceNote: "Tous les fichiers de l'espace de travail sauf la constitution sont supprimés de façon irréversible ; la constitution et les points de contrôle de la Persona sont conservés",
  workspaceStat: (n: number) => `${n} fichier${n <= 1 ? '' : 's'} (hors constitution)`,
  workspaceCleared: (n: number) => `${n} fichier${n <= 1 ? '' : 's'} de l'espace de travail supprimé${n <= 1 ? '' : 's'} ; la constitution est conservée`,
  firstTurnUser: 'Premier tour · saisie utilisateur',
  firstTurnUserDesc: "Message user du premier tour synthétique. Si ce champ ou la réponse est vide, le tour entier n'est pas injecté.",
  firstTurnThinking: 'Premier tour · raisonnement',
  firstTurnThinkingDesc: "Raisonnement (reasoning_content) du premier tour assistant synthétique ; vide = le tour n'en porte pas. Le dialecte openai-responses-compat ne renvoie pas le raisonnement, cette partie n'est donc jamais transmise à ces endpoints.",
  firstTurnReply: 'Premier tour · réponse',
  firstTurnReplyDesc: 'Texte de la réponse assistant du premier tour synthétique.',
};
export const panelText: Partial<typeof panelEn> = {
  workspace: 'Espace de travail',
  workspaceDesc: "L'enregistrement crée un commit dans le dépôt Git de l'espace de travail, signé operator.",
  history: 'Historique des versions',
};
