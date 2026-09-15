import type { ModelSpec, ToolSchema, LLMUsage } from '../../core/types.ts';
import type { Request, Schemas } from './index.ts';
import type { TokenMeters } from '../../core/generation.ts';
import { inputItem, itemText, type ContextRecord } from './context.ts';

export function hasRole(entry: ContextRecord, role: string): boolean {
  return entry.item.type === 'message' && entry.item.role === role;
}
export function textOf(entry: ContextRecord): string { return itemText(entry.item); }
export function withoutPastReasoning(entries: readonly ContextRecord[]): ContextRecord[] {
  return entries.filter(entry => entry.item.type !== 'reasoning' || entry.context.head);
}
export function responseRequest(spec: ModelSpec, context: readonly ContextRecord[], tools: readonly ToolSchema[] = []): Request {
  return {
    model: spec.model, input: context.map(inputItem), tools: tools.map(tool => ({ ...tool, type: 'function' })),
    // effort 词表归端点(见 ModelSpec.reasoningEffort);协议枚举只覆盖 OpenAI 自己的取值。
    reasoning: spec.thinking ? { ...(spec.reasoningEffort ? { effort: spec.reasoningEffort as Schemas['ReasoningEffortEnum'] } : {}) } : { effort: 'none' },
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.maxTokens !== undefined ? { max_output_tokens: spec.maxTokens } : {}),
  };
}

/** Legacy numeric dashboard totals sum only known measurements; billing retains nullable meters. */
export function usageCounters(meters: TokenMeters): LLMUsage {
  return { promptTokens: meters.input ?? 0, completionTokens: meters.output ?? 0,
    cacheHitTokens: meters.cachedInput ?? 0, cacheMissTokens: meters.uncachedInput ?? 0, reasoningTokens: meters.reasoning ?? undefined };
}
