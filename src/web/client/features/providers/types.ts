import type { ProviderHubApi } from '../../../../providers/hub-api.ts';
export type HubState = ReturnType<ProviderHubApi['list']>;
export type Connection = HubState['providers'][number];
export type Detail = ReturnType<ProviderHubApi['detail']>;
export type Module = ReturnType<ProviderHubApi['moduleList']>[number];
export interface Editing {
  original: string | null;
  copyFrom?: { name: string; revision: string };
  name: string;
  entry: Detail['entry'];
  revision?: string;
  secretValue: string;
  raw: Record<string, string>;
}
export const connectionPath = (name: string) => `/api/providers/${encodeURIComponent(name)}`;

/** 选定模块后的空白端点:地址与推理档取模块自报的默认,模型留空。 */
export function moduleEntry(module: Module | undefined, kind: string): Detail['entry'] {
  const tier = module?.reasoningTiers[0];
  return { kind, baseUrl: module?.defaultBaseUrl ?? '',
    spec: { model: '', thinking: tier?.thinking ?? true, ...(tier?.effort ? { reasoningEffort: tier.effort } : {}) } };
}
