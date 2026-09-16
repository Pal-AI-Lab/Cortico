/** Core 默认配置与深合并工具。Persona 和 World 参数由各自声明，部署合并顺序见 src/deploy.ts。 */
import type { CoreConfig } from './types.ts';
import type { PriceDefinition } from '../providers/pricebook.ts';
import type { ConfigGroup } from './config-schema.ts';
import { pick, type Language } from './language.ts';

const CORE_GROUP_TEXT = {
  zh: {
    title: "事件合批、推理与日志",
    description: "",
    displayName: {
      title: '展示名',
      description: '控制台标题与 bot 发出的消息用这个名字。控制台立刻跟上;已经挂载的 World 在自己重启后才跟上。',
    },
    quietGap: {
      title: '安静窗口',
      description: "参与合批的事件在最后一项到达后等待此时长；达到批次时限或数量上限时提前投递。",
    },
    minBatchAge: {
      title: "最短合批时间",
      description: "参与合批的事件从第一项到达起至少等待此时长；批次时限和数量上限优先。",
    },
    maxBatchAge: {
      title: "最长合批时间",
      description: "从第一项到达起，合批等待不超过此时长。",
    },
    maxBatchSize: {
      title: '单批上限',
      suffix: '条',
      description: "外部事件和候选达到此数量时立即投递；不计延迟渲染项和 piggyback 项。",
    },
    keepPastThinking: {
      title: '保留历史思维链',
      description: "启用后，provider 可回传兼容的历史推理；关闭后请求不含历史推理。已保存的 session 不变。",
    },
    logFile: {
      title: '日志落盘门槛',
      description: "低于此级别的记录不写入 data/runs/<run>/log.jsonl。",
    },
    logConsole: {
      title: '日志打印门槛',
      description: '低于这一级的记录不打到控制台窗口。',
    },
    logAreas: {
      title: '按区域覆盖落盘门槛',
      description: "以逗号分隔 `区域=级别`，例如 `core.loop=trace,console=warn`；支持 `.*`。最长匹配前缀优先，未匹配的区域使用默认门槛。",
    },
  },
  en: {
    title: "Event batching, reasoning and logging",
    description: "",
    displayName: {
      title: 'Display name',
      description: 'Used for the console title and as the sender name on messages the bot sends. The console picks it up at once; a mounted World does so when that World restarts.',
    },
    quietGap: {
      title: 'Quiet window',
      description: "Wait this long after the last batched item arrives; the batch time and size limits can trigger earlier delivery.",
    },
    minBatchAge: {
      title: 'Minimum batch age',
      description: "Wait at least this long after the first batched item arrives; the batch time and size limits take precedence.",
    },
    maxBatchAge: {
      title: "Maximum batch age",
      description: "Limit batching delay to this duration from the first item.",
    },
    maxBatchSize: {
      title: 'Batch size limit',
      suffix: 'items',
      description: "Deliver when external events and candidates reach this count; deferred rendering and piggyback items are excluded.",
    },
    keepPastThinking: {
      title: 'Keep past reasoning',
      description: "Allow the provider to replay compatible past reasoning. When disabled, requests omit past reasoning. Saved sessions are unchanged.",
    },
    logFile: {
      title: 'Log file threshold',
      description: "Records below this level are not written to data/runs/<run>/log.jsonl.",
    },
    logConsole: {
      title: 'Log print threshold',
      description: 'Records below this level are not printed to the console window.',
    },
    logAreas: {
      title: 'Per-area file threshold overrides',
      description: "Comma-separated `area=level`, such as `core.loop=trace,console=warn`; `.*` is supported. The longest matching prefix applies. Unmatched areas use the default threshold.",
    },
  },
};

/** 按请求语言生成配置文案；两种语言使用相同的结构与取值范围。 */
export function coreConfigGroup(language: Language): ConfigGroup {
  const t = pick(language, CORE_GROUP_TEXT);
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
      },
    },
  };
}

/** 供开发脚本和测试引用的中文版；运行时按请求语言生成。 */
export const CORE_CONFIG_GROUP: ConfigGroup = coreConfigGroup('zh');

export const CORE_DEFAULTS = {
  /** 用于控制台标题和终端消息的发送方名称。 */
  displayName: 'Cortico Bot',
  timezone: 'Asia/Shanghai',
  /** 默认端点；部署根 providers/ 中的同名端点配置覆盖此项。 */
  providers: {
    deepseek: {
      kind: 'openai-responses-compat' as const,
      baseUrl: 'https://api.deepseek.com',
      secret: 'DEEPSEEK_API_KEY',
      spec: { model: 'deepseek-flash', thinking: false },
      // 默认价目为零；操作者可在控制台填写实际价格。
      pricing: [{
        models: ['*'], currency: 'USD', basis: 'marginal', source: 'console',
        rules: [{ meter: 'cachedInput', perMillion: 0 }, { meter: 'uncachedInput', perMillion: 0 }, { meter: 'output', perMillion: 0 }],
      }] as PriceDefinition[],
    },
  },
  activeProvider: 'deepseek',
  web: { port: 7777, theme: 'mint' },
  paths: { memory: 'memory', data: 'data' },
  batching: { quietGapMs: 2500, minBatchAgeMs: 0, maxBatchAgeMs: 15000, maxBatchSize: 100 },
  context: { keepPastThinking: true },
  logging: { file: 'debug' as const, console: 'info' as const, areas: '' },
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
