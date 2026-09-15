/**
 * 界面语言随请求走:同一个进程、同一批依赖,两个浏览器各按自己的语言拿到服务端文案。
 *
 * 真 WebApp + 真 TerminalWorld:HTTP 看 `x-cortico-language` 头,WebSocket 握手看 `?language=`。
 * 没带 = 部署默认语言(这里构造成 zh)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { WebApp } from '../../src/web/server.ts';
import { TerminalWorld } from '../../src/worlds/terminal/world.ts';
import { ioPageContribution } from '../../src/bot.ts';
import {
  CONSOLE_LANGUAGE_HEADER, CONSOLE_LANGUAGE_QUERY, panelStreamRoute,
  type ConsoleManifest,
} from '../../src/web/shared/console-protocol.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { Language } from '../../src/core/language.ts';
import { FakeHost } from './fakes.ts';

let app: WebApp;
let port: number;
let host: FakeHost;
let world: TerminalWorld;
let dir: string;

const base = () => `http://127.0.0.1:${port}`;
const headers = (language?: Language): Record<string, string> =>
  language ? { [CONSOLE_LANGUAGE_HEADER]: language } : {};
const getJson = async <T>(path: string, language?: Language): Promise<T> =>
  (await fetch(`${base()}${path}`, { headers: headers(language) })).json() as Promise<T>;
const postJson = async <T>(path: string, language?: Language): Promise<T> =>
  (await fetch(`${base()}${path}`, { method: 'POST', headers: headers(language) })).json() as Promise<T>;

/** 连一条终端流,等第一帧(开场白)回来。 */
async function firstFrame(query: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${panelStreamRoute('world:terminal', 'chat')}${query}`);
  const text = await new Promise<string>((res, rej) => {
    ws.once('message', (d) => res(String((JSON.parse(d.toString()) as { text: string }).text)));
    ws.once('error', rej);
  });
  ws.close();
  return text;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-language-'));
  host = new FakeHost();
  world = new TerminalWorld({ timezone: 'Asia/Shanghai' });
  await world.start(host);
  app = new WebApp({
    store: host.store,
    memoryDir: dir,
    dataDir: dir,
    language: 'zh',
    getStatus: () => ({}),
    run: { pause: () => {}, resume: () => {}, isPaused: () => false },
    storage: (language) => [{
      key: 'demo', owner: 'core', kind: 'memory', label: language === 'en' ? 'Demo' : '演示',
      stat: () => '', clear: () => (language === 'en' ? 'cleared' : '已清'),
    }],
    consolePageSources: () => [{
      id: 'world:terminal',
      contribute: (language) => ioPageContribution('terminal', '终端对话', undefined, world, language),
    }],
    log: nullLogger(),
  });
  port = await app.start(0);
});

afterAll(async () => {
  await world.stop();
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('每个请求自带界面语言', () => {
  it('HTTP 头选语言;没带头 = 部署默认', async () => {
    const zh = await postJson<{ result: string }>('/api/run/pause');
    const en = await postJson<{ result: string }>('/api/run/pause', 'en');
    expect(zh.result).toBe('已暂停:事件照常落库排队,不投递唤醒');
    expect(en.result).toBe('Paused: events are still stored and queued, no wake is delivered');
  });

  it('manifest 里贡献方的文案按请求语言现算,页 id 不变', async () => {
    const zh = await getJson<ConsoleManifest>('/api/console/manifest', 'zh');
    const en = await getJson<ConsoleManifest>('/api/console/manifest', 'en');
    expect(zh.providers.map((p) => p.id)).toEqual(en.providers.map((p) => p.id));
    expect(zh.providers[0].label).toBe('终端对话');
    expect(en.providers[0].label).toBe('Terminal chat');
    expect(en.providers[0].panels?.[0]?.title).toBe('Chat');
  });

  it('存储清单与清除回执按请求语言', async () => {
    const zh = await getJson<{ parts: Array<{ label: string }> }>('/api/storage');
    const en = await getJson<{ parts: Array<{ label: string }> }>('/api/storage', 'en');
    expect(zh.parts[0].label).toBe('演示');
    expect(en.parts[0].label).toBe('Demo');
    const cleared = await postJson<{ result: string }>('/api/storage/clear?key=demo', 'en');
    expect(cleared.result).toBe('cleared');
  });

  it('WebSocket 握手的查询串选语言,那条流上的系统提示按它给', async () => {
    expect(await firstFrame('')).toContain('报上名字');
    expect(await firstFrame(`?${CONSOLE_LANGUAGE_QUERY}=en`)).toContain('introduce yourself');
    // 不认识的值当没带
    expect(await firstFrame(`?${CONSOLE_LANGUAGE_QUERY}=fr`)).toContain('报上名字');
  });
});
