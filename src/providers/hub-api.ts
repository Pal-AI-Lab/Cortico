import type { ProviderHub } from './webui/hub.ts';

export type ProviderHubApi = Pick<ProviderHub, 'list' | 'moduleList' | 'groups' | 'preview' | 'detail' | 'save' | 'delete' | 'activate' | 'action'>;
