import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ioPageContribution } from '../../../src/bot.ts';
import type { WorldHost } from '../../../src/core/types.ts';
import type { LiveStatus } from '../../../src/worlds/bilibili/client.ts';
import { BrowserLogin } from '../../../src/worlds/bilibili/login.ts';
import { BilibiliWorld } from '../../../src/worlds/bilibili/world.ts';

/** 浏览器里复制出来的 SESSDATA 就带 `%2C` 与 `*`,写回配置的必须是这个原样。 */
const RAW_SESSDATA = 'a1b2c3d4%2C1790000000%2Cef56a*21';

interface PollReply {
  code: number;
  cookies?: string[];
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('浏览器确认登录', () => {
  it('确认后把 Set-Cookie 里的 SESSDATA 原样写回，面板读到成功与 uid', async () => {
    const passport = await fakePassport([
      { code: 86101 },
      {
        code: 0,
        cookies: [
          `SESSDATA=${RAW_SESSDATA}; Path=/; Domain=bilibili.com; HttpOnly; Secure`,
          'bili_jct=0123abcd; Path=/; Domain=bilibili.com',
          'DedeUserID=42; Path=/; Domain=bilibili.com',
        ],
      },
    ]);
    const saved: string[] = [];
    const module = new BilibiliWorld({ roomId: 0, passportBase: passport.base, onSessdata: (value) => saved.push(value) });
    const page = ioPageContribution('bilibili', 'B 站直播间', undefined, module);

    const started = await page.invoke!('login', 'start', []) as Record<string, unknown>;
    expect(started).toMatchObject({ phase: 'waiting', url: passport.confirmUrl, configured: false });

    await until(() => saved.length > 0, 8000);
    expect(saved).toEqual([RAW_SESSDATA]);
    expect(await page.invoke!('login', 'state', [])).toMatchObject({ phase: 'done', uid: 42, url: null, configured: true });
    expect(passport.polledKeys.every((key) => key === 'key-1')).toBe(true);
  }, 15000);

  it('写回配置失败时这次登录记为失败，仍用旧凭证', async () => {
    const passport = await fakePassport([{ code: 0, cookies: [`SESSDATA=${RAW_SESSDATA}; Path=/`] }]);
    const module = new BilibiliWorld({
      roomId: 0,
      passportBase: passport.base,
      onSessdata: () => { throw new Error('config.json 被占用'); },
    });
    const page = ioPageContribution('bilibili', 'B 站直播间', undefined, module);
    await page.invoke!('login', 'start', []);
    await until(async () => (await page.invoke!('login', 'state', []) as { phase: string }).phase !== 'waiting', 8000);
    expect(await page.invoke!('login', 'state', [])).toMatchObject({
      phase: 'failed',
      error: expect.stringContaining('config.json 被占用'),
      configured: false,
    });
  }, 15000);

  it('登录拿到的凭证接入后仍是匿名时，照已配置凭证的规则报错', async () => {
    const passport = await fakePassport([{ code: 0, cookies: [`SESSDATA=${RAW_SESSDATA}`] }]);
    const anonymous: LiveStatus = {
      phase: 'connected', roomId: 6, realRoomId: 6, title: '测试间', living: false, liveStartedAt: null, selfUid: 0, lastError: null,
    };
    let report: ((status: LiveStatus) => void) | null = null;
    const errors: string[] = [];
    const log = { info: () => {}, warn: () => {}, debug: () => {}, error: (msg: string) => { errors.push(msg); } };
    const module = new BilibiliWorld({
      roomId: 6,
      passportBase: passport.base,
      onSessdata: () => {},
      source: (handlers) => {
        report = handlers.onStatus;
        return { start: async () => {}, stop: async () => {}, current: () => anonymous };
      },
    });
    await module.start({ log: { ...log, child: () => log }, pushCandidate: async () => [] } as unknown as WorldHost);
    try {
      expect(errors).toEqual([]);
      const page = ioPageContribution('bilibili', 'B 站直播间', undefined, module);
      await page.invoke!('login', 'start', []);
      await until(async () => (await page.invoke!('login', 'state', []) as { phase: string }).phase === 'done', 8000);
      report!(anonymous);
      expect(errors).toEqual([expect.stringContaining('登录接口仍返回匿名状态')]);
    } finally {
      await module.stop();
    }
  }, 15000);

  it('链接作废后停止轮询，取消后的迟到结果不再写回', async () => {
    const expiring = await fakePassport([{ code: 86090 }, { code: 86038 }]);
    const login = new BrowserLogin({ passportBase: expiring.base, pollMs: 10, onSessdata: () => {} });
    await login.start();
    await until(() => login.current.phase === 'expired', 3000);
    const polls = expiring.polledKeys.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(expiring.polledKeys.length).toBe(polls);
    expect(login.current.url).toBeNull();

    const late = await fakePassport([{ code: 0, cookies: [`SESSDATA=${RAW_SESSDATA}`] }]);
    const saved: string[] = [];
    const cancelled = new BrowserLogin({ passportBase: late.base, pollMs: 30, onSessdata: (value) => saved.push(value) });
    await cancelled.start();
    cancelled.cancel();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(saved).toEqual([]);
    expect(cancelled.current.phase).toBe('idle');
  });
});

/** 本机假 passport:生成固定的 key,轮询依次回放 `replies`,用完后重复最后一条。 */
async function fakePassport(replies: PollReply[]): Promise<{ base: string; confirmUrl: string; polledKeys: string[] }> {
  const polledKeys: string[] = [];
  const confirmUrl = 'https://account.example.test/h5/scan-web?qrcode_key=key-1';
  let next = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/x/passport-login/web/qrcode/generate') {
      json(response, { code: 0, message: '0', data: { url: confirmUrl, qrcode_key: 'key-1' } });
      return;
    }
    if (url.pathname === '/x/passport-login/web/qrcode/poll') {
      polledKeys.push(url.searchParams.get('qrcode_key') ?? '');
      const reply = replies[Math.min(next, replies.length - 1)];
      next += 1;
      if (reply.cookies) response.setHeader('Set-Cookie', reply.cookies);
      json(response, { code: 0, message: '0', data: { url: '', refresh_token: '', timestamp: 0, code: reply.code, message: '' } });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, confirmUrl, polledKeys };
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
