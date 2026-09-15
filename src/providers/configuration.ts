import type { LLMProviderEntry, ModelSpec } from '../core/types.ts';
import type { Language } from '../core/language.ts';
import type { ProviderAvailability, ProviderModule } from './base.ts';
import { validatePrices } from './pricebook.ts';
import { text } from './strings.ts';

/** `language` only picks the wording of the thrown message; the console passes its own. */
export function validateSpec(
  module: ProviderModule,
  entry: LLMProviderEntry,
  value: unknown,
  language: Language = 'zh',
): ModelSpec {
  const S = text(language);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(S.profileObject);
  const spec = value as ModelSpec;
  if (typeof spec.model !== 'string' || !spec.model.trim()) throw new Error(S.modelRequired);
  if (typeof spec.thinking !== 'boolean') throw new Error(S.thinkingBoolean);
  if (module.reasoningTiers.length) {
    if (
      !module.reasoningTiers.some(
        (tier) => tier.thinking === spec.thinking && tier.effort === spec.reasoningEffort,
      )
    )
      throw new Error(S.tierUnsupported(module.title));
  } else if (spec.reasoningEffort !== undefined) {
    if (typeof spec.reasoningEffort !== 'string' || !spec.reasoningEffort.trim())
      throw new Error(S.effortString);
    if (!spec.thinking) throw new Error(S.effortWithoutThinking);
  }
  if (
    spec.temperature !== undefined &&
    (!Number.isFinite(spec.temperature) || spec.temperature < 0 || spec.temperature > 2)
  )
    throw new Error(S.temperatureRange);
  for (const field of ['maxTokens', 'contextWindow'] as const) {
    if (spec[field] !== undefined && (!Number.isInteger(spec[field]) || spec[field]! <= 0))
      throw new Error(S.positiveInteger(field));
  }
  module.validateModel?.(entry, spec);
  return structuredClone({
    ...spec,
    model: spec.model.trim(),
    ...(spec.reasoningEffort !== undefined ? { reasoningEffort: spec.reasoningEffort.trim() } : {}),
  });
}

/**
 * 端点能不能用:选了模型、声明的密钥读得到,模块自己的条件也满足。
 * 通用条件不满足就不问模块,第一条不满足的就是回给操作员的那句话。
 */
export function endpointAvailability(
  module: ProviderModule,
  name: string,
  entry: LLMProviderEntry,
  secretConfigured: boolean,
  language: Language = 'zh',
): ProviderAvailability {
  const S = text(language);
  if (!entry.spec?.model) return { ready: false, reason: S.noModel };
  if (entry.secret && !secretConfigured) return { ready: false, reason: S.noSecret(entry.secret) };
  return module.availability?.(name, entry, language) ?? { ready: true };
}

export function validateEntry(
  module: ProviderModule,
  value: LLMProviderEntry,
  language: Language = 'zh',
): LLMProviderEntry {
  const S = text(language);
  if (
    value.options !== undefined &&
    (!value.options || typeof value.options !== 'object' || Array.isArray(value.options))
  )
    throw new Error(S.optionsObject);
  const entry = module.normalize?.(structuredClone(value)) ?? structuredClone(value);
  if (entry.kind !== module.id) throw new Error(S.kindChange);
  const url = new URL(entry.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error(S.baseUrlFormat);
  if (
    entry.secret !== undefined &&
    entry.secret !== '' &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.secret)
  )
    throw new Error(S.secretName);
  if (entry.multimodal !== undefined && typeof entry.multimodal !== 'boolean')
    throw new Error(S.multimodalBoolean);
  if (entry.serviceTier !== undefined && typeof entry.serviceTier !== 'string')
    throw new Error(S.serviceTierString);
  if (entry.serviceTier && !module.serviceTiers.some((tier) => tier.id === entry.serviceTier))
    throw new Error(S.serviceTierUnsupported(module.title, entry.serviceTier));
  if (entry.pricing !== undefined) entry.pricing = validatePrices(entry.pricing, language);
  if (entry.spec !== undefined) entry.spec = validateSpec(module, entry, entry.spec, language);
  module.validateEntry?.(entry, language);
  return entry;
}
