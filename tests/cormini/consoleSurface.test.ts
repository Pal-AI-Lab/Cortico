/**
 * Memory 页的工作区与版本历史两块:目录树与读取、baseRevision 按内容 sha256 检查冲突、
 * createOnly 拒绝撞名、写路径以 operator 署名提交、历史面板一次问齐流水与介质状态。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  historyPanelDecl,
  workspaceInvoke,
  workspacePanelDecl,
  type WorkspaceFile,
  type WorkspaceNode,
  type WorkspaceWriteResult,
} from '../../bots/cormini/persona/consoleSurface.ts';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import type { WorkspaceGit } from '../../bots/cormini/persona/workspaceGit.ts';

const gitAvailable = new GitWorkspaceMemory({ memoryDir: process.cwd() }).git.available();

let dir: string;
let invoke: (panel: string, method: string, args: unknown[]) => Promise<unknown>;
let git: WorkspaceGit;

const call = <T>(panel: string, method: string, args: unknown[] = []): Promise<T> =>
  invoke(panel, method, args) as Promise<T>;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cormini-console-'));
  const memory = new GitWorkspaceMemory({ memoryDir: dir, warn: () => { /* 测试里不往控制台喊 */ } });
  memory.ensureDirs(['note', 'note/library', 'note/playbook']);
  writeFileSync(join(dir, 'note', 'a.md'), '第一版\n', 'utf8');
  mkdirSync(join(dir, 'log'), { recursive: true });
  writeFileSync(join(dir, 'log', 'today.md'), '今天\n', 'utf8');
  git = memory.git;
  git.init();
  invoke = workspaceInvoke(memory);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe('面板声明', () => {
  it('两块都是局部 id,标题随界面语言走', () => {
    expect([workspacePanelDecl('zh').id, historyPanelDecl('zh').id]).toEqual(['workspace', 'history']);
    expect(workspacePanelDecl('zh').title).toBe('工作区');
    expect(workspacePanelDecl('en').title).toBe('Workspace');
    expect(historyPanelDecl('en').title).toBe('Version history');
  });

  it('不认识的面板与方法各报各的,措辞写给人看', async () => {
    await expect(call('nope', 'state')).rejects.toThrow('未知面板');
    await expect(call('workspace', 'nope')).rejects.toThrow('未知面板方法');
  });
});

describe('工作区:目录树与读取', () => {
  it('树是递归的,目录在前、同类按名排;隐藏文件与原子写临时文件不进树', async () => {
    writeFileSync(join(dir, '.secret'), 'x', 'utf8');
    writeFileSync(join(dir, 'note', 'b.md.tmp-abc'), 'x', 'utf8');
    const { nodes, root } = await call<{ nodes: WorkspaceNode[]; root: string }>('workspace', 'tree');
    expect(root).toBe(dir);
    expect(nodes.map((n) => n.name)).not.toContain('.secret');
    const kinds = nodes.map((n) => n.type);
    expect(kinds.lastIndexOf('dir')).toBeLessThan(
      kinds.indexOf('file') === -1 ? Number.MAX_SAFE_INTEGER : kinds.indexOf('file'),
    );
    const note = nodes.find((n) => n.name === 'note');
    expect(note?.type).toBe('dir');
    // 子层同样是"目录在前、同类按名排",且临时文件没进来
    expect(note?.children?.map((c) => c.name)).toEqual(['library', 'playbook', 'a.md']);
  });

  it('read 回内容与 revision(= 内容的 sha256),目录/不存在各报各的', async () => {
    const f = await call<WorkspaceFile>('workspace', 'read', ['note/a.md']);
    expect(f.content).toBe('第一版\n');
    expect(f.revision).toBe(sha('第一版\n'));
    expect(f.size).toBeGreaterThan(0);
    await expect(call('workspace', 'read', ['note'])).rejects.toThrow('是目录');
    await expect(call('workspace', 'read', ['note/ghost.md'])).rejects.toThrow('文件不存在');
  });

  it('二进制文件拒绝预览', async () => {
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]));
    await expect(call('workspace', 'read', ['blob.bin'])).rejects.toThrow('二进制文件');
  });

  it('路径逃逸被工作区层拦下', async () => {
    await expect(call('workspace', 'read', ['../outside.md'])).rejects.toThrow('不允许离开');
  });
});

describe('工作区:保存的冲突检测', () => {
  it('底本对得上就写入,并回新的 revision', async () => {
    const before = await call<WorkspaceFile>('workspace', 'read', ['note/a.md']);
    const out = await call<WorkspaceWriteResult>(
      'workspace', 'write', ['note/a.md', '第二版\n', before.revision],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.revision).toBe(sha('第二版\n'));
    expect(readFileSync(join(dir, 'note', 'a.md'), 'utf8')).toBe('第二版\n');
  });

  it('底本对不上:拒绝写入,回原话与当前 revision(不覆盖别处的改动)', async () => {
    const stale = sha('别的版本\n');
    const out = await call<WorkspaceWriteResult>(
      'workspace', 'write', ['note/a.md', '我的版本\n', stale],
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.conflict).toBe(true);
    expect(out.error).toBe('文件已在别处被修改，请重新载入后再保存');
    expect(out.currentRevision).toBe(sha('第一版\n'));
    expect(readFileSync(join(dir, 'note', 'a.md'), 'utf8')).toBe('第一版\n');
  });

  it('底本文件已被移动或删除:同样拒绝', async () => {
    const out = await call<WorkspaceWriteResult>(
      'workspace', 'write', ['note/ghost.md', 'x', sha('x')],
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('文件已被移动或删除');
  });

  it('createOnly 撞上同名文件就拒绝,不覆盖', async () => {
    const out = await call<WorkspaceWriteResult>(
      'workspace', 'write', ['note/a.md', '新的', null, true],
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('同名文件已经存在');
    expect(readFileSync(join(dir, 'note', 'a.md'), 'utf8')).toBe('第一版\n');
  });

  it('不给底本 = 不核对(新建走这条路)', async () => {
    const out = await call<WorkspaceWriteResult>('workspace', 'write', ['note/new.md', '内容', null]);
    expect(out.ok).toBe(true);
    expect(readFileSync(join(dir, 'note', 'new.md'), 'utf8')).toBe('内容');
  });

  it('超过 1MB / 含 NUL 的正文拒绝保存', async () => {
    await expect(
      call('workspace', 'write', ['note/big.md', 'x'.repeat(1024 * 1024 + 1), null]),
    ).rejects.toThrow('文件超过1MB');
    await expect(
      call('workspace', 'write', ['note/nul.md', 'a\0b', null]),
    ).rejects.toThrow('NUL');
  });

  it('删除与改名同样核对底本,措辞各自成句', async () => {
    const stale = sha('别的\n');
    const del = await call<WorkspaceWriteResult>('workspace', 'remove', ['note/a.md', stale]);
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.error).toBe('文件已在别处被修改，请重新载入后再删除');

    const ren = await call<WorkspaceWriteResult>('workspace', 'rename', ['note/a.md', 'note/b.md', stale]);
    expect(ren.ok).toBe(false);
    if (!ren.ok) expect(ren.error).toBe('文件已在别处被修改，请重新载入后再改名');
  });
});

describe.skipIf(!gitAvailable)('工作区:写路径带提交', () => {
  it('编辑立即提交,署名 operator,回执带短 hash', async () => {
    const before = await call<WorkspaceFile>('workspace', 'read', ['note/a.md']);
    const out = await call<WorkspaceWriteResult>(
      'workspace', 'write', ['note/a.md', '第二版\n', before.revision],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result).toMatch(/已保存并提交\(/);
    const last = git.log({ limit: 1 })[0];
    expect(last.author).toBe('operator');
    expect(last.message).toBe('控制台编辑 note/a.md');
  });

  it('某个文件的历史 / diff / 旧版本全文都取得到', async () => {
    const before = await call<WorkspaceFile>('workspace', 'read', ['note/a.md']);
    await call('workspace', 'write', ['note/a.md', '第二版\n', before.revision]);
    const { commits } = await call<{ commits: Array<{ fullHash: string }> }>(
      'workspace', 'history', ['note/a.md'],
    );
    expect(commits.length).toBeGreaterThanOrEqual(1);
    const d = await call<{ diff: string }>('workspace', 'diff', [commits[0].fullHash, 'note/a.md']);
    expect(d.diff).toContain('第二版');
    const at = await call<{ content: string }>('workspace', 'at', [commits[0].fullHash, 'note/a.md']);
    expect(at.content).toBe('第二版\n');
  });
});

describe.skipIf(!gitAvailable)('版本历史面板', () => {
  it('整仓流水 + 介质状态一次问齐;路径过滤只看那一支', async () => {
    const st = await call<{ status: { repo: boolean }; commits: unknown[]; path: string }>(
      'history', 'state', [],
    );
    expect(st.status.repo).toBe(true);
    expect(st.commits.length).toBeGreaterThanOrEqual(1);
    expect(st.path).toBe('');

    const before = await call<WorkspaceFile>('workspace', 'read', ['log/today.md']);
    await call('workspace', 'write', ['log/today.md', '改过\n', before.revision]);
    const filtered = await call<{ commits: Array<{ message: string }>; path: string }>(
      'history', 'state', ['log/today.md'],
    );
    expect(filtered.path).toBe('log/today.md');
    expect(filtered.commits.every((c) => !c.message.startsWith('控制台编辑 note/'))).toBe(true);
  });
});
