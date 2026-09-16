import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { makeCfg, makeTmpDir } from './helpers.ts';
import { ProviderRegistry, providerModules } from '../../src/providers/registry.ts';
import { ProviderSettings } from '../../src/providers/console/settings.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { ProviderModule } from '../../src/providers/base.ts';
import type { PriceDefinition } from '../../src/providers/pricebook.ts';

/** 内建模块的连接字段归端点面板;配置组这条路仍留给扩展,用这个夹具核。 */
const groupModule: ProviderModule = {
  id: 'group-llm',
  title: 'Group LLM',
  reasoningTiers: [],
  serviceTiers: [],
  config: (name) => [{
    id: `llm.group-llm.${name}`,
    owner: 'provider:group-llm',
    schema: {
      type: 'object',
      title: name,
      properties: {
        [`providers.${name}.baseUrl`]: { type: 'string', title: '供应地址', 'x-hot': true },
        [`providers.${name}.secret`]: { type: 'string', title: '密钥变量名', 'x-hot': true },
      },
    },
  }],
  create: () => ({ client: null as never }),
};
const modules = [...providerModules, groupModule];

const temp = makeTmpDir();
afterEach(() => vi.unstubAllGlobals());
afterAll(() => temp.cleanup());
function fixture() {
  const cfg = makeCfg();
  cfg.providers = {
    cloud: { kind: 'openai-responses-compat', baseUrl: 'https://first.test', options: { preset: 'deepseek' } },
    local: {
      kind: 'openai-responses-compat',
      baseUrl: 'https://second.test',
      spec: { model: 'local', thinking: false },
    },
  };
  cfg.activeProvider = 'cloud';
  const file = join(temp.dir, crypto.randomUUID() + '.json');
  // activeProvider 保存在当前部署；端点表位于共享目录。
  writeFileSync(file, JSON.stringify({ activeProvider: 'cloud', untouched: { watermark: 55 } }, null, 2));
  const providersDir = join(temp.dir, crypto.randomUUID());
  const registry = new ProviderRegistry(() => cfg.providers, {
    stateRoot: providersDir,
    readBlob: () => null,
    keepThinking: () => true,
    log: nullLogger(),
  }, modules);
  const settings = new ProviderSettings(cfg, registry, file, providersDir, modules);
  /* eslint-disable-next-line */
  const endpoint = (name: string): any =>
    JSON.parse(readFileSync(join(providersDir, name, 'config.json'), 'utf8'));
  return { cfg, file, providersDir, registry, settings, endpoint };
}
describe('Provider 配置事务', () => {
  it('旧实例名按完整字符串读写，点号不被解释为配置层级', () => {
    const { cfg, settings, endpoint } = fixture();
    cfg.providers['old.account'] = {
      kind: 'group-llm',
      baseUrl: 'https://old.test',
      spec: { model: 'deepseek-flash', thinking: true, reasoningEffort: 'low' },
    };
    const id = 'llm.group-llm.old.account';
    expect(settings.values(id)['providers.old.account.baseUrl']).toBe('https://old.test');
    settings.setConfig(id, { 'providers.old.account.baseUrl': 'https://new.test' });
    // 端点名整串就是目录名(带点也一样),不被拆成层级
    expect(endpoint('old.account').baseUrl).toBe('https://new.test');
    expect(cfg.providers.old).toBeUndefined();
    expect(cfg.providers['old.account'].spec!.reasoningEffort).toBe('low');
  });
  it('启用时校验这一份档位，错误不改变磁盘或运行配置', () => {
    const { cfg, file, settings, endpoint } = fixture();
    const original = readFileSync(file, 'utf8');
    expect(() =>
      settings.activate('local', { model: 'local', thinking: false, reasoningEffort: 'high' }),
    ).toThrow('推理强度');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(cfg.activeProvider).toBe('cloud');
    settings.activate('local');
    expect(cfg.activeProvider).toBe('local');
    // 部署 config.json 只记"这份部署用哪个端点";端点本身在全局那份
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      activeProvider: 'local',
      untouched: { watermark: 55 },
      providerSchemaVersion: 3,
    });
    expect(JSON.parse(readFileSync(file, 'utf8')).providers).toBeUndefined();
    expect(endpoint('local')).toMatchObject({ spec: { model: 'local', thinking: false } });
  });
  it('写入失败保持运行配置;没选模型的实例不能启用', () => {
    const { cfg, file, providersDir, registry, endpoint } = fixture();
    const badFile = join(temp.dir, crypto.randomUUID());
    mkdirSync(badFile);
    const bad = new ProviderSettings(cfg, registry, badFile, providersDir);
    expect(() => bad.activate('local')).toThrow();
    expect(cfg.activeProvider).toBe('cloud');
    const settings = new ProviderSettings(cfg, registry, file, providersDir);
    // 未选择模型的端点不能启用。
    expect(() => settings.activate('cloud')).toThrow('模型档');
    expect(cfg.activeProvider).toBe('cloud');
    settings.save('local', cfg.providers.local);
    expect(endpoint('local').spec.model).toBe('local');
    expect(JSON.parse(readFileSync(file, 'utf8')).providerSchemaVersion).toBe(3);
  });
  it('已绑定会话保留端点和报价，后续请求使用新配置', async () => {
    const { cfg, registry, settings } = fixture();
    const rate = (value: number): PriceDefinition[] => [
      {
        models: ['*'],
        basis: 'marginal',
        currency: 'USD',
        source: 'deployment contract',
        rules: [{ meter: 'input', perMillion: value }],
      },
    ];
    cfg.providers.cloud.pricing = rate(1);
    const bound = registry.bind('cloud');
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          id: 'resp_1', model: 'deepseek-v4-pro', status: 'completed',
          output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
          usage: { input_tokens: 100, output_tokens: 2 },
        }),
      );
    });
    settings.save('cloud', {
      ...cfg.providers.cloud,
      baseUrl: 'https://changed.test',
      pricing: rate(9),
    });
    settings.activate('local');
    const old = await bound.respond({ model: 'deepseek-v4-pro', input: 'hello' });
    const next = await registry.bind('cloud').respond({ model: 'deepseek-v4-pro', input: 'hello' });
    expect(urls).toEqual([
      'https://first.test/responses',
      'https://changed.test/responses',
    ]);
    expect(old.attempts[0].charges[0].knownAmount).toBeCloseTo(0.0001);
    expect(next.attempts[0].charges[0].knownAmount).toBeCloseTo(0.0009);
  });
  it('原生参数按模块验证，未编辑实例的旧档位不阻断保存', () => {
    const { cfg, settings } = fixture();
    cfg.providers.cloud.spec = { model: 'legacy', thinking: true, reasoningEffort: 'high' };
    settings.save('local', { ...cfg.providers.local, baseUrl: 'http://localhost:8091' });
    expect(cfg.providers.local.baseUrl).toBe('http://localhost:8091');
    expect(() =>
      settings.save('local', {
        ...cfg.providers.local,
        options: { endpointPath: 'responses' },
      }),
    ).toThrow('以 / 开头');
    expect(() =>
      settings.save('local', {
        ...cfg.providers.local,
        pricing: [
          {
            models: ['*'],
            basis: 'marginal',
            currency: 'USD',
            source: 'x',
            rules: [{ meter: 'output', perMillion: -1 }],
          },
        ],
      }),
    ).toThrow('非负');
  });
  it("端点表使用控制台内建面板，模块提供操作接口", () => {
    const { settings } = fixture();
    for (const source of settings.sources()) {
      const panel = source.contribute('zh').panels!.find((p) => p.id === 'settings')!;
      expect([source.id, panel.builtin]).toEqual([source.id, 'llm-settings']);
    }
  });
  it('条目改动重建客户端,但 host.resource 持有的控制器与兼容域跨重建保留', () => {
    const { cfg } = fixture();
    // host.resource 保存的对象跨客户端重建保留。
    const probe: ProviderModule = {
      id: 'probe',
      title: 'Probe',
      reasoningTiers: [],
      serviceTiers: [{ id: 'priority', label: '快车道' }],
      create: (_name, _entry, host) => {
        const control = host.resource!('session', () => ({ session: crypto.randomUUID() }));
        return { client: null as never, control, compatibilityKey: () => control.session };
      },
    };
    const registry = new ProviderRegistry(() => cfg.providers, {
      stateRoot: join(temp.dir, crypto.randomUUID()),
      readBlob: () => null,
      keepThinking: () => true,
      log: nullLogger(),
    }, [probe]);
    cfg.providers.account = { kind: 'probe', baseUrl: 'https://probe.test' };
    const first = registry.resolve('account');
    cfg.providers.account.serviceTier = 'priority';
    const second = registry.resolve('account');
    expect(second).not.toBe(first); // 条目变了:客户端确实重建过
    expect(second.control).toBe(first.control);
    expect(second.compatibilityKey!()).toEqual(first.compatibilityKey!());
  });
});

describe('Provider 数据面:建、删、复制、密钥、模型列表、探测', () => {
  const invoke = (settings: ProviderSettings, method: string, body: Record<string, unknown>) =>
    settings.sources().find((source) => source.id === 'llm:openai-responses-compat')!.contribute('zh').invoke!('settings', method, [body]);
  it('新建只吃名字与地址:缺地址落模块默认,报价留空;同名只有在旧条目无模块认领时才能覆盖', async () => {
    const { cfg, settings, endpoint } = fixture();
    cfg.providers.ghost = { kind: 'deleted-module', baseUrl: 'https://ghost.test' };
    await invoke(settings, 'create', { name: 'router', baseUrl: 'https://openrouter.ai/api/v1' });
    // 仅提供地址，其余连接参数由操作者配置。
    expect(cfg.providers.router).toEqual({
      kind: 'openai-responses-compat', baseUrl: 'https://openrouter.ai/api/v1', options: {}, pricing: [],
    });
    // 报价留空:用量页把这条端点的调用记成未计价,而不是零元。
    expect(endpoint('router').pricing).toEqual([]);
    await expect(invoke(settings, 'create', { name: 'router', baseUrl: 'https://x.test' })).rejects.toThrow('已存在');
    await invoke(settings, 'create', { name: 'blank' });
    expect(cfg.providers.blank.baseUrl).toBe('https://api.openai.com/v1');
    await invoke(settings, 'create', { name: 'ghost', baseUrl: 'https://mine.test/v1' });
    expect(cfg.providers.ghost).toMatchObject({ kind: 'openai-responses-compat', baseUrl: 'https://mine.test/v1' });
    const state = (await invoke(settings, 'state', {})) as { baseUrlSuggestions: string[]; effortSuggestions: string[]; instances: Array<{ name: string; secretConfigured: string }> };
    expect(state.baseUrlSuggestions).toContain('https://api.deepseek.com');
    expect(state.effortSuggestions).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(state.instances.find((instance) => instance.name === 'router')).toMatchObject({ secretConfigured: 'none' });
  });
  it('save 可同时改连接字段与原生参数;delete 拒删当前端点、删别的连目录一起走;duplicate 整份复制', async () => {
    const { cfg, settings, providersDir, endpoint } = fixture();
    await invoke(settings, 'save', {
      name: 'local', spec: { model: 'gpt-5.5', thinking: true, reasoningEffort: 'xhigh' }, pricing: [],
      baseUrl: 'https://api.openai.com/v1 ', secret: 'OPENAI_API_KEY', multimodal: true, options: { extraBody: { service_tier: 'flex' } },
    });
    expect(cfg.providers.local).toMatchObject({ baseUrl: 'https://api.openai.com/v1', secret: 'OPENAI_API_KEY', multimodal: true, options: { extraBody: { service_tier: 'flex' } } });
    await invoke(settings, 'duplicate', { name: 'local', as: 'local-2' });
    expect(endpoint('local-2')).toEqual(endpoint('local'));
    await expect(invoke(settings, 'delete', { name: 'cloud' })).rejects.toThrow('当前供应实例');
    await invoke(settings, 'delete', { name: 'local-2' });
    expect(cfg.providers['local-2']).toBeUndefined();
    expect(existsSync(join(providersDir, 'local-2'))).toBe(false);
    expect(cfg.providers.local).toBeDefined();
  });
  it('setSecret 写进端点 .env 并重建实例;状态区分 进程环境 / 文件 / 无', async () => {
    const { cfg, settings, registry, providersDir } = fixture();
    cfg.providers.cloud.secret = 'DS_TEST_KEY';
    cfg.providers.cloud.spec = { model: 'deepseek-flash', thinking: false };
    const before = registry.resolve('cloud');
    expect(settings.secretStatus('cloud', cfg.providers.cloud)).toBe('none');
    await expect(invoke(settings, 'setSecret', { name: 'cloud', value: 'has space' })).rejects.toThrow('空白');
    expect(await invoke(settings, 'setSecret', { name: 'cloud', value: 'sk-first' })).toEqual({ secretConfigured: 'file' });
    await invoke(settings, 'setSecret', { name: 'cloud', value: 'sk-second' });
    expect(readFileSync(join(providersDir, 'cloud', '.env'), 'utf8')).toBe('DS_TEST_KEY=sk-second\n');
    expect(registry.resolve('cloud')).not.toBe(before);
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ id: 'r', model: 'deepseek-flash', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } }));
    });
    await registry.bind('cloud').respond({ model: 'deepseek-flash', input: 'hi' });
    expect(seen).toEqual(['Bearer sk-second']);
    process.env.DS_TEST_KEY = 'from-env';
    try {
      expect(settings.secretStatus('cloud', cfg.providers.cloud)).toBe('env');
    } finally {
      delete process.env.DS_TEST_KEY;
    }
    await expect(invoke(settings, 'setSecret', { name: 'local', value: 'x' })).rejects.toThrow('变量名');
  });
  it('密钥变量名里的正则元字符按字面处理:既不认成别的变量,也不覆盖它', async () => {
    const { cfg, settings, providersDir } = fixture();
    cfg.providers.cloud.secret = 'A.KEY';
    mkdirSync(join(providersDir, 'cloud'), { recursive: true });
    const env = join(providersDir, 'cloud', '.env');
    writeFileSync(env, 'AXKEY=another-secret\n', 'utf8');
    // 文件里没有 A.KEY,只有一个名字长得像的 AXKEY
    expect(settings.secretStatus('cloud', cfg.providers.cloud)).toBe('none');
    await invoke(settings, 'setSecret', { name: 'cloud', value: 'sk-mine' });
    expect(readFileSync(env, 'utf8')).toBe('AXKEY=another-secret\nA.KEY=sk-mine\n');
    expect(settings.secretStatus('cloud', cfg.providers.cloud)).toBe('file');
  });
  it('保存自定义密钥变量名后，请求使用对应的文件或环境密钥', async () => {
    const { cfg, settings, registry, providersDir, endpoint } = fixture();
    const secret = 'my_ModelToken_42';
    vi.stubEnv(secret, '');
    try {
      await invoke(settings, 'save', { name: 'local', secret });
      expect(endpoint('local').secret).toBe(secret);
      expect(settings.secretStatus('local', cfg.providers.local)).toBe('none');
      registry.resolve('local');
      await invoke(settings, 'setSecret', { name: 'local', value: 'sk-custom-file' });
      expect(readFileSync(join(providersDir, 'local', '.env'), 'utf8')).toBe(`${secret}=sk-custom-file\n`);
      const seen: string[] = [];
      vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
        seen.push((init.headers as Record<string, string>).Authorization);
        return new Response(JSON.stringify({ id: 'r', model: 'local', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } }));
      });
      await registry.bind('local').respond({ model: 'local', input: 'hi' });
      vi.stubEnv(secret, 'sk-custom-env');
      registry.invalidate('local');
      expect(settings.secretStatus('local', cfg.providers.local)).toBe('env');
      await registry.bind('local').respond({ model: 'local', input: 'hi' });
      expect(seen).toEqual(['Bearer sk-custom-file', 'Bearer sk-custom-env']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('只保存模型配置后，下一次请求读取外部更新的端点密钥', async () => {
    const { cfg, settings, registry, providersDir } = fixture();
    cfg.providers.cloud.secret = 'DS_TEST_KEY';
    cfg.providers.cloud.spec = { model: 'deepseek-flash', thinking: false };
    const before = registry.resolve('cloud');
    mkdirSync(join(providersDir, 'cloud'), { recursive: true });
    writeFileSync(join(providersDir, 'cloud', '.env'), 'DS_TEST_KEY=sk-from-file\n');
    await invoke(settings, 'save', { name: 'cloud', spec: { model: 'deepseek-v4-pro', thinking: false }, pricing: [] });
    expect(registry.resolve('cloud')).not.toBe(before);
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ id: 'r', model: 'deepseek-v4-pro', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } }));
    });
    await registry.bind('cloud').respond({ model: 'deepseek-v4-pro', input: 'hi' });
    expect(seen).toEqual(['Bearer sk-from-file']);
  });
  it("模型列表来自实例；probe 返回状态、耗时、用量和报价，404 提示检查地址与路径", async () => {
    const { cfg, settings } = fixture();
    cfg.providers.cloud.spec = { model: 'deepseek-flash', thinking: true, reasoningEffort: 'low', maxTokens: 4096 };
    cfg.providers.cloud.pricing = [{ models: ['*'], currency: 'USD', basis: 'marginal', source: 'console', rules: [{ meter: 'input', perMillion: 1 }, { meter: 'output', perMillion: 2 }] }];
    let status = 200;
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }));
      bodies.push(JSON.parse(String(init?.body)));
      if (status !== 200) return new Response('no route', { status });
      return new Response(JSON.stringify({
        id: 'r', model: 'deepseek-flash', status: 'completed', service_tier: null,
        output: [{ type: 'reasoning', id: 'rs', summary: [], content: [], encrypted_content: 'sig' }, { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'pong', annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
      }));
    });
    expect(await invoke(settings, 'models', { name: 'cloud' })).toEqual({ models: [{ id: 'deepseek-flash' }] });
    const ok = (await invoke(settings, 'probe', { name: 'cloud' })) as Record<string, unknown>;
    expect(ok).toMatchObject({ ok: true, status: 200, model: 'deepseek-flash', encryptedReasoning: true, usage: { input: 10, cachedInput: 4, output: 5, reasoning: null } });
    expect(ok.charges).toEqual([{ currency: 'USD', amount: 20 / 1e6 }]);
    expect(bodies[0]).toMatchObject({ max_output_tokens: 256, reasoning: { effort: 'low' }, store: false });
    status = 404;
    const missing = (await invoke(settings, 'probe', { name: 'cloud' })) as Record<string, unknown>;
    expect(missing).toMatchObject({ ok: false, status: 404 });
    expect(String(missing.hint)).toContain('端点路径');
    expect(bodies).toHaveLength(2);
    await expect(invoke(settings, 'probe', { name: 'local' })).resolves.toMatchObject({ ok: false });
  });
  it('模型名是自由字串:目录外、带斜杠冒号日期的名字照样存下并启用,只有空名被拒', async () => {
    const { cfg, settings, endpoint } = fixture();
    for (const model of ['vendor/brand-new:2027-preview', 'deepseek-v4-flash', '  padded-name  ']) {
      await invoke(settings, 'save', { name: 'local', spec: { model, thinking: false }, pricing: [] });
      expect(endpoint('local').spec.model).toBe(model.trim());
    }
    await invoke(settings, 'activate', { name: 'local', spec: { model: 'vendor/whatever', thinking: false } });
    expect(cfg.activeProvider).toBe('local');
    expect(cfg.providers.local.spec!.model).toBe('vendor/whatever');
    await expect(invoke(settings, 'save', { name: 'local', spec: { model: '   ', thinking: false }, pricing: [] })).rejects.toThrow('模型名');
    expect(endpoint('local').spec.model).toBe('vendor/whatever');
  });
});
