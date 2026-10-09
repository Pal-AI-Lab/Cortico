import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  httpStatus: (status: number, snippet: string) => `HTTP ${status} : ${snippet}`,
  notJson: (status: number, snippet: string) => `La réponse n'est pas du JSON valide (HTTP ${status}) : ${snippet}`,
};
