/**
 * Persona 与 bot 声明的面板合并到同一浏览器产物。
 * 声明分别位于 ../persona/consoleSurface.ts 与 ../console-page.ts。
 * 工作区与版本历史两块以及取数—渲染小件来自 Cormini。
 */

import type { ConsoleClientBundle } from 'cortico/web/shared/client-panel.ts';
import '../../cormini/console/style.css';
import { historyPanel } from '../../cormini/console/history.ts';
import type { MediumStatus } from '../../cormini/console/shared.ts';
import { createWorkspacePanel } from '../../cormini/console/workspace.ts';
import { memoryPanel } from './memory.ts';
import { checkpointsPanel } from './checkpoints.ts';
import { resetPanel } from './reset.ts';
import { dreamPanel } from './dream.ts';

// ---------------------------------------------------------------------------
// `bots/corti-soulmate/persona/consoleSurface.ts` 与 `bots/corti-soulmate/console-page.ts`
// 各方法的返回形状
// ---------------------------------------------------------------------------

export interface CheckpointEntry {
  name: string;
  message: string;
  hash: string;
  date: string;
}

export type FileOp = 'read' | 'write' | 'append' | 'rename' | 'delete';

export interface PermissionCell {
  allowed: FileOp[];
  denied: Array<{ op: FileOp; reason: string }>;
}

export interface PermissionRow {
  zone: string;
  label: string;
  cells: PermissionCell[];
}

export interface MemoryTier {
  id: string;
  title: string;
  detail: string;
  live: string;
}

export interface MemoryState {
  tiers: MemoryTier[];
  memo: {
    residentCap: number;
    activeCap: number;
    resident: string[];
    active: string[];
    archived: number;
  };
  matrix: {
    roles: string[];
    rows: PermissionRow[];
    constitutionProposalPending: boolean;
  };
}

export interface Applied<S> {
  ok: true;
  result: string;
  state: S;
}

export interface CheckpointsState {
  status: MediumStatus;
  checkpoints: CheckpointEntry[];
}

export interface StoragePartInfo {
  key: string;
  label: string;
  kind: 'disk' | 'memory';
  location?: string;
  danger?: boolean;
  note?: string;
}

export interface ResetState {
  status: MediumStatus;
  checkpoints: CheckpointEntry[];
  parts: StoragePartInfo[];
  ready: boolean;
  reason: string | null;
}

export interface ResetResult {
  ok: boolean;
  persona: string;
  results: Array<{ key: string; ok: boolean; result: string }>;
}

export interface DreamState {
  dreaming: boolean;
}

/** `dream.trigger` 的回执:一句原样显示的话 + 触发之后的状态(省一次往返)。 */
export interface DreamTriggered {
  ok: boolean;
  message: string;
  state: DreamState;
}

// ---------------------------------------------------------------------------

const bundle: ConsoleClientBundle = {
  panels: {
    workspace: createWorkspacePanel({
      templates: [
        { value: 'blank', label: '空白' },
        { value: 'note', label: '笔记', body: (title) => `# ${title}\n\n` },
        {
          value: 'person',
          label: '人',
          body: (title) => `# ${title}\n\n## 关系\n\n## 已知事实\n\n## 待确认\n`,
        },
        { value: 'memo', label: '备忘', body: (title) => `# ${title}\n\n- 状态：active\n- 记录：\n` },
      ],
      defaultDir: 'note',
    }),
    memory: memoryPanel,
    history: historyPanel,
    checkpoints: checkpointsPanel,
    reset: resetPanel,
    dream: dreamPanel,
  },
};

export default bundle;
