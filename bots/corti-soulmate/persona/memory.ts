/**
 * MEMORY 0–4 模板变量：工作区目录、WORLDVIEW 与人物索引、memo 内容与清单、近期梦摘要、时间。
 * 引导语和空态由 MEMORY.md 模板提供。
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryAssemblyContext, PromptVarDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';
import { MemoTiers } from './memoTiers.ts';
import { buildRoster } from './roster.ts';

/** WebUI 展示的模板变量说明。 */
export const MEMORY_VAR_DECLS: readonly PromptVarDecl[] = [
  { name: 'memory.tree', description: 'persona/ 最外层目录清单(只一层,目录带 /)。', multiline: true },
  { name: 'memory.playbooks', description: 'note/playbook/ 下的手册名,每行一条。', multiline: true },
  { name: 'memory.images', description: '表情包库里最近改动的 5 个文件名。', multiline: true },
  { name: 'memory.worldview', description: 'WORLDVIEW.md 全文(她的梦写的那份)。', multiline: true },
  { name: 'memory.roster', description: '人物花名册:每行「名字 — 档案第一行」。', multiline: true },
  { name: 'memory.memoResident', description: '常驻 memo 的全文,含 ── memo/x ── 分隔行。', multiline: true },
  { name: 'memory.memoActive', description: 'active/ 里的文件名(只列名不列正文)。' },
  { name: 'memory.memoArchivedCount', description: 'memo/archived/ 里的归档条数。' },
  { name: 'memory.emergences', description: '近期梦的浮现,每行一条。', multiline: true },
  { name: 'memory.now', description: '前缀组装那一刻的时间。**在两次前缀重建之间是冻结的**。' },
  { name: 'memory.timezone', description: '时区名。' },
];

/** external/qq/images/ 里最近的文件名,按mtime倒序取前n个(表情包库最近摘要用) */
function recentImageNames(memoryDir: string, n = 5): string[] {
  const dir = join(memoryDir, 'external', 'qq', 'images');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.includes('.tmp-'))
    .map((e) => ({ name: e.name, mtime: statSync(join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n)
    .map((e) => e.name);
}

export function memoryVars(
  ws: GitWorkspaceMemory,
  memo: MemoTiers,
  ctx: MemoryAssemblyContext,
  /** Persona所有的近期梦浮现(MEMORY 3)。 */
  emergences: string[],
): Record<string, string> {
  // 空值返回空串，由模板提供空态。
  let playbook: string[] = [];
  try {
    playbook = ws.listDir('note/playbook');
  } catch {
    playbook = [];
  }

  let worldview = '';
  try {
    worldview = (ws.readFile('WORLDVIEW.md') ?? '').trim();
  } catch {
    worldview = '';
  }

  const residents = memo.residentFiles().map((name) => {
    let body = '';
    try {
      body = ws.readFile(`memo/${name}`);
    } catch {
      body = '(读取失败)';
    }
    return `── memo/${name} ──\n${body.trimEnd()}`;
  });

  const actives = memo.activeFiles();

  return {
    'memory.tree': ws.treeShallow(),
    'memory.playbooks': playbook.map((n) => `- ${n}`).join('\n'),
    'memory.images': recentImageNames(ws.memoryDir, 5).map((n) => `- ${n}`).join('\n'),
    'memory.worldview': worldview,
    'memory.roster': buildRoster(ws.memoryDir),
    'memory.memoResident': residents.join('\n'),
    'memory.memoActive': actives.map((n) => `「${n}」`).join('、'),
    'memory.memoArchivedCount': String(memo.archivedCount()),
    'memory.emergences': emergences.map((e) => `- ${e}`).join('\n'),
    'memory.now': nowIso(ctx.timezone, ctx.now),
    'memory.timezone': ctx.timezone,
  };
}
