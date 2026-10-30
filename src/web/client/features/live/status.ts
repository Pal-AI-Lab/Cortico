/**
 * 控制台页只读状态条，使用 ui.chip 的统一 tone。控制动作归其他控制页；本 feature 仅更新 document.title，品牌名与面包屑由 host 根据状态渲染。
 */

import type { WebUi } from '../../../shared/client-panel.ts';
import { chipsOf, loopOf, type RunPhase, type SessionStat, type StatusSnapshot } from './protocol.ts';
import { S } from './strings.ts';

/** 一枚 chip:纯文本片段与要加粗的读数交替。 */
type ChipPart = string | { b: string | number };

export function chipOf(ui: WebUi, parts: readonly ChipPart[]): HTMLElement {
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

/** 主循环运行阶段的一行说明;idle 或没有阶段时为 null。 */
export function phaseLabel(ui: WebUi, phase: RunPhase | null): string | null {
  if (!phase) return null;
  let head: string;
  switch (phase.state) {
    case 'delivering': head = S.phaseDelivering; break;
    case 'model': head = S.phaseModel; break;
    case 'tools': head = S.phaseTools; break;
    case 'backoff': head = S.phaseBackoff(ui.fmt.clock(phase.retryAt)); break;
    case 'handoff': head = S.phaseHandoff; break;
    default: return null;
  }
  const parts = [head];
  if (phase.round !== undefined) parts.push(S.phaseRound(phase.round));
  if (phase.running.length > 0) parts.push(S.phaseRunning(phase.running.join(', ')));
  return parts.join(' · ');
}

export interface ConnectionButton {
  el: HTMLButtonElement;
  render(st: StatusSnapshot | null): void;
}

/** 当前模型供应商:名字与模型,悬停看模块与地址;点击打开它在「模型供应商」里的设置,没有选中的就打开列表。 */
export function createConnectionButton(ui: WebUi, open: (name: string | null) => void): ConnectionButton {
  let name: string | null = null;
  // ui.button 的点击监听随本页 signal 解除
  const el = ui.button('', { onClick: () => open(name) });
  el.className = 'live-connection';
  const value = ui.h('span', 'live-connection-value');
  el.append(ui.h('span', 'live-connection-label', S.currentProvider), value);
  return {
    el,
    render(st) {
      const conn = st?.modelConnection;
      name = conn?.name ?? null;
      value.textContent = conn ? `${conn.name} · ${conn.model ?? '-'}` : S.noProvider;
      el.title = conn ? `${conn.moduleTitle} (${conn.module})\n${conn.baseUrl}` : S.noProvider;
    },
  };
}

export interface StatusBand {
  el: HTMLElement;
  /** `main` 是会话统计里主会话那一项(累计输入与缓存命中率取自它);还没有时省略那两项。 */
  render(st: StatusSnapshot | null, main?: SessionStat | null): void;
}

export function createStatusBand(ui: WebUi): StatusBand {
  const el = ui.h('div', 'chips');
  return {
    el,
    render(st, main) {
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
      // token 三项:下次提交的上下文估算;main 本次运行累计的输入与缓存命中率
      if (loop.estTokens != null) {
        const next = chipOf(ui, [S.chipNextSend, { b: ui.fmt.count(loop.estTokens) }, ' tok']);
        next.title = S.nextSendTitle;
        el.appendChild(next);
      }
      if (main) {
        const input = chipOf(ui, [S.chipTotalInput, { b: ui.fmt.count(main.promptTokens) }, ' tok']);
        input.title = S.totalInputTitle;
        const cache = chipOf(ui, [S.chipCache, { b: main.cacheHitRate == null ? '-' : ui.fmt.percent(main.cacheHitRate) }]);
        cache.title = S.cacheTitle;
        el.append(input, cache);
      }
      if (loop.messageCount != null) el.appendChild(chipOf(ui, [{ b: loop.messageCount }, S.chipMsgs]));
      if (loop.batchesHandled != null) {
        el.appendChild(chipOf(ui, [S.chipBatchesPre, { b: loop.batchesHandled }, S.chipBatchesPost]));
      }
      if (st.consoleOnline != null) el.appendChild(chipOf(ui, [S.chipOnline, { b: st.consoleOnline }]));
    },
  };
}
