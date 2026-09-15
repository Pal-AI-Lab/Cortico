/**
 * Minecraft 面板经 provider 通道:fake 面板面透传 + 没这个 provider 时 404。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp } from '../../src/web/server.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';

let app: WebApp;
let bare: WebApp;
let port: number;
let barePort: number;
let dir: string;
let srvPhase = 'stopped';
let cliPhase = 'stopped';

const get = async (p: number, path: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`http://127.0.0.1:${p}${path}`);
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (p: number, path: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`http://127.0.0.1:${p}${path}`, { method: 'POST' });
  return { status: r.status, body: (await r.json()) as any };
};
const postJson = async (p: number, path: string, body: unknown): Promise<{ status: number; body: any }> => {
  const r = await fetch(`http://127.0.0.1:${p}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

/** 存档面板的假后端:记下被叫到的动作与参数,状态里回显 */
const worldFake = {
  levelName: 'world',
  last: '' as string,
  state: async () => ({
    configured: true, serverDir: 'C:\\mc', live: false, hosted: false,
    worlds: [{ name: worldFake.levelName, generated: true, modified: null }],
    settings: {
      gamemode: 'survival', difficulty: 'easy', hardcore: false, pvp: true,
      spawnMonsters: true, levelSeed: '', levelName: worldFake.levelName,
    },
    detail: worldFake.last || null,
  }),
  select: async (name: string) => {
    worldFake.levelName = name;
    worldFake.last = `下次启动进「${name}」`;
    return worldFake.state();
  },
  create: async (name: string, seed: string) => {
    worldFake.levelName = name;
    worldFake.last = `新世界${name} 种子${seed}`;
    return worldFake.state();
  },
  apply: async (patch: Record<string, unknown>) => {
    worldFake.last = '收到 ' + Object.keys(patch).sort().join(',');
    return worldFake.state();
  },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-mcmount-'));
  const common = {
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    getStatus: () => ({}),
    log: nullLogger(),
  };
  app = new WebApp({
    ...common,
    consolePageSources: () => [{
      id: 'world:minecraft',
      contribute: () => ({
        id: 'world:minecraft',
        kind: 'world' as const,
        label: 'Minecraft',
        availability: 'active' as const,
        panels: Object.keys(mcPanels).map((id) => ({ id, title: id, getMethods: ['state'] })),
        invoke: mcInvoke,
      }),
    }],
  } as never);
  port = await app.start(0);
  bare = new WebApp({ ...common } as never);
  barePort = await bare.start(0);
});

const mcPanels: Record<string, Record<string, (...args: any[]) => unknown>> = {
      server: {
        state: async () => ({
          phase: srvPhase, address: '127.0.0.1:25565', detail: null, pid: null,
          reachable: srvPhase === 'running', serverDir: '', configured: false,
        }),
        start: async () => {
          srvPhase = 'starting';
          return { phase: srvPhase, address: '127.0.0.1:25565', detail: '世界加载中', pid: 7, reachable: false, serverDir: '', configured: true };
        },
        stop: async () => {
          srvPhase = 'stopped';
          return { phase: srvPhase, address: '127.0.0.1:25565', detail: null, pid: null, reachable: false, serverDir: '', configured: true };
        },
      },
      client: {
        state: async () => ({
          phase: cliPhase, enabled: true, detail: null, pid: cliPhase === 'stopped' ? null : 11,
          windowReady: cliPhase === 'running', gameDir: 'C:\\mc', versionId: '1.20.1',
          username: 'CortiCam', configured: true, command: 'java ...',
        }),
        start: async () => {
          cliPhase = 'starting';
          return { phase: cliPhase, enabled: true, detail: '客户端启动中', pid: 11, windowReady: false, configured: true };
        },
        stop: async () => {
          cliPhase = 'stopped';
          return { phase: cliPhase, enabled: true, detail: null, pid: null, windowReady: false, configured: true };
        },
      },
      world: worldFake as never,
};

async function mcInvoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
  const fn = mcPanels[panel]?.[method];
  if (!fn) throw new Error(`未知面板方法 ${panel}.${method}`);
  return (fn as (...a: unknown[]) => unknown)(...args);
}

afterAll(async () => {
  await app.stop();
  await bare.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('minecraft 面板 · server', () => {
  it('state 透传(含 configured 提示位)', async () => {
    const { status, body } = await get(port, '/api/console/providers/world%3Aminecraft/panels/server/state');
    expect(status).toBe(200);
    expect(body.phase).toBe('stopped');
    expect(body.configured).toBe(false);
  });

  it('start → starting;stop → stopped', async () => {
    const s1 = await post(port, '/api/console/providers/world%3Aminecraft/panels/server/start');
    expect(s1.body.phase).toBe('starting');
    expect(s1.body.pid).toBe(7);
    const s2 = await post(port, '/api/console/providers/world%3Aminecraft/panels/server/stop');
    expect(s2.body.phase).toBe('stopped');
  });
});

describe('minecraft 面板 · client', () => {
  it('state 透传(窗口就绪位与账号名)', async () => {
    const { body } = await get(port, '/api/console/providers/world%3Aminecraft/panels/client/state');
    expect(body.windowReady).toBe(false);
    expect(body.username).toBe('CortiCam');
  });

  it('start/stop 走通', async () => {
    expect((await post(port, '/api/console/providers/world%3Aminecraft/panels/client/start')).body.phase).toBe('starting');
    expect((await post(port, '/api/console/providers/world%3Aminecraft/panels/client/stop')).body.phase).toBe('stopped');
  });
});

describe('minecraft 面板 · world', () => {
  it('state 透传存档表与设置', async () => {
    const { status, body } = await get(port, '/api/console/providers/world%3Aminecraft/panels/world/state');
    expect(status).toBe(200);
    expect(body.settings.levelName).toBe('world');
    expect(body.worlds[0].name).toBe('world');
  });

  it('换存档与开新存档把名字带下去', async () => {
    const sel = await postJson(port, '/api/console/providers/world%3Aminecraft/panels/world/select', { args: ['old-world'] });
    expect(sel.body.settings.levelName).toBe('old-world');
    expect(sel.body.detail).toContain('old-world');
    const made = await postJson(port, '/api/console/providers/world%3Aminecraft/panels/world/create', { args: ['新世界', '42'] });
    expect(made.body.detail).toContain('种子42');
    expect(made.body.settings.levelName).toBe('新世界');
  });

  it('玩法补丁原样透传,不在路由层挑拣', async () => {
    const { body } = await postJson(port, '/api/console/providers/world%3Aminecraft/panels/world/apply', {
      args: [{ difficulty: 'hard', gamemode: 'creative' }],
    });
    expect(body.detail).toBe('收到 difficulty,gamemode');
  });
});

describe('没有这个 provider', () => {
  it('没有这个 provider 时全部端点 404', async () => {
    for (const [path, method] of [
      ['/api/console/providers/world%3Aminecraft/panels/server/state', get] as const,
      ['/api/console/providers/world%3Aminecraft/panels/server/start', post] as const,
      ['/api/console/providers/world%3Aminecraft/panels/client/state', get] as const,
      ['/api/console/providers/world%3Aminecraft/panels/client/start', post] as const,
      ['/api/console/providers/world%3Aminecraft/panels/world/state', get] as const,
    ]) {
      const { status, body } = await method(barePort, path);
      expect(status).toBe(404);
      expect(typeof body.error).toBe('string');
    }
  });
});
