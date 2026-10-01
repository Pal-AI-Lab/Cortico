/**
 * /ws/debug 调试通道测试。
 * 真SessionLog/JsonlEventStore/Runlog(mkdtemp临时目录)+ 手写debug deps,
 * 不跑agent主循环。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { WebApp, type WebAppDebugDeps } from '../../src/web/server.ts';
import { SessionLog } from "../core/fixture-session.ts";
import { JsonlEventStore } from '../../src/core/event-store.ts';
import { Runlog, nullLogger } from "../core/fixture-util.ts";
import type { ChatMessage } from '../core/fixture-types.ts';


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
  async nextOfType(t: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 20; i++) {
      const m = await this.next();
      if (m.t === t) return m;
    }
    throw new Error(`20条内没等到t=${t}`);
  }
}

async function openDebug(port: number): Promise<{ ws: WebSocket; q: WSQueue }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/debug`);
  const q = new WSQueue(ws);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  return { ws, q };
}

const schemas = [
  { name: 'fork', description: '分出联想', parameters: { type: 'object', properties: {} } },
  { name: 'send', description: '发言', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];

let app: WebApp;
let port: number;
let memoryDir: string;
let dataDir: string;
let session: SessionLog;
let store: JsonlEventStore;
let runlog: Runlog;
let paused = false;

const sysMsg: ChatMessage = { role: 'system', content: '测试用系统前缀。' };
const asstMsg: ChatMessage = {
  role: 'user',
  content: '#1 [09:00] 阿明: 在吗',
};

beforeAll(async () => {
  memoryDir = mkdtempSync(join(tmpdir(), 'webdebug-persona-'));
  dataDir = mkdtempSync(join(tmpdir(), 'webdebug-data-'));
  session = new SessionLog(dataDir);
  store = new JsonlEventStore({ dataDir, run: 'r-20260101-000000-0001' });
  runlog = new Runlog(join(dataDir, 'runlog.jsonl'), { console: false });

  // 种子数据(在WebApp构造前:hello快照必须能读到)
  session.append(sysMsg);
  session.append(asstMsg);
  store.append({ type: 'terminal.message', ts: '2026-07-17T09:00:00+08:00', source: 'terminal', origin: 'external', text: '[09:00] 阿明: 在吗', senderKey: '阿明' });
  store.append({ type: 'qq.message', ts: '2026-07-17T09:01:00+08:00', source: 'qq', origin: 'external', text: '[09:01] 小北: 早', senderKey: '10001' });
  runlog.write({ ts: '2026-07-17T09:00:01+08:00', level: 'info', area: 'loop', msg: '唤醒' });
  runlog.write({ ts: '2026-07-17T09:00:02+08:00', level: 'error', area: 'worlds.qq', msg: '断线', data: { code: 1006 } });

  const debug: WebAppDebugDeps = {
    sessionMessages: () => session.records,
    onSessionAppend: (cb) => session.onAppend(cb),
    onSessionReset: (cb) => session.onReset(cb),
    onEvent: (cb) => store.onAppend(cb),
    onRunlog: (cb) => runlog.onWrite(cb),
    runId: () => 'r-20260101-000000-0001',
    toolSchemas: () => schemas,
  };
  app = new WebApp({
    store,
    memoryDir,
    dataDir,
    getStatus: () => ({ loop: { estTokens: 42, messageCount: session.messages.length, paused }, terminalOnline: 0 }),
    run: { pause: () => { paused = true; }, resume: () => { paused = false; }, isPaused: () => paused },
    debug,
    log: nullLogger(),
  });
  port = await app.start(0);
});

afterAll(async () => {
  await app.stop();
  rmSync(memoryDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('/ws/debug hello快照', () => {
  it('连接即收到hello:session全量+toolSchemas+status', async () => {
    const { ws, q } = await openDebug(port);
    const hello = await q.nextOfType('hello');
    expect(hello.session).toEqual(session.records);
    expect(hello.toolSchemas).toEqual(schemas);
    expect((hello.status as { loop: { estTokens: number } }).loop.estTokens).toBe(42);
    ws.close();
  });
});

describe('/ws/debug 实时推送', () => {
  it('session.append → 推session.append帧(带index)+顺带status帧', async () => {
    const { ws, q } = await openDebug(port);
    await q.nextOfType('hello');
    const toolMsg: ChatMessage = { role: 'assistant', content: '', reasoning_content: '先看看该不该回复。' };
    const beforeLen = session.records.length;
    session.append(toolMsg);
    const f = await q.nextOfType('session.append');
    expect(f.index).toBe(beforeLen);
    expect(f.message).toEqual(session.records[beforeLen]);
    expect((await q.nextOfType('session.append')).message).toEqual(session.records[beforeLen + 1]);
    const st = await q.nextOfType('status');
    expect((st.status as { loop: { messageCount: number } }).loop.messageCount).toBeGreaterThanOrEqual(beforeLen + 1);
    ws.close();
  });

  it('event/runlog → 实时帧到达;多客户端都收到', async () => {
    const a = await openDebug(port);
    const b = await openDebug(port);
    await a.q.nextOfType('hello');
    await b.q.nextOfType('hello');

    const ev = store.append({ type: 'terminal.message', ts: '2026-07-17T09:02:00+08:00', source: 'terminal', origin: 'external', text: '[09:02] 阿明: 还在吗', senderKey: '阿明' });
    for (const c of [a, b]) {
      const f = await c.q.nextOfType('event');
      expect((f.envelope as { cursor: number }).cursor).toBe(ev.cursor);
      expect((f.envelope as { text: string }).text).toContain('还在吗');
    }

    runlog.write({ ts: '2026-07-17T09:02:01+08:00', level: 'warn', area: 'bus', msg: '队列偏高' });
    for (const c of [a, b]) {
      const f = await c.q.nextOfType('runlog');
      expect((f.entry as { level: string }).level).toBe('warn');
    }
    a.ws.close();
    b.ws.close();
  });

  it('session.reset → 推session.reset帧(整个数组)', async () => {
    const { ws, q } = await openDebug(port);
    await q.nextOfType('hello');
    const newMsgs: ChatMessage[] = [sysMsg, { role: 'user', content: '[system] Session restarted.' }];
    session.reset(newMsgs);
    const f = await q.nextOfType('session.reset');
    expect(f.messages).toEqual(session.records);
    expect(f.toolSchemas).toEqual(schemas);
    ws.close();
  });

  it('暂停与继续不经 session 追加也立即推 status', async () => {
    const { ws, q } = await openDebug(port);
    await q.nextOfType('hello');
    await fetch(`http://127.0.0.1:${port}/api/run/pause`, { method: 'POST' });
    expect(((await q.nextOfType('status')).status as { loop: { paused: boolean } }).loop.paused).toBe(true);
    await fetch(`http://127.0.0.1:${port}/api/run/resume`, { method: 'POST' });
    expect(((await q.nextOfType('status')).status as { loop: { paused: boolean } }).loop.paused).toBe(false);
    ws.close();
  });
});

describe('无debug deps时的拒绝路径', () => {
  let app2: WebApp;
  let p2: number;
  beforeAll(async () => {
    app2 = new WebApp({
      store, memoryDir, dataDir,
      getStatus: () => ({}), log: nullLogger(),
    });
    p2 = await app2.start(0);
  });
  afterAll(async () => { await app2.stop(); });

  it('/ws/debug → 收到sys说明后连接被关闭', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${p2}/ws/debug`);
    const messages: Array<{ t: string; text: string }> = [];
    const closed = new Promise<void>((res) => ws.on('close', () => res()));
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    await closed;
    expect(messages.some((m) => m.t === 'sys' && m.text.includes('调试通道不可用'))).toBe(true);
  });

});
