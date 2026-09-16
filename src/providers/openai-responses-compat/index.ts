import type { ProviderModule } from '../base.ts';
import type { LLMProviderEntry } from '../../core/types.ts';
import { isContextOverflow } from '../transport/errors.ts';
import { ModelCatalog, ResponsesProvider } from './native.ts';
import { text } from './strings.ts';

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
}
export function compatOptions(entry: LLMProviderEntry): CompatOptions {
  return (entry.options ?? {}) as CompatOptions;
}

/** Empty strings and empty objects are the console's "unset"; they do not reach the wire. */
function normalizeCompat(entry: LLMProviderEntry): LLMProviderEntry {
  const options: Record<string, unknown> = { ...entry.options };
  if (options.endpointPath === '') delete options.endpointPath;
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
    return {
      listModels: () => catalog.list(),
      contextWindow: (model) => catalog.contextWindow(model),
      compatibilityKey: () => [options.endpointPath ?? '/responses', name],
      client: new ResponsesProvider({
        baseUrl: entry.baseUrl,
        apiKey,
        endpointPath: options.endpointPath,
        extraHeaders: options.extraHeaders,
        extraBody: options.extraBody,
        log: host.log,
        media: { enabled: () => entry.multimodal === true, read: host.readBlob },
        keepThinking: host.keepThinking,
      }),
    };
  },
} satisfies ProviderModule;
