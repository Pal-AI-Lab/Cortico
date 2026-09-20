/**
 * 扩展的浏览器端产物:URL 由服务端分配,文件逐个发。
 *
 * 用真的临时目录放真的 js/css,验证三件事:manifest 里那一页拿到的是
 * `/assets/extensions/…`;那条 URL 能取到字节且按 immutable 缓存;URL 里的三段只是
 * 查表用的键,拿它拼不出别的文件。dist 与扩展撞 key 时仓库内的页赢。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp, type WebAppDeps, type WebAppExtensionDeps } from '../../src/web/server.ts';
import { ConsoleAssets, type ConsolePageSource } from '../../src/web/console-pages.ts';
import type { Logger } from '../../src/core/types.ts';
import type { ConsoleManifest } from '../../src/web/shared/console-protocol.ts';
import { extensionAssetUrl, type ExtensionConsoleAsset } from '../../src/extensions/manifest.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';

const PKG = '@acme/cortico-world-demo';
const VERSION = '1.2.3';
const JS_BODY = 'export function mount(){ return "demo panel"; }\n';
const CSS_BODY = '.demo-panel { color: rebeccapurple; }\n';

let dir: string;
/** 扩展包里的 dist 目录:三个文件,只有前两个进产物表。 */
let pkgDist: string;
/** "没构建过"的 dist/web:不让测试撞上仓库里真实的产物。 */
let emptyDist: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-extensions-assets-'));
  emptyDist = join(dir, 'no-dist');
  pkgDist = join(dir, 'pkg-dist');
  mkdirSync(emptyDist, { recursive: true });
  mkdirSync(pkgDist, { recursive: true });
  writeFileSync(join(pkgDist, 'console.js'), JS_BODY, 'utf8');
  writeFileSync(join(pkgDist, 'console.css'), CSS_BODY, 'utf8');
  // 同目录下的第三个文件:产物表里没有它,于是 URL 也取不到它
  writeFileSync(join(pkgDist, 'secret.js'), 'const token = "hunter2";\n', 'utf8');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 产物表里那一条。`pkgDist` 在 beforeAll 里才有值,所以按需算。 */
const asset = (): ExtensionConsoleAsset => ({
  pageId: 'world:demo',
  packageName: PKG,
  version: VERSION,
  jsFile: join(pkgDist, 'console.js'),
  cssFile: join(pkgDist, 'console.css'),
});

const extensionDeps = (assets: readonly ExtensionConsoleAsset[]): WebAppExtensionDeps => ({
  list: () => ({ dir: '/repo/extensions', extensions: [] }),
  search: async () => [],
  packageInfo: async () => { throw new Error('这个用例不取包详情'); },
  consoleAssets: () => assets,
  install: async () => '',
  uninstall: async () => '',
});

const soleSource = (): ConsolePageSource[] => [
  { id: 'world:demo', contribute: () => ({ id: 'world:demo', kind: 'world' as const, label: '样例 World' }) },
];

async function withApp(extra: Partial<WebAppDeps>, fn: (base: string) => Promise<void>): Promise<void> {
  const app = new WebApp({
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    webDistDir: emptyDist,
    getStatus: () => ({}),
    consolePageSources: soleSource,
    log: nullLogger(),
    ...extra,
  });
  const port = await app.start(0);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await app.stop();
  }
}

const clientOf = async (base: string): Promise<{ js: string; css?: string } | undefined> => {
  const m = (await (await fetch(`${base}/api/console/manifest`)).json()) as ConsoleManifest;
  return m.providers.find((p) => p.id === 'world:demo')?.client;
};

describe('扩展产物的 URL 分配', () => {
  it('manifest 里那一页的 client 是服务端分配的 /assets/extensions/ 路径', async () => {
    await withApp({ extensions: extensionDeps([asset()]) }, async (base) => {
      expect(await clientOf(base)).toEqual({
        js: '/assets/extensions/acme__cortico-world-demo/1.2.3/console.js',
        css: '/assets/extensions/acme__cortico-world-demo/1.2.3/console.css',
      });
    });
  });

  it('那两条 URL 取回的就是包里的字节,且按 immutable 缓存', async () => {
    await withApp({ extensions: extensionDeps([asset()]) }, async (base) => {
      const js = await fetch(`${base}${extensionAssetUrl(PKG, VERSION, 'console.js')}`);
      expect(js.status).toBe(200);
      expect(await js.text()).toBe(JS_BODY);
      expect(js.headers.get('content-type')).toContain('javascript');
      expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

      const css = await fetch(`${base}${extensionAssetUrl(PKG, VERSION, 'console.css')}`);
      expect(css.status).toBe(200);
      expect(await css.text()).toBe(CSS_BODY);
      expect(css.headers.get('content-type')).toContain('text/css');
    });
  });

  /** URL 的三段是查表的键,不是路径片段——拼不出产物表以外的任何文件。 */
  it('同目录下没上表的文件、回溯写法、错版本、错包名一律 404', async () => {
    await withApp({ extensions: extensionDeps([asset()]) }, async (base) => {
      const cases = [
        ['同目录另一个文件', '/assets/extensions/acme__cortico-world-demo/1.2.3/secret.js'],
        ['编码回溯', '/assets/extensions/acme__cortico-world-demo/1.2.3/%2e%2e%2fsecret.js'],
        ['包名段回溯', '/assets/extensions/%2e%2e/1.2.3/console.js'],
        ['版本段回溯', '/assets/extensions/acme__cortico-world-demo/%2e%2e/console.js'],
        ['错版本', '/assets/extensions/acme__cortico-world-demo/9.9.9/console.js'],
        ['未规整的包名', '/assets/extensions/@acme/cortico-world-demo/1.2.3/console.js'],
      ];
      for (const [name, path] of cases) {
        const r = await fetch(`${base}${path}`);
        expect([name, r.status]).toEqual([name, 404]);
      }
    });
  });

  it('没有扩展产物时那一页照常在 manifest 里,只是没有 client', async () => {
    await withApp({ extensions: extensionDeps([]) }, async (base) => {
      expect(await clientOf(base)).toBeUndefined();
      expect((await fetch(`${base}${extensionAssetUrl(PKG, VERSION, 'console.js')}`)).status).toBe(404);
    });
  });

  /**
   * 分配出来的 URL 仍要过 `isSafeAssetUrl`。规整后的段只剩 `[A-Za-z0-9._-]`,
   * 于是唯一还能出事的写法是规整成空段(URL 里出现 `//`)——照样一条也不放行。
   */
  it('分配不出合法 /assets/ 路径的产物被拒,并记一条 error', () => {
    const errors: string[] = [];
    const log = { error: (msg: string) => { errors.push(msg); } } as unknown as Logger;
    const assets = new ConsoleAssets(emptyDist, log, [
      { pageId: 'world:noname', packageName: '@', version: VERSION, jsFile: join(pkgDist, 'console.js') },
      { pageId: 'world:nover', packageName: PKG, version: '', jsFile: join(pkgDist, 'console.js') },
      { pageId: 'world:ok', packageName: PKG, version: VERSION, jsFile: join(pkgDist, 'console.js') },
    ]);
    expect(assets.forPage('world:noname')).toBeUndefined();
    expect(assets.forPage('world:nover')).toBeUndefined();
    expect(assets.forPage('world:ok')).toEqual({ js: extensionAssetUrl(PKG, VERSION, 'console.js') });
    expect(errors.length).toBe(2);
  });

  /** 扩展换不掉自带面板:同一个 page id 上,dist 清单里的那条赢。 */
  it('dist 清单里有同 key 时用 dist 的,扩展产物不上 manifest', async () => {
    const webDistDir = join(dir, 'dist-collide');
    mkdirSync(webDistDir, { recursive: true });
    writeFileSync(
      join(webDistDir, 'asset-manifest.json'),
      JSON.stringify({
        protocolVersion: 1,
        core: '/assets/console.js',
        providers: { 'world:demo': { js: '/assets/worlds/demo/client.a1b2.js' } },
      }),
      'utf8',
    );
    await withApp({ extensions: extensionDeps([asset()]), webDistDir }, async (base) => {
      expect(await clientOf(base)).toEqual({ js: '/assets/worlds/demo/client.a1b2.js' });
      // 路由与 manifest 是两件事:文件照发,只是没有一页引用它
      expect((await fetch(`${base}${extensionAssetUrl(PKG, VERSION, 'console.js')}`)).status).toBe(200);
    });
  });
});
