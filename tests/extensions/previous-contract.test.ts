/**
 * 上一版契约的包经过渡层加载:manifest 给 warning 而不拒绝,旧名接到新名上;再老的照旧拒绝,
 * check:extension 对上一版契约判失败。夹具包按上一版契约写成。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ExtensionManager, importBotDefinition, loadExtensions, locateBotPackage } from '../../src/extensions.ts';
import { EXTENSION_API_VERSIONS, EXTENSION_KINDS, parseExtensionManifest } from '../../src/extensions/manifest.ts';
import { PREVIOUS_CONTRACT_VERSIONS, UPGRADING_URL, previousContractModulePath } from '../../src/extensions/previous-contract.ts';
import { providerModules } from '../../src/providers/registry.ts';
import type { ProviderWebUiHost } from '../../src/providers/webui/types.ts';
import type { LoadedConfig } from '../../src/deploy.ts';
import type { WorldContext, WorldSection } from '../../src/world.ts';
import { WebApp } from '../../src/web/server.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from '../web/fakes.ts';
import { installFixture } from '../fixtures/extensions/install.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'extension-previous-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('契约版本', () => {
  it('过渡层认的版本正好比当前小一;契约再加一时这里变红,该删过渡层了', () => {
    for (const kind of EXTENSION_KINDS) expect(PREVIOUS_CONTRACT_VERSIONS[kind]).toBe(EXTENSION_API_VERSIONS[kind] - 1);
  });

  it('上一版契约解析通过并给 warning,旧字段名当新字段名;再老一版照旧拒绝', () => {
    for (const kind of EXTENSION_KINDS) {
      const parse = (api: number) => parseExtensionManifest({
        type: 'module', keywords: [`cortico-${kind}`],
        cortico: { kind, api, consoleClient: 'dist/console.js', consoleStyle: 'dist/console.css' },
      });
      const previous = parse(PREVIOUS_CONTRACT_VERSIONS[kind]);
      expect(previous.ok).toBe(true);
      expect(previous.warnings).toEqual([expect.stringContaining(UPGRADING_URL)]);
      expect(previous.ok && previous.manifest).toMatchObject({ webUiClient: 'dist/console.js', webUiStyle: 'dist/console.css' });
      const older = parse(PREVIOUS_CONTRACT_VERSIONS[kind] - 1);
      expect(older.ok).toBe(false);
      expect((older as { reasons: string[] }).reasons.join('')).toContain('扩展需要升级');
    }
  });
});

describe('加载与改名', () => {
  it('World:产物按 consoleClient 发,实例的 console() 当 webUi(),旧模块路径 import 得到', async () => {
    installFixture(root, 'world-previous-contract');
    const set = await loadExtensions(root);
    const record = set.records[0];
    expect(record).toMatchObject({ loaded: true, previousContract: true, webUi: 'served', worldId: 'previous-world' });
    expect(record.warnings?.('en')).toEqual([expect.stringContaining('transition layer')]);
    expect(set.webUiAssets.map((a) => [a.pageId, a.jsFile.endsWith('console.js'), a.cssFile?.endsWith('console.css')]))
      .toEqual([['world:previous-world', true, true]]);
    const world = set.worlds[0].create({} as WorldContext<WorldSection>);
    expect(world.webUi?.('en')?.label).toBe('world:previous-world en');
  });

  it('provider:模块的 console() 当 webUi();框架内建模块能按旧名 console 调', async () => {
    installFixture(root, 'provider-previous-contract');
    const set = await loadExtensions(root);
    expect(set.records[0]).toMatchObject({ loaded: true, previousContract: true });
    const host = { language: 'en' } as ProviderWebUiHost;
    expect(set.providers[0].webUi?.(host).panels).toEqual([{ id: 'own', title: 'en' }]);
    for (const builtin of providerModules.filter((m) => m.webUi)) {
      expect((builtin as { console?: unknown }).console).toBe(builtin.webUi);
    }
  });

  it('bot:声明的 terminal 当 console,Persona 的 console() 与 BotParts.console 的 consolePages 接到新名', async () => {
    installFixture(root, 'bot-previous-contract');
    const location = locateBotPackage(root, 'bot-previous-contract', join(root, 'bots', 'bot-previous-contract'));
    const definition = await importBotDefinition(location, { treeHas: () => false });
    expect(definition.declares).toEqual(['console', { id: 'qq', label: 'QQ' }]);
    const parts = definition.build({} as LoadedConfig, []);
    expect(parts.persona.webUi?.('ja')?.panels).toEqual([{ id: 'memory', title: 'ja' }]);
    expect(parts.webUi?.enabled).toBe(true);
    expect(parts.webUi?.webUiPages?.({ storage: [], language: 'en' }).map((p) => p.label)).toEqual(['en']);
  });

  it('旧模块路径只对上一版契约的包改写', () => {
    const previous = installFixture(root, 'world-previous-contract');
    const current = installFixture(root, 'world-ok');
    const from = (dir: string) => pathToFileURL(join(dir, 'index.js')).href;
    expect(previousContractModulePath('web/shared/console-protocol.ts', from(previous))).toBe('web/shared/webui-protocol.ts');
    expect(previousContractModulePath('worlds/terminal/config.ts', from(previous))).toBe('worlds/console/config.ts');
    expect(previousContractModulePath('worlds/qq/console/client.ts', from(previous))).toBe('worlds/qq/webui/client.ts');
    expect(previousContractModulePath('core/util.ts', from(previous))).toBeNull();
    expect(previousContractModulePath('web/shared/console-protocol.ts', from(current))).toBeNull();
  });
});

describe('旧面板路由', () => {
  it('/api/console/providers/... 只转给上一版契约的包的页,别的页 404', async () => {
    installFixture(root, 'world-previous-contract');
    installFixture(root, 'world-ok');
    const set = await loadExtensions(root);
    const echo = (id: string) => ({
      id,
      contribute: () => ({
        id, kind: 'world' as const, label: id, panels: [{ id: 'p', title: 'P' }],
        invoke: async (panel: string, method: string, args: unknown[]) => ({ panel, method, args }),
      }),
    });
    const app = new WebApp({
      store: new FakeStore(),
      memoryDir: root,
      dataDir: root,
      getStatus: () => ({}),
      run: { pause: () => {}, resume: () => {}, isPaused: () => false },
      log: nullLogger(),
      extensions: new ExtensionManager(root, set),
      webUiPageSources: () => [echo('world:previous-world'), echo('world:fixture-world')],
    });
    const port = await app.start(0);
    try {
      const post = (page: string) => fetch(`http://127.0.0.1:${port}/api/console/providers/${encodeURIComponent(page)}/panels/p/ping`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: [1] }),
      });
      const forwarded = await post('world:previous-world');
      expect(forwarded.status).toBe(200);
      expect(await forwarded.json()).toEqual({ panel: 'p', method: 'ping', args: [1] });
      expect((await post('world:fixture-world')).status).toBe(404);
    } finally {
      await app.stop();
    }
  });
});

describe('check:extension', () => {
  it('上一版契约判失败,给出升级说明', () => {
    const pkgDir = installFixture(root, 'world-previous-contract');
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/extension-check.ts', pkgDir], { cwd: repoRoot, encoding: 'utf8' });
    expect(child.status).toBe(1);
    expect(child.stdout).toContain(`✗ cortico.api ${PREVIOUS_CONTRACT_VERSIONS.world} is the previous world contract`);
    expect(child.stdout).toContain(UPGRADING_URL);
  });
});
