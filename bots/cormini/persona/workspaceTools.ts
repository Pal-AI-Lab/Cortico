/**
 * 工作区工具绑定 GitWorkspaceMemory；WorkspaceHost 提供角色权限、虚拟文件和常驻文件约束。
 *
 * 路径一律相对工作区并经 `memory.insideWorkspace` 校验;写类工具的回执以 `[written]` /
 * `[edited]` / `[appended]` / `[deleted]` / `[moved]` 起头,变体据此判断要不要提交版本。
 * 移动与删除一次可以选中多份文件:一个目录下的全部,或从工作区根匹配的 glob,再按修改日期收窄。
 *
 * Fallback:不给行区间的 read_file 遇到超过 `WorkspaceHost.wholeReadFallbackChars()` 的文件只交回开头几行。
 * 它防的是模型不看清单里的大小、把长文件整份读进上下文;上限的推导在 Persona 的同名方法上。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import type { ToolDef } from 'cortico/core/types.ts';
import { SYSTEM_TIMEZONE, parseTimeIn } from 'cortico/core/util.ts';
import { BLOBS_DIR, LIST_DIR_CAP, globToRegExp, memHandle, type GitWorkspaceMemory, type ModifiedRange } from './memory.ts';

/** `glob_files` 一次最多交回的文件数。 */
const GLOB_LIMIT = 100;
/** `grep_files` 缺省最多交回的命中行(或文件)数。 */
const GREP_DEFAULT_LIMIT = 50;
/** `grep_files` 每行交回的最大字符数,更长的截断。 */
const GREP_LINE_CHARS = 200;
/** 批量移动、删除的回执最多逐条列出的文件数。 */
const BATCH_LIST_MAX = 50;
/** 含这些字符、又不是现存文件或目录的路径当 glob 读。 */
const WILDCARD = /[*?{]/;

/** 整数参数;缺席、非数字、非有限值都当没给。 */
function intArg(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
  return undefined;
}

function clipLine(line: string): string {
  return line.length > GREP_LINE_CHARS ? `${line.slice(0, GREP_LINE_CHARS)}…` : line;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 正文按 `\n` 切行;`total` 不算结尾换行之后的那个空串。 */
function splitLines(text: string): { lines: string[]; total: number } {
  const lines = text.split('\n');
  return { lines, total: text === '' ? 0 : text.endsWith('\n') ? lines.length - 1 : lines.length };
}

/** offset/limit 落成 1 起的闭区间:负 offset 从尾倒数,limit 缺省到末行。`start > total` 即越界。 */
function lineSpan(total: number, offset: number | undefined, limit: number | undefined): { start: number; end: number } {
  let start = offset === undefined || offset === 0 ? 1 : offset > 0 ? offset : total + offset + 1;
  if (start < 1) start = 1;
  const end = limit === undefined ? total : Math.min(total, start + Math.max(limit, 1) - 1);
  return { start, end };
}

/** Fallback:超过 `max` 的文件只交回开头的整行(第一行就超长则截断它),抬头说清总行数、大小和怎么读其余部分。 */
function readHeadFallback(path: string, text: string, max: number): string {
  const { lines, total } = splitLines(text);
  let used = 0;
  let n = 0;
  while (n < total && used + lines[n]!.length + 1 <= max) used += lines[n++]!.length + 1;
  const shown = n > 0 ? `第 1-${n} 行` : `第 1 行的前 ${max} 字符`;
  const body = n > 0 ? lines.slice(0, n).join('\n') : lines[0]!.slice(0, max);
  return `[${path} 共 ${total} 行、${text.length} 字符,整份太长,只交回${shown};用 offset 和 limit 读其余部分]\n${body}`;
}

/** `modified_before` / `modified_after` → 毫秒范围;只给日期按本机时区的零点。读不出返回一句错误。 */
function modifiedRange(args: Record<string, unknown>): ModifiedRange | string {
  const range: ModifiedRange = {};
  for (const [key, field] of [['modified_before', 'before'], ['modified_after', 'after']] as const) {
    const raw = args[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const ms = parseTimeIn(SYSTEM_TIMEZONE, String(raw));
    if (Number.isNaN(ms)) return `${key} 读不出:${String(raw)};写成 2026-09-01 或带时刻的 ISO 时间`;
    range[field] = ms;
  }
  return range;
}

function rangeNote(range: ModifiedRange): string {
  return range.before !== undefined || range.after !== undefined ? '(在给定的修改日期范围内)' : '';
}

/** 工作区内的路径换成规范的相对路径(`/` 分隔,根是空串);逃逸抛错。 */
function relOf(memory: GitWorkspaceMemory, path: string): string {
  return relative(memory.memoryDir, memory.insideWorkspace(path || '.')).split(sep).join('/');
}

/** `move_file` / `delete_file` 选中的文件。`many` 时 `base` 是批量移动保留相对路径的起点。 */
interface Selection {
  files: string[];
  many: boolean;
  base: string;
}

/** 一份现存文件、一个目录下的全部文件,或从工作区根匹配的 glob;再按修改日期收窄。选不出返回一句错误。 */
function select(memory: GitWorkspaceMemory, target: string, range: ModifiedRange): Selection | string {
  let rel: string;
  try {
    rel = relOf(memory, target);
  } catch (e) {
    return errText(e);
  }
  const abs = join(memory.memoryDir, rel);
  if (existsSync(abs)) {
    if (!statSync(abs).isDirectory()) return { files: memory.newestFirst([rel], range), many: false, base: '' };
    return { files: memory.newestFirst(memory.walkFiles(rel), range), many: true, base: rel };
  }
  const pattern = memory.normalize(target);
  if (!WILDCARD.test(pattern)) return `${target} 不存在`;
  const segments = pattern.split('/');
  const base = segments.slice(0, segments.findIndex((s) => WILDCARD.test(s))).join('/');
  return { files: memory.matchFiles(pattern, range), many: true, base };
}

/** 批量回执:做成的逐条列出,没动的带理由;一份也没做成时以失败起头。 */
function batchReceipt(ok: string, failed: string, done: string[], skipped: string[]): string {
  const list = (items: string[]): string => {
    const shown = items.slice(0, BATCH_LIST_MAX).map((s) => `- ${s}`);
    if (items.length > shown.length) shown.push(`… 另有 ${items.length - shown.length} 个`);
    return shown.join('\n');
  };
  if (done.length === 0) return `${failed} 一个也没动:\n${list(skipped)}`;
  const head = `${ok} ${done.length} 个文件:\n${list(done)}`;
  return skipped.length === 0 ? head : `${head}\n没动的 ${skipped.length} 个:\n${list(skipped)}`;
}

/**
 * 文件工具要问Persona的那几件事。Cormini 用自己的 protected 方法接进来,变体覆写
 * 哪一个就改哪一处行为(写纪律、虚拟文件、删不得的常驻文件),工具本身不必知道。
 */
export interface WorkspaceHost {
  /** 这份记忆在磁盘上是什么(路径安全、读写、遍历、检索、blobs、版本历史) */
  memory: GitWorkspaceMemory;
  writeGuard(op: 'write' | 'append' | 'rename' | 'delete', path: string, role: string): string | null;
  /** Fallback:不给行区间的 read_file 整份交回的字符上限。 */
  wholeReadFallbackChars(): number;
  /** 整份文件从 `from` 移到 `to` 的准入;返回理由就不动。 */
  moveGuard(from: string, to: string, role: string): string | null;
  readOverride(path: string): string | null;
  prefixResidentFiles(): string[];
}

function isResident(host: WorkspaceHost, rel: string): boolean {
  const abs = resolve(host.memory.memoryDir, rel);
  return host.prefixResidentFiles().some((f) => resolve(f) === abs);
}

const MODIFIED_BEFORE = {
  type: 'string',
  description: 'Only files last modified before this date: YYYY-MM-DD (midnight, local time) or an ISO time.',
};
const MODIFIED_AFTER = {
  type: 'string',
  description: 'Only files last modified on or after this date: YYYY-MM-DD (midnight, local time) or an ISO time.',
};

const READ_FILE: Omit<ToolDef, 'handler'> = {
  name: 'read_file',
  description: 'Read a file from your workspace. Give offset and limit to read a slice of a long note '
    + '(a negative offset counts from the end, so offset -20 reads the last 20 lines). '
    + 'list_files and glob_files show each file\'s size; read a long file by range. '
    + 'Without a range you get the whole file, or for a file too long to take in at once its opening lines and the total line count.',
  tags: ['read'],
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to your workspace.' },
      offset: { type: 'integer', description: 'First line to read, 1-indexed. Negative counts from the end (-1 is the last line). Omit to start at the top.' },
      limit: { type: 'integer', description: 'How many lines to read. Omit to read to the end.' },
    },
    required: ['path'],
  },
};

const WRITE_FILE: Omit<ToolDef, 'handler'> = {
  name: 'write_file',
  description: 'Write a file in your workspace, replacing it if it exists. This is how you remember. '
    + 'Use it for a new file or a real rewrite of the whole document; to change one passage use edit_file.',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to your workspace.' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
};

const EDIT_FILE: Omit<ToolDef, 'handler'> = {
  name: 'edit_file',
  description: 'Replace one exact passage of a file in your workspace and leave the rest untouched. '
    + 'old_string must appear in the file verbatim and exactly once (quote enough context to make it unique), '
    + 'or set replace_all to change every occurrence. Use this to update a line in place — a profile\'s first-line summary, '
    + 'a stale fact, a wrong number — instead of rewriting the whole file with write_file or piling a correction under it.',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to your workspace.' },
      old_string: { type: 'string', description: 'The exact text to replace, verbatim from the file.' },
      new_string: { type: 'string', description: 'The replacement text. Must differ from old_string.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match. Default false.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
};

const DELETE_FILE: Omit<ToolDef, 'handler'> = {
  name: 'delete_file',
  description: 'Delete files from your workspace: one file, every file under a folder, or every file whose path matches '
    + 'a glob counted from the workspace root (handoffs/2026-09-*). modified_before and modified_after narrow the selection '
    + 'by last-modified date. The constitution and other prefix-resident documents are never deleted.',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A file, a folder, or a glob, relative to your workspace.' },
      modified_before: MODIFIED_BEFORE,
      modified_after: MODIFIED_AFTER,
    },
    required: ['path'],
  },
};

const MOVE_FILE: Omit<ToolDef, 'handler'> = {
  name: 'move_file',
  description: 'Move or rename files in your workspace, or move lines from one file to another. '
    + 'from is a file, a folder, or a glob counted from the workspace root (handoffs/2026-09-*, notes/**/*.md). '
    + 'One file goes to the path to, or into to when that is an existing folder or ends with /. '
    + 'A folder or a glob moves every file it selects into the folder to, keeping each file\'s path below the folder '
    + 'or below the glob\'s leading fixed folders. '
    + 'With offset and limit (numbered as in read_file) only those lines of the file from move: they are cut from it and '
    + 'appended to the file to, which is created if missing. This splits a long file without retyping it. '
    + 'Missing folders are created and an existing file is never overwritten. Prefix-resident documents stay where they are, '
    + 'but lines can be moved out of them.',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'A file, a folder, or a glob, relative to your workspace.' },
      to: { type: 'string', description: 'The new path, the destination folder, or with offset/limit the file the lines are appended to.' },
      offset: { type: 'integer', description: 'First line to move, numbered as in read_file. Give offset or limit to move lines instead of whole files.' },
      limit: { type: 'integer', description: 'How many lines to move. Omit to move through the last line.' },
      modified_before: MODIFIED_BEFORE,
      modified_after: MODIFIED_AFTER,
    },
    required: ['from', 'to'],
  },
};

const APPEND_FILE: Omit<ToolDef, 'handler'> = {
  name: 'append_file',
  description:
    'Add text to the end of a file in your workspace, keeping everything already in it. '
    + 'The file and any missing parent folders are created if it does not exist, so appending to a new path starts that file. '
    + 'Use this for anything that grows entry by entry — a running log, a diary, a ledger, a record of this session: '
    + 'append the new lines instead of rewriting the whole note. '
    + 'Give such a file one period in its name (log/2026-10.md) and start the next file when the period turns, '
    + 'so a finished period can be moved or archived whole. '
    + 'Keep write_file for when you really are replacing the whole document: a rewrite, a distillation, a restructure. '
    + 'If the file does not already end with a newline, one is added before your text.',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to your workspace.' },
      content: { type: 'string', description: 'Text appended verbatim at the end of the file.' },
    },
    required: ['path', 'content'],
  },
};

const LIST_FILES: Omit<ToolDef, 'handler'> = {
  name: 'list_files',
  description: 'List files in your workspace, each with its size and last-modified date. The directory you name is listed in full; '
    + `every other directory shows at most its first ${LIST_DIR_CAP} entries plus a count of the rest. `
    + 'Name a directory to see all of it.',
  tags: ['read'],
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Directory relative to your workspace to list in full. Omit for the workspace root.' },
    },
    required: [],
  },
};

const GLOB_FILES: Omit<ToolDef, 'handler'> = {
  name: 'glob_files',
  description: 'Find files in your workspace by name pattern, most recently modified first, each with its size and last-modified date. '
    + 'Patterns not starting with **/ get it prepended, so *.md matches everywhere; '
    + 'use a directory prefix to narrow (minecraft/worlds/*/目标.md, viewers/**/1234*.md). '
    + 'modified_before and modified_after narrow by last-modified date.',
  tags: ['read'],
  parameters: {
    type: 'object',
    properties: {
      glob_pattern: { type: 'string', description: 'Glob such as *.md, notes/**/*.md, viewers/**/1234*.md.' },
      target_directory: { type: 'string', description: 'Directory relative to your workspace to search under. Omit for the whole workspace.' },
      modified_before: MODIFIED_BEFORE,
      modified_after: MODIFIED_AFTER,
    },
    required: ['glob_pattern'],
  },
};

const GREP_FILES: Omit<ToolDef, 'handler'> = {
  name: 'grep_files',
  description: 'Search the text of your workspace files with a regular expression. '
    + 'Returns matching lines as path:line: text (default), or just the files, or per-file counts. '
    + 'This is how you find where you wrote something down; narrow with path or glob when you know roughly where.',
  tags: ['read'],
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory relative to your workspace to search in. Omit for the whole workspace.' },
      glob: { type: 'string', description: 'Only search files whose path matches this glob, e.g. *.md or viewers/**.' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'content (default): matching lines; files_with_matches: file paths only; count: matches per file.' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive match. Default false.' },
      context: { type: 'integer', description: 'Lines of context to show before and after each match (content mode only).' },
      head_limit: { type: 'integer', description: `Maximum matching lines (or files) to return. Default ${GREP_DEFAULT_LIMIT}.` },
    },
    required: ['pattern'],
  },
};

/** 文件工具的声明,顺序同 `workspaceTools()`。 */
export const WORKSPACE_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  READ_FILE,
  WRITE_FILE,
  EDIT_FILE,
  APPEND_FILE,
  DELETE_FILE,
  MOVE_FILE,
  LIST_FILES,
  GLOB_FILES,
  GREP_FILES,
];

function readTool(host: WorkspaceHost): ToolDef {
  return {
    ...READ_FILE,
    handler: async (args) => {
      const path = String(args.path ?? '');
      const virtual = host.readOverride(path);
      if (virtual !== null) return virtual;
      // blobs/ 下是二进制:不回正文,回执附上句柄,渲染层决定她看到的是分片还是那一行
      const rel = path.replace(/\\/g, '/').replace(/^\.\//, '');
      if (rel.startsWith(BLOBS_DIR)) {
        const got = host.memory.blobs.get(memHandle(rel));
        if (!got) return `[not found] ${path}`;
        return { text: '', blobs: [{ handle: memHandle(rel), fallbackText: `${got.mime} ${got.bytes.byteLength} 字节` }] };
      }
      let text: string;
      try {
        text = readFileSync(host.memory.insideWorkspace(path), 'utf8');
      } catch {
        return `[not found] ${path}`;
      }
      const offset = intArg(args.offset);
      const limit = intArg(args.limit);
      if (offset === undefined && limit === undefined) {
        const max = host.wholeReadFallbackChars();
        return text.length <= max ? text : readHeadFallback(path, text, max);
      }
      const { lines, total } = splitLines(text);
      if (total === 0) return `[${path} 是空文件]`;
      const { start, end } = lineSpan(total, offset, limit);
      if (start > total) return `[${path} 共 ${total} 行,没有第 ${start} 行]`;
      return `[${path} 第 ${start}-${end} 行,共 ${total} 行]\n${lines.slice(start - 1, end).join('\n')}`;
    },
  };
}

function writeTool(host: WorkspaceHost): ToolDef {
  return {
    ...WRITE_FILE,
    handler: async (args, ctx) => {
      const path = String(args.path ?? '');
      const content = String(args.content ?? '');
      const denied = host.writeGuard('write', path, ctx.role);
      if (denied) return `[write failed] ${denied}`;
      try {
        host.memory.writeFileAtomic(path, content);
        return `[written] ${path}`;
      } catch (e) {
        return `[write failed] ${errText(e)}`;
      }
    },
  };
}

function editTool(host: WorkspaceHost): ToolDef {
  return {
    ...EDIT_FILE,
    handler: async (args, ctx) => {
      const path = String(args.path ?? '');
      const oldText = String(args.old_string ?? '');
      const newText = String(args.new_string ?? '');
      const all = args.replace_all === true;
      let abs: string;
      try {
        abs = host.memory.insideWorkspace(path);
      } catch (e) {
        return `[edit failed] ${errText(e)}`;
      }
      const denied = host.writeGuard('write', path, ctx.role);
      if (denied) return `[edit failed] ${denied}`;
      if (!existsSync(abs)) return `[edit failed] ${path} 不存在`;
      if (statSync(abs).isDirectory()) return `[edit failed] ${path} 是目录`;
      if (oldText === '') return `[edit failed] old_string 不能为空`;
      if (oldText === newText) return `[edit failed] new_string 与 old_string 相同,没有可改的`;
      const prev = readFileSync(abs, 'utf8');
      const count = prev.split(oldText).length - 1;
      if (count === 0) return `[edit failed] ${path} 里没有这段文字;先 read_file 看一眼,把要改的那段原样引用`;
      if (count > 1 && !all) {
        return `[edit failed] 这段文字在 ${path} 里出现 ${count} 次;多带些上下文让它唯一,或者 replace_all 全换`;
      }
      const next = all ? prev.split(oldText).join(newText) : prev.replace(oldText, () => newText);
      try {
        // 记忆层的路径规则比 insideWorkspace 严(`a/../b` 这种它拒),落地时才现形
        host.memory.writeFileAtomic(path, next);
      } catch (e) {
        return `[edit failed] ${errText(e)}`;
      }
      const line = prev.slice(0, prev.indexOf(oldText)).split('\n').length;
      return `[edited] ${path} 第 ${line} 行起换了 ${all ? count : 1} 处,现在 ${next.length} 字符`;
    },
  };
}

/**
 * 删文件:一份、一个目录下的全部,或一个 glob 选中的全部。常驻系统前缀的那几份(宪法、伙伴主档)不删;
 * 删空的目录随之删掉;整个工作区不能一次删。历史由变体的版本库保留。
 */
function deleteTool(host: WorkspaceHost): ToolDef {
  return {
    ...DELETE_FILE,
    handler: async (args, ctx) => {
      const path = String(args.path ?? '');
      if (host.memory.normalize(path) === '') return '[delete failed] 要给出文件、文件夹或 glob;整个工作区不能一次删掉';
      const range = modifiedRange(args);
      if (typeof range === 'string') return `[delete failed] ${range}`;
      const sel = select(host.memory, path, range);
      if (typeof sel === 'string') return `[delete failed] ${sel}`;
      if (sel.files.length === 0) return `[delete failed] 没有匹配 ${path} 的文件${rangeNote(range)}`;
      const resident = '常驻系统前缀,不能删;要改就改内容';
      const remove = (rel: string): string | null => {
        if (isResident(host, rel)) return resident;
        const denied = host.writeGuard('delete', rel, ctx.role);
        if (denied) return denied;
        try {
          host.memory.deleteFile(rel);
          host.memory.pruneEmptyDirs(rel);
        } catch (e) {
          return errText(e);
        }
        return null;
      };
      if (!sel.many) {
        const why = remove(sel.files[0]!);
        if (why === null) return `[deleted] ${path}`;
        return `[delete failed] ${why === resident ? `${path} ${why}` : why}`;
      }
      const done: string[] = [];
      const skipped: string[] = [];
      for (const rel of sel.files) {
        const why = remove(rel);
        if (why) skipped.push(`${rel}(${why})`);
        else done.push(rel);
      }
      return batchReceipt('[deleted]', '[delete failed]', done, skipped);
    },
  };
}

/**
 * 移动整份文件,或把一份文件的几行剪下来追加到另一份(正文不经过模型)。整份移动走 moveGuard,
 * 常驻系统前缀的文件不移走;目标已存在不覆盖;移空的源目录随之删掉。
 */
function moveTool(host: WorkspaceHost): ToolDef {
  const moveOne = (src: string, dest: string, role: string): string | null => {
    if (src === dest) return '已经在这个位置';
    if (isResident(host, src)) return '常驻系统前缀,不能移走;要瘦身就用 offset/limit 把其中几行移出去';
    const denied = host.moveGuard(src, dest, role);
    if (denied) return denied;
    try {
      host.memory.renameFile(src, dest);
      host.memory.pruneEmptyDirs(src);
    } catch (e) {
      return errText(e);
    }
    return null;
  };
  return {
    ...MOVE_FILE,
    handler: async (args, ctx) => {
      const from = String(args.from ?? '');
      const to = String(args.to ?? '');
      if (!from || !to) return '[move failed] from 与 to 都要给';
      const offset = intArg(args.offset);
      const limit = intArg(args.limit);
      if (offset !== undefined || limit !== undefined) return moveLines(host, from, to, offset, limit, ctx.role);
      const range = modifiedRange(args);
      if (typeof range === 'string') return `[move failed] ${range}`;
      const sel = select(host.memory, from, range);
      if (typeof sel === 'string') return `[move failed] ${sel}`;
      if (sel.files.length === 0) return `[move failed] 没有匹配 ${from} 的文件${rangeNote(range)}`;
      let target: string;
      try {
        target = relOf(host.memory, to);
      } catch (e) {
        return `[move failed] ${errText(e)}`;
      }
      const targetIsDir = host.memory.isDir(target);
      if (!sel.many) {
        const src = sel.files[0]!;
        const dest = to.endsWith('/') || targetIsDir ? posix.join(target, posix.basename(src)) : target;
        const why = moveOne(src, dest, ctx.role);
        return why ? `[move failed] ${why}` : `[moved] ${src} → ${dest}`;
      }
      if (!targetIsDir && host.memory.exists(target)) return `[move failed] ${to} 是文件;移动多份文件时 to 要是文件夹`;
      const done: string[] = [];
      const skipped: string[] = [];
      for (const src of sel.files) {
        const dest = posix.join(target, sel.base ? posix.relative(sel.base, src) : src);
        const why = moveOne(src, dest, ctx.role);
        if (why) skipped.push(`${src}(${why})`);
        else done.push(`${src} → ${dest}`);
      }
      return batchReceipt('[moved]', '[move failed]', done, skipped);
    },
  };
}

/** 剪下 `from` 的第 offset 起 limit 行追加到 `to`:先追加再改源文件,中途失败最多多出一份副本,不会丢行。 */
function moveLines(
  host: WorkspaceHost,
  from: string,
  to: string,
  offset: number | undefined,
  limit: number | undefined,
  role: string,
): string {
  let src: string;
  let dest: string;
  try {
    src = relOf(host.memory, from);
    dest = relOf(host.memory, to);
  } catch (e) {
    return `[move failed] ${errText(e)}`;
  }
  if (src.startsWith(BLOBS_DIR) || dest.startsWith(BLOBS_DIR)) return `[move failed] ${BLOBS_DIR} 下是二进制,不能按行移动`;
  if (src === dest) return '[move failed] from 与 to 是同一份文件';
  const absSrc = join(host.memory.memoryDir, src);
  if (!existsSync(absSrc) || statSync(absSrc).isDirectory()) return `[move failed] ${from} 不是现存的文件;按行移动只能从一份文件里移`;
  if (host.memory.isDir(dest)) return `[move failed] ${to} 是文件夹;按行移动的 to 要是文件`;
  const denied = host.writeGuard('write', src, role) ?? host.writeGuard('append', dest, role);
  if (denied) return `[move failed] ${denied}`;
  const text = readFileSync(absSrc, 'utf8');
  const { lines, total } = splitLines(text);
  if (total === 0) return `[move failed] ${from} 是空文件`;
  const { start, end } = lineSpan(total, offset, limit);
  if (start > total) return `[move failed] ${from} 共 ${total} 行,没有第 ${start} 行`;
  const moved = lines.slice(start - 1, end).join('\n');
  const kept = [...lines.slice(0, start - 1), ...lines.slice(end)].join('\n');
  try {
    host.memory.appendFile(dest, `${moved}\n`);
    host.memory.writeFileAtomic(src, kept);
  } catch (e) {
    return `[move failed] ${errText(e)}`;
  }
  const destChars = readFileSync(join(host.memory.memoryDir, dest), 'utf8').length;
  return `[moved] ${src} 第 ${start}-${end} 行(${moved.length} 字符)→ ${dest};`
    + `${src} 剩 ${total - (end - start + 1)} 行、${kept.length} 字符,${dest} 现在 ${destChars} 字符`;
}

/**
 * 向持续增长的日志、台账或流水追加内容，保持旧正文不变，回执报告追加量与当前大小。
 */
function appendTool(host: WorkspaceHost): ToolDef {
  return {
    ...APPEND_FILE,
    handler: async (args, ctx) => {
      const path = String(args.path ?? '');
      const content = String(args.content ?? '');
      const denied = host.writeGuard('append', path, ctx.role);
      if (denied) return `[append failed] ${denied}`;
      let existed = false;
      let padded = false;
      let added = 0;
      let size = 0;
      try {
        const abs = host.memory.insideWorkspace(path);
        if (existsSync(abs) && statSync(abs).isDirectory()) {
          return `[append failed] ${path} 是目录,不能当文件追加`;
        }
        const prev = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
        existed = prev !== null;
        padded = prev !== null && prev.length > 0 && !prev.endsWith('\n');
        const payload = padded ? `\n${content}` : content;
        host.memory.appendFile(path, content);
        added = payload.length;
        size = (prev?.length ?? 0) + payload.length;
      } catch (e) {
        return `[append failed] ${errText(e)}`;
      }
      const head = existed ? `[appended] ${path}` : `[appended] ${path}(原本没有这份文件,已新建)`;
      const pad = padded ? '(上一行没有换行,先替你补了一个)' : '';
      return `${head} +${added} 字符${pad},现在 ${size} 字符。`;
    },
  };
}

function listTool(host: WorkspaceHost): ToolDef {
  return {
    ...LIST_FILES,
    handler: async (args) => {
      const dir = typeof args.dir === 'string' ? args.dir : '';
      try {
        return host.memory.listing(dir);
      } catch (e) {
        return `[list failed] ${errText(e)}`;
      }
    },
  };
}

/** 按文件名模式找文件,最近改过的在前。不以「两个星号加斜杠」开头的模式补上它,所以 `*.md` 找的是全树。 */
function globTool(host: WorkspaceHost): ToolDef {
  return {
    ...GLOB_FILES,
    handler: async (args) => {
      const pattern = String(args.glob_pattern ?? '');
      const dir = typeof args.target_directory === 'string' ? args.target_directory : '';
      if (!pattern) return '[glob failed] glob_pattern 不能为空';
      const range = modifiedRange(args);
      if (typeof range === 'string') return `[glob failed] ${range}`;
      let root: string;
      try {
        root = host.memory.insideWorkspace(dir || '.');
      } catch (e) {
        return `[glob failed] ${errText(e)}`;
      }
      if (!existsSync(root) || !statSync(root).isDirectory()) return `[glob failed] ${dir} 不是目录`;
      const prefix = host.memory.normalize(dir);
      const hits = host.memory.globFiles(pattern, dir, range);
      if (hits.length === 0) return `没有匹配 ${pattern} 的文件${prefix ? `(在 ${prefix}/ 下)` : ''}${rangeNote(range)}`;
      const shown = hits.slice(0, GLOB_LIMIT);
      const lines = shown.map((f) => `- ${f} ${host.memory.facts(f)}`);
      if (hits.length > shown.length) lines.push(`… 另有 ${hits.length - shown.length} 个,收窄模式再找`);
      return `${hits.length} 个文件,最近改过的在前:\n${lines.join('\n')}`;
    },
  };
}

/** 按内容搜。三种输出:命中行(带路径与行号)、只列文件、每文件计数。命中行数有上限,截断时说明。 */
function grepTool(host: WorkspaceHost): ToolDef {
  return {
    ...GREP_FILES,
    handler: async (args) => {
      const pattern = String(args.pattern ?? '');
      if (!pattern) return '[grep failed] pattern 不能为空';
      let re: RegExp;
      try {
        re = new RegExp(pattern, args.ignore_case === true ? 'i' : '');
      } catch (e) {
        return `[grep failed] 正则无效:${errText(e)}`;
      }
      const where = typeof args.path === 'string' ? args.path : '';
      let root: string;
      try {
        root = host.memory.insideWorkspace(where || '.');
      } catch (e) {
        return `[grep failed] ${errText(e)}`;
      }
      if (!existsSync(root)) return `[grep failed] ${where} 不存在`;
      const mode = args.output_mode === 'files_with_matches' || args.output_mode === 'count' ? args.output_mode : 'content';
      const context = Math.max(0, intArg(args.context) ?? 0);
      const limit = Math.max(1, intArg(args.head_limit) ?? GREP_DEFAULT_LIMIT);
      const globFilter = typeof args.glob === 'string' && args.glob !== ''
        ? globToRegExp(args.glob.startsWith('**/') ? args.glob : `**/${args.glob}`)
        : null;

      let total = 0;
      let matchedFiles = 0;
      const out: string[] = [];
      let shown = 0;
      for (const hit of host.memory.grep({ match: (l) => re.test(l), path: where, filter: globFilter })) {
        const { path: f, lines, hits } = hit;
        matchedFiles++;
        total += hits.length;
        if (mode === 'count') {
          if (shown < limit) { out.push(`${f}: ${hits.length}`); shown++; }
          continue;
        }
        if (mode === 'files_with_matches') {
          if (shown < limit) { out.push(`${f}(${hits.length} 处)`); shown++; }
          continue;
        }
        for (const i of hits) {
          if (shown >= limit) break;
          for (let j = Math.max(0, i - context); j < i; j++) out.push(`${f}-${j + 1}- ${clipLine(lines[j])}`);
          out.push(`${f}:${i + 1}: ${clipLine(lines[i])}`);
          for (let j = i + 1; j <= Math.min(lines.length - 1, i + context); j++) out.push(`${f}-${j + 1}- ${clipLine(lines[j])}`);
          shown++;
        }
      }
      if (total === 0) return `没有匹配 /${pattern}/ 的内容${where ? `(在 ${where} 下)` : ''}`;
      const truncated = mode === 'content' ? total > shown : matchedFiles > shown;
      const head = mode === 'content'
        ? `${total} 处命中,${matchedFiles} 个文件${truncated ? `,只交回前 ${shown} 处` : ''}`
        : `${matchedFiles} 个文件命中,共 ${total} 处${truncated ? `,只列前 ${shown} 个` : ''}`;
      return `${head}:\n${out.join('\n')}`;
    },
  };
}

/** 平铺工作区的那一套文件工具。形状对齐通用 agent 工具集:读带行区间、精确替换、追加、删除、移动、按名找、按内容搜。 */
export function workspaceTools(host: WorkspaceHost): ToolDef[] {
  return [
    readTool(host),
    writeTool(host),
    editTool(host),
    appendTool(host),
    deleteTool(host),
    moveTool(host),
    listTool(host),
    globTool(host),
    grepTool(host),
  ];
}
