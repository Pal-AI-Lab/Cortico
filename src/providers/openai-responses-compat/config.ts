import type { ConfigGroup } from '../../core/config-schema.ts';
import type { LLMProviderEntry } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import { REASONING_REPLAYS, SYNTHETIC_REASONING_TEXT } from '../transport/responses-input.ts';
import { text } from './strings.ts';

export function protocolConfig(name: string, entry: LLMProviderEntry, language: Language): ConfigGroup[] {
  const S = text(language);
  return [{
    id: `llm.${entry.kind}.${name}.protocol`,
    owner: `provider:${entry.kind}`,
    schema: {
      type: 'object', title: name,
      properties: {
        [`providers.${name}.options.extraHeaders`]: {
          type: 'object', title: language === 'zh' ? '附加请求头（JSON object）' : 'Extra headers (JSON object)',
        },
        [`providers.${name}.options.extraBody`]: {
          type: 'object', title: language === 'zh' ? '附加请求体（JSON object）' : 'Extra request body (JSON object)',
        },
        [`providers.${name}.options.endpointPath`]: {
          type: 'string', title: S.endpointPath, description: S.endpointPathDescription, 'x-hot': true,
        },
        [`providers.${name}.options.reasoningReplay`]: {
          type: 'string', enum: [...REASONING_REPLAYS], title: S.reasoningReplay, description: S.reasoningReplayDescription, 'x-hot': true,
        },
        [`providers.${name}.options.syntheticReasoningText`]: {
          type: 'string', title: S.syntheticReasoningText, description: S.syntheticReasoningTextDescription(SYNTHETIC_REASONING_TEXT), 'x-hot': true,
        },
      },
    },
  }];
}
