/** Core 默认配置与深合并工具。Persona 和 World 参数由各自声明，部署合并顺序见 src/deploy.ts。 */
import type { CoreConfig } from './types.ts';
import type { ConfigGroup } from './config-schema.ts';
import type { Language } from './language.ts';
import { coreGroupText } from './strings.ts';
import { SYSTEM_TIMEZONE } from './util.ts';

/** 按请求语言生成配置文案；各语言使用相同的结构与取值范围。 */
/** 用量报告可换算的币种与初始汇率:1 USD 合多少该币种，取 2026-10-10 的中间价。部署里可改。 */
export const USAGE_RATES: Readonly<Record<string, number>> = {
  CNY: 6.69, EUR: 0.892, JPY: 158.3, KRW: 1341, TWD: 31.9, BRL: 4.99, RUB: 85.4,
};

export function coreConfigGroup(language: Language): ConfigGroup {
  const t = coreGroupText(language);
  const rates = Object.fromEntries(Object.keys(USAGE_RATES).map((code) => [`usage.rates.${code}`, {
    type: 'number' as const,
    title: t.usageRate.title(code),
    minimum: 0,
    'x-hot': true,
    description: t.usageRate.description,
  }]));
  return {
    id: 'core',
    owner: 'core',
    schema: {
      type: 'object',
      title: t.title,
      description: t.description,
      properties: {
        displayName: {
          type: 'string',
          title: t.displayName.title,
          'x-hot': true,
          description: t.displayName.description,
        },
        'batching.quietGapMs': {
          type: 'integer',
          title: t.quietGap.title,
          minimum: 100,
          maximum: 600_000,
          multipleOf: 100,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': true,
          description: t.quietGap.description,
        },
        'batching.minBatchAgeMs': {
          type: 'integer',
          title: t.minBatchAge.title,
          minimum: 0,
          maximum: 600_000,
          multipleOf: 100,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': true,
          description: t.minBatchAge.description,
        },
        'batching.maxBatchAgeMs': {
          type: 'integer',
          title: t.maxBatchAge.title,
          minimum: 1000,
          maximum: 3_600_000,
          multipleOf: 500,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': true,
          description: t.maxBatchAge.description,
        },
        'batching.maxBatchSize': {
          type: 'integer',
          title: t.maxBatchSize.title,
          minimum: 1,
          maximum: 1000,
          'x-suffix': t.maxBatchSize.suffix,
          'x-hot': true,
          description: t.maxBatchSize.description,
        },
        'context.keepPastThinking': {
          type: 'boolean',
          title: t.keepPastThinking.title,
          'x-hot': true,
          description: t.keepPastThinking.description,
        },
        'logging.file': {
          type: 'string',
          title: t.logFile.title,
          enum: ['trace', 'debug', 'info', 'warn', 'error'],
          'x-hot': true,
          description: t.logFile.description,
        },
        'logging.console': {
          type: 'string',
          title: t.logConsole.title,
          enum: ['trace', 'debug', 'info', 'warn', 'error'],
          'x-hot': true,
          description: t.logConsole.description,
        },
        'logging.areas': {
          type: 'string',
          title: t.logAreas.title,
          'x-hot': true,
          description: t.logAreas.description,
        },
        ...rates,
      },
    },
  };
}

/** 供开发脚本和测试引用的中文版；运行时按请求语言生成。 */
export const CORE_CONFIG_GROUP: ConfigGroup = coreConfigGroup('zh');

export const CORE_DEFAULTS = {
  /** 用于控制台标题和终端消息的发送方名称。 */
  displayName: 'Cortico Bot',
  timezone: SYSTEM_TIMEZONE,
  providers: {} as Record<string, import('./types.ts').LLMProviderEntry>,
  activeProvider: '',
  web: { port: 7777, theme: 'mint' },
  paths: { memory: 'memory', data: 'data' },
  batching: { quietGapMs: 2500, minBatchAgeMs: 0, maxBatchAgeMs: 15000, maxBatchSize: 100 },
  context: { keepPastThinking: true },
  logging: { file: 'debug' as const, console: 'info' as const, areas: '' },
  usage: { rates: USAGE_RATES },
} as const;


export function cloneConfigValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneConfigValue(item)) as T;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = cloneConfigValue(item);
    return out as T;
  }
  return value;
}

/** 后一层覆盖前一层；对象递归合并，数组整体替换。 */
export function deepMerge<T>(base: T, patch: Partial<T> | undefined): T {
  if (patch === undefined) return cloneConfigValue(base);
  if (Array.isArray(base) || Array.isArray(patch)) {
    return cloneConfigValue((patch as T) ?? base);
  }
  if (typeof base === 'object' && base !== null && typeof patch === 'object' && patch !== null) {
    const out = cloneConfigValue(base) as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      const bv = (base as Record<string, unknown>)[k];
      out[k] = bv !== undefined && typeof bv === 'object' && bv !== null && !Array.isArray(bv)
        ? deepMerge(bv, v as never)
        : cloneConfigValue(v);
    }
    return out as T;
  }
  return cloneConfigValue((patch as T) ?? base);
}

/** 已合并的部署配置。运行时共享 config 引用，配置热更新必须保留父对象身份。 */
export interface LoadedConfig<C extends CoreConfig = CoreConfig> {
  /** 可包含 Persona 与 World 配置；Core 仅依赖 CoreConfig 字段。 */
  config: C;
  /** 密钥名称由使用方声明，装配层按名称读取。 */
  secret(name: string): string;
  /** 部署目录，包含 config.json、.env 和 data/。 */
  rootDir: string;
  /** bot 代码包目录，可供多个部署使用；缺省时使用 rootDir。 */
  packageDir?: string;
  /**
   * 共享端点目录 <部署根>/providers/，各端点内部结构由 provider 管理。
   * 缺省时使用 <rootDir>/providers。
   */
  providersDir?: string;
  repoRoot?: string;
  /** 解析后的绝对路径 */
  memoryDir: string;
  dataDir: string;
}
