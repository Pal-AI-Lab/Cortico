/**
 * 终端页只读状态条，使用 ui.chip 的统一 tone。控制动作归其他控制页；本 feature 仅更新 document.title，品牌名与面包屑由 host 根据状态渲染。
 */

import type { ConsoleUi } from '../../../shared/client-panel.ts';
import { chipsOf, loopOf, type StatusSnapshot } from './protocol.ts';
import { S } from './strings.ts';

/** 一枚 chip:纯文本片段与要加粗的读数交替。 */
type ChipPart = string | { b: string | number };

function chipOf(ui: ConsoleUi, parts: readonly ChipPart[]): HTMLElement {
  const c = ui.chip('');
  for (const p of parts) {
    if (typeof p === 'string') c.appendChild(ui.h('span', null, p));
    else c.appendChild(ui.h('b', null, String(p.b)));
  }
  return c;
}

/**
 * 展示名来自部署配置(`/api/status` 的 `displayName`)——**框架自己不预设身份**。
 * 返回是否真的改了,免得每一帧心跳都去写一次 `document.title`。
 */
export function applyDisplayName(doc: Document, name: string | undefined, current: string): boolean {
  if (!name || name === current) return false;
  doc.title = S.docTitle(name);
  return true;
}

export interface StatusBand {
  el: HTMLElement;
  render(st: StatusSnapshot | null): void;
}

export function createStatusBand(ui: ConsoleUi): StatusBand {
  const el = ui.h('div', 'chips');
  return {
    el,
    render(st) {
      while (el.children.length) el.children[0].remove();
      if (!st) {
        el.appendChild(ui.chip(S.chipDisconnected));
        return;
      }
      // 先列影响 bot 能否响应的状态,累计统计排在后面。
      const loop = loopOf(st);
      if (loop.paused) el.appendChild(ui.chip(S.chipPaused, 'warn'));
      else if (loop.scheduleBlocked) el.appendChild(ui.chip(S.chipScheduleBlocked, 'warn'));
      if (loop.truncating) el.appendChild(ui.chip(S.chipTruncating, 'accent'));
      if (loop.behind) el.appendChild(ui.chip(S.chipBehind(loop.behind), 'warn'));
      // 人格概念(「梦中」这类)由Persona自报文本,框架照画不解释。
      for (const chip of chipsOf(st)) el.appendChild(ui.chip(chip.label, chip.tone));
      if (loop.estTokens != null) {
        el.appendChild(chipOf(ui, [{ b: ui.fmt.count(loop.estTokens) }, ' tok']));
      }
      const u = loop.lastUsage;
      if (u && u.promptTokens) {
        el.appendChild(
          chipOf(ui, [S.chipCache, { b: ui.fmt.percent((u.cacheHitTokens || 0) / u.promptTokens) }]),
        );
      }
      if (loop.messageCount != null) el.appendChild(chipOf(ui, [{ b: loop.messageCount }, S.chipMsgs]));
      if (loop.batchesHandled != null) {
        el.appendChild(chipOf(ui, [S.chipBatchesPre, { b: loop.batchesHandled }, S.chipBatchesPost]));
      }
      if (st.terminalOnline != null) el.appendChild(chipOf(ui, [S.chipOnline, { b: st.terminalOnline }]));
    },
  };
}
