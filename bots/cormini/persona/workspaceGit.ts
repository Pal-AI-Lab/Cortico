/**
 * 工作区的独立 Git 仓库。命令固定在工作区执行，并隔离影响仓库定位的环境变量。
 * 首次使用时初始化，创建 checkpoint0；checkpoint 为 annotated tag，回滚执行 reset --hard。
 * Git 不可用或建仓失败时，文件写入继续，版本读取报告错误。
 * 异步提交由调用方串行执行；操作员和 Persona 的提交使用不同作者。
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 幂等补齐 Git 忽略规则与禁止行尾转换的属性文件，已有文件保持原样。 */
const REPO_FILES: ReadonlyArray<readonly [string, string]> = [
  ['.gitignore', '# workspace 版本管理:忽略原子写临时文件\n*.tmp-*\n'],
  ['.gitattributes', '# 行尾一律原样:笔记里有靠原文对齐的地方,git 不替她改写\n* -text\n'],
];

/** 超过此时长的索引锁可移除；调用方须保证单实例、串行提交。 */
const STALE_INDEX_LOCK_MS = 60_000;

export interface GitAuthor {
  name: string;
  email: string;
}

export const AUTHOR_OPERATOR: GitAuthor = { name: 'operator', email: 'operator@persona.local' };
export const AUTHOR_SELF: GitAuthor = { name: 'corti', email: 'corti@persona.local' };

export interface CommitInfo {
  hash: string;
  fullHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

/** 一次提交里某个文件的增删行数(`--numstat`);二进制文件 git 报 `-`,这里是 null。 */
export interface CommitFileStat {
  path: string;
  added: number | null;
  removed: number | null;
}

export interface CommitStat extends CommitInfo {
  files: CommitFileStat[];
}

export interface CheckpointInfo {
  name: string;
  message: string;
  hash: string;
  date: string;
}

export interface GitStatus {
  available: boolean;
  repo: boolean;
  dirty: boolean;
  head: string | null;
  lastCommit: CommitInfo | null;
  tags: string[];
  /** 建仓失败原因；null 表示没有错误。 */
  initError: string | null;
  /** 最近一次提交失败的原因；文件可能已写入。提交成功后清空。 */
  commitError: string | null;
}

const FS = '\x1f';
const RS = '\x1e';
const LOG_FMT = `%H${FS}%an${FS}%ae${FS}%aI${FS}%s${RS}`;

/**
 * revision 不得以 '-' 开头，命令另用 --end-of-options（Git >= 2.24）终止选项解析。
 * 禁止 ':'，因为 fileAt 用 rev:path 表示指定版本中的文件。
 */
function assertRevision(rev: string): string {
  if (!rev || rev.length > 200 || rev.startsWith('-') || !/^[\w./\-~^{}@一-鿿]+$/.test(rev)) {
    throw new Error(`revision 形状不合法:${rev}`);
  }
  return rev;
}

/** checkpoint 名(tag)同样先卡形状:不以 `-` 开头,只留安全字形 */
function assertTagName(name: string): string {
  if (!name || name.startsWith('-') || !/^[\w.\-一-鿿]+$/.test(name)) {
    throw new Error(`checkpoint 名只能含字母数字、下划线、点、连字符或中文:${name}`);
  }
  return name;
}

/**
 * 本机能不能用 git。macOS 没装命令行工具时,/usr/bin/git 只是个壳,一被调用就弹出安装对话框;
 * 所以先用 `xcode-select -p` 问装没装(没装时它返回非零、不弹框),装了才去跑 git。
 */
export function gitInstalled(platform: NodeJS.Platform = process.platform, exec: typeof execFileSync = execFileSync): boolean {
  try {
    if (platform === 'darwin') exec('xcode-select', ['-p'], { stdio: ['ignore', 'ignore', 'ignore'] });
    exec('git', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

export class WorkspaceGit {
  readonly dir: string;
  private availCache: boolean | null = null;
  private repoCache: boolean | null = null;
  /** 最近一次建仓失败的原因;null = 没失败过。进 status() 供控制台展示。 */
  private initError: string | null = null;
  private warnedInitFail = false;
  /** 最近一次提交失败的原因;成功一次就清空。进 status() 供控制台展示。 */
  private commitError: string | null = null;
  /** 去重提交失败日志；提交成功后清空。 */
  private warnedCommitError: string | null = null;
  private readonly warn: (msg: string, data?: unknown) => void;

  constructor(workspaceDir: string, warn?: (msg: string, data?: unknown) => void) {
    this.dir = workspaceDir;
    this.warn = warn ?? ((msg, data) => console.warn(`[workspaceGit] ${msg}`, data ?? ''));
  }

  available(): boolean {
    if (this.availCache !== null) return this.availCache;
    this.availCache = gitInstalled();
    return this.availCache;
  }

  /** 用 Git 命令检查仓库是否可用；仅存在 .git 目录不足以确认初始化完成。 */
  isRepo(): boolean {
    if (!existsSync(join(this.dir, '.git'))) return false;
    if (this.repoCache !== null) return this.repoCache;
    try {
      this.run(['rev-parse', '--git-dir']);
      this.repoCache = true;
    } catch {
      this.repoCache = false;
    }
    return this.repoCache;
  }

  /** 保留进程环境，移除影响仓库、索引和对象目录定位的 Git 变量。 */
  private gitEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      const upper = key.toUpperCase();
      if (
        upper === 'GIT_DIR' ||
        upper === 'GIT_WORK_TREE' ||
        upper === 'GIT_INDEX_FILE' ||
        upper === 'GIT_OBJECT_DIRECTORY' ||
        upper === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ||
        upper === 'GIT_COMMON_DIR' ||
        upper === 'GIT_PREFIX'
      ) {
        delete env[key];
      }
    }
    return env;
  }

  private run(args: string[]): string {
    // safe.directory 仅作为本次 Git 调用的配置；-C 固定目标工作区。
    // quotepath=false 保留非 ASCII 路径，供历史记录与 numstat 匹配。
    return execFileSync('git', ['-C', this.dir, '-c', 'safe.directory=*', '-c', 'core.quotepath=false', ...args], {
      cwd: this.dir,
      env: this.gitEnv(),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  /** 非阻塞 Git 调用；同一仓库的调用必须串行。 */
  private runAsync(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', this.dir, '-c', 'safe.directory=*', '-c', 'core.quotepath=false', ...args],
        { cwd: this.dir, env: this.gitEnv(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
  }

  private authorArgs(a: GitAuthor): string[] {
    return ['-c', `user.name=${a.name}`, '-c', `user.email=${a.email}`];
  }

  /** 幂等补齐仓库属性文件，已有文件不修改。 */
  private ensureRepoFiles(): void {
    for (const [name, body] of REPO_FILES) {
      const file = join(this.dir, name);
      if (!existsSync(file)) writeFileSync(file, body, 'utf8');
    }
  }

  /** 超时锁的处理依赖单实例、串行提交的使用约束。 */
  private clearStaleIndexLock(): void {
    const lock = join(this.dir, '.git', 'index.lock');
    try {
      const age = Date.now() - statSync(lock).mtimeMs;
      if (age < STALE_INDEX_LOCK_MS) return;
      rmSync(lock, { force: true });
      this.warn('已移除超时的 Git 索引锁。', { dir: this.dir, ageMs: Math.round(age) });
    } catch { /* 没有锁,或读不到:照常往下走 */ }
  }

  init(): { created: boolean } {
    if (!this.available() || this.isRepo()) return { created: false };
    this.ensureRepoFiles();
    this.run(['init']); // 重复 init 保留已有对象，并补齐初始化步骤。
    this.repoCache = null;
    if (!this.isRepo()) throw new Error(`git init 之后 ${this.dir} 里仓不可用`);
    this.run(['config', 'core.autocrlf', 'false']);
    this.run(['config', 'core.safecrlf', 'false']);
    this.run(['add', '-A']);
    this.run([
      ...this.authorArgs(AUTHOR_OPERATOR),
      'commit', '--allow-empty', '-m', 'checkpoint0:出厂/重置后的干净状态',
    ]);
    // annotated tag 的 tagger 使用指定身份，不依赖机器全局配置。
    this.run([
      ...this.authorArgs(AUTHOR_OPERATOR),
      'tag', '-a', 'checkpoint0', '-m', '出厂/重置后的干净状态(init 自动)',
    ]);
    return { created: true };
  }

  /** 需要提交或读历史时再建仓;失败不抛——文件照写,历史页显示未建仓。 */
  ensureRepo(): void {
    if (!this.available()) return;
    this.clearStaleIndexLock();
    try {
      this.init();
      this.initError = null;
      if (this.isRepo()) this.ensureRepoFiles();
    } catch (e) {
      this.initError = e instanceof Error ? e.message : String(e);
      if (!this.warnedInitFail) {
        this.warnedInitFail = true;
        this.warn('workspace 建仓失败(文件照写,版本历史不可用)', { dir: this.dir, err: this.initError });
      }
    }
  }

  dirty(): boolean {
    if (!this.available() || !this.isRepo()) return false;
    try {
      return this.run(['status', '--porcelain']).trim() !== '';
    } catch {
      return false;
    }
  }

  /** 相同提交错误只记录一次；提交成功后允许再次报告。 */
  private noteCommitFailure(e: unknown): null {
    this.commitError = e instanceof Error ? e.message : String(e);
    if (this.warnedCommitError !== this.commitError) {
      this.warnedCommitError = this.commitError;
      this.warn('workspace 提交失败（文件已保存，本次修改未提交）', { dir: this.dir, err: this.commitError });
    }
    return null;
  }

  private noteCommitOk(): void {
    this.commitError = null;
    this.warnedCommitError = null;
  }

  commitAll(message: string, author: GitAuthor): string | null {
    this.ensureRepo();
    if (!this.available() || !this.isRepo()) return null;
    try {
      this.run(['add', '-A']);
      if (this.run(['status', '--porcelain']).trim() === '') {
        this.noteCommitOk();
        return null;
      }
      this.run([...this.authorArgs(author), 'commit', '-m', message]);
      const hash = this.run(['rev-parse', '--short', 'HEAD']).trim();
      this.noteCommitOk();
      return hash;
    } catch (e) {
      return this.noteCommitFailure(e);
    }
  }

  /** `commitAll` 的不阻塞版本。同一个仓上必须串行调用。 */
  async commitAllAsync(message: string, author: GitAuthor): Promise<string | null> {
    this.ensureRepo();
    if (!this.available() || !this.isRepo()) return null;
    try {
      await this.runAsync(['add', '-A']);
      if ((await this.runAsync(['status', '--porcelain'])).trim() === '') {
        this.noteCommitOk();
        return null;
      }
      await this.runAsync([...this.authorArgs(author), 'commit', '-m', message]);
      const hash = (await this.runAsync(['rev-parse', '--short', 'HEAD'])).trim();
      this.noteCommitOk();
      return hash;
    } catch (e) {
      return this.noteCommitFailure(e);
    }
  }

  log(opts?: { path?: string; limit?: number }): CommitInfo[] {
    this.ensureRepo();
    if (!this.available() || !this.isRepo()) return [];
    const args = ['log', `--pretty=format:${LOG_FMT}`, `-n${opts?.limit ?? 50}`];
    if (opts?.path) args.push('--', opts.path);
    let out = '';
    try { out = this.run(args); } catch { return []; }
    return this.parseLog(out);
  }

  /**
 * 按提交返回文件增删行数。记录分隔符放在 pretty 头之前，使紧随其后的 numstat 行归属该提交。
 */
  logStat(opts?: { path?: string; limit?: number }): CommitStat[] {
    this.ensureRepo();
    if (!this.available() || !this.isRepo()) return [];
    const args = [
      // Git 配置选项必须位于子命令之前。
      '-c', 'core.quotepath=false',
      'log', `--pretty=format:${RS}%H${FS}%an${FS}%ae${FS}%aI${FS}%s`,
      '--numstat', `-n${opts?.limit ?? 20}`,
    ];
    if (opts?.path) args.push('--', opts.path);
    let out = '';
    try { out = this.run(args); } catch { return []; }
    const commits: CommitStat[] = [];
    for (const rec of out.split(RS)) {
      if (!rec.trim()) continue;
      const lines = rec.split(/\r?\n/);
      const [full, an, ae, date, ...rest] = (lines[0] ?? '').split(FS);
      if (!full) continue;
      const files: CommitFileStat[] = [];
      for (const line of lines.slice(1)) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
        if (!m) continue;
        files.push({
          path: m[3],
          added: m[1] === '-' ? null : Number(m[1]),
          removed: m[2] === '-' ? null : Number(m[2]),
        });
      }
      commits.push({
        hash: full.slice(0, 8),
        fullHash: full,
        author: an ?? '',
        email: ae ?? '',
        date: date ?? '',
        message: rest.join(FS) ?? '',
        files,
      });
    }
    return commits;
  }

  private parseLog(out: string): CommitInfo[] {
    const commits: CommitInfo[] = [];
    for (const rec of out.split(RS)) {
      const r = rec.replace(/^\s+/, '');
      if (!r) continue;
      const [full, an, ae, date, ...rest] = r.split(FS);
      if (!full) continue;
      commits.push({
        hash: full.slice(0, 8),
        fullHash: full,
        author: an ?? '',
        email: ae ?? '',
        date: date ?? '',
        message: rest.join(FS) ?? '',
      });
    }
    return commits;
  }

  diff(hash: string, opts?: { path?: string }): string {
    this.ensureRepo();
    if (!this.available() || !this.isRepo()) throw new Error('git 不可用');
    const args = [
      'show', '--no-color', '--pretty=format:%H %an %aI%n%s%n',
      '--end-of-options', assertRevision(hash),
    ];
    if (opts?.path) args.push('--', opts.path);
    return this.run(args);
  }

  fileAt(hash: string, path: string): string {
    this.ensureRepo();
    if (!this.available() || !this.isRepo()) throw new Error('git 不可用');
    return this.run(['show', '--end-of-options', `${assertRevision(hash)}:${path}`]);
  }

  listTags(): CheckpointInfo[] {
    if (!this.available() || !this.isRepo()) return [];
    let out = '';
    try {
      out = this.run([
        'for-each-ref', '--sort=-creatordate', 'refs/tags',
        `--format=%(refname:short)${FS}%(contents:subject)${FS}%(objectname:short)${FS}%(creatordate:iso-strict)`,
      ]);
    } catch { return []; }
    const tags: CheckpointInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [name, message, hash, date] = line.split(FS);
      let commitHash = hash ?? '';
      try { commitHash = this.run(['rev-parse', '--short', `${name}^{commit}`]).trim(); } catch { /* keep */ }
      tags.push({ name, message: message ?? '', hash: commitHash, date: date ?? '' });
    }
    return tags;
  }

  /**
   * 新建 checkpoint:先提交当前改动(有则提交),再打 annotated tag。
   * 与 `listTags` 一样不 ensureRepo:存档点是对已有历史的操作,不该顺手建仓。
   */
  tag(name: string, message: string, author: GitAuthor = AUTHOR_OPERATOR): void {
    if (!this.available() || !this.isRepo()) throw new Error('git 不可用');
    assertTagName(name);
    if (this.listTags().some((t) => t.name === name)) {
      throw new Error(`checkpoint 已存在:${name}`);
    }
    this.commitAll(`checkpoint「${name}」`, author);
    this.run([...this.authorArgs(author), 'tag', '-a', name, '-m', message || name]);
  }

  deleteTag(name: string): void {
    if (!this.available() || !this.isRepo()) throw new Error('git 不可用');
    if (name === 'checkpoint0') throw new Error('checkpoint0 是出厂基线,不能删除');
    this.run(['tag', '-d', assertTagName(name)]);
  }

  /**
   * 回滚工作区到某 checkpoint(reset --hard tag)。
   * 之后的提交仍可经 reflog 找回;这是一次显式的人工重置。
   */
  checkoutTag(name: string): void {
    if (!this.available() || !this.isRepo()) throw new Error('git 不可用');
    if (!this.listTags().some((t) => t.name === name)) {
      throw new Error(`没有这个 checkpoint:${name}`);
    }
    this.run(['reset', '--hard', name]);
    this.run(['clean', '-fd']); // 删除未跟踪且未被忽略的文件。
  }

  status(): GitStatus {
    this.ensureRepo();
    const available = this.available();
    const repo = available && this.isRepo();
    if (!repo) {
      return { available, repo: false, dirty: false, head: null, lastCommit: null, tags: [], initError: this.initError, commitError: this.commitError };
    }
    let head: string | null = null;
    try { head = this.run(['rev-parse', '--short', 'HEAD']).trim(); } catch { /* 无提交 */ }
    const last = this.log({ limit: 1 })[0] ?? null;
    const tags = this.listTags().map((t) => t.name);
    return { available, repo: true, dirty: this.dirty(), head, lastCommit: last, tags, initError: this.initError, commitError: this.commitError };
  }
}
