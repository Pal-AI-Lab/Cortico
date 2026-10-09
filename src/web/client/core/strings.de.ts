import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  httpStatus: (status: number, snippet: string) => `HTTP ${status}: ${snippet}`,
  notJson: (status: number, snippet: string) => `Antwort ist kein gültiges JSON (HTTP ${status}): ${snippet}`,
};
