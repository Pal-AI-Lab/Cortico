import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp } from '../../src/web/server.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { Logger } from '../../src/core/types.ts';
import { FakeStore } from './fakes.ts';

function call(port: number, opts: { method?: string; path?: string; host?: string; origin?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: opts.path ?? '/api/status', method: opts.method ?? 'GET',
      headers: { ...(opts.host ? { Host: opts.host } : {}), ...(opts.origin ? { Origin: opts.origin } : {}) },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end();
  });
}

describe('WebApp 监听地址与对外名字', () => {
  let app: WebApp | null = null;
  let dir = '';
  afterEach(async () => {
    if (app) await app.stop();
    app = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  async function start(extra: { host?: string; allowedHosts?: string[]; log?: Logger } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'web-bind-'));
    let paused = false;
    app = new WebApp({
      store: new FakeStore(), memoryDir: dir, dataDir: dir, getStatus: () => ({}), log: extra.log ?? nullLogger(),
      run: { pause: () => { paused = true; }, resume: () => { paused = false; }, isPaused: () => paused },
      ...(extra.host ? { host: extra.host } : {}),
      ...(extra.allowedHosts ? { allowedHosts: extra.allowedHosts } : {}),
    });
    return app.start(0);
  }

  it('缺省只监听回环,域名 Host 回 421', async () => {
    const port = await start();
    expect(app!.boundAddress).toBe('127.0.0.1');
    expect(await call(port, { host: `bot.example.test:${port}` })).toBe(421);
  });

  it('allowedHosts 里的名字作 Host 被接受,不带端口的条目匹配任意端口', async () => {
    const port = await start({ allowedHosts: ['Bot.Example.test'] });
    expect(await call(port, { host: `bot.example.test:${port}` })).toBe(200);
    expect(await call(port, { host: 'bot.example.test' })).toBe(200);
    expect(await call(port, { host: 'other.example.test' })).toBe(421);
  });

  it('反向代理改写 Host 时,allowedHosts 里的名字作 Origin 的写请求放行,别的 Origin 仍被拒', async () => {
    const port = await start({ allowedHosts: ['bot.example.test'] });
    const upstream = `127.0.0.1:${port}`;
    expect(await call(port, { method: 'POST', path: '/api/run/pause', host: upstream, origin: 'https://bot.example.test' })).toBe(200);
    expect(await call(port, { method: 'POST', path: '/api/run/pause', host: upstream, origin: 'https://evil.example.test' })).toBe(403);
  });

  it('监听 0.0.0.0 时绑定所有网卡,不校验 Host,并记一条没有设访问密码的 warn', async () => {
    const warns: string[] = [];
    const log: Logger = { ...nullLogger(), warn: (msg) => { warns.push(msg); } };
    const port = await start({ host: '0.0.0.0', log });
    expect(app!.boundAddress).toBe('0.0.0.0');
    expect(await call(port, { host: 'anything.example.test' })).toBe(200);
    expect(warns.some((msg) => msg.includes('没有设访问密码'))).toBe(true);
  });

  it('缺省监听回环时不记这条 warn', async () => {
    const warns: string[] = [];
    await start({ log: { ...nullLogger(), warn: (msg) => { warns.push(msg); } } });
    expect(warns).toEqual([]);
  });
});
