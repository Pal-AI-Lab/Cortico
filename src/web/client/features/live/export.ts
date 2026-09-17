/**
 * 把当前观察的 session 存成 JSON 文件。两种范围:整份(含系统前缀与合成开头)、
 * 只留非前缀部分(system / developer 条目与合成开头都不进文件)。
 */

import type { ContextRecord } from '../../../../protocol/open-responses/context.ts';
import type { ConsoleUi } from '../../../shared/client-panel.ts';
import { icon } from '../../ui/icons.ts';
import { S } from './strings.ts';

export type ExportScope = 'all' | 'dialogue';

export interface ExportInput {
  sessionId: string;
  sessionLabel: string;
  messages: readonly ContextRecord[];
  /** 合成开头。只在整份导出时进文件。 */
  head?: readonly ContextRecord[];
  exportedAt: Date;
}

export interface ExportFile {
  exportedAt: string;
  scope: ExportScope;
  session: { id: string; label: string };
  items: ContextRecord[];
}

function isPrefix(entry: ContextRecord): boolean {
  const item = entry.item;
  return item.type === 'message' && (item.role === 'system' || item.role === 'developer');
}

export function buildExport(input: ExportInput, scope: ExportScope): ExportFile {
  const items = scope === 'all'
    ? [...(input.head ?? []), ...input.messages]
    : input.messages.filter((entry) => !isPrefix(entry) && entry.context.head !== true);
  return {
    exportedAt: input.exportedAt.toISOString(),
    scope,
    session: { id: input.sessionId, label: input.sessionLabel },
    items,
  };
}

/** `cortico-session-main-20260917-142530.json`:本地时间,同一秒内不会重名到别的 session 上。 */
export function exportFileName(sessionId: string, at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`
    + `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  const id = sessionId.replace(/[^\w.-]/g, '_');
  return `cortico-session-${id}-${stamp}.json`;
}

/** 交给浏览器下载。对象 URL 在同一轮事件循环之后撤掉。 */
export function downloadJson(doc: Document, name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = doc.createElement('a');
  link.href = url;
  link.download = name;
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface ExportDialogDeps {
  ui: ConsoleUi;
  doc: Document;
  /** 页面的 signal:离开这一页,弹窗跟着消失。 */
  signal: AbortSignal;
  onPick(scope: ExportScope): void;
}

/** 选范围。Esc、点遮罩、离开页面都算不导出。 */
export function openExportDialog(deps: ExportDialogDeps): void {
  if (deps.signal.aborted) return;
  const { ui, doc } = deps;
  const mask = ui.h('div', 'modal');
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-label', S.exportTitle);
  const ac = new AbortController();
  const close = (): void => {
    if (ac.signal.aborted) return;
    ac.abort();
    mask.remove();
  };
  deps.signal.addEventListener('abort', close, { once: true, signal: ac.signal });
  doc.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') close();
  }, { signal: ac.signal });
  mask.addEventListener('mousedown', (ev: MouseEvent) => {
    if (ev.target === mask) close();
  }, { signal: ac.signal });

  const card = ui.h('div', 'modalcard');
  card.setAttribute('style', 'width:min(460px,92vw)');
  const head = ui.h('div', 'modalhead');
  head.appendChild(ui.h('span', 'modaltitle', S.exportTitle));
  const body = ui.h('div', 'modalbody');
  body.appendChild(ui.h('div', null, S.exportBody));

  const pick = (scope: ExportScope): void => {
    close();
    deps.onPick(scope);
  };
  const bar = ui.rowbar();
  bar.appendChild(ui.h('span', 'grow'));
  for (const [label, scope, variant] of [
    [S.exportAll, 'all', 'danger'],
    [S.exportDialogue, 'dialogue', 'plain'],
  ] as const) {
    const btn = ui.button('', { size: 'sm', variant, onClick: () => pick(scope) });
    btn.className += ' btn-ico';
    btn.append(icon(doc, 'download'), ui.h('span', null, label));
    bar.appendChild(btn);
  }
  body.appendChild(bar);
  card.append(head, body);
  mask.appendChild(card);
  doc.body.appendChild(mask);
}
