import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { makeCfg, makeTmpDir } from './helpers.ts';
import { ProviderRegistry, providerModules } from '../../src/providers/registry.ts';
import { ProviderSettings } from '../../src/providers/webui/settings.ts';
import { text as providerText } from '../../src/providers/webui/strings.ts';
import { nullLogger } from '../../src/core/util.ts';
import { loadDeployment } from '../../src/deploy.ts';
import type { ProviderModule } from '../../src/providers/base.ts';
import type { PriceDefinition } from '../../src/providers/pricebook.ts';

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
  it('连接与协议配置按声明保存，非法值不改变磁盘或运行配置', () => {
    const { cfg, settings, endpoint, providersDir } = fixture();
    const connection = 'llm.openai-responses-compat.local.connection';
    const protocol = 'llm.openai-responses-compat.local.protocol';
    settings.setConfig(connection, {
      'providers.local.baseUrl': 'https://changed.test',
      'providers.local.secret': 'SERVICE_TOKEN',
      'providers.local.multimodal': true,
    });
    settings.setConfig(protocol, { 'providers.local.options.endpointPath': '/generate' });
    expect(endpoint('local')).toMatchObject({
      baseUrl: 'https://changed.test', secret: 'SERVICE_TOKEN', multimodal: true,
      options: { endpointPath: '/generate' },
    });
    expect(settings.values(protocol)['providers.local.options.endpointPath']).toBe('/generate');
    const file = join(providersDir, 'local', 'config.json');
    const before = readFileSync(file, 'utf8');
    const current = structuredClone(cfg.providers.local);
    for (const [group, values] of [
      [connection, { 'providers.local.baseUrl': 'invalid-url' }],
      [connection, { 'providers.local.secret': 'invalid.name' }],
      [protocol, { 'providers.local.options.endpointPath': 'generate' }],
    ] as const) {
      expect(() => settings.setConfig(group, values)).toThrow();
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(cfg.providers.local).toEqual(current);
    }
  });
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
  it('写入失败保持运行配置;部署 config.json 只记选中的端点', () => {
    const { cfg, file, providersDir, registry, endpoint } = fixture();
    const badFile = join(temp.dir, crypto.randomUUID());
    mkdirSync(badFile);
    const bad = new ProviderSettings(cfg, registry, badFile, providersDir);
    const current = structuredClone(cfg.providers.local);
    expect(() => bad.save('local', { ...cfg.providers.local, baseUrl: 'https://changed.test' })).toThrow();
    expect(cfg.providers.local).toEqual(current);
    const settings = new ProviderSettings(cfg, registry, file, providersDir);
    settings.save('local', cfg.providers.local);
    expect(endpoint('local').spec.model).toBe('local');
    // 端点本身在共享目录那份
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      activeProvider: 'cloud',
      untouched: { watermark: 55 },
      providerSchemaVersion: 3,
    });
    expect(JSON.parse(readFileSync(file, 'utf8')).providers).toBeUndefined();
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

describe('Provider 密钥、模型名与探测', () => {
  it('从磁盘加载的密钥变量名按字面匹配', () => {
    const { cfg, settings, providersDir } = fixture();
    mkdirSync(join(providersDir, 'cloud'), { recursive: true });
    writeFileSync(join(providersDir, 'cloud', 'config.json'), JSON.stringify({
      kind: 'openai-responses-compat', baseUrl: 'https://example.invalid', secret: 'A.KEY',
    }));
    cfg.providers = loadDeployment({ defaults: makeCfg }, temp.dir, temp.dir, temp.dir, providersDir).config.providers;
    const env = join(providersDir, 'cloud', '.env');
    writeFileSync(env, 'AXKEY=another-secret\n', 'utf8');
    expect(settings.secretStatus('cloud', cfg.providers.cloud)).toBe('none');
    writeFileSync(env, 'AXKEY=another-secret\nA.KEY=sk-mine\n', 'utf8');
    expect(settings.secretStatus('cloud', cfg.providers.cloud)).toBe('file');
  });
  it('保存自定义密钥变量名后，请求使用对应的文件或环境密钥', async () => {
    const { cfg, settings, registry, providersDir, endpoint } = fixture();
    const secret = 'my_ModelToken_42';
    vi.stubEnv(secret, '');
    try {
      settings.save('local', { ...cfg.providers.local, secret });
      expect(endpoint('local').secret).toBe(secret);
      expect(settings.secretStatus('local', cfg.providers.local)).toBe('none');
      writeFileSync(join(providersDir, 'local', '.env'), `${secret}=sk-custom-file\n`);
      expect(settings.secretStatus('local', cfg.providers.local)).toBe('file');
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
    settings.save('cloud', { ...cfg.providers.cloud, spec: { model: 'deepseek-v4-pro', thinking: false }, pricing: [] });
    expect(registry.resolve('cloud')).not.toBe(before);
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ id: 'r', model: 'deepseek-v4-pro', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } }));
    });
    await registry.bind('cloud').respond({ model: 'deepseek-v4-pro', input: 'hi' });
    expect(seen).toEqual(['Bearer sk-from-file']);
  });
  it('探测失败的提示:403 地区拒绝与鉴权失败分开,200 但正文不成形的不算连接失败', async () => {
    const { cfg, settings, registry } = fixture();
    const spec = { model: 'deepseek-flash', thinking: false };
    cfg.providers.cloud.spec = spec;
    const S = providerText('zh');
    let reply = (): Response => new Response(JSON.stringify({ error: { code: 'unsupported_country_region_territory', message: 'Country, region, or territory not supported' } }), { status: 403 });
    vi.stubGlobal('fetch', async () => reply());
    const hintOf = async () => ((await settings.probeClient(registry.bind('cloud'), spec, 'zh')) as Record<string, unknown>).hint;
    expect(await hintOf()).toBe(S.probeRegion('https://developers.openai.com/api/docs/supported-countries'));
    reply = () => new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), { status: 403 });
    expect(await hintOf()).toBe(S.probeAuth);
    reply = () => new Response('<html>ok</html>', { status: 200 });
    expect(await hintOf()).toBe(S.probeIncompatible);
  });
  it('模型名是自由字串:目录外、带斜杠冒号日期的名字照样存下,只有空名被拒', () => {
    const { cfg, settings, endpoint } = fixture();
    for (const model of ['vendor/brand-new:2027-preview', 'deepseek-v4-flash', '  padded-name  ']) {
      settings.save('local', { ...cfg.providers.local, spec: { model, thinking: false }, pricing: [] });
      expect(endpoint('local').spec.model).toBe(model.trim());
    }
    expect(() => settings.save('local', { ...cfg.providers.local, spec: { model: '   ', thinking: false }, pricing: [] })).toThrow('模型名');
    expect(endpoint('local').spec.model).toBe('padded-name');
  });
});
