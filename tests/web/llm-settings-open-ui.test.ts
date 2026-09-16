import { afterEach, describe, expect, it } from 'vitest';
import {
  mountPanel,
  change,
  button,
  flush,
  doc,
  openBaseUrls,
  openEfforts,
} from './provider-settings-fixture.ts';

type Any = any;
let cleanup: () => void = () => {};
afterEach(() => cleanup());

interface Instance {
  name: string;
  entry: Record<string, unknown>;
  quotes: unknown[];
  secretConfigured: 'env' | 'file' | 'none';
}
/**
 * 开放模块的数据面替身:`state` 回一份可变的表,写类方法默认回 `{ok:true}` 并记下请求体,
 * 单个方法的行为由测试用 `handlers` 覆盖。
 */
function fakeSettings(instances: Instance[], options: { suggestions?: boolean } = {}) {
  const state: Record<string, unknown> = {
    active: instances[0]?.name ?? '',
    reasoningTiers: [],
    serviceTiers: [],
    effortSuggestions: openEfforts,
    instances,
    ...(options.suggestions === false ? {} : { baseUrlSuggestions: openBaseUrls }),
  };
  const calls: Array<{ method: string; body: Any }> = [];
  const handlers: Record<string, (body: Any) => unknown> = {};
  const invoke = async (method: string, args: unknown[]) => {
    if (method === 'state') return state;
    const body = args[0] as Any;
    calls.push({ method, body });
    if (handlers[method]) return handlers[method](body);
    return method === 'models' ? { models: [] } : { ok: true };
  };
  const last = (method: string) => calls.filter((c) => c.method === method).at(-1)?.body;
  const bodies = (method: string) => calls.filter((c) => c.method === method).map((c) => c.body);
  return { state, calls, handlers, invoke, last, bodies };
}
function instance(patch: Partial<Instance> = {}, entry: Record<string, unknown> = {}): Instance {
  return {
    name: 'primary',
    entry: {
      kind: 'fixture-open-llm',
      baseUrl: 'https://alpha.test/v1',
      secret: 'ALPHA_API_KEY',
      spec: { model: 'alpha-large', thinking: true, reasoningEffort: 'high' },
      ...entry,
    },
    quotes: [],
    secretConfigured: 'none',
    ...patch,
  };
}
const byLabel = (root: Any, label: string) => root.querySelector(`[aria-label="${label}"]`);
const tick = (checkbox: Any, checked: boolean) => {
  checkbox.checked = checked;
  checkbox.dispatchEvent(new doc.defaultView.Event('change'));
};

describe('开放推理强度', () => {
  it('effort 文本框带候选 datalist;空 = 端点默认、none = 关闭、其余原串落 reasoningEffort', async () => {
    for (const [typed, expected] of [
      ['', { model: 'alpha-large', thinking: true }],
      ['none', { model: 'alpha-large', thinking: false }],
      ['xhigh', { model: 'alpha-large', thinking: true, reasoningEffort: 'xhigh' }],
    ] as const) {
      const server = fakeSettings([instance()]);
      const view = await mountPanel(server.invoke);
      cleanup = view.cleanup;
      const effort = byLabel(view.root, '推理强度');
      expect(effort.tagName).toBe('INPUT');
      expect(effort.value).toBe('high');
      const list = view.root.querySelector(`datalist#${effort.getAttribute('list')}`);
      expect([...list.options].map((o: Any) => o.value)).toEqual(['none', 'low', 'high']);
      expect(byLabel(view.root, '推理档位')).toBeNull();
      change(effort, typed);
      await flush();
      expect(server.last('save').spec).toEqual(expected);
      cleanup();
    }
  });
  it('thinking:false 的档回显为 none', async () => {
    const view = await mountPanel(
      fakeSettings([instance({}, { spec: { model: 'm', thinking: false } })]).invoke,
    );
    cleanup = view.cleanup;
    expect(byLabel(view.root, '推理强度').value).toBe('none');
  });
});

describe('新建实例', () => {
  const urlField = (root: Any) => root.querySelector('input[placeholder="HTTP(S) 供应地址"]');
  it('地址格挂着候选 datalist,但照收自写地址;送出的只有名字与地址', async () => {
    const server = fakeSettings([instance()]);
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    const url = urlField(view.root);
    const list = view.root.querySelector(`datalist#${url.getAttribute('list')}`);
    expect([...list.options].map((o: Any) => o.value)).toEqual(openBaseUrls);
    change(view.root.querySelector('input[placeholder="新实例名称"]'), 'second');
    change(url, openBaseUrls[1]);
    button(view.root, '添加实例').click();
    await flush();
    expect(server.last('create')).toEqual({ name: 'second', baseUrl: openBaseUrls[1] });
    // 成功后整页重读;候选之外的地址一样收
    change(view.root.querySelector('input[placeholder="新实例名称"]'), 'third');
    change(urlField(view.root), 'http://localhost:8080/v1');
    button(view.root, '添加实例').click();
    await flush();
    expect(server.last('create')).toEqual({ name: 'third', baseUrl: 'http://localhost:8080/v1' });
  });
  it('模块不给候选地址时这一格就是空 datalist,两格照旧', async () => {
    const server = fakeSettings([instance()], { suggestions: false });
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    const url = urlField(view.root);
    expect(view.root.querySelector(`datalist#${url.getAttribute('list')}`).options.length).toBe(0);
    change(view.root.querySelector('input[placeholder="新实例名称"]'), 'plain');
    change(url, 'http://h/v1');
    button(view.root, '添加实例').click();
    await flush();
    expect(server.last('create')).toEqual({ name: 'plain', baseUrl: 'http://h/v1' });
  });
});

describe('连接表', () => {
  it('每格改完即存;面板不认的 options 键原样留着,空的删掉', async () => {
    const server = fakeSettings([
      instance({}, { options: { vendorOnly: 'keep-me', extraBody: { store: false } } }),
    ]);
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    expect(byLabel(view.root, '请求路径').value).toBe('/responses');
    expect(byLabel(view.root, '附加请求体（JSON 对象）').value).toContain('"store": false');
    change(byLabel(view.root, '供应地址'), 'https://alpha.test/v2 ');
    change(byLabel(view.root, '密钥变量名'), 'ALPHA_KEY_2');
    tick(view.root.querySelector('label.check input'), true);
    change(byLabel(view.root, '请求路径'), '/v1/responses');
    change(byLabel(view.root, '附加请求头（JSON 对象）'), '{"HTTP-Referer": "https://x.test"}');
    change(byLabel(view.root, '附加请求体（JSON 对象）'), '');
    await flush();
    const bodies = server.bodies('save');
    expect(bodies.every((body: Any) => body.name === 'primary')).toBe(true);
    expect(bodies.map((body: Any) => body.baseUrl).filter(Boolean)).toEqual(['https://alpha.test/v2']);
    expect(bodies.map((body: Any) => body.secret).filter(Boolean)).toEqual(['ALPHA_KEY_2']);
    expect(bodies.some((body: Any) => body.multimodal === true)).toBe(true);
    expect(server.last('save').options).toEqual({
      vendorOnly: 'keep-me',
      endpointPath: '/v1/responses',
      extraHeaders: { 'HTTP-Referer': 'https://x.test' },
    });
  });
  it('地址或密钥变量名改过就重取模型列表', async () => {
    const server = fakeSettings([instance()]);
    server.handlers.models = () => ({ models: [{ id: 'alpha-mini' }] });
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    expect(server.bodies('models')).toEqual([]);
    change(byLabel(view.root, '供应地址'), 'https://beta.test/v1');
    await flush();
    expect(server.bodies('models')).toEqual([{ name: 'primary' }]);
    expect(byLabel(view.root, '模型').tagName).toBe('SELECT');
  });
  it('附加请求头不是 JSON 对象时不保存,报错留在面板', async () => {
    const server = fakeSettings([instance()]);
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    change(byLabel(view.root, '附加请求头（JSON 对象）'), '["a"]');
    await flush();
    expect(server.calls.filter((c) => c.method === 'save')).toEqual([]);
    expect(view.root.textContent).toContain('附加请求头（JSON 对象） 必须是 JSON 对象');
  });
  it('写入密钥:送出变量所属实例与值,成功后输入框清空、来源药丸更新', async () => {
    const current = instance();
    const server = fakeSettings([current]);
    server.handlers.setSecret = (body) => {
      expect(body).toEqual({ name: 'primary', value: 'sk-secret' });
      current.secretConfigured = 'file';
      return { ok: true };
    };
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    expect(view.root.querySelector('.pill.off').textContent).toBe('未配置');
    const value = byLabel(view.root, '密钥值');
    expect(value.type).toBe('password');
    change(value, 'sk-secret');
    button(view.root, '写入密钥').click();
    await flush();
    expect(server.calls.map((c) => c.method)).toEqual(['setSecret']);
    expect(byLabel(view.root, '密钥值').value).toBe('');
    expect(view.root.querySelector('.pill.on').textContent).toBe('端点 .env');
    expect(view.root.textContent).toContain('密钥已写入端点 .env。');
  });
  it('还没填密钥变量名的实例给出提示', async () => {
    const view = await mountPanel(fakeSettings([instance({}, { secret: undefined })]).invoke);
    cleanup = view.cleanup;
    expect(view.root.textContent).toContain('先保存密钥变量名');
  });
});

describe('模块段落', () => {
  it('连接与模型档之间留给模块,作用域是当前实例;换实例时上一批结束', async () => {
    const server = fakeSettings([instance(), instance({ name: 'second' })]);
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    expect(view.slots).toEqual([
      expect.objectContaining({ slot: 'instance', scope: { instance: 'primary' }, disposed: false }),
    ]);
    change(view.root.querySelector('select'), 'second');
    await flush();
    expect(view.slots.map((s: Any) => [s.scope.instance, s.disposed])).toEqual([
      ['primary', true],
      ['second', false],
    ]);
  });
});

describe('成本三格表', () => {
  const rateOf = (root: Any, label: string) => byLabel(root, label).value;
  it('没有报价时三格留空并说明未设;填一格才落成一条 * 边际规则', async () => {
    const server = fakeSettings([instance({}, { pricing: [] })]);
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    expect(byLabel(view.root, '币种').value).toBe('USD');
    expect(
      ['缓存命中 / 百万 token', '未缓存输入 / 百万 token', '输出 / 百万 token'].map((l) =>
        rateOf(view.root, l),
      ),
    ).toEqual(['', '', '']);
    expect(view.root.textContent).toContain('未设报价');
    expect(view.root.querySelector('details').open).toBe(false);
    change(byLabel(view.root, '输出 / 百万 token'), '15');
    await flush();
    expect(server.last('save').pricing).toEqual([
      {
        models: ['*'],
        currency: 'USD',
        basis: 'marginal',
        source: 'console',
        rules: [
          { meter: 'cachedInput', perMillion: 0 },
          { meter: 'uncachedInput', perMillion: 0 },
          { meter: 'output', perMillion: 15 },
        ],
      },
    ]);
  });
  it('三格全清回到未设', async () => {
    const server = fakeSettings([
      instance({}, {
        pricing: [{
          models: ['*'], currency: 'USD', basis: 'marginal', source: 'console',
          rules: [
            { meter: 'cachedInput', perMillion: 1 },
            { meter: 'uncachedInput', perMillion: 2 },
            { meter: 'output', perMillion: 3 },
          ],
        }],
      }),
    ]);
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    for (const label of ['缓存命中 / 百万 token', '未缓存输入 / 百万 token', '输出 / 百万 token'])
      change(byLabel(view.root, label), '');
    await flush();
    expect(server.last('save').pricing).toEqual([]);
  });
  it('已存的正是那一条 * 规则时回填三格;改一格连同其余两格一起送回', async () => {
    const pricing = [
      {
        models: ['*'],
        currency: 'CNY',
        basis: 'marginal',
        source: 'console',
        rules: [
          { meter: 'uncachedInput', perMillion: 2 },
          { meter: 'cachedInput', perMillion: 0.5 },
          { meter: 'output', perMillion: 8 },
        ],
      },
    ];
    const server = fakeSettings([instance({}, { pricing })]);
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    expect(byLabel(view.root, '币种').value).toBe('CNY');
    expect(rateOf(view.root, '缓存命中 / 百万 token')).toBe('0.5');
    expect(rateOf(view.root, '未缓存输入 / 百万 token')).toBe('2');
    expect(rateOf(view.root, '输出 / 百万 token')).toBe('8');
    change(byLabel(view.root, '输出 / 百万 token'), '9');
    await flush();
    expect(server.last('save').pricing[0].rules).toEqual([
      { meter: 'cachedInput', perMillion: 0.5 },
      { meter: 'uncachedInput', perMillion: 2 },
      { meter: 'output', perMillion: 9 },
    ]);
  });
  it('三格表达不了的报价:三格留空、完整规则展开并持有原值;改 JSON 以 JSON 为准,改三格则覆盖', async () => {
    const pricing = [
      {
        models: ['alpha-large'],
        currency: 'USD',
        basis: 'marginal',
        source: 'sheet',
        rules: [{ meter: 'output', perMillion: 3 }],
      },
      { models: ['alpha-mini'], currency: 'USD', basis: 'marginal', source: 'sheet', rules: [] },
    ];
    const server = fakeSettings([instance({}, { pricing })]);
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    expect(rateOf(view.root, '输出 / 百万 token')).toBe('');
    expect(view.root.textContent).toContain('以下方完整规则为准');
    const advanced = view.root.querySelector('details');
    expect(advanced.open).toBe(true);
    const raw = advanced.querySelector('textarea');
    expect(JSON.parse(raw.value)).toEqual(pricing);
    change(raw, JSON.stringify([pricing[1]]));
    await flush();
    expect(server.last('save').pricing).toEqual([pricing[1]]);
    change(byLabel(view.root, '缓存命中 / 百万 token'), '1');
    await flush();
    expect(server.last('save').pricing).toEqual([
      expect.objectContaining({
        models: ['*'],
        rules: [
          { meter: 'cachedInput', perMillion: 1 },
          { meter: 'uncachedInput', perMillion: 0 },
          { meter: 'output', perMillion: 0 },
        ],
      }),
    ]);
  });
  it('完整规则那格写坏时不往端点写,解析错误留在卡上', async () => {
    const server = fakeSettings([instance({}, { pricing: [] })]);
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    change(view.root.querySelector('details textarea'), '{ 不是 JSON');
    await flush();
    expect(server.bodies('save')).toEqual([]);
    expect(view.root.querySelector('details .msgline.bad').textContent).toContain('SyntaxError');
  });
});

describe('探测与模型列表', () => {
  it('成功的探测渲染状态、耗时、回显模型、用量、加密思维链与本次费用;探测中按钮禁用', async () => {
    const server = fakeSettings([instance()]);
    let settle: (value: unknown) => void = () => {};
    server.handlers.probe = () => new Promise((resolve) => (settle = resolve));
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    const probe = button(view.root, '测试可用性');
    probe.click();
    await flush();
    expect(probe.disabled).toBe(true);
    settle({
      ok: true,
      status: 200,
      elapsedMs: 1234,
      model: 'alpha-large-2026',
      usage: { input: 12, cachedInput: 0, output: 5, reasoning: 40 },
      encryptedReasoning: true,
      charges: [{ currency: 'USD', amount: 0.0012 }],
    });
    await flush();
    expect(probe.disabled).toBe(false);
    expect(server.last('probe')).toEqual({ name: 'primary' });
    const card = view.root.querySelector('.kvtable');
    const text = card.textContent;
    expect(text).toContain('成功 · 200');
    expect(text).toContain('1.2s');
    expect(text).toContain('alpha-large-2026');
    expect(text).toContain('输入 12 · 缓存命中 0 · 输出 5 · 推理 40');
    expect(text).toContain('有');
    expect(text).toContain('$0.0012');
    expect(view.root.querySelector('.msgline.bad')).toBeNull();
  });
  it('失败的探测把 error 与 hint 放进警示行', async () => {
    const server = fakeSettings([instance()]);
    server.handlers.probe = () => ({
      ok: false,
      status: 404,
      elapsedMs: 80,
      error: 'HTTP 404',
      hint: '该 baseUrl 没有 Responses 端点',
    });
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    button(view.root, '测试可用性').click();
    await flush();
    expect(view.root.querySelector('.kvtable').textContent).toContain('失败 · 404');
    const bad = [...view.root.querySelectorAll('.msgline.bad')].map((n: Any) => n.textContent);
    expect(bad).toEqual(['HTTP 404', '该 baseUrl 没有 Responses 端点']);
  });
  it('取到模型列表就把模型格换成选单,选中的那个带出上下文窗口', async () => {
    const server = fakeSettings([instance()]);
    server.handlers.models = () => ({
      models: [{ id: 'alpha-large', contextWindow: 128000 }, { id: 'alpha-mini' }],
    });
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    button(view.root, '取模型列表').click();
    await flush();
    const model = byLabel(view.root, '模型');
    expect(model.tagName).toBe('SELECT');
    expect([...model.options].map((o: Any) => o.value)).toEqual(['alpha-large', 'alpha-mini']);
    expect(view.root.textContent).toContain('取到 2 个模型。');
    expect(byLabel(view.root, '上下文窗口').value).toBe('128000');
    expect(server.last('save').spec.contextWindow).toBe(128000);
    change(byLabel(view.root, '模型'), 'alpha-mini');
    await flush();
    expect(server.last('save').spec.model).toBe('alpha-mini');
  });
  it('取不到模型列表就留在自由输入,原因写在模型格下面', async () => {
    const server = fakeSettings([instance()]);
    server.handlers.models = () => {
      throw new Error('端点不提供模型列表');
    };
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    button(view.root, '取模型列表').click();
    await flush();
    expect(byLabel(view.root, '模型').tagName).toBe('INPUT');
    expect(view.root.textContent).toContain('取不到模型列表：Error: 端点不提供模型列表');
  });
  it('模型名没有默认候选:占位符是通用的,手填一个目录外的名字照样保存', async () => {
    const server = fakeSettings([instance()]);
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    const model = byLabel(view.root, '模型');
    expect(model.placeholder).toBe('明确模型名');
    change(model, 'vendor/brand-new-model:2027-preview');
    await flush();
    expect(server.last('save').spec.model).toBe('vendor/brand-new-model:2027-preview');
  });
});

describe('删除与复制', () => {
  const proceed = () => button(doc.body, '仍要继续');
  it('删除先弹危险确认;服务端拒删当前实例时把措辞放进面板,实例仍在', async () => {
    const server = fakeSettings([instance()]);
    server.handlers.delete = () => {
      throw new Error('不能删除当前供应实例');
    };
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    button(view.root, '删除').click();
    await flush();
    expect(doc.body.textContent).toContain('删除实例 primary？');
    proceed().click();
    await flush();
    expect(server.last('delete')).toEqual({ name: 'primary' });
    expect(view.root.textContent).toContain('不能删除当前供应实例');
    expect([...view.root.querySelector('select').options].map((o: Any) => o.value)).toEqual(['primary']);
  });
  it('确认框取消则不发请求', async () => {
    const server = fakeSettings([instance()]);
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    button(view.root, '删除').click();
    await flush();
    button(doc.body, '取消').click();
    await flush();
    expect(server.calls).toEqual([]);
  });
  it('复制:点开一行输入副本名,成功后选中副本', async () => {
    const server = fakeSettings([instance()]);
    server.handlers.duplicate = (body) => {
      (server.state.instances as Instance[]).push(instance({ name: body.as }));
      return { ok: true };
    };
    const view = await mountPanel(server.invoke);
    cleanup = view.cleanup;
    const name = byLabel(view.root, '副本名称');
    expect(name.closest('div[hidden]')).not.toBeNull();
    button(view.root, '复制').click();
    expect(name.closest('div[hidden]')).toBeNull();
    change(name, 'copy');
    button(view.root, '复制为').click();
    await flush();
    expect(server.last('duplicate')).toEqual({ name: 'primary', as: 'copy' });
    expect(view.root.querySelector('select').value).toBe('copy');
    expect(view.root.textContent).toContain('已复制。');
  });
});

describe('英文表', () => {
  it('language=en 时按钮与字段全部走英文', async () => {
    const view = await mountPanel(fakeSettings([instance()]).invoke, 'en');
    cleanup = view.cleanup;
    for (const label of ['Test endpoint', 'Duplicate', 'Delete', 'Fetch models', 'Save key'])
      expect(button(view.root, label)).toBeDefined();
    expect(byLabel(view.root, 'Reasoning effort')).not.toBeNull();
    expect(byLabel(view.root, 'Cache hit / M tokens')).not.toBeNull();
  });
});
