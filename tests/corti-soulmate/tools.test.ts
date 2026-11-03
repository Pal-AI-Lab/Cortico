/**
 * 工具面:Cormini 的文件工具经 writeGuard 接上这份人格的写纪律(权限矩阵 + memo 容量守门
 * + CORE.md 只读),加 move_file 与 schedule_wake。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiSoulmate } from '../../bots/corti-soulmate/persona/index.ts';
import { makeCfg, makeFakeHarnessApi } from '../core/helpers.ts';
import { tmpPersona, cleanup, ctxFor, pick } from './helpers.ts';
import type { ToolDef } from '../../src/core/types.ts';

describe('工具集(按认知路径)', () => {
  let dir: string;
  let core: CortiSoulmate;
  let main: ToolDef[];
  let dream: ToolDef[];

  beforeEach(() => {
    dir = tmpPersona();
    const cfg = makeCfg();
    cfg.memo = { residentCap: 2, activeCap: 2 };
    core = new CortiSoulmate({ memoryDir: dir, cfg });
    const decls = core.declareSessions();
    main = decls.find((d) => d.id === 'main')!.tools();
    dream = decls.find((d) => d.id === 'dream')!.tools();
  });
  afterEach(() => cleanup(dir));

  const names = (ts: ToolDef[]) => ts.map((t) => t.name).sort();

  it('主 session = Cormini 文件工具 + save_blob + move_file + end_turn + schedule_wake;梦没有闹钟与收工', () => {
    expect(names(main)).toEqual([
      'append_file', 'delete_file', 'edit_file', 'end_turn', 'glob_files', 'grep_files', 'list_files',
      'move_file', 'read_file', 'save_blob', 'schedule_wake', 'write_file',
    ]);
    expect(names(dream)).toEqual([
      'append_file', 'delete_file', 'edit_file', 'glob_files', 'grep_files', 'list_files',
      'move_file', 'read_file', 'save_blob', 'write_file',
    ]);
  });

  it('自报的自有工具名 = 没挂 World 时主 session 的整张表(装配层据此拒绝撞名的 World)', () => {
    expect([...core.ownToolNames()].sort()).toEqual(names(main));
  });

  it('读写往返:write_file→read_file→list_files', async () => {
    const w = await pick(main, 'write_file').handler({ path: 'note/今天.md', content: '第一篇' }, ctxFor('main'));
    expect(w).toBe('[written] note/今天.md');
    const r = await pick(main, 'read_file').handler({ path: 'note/今天.md' }, ctxFor('main'));
    expect(r).toBe('第一篇');
    const l = await pick(main, 'list_files').handler({ dir: 'note' }, ctxFor('main'));
    expect(l).toContain('今天.md');
  });

  it('权限硬拦:拒绝时返回理由文本,不抛异常、不写文件', async () => {
    const wWorld = await pick(main, 'write_file').handler({ path: 'WORLDVIEW.md', content: 'x' }, ctxFor('main'));
    expect(wWorld).toContain('dream');
    expect(existsSync(join(dir, 'WORLDVIEW.md'))).toBe(false);

    const wConst = await pick(main, 'write_file').handler({ path: 'CONSTITUTION.md', content: 'x' }, ctxFor('main'));
    expect(wConst).toContain('read-only');

    const wPeople = await pick(main, 'write_file').handler({ path: 'people/阿明.md', content: 'x' }, ctxFor('main'));
    expect(wPeople).toContain('append');
    // 追加是允许的
    const ap = await pick(main, 'append_file').handler({ path: 'people/阿明.md', content: '阿明:群主\n' }, ctxFor('main'));
    expect(ap).toContain('[appended]');
  });

  it('等价路径不能绕过受保护区域的权限', async () => {
    const worldview = await pick(main, 'write_file').handler({ path: '././WORLDVIEW.md', content: 'x' }, ctxFor('main'));
    expect(worldview).toContain('dream');
    expect(existsSync(join(dir, 'WORLDVIEW.md'))).toBe(false);
  });

  it('梦可以改写宪法(只有梦重写),但不能删它', async () => {
    const w = await pick(dream, 'write_file').handler({ path: 'CONSTITUTION.md', content: '第一条:诚实。' }, ctxFor('dream'));
    expect(w).toBe('[written] CONSTITUTION.md');
    expect(readFileSync(join(dir, 'CONSTITUTION.md'), 'utf8')).toBe('第一条:诚实。');
    const d = await pick(dream, 'delete_file').handler({ path: 'CONSTITUTION.md' }, ctxFor('dream'));
    expect(d).toContain('[delete failed]');
    expect(existsSync(join(dir, 'CONSTITUTION.md'))).toBe(true);
  });

  it('main 的 delete_file 只在 external/ 生效', async () => {
    await pick(main, 'write_file').handler({ path: 'external/qq/images/旧图.png', content: 'x' }, ctxFor('main'));
    const deleted = await pick(main, 'delete_file').handler({ path: 'external/qq/images/旧图.png' }, ctxFor('main'));
    expect(deleted).toBe('[deleted] external/qq/images/旧图.png');
    expect(existsSync(join(dir, 'external', 'qq', 'images', '旧图.png'))).toBe(false);

    await pick(main, 'write_file').handler({ path: 'note/不能删.md', content: 'x' }, ctxFor('main'));
    const denied = await pick(main, 'delete_file').handler({ path: 'note/不能删.md' }, ctxFor('main'));
    expect(denied).toContain('dream');
    expect(existsSync(join(dir, 'note', '不能删.md'))).toBe(true);
  });

  it('read_file("CORE.md") 返回随软件走的机制说明;写它被拒', async () => {
    const t = await pick(main, 'read_file').handler({ path: 'CORE.md' }, ctxFor('main'));
    expect(typeof t).toBe('string');
    expect(t as string).toContain('CORE');
    const w = await pick(main, 'write_file').handler({ path: 'CORE.md', content: 'x' }, ctxFor('main'));
    expect(w).toContain('read-only');
    expect(existsSync(join(dir, 'CORE.md'))).toBe(false);
  });

  it('常驻满:write_file 被容量守门拦下并指向 move_file;下沉后可写', async () => {
    const wf = pick(main, 'write_file');
    const mv = pick(main, 'move_file');
    // 常驻cap=2:写满两条
    expect(await wf.handler({ path: 'memo/a.md', content: '1' }, ctxFor('main'))).toContain('[written]');
    expect(await wf.handler({ path: 'memo/b.md', content: '2' }, ctxFor('main'))).toContain('[written]');

    const full = await wf.handler({ path: 'memo/c.md', content: '3' }, ctxFor('main'));
    expect(full).toContain('full');
    expect(full).toContain('move_file');
    expect(existsSync(join(dir, 'memo', 'c.md'))).toBe(false);

    // 覆写已存在的常驻不占新位,放行
    expect(await wf.handler({ path: 'memo/a.md', content: '新' }, ctxFor('main'))).toContain('[written]');

    expect(await mv.handler({ from: 'memo/a.md', to: 'memo/active/a.md' }, ctxFor('main'))).toBe('[moved] memo/a.md → memo/active/a.md');
    expect(await wf.handler({ path: 'memo/c.md', content: '3' }, ctxFor('main'))).toContain('[written]');
    expect(existsSync(join(dir, 'memo', 'c.md'))).toBe(true);
  });

  it('memo容量守门覆盖无扩展名文件', async () => {
    const wf = pick(main, 'write_file');
    expect(await wf.handler({ path: 'memo/一', content: '1' }, ctxFor('main'))).toContain('[written]');
    expect(await wf.handler({ path: 'memo/二.txt', content: '2' }, ctxFor('main'))).toContain('[written]');
    const full = await wf.handler({ path: 'memo/三.md', content: '3' }, ctxFor('main'));
    expect(full).toContain('full');
    expect(existsSync(join(dir, 'memo', '三.md'))).toBe(false);
  });

  it('active/ 同样有容量守门:满时下沉被拦,指向 archived', async () => {
    const wf = pick(main, 'write_file');
    const mv = pick(main, 'move_file');
    await wf.handler({ path: 'memo/active/x.md', content: 'x' }, ctxFor('main'));
    await wf.handler({ path: 'memo/active/y.md', content: 'y' }, ctxFor('main'));
    await wf.handler({ path: 'memo/r.md', content: 'r' }, ctxFor('main'));
    const blocked = await mv.handler({ from: 'memo/r.md', to: 'memo/active/r.md' }, ctxFor('main'));
    expect(blocked).toContain('memo/active/ is full');
    expect(blocked).toContain('archived');
    expect(await mv.handler({ from: 'memo/active/x.md', to: 'memo/archived/x.md' }, ctxFor('main'))).toContain('[moved]');
    expect(await mv.handler({ from: 'memo/r.md', to: 'memo/active/r.md' }, ctxFor('main'))).toContain('[moved]');
  });

  it('main 可用 move_file 在 note/ 内搬运;people/ 仍拒绝改名', async () => {
    await pick(main, 'write_file').handler({ path: 'note/draft.md', content: '草稿' }, ctxFor('main'));
    const ok = await pick(main, 'move_file').handler({ from: 'note/draft.md', to: 'note/playbook/draft.md' }, ctxFor('main'));
    expect(ok).toContain('[moved]');
    expect(existsSync(join(dir, 'note', 'playbook', 'draft.md'))).toBe(true);

    await pick(main, 'append_file').handler({ path: 'people/阿明.md', content: '阿明:群主\n' }, ctxFor('main'));
    const denied = await pick(main, 'move_file').handler({ from: 'people/阿明.md', to: 'people/阿明-1.md' }, ctxFor('main'));
    expect(denied).toContain('people/');
    expect(existsSync(join(dir, 'people', '阿明.md'))).toBe(true);
  });

  it('梦经 ctx 冒充主意识也拿不到主意识没有的权限;主意识经 ctx 冒充梦同样按梦的矩阵算', async () => {
    // 权限按 ctx.role(session id)算,工具对象本身不带角色
    const r = await pick(dream, 'write_file').handler({ path: 'WORLDVIEW.md', content: 'x' }, ctxFor('main'));
    expect(r).toContain('dream');
    expect(existsSync(join(dir, 'WORLDVIEW.md'))).toBe(false);
  });
});

describe('点开头的路径与 save_blob 的落点', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  let dir: string;
  let core: CortiSoulmate;
  let tools: Record<'main' | 'dream', ToolDef[]>;

  beforeEach(() => {
    dir = tmpPersona();
    core = new CortiSoulmate({ memoryDir: dir, cfg: makeCfg() });
    core.attach(makeFakeHarnessApi({ blob: (h) => (h.startsWith('log:abcdef01') ? { bytes: PNG, mime: 'image/png' } : null) }));
    const decls = core.declareSessions();
    tools = {
      main: decls.find((d) => d.id === 'main')!.tools(),
      dream: decls.find((d) => d.id === 'dream')!.tools(),
    };
  });
  afterEach(() => cleanup(dir));

  for (const role of ['main', 'dream'] as const) {
    it(`${role} 写 .git/config、.gitattributes、.git/hooks/post-commit 都被拒绝`, async () => {
      for (const path of ['.git/config', '.gitattributes', '.git/hooks/post-commit']) {
        expect(await pick(tools[role], 'write_file').handler({ path, content: 'x\n' }, ctxFor(role))).toMatch(/^\[write failed\] /);
        expect(await pick(tools[role], 'append_file').handler({ path, content: 'x\n' }, ctxFor(role))).toMatch(/^\[append failed\] /);
        expect(await pick(tools[role], 'save_blob').handler({ handle: 'log:abcdef01', path }, ctxFor(role))).toMatch(/^\[save failed\] /);
      }
      expect(existsSync(join(dir, '.git/config'))).toBe(false);
      expect(existsSync(join(dir, '.gitattributes'))).toBe(false);
      expect(existsSync(join(dir, '.git/hooks/post-commit'))).toBe(false);
    });

    it(`${role} 的 move_file 来源或目标点开头都拒绝`, async () => {
      await pick(tools[role], 'write_file').handler({ path: 'note/a.md', content: 'a\n' }, ctxFor(role));
      expect(await pick(tools[role], 'move_file').handler({ from: 'note/a.md', to: '.git/hooks/post-commit' }, ctxFor(role))).toMatch(/^\[move failed\] /);
      expect(await pick(tools[role], 'move_file').handler({ from: 'note/a.md', to: '.gitattributes' }, ctxFor(role))).toMatch(/^\[move failed\] /);
      expect(readFileSync(join(dir, 'note/a.md'), 'utf8')).toBe('a\n');
      expect(existsSync(join(dir, '.git/hooks/post-commit'))).toBe(false);
    });
  }

});

/** 临时目录所在的卷会不会给普通文件生成 8.3 短名(CONSTITUTION.md 即 CONSTI~1.MD)。 */
const FILE_SHORT_NAMES = process.platform === 'win32' && (() => {
  const probe = mkdtempSync(join(tmpdir(), 'soulmate-8dot3-'));
  try {
    writeFileSync(join(probe, 'CONSTITUTION.md'), '');
    return realpathSync.native(join(probe, 'CONSTI~1.MD')) === realpathSync.native(join(probe, 'CONSTITUTION.md'));
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe.skipIf(process.platform !== 'win32')('Windows 上同一文件的别名按盘上的真实名字过权限', () => {
  let dir: string;
  let main: ToolDef[];

  beforeEach(() => {
    dir = tmpPersona();
    main = new CortiSoulmate({ memoryDir: dir, cfg: makeCfg() }).declareSessions().find((d) => d.id === 'main')!.tools();
    writeFileSync(join(dir, 'CONSTITUTION.md'), '第一条:诚实。\n', 'utf8');
  });
  afterEach(() => cleanup(dir));

  it.skipIf(!FILE_SHORT_NAMES)('main 的 write_file CONSTI~1.MD 被拒,宪法原样(卷上不生成 8.3 短名时跳过)', async () => {
    const out = await pick(main, 'write_file').handler({ path: 'CONSTI~1.MD', content: '改掉\n' }, ctxFor('main'));
    expect(out).toMatch(/^\[write failed\] /);
    expect(out).toContain('CONSTITUTION.md');
    expect(readFileSync(join(dir, 'CONSTITUTION.md'), 'utf8')).toBe('第一条:诚实。\n');
  });

  it('main 的 append_file CONSTITUTION.md::$DATA 被拒,宪法原样', async () => {
    const out = await pick(main, 'append_file').handler({ path: 'CONSTITUTION.md::$DATA', content: '追加\n' }, ctxFor('main'));
    expect(out).toMatch(/^\[append failed\] /);
    expect(readFileSync(join(dir, 'CONSTITUTION.md'), 'utf8')).toBe('第一条:诚实。\n');
  });

  it('大小写一致的普通写入和 draft~1.md 这类新文件照常成功', async () => {
    expect(await pick(main, 'write_file').handler({ path: 'note/今天.md', content: 'a\n' }, ctxFor('main'))).toBe('[written] note/今天.md');
    expect(await pick(main, 'write_file').handler({ path: 'note/今天.md', content: 'b\n' }, ctxFor('main'))).toBe('[written] note/今天.md');
    expect(await pick(main, 'write_file').handler({ path: 'note/draft~1.md', content: 'c\n' }, ctxFor('main'))).toBe('[written] note/draft~1.md');
    expect(readFileSync(join(dir, 'note', '今天.md'), 'utf8')).toBe('b\n');
    expect(readFileSync(join(dir, 'note', 'draft~1.md'), 'utf8')).toBe('c\n');
  });
});
