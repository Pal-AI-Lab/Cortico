import type { ConsoleClientBundle } from '../../../web/shared/client-panel.ts';
import { reasoningPanel } from './reasoning-panel.ts';

// The endpoint table (`builtin: 'llm-settings'`) is the console's own; only the reasoning section ships here.
export default { panels: { reasoning: reasoningPanel } } satisfies ConsoleClientBundle;
