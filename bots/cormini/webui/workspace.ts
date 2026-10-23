/**
 * 面板 `workspace`——工作区的目录树 + 编辑器。路径前缀是服务端回报的工作区目录名。
 *
 * 保存/删除/改名带 sha256 `baseRevision`;冲突回执是 `ok:false, conflict:true`。
 * 未保存改动走 `ctx.guardLeave`。键盘监听只挂在编辑器节点上,随 `ctx.signal` 摘掉。
 */

import type {
  WebUiPanelContext,
  WebUiPanel,
} from 'cortico/web/shared/client-panel.ts';
import {
  autoload, colorDiff, dimLine, errText, setMsg, stamp,
  type Commit, type WorkspaceFile, type WorkspaceNode, type WorkspaceTree,
  type WorkspaceWriteResult,
} from './shared.ts';
import { workspaceText } from './strings.ts';

type Text = ReturnType<typeof workspaceText>;

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

function defaultTemplates(T: Text): readonly NewFileTemplate[] {
  return [
    { value: 'blank', label: T.templateBlank },
    { value: 'note', label: T.templateNote, body: (title) => `# ${title}\n\n` },
  ];
}

function templateText(
  templates: readonly NewFileTemplate[],
  type: string,
  name: string,
  untitled: string,
): string {
  const title = String(name || untitled).replace(/\.[^.]+$/, '');
  return templates.find((t) => t.value === type)?.body?.(title) ?? '';
}

/** 工作区目录的绝对路径 → 它自己的名字。 */
function rootName(abs: string): string {
  return abs.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'workspace';
}

const sizeText = (n: number | undefined, ctx: WebUiPanelContext): string =>
  n == null ? '' : ctx.ui.fmt.bytes(n);

function markdownPreview(ctx: WebUiPanelContext, source: string): string {
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

const svg = (body: string): string =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_NEW = svg('<path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z"/><path d="M9 2v4h4M8 8.5v3.5M6.25 10.25h3.5"/>');
const ICON_REFRESH = svg('<path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M13 2.5v3h-3"/>');
const ICON_SIDE = svg('<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6.5 3v10"/>');

/** 侧栏标题行里的小图标按钮:只有图标,名字在 title 和 aria-label 里。 */
function iconButton(ctx: WebUiPanelContext, cls: string, icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const btn = ctx.ui.h('button', ('ct-iconbtn ' + cls).trim());
  btn.type = 'button';
  btn.innerHTML = icon;
  if (label) {
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  btn.addEventListener('click', onClick, { signal: ctx.signal });
  return btn;
}

// ---------------------------------------------------------------------------

export function createWorkspacePanel(options: WorkspacePanelOptions = {}): WebUiPanel {
  return {
    mount(ctx: WebUiPanelContext) {
      const T = workspaceText(ctx.language);
      autoload<WorkspaceTree>(ctx, {
        loading: T.treeLoading,
        failed: T.workspaceFailed,
        load: () => ctx.invoke<WorkspaceTree>('tree'),
        // 刷新目录树时保留编辑器及未保存修改。
        render: (tree) => [new WorkspaceView(ctx, tree, options).el],
      });
    },
  };
}

class WorkspaceView {
  readonly el: HTMLElement;

  private readonly ctx: WebUiPanelContext;
  private readonly T: Text;

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
  /** 打开了文件时的整块（文件头、工具行、编辑区、页脚）；没打开时换成空态。 */
  private readonly fileArea: HTMLDivElement;
  private readonly emptyNote: HTMLElement;
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

  constructor(ctx: WebUiPanelContext, tree: WorkspaceTree, options: WorkspacePanelOptions) {
    this.ctx = ctx;
    const T = workspaceText(ctx.language);
    this.T = T;
    this.nodes = tree.nodes;
    this.root = rootName(tree.root);
    this.templates = options.templates ?? defaultTemplates(T);
    this.defaultDir = options.defaultDir ?? '';
    const { ui } = ctx;

    // ---- 左栏:标题与按钮一行,过滤框一行,目录树占满其余高度;可以收成一条窄边 ----
    const split = ui.h('div', 'ct-ws');
    const filterInput = ui.input({
      type: 'search',
      placeholder: T.filterFiles,
      onInput: (v) => { this.filter = v.trim(); this.renderTree(); },
    });
    filterInput.classList.add('ct-filter');
    const sideToggle = iconButton(ctx, 'ct-sidetoggle', ICON_SIDE, '', () => {
      setCollapsed(!split.classList.contains('is-collapsed'));
    });
    const setCollapsed = (on: boolean): void => {
      split.classList.toggle('is-collapsed', on);
      const label = on ? T.expandSide : T.collapseSide;
      sideToggle.title = label;
      sideToggle.setAttribute('aria-label', label);
      sideToggle.setAttribute('aria-expanded', String(!on));
      ctx.memo.set('ws.sideCollapsed', on);
    };
    const sideHead = ui.h('div', 'ct-sidehead');
    sideHead.append(
      ui.h('span', 'ct-sidetitle', T.workspaceTitle),
      iconButton(ctx, '', ICON_NEW, T.newFile, () => this.openNewDialog()),
      iconButton(ctx, '', ICON_REFRESH, T.refresh, () => { void this.refreshTree(); }),
      sideToggle,
    );
    const filterRow = ui.h('div', 'ct-filterrow');
    filterRow.appendChild(filterInput);
    this.treePane = ui.h('div', 'ct-tree');
    const side = ui.h('div', 'ct-side');
    side.append(sideHead, filterRow, this.treePane);

    // ---- 右栏:文件头(路径、还原、保存) / 工具行(显示方式、查找等、删除) / 编辑区 / 页脚 ----
    this.pane = ui.h('div', 'ct-pane');

    this.pathLabel = ui.h('div', 'ct-path', T.noFileOpen);
    this.metaLabel = ui.h('span', 'ct-dim');
    this.stateLabel = ui.h('span', 'ct-dim');
    this.msg = ui.msgline('');

    this.saveBtn = ui.button(T.save, { size: 'sm', variant: 'primary', onClick: () => { void this.save(); } });
    const reloadBtn = ui.button(T.revert, { size: 'sm', onClick: () => { void this.revert(); } });
    const findBtn = ui.button(T.find, { size: 'sm', onClick: () => this.toggleFind(true) });
    const histBtn = ui.button(T.history, { size: 'sm', onClick: () => { void this.showHistory(); } });
    const renameBtn = ui.button(T.rename, { size: 'sm', onClick: () => this.openRenameDialog() });
    const delBtn = ui.button(T.remove, { size: 'sm', variant: 'danger', onClick: () => { void this.remove(); } });
    this.fileBtns = [this.saveBtn, reloadBtn, findBtn, histBtn, renameBtn, delBtn];

    const mode = ui.segmented(
      [{ value: 'edit', label: T.modeEdit }, { value: 'split', label: T.modeSplit }, { value: 'preview', label: T.modePreview }],
      {
        size: 'sm',
        value: ctx.memo.get<string>('ws.mode', 'edit'),
        onSelect: (v) => { ctx.memo.set('ws.mode', v); this.setMode(v); },
      },
    );

    const head = ui.h('div', 'ct-filehead');
    head.append(this.pathLabel, reloadBtn, this.saveBtn);
    const tools = ui.h('div', 'ct-filetools');
    tools.append(mode.el, ui.h('span', 'grow'), findBtn, histBtn, renameBtn, ui.h('span', 'ct-sep'), delBtn);

    // ---- 查找栏 ----
    this.findInput = ui.input({
      placeholder: T.find,
      onInput: () => this.updateFindCount(),
      onCommit: () => this.jumpFind(1),
    });
    this.replaceInput = ui.input({ placeholder: T.replaceWith });
    this.findCount = ui.h('span', 'ct-dim', T.noMatches);
    this.findBar = ui.rowbar();
    this.findBar.classList.add('ct-findbar', 'ct-hidden');
    this.findBar.append(
      this.findInput,
      ui.button(T.previous, { size: 'sm', onClick: () => this.jumpFind(-1) }),
      ui.button(T.next, { size: 'sm', onClick: () => this.jumpFind(1) }),
      this.findCount,
      this.replaceInput,
      ui.button(T.replace, { size: 'sm', onClick: () => this.replaceOne() }),
      ui.button(T.replaceAll, { size: 'sm', onClick: () => this.replaceAll() }),
      ui.h('span', 'grow'),
      ui.button(T.close, { size: 'sm', onClick: () => this.toggleFind(false) }),
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

    this.fileArea = ui.h('div', 'ct-file');
    this.fileArea.append(head, tools, this.findBar, this.editWrap, this.histWrap, foot);
    this.emptyNote = ui.placeholder(T.noFileOpen);
    this.emptyNote.classList.add('ct-empty');
    this.pane.append(this.emptyNote, this.fileArea, this.msg);

    split.append(side, this.pane);
    setCollapsed(ctx.memo.get<boolean>('ws.sideCollapsed', false));

    this.el = split;

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
    ctx.guardLeave(() => (this.dirty() ? T.leaveGuard : null));

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
      this.treePane.appendChild(ui.placeholder(this.filter ? this.T.noMatchingFiles : this.T.emptyRoot(this.root)));
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
      title: this.T.discardTitle,
      body: this.T.discardBody(`${this.root}/${this.cur?.path}`),
      danger: true,
    });
  }

  private async openFile(node: WorkspaceNode | { path: string }, force = false): Promise<void> {
    const path = node.path;
    if (!force && this.cur && this.cur.path !== path && !(await this.canLeaveCurrent())) return;
    const seq = ++this.openSeq;
    this.pathLabel.textContent = this.T.opening(`${this.root}/${path}`);
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
      this.pathLabel.textContent = this.T.readFailed;
      setMsg(this.msg, this.T.readFailedDetail(errText(err)), true);
    }
  }

  private async save(): Promise<void> {
    if (!this.cur || !this.dirty()) return;
    const content = this.editor.value;
    const busy = this.ctx.ui.disable(...this.fileBtns);
    setMsg(this.msg, this.T.saving);
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
      setMsg(this.msg, this.T.saveFailed(errText(err)), true);
    } finally {
      busy.dispose();
      this.syncMeta();
    }
  }

  private async revert(): Promise<void> {
    if (!this.cur || !this.dirty()) return;
    const ok = await this.ctx.ui.confirm({ title: this.T.revertTitle });
    if (!ok || !this.cur) return;
    this.editor.value = this.cur.content;
    setMsg(this.msg, this.T.reverted);
    this.syncMeta();
  }

  private async remove(): Promise<void> {
    if (!this.cur) return;
    const path = this.cur.path;
    const ok = await this.ctx.ui.confirm({
      title: this.T.removeTitle(`${this.root}/${path}`),
      body: this.T.removeBody,
      danger: true,
    });
    if (!ok || !this.cur) return;
    try {
      const out = await this.ctx.invoke<WorkspaceWriteResult>('remove', [path, this.cur.revision]);
      if (!out.ok) { setMsg(this.msg, out.error, true); return; }
      this.cur = null;
      this.editor.value = '';
      this.pathLabel.textContent = this.T.removed;
      this.setPane('empty');
      setMsg(this.msg, out.result);
      void this.refreshTree();
    } catch (err) {
      setMsg(this.msg, this.T.removeFailed(errText(err)), true);
    }
  }

  // -------------------------------------------------------------------------
  // 新建 / 改名(抽屉里的小表单;`ui.drawer` 收得下节点)
  // -------------------------------------------------------------------------

  private openNewDialog(): void {
    const { ui } = this.ctx;
    const T = this.T;
    const dirOf = this.cur?.path.includes('/')
      ? this.cur.path.slice(0, this.cur.path.lastIndexOf('/'))
      : this.defaultDir;
    const dir = ui.input({ value: dirOf, placeholder: this.defaultDir });
    const name = ui.input({ placeholder: T.fileNamePlaceholder });
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
      body.value = templateText(this.templates, tpl.value, name.value, T.untitled);
    }, { signal: this.ctx.signal });
    sync();

    const create = ui.button(T.create, {
      variant: 'primary',
      onClick: () => {
        const p = fullPath();
        if (!p || !name.value.trim()) { setMsg(msg, T.needFileName, true); return; }
        const busy = ui.disable(create);
        setMsg(msg, T.creating);
        // createOnly 在同名文件已存在时拒绝写入。
        void this.ctx.invoke<WorkspaceWriteResult>('write', [p, body.value, null, true])
          .then(
            (out) => {
              if (!out.ok) { setMsg(msg, out.error, true); return; }
              drawer.dispose();
              void this.refreshTree();
              void this.openFile({ path: p }, true);
            },
            (err: unknown) => { setMsg(msg, T.createFailed(errText(err)), true); },
          )
          .finally(() => { busy.dispose(); });
      },
    });

    const form = ui.h('div', 'ct-form');
    form.append(
      ui.field(T.fieldDir, dir),
      ui.field(T.fieldName, name),
      ui.field(T.fieldTemplate, tpl),
      ui.field(T.fieldBody, body),
      path,
      (() => { const r = ui.actions(); r.append(msg, ui.h('span', 'grow'), create); return r; })(),
    );
    const drawer = ui.drawer(T.newFileTitle, form);
  }

  private openRenameDialog(): void {
    if (!this.cur) return;
    const { ui } = this.ctx;
    const T = this.T;
    if (this.dirty()) { setMsg(this.msg, T.saveBeforeRename, true); return; }
    const from = this.cur.path;
    const to = ui.input({ value: from, cls: 'mono' });
    const msg = ui.msgline('');
    const apply = ui.button(T.rename, {
      variant: 'primary',
      onClick: () => {
        const target = to.value.trim();
        if (!target || target === from) { setMsg(msg, T.needNewPath, true); return; }
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
            (err: unknown) => { setMsg(msg, T.renameFailed(errText(err)), true); },
          )
          .finally(() => { busy.dispose(); });
      },
    });
    const form = ui.h('div', 'ct-form');
    form.append(
      dimLine(this.ctx, T.currentPath(`${this.root}/${from}`)),
      ui.field(T.newPath(this.root), to),
      (() => { const r = ui.actions(); r.append(msg, ui.h('span', 'grow'), apply); return r; })(),
    );
    const drawer = ui.drawer(T.renameTitle, form);
  }

  // -------------------------------------------------------------------------
  // 这一份档案的历史
  // -------------------------------------------------------------------------

  private async showHistory(): Promise<void> {
    if (!this.cur) return;
    const { ui } = this.ctx;
    const path = this.cur.path;
    this.setPane('hist');
    this.histWrap.replaceChildren(ui.placeholder(this.T.fileHistoryLoading));
    let commits: Commit[] = [];
    try {
      commits = (await this.ctx.invoke<{ commits: Commit[] }>('history', [path])).commits;
    } catch (err) {
      if (this.ctx.signal.aborted) return;
      this.histWrap.replaceChildren(ui.placeholder(this.T.fileHistoryFailed(errText(err))));
      return;
    }
    if (this.ctx.signal.aborted) return;
    const back = ui.rowbar();
    back.append(
      ui.button(this.T.backToEditor, { size: 'sm', onClick: () => this.setPane('edit') }),
      ui.h('span', 'grow'),
      ui.h('span', 'ct-dim', `${this.root}/${path}`),
    );
    this.histWrap.replaceChildren(back);
    if (!commits.length) {
      this.histWrap.appendChild(ui.placeholder(this.T.noFileHistory));
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
      detail.replaceChildren(ui.placeholder(this.T.loadingDiff));
      void Promise.all([
        this.ctx.invoke<{ diff: string }>('diff', [c.fullHash, path]),
        this.ctx.invoke<{ content: string }>('at', [c.fullHash, path]),
      ]).then(
        ([d, f]) => {
          if (this.ctx.signal.aborted) return;
          const bar = ui.rowbar();
          bar.append(
            ui.button(this.T.viewFull, {
              size: 'sm',
              onClick: () => { ui.drawer(`${this.root}/${path} @ ${c.hash}`, f.content); },
            }),
            ui.button(this.T.restoreDraft, {
              size: 'sm',
              onClick: () => {
                this.setPane('edit');
                this.editor.value = f.content;
                this.syncMeta();
                setMsg(this.msg, this.T.restored);
              },
            }),
            ui.copyButton(() => f.content, { label: this.T.copyFull }),
          );
          detail.replaceChildren(colorDiff(this.ctx, d.diff), bar);
        },
        (err: unknown) => {
          if (this.ctx.signal.aborted) return;
          detail.replaceChildren(ui.placeholder(this.T.diffFailed(errText(err))));
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
    this.fileArea.hidden = kind === 'empty';
    this.emptyNote.hidden = kind !== 'empty';
    this.editWrap.classList.toggle('ct-hidden', kind !== 'edit');
    this.histWrap.classList.toggle('ct-hidden', kind !== 'hist');
    this.findBar.classList.toggle('ct-hidden', kind !== 'edit' || this.findBar.dataset.open !== '1');
    for (const b of this.fileBtns) b.disabled = kind === 'empty';
    if (kind === 'empty') {
      this.pathLabel.textContent = this.T.noFileOpen;
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
      ? this.T.cursor(line, col, text.split('\n').length, text.length, dirty)
      : '';
    this.saveBtn.disabled = !dirty;
    this.pathLabel.classList.toggle('is-dirty', dirty);
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
    this.findCount.textContent = n ? this.T.matches(n) : this.T.noMatches;
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
