import type { WebUiClientBundle } from '../../../web/shared/client-panel.ts';
import { reasoningPanel } from './reasoning-panel.ts';

// The editor's own blocks (`builtin: 'connection-*'`) are drawn by the WebUI; only the reasoning section ships here.
export default { panels: { reasoning: reasoningPanel } } satisfies WebUiClientBundle;
