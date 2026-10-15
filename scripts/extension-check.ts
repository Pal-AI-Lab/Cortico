/**
 * 检查扩展的 manifest、入口导入、导出结构、WebUI 产物与构造契约。
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
import { loadBuiltinWorlds } from '../src/worlds/index.ts';
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
import { pageIdFor } from '../src/web/shared/webui-protocol.ts';

const builtinWorlds = await loadBuiltinWorlds();

let failures = 0;
const ok = (msg: string): void => console.log(`  ✓ ${msg}`);
const warn = (msg: string): void => console.log(`  ⚠ ${msg}`);
const fail = (msg: string): void => { failures += 1; console.log(`  ✗ ${msg}`); };

function verdict(): void {
  console.log('');
  if (failures === 0) {
    console.log('Extension check passed.');
    return;
  }
  console.log(`Failed checks: ${failures}.`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: pnpm check:extension <extension package directory>');
    process.exitCode = 1;
    return;
  }
  const pkgDir = resolve(process.cwd(), arg);
  const pkgFile = join(pkgDir, 'package.json');
  if (!existsSync(pkgFile)) {
    console.error(`${pkgFile} does not exist: the argument must be the extension package root, the directory that holds package.json.`);
    process.exitCode = 1;
    return;
  }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as ExtensionPackageJson;

  console.log(`Directory: ${pkgDir}`);
  console.log(`Package:   ${pkg.name ?? '(package.json has no name)'}@${pkg.version ?? '(no version)'}`);
  console.log(`Contracts: ${EXTENSION_KINDS.map((kind) => `${kind} v${EXTENSION_API_VERSIONS[kind]}`).join(' / ')}`);
  console.log('');

  if (!pkg.name) fail('package.json has no name: pnpm cannot install a package without one.');
  if (!pkg.version) fail('package.json has no version: browser bundle URLs contain the version, so without one browsers keep serving the old cached bundle.');

  const parsed = parseExtensionManifest(pkg, 'en');
  for (const w of parsed.warnings) warn(w);
  if (!parsed.ok) {
    for (const reason of parsed.reasons) fail(reason);
    verdict();
    return;
  }
  const manifest = parsed.manifest;
  ok(`manifest: kind=${manifest.kind}, api=${manifest.api}`);

  const entry = resolveExtensionEntry(pkgDir, pkg);
  if (!existsSync(entry)) {
    fail(`Entry ${entry} does not exist: the file that exports / module / main points to must ship in the package (check files and .npmignore).`);
    verdict();
    return;
  }
  ok(`Entry: ${entry}`);

  // 扩展 import `cortico/*` 靠这个钩子;装载器在 import 前也是先注册它。
  registerFrameworkResolver();
  let exported: unknown;
  try {
    exported = ((await import(pathToFileURL(entry).href)) as { default?: unknown }).default;
  } catch (error) {
    fail(`Importing the entry threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    verdict();
    return;
  }

  const shaped = manifest.kind === 'world' ? isWorldDefinition(exported)
    : manifest.kind === 'provider' ? isProviderModule(exported)
    : isBotDefinition(exported);
  if (!shaped) {
    fail(`${extensionShapeMismatch(manifest.kind, 'en')} The extension cannot load.`);
    verdict();
    return;
  }
  const noun = { world: 'World', provider: 'provider', bot: 'bot' }[manifest.kind];
  const id = (exported as { id: string }).id;
  ok(`Default export has the ${manifest.kind} shape; id = ${id}`);
  if (manifest.kind === 'bot') {
    console.log('    The bot id must not match a directory under bots/ in the repository. To use the bot, set the bot field of deployment.json to the package name.');
    console.log('    The package directory is read-only: a promptDocs template without deploymentPath shows in the WebUI but cannot be saved.');
  } else {
    console.log(`    The ${noun} id must be unique in the deployment; an id that matches a built-in or another extension does not load.`);
    const builtin = manifest.kind === 'world' ? builtinWorlds.map((w) => w.id) : providerModules.map((p) => p.id);
    if (builtin.includes(id)) fail(`${noun} id "${id}" matches a built-in ${noun}; the loader refuses to load it.`);
  }

  if (manifest.webUiClient === undefined) {
    ok('No browser bundle declared (cortico.webUiClient); the WebUI shows the generic panel.');
  } else {
    const js = extensionPackageFile(pkgDir, manifest.webUiClient);
    if (!js) {
      fail(`cortico.webUiClient points to ${manifest.webUiClient}, which is not in the package: build it, then check that files / .npmignore include it. The ${noun} still loads, without this WebUI panel.`);
    } else {
      ok(`Browser bundle: ${manifest.webUiClient}`);
      console.log(`    WebUI page id: ${pageIdFor(EXTENSION_PAGE_KIND[manifest.kind], id)}`);
      console.log(`    Published URL: ${extensionAssetUrl(pkg.name ?? '', pkg.version ?? '0', basename(manifest.webUiClient))}`);
    }
    if (manifest.webUiStyle !== undefined) {
      if (extensionPackageFile(pkgDir, manifest.webUiStyle)) ok(`Browser style: ${manifest.webUiStyle}`);
      else warn(`cortico.webUiStyle points to ${manifest.webUiStyle}, which is not in the package: the panel is served without styles.`);
    }
  }

  // 使用临时部署检查构造与声明,不调用 start()。
  console.log('');
  console.log('Construction check (temporary deployment, default config, no secrets, start() not called):');
  const scratchDir = mkdtempSync(join(tmpdir(), 'cortico-check-'));
  try {
    const dryOpts = {
      scratchDir,
      packageDir: pkgDir,
      repoRoot: resolve(import.meta.dirname, '..'),
      hasWebUiClient: manifest.webUiClient !== undefined,
      language: 'en' as const,
    };
    let report: DryMountReport;
    if (manifest.kind === 'world') {
      const { taken, skipped } = collectToolNames(builtinWorlds, dryOpts);
      for (const s of skipped) warn(`A built-in World failed to construct, so the name collision check does not cover its tools: ${s}`);
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
