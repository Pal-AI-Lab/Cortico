/**
 * 文件式工作区记忆：路径检查、文件读写、遍历、检索、二进制附件和 Git 历史。
 * Persona 提供权限、虚拟文件、前缀渲染及清除策略；工具定义在 workspaceTools.ts。
 */
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize as pathNormalize, relative, resolve, sep } from 'node:path';
import { MEM_SCHEME, mimeOfHandle } from 'cortico/core/blobs.ts';
import type { BlobStore } from 'cortico/core/types.ts';
import { SYSTEM_TIMEZONE, nowIso } from 'cortico/core/util.ts';
import { WorkspaceGit } from './workspaceGit.ts';

/** 工作区层的可预期错误(路径逃逸、文件不存在等),消息可直接作为 tool result */
export class WorkspaceError extends Error {}

/** 二进制工件落在工作区的哪个子目录(不带目录的名字提示进这里) */
export const BLOBS_DIR = 'blobs/';

/** `list_files` 对非指定目录的每个子目录最多列这么多项;余下折叠成一行计数。 */
export const LIST_DIR_CAP = 10;

/** 工作区相对路径 → `mem:` 句柄;路径统一用 `/`。 */
export function memHandle(rel: string): string {
  return `${MEM_SCHEME}${rel.split(sep).join('/')}`;
}

/** 返回使用正斜杠且无冗余分隔的相对路径。 */
export function normalizeWorkspacePath(relPath: string): string {
  let raw = String(relPath ?? '').trim().replace(/\\/g, '/');
  const rooted = raw.startsWith('/');
  raw = raw.replace(/\/{2,}/g, '/');
  const normalized = raw
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  return rooted ? `/${normalized}` : normalized;
}

/**
 * 规范化后检查路径是否位于工作区内，允许区内的 a/../b。
 * resolveSafe 另拒绝所有 '..' 段；调用方按接口的路径约束选用。
 */
function insideWorkspace(root: string, rel: string): string {
  const abs = resolve(root, pathNormalize(rel));
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`path escapes workspace: ${rel}`);
  return abs;
}

/**
 * glob → 正则。支持 `**`(跨目录)、`*`、`?`、`{a,b}`;路径用 `/` 分隔,匹配整条工作区相对路径。
 * 花括号里的备选项按字面处理,不再展开通配符。
 */
export function globToRegExp(glob: string): RegExp {
  const escape = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close < 0) {
        re += '\\{';
        continue;
      }
      re += `(?:${glob.slice(i + 1, close).split(',').map(escape).join('|')})`;
      i = close;
    } else re += escape(c);
  }
  return new RegExp(`^${re}$`);
}

/** 修改时刻的筛选范围(毫秒):`before` 不含,`after` 含。 */
export interface ModifiedRange {
  before?: number;
  after?: number;
}

function inRange(mtimeMs: number, range: ModifiedRange): boolean {
  return (range.before === undefined || mtimeMs < range.before) && (range.after === undefined || mtimeMs >= range.after);
}

/** 字节数的短写:B、KB(一位小数)、MB(一位小数)。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 文件清单行尾的「(大小, 最后修改日期)」;日期按本机时区。 */
function fileFacts(size: number, mtimeMs: number): string {
  return `(${formatSize(size)}, ${nowIso(SYSTEM_TIMEZONE, new Date(mtimeMs)).slice(0, 10)})`;
}

/** 一个目录的清单行,文件带大小和日期。`full` 为假时只取前 `LIST_DIR_CAP` 项,末尾补一行"共几项、怎么看全"。 */
function listDirLines(abs: string, prefix: string, full: boolean): string[] {
  const names = readdirSync(abs).sort().filter((name) => !name.startsWith('.'));
  const shown = full ? names : names.slice(0, LIST_DIR_CAP);
  const out: string[] = [];
  for (const name of shown) {
    const child = join(abs, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(child);
    if (st.isDirectory()) out.push(...listDirLines(child, rel, false));
    else out.push(`${rel} ${fileFacts(st.size, st.mtimeMs)}`);
  }
  if (names.length > shown.length) {
    out.push(`${prefix}/ … 共 ${names.length} 项,以上只列了前 ${shown.length} 项;list_files 指定 dir 为 ${prefix} 可列出全部`);
  }
  return out;
}

function walkFilesAbs(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walkFilesAbs(abs, rel));
    else out.push(rel);
  }
  return out;
}

/** 目录项排序:目录在前,同类按名。树与 listDir 共用这一条。 */
function dirsFirst(a: { name: string; isDirectory(): boolean }, b: { name: string; isDirectory(): boolean }): number {
  return Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name);
}

/** 隐藏文件与原子写的临时文件不进目录视图(与 git 忽略的口径一致)。 */
function visibleEntry(name: string): boolean {
  return !name.startsWith('.') && !name.includes('.tmp-');
}

/**
 * 工作区的二进制附件。mem: 句柄携带工作区相对路径，字节保存在部署的工作区中。
 * put 的路径不含目录时使用 dir（默认 blobs/）；get 可读取工作区内任意文件。
 * insideWorkspace 拒绝越出工作区的路径。
 */
export class WorkspaceBlobStore implements BlobStore {
  constructor(private readonly root: string, private readonly dir: string = BLOBS_DIR) {}

  put(nameHint: string, bytes: Uint8Array, mime: string): string {
    let rel = pathNormalize(nameHint).split(sep).join('/').replace(/^\.\//, '');
    if (!rel.includes('/')) rel = `${this.dir}${rel}`;
    const abs = insideWorkspace(this.root, rel);
    if (existsSync(abs) && statSync(abs).isDirectory()) throw new Error(`${rel} 是目录`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    void mime;
    return memHandle(relative(this.root, abs));
  }

  get(handle: string): { bytes: Uint8Array; mime: string } | null {
    const rel = handle.startsWith(MEM_SCHEME) ? handle.slice(MEM_SCHEME.length) : handle;
    if (!rel) return null;
    let abs: string;
    try {
      abs = insideWorkspace(this.root, rel);
    } catch {
      return null;
    }
    if (!existsSync(abs) || statSync(abs).isDirectory()) return null;
    return { bytes: readFileSync(abs), mime: mimeOfHandle(rel) };
  }

  list(prefix: string = this.dir): Array<{ handle: string; mime: string; size: number }> {
    let root: string;
    try {
      root = insideWorkspace(this.root, prefix || '.');
    } catch {
      return [];
    }
    if (!existsSync(root) || !statSync(root).isDirectory()) return [];
    const out: Array<{ handle: string; mime: string; size: number }> = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        if (name.startsWith('.')) continue;
        const abs = join(dir, name);
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs);
        else {
          const rel = relative(this.root, abs);
          out.push({ handle: memHandle(rel), mime: mimeOfHandle(rel), size: st.size });
        }
      }
    };
    walk(root);
    return out;
  }
}

export interface GitWorkspaceMemoryOptions {
  /** 工作区目录 = 记忆。不存在则创建。 */
  memoryDir: string;
  /** 不带目录的名字提示落进哪个工作区子目录。不给 = `blobs/`。 */
  blobsDir?: string;
  /** 版本历史出声的去处(建仓/提交失败);不给 = console.warn。 */
  warn?: (msg: string, data?: unknown) => void;
}

/** 检索命中的一份文件:整份行表 + 命中行号(上下文/计数/只列文件都在这之上拼)。 */
export interface GrepFileHit {
  path: string;
  lines: string[];
  hits: number[];
}

export class GitWorkspaceMemory {
  /** 工作区根目录 = 记忆 */
  readonly memoryDir: string;
  /** 记忆里的二进制工件:工作区 blobs/ 下的文件,`mem:` 句柄即相对路径 */
  readonly blobs: WorkspaceBlobStore;
  /** 这份记忆的版本历史 */
  readonly git: WorkspaceGit;

  constructor(opts: GitWorkspaceMemoryOptions) {
    this.memoryDir = resolve(opts.memoryDir);
    if (!existsSync(this.memoryDir)) mkdirSync(this.memoryDir, { recursive: true });
    this.blobs = new WorkspaceBlobStore(this.memoryDir, opts.blobsDir);
    this.git = new WorkspaceGit(this.memoryDir, opts.warn);
  }

  // -------------------------------------------------------------------------
  // 首次初始化
  // -------------------------------------------------------------------------

  /** 仅创建尚不存在的种子文件；文件名和内容由调用方提供。 */
  seed(files: ReadonlyArray<readonly [string, string]>): void {
    for (const [rel, body] of files) {
      const abs = this.resolveSafe(rel);
      if (existsSync(abs)) continue;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
    }
  }

  /** 建目录骨架。哪几个目录同样是人格约定,由调用方给。 */
  ensureDirs(dirs: readonly string[]): void {
    for (const d of dirs) {
      mkdirSync(join(this.memoryDir, ...d.split('/').filter(Boolean)), { recursive: true });
    }
  }

  // -------------------------------------------------------------------------
  // 路径安全
  // -------------------------------------------------------------------------

  normalize(relPath: string): string {
    return normalizeWorkspacePath(relPath);
  }

  /** 相对路径转绝对路径，拒绝盘符、绝对路径和任何 .. 段。 */
  resolveSafe(relPath: string): string {
    const s = this.normalize(relPath);
    if (/^[a-zA-Z]:/.test(s) || s.startsWith('/') || isAbsolute(s)) {
      throw new WorkspaceError(`只接受工作区内的相对路径,不接受绝对路径:${s}`);
    }
    if (s.split('/').some((seg) => seg === '..')) {
      throw new WorkspaceError(`路径不能包含"..",不允许离开工作区:${s}`);
    }
    const abs = resolve(this.memoryDir, s);
    const rel = relative(this.memoryDir, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceError(`路径解析后越出了工作区:${s}`);
    }
    return abs;
  }

  /** 工具层那条较松的护栏(见 `insideWorkspace` 的注释);逃逸抛普通 Error。 */
  insideWorkspace(relPath: string): string {
    return insideWorkspace(this.memoryDir, relPath);
  }

  exists(relPath: string): boolean {
    try {
      return existsSync(this.resolveSafe(relPath));
    } catch {
      return false;
    }
  }

  isDir(relPath: string): boolean {
    try {
      const abs = this.resolveSafe(relPath);
      return existsSync(abs) && statSync(abs).isDirectory();
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 读写
  // -------------------------------------------------------------------------

  readFile(relPath: string): string {
    const abs = this.resolveSafe(relPath);
    if (!existsSync(abs)) throw new WorkspaceError(`文件不存在:${this.normalize(relPath)}`);
    if (statSync(abs).isDirectory()) {
      throw new WorkspaceError(`${this.normalize(relPath)} 是目录,用 list_dir 查看它`);
    }
    return readFileSync(abs, 'utf8');
  }

  /** 同目录临时文件写完后 rename；失败时移除临时文件并保留原始错误。 */
  writeFileAtomic(relPath: string, content: string): void {
    const abs = this.resolveSafe(relPath);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      throw new WorkspaceError(`${this.normalize(relPath)} 是目录,不能作为文件写入`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${Math.random().toString(36).slice(2, 8)}`;
    try {
      writeFileSync(tmp, content, 'utf8');
      renameSync(tmp, abs);
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // 保留原始写入错误。
      }
      throw error;
    }
  }

  /** 追加内容前保证现有文件以换行结尾。 */
  appendFile(relPath: string, content: string): void {
    const abs = this.resolveSafe(relPath);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      throw new WorkspaceError(`${this.normalize(relPath)} 是目录,不能追加`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    let payload = content;
    if (existsSync(abs)) {
      const prev = readFileSync(abs, 'utf8');
      if (prev.length > 0 && !prev.endsWith('\n')) payload = '\n' + payload;
    }
    appendFileSync(abs, payload, 'utf8');
  }

  renameFile(fromRel: string, toRel: string): void {
    const from = this.resolveSafe(fromRel);
    const to = this.resolveSafe(toRel);
    if (!existsSync(from)) throw new WorkspaceError(`文件不存在:${this.normalize(fromRel)}`);
    if (statSync(from).isDirectory()) {
      throw new WorkspaceError(`${this.normalize(fromRel)} 是目录,只能移动文件`);
    }
    if (existsSync(to)) {
      throw new WorkspaceError(`目标已存在:${this.normalize(toRel)},换个名字或先删除它`);
    }
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }

  deleteFile(relPath: string): void {
    const abs = this.resolveSafe(relPath);
    if (!existsSync(abs)) throw new WorkspaceError(`文件不存在:${this.normalize(relPath)}`);
    if (statSync(abs).isDirectory()) {
      throw new WorkspaceError(`${this.normalize(relPath)} 是目录,只能删除文件`);
    }
    unlinkSync(abs);
  }

  /** 从 `relPath` 所在目录往上删空目录,到工作区根为止(根不删)。 */
  pruneEmptyDirs(relPath: string): void {
    let dir = dirname(this.resolveSafe(relPath));
    while (dir !== this.memoryDir && dir.startsWith(this.memoryDir + sep)) {
      if (!existsSync(dir) || readdirSync(dir).length > 0) return;
      rmdirSync(dir);
      dir = dirname(dir);
    }
  }

  // -------------------------------------------------------------------------
  // 遍历
  // -------------------------------------------------------------------------

  /** 列出一层目录，目录名带尾部 / 并排在文件前；路径无效时抛错。 */
  listDir(relPath = ''): string[] {
    const abs = this.resolveSafe(relPath);
    if (!existsSync(abs)) throw new WorkspaceError(`目录不存在:${this.normalize(relPath) || '工作区根'}`);
    if (!statSync(abs).isDirectory()) {
      throw new WorkspaceError(`${this.normalize(relPath)} 是文件,用 read_file 读它`);
    }
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => visibleEntry(e.name))
      .sort(dirsFirst)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  }

  /** `rel` 之下每一个文件的工作区相对路径(含 `rel` 前缀);点开头的整条跳过。 */
  walkFiles(rel = ''): string[] {
    const abs = this.insideWorkspace(rel || '.');
    const prefix = relative(this.memoryDir, abs).split(sep).filter(Boolean).join('/');
    return walkFilesAbs(abs, prefix);
  }

  /**
 * 完整列出 dir（空值为工作区根）；各子目录最多显示 LIST_DIR_CAP 项，其余报告计数。
 * 指定该子目录可查看全部。前缀的 prefixWorkspaceListing 把超过此上限的目录整个折叠为计数。
 */
  listing(dir = ''): string {
    const abs = this.insideWorkspace(dir || '.');
    if (!existsSync(abs)) return `[not found] ${dir}`;
    if (!statSync(abs).isDirectory()) return `[not a directory] ${dir}`;
    const rel = relative(this.memoryDir, abs).split(sep).filter((s) => s !== '').join('/');
    const lines = listDirLines(abs, rel, true);
    if (lines.length === 0) return rel ? `${rel}/ is empty.` : 'Your workspace is empty.';
    return `Files in ${rel ? `${rel}/` : 'your workspace'}:\n${lines.map((f) => `- ${f}`).join('\n')}`;
  }

  /** 整棵树的树枝图。 */
  tree(): string {
    const lines: string[] = ['persona/'];
    const walk = (abs: string, prefix: string): void => {
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => visibleEntry(e.name))
        .sort(dirsFirst);
      entries.forEach((e, i) => {
        const last = i === entries.length - 1;
        lines.push(prefix + (last ? '└── ' : '├── ') + e.name + (e.isDirectory() ? '/' : ''));
        if (e.isDirectory()) walk(join(abs, e.name), prefix + (last ? '    ' : '│   '));
      });
    };
    walk(this.memoryDir, '');
    return lines.join('\n');
  }

  /** MEMORY 0 仅渲染最外层直接子项,防止大型子目录占用常驻前缀。 */
  treeShallow(): string {
    const lines: string[] = ['persona/'];
    for (const e of readdirSync(this.memoryDir, { withFileTypes: true })
      .filter((entry) => visibleEntry(entry.name))
      .sort(dirsFirst)) {
      lines.push(e.isDirectory() ? `${e.name}/` : e.name);
    }
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // 检索
  // -------------------------------------------------------------------------

  /**
   * 按名找文件的底层:模式匹配整条工作区相对路径,最近改过的在前。
   * 不以 `**` + `/` 开头的模式补上它,所以 `*.md` 找的是整棵树。
   */
  globFiles(pattern: string, dir = '', range: ModifiedRange = {}): string[] {
    const re = globToRegExp(pattern.startsWith('**/') ? pattern : `**/${pattern}`);
    return this.newestFirst(this.walkFiles(dir).filter((f) => re.test(f)), range);
  }

  /** 模式按整条路径从工作区根匹配(不补 `**` + `/`),最近改过的在前。移动与删除用这一种,`*.md` 只是根下那几份。 */
  matchFiles(pattern: string, range: ModifiedRange = {}): string[] {
    const re = globToRegExp(this.normalize(pattern));
    return this.newestFirst(this.walkFiles().filter((f) => re.test(f)), range);
  }

  /** 工作区相对路径按修改时刻筛选,最近改过的在前。 */
  newestFirst(files: string[], range: ModifiedRange = {}): string[] {
    return files
      .map((f) => ({ f, mtime: statSync(join(this.memoryDir, f)).mtimeMs }))
      .filter((x) => inRange(x.mtime, range))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.f);
  }

  /** 一份文件清单行尾的「(大小, 最后修改日期)」。 */
  facts(relPath: string): string {
    const st = statSync(join(this.memoryDir, relPath));
    return fileFacts(st.size, st.mtimeMs);
  }

  /**
 * 从 path（文件或目录，空值为工作区）检索，返回命中文件的行表和命中行号。
 * 跳过含 NUL 的二进制文件及原子写临时文件；按 CRLF/LF 切行。
 */
  grep(opts: { match: (line: string) => boolean; path?: string; filter?: RegExp | null }): GrepFileHit[] {
    const where = opts.path ?? '';
    const abs = this.insideWorkspace(where || '.');
    const files = statSync(abs).isDirectory()
      ? this.walkFiles(where)
      : [relative(this.memoryDir, abs).split(sep).join('/')];
    const out: GrepFileHit[] = [];
    for (const f of files) {
      if (opts.filter && !opts.filter.test(f)) continue;
      if (f.split('/').some((seg) => seg.includes('.tmp-'))) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(join(this.memoryDir, f));
      } catch {
        continue;
      }
      if (buf.includes(0)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      const hits: number[] = [];
      lines.forEach((l, i) => { if (opts.match(l)) hits.push(i); });
      if (hits.length === 0) continue;
      out.push({ path: f, lines, hits });
    }
    return out;
  }
}
