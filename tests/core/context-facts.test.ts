/**
 * 上下文事实的来源:上游自报窗口(Provider 实例的模型目录)与手填窗口取小,
 * "输入超过上下文"的拒绝由 Provider 模块识别。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isContextOverflow } from '../../src/providers/transport/errors.ts';
import { ModelCatalog } from '../../src/providers/openai-responses-compat/native.ts';
import { Core } from './fixture-core.ts';
import { activeSpec, FakeLLM, makeCfg, makeFakeIO, makeFakePersona, makeLoaded, makeTmpDir, sleep } from './helpers.ts';

afterEach(() => { vi.useRealTimers(); });

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('until超时');
    await sleep(10);
  }
}

describe('isContextOverflow', () => {
  it('400/413 与流内失败(0)带超长措辞才算;其他状态与其他 4xx 措辞不算', () => {
    expect(isContextOverflow({ status: 400, body: "This model's maximum context length is 128000 tokens" })).toBe(true);
    expect(isContextOverflow({ status: 400, body: '{"error":{"code":"context_length_exceeded"}}' })).toBe(true);
    expect(isContextOverflow({ status: 400, body: 'the request exceeds the available context size' })).toBe(true);
    expect(isContextOverflow({ status: 0, body: '{"message":"prompt is too long"}' })).toBe(true);
    expect(isContextOverflow({ status: 413, body: 'input is too long' })).toBe(true);
    expect(isContextOverflow({ status: 400, body: 'Model Not Exist' })).toBe(false);
    expect(isContextOverflow({ status: 500, body: 'context length' })).toBe(false);
    expect(isContextOverflow({ status: 429, body: 'too many tokens per minute' })).toBe(false);
  });
});

describe('ModelCatalog', () => {
  it('GET /models 给 id 列表;带 context_length 的模型才报窗口;非 2xx 原样抛', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://router.test/api/v1/models');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
      return new Response(JSON.stringify({ data: [{ id: 'b/plain' }, { id: 'a/wide', context_length: 200000 }, { context_length: 5 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const catalog = new ModelCatalog(() => ({ baseUrl: 'https://router.test/api/v1/', headers: { Authorization: 'Bearer k' } }), fetchImpl);
    expect(catalog.contextWindow('a/wide')).toBeUndefined();
    expect(await catalog.list()).toEqual([{ id: 'a/wide', contextWindow: 200000 }, { id: 'b/plain' }]);
    expect(catalog.contextWindow('a/wide')).toBe(200000);
    expect(catalog.contextWindow('b/plain')).toBeUndefined();
    const denied = new ModelCatalog(() => ({ baseUrl: 'https://router.test/api/v1', headers: {} }), (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch);
    await expect(denied.list()).rejects.toThrow('GET /models 401');
  });

  it('name、top_provider.max_completion_tokens、architecture.input_modalities 成为显示名、最大输出与图像输入;类型不对的不报', async () => {
    const rows = [
      { id: 'alpha-mini', name: 'Alpha Mini', top_provider: { max_completion_tokens: 8192 }, architecture: { input_modalities: ['text', 'image'] } },
      { id: 'beta-text', architecture: { input_modalities: ['text'] }, top_provider: null },
      { id: 'gamma-odd', name: 42, top_provider: { max_completion_tokens: '8192' }, architecture: { input_modalities: 'image' } },
    ];
    const catalog = new ModelCatalog(() => ({ baseUrl: 'https://router.test/v1', headers: {} }), (async () => new Response(JSON.stringify({ data: rows }), { status: 200 })) as unknown as typeof fetch);
    expect(await catalog.list()).toEqual([
      { id: 'alpha-mini', displayName: 'Alpha Mini', maxOutputTokens: 8192, inputImages: true },
      { id: 'beta-text', inputImages: false },
      { id: 'gamma-odd' },
    ]);
  });
});

describe('Core · 生效窗口', () => {
  let tmp: ReturnType<typeof makeTmpDir> | null = null;
  afterEach(async () => {
    vi.unstubAllGlobals();
    tmp?.cleanup();
    tmp = null;
  });

  it('上游自报与手填取小;单轮生成上限从窗口里扣掉;两者都没有则没有物理上限', async () => {
    // 上游自报来自模型目录(OpenRouter 的 context_length);目录只在控制台取列表时拉。
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).endsWith('/models')
        ? new Response(JSON.stringify({ data: [{ id: 'local', context_length: 16384 }] }), { status: 200 })
        : new Response('', { status: 404 })));
    tmp = makeTmpDir();
    const config = makeCfg();
    config.worlds.qq.enabled = false;
    config.providers = {
      local: {
        kind: 'openai-responses-compat',
        baseUrl: 'http://127.0.0.1:1/v1',
        spec: { model: 'local', thinking: false, contextWindow: 128000, maxTokens: 4096 },
      },
    };
    config.activeProvider = 'local';
    const loaded = makeLoaded({ config, rootDir: tmp.dir, memoryDir: `${tmp.dir}/persona`, dataDir: `${tmp.dir}/data` });
    const persona = makeFakePersona([], { cfg: config });
    const core = new Core(loaded, { persona, worlds: [makeFakeIO('web')], llm: new FakeLLM() });
    try {
      const hard = () => core.loop.getStatus().context.hardTokens;
      // 目录未拉之前只有手填值
      expect(hard()).toBe(128000 - 4096);
      await core.providers.resolve('local').listModels!();
      await until(() => hard() === 16384 - 4096);
      // 手填比上游小时按手填
      activeSpec(config).contextWindow = 8000;
      expect(hard()).toBe(8000 - 4096);
      delete activeSpec(config).maxTokens;
      expect(hard()).toBe(8000);
      // 手填缺席仍有上游值;两者都缺席(目录没有该模型)则 null
      delete activeSpec(config).contextWindow;
      expect(hard()).toBe(16384);
      config.providers = {
        cloud: {
          kind: 'openai-responses-compat',
          baseUrl: 'https://api.deepseek.test',
          spec: { model: 'deepseek-flash', thinking: false },
        },
      };
      config.activeProvider = 'cloud';
      expect(hard()).toBeNull();
    } finally {
      await core.stop();
    }
  });
});
