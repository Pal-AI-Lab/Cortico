/**
 * WebSearch 是仅提供请求/响应工具的 World。
 * 它不提供环境提示词或事件;搜索结果不落事件库且不参与异步投递。
 */
import { fileURLToPath } from 'node:url';
import type { World, WorldHost, WorldWebUiDecl, ToolDef } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import { BraveClient } from './brave-client.ts';
import { DeepSeekClient } from './deepseek-client.ts';
import type { Freshness, SearchClient, SearchMode } from './search.ts';
import {
  SEARCH_PROVIDERS,
  type SearchProvider,
  type WebSearchConfigSection,
  type WebSearchPanelState,
  webSearchConfigGroup,
  WEBSEARCH_BASE_URL_KEYS,
  WEBSEARCH_DEFAULTS,
  WEBSEARCH_SECRETS,
} from './config.ts';
import { text } from './strings.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const SETUP_PANEL = 'setup';

export interface WebSearchWorldOptions {
  /** `worlds.websearch` 活引用;每次搜索时读，改服务、改偏好立即生效。 */
  cfg: WebSearchConfigSection;
  /** 按变量名取密钥;空串=未配置，工具仍在，调用时提示。 */
  secret(name: string): string;
  storeSecret(name: string, value: string): void;
}

/** 打码后的密钥:前 6 位与后 4 位;短 key 只露前 2 位。 */
function maskKey(key: string): string {
  return key.length <= 12 ? `${key.slice(0, 2)}…` : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

const MODES: SearchMode[] = ['auto', 'answer', 'links', 'news', 'images', 'videos'];
const FRESHNESS: Freshness[] = ['any', 'day', 'week', 'month', 'year'];
const N_MIN = 1;
const N_MAX = 6;
const N_DEFAULT = 4;
const Q_MIN = 1;
const Q_MAX = 240;

/** 每次有结果都附上：外部平台有自己的内容规则，照搬检索结果可能导致账号被封 */
const PLATFORM_RISK_WARNING =
  '⚠ Before posting any of this into QQ or other external platforms: make sure it doesn\'t violate that platform\'s rules (illegal, explicit, violent, infringing, etc.) — sharing content that does can get the account banned. Paraphrase and use judgment.';

export const WEBSEARCH_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'web_search',
    description:
      'Search the public internet for recent or uncertain information. Returns concise, numbered evidence with sources. Default to calling it once.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: {
          type: 'string',
          minLength: Q_MIN,
          maxLength: Q_MAX,
          description:
            'Focused search query. Keep key names, dates and platforms; do not paste whole chat logs or private info.',
        },
        mode: {
          type: 'string',
          enum: MODES,
          default: 'auto',
          description:
            '"answer" for evidence to answer a question; "links" for web pages; others search that content type.',
        },
        fresh: {
          type: 'string',
          enum: FRESHNESS,
          default: 'any',
        },
        n: {
          type: 'integer',
          minimum: N_MIN,
          maximum: N_MAX,
          default: N_DEFAULT,
        },
      },
      required: ['q'],
    },
  },
];

export class WebSearchWorld implements World {
  readonly id = 'websearch';

  private readonly opts: WebSearchWorldOptions;

  constructor(opts: WebSearchWorldOptions) {
    this.opts = opts;
  }

  private get provider(): SearchProvider {
    return SEARCH_PROVIDERS.includes(this.opts.cfg.provider) ? this.opts.cfg.provider : WEBSEARCH_DEFAULTS.provider;
  }

  private key(provider: SearchProvider): string {
    return this.opts.secret(WEBSEARCH_SECRETS[provider]).trim();
  }

  /** 配置里的地址,去掉末尾斜杠;空串或未写时为默认地址。 */
  private baseUrl(provider: SearchProvider): string {
    const key = WEBSEARCH_BASE_URL_KEYS[provider];
    return (this.opts.cfg[key]?.trim() || WEBSEARCH_DEFAULTS[key]).replace(/\/+$/, '');
  }

  /** 按当前服务和密钥现建客户端;没密钥时为 null。 */
  private client(): SearchClient | null {
    const provider = this.provider;
    const apiKey = this.key(provider);
    if (!apiKey) return null;
    const cfg = { ...WEBSEARCH_DEFAULTS, ...this.opts.cfg };
    const baseUrl = this.baseUrl(provider);
    return provider === 'deepseek'
      ? new DeepSeekClient({ apiKey, baseUrl, timeoutMs: cfg.timeoutMs })
      : new BraveClient({
          apiKey,
          baseUrl,
          country: cfg.country,
          searchLang: cfg.searchLang,
          uiLang: cfg.uiLang,
          safesearch: cfg.safesearch,
          timeoutMs: cfg.timeoutMs,
        });
  }

  panelState(): WebSearchPanelState {
    const keys = Object.fromEntries(SEARCH_PROVIDERS.map((p) => {
      const k = this.key(p);
      return [p, k ? maskKey(k) : null];
    })) as WebSearchPanelState['keys'];
    const baseUrls = Object.fromEntries(SEARCH_PROVIDERS.map((p) => [p, this.baseUrl(p)])) as WebSearchPanelState['baseUrls'];
    return { provider: this.provider, keys, baseUrls };
  }

  private async invoke(panel: string, method: string, args: unknown[], language: Language): Promise<unknown> {
    const t = text(language);
    if (panel !== SETUP_PANEL) throw new Error(t.unknownPanel(panel));
    const provider = SEARCH_PROVIDERS.includes(args[0] as SearchProvider) ? (args[0] as SearchProvider) : this.provider;
    switch (method) {
      case 'state':
        return this.panelState();
      case 'setKey': {
        const key = String(args[1] ?? '').trim();
        if (!key || /\s/.test(key)) throw new Error(t.keyEmpty);
        this.opts.storeSecret(WEBSEARCH_SECRETS[provider], key);
        return this.panelState();
      }
      case 'clearKey':
        this.opts.storeSecret(WEBSEARCH_SECRETS[provider], '');
        return this.panelState();
      case 'test': {
        const client = this.client();
        if (!client) throw new Error(this.unconfigured());
        const { endpoint, results } = await client.search(t.testQuery, { mode: 'links', fresh: 'any', n: 3 });
        return { endpoint, results };
      }
      default:
        throw new Error(t.unknownMethod(method));
    }
  }

  private unconfigured(): string {
    return `web search is not configured (missing ${WEBSEARCH_SECRETS[this.provider]})`;
  }

  /** 变量表为空；模板留空时，该 World 不进入前缀。 */
  envPromptVars(): Record<string, string> {
    return {};
  }

  /** WebUI 里露出什么:当前服务的密钥有没有配好、快速配置页签、检索偏好旋钮 */
  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = text(language);
    const hasKey = !!this.key(this.provider);
    return {
      label: t.moduleLabel,
      // 一条链路:当前服务的密钥。没配 = 灰(部署没填,不是运行出错);工具照旧在,调用会自己说明。
      lamps: [hasKey
        ? { label: t.key, state: 'online' as const, hint: t.keySet }
        : { label: t.key, state: 'offline' as const, hint: t.keyUnset }],
      badges: [
        { label: t.service, value: t.providerName[this.provider], tone: 'plain' as const },
        hasKey
          ? { label: t.key, value: t.keySet, tone: 'on' as const }
          : { label: t.key, value: t.keyUnsetBadge, tone: 'off' as const },
      ],
      panels: [{ id: SETUP_PANEL, title: t.panelTitle, description: t.panelDescription, getMethods: ['state'] }],
      invoke: (panel, method, args) => this.invoke(panel, method, args, language),
      config: [webSearchConfigGroup(language)],
      promptDocs: [
        {
          key: 'worlds.websearch.envPrompt',
          title: t.promptDocTitle,
          description: t.promptDocDescription,
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
    };
  }

  async start(_host: WorldHost): Promise<void> {
  }

  async stop(): Promise<void> {
  }

  tools(): ToolDef[] {
    return [this.webSearchTool()];
  }

  private webSearchTool(): ToolDef {
    return {
      ...WEBSEARCH_TOOL_DECLS[0],
      handler: async (args) => {
        const client = this.client();
        if (!client) return `[tool failed] ${this.unconfigured()}`;

        const q = typeof args.q === 'string' ? args.q.trim() : '';
        if (q.length < Q_MIN) return '[bad input] q must not be empty';

        const mode: SearchMode = MODES.includes(args.mode as SearchMode) ? (args.mode as SearchMode) : 'auto';
        const fresh: Freshness = FRESHNESS.includes(args.fresh as Freshness) ? (args.fresh as Freshness) : 'any';
        const n =
          args.n !== undefined && args.n !== null
            ? Math.min(N_MAX, Math.max(N_MIN, Math.trunc(Number(args.n)) || N_DEFAULT))
            : N_DEFAULT;

        try {
          const { endpoint, results } = await client.search(q.slice(0, Q_MAX), { mode, fresh, n });
          if (results.length === 0) return `(no results for "${q}")`;

          const lines = [`web_search: "${q}" · ${endpoint} · ${results.length} result(s)`, ''];
          results.forEach((r, i) => {
            lines.push(`${i + 1}. ${r.title || '(untitled)'}`, `   ${r.url}`);
            if (r.snippet) lines.push(`   ${r.snippet}`);
            lines.push('');
          });
          lines.push(PLATFORM_RISK_WARNING);
          return lines.join('\n').trimEnd();
        } catch (e) {
          return `[search failed] ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    };
  }
}
