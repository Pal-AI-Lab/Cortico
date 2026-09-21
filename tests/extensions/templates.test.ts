/** 检查扩展模板的 manifest、导出结构、构造结果及 id 冲突。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXTENSION_API_VERSIONS, EXTENSION_KEYWORDS, parseExtensionManifest, type ExtensionPackageJson } from '../../src/extensions/manifest.ts';
import { isBotDefinition, isProviderModule, isWorldDefinition, resolveExtensionEntry } from '../../src/extensions.ts';
import { collectToolNames, dryMountBot, dryMountProvider, dryMountWorld } from '../../src/extensions/dry-mount.ts';
import { BUILTIN_WORLDS } from '../../src/worlds/index.ts';
import { providerModules } from '../../src/providers/registry.ts';
import type { BotDefinition } from '../../src/bot.ts';
import type { CoreConfig } from '../../src/core/types.ts';
import type { WorldDefinition, WorldSection } from '../../src/world.ts';
import type { ProviderModule } from '../../src/providers/base.ts';

const TEMPLATES = resolve(import.meta.dirname, '../../templates/extension');
const BOTS_DIR = resolve(import.meta.dirname, '../../bots');

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'templates-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

async function loadTemplate(kind: 'world' | 'provider' | 'bot') {
  const pkgDir = join(TEMPLATES, kind);
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as ExtensionPackageJson;
  const parsed = parseExtensionManifest(pkg);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  if (!parsed.ok) throw new Error('unreachable');
  expect(parsed.warnings).toEqual([]);
  expect(parsed.manifest.kind).toBe(kind);
  expect(parsed.manifest.api).toBe(EXTENSION_API_VERSIONS[kind]);
  expect(pkg.keywords).toContain(EXTENSION_KEYWORDS[kind]);
  const entry = resolveExtensionEntry(pkgDir, pkg);
  expect(existsSync(entry)).toBe(true);
  const exported = ((await import(pathToFileURL(entry).href)) as { default?: unknown }).default;
  return { pkgDir, exported };
}

describe('templates/extension', () => {
  it('每个 kind 一个目录,各带 README', () => {
    expect(readdirSync(TEMPLATES).filter((n) => existsSync(join(TEMPLATES, n, 'package.json'))).sort()).toEqual(['bot', 'provider', 'world']);
    for (const kind of ['world', 'provider', 'bot']) expect(existsSync(join(TEMPLATES, kind, 'README.md'))).toBe(true);
  });

  it("World 模板通过结构与构造检查，工具名不与内建冲突", async () => {
    const { pkgDir, exported } = await loadTemplate('world');
    expect(isWorldDefinition(exported)).toBe(true);
    const def = exported as WorldDefinition<WorldSection>;
    expect(BUILTIN_WORLDS.map((w) => w.id)).not.toContain(def.id);
    const { taken } = collectToolNames(BUILTIN_WORLDS, { scratchDir });
    const report = await dryMountWorld(def, { scratchDir, packageDir: pkgDir, takenToolNames: taken });
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("Provider 模板通过结构与构造检查，id 不与内建冲突", async () => {
    const { exported } = await loadTemplate('provider');
    expect(isProviderModule(exported)).toBe(true);
    const mod = exported as ProviderModule;
    expect(providerModules.map((p) => p.id)).not.toContain(mod.id);
    const report = dryMountProvider(mod, { scratchDir });
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("Bot 模板通过结构与构造检查，id 不与仓内 bot 冲突", async () => {
    const { pkgDir, exported } = await loadTemplate('bot');
    expect(isBotDefinition(exported)).toBe(true);
    const def = exported as BotDefinition<CoreConfig>;
    expect(readdirSync(BOTS_DIR)).not.toContain(def.id);
    const report = dryMountBot(def, { scratchDir, packageDir: pkgDir });
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});
