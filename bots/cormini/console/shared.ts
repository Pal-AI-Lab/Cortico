/**
 * 「工作区」与「版本历史」两块面板共用的回执形状与渲染小件。
 * 服务端形状见 ../persona/consoleSurface.ts。
 */

import type { ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';

export interface WorkspaceNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
  children?: WorkspaceNode[];
}

export interface WorkspaceTree {
  nodes: WorkspaceNode[];
  /** 工作区目录的绝对路径;面板取它的末段作为路径前缀。 */
  root: string;
}

export interface WorkspaceFile {
  path: string;
  content: string;
  revision: string;
  size: number;
  mtime: string | null;
}

/** 写/删/改名的回执。`conflict` 那支 = 没做,因为底本变了。 */
export type WorkspaceWriteResult =
  | { ok: true; result: string; revision: string }
  | { ok: false; conflict: true; error: string; currentRevision?: string };

export interface Commit {
  hash: string;
  fullHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

export interface MediumStatus {
  available: boolean;
  repo: boolean;
  dirty: boolean;
  head: string | null;
  lastCommit: Commit | null;
  tags: string[];
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function setMsg(el: HTMLElement, text: string, bad = false): void {
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

export interface AutoloadOptions<T> {
  loading: string;
  failed: string;
  load(): Promise<T>;
  /** reload 重新加载数据并渲染。 */
  render(data: T, reload: () => void): Node[];
}

/**
 * 取数—渲染骨架：空态 → 取数 → 渲染或错误空态。
 * 请求代号防止晚到的旧响应覆盖新响应；unmount 后到达的异步拒绝不再写 DOM。
 */
export function autoload<T>(ctx: ConsolePanelContext, opts: AutoloadOptions<T>): void {
  const { ui, root } = ctx;
  let generation = 0;
  const run = (): void => {
    const gen = ++generation;
    root.replaceChildren(ui.placeholder(opts.loading));
    void opts.load().then(
      (data) => {
        if (gen !== generation || ctx.signal.aborted) return;
        root.replaceChildren(...opts.render(data, run));
      },
      (err: unknown) => {
        if (gen !== generation || ctx.signal.aborted) return;
        root.replaceChildren(ui.placeholder(`${opts.failed}: ${errText(err)}`));
      },
    );
  };
  run();
}

export function dimLine(ctx: ConsolePanelContext, text = ''): HTMLElement {
  return ctx.ui.h('div', 'ct-dim', text);
}

export function stamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 19).replace('T', ' ');
}

export function gitLine(st: MediumStatus): string {
  if (!st.available) return 'git 不可用';
  if (!st.repo) return '还没有建仓';
  return `git ${st.head ?? '—'} · ${st.dirty ? '有未提交改动' : '干净'} · ${st.tags.length} 个存档点`;
}

export function colorDiff(ctx: ConsolePanelContext, text: string): HTMLElement {
  const box = ctx.ui.h('div', 'diffbox');
  box.innerHTML = String(text || '')
    .split('\n')
    .map((line) => {
      const safe = ctx.ui.esc(line);
      if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="di-add">${safe}</span>`;
      if (line.startsWith('-') && !line.startsWith('---')) return `<span class="di-del">${safe}</span>`;
      if (line.startsWith('@@')) return `<span class="di-hunk">${safe}</span>`;
      return safe;
    })
    .join('\n');
  return box;
}
