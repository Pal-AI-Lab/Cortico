import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
/** listen 的旁观钩子:指定端口报 EACCES。node 内建模块的属性不可重定义,只能整 module 代理一次。 */
const netHooks = vi.hoisted(() => ({ deniedPort: null as number | null }));
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  const createServer = ((...args: unknown[]) => {
    const server = (actual.createServer as (...a: unknown[]) => import('node:http').Server)(...args);
    const listen = server.listen.bind(server) as (...a: unknown[]) => import('node:http').Server;
    server.listen = ((...listenArgs: unknown[]) => {
      if (listenArgs[0] !== netHooks.deniedPort) return listen(...listenArgs);
      const denied = Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${String(listenArgs[0])}`), { code: 'EACCES' });
      process.nextTick(() => server.emit('error', denied));
      return server;
    }) as typeof server.listen;
    return server;
  }) as typeof actual.createServer;
  return { ...actual, default: { ...actual, createServer }, createServer };
});
import type { Logger } from '../../../src/core/types.ts';
import { AgentAnnouncementStore } from '../../../src/worlds/bilibili/overlay/announcement.ts';
import { OverlayAssetStore } from '../../../src/worlds/bilibili/overlay/assets.ts';
import {
  BilibiliOverlayServer,
  type BilibiliOverlayEditorActions,
  OverlayEditorConflictError,
} from '../../../src/worlds/bilibili/overlay/server.ts';

const roots: string[] = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as unknown as Logger;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Bilibili Overlay 服务', () => {
  it('只绑定回环地址，页面/SSE/素材同源且不开放 wildcard CORS', async () => {
    const root = tempRoot();
    const assets = new OverlayAssetStore(join(root, 'assets'));
    expect(() => assets.import(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'))).toThrow(
      '只支持 PNG、JPEG、WebP 和 GIF',
    );
    const imported = assets.import(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64'));
    const server = new BilibiliOverlayServer({
      preferredPort: 0,
      assets,
      snapshot: () => ({ design: { schemaVersion: 1 }, agentAnnouncement: { text: '' } }),
      editor: editorActions(assets),
    });
    await server.start(log);
    try {
      expect(server.overlayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/overlay$/);
      expect(server.editorUrl).toBe(`${server.baseUrl}/editor`);
      const editor = await fetch(server.editorUrl);
      expect(editor.status).toBe(200);
      expect(editor.headers.get('access-control-allow-origin')).toBeNull();
      const editorHtml = await editor.text();
      expect(editorHtml).toContain('<!doctype html>');
      expect(editorHtml).toContain('data-mode="styles"');
      expect(editorHtml).toContain('data-mode="components"');
      expect(editorHtml).toContain('data-mode="layout"');
      for (const path of ['/editor/editor.css', '/editor/editor.js']) {
        const asset = await fetch(`${server.baseUrl}${path}`);
        expect(asset.status, path).toBe(200);
        expect(asset.headers.get('access-control-allow-origin'), path).toBeNull();
      }

      const page = await fetch(server.overlayUrl);
      expect(page.status).toBe(200);
      expect(page.headers.get('access-control-allow-origin')).toBeNull();
      expect(await page.text()).toContain('id="stage"');

      const image = await fetch(`${server.baseUrl}/assets/${imported.id}`);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/png');
      expect(image.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await server.stop();
    }
  });

  it('编辑 API 只接受同源 JSON 写入，素材上传后立即可从同源路径读取', async () => {
    const root = tempRoot();
    const assets = new OverlayAssetStore(join(root, 'assets'));
    const actions = editorActions(assets);
    const server = new BilibiliOverlayServer({
      preferredPort: 0,
      assets,
      snapshot: () => ({ design: { schemaVersion: 2 }, agentAnnouncement: { text: '' } }),
      editor: actions,
    });
    await server.start(log);
    try {
      const state = await fetch(`${server.baseUrl}/api/editor/state`);
      expect(state.status).toBe(200);
      expect(state.headers.get('access-control-allow-origin')).toBeNull();
      expect(await state.json()).toMatchObject({ design: { marker: 'initial' }, designRevision: 0 });

      const saved = await fetch(`${server.baseUrl}/api/editor/design`, {
        method: 'PUT',
        headers: {
          Origin: server.baseUrl,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ design: { marker: 'saved' }, baseRevision: 0 }),
      });
      expect(saved.status).toBe(200);
      expect(saved.headers.get('access-control-allow-origin')).toBeNull();
      expect(await saved.json()).toMatchObject({ design: { marker: 'saved' }, designRevision: 1 });
      expect(await (await fetch(`${server.baseUrl}/api/editor/state`)).json()).toMatchObject({
        design: { marker: 'saved' },
        designRevision: 1,
      });

      const stale = await fetch(`${server.baseUrl}/api/editor/design`, {
        method: 'PUT',
        headers: { Origin: server.baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ design: { marker: 'stale' }, baseRevision: 0 }),
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: expect.stringContaining('已被其他编辑') });
      expect(await (await fetch(`${server.baseUrl}/api/editor/state`)).json()).toMatchObject({
        design: { marker: 'saved' },
        designRevision: 1,
      });

      const announcement = await fetch(`${server.baseUrl}/api/editor/announcement`, {
        method: 'PUT',
        headers: { Origin: server.baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '第一版公告', expectedRevision: 0 }),
      });
      expect(announcement.status).toBe(200);
      expect(await announcement.json()).toMatchObject({ text: '第一版公告', revision: 1 });
      const staleAnnouncement = await fetch(`${server.baseUrl}/api/editor/announcement`, {
        method: 'PUT',
        headers: { Origin: server.baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '陈旧公告', expectedRevision: 0 }),
      });
      expect(staleAnnouncement.status).toBe(409);
      expect(await staleAnnouncement.json()).toMatchObject({ error: expect.stringContaining('已被其他写入') });
      expect(await (await fetch(`${server.baseUrl}/api/editor/state`)).json()).toMatchObject({
        agentAnnouncement: { text: '第一版公告', revision: 1 },
      });

      const crossOrigin = await fetch(`${server.baseUrl}/api/editor/design`, {
        method: 'PUT',
        headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ design: { marker: 'stolen' }, baseRevision: 1 }),
      });
      expect(crossOrigin.status).toBe(403);
      expect(await crossOrigin.json()).toEqual({ error: '编辑器写入只接受同源请求' });
      expect(await (await fetch(`${server.baseUrl}/api/editor/state`)).json()).toMatchObject({
        design: { marker: 'saved' },
      });

      const missingOrigin = await fetch(`${server.baseUrl}/api/editor/design`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ design: { marker: 'originless' }, baseRevision: 1 }),
      });
      expect(missingOrigin.status).toBe(403);
      expect(await missingOrigin.json()).toEqual({ error: '编辑器写入只接受同源请求' });
      expect(await (await fetch(`${server.baseUrl}/api/editor/state`)).json()).toMatchObject({
        design: { marker: 'saved' },
        designRevision: 1,
      });

      const wrongType = await fetch(`${server.baseUrl}/api/editor/design`, {
        method: 'PUT',
        headers: { Origin: server.baseUrl, 'Content-Type': 'text/plain' },
        body: JSON.stringify({ design: { marker: 'plain' }, baseRevision: 1 }),
      });
      expect(wrongType.status).toBe(400);
      expect(await wrongType.json()).toMatchObject({ error: expect.stringContaining('application/json') });

      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64');
      const uploaded = await fetch(`${server.baseUrl}/api/editor/assets`, {
        method: 'POST',
        headers: { Origin: server.baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64: png }),
      });
      expect(uploaded.status).toBe(200);
      const uploadBody = await uploaded.json() as { asset: { id: string; mime: string } };
      expect(uploadBody.asset).toMatchObject({ mime: 'image/png' });
      const image = await fetch(`${server.baseUrl}/assets/${uploadBody.asset.id}`);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/png');
    } finally {
      await server.stop();
    }
  });

  it('SSE 新连接只有快照，实时观众与公告走独立增量事件', async () => {
    const root = tempRoot();
    const server = new BilibiliOverlayServer({
      preferredPort: 0,
      assets: new OverlayAssetStore(join(root, 'assets')),
      snapshot: () => ({ design: { marker: 'current' }, agentAnnouncement: { text: '旧公告' } }),
      editor: editorActions(new OverlayAssetStore(join(root, 'assets'))),
    });
    await server.start(log);
    try {
      server.emitAudience({ eventKind: 'danmaku', username: '旧', body: '不重放', avatarUrl: '', facts: { eventKind: 'danmaku' } });
      const stream = await openSse(`${server.baseUrl}/stream`);
      const snapshot = await stream.readUntil('"type":"snapshot"');
      expect(snapshot).toContain('"marker":"current"');
      expect(snapshot).not.toContain('不重放');

      server.emitAudience({ eventKind: 'gift', username: '新', body: '小电视 ×1', avatarUrl: '', facts: { eventKind: 'gift' } });
      expect(await stream.readUntil('小电视 ×1')).toContain('"type":"audience"');

      const announcement = new AgentAnnouncementStore();
      server.emitAnnouncement(announcement.set('新公告', 20));
      expect(await stream.readUntil('新公告')).toContain('"type":"announcement"');
      await stream.close();
    } finally {
      await server.stop();
    }
  });

  it('候选端口 listen 回 EACCES 时试下一个,不当成启动失败', async () => {
    const root = tempRoot();
    const assets = new OverlayAssetStore(join(root, 'assets'));
    const options = {
      assets,
      snapshot: () => ({ design: { schemaVersion: 1 }, agentAnnouncement: { text: '' } }),
      editor: editorActions(assets),
    };
    const blocker = new BilibiliOverlayServer({ preferredPort: 0, ...options });
    await blocker.start(log);
    const busy = Number(new URL(blocker.baseUrl).port);
    const server = new BilibiliOverlayServer({ preferredPort: busy, ...options });
    netHooks.deniedPort = busy + 1;
    try {
      await server.start(log);
      expect(Number(new URL(server.baseUrl).port)).toBeGreaterThan(busy + 1);
    } finally {
      netHooks.deniedPort = null;
      await server.stop();
      await blocker.stop();
    }
  });

  it('偏好端口被占时顺延并记录 warn', async () => {
    const root = tempRoot();
    const assets = new OverlayAssetStore(join(root, 'assets'));
    const blocker = new BilibiliOverlayServer({
      preferredPort: 0,
      assets,
      snapshot: () => ({ design: { schemaVersion: 1 }, agentAnnouncement: { text: '' } }),
      editor: editorActions(assets),
    });
    await blocker.start(log);
    const busy = Number(new URL(blocker.baseUrl).port);

    const warns: string[] = [];
    const recording = {
      info() {}, error() {}, debug() {},
      warn(msg: string) { warns.push(msg); },
      child() { return this; },
    } as unknown as Logger;
    const server = new BilibiliOverlayServer({
      preferredPort: busy,
      assets,
      snapshot: () => ({ design: { schemaVersion: 1 }, agentAnnouncement: { text: '' } }),
      editor: editorActions(assets),
    });
    await server.start(recording);
    try {
      expect(Number(new URL(server.baseUrl).port)).toBeGreaterThan(busy);
      const hit = warns.find((msg) => msg.includes('被占用'));
      expect(hit).toBeDefined();
      expect(hit).toContain(`改用 ${new URL(server.baseUrl).port}`);
    } finally {
      await server.stop();
      await blocker.stop();
    }
  });
});

async function openSse(url: string): Promise<{
  readUntil(text: string): Promise<string>;
  close(): Promise<void>;
}> {
  const response = await fetch(url);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  return {
    async readUntil(text: string): Promise<string> {
      for (let index = 0; index < 20 && !pending.includes(text); index += 1) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
      }
      if (!pending.includes(text)) throw new Error(`SSE 未收到 ${text}`);
      const out = pending;
      pending = '';
      return out;
    },
    async close(): Promise<void> {
      await reader.cancel();
    },
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bilibili-overlay-'));
  roots.push(root);
  return root;
}

function editorActions(assets: OverlayAssetStore): BilibiliOverlayEditorActions {
  let design: unknown = { marker: 'initial' };
  let designRevision = 0;
  let announcement = { text: '', revision: 0 };
  const state = (): Record<string, unknown> => ({
    design,
    designRevision,
    agentAnnouncement: announcement,
    assets: assets.list(null),
  });
  return {
    state,
    saveDesign: async (value, baseRevision) => {
      if (baseRevision !== designRevision) throw new OverlayEditorConflictError('设计已被其他编辑会话更新');
      design = value;
      designRevision++;
      return { ...state(), message: '已保存' };
    },
    importAsset: (value) => {
      const asset = assets.import(typeof value === 'string' ? value : '');
      return { asset, assets: assets.list(null) };
    },
    deleteAsset: (value) => ({ deleted: assets.delete(typeof value === 'string' ? value : '') }),
    setAgentAnnouncement: (value, expectedRevision) => {
      if (expectedRevision !== announcement.revision) {
        throw new OverlayEditorConflictError('公告已被其他写入者更新');
      }
      announcement = { text: String(value), revision: announcement.revision + 1 };
      return announcement;
    },
  };
}
