/**
 * 生成 npm 发布包 dist/package：框架源码、发布清单、README 与 LICENSE。
 * 默认只生成目录;--pack 产出 tarball,--publish 发布。清单缺少源码用到的第三方包时退出码为 1。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 发布包的名字;与扩展代码里 `cortico/<src 下路径>` 的前缀一致。 */
export const PACKAGE_NAME = 'cortico';

/**
 * 发布清单声明的依赖。扩展作者只 import 契约面,但 TypeScript 会跟着相对 import 解析到
 * `src/web/` 的服务端类型,因此 express 与 ws 的类型也要装得上。版本取自仓库根清单。
 */
export const PUBLISHED_DEPENDENCIES = [
  '@types/express',
  '@types/ws',
  'express',
  'ws',
] as const;

export interface RootPackageJson {
  version: string;
  description: string;
  license: string;
  repository: { type: string; url: string };
  engines: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface PublishManifest {
  name: string;
  version: string;
  type: 'module';
  description: string;
  license: string;
  repository: { type: string; url: string };
  homepage: string;
  bugs: { url: string };
  keywords: string[];
  engines: Record<string, string>;
  exports: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
}

const REPO_ROOT = resolve(import.meta.dirname, '..');
const STAGING_DIR = join(REPO_ROOT, 'dist', 'package');
const REPO_URL = 'https://github.com/Pal-AI-Lab/Cortico';

/** 发布清单。`./*` 把 `cortico/core/types.ts` 解析到包内的 `src/core/types.ts`。 */
export function buildManifest(root: RootPackageJson): PublishManifest {
  const dependencies: Record<string, string> = {};
  for (const name of PUBLISHED_DEPENDENCIES) {
    const range = root.dependencies[name] ?? root.devDependencies[name];
    if (range === undefined) throw new Error(`仓库根清单里没有 ${name},无法确定发布依赖的版本范围`);
    dependencies[name] = range;
  }
  return {
    name: PACKAGE_NAME,
    version: root.version,
    type: 'module',
    description: root.description,
    license: root.license,
    repository: root.repository,
    homepage: `${REPO_URL}#readme`,
    bugs: { url: `${REPO_URL}/issues` },
    keywords: ['cortico', 'agent', 'persona', 'bot', 'framework', 'typescript'],
    engines: root.engines,
    exports: { './package.json': './package.json', './*': './src/*' },
    files: ['src', 'README.md', 'LICENSE'],
    dependencies,
  };
}

const FROM_RE = /(?:^|[\s;])(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g;

export function importSpecifiers(text: string): string[] {
  const specs: string[] = [];
  for (const m of text.matchAll(FROM_RE)) specs.push(m[1] as string);
  for (const m of text.matchAll(SIDE_EFFECT_RE)) specs.push(m[1] as string);
  return specs;
}

/** 目录下所有 `.ts` 文件里出现的 `cortico/<路径>` 说明符,去掉前缀后返回 src 下的相对路径。 */
export function corticoEntries(dir: string): string[] {
  const found = new Set<string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        for (const spec of importSpecifiers(readFileSync(full, 'utf8'))) {
          if (spec.startsWith(`${PACKAGE_NAME}/`)) found.add(spec.slice(PACKAGE_NAME.length + 1));
        }
      }
    }
  };
  walk(dir);
  return [...found].sort();
}

/** 包名部分:`@scope/name/sub` 取 `@scope/name`,`name/sub` 取 `name`。 */
function packageOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
}

/** 从入口出发沿相对 import 求闭包,返回触及的源码文件与第三方包名。 */
export function importClosure(srcDir: string, entries: readonly string[]): { files: string[]; externals: string[] } {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const queue = entries.map((e) => resolve(srcDir, e));
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec));
      else if (spec.startsWith(`${PACKAGE_NAME}/`)) queue.push(resolve(srcDir, spec.slice(PACKAGE_NAME.length + 1)));
      else externals.add(packageOf(spec));
    }
  }
  return { files: [...seen].sort(), externals: [...externals].sort() };
}

/** 闭包里出现但清单没声明的第三方包。`@types/*` 与它对应的包一起声明,不单独计入。 */
export function missingDependencies(manifest: PublishManifest, externals: readonly string[]): string[] {
  return externals.filter((name) => manifest.dependencies[name] === undefined);
}

function stage(manifest: PublishManifest): void {
  rmSync(STAGING_DIR, { recursive: true, force: true });
  mkdirSync(STAGING_DIR, { recursive: true });
  cpSync(join(REPO_ROOT, 'src'), join(STAGING_DIR, 'src'), { recursive: true });
  cpSync(join(REPO_ROOT, 'LICENSE'), join(STAGING_DIR, 'LICENSE'));
  cpSync(join(REPO_ROOT, 'scripts', 'package-readme.md'), join(STAGING_DIR, 'README.md'));
  writeFileSync(join(STAGING_DIR, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function npm(args: string[]): number {
  const res = spawnSync('npm', args, { cwd: STAGING_DIR, stdio: 'inherit', shell: true });
  return res.status ?? 1;
}

async function main(): Promise<void> {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as RootPackageJson;
  const manifest = buildManifest(root);
  const entries = corticoEntries(join(REPO_ROOT, 'templates', 'extension'));
  const { files, externals } = importClosure(join(REPO_ROOT, 'src'), entries);
  const missing = missingDependencies(manifest, externals);
  if (missing.length > 0) {
    console.error(`发布清单缺少扩展契约用到的依赖: ${missing.join(', ')}`);
    process.exit(1);
  }

  stage(manifest);
  console.log(`${manifest.name}@${manifest.version} → ${STAGING_DIR}`);
  console.log(`扩展契约闭包 ${files.length} 个文件,第三方依赖 ${externals.join(', ')}`);

  const argv = process.argv.slice(2);
  if (argv.includes('--pack')) process.exit(npm(['pack', '--pack-destination', join(REPO_ROOT, 'dist')]));
  if (argv.includes('--publish')) process.exit(npm(['publish', '--access', 'public']));
  console.log('加 --pack 产出 tarball,--publish 发布。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
