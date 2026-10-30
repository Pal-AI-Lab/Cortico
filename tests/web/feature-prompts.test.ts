/**
 * @vitest-environment jsdom
 * 使用模拟 DOM 与接口验证页面行为；浏览器源码由变量动态 import 加载，类型由 tsconfig.web.json 检查。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UI = '../../src/web/client/ui/index.ts';
const LIFECYCLE = '../../src/web/client/core/lifecycle.ts';
const ROUTER = '../../src/web/client/core/router.ts';
const PROMPTS = '../../src/web/client/features/prompts/index.ts';
import { WEBUI_PROTOCOL_VERSION } from '../../src/web/shared/webui-protocol.ts';

const EDITOR = '../../src/web/client/features/prompts/editor.ts';

type Any = any;

const { createWebUi } = (await import(UI)) as Any;
const { Lifecycle } = (await import(LIFECYCLE)) as Any;
const { Router } = (await import(ROUTER)) as Any;
const prompts = (await import(PROMPTS)) as Any;
const { createPrefixEditor } = (await import(EDITOR)) as Any;
const { EditorView } = (await import('@codemirror/view')) as Any;

/** 页面里那个编辑器的 view（`findFromDOM` 是公开入口，别去摸私有字段）。 */
const viewOf = (root: HTMLElement): Any =>
  EditorView.findFromDOM(root.querySelector('.prefix-host .cm-editor') as HTMLElement);

const flush = async (n = 30): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const DOCS = {
  prompts: [
    {
      key: 'orientation', title: 'ORIENTATION', content: '定向第一行\n定向第二行', revision: 'r1',
    },
    {
      key: 'worlds.qq.envPrompt', title: 'QQ · 环境提示词', revision: 'r2', role: 'envPrompt',
      content: '你在QQ上。\n{{qq.identity}}',
      vars: [{ name: 'qq.identity', description: '你自己的 QQ 号', value: '你的QQ号是99。' }],
    },
    {
      key: 'persona.prefix', title: '前缀装配', revision: 'r3', role: 'prefix',
      content: '{{persona.orientation}}', vars: [{ name: 'persona.orientation', description: '定向全文' }],
    },
  ],
};
const PREFIX = {
  segments: [
    { title: 'ORIENTATION', text: '定向第一行\n定向第二行', sourceKey: 'orientation' },
    { title: '环境:qqWorld', text: '你在QQ上。\n你的QQ号是99。', sourceKey: 'worlds.qq.envPrompt' },
    { title: 'Using your tools', text: '工具用法(来自代码)' },
  ],
};

let calls: Array<{ url: string; body: Any }> = [];

/** `reply` 按 (url, method) 分派——GET 与 POST 打的是同一条 `/api/prompts`。 */
function stub(reply?: (url: string, method: string) => unknown): void {
  vi.stubGlobal('fetch', (url: unknown, init: Any) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET');
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = u === '/api/webui/manifest' ? { protocolVersion: WEBUI_PROTOCOL_VERSION, providers: [] } : reply
      ? reply(u, method)
      : method === 'POST' ? { ok: true, result: '已保存', revision: 'r-new' }
        : u === '/api/prompts' ? DOCS
          : u === '/api/prompts/prefix' ? PREFIX
            : {};
    return Promise.resolve(new Response(JSON.stringify(body ?? {}), {
      status: body && typeof body === 'object' && 'error' in body ? 409 : 200, headers: { 'Content-Type': 'application/json' },
    }));
  });
}

function mkCtx(caps: Record<string, boolean> = { prompts: true }): Any {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const lifecycle = new Lifecycle(() => {});
  mounted.push(lifecycle);
  const ui = createWebUi({
    memo: { get: () => null, set: () => {} },
    overlayHost: document.body,
    signal: lifecycle.signal,
    doc: document,
  });
  return {
    ctx: {
      ui, root, lifecycle, signal: lifecycle.signal,
      capabilities: caps,
      route: { segments: ['prompts'] },
      router: new Router({ win: window, onError: () => {} }),
      onError: () => {},
    },
    root,
    lifecycle,
  };
}

const mounted: Any[] = [];
beforeEach(() => {
  calls = [];
  sessionStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { for (const life of mounted.splice(0)) life.dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); });

describe('整条前缀是一份文档', () => {

  it('浮层:点外面立刻消失,而且关掉之后同一颗还能再点开', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    const chip = root.querySelector('.varchip') as HTMLElement;

    chip.click();
    expect(document.querySelector('.varpop')).toBeTruthy();

    // 点浮层以外的任何地方 → 立刻收起
    (root.querySelector('.prompt-toolbar') as HTMLElement).click();
    expect(document.querySelector('.varpop')).toBe(null);

    chip.click();
    expect(document.querySelector('.varpop')).toBeTruthy();

    // 点浮层内部不关
    (document.querySelector('.varpop') as HTMLElement).click();
    expect(document.querySelector('.varpop')).toBeTruthy();

    // Esc 关
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.varpop')).toBe(null);
  });

  it('有行号列', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    expect(root.querySelectorAll('.prefix-host .cm-lineNumbers').length).toBe(1);
  });

  it('只读块改不动:落在它范围里的改动被挡下', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    const view = viewOf(root);
    const before = view.state.doc.toString();
    const at = before.indexOf('工具用法') + 2;
    view.dispatch({ changes: { from: at, insert: 'XX' } });
    expect(view.state.doc.toString()).toBe(before);
  });
});

describe('分割线与栏宽', () => {

  it('状态行报的是 token 不是字数', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    const line = root.querySelector('.prompt-toolbar .msgline')!;
    expect(line.textContent).toContain('3 块');
    expect(line.textContent).toContain('tokens');
  });
});

const editors: Any[] = [];
function mountEditor(blocks: Any[]) {
  const changes = new Map<string, string>();
  const parent = document.createElement('div');
  document.body.append(parent);
  const editor = createPrefixEditor({
    parent, onChange: (batch: Any[]) => { for (const c of batch) changes.set(c.sourceKey, c.text); },
    onSave() {}, onGeometry() {}, onFold() {},
  });
  editors.push(editor);
  editor.setBlocks(blocks.map((block) => ({ ...block, collapsed: block.sourceKey !== 'constitution', description: 'Section explanation' })));
  return { editor, changes };
}
afterEach(() => { for (const editor of editors.splice(0)) editor.dispose(); document.body.replaceChildren(); });

describe('continuous prompt document', () => {
  it('folds presentation without changing template text, including CRLF and empty sources', () => {
    const { editor, changes } = mountEditor([
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Identity\r\nVoice\r\n' },
      { title: 'ENVIRONMENT', sourceKey: 'worlds.fixture.envPrompt', tone: 'world', text: '' },
    ]);
    expect(editor.blockGeometry().map((g: Any) => g.collapsed)).toEqual([false, true]);
    const before = editor.view.state.doc.toString();
    editor.view.dom.querySelector('.prefix-comment[data-block="0"] button').click();
    editor.view.dom.querySelector('.prefix-comment[data-block="1"] button').click();
    expect(editor.blockGeometry().map((g: Any) => g.collapsed)).toEqual([true, false]);
    expect(editor.canUndo()).toBe(false);
    expect(editor.view.state.doc.toString()).toBe(before);
    expect(editor.text('constitution')).toBe('Identity\nVoice\n');
    expect(changes.size).toBe(0);
    editor.view.dispatch({ changes: { from: before.length, insert: 'Environment' } });
    expect(editor.text('worlds.fixture.envPrompt')).toBe('Environment');
    expect(editor.text('constitution')).toBe('Identity\nVoice\n');
  });

  it('inserts a reference token, removes it as a whole and undoes while its section is folded', () => {
    const key = 'constitution';
    const { editor } = mountEditor([{ title: 'CONSTITUTION', sourceKey: key, tone: 'persona', text: 'Hello ', vars: [{ name: 'fixture.name', description: 'Name', value: 'Friend' }] }]);
    editor.insert(key, 'fixture.name', 6);
    expect(editor.text(key)).toBe('Hello {{fixture.name}}');
    expect(editor.view.dom.querySelector('.prompt-reference-label')?.textContent).toBe('fixture.name');
    (editor.view.dom.querySelector('.prompt-reference-remove')).click();
    expect(editor.text(key)).toBe('Hello ');
    editor.setCollapsed(0, true);
    editor.undo();
    expect(editor.text(key)).toBe('Hello {{fixture.name}}');
    editor.redo();
    expect(editor.text(key)).toBe('Hello ');
  });

  it('previews current values and fallbacks in place without changing unsaved template text or undo history', () => {
    const { editor, changes } = mountEditor([{ title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'For {{ fixture.name | Friend }}', vars: [{ name: 'fixture.name', description: 'Name', value: '' }] }]);
    editor.view.dispatch({ changes: { from: 0, insert: 'Hello! ' }, userEvent: 'input' });
    changes.clear();
    expect(editor.view.dom.querySelector('.prompt-reference-label')?.textContent).toBe('fixture.name');
    editor.setPreview('constitution', true);
    expect(editor.view.dom.querySelector('.prompt-reference-label')?.textContent).toBe('Friend');
    editor.updateVariables('constitution', [{ name: 'fixture.name', description: 'Name', value: 'Partner' }]);
    expect(editor.view.dom.querySelector('.prompt-reference-label')?.textContent).toBe('Partner');
    editor.updateVariables('constitution', [{ name: 'fixture.name', description: 'Name' }]);
    expect(editor.view.dom.querySelector('.prompt-reference-label')?.textContent).toBe('{{ fixture.name | Friend }}');
    editor.setPreview('constitution', false);
    expect(editor.view.dom.querySelector('.prompt-reference-label')?.textContent).toBe('fixture.name');
    expect(editor.text('constitution')).toBe('Hello! For {{ fixture.name | Friend }}');
    expect(changes.size).toBe(0);
    editor.undo();
    expect(editor.text('constitution')).toBe('For {{ fixture.name | Friend }}');
  });

  it('keeps undo at the reference that was edited instead of a stale caret in another section', () => {
    const { editor } = mountEditor([
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Identity' },
      { title: 'WORLD', sourceKey: 'worlds.fixture.envPrompt', tone: 'world', text: 'Hello {{fixture.name}}!', vars: [{ name: 'fixture.name', description: 'Name', value: 'Friend' }] },
    ]);
    editor.setCollapsed(1, false);
    const position = editor.view.state.doc.toString().indexOf('{{');
    (editor.view.dom.querySelector('.prompt-reference-remove')).click();
    editor.undo();
    expect(editor.view.state.selection.main.head).toBe(position);
    expect(editor.text('worlds.fixture.envPrompt')).toBe('Hello {{fixture.name}}!');
    editor.view.dispatch({ selection: { anchor: 0 } });
    editor.insert('worlds.fixture.envPrompt', 'fixture.name', position);
    editor.undo();
    expect(editor.view.state.selection.main.head).toBe(position);
    editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', code: 'KeyZ', keyCode: 90, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(editor.text('worlds.fixture.envPrompt')).toBe('Hello {{fixture.name}}{{fixture.name}}!');
  });

  it('previews only the selected section and recognizes manually typed references followed by space', () => {
    const vars = [{ name: 'fixture.name', description: 'Name', value: 'Friend' }];
    const { editor } = mountEditor([
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: '{{fixture.name}}', vars },
      { title: 'WORLD', sourceKey: 'worlds.fixture.envPrompt', tone: 'world', text: '', vars },
    ]);
    editor.setCollapsed(1, false);
    for (const char of '{{fixture.name}} ') {
      editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: char }, userEvent: 'input.type' });
    }
    expect(editor.text('worlds.fixture.envPrompt')).toBe('{{fixture.name}} ');
    editor.setPreview('worlds.fixture.envPrompt', true);
    expect([...editor.view.dom.querySelectorAll('.prompt-reference-label')].map((el) => el.textContent)).toEqual(['fixture.name', 'Friend']);
    editor.setPreview('worlds.fixture.envPrompt', false);
    expect([...editor.view.dom.querySelectorAll('.prompt-reference-label')].map((el) => el.textContent)).toEqual(['fixture.name', 'fixture.name']);
  });

  it('restores saved sources including folded sections as one undoable edit, retaining generated text', () => {
    const { editor, changes } = mountEditor([
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Identity' },
      { title: 'WORKSPACE', tone: 'derived', text: 'files.md' },
      { title: 'WORLD', sourceKey: 'worlds.fixture.envPrompt', tone: 'world', text: 'Environment' },
    ]);
    editor.view.dispatch({ changes: { from: 0, insert: 'New ' } });
    editor.setCollapsed(2, false);
    editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: '!' } });
    editor.setCollapsed(2, true);
    const edited = editor.view.state.doc.toString();
    editor.restore(new Map([['constitution', 'Identity'], ['worlds.fixture.envPrompt', 'Environment']]));
    expect(editor.view.state.doc.toString()).toBe('Identity\nfiles.md\nEnvironment');
    expect(changes.get('constitution')).toBe('Identity');
    expect(changes.get('worlds.fixture.envPrompt')).toBe('Environment');
    expect(editor.blockGeometry()[2].collapsed).toBe(true);
    editor.undo();
    expect(editor.view.state.doc.toString()).toBe(edited);
  });
});

describe('prompt persistence and reload', () => {
const worldKey = 'worlds.fixture.envPrompt';
let sources: Any[], generated: string, writes: Any[], sessionWrites: string[], saveGate: Any, sessionGate: Any, configAvailable: boolean, failures: Set<string>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function prefix() {
  return [
    ...sources.filter((doc) => doc.content).map((doc) => ({ title: doc.key, sourceKey: doc.key, text: doc.content })),
    { title: 'WORKSPACE', text: generated },
  ];
}
beforeEach(() => {
  sources = [
    { key: 'instructions', title: 'Persona', role: 'prefix', content: 'Hello {{fixture.name}}', revision: '1', vars: [{ name: 'fixture.name', description: 'Name', value: 'Friend' }] },
    { key: worldKey, title: 'World template', role: 'envPrompt', content: 'Environment', revision: '1', origin: 'module' },
  ];
  generated = 'files.md'; writes = []; sessionWrites = [];
  saveGate = sessionGate = null; configAvailable = true; failures = new Set();
  history.replaceState(null, '', '/#/prompts');
  vi.stubGlobal('fetch', async (path: string, options: Any) => {
    if (path === '/api/webui/manifest') return json({ protocolVersion: WEBUI_PROTOCOL_VERSION, framework: { capabilities: { config: configAvailable } }, providers: [
      { id: 'world:fixture', kind: 'world', label: 'Fixture World', availability: 'active', configGroups: ['worlds.fixture'], prompts: [{ key: worldKey }] },
    ] });
    if (path === '/api/prompts/prefix') return json({ segments: prefix() });
    if (path === '/api/prompts' && options.method === 'GET') return json({ prompts: sources });
    if (path === '/api/prompts') {
      const body = JSON.parse(options.body);
      writes.push(body);
      if (saveGate) await saveGate.promise;
      if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const doc = sources.find((source) => source.key === body.key);
      if (failures.has(doc.key) || doc.revision !== body.baseRevision) return json({ error: 'Revision conflict' }, 409);
      doc.content = body.content; doc.revision = String(Number(doc.revision) + 1);
      return json({ revision: doc.revision });
    }
    if (path === '/api/session/reload-prefix') {
      sessionWrites.push(path);
      if (sessionGate) await sessionGate.promise;
      if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return json({ ok: true });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});

async function mountPage() {
  const life = new Lifecycle((error: unknown) => { throw error; });
  mounted.push(life);
  const root = document.createElement('div');
  document.body.append(root);
  const ui = createWebUi({ doc: document, overlayHost: document.body, signal: life.signal, memo: { get: (_: unknown, fallback: unknown) => fallback, set() {} } });
  const router = new Router({ win: window, confirmLeave: (body: string) => ui.confirm({ title: 'Leave', body }) });
  life.own(router.start());
  await prompts.mountPrompts({ root, ui, router, route: router.route, signal: life.signal, lifecycle: life, capabilities: { prompts: true, storage: true, sessionControl: true }, onError() {} });
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>(`[data-source="${worldKey}"]`)!.textContent).toContain('Fixture World'));
  const view = EditorView.findFromDOM(root.querySelector<HTMLElement>('.cm-editor')!);
  const button = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('.prompt-actions button')].find((el) => el.textContent === label)!;
  const edit = (text: string) => view.dispatch({ changes: { from: 0, insert: text }, userEvent: 'input.type' });
  return { root, life, router, view, button, edit };
}

it('omits the World configuration shortcut when the manifest disables configuration', async () => {
  configAvailable = false;
  const { root } = await mountPage();
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>(`[data-source="${worldKey}"]`)!.textContent).toContain('Fixture World'));
  expect(root.querySelector<HTMLElement>('.prompt-settings-link')!).toBeNull();
});

});
