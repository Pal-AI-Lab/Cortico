// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { createWebUi } = (await import('../../src/web/client/ui/index.ts')) as Any;
const { createSessionBand } = (await import('../../src/web/client/features/live/sessions.ts')) as Any;

type Any = any;
/** 查询结果按 Any 用:测试里节点必在,缺了就让断言或调用直接失败。 */
const $ = (sel: string, from: ParentNode = document): Any => from.querySelector(sel);
const $$ = (sel: string, from: ParentNode = document): Any[] => [...from.querySelectorAll(sel)];

// jsdom has no layout: every card is 100px wide and the row is `rowWidth` wide.
let rowWidth = 1000;
let lives: Any[] = [];
const saved: Any = {};
beforeEach(() => {
  // Browsers cannot focus a card inside a closed popover; jsdom does not enforce hidden layout.
  const focus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype as Any, 'focus').mockImplementation(function (this: Any, options: Any) {
    if (!this.closest('[hidden]')) focus.call(this, options);
  });
  saved.offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  saved.client = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 100; } });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.classList?.contains('sesscards') ? rowWidth : 0; },
  });
});
afterEach(() => {
  lives.forEach((life: Any) => life.abort());
  lives = [];
  vi.restoreAllMocks();
  if (saved.offset) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', saved.offset);
  else delete (HTMLElement.prototype as Any).offsetWidth;
  if (saved.client) Object.defineProperty(Element.prototype, 'clientWidth', saved.client);
  else delete (Element.prototype as Any).clientWidth;
  document.body.replaceChildren();
});

const session = (id: Any, opts: Any = {}) => ({
  id, label: id, role: id.split('-')[0], calls: 0, promptTokens: 120, completionTokens: 0, cacheHitTokens: 0,
  cacheHitRate: null, messageCount: 0, startedAt: opts.started ?? '2026-10-23T10:00:00', endedAt: opts.ended ?? null,
});

function mount() {
  const life = new AbortController();
  lives.push(life);
  const ui = createWebUi({ doc: document, overlayHost: document.body, signal: life.signal, memo: { get: (_: Any, f: Any) => f, set() {} } });
  const picked: Any[] = [];
  const band = createSessionBand({ ui, signal: life.signal, onPick: (id: Any) => picked.push(id) });
  document.body.appendChild(band.el);
  return { band, picked };
}

const shownIds = (band: Any) => $$(':scope > .sesscard b', band.el).map((b: Any) => b.textContent);

describe('console session chips', () => {
  it('keeps main first, running newest first, ended last with the latest close at the end, and drops World usage items', () => {
    rowWidth = 1000;
    const { band } = mount();
    band.render([
      session('fork-1', { started: '2026-10-23T10:01:00', ended: '2026-10-23T10:05:00' }),
      session('worlds.desktop-pet'),
      session('fork-2', { started: '2026-10-23T10:02:00' }),
      session('main'),
      session('fork-3', { started: '2026-10-23T10:03:00' }),
      session('fork-4', { started: '2026-10-23T10:00:30', ended: '2026-10-23T10:09:00' }),
    ], 'main');
    expect(shownIds(band)).toEqual(['main', 'fork-3', 'fork-2', 'fork-1', 'fork-4']);
  });

  it('leaves out the earliest-ended sessions that do not fit on the line', () => {
    rowWidth = 430; // four 100px cards with 6px gaps
    const { band } = mount();
    band.render([
      session('main'),
      session('fork-1', { ended: '2026-10-23T10:01:00' }),
      session('fork-2', { ended: '2026-10-23T10:02:00' }),
      session('fork-3', { ended: '2026-10-23T10:03:00' }),
      session('fork-4', { ended: '2026-10-23T10:04:00' }),
    ], 'main');
    expect(shownIds(band)).toEqual(['main', 'fork-2', 'fork-3', 'fork-4']);
    expect($('.sessmore', band.el)).toBeNull();
  });

  it('collects running sessions that do not fit behind a +N chip whose popover lists them', () => {
    rowWidth = 330; // three cards fit; with the +N chip, two
    const { band, picked } = mount();
    band.render([
      session('main'),
      session('fork-1', { started: '2026-10-23T10:01:00' }),
      session('fork-2', { started: '2026-10-23T10:02:00' }),
      session('fork-3', { started: '2026-10-23T10:03:00' }),
      session('fork-9', { ended: '2026-10-23T10:09:00' }),
    ], 'main');
    expect(shownIds(band)).toEqual(['main', 'fork-3']);
    const more = $('.sessmore-btn', band.el);
    expect(more.textContent).toBe('+2');
    const pop = $('.sesspop', band.el);
    expect($$('b', pop).map((b: Any) => b.textContent)).toEqual(['fork-2', 'fork-1']);
    expect(band.el.textContent).not.toContain('fork-9');
    $('.sessmore', band.el).dispatchEvent(new MouseEvent('mouseenter'));
    expect(pop.hidden).toBe(false);
    $('.sesscard', pop).click();
    expect(picked).toEqual(['fork-2']);
    expect(pop.hidden).toBe(true);
  });
});


it('keeps a focused overflow open on click and pointer exit, then closes on Escape from a card', async () => {
  rowWidth = 220;
  const { band } = mount();
  band.render([session('main'), session('fork-1'), session('fork-2')], 'main');
  const more = $('.sessmore-btn', band.el);
  const pop = $('.sesspop', band.el);
  more.focus(); more.click();
  expect(pop.hidden).toBe(false);
  const card = $('button', pop);
  card.focus();
  $('.sessmore', band.el).dispatchEvent(new MouseEvent('mouseleave'));
  await new Promise((resolve: Any) => setTimeout(resolve, 200));
  expect(pop.hidden).toBe(false);
  card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(pop.hidden).toBe(true);
  expect(document.activeElement).toBe(more);
});

it('preserves keyboard focus and dismissal across live session updates', () => {
  rowWidth = 220;
  const { band } = mount();
  const data = [session('main'), session('fork-1'), session('fork-2')];
  band.render(data, 'main');
  const more = $('.sessmore-btn', band.el);
  const pop = $('.sesspop', band.el);
  more.focus();
  const card = $('button', pop); card.focus();
  band.render(data, 'main');
  expect(document.activeElement).toBe(card);
  expect(pop.hidden).toBe(false);
  more.focus();
  more.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
  band.render(data, 'main');
  expect(document.activeElement).toBe(more);
  expect(pop.hidden).toBe(true);
});
