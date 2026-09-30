/**
 * @vitest-environment jsdom
 * 使用模拟 DOM 与接口验证页面行为；浏览器源码由变量动态 import 加载，类型由 tsconfig.web.json 检查。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UI = '../../src/web/client/ui/index.ts';
const LIFECYCLE = '../../src/web/client/core/lifecycle.ts';
const ROUTER = '../../src/web/client/core/router.ts';
const PROMPTS = '../../src/web/client/features/prompts/index.ts';
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
    const body = reply
      ? reply(u, method)
      : method === 'POST' ? { ok: true, result: '已保存', revision: 'r-new' }
        : u === '/api/prompts' ? DOCS
          : u === '/api/prompts/prefix' ? PREFIX
            : {};
    return Promise.resolve(new Response(JSON.stringify(body ?? {}), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
  });
}

function mkCtx(caps: Record<string, boolean> = { prompts: true }): Any {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const lifecycle = new Lifecycle(() => {});
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

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); });

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
    expect(text).toContain('{{qq.identity}}');
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
    expect(flags.map((f: Any) => f.textContent)).toEqual([
      'ORIENTATION', '环境:qqWorld', 'Using your tools',
    ]);
    // 按来源分档上色,只读那面另有标记
    expect(flags.map((f: Any) => f.className)).toEqual([
      'prefix-flag tone-persona',
      'prefix-flag tone-world',
      'prefix-flag tone-derived flag-readonly',
    ]);
  });

  it('左侧标签与右栏取同一份块几何——两边都跟内容对齐', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    const flagTops = [...root.querySelectorAll('.prefix-flag')].map((f: Any) => f.style.top);
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

    expect(root.querySelector('.varpop')).toBe(null);
    (root.querySelector('.varchip') as HTMLElement).click();
    const pop = root.querySelector('.varpop')!;
    expect(pop.textContent).toContain('{{qq.identity}}');
    expect(pop.textContent).toContain('你自己的 QQ 号');
    expect(pop.textContent).toContain('你的QQ号是99。'); // 此刻的实际展开值
    (root.querySelector('.varchip') as HTMLElement).click();
    expect(root.querySelector('.varpop')).toBe(null);
  });

  it('浮层:点外面立刻消失,而且关掉之后同一颗还能再点开', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await prompts.mountPrompts(ctx);
    await flush();
    const chip = root.querySelector('.varchip') as HTMLElement;

    chip.click();
    expect(root.querySelector('.varpop')).toBeTruthy();

    // 点浮层以外的任何地方 → 立刻收起
    (root.querySelector('.prompt-toolbar') as HTMLElement).click();
    expect(root.querySelector('.varpop')).toBe(null);

    chip.click();
    expect(root.querySelector('.varpop')).toBeTruthy();

    // 点浮层内部不关
    (root.querySelector('.varpop') as HTMLElement).click();
    expect(root.querySelector('.varpop')).toBeTruthy();

    // Esc 关
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(root.querySelector('.varpop')).toBe(null);
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
    const lines = [...root.querySelectorAll('.prefix-divider')];
    expect(lines.length).toBe(3);
    // 三条线与三面旗同高——它们本来就是同一份块几何
    expect(lines.map((l: Any) => l.style.top))
      .toEqual([...root.querySelectorAll('.prefix-flag')].map((f: Any) => f.style.top));
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

    grip.dispatchEvent(new MouseEvent('pointerdown', { clientX: 500, bubbles: true }));
    // 右栏在右边:往左拖是变宽
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 460 }));
    expect(parseFloat(rail.style.flexBasis)).toBe(before + 40);

    document.dispatchEvent(new MouseEvent('pointerup', {}));
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }));
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
