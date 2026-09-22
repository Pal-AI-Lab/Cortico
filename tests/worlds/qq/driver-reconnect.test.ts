/**
 * OneBotDriver:断线重连(短退避参数)、callApi错误路径、扩展动作隔离。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { OneBotDriver } from '../../../src/worlds/qq/driver.ts';
import { MockOneBot } from '../../helpers/mock-onebot.ts';
import { waitUntil } from './helpers.ts';

const GROUP = 424242;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function makeDriver(port: number, extra: Partial<ConstructorParameters<typeof OneBotDriver>[0]> = {}) {
  const driver = new OneBotDriver({
    wsUrl: `ws://127.0.0.1:${port}`,
    groups: [GROUP],
    reconnectBaseMs: 50,
    reconnectMaxMs: 200,
    apiTimeoutMs: 2000,
    ...extra,
  });
  cleanups.push(() => driver.stop());
  return driver;
}

function makeMock(port = 0, groupName = '测试群') {
  const mock = new MockOneBot({ port, groupId: GROUP, groupName });
  cleanups.push(() => mock.close());
  return mock;
}

describe('OneBotDriver', () => {
  it('连接后完成身份初始化', async () => {
    const mock = makeMock();
    const port = await mock.start();
    const driver = makeDriver(port);
    await driver.start();

    expect(driver.connected).toBe(true);
    expect(driver.identity?.selfId).toBe(5000);
    expect(driver.identity?.nickname).toBe('bot');
    expect(driver.identity?.groups.get(GROUP)).toEqual({
      groupName: '测试群',
      card: 'bot',
    });
  });

  it('协议端挂掉后指数退避重连,新协议端起来能自动连上', async () => {
    const mock1 = makeMock();
    const port = await mock1.start();
    const driver = makeDriver(port);
    await driver.start();
    expect(driver.connected).toBe(true);

    await mock1.close();
    await waitUntil(() => !driver.connected, '感知断线');

    // 同端口起一个新协议端(群名不同以验证身份刷新)
    const mock2 = makeMock(port, '第二个群名');
    await mock2.start();
    await waitUntil(
      () => driver.connected && driver.identity?.groups.get(GROUP)?.groupName === '第二个群名',
      '重连并刷新身份',
    );
  });

  it('协议端一开始就不在:start不reject,起来后自动连上', async () => {
    const probe = makeMock();
    const port = await probe.start();
    await probe.close();

    const driver = makeDriver(port);
    await driver.start(); // 首次失败也resolve
    expect(driver.connected).toBe(false);

    const mock = makeMock(port);
    await mock.start();
    await driver.waitReady(5000);
    expect(driver.connected).toBe(true);
  });

  it('连接尝试尚未结束时stop，start Promise也会收口', async () => {
    const probe = makeMock();
    const port = await probe.start();
    await probe.close();

    const driver = makeDriver(port);
    const started = driver.start();
    await driver.stop();

    await expect(
      Promise.race([
        started.then(() => 'settled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 250)),
      ]),
    ).resolves.toBe('settled');
    expect(driver.connected).toBe(false);
  });

  it('未连接时callApi直接reject', async () => {
    const probe = makeMock();
    const port = await probe.start();
    await probe.close();

    const driver = makeDriver(port);
    await driver.start();
    await expect(driver.callApi('get_login_info')).rejects.toThrow('WS未连接');
  });

  it('未知action:callApi reject;callExtension返回ok:false不抛', async () => {
    const mock = makeMock();
    const port = await mock.start();
    const driver = makeDriver(port);
    await driver.start();

    await expect(driver.callApi('no_such_action')).rejects.toThrow('1404');

    const result = await driver.callExtension('no_such_action');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('1404');
  });

  it('带token时发送Authorization头(mock校验通过)', async () => {
    const mock = new MockOneBot({ port: 0, groupId: GROUP, token: 'sekrit' });
    cleanups.push(() => mock.close());
    const port = await mock.start();

    const driver = makeDriver(port, { token: 'sekrit' });
    await driver.start();
    expect(driver.connected).toBe(true);
    expect(driver.identity?.selfId).toBe(5000);
  });
});
