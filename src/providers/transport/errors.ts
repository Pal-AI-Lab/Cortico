export class LLMError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.body = body;
  }
}

/** An `error` event in a stream: the upstream's own failure report, which the transport does not retry. */
export class StreamErrorEvent extends LLMError {
  constructor(body: string) {
    super(`Stream error event: ${upstreamText(body)}`, upstreamStatus(body), body);
    this.name = 'StreamErrorEvent';
  }
}

/** A stream can carry a request rejection after its HTTP 200 headers were sent. */
export function upstreamStatus(body: string): number {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return 0;
    const error: unknown = 'error' in parsed ? parsed.error : parsed;
    if (!error || typeof error !== 'object') return 0;
    for (const key of ['status', 'status_code'] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) return value;
    }
    // Compatibility gateways sometimes wrap the upstream status in a message prefix.
    const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
    const status = /^<([45]\d{2})>\s/.exec(message);
    if (status) return Number(status[1]);
    const code = 'code' in error ? error.code : null;
    const type = 'type' in error ? error.type : null;
    if (['invalid_request_error', 'context_length_exceeded', 'content_filter', 'data_inspection_failed', 'DataInspectionFailed'].includes(String(code))
      || type === 'invalid_request_error') return 400;
    if (code === 'rate_limit_exceeded' || type === 'rate_limit_error') return 429;
  } catch { /* Unstructured failures keep the unknown status. */ }
  return 0;
}

/** The upstream's error text: `error.message` or `message` of a JSON body, else the body, on one line. */
export function upstreamText(body: string): string {
  let text = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === 'string') text = message;
  } catch { /* not JSON: the body as it came */ }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Whether an upstream rejection says the input exceeded the model's context. Status 0 is an
 * in-stream failure event; 400/413 are the request-rejection codes. The body patterns cover
 * the OpenAI `context_length_exceeded` code, DeepSeek's "maximum context length" message
 * and llama-server's "exceeds the available context size".
 */
export function isContextOverflow(error: { status: number; body: string }): boolean {
  if (error.status !== 0 && error.status !== 400 && error.status !== 413) return false;
  return /context_length_exceeded|context length|context size|context window|maximum context|prompt is too long|input is too long|too many tokens/i.test(error.body);
}

/** 上游请求 id 拼进错误消息的固定形状(没有就什么都不拼)。 */
export function reqIdSuffix(requestId: string | null | undefined): string {
  return requestId ? ` [req=${requestId}]` : '';
}

export function abortError(signal: AbortSignal): LLMError {
  const reason = signal.reason;
  const detail = reason instanceof Error ? reason.message : String(reason ?? '调用方取消');
  return new LLMError(`LLM请求已取消: ${detail}`, 0, '');
}

export function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `Retry-After` 头换算成毫秒:数字按秒,HTTP 日期按距今;缺失或不成形返回 null,过期为 0。 */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
