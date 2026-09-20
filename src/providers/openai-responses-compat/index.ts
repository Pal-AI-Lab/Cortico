import type { ProviderModule } from '../base.ts';
import type { LLMProviderEntry } from '../../core/types.ts';
import type { ResponseClient } from '../../core/generation.ts';
import { isContextOverflow } from '../transport/errors.ts';
import { REASONING_REPLAYS, type ReasoningReplay } from '../transport/responses-input.ts';
import { ModelCatalog, ResponsesProvider, type ResponsesProviderOptions } from './native.ts';
import { text } from './strings.ts';
import { protocolConfig } from './config.ts';
import { compatConsole } from './console/server.ts';

/** Suggested base URLs for the console field; operators may enter other URLs. */
const BASE_URLS: readonly string[] = [
  'https://api.openai.com/v1',
  'https://api.deepseek.com',
  'https://openrouter.ai/api/v1',
  'https://api.x.ai/v1',
];

/** Reasoning-effort choices used by the console. */
const EFFORTS: readonly string[] = ['none', 'low', 'medium', 'high', 'xhigh'];

export interface CompatOptions {
  endpointPath?: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Default `encrypted`. */
  reasoningReplay?: ReasoningReplay;
  /** Plaintext replay only; defaults to `SYNTHETIC_REASONING_TEXT`. */
  syntheticReasoningText?: string;
}
export function compatOptions(entry: LLMProviderEntry): CompatOptions {
  return (entry.options ?? {}) as CompatOptions;
}

/** Module-owned control object, used by the endpoint page's reasoning section. */
export interface CompatControl {
  /** A client for this endpoint with the given replay form; the stored entry is unchanged. */
  probeClient(replay: ReasoningReplay): ResponseClient;
}

/** Empty strings and empty objects are the console's "unset"; they do not reach the wire. */
function normalizeCompat(entry: LLMProviderEntry): LLMProviderEntry {
  const options: Record<string, unknown> = { ...entry.options };
  for (const key of ['endpointPath', 'reasoningReplay', 'syntheticReasoningText'] as const) if (options[key] === '') delete options[key];
  for (const key of ['extraHeaders', 'extraBody'] as const) {
    const value = options[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) delete options[key];
  }
  return { ...entry, options };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export default {
  id: 'openai-responses-compat',
  title: 'OpenAI Responses Compatible',
  defaultBaseUrl: BASE_URLS[0],
  baseUrlSuggestions: BASE_URLS,
  normalize: normalizeCompat,
  config: protocolConfig,
  console: compatConsole,
  reasoningTiers: [],
  effortSuggestions: EFFORTS,
  serviceTiers: [],
  validateEntry: (entry, language) => {
    const S = text(language);
    const options = compatOptions(entry);
    if (options.endpointPath !== undefined && (typeof options.endpointPath !== 'string' || !options.endpointPath.startsWith('/')))
      throw new Error(S.endpointPathSlash);
    if (options.extraHeaders !== undefined && (!isPlainObject(options.extraHeaders)
      || Object.values(options.extraHeaders).some((value) => typeof value !== 'string')))
      throw new Error(S.extraHeadersObject);
    if (options.extraBody !== undefined && !isPlainObject(options.extraBody)) throw new Error(S.extraBodyObject);
    if (options.reasoningReplay !== undefined && !REASONING_REPLAYS.includes(options.reasoningReplay))
      throw new Error(S.reasoningReplayValue);
    // 端点拒收空的 reasoning_text:全空白与空串一样会让明文形态整条请求 400。
    if (options.syntheticReasoningText !== undefined
      && (typeof options.syntheticReasoningText !== 'string' || !options.syntheticReasoningText.trim()))
      throw new Error(S.syntheticReasoningTextValue);
  },
  contextOverflow: isContextOverflow,
  create(name, entry, host) {
    const options = compatOptions(entry);
    const apiKey = entry.secret ? host.secret(entry.secret) : undefined;
    const headers = (): Record<string, string> => ({
      ...options.extraHeaders,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    });
    const catalog = new ModelCatalog(() => ({ baseUrl: entry.baseUrl, headers: headers() }));
    const clientOptions = (reasoningReplay: ReasoningReplay | undefined): ResponsesProviderOptions => ({
      baseUrl: entry.baseUrl,
      apiKey,
      endpointPath: options.endpointPath,
      extraHeaders: options.extraHeaders,
      extraBody: options.extraBody,
      log: host.log,
      media: { enabled: () => entry.multimodal === true, read: host.readBlob },
      keepThinking: host.keepThinking,
      reasoningReplay,
      syntheticReasoningText: options.syntheticReasoningText,
    });
    return {
      listModels: () => catalog.list(),
      contextWindow: (model) => catalog.contextWindow(model),
      compatibilityKey: () => [options.endpointPath ?? '/responses', name],
      control: { probeClient: (replay) => new ResponsesProvider(clientOptions(replay)) } satisfies CompatControl,
      client: new ResponsesProvider(clientOptions(options.reasoningReplay)),
    };
  },
} satisfies ProviderModule;
