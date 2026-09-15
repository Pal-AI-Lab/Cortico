import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { personaPageContribution } from '../../src/bot.ts';
import { validateContributions } from '../../src/web/shared/console-protocol.ts';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { PERSONA_PANELS, personaConsoleDecl } from '../../bots/cortiv/persona/consoleSurface.ts';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import type { PersonaConsoleDecl, Persona } from '../../src/core/types.ts';

const BUNDLE_ENTRY = '../../bots/cortiv/console/client.ts';

function fakeCore(decl: PersonaConsoleDecl): Persona {
  return { console: () => decl } as unknown as Persona;
}

describe('CortiV 控制面声明', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cortiv-console-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('Persona按 bot id 铸名,面板是工作区/记忆/历史', () => {
    const c = personaPageContribution('cortiv', '可缇Corti', fakeCore({ panels: PERSONA_PANELS }));
    expect(c?.id).toBe('persona:cortiv');
    expect(c?.kind).toBe('persona');
    expect(c?.panels?.map((p) => p.id)).toEqual(['workspace', 'memory', 'history']);
    expect(validateContributions([c!])).toEqual([]);
  });

  it('CortiV.console() 保留 promptDocs,Memory 页是工作区三块且不带工作区清除项,并提供 invoke', () => {
    const core = new CortiV({ memoryDir: dir });
    const decl = core.console();
    // 没给 firstTurnDir(部署的 prompts/)就没有首轮对话三份;装配层会给
    expect(decl.promptDocs?.map((d) => d.key)).toEqual(['orientation', 'constitution', 'memoryNote']);
    const withFirstTurn = new CortiV({ memoryDir: dir, firstTurnDir: join(dir, 'prompts') }).console();
    expect(withFirstTurn.promptDocs?.map((d) => d.key)).toEqual([
      'orientation', 'constitution', 'memoryNote',
      'firstTurn.user', 'firstTurn.thinking', 'firstTurn.reply',
    ]);
    expect(decl.storage).toBeUndefined();
    expect(decl.panels).toBeUndefined();
    expect(decl.memory?.storage).toBeUndefined();
    expect(decl.memory?.panels?.map((p) => p.id)).toEqual(['workspace', 'memory', 'history']);
    expect(typeof decl.invoke).toBe('function');
  });

  it('装配 console() 不建仓、也不吃父进程的 GIT_DIR', () => {
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = join(dir, 'no-such-git');
    try {
      const core = new CortiV({ memoryDir: dir });
      expect(() => core.console()).not.toThrow();
      expect(existsSync(join(dir, '.git'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
    }
  });
});

describe('工作区 invoke', () => {
  let dir: string;
  let invoke: (panel: string, method: string, args?: unknown[]) => Promise<unknown>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortiv-ws-'));
    const decl = personaConsoleDecl({ memory: new GitWorkspaceMemory({ memoryDir: dir, warn: () => { /* 测试里不往控制台喊 */ } }) });
    invoke = (panel, method, args = []) => decl.invoke!(panel, method, args);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('写再读:内容与 revision 对得上;冲突底本拒绝覆盖', async () => {
    const created = await invoke('workspace', 'write', ['note.md', '第一版\n', null, true]) as {
      ok: true; revision: string;
    };
    expect(created.ok).toBe(true);
    expect(readFileSync(join(dir, 'note.md'), 'utf8')).toBe('第一版\n');

    const file = await invoke('workspace', 'read', ['note.md']) as { content: string; revision: string };
    expect(file.content).toBe('第一版\n');
    expect(file.revision).toBe(created.revision);

    const clash = await invoke('workspace', 'write', ['note.md', '抢写\n', 'not-the-hash']) as {
      ok: false; conflict: true; error: string;
    };
    expect(clash.ok).toBe(false);
    expect(clash.conflict).toBe(true);
    expect(clash.error).toContain('别处被修改');
    expect(readFileSync(join(dir, 'note.md'), 'utf8')).toBe('第一版\n');

    const saved = await invoke('workspace', 'write', ['note.md', '第二版\n', file.revision]) as {
      ok: true; revision: string;
    };
    expect(saved.ok).toBe(true);
    expect(readFileSync(join(dir, 'note.md'), 'utf8')).toBe('第二版\n');
  });

  it('路径逃逸与绝对路径都拒绝', async () => {
    await expect(invoke('workspace', 'read', ['../secret.md'])).rejects.toThrow('工作区');
    await expect(invoke('workspace', 'write', ['C:\\\\abs.md', 'x', null])).rejects.toThrow();
  });

  it('同名新建拒绝覆盖', async () => {
    writeFileSync(join(dir, 'exists.md'), '旧\n', 'utf8');
    const out = await invoke('workspace', 'write', ['exists.md', '新\n', null, true]) as {
      ok: false; conflict: true;
    };
    expect(out.ok).toBe(false);
    expect(out.conflict).toBe(true);
    expect(readFileSync(join(dir, 'exists.md'), 'utf8')).toBe('旧\n');
  });

  it('父进程带着无效 GIT_DIR 时,第一次保存仍能建仓并提交', async () => {
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = join(dir, 'no-such-git');
    try {
      const out = await invoke('workspace', 'write', ['a.md', 'hi\n', null, true]) as {
        ok: true; result: string;
      };
      expect(out.ok).toBe(true);
      expect(existsSync(join(dir, '.git'))).toBe(true);
      expect(out.result).toMatch(/已保存/);
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
    }
  });
});

describe('Memory 概览', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cortiv-mem-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('按来源统计 viewers/,并带上首行摘要', async () => {
    writeFileSync(join(dir, 'CONSTITUTION.md'), '# 我是谁\n', 'utf8');
    mkdirSync(join(dir, 'viewers', 'bilibili'), { recursive: true });
    writeFileSync(join(dir, 'viewers', 'bilibili', '314.md'), '常来下棋的人\n喜欢五子棋\n', 'utf8');
    const decl = personaConsoleDecl({ memory: new GitWorkspaceMemory({ memoryDir: dir, warn: () => { /* 测试里不往控制台喊 */ } }) });
    const st = await decl.invoke!('memory', 'state', []) as {
      workspaceFiles: number;
      constitutionChars: number;
      viewers: { total: number; bySource: Array<{ source: string; count: number }>; archives: Array<{ path: string; summary: string }> };
      note: string;
    };
    expect(st.viewers.total).toBe(1);
    expect(st.viewers.bySource).toEqual([{ source: 'bilibili', count: 1 }]);
    expect(st.viewers.archives[0]).toMatchObject({
      path: 'viewers/bilibili/314.md',
      summary: '常来下棋的人',
    });
    expect(st.constitutionChars).toBeGreaterThan(0);
    expect(st.note).toContain('viewers/');
    expect(st).not.toHaveProperty('tiers');
    expect(st).not.toHaveProperty('matrix');
  });
});

describe('浏览器扩展', () => {
  it('default export 的面板键 = 声明的三个局部 id,且都能 mount', async () => {
    const bundle = ((await import(BUNDLE_ENTRY)) as any).default;
    const declared = PERSONA_PANELS.map((p) => p.id);
    expect(Object.keys(bundle.panels).sort()).toEqual([...declared].sort());
    for (const id of declared) expect(typeof bundle.panels[id].mount).toBe('function');
  });
});
