import type { WebUiClientBundle } from '../../../web/shared/client-panel.ts';
import { modelsPanel } from './models-panel.ts';
import { runtimePanel } from './runtime-panel.ts';

// The editor's own blocks (`builtin: 'connection-*'`) are drawn by the WebUI; only these two ship here.
export default { panels: { runtime: runtimePanel, models: modelsPanel } } satisfies WebUiClientBundle;
