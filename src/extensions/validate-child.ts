import { BUILTIN_WORLDS } from '../worlds/index.ts';
import { providerModules } from '../providers/registry.ts';
/** Isolated declaration validation; never starts the package's runtime. */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseExtensionManifest } from './manifest.ts';
import { registerFrameworkResolver } from './runtime.ts';
import { dryMountBot, dryMountProvider, dryMountWorld } from './dry-mount.ts';
import { extensionPackageFile, isBotDefinition, isProviderModule, isWorldDefinition, resolveExtensionEntry } from '../extensions.ts';

const dir = process.argv[2];
const scratch = mkdtempSync(join(tmpdir(), 'cortico-extension-check-'));
try {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const [field, current] of [['os', process.platform], ['cpu', process.arch]] as const) {
    const constraints = pkg[field] as string[] | undefined;
    if (constraints && (constraints.includes('!' + current) || (constraints.some(value => !value.startsWith('!')) && !constraints.includes(current) && !constraints.includes('any')))) throw new Error('扩展不支持当前平台: ' + field + '=' + current);
  }
  const parsed = parseExtensionManifest(pkg);
  if (!parsed.ok) throw new Error(parsed.reasons.join('\n'));
  for (const asset of [parsed.manifest.consoleClient, parsed.manifest.consoleStyle]) {
    if (asset && !extensionPackageFile(dir, asset)) throw new Error('缺少声明的控制台资源: ' + asset);
  }
  registerFrameworkResolver();
  const value = (await import(pathToFileURL(resolveExtensionEntry(dir, pkg)).href)).default;
  const options = { scratchDir: scratch, packageDir: dir, hasConsoleClient: !!parsed.manifest.consoleClient };
  const kind = parsed.manifest.kind;
  const report = kind === 'world' && isWorldDefinition(value) ? await dryMountWorld(value, options)
    : kind === 'provider' && isProviderModule(value) ? dryMountProvider(value, options)
    : kind === 'bot' && isBotDefinition(value) ? dryMountBot(value, options) : null;
  if (!report) throw new Error('扩展默认导出与声明的类型不匹配。');
  const builtin = kind === 'world' ? BUILTIN_WORLDS.map(p => p.id) : kind === 'provider' ? providerModules.map(p => p.id) : [];
  if (kind === 'bot' && existsSync(join(fileURLToPath(new URL('../../', import.meta.url)), 'bots', value.id, 'index.ts'))) throw new Error('Bot ID 与内建模板冲突: ' + value.id);
  if (builtin.includes(value.id)) throw new Error('扩展 ID 与内建模块冲突: ' + value.id);
  if (report.failures.length) throw new Error(report.failures.join('\n'));
  process.send?.({ ok: true, name: pkg.name, version: pkg.version, kind, moduleId: value.id, warnings: report.warnings });
} catch (error) {
  process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
