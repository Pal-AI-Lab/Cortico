/** 验证 World 配置的声明、读取、保存与校验。 */
import { describe, it, expect } from 'vitest';
import { QQWorld } from '../../src/worlds/qq/world.ts';
import { type QQRosterEntry } from '../../src/worlds/qq/config.ts';

// 装配侧 gate 数据面(配置所有权在装配层;这里用内存态代替 config.json)
const state = {
  enabled: true,
  wsUrl: 'ws://127.0.0.1:3001',
  token: '',
  groups: [{ id: 111, enabled: true }] as QQRosterEntry[],
  privates: [{ id: 222, enabled: true }] as QQRosterEntry[],
};
const setCalls: Array<{ groups: QQRosterEntry[]; privates: QQRosterEntry[] }> = [];

const qq = new QQWorld(
  { wsUrl: state.wsUrl, groups: [111], privates: [222], token: '' },
  {
    gate: {
      enabled: () => state.enabled,
      wsUrl: () => state.wsUrl,
      tokenSet: () => !!state.token,
      roster: () => ({ groups: [...state.groups], privates: [...state.privates] }),
      setRoster: (groups, privates) => {
        setCalls.push({ groups, privates });
        state.groups = [...groups];
        state.privates = [...privates];
        return `已更新:群 ${groups.length} 个 / 私聊 ${privates.length} 个`;
      },
      setEnabled: (enabled) => { state.enabled = enabled; },
      setConnection: (wsUrl, token) => {
        state.wsUrl = wsUrl;
        if (token !== '') state.token = token;
      },
      restart: async () => {},
    },
  },
);

const invoke = (panel: string, method: string, args: unknown[] = []): Promise<any> =>
  Promise.resolve(qq.webUi().invoke!(panel, method, args)) as Promise<any>;
const setRoster = (groups: unknown, privates: unknown) =>
  invoke('roster', 'set', [groups, privates]);

describe('QQ roster 面板', () => {
  it('roster.get 返回当前监听roster(含enabled)', async () => {
    expect(await invoke('roster', 'get')).toEqual({
      groups: [{ id: 111, enabled: true }],
      privates: [{ id: 222, enabled: true }],
    });
  });

  it('roster.set:更新并返回ok+新config', async () => {
    const body = await setRoster(
      [{ id: 10, enabled: true }, { id: 20, enabled: false }],
      [{ id: 30, enabled: true }],
    );
    expect(body.ok).toBe(true);
    expect(body.config).toEqual({
      groups: [{ id: 10, enabled: true }, { id: 20, enabled: false }],
      privates: [{ id: 30, enabled: true }],
    });
    expect(typeof body.result).toBe('string');
    expect(setCalls.at(-1)).toMatchObject({
      groups: [{ id: 10, enabled: true }, { id: 20, enabled: false }],
      privates: [{ id: 30, enabled: true }],
    });
  });

  it('缺省groups/privates→当作空数组;enabled缺省→true;字符串数字id被Number化', async () => {
    expect((await setRoster(undefined, undefined)).config).toEqual({ groups: [], privates: [] });
    const body = await setRoster([{ id: '123' }], [{ id: '456', enabled: false }]);
    expect(body.config).toEqual({ groups: [{ id: 123, enabled: true }], privates: [{ id: 456, enabled: false }] });
  });

  it('校验归 World:非法输入一律抛错', async () => {
    await expect(setRoster(123, [])).rejects.toThrow();
    await expect(setRoster([], 'x')).rejects.toThrow();
    await expect(setRoster([111], [])).rejects.toThrow();
    await expect(setRoster([{ id: 'abc' }], [])).rejects.toThrow();
    await expect(setRoster([{ id: 0 }], [])).rejects.toThrow();
    await expect(setRoster([{ id: 1.5 }], [])).rejects.toThrow();
    await expect(setRoster([{ id: 1 }, { id: 1 }], [])).rejects.toThrow();
  });
});

describe('QQ gate 面板', () => {
  it('gate.state 组合装配侧配置与 World 连接快照', async () => {
    const body = await invoke('gate', 'state');
    expect(body.enabled).toBe(true);
    expect(body.wsUrl).toBe('ws://127.0.0.1:3001');
    expect(body.connected).toBe(false);
  });

  it('未知面板 / 未知方法各自抛错', async () => {
    await expect(invoke('nope', 'x')).rejects.toThrow();
    await expect(invoke('roster', 'nope')).rejects.toThrow();
  });
});
