import type { WebUiClientBundle } from '../../../web/shared/client-panel.ts';
import { modelsPanel } from './models-panel.ts';
import { runtimePanel } from './runtime-panel.ts';

// The endpoint table (`builtin: 'llm-settings'`) is the WebUI's own; only these two ship here.
export default { panels: { runtime: runtimePanel, models: modelsPanel } } satisfies WebUiClientBundle;
