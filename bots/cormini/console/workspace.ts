/**
 * 面板 `workspace`——工作区的目录树 + 编辑器。路径前缀是服务端回报的工作区目录名。
 *
 * 保存/删除/改名带 sha256 `baseRevision`;冲突回执是 `ok:false, conflict:true`。
 * 未保存改动走 `ctx.guardLeave`。键盘监听只挂在编辑器节点上,随 `ctx.signal` 摘掉。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import {
  autoload, colorDiff, dimLine, errText, setMsg, stamp,
  type Commit, type WorkspaceFile, type WorkspaceNode, type WorkspaceTree,
  type WorkspaceWriteResult,
} from './shared.ts';

/** `body` 缺省 = 空文件。 */
export interface NewFileTemplate {
  value: string;
  label: string;
  body?(title: string): string;
}

export interface WorkspacePanelOptions {
  /** 首项默认选中。 */
  templates?: readonly NewFileTemplate[];
  /** 新建文件的默认目录。 */
  defaultDir?: string;
}

const DEFAULT_TEMPLATES: readonly NewFileTemplate[] = [
  { value: 'blank', label: '空白' },
  { value: 'note', label: '笔记', body: (title) => `# ${title}\n\n` },
];

function templateText(
  templates: readonly NewFileTemplate[],
  type: string,
  name: string,
): string {
  const title = String(name || '新档案').replace(/\.[^.]+$/, '');
  return templates.find((t) => t.value === type)?.body?.(title) ?? '';
}

/** 工作区目录的绝对路径 → 它自己的名字。 */
function rootName(abs: string): string {
  return abs.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'workspace';
}

const sizeText = (n: number | undefined, ctx: ConsolePanelContext): string =>
  n == null ? '' : ctx.ui.fmt.bytes(n);

function markdownPreview(ctx: ConsolePanelContext, source: string): string {
  const esc = (s: string): string => ctx.ui.esc(s);
  let inCode = false;
  let out = '';
  for (const raw of String(source || '').split('\n')) {
    const line = esc(raw);
    if (/^```/.test(raw)) {
      inCode = !inCode;
      out += inCode ? '<pre><code>' : '</code></pre>';
      continue;
    }
    if (inCode) { out += `${line}\n`; continue; }
    const head = /^(#{1,6})\s+(.+)$/.exec(raw);
    if (head) {
      const n = head[1].length;
      out += `<h${n}>${esc(head[2])}</h${n}>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(raw)) {
      out += `<div>• ${esc(raw.replace(/^\s*[-*]\s+/, ''))}</div>`;
      continue;
    }
    if (/^>\s?/.test(raw)) {
      out += `<blockquote>${esc(raw.replace(/^>\s?/, ''))}</blockquote>`;
      continue;
    }
    out += raw.trim()
      ? `<p>${line.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</p>`
      : '<br>';
  }
  return out;
}

// ---------------------------------------------------------------------------

export function createWorkspacePanel(options: WorkspacePanelOptions = {}): ConsolePanel {
  return {
    mount(ctx: ConsolePanelContext) {
      autoload<WorkspaceTree>(ctx, {
        loading: '读取工作区目录树…',
        failed: '工作区不可用',
        load: () => ctx.invoke<WorkspaceTree>('tree'),
        // 刷新目录树时保留编辑器及未保存修改。
        render: (tree) => [new WorkspaceView(ctx, tree, options).el],
      });
    },
  };
}

class WorkspaceView {
  readonly el: HTMLElement;

  private readonly ctx: ConsolePanelContext;

  private nodes: WorkspaceNode[];
  private filter = '';

  /** 路径前缀:工作区目录自己的名字。 */
  private readonly root: string;
  private readonly templates: readonly NewFileTemplate[];
  private readonly defaultDir: string;

  /** 当前打开的档案。null = 还没选。 */
  private cur: { path: string; content: string; revision: string; node: WorkspaceNode | null } | null = null;

  private readonly treePane: HTMLDivElement;
  private readonly pane: HTMLDivElement;
  private readonly editor: HTMLTextAreaElement;
  private readonly preview: HTMLDivElement;
  private readonly editWrap: HTMLDivElement;
  private readonly histWrap: HTMLDivElement;
  private readonly pathLabel: HTMLElement;
  private readonly metaLabel: HTMLElement;
  private readonly stateLabel: HTMLElement;
  private readonly msg: HTMLDivElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly fileBtns: HTMLButtonElement[];
  private readonly findBar: HTMLDivElement;
  private readonly findInput: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly findCount: HTMLElement;

  /** 仅应用最近一次打开文件请求的结果。 */
  private openSeq = 0;

  constructor(ctx: ConsolePanelContext, tree: WorkspaceTree, options: WorkspacePanelOptions) {
    this.ctx = ctx;
    this.nodes = tree.nodes;
    this.root = rootName(tree.root);
    this.templates = options.templates ?? DEFAULT_TEMPLATES;
    this.defaultDir = options.defaultDir ?? '';
    const { ui } = ctx;

    const card = ui.sheet({
      title: '工作区',
      en: `${this.root}/`,
      desc: '保存时以 operator 署名提交到工作区的 Git 仓库。',
    });

    const filterInput = ui.input({
      type: 'search',
      placeholder: '过滤档案名…',
      onInput: (v) => { this.filter = v.trim(); this.renderTree(); },
    });
    filterInput.classList.add('ct-filter');
    const top = ui.rowbar();
    top.append(
      ui.button('新建', { size: 'sm', variant: 'primary', onClick: () => this.openNewDialog() }),
      ui.button('刷新', { size: 'sm', onClick: () => { void this.refreshTree(); } }),
      filterInput,
      ui.h('span', 'grow'),
    );
    card.body.appendChild(top);

    // ---- 主体:树 | 编辑区 ----
    this.treePane = ui.h('div', 'ct-tree');
    this.pane = ui.h('div', 'ct-pane');

    this.pathLabel = ui.h('div', 'ct-path', '还没有打开档案');
    this.metaLabel = ui.h('span', 'ct-dim');
    this.stateLabel = ui.h('span', 'ct-dim');
    this.msg = ui.msgline('');

    this.saveBtn = ui.button('保存', { size: 'sm', variant: 'primary', onClick: () => { void this.save(); } });
    const reloadBtn = ui.button('还原', { size: 'sm', onClick: () => { void this.revert(); } });
    const findBtn = ui.button('查找', { size: 'sm', onClick: () => this.toggleFind(true) });
    const histBtn = ui.button('历史', { size: 'sm', onClick: () => { void this.showHistory(); } });
    const renameBtn = ui.button('改名', { size: 'sm', onClick: () => this.openRenameDialog() });
    const delBtn = ui.button('删除', { size: 'sm', variant: 'danger', onClick: () => { void this.remove(); } });
    this.fileBtns = [this.saveBtn, reloadBtn, findBtn, histBtn, renameBtn, delBtn];

    const mode = ui.segmented(
      [{ value: 'edit', label: '编辑' }, { value: 'split', label: '分栏' }, { value: 'preview', label: '预览' }],
      {
        size: 'sm',
        value: ctx.memo.get<string>('ws.mode', 'edit'),
        onSelect: (v) => { ctx.memo.set('ws.mode', v); this.setMode(v); },
      },
    );

    const bar = ui.rowbar();
    bar.append(this.pathLabel, ui.h('span', 'grow'), mode.el, ...this.fileBtns);

    // ---- 查找栏 ----
    this.findInput = ui.input({
      placeholder: '查找',
      onInput: () => this.updateFindCount(),
      onCommit: () => this.jumpFind(1),
    });
    this.replaceInput = ui.input({ placeholder: '替换为' });
    this.findCount = ui.h('span', 'ct-dim', '无匹配');
    this.findBar = ui.rowbar();
    this.findBar.classList.add('ct-findbar', 'ct-hidden');
    this.findBar.append(
      this.findInput,
      ui.button('上一个', { size: 'sm', onClick: () => this.jumpFind(-1) }),
      ui.button('下一个', { size: 'sm', onClick: () => this.jumpFind(1) }),
      this.findCount,
      this.replaceInput,
      ui.button('替换', { size: 'sm', onClick: () => this.replaceOne() }),
      ui.button('全部替换', { size: 'sm', onClick: () => this.replaceAll() }),
      ui.h('span', 'grow'),
      ui.button('关闭', { size: 'sm', onClick: () => this.toggleFind(false) }),
    );

    // ---- 编辑器本体 ----
    this.editor = ui.textarea({
      cls: 'mono ct-textarea',
      onInput: () => { this.syncMeta(); this.updateFindCount(); },
    });
    this.editor.spellcheck = false;
    this.preview = ui.h('div', 'ct-preview');
    this.editWrap = ui.h('div', 'ct-editwrap');
    this.editWrap.append(this.editor, this.preview);

    this.histWrap = ui.h('div', 'ct-hist ct-hidden');

    const foot = ui.rowbar();
    foot.append(this.metaLabel, ui.h('span', 'grow'), this.stateLabel);

    this.pane.append(bar, this.findBar, this.editWrap, this.histWrap, foot, this.msg);

    const split = ui.h('div', 'ct-ws');
    split.append(this.treePane, this.pane);
    card.body.appendChild(split);

    this.el = card.el;

    for (const type of ['click', 'keyup'] as const) {
      this.editor.addEventListener(type, () => this.syncMeta(), { signal: ctx.signal });
    }
    this.editor.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Tab') return;
      ev.preventDefault();
      const a = this.editor;
      a.setRangeText('  ', a.selectionStart, a.selectionEnd, 'end');
      this.syncMeta();
    }, { signal: ctx.signal });

    /**
     * 离开拦截：返回提示文本时请求用户确认，返回 null 时放行。面板卸载时框架自动解除。
     */
    ctx.guardLeave(() => (this.dirty() ? '工作区里有未保存的改动,离开会丢弃它们。' : null));

    this.setMode(mode.value || 'edit');
    this.renderTree();
    this.setPane('empty');
    this.syncMeta();
  }

  // -------------------------------------------------------------------------
  // 目录树
  // -------------------------------------------------------------------------

  /** 按路径过滤文件；目录包含匹配子项时保留。 */
  private filtered(nodes: WorkspaceNode[]): WorkspaceNode[] {
    const q = this.filter.toLocaleLowerCase();
    if (!q) return nodes;
    const walk = (n: WorkspaceNode): WorkspaceNode | null => {
      const hit = (n.path || n.name).toLocaleLowerCase().includes(q);
      if (n.type === 'file') return hit ? n : null;
      const children = (n.children ?? []).map(walk).filter((x): x is WorkspaceNode => !!x);
      return children.length || hit ? { ...n, children } : null;
    };
    return nodes.map(walk).filter((x): x is WorkspaceNode => !!x);
  }

  /**
   * 刷新目录树时保留编辑器正文、光标、未保存状态和滚动位置。
   */
  private async refreshTree(): Promise<void> {
    try {
      const tree = await this.ctx.invoke<WorkspaceTree>('tree');
      if (this.ctx.signal.aborted) return;
      this.nodes = tree.nodes;
      this.renderTree();
      if (this.cur) this.markSelected(this.cur.path);
    } catch {
      // 刷新失败时保留当前目录树和编辑状态。
    }
  }

  private renderTree(): void {
    const { ui } = this.ctx;
    const nodes = this.filtered(this.nodes);
    this.treePane.replaceChildren();
    if (!nodes.length) {
      this.treePane.appendChild(ui.placeholder(this.filter ? '没有匹配的档案' : `${this.root}/ 是空的`));
      return;
    }
    this.renderRows(nodes, this.treePane, 0, !!this.filter);
  }

  /** 展开状态记在 `ctx.memo` 里(按 provider:panel 命名空间隔离),跨导航恢复。 */
  private openDirs(): Set<string> {
    return new Set(this.ctx.memo.get<string[]>('ws.openDirs', ['']));
  }

  private saveOpenDirs(dirs: Set<string>): void {
    this.ctx.memo.set('ws.openDirs', [...dirs]);
  }

  private renderRows(
    nodes: WorkspaceNode[],
    container: HTMLElement,
    depth: number,
    forceOpen: boolean,
  ): void {
    const { ui } = this.ctx;
    const open = this.openDirs();
    for (const n of nodes) {
      const row = ui.h('div', `treerow${n.type === 'dir' ? ' dir' : ''}`);
      row.style.paddingLeft = `${depth * 14 + 10}px`;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      if (n.type === 'dir') {
        const shown = forceOpen || depth === 0 || open.has(n.path);
        const label = ui.h('span', null, `${shown ? '▾ ' : '▸ '}${n.name}/`);
        const box = ui.h('div', shown ? null : 'ct-hidden');
        row.appendChild(label);
        row.setAttribute('aria-expanded', String(shown));
        const toggle = (): void => {
          const hidden = box.classList.toggle('ct-hidden');
          const dirs = this.openDirs();
          if (hidden) dirs.delete(n.path); else dirs.add(n.path);
          this.saveOpenDirs(dirs);
          label.textContent = `${hidden ? '▸ ' : '▾ '}${n.name}/`;
          row.setAttribute('aria-expanded', String(!hidden));
        };
        row.addEventListener('click', toggle, { signal: this.ctx.signal });
        row.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          ev.preventDefault();
          toggle();
        }, { signal: this.ctx.signal });
        container.append(row, box);
        this.renderRows(n.children ?? [], box, depth + 1, forceOpen);
        continue;
      }
      row.dataset.path = n.path;
      if (this.cur?.path === n.path) row.classList.add('sel');
      row.append(ui.h('span', null, n.name), ui.h('span', 'fsize', sizeText(n.size, this.ctx)));
      const open1 = (): void => { void this.openFile(n); };
      row.addEventListener('click', open1, { signal: this.ctx.signal });
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') open1();
      }, { signal: this.ctx.signal });
      container.appendChild(row);
    }
  }

  private markSelected(path: string): void {
    for (const row of this.treePane.querySelectorAll('.treerow.sel')) row.classList.remove('sel');
    const sel = this.treePane.querySelector(`.treerow[data-path="${CSS.escape(path)}"]`);
    sel?.classList.add('sel');
  }

  // -------------------------------------------------------------------------
  // 打开 / 保存 / 删除 / 改名
  // -------------------------------------------------------------------------

  private dirty(): boolean {
    return !!this.cur && this.editor.value !== this.cur.content;
  }

  private async canLeaveCurrent(): Promise<boolean> {
    if (!this.dirty()) return true;
    return this.ctx.ui.confirm({
      title: '放弃未保存的改动?',
      body: `${this.root}/${this.cur?.path} 改过还没保存。打开别的档案会丢掉这些改动。`,
      danger: true,
    });
  }

  private async openFile(node: WorkspaceNode | { path: string }, force = false): Promise<void> {
    const path = node.path;
    if (!force && this.cur && this.cur.path !== path && !(await this.canLeaveCurrent())) return;
    const seq = ++this.openSeq;
    this.pathLabel.textContent = `正在展开 ${this.root}/${path}…`;
    try {
      const file = await this.ctx.invoke<WorkspaceFile>('read', [path]);
      if (seq !== this.openSeq || this.ctx.signal.aborted) return;
      this.cur = {
        path: file.path,
        content: file.content,
        revision: file.revision,
        node: 'type' in node ? (node as WorkspaceNode) : null,
      };
      this.editor.value = file.content;
      this.pathLabel.textContent = `${this.root}/${file.path}`;
      this.pathLabel.title = `${this.root}/${file.path}`;
      this.metaLabel.textContent = `${this.ctx.ui.fmt.bytes(file.size)} · ${stamp(file.mtime)}`;
      setMsg(this.msg, '');
      this.setPane('edit');
      this.markSelected(file.path);
      this.syncMeta();
      this.updateFindCount();
    } catch (err) {
      if (seq !== this.openSeq || this.ctx.signal.aborted) return;
      this.pathLabel.textContent = '读取失败';
      setMsg(this.msg, `读取失败: ${errText(err)}`, true);
    }
  }

  private async save(): Promise<void> {
    if (!this.cur || !this.dirty()) return;
    const content = this.editor.value;
    const busy = this.ctx.ui.disable(...this.fileBtns);
    setMsg(this.msg, '保存中…');
    try {
      const out = await this.ctx.invoke<WorkspaceWriteResult>(
        'write',
        [this.cur.path, content, this.cur.revision],
      );
      if (!out.ok) {
        setMsg(this.msg, out.error, true);
        return;
      }
      this.cur.content = content;
      this.cur.revision = out.revision;
      setMsg(this.msg, out.result);
      void this.refreshTree();
    } catch (err) {
      setMsg(this.msg, `保存失败: ${errText(err)}`, true);
    } finally {
      busy.dispose();
      this.syncMeta();
    }
  }

  private async revert(): Promise<void> {
    if (!this.cur || !this.dirty()) return;
    const ok = await this.ctx.ui.confirm({ title: '放弃当前未保存的修改?' });
    if (!ok || !this.cur) return;
    this.editor.value = this.cur.content;
    setMsg(this.msg, '已恢复到最近保存的版本');
    this.syncMeta();
  }

  private async remove(): Promise<void> {
    if (!this.cur) return;
    const path = this.cur.path;
    const ok = await this.ctx.ui.confirm({
      title: `删除 ${this.root}/${path}?`,
      body: '未保存的修改将丢失。已提交的版本可从「版本历史」恢复。',
      danger: true,
    });
    if (!ok || !this.cur) return;
    try {
      const out = await this.ctx.invoke<WorkspaceWriteResult>('remove', [path, this.cur.revision]);
      if (!out.ok) { setMsg(this.msg, out.error, true); return; }
      this.cur = null;
      this.editor.value = '';
      this.pathLabel.textContent = '档案已删除';
      this.setPane('empty');
      setMsg(this.msg, out.result);
      void this.refreshTree();
    } catch (err) {
      setMsg(this.msg, `删除失败: ${errText(err)}`, true);
    }
  }

  // -------------------------------------------------------------------------
  // 新建 / 改名(抽屉里的小表单;`ui.drawer` 收得下节点)
  // -------------------------------------------------------------------------

  private openNewDialog(): void {
    const { ui } = this.ctx;
    const dirOf = this.cur?.path.includes('/')
      ? this.cur.path.slice(0, this.cur.path.lastIndexOf('/'))
      : this.defaultDir;
    const dir = ui.input({ value: dirOf, placeholder: this.defaultDir });
    const name = ui.input({ placeholder: '文件名.md' });
    const tpl = ui.select({ options: this.templates.map((t) => ({ value: t.value, label: t.label })) });
    const body = ui.textarea({ rows: 8, cls: 'mono' });
    const path = ui.h('div', 'ct-dim');
    const msg = ui.msgline('');

    const fullPath = (): string =>
      [dir.value.trim().replace(/^[\\/]+|[\\/]+$/g, ''), name.value.trim()].filter(Boolean).join('/');
    const sync = (): void => { path.textContent = `${this.root}/${fullPath()}`; };
    for (const el of [dir, name]) {
      el.addEventListener('input', sync, { signal: this.ctx.signal });
    }
    tpl.addEventListener('change', () => {
      body.value = templateText(this.templates, tpl.value, name.value);
    }, { signal: this.ctx.signal });
    sync();

    const create = ui.button('创建', {
      variant: 'primary',
      onClick: () => {
        const p = fullPath();
        if (!p || !name.value.trim()) { setMsg(msg, '请填写文件名', true); return; }
        const busy = ui.disable(create);
        setMsg(msg, '创建中…');
        // createOnly 在同名文件已存在时拒绝写入。
        void this.ctx.invoke<WorkspaceWriteResult>('write', [p, body.value, null, true])
          .then(
            (out) => {
              if (!out.ok) { setMsg(msg, out.error, true); return; }
              drawer.dispose();
              void this.refreshTree();
              void this.openFile({ path: p }, true);
            },
            (err: unknown) => { setMsg(msg, `创建失败: ${errText(err)}`, true); },
          )
          .finally(() => { busy.dispose(); });
      },
    });

    const form = ui.h('div', 'ct-form');
    form.append(
      ui.field('目录', dir),
      ui.field('文件名', name),
      ui.field('模板', tpl),
      ui.field('正文', body),
      path,
      (() => { const r = ui.actions(); r.append(msg, ui.h('span', 'grow'), create); return r; })(),
    );
    const drawer = ui.drawer('新建档案', form);
  }

  private openRenameDialog(): void {
    if (!this.cur) return;
    const { ui } = this.ctx;
    if (this.dirty()) { setMsg(this.msg, '请先保存或放弃修改,再重命名', true); return; }
    const from = this.cur.path;
    const to = ui.input({ value: from, cls: 'mono' });
    const msg = ui.msgline('');
    const apply = ui.button('改名', {
      variant: 'primary',
      onClick: () => {
        const target = to.value.trim();
        if (!target || target === from) { setMsg(msg, '请输入不同的新路径', true); return; }
        const busy = ui.disable(apply);
        void this.ctx.invoke<WorkspaceWriteResult>('rename', [from, target, this.cur?.revision ?? null])
          .then(
            (out) => {
              if (!out.ok) { setMsg(msg, out.error, true); return; }
              drawer.dispose();
              this.cur = null;
              void this.refreshTree();
              void this.openFile({ path: target }, true);
            },
            (err: unknown) => { setMsg(msg, `改名失败: ${errText(err)}`, true); },
          )
          .finally(() => { busy.dispose(); });
      },
    });
    const form = ui.h('div', 'ct-form');
    form.append(
      dimLine(this.ctx, `当前:${this.root}/${from}`),
      ui.field(`新路径(相对 ${this.root}/)`, to),
      (() => { const r = ui.actions(); r.append(msg, ui.h('span', 'grow'), apply); return r; })(),
    );
    const drawer = ui.drawer('改名 / 移动', form);
  }

  // -------------------------------------------------------------------------
  // 这一份档案的历史
  // -------------------------------------------------------------------------

  private async showHistory(): Promise<void> {
    if (!this.cur) return;
    const { ui } = this.ctx;
    const path = this.cur.path;
    this.setPane('hist');
    this.histWrap.replaceChildren(ui.placeholder('加载历史…'));
    let commits: Commit[] = [];
    try {
      commits = (await this.ctx.invoke<{ commits: Commit[] }>('history', [path])).commits;
    } catch (err) {
      if (this.ctx.signal.aborted) return;
      this.histWrap.replaceChildren(ui.placeholder(`历史加载失败: ${errText(err)}`));
      return;
    }
    if (this.ctx.signal.aborted) return;
    const back = ui.rowbar();
    back.append(
      ui.button('← 返回编辑器', { size: 'sm', onClick: () => this.setPane('edit') }),
      ui.h('span', 'grow'),
      ui.h('span', 'ct-dim', `${this.root}/${path}`),
    );
    this.histWrap.replaceChildren(back);
    if (!commits.length) {
      this.histWrap.appendChild(ui.placeholder('这个档案还没有提交历史'));
      return;
    }
    for (const c of commits) this.histWrap.append(...this.commitRow(c, path));
  }

  private commitRow(c: Commit, path: string): Node[] {
    const { ui } = this.ctx;
    const row = ui.h('div', 'histrow');
    const head = ui.h('div', 'hh');
    head.append(
      ui.h('span', 'hhash', c.hash),
      ui.h('span', 'hauthor', c.author),
      ui.h('span', 'hdate', stamp(c.date)),
    );
    row.append(head, ui.h('div', 'hmsg', c.message));
    const detail = ui.h('div');
    let open = false;
    row.addEventListener('click', () => {
      if (open) { detail.replaceChildren(); open = false; return; }
      open = true;
      detail.replaceChildren(ui.placeholder('加载 diff…'));
      void Promise.all([
        this.ctx.invoke<{ diff: string }>('diff', [c.fullHash, path]),
        this.ctx.invoke<{ content: string }>('at', [c.fullHash, path]),
      ]).then(
        ([d, f]) => {
          if (this.ctx.signal.aborted) return;
          const bar = ui.rowbar();
          bar.append(
            ui.button('查看全文', {
              size: 'sm',
              onClick: () => { ui.drawer(`${this.root}/${path} @ ${c.hash}`, f.content); },
            }),
            ui.button('恢复为当前草稿', {
              size: 'sm',
              onClick: () => {
                this.setPane('edit');
                this.editor.value = f.content;
                this.syncMeta();
                setMsg(this.msg, '已载入旧版本，保存后生效');
              },
            }),
            ui.copyButton(() => f.content, { label: '复制全文' }),
          );
          detail.replaceChildren(colorDiff(this.ctx, d.diff), bar);
        },
        (err: unknown) => {
          if (this.ctx.signal.aborted) return;
          detail.replaceChildren(ui.placeholder(`diff 失败: ${errText(err)}`));
        },
      );
    }, { signal: this.ctx.signal });
    return [row, detail];
  }

  // -------------------------------------------------------------------------
  // 版式:编辑 / 分栏 / 预览、编辑区 / 历史区
  // -------------------------------------------------------------------------

  private setMode(mode: string): void {
    this.editWrap.classList.toggle('ct-mode-edit', mode === 'edit');
    this.editWrap.classList.toggle('ct-mode-split', mode === 'split');
    this.editWrap.classList.toggle('ct-mode-preview', mode === 'preview');
    if (mode !== 'edit') this.preview.innerHTML = markdownPreview(this.ctx, this.editor.value);
  }

  private setPane(kind: 'empty' | 'edit' | 'hist'): void {
    this.editWrap.classList.toggle('ct-hidden', kind !== 'edit');
    this.histWrap.classList.toggle('ct-hidden', kind !== 'hist');
    this.findBar.classList.toggle('ct-hidden', kind !== 'edit' || this.findBar.dataset.open !== '1');
    for (const b of this.fileBtns) b.disabled = kind === 'empty';
    if (kind === 'empty') {
      this.pathLabel.textContent = '还没有打开档案';
      this.metaLabel.textContent = '';
      this.stateLabel.textContent = '';
    }
  }

  private syncMeta(): void {
    const text = this.editor.value;
    const before = text.slice(0, this.editor.selectionStart);
    const line = before.split('\n').length;
    const col = before.length - before.lastIndexOf('\n');
    const dirty = this.dirty();
    this.stateLabel.textContent = this.cur
      ? `第 ${line} 行 第 ${col} 列 · ${text.split('\n').length} 行 ${text.length} 字 · ${dirty ? '● 未保存' : '✓ 已保存'}`
      : '';
    this.saveBtn.disabled = !dirty;
    if (!this.editWrap.classList.contains('ct-mode-edit')) {
      this.preview.innerHTML = markdownPreview(this.ctx, text);
    }
  }

  // -------------------------------------------------------------------------
  // 查找 / 替换(纯前端,不发请求)
  // -------------------------------------------------------------------------

  private toggleFind(open: boolean): void {
    this.findBar.dataset.open = open ? '1' : '';
    this.findBar.classList.toggle('ct-hidden', !open);
    if (!open) { this.editor.focus(); return; }
    this.findInput.focus();
    this.findInput.select();
    this.updateFindCount();
  }

  private matches(): number[] {
    const needle = this.findInput.value;
    const text = this.editor.value;
    const out: number[] = [];
    if (!needle) return out;
    let at = 0;
    while ((at = text.indexOf(needle, at)) >= 0) {
      out.push(at);
      at += Math.max(1, needle.length);
    }
    return out;
  }

  private updateFindCount(): void {
    const n = this.matches().length;
    this.findCount.textContent = n ? `${n} 处` : '无匹配';
  }

  private jumpFind(dir: 1 | -1): void {
    const ms = this.matches();
    if (!ms.length) return;
    const from = dir > 0 ? this.editor.selectionEnd : this.editor.selectionStart;
    let at = dir > 0 ? ms.find((x) => x >= from) : [...ms].reverse().find((x) => x < from);
    if (at == null) at = dir > 0 ? ms[0] : ms[ms.length - 1];
    this.editor.focus();
    this.editor.setSelectionRange(at, at + this.findInput.value.length);
    this.syncMeta();
  }

  private replaceOne(): void {
    const needle = this.findInput.value;
    if (!needle) return;
    const a = this.editor;
    if (a.value.slice(a.selectionStart, a.selectionEnd) !== needle) this.jumpFind(1);
    if (a.value.slice(a.selectionStart, a.selectionEnd) === needle) {
      a.setRangeText(this.replaceInput.value, a.selectionStart, a.selectionEnd, 'end');
    }
    this.syncMeta();
    this.updateFindCount();
  }

  private replaceAll(): void {
    const needle = this.findInput.value;
    if (!needle) return;
    this.editor.value = this.editor.value.split(needle).join(this.replaceInput.value);
    this.syncMeta();
    this.updateFindCount();
  }
}
