import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { WebApp } from '../../src/web/server.ts';
import { ConsoleAuth, SESSION_COOKIE, SESSION_COOKIE_MAX_AGE_SEC, cookieValue } from '../../src/web/auth.ts';
import { CONSOLE_AUTH_HEADER } from '../../src/web/shared/console-protocol.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { Logger } from '../../src/core/types.ts';
import { FakeStore } from './fakes.ts';

interface Reply { status: number; body: string; headers: Record<string, string | string[] | undefined> }

function call(port: number, opts: { method?: string; path: string; cookie?: string; json?: unknown; raw?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.raw ?? (opts.json === undefined ? undefined : JSON.stringify(opts.json));
    const req = request({
      host: '127.0.0.1', port, path: opts.path, method: opts.method ?? 'GET',
      headers: {
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function socketOpens(url: string, cookie?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, cookie ? { headers: { Cookie: cookie } } : {});
    ws.once('open', () => { ws.close(); resolve(true); });
    ws.once('error', () => resolve(false));
    ws.once('unexpected-response', (_req, res) => { res.resume(); resolve(false); });
  });
}

/** Set-Cookie 头里的 `名=值` 那一段,可直接作 Cookie 请求头。 */
function sessionOf(reply: Reply): string {
  const header = ([] as string[]).concat(reply.headers['set-cookie'] ?? [])[0] ?? '';
  return header.split(';')[0];
}

describe('ConsoleAuth', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
  const keyFile = () => join((dir = dir || mkdtempSync(join(tmpdir(), 'web-auth-unit-'))), 'web-auth.key');

  it('密码为空时不启用', () => {
    expect(new ConsoleAuth('', keyFile()).enabled).toBe(false);
    expect(new ConsoleAuth('x', keyFile()).enabled).toBe(true);
  });

  it('令牌认密码与数据目录:同目录同密码的新实例认它,被改动、换了密码或换了目录都不认', () => {
    const file = keyFile();
    const auth = new ConsoleAuth('first', file);
    const token = auth.issue();
    expect(auth.verify(token)).toBe(true);
    expect(new ConsoleAuth('first', file).verify(token)).toBe(true);
    expect(auth.verify(`${token}0`)).toBe(false);
    expect(auth.verify('')).toBe(false);
    expect(auth.verify(null)).toBe(false);
    expect(new ConsoleAuth('second', file).verify(token)).toBe(false);
    expect(new ConsoleAuth('first', join(dir, 'other.key')).verify(token)).toBe(false);
  });

  it('错误的登录串行等待:三次并发失败耗时不少于三个延迟,正确的密码不排队', async () => {
    const auth = new ConsoleAuth('right', keyFile(), 40);
    const started = Date.now();
    const wrong = Promise.all([auth.login('a'), auth.login('b'), auth.login('c')]);
    expect(await auth.login('right')).toBe(true);
    expect(Date.now() - started).toBeLessThan(40);
    expect(await wrong).toEqual([false, false, false]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(115);
  });

  it('cookieValue 取指定名字的值', () => {
    expect(cookieValue(`a=1; ${SESSION_COOKIE}=tok.en; b=2`, SESSION_COOKIE)).toBe('tok.en');
    expect(cookieValue('a=1', SESSION_COOKIE)).toBeNull();
    expect(cookieValue(undefined, SESSION_COOKIE)).toBeNull();
  });
});

describe('WebApp 访问密码', () => {
  let app: WebApp | null = null;
  let dir = '';
  afterEach(async () => {
    if (app) await app.stop();
    app = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  async function start(password: string, reuseDir = false): Promise<number> {
    if (!reuseDir) dir = mkdtempSync(join(tmpdir(), 'web-auth-'));
    app = new WebApp({
      store: new FakeStore(), memoryDir: dir, dataDir: dir, getStatus: () => ({}), log: nullLogger(),
      sessions: { list: () => [], messages: () => null, onChange: () => {} },
      password, failedLoginDelayMs: 0,
    });
    return app.start(0);
  }

  it('没设密码:接口照常放行,不出登录页,状态报告不要求登录', async () => {
    const port = await start('');
    expect((await call(port, { path: '/api/status' })).status).toBe(200);
    expect((await call(port, { path: '/' })).body).not.toContain('id="login"');
    expect(JSON.parse((await call(port, { path: '/api/auth/status' })).body)).toEqual({ required: false, authenticated: true });
    expect(await socketOpens(`ws://127.0.0.1:${port}/ws/sessions`)).toBe(true);
  });

  it('设了密码而未登录:入口给登录页,接口回 401 并带标记头,WebSocket 连不上', async () => {
    const port = await start('open sesame');
    const home = await call(port, { path: '/' });
    expect(home.status).toBe(200);
    expect(home.body).toContain('id="login"');
    const api = await call(port, { path: '/api/status' });
    expect(api.status).toBe(401);
    expect(api.headers[CONSOLE_AUTH_HEADER]).toBe('required');
    expect((await call(port, { path: '/login.html' })).status).toBe(401);
    expect(JSON.parse((await call(port, { path: '/api/auth/status' })).body)).toEqual({ required: true, authenticated: false });
    expect(await socketOpens(`ws://127.0.0.1:${port}/ws/sessions`)).toBe(false);
  });

  it('未登录的大请求体在解析之前就被 401 挡下', async () => {
    const port = await start('open sesame');
    const reply = await call(port, { method: 'POST', path: '/api/console/providers/x/panels/y/z', raw: '{"args":[' });
    expect(reply.status).toBe(401);
  });

  it('密码不对回 401 且不发 Cookie;密码对了发 HttpOnly、SameSite=Strict 的 Cookie,凭它访问接口与 WebSocket', async () => {
    const port = await start('open sesame');
    const wrong = await call(port, { method: 'POST', path: '/api/auth/login', json: { password: 'nope' } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const ok = await call(port, { method: 'POST', path: '/api/auth/login', json: { password: 'open sesame' } });
    expect(ok.status).toBe(200);
    const header = ([] as string[]).concat(ok.headers['set-cookie'] ?? [])[0];
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_SEC}`);
    expect(header).not.toContain('Secure');

    const cookie = sessionOf(ok);
    expect((await call(port, { path: '/api/status', cookie })).status).toBe(200);
    expect((await call(port, { path: '/', cookie })).body).not.toContain('id="login"');
    expect(await socketOpens(`ws://127.0.0.1:${port}/ws/sessions`, cookie)).toBe(true);
  });

  it('反向代理报告 HTTPS 时 Cookie 带 Secure', async () => {
    const port = await start('open sesame');
    const reply = await new Promise<Reply>((resolve, reject) => {
      const payload = JSON.stringify({ password: 'open sesame' });
      const req = request({
        host: '127.0.0.1', port, path: '/api/auth/login', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Forwarded-Proto': 'https' },
      }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: '', headers: res.headers })); });
      req.on('error', reject);
      req.end(payload);
    });
    expect(([] as string[]).concat(reply.headers['set-cookie'] ?? [])[0]).toContain('; Secure');
  });

  it('登录态跨进程重启保留;退出登录清掉 Cookie', async () => {
    let port = await start('open sesame');
    const cookie = sessionOf(await call(port, { method: 'POST', path: '/api/auth/login', json: { password: 'open sesame' } }));
    await app!.stop();
    port = await start('open sesame', true);
    expect((await call(port, { path: '/api/status', cookie })).status).toBe(200);

    const out = await call(port, { method: 'POST', path: '/api/auth/logout', cookie });
    expect(([] as string[]).concat(out.headers['set-cookie'] ?? [])[0]).toContain('Max-Age=0');
  });

  it('改了密码之后旧登录态失效', async () => {
    let port = await start('first');
    const cookie = sessionOf(await call(port, { method: 'POST', path: '/api/auth/login', json: { password: 'first' } }));
    await app!.stop();
    port = await start('second', true);
    expect((await call(port, { path: '/api/status', cookie })).status).toBe(401);
  });
});

/** 本机一块非回环网卡的 IPv4;经它连进来的对端地址不是回环。 */
const lanAddress = Object.values(networkInterfaces()).flat()
  .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;

describe('WebApp 明文登录的 warn', () => {
  let app: WebApp | null = null;
  let dir = '';
  afterEach(async () => {
    if (app) await app.stop();
    app = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function login(host: string, port: number, forwardedProto?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ password: 'open sesame' });
      const req = request({
        host, port, path: '/api/auth/login', method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
          ...(forwardedProto ? { 'X-Forwarded-Proto': forwardedProto } : {}),
        },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject);
      req.end(payload);
    });
  }

  it.skipIf(!lanAddress)('非回环对端经明文登录记 warn;回环对端或反向代理报告 HTTPS 时不记', async () => {
    dir = mkdtempSync(join(tmpdir(), 'web-auth-plain-'));
    const warns: string[] = [];
    const log: Logger = { ...nullLogger(), warn: (msg) => { warns.push(msg); } };
    app = new WebApp({
      store: new FakeStore(), memoryDir: dir, dataDir: dir, getStatus: () => ({}), log,
      host: '0.0.0.0', password: 'open sesame', failedLoginDelayMs: 0,
    });
    const port = await app.start(0);
    const plain = (): number => warns.filter((msg) => msg.includes('明文连接')).length;

    expect(await login('127.0.0.1', port)).toBe(200);
    expect(plain()).toBe(0);
    expect(await login(lanAddress!, port, 'https')).toBe(200);
    expect(plain()).toBe(0);
    expect(await login(lanAddress!, port)).toBe(200);
    expect(plain()).toBe(1);
  });
});
