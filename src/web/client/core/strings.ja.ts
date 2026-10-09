import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  httpStatus: (status: number, snippet: string) => `HTTP ${status}：${snippet}`,
  notJson: (status: number, snippet: string) => `レスポンスが有効な JSON ではありません（HTTP ${status}）：${snippet}`,
};
