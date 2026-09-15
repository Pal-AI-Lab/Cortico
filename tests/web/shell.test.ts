/** 验证外壳随 capabilities 与 manifest 更新导航，保留浏览器链接行为；关机和重启需两次确认。DOM 与动态 import 方式见 feature-generic.test.ts。 */

import { describe, expect, it, vi, afterEach } from 'vitest';

const SHELL = '../../src/web/client/shell/index.ts';
const UI = '../../src/web/client/ui/index.ts';

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
    const wrapped: Listener = opts?.once ? (ev): void => { this.remove(type, wrapped); fn(ev); } : fn;
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
  id = '';
  href = '';
  title = '';
  hidden = false;
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  listeners = new Listeners();
  ownText = '';
  open = false;
  readonly classList = new ClassList(this);

  constructor(tag: string, doc: FakeDoc) {
    this.tagName = tag;
    this.ownerDocument = doc;
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) { this.children = []; this.ownText = v; }

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
  removeAttribute(k: string): void { this.attrs.delete(k); }
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
}

class FakeDoc {
  title = '';
  body: FakeEl;
  // 浮层(confirm/modal)会往 document 上挂 Esc 监听:没有这两个方法开不了对话框
  listeners = new Listeners();
  constructor() { this.body = new FakeEl('body', this); }
  createElement(tag: string): FakeEl { return new FakeEl(tag, this); }
  createElementNS(_namespace: string, tag: string): FakeEl { return new FakeEl(tag, this); }
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
}

function fakeMemo(): Any {
  const store: Record<string, unknown> = {};
  return {
    get<T>(k: string, d: T): T { return k in store ? (store[k] as T) : d; },
    set(k: string, v: unknown): void { store[k] = v; },
  };
}

// ---------------------------------------------------------------------------
// 假件
// ---------------------------------------------------------------------------

/** 左键单击。修饰键与中键由浏览器自己处理，所以桩里要给全这几个字段。 */
function click(el: FakeEl, extra: Record<string, unknown> = {}): void {
  el.dispatchEvent({
    type: 'click', button: 0,
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    preventDefault: (): void => {},
    ...extra,
  });
}

function stubStatus(payload: unknown, fail = false): void {
  vi.stubGlobal('fetch', () => Promise.resolve(
    fail
      ? { ok: false, status: 500, text: () => Promise.resolve('{"error":"服务端说不行"}') }
      : { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)) },
  ));
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const route = (...segments: string[]): Any => ({ segments, query: {}, raw: `/${segments.join('/')}` });

const feature = (
  r: string,
  label: string,
  needsAny?: string[],
  navGroup?: string,
  navMode?: 'group' | 'primary' | 'world-root' | 'persona' | 'hidden',
): Any => ({
  route: r, label, needsAny, navGroup, navMode, mount: (): void => {},
});

interface Made {
  shell: Any;
  doc: FakeDoc;
  el: FakeEl;
  nav: FakeEl;
  navigated: string[][];
  life: AbortController;
}

async function mkShell(over: Record<string, unknown> = {}): Promise<Made> {
  const { createConsoleUi } = (await import(UI)) as Any;
  const { createShell } = (await import(SHELL)) as Any;
  const doc = new FakeDoc();
  const life = new AbortController();
  const ui = createConsoleUi({
    memo: fakeMemo(), overlayHost: doc.body, doc, signal: life.signal,
  });
  const navigated: string[][] = [];
  const shell = createShell({
    doc, ui,
    router: { navigate: (segs: string[]): void => { navigated.push(segs); } },
    signal: life.signal,
    onError: vi.fn(),
    ...over,
  });
  doc.body.appendChild(shell.el as unknown as FakeEl);
  const el = shell.el as unknown as FakeEl;
  return { shell, doc, el, nav: el.children[1], navigated, life };
}

/** 左栏上每一行的显示名。 */
const labels = (nav: FakeEl): string[] => nav.findAll('navitem').map((n) => n.find('lbl')!.textContent);

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 框架页那一段
// ---------------------------------------------------------------------------

describe('框架页那一段', () => {
  it('按语义分组，组内仍保持 feature 声明顺序', async () => {
    stubStatus({});
    const { nav } = await mkShell({
      features: [
        feature('live', '终端', undefined, '系统'),
        feature('config', '配置', undefined, '管理'),
        feature('usage', '用量', undefined, '系统'),
      ],
    });
    const groups = nav.findAll('navgroup');
    expect(groups.map((g) => g.find('stacklabel')!.textContent)).toEqual(['系统', '管理']);
    expect(groups.map((g) => labels(g))).toEqual([['终端', '用量'], ['配置']]);
  });

  it('终端是一级入口,World 总览是实例树入口;设置压在 Core 组底,系统提示词归 Persona & Memory 组', async () => {
    stubStatus({});
    const { nav, navigated } = await mkShell({
      features: [
        feature('live', '终端', undefined, undefined, 'primary'),
        feature('core', '运行诊断', undefined, 'Core'),
        feature('usage', '用量', undefined, 'Core'),
        feature('providers', '语言模型', undefined, 'Core'),
        feature('world', 'World 总览', ['worlds'], undefined, 'world-root'),
        feature('extensions', '扩展', undefined, 'Core'),
        feature('prompts', '系统提示词', undefined, undefined, 'persona'),
        feature('appearance', '外观', undefined, undefined, 'hidden'),
        feature('settings', '设置', undefined, 'Core'),
      ],
      capabilities: { worlds: true },
    });

    expect(nav.children.length).toBe(4);
    expect(nav.children[0].classList.contains('navgroup-primary')).toBe(true);
    expect(labels(nav.children[0])).toEqual(['终端']);
    const core = nav.children[1];
    expect(core.find('stacklabel')!.textContent).toBe('Core');
    // 组内按声明顺序;设置声明在最末,所以压组底
    expect(labels(core)).toEqual(['运行诊断', '用量', '语言模型', '扩展', '设置']);
    const persona = nav.children[2];
    expect(persona.find('stacklabel')!.textContent).toBe('Persona & Memory');
    expect(labels(persona)).toEqual(['系统提示词']);
    expect(nav.children[3].classList.contains('navgroup-world-tree')).toBe(true);
    click(core.findAll('navitem')[4]);
    expect(navigated).toEqual([['settings']]);
  });

  it('按 needsAny 过滤：没挂的表面根本不出现在导航里', async () => {
    stubStatus({});
    const { nav } = await mkShell({
      features: [
        feature('alpha', '甲页', undefined, '系统'), // 无 needsAny = 永远可用
        feature('beta', '乙页', ['beta'], '系统'),
        feature('gamma', '丙页', ['gamma', 'delta'], '系统'), // 任一满足即可
      ],
      capabilities: { beta: false, delta: true },
    });
    expect(labels(nav)).toEqual(['甲页', '丙页']);
  });

  it('capabilities 晚到 → setCapabilities 重排,原先被判"没挂"的那页补进来', async () => {
    stubStatus({});
    const { shell, nav } = await mkShell({
      features: [feature('alpha', '甲页', ['alpha'], '系统')],
    });
    expect(labels(nav)).toEqual([]);
    shell.setCapabilities({ alpha: true });
    expect(labels(nav)).toEqual(['甲页']);
  });

  it('跳转经 router,href 也照 feature.route 拼好（中键/新标签页白拿）', async () => {
    stubStatus({});
    const { nav, navigated } = await mkShell({ features: [feature('alpha', '甲页', undefined, '系统')] });
    const item = nav.findAll('navitem')[0];
    expect(item.href).toBe('#/alpha');
    click(item);
    expect(navigated).toEqual([['alpha']]);
  });

  it('修饰键与中键不拦：那是"在新标签页打开",不该被 router 吃掉', async () => {
    stubStatus({});
    const { nav, navigated } = await mkShell({ features: [feature('alpha', '甲页', undefined, '系统')] });
    const item = nav.findAll('navitem')[0];
    click(item, { ctrlKey: true });
    click(item, { button: 1 });
    expect(navigated).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// provider 那一段
// ---------------------------------------------------------------------------

const providers = [
  {
    id: 'world:sample', kind: 'world', label: '样例 World', availability: 'active',
    lamps: [
      { label: '甲链路', state: 'online', hint: '在线 3 人' },
      { label: '乙链路', state: 'offline' },
    ],
    badges: [{ label: '在线', value: 3, tone: 'on' }],
  },
  { id: 'world:idle', kind: 'world', label: '未载入的', availability: 'inactive' },
  { id: 'world:absent', kind: 'world', label: '没实现的', availability: 'missing', reason: '本地没装' },
  { id: 'persona:demo', kind: 'persona', label: '样例人格', availability: 'active' },
];

describe('provider 那一段', () => {
  it('只列 active；未载入 / 没实现的不进左栏', async () => {
    stubStatus({});
    const { nav } = await mkShell({ pages: providers });
    expect(labels(nav)).toEqual(['样例人格', '样例 World']);
    expect(nav.findAll('stacklabel').map((label) => label.textContent)).toEqual(['Persona & Memory', 'World']);
    expect(nav.find('navmodule-list')!.getAttribute('aria-label')).toBe('World 实例');
  });

  it('memory 页跟在 persona 页后面,同一组;manifest 里的先后不算数', async () => {
    stubStatus({});
    const { nav } = await mkShell({
      pages: [
        { id: 'memory:demo', kind: 'memory', label: 'GitMem', availability: 'active' },
        { id: 'persona:demo', kind: 'persona', label: '样例人格', availability: 'active' },
      ],
    });
    expect(labels(nav.find('navgroup-persona')!)).toEqual(['样例人格', 'GitMem']);
  });

  it('navMode persona 的框架页排在 Persona 页与 Memory 页之后,同一组', async () => {
    stubStatus({});
    const { nav } = await mkShell({
      features: [feature('prompts', '系统提示词', undefined, undefined, 'persona')],
      pages: [
        { id: 'persona:demo', kind: 'persona', label: '样例人格', availability: 'active' },
        { id: 'memory:demo', kind: 'memory', label: 'GitMem', availability: 'active' },
      ],
    });
    expect(labels(nav.find('navgroup-persona')!)).toEqual(['样例人格', 'GitMem', '系统提示词']);
  });

  it('跳 #/provider/<id>，冒号按 URL 编码（协议要求调用方自己编）', async () => {
    stubStatus({});
    const { nav, navigated } = await mkShell({ pages: providers });
    const [first, second] = nav.findAll('navitem');
    expect(first.href).toBe(`#/provider/${encodeURIComponent('persona:demo')}`);
    expect(first.href).toBe('#/provider/persona%3Ademo');
    expect(second.href).toBe('#/provider/world%3Asample');
    click(second);
    expect(navigated).toEqual([['provider', 'world:sample']]);
  });

  it('provider 行只有名字与那一排灯：徽标那种小字不进左栏', async () => {
    stubStatus({});
    const { nav } = await mkShell({ pages: providers });
    const module = nav.findAll('navitem')[1];
    expect(module.textContent).toBe('样例 World');
    const dots = module.findAll('navdot');
    expect(dots.map((d) => d.className)).toEqual(['navdot on', 'navdot']);
    expect(dots[0].getAttribute('aria-label')).toBe('甲链路 正常 · 在线 3 人');
    expect(dots[1].getAttribute('aria-label')).toBe('乙链路 未启用');
  });

  it('没报灯的 provider 行不画灯（灰灯是"关着"，不能拿它讲"没报"）', async () => {
    stubStatus({});
    const { nav } = await mkShell({ pages: providers });
    const row = nav.findAll('navitem')[0].find('navlamps')!;
    expect(row.hidden).toBe(true);
    expect(row.findAll('navdot')).toEqual([]);
  });

  it('setLamps 只改灯，不重排导航（这是每秒两次的调用）', async () => {
    stubStatus({});
    const { shell, nav } = await mkShell({ pages: providers });
    const before = nav.findAll('navitem');
    const dotsBefore = before[1].findAll('navdot');
    shell.setLamps({
      'world:sample': [
        { label: '甲链路', state: 'error', hint: '连不上' },
        { label: '乙链路', state: 'online' },
      ],
    });
    expect(nav.findAll('navitem')).toEqual(before); // 同一批行，没重建
    const dots = before[1].findAll('navdot');
    expect(dots).toEqual(dotsBefore); // 数目没变，连点本身都是原来那几个
    expect(dots.map((d) => d.className)).toEqual(['navdot bad', 'navdot on']);
    expect(dots[0].getAttribute('aria-label')).toBe('甲链路 故障 · 连不上');
  });

  it('灯的条数变了就重排那一排（World 多接了一条链路）', async () => {
    stubStatus({});
    const { shell, nav } = await mkShell({ pages: providers });
    shell.setLamps({ 'world:sample': [{ label: '丙链路', state: 'loading' }] });
    const dots = nav.findAll('navitem')[1].findAll('navdot');
    expect(dots.map((d) => d.className)).toEqual(['navdot warn']);
    expect(dots[0].getAttribute('aria-label')).toBe('丙链路 启动中');
  });

  it('灯的读数比 manifest 那一帧新：重排之后不退回旧值', async () => {
    stubStatus({});
    const { shell, nav } = await mkShell({ pages: providers });
    shell.setLamps({ 'world:sample': [{ label: '甲链路', state: 'loading' }] });
    shell.setPages(providers);
    expect(nav.findAll('navitem')[1].findAll('navdot').map((d) => d.className))
      .toEqual(['navdot warn']);
  });

  it('manifest 晚到 / 变了 → setPages 重排,两段顺序不乱', async () => {
    stubStatus({});
    const { shell, nav } = await mkShell({ features: [feature('alpha', '甲页', undefined, '系统')] });
    expect(labels(nav)).toEqual(['甲页']);
    shell.setPages(providers);
    expect(labels(nav)).toEqual(['甲页', '样例人格', '样例 World']);
    expect(nav.findAll('stacklabel').length).toBe(3);
    shell.setPages([]);
    expect(labels(nav)).toEqual(['甲页']);
    expect(nav.findAll('stacklabel').length).toBe(1);
  });

  it('供应模块(kind llm)不逐个进左栏:它们的入口是框架的「语言模型」页', async () => {
    stubStatus({});
    const { shell, nav } = await mkShell({ features: [feature('alpha', '甲页', undefined, '系统')] });
    shell.setPages([
      ...providers,
      { id: 'llm:alpha', kind: 'llm', label: '甲供应', availability: 'active', lamps: [] },
      { id: 'llm:beta', kind: 'llm', label: '乙供应', availability: 'active', lamps: [] },
    ]);
    expect(labels(nav)).toEqual(['甲页', '样例人格', '样例 World']);
    expect(nav.findAll('stacklabel').length).toBe(3);
  });

  it('框架页与人格入口带图标， World 实例保持纯文字', async () => {
    stubStatus({});
    const { nav } = await mkShell({
      features: [{ ...feature('live', '终端', undefined, '系统'), icon: 'terminal' }],
      pages: providers,
    });
    const items = nav.findAll('navitem');
    expect(items[0].find('navicon')).not.toBe(null);
    expect(items[1].find('navicon')).not.toBe(null);
    expect(items[2].find('navicon')).toBe(null);
  });

  it('Persona排在 World 树之前， World 总览与实例保持同一共同区域', async () => {
    stubStatus({});
    const { nav } = await mkShell({
      features: [feature('world', 'World 总览', ['worlds'], undefined, 'world-root')],
      capabilities: { worlds: true },
      pages: providers,
    });
    expect(labels(nav)).toEqual(['样例人格', 'World 总览', '样例 World']);
    const tree = nav.find('navgroup-world-tree')!;
    expect(tree.find('stacklabel')!.textContent).toBe('World');
    expect(labels(tree)).toEqual(['World 总览', '样例 World']);
    expect(tree.find('navmodule-list')!.find('navicon')).toBe(null);
  });
});

describe('底部运行控制', () => {
  it('按当前暂停态调用 pause / resume，并立即切换按钮语义', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', (url: unknown) => {
      seen.push(String(url));
      const payload = String(url) === '/api/status'
        ? { loop: { paused: false } }
        : { paused: true, result: '已暂停' };
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)) });
    });
    const { el } = await mkShell({ capabilities: { run: true } });
    await flush();
    const run = el.findAll('rail-action')[0];
    expect(run.getAttribute('aria-label')).toBe('暂停运行');
    click(run);
    await flush();
    expect(seen).toEqual(['/api/status', '/api/run/pause']);
    expect(run.getAttribute('aria-label')).toBe('继续运行');
  });

  // 关机等待装配层返回各步骤结果。

  const shutdownBtn = (el: FakeEl): FakeEl => el.find('rail-shutdown') as FakeEl;

  /** 查找 danger 模式的继续按钮。 */
  const proceed = async (doc: FakeDoc): Promise<void> => {
    const ok = doc.body.findAll('btn').find((b) => b.textContent === '仍要继续') as FakeEl;
    ok.dispatchEvent({ type: 'click' });
    await flush();
  };

  it('关机接口没挂就整个不画;capabilities 晚到再补出来', async () => {
    stubStatus({});
    const { shell, el } = await mkShell({ capabilities: { run: true } });
    expect(shutdownBtn(el).hidden).toBe(true);
    shell.setCapabilities({ run: true, shutdown: true });
    expect(shutdownBtn(el).hidden).toBe(false);
    expect(shutdownBtn(el).getAttribute('aria-label')).toBe('关机');
  });

  it('要过两道确认才发 POST,逐步结果摊在最后一屏的对话框里', async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal('fetch', (url: unknown, init?: { method?: string }) => {
      seen.push({ url: String(url), ...(init?.method ? { method: init.method } : {}) });
      const payload = String(url) === '/api/run/shutdown'
        ? {
            ok: false,
            localComplete: false,
            result: '收尾完成,但有 1 步没走完:托管 LLM server 停机',
            steps: [
              { label: '按住事件投递', ok: true, ms: 2 },
              { label: 'World 收尾(托管的外部进程与存档都在这一步)', ok: true, ms: 4200 },
              { label: '托管 LLM server 停机', ok: false, ms: 3000, detail: '超时(3秒)' },
            ],
          }
        : {};
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)) });
    });
    const { doc, el } = await mkShell({ capabilities: { run: true, shutdown: true } });
    await flush();
    const sent = (): boolean => seen.some((c) => c.url === '/api/run/shutdown');

    click(shutdownBtn(el));
    await flush();
    // 一道确认还不够:这一步之后不该已经发出去
    expect(sent()).toBe(false);
    await proceed(doc);
    expect(sent()).toBe(false);
    await proceed(doc);

    expect(seen.find((c) => c.url === '/api/run/shutdown')?.method).toBe('POST');
    const body = doc.body.textContent;
    expect(body).toContain('World 收尾');
    expect(body).toContain('✗ 托管 LLM server 停机');
    expect(body).toContain('超时(3秒)');
  });

  it('本地步骤全过但外部未确认时，最终标题不误报成本地步骤失败', async () => {
    vi.stubGlobal('fetch', (url: unknown) => {
      const payload = String(url) === '/api/run/shutdown'
        ? {
            ok: false,
            localComplete: true,
            result: '本地关机完成(4 步全部走完)；[P0] B 站直播间=still-live。',
            steps: [
              { label: '按住事件投递', ok: true, ms: 2 },
              { label: 'World 收尾', ok: true, ms: 100 },
            ],
            externalChecks: [{ status: 'still-live' }],
          }
        : {};
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)) });
    });
    const { doc, el } = await mkShell({ capabilities: { run: true, shutdown: true } });
    await flush();
    click(shutdownBtn(el));
    await flush();
    await proceed(doc);
    await proceed(doc);

    const body = doc.body.textContent;
    expect(body).toContain('本地已关机,外部状态未确认');
    expect(body).not.toContain('有步骤没走完');
    expect(body).toContain('[P0]');
  });

  it('第一道就取消:什么也不发', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', (url: unknown) => {
      seen.push(String(url));
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    });
    const { doc, el } = await mkShell({ capabilities: { run: true, shutdown: true } });
    await flush();
    click(shutdownBtn(el));
    await flush();
    const cancel = doc.body.findAll('btn').find((b) => b.textContent === '取消') as FakeEl;
    cancel.dispatchEvent({ type: 'click' });
    await flush();
    expect(seen.some((u) => u === '/api/run/shutdown')).toBe(false);
  });


  const restartBtn = (el: FakeEl): FakeEl => el.find('rail-restart') as FakeEl;

  it('重启键按能力位显示，未受监督时提示手动启动', async () => {
    stubStatus({});
    const { shell, el } = await mkShell({ capabilities: { run: true, shutdown: true } });
    expect(restartBtn(el).hidden).toBe(true);
    shell.setCapabilities({ run: true, shutdown: true, restart: true });
    expect(restartBtn(el).hidden).toBe(false);
    expect(restartBtn(el).getAttribute('aria-label')).toBe('重启');
    expect(restartBtn(el).title).toContain('手动启动');
    shell.setCapabilities({ run: true, shutdown: true, restart: true, supervised: true });
    expect(restartBtn(el).title).not.toContain('手动启动');
  });

  it('重启也要过两道确认才打 /api/run/restart;关机端点一次都不碰', async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal('fetch', (url: unknown, init?: { method?: string }) => {
      seen.push({ url: String(url), ...(init?.method ? { method: init.method } : {}) });
      const payload = String(url) === '/api/run/restart'
        ? { ok: true, localComplete: true, result: '本地关机完成,进程即将退出,启动器随即重新拉起', steps: [{ label: '按住事件投递', ok: true, ms: 2 }] }
        : {};
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)) });
    });
    const { doc, el } = await mkShell({ capabilities: { run: true, shutdown: true, restart: true, supervised: true } });
    await flush();
    click(restartBtn(el));
    await flush();
    expect(seen.some((c) => c.url === '/api/run/restart')).toBe(false);
    await proceed(doc);
    expect(seen.some((c) => c.url === '/api/run/restart')).toBe(false);
    await proceed(doc);
    expect(seen.find((c) => c.url === '/api/run/restart')?.method).toBe('POST');
    expect(seen.some((c) => c.url === '/api/run/shutdown')).toBe(false);
    expect(doc.body.textContent).toContain('✓ 按住事件投递');
  });

  it('未受监督的进程提示手动重新启动', async () => {
    stubStatus({});
    const { doc, el } = await mkShell({ capabilities: { run: true, restart: true } });
    await flush();
    click(restartBtn(el));
    await flush();
    expect(doc.body.textContent).toContain('手动重新启动');
  });
});

// ---------------------------------------------------------------------------
// 高亮
// ---------------------------------------------------------------------------

describe('当前项高亮', () => {
  async function mk(): Promise<Made> {
    stubStatus({});
    return mkShell({ features: [feature('alpha', '甲页', undefined, '系统'), feature('beta', '乙页', undefined, '系统')], pages: providers });
  }
  const active = (nav: FakeEl): string[] =>
    nav.findAll('navitem').filter((n) => n.classList.contains('active')).map((n) => n.find('lbl')!.textContent);

  it('框架页：只亮当前那一条', async () => {
    const { shell, nav } = await mk();
    shell.setRoute(route('beta'));
    expect(active(nav)).toEqual(['乙页']);
    shell.setRoute(route('alpha'));
    expect(active(nav)).toEqual(['甲页']);
  });

  it('provider 路由亮到对应那一项，而不是全都不亮', async () => {
    const { shell, nav } = await mk();
    shell.setRoute(route('provider', 'world:sample'));
    expect(active(nav)).toEqual(['样例 World']);
    expect(nav.findAll('navitem')[3].getAttribute('aria-current')).toBe('page');
  });

  it('页内子页签（多出来的那一段）不会把高亮弄掉', async () => {
    const { shell, nav } = await mk();
    shell.setRoute(route('alpha', 'sub'));
    expect(active(nav)).toEqual(['甲页']);
    shell.setRoute(route('provider', 'persona:demo', 'panel'));
    expect(active(nav)).toEqual(['样例人格']);
  });

  it('没人认领的路由 → 一条都不亮，也不残留 aria-current', async () => {
    const { shell, nav } = await mk();
    shell.setRoute(route('provider', 'world:sample'));
    shell.setRoute(route('nobody'));
    expect(active(nav)).toEqual([]);
    expect(nav.findAll('navitem').every((n) => n.getAttribute('aria-current') === null)).toBe(true);
  });

  it('重排之后高亮还在（换 manifest 不该把当前位置抹掉）', async () => {
    const { shell, nav } = await mk();
    shell.setRoute(route('provider', 'persona:demo'));
    shell.setPages(providers);
    expect(active(nav)).toEqual(['样例人格']);
  });
});

// ---------------------------------------------------------------------------
// 品牌名 / 连接状态
// ---------------------------------------------------------------------------

describe('品牌名', () => {
  it('来自 /api/status 的 displayName，顺带改页面标题', async () => {
    stubStatus({ displayName: '示例' });
    const { el, doc } = await mkShell();
    expect(el.find('name')!.textContent).toBe('bot');   // 到手之前是中性缺省
    await flush();
    expect(el.find('name')!.textContent).toBe('示例');
    expect(doc.title).toBe('控制台 · 示例');
  });

  it('拿不到 / 空串 → 留中性缺省，不报错卡', async () => {
    stubStatus(null, true);
    const { el } = await mkShell();
    await flush();
    expect(el.find('name')!.textContent).toBe('bot');

    stubStatus({ displayName: '   ' });
    const b = await mkShell();
    await flush();
    expect(b.el.find('name')!.textContent).toBe('bot');
  });

  it('调用方也能直接告知（已经拿过 status 的场合）', async () => {
    stubStatus({});
    const { shell, el } = await mkShell();
    shell.setBrand('示例');
    expect(el.find('name')!.textContent).toBe('示例');
    shell.setBrand(null);
    expect(el.find('name')!.textContent).toBe('bot');
  });
});

describe('连接状态', () => {
  it('外壳自己不探活：造好之后除了 /api/status 一个请求都不发', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', (url: unknown) => {
      seen.push(String(url));
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    });
    const { shell } = await mkShell({ pages: providers });
    await flush();
    shell.setRoute(route('provider', 'world:sample'));
    await flush();
    expect(seen).toEqual(['/api/status']);
  });
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

describe('生命周期', () => {
  it('dispose 后监听归零，节点也从文档里摘掉', async () => {
    stubStatus({});
    const { shell, doc, el, nav, navigated } = await mkShell({
      features: [feature('alpha', '甲页', undefined, '系统')], pages: providers,
    });
    const items = nav.findAll('navitem');
    expect(items.length).toBe(3);
    expect(items.reduce((n, i) => n + i.countListeners('click'), 0)).toBe(3);

    shell.dispose();
    expect(items.reduce((n, i) => n + i.countListeners('click'), 0)).toBe(0);
    expect(doc.body.children).not.toContain(el);
    click(items[0]);
    expect(navigated).toEqual([]);
  });

  it('传进来的 signal abort 等同于 dispose', async () => {
    stubStatus({});
    const { nav, life, navigated } = await mkShell({ features: [feature('alpha', '甲页', undefined, '系统')] });
    const item = nav.findAll('navitem')[0];
    life.abort();
    expect(item.countListeners('click')).toBe(0);
    click(item);
    expect(navigated).toEqual([]);
  });

  it('反复重排不攒监听：摘掉的那茬当场归零', async () => {
    stubStatus({});
    const { shell, nav } = await mkShell({ pages: providers });
    const stale = nav.findAll('navitem')[0];
    shell.setPages(providers);
    expect(stale.countListeners('click')).toBe(0);
    expect(nav.findAll('navitem').reduce((n, i) => n + i.countListeners('click'), 0)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 源码扫描
// ---------------------------------------------------------------------------

describe('外壳源码的规矩', () => {
  it('外壳没有裸定时器、自备 fetch 与全局 DOM', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = 'src/web/client/shell';
    const names = readdirSync(dir).filter((n) => n.endsWith('.ts'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const raw = readFileSync(`${dir}/${name}`, 'utf8');
      // 架构约束只检查可执行源码，忽略注释。
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(src, name).not.toMatch(/(^|[^.\w])setInterval\s*\(/);
      expect(src, name).not.toMatch(/(^|[^.\w])setTimeout\s*\(/);
      expect(src, name).not.toMatch(/(^|[^.\w])fetch\s*\(/);
      expect(src, name).not.toMatch(/document\s*\.\s*body/);
      expect(src, name).not.toMatch(/window\s*\.\s*__/);
    }
  });
});
