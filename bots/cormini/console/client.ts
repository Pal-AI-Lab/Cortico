/**
 * Cormini 控制台的浏览器入口；面板声明见 ../persona/consoleSurface.ts。
 * 变体从 ./workspace.ts 与 ./history.ts 取这两块，自己的面板在各自的入口里补。
 */

import type { ConsoleClientBundle } from 'cortico/web/shared/client-panel.ts';
import './style.css';
import { historyPanel } from './history.ts';
import { createWorkspacePanel } from './workspace.ts';

const bundle: ConsoleClientBundle = {
  panels: {
    workspace: createWorkspacePanel(),
    history: historyPanel,
  },
};

export default bundle;
