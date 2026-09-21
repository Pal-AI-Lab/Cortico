/**
 * generate 的重试策略:429 按 Retry-After 决定下一次等待,408 与网络错误同入重试集,
 * 上游要求的退避超过上限时不再等待。Fixture 只借道共享传输,不测 Chat 方言本身。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIHttpClient } from '../../../src/providers/transport/chat.ts';
import type { NativeChatMessage } from '../../../src/providers/transport/native-types.ts';
import type { ModelSpec, ToolSchema } from '../../../src/core/types.ts';
import { nullLogger } from '../../../src/core/util.ts';
import { GenerationError } from '../../../src/core/generation.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

class Fixture extends OpenAIHttpClient {
  constructor() { super('https://fixture.test', nullLogger()); }
  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[], tools?: ToolSchema[]): Record<string, unknown> {
    return { model: spec.model, messages };
  }
  protected headers(): Record<string, string> { return { 'Content-Type': 'application/json' }; }
}
const ok = () => new Response(JSON.stringify({ id: 'r1', model: 'test', choices: [{ index: 0, message: { content: 'ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));

describe('retry policy', () => {
  it('waits out the Retry-After interval before retrying a 429', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetcher);
    const promise = new Fixture().respond({ model: 'test', input: 'hi' });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toMatchObject({ response: { status: 'completed' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries a 408 request timeout', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('timeout', { status: 408 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetcher);
    const promise = new Fixture().respond({ model: 'test', input: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toMatchObject({ response: { status: 'completed' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops instead of waiting out a Retry-After beyond the cap', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429, headers: { 'retry-after': '3600' } }));
    vi.stubGlobal('fetch', fetcher);
    const caught = await new Fixture().respond({ model: 'test', input: 'hi' }).catch(error => error);
    expect(caught).toBeInstanceOf(GenerationError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
