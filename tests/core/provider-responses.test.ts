import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { OpenAIHttpClient } from '../../src/providers/transport/chat.ts';
import { mapTools, renderMessagesWithMedia } from '../../src/providers/transport/history.ts';
import type { NativeChatMessage } from '../../src/providers/transport/native-types.ts';
import type { ModelSpec, ToolSchema } from '../../src/core/types.ts';
import { nullLogger } from '../../src/core/util.ts';
import { ChatResponseAssembly, NativeResponseAssembly } from '../../src/providers/transport/response-assembly.ts';
import { EventDecoder } from '../../src/providers/transport/response-http.ts';
import { GenerationError, priceUsage, unknownMeters } from '../../src/core/generation.ts';
import { ResponsesProvider } from '../../src/providers/openai-responses-compat/native.ts';
import type { FunctionCall, StreamEvent } from '../../src/protocol/open-responses/index.ts';

const sse = (values: unknown[]): Response => new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

/** The Chat transport is used by llamacpp and extensions; this adapter tests their shared transport behavior. */
class ChatFixture extends OpenAIHttpClient {
  constructor(baseUrl = 'https://fixture.test') { super(baseUrl, nullLogger()); }
  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[], tools?: ToolSchema[]): Record<string, unknown> {
    const mapped = mapTools(tools);
    return { model: spec.model, messages: renderMessagesWithMedia(messages, undefined, { keepReasoning: true }), ...(mapped ? { tools: mapped } : {}) };
  }
  protected headers(): Record<string, string> { return { 'Content-Type': 'application/json' }; }
}

describe('Provider standard Responses boundary', () => {
  it('assembles a native reasoning Item from its deltas and replays them as events',()=>{
    const assembly=new NativeResponseAssembly();const events:StreamEvent[]=[];
    const initial={id:'r-native',model:'test',status:'in_progress',output:[]};
    const item={id:'reason',type:'reasoning',status:'completed',summary:[],content:[{type:'reasoning_text',text:'checked'}]};
    const native=[
      {type:'response.created',response:initial},
      {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
      {type:'response.content_part.added',output_index:0,item_id:'reason',content_index:0,part:{type:'reasoning_text',text:''}},
      {type:'response.reasoning.delta',output_index:0,item_id:'reason',content_index:0,delta:'checked'},
      {type:'response.reasoning.done',output_index:0,item_id:'reason',content_index:0,text:'checked'},
      {type:'response.content_part.done',output_index:0,item_id:'reason',content_index:0,part:item.content[0]},
      {type:'response.output_item.done',output_index:0,item},
      {type:'response.completed',response:{...initial,status:'completed',output:[item]}},
    ];
    native.forEach((event,sequence_number)=>assembly.feed({...event,sequence_number},event=>events.push(event)));
    expect(assembly.finish().output).toEqual([item]);
    expect(events.map(event=>event.type)).toContain('response.reasoning.delta');
  });
  it('maps standard media, sampling and structured output at the native Chat boundary', async () => {
    let body: any;
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }));
    });
    const client = new ChatFixture();
    await client.respond({ model: 'test', input: [{ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'https://fixture.test/img.png', detail: 'high' },
      { type: 'input_file', filename: 'notes.txt', file_data: 'data:text/plain;base64,aGk=' },
    ] }], top_p: 0.8, tool_choice: { type: 'function', name: 'inspect' }, text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } } });
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'https://fixture.test/img.png', detail: 'high' } },
      { type: 'file', file: { filename: 'notes.txt', file_data: 'data:text/plain;base64,aGk=' } }]);
    expect(body).toMatchObject({ top_p: 0.8, tool_choice: { type: 'function', function: { name: 'inspect' } }, response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true } } });
    await expect(client.respond({ model: 'test', input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_url: 'https://fixture.test/file' }] }] })).rejects.toThrow('inline file_data');
  });

  it('chat history attaches only image blobs; other blobs stay as their text line', () => {
    const media = { enabled: () => true, read: () => Buffer.from('x') };
    const [audio, mixed] = renderMessagesWithMedia([
      { role: 'tool', content: '[blob log:a audio/mpeg] clip', tool_call_id: 'c1', blobs: [{ handle: 'log:a', mime: 'audio/mpeg' }] },
      { role: 'user', content: 'look', blobs: [{ handle: 'log:a', mime: 'audio/mpeg' }, { handle: 'log:i', mime: 'image/png' }] },
    ] as any, media);
    expect(audio.content).toBe('[blob log:a audio/mpeg] clip');
    expect(mixed.content).toEqual([{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('x').toString('base64')}` } }]);
  });

  it('normalizes partial native usage without representing missing meters as zero', () => {
    const assembly = new NativeResponseAssembly();
    const response = { id: 'partial-usage', model: 'test', output: [], status: 'completed', usage: { input_tokens: 50, output_tokens: 3 } };
    assembly.feed({ type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', usage: null } }, () => {});
    assembly.feed({ type: 'response.completed', sequence_number: 1, response }, () => {});
    expect(assembly.finish().usage).toBeNull();
    expect(assembly.meters()).toMatchObject({ input: 50, output: 3, total: 53, cachedInput: null, reasoning: null, native: { input_tokens: 50, output_tokens: 3 } });
  });

  it('treats a missing function-call status as completed only for a completed native response', () => {
    const assembly = new NativeResponseAssembly();
    const initial = { id: 'missing-status', model: 'test', status: 'in_progress', output: [] };
    const call = { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'inspect', arguments: '{}' } as unknown as FunctionCall;
    assembly.feed({ type: 'response.created', sequence_number: 0, response: initial }, () => {});
    assembly.feed({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: call }, () => {});
    assembly.feed({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: call }, () => {});
    assembly.feed({ type: 'response.completed', sequence_number: 3, response: { ...initial, status: 'completed', output: [call] } }, () => {});
    expect(assembly.finish().output[0]).toMatchObject({ type: 'function_call', status: 'completed' });

    // 截断的响应里没带 status 的调用可能只写了半截参数,保持缺省,Core 不执行它
    const truncated = new NativeResponseAssembly();
    truncated.feed({ type: 'response.created', sequence_number: 0, response: initial }, () => {});
    truncated.feed({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: call }, () => {});
    truncated.feed({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: call }, () => {});
    truncated.feed({ type: 'response.incomplete', sequence_number: 3, response: { ...initial, status: 'incomplete', output: [call] } }, () => {});
    expect(truncated.finish().output[0]).not.toHaveProperty('status');
  });

  it('normalizes omitted function-call status in a unary Responses-compatible response', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      id: 'unary-missing-status', model: 'test', status: 'completed', output: [
        { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'inspect', arguments: '{}' },
      ], usage: null,
    })));
    const result = await new ResponsesProvider({ baseUrl: 'https://fixture.test' }).respond({ model: 'test', input: [] });
    expect(result.response.output[0]).toMatchObject({ type: 'function_call', status: 'completed' });
  });

  it('keeps a response whose usage block is malformed, leaving those meters unknown', () => {
    const assembly = new ChatResponseAssembly({ model: 'test' });
    assembly.feed({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: '12', completion_tokens: -1, prompt_cache_hit_tokens: 40, total_tokens: 5 } }, () => {});
    expect(assembly.finish(() => {}).status).toBe('completed');
    expect(assembly.meters()).toMatchObject({ input: null, output: -1, cachedInput: 40, uncachedInput: null, total: 5, native: { prompt_tokens: '12' } });
  });
  it('maps native call order without overlapping text Items between tool chunks', () => {
    const assembly = new ChatResponseAssembly({ model: 'test' });
    const emit = (): void => {};
    assembly.feed({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{}' } }] } }] }, emit);
    assembly.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } }] } }] }, emit);
    assembly.feed({ choices: [{ delta: { content: 'comment' } }] }, emit);
    assembly.feed({ choices: [{ delta: { tool_calls: [{ index: 2, id: 'c', function: { name: 'third', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, emit);
    const response = assembly.finish(emit);
    expect(response.output.map(item => item.type)).toEqual(['function_call', 'function_call', 'message', 'function_call']);
    expect(response.output.filter(item => item.type === 'function_call').map(item => item.call_id)).toEqual(['a', 'b', 'c']);
  });
  it('keeps interleaved function deltas open until native completion and preserves output order', () => {
    const assembly = new ChatResponseAssembly({ model: 'deepseek-v4' });
    const events: StreamEvent[] = [];
    const emit = (event: StreamEvent): void => { events.push(event); };
    assembly.feed({ choices: [{ delta: { reasoning_content: 'consider' } }] }, emit);
    assembly.feed({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'a', function: { name: 'first', arguments: '{"x":' } },
      { index: 1, id: 'b', function: { name: 'second', arguments: '{"y":' } },
    ] } }] }, emit);
    expect(events.filter(event => event.type === 'response.output_item.done')).toHaveLength(0);
    assembly.feed({ choices: [{ delta: { tool_calls: [
      { index: 1, function: { arguments: '2}' } }, { index: 0, function: { arguments: '1}' } },
    ] }, finish_reason: 'tool_calls' }] }, emit);
    const response = assembly.finish(emit);
    expect(response.output.map(item => item.type)).toEqual(['reasoning', 'function_call', 'function_call']);
    expect(response.output.filter(item => item.type === 'function_call').map(item => [item.call_id, item.arguments, item.status]))
      .toEqual([['a', '{"x":1}', 'completed'], ['b', '{"y":2}', 'completed']]);
    expect(response.usage).toBeNull();
  });

  it('does not turn a truncated argument stream into a completed call', () => {
    const assembly = new ChatResponseAssembly({ model: 'test' });
    assembly.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'cut', function: { name: 'act', arguments: '{"script":"hel' } }] } }] }, () => {});
    expect(() => assembly.finish(() => {})).toThrow('without finish_reason');
    expect(assembly.snapshot()?.output[0]).toMatchObject({ status: 'in_progress', arguments: '{"script":"hel' });
  });

  it('a length stop marks only the Item still being written as incomplete', () => {
    const assembly = new ChatResponseAssembly({ model: 'test' });
    const emit = (): void => {};
    assembly.feed({ choices: [{ delta: { reasoning_content: 'plan' } }] }, emit);
    assembly.feed({ choices: [{ delta: { content: 'said' } }] }, emit);
    assembly.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'act', arguments: '{"script":"done"}' } }] } }] }, emit);
    assembly.feed({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'act', arguments: '{"script":"hal' } }] }, finish_reason: 'length' }] }, emit);
    const response = assembly.finish(emit);
    expect(response).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    expect(response.output.map(item => [item.type, 'status' in item ? item.status : undefined]))
      .toEqual([['reasoning', undefined], ['message', 'completed'], ['function_call', 'completed'], ['function_call', 'incomplete']]);
  });

  it('accepts trailing native chunks after finish_reason without failing the stream', () => {
    const assembly = new ChatResponseAssembly({ model: 'test' });
    const emit = (): void => {};
    assembly.feed({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, emit);
    assembly.feed({ choices: [{ delta: { role: 'assistant', content: '' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }, emit);
    expect(assembly.finish(emit).status).toBe('completed');
    expect(assembly.meters()).toMatchObject({ input: 3, output: 1 });
  });

  it('decodes real native Responses framing and retains encrypted reasoning and function identity', () => {
    const raw = readFileSync(new URL('../fixtures/responses-stream.sse', import.meta.url), 'utf8');
    const decoder = new EventDecoder();
    const assembly = new NativeResponseAssembly();
    for (let index = 0; index < raw.length; index += 17) {
      for (const payload of decoder.feed(raw.slice(index, index + 17))) {
        if (payload !== '[DONE]') assembly.feed(JSON.parse(payload), () => {});
      }
    }
    const response = assembly.finish();
    expect(response.status).toBe('completed');
    expect(response.output[0]).toMatchObject({ type: 'reasoning', encrypted_content: expect.any(String) });
    expect(response.output[1]).toMatchObject({ type: 'function_call', id: expect.any(String), call_id: expect.any(String) });
    expect(response.output.filter(item => item.type === 'function_call')).toHaveLength(1);
    expect(assembly.meters().native).toHaveProperty('input_tokens');
  });

  it('accounts for failed reasoning-only attempts before a successful retry, with separate stream identities', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T00:59:59Z'));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(sse([{ id: 'first', choices: [{ delta: { reasoning_content: 'try' } }], usage: { prompt_tokens: 20, completion_tokens: 5 } }]))
      .mockResolvedValueOnce(sse([{ id: 'second', choices: [{ delta: { content: 'ready' }, finish_reason: 'stop' }], usage: {
        prompt_tokens: 30, completion_tokens: 6, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 2 },
      } }]));
    vi.stubGlobal('fetch', fetcher);
    const events: StreamEvent[] = [];
    const promise = new ChatFixture().respond({ model: 'deepseek-v4', input: 'hi' }, { onEvent: event => { events.push(event); },
      quote: at => [{id:at.startedAt,currency:'USD',basis:'marginal',source:'time contract',capturedAt:at.startedAt,
        rules:[{meter:'output',perMillion:new Date(at.startedAt).getUTCHours() ? 2 : 1}]}] });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.attempts.map(attempt => [attempt.outcome, attempt.meters.input, attempt.meters.cachedInput]))
      .toEqual([['failed', 20, null], ['completed', 30, 10]]);
    expect(result.attempts[0].id).not.toBe(result.attempts[1].id);
    expect(result.attempts.map(attempt => attempt.charges[0].amount)).toEqual([5/1e6,12/1e6]);
    expect(result.attempts[0].charges[0].quote.id).not.toBe(result.attempts[1].charges[0].quote.id);
    expect(result.attempts.map(attempt => attempt.serviceTier)).toEqual([null,null]);
    expect(events.filter(event => event.type === 'response.created').map(event => event.response.id)).toEqual(['first', 'second']);
    expect(result.response.usage?.total_tokens).toBe(36);
  });

  it('keeps unknown prices distinct from explicitly free marginal usage', () => {
    const meters = { ...unknownMeters(), output: 4 };
    const quote = { id: 'q', currency: 'USD', basis: 'marginal' as const, source: 'test', capturedAt: '2026-09-05', rules: [{ meter: 'input' as const, perMillion: 1 }, { meter: 'output' as const, perMillion: 2 }] };
    expect(priceUsage(meters, [quote])[0]).toMatchObject({ amount: null, knownAmount: 0.000008, missing: ['input'] });
    expect(priceUsage(meters, [{ ...quote, rules: [] }])[0].amount).toBe(0);
  });

  it('returns a discarded metered result when a native request ignores cancellation', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', async () => {
      controller.abort();
      return new Response(JSON.stringify({ id: 'late', choices: [{ message: { content: 'late' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    });
    const result = await new ChatFixture().respond({ model: 'test' }, { signal: controller.signal });
    expect(result.attempts[0]).toMatchObject({ outcome: 'discarded', meters: { input: 10, output: 2 } });
  });

  it('carries consumed usage and unfinished Items on a committed stream failure', async () => {
    vi.stubGlobal('fetch', async () => sse([{ choices: [{ delta: { content: 'partial' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }]));
    const caught = await new ChatFixture().respond({ model: 'test' }, { onEvent: () => {} }).catch(error => error);
    expect(caught).toBeInstanceOf(GenerationError);
    expect(caught.attempts).toHaveLength(1);
    expect(caught.attempts[0].meters.input).toBe(10);
    expect(caught.partial.output[0]).toMatchObject({ status: 'in_progress' });
  });

  it('keepalive frames are not progress: the content idle watchdog aborts a silent stream and the ladder retries it', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let fetches = 0;
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      fetches++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          // 模拟 fetch：abort 后读取响应体失败。
          init.signal?.addEventListener('abort', () => { try { controller.error(init.signal?.reason); } catch { /* already closed */ } }, { once: true });
          const ping = (): void => {
            if (init.signal?.aborted) return;
            try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { return; }
            setTimeout(ping, 10_000);
          };
          ping();
        },
      }));
    });
    const promise = new ChatFixture().respond({ model: 'test' }, { onEvent: () => {} }).catch(error => error);
    // keepalive 重置帧空闲计时，内容空闲仍在 300 秒后取消请求。
    for (let i = 0; i < 14; i++) await vi.advanceTimersByTimeAsync(100_000);
    const caught = await promise;
    expect(caught).toBeInstanceOf(GenerationError);
    expect(String(caught.message)).toContain('content idle');
    expect(fetches).toBe(4);
  });
});
