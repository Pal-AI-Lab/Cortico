/**
 * /api/storage 与 /api/storage/clear 测试:fake StoragePart清单。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp, type OwnedStoragePart } from '../../src/web/server.ts';
import { nowIso, nullLogger } from '../../src/core/util.ts';
import { createBot } from '../../src/bot.ts';
import { LANGUAGES } from '../../src/core/language.ts';
import type { WorldHost } from '../../src/core/types.ts';
import { USAGE_LOG_FILE, WORLD_USAGE_ROLE_PREFIX } from '../../src/core/usage-log.ts';
import { WORLD_ACTIVITY_LOG_FILE, WORLD_ACTIVITY_MINUTE_MS } from '../../src/core/world-activity-log.ts';
import { WEBUI_LANGUAGE_HEADER } from '../../src/web/shared/webui-protocol.ts';
import { FakeLLM, makeCfg, makeFakeIO, makeFakePersona, makeLoaded, makeTmpDir } from '../core/helpers.ts';
import { FakeStore } from './fakes.ts';

let app: WebApp;
let port: number;
let dir: string;
let cleared: string[] = [];

const parts: OwnedStoragePart[] = [
  {
    key: 'session',
    owner: 'core',
    label: '主session',
    kind: 'disk',
    danger: true,
    order: 10, // 一键清空时最后执行
    stat: () => '10条',
    clear: () => {
      cleared.push('session');
      return 'session已重开';
    },
  },
  {
    key: 'events',
    owner: 'core',
    label: '事件库',
    kind: 'disk',
    location: 'data/events.jsonl',
    danger: true,
    note: '经历全抹除',
    stat: () => '42条',
    clear: () => {
      cleared.push('events');
      return '已清除42条';
    },
  },
  {
    key: 'tracker',
    owner: 'core',
    label: 'session统计',
    kind: 'memory',
    stat: () => '3个session',
    clear: async () => {
      cleared.push('tracker');
      return '统计已清零';
    },
  },
  {
    key: 'broken',
    owner: 'world:sample',
    label: '会失败的部分',
    kind: 'memory',
    stat: () => {
      throw new Error('统计炸了');
    },
    clear: () => {
      throw new Error('清除炸了');
    },
  },
];

const base = () => `http://127.0.0.1:${port}`;
const req = async (url: string, method = 'GET'): Promise<{ status: number; body: any }> => {
  const r = await fetch(url, { method });
  return { status: r.status, body: (await r.json()) as any };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-storage-'));
  app = new WebApp({
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    getStatus: () => ({}),
    storage: () => parts,
    log: nullLogger(),
  });
  port = await app.start(0);
});

afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/storage', () => {
  it('列出各部分:key/label/kind/owner/danger/stat;统计异常不炸整个列表', async () => {
    const { status, body } = await req(`${base()}/api/storage`);
    expect(status).toBe(200);
    expect(body.parts).toHaveLength(4);

    const ev = body.parts.find((p: any) => p.key === 'events');
    expect(ev.kind).toBe('disk');
    expect(ev.danger).toBe(true);
    expect(ev.stat).toBe('42条');
    expect(ev.location).toBe('data/events.jsonl');
    expect(ev.owner).toBe('core');
    expect(body.parts.find((p: any) => p.key === 'broken').owner).toBe('world:sample');

    const tr = body.parts.find((p: any) => p.key === 'tracker');
    expect(tr.kind).toBe('memory');
    expect(tr.danger).toBe(false);

    const broken = body.parts.find((p: any) => p.key === 'broken');
    expect(broken.stat).toContain('统计失败');
  });
});

describe('POST /api/storage/clear', () => {
  it('lists both usage ledgers in every language and clears both files and active counts together', async () => {
    const tmp = makeTmpDir();
    const config = makeCfg({ providers: {}, activeProvider: '' });
    config.web.port = 0;
    const dataDir = join(tmp.dir, 'data');
    const loaded = makeLoaded({ config, rootDir: tmp.dir, memoryDir: join(tmp.dir, 'memory'), dataDir });
    let host!: WorldHost;
    const world = { ...makeFakeIO('sample'), start: async (value: WorldHost) => { host = value; } };
    const bot = createBot(loaded, {
      id: 'fixture',
      defaults: () => config,
      build: () => ({ persona: makeFakePersona([], { silent: true }), worlds: [world], llm: new FakeLLM() }),
    });
    try {
      const { port } = await bot.start();
      const url = `http://127.0.0.1:${port}/api/storage`;
      const files = [USAGE_LOG_FILE, WORLD_ACTIVITY_LOG_FILE];
      await Promise.all(LANGUAGES.map(async language => {
        const response = await fetch(url, { headers: { [WEBUI_LANGUAGE_HEADER]: language } });
        expect(response.status).toBe(200);
        const { parts } = await response.json() as { parts: Array<Pick<OwnedStoragePart, 'key' | 'owner' | 'location' | 'note'>> };
        const part = parts.find(part => part.key === 'usage' && part.owner === 'core');
        expect(part?.location).toBe(files.map(file => `data/${file}`).join(', '));
        for (const file of files) expect(part?.note).toContain(file);
      }));

      bot.core.worldActivityLog.record(world.id, 'events', Date.now() - WORLD_ACTIVITY_MINUTE_MS);
      await host.pushEvent({ source: world.id, type: 'sample.note', ts: nowIso(config.timezone), text: 'archive' }, { deliver: false });
      host.reportUsage({ promptTokens: 12, completionTokens: 3, cacheHitTokens: 0, cacheMissTokens: 12 }, { model: 'fixture-model' });
      expect(await bot.core.usageLog.readAll()).toEqual([
        expect.objectContaining({ role: WORLD_USAGE_ROLE_PREFIX + world.id }),
      ]);
      for (const file of files) expect(readFileSync(join(dataDir, file), 'utf8').trim()).toBeTruthy();

      const response = await fetch(`${url}/clear?owner=core&key=usage`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
      for (const file of files) expect(readFileSync(join(dataDir, file), 'utf8')).toBe('');
      expect(await bot.core.usageLog.readAll()).toEqual([]);
      expect(await bot.core.worldActivityLog.readAll()).toEqual([]);
    } finally {
      await bot.stop();
      tmp.cleanup();
    }
  });

  it('同步与异步clear都执行并返回结果描述', async () => {
    cleared = [];
    const r1 = await req(`${base()}/api/storage/clear?key=events`, 'POST');
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ ok: true, result: '已清除42条' });

    const r2 = await req(`${base()}/api/storage/clear?key=tracker`, 'POST');
    expect(r2.status).toBe(200);
    expect(r2.body.result).toBe('统计已清零');
    expect(cleared).toEqual(['events', 'tracker']);
  });

  it('未知key→404;缺key→400;clear抛错→500', async () => {
    expect((await req(`${base()}/api/storage/clear?key=nope`, 'POST')).status).toBe(404);
    expect((await req(`${base()}/api/storage/clear`, 'POST')).status).toBe(400);
    const r = await req(`${base()}/api/storage/clear?key=broken`, 'POST');
    expect(r.status).toBe(500);
    expect(r.body.error).toContain('清除炸了');
  });

  it('clear-all:按order升序执行(session最后),坏部分不中断其余', async () => {
    cleared = [];
    const { status, body } = await req(`${base()}/api/storage/clear-all`, 'POST');
    expect(status).toBe(200);
    expect(body.ok).toBe(false); // broken那项失败
    expect(body.results).toHaveLength(4);
    // order=0的按数组序在前,session(order=10)最后
    expect(cleared).toEqual(['events', 'tracker', 'session']);
    const last = body.results[body.results.length - 1];
    expect(last.key).toBe('session');
    expect(last.ok).toBe(true);
    const broken = body.results.find((r: any) => r.key === 'broken');
    expect(broken.ok).toBe(false);
  });

  it('未挂载storage清单→空列表', async () => {
    const bare = new WebApp({
      store: new FakeStore(),
      memoryDir: dir,
      dataDir: dir,
      getStatus: () => ({}),
      log: nullLogger(),
    });
    const p2 = await bare.start(0);
    const { body } = await req(`http://127.0.0.1:${p2}/api/storage`);
    expect(body.parts).toEqual([]);
    expect((await req(`http://127.0.0.1:${p2}/api/storage/clear?key=x`, 'POST')).status).toBe(404);
    await bare.stop();
  });
});

describe('两个 World 声明同名 key', () => {
  it('带 owner 只清那一个 World 的;不带 owner 回 409 并列出归属', async () => {
    const hits: string[] = [];
    const same = (owner: OwnedStoragePart['owner']): OwnedStoragePart => ({
      key: 'log', owner, label: `${owner} 日志`, kind: 'disk', stat: () => '1条',
      clear: () => { hits.push(owner); return `${owner} 已清`; },
    });
    const twin = new WebApp({
      store: new FakeStore(),
      memoryDir: dir,
      dataDir: dir,
      getStatus: () => ({}),
      storage: () => [same('world:a'), same('world:b')],
      log: nullLogger(),
    });
    const p2 = await twin.start(0);
    const r = await req(`http://127.0.0.1:${p2}/api/storage/clear?owner=world:b&key=log`, 'POST');
    expect(r.body).toEqual({ ok: true, result: 'world:b 已清' });
    expect(hits).toEqual(['world:b']);
    const ambiguous = await req(`http://127.0.0.1:${p2}/api/storage/clear?key=log`, 'POST');
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error).toContain('world:a, world:b');
    expect(hits).toEqual(['world:b']);
    await twin.stop();
  });
});
