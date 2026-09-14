import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../../../core/types.ts';
import type { AgentAnnouncementState, OverlayAudienceEvent } from './types.ts';
import { OverlayAssetStore } from './assets.ts';

const STATIC_DIR = fileURLToPath(new URL('./web/', import.meta.url));
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/overlay': { file: 'overlay.html', type: 'text/html; charset=utf-8' },
  '/overlay/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/overlay/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/editor': { file: 'editor.html', type: 'text/html; charset=utf-8' },
  '/editor/editor.js': { file: 'editor.js', type: 'text/javascript; charset=utf-8' },
  '/editor/editor.css': { file: 'editor.css', type: 'text/css; charset=utf-8' },
};
const KEEPALIVE_MS = 15_000;
const SSE_PAD = `: ${' '.repeat(2048)}\n\n`;
const MAX_EDITOR_BODY_BYTES = 12 * 1024 * 1024;
const HOST = '127.0.0.1';

export interface BilibiliOverlayEditorActions {
  state(): Record<string, unknown>;
  saveDesign(value: unknown, baseRevision: unknown): Promise<Record<string, unknown>> | Record<string, unknown>;
  importAsset(value: unknown): Promise<Record<string, unknown>> | Record<string, unknown>;
  deleteAsset(value: unknown): Promise<Record<string, unknown>> | Record<string, unknown>;
  setAgentAnnouncement(value: unknown, expectedRevision: unknown): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export class OverlayEditorConflictError extends Error {}

interface BilibiliOverlayServerOptions {
  preferredPort: number;
  assets: OverlayAssetStore;
  snapshot: () => Record<string, unknown>;
  editor: BilibiliOverlayEditorActions;
}

export class BilibiliOverlayServer {
  private http: Server | null = null;
  private boundPort: number | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private readonly subscribers = new Set<ServerResponse>();
  private seq = 0;

  constructor(private readonly options: BilibiliOverlayServerOptions) {}

  get port(): number {
    return this.boundPort ?? this.options.preferredPort;
  }

  get overlayUrl(): string {
    return `http://${HOST}:${this.port}/overlay`;
  }

  get editorUrl(): string {
    return `http://${HOST}:${this.port}/editor`;
  }

  get baseUrl(): string {
    return `http://${HOST}:${this.port}`;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get running(): boolean {
    return this.http !== null;
  }

  async start(log: Logger): Promise<void> {
    if (this.http) return;
    const preferred = this.options.preferredPort;
    // 顺延上限 5(原为 50):顺延一两个是"上次没退干净",顺延到第 20 个只可能是
    // 有人在反复起实例,继续顺延等于把两个实例都留着跑。
    const attempts = preferred === 0 ? 1 : Math.min(5, 65536 - preferred);
    let lastError: unknown;
    for (let index = 0; index < attempts; index += 1) {
      const port = preferred === 0 ? 0 : preferred + index;
      const server = createServer((request, response) => {
        void this.onRequest(request, response).catch((error: unknown) => {
          if (response.headersSent) {
            response.destroy();
            return;
          }
          this.json(response, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, HOST, () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
        this.http = server;
        this.boundPort = (server.address() as AddressInfo).port;
        // warn 而不是 info:端口顺延是"另一个实例还在跑"最早也最便宜的旁证。
        if (index > 0) {
          log.warn(
            `B站 Overlay 端口 ${preferred} 被占用,改用 ${this.boundPort}`
            + '——如果没在跑第二个实例,说明上一次没退干净',
          );
        }
        break;
      } catch (error) {
        lastError = error;
        server.close();
        if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE' || preferred === 0) throw error;
      }
    }
    if (!this.http) throw lastError instanceof Error ? lastError : new Error('B站 Overlay 没有可用端口');
    this.keepalive = setInterval(() => {
      for (const response of this.subscribers) {
        try {
          response.write(':hb\n\n');
        } catch {
          this.subscribers.delete(response);
          response.destroy();
        }
      }
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();
    log.info(`B站 Overlay 已启动 ${this.overlayUrl}`);
  }

  async stop(): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    for (const response of this.subscribers) response.end();
    this.subscribers.clear();
    const server = this.http;
    this.http = null;
    this.boundPort = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  emitAudience(event: OverlayAudienceEvent): void {
    this.emit('audience', { event });
  }

  emitState(): void {
    this.emit('state', this.options.snapshot());
  }

  emitAnnouncement(agentAnnouncement: AgentAnnouncementState): void {
    this.emit('announcement', { agentAnnouncement });
  }

  private emit(type: string, data: Record<string, unknown>): void {
    if (!this.subscribers.size) return;
    const payload = `id: ${++this.seq}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    for (const response of this.subscribers) {
      if (type === 'audience' && response.writableNeedDrain) continue;
      try {
        response.write(payload);
      } catch {
        this.subscribers.delete(response);
      }
    }
  }

  private async onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseUrl);
    const path = url.pathname === '/' ? '/editor' : url.pathname.replace(/\/$/, '') || '/';
    if (path === '/api/editor/state' && request.method === 'GET') {
      this.json(response, 200, this.options.editor.state());
      return;
    }
    if (path.startsWith('/api/editor/')) {
      await this.onEditorRequest(request, response, path);
      return;
    }
    const staticFile = STATIC_FILES[path];
    if (staticFile && request.method === 'GET') {
      try {
        const body = readFileSync(STATIC_DIR + staticFile.file);
        response.writeHead(200, {
          'Content-Type': staticFile.type,
          'Cache-Control': 'no-cache, no-store',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data: blob:; connect-src 'self'",
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN',
        }).end(body);
      } catch {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('overlay asset unreadable');
      }
      return;
    }
    if (path.startsWith('/assets/') && request.method === 'GET') {
      const id = path.slice('/assets/'.length);
      const asset = this.options.assets.path(id);
      if (!asset) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('asset not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': asset.mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      }).end(readFileSync(asset.path));
      return;
    }
    if (path !== '/stream' || request.method !== 'GET') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('GET /editor | /overlay | /stream');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    response.write(SSE_PAD);
    response.write(`data: ${JSON.stringify({ type: 'snapshot', ...this.options.snapshot() })}\n\n`);
    this.subscribers.add(response);
    response.on('close', () => this.subscribers.delete(response));
  }

  private async onEditorRequest(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (!this.sameOrigin(request)) {
      this.json(response, 403, { error: '编辑器写入只接受同源请求' });
      return;
    }
    try {
      if (path === '/api/editor/design' && request.method === 'PUT') {
        const body = await this.jsonBody(request);
        this.json(response, 200, await this.options.editor.saveDesign(body.design, body.baseRevision));
        return;
      }
      if (path === '/api/editor/assets' && request.method === 'POST') {
        const body = await this.jsonBody(request);
        this.json(response, 200, await this.options.editor.importAsset(body.base64));
        return;
      }
      if (path.startsWith('/api/editor/assets/') && request.method === 'DELETE') {
        this.json(response, 200, await this.options.editor.deleteAsset(decodeURIComponent(path.slice('/api/editor/assets/'.length))));
        return;
      }
      if (path === '/api/editor/announcement' && request.method === 'PUT') {
        const body = await this.jsonBody(request);
        this.json(response, 200, await this.options.editor.setAgentAnnouncement(body.text, body.expectedRevision));
        return;
      }
      this.json(response, 404, { error: '编辑器接口不存在' });
    } catch (error) {
      this.json(response, error instanceof OverlayEditorConflictError ? 409 : 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private sameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return false;
    try {
      return new URL(origin).origin === this.baseUrl;
    } catch {
      return false;
    }
  }

  private async jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      throw new Error('请求必须使用 application/json');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_EDITOR_BODY_BYTES) throw new Error('编辑器请求不能超过 12 MiB');
      chunks.push(bytes);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求正文必须是 JSON 对象');
    return parsed as Record<string, unknown>;
  }

  private json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'X-Content-Type-Options': 'nosniff',
    }).end(JSON.stringify(body));
  }
}
