/**
 * 新部署的开场引导：三条 Cortico 署名的气泡各报一项配置的当前状态，末尾那颗按钮让运行继续
 * 并请对方开口。端点状态由终端页从 providers 灯推进来，另两项在挂载时各读一次接口。
 * 是否显示由终端页判定，这里只画。
 */

import type { ConsoleUi } from '../../../shared/client-panel.ts';
import { get } from '../../core/api.ts';
import { brandMark } from '../../ui/icons.ts';
import { S } from './strings.ts';

/** 这一页用得到的 `/api/worlds` 字段。 */
interface WorldRow {
  label?: unknown;
  status?: unknown;
}

/** 这一页用得到的 `/api/prompts` 字段。 */
interface PromptRow {
  scope?: unknown;
  origin?: unknown;
}

export interface OnboardingDeps {
  ui: ConsoleUi;
  doc: Document;
  signal: AbortSignal;
  /** 跳到控制台的另一页。 */
  go(segments: readonly string[]): void;
  /** 继续运行并请对方开口；`label` 是这颗按钮上的字，逐字进事件正文。 */
  start(label: string): void;
}

export interface OnboardingView {
  el: HTMLElement;
  /** 端点可用性与悬停说明取自 providers 灯。 */
  setProvider(ready: boolean, hint: string): void;
}

interface Bubble {
  el: HTMLElement;
  setState(text: string, bad?: boolean): void;
}

export function createOnboarding(deps: OnboardingDeps): OnboardingView {
  const { ui, doc, signal } = deps;

  const el = ui.h('div', 'onboarding');
  const grid = ui.h('div', 'ob-grid');
  const gutter = ui.h('div', 'gutter ob-mark');
  gutter.appendChild(brandMark(doc));
  const col = ui.h('div', 'ob-col');
  col.appendChild(ui.h('div', 'ob-who', S.obWho));
  grid.append(gutter, col);
  el.appendChild(grid);

  const bubble = (line: string, action: { label: string; go: readonly string[] }): Bubble => {
    const box = ui.h('div', 'ob-bubble');
    box.appendChild(ui.h('div', 'ob-line', line));
    const state = ui.h('div', 'ob-state');
    const button = ui.button(action.label, { size: 'sm', onClick: () => deps.go(action.go) });
    const row = ui.h('div', 'ob-acts');
    row.append(state, button);
    box.appendChild(row);
    col.appendChild(box);
    return {
      el: box,
      setState(text, bad) {
        state.textContent = text;
        state.className = bad ? 'ob-state bad' : 'ob-state';
      },
    };
  };

  const provider = bubble(S.obProvider, { label: S.obProviderAction, go: ['providers'] });
  const worlds = bubble(S.obWorlds, { label: S.obWorldsAction, go: ['world'] });
  const prompts = bubble(S.obPrompts, { label: S.obPromptsAction, go: ['prompts'] });

  const startLabel = S.obStart;
  const start = ui.button(startLabel, {
    variant: 'primary',
    onClick: () => deps.start(startLabel),
  });
  const startRow = ui.h('div', 'ob-start');
  startRow.appendChild(start);
  col.appendChild(startRow);

  // 读不到就把状态行留空：引导区少一行读数，不该变成错误卡。
  void get<{ worlds?: WorldRow[] }>('/api/worlds', { signal }).then((data) => {
    const active = (data?.worlds ?? [])
      .filter((w) => w.status === 'active' && typeof w.label === 'string')
      .map((w) => w.label as string);
    if (active.length) worlds.setState(S.obWorldsState(active));
  }, () => {});

  void get<{ prompts?: PromptRow[] }>('/api/prompts', { signal }).then((data) => {
    const persona = (data?.prompts ?? []).filter((p) => p.scope === 'persona');
    if (!persona.length) return;
    prompts.setState(persona.some((p) => p.origin === 'deployment') ? S.obPromptsOwn : S.obPromptsDefault);
  }, () => {});

  return {
    el,
    setProvider(ready, hint) {
      // 灯自己的悬停说明就是这一行要报的读数（可用的端点名，或最后一个端点不可用的原因）。
      const state = hint || S.obProviderNone;
      provider.setState(state, !ready);
      start.disabled = !ready;
      start.title = ready ? '' : state;
    },
  };
}
