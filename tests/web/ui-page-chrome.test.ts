// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { pageBadges } = (await import('../../src/web/client/ui/page-badges.ts')) as Any;
const { placeOverflowPopover } = (await import('../../src/web/client/ui/overflow-popover.ts')) as Any;
const { watchPageScrollInset } = (await import('../../src/web/client/ui/page.ts')) as Any;
const { pageTabs } = (await import('../../src/web/client/ui/page-tabs.ts')) as Any;

type Any = any;
/** 查询结果按 Any 用:测试里节点必在,缺了就让断言或调用直接失败。 */
const $ = (sel: string, from: ParentNode = document): Any => from.querySelector(sel);
const $$ = (sel: string, from: ParentNode = document): Any[] => [...from.querySelectorAll(sel)];
let life: Any, resize: Any;
beforeEach(() => {
  life = new AbortController();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: Any) { resize = callback; }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { life.abort(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('fits badges on one line and preserves every hidden badge through narrowing, expansion and cleanup', () => {
  let width = 250;
  const badges = ['ready', 'online', 'watching', 'idle'].map((text: Any) => {
    const el = document.createElement('span'); el.className = 'pill'; el.textContent = text; return el;
  });
  vi.spyOn(HTMLElement.prototype as Any, 'getBoundingClientRect').mockImplementation(function (this: Any) {
    const w = this.classList.contains('page-badge-more') ? 30 : 100;
    return { x: 0, y: 0, left: 0, right: w, top: 0, bottom: 22, width: w, height: 22 };
  });
  const row = pageBadges(document, document.body, life.signal, badges);
  row.style.columnGap = '6px';
  Object.defineProperty(row, 'clientWidth', { get: () => width });
  document.body.append(row);
  resize();
  const more = $('button', row);
  const pop = $('.page-badge-pop');
  expect([...row.children].map((el: Any) => el.textContent)).toEqual(['ready', 'online', '+2']);
  more.focus();
  expect(pop.hidden).toBe(false);
  resize();
  expect(document.activeElement).toBe(more);
  expect(pop.hidden).toBe(false);
  document.dispatchEvent(new Event('scroll'));
  expect(pop.hidden).toBe(false);
  expect([...pop.children]).toEqual(badges.slice(2));
  more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(pop.hidden).toBe(true);
  resize();
  expect(document.activeElement).toBe(more);
  expect(pop.hidden).toBe(true);
  more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(pop);
  expect(pop.hidden).toBe(false);
  pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(document.activeElement).toBe(more);
  expect(pop.hidden).toBe(true);
  width = 80; resize();
  expect(row.textContent).toBe('+4');
  more.click();
  expect([...pop.children]).toEqual(badges);
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  expect(pop.hidden).toBe(true);
  width = 500; resize();
  expect([...row.children]).toEqual(badges);
  expect(pop.children.length).toBe(0);
  life.abort();
  expect(pop.isConnected).toBe(false);
});

it('moves the tab indicator between wrapped rows only after navigation is accepted', () => {
  const selected: Any[] = [];
  const tabs = pageTabs(document, life.signal, [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }], { value: 'a', onSelect: (v: Any) => selected.push(v) });
  document.body.append(tabs.el);
  const labels = $$('.pagetab > span', tabs.el);
  let secondRow = 60;
  labels.forEach((label: Any, index: Any) => {
    Object.defineProperties(label, { offsetLeft: { get: () => 10 + index * 80 }, offsetWidth: { get: () => 60 }, offsetTop: { get: () => index ? secondRow : 10 }, offsetHeight: { get: () => 22 } });
  });
  resize();
  const firstY = parseFloat(tabs.el.style.getPropertyValue('--tab-y'));
  $$('button', tabs.el)[1].click();
  expect(selected).toEqual(['b']);
  expect(parseFloat(tabs.el.style.getPropertyValue('--tab-y'))).toBe(firstY);
  tabs.setValue('b');
  expect(tabs.el.dataset.line).toBe('appear');
  resize();
  expect(tabs.el.dataset.line).toBe('appear');
  tabs.setValue('a');
  expect(tabs.el.dataset.line).toBe('appear');
  tabs.setValue('b');
  expect(tabs.el.dataset.line).toBe('appear');
  const wrappedY = parseFloat(tabs.el.style.getPropertyValue('--tab-y'));
  expect(wrappedY - firstY).toBe(labels[1].offsetTop - labels[0].offsetTop);
  secondRow = 10; resize();
  expect(parseFloat(tabs.el.style.getPropertyValue('--tab-y'))).toBe(firstY);
  tabs.setValue('a');
  expect(tabs.el.dataset.line).toBe('ready');
});


it.each([
  { bounds: [200, 900], trigger: [850, 890], expected: [530, 360] },
  { bounds: [200, 900], trigger: [210, 250], expected: [200, 360] },
  { bounds: [200, 450], trigger: [400, 440], expected: [200, 250] },
  { bounds: [200, 900], trigger: [890, 930], expected: [540, 360] },
])('keeps overflow within its content edges: %j', ({ bounds, trigger, expected }) => {
  const content = document.createElement('div');
  const anchor = document.createElement('button');
  const pop = document.createElement('div');
  (content as Any).getBoundingClientRect = () => ({ left: bounds[0], right: bounds[1] });
  (anchor as Any).getBoundingClientRect = () => ({ left: trigger[0], right: trigger[1], top: 80, bottom: 100 });
  Object.defineProperty(pop, 'offsetWidth', { get: () => parseFloat(pop.style.maxWidth) });
  (pop as Any).getBoundingClientRect = () => ({ width: parseFloat(pop.style.maxWidth) });
  placeOverflowPopover(pop, anchor, content);
  expect([parseFloat(pop.style.left), parseFloat(pop.style.maxWidth)]).toEqual(expected);
  expect(parseFloat(pop.style.left) + pop.offsetWidth).toBeLessThanOrEqual(bounds[1]);
  expect(parseFloat(pop.style.left)).toBeGreaterThanOrEqual(bounds[0]);
});


it.each([{ top: 100, bottom: 122, above: false }, { top: 680, bottom: 702, above: true }])('fits tall overflow beside its trigger: %j', ({top, bottom, above}) => {
  const content = document.createElement('div'), anchor = document.createElement('button'), pop = document.createElement('div');
  (content as Any).getBoundingClientRect = () => ({left: 200, right: 900});
  (anchor as Any).getBoundingClientRect = () => ({left: 850, right: 880, top, bottom});
  Object.defineProperty(pop, 'scrollHeight', {get: () => 1200});
  (pop as Any).getBoundingClientRect = () => ({width: 360, height: parseFloat(pop.style.maxHeight)});
  placeOverflowPopover(pop, anchor, content);
  const y = parseFloat(pop.style.top), height = parseFloat(pop.style.maxHeight);
  expect(y).toBeGreaterThanOrEqual(8);
  expect(y + height).toBeLessThanOrEqual(innerHeight - 8);
  if (above) expect(y + height).toBeLessThan(top);
  else expect(y).toBeGreaterThan(bottom);
});


it('accounts for popup width after the height limit adds a scrollbar', () => {
  const content = document.createElement('div'), anchor = document.createElement('button'), pop = document.createElement('div');
  (content as Any).getBoundingClientRect = () => ({left: 200, right: 900});
  (anchor as Any).getBoundingClientRect = () => ({left: 860, right: 900, top: 80, bottom: 100});
  Object.defineProperty(pop, 'scrollHeight', {get: () => 1200});
  (pop as Any).getBoundingClientRect = () => ({width: pop.style.maxHeight ? 220 : 200, height: 200});
  placeOverflowPopover(pop, anchor, content);
  expect(parseFloat(pop.style.left) + pop.getBoundingClientRect().width).toBe(900);
});

it('updates the scroll inset when sticky headings resize or are replaced, and releases it on disposal', async () => {
  const slot = document.createElement('div');
  document.body.append(slot);
  watchPageScrollInset(slot, life.signal);
  const heading = (height: Any, sticky: Any = true) => {
    const el = document.createElement('header');
    el.className = 'featureintro';
    el.style.position = sticky ? 'sticky' : 'static';
    el.style.top = '0px';
    vi.spyOn(el as Any, 'getBoundingClientRect').mockImplementation(() => ({ height: Number(el.dataset.height), bottom: Number(el.dataset.height) + Number(el.dataset.top ?? 0) }));
    el.dataset.height = String(height);
    return el;
  };
  const head = heading(80);
  slot.append(head);
  await Promise.resolve();
  expect(slot.style.getPropertyValue('--page-scroll-inset')).toBe('80px');
  head.dataset.height = '110'; resize();
  expect(slot.style.getPropertyValue('--page-scroll-inset')).toBe('110px');
  slot.replaceChildren(heading(90, false));
  await Promise.resolve();
  expect(slot.style.getPropertyValue('--page-scroll-inset')).toBe('0px');
  slot.replaceChildren(heading(100));
  await Promise.resolve();
  expect(slot.style.getPropertyValue('--page-scroll-inset')).toBe('100px');
  const toolbar = heading(50);
  toolbar.className = 'prompt-toolbar';
  toolbar.dataset.top = '100';
  slot.replaceChildren(heading(80, false), toolbar);
  await Promise.resolve();
  expect(slot.style.getPropertyValue('--page-scroll-inset')).toBe('150px');
  toolbar.dataset.top = '0';
  slot.dispatchEvent(new Event('scroll'));
  expect(slot.style.getPropertyValue('--page-scroll-inset')).toBe('50px');
  slot.replaceChildren();
  await Promise.resolve();
  expect(slot.style.getPropertyValue('--page-scroll-inset')).toBe('0px');
  life.abort();
  slot.append(heading(120));
  await Promise.resolve();
  expect(slot.style.getPropertyValue('--page-scroll-inset')).toBe('');
});
