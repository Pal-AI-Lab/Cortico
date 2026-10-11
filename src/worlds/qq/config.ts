import type { ConfigGroup } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import type { VisionConfig } from './vision.ts';
import { text } from './strings.ts';

/** 关闭的 roster 条目仍持久化并显示,仅从监听集合中排除。 */
export interface QQRosterEntry {
  id: number;
  enabled: boolean;
}

export const QQ_DEFAULTS = {
  enabled: false,
  /** OneBot v11 协议端的正向 WS 地址 */
  wsUrl: 'ws://127.0.0.1:3001',
  groups: [] as QQRosterEntry[],
  privates: [] as QQRosterEntry[],
  token: '',
} as const;

/**
 * 本 World 需要的密钥的**环境变量名**。辅助视觉用的是 OpenRouter——
 * core 不认识这个名字,装配层照 World 声明的名字取值。
 */
export const QQ_SECRETS = { vision: 'OPENROUTER_API_KEY' } as const;

/**
 * 本 World 声明的可调项。只声明**World 自己**的参数:连接与监听名单有
 * 专用面板(要卡片式增删、要重启),这里放的是自带视觉的行为旋钮。文案按界面语言给。
 */
export function qqConfigGroup(language: Language): ConfigGroup {
  const t = text(language);
  return {
    id: 'world:qq',
    owner: 'world:qq',
    schema: {
      type: 'object',
      title: t.configTitle,
      description: t.configDescription,
      properties: {
        'worlds.qq.vision.enabled': {
          type: 'boolean',
          title: t.visionEnabledTitle,
          'x-hot': false,
          description: t.visionEnabledDescription,
        },
        'worlds.qq.vision.model': {
          type: 'string',
          title: t.visionModelTitle,
          'x-hot': false,
          description: t.visionModelDescription,
        },
        'worlds.qq.vision.concurrency': {
          type: 'integer',
          title: t.concurrencyTitle,
          minimum: 1,
          maximum: 16,
          multipleOf: 1,
          'x-suffix': t.concurrencySuffix,
          'x-hot': true,
          description: t.concurrencyDescription,
        },
        'worlds.qq.vision.dedupPrecheckMs': {
          type: 'integer',
          title: t.dedupPrecheckTitle,
          minimum: 0,
          maximum: 30_000,
          multipleOf: 100,
          'x-suffix': 'ms',
          'x-hot': true,
          description: t.dedupPrecheckDescription,
        },
        'worlds.qq.vision.maxImageBytes': {
          type: 'integer',
          title: t.maxImageBytesTitle,
          minimum: 65_536,
          maximum: 104_857_600,
          multipleOf: 65_536,
          'x-scale': 1_048_576,
          'x-suffix': 'MB',
          'x-hot': true,
          description: t.maxImageBytesDescription,
        },
        'worlds.qq.vision.timeoutMs': {
          type: 'integer',
          title: t.timeoutTitle,
          minimum: 1000,
          maximum: 300_000,
          multipleOf: 1000,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': false,
          description: t.timeoutDescription,
        },
      },
    },
  };
}

/** config.json 的 `worlds.qq` 节。 */
export interface QQConfigSection {
  enabled: boolean;
  /** OneBot v11 协议端的正向 WS 地址 */
  wsUrl: string;
  /** 群 roster,逐项热更新;关闭的条目仍持久化并显示,但不参与监听。 */
  groups: QQRosterEntry[];
  /** 监听的私聊 QQ 号 roster,语义同 groups */
  privates: QQRosterEntry[];
  /** OneBot access token,可空 */
  token: string;
  vision: VisionConfig;
}
