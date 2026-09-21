import { createHash } from 'node:crypto';
import type { Request } from '../protocol/open-responses/index.ts';
import type { LLMProviderEntry } from '../core/types.ts';
import type { Language } from '../core/language.ts';
import type { PriceSnapshot, PriceRule, PriceTable, PriceWindow } from '../core/generation.ts';
import { text } from './strings.ts';

export interface PriceDefinition extends PriceTable {
  models: string[];
  currency: string;
  basis: 'marginal' | 'equivalent';
  /** A module declares its own time-of-day windows; `validatePrices` does not take them from an endpoint. */
  timeWindows?: PriceWindow[];
  source: string;
}
export interface QuoteTime { startedAt: string; requestedServiceTier: string | null; }

export function snapshotPrice(definition: PriceDefinition, at: QuoteTime): PriceSnapshot {
  const { models: _models, ...definitionBody } = definition;
  return { ...structuredClone(definitionBody), id: createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 20), capturedAt: at.startedAt };
}

/** An explicit instance override replaces the module's quote for that cost basis. */
export function quotePrices(entry: LLMProviderEntry, request: Request, at: QuoteTime, defaults: readonly PriceDefinition[]): PriceSnapshot[] {
  const byBasis = new Map<string, PriceDefinition>();
  for (const definition of [...defaults, ...(entry.pricing ?? [])]) {
    if (definition.models.includes('*') || definition.models.includes(request.model ?? '')) byBasis.set(definition.basis, definition);
  }
  return [...byBasis.values()].map(definition => snapshotPrice(definition, at));
}

/** External configuration boundary for module-owned rate definitions. `language` picks the message wording. */
export function validatePrices(value: unknown, language: Language = 'zh'): PriceDefinition[] {
  const S = text(language);
  if (!Array.isArray(value)) throw new Error(S.pricingArray);
  const meters = new Set(['input', 'output', 'total', 'cachedInput', 'uncachedInput', 'reasoning']);
  const rules = (raw: unknown): PriceRule[] => {
    if (!Array.isArray(raw)) throw new Error(S.rulesArray);
    return raw.map(rule => {
      if (!rule || typeof rule !== 'object' || typeof rule.meter !== 'string' || (!meters.has(rule.meter) && !rule.meter.startsWith('detail:'))
        || typeof rule.perMillion !== 'number' || !Number.isFinite(rule.perMillion) || rule.perMillion < 0) throw new Error(S.ruleShape);
      if (rule.unit !== undefined && (typeof rule.unit !== 'string' || !rule.unit.trim())) throw new Error(S.unitRequired);
      if (meters.has(rule.meter) && rule.unit !== undefined && rule.unit !== 'token') throw new Error(S.tokenUnit);
      return { meter: rule.meter, perMillion: rule.perMillion, ...(rule.unit ? { unit: rule.unit } : {}) };
    });
  };
  const bands = (raw: unknown) => {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) throw new Error(S.bandsArray);
    let previous = 0;
    return raw.map(band => {
      if (!band || typeof band.from !== 'number' || !Number.isFinite(band.from) || band.from <= previous) throw new Error(S.bandsIncreasing);
      previous = band.from;
      return { from: band.from, rules: rules(band.rules) };
    });
  };
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.models) || !raw.models.length || raw.models.some((model: unknown) => typeof model !== 'string' || !model.trim())) throw new Error(S.modelsRequired);
    if (typeof raw.currency !== 'string' || !raw.currency.trim()) throw new Error(S.currencyRequired);
    if (raw.basis !== 'marginal' && raw.basis !== 'equivalent') throw new Error(S.basisValue);
    if (typeof raw.source !== 'string' || !raw.source.trim()) throw new Error(S.sourceRequired);
    if (raw.timeWindows !== undefined) throw new Error(S.timeWindowsUnsupported);
    const tiers: PriceDefinition['serviceTiers'] = {};
    if (raw.serviceTiers !== undefined) {
      if (!raw.serviceTiers || typeof raw.serviceTiers !== 'object' || Array.isArray(raw.serviceTiers)) throw new Error(S.tiersObject);
      for (const [tier, data] of Object.entries(raw.serviceTiers) as [string, any][]) {
        if (!tier.trim()) throw new Error(S.tierNameRequired);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(S.tierRules);
        tiers[tier] = { rules: rules(data.rules), ...(data.inputBands ? { inputBands: bands(data.inputBands) } : {}) };
      }
    }
    return { models: [...raw.models], currency: raw.currency.trim(), basis: raw.basis, source: raw.source.trim(), rules: rules(raw.rules),
      ...(raw.inputBands ? { inputBands: bands(raw.inputBands) } : {}), ...(raw.serviceTiers ? { serviceTiers: tiers } : {}) };
  });
}
