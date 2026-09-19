/**
 * 控制台 listen:固定端口被占时顺延到下一个空闲端口。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp } from '../../src/web/server.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';

// 占位服务器绑同一个地址(控制台只绑回环):不同地址不算冲突,顺延也就不会触发
function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

describe('WebApp.listen 端口顺延', () => {
  const apps: WebApp[] = [];
  const blockers: Server[] = [];
  let dir: string;

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop();
    await Promise.all(
      blockers.splice(0).map(
        (s) => new Promise<void>((res) => s.close(() => res())),
      ),
    );
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const warns: string[] = [];

  function makeApp(): WebApp {
    dir = mkdtempSync(join(tmpdir(), 'webtest-listen-'));
    const log = nullLogger();
    const app = new WebApp({
      store: new FakeStore(),
      memoryDir: dir,
      dataDir: dir,
      getStatus: () => ({}),
      log: { ...log, child: () => log, warn: (msg: string) => { warns.push(msg); } } as typeof log,
    });
    apps.push(app);
    return app;
  }

  it('目标端口空闲时用该端口', async () => {
    const probe = createServer();
    blockers.push(probe);
    const free = await listen(probe);
    await new Promise<void>((res) => probe.close(() => res()));
    blockers.pop();

    const actual = await makeApp().start(free);
    expect(actual).toBe(free);
  });

  it('偏好端口是 65535 且不可用:候选不越过 65535,抛出的是监听错误而不是非法端口', async ({ skip }) => {
    const blocker = createServer();
    try {
      await listen(blocker, 65535);
      blockers.push(blocker);
    } catch (err) {
      // 别的进程占着 65535 时它同样不可用;回别的错误码的机器上走不到这条路径。
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') skip();
    }
    await expect(makeApp().start(65535)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('目标端口被占时改用下一个空闲端口', async () => {
    const blocker = createServer();
    blockers.push(blocker);
    const busy = await listen(blocker);

    const actual = await makeApp().start(busy);
    expect(actual).not.toBe(busy);
    expect(actual).toBeGreaterThan(busy);
    // 端口顺延须以 warn 级别报告。
    const hit = warns.find((m) => m.includes('被占用'));
    expect(hit).toBeDefined();

  });
});
