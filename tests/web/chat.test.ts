/** WebApp 与 ConsoleWorld 的端到端流式通信，经 /ws/providers/world:console/panels/chat 验证发言、回执与事件存储。协议分支见 io-console-webui.test.ts，框架通道见 provider-stream.test.ts。 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { WebApp } from '../../src/web/server.ts';
import { ConsoleWorld } from '../../src/worlds/console/world.ts';
import { ioPageContribution } from '../../src/bot.ts';
import { panelStreamRoute } from '../../src/web/shared/webui-protocol.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { ToolCallContext } from '../../src/core/types.ts';
import { FakeHost } from './fakes.ts';

class WSQueue {
  private msgs: Array<Record<string, unknown>> = [];
  private waiters: Array<(m: Record<string, unknown>) => void> = [];
  constructor(ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Record<string, unknown>;
      const w = this.waiters.shift();
      if (w) w(m);
      else this.msgs.push(m);
    });
  }
  next(timeoutMs = 5000): Promise<Record<string, unknown>> {
    const head = this.msgs.shift();
    if (head) return Promise.resolve(head);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('等待WS消息超时')), timeoutMs);
      this.waiters.push((m) => { clearTimeout(timer); res(m); });
    });
  }
  async nextOfType(type: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 20; i++) {
      const m = await this.next();
      if (m.type === type) return m;
    }
    throw new Error(`20条内没等到type=${type}`);
  }
}

async function openClient(port: number): Promise<{ ws: WebSocket; q: WSQueue }> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${panelStreamRoute('world:console', 'chat')}`,
  );
  const q = new WSQueue(ws);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  return { ws, q };
}

const ctx: ToolCallContext = { role: 'main', log: nullLogger() };

let app: WebApp;
let port: number;
let host: FakeHost;
let world: ConsoleWorld;
let memoryDir: string;
let dataDir: string;

beforeAll(async () => {
  memoryDir = mkdtempSync(join(tmpdir(), 'webchat-persona-'));
  dataDir = mkdtempSync(join(tmpdir(), 'webchat-data-'));
  host = new FakeHost();
  world = new ConsoleWorld({ timezone: 'Asia/Shanghai' });
  await world.start(host);
  app = new WebApp({
    store: host.store,
    memoryDir,
    dataDir,
    getStatus: () => ({ online: world.onlineCount() }),
    // 与真跑同一条适配路径:World 自报的 stream 经 ioPageContribution 转发。
    webUiPageSources: () => [{
      id: 'world:console',
      contribute: () => ioPageContribution('console', '控制台对话', undefined, world),
    }],
    log: nullLogger(),
  });
  port = await app.start(0);
});

afterAll(async () => {
  await world.stop();
  await app.stop();
  rmSync(memoryDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('控制台对话经 provider 流式通道的整条链路', () => {
  it('hello+msg → host收到flush投递的console.message,双端收到回显;工具发言推得回去', async () => {
    const a = await openClient(port);
    await a.q.nextOfType('sys'); // 欢迎语
    a.ws.send(JSON.stringify({ type: 'hello', name: '阿明' }));
    await a.q.nextOfType('sys'); // 你好,阿明

    const b = await openClient(port);
    await b.q.nextOfType('sys');
    b.ws.send(JSON.stringify({ type: 'hello', name: '小北' }));
    await b.q.nextOfType('sys');

    a.ws.send(JSON.stringify({ type: 'msg', text: '你好呀' }));

    const echoA = await a.q.nextOfType('msg');
    const echoB = await b.q.nextOfType('msg');
    for (const echo of [echoA, echoB]) {
      expect(echo.from).toBe('阿明');
      expect(echo.text).toBe('你好呀');
      expect(typeof echo.ts).toBe('string');
    }

    const rec = host.pushed.find((p) => p.e.type === 'console.message');
    expect(rec).toBeDefined();
    expect(rec!.opts?.trigger).toBe('flush');
    expect(rec!.e.senderKey).toBe('阿明');
    expect(rec!.e.source).toBe('console');
    expect(rec!.e.text).toMatch(/^\[\d{2}:\d{2}\] 阿明: 你好呀$/);

    // 进出控制台不投递事件:presence 噪音不打扰bot
    expect(host.pushed.filter((p) => p.e.type === 'console.presence').length).toBe(0);

    const send = world.tools().find((t) => t.name === 'console_send')!;
    const result = await send.handler({ text: '我在。' }, ctx);
    const botA = await a.q.nextOfType('msg');
    const botB = await b.q.nextOfType('msg');
    for (const bm of [botA, botB]) {
      expect(bm.from).toBe('bot');
      expect(bm.text).toBe('我在。');
    }
    // 回执带投递事实(发到哪、几个连接在线):见 worlds-console-webui.test.ts
    expect(String(result).startsWith('[sent] ')).toBe(true);
    expect(result).toContain('2 connections online');

    const self = host.pushed.find((p) => p.e.type === 'console.self');
    expect(self).toBeDefined();
    expect(self!.opts?.deliver).toBe(false);
    expect(self!.e.text).toMatch(/^\[\d{2}:\d{2}\] you: 我在。$/);

    a.ws.close();
    b.ws.close();
    await vi.waitFor(() => expect(world.onlineCount()).toBe(0));
    expect(host.pushed.filter((p) => p.e.type === 'console.presence').length).toBe(0);
  });
});
