import type {
  LLMProviderEntry,
  Logger,
  ReasoningTier,
  ServiceTier,
  ModelSpec,
  ConfigGroup,
} from '../core/types.ts';
import type { ConsolePageContribution } from '../web/shared/console-protocol.ts';
import type { Language } from '../core/language.ts';
import type { ProviderConsoleHost } from './console/types.ts';
import type { PriceDefinition, QuoteTime } from './pricebook.ts';
import type { Request } from '../protocol/open-responses/index.ts';
import type { ContextRecord } from '../protocol/open-responses/context.ts';
import type { GenerateOptions, Generation, GenerationError, ResponseClient } from '../core/generation.ts';

/** Providers expose standard Responses and own their native transport semantics. */
export abstract class BaseProvider implements ResponseClient {
  abstract respond(request: Request, options?: GenerateOptions): Promise<Generation>;
}

export interface ProviderHost {
  /**
   * 端点数据目录 <部署根>/providers/<端点名>/，内部结构由 provider 管理。
   * 不同端点使用不同目录；同一部署根下共享该端点的部署共用目录。
   */
  stateDir: string;
  repoRoot?: string;
  resource?<T>(key: string, create: () => T): T;
  currentEntry?(): LLMProviderEntry;
  /** 按名字取密钥:进程环境 > 这个端点的 `.env`。 */
  secret(name: string): string;
  /** 按句柄取回附件字节(渲染层把附件升格成内容分片时用);读不到 → null */
  readBlob(handle: string): Buffer | null;
  keepThinking(): boolean;
  log: Logger;
}

/** 传给 ProviderRegistry 的宿主；registry 按端点补充 stateDir 和对应目录的 secret 读取器。 */
export type ProviderHostBase = Omit<ProviderHost, 'stateDir' | 'secret' | 'currentEntry' | 'resource'> & {
  /** 同一部署根下共享的端点目录。 */
  stateRoot: string;
};

export interface ProviderInstance {
  client: BaseProvider;
  /** Model ids the endpoint advertises (`GET /models`), with the context window when the catalog states one. */
  listModels?(): Promise<Array<{ id: string; contextWindow?: number }>>;
  /** Module-owned control object; interpreted by that module's console contribution. */
  control?: unknown;
  compatibilityKey?(): unknown;
  start?(): Promise<unknown>;
  stop?(): Promise<unknown>;
  /**
   * Context window the upstream reports for this model, in tokens. How it is detected
   * belongs to the module (a model catalog, a server properties endpoint, a launch
   * parameter); `undefined` until known. The core takes the minimum of this and the
   * profile's hand-filled `contextWindow`.
   */
  contextWindow?(model: string): number | undefined;
}

/** 一个端点此刻能不能发起生成。判断只看本地状态,不连上游。 */
export interface ProviderAvailability {
  ready: boolean;
  /** 不可用的原因,控制台语言;可用时不带。 */
  reason?: string;
}

export interface ProviderModule {
  id: string;
  title: string;
  defaultBaseUrl?: string;
  /** Candidate endpoint URLs offered on the URL field. Candidates only: any URL is accepted. */
  baseUrlSuggestions?: readonly string[];
  /** Empty = open: `reasoningEffort` accepts any non-empty string; `effortSuggestions` supplies the candidates. */
  reasoningTiers: readonly ReasoningTier[];
  effortSuggestions?: readonly string[];
  serviceTiers: readonly ServiceTier[];
  temperatureNote?: string;
  /**
   * Console copies of the tier tables and temperature note in the console language.
   * Absent (or a field left out) = the tables above are shown as written.
   */
  localize?(language: Language): {
    reasoningTiers?: readonly ReasoningTier[];
    serviceTiers?: readonly ServiceTier[];
    temperatureNote?: string;
  };
  /**
   * 这个端点还缺什么本地条件。框架先查通用条件——模型、密钥——都齐了才问模块;
   * 除此之外没有条件的模块不实现它。
   */
  availability?(name: string, entry: LLMProviderEntry, language: Language): ProviderAvailability;
  normalize?(entry: LLMProviderEntry): LLMProviderEntry;
  /** `language` is the console language for the thrown message; validation itself is fixed. */
  validateEntry?(entry: LLMProviderEntry, language: Language): void;
  validateModel?(entry: LLMProviderEntry, spec: ModelSpec): void;
  accepts?(entry: LLMProviderEntry, spec: ModelSpec, mime: string): boolean;
  config?(name: string, entry: LLMProviderEntry, language: Language): ConfigGroup[];
  console?(host: ProviderConsoleHost): Partial<ConsolePageContribution>;
  prices?(entry: LLMProviderEntry, request: Request, at: QuoteTime): readonly PriceDefinition[];
  /**
   * Estimate tokens for records not yet covered by upstream usage.
   * Absent: Core uses its character-ratio estimate.
   */
  estimateTokens?(records: readonly ContextRecord[], spec: ModelSpec): number;
  /** The upstream rejected a request because its input exceeded the model's context. */
  contextOverflow?(error: GenerationError): boolean;
  create(name: string, entry: LLMProviderEntry, host: ProviderHost): ProviderInstance;
}
