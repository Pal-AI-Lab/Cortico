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
import { ExtensionManager, loadExtensions, readInstalled, repositoryWebUrl, type ExtensionSet } from '../src/extensions.ts';
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
  function manager(booted: Partial<ExtensionSet> = {}, opts: { code?: number; hang?: boolean; packument?: unknown } = {}) {
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
        if (opts.packument) return opts.packument;
        return {
          objects: [
            { package: { name: 'a-mod', version: '1.0.0', description: 'A', keywords: ['cortico-world'], license: 'MIT', links: { npm: 'https://npm/a', repository: 'git+https://github.com/me/a.git' }, publisher: { username: 'me' } }, downloads: { monthly: 12 }, dependents: '7' },
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
    expect(await mgr.search()).toEqual([{
      name: 'a-mod', version: '1.0.0', description: 'A', publisher: 'me', license: 'MIT',
      downloads: 12, dependents: 7, keywords: ['cortico-world'], kind: 'world',
      // git+https 的仓库地址收成能点的 https
      links: { npm: 'https://npm/a', repository: 'https://github.com/me/a' }, installed: true,
    }]);
    expect(await mgr.search('provider')).toEqual([{
      name: 'a-prov', version: '3.0.0', description: 'P', downloads: 3, dependents: 0, kind: 'provider',
      keywords: ['cortico-provider'], links: {}, installed: false,
    }]);
    expect(urls.map((u) => decodeURIComponent(u).match(/keywords:[a-z-]+/)?.[0])).toEqual([
      'keywords:cortico-world', 'keywords:cortico-provider',
    ]);
    // 一页没取满就不翻下一页
    expect(urls[0]).toContain('size=250&from=0');
  });

  it('search:一页取满就接着翻,同名包只留一条,翻到上限为止', () => {
    const full = {
      objects: Array.from({ length: 250 }, (_, i) => ({
        package: { name: `w-${i}`, version: '1.0.0', keywords: ['cortico-world'] },
        downloads: { monthly: 0 },
      })),
    };
    const urls: string[] = [];
    const set: ExtensionSet = { dir: join(root, 'extensions'), records: [], worlds: [], providers: [], consoleAssets: [] };
    const mgr = new ExtensionManager(root, set, {
      run: async () => ({ code: 0, output: '' }),
      // 每页都满:只有条数上限能让它停
      fetchJson: async (url) => { urls.push(url); return full; },
    });
    return mgr.search().then((hits) => {
      expect(urls.map((u) => u.match(/from=\d+/)?.[0])).toEqual(['from=0', 'from=250', 'from=500', 'from=750']);
      // 每页是同一批名字:去重之后只剩一页
      expect(hits).toHaveLength(250);
    });
  });

  it('packageInfo:latest 版本的 cortico 块按本机同一套判据解析,已安装的带上版本范围', async () => {
    installFake('a-mod');
    const version = {
      name: 'a-mod', version: '2.0.0', type: 'module', main: './index.js', license: 'MIT',
      keywords: ['cortico-world'], cortico: { kind: 'world', api: EXTENSION_API_VERSION, consoleClient: 'dist/console.js' },
      engines: { node: '>=22' }, dependencies: { ws: '^8' }, dist: { unpackedSize: 2048, fileCount: 9 },
      maintainers: [{ username: 'me' }], _npmUser: { name: 'me' },
      repository: { url: 'git+ssh://git@github.com/me/a-mod.git' }, homepage: 'https://example.invalid',
    };
    const { mgr, urls } = manager({}, {
      packument: {
        'dist-tags': { latest: '2.0.0' },
        versions: { '1.0.0': { ...version, version: '1.0.0' }, '2.0.0': version },
        time: {
          created: '2026-01-01T00:00:00.000Z', modified: '2026-03-03T00:00:00.000Z',
          '1.0.0': '2026-01-01T00:00:00.000Z', '2.0.0': '2026-03-02T00:00:00.000Z',
        },
      },
    });
    const info = await mgr.packageInfo('a-mod');
    expect(urls[0]).toBe('https://registry.npmjs.org/a-mod');
    expect(info).toMatchObject({
      name: 'a-mod', version: '2.0.0', license: 'MIT', published: '2026-03-02T00:00:00.000Z',
      created: '2026-01-01T00:00:00.000Z', versionCount: 2,
      manifest: { kind: 'world', api: EXTENSION_API_VERSION, consoleClient: 'dist/console.js' },
      frameworkApi: EXTENSION_API_VERSION, engines: '>=22', unpackedSize: 2048, fileCount: 9,
      dependencies: ['ws'], maintainers: ['me'], installed: true, installedSpec: '^1.0.0',
      links: { npm: 'https://www.npmjs.com/package/a-mod', repository: 'https://github.com/me/a-mod', homepage: 'https://example.invalid' },
    });
    // 新的在前
    expect(info.history.map((h) => h.version)).toEqual(['2.0.0', '1.0.0']);
    expect(info.problems).toBeUndefined();
  });

  it('packageInfo:装不上的包给出理由;包名不合法与没有 latest 各自抛错', async () => {
    const { mgr } = manager({}, {
      packument: {
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name: 'b', version: '1.0.0', keywords: [], cortico: { kind: 'world', api: 99 } } },
        time: { '1.0.0': '2026-02-02T00:00:00.000Z' },
      },
    });
    const info = await mgr.packageInfo('b');
    expect(info.manifest).toBeUndefined();
    expect(info.problems?.join(' ')).toContain('type');
    expect(info.problems?.join(' ')).toContain('v99');
    await expect(mgr.packageInfo('Bad Name')).rejects.toThrow('包名');
    const { mgr: empty } = manager({}, { packument: { 'dist-tags': {}, versions: {} } });
    await expect(empty.packageInfo('c')).rejects.toThrow('latest');
  });

  it('repositoryWebUrl:npm 那几种写法都收成 https,认不出的原样退回', () => {
    expect(repositoryWebUrl('git+https://github.com/me/a.git')).toBe('https://github.com/me/a');
    expect(repositoryWebUrl('git://github.com/me/a.git')).toBe('https://github.com/me/a');
    expect(repositoryWebUrl('git+ssh://git@github.com/me/a.git')).toBe('https://github.com/me/a');
    expect(repositoryWebUrl('git@gitlab.com:me/a.git')).toBe('https://gitlab.com/me/a');
    expect(repositoryWebUrl('https://example.invalid/me/a')).toBe('https://example.invalid/me/a');
    expect(repositoryWebUrl('me/a')).toBe('me/a');
  });

  it('readInstalled:没有 extensions/ 或没有 dependencies 都是空表', () => {
    expect(readInstalled(join(root, 'extensions'))).toEqual([]);
    mkdirSync(join(root, 'extensions'));
    writeFileSync(join(root, 'extensions/package.json'), '{"name":"x"}');
    expect(readInstalled(join(root, 'extensions'))).toEqual([]);
  });
});
