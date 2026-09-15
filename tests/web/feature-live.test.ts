/**
 * 终端页使用变量形式的动态 import，避免根 tsconfig 将 DOM 代码拉入 Node 检查；浏览器类型由 tsconfig.web.json 检查。
 * 迷你 DOM 实现 addEventListener 的 signal 选项，保证卸载后的监听计数有效。
 * WebSocket 及其退避定时器、fetch 和 fork 轮询时钟均可控。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { responseTimelineFixture } from './response-timeline-fixture.ts';
import { records } from '../core/fixture-protocol.ts';
import {record,message,functionCall,functionResult}from'../../src/protocol/open-responses/context.ts';
import {estimateMessagesTokens}from'../../src/protocol/open-responses/tokens.ts';

const UI_ENTRY = '../../src/web/client/ui/index.ts';
const LIFECYCLE_ENTRY = '../../src/web/client/core/lifecycle.ts';
const ROUTER_ENTRY = '../../src/web/client/core/router.ts';
const LIVE_ENTRY = '../../src/web/client/features/live/index.ts';
const CONTEXT_ENTRY = '../../src/web/client/features/live/context.ts';
const FEATURE_ENTRY = '../../src/web/client/features/feature.ts';

type Any = any;

const { createConsoleUi } = (await import(UI_ENTRY)) as Any;
const { Lifecycle } = (await import(LIFECYCLE_ENTRY)) as Any;
const { Router, parseHash } = (await import(ROUTER_ENTRY)) as Any;
const live = (await import(LIVE_ENTRY)) as Any;
const cx = (await import(CONTEXT_ENTRY)) as Any;
const { featureAvailable } = (await import(FEATURE_ENTRY)) as Any;

// ---------------------------------------------------------------------------
// 迷你 DOM 桩
// ---------------------------------------------------------------------------

type Listener = (ev: Any) => void;
interface ListenOptions {
  signal?: AbortSignal;
  once?: boolean;
}

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
  total(): number {
    let n = 0;
    for (const arr of this.map.values()) n += arr.length;
    return n;
  }
}

class FakeEl {
  readonly tagName: string;
  readonly ownerDocument: FakeDoc;
  readonly nodeType = 1;
  className = '';
  type = '';
  open = false;
  value = '';
  checked = false;
  rows = 0;
  colSpan = 1;
  disabled = false;
  placeholder = '';
  title = '';
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  listeners = new Listeners();
  ownText = '';
  scrollTop = 0;
  scrolledIntoView = false;
  scrollHeight = 0;
  clientHeight = 0;
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
  replaceChildren(...nodes: FakeEl[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.ownText = '';
    this.append(...nodes);
  }
  scrollIntoView(): void { this.scrolledIntoView = true; }
  insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, node);
    else this.children.push(node);
    return node;
  }
  replaceWith(node: FakeEl): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this.parent;
    this.parent.children.splice(i, 1, node);
    this.parent = null;
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
  }
  focus(): void {}
  select(): void {}
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.remove(type, fn);
  }
  dispatchEvent(ev: Any): void {
    if (ev.target === undefined) ev.target = this;
    let node: FakeEl | null = this;
    while (node) {
      node.listeners.fire(ev.type, ev);
      node = node.parent;
    }
  }
  countListeners(type: string): number {
    return this.listeners.count(type);
  }
  /** 整棵子树上还挂着多少监听(测试自用) */
  totalListeners(): number {
    return this.children.reduce((n, c) => n + c.totalListeners(), this.listeners.total());
  }
  /** 递归找第一个 class 含某个词的后代 */
  find(cls: string): FakeEl | null {
    for (const c of this.children) {
      if (c.className.split(' ').includes(cls)) return c;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
  /** 递归找所有 class 含某个词的后代 */
  findAll(cls: string, out: FakeEl[] = []): FakeEl[] {
    for (const c of this.children) {
      if (c.className.split(' ').includes(cls)) out.push(c);
      c.findAll(cls, out);
    }
    return out;
  }
}

class FakeDoc {
  listeners = new Listeners();
  body: FakeEl;
  title = '';
  defaultView: Any = undefined;
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
  countListeners(type: string): number {
    return this.listeners.count(type);
  }
}

// ---------------------------------------------------------------------------
// 假 WebSocket 环境
// ---------------------------------------------------------------------------

class FakeSocket {
  private messageOffsets: number[] = [];
  private itemCount = 0;
  readyState = 0;
  closed = false;
  onopen: Any = null;
  onclose: Any = null;
  onerror: Any = null;
  onmessage: Any = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  /** 连上 */
  up(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  /** 推一帧 */
  emit(frame: unknown): void {
    const input = frame as Any;
    const encoded = { ...input };
    for (const field of ['session', 'messages', 'head']) {
      if (!Array.isArray(input[field])) continue;
      encoded[field] = records(input[field]);
      if (field !== 'head') {
        this.messageOffsets = []; this.itemCount = 0;
        for (const entry of input[field]) { this.messageOffsets.push(this.itemCount); this.itemCount += records([entry]).length; }
      }
    }
    if (input.t === 'session.append') {
      const index = this.messageOffsets[input.index] ?? this.itemCount + input.index - this.messageOffsets.length;
      const items = records([input.message]);
      if (input.index === this.messageOffsets.length) { this.messageOffsets.push(this.itemCount); this.itemCount += items.length; }
      items.forEach((message, offset) => this.onmessage?.({ data: JSON.stringify({ ...encoded, index: index + offset, message }) }));
    } else this.onmessage?.({ data: JSON.stringify(encoded) });
  }
  /** 推一段坏文本 */
  emitRaw(text: string): void {
    this.onmessage?.({ data: text });
  }
}

function fakeEnv() {
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, () => void>();
  let seq = 0;
  return {
    sockets,
    timers,
    env: {
      wsUrl: (p: string) => `ws://test${p}`,
      createSocket: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      setTimer: (fn: () => void) => {
        seq += 1;
        timers.set(seq, fn);
        return seq;
      },
      clearTimer: (id: number) => {
        timers.delete(id);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 假 fetch / 假 FeatureContext
// ---------------------------------------------------------------------------

const fetched: string[] = [];

function stubFetch(reply: (url: string) => unknown): void {
  vi.stubGlobal('fetch', (url: unknown) => {
    fetched.push(String(url));
    const raw = reply(String(url)) as Any;
    const body = raw?.messages ? { ...raw, messages: records(raw.messages) } : raw;
    return Promise.resolve(
      new Response(JSON.stringify(body ?? {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

function fakeWin(hash = '#/live'): Any {
  const listeners = new Listeners();
  return {
    location: { hash },
    addEventListener: (t: string, fn: Listener) => listeners.add(t, fn),
    removeEventListener: (t: string, fn: Listener) => listeners.remove(t, fn),
  };
}

interface Ctx {
  ctx: Any;
  doc: FakeDoc;
  root: FakeEl;
  lifecycle: Any;
  errors: unknown[];
}

function mkCtx(capabilities: Record<string, boolean>, hash = '#/live'): Ctx {
  const doc = new FakeDoc();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  const errors: unknown[] = [];
  const lifecycle = new Lifecycle((e: unknown) => errors.push(e));
  const store: Record<string, unknown> = {};
  const memo = {
    get: <T,>(k: string, d: T): T => (k in store ? (store[k] as T) : d),
    set: (k: string, v: unknown): void => {
      store[k] = v;
    },
  };
  const ui = createConsoleUi({ memo, overlayHost: doc.body, doc, signal: lifecycle.signal });
  ui.promptInput = (opts: Any): Any => {
    const el = ui.h('div', 'prompt-input-host');
    el.appendChild(ui.h('textarea', 'prompt-textarea'));
    if (opts.tools) el.appendChild(opts.tools);
    return { el, focus: (): void => {}, setDisabled: (): void => {} };
  };
  const router = new Router({ win: fakeWin(hash), confirmLeave: async () => true });
  const ctx = {
    root,
    lifecycle,
    signal: lifecycle.signal,
    ui,
    router,
    route: parseHash(hash),
    capabilities,
    onError: (e: unknown) => errors.push(e),
  };
  return { ctx, doc, root, lifecycle, errors };
}

/**
 * 让挂起的 promise 链跑完。
 *
 * 用 `setImmediate` 而不是数几个微任务:`Response.text()` 那条链在 undici 里要过
 * 一趟宏任务,数微任务数不到头。所以下面的假时钟**故意不接管 `setImmediate`**——
 * 它是这里唯一还需要真的跑起来的那一档。
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  fetched.length = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ===========================================================================
// 纯函数
// ===========================================================================

describe('上下文占用 · 纯计算', () => {
  it('estTok:中日韩按 0.6、其余按 0.3,向上取整', () => {
    expect(cx.estTok('')).toBe(0);
    expect(cx.estTok(null)).toBe(0);
    expect(cx.estTok('你好')).toBe(2); // ceil(1.2)
    expect(cx.estTok('abc')).toBe(1); // ceil(0.9)
    expect(cx.estTok('你好abc')).toBe(3); // ceil(1.2+0.9)
  });

  it('jsonTok:空值给 0,其余按序列化后的字数算', () => {
    expect(cx.jsonTok(null)).toBe(0);
    expect(cx.jsonTok(undefined)).toBe(0);
    expect(cx.jsonTok({ a: 1 })).toBe(cx.estTok('{"a":1}'));
  });

  it('parsePrefixSegments:按 ━━━ 段名 ━━━ 切开,前言归 (前言)', () => {
    const seg = cx.parsePrefixSegments('开场白\n━━━ ORIENTATION ━━━\nhello\n━━━ 记忆 ━━━\nmemo');
    expect(Object.keys(seg)).toEqual(['(前言)', 'ORIENTATION', '记忆']);
    expect(seg['(前言)']).toBe('开场白');
    expect(seg['ORIENTATION']).toBe('hello');
    expect(seg['记忆']).toBe('memo');
    expect(cx.parsePrefixSegments('')).toEqual({});
  });

  it('computeCtx:空 session 给 null;分类之和等于总量', () => {
    expect(cx.computeCtx({ messages: [], toolSchemas: [], status: null })).toBe(null);
    const sys = '━━━ ORIENTATION ━━━\nhello\n━━━ 记忆 ━━━\nmemo';
    const d = cx.computeCtx({
      messages: records([
        { role: 'system', content: sys },
        { role: 'assistant', content: 'hi', reasoning_content: '想想' },
        { role: 'tool', content: '回执', tool_call_id: 'c1' },
      ]),
      toolSchemas: [{ name: 'look', description: 'look', parameters: { type: 'object' } }],
      status: { loop: { context: { maxTokens: 1000, softRatio: 0.5 } } },
    });
    const by = (k: string): number => d.cats.find((c: Any) => c.key === k).tok;
    expect(by('orient')).toBe(cx.estTok('hello'));
    expect(by('memory')).toBe(cx.estTok('memo'));
    expect(by('reasoning')).toBe(cx.estTok('想想') + 8);
    expect(by('toolsSchema')).toBeGreaterThan(0);
    expect(by('toolIO')).toBe(cx.estTok('回执') + 8);
    expect(d.total).toBe(d.cats.reduce((s: number, c: Any) => s + c.tok, 0));
    expect(d.maxTokens).toBe(1000);
    expect(d.softRatio).toBe(0.5);
    expect(d.toolCount).toBe(1);
  });

  it('标准 Item 的分类使用运行时估算，包含加密推理并完整移除历史 reasoning Item',async()=>{
    const entries=[message('system','prefix'),record({type:'reasoning',id:'r',summary:[],encrypted_content:'opaque'.repeat(100),content:[{type:'reasoning_text',text:'think'}]}),functionCall('c','inspect','{}'),functionResult('c','done')];
    const input={messages:entries,toolSchemas:[],status:{context:{keepPastThinking:true}}};
    expect(cx.computeCtx(input).total).toBe(estimateMessagesTokens(entries));
    input.status.context.keepPastThinking=false;
    expect(cx.computeCtx(input).total).toBe(estimateMessagesTokens(entries.filter(entry=>entry.item.type!=='reasoning')));
    expect(cx.computeCtx(input).strippedThinking).toBe(estimateMessagesTokens([entries[1]]));
  });

  it('computeCtx:丢弃历史思维链时按丢弃后算,并报出省下的量', () => {
    const messages = records([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: '', reasoning_content: '很长的一段思考' },
      { role: 'assistant', content: '', reasoning_content: '最近这轮' },
    ]);
    const dropped = cx.computeCtx({
      messages,
      toolSchemas: [],
      status: { context: { keepPastThinking: false } },
    });
    expect(dropped.cats.find((c: Any) => c.key === 'reasoning').tok).toBe(0);
    expect(dropped.keepOn).toBe(false);
    expect(dropped.strippedThinking).toBe(estimateMessagesTokens(messages.filter(entry => entry.item.type === 'reasoning')));

    // 保留是缺省:占用里照常计思维链,省下的量为 0
    const kept = cx.computeCtx({ messages, toolSchemas: [], status: { context: {} } });
    expect(kept.cats.find((c: Any) => c.key === 'reasoning').tok).toBe(
      estimateMessagesTokens(messages.filter(entry => entry.item.type === 'reasoning')),
    );
    expect(kept.keepOn).toBe(true);
    expect(kept.strippedThinking).toBe(0);
  });

  it('fork 继承的合成开头保留推理，空系统 Item 的结构开销仍计入上下文', () => {
    const reasoning = responseTimelineFixture().entries[4];
    const synthetic = { ...reasoning, context: { ...reasoning.context, head: true as const } };
    const session = [message('system', ''), synthetic, reasoning];
    const result = cx.computeCtx({ messages: session, toolSchemas: [], status: { context: { keepPastThinking: false } } });
    expect(result.total).toBe(estimateMessagesTokens(session.slice(0, 2)));
    expect(result.strippedThinking).toBe(estimateMessagesTokens([reasoning]));
    expect(result.cats.find((cat: Any) => cat.key === 'head').tok).toBe(estimateMessagesTokens([synthetic]));
  });
});

// ===========================================================================
// feature 声明
// ===========================================================================

describe('live feature 声明', () => {
  it('认领 live 路由,两条通道任一挂着就有意义', () => {
    expect(live.liveFeature.route).toBe('live');
    expect(live.liveFeature.label).toBe('终端');
    expect([...live.liveFeature.needsAny]).toEqual(['debug', 'sessions']);
    expect(featureAvailable(live.liveFeature, { debug: true, sessions: false })).toBe(true);
    expect(featureAvailable(live.liveFeature, { debug: false, sessions: true })).toBe(true);
    expect(featureAvailable(live.liveFeature, { debug: false, sessions: false })).toBe(false);
  });
});

// ===========================================================================
// 挂载
// ===========================================================================

describe('live feature 挂载', () => {
  it('画出两层顶栏、时间线与带分类圆环的输入器', () => {
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);

    expect(root.find('liveband')).not.toBe(null);
    expect(root.find('chips')).not.toBe(null);
    expect(root.find('sesscards')).not.toBe(null);
    expect(root.find('ctxdonut')).not.toBe(null);
    expect(root.find('prompt-input-host')).not.toBe(null);
    expect(root.find('tlinner')).not.toBe(null);
    expect(sockets.map((socket) => socket.url)).toEqual([
      'ws://test/ws/debug',
      'ws://test/ws/providers/world%3Aterminal/panels/chat',
    ]);
  });

  it('分类圆环在输入器内向上打开局部面板，再次点击关闭', () => {
    const { env } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);

    const ring = root.find('ctxdonut')!;
    ring.dispatchEvent({ type: 'click' });
    expect(ring.getAttribute('aria-expanded')).toBe('true');
    expect(root.find('ctxanchor')!.find('ctxpanel')).not.toBe(null);
    ring.dispatchEvent({ type: 'click' });
    expect(ring.getAttribute('aria-expanded')).toBe('false');
    expect(root.find('ctxpanel')).toBe(null);
  });

  it('hello 帧铺出整条时间线、状态读数与 session 卡条', () => {
    const { env, sockets } = fakeEnv();
    const { ctx, root, doc } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].up();
    sockets[0].emit({
      t: 'hello',
      session: [
        { role: 'system', content: '前缀' },
        { role: 'user', content: '一条系统文本' },
        {
          role: 'assistant',
          content: '独白',
          reasoning_content: '思考',
          tool_calls: [{ id: 'c1', function: { name: 'look', arguments: '{"a":1}' } }],
        },
      ],
      toolSchemas: [{ name: 'look' }],
      status: { displayName: '某某', loop: { estTokens: 12345, messageCount: 3, paused: true } },
      sessions: [
        { id: 'main', label: '主意识', role: 'main', promptTokens: 100, completionTokens: 5, cacheHitTokens: 40, cacheHitRate: 0.4, calls: 2, messageCount: 3, endedAt: null },
        { id: 'f1', label: '联想', role: 'association', promptTokens: 10, completionTokens: 1, cacheHitTokens: 0, cacheHitRate: 0, calls: 1, messageCount: 1, endedAt: null },
      ],
    });

    const inner = root.find('tlinner') as FakeEl;
    // 系统前缀卡 / 系统文本块 / 一张 ASSISTANT 卡(思考 + 独白 + 工具调用是同一个 Response)
    expect(inner.children.length).toBe(3);
    expect(inner.find('syscard')).not.toBe(null);
    expect(inner.find('world')).not.toBe(null);
    const turn = inner.find('turn') as FakeEl;
    expect(turn.find('turnbody')!.children.map((n) => n.getAttribute('data-item-type')))
      .toEqual(['reasoning', 'message', 'function_call']);
    expect(turn.findAll('think-body').map((b) => b.textContent)).toEqual(['思考']);
    expect(turn.find('monolog-body')!.textContent).toBe('独白');
    expect(turn.find('toolcall')).not.toBe(null);
    // 工具卡在等结果
    expect((inner.find('toolresult') as FakeEl).className).toContain('pending');

    const chips = root.find('chips') as FakeEl;
    expect(chips.textContent).toContain('12.3k');
    expect(chips.textContent).toContain('已暂停');

    expect((root.find('sesscards') as FakeEl).children.length).toBe(2);
    // 展示名来自部署配置,只落在标题上(品牌名归外壳)
    expect(doc.title).toBe('控制台 · 某某');
  });

  it('工具回执按 call_id 填回等结果的那个槽位,不新开一张卡', () => {
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].up();
    sockets[0].emit({
      t: 'hello',
      session: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'c1', function: { name: 'look', arguments: '{}' } }],
        },
      ],
    });
    const inner = root.find('tlinner') as FakeEl;
    expect(inner.children.length).toBe(1);
    sockets[0].emit({
      t: 'session.append',
      index: 1,
      message: { role: 'tool', tool_call_id: 'c1', content: '看到了' },
    });
    expect(inner.children.length).toBe(1); // 没有多出一张 standalone 卡
    const slot = inner.find('toolresult') as FakeEl;
    expect(slot.className).not.toContain('pending');
    expect(slot.textContent).toContain('看到了');
    // 槽位记着是哪条 Item 填的
    expect(slot.getAttribute('data-item-type')).toBe('function_call_output');
    expect(inner.find('standalone')).toBeNull();
  });

  it.each([undefined, null, '1', -1, 0.5, 2])('追加索引 %s 无效时重新获取完整会话', (index) => {
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].up();
    sockets[0].emit({ t: 'hello', session: [functionResult('first', '已收到')] });
    const connections = sockets.length;
    sockets[0].emitRaw(JSON.stringify({ t: 'session.append', index, message: functionResult('next', '不能追加') }));
    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(connections + 1);
    expect(sockets.at(-1)!.url).toBe(sockets[0].url);
    expect(root.find('tlinner')!.textContent).not.toContain('不能追加');
  });

  it('已收到的追加索引不会重复渲染或触发重连', () => {
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true });
    live.createLiveFeature({ env }).mount(ctx);
    const message = functionResult('first', '已收到');
    sockets[0].emit({ t: 'hello', session: [message] });
    const connections = sockets.length;
    sockets[0].emitRaw(JSON.stringify({ t: 'session.append', index: 0, message }));
    expect(sockets).toHaveLength(connections);
    expect(sockets[0].closed).toBe(false);
    expect(root.find('tlinner')!.children).toHaveLength(1);
  });

  it('对不上号的工具回执单独成卡', () => {
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].emit({ t: 'hello', session: [functionResult('orphan', '没人等它')] });
    const card = root.find('standalone') as FakeEl;
    expect(card.find('badge')!.textContent).toBe('function_call_output');
    expect(card.textContent).toContain('orphan');
    expect(card.textContent).toContain('没人等它');
  });

  it('气泡只画模型的直接输出:speak 工具也是工具卡,事件投递帧靠右,气泡带头像', () => {
    const { session } = responseTimelineFixture();
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].emit({
      t: 'hello',
      session: [
        ...session,
        functionCall('evf_1', 'external_event_frame', '{}'),
        functionResult('evf_1', '[1 new events]\n[直播间] 看过 481'),
      ],
      toolSchemas: [{ name: 'terminal_send', tags: ['speak'] }, { name: 'inspect', tags: ['read'] }],
      status: { displayName: 'Yukima' },
    });
    // 带 speak 标签的工具不再画成气泡,和别的工具一样是工具卡;回执照样填回槽位
    expect(root.find('bubblewrap')).toBeNull();
    const cards = root.findAll('toolcall');
    // 卡头是 tool_name / call_id 两只键值框:键名在 kv-k,值全文在 kv-v
    const kvv = (card: FakeEl, key: string): string | null => card.find(`kv-${key}`)?.find('kv-v')?.textContent ?? null;
    expect(cards.map((c) => kvv(c, 'tool_name'))).toEqual(['inspect', 'terminal_send', 'external_event_frame']);
    expect(cards.map((c) => kvv(c, 'call_id'))).toEqual(['inspect_1', 'send_1', 'evf_1']);
    expect(cards[0].find('kv-tool_name')!.find('kv-k')!.textContent).toBe('tool_name');
    expect(cards[1].find('toolresult')!.textContent).toContain('已发送');
    // 只有合成调用对多一只「合成」标记框
    expect(cards.map((c) => c.find('kv-合成') !== null)).toEqual([false, false, true]);
    // 事件投递帧和别的工具调用一样待在 ASSISTANT 组里;它没有 responseId,自成一段(#10);卡带 evframe,回执填回
    const turns = root.findAll('turn');
    expect(turns).toHaveLength(2);
    expect(turns[1].find('ordinal')!.textContent).toBe(`#${session.length}`);
    expect(turns[1].find('turnbody')!.children.map((c) => c.getAttribute('data-item-id'))).toEqual([cards[2].getAttribute('data-item-id')]);
    expect(root.find('evgrp')).toBeNull();
    expect(cards.map((c) => c.className.split(' ').includes('evframe'))).toEqual([false, false, true]);
    expect(cards[2].find('toolresult')!.textContent).toContain('看过 481');
    // ASSISTANT 组:左栏头像(占位字取展示名首字)+ 组头 ASSISTANT №n;气泡不再各自带头像
    const turn = root.find('turn') as FakeEl;
    expect(turn.children.map((c) => c.className)).toEqual(['gutter avatar', 'gcol']);
    expect(turn.find('avatar-fallback')!.textContent).toBe('Y');
    expect(turn.find('turnhead')!.find('badge')!.textContent).toBe('ASSISTANT');
    expect(turn.find('turnhead')!.find('ordinal')!.textContent).toBe('#1');
    const mono = root.find('monolog') as FakeEl;
    expect(mono.find('monolog-avatar')).toBeNull();
    expect(mono.find('monolog-body')!.textContent).toBe('状态核对完成。');
    // USER 组:靠右,组头是序号 + USER,记号栏在内容列之后
    const user = root.find('usergrp') as FakeEl;
    expect(user).toBeNull(); // 这份夹具没有 user 消息
  });

  it('USER 组靠右带序号,合成首轮与 session 同画法、前后各一道分隔线', () => {
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].emit({
      t: 'hello',
      session: [message('system', '前缀'), message('user', '[system] 2 条新事件。'), message('assistant', '好。')],
      head: [message('user', '首轮输入'), message('assistant', '首轮回复')],
    });
    const inner = root.find('tlinner') as FakeEl;
    // 系统条 / 分隔线 / 首轮 USER / 首轮 ASSISTANT / 分隔线 / USER №1 / ASSISTANT №2
    expect(inner.children.map((c) => c.className.split(' ')[0])).toEqual([
      'tcard', 'divider', 'usergrp', 'tcard', 'divider', 'usergrp', 'tcard',
    ]);
    expect(inner.children[1].textContent).toContain('合成开头');
    expect(inner.children[1].className).toContain('sessionhead');
    const [ftUser, ftTurn, , user, turn] = inner.children.slice(2) as FakeEl[];
    // 首轮没有 session 序号;正式的带 №
    expect(ftUser.find('ordinal')).toBeNull();
    expect(ftTurn.find('ordinal')).toBeNull();
    expect(user.find('ordinal')!.textContent).toBe('#1');
    expect(turn.find('ordinal')!.textContent).toBe('#2');
    // USER 组:内容列在前、记号栏在后;组头写 USER
    expect(user.children.map((c) => c.className)).toEqual(['gcol r', 'gutter']);
    expect(user.find('ghead')!.find('badge')!.textContent).toBe('USER');
    expect(user.find('world')!.textContent).toBe('[system] 2 条新事件。');
    expect(user.getAttribute('data-item-type')).toBe('message');
  });

  it('坏帧只报错不炸,认不出的帧忽略', () => {
    const { env, sockets } = fakeEnv();
    const { ctx, errors } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].up();
    sockets[0].emitRaw('{不是 json');
    expect(errors.length).toBe(1);
    expect(() => sockets[0].emit({ t: '未来才有的帧型' })).not.toThrow();
  });

  /** 一张 ASSISTANT 卡里各块的 Item id,同一 Item 拆成几块(多段正文)只数一次。 */
  const itemIds = (turn: FakeEl): string[] => {
    const out: string[] = [];
    for (const block of turn.find('turnbody')!.children) {
      const id = block.getAttribute('data-item-id')!;
      if (out.at(-1) !== id) out.push(id);
    }
    return out;
  };

  it('同一 Response 的 Item 合成一张 ASSISTANT 卡,卡内按 output 顺序排;明文、摘要和加密载荷分别呈现', () => {
    const { response, session } = responseTimelineFixture();
    const { env, sockets } = fakeEnv();
    const { ctx, root, errors } = mkCtx({ debug: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].emit({ t: 'hello', session });
    const inner = root.find('tlinner') as FakeEl;
    // 系统前缀卡 + 一张 ASSISTANT 卡;两条回执都填回了各自的调用卡
    expect(inner.children.map((n) => n.className.split(' ').slice(0, 2).join(' '))).toEqual(['tcard syscard', 'tcard turn']);
    const turn = root.find('turn') as FakeEl;
    expect(turn.getAttribute('data-response-id')).toBe(response.id);
    expect(itemIds(turn)).toEqual(response.output.map((item) => item.id));
    const blocks = turn.find('turnbody')!.children;
    expect(blocks[0].findAll('think-body').map((body) => body.textContent)).toEqual(['先读取当前状态。\n\n再核对待处理事件。']);
    // 只有加密载荷的思考:一行「思考 🔒」,锁的 hover 说明字数,没有正文可展开
    expect(blocks[2].find('think-body')).toBeNull();
    expect(blocks[2].findAll('think-label').map((label) => label.textContent)).toEqual(['加密思考 16 字符']);
    expect(blocks[2].find('chev')).toBeNull();
    // 明文 + 加密 + 摘要:头上按字面报两种长度,摘要另起小节
    expect(blocks[4].findAll('think-label').map((label) => label.textContent)).toEqual(['可见思考 12 字', '加密思考 16 字符', '摘要']);
    expect(blocks[4].findAll('think-body').map((body) => body.textContent)).toEqual(['保留当前结果用于下一步。', '已完成状态核对。']);
    expect(blocks[0].findAll('think-label').map((label) => label.textContent)).toEqual(['可见思考 19 字']);
    // 工具调用一律是工具卡,terminal_send 也不例外;气泡只留给模型的直接输出
    expect(blocks[3].className).toContain('toolcall');
    expect(blocks[3].className).not.toContain('evframe');
    expect(blocks[3].find('kv-tool_name')!.find('kv-v')!.textContent).toBe('terminal_send');
    expect(root.find('bubblewrap')).toBeNull();
    expect(blocks[5].find('monolog-label')!.textContent).toContain('commentary');
    const answer = blocks.slice(6);
    expect(answer.map((b) => b.getAttribute('data-item-id'))).toEqual(['answer', 'answer', 'answer']);
    expect(answer.map((b) => b.find('monolog-body')!.textContent)).toEqual(['可以继续处理事件。', '该操作无法执行。', '其余结果保持有效。']);
    // final_answer 的气泡不印标签;拒绝印「拒绝」;phase 只在 hover
    expect(answer.map((b) => b.find('monolog-label')?.textContent ?? null)).toEqual([null, '拒绝', null]);
    expect(answer[0].title).toBe('assistant 正文 · final_answer');
    // 回执按 call_id 对号,与到达顺序无关
    expect(blocks[1].find('toolresult')!.textContent).toContain('队列中有 2 条事件');
    expect(blocks[3].find('toolresult')!.textContent).toContain('已发送');
    expect(root.find('standalone')).toBeNull();
    // 「原始 Item」展开这一段的标准 Item 原文(含加密载荷)
    const raw = turn.find('turnraw') as FakeEl;
    expect(raw.className).not.toContain('open');
    turn.find('rawtoggle')!.dispatchEvent({ type: 'click' });
    expect(raw.className).toContain('open');
    expect(raw.textContent).toContain('opaque-state-one');
    expect(raw.textContent).toContain('"phase": "final_answer"');
    expect(errors).toEqual([]);
  });

  it('实时追加与 hello 重载画出同一结构,回执按 call_id 填回各自的调用卡', () => {
    const { response, session } = responseTimelineFixture();
    const { env, sockets } = fakeEnv();
    const { ctx, root, errors } = mkCtx({ debug: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].emit({ t: 'hello', session: session.slice(0, 1) });
    session.slice(1).forEach((entry, i) => sockets[0].emit({ t: 'session.append', index: i + 1, message: entry }));
    const expected = response.output.map((item) => item.id);
    const check = (): void => {
      expect(root.findAll('turn')).toHaveLength(1);
      expect(itemIds(root.find('turn') as FakeEl)).toEqual(expected);
      expect(root.findAll('toolresult').map((slot) => slot.textContent)).toEqual(['队列中有 2 条事件', '已发送']);
      expect(root.find('standalone')).toBeNull();
    };
    check();
    sockets[0].emit({ t: 'session.reset', messages: session });
    check();
    sockets[0].emit({ t: 'hello', session });
    check();
    expect(errors).toEqual([]);
  });

  it('ASSISTANT 卡不越过中间的工具回执;未闭合参数与空 reasoning 保留原状态', () => {
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true });
    live.createLiveFeature({ env }).mount(ctx);
    const partial = record({ type: 'function_call', id: 'partial', call_id: 'c', name: 'inspect', arguments: '{"scope":', status: 'incomplete' }, { responseId: 'r', responseStatus: 'incomplete' });
    const empty = record({ type: 'reasoning', id: 'empty', summary: [] }, { responseId: 'r', responseStatus: 'incomplete' });
    sockets[0].emit({ t: 'hello', session: [partial, functionResult('c', '取消'), empty] });
    const turns = root.findAll('turn');
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.getAttribute('data-response-id'))).toEqual(['r', 'r']);
    expect(turns.map((t) => t.find('turnstatus')!.textContent)).toEqual(['incomplete', 'incomplete']);
    const call = turns[0].find('toolcall') as FakeEl;
    expect(call.find('toolhead')!.textContent).toContain('incomplete');
    expect(call.textContent).toContain('{"scope":');
    expect(call.find('toolresult')!.textContent).toContain('取消');
    // 空 reasoning(无正文、无摘要、无加密载荷)不画块,但它仍算进这一段:组照开,原始 Item 里有它
    expect(turns[1].find('think')).toBeNull();
    expect(turns[1].find('turnbody')!.children).toHaveLength(0);
    expect(turns[1].className.split(' ')).toContain('empty');
    expect(turns[0].className.split(' ')).not.toContain('empty');
    turns[1].find('rawtoggle')!.dispatchEvent({ type: 'click' });
    expect(turns[1].find('turnraw')!.textContent).toContain('"id": "empty"');
  });

  it('调试通道没挂:不开它,改用 /ws/sessions 顶上,并拉一次 /api/status', async () => {
    stubFetch(() => ({ loop: { estTokens: 10 } }));
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: false, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);
    await flush();

    expect(sockets.map((s) => s.url)).toEqual([
      'ws://test/ws/sessions',
      'ws://test/ws/providers/world%3Aterminal/panels/chat',
    ]);
    expect(fetched).toEqual(['/api/status']);
    expect((root.find('tlinner') as FakeEl).textContent).toContain('调试通道不可用');

    sockets[0].up();
    sockets[0].emit({
      t: 'sessions',
      sessions: [
        { id: 'main', label: '主意识', role: 'main', promptTokens: 1, completionTokens: 0, cacheHitTokens: 0, cacheHitRate: null, calls: 0, messageCount: 0, endedAt: null },
      ],
    });
    expect((root.find('sesscards') as FakeEl).children.length).toBe(1);
  });

  it('两条观察通道都没挂时只保留终端发送通道', () => {
    stubFetch(() => ({}));
    const { env, sockets } = fakeEnv();
    const { ctx } = mkCtx({ debug: false, sessions: false });
    live.createLiveFeature({ env }).mount(ctx);
    expect(sockets.map((socket) => socket.url)).toEqual([
      'ws://test/ws/providers/world%3Aterminal/panels/chat',
    ]);
  });
});

// ===========================================================================
// fork 视图
// ===========================================================================

describe('fork 视图', () => {
  const helloWithSessions = (ended: string | null) => ({
    t: 'hello',
    session: [{ role: 'system', content: '前缀' }],
    sessions: [
      { id: 'main', label: '主意识', role: 'main', promptTokens: 1, completionTokens: 0, cacheHitTokens: 0, cacheHitRate: null, calls: 0, messageCount: 1, endedAt: null },
      { id: 'f1', label: '联想', role: 'association', promptTokens: 2, completionTokens: 0, cacheHitTokens: 0, cacheHitRate: null, calls: 1, messageCount: 2, endedAt: ended },
    ],
  });

  it('点卡条切到 fork:拉一次消息、挂上轮询、横幅带返回键', async () => {
    stubFetch(() => ({ messages: [{ role: 'user', content: 'x' }], estTokens: 42 }));
    const { env, sockets } = fakeEnv();
    const { ctx, root, lifecycle } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].up();
    sockets[0].emit(helloWithSessions(null));

    const cards = (root.find('sesscards') as FakeEl).children;
    cards[1].dispatchEvent({ type: 'click' });
    await flush();

    expect(fetched).toEqual(['/api/sessions/messages?id=f1']);
    expect(root.find('forkbanner')).not.toBe(null);
    expect((root.find('forkbanner') as FakeEl).textContent).toContain('联想');
    // 轮询是这一页唯一的定时器
    expect(vi.getTimerCount()).toBe(1);

    // 再点一次同一张卡不重复切
    cards[1].dispatchEvent({ type: 'click' });
    await flush();
    expect(fetched.length).toBe(1);

    lifecycle.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('消息条数不变时仍刷新生成中的思维链', async () => {
    let calls = 0;
    stubFetch(() => ({
      messages: [
        { role: 'user', content: '画图' },
        { role: 'assistant', content: '', reasoning_content: calls++ === 0 ? '正在想' : '正在想第一层怎么铺' },
      ],
      estTokens: 8,
    }));
    const { env, sockets } = fakeEnv();
    const { ctx, root, lifecycle } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].up();
    sockets[0].emit(helloWithSessions(null));
    (root.find('sesscards') as FakeEl).children[1].dispatchEvent({ type: 'click' });
    await flush();
    expect((root.find('tlinner') as FakeEl).textContent).toContain('正在想');

    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect((root.find('tlinner') as FakeEl).textContent).toContain('正在想第一层怎么铺');
    lifecycle.dispose();
  });

  it('fork 轮询保留 Response Item 顺序，更新同一 Item 的摘要与加密载荷不增加伪消息', async () => {
    const fixture = responseTimelineFixture();
    let version = 0;
    stubFetch(() => {
      const entries = structuredClone(fixture.session);
      const reasoning = entries.find(entry => entry.item.id === 'reason_mixed')!.item;
      if (reasoning.type !== 'reasoning') throw new Error('Missing reasoning fixture');
      reasoning.summary = [{ type: 'summary_text', text: version ? '新的摘要' : '初始摘要' }];
      reasoning.encrypted_content = version ? 'opaque-new-state' : 'opaque';
      return { messages: entries, estTokens: 100 };
    });
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].emit(helloWithSessions(null));
    root.find('sesscards')!.children[1].dispatchEvent({ type: 'click' });
    await flush();
    const expected = fixture.response.output.map((item) => item.id);
    const ids = () => root.findAll('turn').flatMap((turn) => {
      const out: string[] = [];
      for (const block of turn.find('turnbody')!.children) {
        const id = block.getAttribute('data-item-id')!;
        if (out.at(-1) !== id) out.push(id);
      }
      return out;
    });
    expect(ids()).toEqual(expected);
    expect(root.findAll('think-body').map(body => body.textContent)).toContain('初始摘要');
    version++;
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(ids()).toEqual(expected);
    expect(root.findAll('think-body').map(body => body.textContent)).toContain('新的摘要');
    expect(root.findAll('think-enc').at(-1)!.textContent).toBe(`加密思考 ${'opaque-new-state'.length} 字符`);
  });

  it('目标 session 已结束就停轮询(定格)', async () => {
    stubFetch(() => ({ messages: [], estTokens: 0 }));
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].up();
    sockets[0].emit(helloWithSessions('2026-08-12T10:00:00Z'));
    (root.find('sesscards') as FakeEl).children[1].dispatchEvent({ type: 'click' });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect((root.find('forkbanner') as FakeEl).textContent).toContain('已结束');
  });

  it('返回主 session:停轮询并回到主时间线', async () => {
    stubFetch(() => ({ messages: [{ role: 'user', content: 'x' }], estTokens: 1 }));
    const { env, sockets } = fakeEnv();
    const { ctx, root } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].up();
    sockets[0].emit(helloWithSessions(null));
    (root.find('sesscards') as FakeEl).children[1].dispatchEvent({ type: 'click' });
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    const back = (root.find('forkbanner') as FakeEl).children[1];
    back.dispatchEvent({ type: 'click' });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(root.find('forkbanner')).toBe(null);
    expect((root.find('tlinner') as FakeEl).find('syscard')).not.toBe(null);
  });
});

// ===========================================================================
// 卸载
// ===========================================================================

describe('live feature 卸载', () => {
  it('unmount:连接关掉、退避定时器清掉、监听归零', async () => {
    stubFetch(() => ({ messages: [], estTokens: 0 }));
    const { env, sockets, timers } = fakeEnv();
    const { ctx, root, lifecycle } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].up();
    sockets[0].emit({ t: 'hello', session: [{ role: 'system', content: '前缀' }] });

    const view = root.children[0];
    expect(view.totalListeners()).toBeGreaterThan(0);

    // 掉线一次:退避定时器排上
    sockets[0].readyState = 3;
    sockets[0].onclose?.({});
    expect(timers.size).toBe(1);

    lifecycle.dispose();
    expect(timers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(view.totalListeners()).toBe(0);
    expect(sockets.every((s) => s.closed || s.readyState === 3)).toBe(true);
  });

  it('卸载后再来的帧不会往已经拆掉的界面里写', () => {
    const { env, sockets } = fakeEnv();
    const { ctx, root, lifecycle } = mkCtx({ debug: true, sessions: true });
    live.createLiveFeature({ env }).mount(ctx);
    sockets[0].up();
    lifecycle.dispose();
    const before = (root.find('tlinner') as FakeEl).textContent;
    sockets[0].emit({ t: 'hello', session: [{ role: 'system', content: '前缀' }] });
    expect((root.find('tlinner') as FakeEl).textContent).toBe(before);
  });
});
