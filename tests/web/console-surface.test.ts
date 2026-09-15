/** 验证只挂框架级 ConsoleSurface、一个贡献页都没有时各端点的行为。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp } from '../../src/web/server.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';

let app: WebApp;
let port: number;
let dir: string;
const base = () => `http://127.0.0.1:${port}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-surface-'));
  // 刻意只给 ConsoleSurface 的必填项 + 几个框架级可选项,一个 provider 都不给
  app = new WebApp({
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    getStatus: () => ({ loop: { estTokens: 1, messageCount: 2 } }),
    run: { pause: () => {}, resume: () => {}, isPaused: () => false },
    log: nullLogger(),
  });
  port = await app.start(0);
});

afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('只挂框架级 ConsoleSurface', () => {
  it('框架自己的端点照常工作', async () => {
    for (const p of ['/api/status', '/api/events', '/api/log', '/api/storage', '/api/worlds']) {
      const r = await fetch(`${base()}${p}`);
      expect([p, r.status]).toEqual([p, 200]);
    }
    expect((await fetch(`${base()}/api/run/pause`, { method: 'POST' })).status).toBe(200);
  });

  it('页面本身能拿到(前端按端点可用性自己降级)', async () => {
    const r = await fetch(`${base()}/`);
    expect(r.status).toBe(200);
  });

  it('没有声明的 Provider 与旧全局报价端点均不存在', async () => {
    const manifest = (await (await fetch(`${base()}/api/console/manifest`)).json()) as { providers: unknown[] };
    expect(manifest.providers).toEqual([]);
    expect((await fetch(`${base()}/api/console/providers/world%3Aqq/panels/roster/get`)).status).toBe(404);
    expect((await fetch(`${base()}/api/pricing`)).status).toBe(404);
  });

  it('能力清单如实报出"什么都没挂",前端据此不渲染而不是显示一串 503', async () => {
    const d = (await (await fetch(`${base()}/api/capabilities`)).json()) as { capabilities: Record<string, boolean> };
    expect(d.capabilities.run).toBe(true);
    // 框架能力未挂载时如实报 false；Provider 控制面由 manifest 声明。
    for (const k of ['debug', 'sessions', 'storage', 'usage', 'config', 'worlds', 'prompts', 'toolSchemas', 'sessionControl']) {
      expect([k, d.capabilities[k]]).toEqual([k, false]);
    }
    for (const k of ['chat', 'modulePanels', 'persona', 'checkpoints', 'reset', 'dream']) {
      expect([k, k in d.capabilities]).toEqual([k, false]);
    }
  });

  it('配置项也是框架级的,但没人声明时同样 503(不是崩)', async () => {
    expect((await fetch(`${base()}/api/config`)).status).toBe(503);
    const r = await fetch(`${base()}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: 'core', values: {} }),
    });
    expect(r.status).toBe(503);
  });
});
