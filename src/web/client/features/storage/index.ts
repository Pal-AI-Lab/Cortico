/**
 * 存储项由服务端声明；清除范围和操作结果由各项的实现决定。
 */

import { get, post } from '../../core/api.ts';
import { pageIntro } from '../../ui/page.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { S } from './strings.ts';

/** 一条可清除的存储部分。与 `src/core/types.ts` 的 `StoragePart` 同形（去掉两个函数）。 */
export interface StoragePartView {
  key: string;
  label: string;
  kind: 'disk' | 'memory';
  /** 分节归属；留空 = 框架自己的存储。 */
  group?: string | null;
  location?: string;
  danger?: boolean;
  note?: string;
  /** 当前规模描述，服务端实时算。 */
  stat?: string;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/** 框架存储在前，World 按清单中首次出现的顺序分组；各组内 disk 在 memory 前。 */
export function storageSections(
  parts: readonly StoragePartView[],
): Array<{ group: string | null; kind: 'disk' | 'memory'; title: string }> {
  const groups: string[] = [];
  for (const p of parts) if (p.group && !groups.includes(p.group)) groups.push(p.group);
  const out: Array<{ group: string | null; kind: 'disk' | 'memory'; title: string }> = [
    { group: null, kind: 'disk', title: S.sectionDisk },
    { group: null, kind: 'memory', title: S.sectionMemory },
  ];
  for (const g of groups) {
    out.push({ group: g, kind: 'disk', title: S.groupDisk(g) });
    out.push({ group: g, kind: 'memory', title: S.groupMemory(g) });
  }
  return out;
}

export function mountStorage(ctx: FeatureContext, opts: { embedded?: boolean } = {}): void {
  const { ui, root } = ctx;
  const intro = pageIntro(ui, S.pageTitle);

  const sheet = ui.sheet({
    title: S.sheetTitle,
    en: 'disk / memory',
  });
  const body = ui.h('div');
  const bar = ui.actions();
  const msg = ui.msgline();
  const nukeBtn = ui.button(S.nukeAll, { variant: 'danger', onClick: () => void nuke() });
  bar.append(msg, ui.h('span', 'grow'), nukeBtn);
  sheet.body.append(body, bar);
  if (!opts.embedded) root.appendChild(intro);
  root.appendChild(sheet.el);

  function setMsg(text: string, bad?: boolean): void {
    msg.textContent = text;
    msg.className = 'msgline' + (bad ? ' bad' : '');
  }

  function row(p: StoragePartView): HTMLDivElement {
    const el = ui.h('div', 'strow');
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
    el.append(info, stat, btn);
    return el;
  }

  async function clearOne(p: StoragePartView, btn: HTMLButtonElement): Promise<void> {
    const ok = await ui.confirm(
      p.danger
        ? {
            title: S.dangerTitle(p.label),
            body: S.dangerBody(p.note || ''),
            danger: true,
          }
        : { title: S.clearTitle(p.label), body: p.note || '' },
    );
    if (!ok || ctx.signal.aborted) return;
    const lock = ui.disable(btn);
    try {
      const out = await post<{ result?: string }>(
        `/api/storage/clear?key=${encodeURIComponent(p.key)}`,
        undefined,
        { signal: ctx.signal },
      );
      if (ctx.signal.aborted) return;
      setMsg('✓ ' + (out.result || S.cleared));
      await load();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      setMsg(S.clearFailed(errText(err)), true);
    } finally {
      lock.dispose();
    }
  }

  async function nuke(): Promise<void> {
    const ok = await ui.confirm({
      title: S.nukeTitle,
      body: S.nukeBody,
      danger: true,
    });
    if (!ok || ctx.signal.aborted) return;
    const lock = ui.disable(nukeBtn);
    try {
      const out = await post<{ results?: Array<{ key: string; ok: boolean }> }>(
        '/api/storage/clear-all',
        undefined,
        { signal: ctx.signal },
      );
      if (ctx.signal.aborted) return;
      const results = out.results || [];
      const bad = results.filter((x) => !x.ok);
      setMsg(
        bad.length
          ? S.partialFailed(bad.map((x) => x.key).join(','))
          : S.nukedAll(results.length),
        bad.length > 0,
      );
      await load();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      setMsg(S.nukeFailed(errText(err)), true);
    } finally {
      lock.dispose();
    }
  }

  async function load(): Promise<void> {
    try {
      const data = await get<{ parts?: StoragePartView[] }>('/api/storage', { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      const parts = data.parts || [];
      body.replaceChildren();
      if (!parts.length) {
        body.appendChild(ui.placeholder(S.noList));
        return;
      }
      for (const sec of storageSections(parts)) {
        const items = parts.filter((p) => (p.group || null) === sec.group && p.kind === sec.kind);
        if (!items.length) continue;
        body.appendChild(ui.h('div', 'stacklabel', sec.title));
        for (const p of items) body.appendChild(row(p));
      }
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      body.replaceChildren(ui.placeholder(S.loadFailed(errText(err))));
    }
  }

  body.appendChild(ui.placeholder(S.loading));
  void load();
}

export const storageFeature: FrameworkFeature = {
  route: 'storage',
  label: S.navLabel,
  navMode: 'hidden',
  needs: ['storage'],
  mount: mountStorage,
};
