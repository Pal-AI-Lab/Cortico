// @vitest-environment jsdom
/** The settings window's reflow motion (`console/base/motion.ts`). jsdom lays nothing out and animates nothing, so both are stubbed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
const { measureReflow, steadiest } = (await import('../../src/web/client/core/motion.ts')) as Any;

type Any = any;
/** 查询结果按 Any 用:测试里节点必在,缺了就让断言或调用直接失败。 */
const $ = (sel: string, from: ParentNode = document): Any => from.querySelector(sel);

const tops = new Map();
const rect = (top: Any) => ({ top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40 });
let played: Any[] = [];
function item(key: Any, top: Any) {
  const el = document.createElement('div'); el.className = 'item'; el.dataset.key = key; tops.set(el, top);
  return el;
}
function stubLayout() {
  vi.spyOn(HTMLElement.prototype as Any, 'getBoundingClientRect').mockImplementation(function (this: Any) { return tops.has(this) ? rect(tops.get(this)) : rect(0); });
  (HTMLElement.prototype as Any).animate = function (frames: Any, options: Any) { const animation = { id: options?.id ?? '', frames, options, finished: new Promise(() => {}), cancel() {} }; played.push([this, animation]); return animation; };
  HTMLElement.prototype.getAnimations = () => [];
}
afterEach(() => { vi.restoreAllMocks(); delete (HTMLElement.prototype as Any).animate; delete (HTMLElement.prototype as Any).getAnimations; tops.clear(); played = []; document.body.replaceChildren(); });

describe('measureReflow', () => {
  it('lets what went leave sideways first, then slides the rest into the gap and new items in', () => {
    stubLayout();
    const list = document.createElement('div'); document.body.append(list);
    const a = item('a', 0), b = item('b', 50), c = item('c', 100);
    list.append(a, b, c);
    const reflow = measureReflow(list, '.item', (el: Any) => el.dataset.key);
    b.remove(); tops.set(c, 50);
    const d = item('d', 100); list.append(d);
    reflow.play();
    const of = (el: Any) => played.find(([target]) => target === el)?.[1];
    expect(of(a)).toBeUndefined();
    const ghost = $('.motion-ghost', list);
    expect(ghost.dataset.key).toBeUndefined();
    expect(ghost.inert).toBe(true);
    expect(ghost.style.top).toBe('50px');
    expect(of(ghost).frames[1]).toMatchObject({ opacity: 0, transform: 'translateX(24px)' });
    // The rest wait in place until what went has left; new items take their final places, so they
    // wait until the rest have (nearly) arrived.
    expect(of(c).frames[0]).toEqual({ transform: 'translate(0px, 50px)' });
    expect(of(c).options).toMatchObject({ delay: 130, fill: 'backwards' });
    expect(of(d).frames[0]).toMatchObject({ opacity: 0, transform: 'translateX(-24px)' });
    expect(of(d).options.delay).toBeGreaterThan(130 + 140);
  });
  it('lets items that change places leave and arrive instead of sliding through the others', () => {
    stubLayout();
    const list = document.createElement('div'); document.body.append(list);
    const a = item('a', 0), b = item('b', 50), c = item('c', 100);
    list.append(a, b, c);
    const reflow = measureReflow(list, '.item', (el: Any) => el.dataset.key);
    list.prepend(c); tops.set(c, 0); tops.set(a, 50); tops.set(b, 100);
    reflow.play();
    const of = (el: Any) => played.find(([target]) => target === el)?.[1];
    expect(of(a).frames[0]).toEqual({ transform: 'translate(0px, -50px)' });
    expect(of(b).frames[0]).toEqual({ transform: 'translate(0px, -50px)' });
    expect(of(c).frames[0]).toMatchObject({ opacity: 0 });
    expect($('.motion-ghost', list).style.top).toBe('100px');
  });
  it('finds the longest increasing run', () => {
    expect(steadiest([2, 0, 1])).toEqual([0, 1]);
    expect(steadiest([0, 1, 2])).toEqual([0, 1, 2]);
    expect(steadiest([3, 1, 2, 0, 4])).toEqual([1, 2, 4]);
    expect(steadiest([])).toEqual([]);
  });
  it('does nothing for a first render or with reduced motion', () => {
    stubLayout();
    const list = document.createElement('div'); document.body.append(list);
    measureReflow(list, '.item', (el: Any) => el.dataset.key).play();
    list.append(item('a', 0));
    measureReflow(list, '.item', (el: Any) => el.dataset.key).play();
    expect(played).toEqual([]);
    (window as Any).matchMedia = () => ({ matches: true });
    const reflow = measureReflow(list, '.item', (el: Any) => el.dataset.key);
    list.firstElementChild!.remove(); reflow.play();
    expect($('.motion-ghost', list)).toBeNull();
    delete (window as Any).matchMedia;
  });
});
