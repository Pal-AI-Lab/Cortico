/** 统一重置面板：先回滚工作区，再按服务端清单清除存储，session 最后重建。清单不完整时禁止执行。 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import { autoload, errText, gitLine, setMsg } from '../../cormini/console/shared.ts';
import type { ResetResult, ResetState } from './client.ts';

export const resetPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    autoload<ResetState>(ctx, {
      loading: '读取重置范围…',
      failed: '统一重置不可用',
      load: () => ctx.invoke<ResetState>('state'),
      render: (st, reload) => [runCard(ctx, st, reload), scopeCard(ctx, st)],
    });
  },
};

function runCard(ctx: ConsolePanelContext, st: ResetState, reload: () => void): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '统一重置',
    en: 'rollback + clear all',
    desc: '将工作区回滚到选定存档点，再按清单清除存储。',
  });

  const bar = ui.rowbar();
  bar.append(ui.pill(gitLine(st.status), st.status.repo ? 'on' : 'off'), ui.h('span', 'grow'));
  card.body.appendChild(bar);

  if (!st.ready) {
    card.body.appendChild(ui.placeholder(st.reason ?? '重置暂不可用'));
    return card.el;
  }
  if (!st.checkpoints.length) {
    card.body.appendChild(ui.placeholder('没有可用存档点，请先在「存档点」面板创建。'));
    return card.el;
  }

  const pick = ui.select({
    options: st.checkpoints.map((c) => ({
      value: c.name,
      label: `${c.name} · ${c.hash}${c.message ? ` · ${c.message}` : ''}`,
    })),
  });
  const msg = ui.msgline('');
  const run = ui.button('回滚并清空', {
    variant: 'danger',
    onClick: () => { void execute(ctx, pick.value, msg, run, reload); },
  });
  const line = ui.actions();
  line.append(msg, ui.h('span', 'grow'), run);
  card.body.append(ui.field('回滚到', pick), line);
  return card.el;
}

async function execute(
  ctx: ConsolePanelContext,
  checkpoint: string,
  msg: HTMLElement,
  btn: HTMLButtonElement,
  reload: () => void,
): Promise<void> {
  const { ui } = ctx;
  const first = await ui.confirm({
    title: `回滚到存档点「${checkpoint}」并清空全部存储?`,
    body: '工作区恢复到该存档点，然后清除清单中的全部存储。已提交的工作区版本可查询；清除的数据不可恢复。',
    danger: true,
  });
  if (!first) return;
  const second = await ui.confirm({
    title: '再确认',
    body: `确认回滚到「${checkpoint}」并清除清单中的全部存储？`,
    danger: true,
  });
  if (!second) return;

  const busy = ui.busy('正在重置', '正在回滚工作区并清除存储。');
  btn.disabled = true;
  try {
    const out = await ctx.invoke<ResetResult>('run', [checkpoint]);
    const bad = out.results.filter((r) => !r.ok);
    setMsg(
      msg,
      `${out.ok ? '✓ ' : '部分失败: '}${out.persona};清理 ${out.results.length} 项`
      + (bad.length ? `(${bad.map((r) => r.key).join('、')} 失败)` : ''),
      bad.length > 0,
    );
    if (bad.length) {
      ui.drawer('逐项结果', out.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.key}: ${r.result}`).join('\n'));
    }
    reload();
  } catch (err) {
    setMsg(msg, `重置失败: ${errText(err)}`, true);
  } finally {
    busy.dispose();
    btn.disabled = false;
  }
}

function scopeCard(ctx: ConsolePanelContext, st: ResetState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '清除范围',
    en: 'storage parts',
    desc: '工作区回滚后按清单逐项清除。session 最后清除，并用回滚后的工作区重建前缀。',
  });
  if (!st.parts.length) {
    card.body.appendChild(ui.placeholder('拿不到存储清单'));
    return card.el;
  }
  const table = ui.table({ head: ['项', '位置', '清掉之后'] });
  for (const p of st.parts) {
    const name = ui.h('span', null, p.label);
    const cell = ui.h('div', 'ct-cellops');
    cell.append(name);
    if (p.danger) cell.appendChild(ui.pill('不可恢复', 'off'));
    table.addRow([
      { el: cell },
      { text: p.location ?? (p.kind === 'memory' ? '(内存)' : '—'), cls: 'mono' },
      { text: p.note ?? '—', cls: 'txt' },
    ]);
  }
  card.body.appendChild(table.el);
  return card.el;
}
