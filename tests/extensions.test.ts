/**
 * 扩展层:`extensions/` 下的包按 package.json 逐个真 import,失败只废自己那一格;
 * 并进 bot 定义时补 `worlds` 默认值。装卸经 pnpm——这里只验它收到的命令行与磁盘对账,
 * pnpm 本体不跑(那要联网)。
 *
 * 按 kind 分派、契约版本、provider 形状与浏览器端产物在 tests/extensions-manifest.test.ts;
 * 扩展 import 框架的那条解析线在 tests/extensions-runtime.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionManager, loadExtensions, readInstalled, type ExtensionSet } from '../src/extensions.ts';
import { EXTENSION_API_VERSION } from '../src/extensions/manifest.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'extensions-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const definitionSource = (id: string): string =>
  `export default { id: ${JSON.stringify(id)}, label: ${JSON.stringify(`${id} 扩展`)}, `
  + `defaults: () => ({ enabled: false, port: 7 }), `
  + `create: () => ({ id: ${JSON.stringify(id)}, envPromptVars: () => ({}), tools: () => [], start: async () => {}, stop: async () => {} }) };`;

/** 往 extensions/ 里"装"一个包:写进 package.json 的 dependencies,并在 node_modules 下放上文件。 */
function installFake(name: string, opts: {
  spec?: string; body?: string; pkg?: Record<string, unknown>; noFiles?: boolean;
} = {}): void {
  const dir = join(root, 'extensions');
  mkdirSync(dir, { recursive: true });
  const pkgFile = join(dir, 'package.json');
  const pkg: { name?: string; private?: boolean; dependencies: Record<string, string> } = existsSync(pkgFile)
    ? JSON.parse(readFileSync(pkgFile, 'utf8')) as { dependencies: Record<string, string> }
    : { name: 'cortico-extensions', private: true, dependencies: {} };
  pkg.dependencies[name] = opts.spec ?? '^1.0.0';
  writeFileSync(pkgFile, JSON.stringify(pkg));
  if (opts.noFiles) return;
  const pkgDir = join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name, version: '1.2.3', type: 'module', main: './index.js',
    keywords: ['cortico-world'], cortico: { kind: 'world', api: EXTENSION_API_VERSION },
    ...(opts.pkg ?? {}),
  }));
  writeFileSync(join(pkgDir, 'index.js'), opts.body ?? definitionSource('x'));
}

describe('loadExtensions', () => {
  it('extensions/ 不存在 → 空集,不报错', async () => {
    const set = await loadExtensions(root);
    expect(set.records).toEqual([]);
    expect(set.worlds).toEqual([]);
    expect(set.providers).toEqual([]);
    expect(set.consoleAssets).toEqual([]);
    expect(set.dir).toBe(join(root, 'extensions'));
  });

  it('合法的包加载成 World 定义;记录带版本、 World id 与显示名', async () => {
    installFake('@acme/cortico-world-alpha', { body: definitionSource('alpha'), pkg: { description: '甲' } });
    const set = await loadExtensions(root);
    expect(set.worlds.map((m) => m.id)).toEqual(['alpha']);
    expect(set.records).toEqual([{
      name: '@acme/cortico-world-alpha', spec: '^1.0.0', version: '1.2.3', description: '甲',
      kind: 'world', api: EXTENSION_API_VERSION, consoleClient: false, console: 'none',
      loaded: true, worldId: 'alpha', label: 'alpha 扩展',
    }]);
    // 定义是活的:defaults / create 都能调
    expect(set.worlds[0].defaults()).toEqual({ enabled: false, port: 7 });
    expect(set.worlds[0].create({} as never).id).toBe('alpha');
  });

  it('形状不对 / 目录缺失 / 导入抛错各自留 reason,其它包照常', async () => {
    installFake('bad-shape', { body: 'export default { id: "b" };' });
    installFake('gone', { noFiles: true });
    installFake('throws', { body: 'throw new Error("boom at import");' });
    installFake('good', { body: definitionSource('good') });
    const set = await loadExtensions(root);
    expect(set.worlds.map((m) => m.id)).toEqual(['good']);
    const byName = Object.fromEntries(set.records.map((r) => [r.name, r]));
    expect(byName['bad-shape']).toMatchObject({ loaded: false, reason: expect.stringContaining('WorldDefinition') });
    expect(byName.gone).toMatchObject({ loaded: false, version: null, reason: expect.stringContaining('node_modules') });
    expect(byName.throws).toMatchObject({ loaded: false, reason: expect.stringContaining('boom at import') });
    expect(byName.good.loaded).toBe(true);
  });

  it('与内建同 id 的扩展不装;两个扩展同 id 先到的赢', async () => {
    installFake('clash-builtin', { body: definitionSource('terminal-like') });
    installFake('first', { body: definitionSource('dup') });
    installFake('second', { body: definitionSource('dup') });
    const set = await loadExtensions(root, { reserved: ['terminal-like'] });
    expect(set.worlds.map((m) => m.id)).toEqual(['dup']);
    const byName = Object.fromEntries(set.records.map((r) => [r.name, r]));
    expect(byName['clash-builtin']).toMatchObject({ loaded: false, worldId: 'terminal-like', reason: expect.stringContaining('占用') });
    expect(byName.first.loaded).toBe(true);
    expect(byName.second).toMatchObject({ loaded: false, worldId: 'dup' });
  });

  it('入口按 exports(字符串 / "." 的 import)解析;cortico.consoleClient 标出来', async () => {
    installFake('exp-str', { pkg: { main: undefined, exports: './entry.js' }, body: 'nope' });
    writeFileSync(join(root, 'extensions/node_modules/exp-str/entry.js'), definitionSource('es'));
    installFake('exp-obj', {
      pkg: {
        main: undefined,
        exports: { '.': { import: './esm.js', require: './cjs.js' } },
        cortico: { kind: 'world', api: EXTENSION_API_VERSION, consoleClient: 'dist/client.js' },
      },
      body: 'nope',
    });
    writeFileSync(join(root, 'extensions/node_modules/exp-obj/esm.js'), definitionSource('eo'));
    const set = await loadExtensions(root);
    expect(set.worlds.map((m) => m.id)).toEqual(['es', 'eo']);
    expect(set.records.find((r) => r.name === 'exp-obj')?.consoleClient).toBe(true);
    expect(set.records.find((r) => r.name === 'exp-str')?.consoleClient).toBe(false);
  });
});

describe('ExtensionManager', () => {
  interface Run { args: string[]; cwd: string }
  function manager(booted: Partial<ExtensionSet> = {}, opts: { code?: number; hang?: boolean } = {}) {
    const runs: Run[] = [];
    let release: (() => void) | null = null;
    const urls: string[] = [];
    const set: ExtensionSet = {
      dir: join(root, 'extensions'), records: [], worlds: [], providers: [], consoleAssets: [], ...booted,
    };
    const mgr = new ExtensionManager(root, set, {
      run: (args, cwd) => {
        runs.push({ args, cwd });
        if (opts.hang) return new Promise((r) => { release = () => r({ code: 0, output: '' }); });
        return Promise.resolve({ code: opts.code ?? 0, output: 'Progress: resolved 1\n+ pkg 1.0.0\nDone in 1s' });
      },
      fetchJson: async (url) => {
        urls.push(url);
        return {
          objects: [
            { package: { name: 'a-mod', version: '1.0.0', description: 'A', keywords: ['cortico-world'], links: { npm: 'https://npm/a', repository: 'https://git/a' }, publisher: { username: 'me' } }, downloads: { monthly: 12 } },
            { package: { name: 'a-prov', version: '3.0.0', description: 'P', keywords: ['cortico-provider'] }, downloads: { monthly: 3 } },
            { package: { name: 'not-a-mod', version: '2.0.0', description: 'N', keywords: ['other'] }, downloads: { monthly: 999 } },
          ],
        };
      },
    });
    return { mgr, runs, urls, release: () => release?.() };
  }

  it('install:合法包名 → pnpm add name@version --ignore-workspace,在 extensions/ 里跑;首次先造 package.json', async () => {
    const { mgr, runs } = manager();
    const msg = await mgr.install({ name: '@acme/cortico-world-x', version: '^1.2.0' });
    expect(runs).toEqual([{ args: ['add', '@acme/cortico-world-x@^1.2.0', '--ignore-workspace'], cwd: join(root, 'extensions') }]);
    expect(JSON.parse(readFileSync(join(root, 'extensions/package.json'), 'utf8'))).toMatchObject({ private: true, dependencies: {} });
    expect(msg).toContain('重启');
    expect(msg).toContain('Done in 1s');
    await mgr.install({ name: 'plain' });
    expect(runs[1].args).toEqual(['add', 'plain', '--ignore-workspace']);
  });

  it('install:本机目录必须存在且含 package.json,按绝对路径交给 pnpm', async () => {
    const { mgr, runs } = manager();
    await expect(mgr.install({ path: './nowhere' })).rejects.toThrow('目录不存在');
    mkdirSync(join(root, 'empty'));
    await expect(mgr.install({ path: './empty' })).rejects.toThrow('package.json');
    mkdirSync(join(root, 'my mod'));
    writeFileSync(join(root, 'my mod/package.json'), '{}');
    await mgr.install({ path: './my mod' });
    expect(runs[0].args).toEqual(['add', join(root, 'my mod'), '--ignore-workspace']);
  });

  it('install:拒绝带 shell 元字符的包名、版本与路径,一次 pnpm 都不起', async () => {
    const { mgr, runs } = manager();
    for (const name of ['a b', 'x;rm -rf /', 'Upper', '../escape', '$(id)']) {
      await expect(mgr.install({ name })).rejects.toThrow('包名');
    }
    for (const version of ['1.0 || 2.0', '>=1.0.0', '1.0"', '%PATH%']) {
      await expect(mgr.install({ name: 'ok', version })).rejects.toThrow('版本');
    }
    await expect(mgr.install({ path: './a"b' })).rejects.toThrow('字符');
    expect(runs).toEqual([]);
  });

  it('install:pnpm 非零退出 → 抛错带输出尾部', async () => {
    const { mgr } = manager({}, { code: 1 });
    await expect(mgr.install({ name: 'x' })).rejects.toThrow('退出码 1');
  });

  it('装卸串行:前一个没回来时第二个直接拒绝', async () => {
    const { mgr, runs, release } = manager({}, { hang: true });
    const first = mgr.install({ name: 'x' });
    await expect(mgr.install({ name: 'y' })).rejects.toThrow('在进行');
    release();
    await first;
    expect(runs.map((r) => r.args[1])).toEqual(['x']);
  });

  it('uninstall:没装的包拒绝;装了的 → pnpm remove', async () => {
    installFake('present');
    const { mgr, runs } = manager();
    await expect(mgr.uninstall('absent')).rejects.toThrow('没有安装');
    await expect(mgr.uninstall('bad name')).rejects.toThrow('包名');
    const msg = await mgr.uninstall('present');
    expect(runs).toEqual([{ args: ['remove', 'present', '--ignore-workspace'], cwd: join(root, 'extensions') }]);
    expect(msg).toContain('重启');
  });

  it('list:启动时的记录对照此刻磁盘——新装的 pending-restart,卸了的 removed,换版本的 pending-restart', async () => {
    installFake('kept', { body: definitionSource('kept') });
    installFake('bumped', { body: definitionSource('bumped') });
    installFake('gone-later', { body: definitionSource('gl') });
    installFake('broken', { body: 'export default 1;' });
    const booted = await loadExtensions(root);
    // 启动之后磁盘变了:换版本、卸掉、新装
    installFake('bumped', { spec: '^2.0.0', body: definitionSource('bumped') });
    const pkgFile = join(root, 'extensions/package.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { dependencies: Record<string, string> };
    delete pkg.dependencies['gone-later'];
    writeFileSync(pkgFile, JSON.stringify(pkg));
    installFake('fresh', { body: definitionSource('fresh'), pkg: { description: '新来的' } });

    const { mgr } = manager(booted);
    const { dir, extensions } = mgr.list();
    expect(dir).toBe(join(root, 'extensions'));
    const state = Object.fromEntries(extensions.map((p) => [p.name, p.state]));
    expect(state).toEqual({
      kept: 'loaded', bumped: 'pending-restart', 'gone-later': 'removed', broken: 'failed', fresh: 'pending-restart',
    });
    expect(extensions.find((p) => p.name === 'fresh')).toMatchObject({ version: '1.2.3', description: '新来的', loaded: false });
    expect(extensions.find((p) => p.name === 'broken')?.reason).toContain('WorldDefinition');
  });

  it('search:关键字按 kind 换,只留带那个关键字的包,标出已安装', async () => {
    installFake('a-mod');
    const { mgr, urls } = manager();
    expect(await mgr.search('anything')).toEqual([{
      name: 'a-mod', version: '1.0.0', description: 'A', publisher: 'me', downloads: 12, kind: 'world',
      links: { npm: 'https://npm/a', repository: 'https://git/a' }, installed: true,
    }]);
    expect(await mgr.search('anything', 'provider')).toEqual([{
      name: 'a-prov', version: '3.0.0', description: 'P', downloads: 3, kind: 'provider',
      links: {}, installed: false,
    }]);
    expect(urls.map((u) => decodeURIComponent(u).match(/keywords:[a-z-]+/)?.[0])).toEqual([
      'keywords:cortico-world', 'keywords:cortico-provider',
    ]);
  });

  it('readInstalled:没有 extensions/ 或没有 dependencies 都是空表', () => {
    expect(readInstalled(join(root, 'extensions'))).toEqual([]);
    mkdirSync(join(root, 'extensions'));
    writeFileSync(join(root, 'extensions/package.json'), '{"name":"x"}');
    expect(readInstalled(join(root, 'extensions'))).toEqual([]);
  });
});
