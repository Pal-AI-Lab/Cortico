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
