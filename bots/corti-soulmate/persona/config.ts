/**
 * Persona发布的层 2 建议配置；层 3 的 `config.json` 部署值优先。
 * 内容是Persona参数与 session 阶段容量。用哪个模型、模型物理上下文上限
 * 都是 Provider 事实,不在这里。
 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';

/** Persona建议的配置片段(会被 config.json 覆盖) */
export interface PersonaConfig {
  context: {
    /** 用于计算预警阈值和交接笔记预算。 */
    maxTokens: number;
    /** 交接笔记预算占阶段预算的比例。 */
    keepRatio: number;
    /** 超过阶段预算的此比例时先提示；下一批结束时仍超出则交接。 */
    softRatio: number;
    /** 是否把部署 prompts/ 里的首轮对话作为合成开头送进请求。 */
    firstTurn: boolean;
  };
  loop: { softCap: number; hardCap: number };
  memo: { residentCap: number; activeCap: number };
  tick: {
    dayIntervalMinutes: [number, number];
    nightIntervalMinutes: number | null;
    nightStartHour: number;
    nightEndHour: number;
  };
  dream: { maxRounds: number };
}

/**
 * 这份Persona声明的可调项。控制台只按 JSON Schema 渲染,不解释
 * "memo 三级缓存""梦"等人格概念。
 *
 * 模型不归Persona:用哪个模型、怎么想整组归 Provider,它拿不到也不问。
 */
export const PERSONA_CONFIG_GROUP: ConfigGroup = {
  // id 是配置组的实例身份;同一进程中的多个 bot 必须可区分。
  id: 'corti',
  // owner 是**角色**,词表由框架定(core / persona / module:*)。它回答的是
  // "这组参数归四分法里的哪一块",不包含具体实现名称。
  owner: 'persona',
  schema: {
    type: 'object',
    title: '认知节奏',
    description: '一个 session 阶段有多长、一次唤醒能行动几轮、备忘分层容量、作息与梦的成本边界。',
    properties: {
      'context.maxTokens': {
        type: 'integer',
        title: '上下文阶段预算',
        minimum: 8000,
        maximum: 2_000_000,
        multipleOf: 1000,
        'x-suffix': 'tok',
        'x-hot': true,
        description:
          '上下文超过阶段预算 × 软阈值比例时先提示；下一批结束时仍超出则交接，并启动后台整理。'
          + '模型窗口与单次输出上限在「语言模型」页配置；达到模型硬限制时由 Core 强制交接。',
      },
      'context.keepRatio': {
        type: 'number',
        title: '交接保留比例',
        minimum: 0.05,
        maximum: 0.9,
        multipleOf: 0.01,
        'x-suffix': '×',
        'x-hot': true,
        description: '交接笔记的 token 预算 = 阶段预算 × 此比例。笔记保留最近内容。',
      },
      'context.softRatio': {
        type: 'number',
        title: '软阈值比例',
        minimum: 0.1,
        maximum: 1,
        multipleOf: 0.01,
        'x-suffix': '×',
        'x-hot': true,
        description: '上下文预警阈值 = 阶段预算 × 此比例。',
      },
      'context.firstTurn': {
        type: 'boolean',
        title: '合成首轮对话',
        'x-hot': true,
        description: '把部署 prompts/ 里的首轮对话(FIRST_TURN_USER / THINKING / REPLY)作为合成开头送进每次请求,不写入 session;内容为空时不送。',
      },
      'loop.softCap': {
        type: 'integer',
        title: '工具循环软上限',
        minimum: 1,
        maximum: 100,
        multipleOf: 1,
        'x-suffix': '轮',
        'x-hot': true,
        description: '单次唤醒行动到这一轮,追加一条疲劳提示。',
      },
      'loop.hardCap': {
        type: 'integer',
        title: '工具循环硬上限',
        minimum: 1,
        maximum: 200,
        multipleOf: 1,
        'x-suffix': '轮',
        'x-hot': true,
        description: '到这一轮直接结束本次唤醒。应 ≥ 软上限。',
      },
      'memo.residentCap': {
        type: 'integer',
        title: 'memo 常驻条数',
        minimum: 1,
        maximum: 50,
        multipleOf: 1,
        'x-suffix': '条',
        'x-hot': true,
        description: 'MEMORY 2 常驻区容量；前缀包含这一层的全文。',
      },
      'memo.activeCap': {
        type: 'integer',
        title: 'memo active 条数',
        minimum: 1,
        maximum: 200,
        multipleOf: 1,
        'x-suffix': '条',
        'x-hot': true,
        description: 'memo/active/ 区容量(前缀只列文件名那层)。',
      },
      'tick.dayIntervalMinutes': {
        type: 'array',
        title: '白天 tick 间隔 [最小,最大]',
        items: { type: 'integer', minimum: 1, maximum: 1440 },
        minItems: 2,
        maxItems: 2,
        'x-suffix': 'min',
        'x-hot': true,
        description: '白天两次主动 tick 的间隔在此区间内取随机。',
      },
      'tick.nightIntervalMinutes': {
        type: 'integer',
        title: '深夜 tick 间隔',
        minimum: 0,
        maximum: 1440,
        multipleOf: 1,
        nullable: true,
        'x-suffix': 'min',
        'x-hot': true,
        description: '深夜 tick 间隔分钟;留空(null)＝深夜完全不 tick。',
      },
      'tick.nightStartHour': {
        type: 'integer',
        title: '深夜起始',
        minimum: 0,
        maximum: 23,
        multipleOf: 1,
        'x-suffix': '点',
        'x-hot': true,
        description: '深夜起始整点(含)。',
      },
      'tick.nightEndHour': {
        type: 'integer',
        title: '深夜结束',
        minimum: 0,
        maximum: 23,
        multipleOf: 1,
        'x-suffix': '点',
        'x-hot': true,
        description: '深夜结束整点。',
      },
      'dream.maxRounds': {
        type: 'integer',
        title: '梦 fork 轮数上限',
        minimum: 1,
        maximum: 200,
        multipleOf: 1,
        'x-suffix': '轮',
        'x-hot': true,
        description: '每次交接后唯一一场梦的工具循环上限(成本边界)。',
      },
    },
  },
};

export const PERSONA_DEFAULTS: PersonaConfig = {
  context: { maxTokens: 128000, keepRatio: 0.3333, softRatio: 0.85, firstTurn: false },
  loop: { softCap: 8, hardCap: 16 },
  // MEMORY 2 的三层容量(7±2 的 7)
  memo: { residentCap: 7, activeCap: 21 },
  // 作息:白天随机间隔 tick,深夜放缓
  tick: { dayIntervalMinutes: [30, 60], nightIntervalMinutes: 120, nightStartHour: 0, nightEndHour: 8 },
  dream: { maxRounds: 40 },
};
