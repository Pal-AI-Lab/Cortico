import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { configText } from './strings.ts';

/**
 * 上下文阶段三个裁量与首轮对话开关(`ContextStagePolicy`)的 WebUI 配置组。归属 `persona`:
 * 容量与首轮对话都是 Persona 的参数,core 只持 `hardTokens` 物理钳制与 keepPastThinking。渲染在
 * Persona 页的配置页签。
 *
 * 每个以 Cormini 为骨架的 bot 各声明一次,`id` 按 bot 取;没有这一组的 bot,这三个数在
 * WebUI 上没有位置,只能改 config.json。标题与说明按请求语言给出。
 */
export function contextStageConfigGroup(id: string, language: Language): ConfigGroup {
  const t = configText(language);
  return {
    id,
    owner: 'persona',
    schema: {
      type: 'object',
      title: t.title,
      description: t.description,
      properties: {
        'context.maxTokens': {
          type: 'integer',
          title: t.maxTokens,
          minimum: 8000,
          maximum: 2_000_000,
          multipleOf: 1000,
          'x-suffix': 'tok',
          'x-hot': true,
          description: t.maxTokensDesc,
        },
        'context.keepRatio': {
          type: 'number',
          title: t.keepRatio,
          minimum: 0.05,
          maximum: 0.9,
          multipleOf: 0.01,
          'x-suffix': '×',
          'x-hot': true,
          description: t.keepRatioDesc,
        },
        'context.softRatio': {
          type: 'number',
          title: t.softRatio,
          minimum: 0.1,
          maximum: 1,
          multipleOf: 0.01,
          'x-suffix': '×',
          'x-hot': true,
          description: t.softRatioDesc,
        },
        'context.firstTurn': {
          type: 'boolean',
          title: t.firstTurn,
          'x-hot': true,
          description: t.firstTurnDesc,
        },
      },
    },
  };
}
