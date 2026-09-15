/** Legacy fixtures are translated only in tests; production sessions and clients use Items. */
import type { ChatMessage, LLMChatOptions, LLMDelta, LLMResult } from './fixture-types.ts';
import type { LLMUsage, ModelSpec, ToolSchema, OutputTap, ForkOptions, SessionInfo, CoreApi } from '../../src/core/types.ts';
import { fixtureRecords } from './fixture-messages.ts';
import { itemText, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { createResponse, type OutputItem, type Request, type StreamEvent } from '../../src/protocol/open-responses/index.ts';
import { ResponseAccumulator } from '../../src/protocol/open-responses/stream.ts';
import { GenerationError, type ProviderAttempt, type ResponseClient } from '../../src/core/generation.ts';
import { requestSpec, requestTools } from '../../src/providers/transport/native-input.ts';
import { LLMError, LLMStreamAborted } from './fixture-errors.ts';

export interface FixtureClient { chat(spec: ModelSpec, messages: ChatMessage[], tools?: ToolSchema[], options?: LLMChatOptions): Promise<LLMResult>; }
export interface FixtureTap { onDelta(delta: LLMDelta): void; externalizes?(delta: LLMDelta): boolean; onRoundEnd?(): void; onAbort?(reason: string): void; }
export interface FixtureHandoffResult { tail: ChatMessage[] | null; trim?: boolean; }
export interface FixtureForkOptions extends Omit<ForkOptions, 'messages'> { messages: ChatMessage[]; }
export interface FixtureSessionInfo extends Omit<SessionInfo, 'snapshot'> { snapshot: ChatMessage[] | null; }
export interface FixtureHarnessApi extends Omit<CoreApi, 'spawnFork' | 'sessionInfo' | 'llm'> {
  spawnFork(options: FixtureForkOptions): Promise<string>;
  sessionInfo(id: string): FixtureSessionInfo;
  llm: FixtureClient | ResponseClient;
}
let groupSeq = 0;
export function records(messages: readonly ChatMessage[] | readonly ContextRecord[]): ContextRecord[] {
  if (!messages.length) return [];
  if ('item' in messages[0]) return [...messages] as ContextRecord[];
  const namespace = `test_${++groupSeq}`;
  return fixtureRecords(messages as ChatMessage[], namespace);
}
export function messages(records: readonly ContextRecord[] | readonly ChatMessage[]): ChatMessage[] {
  if (!records.length) return [];
  if ('role' in records[0]) return [...records] as ChatMessage[];
  const result: ChatMessage[] = [];
  let assistant: ChatMessage | null = null;
  let group: string | number | undefined;
  for (const entry of records as readonly ContextRecord[]) {
    const { item, context } = entry;
    const key = context.responseId;
    const meta = { ...(context.ts ? { ts: context.ts } : {}), ...(context.blobs ? { blobs: context.blobs } : {}),
      ...(context.frame ? { frame: context.frame } : {}), ...(context.head ? { head: true as const } : {}), ...(context.ephemeral ? { ephemeral: true as const } : {}) };
    if (item.type === 'message' && item.role !== 'assistant') {
      assistant = null;
      result.push({ role: item.role === 'developer' ? 'system' : item.role, content: itemText(item), ...meta });
    } else if (item.type === 'function_call_output') {
      assistant = null;
      result.push({ role: 'tool', content: itemText(item), tool_call_id: item.call_id, ...meta });
    } else if (item.type === 'reasoning' || item.type === 'function_call' || item.type === 'message') {
      if (!assistant || (!(context.head && assistant.head) && (key === undefined || key !== group))) {
        assistant = { role: 'assistant', content: '', ...meta };
        if (context.origin?.module === 'fixture') assistant.reasoning_content = '';
        result.push(assistant);
      }
      group = key;
      if (item.type === 'message') assistant.content += itemText(item);
      if (item.type === 'reasoning') {
        assistant.reasoning_content = (assistant.reasoning_content ?? '') + itemText(item);
        if (item.encrypted_content) assistant.reasoningRef = { signature: item.encrypted_content, model: context.origin?.model ?? '' };
      }
      if (item.type === 'function_call') (assistant.tool_calls ??= []).push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    }
  }
  return result;
}

/** Scripted deltas exercise real standard Item lifecycles, including per-call early completion. */
export class FixtureStream {
  readonly response;
  private sequence = 0;
  private readonly output: any[] = [];
  private readonly calls = new Map<number, number>();
  private readonly texts = new Map<string, number>();
  constructor(request: Request, private readonly emit: (event: StreamEvent) => void) {
    this.response = createResponse(`resp_fixture_${++groupSeq}`, request);
    this.send({ type: 'response.created', response: this.response });
  }
  private send(event: Record<string, unknown>): void { this.emit(structuredClone({ ...event, sequence_number: this.sequence++ }) as StreamEvent); }
  feed(delta: LLMDelta): void {
    if (delta.type === 'reasoning' || delta.type === 'content') {
      let index = this.texts.get(delta.type);
      const reason = delta.type === 'reasoning';
      if (index === undefined) {
        index = this.output.length;
        const item = reason ? { type: 'reasoning', id: `rs_${index}`, summary: [], content: [] }
          : { type: 'message', id: `msg_${index}`, role: 'assistant', status: 'in_progress', content: [] };
        this.output.push(item); this.texts.set(delta.type, index);
        this.send({ type: 'response.output_item.added', output_index: index, item });
        const part = reason ? { type: 'reasoning_text', text: '' } : { type: 'output_text', text: '', annotations: [] };
        this.send({ type: 'response.content_part.added', output_index: index, item_id: item.id, content_index: 0, part });
        item.content.push(part as never);
      }
      const item = this.output[index];
      this.send({ type: reason ? 'response.reasoning.delta' : 'response.output_text.delta', output_index: index, item_id: item.id, content_index: 0, delta: delta.text, logprobs: [] });
      item.content[0].text += delta.text;
      return;
    }
    if (delta.type === 'tool_call.begin') {
      // The legacy fixtures place all reasoning/text before tool calls.
      this.closeTexts();
      const index = this.output.length;
      this.calls.set(delta.index, index);
      const item = { type: 'function_call', id: `fc_${index}`, call_id: delta.id, name: delta.name, arguments: '', status: 'in_progress' };
      this.output.push(item); this.send({ type: 'response.output_item.added', output_index: index, item });
      return;
    }
    const index = this.calls.get(delta.index);
    if (index === undefined) return;
    const item = this.output[index];
    if (delta.type === 'tool_call.delta') {
      this.send({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: delta.argsFragment });
      item.arguments += delta.argsFragment;
    } else {
      this.send({ type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: item.arguments });
      item.status = 'completed';
      this.send({ type: 'response.output_item.done', output_index: index, item });
    }
  }
  private closeTexts(): void {
    for (const index of this.texts.values()) {
      const item = this.output[index];
      this.send({ type: 'response.content_part.done', output_index: index, item_id: item.id, content_index: 0, part: item.content[0] });
      if (item.type === 'message') item.status = 'completed';
      this.send({ type: 'response.output_item.done', output_index: index, item });
    }
    this.texts.clear();
  }
  finish(usage: LLMUsage | undefined): void {
    this.closeTexts();
    this.response.output = this.output as OutputItem[];
    this.response.status = 'completed';
    if (usage) {
      this.response.usage = { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens, total_tokens: usage.promptTokens + usage.completionTokens,
        input_tokens_details: { cached_tokens: usage.cacheHitTokens }, output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 } };
    }
    this.send({ type: 'response.completed', response: this.response });
  }
}

function attempt(usage: LLMUsage | undefined, responseId: string, outcome: ProviderAttempt['outcome']): ProviderAttempt {
  return { id: crypto.randomUUID(), generationId: responseId, ordinal: 0, origin: { instance: 'fixture', module: 'fixture', model: 'fixture', compatibilityDomain: 'fixture' },
    startedAt: new Date().toISOString(), elapsedMs: 0, requestId: null, responseId, outcome, status: 200, serviceTier: 'default', charges: [],
    meters: { input: usage?.promptTokens ?? null, output: usage?.completionTokens ?? null, total: usage ? usage.promptTokens + usage.completionTokens : null,
      cachedInput: usage?.cacheHitTokens ?? null, uncachedInput: usage?.cacheMissTokens ?? null, reasoning: usage?.reasoningTokens ?? null, native: null } };
}
export function adaptClient(client: FixtureClient | ResponseClient): ResponseClient {
  if ('respond' in client) return client;
  return { respond: async (request, options = {}) => {
    const spec = requestSpec(request, options);
    const accumulator = new ResponseAccumulator();
    const stream = new FixtureStream(request, event => { accumulator.accept(event); options.onEvent?.(event); });
    let emitted = false;
    try {
      const result = await client.chat(spec, messages(options.context ?? (request.input as any[] ?? []).map(item => ({ version: 2, item, context: {} }))), requestTools(request),
        { ...options, onDelta: options.onEvent ? delta => { emitted = true; stream.feed(delta); } : undefined });
      if (!emitted) {
        if (result.message.reasoning_content) stream.feed({ type: 'reasoning', text: result.message.reasoning_content });
        if (result.message.content) stream.feed({ type: 'content', text: result.message.content });
        result.message.tool_calls?.forEach((call, index) => {
          stream.feed({ type: 'tool_call.begin', index, id: call.id, name: call.function.name });
          stream.feed({ type: 'tool_call.delta', index, argsFragment: call.function.arguments });
          stream.feed({ type: 'tool_call.end', index });
        });
      }
      if (!accumulator.snapshot()?.output.length) stream.feed({ type: 'content', text: '' });
      stream.finish(result.usage);
      const response = accumulator.finish();
      const ledger = attempt(result.usage, response.id, 'completed'); ledger.origin.model = spec.model;
      return { response, origin: ledger.origin, attempts: [ledger] };
    } catch (error) {
      const partial = accumulator.snapshot();
      const ledger = attempt(error instanceof LLMError ? error.usage : undefined, stream.response.id, options.signal?.aborted ? 'aborted' : 'failed');
      ledger.origin.model = spec.model;
      if (error instanceof LLMError) {
        ledger.elapsedMs = error.failedAfterMs ?? 0;
        ledger.requestId = error.requestId ?? null;
        ledger.status = error.status;
      }
      if (error instanceof LLMStreamAborted) {
        stream.response.output = records([error.partial]).map(entry => entry.item as OutputItem);
      }
      throw new GenerationError(String(error instanceof Error ? error.message : error), [ledger],
        error instanceof LLMStreamAborted ? stream.response : partial?.output.length ? partial : null,
        ledger.origin, error instanceof LLMError ? error.status : 0, error instanceof LLMError ? error.body : '', { cause: error });
    }
  } };
}

export function adaptTap(tap: FixtureTap | OutputTap | undefined): OutputTap | undefined {
  if (!tap || 'onEvent' in tap) return tap;
  const indices = new Map<number, number>();
  const delta = (event: StreamEvent): LLMDelta | null => {
    if (event.type === 'response.created') { indices.clear(); return null; }
    if (event.type === 'response.output_text.delta') return event.delta ? { type: 'content', text: event.delta } : null;
    if (event.type === 'response.reasoning.delta' || event.type === 'response.reasoning_summary_text.delta') return { type: 'reasoning', text: event.delta };
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      if (!indices.has(event.output_index)) indices.set(event.output_index, indices.size);
      return { type: 'tool_call.begin', index: indices.get(event.output_index)!, id: event.item.call_id, name: event.item.name };
    }
    if (event.type === 'response.function_call_arguments.delta') return { type: 'tool_call.delta', index: indices.get(event.output_index)!, argsFragment: event.delta };
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') return { type: 'tool_call.end', index: indices.get(event.output_index)! };
    return null;
  };
  return { onEvent: event => { const d = delta(event); if (d) tap.onDelta(d); },
    externalizes: event => { const d = delta(event); return d ? tap.externalizes?.(d) ?? d.type !== 'reasoning' : false; },
    onRoundEnd: tap.onRoundEnd?.bind(tap), onAbort: tap.onAbort?.bind(tap) };
}

export function legacyTap(tap: OutputTap): FixtureTap {
  let stream = new FixtureStream({}, event => tap.onEvent(event));
  return { onDelta: delta => stream.feed(delta), onRoundEnd: () => { tap.onRoundEnd?.(); stream = new FixtureStream({}, event => tap.onEvent(event)); },
    onAbort: reason => { tap.onAbort?.(reason); stream = new FixtureStream({}, event => tap.onEvent(event)); },
    externalizes: delta => delta.type === 'tool_call.begin' && delta.name === 'vtuber_act' };
}
