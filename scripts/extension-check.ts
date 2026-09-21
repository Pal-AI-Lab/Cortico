/**
 * 检查扩展的 manifest、入口导入、导出结构、控制台产物与构造契约。
 * 有检查失败时退出码为 1;不启动扩展或验证外部服务。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EXTENSION_API_VERSIONS,
  EXTENSION_KINDS,
  parseExtensionManifest,
  extensionAssetUrl,
  type ExtensionPackageJson,
} from '../src/extensions/manifest.ts';
import { registerFrameworkResolver } from '../src/extensions/runtime.ts';
import { collectToolNames, dryMountBot, dryMountProvider, dryMountWorld, type DryMountReport } from '../src/extensions/dry-mount.ts';
import { BUILTIN_WORLDS } from '../src/worlds/index.ts';
import { providerModules } from '../src/providers/registry.ts';
import type { BotDefinition } from '../src/bot.ts';
import type { CoreConfig } from '../src/core/types.ts';
import type { WorldDefinition, WorldSection } from '../src/world.ts';
import type { ProviderModule } from '../src/providers/base.ts';
import {
  EXTENSION_PAGE_KIND,
  isBotDefinition,
  isWorldDefinition,
  isProviderModule,
  extensionPackageFile,
  extensionShapeMismatch,
  resolveExtensionEntry,
} from '../src/extensions.ts';
import { pageIdFor } from '../src/web/shared/console-protocol.ts';

let failures = 0;
const ok = (msg: string): void => console.log(`  ✓ ${msg}`);
const warn = (msg: string): void => console.log(`  ⚠ ${msg}`);
const fail = (msg: string): void => { failures += 1; console.log(`  ✗ ${msg}`); };

function verdict(): void {
  console.log('');
  if (failures === 0) {
    console.log('扩展检查通过。');
    return;
  }
  console.log(`${failures} 项检查失败。`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('用法: pnpm check:extension <扩展目录>');
    process.exitCode = 1;
    return;
  }
  const pkgDir = resolve(process.cwd(), arg);
  const pkgFile = join(pkgDir, 'package.json');
  if (!existsSync(pkgFile)) {
    console.error(`${pkgFile} 不存在:参数要指向扩展包的根目录(含 package.json 的那一层)。`);
    process.exitCode = 1;
    return;
  }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as ExtensionPackageJson;

  console.log(`扩展目录: ${pkgDir}`);
  console.log(`包:       ${pkg.name ?? '(package.json 没有 name)'}@${pkg.version ?? '(没有 version)'}`);
  console.log(`框架契约: ${EXTENSION_KINDS.map((kind) => `${kind} v${EXTENSION_API_VERSIONS[kind]}`).join(' / ')}`);
  console.log('');

  if (!pkg.name) fail('package.json 缺少 name:pnpm 装不了没有名字的包。');
  if (!pkg.version) fail('package.json 缺少 version:浏览器端产物的 URL 按版本分段,没有版本换不掉旧缓存。');

  const parsed = parseExtensionManifest(pkg);
  for (const w of parsed.warnings) warn(w);
  if (!parsed.ok) {
    for (const reason of parsed.reasons) fail(reason);
    verdict();
    return;
  }
  const manifest = parsed.manifest;
  ok(`manifest: kind=${manifest.kind},api=${manifest.api}`);

  const entry = resolveExtensionEntry(pkgDir, pkg);
  if (!existsSync(entry)) {
    fail(`入口 ${entry} 不存在:exports / module / main 指向的文件要随包发布(检查 files 与 .npmignore)。`);
    verdict();
    return;
  }
  ok(`入口: ${entry}`);

  // 扩展 import `cortico/*` 靠这个钩子;装载器在 import 前也是先注册它。
  registerFrameworkResolver();
  let exported: unknown;
  try {
    exported = ((await import(pathToFileURL(entry).href)) as { default?: unknown }).default;
  } catch (error) {
    fail(`import 入口时抛错: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    verdict();
    return;
  }

  const shaped = manifest.kind === 'world' ? isWorldDefinition(exported)
    : manifest.kind === 'provider' ? isProviderModule(exported)
    : isBotDefinition(exported);
  if (!shaped) {
    fail(`${extensionShapeMismatch(manifest.kind)}扩展无法加载。`);
    verdict();
    return;
  }
  const noun = { world: 'World', provider: 'provider', bot: 'bot' }[manifest.kind];
  const id = (exported as { id: string }).id;
  ok(`默认导出符合 ${manifest.kind} 的形状;id = ${id}`);
  if (manifest.kind === 'bot') {
    console.log('    bot id 不得与仓内 bots/ 下任一目录同名;deployment.json 的 bot 字段填包名即启用。');
    console.log('    包目录只读:promptDocs 里没给 deploymentPath 的模板在控制台里显示但不能保存。');
  } else {
    console.log(`    ${noun} id 在整份部署里唯一,与内建的或别的扩展同名时无法加载。`);
    const builtin = manifest.kind === 'world' ? BUILTIN_WORLDS.map((w) => w.id) : providerModules.map((p) => p.id);
    if (builtin.includes(id)) fail(`${noun} id「${id}」与内建的撞名,装载器拒绝加载。`);
  }

  if (manifest.consoleClient === undefined) {
    ok('没有声明浏览器端产物(cortico.consoleClient),控制台按框架给的通用面板显示。');
  } else {
    const js = extensionPackageFile(pkgDir, manifest.consoleClient);
    if (!js) {
      fail(`cortico.consoleClient 指的 ${manifest.consoleClient} 不在包里:先 build,再确认它落在 files / .npmignore 允许的范围内。${noun}本体照常加载,只是控制台没有这一块面板。`);
    } else {
      ok(`浏览器端产物: ${manifest.consoleClient}`);
      console.log(`    控制台页 id: ${pageIdFor(EXTENSION_PAGE_KIND[manifest.kind], id)}`);
      console.log(`    发布后的 URL: ${extensionAssetUrl(pkg.name ?? '', pkg.version ?? '0', basename(manifest.consoleClient))}`);
    }
    if (manifest.consoleStyle !== undefined) {
      if (extensionPackageFile(pkgDir, manifest.consoleStyle)) ok(`浏览器端样式: ${manifest.consoleStyle}`);
      else warn(`cortico.consoleStyle 指的 ${manifest.consoleStyle} 不在包里:面板按无样式发。`);
    }
  }

  // 使用临时部署检查构造与声明,不调用 start()。
  console.log('');
  console.log('构造检查(临时部署、默认配置、无密钥,不调用 start):');
  const scratchDir = mkdtempSync(join(tmpdir(), 'cortico-check-'));
  try {
    const dryOpts = {
      scratchDir,
      packageDir: pkgDir,
      repoRoot: resolve(import.meta.dirname, '..'),
      hasConsoleClient: manifest.consoleClient !== undefined,
    };
    let report: DryMountReport;
    if (manifest.kind === 'world') {
      const { taken, skipped } = collectToolNames(BUILTIN_WORLDS, dryOpts);
      for (const s of skipped) warn(`内建 World 构造失败,无法将其工具纳入重名检查: ${s}`);
      report = await dryMountWorld(exported as WorldDefinition<WorldSection>, { ...dryOpts, takenToolNames: taken });
    } else if (manifest.kind === 'provider') {
      report = dryMountProvider(exported as ProviderModule, dryOpts);
    } else {
      report = dryMountBot(exported as BotDefinition<CoreConfig>, dryOpts);
    }
    for (const m of report.ok) ok(m);
    for (const m of report.warnings) warn(m);
    for (const m of report.failures) fail(m);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  verdict();
}

await main();
