import type { ProviderHubApi } from '../../../../providers/hub-api.ts';
export type HubState = ReturnType<ProviderHubApi['list']>;
export type Connection = HubState['providers'][number];
export type Detail = ReturnType<ProviderHubApi['detail']>;
export type Module = ReturnType<ProviderHubApi['moduleList']>[number];
export interface Editing {
  original: string | null;
  name: string;
  entry: Detail['entry'];
  revision?: string;
  secretValue: string;
  raw: Record<string, string>;
}
export const connectionPath = (name: string) => `/api/providers/${encodeURIComponent(name)}`;
