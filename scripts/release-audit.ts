/**
 * 公开发布审计：阻止部署资源、明文凭证和异常大文件进入 Git 跟踪内容。
 *
 * 该检查覆盖 HEAD 发布树、当前索引与已跟踪工作树，不扫描更早的历史提交。
 * 通过后仍需单独审查所有待公开分支的历史。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_TRACKED_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FIXTURE_RESOURCE_BYTES = 1024 * 1024;

export type ReleaseFindingKind =
  | 'audio'
  | 'credential'
  | 'external-resource'
  | 'large-file'
  | 'live2d'
  | 'minecraft'
  | 'model-weight';

export type ReleaseFindingOrigin = 'HEAD' | 'index' | 'worktree';

export interface ReleaseFinding {
  kind: ReleaseFindingKind;
  path: string;
  detail: string;
  origins: ReleaseFindingOrigin[];
}

export interface ReleaseAuditResult {
  root: string;
  trackedFiles: number;
  findings: ReleaseFinding[];
}

interface IndexedFile {
  oid: string;
  path: string;
  size: number;
}

interface AuditedFile {
  path: string;
  size: number;
  origins: ReleaseFindingOrigin[];
}

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

const MODEL_SUFFIXES = [
  '.gguf',
  '.safetensors',
  '.ckpt',
  '.onnx',
  '.pth',
  '.pt',
  '.tflite',
];

const AUDIO_SUFFIXES = [
  '.aac',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
];

const LIVE2D_SUFFIXES = [
  '.moc',
  '.moc3',
  '.model3.json',
  '.physics3.json',
  '.motion3.json',
  '.exp3.json',
  '.cdi3.json',
];

const MINECRAFT_SUFFIXES = ['.jar', '.mca', '.mcr', '.nbt', '.schem', '.schematic'];

const CREDENTIAL_SIGNATURES = [
  {
    label: '私钥正文',
    pattern: '-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----',
  },
  {
    label: 'GitHub access token',
    pattern: '(^|[^A-Za-z0-9])(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})',
  },
  {
    label: 'Hugging Face access token',
    pattern: '(^|[^A-Za-z0-9])hf_[A-Za-z0-9]{20,}',
  },
  {
    label: 'OpenAI-style API key',
    pattern: '(^|[^A-Za-z0-9])sk-(proj-)?[A-Za-z0-9_-]{20,}',
  },
  {
    label: 'AWS access key',
    pattern: '(^|[^A-Z0-9])(AKIA|ASIA)[A-Z0-9]{16}([^A-Z0-9]|$)',
  },
  {
    label: 'Google API key',
    pattern: '(^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}([^A-Za-z0-9_-]|$)',
  },
  {
    label: 'Slack token',
    pattern: '(^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{20,}',
  },
  {
    label: '部署凭证赋值',
    pattern: "(SESSDATA|VTS_AUTH_TOKEN|BRAVE_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY)[[:space:]]*[:=][[:space:]]*[\"']?[A-Za-z0-9%._~+/-]{16,}",
  },
] as const;

function runGit(root: string, args: string[], input?: string): GitResult {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function requireGit(root: string, args: string[], input?: string): string {
  const result = runGit(root, args, input);
  if (result.status !== 0) {
    const message = result.stderr.trim() || `git ${args[0]} 失败(exit ${result.status})`;
    throw new Error(message);
  }
  return result.stdout;
}

function indexedFiles(root: string): IndexedFile[] {
  const raw = requireGit(root, ['ls-files', '--cached', '--stage', '-z']);
  const staged = raw.split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new Error(`无法解析 git ls-files 输出: ${JSON.stringify(entry)}`);
    const [mode, oid, stage] = entry.slice(0, tab).split(' ');
    if (!mode || !oid || stage === undefined) {
      throw new Error(`无法解析 git ls-files 输出: ${JSON.stringify(entry)}`);
    }
    return { oid, path: entry.slice(tab + 1), stage: Number(stage) };
  });

  const byPath = new Map<string, { oid: string; path: string; stage: number }>();
  for (const entry of staged) {
    const previous = byPath.get(entry.path);
    if (!previous || entry.stage === 0) byPath.set(entry.path, entry);
  }

  const oids = [...new Set([...byPath.values()].map((entry) => entry.oid))];
  if (oids.length === 0) return [];
  const sizesRaw = requireGit(
    root,
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    `${oids.join('\n')}\n`,
  );
  const sizes = new Map<string, number>();
  for (const line of sizesRaw.trimEnd().split('\n')) {
    const [oid, type, bytes] = line.trim().split(' ');
    if (oid && type === 'blob' && bytes) sizes.set(oid, Number(bytes));
  }

  return [...byPath.values()]
    .map((entry) => ({ ...entry, size: sizes.get(entry.oid) ?? 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function headFiles(root: string): IndexedFile[] {
  const head = runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.status !== 0) return [];

  const raw = requireGit(root, ['ls-tree', '-r', '-z', '--full-tree', '-l', 'HEAD']);
  return raw.split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new Error(`无法解析 git ls-tree 输出: ${JSON.stringify(entry)}`);
    const [mode, type, oid, bytes] = entry.slice(0, tab).trim().split(/\s+/);
    if (!mode || !type || !oid || !bytes) {
      throw new Error(`无法解析 git ls-tree 输出: ${JSON.stringify(entry)}`);
    }
    return { oid, path: entry.slice(tab + 1), size: type === 'blob' ? Number(bytes) : 0 };
  });
}

const ORIGIN_ORDER: ReleaseFindingOrigin[] = ['HEAD', 'index', 'worktree'];

function mergeTrackedFiles(root: string, head: IndexedFile[], index: IndexedFile[]): AuditedFile[] {
  const merged = new Map<string, { path: string; size: number; origins: Set<ReleaseFindingOrigin> }>();
  const add = (file: IndexedFile, origin: ReleaseFindingOrigin): void => {
    const current = merged.get(file.path) ?? { path: file.path, size: 0, origins: new Set() };
    current.size = Math.max(current.size, file.size);
    current.origins.add(origin);
    merged.set(file.path, current);
  };
  for (const file of head) add(file, 'HEAD');
  for (const file of index) add(file, 'index');

  for (const file of merged.values()) {
    const worktreePath = resolve(root, ...file.path.split('/'));
    if (!existsSync(worktreePath)) continue;
    file.origins.add('worktree');
    const stat = lstatSync(worktreePath);
    if (stat.isFile()) file.size = Math.max(file.size, stat.size);
  }

  return [...merged.values()]
    .map((file) => ({
      path: file.path,
      size: file.size,
      origins: ORIGIN_ORDER.filter((origin) => file.origins.has(origin)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function isSensitivePath(path: string): string | null {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  const envTemplate = ['.example', '.sample', '.template'].some((suffix) => base.endsWith(suffix));
  if (base === '.env' || (base.startsWith('.env.') && !envTemplate)) {
    return '环境变量凭证文件';
  }
  if (['.netrc', 'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519'].includes(base)) {
    return '凭证文件名';
  }
  if (/\.(jks|key|keystore|p12|pfx)$/.test(base)) return '私钥或证书容器';
  if (/oauth.*\.json$/.test(base)) return 'OAuth token 文件';
  // 部署目录包含私有数据,即使文件名或内容未命中其他规则也要排除。
  if (lower === 'deployments' || lower.startsWith('deployments/')) return '部署根不得进入版本控制';
  if (/^bots\/[^/]+\/config\.json$/.test(lower)) return 'bot 部署配置';
  return null;
}

function externalResourceDetail(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.startsWith('local-resources/') || lower.startsWith('cortico-resources/')) {
    return '仓库内资源根必须保持未跟踪';
  }
  if (/^bots\/[^/]+\/voices\//.test(lower)) return '参考声线属于部署者资源';
  if (/^runtime\/(llm\/llama-server|minecraft\/llama-server)\/models\//.test(lower)) {
    return '本地推理模型目录不得进入 Git';
  }
  if (/^scratch\/minecraft\/server(\/|$)/.test(lower)) return 'Minecraft 服务端世界属于外置资源';
  if (/.(moc3|model3.json|cdi3.json|physics3.json|vtube.json|exp3.json|motion3.json)$/.test(lower)) return 'Live2D 模型文件属于外置资源';
  return null;
}

function hasSuffix(path: string, suffixes: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return suffixes.some((suffix) => lower.endsWith(suffix));
}

function isModelBin(path: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith('.bin')) return false;
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  return base.startsWith('ggml-') || /(^|\/)models?\//.test(lower);
}

function isSmallFixture(path: string, size: number): boolean {
  return path.toLowerCase().startsWith('tests/fixtures/') && size <= MAX_FIXTURE_RESOURCE_BYTES;
}

interface CredentialMatch {
  labels: string[];
  origins: ReleaseFindingOrigin[];
}

function credentialFiles(root: string, hasHead: boolean): Map<string, CredentialMatch> {
  const found = new Map<string, { labels: Set<string>; origins: Set<ReleaseFindingOrigin> }>();
  const sources: Array<{ origin: ReleaseFindingOrigin; args: string[]; prefix: string }> = [
    { origin: 'index', args: ['--cached'], prefix: '' },
    { origin: 'worktree', args: [], prefix: '' },
  ];
  if (hasHead) sources.unshift({ origin: 'HEAD', args: [], prefix: 'HEAD:' });

  for (const source of sources) {
    for (const signature of CREDENTIAL_SIGNATURES) {
      const args = ['grep', ...source.args, '-I', '-l', '-z', '-E', '-e', signature.pattern];
      if (source.origin === 'HEAD') args.push('HEAD');
      args.push('--', '.');
      const result = runGit(root, args);
      if (result.status === 1) continue;
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `git grep 失败(exit ${result.status})`);
      }
      for (const rawPath of result.stdout.split('\0').filter(Boolean)) {
        const path = source.prefix && rawPath.startsWith(source.prefix)
          ? rawPath.slice(source.prefix.length)
          : rawPath;
        const match = found.get(path) ?? { labels: new Set<string>(), origins: new Set<ReleaseFindingOrigin>() };
        match.labels.add(signature.label);
        match.origins.add(source.origin);
        found.set(path, match);
      }
    }
  }
  return new Map([...found].map(([path, match]) => [path, {
    labels: [...match.labels],
    origins: ORIGIN_ORDER.filter((origin) => match.origins.has(origin)),
  }]));
}

/** 审计 HEAD 发布树、当前索引与已跟踪工作树。 */
export function auditRepository(startDir: string): ReleaseAuditResult {
  const requestedRoot = resolve(startDir);
  const root = requireGit(requestedRoot, ['rev-parse', '--show-toplevel']).trim();
  const head = headFiles(root);
  const files = mergeTrackedFiles(root, head, indexedFiles(root));
  const findings: ReleaseFinding[] = [];

  for (const file of files) {
    const sensitive = isSensitivePath(file.path);
    if (sensitive) findings.push({ kind: 'credential', path: file.path, detail: sensitive, origins: file.origins });

    const external = externalResourceDetail(file.path);
    if (external) {
      findings.push({ kind: 'external-resource', path: file.path, detail: external, origins: file.origins });
    } else if (!isSmallFixture(file.path, file.size)) {
      if (hasSuffix(file.path, MODEL_SUFFIXES) || isModelBin(file.path)) {
        findings.push({
          kind: 'model-weight',
          path: file.path,
          detail: '模型权重应从发布链接下载到外置资源目录',
          origins: file.origins,
        });
      } else if (hasSuffix(file.path, AUDIO_SUFFIXES)) {
        findings.push({ kind: 'audio', path: file.path, detail: '音频或参考声线不得随源码发布', origins: file.origins });
      } else if (hasSuffix(file.path, LIVE2D_SUFFIXES)) {
        findings.push({ kind: 'live2d', path: file.path, detail: 'Live2D 授权素材不得随源码发布', origins: file.origins });
      } else if (hasSuffix(file.path, MINECRAFT_SUFFIXES)) {
        findings.push({
          kind: 'minecraft',
          path: file.path,
          detail: 'Minecraft 程序、 World 或世界文件不得随源码发布',
          origins: file.origins,
        });
      }
    }

    if (file.size > MAX_TRACKED_FILE_BYTES) {
      findings.push({
        kind: 'large-file',
        path: file.path,
        detail: `${formatBytes(file.size)}，超过 ${formatBytes(MAX_TRACKED_FILE_BYTES)} 的发布审查阈值`,
        origins: file.origins,
      });
    }
  }

  for (const [path, match] of credentialFiles(root, head.length > 0)) {
    if (findings.some((finding) => finding.kind === 'credential' && finding.path === path)) continue;
    findings.push({ kind: 'credential', path, detail: `疑似${match.labels.join('、')}`, origins: match.origins });
  }

  findings.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  return { root, trackedFiles: files.length, findings };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const KIND_LABELS: Record<ReleaseFindingKind, string> = {
  audio: '音频',
  credential: '凭证',
  'external-resource': '外置资源',
  'large-file': '大文件',
  live2d: 'Live2D',
  minecraft: 'Minecraft',
  'model-weight': '模型权重',
};

/** 输出不包含命中的凭证正文。 */
export function formatAuditReport(result: ReleaseAuditResult): string {
  if (result.findings.length === 0) {
    return [
      `公开发布审计通过：检查 ${result.trackedFiles} 个 Git 跟踪文件，未发现外置资源、明文凭证或异常大文件。`,
      '范围：HEAD 发布树、当前 Git 索引与已跟踪工作树；更早的提交历史和其他分支需另行审查。',
    ].join('\n');
  }

  const lines = [`公开发布审计失败：${result.findings.length} 项需要处理。`];
  for (const finding of result.findings) {
    const origins = finding.origins.map((origin) => origin === 'HEAD' ? 'HEAD 发布树' : origin === 'index' ? '索引' : '工作树');
    lines.push(`- [${KIND_LABELS[finding.kind]}] ${JSON.stringify(finding.path)}（${origins.join('、')}）：${finding.detail}`);
  }
  lines.push('', '处理：将部署资源移到仓库同级 Cortico-Resources，并从 Git 索引移除对应路径。');
  if (result.findings.some((finding) => finding.kind === 'credential')) {
    lines.push('凭证：先撤销或轮换，再清理所有待公开分支的历史；仅删除当前文件不足以保密。');
  }
  if (result.findings.some((finding) => finding.origins.includes('HEAD'))) {
    lines.push('HEAD：暂存删除不会改变 git archive HEAD；提交删除后再运行审计。');
  }
  lines.push('复查：处理后重新运行 pnpm audit:release。');
  lines.push('范围：HEAD 发布树、当前 Git 索引与已跟踪工作树；更早的提交历史和其他分支需另行审查。');
  return lines.join('\n');
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && resolve(entry) === fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    const result = auditRepository(process.cwd());
    console.log(formatAuditReport(result));
    if (result.findings.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`公开发布审计无法运行：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
