/**
 * 新部署的开场引导：四条 Cortico 署名的气泡，用 assistant 直接输出那套气泡样式。
 * 端点状态由终端页从 providers 灯推进来，已启用的 World 在挂载时读一次接口。
 * 是否显示由终端页判定，这里只画。
 */

import type { ConsoleUi } from '../../../shared/client-panel.ts';
import { get } from '../../core/api.ts';
import { brandMark, icon, type ConsoleIconName } from '../../ui/icons.ts';
import { S } from './strings.ts';

/** 这一页用得到的 `/api/worlds` 字段。 */
interface WorldRow {
  label?: unknown;
  status?: unknown;
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
  /** 端点可用性来自 providers 灯。 */
  setProvider(ready: boolean): void;
}

/** 状态行的语气：成不成事各有各的颜色，不报读数时收起这一行。 */
type Tone = 'ok' | 'bad';

interface Bubble {
  setState(text: string | null, tone?: Tone): void;
  button: HTMLButtonElement;
}

export function createOnboarding(deps: OnboardingDeps): OnboardingView {
  const { ui, doc, signal } = deps;

  const el = ui.h('div', 'onboarding');
  const grid = ui.h('div', 'ob-grid');
  const gutter = ui.h('div', 'gutter ob-mark');
  gutter.appendChild(brandMark(doc));
  const col = ui.h('div', 'ob-col');
  col.appendChild(ui.h('div', 'ob-who', S.obWho));
  const body = ui.h('div', 'turnbody');
  col.appendChild(body);
  grid.append(gutter, col);
  el.appendChild(grid);

  const bubble = (
    line: string,
    action?: { label: string; icon?: ConsoleIconName; accent?: boolean; onClick(): void },
  ): Bubble => {
    const box = ui.h('div', 'monolog');
    box.appendChild(ui.h('div', 'monolog-body', line));
    const state = ui.h('div', 'ob-state hidden');
    // 外观取子页签那颗按钮（`.seg`），`ob-btn` 只挂本页的微调。
    const button = ui.h('button', action?.accent ? 'seg active ob-btn ob-go' : 'seg active ob-btn');
    button.type = 'button';
    if (action?.icon) button.appendChild(icon(doc, action.icon));
    button.appendChild(ui.h('span', null, action?.label ?? ''));
    if (action) button.addEventListener('click', () => action.onClick(), { signal });
    box.appendChild(state);
    if (action) {
      const acts = ui.h('div', 'ob-acts');
      acts.appendChild(button);
      box.appendChild(acts);
    }
    body.appendChild(box);
    return {
      button,
      setState(text, tone) {
        state.className = text === null ? 'ob-state hidden' : `ob-state ${tone ?? ''}`.trim();
        state.textContent = text ?? '';
      },
    };
  };

  bubble(S.obWelcome);
  const provider = bubble(S.obProvider, { label: S.obGoConfigure, onClick: () => deps.go(['providers']) });
  const worlds = bubble(S.obWorlds, { label: S.obGoConfigure, onClick: () => deps.go(['world']) });
  bubble(S.obPrompts, { label: S.obGoEdit, onClick: () => deps.go(['prompts']) });

  const startLabel = S.obStart;
  // 最后那颗按的是「开始跑」，图标与左下角运行控制里的继续是同一个。
  const ready = bubble(S.obReady, {
    label: startLabel,
    icon: 'play',
    accent: true,
    onClick: () => deps.start(startLabel),
  });

  // 读不到就让这一行空着：引导区少一行读数，不该变成错误卡。
  void get<{ worlds?: WorldRow[] }>('/api/worlds', { signal }).then((data) => {
    const active = (data?.worlds ?? [])
      .filter((w) => w.status === 'active' && typeof w.label === 'string')
      .map((w) => w.label as string);
    if (active.length) worlds.setState(S.obWorldsState(active));
  }, () => {});

  return {
    el,
    setProvider(available) {
      provider.setState(available ? S.obProviderReady : S.obProviderNone, available ? 'ok' : 'bad');
      // 最后一条只在还缺端点时说话：配好了就只剩那颗按钮。
      ready.setState(available ? null : S.obProviderNone, 'bad');
      ready.button.disabled = !available;
    },
  };
}
