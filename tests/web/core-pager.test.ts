// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createWebUi } from '../../src/web/client/ui/index.ts';
import { createPager } from '../../src/web/client/features/core/pager.ts';

type Any = any;
/** 查询结果按 Any 用:测试里节点必在,缺了就让断言或调用直接失败。 */
const $ = (sel: string, from: ParentNode = document): Any => from.querySelector(sel);
const $$ = (sel: string, from: ParentNode = document): Any[] => [...from.querySelectorAll(sel)];

afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

function mount(opts: Any = {}) {
  const life = new AbortController();
  const ui = createWebUi({ doc: document, overlayHost: document.body, signal: life.signal, memo: { get: (_: Any, f: Any) => f, set() {} } });
  const changes: Any[] = [];
  const pager = createPager(ui, { key: 'test', sizes: [10, 20], defaultSize: 10, onChange: (beyond: Any) => changes.push(beyond), ...opts });
  document.body.appendChild(pager.el);
  // the pager's only buttons: previous, then next
  const buttons = () => $$('button', pager.el);
  return { pager, changes, prev: () => buttons()[0], next: () => buttons()[1] };
}

describe('运行诊断 table pager', () => {
  it('slices pages, clamps the page when rows shrink, and hides the page keys on a single page', () => {
    const { pager, next } = mount();
    pager.render(25);
    expect(pager.slice(25)).toEqual([0, 10]);
    expect($('.core-pager-of', pager.el).textContent).toBe('1 / 3');
    next().click();
    next().click();
    pager.render(25);
    expect(pager.slice(25)).toEqual([20, 25]);
    expect(next().disabled).toBe(true);
    pager.render(8);
    expect(pager.page).toBe(0);
    expect(next().hidden).toBe(true);
  });

  it('keeps 下一页 usable on the last loaded page while earlier rows exist, and reports it as beyond', () => {
    const { pager, changes, next } = mount();
    pager.render(10, true);
    expect($('.core-pager-shown', pager.el).textContent).toContain('10+');
    expect(next().disabled).toBe(false);
    next().click();
    expect(changes).toEqual([true]);
  });

  it('remembers the page size per key', () => {
    const { pager } = mount();
    const sel = $('select', pager.el);
    sel.value = '20';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(pager.size).toBe(20);
    expect(mount().pager.size).toBe(20);
  });
});
