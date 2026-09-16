/**
 * 人格控制面声明局部 id 与标题；Memory 分层读数取自真目录；权限矩阵逐格执行 checkAccess 得出。
 * 工作区与版本历史两块的行为在 tests/cormini/consoleSurface.test.ts。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { personaConsoleDecl, personaPanels } from '../../bots/corti-soulmate/persona/consoleSurface.ts';
import type { MemoryState } from '../../bots/corti-soulmate/persona/consoleSurface.ts';
import { MemoTiers } from '../../bots/corti-soulmate/persona/memoTiers.ts';
import type { PersonaRole } from '../../bots/corti-soulmate/persona/permissions.ts';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import type { WorkspaceGit } from '../../bots/cormini/persona/workspaceGit.ts';
import type { PersonaConsoleDecl } from '../../src/core/types.ts';
import { cleanup, tmpPersona, WORKSPACE_DIRS } from './helpers.ts';

const gitAvailable = new GitWorkspaceMemory({ memoryDir: process.cwd() }).git.available();

let dir: string;
let decl: PersonaConsoleDecl;
let git: WorkspaceGit;

const call = <T>(panel: string, method: string, args: unknown[] = []): Promise<T> =>
  decl.invoke!(panel, method, args) as Promise<T>;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  dir = tmpPersona();
  const memory = new GitWorkspaceMemory({ memoryDir: dir, warn: () => { /* 测试里不往控制台喊 */ } });
  memory.ensureDirs(WORKSPACE_DIRS);
  writeFileSync(join(dir, 'note', 'a.md'), '第一版\n', 'utf8');
  writeFileSync(join(dir, 'memo', 'today.md'), '今天\n', 'utf8');
  mkdirSync(join(dir, 'memo', 'active'), { recursive: true });
  writeFileSync(join(dir, 'memo', 'active', 'later.md'), '回头看\n', 'utf8');
  git = memory.git;
  git.init();
  decl = personaConsoleDecl({
    memory,
    memo: new MemoTiers(memory, { residentCap: 5, activeCap: 9 }),
    emergences: () => ['[surfaced from association] 一缕'],
  });
});

afterEach(() => cleanup(dir));

// ---------------------------------------------------------------------------

describe('Persona的面板声明', () => {
  it('三个面板都是局部 id + 真标题,不带 bot 名前缀', () => {
    expect(personaPanels().map((p) => p.id)).toEqual(['workspace', 'memory', 'history']);
    expect(personaPanels().map((p) => p.title)).toEqual(['工作区', 'Memory 分层', '版本历史']);
    expect(decl.panels).toEqual(personaPanels());
  });

  it('不认识的面板与方法各报各的,措辞写给人看', async () => {
    await expect(call('nope', 'state')).rejects.toThrow('未知面板');
    await expect(call('memory', 'nope')).rejects.toThrow('未知面板方法');
  });
});

describe('Memory 面板', () => {
  it('五层都在,memo 三级读数取自真目录', async () => {
    const st = await call<MemoryState>('memory', 'state');
    expect(st.tiers.map((t) => t.id)).toEqual([
      'MEMORY 0', 'MEMORY 1', 'MEMORY 2', 'MEMORY 3', 'MEMORY 4',
    ]);
    expect(st.memo.resident).toEqual(['today.md']);
    expect(st.memo.active).toEqual(['later.md']);
    expect(st.memo.residentCap).toBe(5);
    expect(st.memo.activeCap).toBe(9);
    // MEMORY 3 的读数来自Persona持有的浮现
    expect(st.tiers[3].live).toContain('1');
  });

  it('权限矩阵逐格现算:主意识对 people/ 只能追加、external/ 全权,梦全区可写', async () => {
    const st = await call<MemoryState>('memory', 'state');
    expect(st.matrix.roles).toEqual(['main', 'dream']);
    const at = (zone: string, role: PersonaRole) => {
      const row = st.matrix.rows.find((r) => r.zone === zone)!;
      return row.cells[st.matrix.roles.indexOf(role)];
    };
    // 读一律放行,所以每一格都含 read
    for (const row of st.matrix.rows) {
      for (const cell of row.cells) expect(cell.allowed).toContain('read');
    }
    expect(at('note', 'main').allowed).toEqual(['read', 'write', 'append', 'rename']);
    expect(at('people', 'main').allowed).toEqual(['read', 'append']);
    expect(at('external', 'main').allowed).toEqual(['read', 'write', 'append', 'rename', 'delete']);
    expect(at('worldview', 'dream').allowed).toEqual(['read', 'write', 'append', 'rename', 'delete']);
    // 拒绝理由就是 agent 会收到的那句原话
    expect(at('worldview', 'main').denied[0].reason).toContain('dream');
  });

  it('宪法归梦修订:梦可改内容,不能改名删除;主意识只读', async () => {
    const st = await call<MemoryState>('memory', 'state');
    const row = st.matrix.rows.find((r) => r.zone === 'constitution')!;
    expect(row.cells[st.matrix.roles.indexOf('dream')].allowed).toEqual(['read', 'write', 'append']);
    expect(row.cells[st.matrix.roles.indexOf('main')].allowed).toEqual(['read']);
  });
});
