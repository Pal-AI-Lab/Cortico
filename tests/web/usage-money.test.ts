// @vitest-environment jsdom
import { expect, it } from 'vitest';
const { createWebUi } = (await import('../../src/web/client/ui/index.ts')) as Any;
const { webUiFormat, currencyName, formatMoney } = (await import('../../src/web/client/ui/format.ts')) as Any;
const { renderChart, fmtAxis, fmtMetric } = (await import('../../src/web/client/features/usage/chart.ts')) as Any;

type Any = any;
/** 查询结果按 Any 用:测试里节点必在,缺了就让断言或调用直接失败。 */
const $ = (sel: string, from: ParentNode = document): Any => from.querySelector(sel);
const $$ = (sel: string, from: ParentNode = document): Any[] => [...from.querySelectorAll(sel)];

it.each([
  [null, '$0.00'], [0, '$0.00'], [0.004, '$0.00'], [0.1267, '$0.13'], [12.346, '$12.35'],
])('formats amount %s with two decimals across readouts and chart labels', (amount: Any, expected: Any) => {
  expect(webUiFormat.money(amount)).toBe(expected);
  expect(fmtMetric(amount ?? 0, 'cost')).toBe(expected);
  expect(fmtAxis(amount ?? 0, 'cost')).toBe(expected.slice(1));
});

it('writes each currency with its symbol and uses three decimals for average costs', () => {
  expect(webUiFormat.money(0.1267, 'EUR')).toBe('€0.13');
  expect(formatMoney(0.1267, 'EUR', 3)).toBe('€0.127');
  expect(formatMoney(1.46, 'CNY')).toBe('¥1.46');
  // Another dollar keeps its country, so it is not read as US dollars; an unknown code stays a code.
  expect(formatMoney(2, 'HKD')).toBe('HK$2.00');
  expect(formatMoney(2, 'XQZ')).toBe('XQZ 2.00');
  // Named in a list, a currency shows its code too: ¥ alone is also yen.
  expect(currencyName('CNY')).toBe('¥ CNY');
  expect(currencyName('XQZ')).toBe('XQZ');
  expect(formatMoney(12, 'USD', 3)).toBe('$12.000');
  expect(formatMoney(0, 'USD', 3)).toBe('$0.000');
});


it('gives small costs distinct cent-based axis labels without changing the displayed amount', () => {
  const life = new AbortController();
  const ui = createWebUi({doc: document, overlayHost: document.body, signal: life.signal, memo: {get: (_: Any, f: Any) => f, set() {}}});
  const box = document.createElement('div');
  let detail = '';
  const tip = {clearHi() {}, setHi() {}, move() {}, hide() {}, show(html: Any) {detail = html;}};
  renderChart({doc: document, ui, box, legend: document.createElement('div'), tip, color: () => '#008855'},
    {currency: 'USD', series: [{bucket: '2026-10-25', cost: 0.003, calls: 1}]}, {metric: 'cost', dims: {}});
  const labels = $$('.vlabel', box).map((el: Any) => el.textContent);
  expect(new Set(labels).size).toBe(labels.length);
  expect(labels.every((label: Any) => /^\d+\.\d{2}$/.test(label))).toBe(true);
  $('.bhit', box).dispatchEvent(new MouseEvent('click', {bubbles: true}));
  expect(detail).toContain(webUiFormat.money(0.003));
  life.abort();
});
