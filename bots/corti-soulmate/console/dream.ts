/**
 * 手动交接面板，通过 provider invoke 触发 bot 声明的动作，并读取该动作的状态。后台梦整理由 bot 负责。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import { autoload, errText, setMsg } from '../../cormini/console/shared.ts';
import type { DreamState, DreamTriggered } from './client.ts';

const POLL_MS = 4000;

export const dreamPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    autoload<DreamState>(ctx, {
      loading: '读取潜意识状态…',
      failed: '潜意识状态不可用',
      load: () => ctx.invoke<DreamState>('state'),
      render: (st) => [card(ctx, st)],
    });
  },
};

function card(ctx: ConsolePanelContext, initial: DreamState): HTMLElement {
  const { ui } = ctx;
  const sheet = ui.sheet({
    title: '强制入梦',
    en: 'handoff → dream',
    desc: '强制交接上下文，并将交接前的快照交给梦 fork 整理工作区。正在入梦或交接时不重复触发。',
  });

  const pills = ui.rowbar();
  const dreamPill = ui.pill('—', 'plain');
  pills.append(ui.h('span', 'ct-dim', '梦'), dreamPill, ui.h('span', 'grow'));

  const msg = ui.msgline('');
  const trigger = ui.button('强制交接并入梦', {
    variant: 'primary',
    onClick: () => { void fire(); },
  });
  const bar = ui.actions();
  bar.append(msg, ui.h('span', 'grow'), trigger);

  sheet.body.append(pills, bar);

  const paint = (st: DreamState): void => {
    dreamPill.textContent = st.dreaming ? '进行中' : '空闲';
    dreamPill.className = `pill ${st.dreaming ? 'on' : 'off'}`;
    trigger.disabled = st.dreaming;
    trigger.textContent = st.dreaming ? '入梦中…' : '强制交接并入梦';
  };
  paint(initial);

  const fire = async (): Promise<void> => {
    trigger.disabled = true;
    try {
      const out = await ctx.invoke<DreamTriggered>('trigger');
      setMsg(msg, out.message, !out.ok);
      paint(out.state);
    } catch (err) {
      setMsg(msg, `触发失败: ${errText(err)}`, true);
      trigger.disabled = false;
    }
  };

  ctx.interval(() => {
    void ctx.invoke<DreamState>('state').then(
      (st) => { if (!ctx.signal.aborted) paint(st); },
      () => { /* 请求失败时保留上次状态。 */ },
    );
  }, POLL_MS);

  return sheet.el;
}
