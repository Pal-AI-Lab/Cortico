/**
 * 每次笔记写入提交到 workspace 的 git 历史，git_log / git_show 可读取该历史。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiV, shrinkNote } from '../../bots/cortiv/persona/persona.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { ToolDef } from '../../src/core/types.ts';


function tool(p: CortiV, name: string): ToolDef {
  return p.declareSessions().find((d) => d.id === 'main')!.tools().find((t) => t.name === name)!;
}

function writeTool(p: CortiV): ToolDef {
  return tool(p, 'write_file');
}

const run = (t: ToolDef, args: Record<string, unknown>): Promise<string> =>
  t.handler(args, { role: 'main', log: nullLogger() }) as Promise<string>;

const call = (t: ToolDef, path: string, content: string, role = 'main'): Promise<string> =>
  t.handler({ path, content }, { role, log: nullLogger() }) as Promise<string>;

describe('write_file 留痕', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cortiv-commit-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const gitLog = (): string =>
    execFileSync('git', ['-C', dir, '-c', 'safe.directory=*', 'log', '--pretty=format:%an|%s'], {
      encoding: 'utf8',
    });

  it('她写的每一份都进 git 历史,署她自己的名', async () => {
    const p = new CortiV({ memoryDir: dir });
    const write = writeTool(p);
    await call(write, 'notes/a.md', '一\n');
    await call(write, 'notes/b.md', '二\n', 'dream');
    const log = gitLog();
    expect(log).toContain('corti|她写了 notes/a.md');
    expect(log).toContain('corti|后台整理写了 notes/b.md');
  });

  it('第一份笔记不会被收编进 checkpoint0——建仓赶在落笔之前', async () => {
    const p = new CortiV({ memoryDir: dir });
    await call(writeTool(p), 'notes/first.md', '第一份\n');
    const shown = execFileSync(
      'git', ['-C', dir, '-c', 'safe.directory=*', 'show', '--stat', '--pretty=format:%s', 'checkpoint0'],
      { encoding: 'utf8' },
    );
    expect(shown).toContain('checkpoint0');
    expect(shown).not.toContain('notes/first.md');
  });
});

describe('git_log / git_show:她自己读得到自己的编辑历史', () => {
  let dir: string;
  let p: CortiV;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortiv-hist-'));
    p = new CortiV({ memoryDir: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const full = '# 地图\n\n## 村庄\n\n村里四个箱子:小麦、胡萝卜、床、铁锭。\n\n## 矿洞\n\n从家往北 200 格。\n';
  const gutted = '# 地图\n\n家在出生点旁边。\n';

  it('列出这份文件的历次版本:短 hash、时刻、增删行数', async () => {
    await run(writeTool(p), { path: '地图.md', content: full });
    await run(writeTool(p), { path: '地图.md', content: gutted });
    const out = await run(tool(p, 'git_log'), { path: '地图.md' });
    const lines = out.split('\n').filter((l) => /^[0-9a-f]{8} /.test(l));
    expect(lines).toHaveLength(2);
    // 新→旧:第一行是把它挖空的那一次,减的行数看得见
    expect(lines[0]).toMatch(/-\d/);
    expect(lines[0]).toContain('她写了 地图.md');
    // 中文路径不能被 quotepath 转义成八进制,否则按路径挑不中这一档
    expect(out).not.toContain('\\345');
  });

  it('不给 path 就是整个工作区的流水', async () => {
    await run(writeTool(p), { path: '地图.md', content: full });
    await run(writeTool(p), { path: 'notes/b.md', content: '二\n' });
    const out = await run(tool(p, 'git_log'), {});
    expect(out).toContain('地图.md');
    expect(out).toContain('notes/b.md');
  });

  it('git_show 取回旧版全文;恢复要她自己 write_file 写回去', async () => {
    await run(writeTool(p), { path: '地图.md', content: full });
    await run(writeTool(p), { path: '地图.md', content: gutted });
    const log = await run(tool(p, 'git_log'), { path: '地图.md' });
    const hashes = log.split('\n')
      .map((l) => /^([0-9a-f]{8}) /.exec(l)?.[1])
      .filter((h): h is string => Boolean(h));
    expect(hashes).toHaveLength(2);
    const out = await run(tool(p, 'git_show'), { path: '地图.md', rev: hashes[1] });
    expect(out).toContain('小麦、胡萝卜、床、铁锭');
    // 只读:没有 checkout/回滚,盘上仍是挖空的那一版
    expect(await run(tool(p, 'read_file'), { path: '地图.md' })).toBe(gutted);
  });

  it('路径逃逸被拒;hash 打错说得清楚', async () => {
    await run(writeTool(p), { path: '地图.md', content: full });
    expect(await run(tool(p, 'git_log'), { path: '../../etc/passwd' })).toContain('[拒绝]');
    expect(await run(tool(p, 'git_show'), { path: '../x', rev: 'abcdef12' })).toContain('[拒绝]');
    expect(await run(tool(p, 'git_show'), { path: '地图.md', rev: 'deadbee' })).toContain('[取不到]');
    expect(await run(tool(p, 'git_show'), { path: '地图.md', rev: '' })).toContain('[缺参数]');
    expect(await run(tool(p, 'git_log'), { path: '没写过.md' })).toContain('[无历史]');
  });
});

describe('write_file 缩水提示', () => {
  it('缩掉一半以上:点名将要消失的小节,不拦截', () => {
    const prev = `# 地图\n\n## 村庄\n${'村里四个箱子。\n'.repeat(20)}\n## 矿洞\n${'往北 200 格。\n'.repeat(20)}`;
    const note = shrinkNote(prev, '# 地图\n\n家在出生点旁边。\n')!;
    expect(note).toContain('[缩水提示]');
    // 只点名真丢的那几节:「地图」这一节还在,不进名单
    expect(note).toContain('将要消失的小节:村庄、矿洞。');
    expect(note).toContain('git_show');
  });

  it('没缩掉一半、或本来就短:不提示', () => {
    const prev = 'x'.repeat(1000);
    expect(shrinkNote(prev, 'x'.repeat(600))).toBeNull();
    expect(shrinkNote('# 短\n小文件\n', '')).toBeNull();
  });

  it('缩水但没有小节标题:只说长度,照样给取回的路', () => {
    const note = shrinkNote('流水账\n'.repeat(100), '一句话\n')!;
    expect(note).toContain('[缩水提示]');
    expect(note).toContain('git_log');
    expect(note).not.toContain('将要消失的小节');
  });

  it('提示走 write_file 回执,写入照样成功', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortiv-shrink-'));
    try {
      const p = new CortiV({ memoryDir: dir });
      const prev = `# 地图\n\n## 村庄\n${'村里四个箱子。\n'.repeat(40)}`;
      await run(writeTool(p), { path: '地图.md', content: prev });
      const first = await run(writeTool(p), { path: '地图.md', content: '# 地图\n\n没了\n' });
      expect(first).toContain('[written] 地图.md');
      expect(first).toContain('村庄');
      // 第一次写一份新文件没有上一版可比,不该冒出提示
      const fresh = await run(writeTool(p), { path: '新的.md', content: '一\n' });
      expect(fresh).toBe('[written] 新的.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * append_file 保留旧正文，回执报告追加量与总大小，写入也进入版本历史。
 */
describe('append_file:只往后长的那条路', () => {
  let dir: string;
  let p: CortiV;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortiv-append-'));
    p = new CortiV({ memoryDir: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const appendTool = (): ToolDef => tool(p, 'append_file');

  it('追加保留旧正文，回执报告追加量与总大小', async () => {
    await run(writeTool(p), { path: '日志/0828.md', content: '# 0828\n第一条\n' });
    const out = await run(appendTool(), { path: '日志/0828.md', content: '第二条\n' });
    expect(out).toBe('[appended] 日志/0828.md +4 字符,现在 15 字符。');
    expect(await run(tool(p, 'read_file'), { path: '日志/0828.md' })).toBe('# 0828\n第一条\n第二条\n');
  });

  it('文件不存在就是新建,回执说明这一点(父目录一并建出来)', async () => {
    const out = await run(appendTool(), { path: '日志/新的/0828.md', content: '第一条\n' });
    expect(out).toContain('原本没有这份文件,已新建');
    expect(out).toContain('+4 字符,现在 4 字符');
    expect(await run(tool(p, 'read_file'), { path: '日志/新的/0828.md' })).toBe('第一条\n');
  });

  it('上一行没换行就先补一个,并在回执里说清', async () => {
    await run(writeTool(p), { path: 'a.md', content: '第一条' });
    const out = await run(appendTool(), { path: 'a.md', content: '第二条' });
    expect(out).toContain('上一行没有换行,先替你补了一个');
    // 补的换行算进加了多少:数字对得上盘上的正文
    expect(out).toContain('+4 字符');
    expect(out).toContain('现在 7 字符');
    expect(await run(tool(p, 'read_file'), { path: 'a.md' })).toBe('第一条\n第二条');
  });

  it('追加同样进 git 历史,署她自己的名', async () => {
    await run(appendTool(), { path: '日志/0828.md', content: '第一条\n' });
    await run(appendTool(), { path: '日志/0828.md', content: '第二条\n' });
    const log = execFileSync(
      'git', ['-C', dir, '-c', 'safe.directory=*', 'log', '--pretty=format:%an|%s'],
      { encoding: 'utf8' },
    );
    expect(log).toContain('corti|她追加了 日志/0828.md');
    // 她自己也读得到:git_log 列得出这两版
    const shown = await run(tool(p, 'git_log'), { path: '日志/0828.md' });
    expect(shown.split('\n').filter((l) => /^[0-9a-f]{8} /.test(l))).toHaveLength(2);
  });

  it('后台整理线程追加时署的是后台的名', async () => {
    await run(appendTool(), { path: 'b.md', content: '一\n' });
    await appendTool().handler({ path: 'b.md', content: '二\n' }, { role: 'dream', log: nullLogger() });
    const log = execFileSync(
      'git', ['-C', dir, '-c', 'safe.directory=*', 'log', '--pretty=format:%s'],
      { encoding: 'utf8' },
    );
    expect(log).toContain('后台整理追加了 b.md');
  });

  it('路径逃逸与目录被拒,不抛异常', async () => {
    expect(await run(appendTool(), { path: '../外面.md', content: 'x' })).toContain('[append failed]');
    await run(writeTool(p), { path: '子目录/x.md', content: 'x\n' });
    expect(await run(appendTool(), { path: '子目录', content: 'x' })).toContain('是目录');
  });

  it('追加工具声明 write 标签', () => {
    expect(appendTool().tags).toContain('write');
  });
});

/**
 * 改一段与删文件同样进版本历史,署名规则与 write_file 相同;落盘失败的不提交。
 */
describe('edit_file / delete_file 留痕', () => {
  let dir: string;
  let p: CortiV;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortiv-edit-'));
    p = new CortiV({ memoryDir: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const subjects = (): string => execFileSync(
    'git', ['-C', dir, '-c', 'safe.directory=*', 'log', '--pretty=format:%an|%s'],
    { encoding: 'utf8' },
  );

  it('改档案首行提交一次,署她的名;后台改的署后台的名', async () => {
    const path = 'viewers/bilibili/1.md';
    await run(writeTool(p), { path, content: '甲(1) — 旧印象\n\n事实一。\n' });
    const out = await run(tool(p, 'edit_file'), { path, old_string: '旧印象', new_string: '新印象' });
    expect(out).toContain(`[edited] ${path} 第 1 行`);
    await tool(p, 'edit_file').handler(
      { path, old_string: '新印象', new_string: '再新的印象' },
      { role: 'dream', log: nullLogger() },
    );
    const log = subjects();
    expect(log).toContain(`corti|她改了 ${path}`);
    expect(log).toContain(`corti|后台整理改了 ${path}`);
    expect(await run(tool(p, 'read_file'), { path })).toBe('甲(1) — 再新的印象\n\n事实一。\n');
  });

  it('失败的改动不提交;删除提交一次并能在历史里看到', async () => {
    await run(writeTool(p), { path: 'x.md', content: 'x\n' });
    const before = subjects().split('\n').length;
    expect(await run(tool(p, 'edit_file'), { path: 'x.md', old_string: '没有', new_string: 'y' })).toContain('[edit failed]');
    expect(subjects().split('\n').length).toBe(before);
    expect(await run(tool(p, 'delete_file'), { path: 'nope.md' })).toContain('[delete failed]');
    expect(await run(tool(p, 'delete_file'), { path: 'x.md' })).toBe('[deleted] x.md');
    expect(subjects()).toContain('corti|她删了 x.md');
    // 删掉的文件历史还在:git_show 能把旧版本读回来
    const shown = await run(tool(p, 'git_log'), { path: 'x.md' });
    expect(shown.split('\n').filter((l) => /^[0-9a-f]{8} /.test(l)).length).toBeGreaterThanOrEqual(2);
  });

  it('整份移动和按行移动各提交一次,署她的名', async () => {
    await run(writeTool(p), { path: 'sessions/a.md', content: '一\n二\n' });
    expect(await run(tool(p, 'move_file'), { from: 'sessions/a.md', to: 'archive/a.md' })).toBe('[moved] sessions/a.md → archive/a.md');
    expect(await run(tool(p, 'move_file'), { from: 'archive/a.md', to: 'archive/b.md', offset: 1, limit: 1 })).toMatch(/^\[moved\] /);
    const log = subjects();
    expect(log).toContain('corti|她移了 sessions/a.md');
    expect(log).toContain('corti|她移了 archive/a.md');
  });
});

/**
 * 写入回执只报数，不评价内容。
 */
describe('write_file 写入频次事实', () => {
  let dir: string;
  let p: CortiV;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortiv-tally-'));
    p = new CortiV({ memoryDir: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('同一份文件写到第三次起报本场第几次;头两次不出声', async () => {
    const write = writeTool(p);
    const note = 'sessions/_waking_note.md';
    expect(await run(write, { path: note, content: '一\n' })).not.toContain('[写入频次]');
    expect(await run(write, { path: note, content: '二\n' })).not.toContain('[写入频次]');
    const third = await run(write, { path: note, content: '三\n' });
    expect(third).toContain('[written] sessions/_waking_note.md');
    expect(third).toContain(`[写入频次] 这是本场第 3 次写入 ${note}`);
    const fourth = await run(write, { path: note, content: '四\n' });
    expect(fourth).toContain('这是本场第 4 次写入');
    // 只报事实:不评价、不建议
    expect(fourth).not.toMatch(/建议|太频繁|应该|不妨/);
  });

  it('追加不进重写频次表:该走的路不该被报数劝退', async () => {
    const write = writeTool(p);
    const append = tool(p, 'append_file');
    const note = 'sessions/_waking_note.md';
    await run(write, { path: note, content: '一\n' });
    await run(write, { path: note, content: '二\n' });
    expect(await run(append, { path: note, content: '三\n' })).not.toContain('[写入频次]');
    // 追加没占计数:下一次整份重写仍是第 3 次
    expect(await run(write, { path: note, content: '四\n' })).toContain('这是本场第 3 次写入');
  });

  it('按文件各记各的,别的文件不受影响', async () => {
    const write = writeTool(p);
    for (let i = 0; i < 3; i++) await run(write, { path: 'a.md', content: `${i}\n` });
    const other = await run(write, { path: 'b.md', content: '一\n' });
    expect(other).toBe('[written] b.md');
  });

  it('频次与缩水提示同时成立时两条都给', async () => {
    const write = writeTool(p);
    const long = `# 地图\n\n## 村庄\n${'村里四个箱子。\n'.repeat(40)}`;
    await run(write, { path: '地图.md', content: long });
    await run(write, { path: '地图.md', content: long });
    const out = await run(write, { path: '地图.md', content: '# 地图\n\n没了\n' });
    expect(out).toContain('[写入频次]');
    expect(out).toContain('[缩水提示]');
  });
});
