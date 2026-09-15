/** 使用模拟 DOM 与接口验证页面行为；浏览器源码由变量动态 import 加载，类型由 tsconfig.web.json 检查。 */

import { describe, expect, it, vi, afterEach } from 'vitest';

const CONFIG = '../../src/web/client/features/config/index.ts';
const STORAGE = '../../src/web/client/features/storage/index.ts';
const FEATURE = '../../src/web/client/features/feature.ts';
const UI = '../../src/web/client/ui/index.ts';
const LIFECYCLE = '../../src/web/client/core/lifecycle.ts';

type Any = any;

// ---------------------------------------------------------------------------
// 迷你 DOM 桩
// ---------------------------------------------------------------------------

type Listener = (ev: Any) => void;
interface ListenOptions { signal?: AbortSignal; once?: boolean }

class Listeners {
  private map = new Map<string, Listener[]>();
  add(type: string, fn: Listener, opts?: ListenOptions): void {
    if (opts?.signal?.aborted) return;
    const wrapped: Listener = opts?.once ? (ev) => { this.remove(type, wrapped); fn(ev); } : fn;
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
  count(type: string): number { return (this.map.get(type) ?? []).length; }
}

class ClassList {
  constructor(private readonly el: FakeEl) {}
  private get parts(): string[] { return this.el.className.split(' ').filter((s) => s !== ''); }
  private set(parts: string[]): void { this.el.className = parts.join(' '); }
  contains(c: string): boolean { return this.parts.includes(c); }
  add(...cs: string[]): void {
    const p = this.parts;
    for (const c of cs) if (!p.includes(c)) p.push(c);
    this.set(p);
  }
  remove(...cs: string[]): void { this.set(this.parts.filter((c) => !cs.includes(c))); }
  toggle(c: string, force?: boolean): boolean {
    const on = force === undefined ? !this.contains(c) : force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
}

class FakeEl {
  readonly tagName: string;
  readonly ownerDocument: FakeDoc;
  readonly nodeType = 1;
  className = '';
  type = '';
  value = '';
  checked = false;
  disabled = false;
  placeholder = '';
  title = '';
  rows = 0;
  colSpan = 1;
  spellcheck = true;
  min = '';
  max = '';
  step = '';
  open = false;
  innerHTML = '';
  clientWidth = 0;
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  listeners = new Listeners();
  ownText = '';
  readonly classList = new ClassList(this);

  constructor(tag: string, doc: FakeDoc) {
    this.tagName = tag;
    this.ownerDocument = doc;
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) { this.children = []; this.ownText = v; }
  get firstChild(): FakeEl | null { return this.children[0] ?? null; }
  get lastChild(): FakeEl | null { return this.children[this.children.length - 1] ?? null; }

  appendChild(node: FakeEl): FakeEl {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    this.children.push(node);
    return node;
  }
  append(...nodes: FakeEl[]): void { for (const n of nodes) this.appendChild(n); }
  replaceChildren(...nodes: FakeEl[]): void {
    for (const c of this.children.slice()) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  removeChild(node: FakeEl): FakeEl { node.remove(); return node; }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void {
    if (k === 'class') { this.className = v; return; }
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    if (k === 'class') return this.className;
    return this.attrs.get(k) ?? null;
  }
  focus(): void {}
  select(): void {}
  getBoundingClientRect(): { width: number; height: number } { return { width: 0, height: 0 }; }
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
  dispatchEvent(ev: Any): void {
    if (ev.target === undefined) ev.target = this;
    let node: FakeEl | null = this;
    while (node) { node.listeners.fire(ev.type, ev); node = node.parent; }
  }
  countListeners(type: string): number { return this.listeners.count(type); }

  find(cls: string): FakeEl | null {
    for (const c of this.children) {
      if (c.classList.contains(cls)) return c;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
  findAll(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) {
      if (c.classList.contains(cls)) out.push(c);
      out.push(...c.findAll(cls));
    }
    return out;
  }
  findTag(tag: string): FakeEl | null {
    for (const c of this.children) {
      if (c.tagName === tag) return c;
      const hit = c.findTag(tag);
      if (hit) return hit;
    }
    return null;
  }
  findAllTag(tag: string): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) {
      if (c.tagName === tag) out.push(c);
      out.push(...c.findAllTag(tag));
    }
    return out;
  }
  /** 按文字找按钮。包装节点的 textContent 也可能相等，所以只认 `<button>`。 */
  findButton(text: string): FakeEl | null {
    for (const b of this.findAllTag('button')) if (b.textContent === text) return b;
    return null;
  }
}

class FakeWindow {
  innerWidth = 1200;
  innerHeight = 800;
  listeners = new Listeners();
  vars: Record<string, string> = {};
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
  dispatchEvent(ev: Any): void { this.listeners.fire(ev.type, ev); }
  countListeners(type: string): number { return this.listeners.count(type); }
  getComputedStyle(): { getPropertyValue(k: string): string } {
    const vars = this.vars;
    return { getPropertyValue: (k: string): string => vars[k] ?? '' };
  }
}

class FakeDoc {
  listeners = new Listeners();
  body: FakeEl;
  documentElement: FakeEl;
  defaultView: Any;
  constructor() {
    this.body = new FakeEl('body', this);
    this.documentElement = new FakeEl('html', this);
    this.defaultView = new FakeWindow();
  }
  createElement(tag: string): FakeEl { return new FakeEl(tag, this); }
  createElementNS(_ns: string, tag: string): FakeEl { return new FakeEl(tag, this); }
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
  dispatchEvent(ev: Any): void { this.listeners.fire(ev.type, ev); }
}

function fakeMemo(): Any {
  const store: Record<string, unknown> = {};
  return {
    get<T>(k: string, d: T): T { return k in store ? (store[k] as T) : d; },
    set(k: string, v: unknown): void { store[k] = v; },
  };
}

// ---------------------------------------------------------------------------
// 假 fetch
// ---------------------------------------------------------------------------

interface Call { url: string; body: Any }
const calls: Call[] = [];

/** `routes` 的值给函数就是"按第 n 次调用回不同东西"。 */
function stubFetch(routes: Record<string, unknown | (() => unknown)>, failing: string[] = []): void {
  vi.stubGlobal('fetch', (url: unknown, init: Any) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (failing.some((f) => u.startsWith(f))) {
      return Promise.resolve({
        ok: false, status: 500,
        text: () => Promise.resolve(JSON.stringify({ error: '服务端说不行' })),
      });
    }
    const key = Object.keys(routes).find((k) => u.startsWith(k));
    const raw = key === undefined ? {} : routes[key];
    const payload = typeof raw === 'function' ? (raw as () => unknown)() : raw;
    return Promise.resolve({
      ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)),
    });
  });
}

/** 按状态码失败（409 冲突要单独造）。 */
function stubFailing(status: number, error: string): void {
  vi.stubGlobal('fetch', (url: unknown, init: Any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve({
      ok: false, status,
      text: () => Promise.resolve(JSON.stringify({ error, conflict: status === 409 })),
    });
  });
}

async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function mkCtx(caps: Record<string, boolean> = {}): Promise<Any> {
  const { createConsoleUi } = (await import(UI)) as Any;
  const { Lifecycle } = (await import(LIFECYCLE)) as Any;
  const doc = new FakeDoc();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  const lifecycle = new Lifecycle();
  const guards: Array<() => string | null> = [];
  const ui = createConsoleUi({
    memo: fakeMemo(), overlayHost: doc.body, doc, signal: lifecycle.signal,
  });
  const ctx = {
    root, lifecycle, signal: lifecycle.signal, ui,
    router: {
      addLeaveGuard(fn: () => string | null) {
        guards.push(fn);
        return { dispose: (): void => { guards.splice(guards.indexOf(fn), 1); } };
      },
    },
    route: { segments: [], query: {}, raw: '' },
    capabilities: caps,
    onError: vi.fn(),
  };
  return { ctx, doc, root, lifecycle, guards, ui };
}

/** 答一次模态确认。`yes` 决定点哪一颗。 */
function answerConfirm(doc: FakeDoc, yes: boolean): void {
  const modal = doc.body.find('modal');
  if (!modal) throw new Error('没有弹出确认框');
  const btn = yes
    ? (modal.findButton('仍要继续') ?? modal.findButton('确认'))
    : modal.findButton('取消');
  if (!btn) throw new Error('确认框上找不到按钮');
  btn.dispatchEvent({ type: 'click' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  calls.length = 0;
});

// ---------------------------------------------------------------------------
// configField —— 这一页真正的判据：**取值归一到存储单位**
// ---------------------------------------------------------------------------

describe('configField 的取值归一', () => {
  async function mkField(prop: Any, val: unknown): Promise<Any> {
    const { ui } = await mkCtx();
    const { configField } = (await import(CONFIG)) as Any;
    return { ...configField(ui, prop, val), ui };
  }

  it('boolean → 勾选框，读回布尔（不是 "on"）', async () => {
    const f = await mkField({ type: 'boolean' }, true);
    expect(f.node.classList.contains('check')).toBe(true);
    expect(f.read()).toBe(true);
    f.node.findTag('input').checked = false;
    expect(f.read()).toBe(false);
  });

  it('string 带 enum → 下拉；值不在 enum 里也照样按声明落到第一项之外的行为交给浏览器', async () => {
    const f = await mkField({ type: 'string', enum: ['a', 'b', 'c'] }, 'b');
    expect(f.node.tagName).toBe('select');
    expect(f.read()).toBe('b');
    // 没给值 → 取 enum 首项
    const g = await mkField({ type: 'string', enum: ['x', 'y'] }, null);
    expect(g.read()).toBe('x');
  });

  it('string 无 enum → 文本框；null 读成空串而不是 "null"', async () => {
    const f = await mkField({ type: 'string' }, null);
    expect(f.node.tagName).toBe('input');
    expect(f.read()).toBe('');
    const g = await mkField({ type: 'string' }, 'hi');
    expect(g.read()).toBe('hi');
  });

  it('x-path 保留文本框并显示选择按钮、推荐目录与安全下载链接', async () => {
    stubFetch({ '/api/path-picker': { path: 'C:\\models\\vision.gguf' } });
    const { ui, lifecycle } = await mkCtx();
    const changed = vi.fn();
    const { configField } = (await import(CONFIG)) as Any;
    const field = configField(ui, {
      type: 'string',
      title: '视觉模型',
      'x-path': {
        kind: 'file',
        extensions: ['.gguf'],
        recommendedDir: 'runtime/external/models/minecraft/vision',
      },
      'x-download': {
        href: 'https://huggingface.co/example/model/resolve/main/vision.gguf',
        label: '下载 GGUF',
      },
    }, 'C:\\old\\vision.gguf', changed, lifecycle.signal);

    expect(field.node.classList.contains('pathfield')).toBe(true);
    expect(field.node.find('pathrecommended')!.textContent).toContain(
      'runtime/external/models/minecraft/vision',
    );
    const link = field.node.findTag('a')!;
    expect(link.getAttribute('href')).toBe(
      'https://huggingface.co/example/model/resolve/main/vision.gguf',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');

    const unsafe = configField(ui, {
      type: 'string',
      'x-path': { kind: 'file' },
      'x-download': { href: 'javascript:alert(1)' },
    }, '', changed, lifecycle.signal);
    expect(unsafe.node.findTag('a')).toBeNull();

    field.node.find('pathpick')!.dispatchEvent({ type: 'click' });
    await flush();
    expect(calls[0]).toEqual({
      url: '/api/path-picker',
      body: {
        kind: 'file',
        title: '视觉模型',
        currentPath: 'C:\\old\\vision.gguf',
        recommendedDir: 'runtime/external/models/minecraft/vision',
        extensions: ['.gguf'],
      },
    });
    expect(field.read()).toBe('C:\\models\\vision.gguf');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('x-path 取消选择时保留原值且不触发保存', async () => {
    stubFetch({ '/api/path-picker': { path: null } });
    const { ui, lifecycle } = await mkCtx();
    const changed = vi.fn();
    const { configField } = (await import(CONFIG)) as Any;
    const field = configField(ui, {
      type: 'string', title: '目录', 'x-path': { kind: 'directory' },
    }, 'C:\\current', changed, lifecycle.signal);
    field.node.find('pathpick')!.dispatchEvent({ type: 'click' });
    await flush();
    expect(field.read()).toBe('C:\\current');
    expect(changed).not.toHaveBeenCalled();
  });

  it('string 带 x-options → 下拉；探测前只有当前值，探测失败也不抛', async () => {
    const f = await mkField({ type: 'string', 'x-options': 'playback-primary' }, 'CABLE Input');
    expect(f.node.tagName).toBe('select');
    expect(f.read()).toBe('CABLE Input');
    expect(f.node.findAllTag('option').map((o: Any) => o.value)).toEqual(['CABLE Input']);
    expect(f.node.findAllTag('option').map((o: Any) => o.textContent)).toEqual(['CABLE Input']);
  });

  it('x-options 当前值为空串时补一项「(当前)」占位', async () => {
    const f = await mkField({ type: 'string', 'x-options': 'playback-secondary' }, '');
    expect(f.node.findAllTag('option').map((o: Any) => o.value)).toEqual(['']);
    expect(f.node.findAllTag('option').map((o: Any) => o.textContent)).toEqual(['(当前)']);
  });

  it('x-options 整张表来自声明方（含它自己的固定项），已选值即使不在表里也保留', async () => {
    // 控制台不认识任何 kind:"系统默认 / 静音"这类固定项也由声明该 kind 的 World 随表给出。
    stubFetch({
      '/api/config/options/playback-primary': {
        options: [
          { value: '', label: '系统默认' },
          { value: 'none', label: '不出声' },
          { value: 'CABLE Input', label: 'CABLE Input · 默认' },
        ],
      },
    });
    const f = await mkField({ type: 'string', 'x-options': 'playback-primary' }, 'Headphones');
    await flush();
    expect(f.read()).toBe('Headphones');
    expect(f.node.findAllTag('option').map((o: Any) => o.value)).toEqual(
      ['', 'none', 'CABLE Input', 'Headphones'],
    );
    expect(f.node.findAllTag('option').map((o: Any) => o.textContent)).toEqual(
      ['系统默认', '不出声', 'CABLE Input · 默认', 'Headphones'],
    );
  });

  it('number：x-scale 是显示换算，读回来必须是存储单位（显示×scale）', async () => {
    // 存储 30000ms，scale 1000 → 显示 30 秒
    const f = await mkField({ type: 'integer', 'x-scale': 1000 }, 30000);
    expect(f.node.value).toBe('30');
    expect(f.read()).toBe(30000);
    f.node.value = '45';
    expect(f.read()).toBe(45000);
  });

  it('number：min/max/step 也按 scale 换算过再设到控件上', async () => {
    const f = await mkField(
      { type: 'integer', 'x-scale': 1000, minimum: 5000, maximum: 60000, multipleOf: 1000 },
      10000,
    );
    expect([f.node.min, f.node.max, f.node.step]).toEqual(['5', '60', '1']);
  });

  it('nullable：留空 ↔ null，而 0 仍然是货真价实的 0', async () => {
    const f = await mkField({ type: 'number', nullable: true }, null);
    expect(f.node.value).toBe('');
    expect(f.node.placeholder).toBe('留空');
    expect(f.read()).toBeNull();
    f.node.value = '0';
    expect(f.read()).toBe(0);      // 不是 null
    f.node.value = '   ';
    expect(f.read()).toBeNull();   // 只有空白 → 还是"不设"
  });

  it('非 nullable 的数字：缺值按 0，且前端不取整（整数由后端 coerce）', async () => {
    const f = await mkField({ type: 'integer' }, undefined);
    expect(f.read()).toBe(0);
    f.node.value = '3.7';
    expect(f.read()).toBe(3.7);
  });

  it('2 元数组 → 一对数字框，读回一对；缺值按 [0,0]', async () => {
    const f = await mkField({ type: 'array', items: { type: 'integer', minimum: 0 }, 'x-scale': 60 }, [120, 300]);
    const [a, b] = f.node.findAllTag('input');
    expect([a.value, b.value]).toEqual(['2', '5']);
    expect(f.read()).toEqual([120, 300]);
    const g = await mkField({ type: 'array', items: { type: 'integer' } }, null);
    expect(g.read()).toEqual([0, 0]);
  });

  it('非数值数组(如 World id 名单)→ 只读文本,read 为 null,不会被写成 [0,0]', async () => {
    const f = await mkField({ type: 'array' }, ['minecraft', 'pvz']);
    expect(f.read).toBeNull();
    expect(f.node.textContent).toBe('["minecraft","pvz"]');
    const g = await mkField({ type: 'array', items: { type: 'string' } }, []);
    expect(g.read).toBeNull();
  });

  it('不认识的 type → 只读文本，且 read 为 null（不参与提交，也不阻塞别人）', async () => {
    const f = await mkField({ type: 'object' }, { a: 1 });
    expect(f.read).toBeNull();
    expect(f.node.textContent).toBe('{"a":1}');
  });
});

// ---------------------------------------------------------------------------
// 配置页
// ---------------------------------------------------------------------------

const configPayload = {
  groups: [
    {
      group: {
        id: 'core', owner: 'core',
        schema: {
          title: '主循环', description: '循环的机械参数',
          properties: {
            'loop.idleMs': { type: 'integer', title: '空转间隔', 'x-scale': 1000, 'x-suffix': '秒', description: '多久醒一次' },
            'loop.strict': { type: 'boolean', title: '严格模式', 'x-hot': false },
          },
        },
      },
      values: { 'loop.idleMs': 30000, 'loop.strict': false },
    },
    {
      group: {
        id: 'world:sample', owner: 'world:sample',
        schema: { title: '样例 World', properties: { 'sample.n': { type: 'number', title: 'N' } } },
      },
      values: { 'sample.n': 2 },
    },
  ],
};

describe('配置页', () => {
  it('按组分节；owner 认识的翻中文，不认识的原样显示', async () => {
    stubFetch({ '/api/config': configPayload });
    const { ctx, root } = await mkCtx({ config: true });
    const { mountConfig } = (await import(CONFIG)) as Any;
    mountConfig(ctx);
    await flush();

    expect(root.findTag('h1')!.textContent).toBe('运行参数');
    const sections = root.findAll('tsection');
    expect(sections.length).toBe(2);
    expect(sections[0].textContent).toContain('主循环');
    expect(sections[0].textContent).toContain('core');
    // `world:sample` 不在翻译表里 → 原样显示（装上新 World 不用改这一页）
    expect(sections[1].textContent).toContain('world:sample');
    expect(root.textContent).toContain('循环的机械参数');
  });

  /** provider 认领的那组旋钮画在 provider 自己那一页，这一页只留没人认领的。 */
  const claimingManifest = {
    protocolVersion: 1,
    providers: [{
      id: 'world:sample', kind: 'world', label: '样例 World', availability: 'active',
      configGroups: ['world:sample'],
    }],
    framework: { capabilities: {} },
  };

  it('被 provider 认领的组不在这一页——它画在声明方自己那一页', async () => {
    stubFetch({ '/api/config': configPayload, '/api/console/manifest': claimingManifest });
    const { ctx, root } = await mkCtx({ config: true });
    const { mountConfig } = (await import(CONFIG)) as Any;
    await mountConfig(ctx);
    await flush();

    const sections = root.findAll('tsection');
    expect(sections.length).toBe(1);
    expect(sections[0].textContent).toContain('主循环');
    expect(root.textContent).not.toContain('样例 World');
  });

  it('认领方把组认光了 → 一句"都归到各自页面"的空态,不是"未挂载声明"', async () => {
    stubFetch({
      '/api/config': { groups: [configPayload.groups[1]] },
      '/api/console/manifest': claimingManifest,
    });
    const { ctx, root } = await mkCtx({ config: true });
    await ((await import(CONFIG)) as Any).mountConfig(ctx);
    await flush();
    expect(root.textContent).toContain('参数均位于各自的设置页');
    expect(root.textContent).not.toContain('未挂载配置项声明');
  });

  it('manifest 取不到 → 退回"全都画在这一页",绝不把旋钮藏起来', async () => {
    stubFetch({ '/api/config': configPayload }, ['/api/console/manifest']);
    const { ctx, root } = await mkCtx({ config: true });
    await ((await import(CONFIG)) as Any).mountConfig(ctx);
    await flush();
    expect(root.findAll('tsection').length).toBe(2);
  });

  it('x-suffix 印成单位、x-hot:false 标"重启生效"、description 落在说明列', async () => {
    stubFetch({ '/api/config': configPayload });
    const { ctx, root } = await mkCtx({ config: true });
    const { mountConfig } = (await import(CONFIG)) as Any;
    mountConfig(ctx);
    await flush();

    const rows = root.findAll('trow');
    expect(rows.length).toBe(3);
    expect(rows[0].find('tunit')!.textContent).toBe('秒');
    expect(rows[0].find('tdesc')!.textContent).toBe('多久醒一次');
    expect(rows[1].find('tlabel')!.textContent).toContain('重启生效');
    // boolean 不配单位（"开启 秒"没有意义）
    expect(rows[1].find('tunit')).toBeNull();
  });

  it('改一下存一下：只发被改的那一组，值是存储单位，不再有勾选框与应用按钮', async () => {
    vi.useFakeTimers();
    stubFetch({ '/api/config': configPayload, POST: { ok: true, result: '已应用' } });
    const { ctx, root } = await mkCtx({ config: true });
    const { mountConfig } = (await import(CONFIG)) as Any;
    mountConfig(ctx);
    await flush();
    calls.length = 0;

    expect(root.findButton('应用')).toBeFalsy();
    expect(root.textContent).not.toContain('仅本次运行');

    const inp = root.findAll('trow')[0].findTag('input')!;
    inp.value = '45';                                  // 显示 45 秒
    inp.dispatchEvent({ type: 'change' });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    // 只发改动的那一组;没碰的 world:sample 不该被顺手写一遍
    const posted = calls.filter((c) => c.body !== undefined);
    expect(posted.length).toBe(1);
    expect(posted[0].body).toEqual({
      group: 'core',
      values: { 'loop.idleMs': 45000, 'loop.strict': false },
    });
  });

  it('路径选择结果复用配置页的分组防抖保存', async () => {
    vi.useFakeTimers();
    const payload = {
      groups: [{
        group: {
          id: 'world:vision', owner: 'world:vision',
          schema: {
            title: '视觉',
            properties: {
              'vision.modelFile': {
                type: 'string', title: '模型',
                'x-path': { kind: 'file', extensions: ['.gguf'] },
              },
            },
          },
        },
        values: { 'vision.modelFile': '' },
      }],
    };
    stubFetch({
      '/api/config': payload,
      '/api/path-picker': { path: 'C:\\models\\vision.gguf' },
    });
    const { ctx, root } = await mkCtx({ config: true });
    ((await import(CONFIG)) as Any).mountConfig(ctx);
    await flush();
    calls.length = 0;

    root.find('pathpick')!.dispatchEvent({ type: 'click' });
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    const saved = calls.find((call) => call.url === '/api/config' && call.body !== undefined);
    expect(saved?.body).toEqual({
      group: 'world:vision',
      values: { 'vision.modelFile': 'C:\\models\\vision.gguf' },
    });
  });

  it('连打字合并成一次请求', async () => {
    vi.useFakeTimers();
    stubFetch({ '/api/config': configPayload, POST: { ok: true, result: '已应用' } });
    const { ctx, root } = await mkCtx({ config: true });
    ((await import(CONFIG)) as Any).mountConfig(ctx);
    await flush();
    calls.length = 0;

    const inp = root.findAll('trow')[0].findTag('input')!;
    for (const v of ['1', '12', '123']) {
      inp.value = v;
      inp.dispatchEvent({ type: 'change' });
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(calls.filter((c) => c.body !== undefined).length).toBe(1);
  });

  it('只读项不进提交面（read 为 null 的那批）', async () => {
    stubFetch({
      '/api/config': {
        groups: [{
          group: {
            id: 'g', owner: 'core',
            schema: { title: 'g', properties: { a: { type: 'object', title: 'A' }, b: { type: 'number', title: 'B' } } },
          },
          values: { a: { deep: 1 }, b: 5 },
        }],
      },
    });
    const { ctx, root } = await mkCtx({ config: true });
    const { mountConfig } = (await import(CONFIG)) as Any;
    mountConfig(ctx);
    await flush();
    calls.length = 0;
    vi.useFakeTimers();
    root.findAll('trow')[1].findTag('input')!.dispatchEvent({ type: 'change' });
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(calls[0].body.values).toEqual({ b: 5 });
  });

  it('没有任何声明 / 取数失败 → 各自一句空态，不是一片白', async () => {
    stubFetch({ '/api/config': { groups: [] } });
    const a = await mkCtx({ config: true });
    const { mountConfig } = (await import(CONFIG)) as Any;
    mountConfig(a.ctx);
    await flush();
    expect(a.root.textContent).toContain('未提供配置项。');

    stubFetch({}, ['/api/config']);
    const b = await mkCtx({ config: true });
    mountConfig(b.ctx);
    await flush();
    expect(b.root.textContent).toContain('配置项加载失败');
    expect(b.root.textContent).toContain('服务端说不行');
  });

  it('保存失败 → 一行红字（改一下会再试一次）', async () => {
    vi.useFakeTimers();
    stubFetch({ '/api/config': configPayload });
    const { ctx, root } = await mkCtx({ config: true });
    const { mountConfig } = (await import(CONFIG)) as Any;
    mountConfig(ctx);
    await flush();
    stubFailing(400, '这一组不认识那个键');
    root.findAll('trow')[0].findTag('input')!.dispatchEvent({ type: 'change' });
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(root.find('msgline')!.textContent).toContain('这一组不认识那个键');
    expect(root.find('msgline')!.classList.contains('bad')).toBe(true);
  });

  it('route / needsAny / 卸载后无残留', async () => {
    const { featureAvailable } = (await import(FEATURE)) as Any;
    const f = ((await import(CONFIG)) as Any).configFeature;
    expect(f.route).toBe('config');
    expect(f.label).toBe('运行参数');
    expect([f.navGroup, f.navMode]).toEqual([undefined, 'hidden']);
    expect(f.needsAny).toEqual(['config']);
    expect(featureAvailable(f, {})).toBe(false);
    expect(featureAvailable(f, { config: true })).toBe(true);

    vi.useFakeTimers();
    stubFetch({ '/api/config': configPayload });
    const { ctx, lifecycle } = await mkCtx({ config: true });
    const before = vi.getTimerCount();
    ((await import(CONFIG)) as Any).mountConfig(ctx);
    await flush();
    lifecycle.dispose();
    expect(vi.getTimerCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 存储页
// ---------------------------------------------------------------------------

const parts = [
  { key: 'events', owner: 'core', label: '事件库', kind: 'disk', location: 'data/events.jsonl', stat: '128 条', danger: true, note: '经历不可恢复' },
  { key: 'cache', owner: 'core', label: '缓存', kind: 'memory', stat: '3 项' },
  { key: 'mod-disk', owner: 'world:sample', label: 'World 落盘', kind: 'disk', stat: '1KB' },
  { key: 'mod-mem', owner: 'world:sample', label: 'World 内存', kind: 'memory', stat: '0' },
];

describe('存储页', () => {
  it('分节：框架的落盘/内存在前， World 的各自成节', async () => {
    const { storageSections } = (await import(STORAGE)) as Any;
    expect(storageSections(parts).map((s: Any) => s.title)).toEqual([
      '落盘 data/（重启后仍在）',
      '内存暂存（重启即清零）',
      'world:sample · 落盘',
      'world:sample · 内存暂存',
    ]);
    // 没有 World 存储时就只有前两节
    expect(storageSections([parts[1]]).length).toBe(2);
  });

  it('每项印规模与位置；空节不留标题', async () => {
    stubFetch({ '/api/storage': { parts } });
    const { ctx, root } = await mkCtx({ storage: true });
    const { mountStorage } = (await import(STORAGE)) as Any;
    mountStorage(ctx);
    await flush();

    expect(root.findTag('h1')!.textContent).toBe('存储');
    expect(root.findAll('strow').length).toBe(4);
    expect(root.findAll('stacklabel').length).toBe(4);
    expect(root.find('stloc')!.textContent).toBe('data/events.jsonl');
    expect(root.find('ststat')!.textContent).toBe('128 条');
    // danger 的那颗是危险配色
    expect(root.findButton('清除')!.classList.contains('danger')).toBe(true);
  });

  it('清除：危险项的确认框写的是后果，答"否"就什么都不发', async () => {
    stubFetch({ '/api/storage': { parts } });
    const { ctx, root, doc } = await mkCtx({ storage: true });
    const { mountStorage } = (await import(STORAGE)) as Any;
    mountStorage(ctx);
    await flush();
    calls.length = 0;

    root.findAll('strow')[0].findButton('清除')!.dispatchEvent({ type: 'click' });
    const modal = doc.body.find('modal')!;
    expect(modal.textContent).toContain('⚠ 危险操作：事件库');
    expect(modal.textContent).toContain('经历不可恢复');
    expect(modal.findButton('仍要继续')).not.toBeNull();
    answerConfirm(doc, false);
    await flush();
    expect(calls.length).toBe(0);
  });

  it('清除：答"是"→ key 走 URL 编码，回执落在消息行，并重取清单', async () => {
    stubFetch({ '/api/storage': { parts } });
    const { ctx, root, doc } = await mkCtx({ storage: true });
    const { mountStorage } = (await import(STORAGE)) as Any;
    mountStorage(ctx);
    await flush();
    calls.length = 0;
    stubFetch({ '/api/storage/clear': { ok: true, result: '已删 128 条' }, '/api/storage': { parts } });

    root.findAll('strow')[0].findButton('清除')!.dispatchEvent({ type: 'click' });
    answerConfirm(doc, true);
    await flush();

    expect(calls[0].url).toBe('/api/storage/clear?key=events');
    expect(root.find('msgline')!.textContent).toContain('已删 128 条');
    expect(calls.some((c) => c.url === '/api/storage')).toBe(true); // 清完重取
  });

  it('一键清空：逐项结果里有失败就报出是哪几项', async () => {
    stubFetch({ '/api/storage': { parts } });
    const { ctx, root, doc } = await mkCtx({ storage: true });
    const { mountStorage } = (await import(STORAGE)) as Any;
    mountStorage(ctx);
    await flush();
    stubFetch({
      '/api/storage/clear-all': {
        ok: false,
        results: [{ key: 'events', ok: true }, { key: 'cache', ok: false }],
      },
      '/api/storage': { parts },
    });

    root.findButton('⚠ 一键清空全部')!.dispatchEvent({ type: 'click' });
    const modal = doc.body.find('modal')!;
    expect(modal.textContent).toContain('一键清空全部存储');
    answerConfirm(doc, true);
    await flush();
    const msg = root.find('msgline')!;
    expect(msg.textContent).toContain('部分失败: cache');
    expect(msg.classList.contains('bad')).toBe(true);
  });

  it('空清单 / 取数失败 → 各自一句空态', async () => {
    stubFetch({ '/api/storage': { parts: [] } });
    const a = await mkCtx({ storage: true });
    const { mountStorage } = (await import(STORAGE)) as Any;
    mountStorage(a.ctx);
    await flush();
    expect(a.root.textContent).toContain('(服务端未挂载存储清单)');

    stubFetch({}, ['/api/storage']);
    const b = await mkCtx({ storage: true });
    mountStorage(b.ctx);
    await flush();
    expect(b.root.textContent).toContain('存储清单加载失败');
  });

  it('卸载时挂起的确认框按"没答应"收场，不会留一层遮罩', async () => {
    stubFetch({ '/api/storage': { parts } });
    const { ctx, root, doc, lifecycle } = await mkCtx({ storage: true });
    const { mountStorage } = (await import(STORAGE)) as Any;
    mountStorage(ctx);
    await flush();
    calls.length = 0;

    root.findAll('strow')[1].findButton('清除')!.dispatchEvent({ type: 'click' });
    expect(doc.body.find('modal')).not.toBeNull();
    lifecycle.dispose();
    await flush();
    expect(doc.body.find('modal')).toBeNull();
    expect(calls.length).toBe(0); // 没答应 → 一个请求都不该发出去
  });

  it('route / needsAny', async () => {
    const { featureAvailable } = (await import(FEATURE)) as Any;
    const f = ((await import(STORAGE)) as Any).storageFeature;
    expect(f.route).toBe('storage');
    expect([f.navGroup, f.navMode]).toEqual([undefined, 'hidden']);
    expect(f.needsAny).toEqual(['storage']);
    expect(featureAvailable(f, { storage: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 两页共同的规矩
// ---------------------------------------------------------------------------

describe('两页共同的规矩', () => {

  it('源码里没有裸 setInterval / setTimeout，也不碰 document.body 与 window.__', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dirs = [
      'src/web/client/features/config',
      'src/web/client/features/storage',
      'src/web/client/features/usage',
    ];
    for (const dir of dirs) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.ts')) continue;
        // 架构约束只检查可执行源码，忽略注释。
        const src = readFileSync(`${dir}/${name}`, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        expect(src, `${dir}/${name}`).not.toMatch(/(^|[^.\w])setInterval\s*\(/);
        expect(src, `${dir}/${name}`).not.toMatch(/(^|[^.\w])setTimeout\s*\(/);
        expect(src, `${dir}/${name}`).not.toMatch(/document\s*\.\s*body/);
        expect(src, `${dir}/${name}`).not.toMatch(/window\s*\.\s*__/);
        // 数据面一律走 core/api.ts
        expect(src, `${dir}/${name}`).not.toMatch(/(^|[^.\w])fetch\s*\(/);
      }
    }
  });
});
