/** WorkspaceGit:init/commit/log/diff/fileAt/tag/checkout,真 git 跑在临时目录。 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceGit, AUTHOR_SELF, AUTHOR_OPERATOR, gitInstalled } from '../../bots/cormini/persona/workspaceGit.ts';

let dir: string;
let g: WorkspaceGit;
const gitAvailable = new WorkspaceGit(tmpdir()).available();
const w = (rel: string, content: string): void => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wsgit-'));
  w('CONSTITUTION.md', '# 宪法\n第一版\n');
  w('note/a.md', 'note a\n');
  g = new WorkspaceGit(dir, () => { /* 测试里不往控制台喊 */ });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('gitInstalled', () => {
  /** 记下被调用的命令;`missing` 里的命令按没装处理(抛错)。 */
  const fakeExec = (missing: string[]) => {
    const calls: string[] = [];
    const exec = ((cmd: string) => {
      calls.push(cmd);
      if (missing.includes(cmd)) throw new Error(`${cmd}: not installed`);
      return Buffer.alloc(0);
    }) as unknown as Parameters<typeof gitInstalled>[1];
    return { calls, exec };
  };

  it('macOS 没装命令行工具:只问 xcode-select,不碰会弹安装框的 git', () => {
    const { calls, exec } = fakeExec(['xcode-select']);
    expect(gitInstalled('darwin', exec)).toBe(false);
    expect(calls).toEqual(['xcode-select']);
  });

  it('macOS 装了命令行工具:再确认 git 能跑', () => {
    const { calls, exec } = fakeExec([]);
    expect(gitInstalled('darwin', exec)).toBe(true);
    expect(calls).toEqual(['xcode-select', 'git']);
  });

  it('其他系统直接问 git', () => {
    const { calls, exec } = fakeExec(['git']);
    expect(gitInstalled('win32', exec)).toBe(false);
    expect(calls).toEqual(['git']);
  });
});

describe.skipIf(!gitAvailable)('WorkspaceGit', () => {
  it('init:建仓+checkpoint0+.gitignore,幂等', () => {
    expect(g.isRepo()).toBe(false);
    expect(g.init().created).toBe(true);
    expect(g.isRepo()).toBe(true);
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);
    // 行尾原样那份附件也一并补齐
    expect(existsSync(join(dir, '.gitattributes'))).toBe(true);
    expect(g.listTags().map((t) => t.name)).toContain('checkpoint0');
    // 再 init 不重复建
    expect(g.init().created).toBe(false);
  });

  it('commitAll:有改动才提交,归因正确,无改动返回 null', () => {
    g.init();
    w('CONSTITUTION.md', '# 宪法\n第二版\n');
    const h1 = g.commitAll('本轮记忆改动', AUTHOR_SELF);
    expect(h1).toBeTruthy();
    expect(g.commitAll('空', AUTHOR_SELF)).toBeNull(); // 无改动
    w('note/a.md', 'note a\n控制台加的一行\n');
    const h2 = g.commitAll('控制台编辑', AUTHOR_OPERATOR);
    expect(h2).toBeTruthy();

    // 署名对照导出的常量:两类来源可分辨才是契约,具体字符串不是
    const log = g.log({ limit: 10 });
    expect(log[0].author).toBe(AUTHOR_OPERATOR.name);
    expect(log[1].author).toBe(AUTHOR_SELF.name);
    expect(log.at(-1)!.message).toContain('checkpoint0');
  });

  it('commitAllAsync 与同步版同义:提交一次、无改动交回 null', async () => {
    g.init();
    w('note/a.md', 'note a\n她写的一行\n');
    expect(await g.commitAllAsync('她写了 note/a.md', AUTHOR_SELF)).toBeTruthy();
    expect(await g.commitAllAsync('空', AUTHOR_SELF)).toBeNull();
  });

  it('log 可按文件过滤;diff/fileAt 拿到变更与旧版本', () => {
    g.init();
    w('CONSTITUTION.md', '# 宪法\n第二版\n');
    g.commitAll('改宪法', AUTHOR_SELF);
    const conLog = g.log({ path: 'CONSTITUTION.md' });
    expect(conLog.length).toBe(2); // checkpoint0 + 改宪法
    const d = g.diff(conLog[0].fullHash, { path: 'CONSTITUTION.md' });
    expect(d).toContain('第二版');
    // checkpoint0 时的旧内容
    expect(g.fileAt('checkpoint0', 'CONSTITUTION.md')).toBe('# 宪法\n第一版\n');
  });

  it('logStat 带每份文件的增删行数', () => {
    g.init();
    w('note/a.md', 'note a\n加了一行\n');
    g.commitAll('加一行', AUTHOR_SELF);
    const stats = g.logStat({ path: 'note/a.md', limit: 5 });
    expect(stats[0].files.some((f) => f.path === 'note/a.md' && f.added === 1)).toBe(true);
  });

  it('tag/checkoutTag:回滚恢复文件并清掉新增文件,checkpoint0 不可删', () => {
    g.init();
    w('CONSTITUTION.md', '# 宪法\n第二版\n');
    g.tag('v2', '第二版基线'); // tag 会先提交当前改动
    expect(g.listTags().map((t) => t.name)).toContain('v2');

    w('CONSTITUTION.md', '# 宪法\n第三版\n');
    w('newfile.md', '回滚后应消失\n');
    g.commitAll('第三版', AUTHOR_SELF);

    g.checkoutTag('checkpoint0');
    expect(readFileSync(join(dir, 'CONSTITUTION.md'), 'utf8')).toBe('# 宪法\n第一版\n');
    expect(existsSync(join(dir, 'newfile.md'))).toBe(false);

    expect(() => g.deleteTag('checkpoint0')).toThrow();
    g.deleteTag('v2');
    expect(g.listTags().map((t) => t.name)).not.toContain('v2');
  });

  it('revision 长成 git 选项时直接拒,不让 git show 写文件', () => {
    g.init();
    const out = join(dir, 'pwn.txt');
    // --output=<file> 会把 diff 写到任意路径:一个读接口就成了写原语
    expect(() => g.diff(`--output=${out}`)).toThrow(/revision/);
    expect(() => g.fileAt('--output=x', 'CONSTITUTION.md')).toThrow(/revision/);
    expect(() => g.diff('-x')).toThrow(/revision/);
    expect(() => g.diff('HEAD:../outside')).toThrow(/revision/); // 冒号会挪走 rev:path 的分界
    expect(existsSync(out)).toBe(false);
    // 正常形状照旧:hash / tag / HEAD~n
    expect(g.diff('HEAD')).toContain('checkpoint0');
    expect(g.fileAt('checkpoint0', 'CONSTITUTION.md')).toContain('第一版');
  });

  it('checkpoint 名同样卡形状(含 deleteTag)', () => {
    g.init();
    expect(() => g.tag('-x', '坏名')).toThrow();
    expect(() => g.deleteTag('--exec=whoami')).toThrow();
    expect(() => g.deleteTag('-d')).toThrow();
  });

  it('status 反映 HEAD/脏/tag,建仓与提交都没出错', () => {
    g.init();
    const s0 = g.status();
    expect(s0.repo).toBe(true);
    expect(s0.dirty).toBe(false);
    expect(s0.tags).toContain('checkpoint0');
    expect(s0.initError).toBeNull();
    expect(s0.commitError).toBeNull();
    w('note/a.md', '改了\n');
    expect(g.status().dirty).toBe(true);
  });
});
