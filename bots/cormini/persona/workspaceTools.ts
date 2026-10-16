/**
 * 工作区工具绑定 GitWorkspaceMemory；WorkspaceHost 提供角色权限、虚拟文件和常驻文件约束。
 *
 * 路径一律相对工作区并经 `memory.insideWorkspace` 校验;写类工具的回执以 `[written]` /
 * `[edited]` / `[appended]` / `[deleted]` 起头,变体据此判断要不要提交版本。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolDef } from 'cortico/core/types.ts';
import { BLOBS_DIR, LIST_DIR_CAP, globToRegExp, memHandle, type GitWorkspaceMemory } from './memory.ts';

/** `glob_files` 一次最多交回的文件数。 */
const GLOB_LIMIT = 100;
/** `grep_files` 缺省最多交回的命中行(或文件)数。 */
const GREP_DEFAULT_LIMIT = 50;
/** `grep_files` 每行交回的最大字符数,更长的截断。 */
const GREP_LINE_CHARS = 200;

/** 整数参数;缺席、非数字、非有限值都当没给。 */
function intArg(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
  return undefined;
}

function clipLine(line: string): string {
  return line.length > GREP_LINE_CHARS ? `${line.slice(0, GREP_LINE_CHARS)}…` : line;
}

/**
 * 文件工具要问Persona的那几件事。Cormini 用自己的 protected 方法接进来,变体覆写
 * 哪一个就改哪一处行为(写纪律、虚拟文件、删不得的常驻文件),工具本身不必知道。
 */
export interface WorkspaceHost {
  /** 这份记忆在磁盘上是什么(路径安全、读写、遍历、检索、blobs、版本历史) */
  memory: GitWorkspaceMemory;
  writeGuard(op: 'write' | 'append' | 'rename' | 'delete', path: string, role: string): string | null;
  readOverride(path: string): string | null;
  prefixResidentFiles(): string[];
}

const READ_FILE: Omit<ToolDef, 'handler'> = {
  name: 'read_file',
  description: 'Read a file from your workspace. Whole file by default; '
    + 'give offset and limit to read a slice of a long note (a negative offset counts from the end, so offset -20 reads the last 20 lines).',
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
  description: 'Delete a file from your workspace. Only files, not folders; '
    + 'the constitution and other prefix-resident documents cannot be deleted.',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path relative to your workspace.' } },
    required: ['path'],
  },
};

const APPEND_FILE: Omit<ToolDef, 'handler'> = {
  name: 'append_file',
  description:
    'Add text to the end of a file in your workspace, keeping everything already in it. '
    + 'The file and any missing parent folders are created if it does not exist, so appending to a new path starts that file. '
    + 'Use this for anything that grows entry by entry — a running log, a diary, a ledger, a record of this session: '
    + 'append the new lines instead of rewriting the whole note. '
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
  description: 'List files in your workspace. The directory you name is listed in full; '
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
  description: 'Find files in your workspace by name pattern, most recently modified first. '
    + 'Patterns not starting with **/ get it prepended, so *.md matches everywhere; '
    + 'use a directory prefix to narrow (minecraft/worlds/*/目标.md, viewers/**/1234*.md).',
  tags: ['read'],
  parameters: {
    type: 'object',
    properties: {
      glob_pattern: { type: 'string', description: 'Glob such as *.md, notes/**/*.md, viewers/**/1234*.md.' },
      target_directory: { type: 'string', description: 'Directory relative to your workspace to search under. Omit for the whole workspace.' },
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
      if (offset === undefined && limit === undefined) return text;
      const lines = text.split('\n');
      const total = text === '' ? 0 : text.endsWith('\n') ? lines.length - 1 : lines.length;
      if (total === 0) return `[${path} 是空文件]`;
      let start = offset === undefined || offset === 0 ? 1 : offset > 0 ? offset : total + offset + 1;
      if (start < 1) start = 1;
      if (start > total) return `[${path} 共 ${total} 行,没有第 ${start} 行]`;
      const end = limit === undefined ? total : Math.min(total, start + Math.max(limit, 1) - 1);
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
        return `[write failed] ${e instanceof Error ? e.message : String(e)}`;
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
        return `[edit failed] ${e instanceof Error ? e.message : String(e)}`;
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
        return `[edit failed] ${e instanceof Error ? e.message : String(e)}`;
      }
      const line = prev.slice(0, prev.indexOf(oldText)).split('\n').length;
      return `[edited] ${path} 第 ${line} 行起换了 ${all ? count : 1} 处,现在 ${next.length} 字符`;
    },
  };
}

/** 删文件。常驻系统前缀的那几份(宪法、伙伴主档)拒删;目录不删。历史由变体的版本库保留。 */
function deleteTool(host: WorkspaceHost): ToolDef {
  return {
    ...DELETE_FILE,
    handler: async (args, ctx) => {
      const path = String(args.path ?? '');
      let abs: string;
      try {
        abs = host.memory.insideWorkspace(path);
      } catch (e) {
        return `[delete failed] ${e instanceof Error ? e.message : String(e)}`;
      }
      if (host.prefixResidentFiles().some((f) => resolve(f) === abs)) {
        return `[delete failed] ${path} 常驻系统前缀,不能删;要改就改内容`;
      }
      const denied = host.writeGuard('delete', path, ctx.role);
      if (denied) return `[delete failed] ${denied}`;
      if (!existsSync(abs)) return `[delete failed] ${path} 不存在`;
      if (statSync(abs).isDirectory()) return `[delete failed] ${path} 是目录,只删文件`;
      try {
        // 同 edit_file:记忆层的路径规则更严,落地时才现形
        host.memory.deleteFile(path);
      } catch (e) {
        return `[delete failed] ${e instanceof Error ? e.message : String(e)}`;
      }
      return `[deleted] ${path}`;
    },
  };
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
        return `[append failed] ${e instanceof Error ? e.message : String(e)}`;
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
        return `[list failed] ${e instanceof Error ? e.message : String(e)}`;
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
      let root: string;
      try {
        root = host.memory.insideWorkspace(dir || '.');
      } catch (e) {
        return `[glob failed] ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!existsSync(root) || !statSync(root).isDirectory()) return `[glob failed] ${dir} 不是目录`;
      const prefix = host.memory.normalize(dir);
      const hits = host.memory.globFiles(pattern, dir);
      if (hits.length === 0) return `没有匹配 ${pattern} 的文件${prefix ? `(在 ${prefix}/ 下)` : ''}`;
      const shown = hits.slice(0, GLOB_LIMIT);
      const lines = shown.map((f) => `- ${f}`);
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
        return `[grep failed] 正则无效:${e instanceof Error ? e.message : String(e)}`;
      }
      const where = typeof args.path === 'string' ? args.path : '';
      let root: string;
      try {
        root = host.memory.insideWorkspace(where || '.');
      } catch (e) {
        return `[grep failed] ${e instanceof Error ? e.message : String(e)}`;
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

/** 平铺工作区的那一套文件工具。形状对齐通用 agent 工具集:读带行区间、精确替换、追加、删除、按名找、按内容搜。 */
export function workspaceTools(host: WorkspaceHost): ToolDef[] {
  return [
    readTool(host),
    writeTool(host),
    editTool(host),
    appendTool(host),
    deleteTool(host),
    listTool(host),
    globTool(host),
    grepTool(host),
  ];
}
