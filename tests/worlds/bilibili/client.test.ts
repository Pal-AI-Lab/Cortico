import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  LiveClient,
  RECONNECT_WATCHDOG_MS,
  ROOM_POLL_MS,
  ROOM_POLL_RISK_HOLD_MS,
  SHUTDOWN_VERIFY_TIMEOUT_MS,
  type LiveStatus,
} from '../../../src/worlds/bilibili/client.ts';
import { encodePacket, OP } from '../../../src/worlds/bilibili/wire.ts';
import type { Logger } from '../../../src/core/types.ts';
import { nullLogger } from '../../../src/core/util.ts';

/**
 * 假 WebSocket:记下构造参数,回调由测试手工触发。握手超时按 ws 8.x 的真实
 * 顺序模拟(先 error 再 close 1006);握手挂死就是什么都不触发。
 * 本文件里其余测试的 fetch 存根不给握手路,从不走到 new WebSocket。
 */
const wsFake = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWebSocket extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = FakeWebSocket.CONNECTING;
    readonly sent: Buffer[] = [];
    terminated = false;
    closedBy: { code?: number; reason?: string } | null = null;

    constructor(readonly url: string, readonly options: Record<string, unknown>) {
      super();
      sockets.push(this);
    }
    send(data: Buffer): void { this.sent.push(data); }
    close(code?: number, reason?: string): void {
      this.closedBy = { code, reason };
      this.readyState = FakeWebSocket.CLOSED;
    }
    terminate(): void {
      this.terminated = true;
      this.readyState = FakeWebSocket.CLOSED;
    }
    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    }
    timeoutHandshake(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('error', new Error('Opening handshake has timed out'));
      this.emit('close', 1006, Buffer.alloc(0));
    }
    drop(code: number, reason: string): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', code, Buffer.from(reason));
    }
  }
  const sockets: FakeWebSocket[] = [];
  return { FakeWebSocket, sockets };
});
vi.mock('ws', () => ({ default: wsFake.FakeWebSocket }));

function client(): LiveClient {
  return new LiveClient({
    roomId: 7734200,
    sessdata: '',
    onCmd: () => {},
    log: nullLogger(),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  wsFake.sockets.length = 0;
});

describe('LiveClient shutdown verification', () => {
  it.each([
    { liveStatus: 0, expected: 'verified-ended' },
    { liveStatus: 1, expected: 'still-live' },
    { liveStatus: 2, expected: 'unknown' },
  ] as const)('maps live_status=$liveStatus to $expected using one read-only GET', async ({ liveStatus, expected }) => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body });
      return new Response(JSON.stringify({ code: 0, data: { live_status: liveStatus } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const live = client();
    await live.stop();
    expect(live.shutdownVerification('zh')[0]).toMatchObject({ status: expected });
    expect(calls).toEqual([expect.objectContaining({
      url: expect.stringContaining('/room/v1/Room/get_info?room_id=7734200'),
      method: 'GET',
      body: undefined,
    })]);
    expect(calls[0].url).not.toMatch(/stop|end|stream/i);
  });

  it('times out to unknown without issuing any mutation request', async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body });
      return new Promise<Response>(() => { /* 模拟不响应且不理会 abort 的上游 */ });
    });

    const live = client();
    const stopping = live.stop();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_VERIFY_TIMEOUT_MS + 1);
    await stopping;

    expect(live.shutdownVerification('zh')[0]).toMatchObject({
      status: 'unknown',
      detail: expect.stringContaining('超时'),
      manualAction: expect.stringContaining('人工确认'),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', body: undefined });
    expect(calls[0].url).toContain('/Room/get_info');
  });

  it('treats a malformed success shell as unknown instead of ended', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 0, data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const live = client();
    await live.stop();
    expect(live.shutdownVerification('zh')[0]).toMatchObject({
      status: 'unknown',
      detail: expect.stringContaining('live_status'),
    });
  });

  it('treats a nonzero API code as unknown instead of ended', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 60004, message: 'room missing' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const live = client();
    await live.stop();
    expect(live.shutdownVerification('zh')[0]).toMatchObject({
      status: 'unknown',
      detail: expect.stringContaining('code=60004'),
    });
  });
});

/**
 * 运行期轮询将 live_status 变化写入状态；412 风控退避十分钟，stop 撤销轮询。
 */
describe('LiveClient 运行期 live_status 轮询', () => {
  /** WS 握手路(finger/spi 起头)一律失败:只留 Room/get_info 这条只读轮询路 */
  function stubFetch(getInfo: () => { status?: number; body?: unknown }): { infoCalls: () => number } {
    let infoCalls = 0;
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('Room/get_info')) {
        infoCalls += 1;
        const next = getInfo();
        if (next.status && next.status !== 200) return new Response('', { status: next.status });
        return new Response(JSON.stringify(next.body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error('ECONNREFUSED(测试里不给握手路)');
    });
    return { infoCalls: () => infoCalls };
  }

  it('轮询读到 live_status 翻转时 patch 状态;读数没变就不空转 onStatus', async () => {
    vi.useFakeTimers();
    const livingSeen: boolean[] = [];
    const replies = [
      { body: { code: 0, data: { live_status: 1, live_time: 1_786_841_602 } } },
      { body: { code: 0, data: { live_status: 1, live_time: 1_786_841_602 } } },
      { body: { code: 0, data: { live_status: 0, live_time: 0 } } },
    ];
    stubFetch(() => replies.shift() ?? { body: { code: 0, data: { live_status: 0, live_time: 0 } } });
    const live = new LiveClient({
      roomId: 7734200,
      sessdata: '',
      onCmd: () => {},
      onStatus: (s: LiveStatus) => { livingSeen.push(s.living); },
      log: nullLogger(),
    });
    await live.start();
    await vi.advanceTimersByTimeAsync(ROOM_POLL_MS * 3 + 100);

    // 状态序列里出现 false→true→false 两个沿(中间那次读数未变,不产生新的翻转)
    const edges: boolean[] = [];
    for (const living of livingSeen) {
      if (edges.length === 0 || edges[edges.length - 1] !== living) edges.push(living);
    }
    expect(edges).toEqual([false, true, false]);
    expect(live.current().living).toBe(false);
    await live.stop();
  });

  it('412 风控:退避十分钟档,严禁热重试;stop 撤防后不再轮询', async () => {
    vi.useFakeTimers();
    let first = true;
    const stub = stubFetch(() => {
      if (first) {
        first = false;
        return { status: 412 };
      }
      return { body: { code: 0, data: { live_status: 0, live_time: 0 } } };
    });
    const live = new LiveClient({
      roomId: 7734200,
      sessdata: '',
      onCmd: () => {},
      log: nullLogger(),
    });
    await live.start();
    await vi.advanceTimersByTimeAsync(ROOM_POLL_MS + 100);
    expect(stub.infoCalls()).toBe(1); // 撞上 412
    // 退避期内一次都不再问
    await vi.advanceTimersByTimeAsync(ROOM_POLL_RISK_HOLD_MS - 1_000);
    expect(stub.infoCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stub.infoCalls()).toBe(2);

    await live.stop();
    const afterStop = stub.infoCalls(); // stop 里的关机核验也读一次 get_info
    await vi.advanceTimersByTimeAsync(ROOM_POLL_MS * 3);
    expect(stub.infoCalls()).toBe(afterStop);
  });
});

/**
 * 握手超时通过 fail() 重连，close 记录 code/reason；握手接口也须超时，轮询兼作重连看门狗。
 */
describe('LiveClient 重连握手收口', () => {
  type LogLine = { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown };

  function recordingLog(): { log: Logger; lines: LogLine[] } {
    const lines: LogLine[] = [];
    const log: Logger = {
      trace: () => {},
      emit: () => {},
      debug: () => {},
      info: (msg, data) => { lines.push({ level: 'info', msg, data }); },
      warn: (msg, data) => { lines.push({ level: 'warn', msg, data }); },
      error: (msg, data) => { lines.push({ level: 'error', msg, data }); },
      child: () => log,
    };
    return { log, lines };
  }

  /** 握手四步全给(spi / nav / get_info / getDanmuInfo),让 connect 走到 new WebSocket */
  function stubHandshakeFetch(opts: { liveStatus?: number; hangSpi?: boolean } = {}): { calls: string[] } {
    const calls: string[] = [];
    const json = (body: unknown): Response => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    vi.stubGlobal('fetch', (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('finger/spi')) {
        if (opts.hangSpi) return new Promise<Response>(() => { /* 不响应也不理会 abort 的上游 */ });
        return Promise.resolve(json({ code: 0, data: { b_3: 'buvid3-test' } }));
      }
      if (u.includes('web-interface/nav')) {
        return Promise.resolve(json({
          code: -101,
          data: {
            mid: 0,
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        }));
      }
      if (u.includes('Room/get_info')) {
        return Promise.resolve(json({
          code: 0,
          data: { room_id: 1866954191, title: '测试间', live_status: opts.liveStatus ?? 1, live_time: '2026-09-01 20:00:00' },
        }));
      }
      if (u.includes('getDanmuInfo')) {
        return Promise.resolve(json({
          code: 0,
          data: { host_list: [{ host: 'broadcastlv.test', wss_port: 443 }], token: 'token-test' },
        }));
      }
      return Promise.reject(new Error(`测试里没有这条路:${u}`));
    });
    return { calls };
  }

  function authenticate(socket: InstanceType<typeof wsFake.FakeWebSocket>): void {
    socket.open();
    socket.emit('message', encodePacket(OP.AUTH_REPLY, JSON.stringify({ code: 0 })));
  }

  it('new WebSocket 带 handshakeTimeout;握手超时(error+close)走 fail() 退避重连', async () => {
    vi.useFakeTimers();
    stubHandshakeFetch();
    const { log, lines } = recordingLog();
    const live = new LiveClient({ roomId: 7734200, sessdata: '', onCmd: () => {}, log });
    await live.start();

    expect(wsFake.sockets).toHaveLength(1);
    expect(wsFake.sockets[0].options.handshakeTimeout).toBe(HANDSHAKE_TIMEOUT_MS);
    expect(live.current().phase).toBe('connecting');

    wsFake.sockets[0].timeoutHandshake();
    expect(live.current()).toMatchObject({ phase: 'retrying', lastError: '长连断开' });
    expect(lines.filter((line) => line.msg.includes('直播接入中断'))).toHaveLength(1);

    // 退避 2 秒后重新握手(重新取 token),开出第二个 socket
    await vi.advanceTimersByTimeAsync(2_100);
    expect(wsFake.sockets).toHaveLength(2);
    expect(live.current().phase).toBe('connecting');
    await live.stop();
  });

  it('close 的 code 与 reason 进 warn 日志;已放弃的 socket 补发的 close 不再触发第二次 fail', async () => {
    vi.useFakeTimers();
    stubHandshakeFetch();
    const { log, lines } = recordingLog();
    const live = new LiveClient({ roomId: 7734200, sessdata: '', onCmd: () => {}, log });
    await live.start();
    const socket = wsFake.sockets[0];
    authenticate(socket);
    expect(live.current().phase).toBe('connected');

    socket.drop(1006, 'remote gone');
    const interrupted = lines.filter((line) => line.level === 'warn' && line.msg.includes('长连断开'));
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].data).toEqual({ code: 1006, reason: 'remote gone' });

    // 同一 socket 再补一个 close(ws 在 terminate 后会这样):不算第二次断线
    socket.drop(1006, 'again');
    expect(lines.filter((line) => line.msg.includes('直播接入中断'))).toHaveLength(1);
    await live.stop();
  });

  it('握手接口不响应:到点 abort 并走 fail() 重连,不会卡在 bootstrap', async () => {
    vi.useFakeTimers();
    const { calls } = stubHandshakeFetch({ hangSpi: true });
    const { log } = recordingLog();
    const live = new LiveClient({ roomId: 7734200, sessdata: '', onCmd: () => {}, log });
    const starting = live.start();
    await vi.advanceTimersByTimeAsync(BOOTSTRAP_TIMEOUT_MS + 1);
    await starting;

    expect(live.current().phase).toBe('retrying');
    expect(live.current().lastError).toContain('超时');
    expect(wsFake.sockets).toHaveLength(0);
    const spiCalls = () => calls.filter((u) => u.includes('finger/spi')).length;
    expect(spiCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(spiCalls()).toBe(2);
    await live.stop();
  });

  it('看门狗:平台在播且握手挂死超过阈值,轮询强制 terminate 并重连', async () => {
    vi.useFakeTimers();
    stubHandshakeFetch({ liveStatus: 1 });
    const { log, lines } = recordingLog();
    const live = new LiveClient({ roomId: 7734200, sessdata: '', onCmd: () => {}, log });
    await live.start();
    const stuck = wsFake.sockets[0];
    expect(live.current()).toMatchObject({ phase: 'connecting', living: true });

    // 握手一直没结果:什么回调都不来。轮询到点(100 秒 > 60 秒阈值)兜底
    await vi.advanceTimersByTimeAsync(ROOM_POLL_MS + 100);
    expect(stuck.terminated).toBe(true);
    const watchdog = lines.filter((line) => line.msg.includes('重连看门狗'));
    expect(watchdog).toHaveLength(1);
    expect(watchdog[0].data).toMatchObject({ phase: 'connecting', elapsedMs: expect.any(Number) });
    expect((watchdog[0].data as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(RECONNECT_WATCHDOG_MS);
    // 退避后开出新 socket
    await vi.advanceTimersByTimeAsync(2_100);
    expect(wsFake.sockets).toHaveLength(2);
    expect(wsFake.sockets[1]).not.toBe(stuck);
    await live.stop();
  });

  it('看门狗不动已接入的连接,也不动退避计时器还挂着的重连', async () => {
    vi.useFakeTimers();
    stubHandshakeFetch({ liveStatus: 1 });
    const { log, lines } = recordingLog();
    const live = new LiveClient({ roomId: 7734200, sessdata: '', onCmd: () => {}, log });
    await live.start();
    authenticate(wsFake.sockets[0]);

    await vi.advanceTimersByTimeAsync(ROOM_POLL_MS * 2 + 100);
    expect(live.current().phase).toBe('connected');
    expect(wsFake.sockets).toHaveLength(1);
    expect(wsFake.sockets[0].terminated).toBe(false);
    expect(lines.some((line) => line.msg.includes('重连看门狗'))).toBe(false);

    // 断线进入 retrying:退避计时器自己会到点,看门狗不插手
    wsFake.sockets[0].drop(1006, 'remote gone');
    expect(live.current().phase).toBe('retrying');
    await vi.advanceTimersByTimeAsync(2_100);
    expect(wsFake.sockets).toHaveLength(2);
    expect(lines.some((line) => line.msg.includes('重连看门狗'))).toBe(false);
    await live.stop();
  });
});
