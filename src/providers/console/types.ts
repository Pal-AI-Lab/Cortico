import type { LLMProviderEntry } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import type { ProviderInstance } from '../base.ts';

/** Output token limit for the connectivity probe and module probes. */
export const PROBE_MAX_OUTPUT_TOKENS = 256;

export interface ProviderConsoleHost {
  /** Console language for panel titles, receipts and error texts. */
  readonly language: Language;
  /** Configuration edits return to the browser draft; runtime mutations require a saved connection. */
  readonly editing?: boolean;
  entries(): Array<{ name: string; entry: LLMProviderEntry }>;
  instance(name: string): ProviderInstance;
  save(name: string, entry: LLMProviderEntry): void;
}
