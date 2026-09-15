/** 验证通用面板 WS 通道的双向通信、断连时单次通知与解析失败说明。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { WebApp, type WebAppDeps } from '../../src/web/server.ts';
import type { ConsolePageSource } from '../../src/web/console-pages.ts';
import {
  panelStreamRoute,
  type ConsolePageContribution,
  type ConsoleStream,
} from '../../src/web/shared/console-protocol.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';

let dir: string;
/** "没构建过"的资源目录:别让测试撞上仓库里真实的 dist/web */
let emptyDist: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-stream-'));
  emptyDist = join(dir, 'no-dist');
  mkdirSync(emptyDist, { recursive: true });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── 起服务与连接的小工具 ────────────────────────────────────────────────

const sourcesOf = (...cs: ConsolePageContribution[]): (() => ConsolePageSource[]) =>
  () => cs.map((c) => ({ id: c.id, contribute: () => c }));

async function withApp(
  consolePageSources: () => ConsolePageSource[],
  fn: (ctx: { base: string; port: number; app: WebApp }) => Promise<void>,
  extra: Partial<WebAppDeps> = {},
): Promise<void> {
  const deps: WebAppDeps = {
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    webDistDir: emptyDist,
    getStatus: () => ({}),
    consolePageSources,
    log: nullLogger(),
    ...extra,
  };
  const app = new WebApp(deps);
  const port = await app.start(0);
  try {
    await fn({ base: `http://127.0.0.1:${port}`, port, app });
  } finally {
    await app.stop();
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const streamUrl = (port: number, pageId: string, panelId: string): string =>
  `ws://127.0.0.1:${port}${panelStreamRoute(pageId, panelId)}`;

const connect = (port: number, pageId: string, panelId: string, headers?: Record<string, string>): WebSocket =>
  new WebSocket(streamUrl(port, pageId, panelId), headers ? { headers } : {});

const opened = (ws: WebSocket): Promise<void> =>
  new Promise((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });

const nextMessage = (ws: WebSocket): Promise<string> =>
  new Promise((res) => { ws.once('message', (d) => res(String(d))); });

const closedWith = (ws: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise((res) => { ws.once('close', (code, reason) => res({ code, reason: reason.toString() })); });

/**
 * 连上就把第一帧与关闭都接住。
 * 监听必须赶在 `await open` 之前挂:说明帧常常与握手响应在同一批数据里到达,
 * 等 open 兑现之后再 `once('message')` 就已经错过了。
 */
function watch(ws: WebSocket): { firstFrame: Promise<string>; gone: Promise<{ code: number; reason: string }> } {
  const first = deferred<string>();
  const closed = deferred<{ code: number; reason: string }>();
  ws.on('message', (d) => first.resolve(String(d)));
  ws.once('close', (code, reason) => closed.resolve({ code, reason: reason.toString() }));
  return { firstFrame: first.promise, gone: closed.promise };
}

/** 握手结果:开了 / 被拒(跨站闸门在 upgrade 就 destroy,客户端看到的是 error) */
const handshake = (port: number, pageId: string, panelId: string, headers?: Record<string, string>):
Promise<'open' | 'rejected'> =>
  new Promise((resolve) => {
    const ws = connect(port, pageId, panelId, headers);
    ws.once('open', () => { ws.close(); resolve('open'); });
    ws.once('error', () => resolve('rejected'));
  });

/** 最常用的假 provider:把拿到的 socket 交出来,别的什么都不做 */
function capturing(id = 'world:demo', panelId = 'live') {
  const got = deferred<{ panel: string; socket: ConsoleStream }>();
  const c: ConsolePageContribution = {
    id,
    kind: 'world',
    label: '假 World',
    panels: [{ id: panelId, title: '实时' }],
    stream: (panel, socket) => got.resolve({ panel, socket }),
  };
  return { contribution: c, sources: sourcesOf(c), opened: got.promise };
}

// ── 双向 ────────────────────────────────────────────────────────────────

describe('provider 流式通道', () => {
  it('声明了 stream 就能连上,服务端推的帧客户端收得到', async () => {
    const fake = capturing();
    await withApp(fake.sources, async ({ port }) => {
      const ws = connect(port, 'world:demo', 'live');
      await opened(ws);
      const { panel, socket } = await fake.opened;
      expect(panel).toBe('live');
      expect(socket.open).toBe(true);

      const first = nextMessage(ws);
      socket.send(JSON.stringify({ t: 'tick', n: 1 }));
      expect(JSON.parse(await first)).toEqual({ t: 'tick', n: 1 });
      ws.close();
    });
  });

  it('客户端发的帧到得了 provider 的 onMessage', async () => {
    const fake = capturing();
    await withApp(fake.sources, async ({ port }) => {
      const ws = connect(port, 'world:demo', 'live');
      await opened(ws);
      const { socket } = await fake.opened;

      const heard = deferred<string>();
      socket.onMessage((text) => heard.resolve(text));
      ws.send('你好');
      expect(await heard.promise).toBe('你好');
      ws.close();
    });
  });

  it('provider 注册 onMessage 之前对端已发的帧不会丢', async () => {
    // provider 慢一拍才注册回调(真实 World 常常要先 await 点什么)
    const late = deferred<ConsoleStream>();
    const c: ConsolePageContribution = {
      id: 'world:slow',
      kind: 'world',
      label: '慢半拍',
      panels: [{ id: 'live', title: '实时' }],
      stream: (_panel, socket) => { late.resolve(socket); },
    };
    await withApp(sourcesOf(c), async ({ port }) => {
      const ws = connect(port, 'world:slow', 'live');
      await opened(ws);
      ws.send('早到的一帧');
      const socket = await late.promise;
      const heard = deferred<string>();
      socket.onMessage((t) => heard.resolve(t));
      expect(await heard.promise).toBe('早到的一帧');
      ws.close();
    });
  });

  it('provider id 含冒号,经 encodeURIComponent 后仍能路由到对的面板', async () => {
    const fake = capturing('world:with-dash', 'panel-2');
    await withApp(fake.sources, async ({ port }) => {
      // 路径里的冒号确实被编码了,服务端负责解回来
      expect(panelStreamRoute('world:with-dash', 'panel-2')).toBe('/ws/providers/world%3Awith-dash/panels/panel-2');
      const ws = connect(port, 'world:with-dash', 'panel-2');
      await opened(ws);
      expect((await fake.opened).panel).toBe('panel-2');
      ws.close();
    });
  });
});

// ── 生命周期 ────────────────────────────────────────────────────────────

describe('流的关闭', () => {
  it('provider 主动 close(reason),客户端看得到关闭与原因', async () => {
    const fake = capturing();
    await withApp(fake.sources, async ({ port }) => {
      const ws = connect(port, 'world:demo', 'live');
      await opened(ws);
      const { socket } = await fake.opened;
      const gone = closedWith(ws);
      socket.close('panel unmounted');
      const { code, reason } = await gone;
      expect(code).toBe(1000);
      expect(reason).toBe('panel unmounted');
    });
  });

  it('客户端断开时 provider 的 onClose 恰好触发一次', async () => {
    const fake = capturing();
    await withApp(fake.sources, async ({ port }) => {
      const ws = connect(port, 'world:demo', 'live');
      await opened(ws);
      const { socket } = await fake.opened;

      let fired = 0;
      const first = deferred();
      socket.onClose(() => { fired += 1; first.resolve(); });
      ws.close();
      await first.promise;
      // 再等一轮事件循环,确认没有第二次
      await new Promise((r) => setImmediate(r));
      expect(fired).toBe(1);
      expect(socket.open).toBe(false);
    });
  });

  it('连接关掉之后 send 静默丢弃,不抛', async () => {
    const fake = capturing();
    await withApp(fake.sources, async ({ port }) => {
      const ws = connect(port, 'world:demo', 'live');
      await opened(ws);
      const { socket } = await fake.opened;
      const gone = deferred();
      socket.onClose(() => gone.resolve());
      ws.close();
      await gone.promise;
      expect(() => socket.send('推给已经没人的连接')).not.toThrow();
      expect(socket.open).toBe(false);
    });
  });

  it('WebApp.stop() 把在连的流断开,并触发 provider 的 onClose', async () => {
    const fake = capturing();
    const deps: WebAppDeps = {
      store: new FakeStore(),
      memoryDir: dir,
      dataDir: dir,
      webDistDir: emptyDist,
      getStatus: () => ({}),
      consolePageSources: fake.sources,
      log: nullLogger(),
    };
    const app = new WebApp(deps);
    const port = await app.start(0);
    const ws = connect(port, 'world:demo', 'live');
    await opened(ws);
    const { socket } = await fake.opened;

    let fired = 0;
    const cleaned = deferred();
    socket.onClose(() => { fired += 1; cleaned.resolve(); });
    const clientGone = new Promise<void>((res) => ws.once('close', () => res()));

    await app.stop();
    await cleaned.promise;
    await clientGone;
    expect(fired).toBe(1);
    expect(socket.open).toBe(false);
  });
});


describe('解析失败', () => {
  /** 连上之后应当立刻收到一帧说明,然后被关掉 */
  const expectExplainedClose = async (
    port: number, pageId: string, panelId: string, wantCode: number,
  ): Promise<string> => {
    const ws = connect(port, pageId, panelId);
    const seen = watch(ws);
    await opened(ws); // 握手本身要成功:静默 destroy 的话这里就 error 了
    const text = (JSON.parse(await seen.firstFrame) as { t: string; text: string }).text;
    expect((await seen.gone).code).toBe(wantCode);
    return text;
  };

  it('流式通道不要求声明过同名面板:通道名只归那一页解释', async () => {
    const fake = capturing('world:demo', 'live');
    await withApp(fake.sources, async ({ port }) => {
      const ws = connect(port, 'world:demo', 'undeclared');
      await opened(ws);
      expect((await fake.opened).panel).toBe('undeclared');
      ws.close();
    });
  });

  it('没这个 provider / 没有流式面,两种都先说明再关', async () => {
    const withStream = capturing().contribution;
    const mute: ConsolePageContribution = {
      id: 'world:mute',
      kind: 'world',
      label: '没流式面',
      panels: [{ id: 'live', title: '实时' }],
    };
    await withApp(sourcesOf(withStream, mute), async ({ port }) => {
      expect(await expectExplainedClose(port, 'world:nobody', 'live', 1008)).toContain('没有这个 provider');
      expect(await expectExplainedClose(port, 'world:mute', 'live', 1013)).toContain('没有流式面');
    });
  });

  it('provider 的 stream() 抛错:只关这一条,服务器与别的连接都不受影响', async () => {
    const good = capturing('world:good', 'live');
    const boom: ConsolePageContribution = {
      id: 'world:boom',
      kind: 'world',
      label: '会炸的',
      panels: [{ id: 'live', title: '实时' }],
      stream: () => { throw new Error('流式面炸了'); },
    };
    await withApp(sourcesOf(good.contribution, boom), async ({ port, base }) => {
      const alive = connect(port, 'world:good', 'live');
      await opened(alive);
      const { socket } = await good.opened;

      const bad = connect(port, 'world:boom', 'live');
      const seen = watch(bad);
      await opened(bad);
      expect((JSON.parse(await seen.firstFrame) as { text: string }).text).toContain('流式面炸了');
      expect((await seen.gone).code).toBe(1011);

      // 服务器还活着
      expect((await fetch(`${base}/api/status`)).status).toBe(200);
      // 另一条流照常双向通
      expect(alive.readyState).toBe(WebSocket.OPEN);
      const echo = nextMessage(alive);
      socket.send('还在');
      expect(await echo).toBe('还在');
      alive.close();
    });
  });

  it('路径不成形的 WS 仍然被直接 destroy(不是所有 /ws/ 都进流式通道)', async () => {
    const fake = capturing();
    await withApp(fake.sources, async ({ port }) => {
      const bad = new WebSocket(`ws://127.0.0.1:${port}/ws/providers/world%3Ademo`);
      const result = await new Promise<'open' | 'rejected'>((res) => {
        bad.once('open', () => { bad.close(); res('open'); });
        bad.once('error', () => res('rejected'));
      });
      expect(result).toBe('rejected');
    });
  });
});

// ── 安全回归 ────────────────────────────────────────────────────────────

describe('流式通道的同源闸门', () => {
  it('跨站 Origin 的握手一律被拒,同源与无 Origin 放行', async () => {
    const fake = capturing();
    await withApp(fake.sources, async ({ port }) => {
      expect(await handshake(port, 'world:demo', 'live', { origin: 'http://evil.example' })).toBe('rejected');
      // 连不存在的 provider 也一样:闸门在解析之前
      expect(await handshake(port, 'world:nobody', 'live', { origin: 'http://evil.example' })).toBe('rejected');
      expect(await handshake(port, 'world:demo', 'live')).toBe('open');
      expect(await handshake(port, 'world:demo', 'live', { origin: `http://127.0.0.1:${port}` })).toBe('open');
    });
  });
});

describe('流的心跳', () => {
  // 通过 ping/pong 检测失联，terminate 后触发 close 和贡献方清理。
  it('服务端按间隔发 ping', async () => {
    const pinged = deferred();
    const opened = deferred();
    await withApp(
      sourcesOf({
        id: 'world:beat',
        kind: 'world',
        label: '心跳',
        panels: [{ id: 'p', title: 'P' }],
        stream: () => { opened.resolve(); },
      }),
      async ({ port }) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/providers/world%3Abeat/panels/p`);
        ws.on('ping', () => pinged.resolve());
        await opened.promise;
        await pinged.promise; // 没收到就超时失败
        ws.close();
      },
      { streamHeartbeatMs: 20 },
    );
  });

  it('对端不回 pong 时连接被断开,provider 的 onClose 照常触发', async () => {
    const closed = deferred();
    await withApp(
      sourcesOf({
        id: 'world:beat',
        kind: 'world',
        label: '心跳',
        panels: [{ id: 'p', title: 'P' }],
        stream: (_panel, socket) => { socket.onClose(() => closed.resolve()); },
      }),
      async ({ port }) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/providers/world%3Abeat/panels/p`);
        // 掐掉自动 pong:ws 默认会自动回,这里模拟一条半开的死连接
        await new Promise<void>((r) => ws.on('open', () => r()));
        ws.pong = (): void => { /* 装死 */ };
        await closed.promise; // 心跳发现失联 → terminate → close → onClose
        ws.terminate();
      },
      { streamHeartbeatMs: 20 },
    );
  });
});
