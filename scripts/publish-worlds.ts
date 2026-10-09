/**
 * 把内建 World 生成 npm 扩展包 `dist/worlds/cortico-world-<id>/`,供不带这些 World 的发行版安装。
 * 包与框架同版本:源码照 `src/worlds/<id>/` 原样复制,跳出 World 目录的相对 import 改写成
 * `cortico/<src 下路径>`,面板打成 `dist/console.js`(+ `.css`)。框架里已内建同 id 的 World 时,
 * 装上的包按 id 冲突不加载。
 *
 * 默认只生成目录;--pack 产出 tarball,--publish 发布。参数里列出 id 时只处理这几个。
 * 包名在 npm 上已有占位版本,版本号可能低于占位版,所以发布显式带 `--tag latest`。
 */
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXTENSION_API_VERSIONS, FRAMEWORK_SPECIFIER } from '../src/extensions/manifest.ts';
import type { RootPackageJson } from './publish-package.ts';

export interface WorldPackageSpec {
  id: string;
  description: string;
  keywords: string[];
  /** 接在包 README 末尾的说明。 */
  readmeNote?: string;
}

export const WORLD_PACKAGES: readonly WorldPackageSpec[] = [
  {
    id: 'minecraft',
    description: 'Cortico World: Minecraft Java Edition through a Mineflayer player — observation text, movement, building, combat and an observer client',
    keywords: ['minecraft', 'mineflayer'],
    // prismarine-viewer 运行时 require canvas,上游只把它列进 devDependencies。canvas 带构建脚本,
    // pnpm 11 遇到未批准的构建脚本整次安装失败,所以不进依赖。
    readmeNote: [
      '观察画面网页(`worlds.minecraft.viewerPort`)要 canvas。它带原生构建脚本,包里不带;没装时 viewer',
      '起不来,只记一条 warn。需要时在扩展目录装:',
      '',
      '```bash',
      'cd extensions && corepack pnpm add --ignore-workspace --allow-build=canvas canvas@3',
      '```',
    ].join('\n'),
  },
  {
    id: 'qq',
    description: 'Cortico World: QQ group and private chats through a OneBot v11 forward WebSocket, with a draft-and-confirm gate on replies',
    keywords: ['qq', 'onebot'],
  },
  {
    id: 'bilibili',
    description: 'Cortico World: read-only Bilibili live room — danmaku, gifts, super chats and guard events, with a local transparent overlay',
    keywords: ['bilibili', 'live-streaming'],
  },
  {
    id: 'websearch',
    description: 'Cortico World: a web_search tool backed by the Brave Search API',
    keywords: ['websearch', 'brave-search'],
  },
];

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SRC_DIR = join(REPO_ROOT, 'src');
const OUT_ROOT = join(REPO_ROOT, 'dist', 'worlds');
const REPO_URL = 'https://github.com/Pal-AI-Lab/Cortico';
/** 面板源码只进 bundle,不随包发。 */
const CONSOLE_DIR = 'console';

export const packageNameOf = (id: string): string => `cortico-world-${id}`;

/** `from '…'`、`import '…'`、`import('…')` 与 `new URL('…', import.meta.url)` 里的相对路径。 */
const RELATIVE_RE = /(\bfrom\s*|\bimport\s*|\bimport\(\s*|new URL\(\s*)(['"])(\.\.?\/[^'"\s]*)\2/g;
const BARE_RE = /(?:\bfrom\s*|\bimport\s*|\bimport\(\s*)['"]([^'"./\s][^'"\s]*)['"]/g;

export interface WorldPackagePlan {
  /** 包内路径(正斜杠)→ 改写后的文本;只含 `.ts`,其余文件原样复制。 */
  sources: Map<string, string>;
  /** 源码 import 到的第三方包。 */
  externals: string[];
  /** 改写不了或改写后指不到文件的引用;非空时不能出包。 */
  problems: string[];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const posix = (p: string): string => p.split(sep).join('/');

function packageOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
}

/** 读 `src/worlds/<id>/` 的 `.ts`,改写跳出目录的 import,并收集第三方包。 */
export function planWorldPackage(id: string): WorldPackagePlan {
  const worldDir = join(SRC_DIR, 'worlds', id);
  const consoleDir = join(worldDir, CONSOLE_DIR);
  const sources = new Map<string, string>();
  const externals = new Set<string>();
  const problems: string[] = [];
  for (const file of walk(worldDir)) {
    if (!file.endsWith('.ts') || file.startsWith(consoleDir + sep)) continue;
    const rel = posix(relative(worldDir, file));
    const text = readFileSync(file, 'utf8').replace(RELATIVE_RE, (whole, head: string, quote: string, spec: string) => {
      const target = resolve(dirname(file), spec);
      if (target.startsWith(worldDir + sep)) return whole;
      if (!target.startsWith(SRC_DIR + sep) || head.startsWith('new URL')) {
        problems.push(`${rel}: ${spec} 指向 World 目录之外,改写不成框架 import`);
        return whole;
      }
      if (!existsSync(target)) problems.push(`${rel}: ${spec} 指向的文件不存在`);
      return `${head}${quote}${FRAMEWORK_SPECIFIER}/${posix(relative(SRC_DIR, target))}${quote}`;
    });
    for (const m of text.matchAll(BARE_RE)) {
      const spec = m[1] as string;
      if (spec.startsWith('node:') || spec.startsWith(`${FRAMEWORK_SPECIFIER}/`)) continue;
      externals.add(packageOf(spec));
    }
    sources.set(rel, text);
  }
  return { sources, externals: [...externals].sort(), problems };
}

/**
 * 依赖钉在仓库 lockfile 装上的版本:World 代码在运行时改写 mineflayer 一系的内部实现,
 * 只对测过的那一版成立。
 */
function installedVersion(name: string): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

function readme(spec: WorldPackageSpec, label: string): string {
  const { id } = spec;
  const name = packageNameOf(id);
  return `# ${name}

Cortico World「${label}」,由 [Cortico](${REPO_URL}) 仓库 \`src/worlds/${id}/\` 生成,包版本就是生成时的框架版本。
源码直接 import 框架内部模块,宿主的 Cortico 版本要与包版本相同。完整 Cortico 已内建这个 World,
装了也会因 id 冲突不加载;这个包给不带它的发行版用。

Generated from \`src/worlds/${id}/\` of [Cortico](${REPO_URL}); the package version is the framework
version it was generated from, and the host must run that same Cortico version. Full Cortico already
ships this World built in; the package is for distributions that leave it out.

\`\`\`bash
cd extensions && corepack pnpm add --ignore-workspace ${name}
\`\`\`

配置与用法见 [src/worlds/${id}](${REPO_URL}/tree/main/src/worlds/${id})。
${spec.readmeNote ? `\n${spec.readmeNote}\n` : ''}`;
}

async function stageWorld(spec: WorldPackageSpec, root: RootPackageJson): Promise<string> {
  const { id } = spec;
  const plan = planWorldPackage(id);
  if (plan.problems.length > 0) throw new Error(`${id}:\n${plan.problems.join('\n')}`);
  const dependencies: Record<string, string> = {};
  for (const name of plan.externals) {
    if (root.dependencies[name] === undefined) throw new Error(`${id}: 仓库根清单的 dependencies 里没有 ${name}`);
    dependencies[name] = installedVersion(name);
  }

  const worldDir = join(SRC_DIR, 'worlds', id);
  const out = join(OUT_ROOT, packageNameOf(id));
  rmSync(out, { recursive: true, force: true });
  cpSync(worldDir, join(out, 'src'), {
    recursive: true,
    filter: (src) => src !== join(worldDir, CONSOLE_DIR) && !src.endsWith('.ts'),
  });
  for (const [rel, text] of plan.sources) {
    const target = join(out, 'src', rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }

  const definitionFile = join(worldDir, 'definition.ts');
  const definitions = await import(pathToFileURL(definitionFile).href) as Record<string, { id?: unknown; label?: unknown }>;
  const [exportName, definition] = Object.entries(definitions).find(([, v]) => v?.id === id) ?? [];
  if (!exportName || typeof definition?.label !== 'string') throw new Error(`${id}: definition.ts 没有导出 id 为 ${id} 的 World`);
  writeFileSync(join(out, 'src', 'index.ts'), `export { ${exportName} as default } from './definition.ts';\n`);

  const cortico: Record<string, unknown> = { kind: 'world', api: EXTENSION_API_VERSIONS.world, displayName: definition.label };
  const consoleEntry = join(worldDir, CONSOLE_DIR, 'client.ts');
  if (existsSync(consoleEntry)) {
    await esbuild.build({
      entryPoints: [{ in: consoleEntry, out: 'console' }],
      outdir: join(out, 'dist'),
      bundle: true,
      format: 'esm',
      jsx: 'automatic',
      target: 'es2022',
      platform: 'browser',
      minify: true,
      sourcemap: true,
      logLevel: 'warning',
    });
    cortico.consoleClient = 'dist/console.js';
    if (existsSync(join(out, 'dist', 'console.css'))) cortico.consoleStyle = 'dist/console.css';
  }

  const manifest = {
    name: packageNameOf(id),
    version: root.version,
    type: 'module',
    description: spec.description,
    license: root.license,
    repository: { ...root.repository, directory: `src/worlds/${id}` },
    homepage: `${REPO_URL}/tree/main/src/worlds/${id}#readme`,
    bugs: { url: `${REPO_URL}/issues` },
    keywords: ['cortico-world', 'cortico', ...spec.keywords],
    engines: root.engines,
    main: './src/index.ts',
    cortico,
    files: ['src', ...(existsSync(join(out, 'dist')) ? ['dist'] : []), 'README.md', 'LICENSE'],
    dependencies,
  };
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, 'README.md'), readme(spec, definition.label));
  cpSync(join(REPO_ROOT, 'LICENSE'), join(out, 'LICENSE'));
  return out;
}

function npm(cwd: string, args: string[]): number {
  const res = spawnSync('npm', args, { cwd, stdio: 'inherit', shell: true });
  return res.status ?? 1;
}

/** registry 上已有这个版本时为真;`npm view` 对不存在的版本输出为空或报 E404。 */
function publishedVersion(name: string, version: string): boolean {
  const res = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', shell: true });
  return res.status === 0 && res.stdout.trim() === version;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const ids = argv.filter((a) => !a.startsWith('--'));
  const unknown = ids.filter((id) => !WORLD_PACKAGES.some((s) => s.id === id));
  if (unknown.length > 0) {
    console.error(`没有这些 World 包: ${unknown.join(', ')}`);
    process.exit(1);
  }
  const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as RootPackageJson;
  const specs = WORLD_PACKAGES.filter((s) => ids.length === 0 || ids.includes(s.id));
  const staged: { name: string; out: string }[] = [];
  for (const spec of specs) {
    const out = await stageWorld(spec, root);
    staged.push({ name: packageNameOf(spec.id), out });
    console.log(`${packageNameOf(spec.id)}@${root.version} → ${out}`);
  }
  for (const { name, out } of staged) {
    if (argv.includes('--pack') && npm(out, ['pack', '--pack-destination', OUT_ROOT]) !== 0) process.exit(1);
    if (!argv.includes('--publish')) continue;
    // 重跑发布任务时跳过已发出的包
    if (publishedVersion(name, root.version)) {
      console.log(`${name}@${root.version} 已在 registry 上,跳过`);
      continue;
    }
    if (npm(out, ['publish', '--access', 'public', '--tag', 'latest']) !== 0) process.exit(1);
  }
  if (!argv.includes('--pack') && !argv.includes('--publish')) console.log('加 --pack 产出 tarball,--publish 发布。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
