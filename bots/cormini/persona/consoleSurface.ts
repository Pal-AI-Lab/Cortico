/**
 * 「工作区」与「版本历史」两块面板的服务端实现:目录树、文件读写与 Git 历史。
 * 保存、删除与改名以 operator 署名提交;读取返回的 revision 与保存校验的 baseRevision
 * 是同一个内容指纹。浏览器端在 ../console/。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { pick, type Language } from 'cortico/core/language.ts';
import type { WorldPanelDecl } from 'cortico/core/types.ts';
import type { GitWorkspaceMemory } from './memory.ts';
import { AUTHOR_OPERATOR } from './workspaceGit.ts';

const PANEL_TEXT = {
  zh: {
    workspace: '工作区',
    workspaceDesc: '保存时以 operator 署名提交到工作区的 Git 仓库。',
    history: '版本历史',
  },
  en: {
    workspace: 'Workspace',
    workspaceDesc: 'Saving commits to the workspace Git repository, authored as operator.',
    history: 'Version history',
  },
};

export function workspacePanelDecl(language: Language = 'zh'): WorldPanelDecl {
  const t = pick(language, PANEL_TEXT);
  return { id: 'workspace', title: t.workspace, description: t.workspaceDesc };
}

export function historyPanelDecl(language: Language = 'zh'): WorldPanelDecl {
  return { id: 'history', title: pick(language, PANEL_TEXT).history };
}

const FILE_MAX_BYTES = 1024 * 1024;

function revisionOf(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface WorkspaceNode {
  name: string;
  /** 相对 memoryDir 的路径，使用正斜杠。 */
  path: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
  children?: WorkspaceNode[];
}

export interface WorkspaceFile {
  path: string;
  content: string;
  revision: string;
  size: number;
  mtime: string | null;
}

/** conflict 表示文件内容已变化，本次操作未执行。 */
export type WorkspaceWriteResult =
  | { ok: true; result: string; revision: string }
  | { ok: false; conflict: true; error: string; currentRevision?: string };

/** 隐藏文件与原子写的临时文件不进树(与工作区工具、git 忽略的口径一致)。 */
function visible(name: string): boolean {
  return !name.startsWith('.') && !name.includes('.tmp-');
}

function buildTree(absDir: string, rel: string): WorkspaceNode[] {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: WorkspaceNode[] = [];
  for (const e of entries) {
    if (!visible(e.name)) continue;
    const path = rel ? `${rel}/${e.name}` : e.name;
    const abs = join(absDir, e.name);
    if (e.isDirectory()) {
      nodes.push({ name: e.name, path, type: 'dir', children: buildTree(abs, path) });
      continue;
    }
    if (!e.isFile()) continue;
    const node: WorkspaceNode = { name: e.name, path, type: 'file' };
    try {
      const st = statSync(abs);
      node.size = st.size;
      node.mtime = st.mtime.toISOString();
    } catch {
      // readdir 与 stat 之间文件可能消失;少一组读数不影响这一格能不能点开
    }
    nodes.push(node);
  }
  nodes.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
  return nodes;
}

function commitNote(hash: string | null, ok: string): string {
  return hash ? `${ok}并提交(${hash})` : `${ok}(git 未提交:无改动或不可用)`;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`缺少 ${what}`);
  return v.trim();
}

/** 空或非字符串 = 没有底本,不核对。 */
function optRevision(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

const conflict = (error: string, currentRevision?: string): WorkspaceWriteResult =>
  currentRevision === undefined
    ? { ok: false, conflict: true, error }
    : { ok: false, conflict: true, error, currentRevision };

function checkBase(
  ws: GitWorkspaceMemory,
  path: string,
  baseRevision: string | null,
  verb: '保存' | '删除' | '改名',
): WorkspaceWriteResult | null {
  if (baseRevision === null) return null;
  const abs = ws.resolveSafe(path);
  if (!existsSync(abs) || statSync(abs).isDirectory()) {
    return conflict('文件已被移动或删除');
  }
  const current = revisionOf(readFileSync(abs));
  if (current !== baseRevision) {
    return verb === '保存'
      ? conflict(`文件已在别处被修改，请重新载入后再${verb}`, current)
      : conflict(`文件已在别处被修改，请重新载入后再${verb}`);
  }
  return null;
}

function readFilePanel(ws: GitWorkspaceMemory, rel: string): WorkspaceFile {
  const path = ws.normalize(rel);
  const abs = ws.resolveSafe(path);
  if (!existsSync(abs)) throw new Error(`文件不存在:${path}`);
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error(`${path} 是目录,不是文件`);
  if (st.size > FILE_MAX_BYTES) throw new Error('文件超过1MB,拒绝预览');
  const buf = readFileSync(abs);
  if (buf.includes(0)) throw new Error('二进制文件,拒绝预览');
  return {
    path,
    content: buf.toString('utf8'),
    revision: revisionOf(buf),
    size: st.size,
    mtime: st.mtime.toISOString(),
  };
}

function writeFilePanel(ws: GitWorkspaceMemory, args: unknown[]): WorkspaceWriteResult {
  const [rawPath, content, base, createOnly] = args;
  const path = str(rawPath, 'path');
  if (typeof content !== 'string') throw new Error('content 必须是字符串');
  if (content.includes('\0')) throw new Error('文本不能包含 NUL 字符');
  if (Buffer.byteLength(content, 'utf8') > FILE_MAX_BYTES) {
    throw new Error('文件超过1MB，拒绝保存');
  }
  if (createOnly === true && ws.exists(path)) {
    return conflict('同名文件已经存在');
  }
  const blocked = checkBase(ws, path, optRevision(base), '保存');
  if (blocked) return blocked;
  ws.writeFileAtomic(path, content);
  const hash = ws.git.commitAll(`控制台编辑 ${ws.normalize(path)}`, AUTHOR_OPERATOR);
  return { ok: true, result: commitNote(hash, '已保存'), revision: revisionOf(content) };
}

function removeFilePanel(ws: GitWorkspaceMemory, args: unknown[]): WorkspaceWriteResult {
  const path = str(args[0], 'path');
  const blocked = checkBase(ws, path, optRevision(args[1]), '删除');
  if (blocked) return blocked;
  ws.deleteFile(path);
  const hash = ws.git.commitAll(`控制台删除 ${ws.normalize(path)}`, AUTHOR_OPERATOR);
  return { ok: true, result: commitNote(hash, '已删除'), revision: '' };
}

function renameFilePanel(ws: GitWorkspaceMemory, args: unknown[]): WorkspaceWriteResult {
  const from = str(args[0], 'from');
  const to = str(args[1], 'to');
  const blocked = checkBase(ws, from, optRevision(args[2]), '改名');
  if (blocked) return blocked;
  ws.renameFile(from, to);
  const hash = ws.git.commitAll(
    `控制台改名 ${ws.normalize(from)} → ${ws.normalize(to)}`,
    AUTHOR_OPERATOR,
  );
  return { ok: true, result: commitNote(hash, '已改名'), revision: '' };
}

/** `workspace` 与 `history` 两块面板的方法分派;变体先处理自己那块,其余交给它。 */
export function workspaceInvoke(
  memory: GitWorkspaceMemory,
): (panel: string, method: string, args: unknown[]) => Promise<unknown> {
  const ws = memory;
  const git = ws.git;
  return async (panel: string, method: string, args: unknown[]): Promise<unknown> => {
    if (panel === 'workspace') {
      switch (method) {
        case 'tree':
          return { nodes: buildTree(ws.memoryDir, ''), root: ws.memoryDir };
        case 'read':
          return readFilePanel(ws, str(args[0], 'path'));
        case 'write':
          return writeFilePanel(ws, args);
        case 'remove':
          return removeFilePanel(ws, args);
        case 'rename':
          return renameFilePanel(ws, args);
        case 'history':
          return { commits: git.log({ path: str(args[0], 'path'), limit: 100 }) };
        case 'diff':
          return { diff: git.diff(str(args[0], 'hash'), { path: str(args[1], 'path') }) };
        case 'at':
          return { content: git.fileAt(str(args[0], 'hash'), str(args[1], 'path')) };
        default:
          throw new Error(`未知面板方法: ${panel}.${method}`);
      }
    }
    if (panel === 'history') {
      switch (method) {
        case 'state': {
          const path = typeof args[0] === 'string' && args[0].trim() ? args[0].trim() : undefined;
          return {
            status: git.status(),
            commits: git.log(path ? { path, limit: 100 } : { limit: 100 }),
            path: path ?? '',
          };
        }
        case 'diff': {
          const path = typeof args[1] === 'string' && args[1].trim() ? args[1].trim() : undefined;
          return { diff: git.diff(str(args[0], 'hash'), path ? { path } : undefined) };
        }
        case 'at':
          return { content: git.fileAt(str(args[0], 'hash'), str(args[1], 'path')) };
        default:
          throw new Error(`未知面板方法: ${panel}.${method}`);
      }
    }
    throw new Error(`未知面板: ${panel}`);
  };
}
