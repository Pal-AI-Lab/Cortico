import type { ProviderHub } from './console/hub.ts';

export type ProviderHubApi = Pick<ProviderHub, 'list' | 'moduleList' | 'groups' | 'detail' | 'save' | 'delete' | 'activate' | 'action'>;
