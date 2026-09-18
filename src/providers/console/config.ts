import type { ConfigGroup } from '../../core/config-schema.ts';
import type { LLMProviderEntry } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import { text } from './strings.ts';

export function connectionGroup(name: string, entry: LLMProviderEntry, language: Language): ConfigGroup {
  const S = text(language);
  const prefix = `providers.${name}.`;
  return {
    id: `llm.${entry.kind}.${name}.connection`,
    owner: `provider:${entry.kind}`,
    schema: {
      type: 'object', title: name, description: S.connectionDescription,
      properties: {
        [`${prefix}baseUrl`]: { type: 'string', title: S.baseUrl, 'x-hot': true },
        [`${prefix}secret`]: { type: 'string', title: S.secret, description: S.secretDescription, 'x-hot': true },
        [`${prefix}multimodal`]: { type: 'boolean', title: S.multimodal, 'x-hot': true },
      },
    },
  };
}
