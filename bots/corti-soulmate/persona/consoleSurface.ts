/** Persona 的服务端 Memory 分层面板与人格文本声明。工作区与版本历史两块在 bots/cormini/persona/consoleSurface.ts;浏览器实现位于 console/;部署级操作由 console-page.ts 提供。 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_VAR_DECLS } from './memory.ts';

/** 前缀与记忆模板由软件包提供。 */
const CORE_DIR = dirname(fileURLToPath(import.meta.url));

import type { Language } from 'cortico/core/language.ts';
import type { WorldPanelDecl, PersonaConsoleDecl, PromptDocDecl } from 'cortico/core/types.ts';
import {
  historyPanelDecl,
  workspaceInvoke,
  workspacePanelDecl,
} from '../../cormini/persona/consoleSurface.ts';
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';
import { MemoTiers } from './memoTiers.ts';
import {
  PERSONA_ROLES, checkAccess,
  type FileOp, type PersonaRole, type Zone,
} from './permissions.ts';

// ---------------------------------------------------------------------------
// 面板声明
// ---------------------------------------------------------------------------

export const MEMORY_PANEL: WorldPanelDecl = {
  id: 'memory',
  title: 'Memory 分层',
};

export function personaPanels(language: Language = 'zh'): WorldPanelDecl[] {
  return [workspacePanelDecl(language), MEMORY_PANEL, historyPanelDecl(language)];
}

/** 一格权限:允许哪些操作,拒绝的各给一句理由(理由就是 agent 会看到的那句)。 */
export interface PermissionCell {
  allowed: FileOp[];
  denied: Array<{ op: FileOp; reason: string }>;
}

export interface PermissionRow {
  zone: Zone;
  label: string;
  /** 与 `roles` 同序 */
  cells: PermissionCell[];
}

export interface MemoryTier {
  id: string;
  title: string;
  /** 不随当前数据变化的结构说明。 */
  detail: string;
  /** 当前数据统计。 */
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
    roles: PersonaRole[];
    rows: PermissionRow[];
  };
}

// ---------------------------------------------------------------------------
// 权限矩阵:**算出来的,不是抄下来的**
// ---------------------------------------------------------------------------

/**
 * 每个区域取一个代表路径，逐角色和操作调用 checkAccess 生成权限矩阵。
 */
const ZONE_SAMPLES: Array<{ zone: Zone; label: string; path: string }> = [
  { zone: 'note', label: 'note/(笔记与手册)', path: 'note/sample.md' },
  { zone: 'memo', label: 'memo/(时间性备忘)', path: 'memo/sample.md' },
  { zone: 'people', label: 'people/(人)', path: 'people/sample.md' },
  { zone: 'worldview', label: 'WORLDVIEW.md(综合认知)', path: 'WORLDVIEW.md' },
  { zone: 'constitution', label: 'CONSTITUTION.md(宪法)', path: 'CONSTITUTION.md' },
  { zone: 'external', label: 'external/(World 自己的抽屉)', path: 'external/qq/sample.md' },
  { zone: 'other', label: '其它(自建目录)', path: 'sample.md' },
];

const FILE_OPS: FileOp[] = ['read', 'write', 'append', 'rename', 'delete'];

function permissionMatrix(): MemoryState['matrix'] {
  const rows: PermissionRow[] = ZONE_SAMPLES.map((z) => ({
    zone: z.zone,
    label: z.label,
    cells: PERSONA_ROLES.map((role) => {
      const cell: PermissionCell = { allowed: [], denied: [] };
      for (const op of FILE_OPS) {
        const r = checkAccess(role, op, z.path);
        if (r.ok) cell.allowed.push(op);
        else cell.denied.push({ op, reason: r.reason });
      }
      return cell;
    }),
  }));
  return { roles: [...PERSONA_ROLES], rows };
}

// ---------------------------------------------------------------------------
// 面板实现
// ---------------------------------------------------------------------------

export interface PersonaConsoleDeps {
  /** Persona持有的那份记忆(版本历史在 `memory.git`) */
  memory: GitWorkspaceMemory;
  memo: MemoTiers;
  /** MEMORY 3 此刻的浮现(Persona持有) */
  emergences(): string[];
  /** 首轮对话三份源的声明,由基类按部署目录给出;不给或为空 = 没有首轮对话。 */
  firstTurnDocs?: PromptDocDecl[];
  /**
   * 人格文本(PREFIX / ENV_SECTION / MEMORY)此刻该读的路径与保存路径,由Persona按
   * "部署 prompts/ 覆盖 > 包内默认"解析。不给 = 读写都是包内那份。
   */
  texts?: { path(name: string): string; writePath(name: string): string };
}

function memoryState(deps: PersonaConsoleDeps): MemoryState {
  const { memory: ws, memo } = deps;
  const resident = memo.residentFiles();
  const active = memo.activeFiles();
  const archived = memo.archivedCount();
  let topLevel = 0;
  try {
    topLevel = ws.listDir('').length;
  } catch {
    topLevel = 0;
  }
  let worldview = '';
  try {
    worldview = ws.readFile('WORLDVIEW.md');
  } catch {
    worldview = '';
  }
  const emergences = deps.emergences();
  return {
    tiers: [
      {
        id: 'MEMORY 0',
        title: '地图',
        detail: 'persona/ 最外层目录 + note/playbook/ 一级条目 + external/qq/images 最近 5 个。地图不是答案,往里翻要用工具。',
        live: `${topLevel} 个顶层条目`,
      },
      {
        id: 'MEMORY 1',
        title: '认知',
        detail: 'WORLDVIEW.md 全文(由梦维护)+ people/ 花名册。',
        live: worldview.trim() ? `WORLDVIEW.md ${worldview.length} 字` : '(还没有 WORLDVIEW.md)',
      },
      {
        id: 'MEMORY 2',
        title: '备忘',
        detail: '常驻 memo/ 全文进前缀;active/ 只列文件名;archived/ 只报数量,正文自己翻。容量由下面两个上限硬拦。',
        live: `常驻 ${resident.length}/${memo.caps.residentCap} · active ${active.length}/${memo.caps.activeCap} · archived ${archived}`,
      },
      {
        id: 'MEMORY 3',
        title: '反射',
        detail: '最近几场梦的浮现。存在人格状态袋里,最多留三缕。',
        live: emergences.length ? `${emergences.length} 缕` : '(此刻没有)',
      },
      {
        id: 'MEMORY 4',
        title: '当下',
        detail: '当前时间与时区。纯机械,每次拼前缀现算。',
        live: '每次组装现算',
      },
    ],
    memo: {
      residentCap: memo.caps.residentCap,
      activeCap: memo.caps.activeCap,
      resident,
      active,
      archived,
    },
    matrix: permissionMatrix(),
  };
}

/**
 * 组装Persona的 `PersonaConsoleDecl`。
 *
 * `invoke` 按 (面板, 方法) 分派,不认识的一律抛——控制台把抛出的错原样显示,
 * 所以措辞要写给人看。
 */
export function personaConsoleDecl(
  deps: PersonaConsoleDeps,
  language: Language = 'zh',
): PersonaConsoleDecl {
  const ws = deps.memory;
  const workspace = workspaceInvoke(ws);
  const text = (name: string): { path: string; deploymentPath?: string } => deps.texts
    ? { path: deps.texts.path(name), deploymentPath: deps.texts.writePath(name) }
    : { path: join(CORE_DIR, name) };
  return {
    panels: personaPanels(language),
    promptDocs: [{
      key: 'constitution',
      title: '宪法',
      description: 'Persona的长期原则；重载系统前缀后对当前 session 生效。',
      path: ws.resolveSafe('CONSTITUTION.md'),
    }, {
      key: 'persona.prefix',
      title: '前缀装配',
      description: '整份 system 前缀由哪几段、按什么顺序、用什么分隔线拼成。删掉一个占位符，那一段就不进前缀。',
      ...text('PREFIX.md'),
      role: 'prefix',
      vars: [
        { name: 'persona.orientation', description: 'ORIENTATION.md 全文。', multiline: true },
        { name: 'persona.constitution', description: 'CONSTITUTION.md 全文。', multiline: true },
        { name: 'worlds.envPrompts', description: '各 World 的环境提示词,按 World id 序,每段套「World 段」那份模板。', multiline: true },
        { name: 'persona.toolUsage', description: '工具用法段。**来自代码**(Persona原语的用法),改不了。 World 工具的说明不在这一段——见各 World 自己的环境提示词。', multiline: true },
        { name: 'memory.all', description: 'MEMORY 0~4 整块,内容见「记忆」那份模板。', multiline: true },
      ],
    }, {
      key: 'persona.envSection',
      title: 'World 段',
      description: '每个 World 那一节的外壳（标题与分隔线）。样式归Persona，所以同一个 World 能装在排版不同的人格上。',
      ...text('ENV_SECTION.md'),
      vars: [
        { name: 'world.id', description: 'World id。' },
        { name: 'world.envPrompt', description: '该 World 渲染好的环境提示词。', multiline: true },
      ],
    }, {
      key: 'persona.memory',
      title: '记忆',
      description: 'MEMORY 0~4 的骨架:五层的引导语、小标题与空态措辞。',
      ...text('MEMORY.md'),
      vars: [...MEMORY_VAR_DECLS],
    }, ...(deps.firstTurnDocs ?? [])],
    invoke: async (panel: string, method: string, args: unknown[]): Promise<unknown> => {
      if (panel === 'memory') {
        if (method === 'state') return memoryState(deps);
        throw new Error(`未知面板方法: ${panel}.${method}`);
      }
      return workspace(panel, method, args);
    },
  };
}
