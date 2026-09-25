import type { ConfigGroup } from '../../core/types.ts';
import type { VisionConfig } from './vision.ts';

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
 * 专用面板(要卡片式增删、要重启),这里放的是自带视觉的行为旋钮。
 */
export const QQ_CONFIG_GROUP: ConfigGroup = {
  id: 'world:qq',
  owner: 'world:qq',
  schema: {
    type: 'object',
    title: 'QQ · 辅助视觉',
    description: '图片描述写入事件库。',
    properties: {
      'worlds.qq.vision.enabled': {
        type: 'boolean',
        title: '开启辅助视觉',
        'x-hot': false,
        description: '关掉后不生成图片描述；主模型接受图片时，原图仍随消息投递。开启需配置 OPENROUTER_API_KEY 并重启。',
      },
      'worlds.qq.vision.model': {
        type: 'string',
        title: 'VLM 模型',
        'x-hot': false,
        description: 'OpenRouter 上的模型名。重启生效。',
      },
      'worlds.qq.vision.concurrency': {
        type: 'integer',
        title: '被动识图并发',
        minimum: 1,
        maximum: 16,
        multipleOf: 1,
        'x-suffix': '路',
        'x-hot': true,
        description: '同时最多跑几张图的识别。',
      },
      'worlds.qq.vision.dedupPrecheckMs': {
        type: 'integer',
        title: '图片内联等待上限',
        minimum: 0,
        maximum: 30_000,
        multipleOf: 100,
        'x-suffix': 'ms',
        'x-hot': true,
        description: '消息投递前等待图片下载或去重预判的最长时间。超时后的图片在下载完成后另行投递；'
          + '辅助视觉开启时，新图片的识图结果仍另行投递。',
      },
      'worlds.qq.vision.maxImageBytes': {
        type: 'integer',
        title: '图片下载上限',
        minimum: 65_536,
        maximum: 104_857_600,
        multipleOf: 65_536,
        'x-scale': 1_048_576,
        'x-suffix': 'MB',
        'x-hot': true,
        description: '超过这个大小的图不下载、不识别。',
      },
      'worlds.qq.vision.timeoutMs': {
        type: 'integer',
        title: '图片与 VLM 请求超时',
        minimum: 1000,
        maximum: 300_000,
        multipleOf: 1000,
        'x-scale': 1000,
        'x-suffix': 's',
        'x-hot': false,
        description: '图片下载和辅助视觉请求均使用此超时；修改后需重启生效。',
      },
    },
  },
};

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
