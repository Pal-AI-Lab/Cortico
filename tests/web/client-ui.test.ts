/**
 * 通用 UI 原语通过迷你 DOM 验证节点关系、class 和监听的安装与移除。
 * 变量形式的动态 import 避免根 tsconfig 将 DOM 代码纳入 Node 检查；浏览器类型由 tsconfig.web.json 检查。
 * 夹具实现 addEventListener 的 signal/once 选项，并使用 Node 原生 AbortController；忽略选项会使监听释放断言失效。
 */

import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const UI_ENTRY = '../../src/web/client/ui/index.ts';
const FORMAT_ENTRY = '../../src/web/client/ui/format.ts';
const DOM_ENTRY = '../../src/web/client/ui/dom.ts';
const IMAGES_ENTRY = '../../src/web/client/ui/images.ts';

type Any = any;

async function loadUi(): Promise<Any> {
  return import(UI_ENTRY);
}

// ---------------------------------------------------------------------------
// 迷你 DOM 桩
// ---------------------------------------------------------------------------

type Listener = (ev: Any) => void;
interface ListenOptions {
  signal?: AbortSignal;
  once?: boolean;
}

/**
 * 监听表。`{ signal }` 与 `{ once }` 按 DOM 规范实现：signal abort 就自动摘，
 * once 触发一次即摘。已经 abort 的 signal 传进来则整条监听不装。
 */
class Listeners {
  private map = new Map<string, Listener[]>();

  add(type: string, fn: Listener, opts?: ListenOptions): void {
    if (opts?.signal?.aborted) return;
    const wrapped: Listener = opts?.once
      ? (ev) => {
          this.remove(type, wrapped);
          fn(ev);
        }
      : fn;
    const arr = this.map.get(type) ?? [];
    arr.push(wrapped);
    this.map.set(type, arr);
    opts?.signal?.addEventListener('abort', () => this.remove(type, wrapped), { once: true });
  }

  remove(type: string, fn: Listener): void {
    const arr = this.map.get(type) ?? [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
    this.map.set(type, arr);
  }

  fire(type: string, ev: Any): void {
    for (const fn of (this.map.get(type) ?? []).slice()) fn(ev);
  }

  count(type: string): number {
    return (this.map.get(type) ?? []).length;
  }
}

class FakeEl {
  readonly tagName: string;
  readonly ownerDocument: FakeDoc;
  /** 元素节点。被测代码靠它分辨"现成节点"与"描述对象"（跨 realm 的 instanceof 不可靠） */
  readonly nodeType = 1;
  className = '';
  type = '';
  open = false;
  value = '';
  /** `input[type=checkbox]` 的勾选态 */
  checked = false;
  rows = 0;
  colSpan = 1;
  disabled = false;
  placeholder = '';
  /** 悬停气泡。桩里只是个普通属性，够验证"原语把它设上去了" */
  title = '';
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  listeners = new Listeners();
  ownText = '';
  focused = false;
  /** 无真实布局；测试赋值模拟滚动位置和尺寸。 */
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  offsetLeft = 0;
  offsetTop = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  /** 只记 `style.setProperty` 写进的 CSS 变量。 */
  style: Any = { setProperty(this: Any, k: string, v: string): void { this[k] = v; } };
  /** `textarea.select()`：复制按钮的降级路线要它 */
  selected = false;
  select(): void {
    this.selected = true;
  }

  constructor(tag: string, doc: FakeDoc) {
    this.tagName = tag;
    this.ownerDocument = doc;
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.ownText = v;
  }

  appendChild(node: FakeEl): FakeEl {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    this.children.push(node);
    return node;
  }
  append(...nodes: FakeEl[]): void {
    for (const n of nodes) this.appendChild(n);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }

  focus(): void {
    this.focused = true;
  }
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.remove(type, fn);
  }
  /** 事件冒泡到根：target 恒为最初派发的那个节点，够验证"点遮罩 vs 点卡片" */
  dispatchEvent(ev: Any): void {
    if (ev.target === undefined) ev.target = this;
    let node: FakeEl | null = this;
    while (node) {
      node.listeners.fire(ev.type, ev);
      node = node.parent;
    }
  }
  /** 还挂着几个某类型的监听（测试自用） */
  countListeners(type: string): number {
    return this.listeners.count(type);
  }
  /** 递归找第一个 class 含某个词的后代（测试自用） */
  find(cls: string): FakeEl | null {
    for (const c of this.children) {
      if (c.className.split(' ').includes(cls)) return c;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
  /** 递归找第一个某标签的后代（测试自用） */
  findTag(tag: string): FakeEl | null {
    for (const c of this.children) {
      if (c.tagName === tag) return c;
      const hit = c.findTag(tag);
      if (hit) return hit;
    }
    return null;
  }
}

class FakeDoc {
  listeners = new Listeners();
  body: FakeEl;
  /** 默认不提供 Clipboard API；可注入文档所属窗口的剪贴板。 */
  defaultView: Any = undefined;
  /** 降级路线用的 `execCommand`。缺省没有 = 连降级也不通。 */
  execCommand?: (cmd: string) => boolean;
  constructor() {
    this.body = new FakeEl('body', this);
  }
  createElement(tag: string): FakeEl {
    return new FakeEl(tag, this);
  }
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.remove(type, fn);
  }
  dispatchEvent(ev: Any): void {
    this.listeners.fire(ev.type, ev);
  }
  /** 还挂着几个某类型的监听——浮层关掉后必须归零 */
  countListeners(type: string): number {
    return this.listeners.count(type);
  }
}

function fakeMemo(seed: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...seed };
  return {
    store,
    get<T>(key: string, fallback: T): T {
      return key in store ? (store[key] as T) : fallback;
    },
    set(key: string, value: unknown): void {
      store[key] = value;
    },
  };
}

/**
 * 造一套 doc + host + ui。`ac` 就是面板的 `ctx.signal` 那一根——测试里所有
 * "面板 unmount"都写成 `ac.abort()`。
 */
async function mkUi(seed: Record<string, unknown> = {}) {
  const { createWebUi } = await loadUi();
  const doc = new FakeDoc();
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const memo = fakeMemo(seed);
  const ac = new AbortController();
  const ui = createWebUi({ memo, overlayHost: host, doc, signal: ac.signal }) as Any;
  return { doc, host, memo, ui, ac };
}

// ---------------------------------------------------------------------------
// WebUiFormat —— 纯函数，口径钉死在这里
// ---------------------------------------------------------------------------

describe('WebUiFormat', () => {
  const load = async (): Promise<Any> => (await import(FORMAT_ENTRY)).webUiFormat;

  it('count：满 10000 才转 k', async () => {
    const fmt = await load();
    expect(fmt.count(null)).toBe('—');
    expect(fmt.count(undefined)).toBe('—');
    expect(fmt.count(0)).toBe('0');
    expect(fmt.count(999)).toBe('999');
    expect(fmt.count(9999)).toBe('9999');
    expect(fmt.count(10000)).toBe('10.0k');
    expect(fmt.count(12345)).toBe('12.3k');
  });

  it('bytes：空值给空串，1024 进制', async () => {
    const fmt = await load();
    expect(fmt.bytes(null)).toBe('');
    expect(fmt.bytes(undefined)).toBe('');
    expect(fmt.bytes(0)).toBe('0B');
    expect(fmt.bytes(512)).toBe('512B');
    expect(fmt.bytes(1023)).toBe('1023B');
    expect(fmt.bytes(1024)).toBe('1.0K');
    expect(fmt.bytes(1536)).toBe('1.5K');
    expect(fmt.bytes(1572864)).toBe('1.5M');
  });

  it('percent：四舍五入到整数', async () => {
    const fmt = await load();
    expect(fmt.percent(null)).toBe('—');
    expect(fmt.percent(0)).toBe('0%');
    expect(fmt.percent(0.42)).toBe('42%');
    expect(fmt.percent(0.425)).toBe('43%');
    expect(fmt.percent(1)).toBe('100%');
  });

  it('clock：ISO 串切 11..19 位，短串/非串给空', async () => {
    const fmt = await load();
    expect(fmt.clock('2026-08-12T18:56:48.123Z')).toBe('18:56:48');
    expect(fmt.clock('2026-08-12T18:56:48')).toBe('18:56:48');
    expect(fmt.clock('2026-08-12T18:56')).toBe('');
    expect(fmt.clock(null)).toBe('');
    expect(fmt.clock(1_700_000_000_000)).toBe('');
  });

  it('money：<1 保 4 位，>=1 保 2 位，币种缺省 USD 渲染成 $，其余代码原样前置', async () => {
    const fmt = await load();
    expect(fmt.money(null)).toBe('$0');
    expect(fmt.money(0)).toBe('$0.0000');
    expect(fmt.money(0.0123456)).toBe('$0.0123');
    expect(fmt.money(0.9999)).toBe('$0.9999');
    expect(fmt.money(1)).toBe('$1.00');
    expect(fmt.money(12.345)).toBe('$12.35');
    expect(fmt.money(1, 'USD')).toBe('$1.00');
    expect(fmt.money(1, 'EUR')).toBe('EUR 1.00');
  });

  it('duration：ms / s / m s / h m 四档，1s 以上先量化到 0.1s', async () => {
    const fmt = await load();
    expect(fmt.duration(null)).toBe('—');
    expect(fmt.duration(Number.NaN)).toBe('—');
    expect(fmt.duration(-5)).toBe('0ms');
    expect(fmt.duration(0)).toBe('0ms');
    expect(fmt.duration(999)).toBe('999ms');
    expect(fmt.duration(1000)).toBe('1.0s');
    expect(fmt.duration(1200)).toBe('1.2s');
    // 量化后跨档：59999 不该印成自相矛盾的 60.0s
    expect(fmt.duration(59_999)).toBe('1m 00s');
    expect(fmt.duration(60_000)).toBe('1m 00s');
    expect(fmt.duration(184_000)).toBe('3m 04s');
    expect(fmt.duration(3_599_999)).toBe('1h 00m');
    expect(fmt.duration(3_600_000)).toBe('1h 00m');
    expect(fmt.duration(7_845_000)).toBe('2h 10m');
  });
});

// ---------------------------------------------------------------------------
// esc / h
// ---------------------------------------------------------------------------

describe('dom 助手', () => {
  it('esc 转义五个字符，空值给空串', async () => {
    const { esc } = await import(DOM_ENTRY);
    expect(esc('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(esc('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(42)).toBe('42');
  });

  it('h 建元素并挂 class / 文本', async () => {
    const { ui } = await mkUi();
    const el = ui.h('div', 'sheet', '文本');
    expect(el.tagName).toBe('div');
    expect(el.className).toBe('sheet');
    expect(el.textContent).toBe('文本');
    const bare = ui.h('span');
    expect(bare.className).toBe('');
    expect(bare.textContent).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 档案卡
// ---------------------------------------------------------------------------

describe('sheet / foldSheet', () => {
  it('sheet 复用 sheet tabbed，标题带英文小注', async () => {
    const { ui } = await mkUi();
    const s = ui.sheet({ title: '监听名单', en: 'ROSTER' });
    expect(s.el.className).toBe('sheet tabbed');
    const head = s.el.findTag('h3') as FakeEl;
    expect(head.ownText).toBe('监听名单');
    expect((head.find('en') as FakeEl).textContent).toBe('ROSTER');
    // 不折叠的卡也有 note，只是不显示
    expect(s.note.className).toBe('foldnote hidden');
    expect(s.el.find('foldnote')).toBe(s.note);
    // body 是卡里的独立容器
    expect(s.body.className).toBe('sheetbody');
    s.body.appendChild(ui.h('div', null, 'x'));
    expect(s.body.parent).toBe(s.el);
  });

  it('foldSheet 用 details.sheet.fold，展开状态经 memo 存取', async () => {
    const { ui, memo } = await mkUi();
    const s = ui.foldSheet('gate', { title: '接入', en: 'GATE', defaultOpen: true });
    expect(s.el.tagName).toBe('details');
    expect(s.el.className).toBe('sheet tabbed fold');
    expect(s.el.open).toBe(true);
    expect(s.body.className).toBe('foldbody');
    expect(s.note.className).toBe('foldnote');

    // 用户收起 → 落到 memo（键带 fold: 前缀，不跟扩展自己的键撞）
    s.el.open = false;
    s.el.dispatchEvent({ type: 'toggle' });
    expect(memo.store['fold:gate']).toBe(false);
  });

  it('foldSheet 重建时从 memo 恢复，而不是回落 defaultOpen', async () => {
    const { ui } = await mkUi({ 'fold:gate': true });
    const s = ui.foldSheet('gate', { title: '接入', defaultOpen: false });
    expect(s.el.open).toBe(true);
  });

  it('desc 落成 body 的第一个孩子（两种卡的 .sh-desc 选择器都命中）', async () => {
    const { ui } = await mkUi();
    const s = ui.sheet({ title: '接入', desc: '开关一拨即重启 World。' });
    expect(s.desc!.className).toBe('sh-desc');
    expect(s.body.children[0]).toBe(s.desc);
    expect(s.desc!.textContent).toBe('开关一拨即重启 World。');

    const f = ui.foldSheet('gate', { title: '接入', desc: '同上' });
    // 折叠卡的选择器是 `.foldbody > .sh-desc`,必须是直接子代,不能再包一层
    expect(f.desc!.parent).toBe(f.body);
    expect(f.body.children[0]).toBe(f.desc);
  });

  it('不给 desc 就不建空节点（空的 .sh-desc 照样占 margin）', async () => {
    const { ui } = await mkUi();
    expect(ui.sheet({ title: 't' }).desc).toBeNull();
    expect(ui.foldSheet('x', { title: 't' }).desc).toBeNull();
    expect(ui.sheet({ title: 't' }).body.children).toHaveLength(0);
  });

  it('foldSheet 的 toggle 监听随面板 abort 摘掉：卸载后不再回写 memo', async () => {
    const { ui, memo, ac } = await mkUi();
    const s = ui.foldSheet('gate', { title: '接入', defaultOpen: true });
    ac.abort();
    s.el.open = false;
    s.el.dispatchEvent({ type: 'toggle' });
    expect(memo.store['fold:gate']).toBeUndefined();
    expect(s.el.countListeners('toggle')).toBe(0);
  });

  it('foldSheet 不碰 localStorage', async () => {
    // 桩环境里压根没有 localStorage：能跑到这儿就说明没摸过全局
    expect((globalThis as Any).localStorage).toBeUndefined();
    const { ui, memo } = await mkUi();
    ui.foldSheet('x', { title: 't' });
    expect(Object.keys(memo.store)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 行内小件
// ---------------------------------------------------------------------------

describe('button / pill / msgline / rowbar', () => {
  it('button 的 class 顺序是 btn sm primary', async () => {
    const { ui } = await mkUi();
    expect(ui.button('a').className).toBe('btn');
    expect(ui.button('a', { size: 'sm' }).className).toBe('btn sm');
    expect(ui.button('a', { size: 'sm', variant: 'primary' }).className).toBe('btn sm primary');
    expect(ui.button('a', { variant: 'danger' }).className).toBe('btn danger');
    expect(ui.button('a', { variant: 'plain', size: 'md' }).className).toBe('btn');
  });

  it('button 是 type=button 且接得住 onClick', async () => {
    const { ui } = await mkUi();
    const seen: string[] = [];
    const b = ui.button('保存', { onClick: () => seen.push('hit') });
    expect(b.type).toBe('button');
    b.dispatchEvent({ type: 'click' });
    expect(seen).toEqual(['hit']);
  });

  it('pill 三态各有 class：on / off / 中性', async () => {
    const { ui } = await mkUi();
    expect(ui.pill('已连接', 'on').className).toBe('pill on');
    expect(ui.pill('未连接', 'off').className).toBe('pill off');
    expect(ui.pill('普通', 'plain').className).toBe('pill');
    expect(ui.pill('无 tone').className).toBe('pill');
    expect(ui.pill('已连接', 'on').textContent).toBe('已连接');
  });

  it('chip 走 .chip 三配色，加粗数值靠自己回填 <b>', async () => {
    const { ui } = await mkUi();
    expect(ui.chip('事件 128').className).toBe('chip');
    expect(ui.chip('事件 128').textContent).toBe('事件 128');
    expect(ui.chip('积压', 'warn').className).toBe('chip warnc');
    expect(ui.chip('离线', 'accent').className).toBe('chip dreamc');
    expect(ui.chip('中性', 'plain').className).toBe('chip');
    const c = ui.chip('调用 ');
    c.appendChild(ui.h('b', null, '12'));
    expect(c.textContent).toBe('调用 12');
  });

  it('msgline / rowbar / placeholder', async () => {
    const { ui } = await mkUi();
    expect(ui.msgline('已保存').className).toBe('msgline');
    expect(ui.msgline('失败', true).className).toBe('msgline bad');
    expect(ui.msgline().textContent).toBe('');
    expect(ui.rowbar().className).toBe('rowbar');
    expect(ui.actions().className).toBe('rowbar actionbar');
    const section = ui.section('生成参数', '修改后保存生效');
    expect(section.className).toBe('sectionhead');
    expect(section.children[0]?.tagName).toBe('h4');
    expect(section.children[0]?.textContent).toBe('生成参数');
    expect(section.children[1]?.className).toBe('sectiondesc');
    expect(section.children[1]?.textContent).toBe('修改后保存生效');
    const ph = ui.placeholder('还没有监听任何群');
    expect(ph.className).toBe('placeholder');
    expect(ph.tagName).toBe('div');
    expect(ph.textContent).toBe('还没有监听任何群');
  });

  it('button 的 onClick 随面板 abort 一起摘', async () => {
    const { ui, ac } = await mkUi();
    const seen: string[] = [];
    const b = ui.button('保存', { onClick: () => seen.push('hit') });
    b.dispatchEvent({ type: 'click' });
    ac.abort();
    b.dispatchEvent({ type: 'click' });
    expect(seen).toEqual(['hit']);
    expect(b.countListeners('click')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 表单控件
// ---------------------------------------------------------------------------

describe('input / select / textarea', () => {
  it('三者共用 .field，cls 追加在后面', async () => {
    const { ui } = await mkUi();
    expect(ui.input().className).toBe('field');
    expect(ui.input({ cls: 'mono' }).className).toBe('field mono');
    expect(ui.select().className).toBe('field');
    expect(ui.textarea().className).toBe('field');
    expect(ui.input().tagName).toBe('input');
    expect(ui.select().tagName).toBe('select');
    expect(ui.textarea().tagName).toBe('textarea');
  });

  it('input：type 缺省 text，初值 / 占位 / 禁用照设', async () => {
    const { ui } = await mkUi();
    expect(ui.input().type).toBe('text');
    const el = ui.input({ type: 'search', value: '铁镐', placeholder: '筛选…', disabled: true });
    expect(el.type).toBe('search');
    expect(el.value).toBe('铁镐');
    expect(el.placeholder).toBe('筛选…');
    expect(el.disabled).toBe(true);
  });

  it('select：字符串选项等价于 value=label，且先填 option 再设 value', async () => {
    const { ui } = await mkUi();
    const el = ui.select({
      options: ['a', { value: 'b', label: '乙' }, { value: 'c' }],
      value: 'b',
    });
    expect(el.children.map((c: Any) => [c.tagName, c.value, c.textContent])).toEqual([
      ['option', 'a', 'a'],
      ['option', 'b', '乙'],
      ['option', 'c', 'c'],
    ]);
    // value 在 option 之后才设——反过来浏览器会把不认识的值丢掉
    expect(el.value).toBe('b');
  });

  it('textarea：rows 与占位', async () => {
    const { ui } = await mkUi();
    const el = ui.textarea({ rows: 4, placeholder: '（空 = 不改）', value: 'x' });
    expect(el.rows).toBe(4);
    expect(el.placeholder).toBe('（空 = 不改）');
    expect(el.value).toBe('x');
  });

  it('onInput 收到当前值；input 听 input、select 听 change', async () => {
    const { ui } = await mkUi();
    const seen: string[] = [];
    const i = ui.input({ onInput: (v: string) => seen.push('i:' + v) });
    i.value = '新值';
    i.dispatchEvent({ type: 'input' });
    const s = ui.select({ options: ['a', 'b'], onInput: (v: string) => seen.push('s:' + v) });
    s.value = 'b';
    s.dispatchEvent({ type: 'change' });
    // select 不听 input:漏派发一次也不该多算一条
    s.dispatchEvent({ type: 'input' });
    expect(seen).toEqual(['i:新值', 's:b']);
  });

  it('onInput 的监听随面板 abort 摘干净', async () => {
    const { ui, ac } = await mkUi();
    const seen: string[] = [];
    const i = ui.input({ onInput: (v: string) => seen.push(v) });
    ac.abort();
    i.value = 'z';
    i.dispatchEvent({ type: 'input' });
    expect(seen).toEqual([]);
    expect(i.countListeners('input')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 提交时机：onInput（逐次击键）/ onChange（敲完）/ onCommit（回车）
//
// ---------------------------------------------------------------------------

describe('onChange / onCommit', () => {
  it('onChange 只在 change 时刻响，逐次击键不算', async () => {
    const { ui } = await mkUi();
    const seen: string[] = [];
    const i = ui.input({ onChange: (v: string) => seen.push(v) });
    i.value = '100';
    i.dispatchEvent({ type: 'input' });
    expect(seen).toEqual([]);
    i.value = '10086';
    i.dispatchEvent({ type: 'change' });
    expect(seen).toEqual(['10086']);
  });

  it('三条钩子各挂各的，互不替代', async () => {
    const { ui } = await mkUi();
    const seen: string[] = [];
    const i = ui.input({
      onInput: (v: string) => seen.push('input:' + v),
      onChange: (v: string) => seen.push('change:' + v),
      onCommit: (v: string) => seen.push('commit:' + v),
    });
    i.value = '1';
    i.dispatchEvent({ type: 'input' });
    i.value = '10086';
    i.dispatchEvent({ type: 'keydown', key: 'Enter' });
    i.dispatchEvent({ type: 'change' });
    expect(seen).toEqual(['input:1', 'commit:10086', 'change:10086']);
  });

  it('onCommit 认回车、不认别的键', async () => {
    const { ui } = await mkUi();
    const seen: string[] = [];
    const i = ui.input({ value: 'x', onCommit: (v: string) => seen.push(v) });
    i.dispatchEvent({ type: 'keydown', key: 'a' });
    i.dispatchEvent({ type: 'keydown', key: 'Escape' });
    expect(seen).toEqual([]);
    i.dispatchEvent({ type: 'keydown', key: 'Enter' });
    expect(seen).toEqual(['x']);
  });

  it('输入法组词中的那次回车不算提交（中文下这是最容易踩的坑）', async () => {
    const { ui } = await mkUi();
    const seen: string[] = [];
    const i = ui.input({ value: '你好', onCommit: (v: string) => seen.push(v) });
    // 敲回车选候选词:isComposing 为真
    i.dispatchEvent({ type: 'keydown', key: 'Enter', isComposing: true });
    expect(seen).toEqual([]);
    // 词选完了再敲一下才是提交
    i.dispatchEvent({ type: 'keydown', key: 'Enter' });
    expect(seen).toEqual(['你好']);
  });

  it('textarea 上的裸回车是换行，要 Ctrl/⌘ 才算提交', async () => {
    const { ui } = await mkUi();
    const seen: string[] = [];
    const t = ui.textarea({ value: '两行\n文本', onCommit: (v: string) => seen.push(v) });
    t.dispatchEvent({ type: 'keydown', key: 'Enter' });
    expect(seen).toEqual([]);
    t.dispatchEvent({ type: 'keydown', key: 'Enter', ctrlKey: true });
    t.dispatchEvent({ type: 'keydown', key: 'Enter', metaKey: true });
    expect(seen).toEqual(['两行\n文本', '两行\n文本']);
  });

  it('select 的 onChange 拿到选中项的 value', async () => {
    const { ui } = await mkUi();
    const seen: string[] = [];
    const s = ui.select({ options: ['100', '300'], onChange: (v: string) => seen.push(v) });
    s.value = '300';
    s.dispatchEvent({ type: 'change' });
    expect(seen).toEqual(['300']);
  });

  it('onChange / onCommit 的监听同样随面板 abort 摘干净', async () => {
    const { ui, ac } = await mkUi();
    const seen: string[] = [];
    const i = ui.input({
      onChange: (v: string) => seen.push('c:' + v),
      onCommit: (v: string) => seen.push('e:' + v),
    });
    expect(i.countListeners('change')).toBe(1);
    expect(i.countListeners('keydown')).toBe(1);
    ac.abort();
    i.dispatchEvent({ type: 'change' });
    i.dispatchEvent({ type: 'keydown', key: 'Enter' });
    expect(seen).toEqual([]);
    expect(i.countListeners('change')).toBe(0);
    expect(i.countListeners('keydown')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 勾选框 / 字段标签 / 分段选择器
// ---------------------------------------------------------------------------

describe('checkbox', () => {
  it('结构是 label.check > input[type=checkbox] + span', async () => {
    const { ui } = await mkUi();
    const c = ui.checkbox('监听中');
    expect(c.el.tagName).toBe('label');
    expect(c.el.className).toBe('check');
    const [box, text] = c.el.children as FakeEl[];
    expect(box.tagName).toBe('input');
    expect(box.type).toBe('checkbox');
    expect(box).toBe(c.input);
    // 文字单独包 span:label.check 是 inline-flex,裸文本节点会让 gap 对不齐
    expect(text.tagName).toBe('span');
    expect(text.textContent).toBe('监听中');
  });

  it('初值 / 禁用 / 悬停气泡', async () => {
    const { ui } = await mkUi();
    expect(ui.checkbox('a').checked).toBe(false);
    const c = ui.checkbox('监听中', { checked: true, disabled: true, title: '点击停用' });
    expect(c.checked).toBe(true);
    expect(c.input.checked).toBe(true);
    expect(c.input.disabled).toBe(true);
    expect(c.el.title).toBe('点击停用');
  });

  it('用户拨动 → onChange 收到新状态；checked 跟着读回来', async () => {
    const { ui } = await mkUi();
    const seen: boolean[] = [];
    const c = ui.checkbox('监听中', { checked: true, onChange: (v: boolean) => seen.push(v) });
    c.input.checked = false;
    c.input.dispatchEvent({ type: 'change' });
    expect(seen).toEqual([false]);
    expect(c.checked).toBe(false);
  });

  it('setChecked 不触发 onChange（回滚不该被当成一次新的用户改动）', async () => {
    const { ui } = await mkUi();
    const seen: boolean[] = [];
    const c = ui.checkbox('监听中', { onChange: (v: boolean) => seen.push(v) });
    c.setChecked(true);
    expect(c.checked).toBe(true);
    expect(c.input.checked).toBe(true);
    expect(seen).toEqual([]);
  });

  it('onChange 随面板 abort 摘干净', async () => {
    const { ui, ac } = await mkUi();
    const seen: boolean[] = [];
    const c = ui.checkbox('监听中', { onChange: (v: boolean) => seen.push(v) });
    ac.abort();
    c.input.checked = true;
    c.input.dispatchEvent({ type: 'change' });
    expect(seen).toEqual([]);
    expect(c.input.countListeners('change')).toBe(0);
  });
});

describe('field', () => {
  it('label.fieldrow > span.fieldlabel + 控件本身', async () => {
    const { ui } = await mkUi();
    const ctrl = ui.input({ cls: 'mono' });
    const row = ui.field('WS 地址', ctrl);
    // <label> 包着控件:点标签即聚焦,不必配 for/id
    expect(row.tagName).toBe('label');
    expect(row.className).toBe('fieldrow');
    const [lbl, inner] = row.children as FakeEl[];
    expect(lbl.tagName).toBe('span');
    expect(lbl.className).toBe('fieldlabel');
    expect(lbl.textContent).toBe('WS 地址');
    // 控件是原样放进去的那一个,调用方手里的引用照样能读 .value
    expect(inner).toBe(ctrl);
  });

  it('也能包非输入控件（标签这件事不是输入框独有的）', async () => {
    const { ui } = await mkUi();
    const seg = ui.segmented(['a', 'b']);
    const row = ui.field('挡位', seg.el);
    expect(row.children[1]).toBe(seg.el);
  });
});

describe('segmented', () => {
  it('结构是 .segwrap > button.seg，选中的那颗加 active', async () => {
    const { ui } = await mkUi();
    const s = ui.segmented(['天', '周', '月'], { value: '周' });
    expect(s.el.className).toBe('segwrap');
    const btns = s.el.children as FakeEl[];
    expect(btns.map((b) => [b.tagName, b.type, b.textContent])).toEqual([
      ['button', 'button', '天'],
      ['button', 'button', '周'],
      ['button', 'button', '月'],
    ]);
    expect(btns.map((b) => b.className)).toEqual(['seg', 'seg active', 'seg']);
    expect(s.value).toBe('周');
  });

  it('sm 落到外框；对象项的 label 与 value 分开；没给 value 就一颗都不亮', async () => {
    const { ui } = await mkUi();
    const s = ui.segmented([{ value: 'g', label: '群' }, { value: 'p' }], { size: 'sm' });
    expect(s.el.className).toBe('segwrap sm');
    expect((s.el.children as FakeEl[]).map((b) => b.textContent)).toEqual(['群', 'p']);
    expect((s.el.children as FakeEl[]).map((b) => b.className)).toEqual(['seg', 'seg']);
    expect(s.value).toBe('');
    expect(ui.segmented(['a'], { size: 'md' }).el.className).toBe('segwrap');
  });

  it('点一颗 → 选中态搬过去，onSelect 收到 value', async () => {
    const { ui } = await mkUi();
    const seen: string[] = [];
    const s = ui.segmented(['天', '周'], { value: '天', onSelect: (v: string) => seen.push(v) });
    (s.el.children[1] as FakeEl).dispatchEvent({ type: 'click' });
    expect(seen).toEqual(['周']);
    expect(s.value).toBe('周');
    expect((s.el.children as FakeEl[]).map((b) => b.className)).toEqual(['seg', 'seg active']);
  });

  it('点已经选中的那颗不回调（后面挂的常是一次重新取数）', async () => {
    const { ui } = await mkUi();
    const seen: string[] = [];
    const s = ui.segmented(['天', '周'], { value: '天', onSelect: (v: string) => seen.push(v) });
    (s.el.children[0] as FakeEl).dispatchEvent({ type: 'click' });
    expect(seen).toEqual([]);
    expect(s.value).toBe('天');
  });

  it('选中底色是外框的滑块：选中按钮有尺寸时把位置写进 CSS 变量并标 data-thumb，结构仍是 .segwrap > button.seg', async () => {
    const { ui } = await mkUi();
    const s = ui.segmented(['天', '周'], { value: '天' });
    const [day, week] = s.el.children as FakeEl[];
    // 还没布局：不显示滑块
    expect(s.el.getAttribute('data-thumb')).toBeNull();

    Object.assign(day, { offsetLeft: 2, offsetTop: 2, offsetWidth: 40, offsetHeight: 26 });
    Object.assign(week, { offsetLeft: 44, offsetTop: 2, offsetWidth: 52, offsetHeight: 26 });
    week.dispatchEvent({ type: 'click' });
    expect(s.el.getAttribute('data-thumb')).toBe('');
    expect([s.el.style['--seg-x'], s.el.style['--seg-y'], s.el.style['--seg-w'], s.el.style['--seg-h']]).toEqual(['44px', '2px', '52px', '26px']);
    expect(s.el.className).toBe('segwrap');
    expect((s.el.children as FakeEl[]).map((b) => b.tagName)).toEqual(['button', 'button']);

    // 选中项不可见（宽度 0）时收起滑块
    week.offsetWidth = 0;
    s.setValue('周');
    expect(s.el.getAttribute('data-thumb')).toBeNull();
  });

  it('setValue 改选中态但不回调；给个不认识的值就一颗都不亮', async () => {
    const { ui } = await mkUi();
    const seen: string[] = [];
    const s = ui.segmented(['天', '周'], { value: '天', onSelect: (v: string) => seen.push(v) });
    s.setValue('周');
    expect(seen).toEqual([]);
    expect(s.value).toBe('周');
    expect((s.el.children as FakeEl[]).map((b) => b.className)).toEqual(['seg', 'seg active']);
    s.setValue('年');
    expect((s.el.children as FakeEl[]).map((b) => b.className)).toEqual(['seg', 'seg']);
  });

  it('重复 value 也不会留下一颗永远亮着的死键', async () => {
    const { ui } = await mkUi();
    const s = ui.segmented(['a', 'a'], { value: 'a' });
    expect((s.el.children as FakeEl[]).map((b) => b.className)).toEqual(['seg active', 'seg active']);
    s.setValue('');
    expect((s.el.children as FakeEl[]).map((b) => b.className)).toEqual(['seg', 'seg']);
  });

  it('点击监听随面板 abort 摘干净', async () => {
    const { ui, ac } = await mkUi();
    const seen: string[] = [];
    const s = ui.segmented(['天', '周'], { value: '天', onSelect: (v: string) => seen.push(v) });
    ac.abort();
    (s.el.children[1] as FakeEl).dispatchEvent({ type: 'click' });
    expect(seen).toEqual([]);
    expect(s.value).toBe('天');
    expect((s.el.children[1] as FakeEl).countListeners('click')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 读数：表 / 小卡
// ---------------------------------------------------------------------------

describe('table', () => {
  it('结构是 .tablewrap > table.data > thead + tbody', async () => {
    const { ui } = await mkUi();
    const t = ui.table({ head: ['session', '状态', '调用'] });
    expect(t.el.className).toBe('tablewrap');
    const tbl = t.el.children[0] as FakeEl;
    expect(tbl.tagName).toBe('table');
    expect(tbl.className).toBe('data');
    const ths = (tbl.findTag('tr') as FakeEl).children;
    expect(ths.map((c) => [c.tagName, c.textContent])).toEqual([
      ['th', 'session'],
      ['th', '状态'],
      ['th', '调用'],
    ]);
    expect(t.body.tagName).toBe('tbody');
    expect(t.body.parent).toBe(tbl);
  });

  it('不给表头就没有 thead；maxHeight 落到外框行内样式', async () => {
    const { ui } = await mkUi();
    const t = ui.table();
    expect(t.el.findTag('thead')).toBeNull();
    expect(t.el.getAttribute('style')).toBeNull();
    const t2 = ui.table({ head: ['a'], maxHeight: 'calc(100vh - 300px)' });
    expect(t2.el.getAttribute('style')).toBe('max-height:calc(100vh - 300px);overflow:auto');
  });

  it('addRow：文本 / 数字 / 节点 / 带 class 的格', async () => {
    const { ui } = await mkUi();
    const t = ui.table({ head: ['名', '数', '态', '文'] });
    const badge = ui.pill('已连接', 'on');
    const tr = t.addRow(['x', 42, badge, { text: '多行\n文本', cls: 'txt' }, null]);
    expect(tr.tagName).toBe('tr');
    expect(t.body.children).toHaveLength(1);
    const tds = tr.children as FakeEl[];
    expect(tds.map((d: FakeEl) => d.tagName)).toEqual(['td', 'td', 'td', 'td', 'td']);
    expect(tds[0].textContent).toBe('x');
    expect(tds[1].textContent).toBe('42');
    expect(tds[2].children[0]).toBe(badge);
    expect(tds[3].className).toBe('txt');
    expect(tds[3].textContent).toBe('多行\n文本');
    expect(tds[4].textContent).toBe('');
  });

  it('clear 清空；给一句话就铺跨列的 .placeholder 空态', async () => {
    const { ui } = await mkUi();
    const t = ui.table({ head: ['a', 'b', 'c'] });
    t.addRow(['1', '2', '3']);
    t.addRow(['4', '5', '6']);
    expect(t.body.children).toHaveLength(2);

    t.clear();
    expect(t.body.children).toHaveLength(0);

    t.addRow(['1', '2', '3']);
    t.clear('暂无 session');
    expect(t.body.children).toHaveLength(1);
    const td = t.body.children[0].children[0] as FakeEl;
    expect(td.className).toBe('placeholder');
    expect(td.colSpan).toBe(3);
    expect(td.textContent).toBe('暂无 session');
  });

  it('无表头时空态的 colSpan 至少是 1', async () => {
    const { ui } = await mkUi();
    const t = ui.table();
    t.clear('空');
    expect((t.body.children[0].children[0] as FakeEl).colSpan).toBe(1);
  });
});

describe('kv', () => {
  it('结构是 table.kvtable > tr > td + td，tr 直接挂表下（不铺 tbody）', async () => {
    const { ui } = await mkUi();
    const t = ui.kv([
      { k: '自身 QQ', v: '10086' },
      { k: '监听群', v: 3 },
    ]);
    expect(t.tagName).toBe('table');
    expect(t.className).toBe('kvtable');
    expect((t.children as FakeEl[]).map((r) => r.tagName)).toEqual(['tr', 'tr']);
    const first = t.children[0] as FakeEl;
    expect((first.children as FakeEl[]).map((d) => [d.tagName, d.textContent])).toEqual([
      ['td', '自身 QQ'],
      ['td', '10086'],
    ]);
    expect((t.children[1] as FakeEl).children[1].textContent).toBe('3');
  });

  it('值给节点就直接放；空值给空格子', async () => {
    const { ui } = await mkUi();
    const badge = ui.pill('已连接', 'on');
    const t = ui.kv([
      { k: '连接', v: badge },
      { k: '备注', v: null },
      { k: '别的', v: undefined },
    ]);
    expect((t.children[0] as FakeEl).children[1].children[0]).toBe(badge);
    expect((t.children[1] as FakeEl).children[1].textContent).toBe('');
    expect((t.children[2] as FakeEl).children[1].textContent).toBe('');
  });

  it('空清单给一张空表（不铺假行）', async () => {
    const { ui } = await mkUi();
    expect(ui.kv([]).children).toHaveLength(0);
  });
});

describe('stat / statgrid', () => {
  it('stat 是 .stat > .k + .v，unit 落成 <small>', async () => {
    const { ui } = await mkUi();
    const s = ui.stat({ k: '总调用', v: 128, unit: '次' });
    expect(s.className).toBe('stat');
    expect(s.children[0].className).toBe('k');
    expect(s.children[0].textContent).toBe('总调用');
    const v = s.children[1] as FakeEl;
    expect(v.className).toBe('v');
    expect(v.textContent).toBe('128次');
    expect((v.findTag('small') as FakeEl).textContent).toBe('次');
  });

  it('stat 的 accent 与节点值', async () => {
    const { ui } = await mkUi();
    expect(ui.stat({ k: 'k', v: 'v', accent: true }).className).toBe('stat accent');
    const node = ui.pill('on', 'on');
    const s = ui.stat({ k: 'k', v: node });
    expect((s.find('v') as FakeEl).children[0]).toBe(node);
  });

  it('statgrid 把一组小卡排进 .statgrid，不给也能建空网格', async () => {
    const { ui } = await mkUi();
    const g = ui.statgrid([
      { k: 'a', v: 1 },
      { k: 'b', v: 2 },
    ]);
    expect(g.className).toBe('statgrid');
    expect(g.children).toHaveLength(2);
    expect(g.children.every((c: FakeEl) => c.className === 'stat')).toBe(true);
    expect(ui.statgrid().children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 浮层
// ---------------------------------------------------------------------------

describe('toast', () => {
  it('挂到 overlayHost，后一条顶掉前一条，到点自摘', async () => {
    vi.useFakeTimers();
    try {
      const { ui, host } = await mkUi();
      ui.toast('已保存');
      expect(host.children).toHaveLength(1);
      expect(host.children[0].className).toBe('toast');
      expect(host.children[0].textContent).toBe('已保存');
      // 位置与动画都在 .toast 里,不留行内样式
      expect(host.children[0].getAttribute('style')).toBeNull();

      ui.toast('出错了', 'bad');
      expect(host.children).toHaveLength(1);
      expect(host.children[0].className).toBe('toast bad');

      vi.advanceTimersByTime(2100);
      expect(host.children).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('返回的句柄能提前撤下', async () => {
    vi.useFakeTimers();
    try {
      const { ui, host } = await mkUi();
      const t = ui.toast('已保存');
      t.dispose();
      expect(host.children).toHaveLength(0);
      // 幂等:定时器到点再关一次不该出事
      t.dispose();
      vi.advanceTimersByTime(2100);
      expect(host.children).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('confirm', () => {
  it('点确认 → true，DOM 与监听清干净', async () => {
    const { ui, doc, host } = await mkUi();
    const p = ui.confirm({ title: '重启 World ？', body: '会断开当前连接。' });
    const modal = host.children[0] as FakeEl;
    expect(modal.className).toBe('modal');
    expect((modal.find('modaltitle') as FakeEl).textContent).toBe('重启 World ？');
    expect(modal.textContent).toContain('会断开当前连接。');
    expect(doc.countListeners('keydown')).toBe(1);

    const ok = modal.find('primary') as FakeEl;
    expect(ok.textContent).toBe('确认');
    expect(ok.focused).toBe(true);
    ok.dispatchEvent({ type: 'click' });

    await expect(p).resolves.toBe(true);
    expect(host.children).toHaveLength(0);
    expect(doc.countListeners('keydown')).toBe(0);
  });

  it('点取消 → false', async () => {
    const { ui, host } = await mkUi();
    const p = ui.confirm({ title: '确定？' });
    const modal = host.children[0] as FakeEl;
    const cancel = modal.children[0].find('btn') as FakeEl;
    expect(cancel.textContent).toBe('取消');
    cancel.dispatchEvent({ type: 'click' });
    await expect(p).resolves.toBe(false);
  });

  it('Esc 取消，且监听解干净', async () => {
    const { ui, doc, host } = await mkUi();
    const p = ui.confirm({ title: '确定？' });
    doc.dispatchEvent({ type: 'keydown', key: 'a' });
    expect(host.children).toHaveLength(1);
    doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    await expect(p).resolves.toBe(false);
    expect(doc.countListeners('keydown')).toBe(0);
  });

  it('点遮罩取消，点卡片内部不关', async () => {
    const { ui, host } = await mkUi();
    const p = ui.confirm({ title: '确定？' });
    const modal = host.children[0] as FakeEl;
    const card = modal.find('modalcard') as FakeEl;
    card.dispatchEvent({ type: 'mousedown' });
    expect(host.children).toHaveLength(1);
    modal.dispatchEvent({ type: 'mousedown' });
    await expect(p).resolves.toBe(false);
    expect(host.children).toHaveLength(0);
  });

  it('danger 走危险态：文案与配色都换', async () => {
    const { ui, host } = await mkUi();
    const p = ui.confirm({ title: '清空存储？', danger: true });
    const modal = host.children[0] as FakeEl;
    const ok = modal.find('danger') as FakeEl;
    expect(ok.className).toBe('btn sm danger');
    expect(ok.textContent).toBe('仍要继续');
    expect(modal.find('primary')).toBeNull();
    ok.dispatchEvent({ type: 'click' });
    await expect(p).resolves.toBe(true);
  });
});

describe('浮层层级', () => {
  it('弹窗压在窄屏顶栏之上,toast 与提示压在弹窗之上', () => {
    const css = readFileSync(new URL('../../src/web/public/styles.css', import.meta.url), 'utf8');
    // 选择器开头、规则体里写的 z-index;同一选择器在各个媒体查询里的值都收
    const z = (selector: string): number[] => [...css.matchAll(new RegExp(`(?:^|\\s)${selector} \\{[^}]*?z-index: (\\d+)`, 'gm'))].map((m) => Number(m[1]));
    const [modal] = z('\\.modal');
    expect(Math.max(...z('#rail'))).toBeLessThan(modal!);
    expect(Math.min(...z('\\.toast'), ...z('\\.u-tip'))).toBeGreaterThan(modal!);
  });
});

describe('lightbox', () => {
  it('点图片、点遮罩或按 Esc 都关闭,doc 上的监听归零', async () => {
    const { ui, doc, host } = await mkUi();
    ui.lightbox('/api/blob?handle=log%3Aa.png', '截图');
    const image = (host.children[0] as FakeEl).findTag('img') as FakeEl & { src: string; alt: string };
    expect([image.src, image.alt]).toEqual(['/api/blob?handle=log%3Aa.png', '截图']);
    image.dispatchEvent({ type: 'click' });
    expect(host.children).toHaveLength(0);

    ui.lightbox('/x.png');
    doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    expect(host.children).toHaveLength(0);
    expect(doc.countListeners('keydown')).toBe(0);
  });
});

describe('drawer', () => {
  it('长文本进 pre.mono，Esc / 关闭键都能收干净', async () => {
    const { ui, doc, host } = await mkUi();
    ui.drawer('原始 JSON', '{"a":1}');
    const modal = host.children[0] as FakeEl;
    expect((modal.find('modaltitle') as FakeEl).textContent).toBe('原始 JSON');
    const pre = modal.findTag('pre') as FakeEl;
    expect(pre.className).toBe('mono');
    expect(pre.textContent).toBe('{"a":1}');

    doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    expect(host.children).toHaveLength(0);
    expect(doc.countListeners('keydown')).toBe(0);

    ui.drawer('再来一次', 'x');
    (host.children[0] as FakeEl).find('btn')!.dispatchEvent({ type: 'click' });
    expect(host.children).toHaveLength(0);
    expect(doc.countListeners('keydown')).toBe(0);
  });

  it('返回的句柄能由调用方关掉（做完一件事顺手收起抽屉）', async () => {
    const { ui, doc, host } = await mkUi();
    const d = ui.drawer('原始 JSON', '{}');
    d.dispose();
    expect(host.children).toHaveLength(0);
    expect(doc.countListeners('keydown')).toBe(0);
    d.dispose();
  });

  it('第二参给节点就原样放进 .modalbody（不再包一层 pre.mono）', async () => {
    const { ui, host } = await mkUi();
    const view = ui.log();
    view.append('第一行');
    ui.drawer('展开日志', view.el);
    const modal = host.children[0] as FakeEl;
    const body = modal.find('modalbody') as FakeEl;
    // 节点是原样那一个,调用方手里的引用照样能继续 append
    expect(body.children).toHaveLength(1);
    expect(body.children[0]).toBe(view.el);
    expect(modal.findTag('pre')).toBeNull();
    view.append('抽屉开着时又来一行');
    expect(view.count).toBe(2);
  });

  it('两种入参都收得住：字符串走 pre.mono，节点直接进', async () => {
    const { ui, host } = await mkUi();
    ui.drawer('文本', 'x');
    expect(((host.children[0] as FakeEl).findTag('pre') as FakeEl).className).toBe('mono');
    const img = ui.h('img');
    ui.drawer('节点', img);
    const second = host.children[1] as FakeEl;
    expect(second.findTag('pre')).toBeNull();
    expect((second.find('modalbody') as FakeEl).children[0]).toBe(img);
  });
});

// ---------------------------------------------------------------------------
//
// ---------------------------------------------------------------------------

describe('busy', () => {
  it('结构是 .modal.busy + .modalcard，文本进 .busytext，且标着 aria-busy', async () => {
    const { ui, host } = await mkUi();
    ui.busy('关闭中', '正在重启……\n回来后这一页会自动刷新。');
    const modal = host.children[0] as FakeEl;
    expect(modal.className).toBe('modal busy');
    expect(modal.getAttribute('aria-busy')).toBe('true');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect((modal.find('modaltitle') as FakeEl).textContent).toBe('关闭中');
    const text = modal.find('busytext') as FakeEl;
    expect(text.textContent).toBe('正在重启……\n回来后这一页会自动刷新。');
    // 不给正文就不建空节点
    ui.busy('稍等');
    expect((host.children[1] as FakeEl).find('busytext')).toBeNull();
  });

  it('关不掉：Esc 不理、点遮罩不理、卡里也没有关闭键', async () => {
    const { ui, doc, host } = await mkUi();
    ui.busy('重启中', '正在重启……');
    const modal = host.children[0] as FakeEl;

    // 压根没往 doc 上装 keydown:这不是"装了但忽略",是根本不听
    expect(doc.countListeners('keydown')).toBe(0);
    doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    expect(host.children).toHaveLength(1);

    modal.dispatchEvent({ type: 'mousedown' });
    expect(host.children).toHaveLength(1);

    // 没有关闭键可点(drawer 那颗 `✕ 关闭 (Esc)` 在这儿是不该有的)
    expect(modal.find('btn')).toBeNull();
    expect(modal.findTag('button')).toBeNull();
  });

  it('只能靠返回的句柄撤下，且幂等', async () => {
    const { ui, host } = await mkUi();
    const b = ui.busy('重启中');
    expect(host.children).toHaveLength(1);
    b.dispose();
    expect(host.children).toHaveLength(0);
    b.dispose();
    expect(host.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 生命周期：面板 unmount（signal abort）
//
// ---------------------------------------------------------------------------

describe('面板 unmount 的收尾', () => {
  it('abort 关掉在开的 drawer，doc 上的监听归零', async () => {
    const { ui, doc, host, ac } = await mkUi();
    ui.drawer('原始 JSON', '{"a":1}');
    expect(host.children).toHaveLength(1);
    expect(doc.countListeners('keydown')).toBe(1);

    ac.abort();
    expect(host.children).toHaveLength(0);
    expect(doc.countListeners('keydown')).toBe(0);
  });

  it('abort 关掉在开的 toast，并撤掉它的定时器', async () => {
    vi.useFakeTimers();
    try {
      const { ui, host, ac } = await mkUi();
      ui.toast('已保存');
      expect(host.children).toHaveLength(1);
      ac.abort();
      expect(host.children).toHaveLength(0);
      // 定时器已撤:到点不会再去动一个早就没了的节点
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort 让挂起的 confirm resolve false（不是 reject，更不是永挂）', async () => {
    const { ui, doc, host, ac } = await mkUi();
    let settled: unknown = 'pending';
    const p = ui.confirm({ title: '重启 World ？' }).then((v: boolean) => (settled = v));
    expect(host.children).toHaveLength(1);

    ac.abort();
    await p;
    expect(settled).toBe(false);
    expect(host.children).toHaveLength(0);
    expect(doc.countListeners('keydown')).toBe(0);
  });

  it('多个浮层同时开着，abort 一次全清', async () => {
    const { ui, doc, host, ac } = await mkUi();
    const p = ui.confirm({ title: '确定？' });
    ui.drawer('日志', 'x');
    expect(host.children).toHaveLength(2);

    ac.abort();
    expect(host.children).toHaveLength(0);
    expect(doc.countListeners('keydown')).toBe(0);
    await expect(p).resolves.toBe(false);
  });

  it('abort 撤掉 busy：面板都卸了还盖着一层，就是把 WebUI 锁死了', async () => {
    const { ui, host, ac } = await mkUi();
    ui.busy('重启中', '正在重启……');
    expect(host.children).toHaveLength(1);

    ac.abort();
    expect(host.children).toHaveLength(0);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('abort 之后：confirm 立即给 false，toast / drawer / busy 静默不显示', async () => {
    const { ui, doc, host, ac } = await mkUi();
    ac.abort();

    await expect(ui.confirm({ title: '确定？' })).resolves.toBe(false);
    expect(host.children).toHaveLength(0);

    // 句柄照样给,调用方 .dispose() 不该炸
    ui.toast('已保存').dispose();
    ui.drawer('日志', 'x').dispose();
    ui.busy('重启中').dispose();
    expect(host.children).toHaveLength(0);
    expect(doc.countListeners('keydown')).toBe(0);
  });

  it('浮层自己先关掉时，不在面板 signal 上攒监听', async () => {
    vi.useFakeTimers();
    try {
      const { ui, host, ac } = await mkUi();
      for (let i = 0; i < 100; i++) ui.toast('第 ' + i + ' 条');
      expect(getEventListeners(ac.signal, 'abort')).toHaveLength(1);
      vi.advanceTimersByTime(2100);
      expect(host.children).toHaveLength(0);
      // 全部到点自摘之后,面板 signal 上一条都不该剩
      expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
      ac.abort();
      expect(host.children).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 尾部粘滞的判据 —— 纯函数
//
// ---------------------------------------------------------------------------

describe('shouldStick', () => {
  it('正好在底算贴底；差 1px 在缺省容差之内也算', async () => {
    const { shouldStick, LOG_STICK_PX } = await loadUi();
    expect(LOG_STICK_PX).toBe(24);
    // scrollHeight 1000、可视 200 ⇒ 滚到最底时 scrollTop = 800
    expect(shouldStick(800, 1000, 200)).toBe(true);
    // scrollTop 可能含小数，容差内仍判为贴底。
    expect(shouldStick(799, 1000, 200)).toBe(true);
    expect(shouldStick(776, 1000, 200)).toBe(true);
  });

  it('用户往上翻就不粘了（差得比容差多）', async () => {
    const { shouldStick } = await loadUi();
    expect(shouldStick(775, 1000, 200)).toBe(false);
    expect(shouldStick(400, 1000, 200)).toBe(false);
    expect(shouldStick(0, 1000, 200)).toBe(false);
  });

  it('容差可调：给 0 时差 1px 就不算贴底', async () => {
    const { shouldStick } = await loadUi();
    expect(shouldStick(800, 1000, 200, 0)).toBe(true);
    expect(shouldStick(799, 1000, 200, 0)).toBe(false);
    // 负容差当 0 用，别把"贴底"判成永远不成立
    expect(shouldStick(800, 1000, 200, -5)).toBe(true);
    expect(shouldStick(799, 1000, 200, -5)).toBe(false);
  });

  it('内容还没撑满框、以及压根没布局时，默认贴底', async () => {
    const { shouldStick } = await loadUi();
    // 只有两行、还没溢出：本来就该跟着长
    expect(shouldStick(0, 60, 240)).toBe(true);
    // 未布局的节点三个数全是 0
    expect(shouldStick(0, 0, 0)).toBe(true);
    // 猜错顶多多滚一次；猜成不粘的话新行会一直落在视野外面
    expect(shouldStick(Number.NaN, 1000, 200)).toBe(true);
    expect(shouldStick(0, Number.NaN, 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// log —— 滚动日志
//
// 与 table 的分工是时间轴 vs 记录集：table 可以整份重画，log 只往末尾长。
// ---------------------------------------------------------------------------

/** 往一个新日志里灌 n 行，返回最后剩几行（上限的边界用）。 */
function countAfter(ui: Any, max: number | undefined, n: number): number {
  const v = ui.log(max === undefined ? undefined : { max });
  for (let i = 0; i < n; i++) v.append('x' + i);
  return v.count;
}

describe('log', () => {
  it('结构是 .logview > .logline，四个 tone 各有 class，限高落行内样式', async () => {
    const { ui } = await mkUi();
    const v = ui.log();
    expect(v.el.className).toBe('logview');
    expect(ui.log({ variant: 'conversation' }).el.className).toBe('logview conversation');
    expect(v.el.getAttribute('style')).toBe('max-height:240px');
    expect(v.append('普通').className).toBe('logline');
    expect(v.append('普通', 'plain').className).toBe('logline');
    expect(v.append('心跳', 'dim').className).toBe('logline dim');
    expect(v.append('留意', 'warn').className).toBe('logline warn');
    expect(v.append('出事了', 'bad').className).toBe('logline bad');
    expect((v.el.children[0] as FakeEl).textContent).toBe('普通');
    expect(ui.log({ maxHeight: 'calc(100vh - 320px)' }).el.getAttribute('style')).toBe(
      'max-height:calc(100vh - 320px)',
    );
  });

  it('append 返回那一行的节点，count 跟着走；clear 回到零', async () => {
    const { ui } = await mkUi();
    const v = ui.log();
    expect(v.count).toBe(0);
    const row = v.append('第一行');
    // 拿到节点就能继续往里塞东西（chip / 链接）
    row.appendChild(ui.chip('128'));
    expect(row.textContent).toBe('第一行128');
    v.append('第二行');
    expect(v.count).toBe(2);
    v.clear();
    expect(v.count).toBe(0);
    expect(v.el.children).toHaveLength(0);
  });

  it('环形裁剪：超过上限从头摘，留下的永远是最新那一段', async () => {
    const { ui } = await mkUi();
    const v = ui.log({ max: 3 });
    for (let i = 1; i <= 6; i++) v.append('第 ' + i + ' 行');
    expect(v.count).toBe(3);
    expect((v.el.children as FakeEl[]).map((c) => c.textContent)).toEqual([
      '第 4 行',
      '第 5 行',
      '第 6 行',
    ]);
    // 缺省上限 400；给 0 / 负数不至于把整个日志裁没（至少留一行）
    expect(countAfter(ui, undefined, 401)).toBe(400);
    expect(countAfter(ui, 0, 5)).toBe(1);
  });

  it('空态：不给就留空框，给了就铺 .placeholder，第一行进来即摘、clear 再回来', async () => {
    const { ui } = await mkUi();
    expect(ui.log().el.children).toHaveLength(0);

    const v = ui.log({ empty: '还没有事件' });
    const ph = v.el.children[0] as FakeEl;
    expect(ph.className).toBe('placeholder');
    expect(ph.textContent).toBe('还没有事件');
    // 空态不算一行——否则环形裁剪从头摘的第一个就是它，行数从此少算一个
    expect(v.count).toBe(0);

    v.append('来了');
    expect(v.el.children).toHaveLength(1);
    expect(v.count).toBe(1);
    expect((v.el.children[0] as FakeEl).className).toBe('logline');

    v.clear();
    expect(v.count).toBe(0);
    expect((v.el.children[0] as FakeEl).className).toBe('placeholder');
  });

  it('接线：贴着底就追到底，用户翻上去后新行不再拽动视野', async () => {
    const { ui } = await mkUi();
    const v = ui.log();
    expect(v.stuck).toBe(true);

    // 摆出"已经溢出、且贴着底"：append 后自动追到 scrollHeight
    v.el.clientHeight = 200;
    v.el.scrollHeight = 1000;
    v.append('新行');
    expect(v.el.scrollTop).toBe(1000);

    // 用户往上翻：滚动事件一来，粘滞就该断掉
    v.el.scrollTop = 100;
    v.el.dispatchEvent({ type: 'scroll' });
    expect(v.stuck).toBe(false);
    v.el.scrollHeight = 1200;
    v.append('又一行');
    expect(v.el.scrollTop).toBe(100);

    // 翻回底部：粘滞恢复，新行又跟着走
    v.el.scrollTop = 1000;
    v.el.dispatchEvent({ type: 'scroll' });
    expect(v.stuck).toBe(true);
    v.append('再一行');
    expect(v.el.scrollTop).toBe(1200);
  });

  it('scrollToEnd 手动把粘滞接回来（"回到底部"那颗按钮）', async () => {
    const { ui } = await mkUi();
    const v = ui.log();
    v.el.clientHeight = 200;
    v.el.scrollHeight = 1000;
    v.el.scrollTop = 0;
    v.el.dispatchEvent({ type: 'scroll' });
    expect(v.stuck).toBe(false);

    v.scrollToEnd();
    expect(v.el.scrollTop).toBe(1000);
    expect(v.stuck).toBe(true);
    // clear 之后也重新粘住：一个空的日志框谈不上"用户正在往上翻"
    v.el.scrollTop = 0;
    v.el.dispatchEvent({ type: 'scroll' });
    v.clear();
    expect(v.stuck).toBe(true);
  });

  it('滚动监听随面板 abort 摘掉', async () => {
    const { ui, ac } = await mkUi();
    const v = ui.log();
    expect(v.el.countListeners('scroll')).toBe(1);
    ac.abort();
    expect(v.el.countListeners('scroll')).toBe(0);
    // 摘掉之后再滚也不会改状态（面板都没了，还去回写粘滞就是拿旧值盖新值）
    v.el.clientHeight = 200;
    v.el.scrollHeight = 1000;
    v.el.scrollTop = 0;
    v.el.dispatchEvent({ type: 'scroll' });
    expect(v.stuck).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// disable —— 局部禁用
//
// ---------------------------------------------------------------------------

describe('disable', () => {
  it('一次置灰一组，dispose 恢复各自原状（本来就禁用的仍禁用）', async () => {
    const { ui } = await mkUi();
    const save = ui.button('保存');
    const name = ui.input();
    // 这一颗本来就是禁用的
    const restart = ui.button('重启');
    restart.disabled = true;

    const off = ui.disable(save, name, restart);
    expect([save.disabled, name.disabled, restart.disabled]).toEqual([true, true, true]);

    off.dispose();
    // 恢复 restart 原来的禁用态。
    expect([save.disabled, name.disabled, restart.disabled]).toEqual([false, false, true]);
  });

  it('dispose 幂等：第二次不再往回写', async () => {
    const { ui } = await mkUi();
    const b = ui.button('保存');
    const off = ui.disable(b);
    off.dispose();
    expect(b.disabled).toBe(false);
    // 此时外部已经自己把它设禁用了，再 dispose 一次不该把它解禁
    b.disabled = true;
    off.dispose();
    expect(b.disabled).toBe(true);
  });

  it('同一个控件传两次只记第一次的原值（否则会留一颗永远灰着的按钮）', async () => {
    const { ui } = await mkUi();
    const b = ui.button('保存');
    const off = ui.disable(b, b, b);
    expect(b.disabled).toBe(true);
    off.dispose();
    expect(b.disabled).toBe(false);
  });

  it('null / undefined 直接跳过（调用方不必先过滤）；一个都没有也不炸', async () => {
    const { ui } = await mkUi();
    const b = ui.button('保存');
    const off = ui.disable(null, b, undefined);
    expect(b.disabled).toBe(true);
    off.dispose();
    expect(b.disabled).toBe(false);
    ui.disable().dispose();
  });

  it('收得下 checkbox 句柄里的那个 input（按结构而不是按标签列举）', async () => {
    const { ui } = await mkUi();
    const c = ui.checkbox('监听中');
    const off = ui.disable(c.input);
    expect(c.input.disabled).toBe(true);
    off.dispose();
    expect(c.input.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// copyButton —— 复制 + 回执
// ---------------------------------------------------------------------------

/** 等一轮宏任务：把点击里挂起的那串微任务全冲干净。 */
const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

/** 给桩文档接一个剪贴板。返回收到的文本列表。 */
function stubClipboard(doc: Any, impl: (text: string) => Promise<void>): string[] {
  const seen: string[] = [];
  doc.defaultView = {
    navigator: {
      clipboard: {
        writeText(text: string): Promise<void> {
          seen.push(text);
          return impl(text);
        },
      },
    },
  };
  return seen;
}

describe('copyButton', () => {
  it('就是一颗 .btn.sm，标签缺省「复制」', async () => {
    const { ui } = await mkUi();
    expect(ui.copyButton('x').className).toBe('btn sm');
    expect(ui.copyButton('x').textContent).toBe('复制');
    expect(ui.copyButton('x').type).toBe('button');
    expect(ui.copyButton('x', { label: '复制坐标' }).textContent).toBe('复制坐标');
    expect(ui.copyButton('x', { size: 'md', variant: 'primary' }).className).toBe('btn primary');
  });

  it('走剪贴板，成功出一条 ok toast', async () => {
    const { ui, doc, host } = await mkUi();
    const seen = stubClipboard(doc, () => Promise.resolve());
    const b = ui.copyButton('-113 64 208', { okText: '坐标已复制' });
    b.dispatchEvent({ type: 'click' });
    await flush();
    expect(seen).toEqual(['-113 64 208']);
    expect(host.children).toHaveLength(1);
    expect(host.children[0].className).toBe('toast');
    expect(host.children[0].textContent).toBe('坐标已复制');
  });

  it('文本给函数就点的时候才算（渲染时抓的快照到手就过期了）', async () => {
    const { ui, doc } = await mkUi();
    const seen = stubClipboard(doc, () => Promise.resolve());
    let live = '第一版';
    const b = ui.copyButton(() => live);
    b.dispatchEvent({ type: 'click' });
    await flush();
    live = '第二版';
    b.dispatchEvent({ type: 'click' });
    await flush();
    expect(seen).toEqual(['第一版', '第二版']);
  });

  it('clipboard 抛错 → 降级 execCommand，仍算成功', async () => {
    const { ui, doc, host } = await mkUi();
    stubClipboard(doc, () => Promise.reject(new Error('NotAllowedError')));
    // 降级时那段文本必须真的在 DOM 里、且已经选中，否则 execCommand 复制的是空
    let snapshot: { text: string; selected: boolean } | null = null;
    doc.execCommand = (cmd: string): boolean => {
      const ta = host.children.find((c: FakeEl) => c.tagName === 'textarea');
      snapshot = ta ? { text: ta.value, selected: ta.selected } : null;
      return cmd === 'copy';
    };

    const b = ui.copyButton('降级也要能用');
    b.dispatchEvent({ type: 'click' });
    await flush();
    expect(snapshot).toEqual({ text: '降级也要能用', selected: true });
    // 那个离屏 textarea 用完即摘，只剩一条 toast
    expect(host.children).toHaveLength(1);
    expect(host.children[0].className).toBe('toast');
    expect(host.children[0].textContent).toBe('已复制');
  });

  it('两条路都不通 → bad toast，并把文本摊进抽屉让用户自己选', async () => {
    const { ui, doc, host } = await mkUi();
    stubClipboard(doc, () => Promise.reject(new Error('NotAllowedError')));
    // 没有 execCommand：降级那条路也没了
    const b = ui.copyButton('捞不回来的一段文本', { label: '复制日志' });
    b.dispatchEvent({ type: 'click' });
    await flush();

    expect((host.children[0] as FakeEl).className).toBe('toast bad');
    const modal = host.children[1] as FakeEl;
    expect(modal.className).toBe('modal');
    expect((modal.find('modaltitle') as FakeEl).textContent).toBe('复制日志');
    expect((modal.findTag('pre') as FakeEl).textContent).toBe('捞不回来的一段文本');
  });

  it('压根没有 navigator.clipboard 时直接走降级（非安全上下文）', async () => {
    const { ui, doc, host } = await mkUi();
    doc.defaultView = { navigator: {} };
    doc.execCommand = (): boolean => true;
    ui.copyButton('x').dispatchEvent({ type: 'click' });
    await flush();
    expect(host.children).toHaveLength(1);
    expect(host.children[0].className).toBe('toast');
  });

  it('惰性取值自己炸了也要出声，不静默', async () => {
    const { ui, doc, host } = await mkUi();
    stubClipboard(doc, () => Promise.resolve());
    const b = ui.copyButton(() => {
      throw new Error('那串值背后的对象已经没了');
    });
    b.dispatchEvent({ type: 'click' });
    await flush();
    expect((host.children[0] as FakeEl).className).toBe('toast bad');
  });

  it('点击监听随面板 abort 摘掉', async () => {
    const { ui, doc, host, ac } = await mkUi();
    const seen = stubClipboard(doc, () => Promise.resolve());
    const b = ui.copyButton('x');
    ac.abort();
    b.dispatchEvent({ type: 'click' });
    await flush();
    expect(seen).toEqual([]);
    expect(b.countListeners('click')).toBe(0);
    expect(host.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// progress —— 细占比条
//
// ---------------------------------------------------------------------------

describe('progress', () => {
  it('结构 + 缺省读数是百分比，宽度落在 .progressfill 的行内样式上', async () => {
    const { ui } = await mkUi();
    const p = ui.progress({ label: '同步进度', max: 200, value: 50 });
    expect(p.el.className).toBe('progress');
    const head = p.el.children[0] as FakeEl;
    expect(head.className).toBe('progresshead');
    expect((head.find('progresslabel') as FakeEl).textContent).toBe('同步进度');
    expect((head.find('progressnum') as FakeEl).textContent).toBe('25%');
    const track = p.el.children[1] as FakeEl;
    expect(track.className).toBe('progresstrack');
    const fill = track.children[0] as FakeEl;
    expect(fill.className).toBe('progressfill');
    expect(fill.getAttribute('style')).toBe('width:25.0%');
    expect([p.value, p.max]).toEqual([50, 200]);
  });

  it('setValue 改条与读数；顺带改满值（总量是边跑边知道的）', async () => {
    const { ui } = await mkUi();
    const p = ui.progress();
    // 缺省 max=1、value=0
    expect((p.el.find('progressnum') as FakeEl).textContent).toBe('0%');
    expect((p.el.find('progressfill') as FakeEl).getAttribute('style')).toBe('width:0.0%');

    p.setValue(0.42);
    expect((p.el.find('progressnum') as FakeEl).textContent).toBe('42%');
    p.setValue(3, 12);
    expect([p.value, p.max]).toEqual([3, 12]);
    expect((p.el.find('progressfill') as FakeEl).getAttribute('style')).toBe('width:25.0%');
  });

  it('条的宽度夹在 0..1，读数仍拿原始值（超额也要看得见是多少）', async () => {
    const { ui } = await mkUi();
    const p = ui.progress({ max: 10, format: (v: number, m: number) => v + ' / ' + m });
    p.setValue(15);
    expect((p.el.find('progressfill') as FakeEl).getAttribute('style')).toBe('width:100.0%');
    expect((p.el.find('progressnum') as FakeEl).textContent).toBe('15 / 10');
    p.setValue(-3);
    expect((p.el.find('progressfill') as FakeEl).getAttribute('style')).toBe('width:0.0%');
    expect((p.el.find('progressnum') as FakeEl).textContent).toBe('-3 / 10');
  });

  it('满值给 0 / 非有限数一律当 1，不印 NaN%', async () => {
    const { ui } = await mkUi();
    expect((ui.progress({ max: 0, value: 1 }).el.find('progressnum') as FakeEl).textContent).toBe(
      '100%',
    );
    const p = ui.progress({ max: Number.NaN });
    expect(p.max).toBe(1);
    p.setValue(Number.NaN);
    expect(p.value).toBe(0);
    expect((p.el.find('progressnum') as FakeEl).textContent).toBe('0%');
    p.setValue(0.5, 0);
    expect([p.max, (p.el.find('progressnum') as FakeEl).textContent]).toEqual([1, '50%']);
  });

  it('tone 沿用 chip 那两个配色后缀；setLabel 能改小标题；aria 三件齐', async () => {
    const { ui } = await mkUi();
    expect(ui.progress({ tone: 'plain' }).el.className).toBe('progress');
    expect(ui.progress({ tone: 'warn' }).el.className).toBe('progress warnc');
    const p = ui.progress({ tone: 'accent', max: 4, value: 1 });
    expect(p.el.className).toBe('progress dreamc');
    expect(p.el.getAttribute('role')).toBe('progressbar');
    expect(p.el.getAttribute('aria-valuemin')).toBe('0');
    expect(p.el.getAttribute('aria-valuemax')).toBe('4');
    expect(p.el.getAttribute('aria-valuenow')).toBe('1');
    p.setValue(2);
    expect(p.el.getAttribute('aria-valuenow')).toBe('2');
    // 不给 label 就是一格空的小标题（读数照样在右边）
    expect((p.el.find('progresslabel') as FakeEl).textContent).toBe('');
    p.setLabel('第 2 步 / 共 4 步');
    expect((p.el.find('progresslabel') as FakeEl).textContent).toBe('第 2 步 / 共 4 步');
  });
});

describe('images(输入器图片通道的归一化算术)', () => {
  it('fitWithin 只缩不放:长边到上限,比例保持,不产生 0 像素边', async () => {
    const { fitWithin } = await import(IMAGES_ENTRY);
    expect(fitWithin(1200, 800, 2048)).toEqual({ width: 1200, height: 800 });
    expect(fitWithin(4096, 2048, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(fitWithin(1000, 3000, 2048)).toEqual({ width: 683, height: 2048 });
    expect(fitWithin(10000, 1, 2048)).toEqual({ width: 2048, height: 1 });
    // 上限非法(0 / 负数)时不动
    expect(fitWithin(4096, 2048, 0)).toEqual({ width: 4096, height: 2048 });
  });

  it('isImageFile 只认四种位图 mime;normalizeImage 对非图片直接拒收', async () => {
    const { isImageFile, normalizeImage, IMAGE_DEFAULTS } = await import(IMAGES_ENTRY);
    expect(['image/jpeg', 'image/png', 'image/webp', 'image/gif'].every((t) => isImageFile({ type: t }))).toBe(true);
    expect(isImageFile({ type: 'image/svg+xml' })).toBe(false);
    expect(isImageFile({ type: 'text/plain' })).toBe(false);
    expect(IMAGE_DEFAULTS).toEqual({ max: 8, maxEdge: 2048, maxBytes: 6 * 1024 * 1024 });
    await expect(normalizeImage({ type: 'text/plain', name: 'a.txt', size: 3 })).rejects.toThrow('不是支持的图片格式');
  });
});
