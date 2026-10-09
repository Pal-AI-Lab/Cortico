import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  httpStatus: (status: number, snippet: string) => `HTTP ${status}: ${snippet}`,
  notJson: (status: number, snippet: string) => `응답이 올바른 JSON이 아닙니다(HTTP ${status}): ${snippet}`,
};
