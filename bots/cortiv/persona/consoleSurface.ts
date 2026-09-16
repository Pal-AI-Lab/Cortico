/** Persona 的人物档案概览面板。工作区与版本历史两块在 bots/cormini/persona/consoleSurface.ts。 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Language } from 'cortico/core/language.ts';
import type { WorldPanelDecl, PersonaConsoleDecl } from 'cortico/core/types.ts';
import {
  historyPanelDecl,
  workspaceInvoke,
  workspacePanelDecl,
} from '../../cormini/persona/consoleSurface.ts';
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';
import { VIEWERS_DIR, viewerMemoryNote } from './viewers.ts';

export const MEMORY_PANEL: WorldPanelDecl = {
  id: 'memory',
  title: 'Memory',
};

export function personaPanels(language: Language = 'zh'): WorldPanelDecl[] {
  return [workspacePanelDecl(language), MEMORY_PANEL, historyPanelDecl(language)];
}

const VIEWER_LIST_CAP = 80;

export interface ViewerArchive {
  source: string;
  path: string;
  summary: string;
}

export interface MemoryState {
  workspaceFiles: number;
  topLevel: string[];
  constitutionChars: number;
  viewers: {
    total: number;
    bySource: Array<{ source: string; count: number }>;
    archives: ViewerArchive[];
    truncated: boolean;
  };
  note: string;
}

export interface PersonaConsoleDeps {
  /** Persona持有的那份记忆(版本历史在 `memory.git`) */
  memory: GitWorkspaceMemory;
}

function visible(name: string): boolean {
  return !name.startsWith('.') && !name.includes('.tmp-');
}

function countFiles(absDir: string): number {
  let n = 0;
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!visible(e.name)) continue;
    const abs = join(absDir, e.name);
    if (e.isDirectory()) n += countFiles(abs);
    else if (e.isFile()) n += 1;
  }
  return n;
}

function memoryState(ws: GitWorkspaceMemory): MemoryState {
  const constitutionAbs = join(ws.memoryDir, 'CONSTITUTION.md');
  let constitutionChars = 0;
  try {
    constitutionChars = readFileSync(constitutionAbs, 'utf8').trim().length;
  } catch {
    constitutionChars = 0;
  }

  const bySource = new Map<string, number>();
  const archives: ViewerArchive[] = [];
  let total = 0;
  let truncated = false;
  const viewersAbs = join(ws.memoryDir, VIEWERS_DIR);
  if (existsSync(viewersAbs) && statSync(viewersAbs).isDirectory()) {
    for (const sourceEnt of readdirSync(viewersAbs, { withFileTypes: true })) {
      if (!sourceEnt.isDirectory() || !visible(sourceEnt.name)) continue;
      const sourceDir = join(viewersAbs, sourceEnt.name);
      for (const fileEnt of readdirSync(sourceDir, { withFileTypes: true })) {
        if (!fileEnt.isFile() || !visible(fileEnt.name) || !fileEnt.name.endsWith('.md')) continue;
        total += 1;
        bySource.set(sourceEnt.name, (bySource.get(sourceEnt.name) ?? 0) + 1);
        if (archives.length >= VIEWER_LIST_CAP) {
          truncated = true;
          continue;
        }
        const path = `${VIEWERS_DIR}/${sourceEnt.name}/${fileEnt.name}`;
        let summary = '';
        try {
          summary = readFileSync(join(sourceDir, fileEnt.name), 'utf8')
            .split('\n').map((l) => l.trim()).find(Boolean) ?? '';
        } catch {
          summary = '';
        }
        archives.push({ source: sourceEnt.name, path, summary });
      }
    }
  }
  archives.sort((a, b) => a.path.localeCompare(b.path));

  return {
    workspaceFiles: countFiles(ws.memoryDir),
    topLevel: ws.listDir(''),
    constitutionChars,
    viewers: {
      total,
      bySource: [...bySource.entries()]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => a.source.localeCompare(b.source)),
      archives,
      truncated,
    },
    note: viewerMemoryNote(),
  };
}

export function personaConsoleDecl(
  deps: PersonaConsoleDeps,
  language: Language = 'zh',
): PersonaConsoleDecl {
  const ws = deps.memory;
  const workspace = workspaceInvoke(ws);
  return {
    panels: personaPanels(language),
    invoke: async (panel: string, method: string, args: unknown[]): Promise<unknown> => {
      if (panel === 'memory') {
        if (method === 'state') return memoryState(ws);
        throw new Error(`未知面板方法: ${panel}.${method}`);
      }
      return workspace(panel, method, args);
    },
  };
}
