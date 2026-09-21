/** Native Responses over any OpenAI-compatible endpoint: bearer key, stateless replay, no vendor branching. */
import type { Logger } from '../../core/types.ts';
import { nullLogger } from '../../core/util.ts';
import { OpenAIHttpClient } from '../transport/chat.ts';
import { ResponseProtocolError } from '../../protocol/open-responses/stream.ts';
import { createResponse, type Request } from '../../protocol/open-responses/index.ts';
import { standardUsage, type GenerateOptions } from '../../core/generation.ts';
import { NativeResponseAssembly, type ResponseAssembly, type parseChatResponse } from '../transport/response-assembly.ts';
import { responseMeters } from '../transport/response-meters.ts';
import { responsesInput, type ReasoningReplay, type ResponsesInputOptions } from '../transport/responses-input.ts';

type Item = Record<string, unknown>;

export interface ResponsesProviderOptions {
  baseUrl: string;
  apiKey?: string;
  /** Path appended to `baseUrl`; default `/responses`. */
  endpointPath?: string;
  extraHeaders?: Record<string, string>;
  /** Merged into every request body last, so vendor-specific fields (`service_tier`, ...) win. */
  extraBody?: Record<string, unknown>;
  media?: ResponsesInputOptions['media'];
  keepThinking?: () => boolean;
  reasoningReplay?: ReasoningReplay;
  syntheticReasoningText?: string;
  log?: Logger;
}

/**
 * Send reasoning only when an effort is supplied; otherwise leave it to the endpoint.
 * Requests set store=false, so replay is local and follows `reasoningReplay`; encrypted replay asks
 * for the signed blocks back through `include`. Endpoint extraBody fields are merged last.
 */
export function buildResponsesBody(
  request: Request,
  options: GenerateOptions,
  input: ResponsesInputOptions,
  extraBody: Record<string, unknown> = {},
): Record<string, unknown> {
  const replay = responsesInput(request, options, input);
  const body: Item = {
    ...request,
    input: replay.input,
    store: false,
    stream: Boolean(options.onEvent),
  };
  // 加密形态靠 include 把签名推理块取回来,明文形态用不上它;端点不支持 include 时整条请求被拒,
  // 所以只在用得上的形态带。
  const include = new Set<string>(request.include ?? []);
  if (input.reasoningReplay !== 'plaintext') include.add('reasoning.encrypted_content');
  if (include.size) body.include = [...include];
  else delete body.include;
  delete body.previous_response_id;
  if (replay.instructions !== undefined) body.instructions = replay.instructions;
  else delete body.instructions;
  if (!request.reasoning?.effort) delete body.reasoning;
  if (options.sessionId) body.prompt_cache_key = options.sessionId;
  return { ...body, ...extraBody };
}

export class ResponsesProvider extends OpenAIHttpClient {
  private readonly opts: ResponsesProviderOptions;

  constructor(opts: ResponsesProviderOptions) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.opts = opts;
    this.chatPath = opts.endpointPath ?? '/responses';
  }

  protected override buildResponseBody(request: Request, options: GenerateOptions): Record<string, unknown> {
    return buildResponsesBody(request, options, {
      media: this.opts.media, keepThinking: this.opts.keepThinking, reasoningReplay: this.opts.reasoningReplay,
      syntheticReasoningText: this.opts.syntheticReasoningText,
    }, this.opts.extraBody);
  }

  /** The Chat body builder is unreachable here: `buildResponseBody` is overridden whole. */
  protected buildBody(): never {
    throw new Error('ResponsesProvider does not build Chat Completions bodies');
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.opts.extraHeaders };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    return headers;
  }

  protected override responseAssembly(): ResponseAssembly {
    return new NativeResponseAssembly();
  }

  protected override parseResponse(raw: unknown, request: Request): ReturnType<typeof parseChatResponse> {
    const data = raw as Item;
    if (typeof data.id !== 'string' || typeof data.model !== 'string' || !Array.isArray(data.output)
      || !['completed', 'incomplete', 'failed'].includes(String(data.status))) throw new ResponseProtocolError('Invalid native Responses resource');
    const meters = responseMeters(data.usage as Record<string, unknown> | null);
    return {
      response: { ...createResponse(data.id, request), ...data, usage: standardUsage(meters) },
      meters,
      serviceTier: typeof data.service_tier === 'string' ? data.service_tier : null,
    };
  }
}

export interface CatalogModel {
  id: string;
  contextWindow?: number;
}

/** `GET /models`: ids always; OpenRouter also states `context_length` per model. */
export class ModelCatalog {
  private known = new Map<string, number | undefined>();
  constructor(
    private readonly endpoint: () => { baseUrl: string; headers: Record<string, string> },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async list(): Promise<CatalogModel[]> {
    const { baseUrl, headers } = this.endpoint();
    const res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GET /models ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { data?: Array<{ id?: unknown; context_length?: unknown }> };
    if (!Array.isArray(json.data)) throw new Error('GET /models returned no data array');
    const models: CatalogModel[] = [];
    for (const row of json.data) {
      if (typeof row.id !== 'string') continue;
      const window = typeof row.context_length === 'number' && Number.isInteger(row.context_length) && row.context_length > 0 ? row.context_length : undefined;
      this.known.set(row.id, window);
      models.push(window ? { id: row.id, contextWindow: window } : { id: row.id });
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  contextWindow(model: string): number | undefined {
    return this.known.get(model);
  }
}
