/** API 客户端行为测试使用脚本化 fetch。变量动态 import 隔离根 tsconfig 的 Node 类型检查，浏览器类型由 tsconfig.web.json 检查。 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const API_SPEC = '../../src/web/client/core/api.ts';
const BUNDLE_SPEC = '../../src/web/shared/client-panel.ts';

/** 手写的模块视图。DOM 类型在这一遍不可用，故一律降级成结构等价的宽类型。 */
interface ApiModule {
  get<T>(path: string, opts?: { signal?: unknown }): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: { signal?: unknown }): Promise<T>;
  fetchManifest(opts?: { signal?: unknown }): Promise<unknown>;
  invokePanel<T>(p: string, panel: string, m: string, args?: unknown[], opts?: unknown): Promise<T>;
  invokePanelBinary(p: string, panel: string, m: string, args?: unknown[], opts?: unknown): Promise<unknown>;
  pickPath(options: Record<string, unknown>, opts?: unknown): Promise<string | null>;
  setConfig(groupId: string, values: Record<string, unknown>, opts?: unknown): Promise<string>;
}

interface InvokeErrorCtor {
  new (message: string, status: number): Error & { status: number };
}

const api = (await import(API_SPEC)) as ApiModule;
const { WebUiInvokeError } = (await import(BUNDLE_SPEC)) as { WebUiInvokeError: InvokeErrorCtor };

/** 一次调用的记录，用来断言方法/头/body。 */
interface Call {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown };
}

const calls: Call[] = [];

/** 装一个按脚本回应的假 fetch。`reply` 返回 Response 或直接抛。 */
function stubFetch(reply: (url: string, init: Call['init']) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', (url: unknown, init: unknown) => {
    const rec: Call = { url: String(url), init: (init ?? {}) as Call['init'] };
    calls.push(rec);
    try {
      return Promise.resolve(reply(rec.url, rec.init));
    } catch (err) {
      return Promise.reject(err);
    }
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 断言并取回 WebUiInvokeError（`rejects.toThrow` 拿不到 status）。 */
async function catchErr(p: Promise<unknown>): Promise<Error & { status?: number }> {
  try {
    await p;
  } catch (err) {
    return err as Error & { status?: number };
  }
  throw new Error('期望抛错，但成功返回了');
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe('web client api —— 正常返回', () => {
  it('2xx JSON 原样解析', async () => {
    stubFetch(() => json({ ok: true, n: 3 }));
    const out = await api.get<{ ok: boolean; n: number }>('/api/x');
    expect(out).toEqual({ ok: true, n: 3 });
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('post 走 application/json 并序列化传进来的 body', async () => {
    stubFetch(() => json({ done: 1 }));
    await api.post('/api/y', { a: [1, 2] });
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(calls[0]?.init.body).toBe('{"a":[1,2]}');
  });

  it('每个请求都带界面语言头(没有印章的环境是中文)', async () => {
    stubFetch(() => json({}));
    await api.get('/api/x');
    await api.post('/api/y', {});
    for (const call of calls) expect(call.init.headers).toMatchObject({ 'x-cortico-language': 'zh' });
  });

  it('fetchManifest 打的是协议规定的 manifest 路由', async () => {
    stubFetch(() => json({ protocolVersion: 1, providers: [], framework: { capabilities: {} } }));
    const m = await api.fetchManifest();
    expect(calls[0]?.url).toBe('/api/webui/manifest');
    expect(m).toMatchObject({ protocolVersion: 1 });
  });

  it('204 与空 body 都返回 null，不在 JSON.parse 上炸', async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    expect(await api.get('/api/void')).toBeNull();

    vi.unstubAllGlobals();
    stubFetch(() => new Response('', { status: 200 }));
    expect(await api.post('/api/void')).toBeNull();
  });

  it('invokePanelBinary 拿回 Blob', async () => {
    stubFetch(() => new Response('RIFFxxxx', { status: 200, headers: { 'Content-Type': 'audio/wav' } }));
    const blob = await api.invokePanelBinary('world:chat', 'voice', 'clip');
    expect(blob).toBeInstanceOf(Blob);
    expect(await (blob as Blob).text()).toBe('RIFFxxxx');
  });

  it('pickPath 与 setConfig 走各自的框架 POST 入口', async () => {
    stubFetch((url) => url === '/api/path-picker'
      ? json({ path: 'C:\\mc\\server' })
      : json({ result: '路径已保存' }));
    const picked = await api.pickPath({ kind: 'directory' });
    const saved = await api.setConfig('world:minecraft', { 'worlds.minecraft.local.serverDir': picked });

    expect(picked).toBe('C:\\mc\\server');
    expect(saved).toBe('路径已保存');
    expect(calls[0]).toMatchObject({
      url: '/api/path-picker',
      init: { method: 'POST', body: '{"kind":"directory"}' },
    });
    expect(calls[1]).toMatchObject({
      url: '/api/config',
      init: {
        method: 'POST',
        body: '{"group":"world:minecraft","values":{"worlds.minecraft.local.serverDir":"C:\\\\mc\\\\server"}}',
      },
    });
  });
});

describe('web client api —— 错误归一化', () => {
  it('非 2xx 带 {error} → WebUiInvokeError，取服务端措辞与状态码', async () => {
    stubFetch(() => json({ error: '没有这个面板' }, 404));
    const err = await catchErr(api.get('/api/x'));
    expect(err).toBeInstanceOf(WebUiInvokeError);
    expect(err.message).toBe('没有这个面板');
    expect(err.status).toBe(404);
  });

  it('非 2xx 且 body 不是 JSON → 消息里带 HTTP 状态与响应片段', async () => {
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const err = await catchErr(api.get('/api/x'));
    expect(err).toBeInstanceOf(WebUiInvokeError);
    expect(err.message).toContain('HTTP 502');
    expect(err.message).toContain('502 Bad Gateway');
    expect(err.status).toBe(502);
  });

  it('非 2xx 且 JSON 里没有 error 字段 → 退回 HTTP <status>', async () => {
    stubFetch(() => json({ whatever: 1 }, 500));
    const err = await catchErr(api.get('/api/x'));
    expect(err.message).toBe('HTTP 500');
    expect(err.status).toBe(500);
  });

  it('200 但 body 是坏 JSON → WebUiInvokeError，消息里带片段', async () => {
    stubFetch(() => new Response('{oops', { status: 200 }));
    const err = await catchErr(api.get('/api/x'));
    expect(err).toBeInstanceOf(WebUiInvokeError);
    expect(err.message).toContain('{oops');
    expect(err.status).toBe(200);
  });

  it('响应片段截断到 200 字符', async () => {
    stubFetch(() => new Response('x'.repeat(500), { status: 500 }));
    const err = await catchErr(api.get('/api/x'));
    expect(err.message).toContain('…');
    expect(err.message.length).toBeLessThan(240);
  });

  it('网络 reject → WebUiInvokeError，status 0', async () => {
    stubFetch(() => { throw new TypeError('Failed to fetch'); });
    const err = await catchErr(api.get('/api/x'));
    expect(err).toBeInstanceOf(WebUiInvokeError);
    expect(err.status).toBe(0);
    expect(err.message).toContain('Failed to fetch');
  });

  it('abort 原样抛出，不被包成 WebUiInvokeError', async () => {
    const ac = new AbortController();
    stubFetch(() => { throw new DOMException('The operation was aborted.', 'AbortError'); });
    const p = api.get('/api/slow', { signal: ac.signal });
    ac.abort();
    const err = await catchErr(p);
    // 调用方靠这条区分"面板卸载了，请求被取消"和"请求真失败了"
    expect(err).not.toBeInstanceOf(WebUiInvokeError);
    expect(err.name).toBe('AbortError');
  });

  it('signal 会原样传给 fetch', async () => {
    const ac = new AbortController();
    stubFetch(() => json({ ok: 1 }));
    await api.get('/api/x', { signal: ac.signal });
    expect(calls[0]?.init.signal).toBe(ac.signal);
  });
});

describe('web client api —— 路由拼接', () => {
  it('provider id 的冒号被编码：worlds:chat → world%3Achat', async () => {
    stubFetch(() => json({ ok: 1 }));
    await api.invokePanel('world:chat', 'gate', 'status');
    expect(calls[0]?.url).toBe('/api/webui/providers/world%3Achat/panels/gate/status');
    expect(calls[0]?.url).not.toContain('world:chat');
  });

  it('invokePanel 发的是 POST，body 是 {"args":[...]}', async () => {
    stubFetch(() => json({ ok: 1 }));
    await api.invokePanel('persona:demo', 'p1', 'save', [{ k: 1 }, 'x']);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(calls[0]?.init.body).toBe('{"args":[{"k":1},"x"]}');
  });

  it('invokePanel 不传 args 时也发空数组', async () => {
    stubFetch(() => json(null));
    await api.invokePanel('world:chat', 'gate', 'read');
    expect(calls[0]?.init.body).toBe('{"args":[]}');
  });

  it('invokePanelBinary 走 POST 并拿回 Blob', async () => {
    stubFetch(() => new Response('WAVDATA', { status: 200 }));
    const blob = await api.invokePanelBinary('world:chat', 'voice', 'preview', ['hi']);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"args":["hi"]}');
    expect(blob).toBeInstanceOf(Blob);
  });

  it('invokePanelBinary 的非 2xx 同样归一化', async () => {
    stubFetch(() => json({ error: '合成失败' }, 500));
    const err = await catchErr(api.invokePanelBinary('world:chat', 'voice', 'preview'));
    expect(err).toBeInstanceOf(WebUiInvokeError);
    expect(err.message).toBe('合成失败');
    expect(err.status).toBe(500);
  });

});
