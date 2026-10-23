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
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_NEW = svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M12 12v6M9 15h6"/>');
const ICON_REFRESH = svg('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>');
const ICON_SIDE = svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>');
const ICON_UNDO = svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>');
const ICON_REDO = svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>');
const ICON_REVERT = svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>');
const ICON_SAVE = svg('<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7"/>');
const ICON_RENAME = svg('<path d="M21.17 6.81a2.82 2.82 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>');
const ICON_DELETE = svg('<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>');
const ICON_FIND = svg('<circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4.2-4.2"/>');
const ICON_HISTORY = svg('<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3.5 2"/>');
const ICON_UP = svg('<path d="m5 12 7-7 7 7M12 19V5"/>');
const ICON_DOWN = svg('<path d="M12 5v14M19 12l-7 7-7-7"/>');
const ICON_CLOSE = svg('<path d="M18 6 6 18M6 6l12 12"/>');
const ICON_CHEVRON = svg('<path d="m9 18 6-6-6-6"/>');
const ICON_REPLACE = svg('<path d="M14 4a2 2 0 0 1 2-2M16 10a2 2 0 0 1-2-2M20 2a2 2 0 0 1 2 2M22 8a2 2 0 0 1-2 2"/><path d="m3 7 3 3 3-3"/><path d="M6 10V5a3 3 0 0 1 3-3h1"/><rect x="2" y="14" width="8" height="8" rx="2"/>');
const ICON_REPLACE_ALL = svg('<path d="M14 14a2 2 0 0 1 2-2M14 4a2 2 0 0 1 2-2M16 10a2 2 0 0 1-2-2M16 22a2 2 0 0 1-2-2M20 12a2 2 0 0 1 2 2M20 2a2 2 0 0 1 2 2M22 20a2 2 0 0 1-2 2M22 8a2 2 0 0 1-2 2"/><path d="m3 7 3 3 3-3"/><path d="M6 10V5a3 3 0 0 1 3-3h1"/><rect x="2" y="14" width="8" height="8" rx="2"/>');

/** 只有图标的小按钮(侧栏标题行、文件头、查找框),名字在 title 和 aria-label 里。 */
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
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly foot: HTMLDivElement;
  /** 撤销 / 恢复:编辑器自己记的快照;连续打字合成一步,替换、还原、载入旧版本各算一步。 */
  private undoStack: Array<{ value: string; at: number }> = [];
  private redoStack: Array<{ value: string; at: number }> = [];
  private lastTyped = 0;
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

    // ---- 右栏:文件头(路径;撤销、恢复 | 还原、保存 | 改名、删除) / 工具行(显示方式;查找、历史) / 编辑区 / 页脚 ----
    this.pane = ui.h('div', 'ct-pane');

    this.pathLabel = ui.h('div', 'ct-path', T.noFileOpen);
    this.metaLabel = ui.h('span', 'ct-dim');
    this.stateLabel = ui.h('span', 'ct-dim');
    this.msg = ui.msgline('');

    this.undoBtn = iconButton(ctx, '', ICON_UNDO, T.undo, () => this.undo());
    this.redoBtn = iconButton(ctx, '', ICON_REDO, T.redo, () => this.redo());
    const reloadBtn = iconButton(ctx, '', ICON_REVERT, T.revert, () => { void this.revert(); });
    this.saveBtn = iconButton(ctx, 'is-primary', ICON_SAVE, T.save, () => { void this.save(); });
    const renameBtn = iconButton(ctx, '', ICON_RENAME, T.rename, () => this.openRenameDialog());
    const delBtn = iconButton(ctx, 'is-danger', ICON_DELETE, T.remove, () => { void this.remove(); });
    const findBtn = iconButton(ctx, '', ICON_FIND, T.find, () => this.toggleFind(this.findBar.dataset.open !== '1'));
    const histBtn = iconButton(ctx, '', ICON_HISTORY, T.history, () => { void this.showHistory(); });
    this.fileBtns = [this.undoBtn, this.redoBtn, reloadBtn, this.saveBtn, renameBtn, delBtn, findBtn, histBtn];

    const mode = ui.segmented(
      [{ value: 'edit', label: T.modeEdit }, { value: 'split', label: T.modeSplit }, { value: 'preview', label: T.modePreview }],
      {
        size: 'sm',
        value: ctx.memo.get<string>('ws.mode', 'edit'),
        onSelect: (v) => { ctx.memo.set('ws.mode', v); this.setMode(v); },
      },
    );

    const head = ui.h('div', 'ct-filehead');
    head.append(
      this.pathLabel,
      this.undoBtn, this.redoBtn, ui.h('span', 'ct-sep'),
      reloadBtn, this.saveBtn, ui.h('span', 'ct-sep'),
      renameBtn, delBtn,
    );
    const tools = ui.h('div', 'ct-filetools');
    tools.append(mode.el, ui.h('span', 'grow'), findBtn, histBtn);

    // ---- 查找:浮在编辑区右上角的小框;点左边的箭头多一行替换 ----
    this.findInput = ui.input({
      placeholder: T.find,
      onInput: () => this.updateFindCount(),
      onCommit: () => this.jumpFind(1),
    });
    this.replaceInput = ui.input({ placeholder: T.replaceWith, onCommit: () => this.replaceOne() });
    this.findCount = ui.h('span', 'ct-findcount');
    this.findBar = ui.h('div', 'ct-find ct-hidden');
    const expand = iconButton(ctx, 'ct-findexpand', ICON_CHEVRON, T.replace, () => {
      const on = this.findBar.classList.toggle('is-replacing');
      expand.setAttribute('aria-expanded', String(on));
      if (on) this.replaceInput.focus();
    });
    expand.setAttribute('aria-expanded', 'false');
    const findRow = ui.h('div', 'ct-findrow');
    findRow.append(
      this.findInput,
      this.findCount,
      iconButton(ctx, '', ICON_UP, T.previous, () => this.jumpFind(-1)),
      iconButton(ctx, '', ICON_DOWN, T.next, () => this.jumpFind(1)),
      iconButton(ctx, '', ICON_CLOSE, T.close, () => this.toggleFind(false)),
    );
    const replaceRow = ui.h('div', 'ct-findrow ct-replacerow');
    replaceRow.append(
      this.replaceInput,
      iconButton(ctx, '', ICON_REPLACE, T.replace, () => this.replaceOne()),
      iconButton(ctx, '', ICON_REPLACE_ALL, T.replaceAll, () => this.replaceAll()),
    );
    const findRows = ui.h('div', 'ct-findrows');
    findRows.append(findRow, replaceRow);
    this.findBar.append(expand, findRows);
    this.findBar.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); this.toggleFind(false); }
    }, { signal: ctx.signal });

    // ---- 编辑器本体:编辑、分栏、预览和历史共用一个固定高度,底边可以往下拖高 ----
    this.editor = ui.textarea({
      cls: 'mono ct-textarea',
      onInput: () => { this.record(true); this.syncMeta(); this.updateFindCount(); },
    });
    this.editor.spellcheck = false;
    this.preview = ui.h('div', 'ct-preview');
    this.editWrap = ui.h('div', 'ct-editwrap');
    this.editWrap.append(this.editor, this.preview);

    this.histWrap = ui.h('div', 'ct-hist ct-hidden');

    const body = ui.h('div', 'ct-body');
    body.append(this.editWrap, this.histWrap, this.findBar);

    this.foot = ui.rowbar();
    this.foot.append(this.metaLabel, ui.h('span', 'grow'), this.stateLabel);

    this.fileArea = ui.h('div', 'ct-file');
    this.fileArea.append(head, tools, body, this.foot);
    this.emptyNote = ui.placeholder(T.noFileOpen);
    this.emptyNote.classList.add('ct-empty');
    this.pane.append(this.emptyNote, this.fileArea, this.msg);

    // 整块的高度固定(记在 memo 里),切换编辑 / 分栏 / 预览 / 历史都不变;拖整块的底边改它
    split.style.height = `${ctx.memo.get<number>('ws.blockHeight', 560)}px`;
    const grip = ui.h('div', 'ct-grip');
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'horizontal');
    grip.title = T.dragHeight;
    grip.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const startY = ev.clientY;
      const startH = split.getBoundingClientRect().height;
      grip.setPointerCapture(ev.pointerId);
      const move = (e: PointerEvent): void => {
        split.style.height = `${Math.max(360, Math.round(startH + e.clientY - startY))}px`;
      };
      grip.addEventListener('pointermove', move, { signal: ctx.signal });
      grip.addEventListener('pointerup', () => {
        grip.removeEventListener('pointermove', move);
        ctx.memo.set('ws.blockHeight', Math.round(split.getBoundingClientRect().height));
      }, { once: true, signal: ctx.signal });
    }, { signal: ctx.signal });

    split.append(side, this.pane, grip);
    setCollapsed(ctx.memo.get<boolean>('ws.sideCollapsed', false));

    this.el = split;

    for (const type of ['click', 'keyup'] as const) {
      this.editor.addEventListener(type, () => this.syncMeta(), { signal: ctx.signal });
    }
    this.editor.addEventListener('keydown', (ev) => {
      const mod = ev.ctrlKey || ev.metaKey;
      const key = ev.key.toLowerCase();
      if (mod && key === 'z' && !ev.shiftKey) { ev.preventDefault(); this.undo(); return; }
      if (mod && (key === 'y' || (key === 'z' && ev.shiftKey))) { ev.preventDefault(); this.redo(); return; }
      if (mod && key === 'f') { ev.preventDefault(); this.toggleFind(true); return; }
      if (mod && key === 's') { ev.preventDefault(); void this.save(); return; }
      if (ev.key !== 'Tab') return;
      ev.preventDefault();
      const a = this.editor;
      a.setRangeText('  ', a.selectionStart, a.selectionEnd, 'end');
      this.record(false);
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
      this.resetUndo();
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
    this.record(false);
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
    setMsg(this.msg, '');
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
                this.record(false);
                this.syncMeta();
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
    this.foot.classList.toggle('ct-hidden', kind === 'hist');
    for (const b of this.fileBtns) b.disabled = kind === 'empty';
    if (kind !== 'empty') this.syncUndo();
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
  // 撤销 / 恢复
  // -------------------------------------------------------------------------

  /** 打开档案时从这份内容起记。 */
  private resetUndo(): void {
    this.undoStack = [{ value: this.editor.value, at: 0 }];
    this.redoStack = [];
    this.lastTyped = 0;
    this.syncUndo();
  }

  /** 内容变了之后记一步;`typing` 时 600ms 内的连续输入并进上一步。 */
  private record(typing: boolean): void {
    const now = Date.now();
    const snap = { value: this.editor.value, at: this.editor.selectionStart };
    if (this.undoStack[this.undoStack.length - 1]?.value === snap.value) return;
    if (typing && now - this.lastTyped < 600 && this.undoStack.length > 1) {
      this.undoStack[this.undoStack.length - 1] = snap;
    } else {
      this.undoStack.push(snap);
      if (this.undoStack.length > 200) this.undoStack.shift();
    }
    this.lastTyped = typing ? now : 0;
    this.redoStack = [];
    this.syncUndo();
  }

  private undo(): void {
    if (this.undoStack.length < 2) return;
    this.redoStack.push(this.undoStack.pop()!);
    this.applySnap(this.undoStack[this.undoStack.length - 1]);
  }

  private redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(snap);
    this.applySnap(snap);
  }

  private applySnap(snap: { value: string; at: number }): void {
    this.editor.value = snap.value;
    this.editor.setSelectionRange(snap.at, snap.at);
    this.lastTyped = 0;
    this.syncUndo();
    this.syncMeta();
    this.updateFindCount();
  }

  private syncUndo(): void {
    this.undoBtn.disabled = !this.cur || this.undoStack.length < 2;
    this.redoBtn.disabled = !this.cur || !this.redoStack.length;
  }

  // -------------------------------------------------------------------------
  // 查找 / 替换(纯前端,不发请求)
  // -------------------------------------------------------------------------

  private toggleFind(open: boolean): void {
    if (open && !this.cur) return;
    if (open && this.editWrap.classList.contains('ct-hidden')) this.setPane('edit');
    if (open) {
      const a = this.editor;
      const sel = a.value.slice(a.selectionStart, a.selectionEnd);
      if (sel && !sel.includes('\n')) this.findInput.value = sel;
    }
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
    this.findCount.textContent = n ? this.T.matches(n) : this.findInput.value ? this.T.noMatches : '';
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
      this.record(false);
    }
    this.syncMeta();
    this.updateFindCount();
  }

  private replaceAll(): void {
    const needle = this.findInput.value;
    if (!needle) return;
    this.editor.value = this.editor.value.split(needle).join(this.replaceInput.value);
    this.record(false);
    this.syncMeta();
    this.updateFindCount();
  }
}
