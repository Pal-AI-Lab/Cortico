import type { ConfigGroup } from '../../core/config-schema.ts';
import type { LLMProviderEntry } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import type { ConsolePanelDecl } from '../../web/shared/console-protocol.ts';
import { text } from './strings.ts';

/**
 * The editor's own sections with their default wording. A module lists them among its panels,
 * in the order its workflow wants, and may override title and description.
 */
export function connectionBlocks(language: Language): Record<'endpoint' | 'model' | 'pricing' | 'protocol', ConsolePanelDecl> {
  const S = text(language);
  return {
    endpoint: { id: 'endpoint', title: S.endpointBlock, description: S.endpointBlockDescription, builtin: 'connection-endpoint', defaultOpen: true },
    model: { id: 'model', title: S.modelBlock, description: S.modelBlockDescription, builtin: 'connection-model', defaultOpen: true },
    pricing: { id: 'pricing', title: S.pricingBlock, builtin: 'connection-pricing', defaultOpen: false },
    protocol: { id: 'protocol', title: S.protocolBlock, description: S.protocolBlockDescription, builtin: 'connection-protocol', defaultOpen: false },
  };
}

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
