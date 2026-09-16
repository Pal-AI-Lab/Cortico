import type { ConsoleUi } from '../../../../shared/client-panel.ts';
import type { Language } from '../../../core/language.ts';
import { panel } from './strings.ts';

interface Rule {
  meter: string;
  perMillion: number;
}
interface Quote {
  currency: string;
  basis: string;
  rules: Rule[];
  source: string;
  inputBands?: unknown[];
  serviceTiers?: unknown;
}
export interface ModelQuote {
  model: string;
  quotes: Quote[];
}

const FORM_METERS = ['cachedInput', 'uncachedInput', 'output'] as const;

/** The one shape the three-rate form edits: a single `*` marginal definition with exactly the three meters. */
interface SimpleCost {
  currency: string;
  rates: [number, number, number];
}

function readSimple(saved: unknown[]): SimpleCost | null {
  if (saved.length !== 1) return null;
  const definition = saved[0] as Record<string, unknown>;
  if (!definition || typeof definition !== 'object') return null;
  const models = definition.models;
  if (!Array.isArray(models) || models.length !== 1 || models[0] !== '*') return null;
  if (definition.basis !== 'marginal' || typeof definition.currency !== 'string') return null;
  if (definition.inputBands !== undefined || definition.serviceTiers !== undefined) return null;
  const rules = definition.rules;
  if (!Array.isArray(rules) || rules.length !== FORM_METERS.length) return null;
  const rates = FORM_METERS.map((meter) => {
    const rule = rules.find((rule: Rule) => rule.meter === meter) as Rule | undefined;
    return rule && typeof rule.perMillion === 'number' ? rule.perMillion : NaN;
  });
  if (rates.some((rate) => Number.isNaN(rate))) return null;
  return { currency: definition.currency, rates: rates as [number, number, number] };
}

function writeSimple(cost: SimpleCost): unknown[] {
  return [
    {
      models: ['*'],
      currency: cost.currency,
      basis: 'marginal',
      source: 'console',
      rules: FORM_METERS.map((meter, i) => ({ meter, perMillion: cost.rates[i] })),
    },
  ];
}

/**
 * Pricing sheet: effective quotes, the three-rate form, the full-rules JSON (`details`) and the
 * quote snapshot. The JSON textarea is the single draft; form edits write through into it, and
 * every change commits the parsed textarea. An endpoint with no pricing keeps the form blank and
 * commits an empty definition list until a rate is typed. Saved pricing the form cannot express
 * opens the textarea and leaves the form blank until edited.
 */
export function pricingEditor(
  ui: ConsoleUi,
  saved: unknown[],
  quotes: ModelQuote[],
  commit: (pricing: unknown[]) => void,
  language?: Language,
) {
  const S = language === 'en' ? panel.en : panel.zh;
  const card = ui.sheet({
    title: S.pricingTitle,
    desc: S.pricingDescription,
  });
  const labels: Record<string, string> = S.meters;
  for (const row of quotes) {
    if (!row.quotes.length) card.body.append(ui.msgline(S.quoteUnknown(row.model)));
    for (const quote of row.quotes) {
      card.body.append(
        ui.kv([
          {
            k: row.model,
            v: `${quote.currency} · ${quote.basis === 'marginal' ? S.marginal : S.equivalent}`,
          },
        ]),
        ui.msgline(
          quote.rules.length
            ? quote.rules
                .map((rule) => S.perMillion(labels[rule.meter] ?? rule.meter, rule.perMillion))
                .join(' · ')
            : S.free,
        ),
        ui.msgline(quote.source),
      );
      if (quote.inputBands?.length || quote.serviceTiers)
        card.body.append(ui.msgline(S.bandsNote));
    }
  }
  const unset = saved.length === 0;
  if (unset) card.body.append(ui.msgline(S.pricingUnset));
  const simple: SimpleCost | null = unset ? null : readSimple(saved);
  const raw = ui.textarea({
    rows: 10,
    value: JSON.stringify(simple ? writeSimple(simple) : saved, null, 2),
    onChange: commitDraft,
  });
  const currency = ui.input({ value: simple?.currency ?? 'USD', onChange: writeThrough });
  currency.setAttribute('aria-label', S.currencyField);
  const problem = ui.msgline();
  const rateLabels = [S.rateCached, S.rateUncached, S.rateOutput];
  const rates = rateLabels.map((label, i) => {
    const input = ui.input({
      type: 'number',
      value: simple ? String(simple.rates[i]) : '',
      onChange: writeThrough,
    });
    input.min = '0';
    input.step = 'any';
    input.setAttribute('aria-label', label);
    return input;
  });
  /** 三格全空 = 没有报价;填了任何一格,空格按 0 计。 */
  function writeThrough() {
    const blank = rates.every((input) => input.value.trim() === '');
    raw.value = blank
      ? '[]'
      : JSON.stringify(
          writeSimple({
            currency: currency.value.trim() || 'USD',
            rates: rates.map((input) => Number(input.value) || 0) as [number, number, number],
          }),
          null,
          2,
        );
    commitDraft();
  }
  /** 完整规则那格可以写坏;解析不过就停在这张卡上说清楚,不往端点写。 */
  function commitDraft(): void {
    try {
      const pricing = JSON.parse(raw.value) as unknown[];
      problem.textContent = '';
      problem.classList.remove('bad');
      commit(pricing);
    } catch (error) {
      problem.textContent = String(error);
      problem.classList.add('bad');
    }
  }
  card.body.append(
    ui.field(S.currencyField, currency),
    ...rates.map((input, i) => ui.field(rateLabels[i], input)),
    ui.msgline(simple || unset ? S.costFormNote : S.costFormOverridden),
  );
  const advanced = ui.h('details');
  advanced.open = !simple && !unset;
  advanced.append(ui.h('summary', null, S.editFull), raw, ui.msgline(S.fullNote), problem);
  const preview = ui.h('details');
  preview.append(
    ui.h('summary', null, S.viewSnapshot),
    ui.h('pre', 'mono', JSON.stringify(quotes, null, 2)),
  );
  card.body.append(advanced, preview);
  return { el: card.el };
}
