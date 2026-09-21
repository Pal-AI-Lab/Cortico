import type { Logger } from '../../core/types.ts';
import type { Request, Response, StreamEvent } from '../../protocol/open-responses/index.ts';
import type { ItemOrigin } from '../../protocol/open-responses/context.ts';
import { GenerationError, priceUsage, unknownMeters, type GenerateOptions, type Generation, type ProviderAttempt, type PriceSnapshot, type TokenMeters } from '../../core/generation.ts';
import { ResponseProtocolError } from '../../protocol/open-responses/stream.ts';
import { LLMError, abortError, parseRetryAfter, retryDelay, reqIdSuffix } from './errors.ts';
import type { ResponseAssembly } from './response-assembly.ts';

export interface ResponseTransport {
  url: string;
  body: Record<string, unknown>;
  headers(): Record<string, string> | Promise<Record<string, string>>;
  refresh(): Promise<boolean>;
  assembly(): ResponseAssembly;
  parse(raw: unknown): { response: Response; meters: TokenMeters; serviceTier: string | null };
  failure(info: { model: string; role?: string; elapsedMs: number; status: number; requestId: string | null; body: string; message: string }, record: (attempts: ProviderAttempt[]) => void): Promise<boolean>;
  succeeded(): void;
  log: Logger;
}

/** SSE framing is independent of packet and line boundaries. */
export class EventDecoder {
  private buffer = '';
  private data: string[] = [];
  feed(text: string): string[] {
    this.buffer += text;
    const events: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line === '') {
        if (this.data.length) events.push(this.data.join('\n'));
        this.data = [];
      } else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
    }
    return events;
  }
}

function irreversible(event: StreamEvent): boolean {
  return event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta'
    || event.type === 'response.function_call_arguments.delta'
    || (event.type === 'response.output_item.added' && event.item?.type === 'function_call');
}

/** 带内容的事件:增量,或输出项的开合。keepalive 帧与空事件不算。 */
function carriesContent(event: StreamEvent): boolean {
  return 'delta' in event || event.type === 'response.output_item.added' || event.type === 'response.output_item.done';
}

/** 首包等待上限：流式 300 秒，非流式 120 秒。 */
const FIRST_RESPONSE_MS = { streaming: 300_000, unary: 120_000 } as const;
/** 帧空闲:连续这么久一个字节都没来。 */
const FRAME_IDLE_MS = 120_000;
/**
 * 内容事件的空闲期限；keepalive 和空 delta 不重置它。
 * 该计时器独立于字节接收计时，以覆盖持续收到空帧的响应。
 */
const CONTENT_IDLE_MS = 300_000;
/**
 * 按 `Retry-After` 退避的上限。更长的要求意味着配额按分钟级恢复,把本轮
 * 挂在等待上不如立刻把失败交给调用方;六倍于固定间隔里最长的一档。
 */
const RETRY_AFTER_CAP_MS = 60_000;

/** Every fetch attempt produces its own immutable metering and price snapshot. */
export async function generate(request: Request, options: GenerateOptions, origin: ItemOrigin, transport: ResponseTransport): Promise<Generation> {
  const generationId = crypto.randomUUID();
  const attempts: ProviderAttempt[] = [];
  let lastError: unknown;
  let partial: Response | null = null;
  let authRetried = false;
  // 上一次尝试的 `Retry-After`;没有头或解析不成形时按固定间隔退避。
  let retryAfterMs: number | null = null;
  const delays = options.diagnostic ? [] : [1000, 4000, 10000];
  const fail = (error: unknown): GenerationError => new GenerationError((error instanceof Error ? error.message : String(error)) + reqIdSuffix(attempts.filter(attempt => attempt.purpose !== 'diagnostic').at(-1)?.requestId), attempts,
    partial, origin, error instanceof LLMError ? error.status : 0, error instanceof LLMError ? error.body : '', { cause: error });
  for (let ordinal = 0; ordinal <= delays.length; ordinal++) {
    try {
      if (options.signal?.aborted) throw abortError(options.signal);
      if (ordinal) await retryDelay(retryAfterMs ?? delays[ordinal - 1], options.signal);
    } catch (error) { throw fail(error); }
    retryAfterMs = null;
    const attempt: ProviderAttempt = {
      id: crypto.randomUUID(), generationId, ordinal, origin: structuredClone(origin), startedAt: new Date().toISOString(), elapsedMs: 0,
      requestId: null, responseId: null, outcome: 'failed', status: null, serviceTier: null, requestedServiceTier: typeof transport.body.service_tier === 'string' ? transport.body.service_tier : request.service_tier ?? null, purpose: options.diagnostic ? 'diagnostic' : 'generation', meters: unknownMeters(), charges: [],
    };
    let quotes: readonly PriceSnapshot[] = [];
    const started = Date.now();
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const streaming = Boolean(options.onEvent);
    let timer = setTimeout(() => controller.abort(new Error('Provider first response timeout')), streaming ? FIRST_RESPONSE_MS.streaming : FIRST_RESPONSE_MS.unary);
    let contentTimer: ReturnType<typeof setTimeout> | null = null;
    const touchContent = (): void => {
      if (contentTimer) clearTimeout(contentTimer);
      contentTimer = setTimeout(() => controller.abort(new Error('Provider stream content idle timeout')), CONTENT_IDLE_MS);
    };
    let committed = false;
    let characters = 0;
    let runaway = false;
    let observed = false;
    const assembly = transport.assembly();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let sent = false;
    let finishedAt: number | null = null;
    const diagnostics: ProviderAttempt[] = [];
    partial = null;
    const forward = (event: StreamEvent): void => {
      observed = true;
      if (carriesContent(event)) touchContent();
      if ('delta' in event && typeof event.delta === 'string') characters += event.delta.length;
      if (irreversible(event)) committed = true;
      if (!options.signal?.aborted) options.onEvent?.(event);
      if (characters > (request.max_output_tokens ?? 32768) * 12) {
        runaway = true;
        controller.abort();
        throw new LLMError('Provider exceeded the output character limit', 0, '');
      }
    };
    try {
      const headers = await transport.headers();
      if (options.signal?.aborted) throw abortError(options.signal);
      attempt.startedAt = new Date().toISOString();
      quotes = structuredClone(options.quote?.({ startedAt: attempt.startedAt, requestedServiceTier: attempt.requestedServiceTier ?? null }) ?? []);
      sent = true;
      const response = await fetch(transport.url, { method: 'POST', body: JSON.stringify(transport.body), headers, signal });
      attempt.status = response.status;
      attempt.requestId = response.headers.get('x-request-id');
      if (!response.ok) {
        const error = new LLMError(`LLM API ${response.status}`, response.status, await response.text());
        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        if (!options.diagnostic && (response.status === 401 || response.status === 403) && !authRetried && await transport.refresh()) {
          authRetried = true;
          lastError = error;
          continue;
        }
        throw error;
      }
      if (streaming) {
        if (!response.body) throw new LLMError('Streaming response has no body', response.status, '');
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        const frames = new EventDecoder();
        touchContent();
        stream: for (;;) {
          const chunk = await reader.read();
          clearTimeout(timer);
          timer = setTimeout(() => controller.abort(new Error('Provider stream idle timeout')), FRAME_IDLE_MS);
          if (chunk.done) break;
          for (const payload of frames.feed(decoder.decode(chunk.value, { stream: true }))) {
            if (payload === '[DONE]') break stream;
            assembly.feed(JSON.parse(payload), forward);
          }
        }
        partial = assembly.finish(forward);
        attempt.meters = assembly.meters();
        attempt.serviceTier = assembly.serviceTier();
      } else {
        const parsed = transport.parse(JSON.parse(await response.text()));
        partial = parsed.response;
        attempt.meters = parsed.meters;
        attempt.serviceTier = parsed.serviceTier;
      }
      attempt.responseId = partial.id;
      if (partial.status === 'failed') throw new LLMError(partial.error?.message ?? partial.error?.code ?? 'Response failed', 0, JSON.stringify(partial.error));
      if (partial.status !== 'completed' && partial.status !== 'incomplete') throw new LLMError(`Response has no terminal status: ${partial.status}`, 0, '');
      attempt.outcome = options.signal?.aborted ? 'discarded' : partial.status;
      transport.succeeded();
      return { response: partial, origin, attempts };
    } catch (error) {
      finishedAt = Date.now();
      if (streaming) {
        partial = assembly.snapshot();
        attempt.meters = assembly.meters();
      }
      attempt.responseId = partial?.id ?? null;
      if (options.signal?.aborted) {
        attempt.outcome = 'aborted';
        lastError = abortError(options.signal);
        break;
      }
      lastError = error;
      if (!sent || committed || runaway || (!streaming && error instanceof ResponseProtocolError)) break;
      const status = error instanceof LLMError ? error.status : 0;
      if (status !== 0 && status !== 408 && status !== 429 && status < 500) break;
      if (retryAfterMs !== null && retryAfterMs > RETRY_AFTER_CAP_MS) break;
      if (!options.diagnostic && observed && Date.now() - started >= 20000 && !await transport.failure({
        model: request.model ?? '', role: options.role, elapsedMs: Date.now() - started, status,
        requestId: attempt.requestId, body: error instanceof LLMError ? error.body : '', message: String(error),
      }, values => diagnostics.push(...values))) break;
      transport.log.warn('Provider attempt failed; retrying', { ordinal, err: String(error) });
    } finally {
      clearTimeout(timer);
      if (contentTimer) clearTimeout(contentTimer);
      if (reader) { try { await reader.cancel(); } catch { /* The failed transport may already be closed. */ } reader.releaseLock(); }
      attempt.elapsedMs = (finishedAt ?? Date.now()) - started;
      attempt.charges = priceUsage(attempt.meters, quotes, attempt.serviceTier);
      if (sent) attempts.push(attempt);
      attempts.push(...diagnostics);
    }
  }
  throw fail(lastError);
}
