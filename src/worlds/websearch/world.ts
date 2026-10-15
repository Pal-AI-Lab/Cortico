/**
 * WebSearch 是仅提供请求/响应工具的 World。
 * 它不提供环境提示词或事件;搜索结果不落事件库且不参与异步投递。
 */
import { fileURLToPath } from 'node:url';
import type { World, WorldHost, WorldWebUiDecl, ToolDef } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import {
  BraveClient,
  type BraveClientConfig,
  type Freshness,
  type SearchMode,
} from './brave-client.ts';
import { webSearchConfigGroup } from './config.ts';
import { text } from './strings.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));




interface WebSearchWorldConfig {
  /** Brave Search API key(装配层按 WEBSEARCH_SECRET 取给它);空串=工具存在但每次调用都提示未配置 */
  apiKey: string;
  country?: string;
  searchLang?: string;
  uiLang?: string;
  safesearch?: BraveClientConfig['safesearch'];
  timeoutMs?: number;
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

export class WebSearchWorld implements World {
  readonly id = 'websearch';

  private readonly client: BraveClient | null;

  constructor(cfg: WebSearchWorldConfig) {
    this.client = cfg.apiKey
      ? new BraveClient({
          apiKey: cfg.apiKey,
          country: cfg.country ?? 'CN',
          searchLang: cfg.searchLang ?? 'zh-hans',
          uiLang: cfg.uiLang ?? 'zh-CN',
          safesearch: cfg.safesearch ?? 'moderate',
          timeoutMs: cfg.timeoutMs ?? 20000,
        })
      : null;
  }

  /** 变量表为空；模板留空时，该 World 不进入前缀。 */
  envPromptVars(): Record<string, string> {
    return {};
  }

  /** WebUI 里露出什么:密钥有没有配好 + 自己的检索偏好旋钮 */
  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = text(language);
    return {
      label: t.moduleLabel,
      // 一条链路:密钥。没配 = 灰(部署没填,不是运行出错);工具照旧在,调用会自己说明。
      lamps: [this.client
        ? { label: t.key, state: 'online' as const, hint: t.keySet }
        : { label: t.key, state: 'offline' as const, hint: t.keyUnset }],
      badges: [
        this.client
          ? { label: t.key, value: t.keySet, tone: 'on' as const }
          : { label: t.key, value: t.keyUnsetBadge, tone: 'off' as const },
      ],
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
      handler: async (args) => {
        const client = this.client;
        if (!client) return '[tool failed] web search is not configured (missing BRAVE_API_KEY)';

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
