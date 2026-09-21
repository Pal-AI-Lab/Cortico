/**
 * OpenAI Responses Compatible 模块(原生 Responses):请求体、鉴权头、流式装配、错误形状、条目校验。
 * 所有 HTTP 都打桩;夹具帧按 DeepSeek / OpenAI 的真实事件名写。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import module, { compatOptions } from '../../src/providers/openai-responses-compat/index.ts';
import { ResponsesProvider, buildResponsesBody } from '../../src/providers/openai-responses-compat/native.ts';
import { validateEntry, validateSpec } from '../../src/providers/configuration.ts';
import { responseRequest } from '../../src/protocol/open-responses/context-helpers.ts';
import { message, record } from '../../src/protocol/open-responses/context.ts';
import { GenerationError } from '../../src/core/generation.ts';
import type { StreamEvent } from '../../src/protocol/open-responses/index.ts';
import type { LLMProviderEntry, ModelSpec } from '../../src/core/types.ts';

afterEach(() => vi.unstubAllGlobals());

const context = [message('system', 'sys'), message('user', 'hi')];
const request = (spec: ModelSpec) => responseRequest(spec, context);
/** DeepSeek 风格:reasoning_text 事件名、无 [DONE] 帧。 */
const sse = (values: unknown[]): Response => new Response(values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''));
const resource = (overrides: Record<string, unknown> = {}) => ({
  id: 'resp_1', model: 'deepseek-flash', status: 'completed',
  output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
  usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 1 } },
  ...overrides,
});

describe('buildResponsesBody(请求体)', () => {
  it('system 上提为 instructions;无状态回放;effort 三种形态', () => {
    const on = buildResponsesBody(request({ model: 'm', thinking: true, reasoningEffort: 'max' }), { context }, {});
    expect(on).toMatchObject({ model: 'm', instructions: 'sys', store: false, stream: false, reasoning: { effort: 'max' } });
    expect((on.input as unknown[]).length).toBe(1);
    expect('previous_response_id' in on).toBe(false);
    const off = buildResponsesBody(request({ model: 'm', thinking: false }), { context }, {});
    expect(off.reasoning).toEqual({ effort: 'none' });
    const endpointDefault = buildResponsesBody(request({ model: 'm', thinking: true }), { context }, {});
    expect('reasoning' in endpointDefault).toBe(false);
  });
  it('include 只在加密形态带;明文形态不带,调用方点名的照带', () => {
    const spec: ModelSpec = { model: 'm', thinking: true };
    const encrypted = buildResponsesBody(request(spec), { context }, {});
    expect(encrypted.include).toEqual(['reasoning.encrypted_content']);
    const plaintext = buildResponsesBody(request(spec), { context }, { reasoningReplay: 'plaintext' });
    expect('include' in plaintext).toBe(false);
    const asked = buildResponsesBody({ ...request(spec), include: ['message.output_text.logprobs'] }, { context }, { reasoningReplay: 'plaintext' });
    expect(asked.include).toEqual(['message.output_text.logprobs']);
  });
  it('工具只带协议声明的成员,其余一律不进线', () => {
    const tool = { name: 'mc_dig', description: '挖一格', parameters: { type: 'object', properties: {} }, tags: ['world'], usage: '挖掘' };
    const body = buildResponsesBody(responseRequest({ model: 'm', thinking: false }, context, [tool as never]), { context }, {});
    expect(body.tools).toEqual([{ type: 'function', name: 'mc_dig', description: '挖一格', parameters: { type: 'object', properties: {} } }]);
  });
  it('extraBody 最后并入;sessionId 成为 prompt_cache_key;流式按 onEvent', () => {
    const body = buildResponsesBody(request({ model: 'm', thinking: true, temperature: 0.7, maxTokens: 64 }), { context, sessionId: 'main', onEvent: () => {} }, {}, { service_tier: 'flex', temperature: 1 });
    expect(body).toMatchObject({ stream: true, prompt_cache_key: 'main', service_tier: 'flex', temperature: 1, max_output_tokens: 64 });
  });
  it('multimodal 开启时附件升格为 input_image 分片;关闭时正文照发', () => {
    const blobs = [{ handle: 'blob:x', mime: 'image/png' }] as never;
    const attached = [record({ type: 'message', id: 'msg_u', status: 'completed', role: 'user', content: [{ type: 'input_text', text: '看图' }] } as never, { blobs })];
    const media = { read: () => Buffer.from('png'), enabled: () => true };
    const on = buildResponsesBody({ model: 'm' }, { context: attached }, { media });
    expect((on.input as Array<{ content: unknown[] }>)[0].content).toEqual([
      { type: 'input_text', text: '看图' }, { type: 'input_image', image_url: `data:image/png;base64,${Buffer.from('png').toString('base64')}` },
    ]);
    const off = buildResponsesBody({ model: 'm' }, { context: attached }, { media: { ...media, enabled: () => false } });
    expect((off.input as Array<{ content: unknown[] }>)[0].content).toEqual([{ type: 'input_text', text: '看图' }]);
  });
});

describe('ResponsesProvider(HTTP 边界)', () => {
  it('打 <baseUrl>/responses,带 Bearer 与附加头;非流式资源解析出计量与服务档', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(resource({ service_tier: 'default' })), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new ResponsesProvider({ baseUrl: 'https://api.deepseek.com/', apiKey: 'sk-1', extraHeaders: { 'X-Title': 'cortico' } });
    const result = await client.respond(request({ model: 'deepseek-flash', thinking: false }), { context });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/responses');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({ 'Content-Type': 'application/json', 'X-Title': 'cortico', Authorization: 'Bearer sk-1' });
    expect(result.response.output[0]).toMatchObject({ type: 'message' });
    expect(result.attempts[0]).toMatchObject({ outcome: 'completed', serviceTier: 'default', meters: { input: 12, output: 3, cachedInput: 8, uncachedInput: 4, reasoning: 1 } });
  });
  it('端点路径可覆盖;无密钥不带 Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(resource()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new ResponsesProvider({ baseUrl: 'http://127.0.0.1:8090/v1', endpointPath: '/v2/responses' }).respond(request({ model: 'm', thinking: false }), { context });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8090/v1/v2/responses');
    expect('Authorization' in ((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>)).toBe(false);
  });
  it('流式:reasoning_text 事件按标准名转发,流关即收尾(没有 [DONE]),usage 从 completed 帧取', async () => {
    const initial = { id: 'resp_s', model: 'deepseek-flash', status: 'in_progress', output: [] };
    const reasoning = { id: 'rs_1', type: 'reasoning', status: 'completed', summary: [], content: [{ type: 'reasoning_text', text: '想' }] };
    const text = { id: 'msg_s', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '好', annotations: [] }] };
    vi.stubGlobal('fetch', async () => sse([
      { type: 'response.created', response: initial },
      { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, item_id: 'rs_1', content_index: 0, part: { type: 'reasoning_text', text: '' } },
      { type: 'response.reasoning_text.delta', output_index: 0, item_id: 'rs_1', content_index: 0, delta: '想' },
      { type: 'response.reasoning_text.done', output_index: 0, item_id: 'rs_1', content_index: 0, text: '想' },
      { type: 'response.content_part.done', output_index: 0, item_id: 'rs_1', content_index: 0, part: reasoning.content[0] },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { ...text, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 1, item_id: 'msg_s', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_s', content_index: 0, delta: '好', logprobs: [] },
      { type: 'response.output_text.done', output_index: 1, item_id: 'msg_s', content_index: 0, text: '好', logprobs: [] },
      { type: 'response.content_part.done', output_index: 1, item_id: 'msg_s', content_index: 0, part: text.content[0] },
      { type: 'response.output_item.done', output_index: 1, item: text },
      { type: 'response.completed', response: { ...initial, status: 'completed', output: [reasoning, text], usage: { input_tokens: 5, output_tokens: 2, output_tokens_details: { reasoning_tokens: 1 } } } },
    ].map((event, sequence_number) => ({ ...event, sequence_number }))));
    const events: StreamEvent[] = [];
    const result = await new ResponsesProvider({ baseUrl: 'https://api.deepseek.com' }).respond(request({ model: 'deepseek-flash', thinking: true }), { context, onEvent: (event) => events.push(event) });
    expect(events.map((event) => event.type)).toContain('response.reasoning.delta');
    expect(events.some((event) => event.type.includes('reasoning_text'))).toBe(false);
    expect(result.response.output.map((item) => item.type)).toEqual(['reasoning', 'message']);
    expect(result.attempts[0].meters).toMatchObject({ input: 5, output: 2, reasoning: 1 });
  });
  it('404 是不可重试的请求拒绝:一发即抛,状态码留在错误上', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('no route', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const caught = await new ResponsesProvider({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' })
      .respond(request({ model: 'gemini', thinking: false }), { context }).catch((error) => error);
    expect(caught).toBeInstanceOf(GenerationError);
    expect(caught.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('模块声明与条目校验', () => {
  const entry = (patch: Partial<LLMProviderEntry> = {}): LLMProviderEntry => ({ kind: 'openai-responses-compat', baseUrl: 'https://api.openai.com/v1', ...patch });
  it('开放档位:任意非空 effort 通过,关思维链时不能带 effort;归一化裁掉空白', () => {
    expect(module.reasoningTiers).toEqual([]);
    expect(validateSpec(module, entry(), { model: ' m ', thinking: true, reasoningEffort: ' max ' })).toEqual({ model: 'm', thinking: true, reasoningEffort: 'max' });
    expect(() => validateSpec(module, entry(), { model: 'm', thinking: true, reasoningEffort: '  ' })).toThrow('推理强度');
    expect(() => validateSpec(module, entry(), { model: 'm', thinking: false, reasoningEffort: 'low' })).toThrow('关闭');
  });
  it('候选只有两样:几个端点地址与一份 effort 词表,都与具体厂商无关', () => {
    expect(module.effortSuggestions).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    // 地址是候选不是身份:条目里不记选了哪条,模块也不因此改变任何行为。
    expect(module.baseUrlSuggestions).toEqual([
      'https://api.openai.com/v1', 'https://api.deepseek.com', 'https://openrouter.ai/api/v1', 'https://api.x.ai/v1',
    ]);
    for (const url of module.baseUrlSuggestions) expect(url.endsWith('/')).toBe(false);
    expect(module.defaultBaseUrl).toBe(module.baseUrlSuggestions[0]);
  });
  it('条目校验:不以 / 开头的路径、非字符串头、非对象体都拒;空值归一化后消失', () => {
    expect(() => validateEntry(module, entry({ options: { endpointPath: 'responses' } }))).toThrow('以 / 开头');
    expect(() => validateEntry(module, entry({ options: { extraHeaders: { a: 1 } } }))).toThrow('附加请求头');
    expect(() => validateEntry(module, entry({ options: { extraBody: [] } }))).toThrow('附加请求体');
    expect(() => validateEntry(module, entry({ options: { reasoningReplay: 'signed' } }))).toThrow('encrypted 或 plaintext');
    expect(() => validateEntry(module, entry({ options: { syntheticReasoningText: '   ' } }))).toThrow('空串或全空白');
    const normalized = validateEntry(module, entry({ options: { endpointPath: '', extraHeaders: {}, extraBody: {}, reasoningReplay: '', syntheticReasoningText: '' } }));
    expect(compatOptions(normalized)).toEqual({});
    expect(compatOptions(validateEntry(module, entry({ options: { reasoningReplay: 'plaintext' } }))).reasoningReplay).toBe('plaintext');
  });
  it('实例:密钥经 host 取,模型目录与窗口挂在实例上,兼容键含端点路径', () => {
    const instance = module.create('cloud', entry({ secret: 'K', options: { endpointPath: '/x' } }), {
      stateDir: 'unused', secret: (name) => (name === 'K' ? 'sk' : ''), readBlob: () => null, keepThinking: () => true,
      log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never,
    });
    expect(instance.client).toBeInstanceOf(ResponsesProvider);
    expect(typeof instance.listModels).toBe('function');
    expect(instance.contextWindow!('anything')).toBeUndefined();
    expect(instance.compatibilityKey!()).toEqual(['/x', 'cloud']);
  });
});
