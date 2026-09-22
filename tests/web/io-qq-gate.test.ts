/** 验证 QQ 接收控制的控制台调用与配置。 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { QQWorld } from '../../src/worlds/qq/world.ts';
import { FakeStore } from './fakes.ts';

const store = new FakeStore();

const gateState = {
  enabled: false,
  wsUrl: 'ws://127.0.0.1:3001',
  tokenSet: false,
};
const calls = { enabled: [] as boolean[], conn: [] as Array<[string, string]>, restart: 0 };

const qq = new QQWorld(
  { wsUrl: gateState.wsUrl, groups: [111], privates: [222], token: '' },
  {
    gate: {
      enabled: () => gateState.enabled,
      wsUrl: () => gateState.wsUrl,
      tokenSet: () => gateState.tokenSet,
      roster: () => ({
        groups: [{ id: 111, enabled: true }],
        privates: [{ id: 222, enabled: true }],
      }),
      setRoster: () => 'ok',
      setEnabled: (e) => { calls.enabled.push(e); gateState.enabled = e; },
      setConnection: (ws, tk) => { calls.conn.push([ws, tk]); gateState.wsUrl = ws; if (tk) gateState.tokenSet = true; },
      restart: () => { calls.restart++; },
    },
  },
);
const invoke = qq.console().invoke!;
afterEach(() => { vi.useRealTimers(); });


beforeAll(() => {
  // 事件库:两个群 + 一个私聊的 qq 事件,外加一条终端事件(应被 source 过滤排除)
  const seed = (source: string, type: string, text: string, conv?: { kind: string; id: number }, ts?: string) =>
    store.append({ type, ts: ts ?? '2026-07-19T15:00:00+08:00', source, origin: 'external', text, ...(conv ? { meta: { conv } } : {}) });
  seed('qq', 'qq.message', '[群「茶话会」] a', { kind: 'group', id: 111 }, '2026-07-19T15:01:00+08:00');
  seed('qq', 'qq.message', '[群「茶话会」] b', { kind: 'group', id: 111 }, '2026-07-19T15:02:00+08:00');
  seed('qq', 'qq.message', '[群「学习组」] c', { kind: 'group', id: 333 }, '2026-07-19T15:03:00+08:00');
  seed('terminal', 'terminal.message', '[终端] 访客', undefined, '2026-07-19T15:04:00+08:00');
  seed('qq', 'qq.message', '[私聊] d', { kind: 'private', id: 222 }, '2026-07-19T15:05:00+08:00');
  // events 面板只用 host.store;不为它起整条协议端连接,直接塞一个只有 store 的宿主
  (qq as any).host = { store };
});

describe('gate.state', () => {
  it('返回开关/连接/身份快照(未连接时 roster 沿用最近身份)', async () => {
    const d = (await invoke('gate', 'state', [])) as any;
    expect(d.enabled).toBe(false);
    expect(d.wsUrl).toBe('ws://127.0.0.1:3001');
    expect(d.tokenSet).toBe(false);
    expect(d.connected).toBe(false);
    expect(d.groups).toEqual([{ id: 111, name: '111', card: '' }]);
    expect(d.privates).toEqual([{ id: 222, name: '' }]);
  });
});

describe('events.list', () => {
  it('只取 source=qq,按会话分组、最近在前', async () => {
    const d = (await invoke('events', 'list', [{}])) as any;
    expect(d.total).toBe(4); // 4 条 qq,终端那条被排除
    expect(d.events.length).toBe(4);
    // 会话按 lastTs 倒序:私聊222(15:05) → 群333(15:03) → 群111(15:02)
    expect(d.conversations.map((c: any) => `${c.kind}:${c.id}:${c.count}`)).toEqual([
      'private:222:1', 'group:333:1', 'group:111:2',
    ]);
  });

  it('conv 过滤只回该会话的事件;非法/未知会话回空', async () => {
    const d = (await invoke('events', 'list', [{ conv: 'group:111' }])) as any;
    expect(d.events.length).toBe(2);
    expect(d.events.every((e: any) => e.conv.kind === 'group' && e.conv.id === 111)).toBe(true);
    expect(d.conversations.length).toBe(3); // conversations 仍是全量(给 tab 用)
    for (const conv of ['group:99999', 'group:not-a-number']) {
      const d2 = (await invoke('events', 'list', [{ conv }])) as any;
      expect(d2.events.length).toBe(0);
      expect(d2.total).toBe(4);
    }
  });
});

describe('gate.setEnabled', () => {
  it('非布尔 enabled → 抛错', async () => {
    await expect(invoke('gate', 'setEnabled', ['yes'])).rejects.toThrow('布尔');
  });

  it('合法 → 持久化开关并调度重启(响应先回,300ms 后 restart)', async () => {
    vi.useFakeTimers();
    calls.enabled.length = 0; calls.restart = 0;
    const r = (await invoke('gate', 'setEnabled', [true])) as any;
    expect(r).toMatchObject({ ok: true, restarting: true, enabled: true });
    expect(calls.enabled).toEqual([true]); // 同步调用
    expect(calls.restart).toBe(0);
    await vi.advanceTimersByTimeAsync(299);
    expect(calls.restart).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.restart).toBe(1);
  });
});

describe('gate.setConnection', () => {
  it('非 ws:// 地址 → 抛错,不触发', async () => {
    calls.conn.length = 0; calls.restart = 0;
    await expect(invoke('gate', 'setConnection', ['http://x', ''])).rejects.toThrow('ws://');
    expect(calls.conn.length).toBe(0);
  });

  it('合法 → 持久化连接并调度重启', async () => {
    vi.useFakeTimers();
    calls.conn.length = 0; calls.restart = 0;
    const r = (await invoke('gate', 'setConnection', ['ws://127.0.0.1:4000', 'sekret'])) as any;
    expect(r).toMatchObject({ ok: true, restarting: true });
    expect(calls.conn).toEqual([['ws://127.0.0.1:4000', 'sekret']]);
    expect(calls.restart).toBe(0);
    await vi.advanceTimersByTimeAsync(299);
    expect(calls.restart).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.restart).toBe(1);
  });
});

describe('gate 数据面未接线', () => {
  it('gate/roster 面板报不可用', async () => {
    const bare = new QQWorld({ wsUrl: 'ws://x', groups: [], privates: [], token: '' });
    const inv = bare.console().invoke!;
    await expect(inv('gate', 'state', [])).rejects.toThrow('不可用');
    await expect(inv('roster', 'get', [])).rejects.toThrow('不可用');
  });
});
