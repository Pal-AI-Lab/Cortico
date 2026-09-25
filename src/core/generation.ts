import type { QuoteTime } from '../providers/pricebook.ts';
import type { ModelSpec } from './types.ts';
import type { Request, Response, StreamEvent, Usage } from '../protocol/open-responses/index.ts';
import type { ContextRecord, ItemOrigin } from '../protocol/open-responses/context.ts';

/** Missing meters remain null. Native details are retained for future reconciliation. */
export interface TokenMeters {
  input: number | null;
  output: number | null;
  total: number | null;
  cachedInput: number | null;
  uncachedInput: number | null;
  reasoning: number | null;
  details?: Record<string, { quantity: number | null; unit: string }>;
  native: Record<string, unknown> | null;
}
export type Meter = Exclude<keyof TokenMeters, 'native' | 'details'> | `detail:${string}`;
export interface PriceRule { meter: Meter; perMillion: number; unit?: string; }
export interface PriceSchedule { rules: PriceRule[]; inputBands?: Array<{ from: number; rules: PriceRule[] }>; }
export interface PriceTable extends PriceSchedule { serviceTiers?: Record<string, PriceSchedule>; }
/**
 * `from` and `to` are `HH:MM` on the clock of `timezone`, half-open; `to` at or before `from` spans midnight.
 * A span belongs to the local date it starts on. `weekdays` (ISO, 1 = Monday to 7 = Sunday) limits the dates
 * that open it; `exceptDates` (`YYYY-MM-DD`) removes single dates.
 */
export interface PriceWindow extends PriceTable {
  from: string;
  to: string;
  timezone: string;
  weekdays?: number[];
  exceptDates?: string[];
}
export interface PriceSnapshot extends PriceTable {
  id: string;
  currency: string;
  basis: 'marginal' | 'equivalent';
  /** The first window holding `capturedAt` replaces the table above it; outside every window that table applies. */
  timeWindows?: PriceWindow[];
  source: string;
  capturedAt: string;
}
export interface Charge {
  quote: PriceSnapshot;
  amount: number | null;
  knownAmount: number;
  missing: Array<Meter | 'serviceTier' | 'timeWindow'>;
  lines: Array<{ meter: Meter; unit: string; quantity: number | null; perMillion: number; amount: number | null }>;
}
export interface ProviderAttempt {
  id: string;
  generationId: string;
  ordinal: number;
  origin: ItemOrigin;
  startedAt: string;
  elapsedMs: number;
  requestId: string | null;
  responseId: string | null;
  outcome: 'completed' | 'incomplete' | 'failed' | 'aborted' | 'discarded';
  status: number | null;
  serviceTier: string | null;
  requestedServiceTier?: string | null;
  purpose?: 'generation' | 'diagnostic';
  meters: TokenMeters;
  charges: Charge[];
}
export interface GenerateOptions {
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  role?: string;
  sessionId?: string;
  /** Local context retains output reasoning and media references alongside the request Items. */
  context?: readonly ContextRecord[];
  nativeSpec?: ModelSpec;
  origin?: ItemOrigin;
  quote?: (at: QuoteTime) => readonly PriceSnapshot[];
  /** Diagnostic requests use a single attempt and cannot recursively diagnose. */
  diagnostic?: boolean;
}
export interface Generation {
  response: Response;
  origin: ItemOrigin;
  attempts: ProviderAttempt[];
}
export interface ResponseClient {
  /** Releases an explicitly bound provider lease. */
  release?(): void;
  respond(request: Request, options?: GenerateOptions): Promise<Generation>;
  /** A fork captures its provider binding once, before its first request. */
  bind?(): ResponseClient;
}
export class GenerationError extends Error {
  constructor(message: string, readonly attempts: ProviderAttempt[], readonly partial: Response | null,
    readonly origin: ItemOrigin, readonly status = 0, readonly body = '', options?: ErrorOptions) {
    super(message, options);
    this.name = 'GenerationError';
  }
}
export function unknownMeters(): TokenMeters {
  return { input: null, output: null, total: null, cachedInput: null, uncachedInput: null, reasoning: null, native: null };
}
export function standardUsage(meters: TokenMeters): Usage | null {
  const { input, output, total, cachedInput, reasoning } = meters;
  if (input === null || output === null || total === null || cachedInput === null || reasoning === null) return null;
  return { input_tokens: input, output_tokens: output, total_tokens: total,
    input_tokens_details: { cached_tokens: cachedInput }, output_tokens_details: { reasoning_tokens: reasoning } };
}
/** Minutes since midnight for an `HH:MM` bound, 24:00 included; null when the text is not one. */
function clockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[2]) > 59 || minutes > 24 * 60 ? null : minutes;
}
/** Whether the text is a real calendar date written `YYYY-MM-DD`. */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
/** Whether the instant falls in the window on the window's own clock and date; null when a field is unreadable. */
function holdsTime(window: PriceWindow, at: string): boolean | null {
  const instant = new Date(at);
  const [from, to] = [clockMinutes(window.from), clockMinutes(window.to)];
  if (from === null || to === null || Number.isNaN(instant.getTime())) return null;
  if (window.weekdays?.some(day => !Number.isInteger(day) || day < 1 || day > 7)) return null;
  if (window.exceptDates?.some(date => !isCalendarDate(date))) return null;
  let year: number, month: number, day: number, local: number;
  try {
    // Intl throws on a zone name it does not know.
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: window.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
    const read = (type: string): number => Number(parts.find(part => part.type === type)!.value);
    [year, month, day] = [read('year'), read('month'), read('day')];
    local = read('hour') * 60 + read('minute');
  } catch { return null; }
  const spansMidnight = to <= from;
  if (spansMidnight ? local < from && local >= to : local < from || local >= to) return false;
  // After midnight the span still belongs to the previous date, the one it started on.
  const start = new Date(Date.UTC(year, month - 1, spansMidnight && local < to ? day - 1 : day));
  if (window.weekdays && !window.weekdays.includes(start.getUTCDay() || 7)) return false;
  return !window.exceptDates?.includes(start.toISOString().slice(0, 10));
}
export function priceUsage(meters: TokenMeters, quotes: readonly PriceSnapshot[], serviceTier: string | null = null): Charge[] {
  return quotes.map(quote => {
    const missing: Charge['missing'] = [];
    let table: PriceTable = quote;
    for (const window of quote.timeWindows ?? []) {
      const holds = holdsTime(window, quote.capturedAt);
      // An unreadable window may be the one holding the request; a later table cannot stand in for it.
      if (holds === null) { missing.push('timeWindow'); break; }
      if (holds) { table = window; break; }
    }
    let schedule: PriceSchedule = table;
    if (table.serviceTiers) {
      if (serviceTier === null || !table.serviceTiers[serviceTier]) missing.push('serviceTier');
      else schedule = table.serviceTiers[serviceTier];
    }
    let rules = schedule.rules;
    if (schedule.inputBands?.length) {
      if (meters.input === null) missing.push('input');
      else for (const band of schedule.inputBands) if (meters.input >= band.from) rules = band.rules;
    }
    const unresolvedSchedule = missing.length > 0;
    const lines = rules.map(rule => {
      const detail = rule.meter.startsWith('detail:') ? meters.details?.[rule.meter.slice(7)] : undefined;
      const quantity = rule.meter.startsWith('detail:') ? detail?.quantity ?? null : meters[rule.meter as Exclude<Meter, `detail:${string}`>];
      const unit = rule.unit ?? 'token';
      const known = !unresolvedSchedule && (!detail || detail.unit === unit);
      const amount = known && rule.perMillion === 0 ? 0 : known && quantity !== null ? quantity * rule.perMillion / 1e6 : null;
      if (amount === null && !unresolvedSchedule) missing.push(rule.meter);
      return { meter: rule.meter, unit, quantity, perMillion: rule.perMillion, amount };
    });
    const knownAmount = lines.reduce((sum, line) => sum + (line.amount ?? 0), 0);
    return { quote: structuredClone(quote), amount: missing.length ? null : knownAmount, knownAmount, missing: [...new Set(missing)], lines };
  });
}
