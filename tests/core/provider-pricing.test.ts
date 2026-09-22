import { describe, it, expect } from 'vitest';
import { priceUsage, unknownMeters, type ProviderAttempt, type TokenMeters } from '../../src/core/generation.ts';
import { quotePrices, snapshotPrice, validatePrices, type PriceDefinition } from '../../src/providers/pricebook.ts';
import { aggregateUsage } from '../../src/core/cost.ts';
import type { PriceRule, PriceSnapshot, PriceWindow } from '../../src/core/generation.ts';
import type { UsageRecord } from '../../src/core/types.ts';

const at = { startedAt: '2026-09-07T00:59:59Z', requestedServiceTier: 'priority' };
const meters: TokenMeters = { input: 200000, output: 1000, total: 201000, cachedInput: 150000, uncachedInput: 50000, reasoning: 500, native: {} };
const entry = { kind: 'openai-responses-compat', baseUrl: 'https://example.test' };
const MODEL = 'sub-4.6';

/** 测试价目同时包含边际/等价计费基础、输入长度分档和服务档倍率。 */
function subscriptionPrices(): PriceDefinition[] {
  const rules = (multiplier: number): PriceRule[] => [
    { meter: 'cachedInput', perMillion: 0.5 * multiplier }, { meter: 'uncachedInput', perMillion: 2 * multiplier }, { meter: 'output', perMillion: 6 * multiplier },
  ];
  const tier = (multiplier: number) => ({ rules: rules(multiplier), inputBands: [{ from: 200000, rules: rules(multiplier * 2) }] });
  return [
    { models: ['*'], currency: 'USD', basis: 'marginal', rules: [], source: '订阅额度池;固定月费不计入' },
    { models: [MODEL], currency: 'USD', basis: 'equivalent', ...tier(1), serviceTiers: { default: tier(1), priority: tier(2) }, source: '样本价目表(API 等价口径)' },
  ];
}
const quote = () => quotePrices(entry, { model: MODEL }, at, subscriptionPrices());

/** 测试价目按时段分档:窗口内半价并再按服务档细分,窗口外用基础档。 */
const windowRules = (multiplier: number): PriceRule[] => [{ meter: 'uncachedInput', perMillion: 2 * multiplier }, { meter: 'output', perMillion: 6 * multiplier }];
const OFF_PEAK: PriceWindow = { from: '00:30', to: '08:30', timezone: 'Asia/Shanghai', rules: windowRules(.5), serviceTiers: { default: { rules: windowRules(.5) }, priority: { rules: windowRules(1) } } };
const PEAK_RATE = (50000 * 2 + 1000 * 6) / 1e6;
const windowedQuote = (capturedAt: string, window: PriceWindow = OFF_PEAK): PriceSnapshot =>
  ({ id: 'quote', currency: 'USD', basis: 'equivalent', source: '样本价目表(错峰窗口)', capturedAt, rules: windowRules(1), timeWindows: [window] });

function row(id: string, outcome: ProviderAttempt['outcome'], currency='USD'): UsageRecord {
  const quotes = quote().map(q => ({ ...q, currency }));
  const attempt: ProviderAttempt = { id, generationId: 'generation', ordinal: 0, origin: { instance: id, module: 'openai-responses-compat', model: MODEL, compatibilityDomain: 'domain' },
    startedAt: at.startedAt, elapsedMs: 100, requestId: null, responseId: 'response', outcome, status: 200, serviceTier: 'default', meters, charges: priceUsage(meters, quotes, 'default') };
  return { ts: at.startedAt, sessionId:'main', role:'main', label:'Main', model:MODEL, promptTokens:200000,completionTokens:1000,cacheHitTokens:150000,cacheMissTokens:50000,reasoningTokens:500,version:2,attempt };
}

describe('Provider price snapshots', () => {
  it('uses total input for the long-context band and the actual priority tier', () => {
    const standard = priceUsage(meters, quote(), 'default')[1];
    const priority = priceUsage(meters, quote(), 'priority')[1];
    expect(standard.amount).toBeCloseTo((150000*.5+50000*2+1000*6)*2/1e6);
    expect(priority.amount).toBeCloseTo(standard.amount! * 2);
    expect(priceUsage({ ...meters,input:199999 },quote(),'default')[1].amount).toBeCloseTo(standard.amount! / 2);
  });
  it('keeps unobserved service tier and cache distribution unknown', () => {
    expect(priceUsage(meters, quote())[1]).toMatchObject({ amount:null,knownAmount:0,missing:['serviceTier'] });
    const partial = priceUsage({ ...meters,cachedInput:null,uncachedInput:null },quote(),'default')[1];
    expect(partial).toMatchObject({ amount:null, missing:['cachedInput','uncachedInput'] });
    expect(partial.knownAmount).toBeCloseTo(.012);
    expect(priceUsage({ ...meters,input:null },quote(),'default')[1]).toMatchObject({ amount:null, knownAmount:0, missing:['input'] });
  });
  it('distinguishes subscription marginal zero, API equivalent and an unquoted model', () => {
    expect(priceUsage(unknownMeters(),quote())[0]).toMatchObject({ amount:0,knownAmount:0,missing:[] });
    expect(quotePrices({kind:'openai-responses-compat',baseUrl:'http://localhost'}, {model:'custom'},at,[])).toEqual([]);
    expect(quotePrices(entry,{model:'unknown'},at,subscriptionPrices())).toHaveLength(1);
  });
  it('an instance override is frozen at quote time', () => {
    const custom = validatePrices([{ models:[MODEL], currency:'EUR',basis:'marginal',rules:[{meter:'output',perMillion:2}],source:'deployment agreement' }]);
    const frozen = quotePrices({...entry,pricing:custom},{model:MODEL},at,subscriptionPrices());
    custom[0].rules[0].perMillion=20;
    expect(frozen[0]).toMatchObject({currency:'EUR',rules:[{meter:'output',perMillion:2}]});
  });
  it('preserves arbitrary metering units and rejects incompatible quantities', () => {
    const snapshot=snapshotPrice({models:['*'],currency:'USD',basis:'marginal',rules:[{meter:'detail:audio',unit:'second',perMillion:1000}],source:'audio contract'},at);
    expect(priceUsage({...unknownMeters(),details:{audio:{quantity:30,unit:'second'}}},[snapshot])[0].amount).toBe(.03);
    expect(priceUsage({...unknownMeters(),details:{audio:{quantity:30,unit:'token'}}},[snapshot])[0].amount).toBeNull();
    expect(()=>validatePrices([{models:['*'],currency:'USD',basis:'marginal',rules:[{meter:'output',perMillion:-1}],source:'x'}])).toThrow();
  });
  it('bills by the window holding the request start, read on the window clock', () => {
    const rate = (capturedAt: string) => priceUsage(meters, [windowedQuote(capturedAt)], 'default')[0].amount;
    expect(rate('2026-09-20T04:00:00Z')).toBeCloseTo(PEAK_RATE);
    expect(rate('2026-09-19T16:30:00Z')).toBeCloseTo(PEAK_RATE / 2);
    expect(rate('2026-09-20T00:30:00Z')).toBeCloseTo(PEAK_RATE);
    const midnight: PriceWindow = { from:'22:00', to:'02:00', timezone:'UTC', rules: windowRules(.5) };
    const across = (capturedAt: string) => priceUsage(meters, [windowedQuote(capturedAt, midnight)])[0].amount;
    expect(across('2026-09-20T23:00:00Z')).toBeCloseTo(PEAK_RATE / 2);
    expect(across('2026-09-20T01:00:00Z')).toBeCloseTo(PEAK_RATE / 2);
    expect(across('2026-09-20T12:00:00Z')).toBeCloseTo(PEAK_RATE);
  });
  it('limits a window to weekdays and drops excepted local dates', () => {
    const workdays: PriceWindow = { from:'09:00', to:'12:00', timezone:'Asia/Shanghai', weekdays:[1,2,3,4,5], exceptDates:['2026-10-01'], rules: windowRules(.5) };
    const rate = (capturedAt: string) => priceUsage(meters, [windowedQuote(capturedAt, workdays)])[0].amount;
    expect(rate('2026-09-23T02:00:00Z')).toBeCloseTo(PEAK_RATE / 2);
    expect(rate('2026-09-26T02:00:00Z')).toBeCloseTo(PEAK_RATE);
    expect(rate('2026-10-01T02:00:00Z')).toBeCloseTo(PEAK_RATE);
    expect(rate('2026-09-23T05:00:00Z')).toBeCloseTo(PEAK_RATE);
  });
  it('dates a span across midnight by the day it starts on', () => {
    const fridayNight: PriceWindow = { from:'22:00', to:'02:00', timezone:'UTC', weekdays:[5], exceptDates:['2026-10-02'], rules: windowRules(.5) };
    const rate = (capturedAt: string) => priceUsage(meters, [windowedQuote(capturedAt, fridayNight)])[0].amount;
    expect(rate('2026-09-25T23:00:00Z')).toBeCloseTo(PEAK_RATE / 2);
    expect(rate('2026-09-26T01:00:00Z')).toBeCloseTo(PEAK_RATE / 2);
    expect(rate('2026-09-25T01:00:00Z')).toBeCloseTo(PEAK_RATE);
    expect(rate('2026-09-26T23:00:00Z')).toBeCloseTo(PEAK_RATE);
    expect(rate('2026-10-03T01:00:00Z')).toBeCloseTo(PEAK_RATE);
  });
  it('leaves a window with an unreadable weekday or date unpriced', () => {
    const unpriced = (window: PriceWindow) => priceUsage(meters, [windowedQuote('2026-09-23T02:00:00Z', window)])[0];
    const base: PriceWindow = { from:'09:00', to:'12:00', timezone:'Asia/Shanghai', rules: windowRules(.5) };
    for (const window of [{ ...base, weekdays:[0] }, { ...base, weekdays:[1.5] }, { ...base, exceptDates:['2026-02-30'] }, { ...base, exceptDates:['2026/10/01'] }]) {
      expect(unpriced(window)).toMatchObject({ amount:null, knownAmount:0, missing:['timeWindow'] });
    }
  });
  it('resolves the service tier within the matched window and leaves an unreadable window unpriced', () => {
    const offPeak = '2026-09-19T16:30:00Z';
    expect(priceUsage(meters, [windowedQuote(offPeak)], 'priority')[0].amount).toBeCloseTo(PEAK_RATE);
    expect(priceUsage(meters, [windowedQuote(offPeak)])[0]).toMatchObject({ amount:null, knownAmount:0, missing:['serviceTier'] });
    expect(priceUsage(meters, [windowedQuote(offPeak, { ...OFF_PEAK, timezone:'Nowhere/Nozone' })], 'default')[0]).toMatchObject({ amount:null, knownAmount:0, missing:['timeWindow'] });
  });
  it('snapshots module-declared windows and keeps them out of endpoint pricing', () => {
    const definition: PriceDefinition = { models:[MODEL], currency:'USD', basis:'equivalent', rules: windowRules(1), source:'样本价目表(错峰窗口)', timeWindows:[OFF_PEAK] };
    const quoted = quotePrices(entry, { model: MODEL }, { startedAt:'2026-09-19T16:30:00Z', requestedServiceTier:null }, [definition]);
    expect(priceUsage(meters, quoted, 'default')[0].amount).toBeCloseTo(PEAK_RATE / 2);
    expect(()=>validatePrices([definition])).toThrow();
  });
});

describe('immutable billing aggregates', () => {
  it('counts every consumed attempt and keeps successful efficiency separate', () => {
    const records = ['completed','failed','aborted','discarded'].map((outcome,i)=>row(String(i),outcome as ProviderAttempt['outcome']));
    const result=aggregateUsage(records,{bucket:'day',basis:'equivalent'});
    expect(result.totals.calls).toBe(4);
    expect(result.successful.calls).toBe(1);
    expect(result.failed.calls).toBe(3);
    expect(result.totals.cost).toBeCloseTo(result.successful.cost*4);
    expect(result.series[0].calls).toBe(4);
    expect(result.byInstance).toHaveLength(4);
  });
  it('separates currencies and bases and never reprices history using current defaults', () => {
    const records=[row('usd','completed'),row('eur','completed','EUR')];
    const unquoted={...records[0],attempt:undefined};
    const result=aggregateUsage([...records,unquoted],{bucket:'day',currency:'USD',basis:'equivalent'});
    expect(result.balances).toHaveLength(4);
    expect(result.totals.cost).toBeCloseTo(records[0].attempt!.charges[1].amount!);
    expect(result.totals.unpricedCalls).toBe(2);
    expect(result.byInstance.find(r=>r.key==='unknown')?.unpricedCalls).toBe(1);
    expect(aggregateUsage([unquoted],{bucket:'day'}).totals).toMatchObject({ cost:0,unpricedCalls:1 });
  });
});
