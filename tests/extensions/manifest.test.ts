/**
 * 按 manifest.kind 验证导出结构、id 命名空间和控制台页前缀。
 * 测试包从 tests/fixtures/extensions 复制到临时依赖目录后导入。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionManager, importBotDefinition, loadExtensions, locateBotPackage } from '../../src/extensions.ts';
import {
  EXTENSION_API_VERSION,
  EXTENSION_ASSET_PREFIX,
  parseExtensionManifest,
  extensionAssetUrl,
} from '../../src/extensions/manifest.ts';
import { ProviderRegistry, providerModule, providerModules, registerProviderModules } from '../../src/providers/registry.ts';
import type { ProviderModule } from '../../src/providers/base.ts';
import { nullLogger } from '../../src/core/util.ts';
import { installFixture } from '../fixtures/extensions/install.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'extension-manifest-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const byName = async (opts?: Parameters<typeof loadExtensions>[1]) => {
  const set = await loadExtensions(root, opts);
  return { set, records: Object.fromEntries(set.records.map((r) => [r.name, r])) };
};

describe('按 kind 分派', () => {
  it('worlds 进 World 表、provider 进端点表,各自记下 kind 与契约版本', async () => {
    installFixture(root, 'world-ok');
    installFixture(root, 'provider-ok');
    const { set, records } = await byName();
    expect(set.worlds.map((m) => m.id)).toEqual(['fixture-world']);
    expect(set.providers.map((p) => p.id)).toEqual(['fixture-provider']);
    expect(records['world-ok']).toMatchObject({ kind: 'world', api: EXTENSION_API_VERSION, loaded: true, worldId: 'fixture-world', label: '夹具 World' });
    expect(records['provider-ok']).toMatchObject({ kind: 'provider', api: EXTENSION_API_VERSION, loaded: true, worldId: 'fixture-provider', label: '夹具端点' });
  });

  it('没有 cortico 块 / 不是 ESM 的包一律不 import,原因说清要改哪里', async () => {
    installFixture(root, 'no-manifest');
    installFixture(root, 'not-esm');
    const { set, records } = await byName();
    expect(set.worlds).toEqual([]);
    expect(records['no-manifest'].kind).toBeUndefined();
    expect(records['no-manifest'].reason).toContain('cortico 块');
    expect(records['not-esm'].reason).toContain('"type": "module"');
  });

  it('默认导出与声明的类别对不上 → 点名声明的是哪一类、缺什么', async () => {
    installFixture(root, 'provider-bad-shape');
    const { set, records } = await byName();
    expect(set.providers).toEqual([]);
    expect(records['provider-bad-shape'].reason)
      .toBe('声明是 provider 类,但默认导出缺 ProviderModule 的 id / title / reasoningTiers / serviceTiers / create()。');
  });
});

describe('bot 包', () => {
  const treeDirOf = (name: string): string => join(root, 'bots', name);

  it('manifest 认 kind: "bot";关键字缺席只是 warning', () => {
    const parsed = parseExtensionManifest({ type: 'module', cortico: { kind: 'bot', api: EXTENSION_API_VERSION } });
    expect(parsed.ok && parsed.manifest.kind).toBe('bot');
    expect(parsed.warnings.join('')).toContain('cortico-bot');
  });

  it('locateBotPackage:仓内有 index.ts 就是仓内包,装了同名扩展也不看', () => {
    installFixture(root, 'bot-ok', { as: 'mine' });
    const tree = treeDirOf('mine');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, 'index.ts'), 'export default {};');
    expect(locateBotPackage(root, 'mine', tree)).toEqual({ source: 'tree', pkgDir: tree, entry: join(tree, 'index.ts') });
  });

  it('locateBotPackage:仓内没有 → extensions/ 下同名的 bot 包,入口按 package.json 解析', () => {
    const pkgDir = installFixture(root, 'bot-ok', { as: 'cortico-bot-x' });
    expect(locateBotPackage(root, 'cortico-bot-x', treeDirOf('cortico-bot-x')))
      .toEqual({ source: 'extension', name: 'cortico-bot-x', pkgDir, entry: join(pkgDir, 'index.js') });
  });

  it('locateBotPackage:两处都没有 → 报错列出两处路径;装了但不是 bot 类 → 说它是哪一类', () => {
    let message = '';
    try { locateBotPackage(root, 'ghost', treeDirOf('ghost')); } catch (e) { message = (e as Error).message; }
    expect(message).toContain(join(treeDirOf('ghost'), 'index.ts'));
    expect(message).toContain(join(root, 'extensions'));
    installFixture(root, 'world-ok');
    expect(() => locateBotPackage(root, 'world-ok', treeDirOf('world-ok'))).toThrow('是 world 类扩展,不是 bot 包');
  });

  it('importBotDefinition:形状不对点名缺什么;id 与仓内 bots/ 目录撞名拒载;合格的原样交回', async () => {
    const bad = installFixture(root, 'bot-ok', { as: 'bad' });
    writeFileSync(join(bad, 'index.js'), 'export default { id: "b" };');
    await expect(importBotDefinition(locateBotPackage(root, 'bad', treeDirOf('bad')), { treeHas: () => false }))
      .rejects.toThrow('BotDefinition 的 id / defaults() / build()');
    installFixture(root, 'bot-ok');
    const location = locateBotPackage(root, 'bot-ok', treeDirOf('bot-ok'));
    await expect(importBotDefinition(location, { treeHas: (id) => id === 'fixture-bot' })).rejects.toThrow('撞名');
    const definition = await importBotDefinition(location, { treeHas: () => false });
    expect(definition.id).toBe('fixture-bot');
    expect(definition.defaults()).toMatchObject({ worlds: {} });
  });

  it('loadExtensions:被引用的 bot 包记 loaded、面板按 persona:<id> 发;其余 bot 包记 idle,入口不 import', async () => {
    installFixture(root, 'bot-with-console');
    const other = installFixture(root, 'bot-ok', { as: 'other-bot' });
    writeFileSync(join(other, 'index.js'), 'throw new Error("must not be imported");');
    const { set, records } = await byName({ activeBot: { name: 'bot-with-console', id: 'fixture-bot-console' } });
    expect(records['bot-with-console']).toMatchObject({ kind: 'bot', api: EXTENSION_API_VERSION, loaded: true, worldId: 'fixture-bot-console', console: 'served' });
    expect(records['other-bot']).toMatchObject({ kind: 'bot', loaded: false, idle: true });
    expect(records['other-bot'].reason).toBeUndefined();
    expect(set.consoleAssets.map((a) => a.pageId)).toEqual(['persona:fixture-bot-console']);
    expect(set.bot).toEqual({ name: 'bot-with-console', id: 'fixture-bot-console' });
  });

  it('loadExtensions:仓内 bot 的部署(没有 activeBot)→ 所有 bot 包 idle,set.bot 缺席', async () => {
    installFixture(root, 'bot-ok');
    const { set, records } = await byName();
    expect(records['bot-ok']).toMatchObject({ kind: 'bot', idle: true, loaded: false });
    expect(set.bot).toBeUndefined();
  });

  it('ExtensionManager:idle 是独立的状态;搜索 bot 类用 cortico-bot 关键字', async () => {
    installFixture(root, 'bot-ok');
    const booted = await loadExtensions(root);
    const urls: string[] = [];
    const mgr = new ExtensionManager(root, booted, { fetchJson: async (url) => { urls.push(url); return { objects: [] }; } });
    expect(mgr.list().extensions.map((e) => e.state)).toEqual(['idle']);
    await mgr.search('', 'bot');
    expect(decodeURIComponent(urls[0])).toContain('keywords:cortico-bot');
  });
});

describe('契约版本', () => {
  it('扩展要的比框架新 → 说框架要升级', async () => {
    installFixture(root, 'api-too-new');
    const { set, records } = await byName();
    expect(set.worlds).toEqual([]);
    expect(records['api-too-new'].reason).toContain(`扩展要求契约 v99,本框架只到 v${EXTENSION_API_VERSION}`);
    expect(records['api-too-new'].reason).toContain('框架需要升级');
  });

  it('反方向(扩展比框架旧)与非正整数各有各的措辞', () => {
    const parse = (api: unknown) => parseExtensionManifest({ type: 'module', cortico: { kind: 'world', api } });
    const old = parse(EXTENSION_API_VERSION - 1);
    expect(old.ok).toBe(false);
    expect((old as { reasons: string[] }).reasons.join('')).toContain('扩展需要升级');
    for (const bad of [0, -1, 1.5, '1', undefined]) {
      const r = parse(bad);
      expect(r.ok).toBe(false);
      expect((r as { reasons: string[] }).reasons.join('')).toContain('必须是正整数');
    }
    expect(parse(EXTENSION_API_VERSION).ok).toBe(true);
  });
});

describe('id 命名空间', () => {
  it('provider 的 id 与内建 provider 撞名 → 不装;worlds 那份保留名管不着它', async () => {
    installFixture(root, 'provider-reserved-id');
    const clash = await byName({ reservedProviders: providerModules.map((m) => m.id) });
    expect(clash.set.providers).toEqual([]);
    expect(clash.records['provider-reserved-id']).toMatchObject({ loaded: false, worldId: 'openai-responses-compat' });
    expect(clash.records['provider-reserved-id'].reason).toContain('provider id「openai-responses-compat」');

    // World 与 provider 的保留名称分别检查。
    const free = await byName({ reserved: ['openai-responses-compat'] });
    expect(free.set.providers.map((p) => p.id)).toEqual(['openai-responses-compat']);
  });

  it('两个 provider 扩展同 id 时先到的赢', async () => {
    installFixture(root, 'provider-ok', { as: 'first' });
    installFixture(root, 'provider-ok', { as: 'second' });
    const { set, records } = await byName();
    expect(set.providers.map((p) => p.id)).toEqual(['fixture-provider']);
    expect(records.first.loaded).toBe(true);
    expect(records.second).toMatchObject({ loaded: false, worldId: 'fixture-provider' });
    expect(records.second.reason).toContain('占用');
  });
});

describe('浏览器端产物', () => {
  it("面板状态：未声明为 none，文件存在为 served，文件缺失为 missing", async () => {
    installFixture(root, 'world-ok');
    installFixture(root, 'world-with-console');
    installFixture(root, 'world-console-missing');
    const { set, records } = await byName();
    expect(records['world-ok']).toMatchObject({ consoleClient: false, console: 'none' });
    expect(records['world-with-console']).toMatchObject({ consoleClient: true, console: 'served' });
    // 缺少面板文件不影响 World 定义加载。
    expect(records['world-console-missing']).toMatchObject({ consoleClient: true, console: 'missing', loaded: true });
    expect(set.consoleAssets.map((a) => a.pageId)).toEqual(['world:with-console']);
  });

  it('asset 的 pageId 按 kind 取前缀,文件是绝对路径,URL 由服务端按包名与版本分配', async () => {
    installFixture(root, 'world-with-console');
    installFixture(root, 'provider-with-console');
    const { set } = await byName();
    expect(set.consoleAssets).toEqual([
      {
        pageId: 'world:with-console',
        packageName: 'world-with-console',
        version: '3.1.0',
        jsFile: join(root, 'extensions/node_modules/world-with-console/dist/console.js'),
        cssFile: join(root, 'extensions/node_modules/world-with-console/dist/console.css'),
      },
      {
        pageId: 'llm:panelled',
        packageName: 'provider-with-console',
        version: '0.4.2',
        jsFile: join(root, 'extensions/node_modules/provider-with-console/dist/panel.js'),
      },
    ]);
    const asset = set.consoleAssets[0];
    expect(extensionAssetUrl(asset.packageName, asset.version, 'console.js'))
      .toBe(`${EXTENSION_ASSET_PREFIX}world-with-console/3.1.0/console.js`);
  });

  it("缺少样式文件不将面板标为 missing，也不影响 World 定义加载", async () => {
    const pkgDir = installFixture(root, 'world-with-console');
    rmSync(join(pkgDir, 'dist/console.css'));
    const { set, records } = await byName();
    expect(records['world-with-console']).toMatchObject({ console: 'served', loaded: true });
    expect(set.consoleAssets[0].cssFile).toBeUndefined();
  });

  it('加载失败的包不进 asset 表', async () => {
    const pkgDir = installFixture(root, 'world-with-console');
    writeFileSync(join(pkgDir, 'index.js'), 'export default { id: "x" };');
    const { set } = await byName();
    expect(set.consoleAssets).toEqual([]);
  });
});

describe("ExtensionManager 安装与加载状态", () => {
  const manager = (booted: Awaited<ReturnType<typeof loadExtensions>>) =>
    new ExtensionManager(root, booted, { run: async () => ({ code: 0, output: '' }), fetchJson: async () => ({}) });

  it('consoleAssets() 给出启动时那一份;list() 带上 kind / api / 面板状态', async () => {
    installFixture(root, 'world-with-console');
    const booted = await loadExtensions(root);
    // 新装包只报告 manifest，产物状态在下一次加载时检查。
    installFixture(root, 'provider-ok');
    const mgr = manager(booted);
    expect(mgr.consoleAssets()).toBe(booted.consoleAssets);
    const extensions = Object.fromEntries(mgr.list().extensions.map((p) => [p.name, p]));
    expect(extensions['world-with-console']).toMatchObject({ state: 'loaded', kind: 'world', api: EXTENSION_API_VERSION, console: 'served' });
    expect(extensions['provider-ok']).toMatchObject({ state: 'pending-restart', kind: 'provider', api: EXTENSION_API_VERSION, console: 'none' });
  });
});

describe('registerProviderModules', () => {
  const late: ProviderModule = {
    id: 'fixture-late', title: '后到的', reasoningTiers: [], serviceTiers: [],
    create: () => ({ client: null as never }),
  };

  it('就地追加进同一张表:注册之前构造的 registry 也能路由到它;重复 id 抛错', () => {
    const registry = new ProviderRegistry(
      () => ({ later: { kind: 'fixture-late', baseUrl: 'https://late.test' } }),
      { stateRoot: join(root, 'providers'), readBlob: () => null, keepThinking: () => true, log: nullLogger() },
    );
    expect(() => registry.resolve('later')).toThrow('Unknown provider module');

    registerProviderModules([late]);
    expect(providerModule('fixture-late')).toBe(late);
    expect(providerModules).toContain(late);
    expect(registry.resolve('later')).toBeTruthy();

    expect(() => registerProviderModules([late])).toThrow('fixture-late');
    expect(() => registerProviderModules([{ ...late, id: 'openai-responses-compat' }])).toThrow('已被占用');
  });
});
