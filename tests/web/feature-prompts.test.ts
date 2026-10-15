/**
 * @vitest-environment jsdom
 * 使用模拟 DOM 与接口验证页面行为；浏览器源码由变量动态 import 加载，类型由 tsconfig.web.json 检查。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UI = '../../src/web/client/ui/index.ts';
const LIFECYCLE = '../../src/web/client/core/lifecycle.ts';
const ROUTER = '../../src/web/client/core/router.ts';
const PROMPTS = '../../src/web/client/features/prompts/index.ts';
import { CONSOLE_PROTOCOL_VERSION } from '../../src/web/shared/console-protocol.ts';

const STRINGS = '../../src/web/client/features/prompts/strings.ts';
const { S } = await import(STRINGS);
const EDITOR = '../../src/web/client/features/prompts/editor.ts';

type Any = any;

const { createConsoleUi } = (await import(UI)) as Any;
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
    const body = u === '/api/console/manifest' ? { protocolVersion: CONSOLE_PROTOCOL_VERSION, providers: [] } : reply
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
  const ui = createConsoleUi({
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
  it('三块拼成一个 CodeMirror 文档,不是三个输入框', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();

    // 一个编辑器,零个 textarea(装配折叠区那份不算,它在 assembly 里)
    expect(root.querySelectorAll('.prefix-host .cm-editor').length).toBe(1);
    expect(root.querySelectorAll('.prefix-host textarea').length).toBe(0);

    // 可编辑块装的是**模板原文**(带 {{}}),只读块装渲染结果
    const text = root.querySelector('.prefix-host .cm-content')!.textContent!;
    expect(viewOf(root).state.doc.toString()).toContain('{{qq.identity}}');
    expect(viewOf(root).state.doc.toString()).not.toContain('{{persona.orientation}}');
    expect(text).toContain('定向第一行');
    expect(text).toContain('工具用法(来自代码)');
  });

  it('每一块的行都带自己那档底色,块首行画上边界', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    expect(root.querySelectorAll('.cm-block-persona').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('.cm-block-world').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('.cm-block-derived').length).toBeGreaterThan(0);
    // 三块 = 三个首行
    expect(root.querySelectorAll('.cm-block-first').length).toBe(3);
  });

  it('游标标签一块一面,写这一块的名字;只读块标出来', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    const flags = [...root.querySelectorAll('.prefix-flag')];
    expect(flags.map((f: Any) => f.querySelector('.prefix-flag-title').textContent)).toEqual([
      'ORIENTATION', 'QQ · 环境提示词', 'Using your tools',
    ]);
    // 按来源分档上色,只读那面另有标记
    expect(flags.map((f: Any) => f.parentElement.className)).toEqual([
      'prefix-label tone-persona',
      'prefix-label tone-world',
      'prefix-label tone-derived',
    ]);
  });

  it('左侧标签与右栏取同一份块几何——两边都跟内容对齐', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    const flagTops = [...root.querySelectorAll('.prefix-label')].map((f: Any) => f.style.top);
    const railTops = [...root.querySelectorAll('.prefix-railcell')].map((c: Any) => c.style.top);
    expect(flagTops.length).toBe(3);
    expect(flagTops).toEqual(railTops);
  });

  it('右栏每块一格,列那份模板的占位符;点开是浮层,再点收起', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    const chips = [...root.querySelectorAll('.varchip')].map((c: Any) => c.textContent);
    expect(chips).toEqual(['qq.identity']);

    expect(document.querySelector('.varpop')).toBe(null);
    (root.querySelector('.varchip') as HTMLElement).click();
    const pop = document.querySelector('.varpop')!;
    expect(pop.textContent).toContain('{{qq.identity}}');
    expect(pop.textContent).toContain('你自己的 QQ 号');
    expect(pop.textContent).toContain('你的QQ号是99。'); // 此刻的实际展开值
    (root.querySelector('.varchip') as HTMLElement).click();
    expect(document.querySelector('.varpop')).toBe(null);
  });

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

  it('光标落在哪一块,整块都亮起来(不是只亮鼠标底下那一行)', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    const view = viewOf(root);

    // 光标在第一块(两行) → 那两行都该带 active,而不是只有光标那一行
    view.dispatch({ selection: { anchor: 1 } });
    const active = [...root.querySelectorAll('.cm-block-active')];
    expect(active.length).toBe(2);
    expect(active[0].textContent).toContain('定向第一行');

    // 挪到 QQ 那块 → active 跟着换过去
    const qq = view.state.doc.toString().indexOf('你在QQ上');
    view.dispatch({ selection: { anchor: qq } });
    expect([...root.querySelectorAll('.cm-block-active')][0].textContent).toContain('你在QQ上');

    // 挪到只读块 → 不给 active(那块本来就不能编辑)
    const at = view.state.doc.toString().indexOf('工具用法');
    view.dispatch({ selection: { anchor: at } });
    expect(root.querySelectorAll('.cm-block-active').length).toBe(0);
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

/** 光标那一行的保存提示。字由 CSS 伪元素画,读得到的只有属性。 */
const hintLabel = (root: HTMLElement): string =>
  root.querySelector('.cm-line[data-save-hint]')?.getAttribute('data-save-hint') ?? '';

/** Ctrl+S。keymap 挂在编辑器的 DOM 上，所以事件得打在 contentDOM 上。 */
function ctrlS(root: HTMLElement): void {
  viewOf(root).contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
    key: 's', ctrlKey: true, bubbles: true, cancelable: true,
  }));
}

describe('按 Ctrl+S 保存', () => {
  it('光打字不写盘;按下 Ctrl+S 才 PUT,只发改过的那一份,带 baseRevision', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    calls = [];

    const view = viewOf(root);
    view.dispatch({ changes: { from: 0, insert: '新' } }); // 落在 ORIENTATION 块
    await flush();
    expect(calls.filter((c) => c.body !== undefined).length).toBe(0);

    ctrlS(root);
    await flush();
    const posted = calls.filter((c) => c.body !== undefined);
    expect(posted.length).toBe(1);
    expect(posted[0].body.key).toBe('orientation');
    expect(posted[0].body.content).toBe('新定向第一行\n定向第二行');
    expect(posted[0].body.baseRevision).toBe('r1');
    expect(root.textContent).toContain('已保存');
  });

  it('行尾提示:进页面没有,一改就催保存,存完变已保存,再改又催', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    const hint = (): string => hintLabel(root);

    expect(hint()).toBe('');

    const view = viewOf(root);
    view.dispatch({ changes: { from: 0, insert: '新' } });
    await flush();
    expect(hint()).toContain('Ctrl+S');
    const line = root.querySelector('.cm-line[data-save-hint]')!;
    expect(line.textContent).toBe('新定向第一行');

    ctrlS(root);
    await flush();
    expect(hint()).toBe('已保存');

    // 「已保存」只在存的时候那一行待着:光标一走开就没了,不跟着跑
    const other = view.state.doc.toString().indexOf('你在QQ上');
    view.dispatch({ selection: { anchor: other } });
    expect(hint()).toBe('');
    // 回到那一行,它还在
    view.dispatch({ selection: { anchor: 1 } });
    expect(hint()).toBe('已保存');

    view.dispatch({ changes: { from: 0, insert: '又' } });
    await flush();
    expect(hint()).toContain('Ctrl+S');
  });

  it('光标停在空行上时,提示只是行的属性:行里一个多余节点都不能有', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    const view = viewOf(root);
    // 开头插一个换行,光标留在这条空行上:文档变了,于是"还没保存"的提示也在这一行
    view.dispatch({ changes: { from: 0, insert: '\n' }, selection: { anchor: 0 } });
    await flush();
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('');
    const line = root.querySelector('.cm-line[data-save-hint]')!;
    expect(line.getAttribute('data-save-hint')).toContain('Ctrl+S');
    /*
     * 空行多出的节点会成为该行仅有的内容，contentEditable 退格会先删除节点而非换行。
     * 提示因此只能放在属性中。
     */
    expect(line.querySelector('span, img')).toBeNull();
  });

  it('保存失败 → 状态行标红说明是哪一份,改动退回待存(没有被吞掉)', async () => {
    stub((u, m) => m === 'POST'
      ? { error: '已在别处被修改' }
      : u === '/api/prompts' ? DOCS : PREFIX);
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    viewOf(root).dispatch({ changes: { from: 0, insert: 'x' } });
    ctrlS(root);
    await flush();
    const line = root.querySelector('.prompt-toolbar .msgline')!;
    expect(line.textContent).toContain('ORIENTATION');
    expect(line.textContent).toContain('已在别处被修改');
    expect(line.className).toContain('bad');
    // 没存上就还是"待保存",不能显示成已保存
    expect(hintLabel(root)).toContain('Ctrl+S');

    // 再按一次,那份改动还在,照样会被发出去
    calls = [];
    stub();
    ctrlS(root);
    await flush();
    expect(calls.filter((c) => c.body !== undefined).map((c) => c.body.key)).toEqual(['orientation']);
  });
});

describe('分割线与栏宽', () => {
  it('每块一条分割线:起点在旗尖(左栏宽),末端与右栏对齐', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const lines = [...root.querySelectorAll('.prefix-divider')];
    expect(lines.length).toBe(3);
    // 三条线与三面旗同高——它们本来就是同一份块几何
    expect(lines.map((l: Any) => l.style.top))
      .toEqual([...root.querySelectorAll('.prefix-label')].map((f: Any) => f.style.top));
    // 起点跟着左栏宽走(jsdom 里 offsetWidth 恒 0,只验证接线是这个量)
    const flags = root.querySelector('.prefix-flags') as HTMLElement;
    expect(lines.map((l: Any) => l.style.left)).toEqual(lines.map(() => `${flags.offsetWidth}px`));
    // 按来源上色,与旗子同档
    expect(lines.map((l: Any) => l.className)).toEqual([
      'prefix-divider tone-persona', 'prefix-divider tone-world', 'prefix-divider tone-derived',
    ]);
  });

  it('拖把手改栏宽,松手后不再跟着鼠标', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    const rail = root.querySelector('.prefix-rail') as HTMLElement;
    const grip = root.querySelectorAll('.prefix-grip')[1] as HTMLElement;
    const before = parseFloat(rail.style.flexBasis);

    grip.setPointerCapture = () => {};
    grip.dispatchEvent(new MouseEvent('pointerdown', { clientX: 500, bubbles: true }));
    // 右栏在右边:往左拖是变宽
    grip.dispatchEvent(new MouseEvent('pointermove', { clientX: 460 }));
    expect(parseFloat(rail.style.flexBasis)).toBe(before + 40);

    grip.dispatchEvent(new Event('lostpointercapture'));
    grip.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }));
    expect(parseFloat(rail.style.flexBasis)).toBe(before + 40);
  });

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

describe('块区间随编辑跟随', () => {
  it('在前一块里加很多行,后一块整体下移,归属不乱', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const changed: Any[] = [];
    const ed = createPrefixEditor({ parent, onChange: (c: Any) => changed.push(...c) });
    ed.setBlocks([
      { title: 'A', tone: 'persona', sourceKey: 'a', text: 'a1\na2' },
      { title: 'B', tone: 'world', sourceKey: 'b', text: 'b1' },
    ]);

    // 在 A 块末尾插三行
    const view = ed.view;
    view.dispatch({ changes: { from: 'a1\na2'.length, insert: '\nx\ny\nz' } });

    // 只有 A 变了;B 的文本原样,没有被顶进 A 里,也没有把 A 的尾巴吞进去
    const byKey = new Map(changed.map((c) => [c.sourceKey, c.text]));
    expect(byKey.get('a')).toBe('a1\na2\nx\ny\nz');
    expect(byKey.get('b')).toBeUndefined();
    expect(view.state.doc.toString()).toBe('a1\na2\nx\ny\nz\nb1');
    ed.dispose();
  });

  it('在块交界处敲进去的字算前一块的', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const changed: Any[] = [];
    const ed = createPrefixEditor({ parent, onChange: (c: Any) => changed.push(...c) });
    ed.setBlocks([
      { title: 'A', tone: 'persona', sourceKey: 'a', text: 'aa' },
      { title: 'B', tone: 'world', sourceKey: 'b', text: 'bb' },
    ]);
    ed.view.dispatch({ changes: { from: 2, insert: '!' } }); // 正好在 A 的末尾
    const byKey = new Map(changed.map((c) => [c.sourceKey, c.text]));
    expect(byKey.get('a')).toBe('aa!');
    expect(byKey.get('b')).toBeUndefined();
    ed.dispose();
  });

  it('模板带 CRLF/CR 换行:载入不算改动,之后的输入落在对的块里', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const changed: Any[] = [];
    const ed = createPrefixEditor({ parent, onChange: (c: Any) => changed.push(...c) });
    ed.setBlocks([
      { title: 'A', tone: 'persona', sourceKey: 'a', text: 'a1\na2' },
      { title: 'B', tone: 'world', sourceKey: 'b', text: 'b1\r\nb2\rb3' },
      { title: 'T', tone: 'derived', text: 't1\r\nt2' },
      { title: 'C', tone: 'persona', sourceKey: 'c', text: 'c1' },
    ]);
    expect(changed).toEqual([]);

    ed.view.dispatch({ changes: { from: 2, insert: '甲\n乙' } });
    const end = ed.view.state.doc.length;
    ed.view.dispatch({ changes: { from: end, insert: '!' } });

    const byKey = new Map(changed.map((c) => [c.sourceKey, c.text]));
    expect(byKey.get('a')).toBe('a1甲\n乙\na2');
    expect(byKey.get('b')).toBeUndefined();
    expect(byKey.get('c')).toBe('c1!');
    expect(ed.view.state.doc.toString()).toBe('a1甲\n乙\na2\nb1\nb2\nb3\nt1\nt2\nc1!');
    ed.dispose();
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

  it('keeps edits inside their source and rejects deletion through generated text or separators', () => {
    const { editor } = mountEditor([
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Persona' },
      { title: 'WORKSPACE', tone: 'derived', text: 'files.md' },
    ]);
    editor.setCollapsed(1, false);
    editor.view.dispatch({ changes: { from: 7, insert: '!' } });
    expect(editor.text('constitution')).toBe('Persona!');
    const before = editor.view.state.doc.toString();
    editor.view.dispatch({ changes: { from: 8, to: 10 } });
    editor.view.dispatch({ changes: { from: 11, insert: 'no' } });
    expect(editor.view.state.doc.toString()).toBe(before);
    editor.setBlocks([{ title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Persona' }, { title: 'WORKSPACE', tone: 'derived', text: 'new.md' }]);
    expect(editor.text('constitution')).toBe('Persona!');
    expect(editor.view.state.doc.toString()).toBe('Persona!\nnew.md');
  });

  it('keeps generated refreshes out of source undo and redo history', () => {
    const { editor } = mountEditor([
      { title: 'WORKSPACE', tone: 'derived', text: 'files.md' },
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Identity' },
    ]);
    editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: '!' }, userEvent: 'input.type' });
    editor.setBlocks([{ title: 'WORKSPACE', tone: 'derived', text: 'files.md\nnotes.md' }, { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Identity' }]);
    editor.undo();
    expect(editor.view.state.doc.toString()).toBe('files.md\nnotes.md\nIdentity');
    expect(editor.canUndo()).toBe(false);
    editor.redo();
    expect(editor.view.state.doc.toString()).toBe('files.md\nnotes.md\nIdentity!');
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
let sources: Any[], generated: string, session: Any[], writes: Any[], sessionWrites: string[], saveGate: Any, sessionGate: Any, configAvailable: boolean, failures: Set<string>;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
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
  generated = 'files.md'; session = []; writes = []; sessionWrites = [];
  saveGate = sessionGate = null; configAvailable = true; failures = new Set();
  history.replaceState(null, '', '/#/prompts');
  vi.stubGlobal('fetch', async (path: string, options: Any) => {
    if (path === '/api/console/manifest') return json({ protocolVersion: CONSOLE_PROTOCOL_VERSION, framework: { capabilities: { config: configAvailable } }, providers: [
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
      session = prefix();
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
  const ui = createConsoleUi({ doc: document, overlayHost: document.body, signal: life.signal, memo: { get: (_: unknown, fallback: unknown) => fallback, set() {} } });
  const router = new Router({ win: window, confirmLeave: (body: string) => ui.confirm({ title: 'Leave', body }) });
  life.own(router.start());
  await prompts.mountPrompts({ root, ui, router, route: router.route, signal: life.signal, lifecycle: life, capabilities: { prompts: true, storage: true, sessionControl: true }, onError() {} });
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>(`[data-source="${worldKey}"]`)!.textContent).toContain('Fixture World'));
  const view = EditorView.findFromDOM(root.querySelector<HTMLElement>('.cm-editor')!);
  const button = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('.prompt-actions button')].find((el) => el.textContent === label)!;
  const edit = (text: string) => view.dispatch({ changes: { from: 0, insert: text }, userEvent: 'input.type' });
  return { root, life, router, view, button, edit };
}

it('serializes saves and keeps edits made during an apply unsaved, with usable undo afterwards', async () => {
  const { root, view, button, edit } = await mountPage();
  saveGate = deferred(); sessionGate = deferred();
  edit('First ');
  button(S.reloadSession).click();
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  saveGate.resolve();
  await vi.waitFor(() => expect(sessionWrites).toHaveLength(1));
  edit('Later ');
  expect([...root.querySelectorAll<HTMLButtonElement>('.prompt-actions button')].every((el) => el.disabled)).toBe(true);
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true, bubbles: true, cancelable: true }));
  root.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await Promise.resolve();
  expect(writes).toHaveLength(1);
  sessionGate.resolve();
  await vi.waitFor(() => expect(button(S.reloadSession).disabled).toBe(false));
  expect(session[0].text).toBe('First Hello {{fixture.name}}');
  expect(view.state.doc.toString()).toContain('Later First Hello');
  expect(button(S.saveToFile).disabled).toBe(false);
  expect(button(S.undo).disabled).toBe(false);
  expect(root.querySelector<HTMLElement>('[role=status]')!.textContent).toBe(S.dirtyCount(1));
});

it('does not apply when a newer edit arrives during saving, and saves that edit with the new revision', async () => {
  const { button, edit } = await mountPage();
  saveGate = deferred();
  edit('First '); button(S.reloadSession).click();
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  edit('Later '); saveGate.resolve();
  await vi.waitFor(() => expect(button(S.reloadSession).disabled).toBe(false));
  expect(sessionWrites).toHaveLength(0);
  expect(button(S.saveToFile).disabled).toBe(false);
  const savedRevision = sources[0].revision;
  button(S.reloadSession).click();
  await vi.waitFor(() => expect(session).toHaveLength(3));
  expect(session[0].text).toBe('Later First Hello {{fixture.name}}');
  expect(writes[1].baseRevision).toBe(savedRevision);
});

it('refreshes variables and generated text after applying, preserving undo and reporting missing values', async () => {
  const { root, view, button, edit } = await mountPage();
  root.querySelector<HTMLElement>('.prompt-preview-toggle')!.click();
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.prompt-reference-label')!.textContent).toBe('Friend'));
  edit('New ');
  sources[0].vars[0].value = 'Partner'; generated = 'notes.md';
  button(S.reloadSession).click();
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.prompt-reference-label')!.textContent).toBe('Partner'));
  expect(view.state.doc.toString()).toContain('notes.md');
  button(S.undo).click();
  expect(view.state.doc.toString()).toContain('Hello {{fixture.name}}');
  expect(view.state.doc.toString()).not.toContain('New ');
  expect(view.state.doc.toString()).toContain('notes.md');
  delete sources[0].vars[0].value;
  root.querySelector<HTMLElement>('.prompt-preview-toggle')!.click();
  root.querySelector<HTMLElement>('.prompt-preview-toggle')!.click();
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.prompt-railwarn')!.textContent).toContain('fixture.name'));
});

it('retains empty editable templates omitted from the prefix and applies their restored content', async () => {
  sources[1].content = '';
  const { root, view, button } = await mountPage();
  const flag = () => root.querySelector<HTMLElement>(`[data-source="${worldKey}"]`)!;
  expect(flag().textContent).toContain(S.outsidePrefix);
  view.dispatch({ changes: { from: view.state.doc.length, insert: 'Restored environment' } });
  button(S.reloadSession).click();
  await vi.waitFor(() => expect(session.find((segment) => segment.sourceKey === worldKey)?.text).toBe('Restored environment'));
  await vi.waitFor(() => expect(flag().textContent).not.toContain(S.outsidePrefix));
});

it('reloads a template saved elsewhere so the next save uses its new revision', async () => {
  const { root, view, button } = await mountPage();
  expect(root.querySelector<HTMLElement>('.prefix-origin')!.textContent).toBe(S.originWorld);
  sources[1].content = 'Changed elsewhere'; sources[1].revision = '5'; sources[1].origin = 'deployment';
  button(S.reloadSession).click();
  await vi.waitFor(() => expect(view.state.doc.toString()).toContain('Changed elsewhere'));
  expect(root.querySelector<HTMLElement>('.prefix-origin')!.textContent).toBe(S.originDeployment);
  view.dispatch({ changes: { from: view.state.doc.toString().indexOf('Changed'), insert: 'Again ' } });
  button(S.saveToFile).click();
  await vi.waitFor(() => expect(sources[1].content).toBe('Again Changed elsewhere'));
  expect(writes.at(-1).baseRevision).toBe('5');
});

it('re-renders the full prefix preview from the saved files after Ctrl+S', async () => {
  const { root, edit } = await mountPage();
  edit('Saved ');
  root.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.prefix-full')!.textContent).toContain('Saved Hello'));
});

it('omits the World configuration shortcut when the manifest disables configuration', async () => {
  configAvailable = false;
  const { root } = await mountPage();
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>(`[data-source="${worldKey}"]`)!.textContent).toContain('Fixture World'));
  expect(root.querySelector<HTMLElement>('.prompt-settings-link')!).toBeNull();
});

it('keeps unsaved edits when World configuration navigation is cancelled', async () => {
  const { root, router, view, edit } = await mountPage();
  edit('Unsaved ');
  root.querySelector<HTMLElement>('.prompt-settings-link')!.click();
  await vi.waitFor(() => expect(document.querySelector('.confirm-card')).not.toBeNull());
  const reverted = new Promise<void>((resolve) => window.addEventListener('hashchange', () => resolve(), { once: true }));
  document.querySelector<HTMLButtonElement>('.confirm-card .btn')!.click();
  await reverted;
  await vi.waitFor(() => expect(document.querySelector('.confirm-card')).toBeNull());
  await vi.waitFor(() => expect(location.hash).toBe('#/prompts'));
  await vi.waitFor(() => expect(router.route.segments).toEqual(['prompts']));
  expect(view.state.doc.toString()).toContain('Unsaved Hello');
  root.querySelector<HTMLElement>('.prompt-settings-link')!.click();
  await vi.waitFor(() => expect(document.querySelector('.confirm-card')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('.confirm-card .btn.primary')!.click();
  await vi.waitFor(() => expect(router.route.segments).toEqual(['provider', 'world:fixture', '~config']));
  expect(router.route.query).toEqual({});
});

it('retains both the failed source and later unsaved sources when the first save fails', async () => {
  const { root, view, button, edit } = await mountPage();
  edit('New ');
  view.dispatch({ changes: { from: view.state.doc.toString().indexOf('Environment'), insert: 'New ' } });
  failures.add('instructions');
  button(S.saveToFile).click();
  await vi.waitFor(() => expect(root.querySelector('[role=status]')!.textContent).toContain('Revision conflict'));
  expect(root.querySelectorAll('.prompt-section-badge.is-dirty')).toHaveLength(2);
  failures.clear();
  button(S.saveToFile).click();
  await vi.waitFor(() => expect(button(S.saveToFile).disabled).toBe(true));
  await vi.waitFor(() => expect(root.querySelectorAll('.prompt-section-badge.is-dirty')).toHaveLength(0));
  expect(sources.every((source) => source.content.startsWith('New '))).toBe(true);
  expect(sessionWrites).toHaveLength(0);
});

it('keeps a failed source dirty after a partial save and retries only that source', async () => {
  const { root, view, button, edit } = await mountPage();
  edit('New ');
  const from = view.state.doc.toString().indexOf('Environment');
  view.dispatch({ changes: { from, insert: 'New ' } });
  failures.add(worldKey); button(S.reloadSession).click();
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[role=status]')!.textContent).toContain('Revision conflict'));
  expect(sessionWrites).toHaveLength(0);
  expect(root.querySelector<HTMLElement>('[data-source="instructions"] .is-dirty')!).toBeNull();
  expect(root.querySelector<HTMLElement>(`[data-source="${worldKey}"] .is-dirty`)!).not.toBeNull();
  failures.clear(); button(S.reloadSession).click();
  await vi.waitFor(() => expect(session).toHaveLength(3));
  expect(writes.filter((write) => write.key === 'instructions')).toHaveLength(1);
  expect(session.filter((segment) => segment.sourceKey).every((segment) => segment.text.startsWith('New '))).toBe(true);
});

it('abandons a pending save on unmount without applying the session', async () => {
  const { life, button, edit } = await mountPage();
  saveGate = deferred(); edit('New '); button(S.reloadSession).click();
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  life.dispose(); saveGate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sources[0].content).toBe('Hello {{fixture.name}}');
  expect(sessionWrites).toHaveLength(0);
});

it('remembers folds across page mounts and resets them in a new window session', async () => {
  const first = await mountPage();
  const flag = (root: HTMLElement, key: string) => root.querySelector<HTMLElement>(`[data-source="${key}"] button`)!;
  expect(flag(first.root, 'instructions').getAttribute('aria-expanded')).toBe('true');
  expect(flag(first.root, worldKey).getAttribute('aria-expanded')).toBe('true');
    flag(first.root, 'instructions').click();
  first.life.dispose(); first.root.remove();
  const next = await mountPage();
  expect(flag(next.root, 'instructions').getAttribute('aria-expanded')).toBe('false');
  expect(flag(next.root, worldKey).getAttribute('aria-expanded')).toBe('true');
  expect(next.view.dom.querySelector('.prefix-comment[data-block="1"] button').getAttribute('aria-expanded')).toBe('true');
  next.button(S.expandAll).click();
  next.life.dispose(); next.root.remove();
  const expanded = await mountPage();
  expect(expanded.button(S.collapseAll)).toBeTruthy();
  expect([...expanded.root.querySelectorAll('.prefix-flag')].every((el) => el.getAttribute('aria-expanded') === 'true')).toBe(true);
  expanded.life.dispose(); expanded.root.remove();
  sessionStorage.clear();
  const restarted = await mountPage();
  expect(flag(restarted.root, 'instructions').getAttribute('aria-expanded')).toBe('true');
  expect(flag(restarted.root, worldKey).getAttribute('aria-expanded')).toBe('true');
});

});
