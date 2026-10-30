// @vitest-environment jsdom
/** Hover hints (`ui/hover-hint.ts`) and the extension info page's pictures (`extensions/gallery.ts`). */
import { afterEach, describe, expect, it, vi } from 'vitest';
const { mountHoverHints } = (await import('../../src/web/client/ui/hover-hint.ts')) as Any;
const { gallery, takeImages } = (await import('../../src/web/client/features/extensions/gallery.ts')) as Any;

type Any = any;
/** 查询结果按 Any 用:测试里节点必在,缺了就让断言或调用直接失败。 */
const $ = (sel: string, from: ParentNode = document): Any => from.querySelector(sel);
const $$ = (sel: string, from: ParentNode = document): Any[] => [...from.querySelectorAll(sel)];

const lives: Any[] = [];
afterEach(() => { lives.splice(0).forEach((life: Any) => life.abort()); document.body.replaceChildren(); vi.useRealTimers(); });
const mount = () => { const life = new AbortController(); lives.push(life); mountHoverHints(document, life.signal); return $('.hover-hint'); };
const enter = (el: Any) => el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));

describe('hover hints', () => {
  it('shows a title in the console box instead of the system tooltip, a moment after the pointer arrives', () => {
    vi.useFakeTimers();
    const box = mount();
    const button = document.createElement('button'); button.title = '刷新';
    document.body.append(button);
    enter(button);
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('刷新');
    expect(box.classList.contains('hidden')).toBe(true);
    vi.advanceTimersByTime(500);
    expect(box.classList.contains('hidden')).toBe(false);
    expect(box.textContent).toBe('刷新');
    document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(box.classList.contains('hidden')).toBe(true);
  });

  it('shows hints in the rail too: in a narrow window its items are icons only', () => {
    vi.useFakeTimers();
    const box = mount();
    const rail = document.createElement('nav'); rail.id = 'rail';
    const item = document.createElement('a'); item.title = '运行诊断'; item.setAttribute('aria-label', '运行诊断');
    rail.append(item); document.body.append(rail);
    enter(item);
    vi.advanceTimersByTime(500);
    expect(item.hasAttribute('title')).toBe(false);
    expect(box.classList.contains('hidden')).toBe(false);
    expect(box.textContent).toBe('运行诊断');
  });
});

describe('extension pictures', () => {
  it('takes https pictures out of a description and leaves the rest', () => {
    const { text, images } = takeImages('上面是截图\n\n![主界面](https://example.com/a.png)\n\n![](http://example.com/b.png) 结尾');
    expect(images).toEqual([{ src: 'https://example.com/a.png', alt: '主界面' }]);
    expect(text).toBe('上面是截图\n\n![](http://example.com/b.png) 结尾');
    expect(takeImages('没有图片').text).toBe('没有图片');
  });

  it('opens a picture in the lightbox and pages through them', () => {
    const life = new AbortController(); lives.push(life);
    HTMLDialogElement.prototype.showModal ??= function (this: Any) { this.open = true; };
    HTMLDialogElement.prototype.close ??= function (this: Any) { this.open = false; this.dispatchEvent(new Event('close')); };
    const row = gallery(document, [{ src: 'https://example.com/1.png', alt: '' }, { src: 'https://example.com/2.png', alt: '二' }], life.signal);
    document.body.append(row);
    const shots = $$('.extension-gallery-shot', row);
    expect(shots).toHaveLength(2);
    shots[1].click();
    const lightbox = $('.extension-lightbox');
    expect($('img', lightbox).alt).toBe('二');
    expect($('.extension-lightbox-count', lightbox).textContent).toBe('2 / 2');
    $('.extension-lightbox-nav.is-next', lightbox).click();
    expect($('.extension-lightbox-count', lightbox).textContent).toBe('1 / 2');
    lightbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('.extension-lightbox')).toBeNull();
  });
});

describe('dropdown lists', () => {
  it('opens a field\'s datalist in the console list, filters it while typing, and picks with the keys or the pointer', async () => {
    const { mountDropdowns } = (await import('../../src/web/client/ui/dropdown.ts')) as Any;
    const life = new AbortController(); lives.push(life);
    mountDropdowns(document, life.signal);
    const list = document.createElement('datalist'); list.id = 'models';
    for (const value of ['deepseek-flash', 'deepseek-v4-pro', 'qwen-max']) list.append(Object.assign(document.createElement('option'), { value }));
    const input = document.createElement('input'); input.setAttribute('list', 'models'); input.value = 'deepseek-flash';
    document.body.append(list, input);
    const box = $('.combo-list');
    const key = (k: Any) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const shown = () => $$('.combo-option', box).map((option: Any) => option.textContent);

    input.focus(); input.click();
    expect(input.hasAttribute('list')).toBe(false);
    expect(box.hidden).toBe(false);
    expect(shown()).toEqual(['deepseek-flash', 'deepseek-v4-pro', 'qwen-max']);
    expect($('[aria-selected="true"]', box).textContent).toBe('deepseek-flash');

    input.click(); expect(box.hidden).toBe(true); input.click();
    key('ArrowDown'); key('ArrowDown'); key('Enter');
    expect(input.value).toBe('deepseek-v4-pro');
    expect(box.hidden).toBe(true);

    input.value = 'qwen'; input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(shown()).toEqual(['qwen-max']);
    let changed = 0; input.addEventListener('change', () => changed++);
    $('.combo-option', box).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    expect([input.value, changed, box.hidden]).toEqual(['qwen-max', 1, true]);

    // Esc closes the list and goes no further (a window around the field stays open).
    key('ArrowDown');
    let reached = false; document.addEventListener('keydown', () => { reached = true; }, { once: true });
    key('Escape');
    expect(box.hidden).toBe(true);
    expect(reached).toBe(false);
  });
});

describe('select dropdowns', () => {
  it('opens a select in the console list instead of the system popup, from its value, and a second press closes it', async () => {
    const { mountDropdowns } = (await import('../../src/web/client/ui/dropdown.ts')) as Any;
    const life = new AbortController(); lives.push(life);
    mountDropdowns(document, life.signal);
    const select = document.createElement('select'); select.className = 'field';
    for (const [value, label] of [['zh', '简体中文'], ['en', 'English'], ['ja', '日本語']]) select.append(Object.assign(document.createElement('option'), { value, textContent: label }));
    select.value = 'en';
    document.body.append(select);
    const box = $('.combo-list');
    const press = () => { const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }); select.dispatchEvent(event); return event.defaultPrevented; };
    const key = (k: Any) => select.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    let changes = 0; select.addEventListener('change', () => changes++);

    expect(press()).toBe(true);
    expect(box.hidden).toBe(false);
    expect($$('.combo-option', box).map((row: Any) => row.textContent)).toEqual(['简体中文', 'English', '日本語']);
    expect($('.is-active', box).textContent).toBe('English');
    press();
    expect(box.hidden).toBe(true);

    key(' '); key('ArrowDown'); key('Enter');
    expect([select.value, changes, box.hidden]).toEqual(['ja', 1, true]);
    // A closed select's arrows are left to it.
    key('ArrowUp');
    expect(box.hidden).toBe(true);
  });
});
