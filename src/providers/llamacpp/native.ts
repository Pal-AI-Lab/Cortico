/**
 * Chat Completions against llama-server. Thinking is the template's `enable_thinking` switch
 * sent per request through `chat_template_kwargs`; templates without that variable ignore it.
 * The server returns the chain of thought as `reasoning_content` (`--reasoning-format deepseek`),
 * which the shared Chat assembly already maps; past thinking is not replayed.
 *
 * The same dialect also has to survive OpenAI Chat Completions relays that are not
 * llama-server: they validate the body strictly and reject unknown fields wholesale
 * (`chat_template_kwargs` among them). `omitTemplateKwargs` drops the template switch,
 * and `extraBody` carries whatever thinking parameter the endpoint actually speaks —
 * both default to absent, which is byte-identical to the llama-server behaviour.
 */
import type { NativeChatMessage } from '../transport/native-types.ts';
import type { ModelSpec, ToolSchema, Logger } from '../../core/types.ts';
import { nullLogger } from '../../core/util.ts';
import { OpenAIHttpClient } from '../transport/chat.ts';
import { mapTools, renderMessagesWithMedia, type CompatMediaOptions } from '../transport/history.ts';
import type { LlamaCppOptions } from './options.ts';

type BodyOptions = Pick<LlamaCppOptions, 'extraBody' | 'omitTemplateKwargs'>;

export function buildLlamaCppRequestBody(
  spec: ModelSpec,
  messages: NativeChatMessage[],
  tools?: ToolSchema[],
  media?: CompatMediaOptions,
  bodyOptions?: BodyOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: spec.model,
    messages: renderMessagesWithMedia(messages, media),
  };
  if (!bodyOptions?.omitTemplateKwargs) body.chat_template_kwargs = { enable_thinking: spec.thinking };
  if (spec.thinking && spec.reasoningEffort) body.reasoning_effort = spec.reasoningEffort;
  if (spec.temperature !== undefined) body.temperature = spec.temperature;
  if (spec.maxTokens !== undefined) body.max_tokens = spec.maxTokens;
  const mapped = mapTools(tools);
  if (mapped) body.tools = mapped;
  return { ...body, ...bodyOptions?.extraBody };
}

export class LlamaCppProvider extends OpenAIHttpClient {
  private readonly apiKey?: string;
  private readonly media?: CompatMediaOptions;
  private readonly bodyOptions?: BodyOptions;

  constructor(opts: { baseUrl: string; apiKey?: string; options?: LlamaCppOptions; log?: Logger; media?: CompatMediaOptions }) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.apiKey = opts.apiKey;
    this.media = opts.media;
    this.bodyOptions = opts.options?.extraBody || opts.options?.omitTemplateKwargs !== undefined
      ? { extraBody: opts.options.extraBody, omitTemplateKwargs: opts.options.omitTemplateKwargs }
      : undefined;
  }

  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[], tools?: ToolSchema[]): Record<string, unknown> {
    return buildLlamaCppRequestBody(spec, messages, tools, this.media, this.bodyOptions);
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }
}
