/**
 * Persona 控制台的浏览器入口；面板声明见 ../persona/consoleSurface.ts。
 * 工作区与版本历史两块来自 Cormini，人物档案概览是这一层自己的。
 */

import type { ConsoleClientBundle } from 'cortico/web/shared/client-panel.ts';
import '../../cormini/console/style.css';
import { historyPanel } from '../../cormini/console/history.ts';
import { createWorkspacePanel } from '../../cormini/console/workspace.ts';
import { memoryPanel } from './memory.ts';

const bundle: ConsoleClientBundle = {
  panels: {
    workspace: createWorkspacePanel({
      templates: [
        { value: 'blank', label: '空白' },
        { value: 'note', label: '笔记', body: (title) => `# ${title}\n\n` },
        { value: 'viewer', label: '人物档案', body: (title) => `${title}\n\n` },
      ],
      defaultDir: 'viewers',
    }),
    memory: memoryPanel,
    history: historyPanel,
  },
};

export default bundle;
