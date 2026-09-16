/**
 * llamacpp 模块:条目形状与校验、Chat Completions 请求体、以及对着一台真 HTTP server 的
 * router 目录(`/models`、`/props`、`/models/load|unload`、`POST /models`)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import module from '../../src/providers/llamacpp/index.ts';
import { LlamaCppProvider, buildLlamaCppRequestBody } from '../../src/providers/llamacpp/native.ts';
import { RouterCatalog } from '../../src/providers/llamacpp/catalog.ts';
import { LAUNCH_DEFAULTS, PINNED_RELEASE, backendChoices, defaultBackend, llamacppOptions, releasePlan } from '../../src/providers/llamacpp/options.ts';
import type { LLMProviderEntry } from '../../src/core/types.ts';
import { nullLogger } from '../../src/core/util.ts';

afterEach(() => vi.unstubAllGlobals());

const entry = (patch: Partial<LLMProviderEntry> = {}): LLMProviderEntry => ({ kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8090/v1', ...patch });

describe('llamacpp 条目', () => {
  it('外部端点不带任何托管键;开启托管后版本、后端与启动参数补默认值', () => {
    expect(module.normalize(entry()).options).toEqual({});

    const managed = module.normalize(entry({ options: { runtime: { backend: defaultBackend() } as never } }));
    const options = llamacppOptions(managed);
    expect(options.runtime).toEqual({ release: PINNED_RELEASE, backend: defaultBackend() });
    expect(options.launch).toEqual(LAUNCH_DEFAULTS);
  });

  it('校验:本机没有的后端只有自备目录才放行;启动参数要正整数', () => {
    const managed = (runtime: Record<string, unknown>, launch?: Record<string, unknown>) =>
      entry({ options: { runtime, ...(launch ? { launch } : {}) } });
    expect(() => module.validateEntry(managed({ release: PINNED_RELEASE, backend: 'sycl-fp16' }), 'zh')).toThrow('没有后端');
    expect(() => module.validateEntry(managed({ release: PINNED_RELEASE, backend: 'sycl-fp16', runtimeDir: 'D:/own' }), 'zh')).not.toThrow();
    expect(() => module.validateEntry(managed({ release: '', backend: defaultBackend() }), 'zh')).toThrow('版本 tag');
    expect(() => module.validateEntry(managed({ release: PINNED_RELEASE, backend: defaultBackend() }, { ...LAUNCH_DEFAULTS, contextSize: 0 }), 'zh')).toThrow('contextSize');
    expect(() => module.validateEntry(managed({ release: PINNED_RELEASE, backend: defaultBackend() }, { ...LAUNCH_DEFAULTS, nGpuLayers: -1 }), 'zh')).toThrow('nGpuLayers');
    expect(() => module.validateEntry(entry({ options: { autoStart: 'yes' } }), 'zh')).toThrow('布尔');
    expect(() => module.validateEntry(entry(), 'zh')).not.toThrow();
  });

  it('端点页的运行时段落:开启托管、逐格改参数、清空自备目录都只写这一条端点', async () => {
    const saved: LLMProviderEntry[] = [];
    let current = entry();
    const console = module.console!({
      language: 'zh',
      entries: () => [{ name: 'local', entry: current }],
      instance: () => { throw new Error('这几个方法不该去要实例'); },
      save: (_name, next) => { saved.push(next); current = next; },
    });
    const call = (method: string, body: Record<string, unknown>) =>
      console.invoke!('runtime', method, [{ name: 'local', ...body }]);

    await call('enable', { backend: defaultBackend() });
    expect(llamacppOptions(current).launch).toEqual(LAUNCH_DEFAULTS);
    await call('configure', { launch: { nGpuLayers: 40 } });
    expect(llamacppOptions(current).launch).toEqual({ ...LAUNCH_DEFAULTS, nGpuLayers: 40 });
    await call('configure', { runtimeDir: 'C:\llama' });
    expect(llamacppOptions(current).runtime!.runtimeDir).toBe('C:\llama');
    await call('configure', { runtimeDir: '  ' });
    expect(llamacppOptions(current).runtime!.runtimeDir).toBeUndefined();
    await call('configure', { autoStart: true });
    expect(llamacppOptions(current).autoStart).toBe(true);
    // 开启托管前没有 runtime 段:这时改参数没有落点
    current = entry();
    const writes = saved.length;
    await expect(call('configure', { launch: { parallel: 2 } })).rejects.toThrow('托管');
    expect(saved.length).toBe(writes);
  });

  it('发布表:Windows CUDA 版搭配 cudart,tar 包剥一层前缀,上游没有的组合给 null', () => {
    const cuda = releasePlan('b10930', 'cuda-13.3', 'win32', 'x64')!;
    expect(cuda.key).toBe('win-cuda-13.3-x64');
    expect(cuda.archives.map((archive) => archive.file)).toEqual([
      'llama-b10930-bin-win-cuda-13.3-x64.zip',
      'cudart-llama-bin-win-cuda-13.3-x64.zip',
    ]);
    expect(cuda.archives[0].url).toBe('https://github.com/ggml-org/llama.cpp/releases/download/b10930/llama-b10930-bin-win-cuda-13.3-x64.zip');
    expect(cuda.serverExe).toBe('llama-server.exe');
    const vulkan = releasePlan('b10930', 'vulkan', 'linux', 'x64')!;
    expect(vulkan.archives).toEqual([expect.objectContaining({ file: 'llama-b10930-bin-ubuntu-vulkan-x64.tar.gz', format: 'tgz', stripComponents: 1 })]);
    expect(releasePlan('b10930', 'cpu', 'linux', 'x64')!.archives[0].file).toBe('llama-b10930-bin-ubuntu-x64.tar.gz');
    expect(releasePlan('b10930', 'metal', 'darwin', 'arm64')!.archives[0].file).toBe('llama-b10930-bin-macos-arm64.tar.gz');
    expect(releasePlan('b10930', 'cuda-13.3', 'linux', 'x64')).toBeNull();
    expect(backendChoices('freebsd' as NodeJS.Platform, 'x64')).toEqual([]);
  });
});

describe('llamacpp Chat 请求', () => {
  it('思维链是模板开关,effort 只在开着时带;工具按 function 格式', () => {
    const body = buildLlamaCppRequestBody(
      { model: 'qwen', thinking: true, reasoningEffort: 'high', temperature: 0.7, maxTokens: 512 },
      [{ role: 'user', content: 'hi' }],
      [{ name: 'look', description: 'look around', parameters: { type: 'object' } }],
    );
    expect(body).toMatchObject({
      model: 'qwen',
      chat_template_kwargs: { enable_thinking: true },
      reasoning_effort: 'high',
      temperature: 0.7,
      max_tokens: 512,
      tools: [{ type: 'function', function: { name: 'look' } }],
    });
    const off = buildLlamaCppRequestBody({ model: 'qwen', thinking: false, reasoningEffort: 'high' }, [{ role: 'user', content: 'hi' }]);
    expect(off.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(off).not.toHaveProperty('reasoning_effort');
    expect(off).not.toHaveProperty('tools');
  });

  it('打到 <baseUrl>/chat/completions,密钥进 bearer,reasoning_content 归一成推理项', async () => {
    let url = '';
    let headers: Record<string, string> = {};
    vi.stubGlobal('fetch', async (target: unknown, init: RequestInit) => {
      url = String(target);
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({
        id: 'chat-1', model: 'qwen',
        choices: [{ message: { content: 'hello', reasoning_content: 'thought' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }));
    });
    const client = new LlamaCppProvider({ baseUrl: 'http://127.0.0.1:8090/v1/', apiKey: 'k', log: nullLogger() });
    const generation = await client.respond({ model: 'qwen', input: [{ type: 'message', role: 'user', content: 'hi' }] });
    expect(url).toBe('http://127.0.0.1:8090/v1/chat/completions');
    expect(headers.Authorization).toBe('Bearer k');
    expect(generation.response.output.map((item) => item.type)).toEqual(['reasoning', 'message']);
  });
});

interface Fake {
  url: string;
  requests: Array<{ method: string; path: string; body: unknown }>;
  close(): Promise<void>;
}

async function fakeRouter(models: unknown[]): Promise<Fake> {
  const requests: Fake['requests'] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({ method: req.method ?? '', path: url.pathname + url.search, body: raw ? JSON.parse(raw) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && url.pathname === '/models') res.end(JSON.stringify({ data: models }));
      else if (req.method === 'GET' && url.pathname === '/props') res.end(JSON.stringify({ default_generation_settings: { n_ctx: url.searchParams.get('model') === 'big' ? 32768 : 4096 } }));
      else if (req.method === 'POST' && ['/models', '/models/load', '/models/unload'].includes(url.pathname)) res.end(JSON.stringify({ success: true }));
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

describe('llamacpp router 目录', () => {
  it('列表带状态、模态与下载进度;单模型 server 的行没有状态也照列', async () => {
    const fake = await fakeRouter([
      { id: 'big', path: '/cache/big.gguf', status: { value: 'loaded', args: [] }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      { id: 'pulling', status: { value: 'downloading', progress: { 'https://a': { done: 10, total: 100 }, 'https://b': { done: 5, total: 50 } } } },
      { id: 'broken', status: { value: 'unloaded', failed: true, exit_code: 1 } },
      { id: 'plain' },
    ]);
    const catalog = new RouterCatalog(() => ({ baseUrl: fake.url, apiKey: 'k' }), { refreshMs: 0 });
    try {
      const models = await catalog.list();
      expect(models.map((model) => [model.id, model.status])).toEqual([['big', 'loaded'], ['broken', 'failed'], ['plain', 'unknown'], ['pulling', 'downloading']]);
      expect(models.find((model) => model.id === 'pulling')!.progress).toEqual({ done: 15, total: 150 });
      expect(models.find((model) => model.id === 'big')!.inputModalities).toEqual(['text', 'image']);
      expect(catalog.acceptsImage('big')).toBe(true);
      expect(catalog.acceptsImage('plain')).toBeUndefined();
      const listings = () => fake.requests.filter((request) => request.path !== '/models/sse');
      expect(listings()[0].path).toBe('/models');
      await catalog.list(true);
      expect(listings()[1].path).toBe('/models?reload=1');
    } finally {
      catalog.stop();
      await fake.close();
    }
  });

  it('拉取、加载、卸载各打自己的端点;上下文窗口从 /props?model= 探,首问不阻塞', async () => {
    const fake = await fakeRouter([{ id: 'big', status: { value: 'loaded' } }]);
    const catalog = new RouterCatalog(() => ({ baseUrl: fake.url }), { refreshMs: 0 });
    try {
      await catalog.download('org/repo:Q4');
      await catalog.load('big');
      await catalog.unload('big');
      const calls = () => fake.requests.filter((request) => request.path !== '/models/sse');
      expect(calls().map((request) => [request.method, request.path, request.body])).toEqual([
        ['POST', '/models', { model: 'org/repo:Q4' }],
        ['POST', '/models/load', { model: 'big' }],
        ['POST', '/models/unload', { model: 'big' }],
      ]);
      expect(catalog.contextWindow('big')).toBeUndefined();
      await catalog.settled('big');
      expect(catalog.contextWindow('big')).toBe(32768);
      expect(calls().at(-1)!.path).toBe('/props?model=big');
      expect(await catalog.listModels()).toEqual([{ id: 'big', contextWindow: 32768 }]);
    } finally {
      catalog.stop();
      await fake.close();
    }
  });

  it('列表里的 downloading 行没有字节数;进度从 /models/sse 的 download_progress 帧补上,完成后清掉', async () => {
    const frames = [
      { model: 'org/repo:Q4', event: 'download_progress', data: { 'https://a': { done: 10, total: 100 }, 'https://b': { done: 30, total: 300 } } },
    ];
    const server = createServer((req, res) => {
      if (req.url === '/models/sse') {
        res.setHeader('Content-Type', 'text/event-stream');
        for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') { res.end('{"success":true}'); return; }
      res.end(JSON.stringify({ data: [{ id: 'org/repo:Q4', status: { value: 'downloading', args: [] } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const catalog = new RouterCatalog(() => ({ baseUrl: `http://127.0.0.1:${port}/v1` }));
    try {
      await catalog.download('org/repo:Q4');
      const deadline = Date.now() + 5000;
      let progress = (await catalog.list())[0].progress;
      while (!progress && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        progress = (await catalog.list())[0].progress;
      }
      expect(progress).toEqual({ done: 40, total: 400 });
    } finally {
      catalog.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('server 不在时列表抛错而不是回空表', async () => {
    const fake = await fakeRouter([]);
    await fake.close();
    const catalog = new RouterCatalog(() => ({ baseUrl: fake.url }));
    await expect(catalog.list()).rejects.toThrow();
  });
});
