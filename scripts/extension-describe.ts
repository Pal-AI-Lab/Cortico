/**
 * 生成扩展包的 describe.json:`cortico.describe` 指的路径,缺省为 describe.json,并把这个缺省值写进
 * package.json 的 cortico 块。内容来自默认导出的 describe 与干装载结果,见 src/extensions/describe-export.ts。
 * 定义没写 describe 或构造失败时退出码为 1。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseExtensionManifest, type ExtensionPackageJson } from '../src/extensions/manifest.ts';
import { registerFrameworkResolver } from '../src/extensions/runtime.ts';
import { DEFAULT_DESCRIBE_FILE, MISSING_DESCRIBE, exportDescribe } from '../src/extensions/describe-export.ts';
import { extensionShapeMismatch, isBotDefinition, isProviderModule, isWorldDefinition, resolveExtensionEntry } from '../src/extensions.ts';

function exit(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) return exit('Usage: pnpm describe:extension <extension package directory>');
  const pkgDir = resolve(process.cwd(), arg);
  const pkgFile = join(pkgDir, 'package.json');
  if (!existsSync(pkgFile)) return exit(`${pkgFile} does not exist: the argument must be the extension package root, the directory that holds package.json.`);
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as ExtensionPackageJson & { files?: unknown };

  const parsed = parseExtensionManifest(pkg, 'en');
  for (const warning of parsed.warnings) console.log(`⚠ ${warning}`);
  if (!parsed.ok) return exit(parsed.reasons.map((reason) => `✗ ${reason}`).join('\n'));
  const { manifest } = parsed;
  const block = pkg.cortico as Record<string, unknown>;
  if (block.describe !== undefined && manifest.describe === undefined) return exit('Fix cortico.describe (see the warning above) or remove it to use describe.json.');

  const entry = resolveExtensionEntry(pkgDir, pkg);
  if (!existsSync(entry)) return exit(`Entry ${entry} does not exist.`);
  registerFrameworkResolver();
  const exported = ((await import(pathToFileURL(entry).href)) as { default?: unknown }).default;
  const shaped = manifest.kind === 'world' ? isWorldDefinition(exported)
    : manifest.kind === 'provider' ? isProviderModule(exported)
    : isBotDefinition(exported);
  if (!shaped) return exit(extensionShapeMismatch(manifest.kind, 'en'));

  const scratchDir = mkdtempSync(join(tmpdir(), 'cortico-describe-'));
  try {
    let describe;
    try {
      describe = await exportDescribe(manifest.kind, exported, {
        scratchDir,
        packageDir: pkgDir,
        repoRoot: resolve(import.meta.dirname, '..'),
        language: 'en',
      });
    } catch (error) {
      return exit(`Constructing the extension in a temporary deployment threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
    if (!describe) return exit(MISSING_DESCRIBE[manifest.kind]);
    const target = manifest.describe ?? DEFAULT_DESCRIBE_FILE;
    writeFileSync(join(pkgDir, target), `${JSON.stringify(describe, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${join(pkgDir, target)}: tools ${describe.tools?.length ?? 0}, events ${describe.events?.length ?? 0}, prompts ${describe.prompts?.length ?? 0}.`);
    if (manifest.describe === undefined) {
      block.describe = target;
      writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
      console.log(`Added "describe": "${target}" to the cortico block of package.json.`);
    }
    if (Array.isArray(pkg.files) && !pkg.files.includes(target)) {
      console.log(`package.json files does not list ${target}; npm publish leaves it out unless a pattern there covers it.`);
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

await main();
