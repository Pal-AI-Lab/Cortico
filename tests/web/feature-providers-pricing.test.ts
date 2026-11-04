import { afterEach, describe, expect, it } from 'vitest';

const UI = '../../src/web/client/ui/index.ts';
const PRICING = '../../src/web/client/features/providers/pricing.ts';
const JSDOM_MODULE = 'jsdom';
// Browser code is independently checked by tsconfig.web.json.
type Any = any;
const { createWebUi } = (await import(UI)) as Any;
const { pricingEditor } = (await import(PRICING)) as Any;
const { JSDOM } = (await import(JSDOM_MODULE)) as Any;
const doc = new JSDOM('<!doctype html><body></body>').window.document as Any;

let cleanup: () => void = () => {};
afterEach(() => cleanup());

/** Mounts the editor on `saved` pricing and records every pricing list it commits. */
function mount(saved: unknown[], quotes: unknown[] = []) {
  const controller = new doc.defaultView.AbortController();
  const ui = createWebUi({
    memo: { get: (_key: string, fallback: unknown) => fallback, set: () => {} },
    overlayHost: doc.body, signal: controller.signal, doc,
  });
  const commits: Any[] = [];
  const editor = pricingEditor(ui, saved, quotes, (pricing: unknown[]) => commits.push(pricing));
  const root = doc.createElement('div');
  root.append(editor.el);
  doc.body.append(root);
  cleanup = () => { controller.abort(); root.remove(); };
  return { root: root as Any, commits };
}
const byLabel = (root: Any, label: string) => root.querySelector(`[aria-label="${label}"]`);
function change(element: Any, value: string) {
  element.value = value;
  element.dispatchEvent(new doc.defaultView.Event('change'));
}
const RATES = ['缓存命中 / 百万 token', '未缓存输入 / 百万 token', '输出 / 百万 token'];

describe('成本三格表', () => {
  it('没有报价时三格与币种留空并说明未设;填了单价和币种才落成一条 * 边际规则', () => {
    const view = mount([]);
    expect(byLabel(view.root, '币种').value).toBe('');
    expect(RATES.map((label) => byLabel(view.root, label).value)).toEqual(['', '', '']);
    expect(view.root.textContent).toContain('未设自定义报价');
    expect(view.root.textContent).not.toContain('报价未知');
    expect(view.root.querySelector('.pricing-note').hidden).toBe(false);
    expect(view.root.querySelector('details').open).toBe(false);
    change(byLabel(view.root, '输出 / 百万 token'), '15');
    expect(view.commits.filter((pricing) => pricing.length)).toEqual([]);
    expect(view.root.textContent).toContain('填写币种后才保存这份报价');
    change(byLabel(view.root, '币种'), 'USD');
    expect(view.root.textContent).not.toContain('填写币种后才保存这份报价');
    expect(view.root.querySelector('.pricing-note').hidden).toBe(true);
    expect(view.commits.at(-1)).toEqual([
      {
        models: ['*'],
        currency: 'USD',
        basis: 'marginal',
        source: 'webui',
        rules: [
          { meter: 'cachedInput', perMillion: 0 },
          { meter: 'uncachedInput', perMillion: 0 },
          { meter: 'output', perMillion: 15 },
        ],
      },
    ]);
  });
  it('模块报价只有一种币种时拿它作默认;扩展计量显示时去掉 detail: 前缀', () => {
    const view = mount([], [{
      model: 'alpha-large',
      quotes: [{
        currency: 'CNY', basis: 'marginal', source: 'module',
        rules: [{ meter: 'output', perMillion: 8 }, { meter: 'detail:cacheCreationInput', perMillion: 1 }],
      }],
    }]);
    expect(byLabel(view.root, '币种').value).toBe('CNY');
    expect(view.root.textContent).toContain('cacheCreationInput 1/百万');
    expect(view.root.textContent).not.toContain('detail:cacheCreationInput 1/百万');
  });
  it('三格全清回到未设', () => {
    const view = mount([{
      models: ['*'], currency: 'USD', basis: 'marginal', source: 'webui',
      rules: [
        { meter: 'cachedInput', perMillion: 1 },
        { meter: 'uncachedInput', perMillion: 2 },
        { meter: 'output', perMillion: 3 },
      ],
    }]);
    for (const label of RATES) change(byLabel(view.root, label), '');
    expect(view.commits.at(-1)).toEqual([]);
    expect(view.root.querySelector('.pricing-note').hidden).toBe(false);
  });
  it('已存的正是那一条 * 规则时回填三格;改一格连同其余两格一起送回', () => {
    const view = mount([{
      models: ['*'], currency: 'CNY', basis: 'marginal', source: 'webui',
      rules: [
        { meter: 'uncachedInput', perMillion: 2 },
        { meter: 'cachedInput', perMillion: 0.5 },
        { meter: 'output', perMillion: 8 },
      ],
    }]);
    expect(byLabel(view.root, '币种').value).toBe('CNY');
    expect(RATES.map((label) => byLabel(view.root, label).value)).toEqual(['0.5', '2', '8']);
    change(byLabel(view.root, '输出 / 百万 token'), '9');
    expect(view.commits.at(-1)[0].rules).toEqual([
      { meter: 'cachedInput', perMillion: 0.5 },
      { meter: 'uncachedInput', perMillion: 2 },
      { meter: 'output', perMillion: 9 },
    ]);
  });
  it('三格表达不了的报价:三格留空、完整规则展开并持有原值;改 JSON 以 JSON 为准,改三格则覆盖', () => {
    const pricing = [
      { models: ['alpha-large'], currency: 'USD', basis: 'marginal', source: 'sheet', rules: [{ meter: 'output', perMillion: 3 }] },
      { models: ['alpha-mini'], currency: 'USD', basis: 'marginal', source: 'sheet', rules: [] },
    ];
    const view = mount(pricing, [{ model: 'alpha-large', quotes: [pricing[0]] }]);
    expect(byLabel(view.root, '输出 / 百万 token').value).toBe('');
    expect(view.root.textContent).toContain('以下方完整规则为准');
    const advanced = view.root.querySelector('details');
    expect(advanced.open).toBe(true);
    const raw = advanced.querySelector('textarea');
    expect(JSON.parse(raw.value)).toEqual(pricing);
    change(raw, JSON.stringify([pricing[1]]));
    expect(view.commits.at(-1)).toEqual([pricing[1]]);
    change(byLabel(view.root, '缓存命中 / 百万 token'), '1');
    expect(view.commits.at(-1)).toEqual([
      expect.objectContaining({
        models: ['*'],
        rules: [
          { meter: 'cachedInput', perMillion: 1 },
          { meter: 'uncachedInput', perMillion: 0 },
          { meter: 'output', perMillion: 0 },
        ],
      }),
    ]);
  });
  it('完整规则那格写坏时不提交,解析错误留在卡上', () => {
    const view = mount([]);
    change(view.root.querySelector('details textarea'), '{ 不是 JSON');
    expect(view.commits).toEqual([]);
    expect(view.root.querySelector('details .msgline.bad').textContent).toContain('SyntaxError');
  });
});
