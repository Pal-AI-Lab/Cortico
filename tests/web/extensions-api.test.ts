/** 扩展管理接口覆盖 World、provider 与 bot 包。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp, type ExtensionInstallTarget } from '../../src/web/server.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';

let app: WebApp;
let port: number;
let dir: string;
const installed: ExtensionInstallTarget[] = [];
const uninstalled: string[] = [];
let searched: Array<{ kind?: string }> = [];
const asked: string[] = [];

const base = () => `http://127.0.0.1:${port}`;
const get = async (path: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base()}${path}`);
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-extensions-'));
  app = new WebApp({
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    getStatus: () => ({}),
    extensions: {
      check: async () => { throw new Error('incompatible extension'); },
      perform: async (id, action) => ({ id, action, target: 'example', phase: 'rolled-back', error: 'invalid export' }),
      operation: id => ({ id, action: 'install', target: 'example', phase: 'committed', name: 'example', version: '1.0.0' }),
      activation: async () => { throw new Error('module in use'); },
      list: () => ({
        dir: '/repo/extensions',
        extensions: [{ name: 'a', spec: '^1', version: '1.0.0', consoleClient: false, loaded: true, worldId: 'a', label: 'A', state: 'loaded' }],
      }),
      search: async (kind) => {
        searched.push({ ...(kind ? { kind } : {}) });
        return [{ name: 'hit', version: '1.0.0', description: 'd', downloads: 1, dependents: 0, links: {}, installed: false, ...(kind ? { kind } : {}) }];
      },
      updates: async () => ({ updates: [{ name: 'a', installedVersion: '1.0.0', latestVersion: '1.1.0', problems: [] }], errors: [] }),
      packageInfo: async (name) => {
        asked.push(name);
        if (name === 'bad name') throw new Error('不是合法的 npm 包名: bad name');
        if (name === 'gone') throw new Error('registry 没有给出 gone 的 latest 版本');
        return {
          name, version: '1.0.0', versionCount: 1, history: [], warnings: [], frameworkApi: 4,
          dependencies: [], maintainers: [], links: { npm: `https://www.npmjs.com/package/${name}` }, installed: false,
        };
      },
      install: async (target) => {
        if ('name' in target && target.name === 'boom') throw new Error('不是合法的 npm 包名: boom');
        installed.push(target);
        return '已安装';
      },
      uninstall: async (name) => { uninstalled.push(name); return '已卸载'; },
    },
    log: nullLogger(),
  });
  port = await app.start(0);
});

afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('/api/extensions', () => {
  it('清单原样转交', async () => {
    const r = await get('/api/extensions');
    expect(r.status).toBe(200);
    expect(r.body.dir).toBe('/repo/extensions');
    expect(r.body.extensions[0]).toMatchObject({ name: 'a', state: 'loaded' });
  });

  it('更新查询返回可用版本', async () => {
    const r = await get('/api/extensions/updates');
    expect(r.status).toBe(200);
    expect(r.body.updates).toMatchObject([{ name: 'a', latestVersion: '1.1.0' }]);
  });

  it('搜索列出一整类,回 { hits }', async () => {
    searched = [];
    const r = await get('/api/extensions/search');
    expect(r.status).toBe(200);
    expect(searched).toEqual([{}]);
    expect(r.body.hits[0].name).toBe('hit');
  });

  it('kind 原样透传;不给等于不限定;只认 worlds / provider,别的 400 且不打依赖', async () => {
    searched = [];
    const worlds = await get('/api/extensions/search?kind=world');
    expect(worlds.status).toBe(200);
    expect(worlds.body.hits[0].kind).toBe('world');
    await get('/api/extensions/search?kind=provider');
    expect(searched).toEqual([{ kind: 'world' }, { kind: 'provider' }]);
    const bad = await get('/api/extensions/search?kind=persona');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('persona');
    // 空串当没给:前端拼 URL 时少一个值不该变成一次 400
    expect((await get('/api/extensions/search?kind=')).status).toBe(200);
    expect(searched.length).toBe(3);
  });

  it('包详情:name 必给;包名不合法 400,registry 那头的失败 502', async () => {
    asked.length = 0;
    const ok = await get('/api/extensions/package?name=%40acme%2Fcortico-world-x');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: '@acme/cortico-world-x', frameworkApi: 4 });
    expect(asked).toEqual(['@acme/cortico-world-x']);
    expect((await get('/api/extensions/package')).status).toBe(400);
    expect((await get('/api/extensions/package?name=%20')).status).toBe(400);
    expect((await get('/api/extensions/package?name=bad%20name')).status).toBe(400);
    const upstream = await get('/api/extensions/package?name=gone');
    expect(upstream.status).toBe(502);
    expect(upstream.body.error).toContain('latest');
  });

  it('安装:name(+version)与 path 两种载荷;缺参 400;依赖拒绝 → 400 带原话', async () => {
    installed.length = 0;
    expect((await post('/api/extensions/install', { name: 'x', version: '^1' })).body).toMatchObject({ ok: true, restartRequired: true });
    expect((await post('/api/extensions/install', { name: 'y' })).status).toBe(200);
    expect((await post('/api/extensions/install', { path: '../mod' })).status).toBe(200);
    expect(installed).toEqual([{ name: 'x', version: '^1' }, { name: 'y' }, { path: '../mod' }]);
    expect((await post('/api/extensions/install', {})).status).toBe(400);
    expect((await post('/api/extensions/install', { name: '   ' })).status).toBe(400);
    const bad = await post('/api/extensions/install', { name: 'boom' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('boom');
  });

  it('卸载:{ name };缺参 400', async () => {
    uninstalled.length = 0;
    expect((await post('/api/extensions/uninstall', { name: 'a' })).body).toMatchObject({ ok: true, restartRequired: true });
    expect(uninstalled).toEqual(['a']);
    expect((await post('/api/extensions/uninstall', {})).status).toBe(400);
  });

  it('能力位 extensions 跟着依赖走;没挂时四个端点都 503', async () => {
    expect((await get('/api/capabilities')).body.capabilities.extensions).toBe(true);
    const bare = new WebApp({ store: new FakeStore(), memoryDir: dir, dataDir: dir, getStatus: () => ({}), log: nullLogger() });
    const p2 = await bare.start(0);
    try {
      const caps = await (await fetch(`http://127.0.0.1:${p2}/api/capabilities`)).json() as any;
      expect(caps.capabilities.extensions).toBe(false);
      expect(caps.capabilities.restart).toBe(false);
      expect((await fetch(`http://127.0.0.1:${p2}/api/extensions`)).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${p2}/api/extensions/updates`)).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${p2}/api/extensions/search`)).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${p2}/api/extensions/package?name=x`)).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${p2}/api/extensions/install`, { method: 'POST' })).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${p2}/api/extensions/uninstall`, { method: 'POST' })).status).toBe(503);
    } finally {
      await bare.stop();
    }
  });
});


describe('extension operation and lifecycle endpoints', () => {
  it('returns queryable structured transaction results', async () => {
    const out = await post('/api/extensions/operations', { id: 'example-operation', action: 'install', target: { name: 'example' }, kind: 'world' });
    expect(out.body).toMatchObject({ id: 'example-operation', phase: 'rolled-back', error: 'invalid export' });
    const result = await get('/api/extensions/operations/example-operation'); expect(result.body.phase).toBe('committed');
  });
  it('returns asynchronous preflight and activation failures without terminating the server', async () => {
    const failed = await post('/api/extensions/check', { target: { name: 'example' }, kind: 'world' }); expect(failed.status).toBe(500); expect(failed.body.error).toContain('incompatible');
    const activation = await post('/api/extensions/activation', { name: 'example', enabled: false }); expect(activation.body.error).toContain('module in use');
    expect((await get('/api/extensions')).status).toBe(200);
  });
  it('keeps boot identity stable while readiness changes', async () => {
    const before = await get('/api/run/lifecycle'); app.markReady(); const after = await get('/api/run/lifecycle');
    expect(before.body.ready).toBe(false); expect(after.body).toMatchObject({ bootId: before.body.bootId, deployment: before.body.deployment, ready: true });
  });
});
