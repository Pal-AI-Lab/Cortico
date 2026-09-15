/**
 * 存储清单视图:列本页的项,落盘在内存前,每项可清除。清单由服务端声明,清除范围和结果由各项的实现决定;
 * `clearAll` 打开时多一颗一键清空,清的是服务端整张清单。
 */

import type { ConsoleUi } from '../../../shared/client-panel.ts';
import { get, post } from '../../core/api.ts';
import { S } from './strings.ts';

/** 一条可清除的存储部分。与 `src/core/types.ts` 的 `OwnedStoragePart` 同形(去掉两个函数)。 */
export interface StoragePartView {
  key: string;
  label: string;
  kind: 'disk' | 'memory';
  /** 归属:core、persona、memory 或 world:<id>,装配层盖章。 */
  owner: string;
  location?: string;
  danger?: boolean;
  note?: string;
  /** 当前规模描述，服务端实时算。 */
  stat?: string;
}

export interface StorageViewDeps {
  ui: ConsoleUi;
  signal: AbortSignal;
  /** 这一处画哪些项。省略 = 全部。 */
  filter?(part: StoragePartView): boolean;
  /** 画「一键清空全部」。 */
  clearAll?: boolean;
}

export interface StorageView {
  el: HTMLElement;
  /** 取一次 `/api/storage` 并重建。可反复调。 */
  load(): Promise<void>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

export function createStorageView(deps: StorageViewDeps): StorageView {
  const { ui, signal } = deps;
  const el = ui.h('div', 'storageview');
  const body = ui.h('div');
  const bar = ui.actions();
  const msg = ui.msgline();
  bar.append(msg, ui.h('span', 'grow'));
  const nukeBtn = deps.clearAll ? ui.button(S.nukeAll, { variant: 'danger', onClick: () => void nuke() }) : null;
  if (nukeBtn) bar.appendChild(nukeBtn);
  el.append(body, bar);

  function setMsg(text: string, bad?: boolean): void {
    msg.textContent = text;
    msg.className = 'msgline' + (bad ? ' bad' : '');
  }

  function row(p: StoragePartView): HTMLDivElement {
    const item = ui.h('div', 'strow');
    const info = ui.h('div', 'stinfo');
    const label = ui.h('div', 'stlabel', p.label);
    if (p.location) label.appendChild(ui.h('span', 'stloc', p.location));
    info.appendChild(label);
    if (p.note) info.appendChild(ui.h('div', 'stnote', p.note));
    const stat = ui.h('div', 'ststat', p.stat || '');
    const btn = ui.button(S.clear, {
      size: 'sm',
      variant: p.danger ? 'danger' : 'plain',
      onClick: () => void clearOne(p, btn),
    });
    item.append(info, stat, btn);
    return item;
  }

  async function clearOne(p: StoragePartView, btn: HTMLButtonElement): Promise<void> {
    const ok = await ui.confirm(
      p.danger
        ? { title: S.dangerTitle(p.label), body: S.dangerBody(p.note || ''), danger: true }
        : { title: S.clearTitle(p.label), body: p.note || '' },
    );
    if (!ok || signal.aborted) return;
    const lock = ui.disable(btn);
    try {
      const out = await post<{ result?: string }>(
        `/api/storage/clear?key=${encodeURIComponent(p.key)}`,
        undefined,
        { signal },
      );
      if (signal.aborted) return;
      setMsg('✓ ' + (out.result || S.cleared));
      await load();
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      setMsg(S.clearFailed(errText(err)), true);
    } finally {
      lock.dispose();
    }
  }

  async function nuke(): Promise<void> {
    if (!nukeBtn) return;
    const ok = await ui.confirm({ title: S.nukeTitle, body: S.nukeBody, danger: true });
    if (!ok || signal.aborted) return;
    const lock = ui.disable(nukeBtn);
    try {
      const out = await post<{ results?: Array<{ key: string; ok: boolean }> }>(
        '/api/storage/clear-all',
        undefined,
        { signal },
      );
      if (signal.aborted) return;
      const results = out.results || [];
      const bad = results.filter((x) => !x.ok);
      setMsg(bad.length ? S.partialFailed(bad.map((x) => x.key).join(',')) : S.nukedAll(results.length), bad.length > 0);
      await load();
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      setMsg(S.nukeFailed(errText(err)), true);
    } finally {
      lock.dispose();
    }
  }

  async function load(): Promise<void> {
    try {
      const data = await get<{ parts?: StoragePartView[] }>('/api/storage', { signal });
      if (signal.aborted) return;
      const all = data.parts || [];
      const parts = deps.filter ? all.filter((p) => deps.filter!(p)) : all;
      body.replaceChildren();
      if (!parts.length) {
        body.appendChild(ui.placeholder(all.length ? S.empty : S.noList));
        return;
      }
      for (const [kind, title] of [['disk', S.sectionDisk], ['memory', S.sectionMemory]] as const) {
        const items = parts.filter((p) => p.kind === kind);
        if (!items.length) continue;
        body.appendChild(ui.h('div', 'stacklabel', title));
        for (const p of items) body.appendChild(row(p));
      }
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      body.replaceChildren(ui.placeholder(S.loadFailed(errText(err))));
    }
  }

  body.appendChild(ui.placeholder(S.loading));
  return { el, load };
}
