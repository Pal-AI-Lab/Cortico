/**
 * 存档点面板管理 persona 仓库的 git tag，属于 bot 的运维控制面。
 * 回滚与 reset 共用统一重置事务：回滚 persona 并清空 core 存储，执行前需要两道确认。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import { autoload, errText, gitLine, setMsg, stamp } from '../../cormini/console/shared.ts';
import type {
  Applied, CheckpointEntry, CheckpointsState, ResetResult,
} from './client.ts';

/** 出厂基线不能删(服务端也会拦,这里先把按钮省掉)。 */
const BASELINE = 'checkpoint0';

export const checkpointsPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    autoload<CheckpointsState>(ctx, {
      loading: '读取存档点…',
      failed: '存档点不可用',
      load: () => ctx.invoke<CheckpointsState>('state'),
      render: (st, reload) => [listCard(ctx, st, reload), createCard(ctx, reload)],
    });
  },
};

function listCard(
  ctx: ConsolePanelContext,
  st: CheckpointsState,
  reload: () => void,
): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '存档点',
    en: 'git tag',
    desc: '存档点是工作区 Git 仓库中的 annotated tag。回滚时还会按存储清单清除数据。',
  });

  const bar = ui.rowbar();
  bar.append(
    ui.pill(gitLine(st.status), st.status.repo ? 'on' : 'off'),
    ui.h('span', 'grow'),
    ui.button('刷新', { size: 'sm', onClick: reload }),
  );
  card.body.appendChild(bar);

  const msg = ui.msgline('');

  if (!st.checkpoints.length) {
    card.body.appendChild(ui.placeholder(
      st.status.repo ? '还没有存档点' : 'persona/ 还没有建仓(bot 启动后自动建并打 checkpoint0)',
    ));
    card.body.appendChild(msg);
    return card.el;
  }

  const table = ui.table({ head: ['名字', '提交', '时间', '说明', ''] });
  for (const c of st.checkpoints) {
    table.addRow([
      { text: c.name, cls: 'mono' },
      { text: c.hash, cls: 'mono' },
      { text: stamp(c.date), cls: 'mono' },
      { text: c.message || '—', cls: 'txt' },
      { el: rowActions(ctx, c, msg, reload) },
    ]);
  }
  card.body.append(table.el, msg);
  return card.el;
}

function rowActions(
  ctx: ConsolePanelContext,
  c: CheckpointEntry,
  msg: HTMLElement,
  reload: () => void,
): HTMLElement {
  const { ui } = ctx;
  const bar = ui.rowbar();
  const roll = ui.button('回滚到此', {
    size: 'sm',
    variant: 'danger',
    onClick: () => { void rollback(ctx, c.name, msg, reload, roll); },
  });
  bar.appendChild(roll);
  if (c.name !== BASELINE) {
    bar.appendChild(ui.button('删除', {
      size: 'sm',
      onClick: () => { void remove(ctx, c.name, msg, reload); },
    }));
  }
  return bar;
}

async function remove(
  ctx: ConsolePanelContext,
  name: string,
  msg: HTMLElement,
  reload: () => void,
): Promise<void> {
  const ok = await ctx.ui.confirm({
    title: `删除存档点「${name}」?`,
    body: '只删这个标记,persona/ 里的文件与提交都不动。',
  });
  if (!ok) return;
  try {
    const out = await ctx.invoke<Applied<CheckpointsState>>('remove', [name]);
    setMsg(msg, out.result);
    reload();
  } catch (err) {
    setMsg(msg, `删除失败: ${errText(err)}`, true);
  }
}

/**
 * 回滚前进行两道确认：先说明操作范围，再确认清空当前经历。
 */
async function rollback(
  ctx: ConsolePanelContext,
  name: string,
  msg: HTMLElement,
  reload: () => void,
  btn: HTMLButtonElement,
): Promise<void> {
  const { ui } = ctx;
  const first = await ui.confirm({
    title: `回滚到存档点「${name}」?`,
    body: '工作区恢复到该存档点，再按清单清除 session、事件库、状态、定时器、统计、用量和 World 缓存。'
      + '已提交的工作区版本可查询；清除的数据不可恢复。',
    danger: true,
  });
  if (!first) return;
  const second = await ui.confirm({
    title: '再确认',
    body: `确认回滚到「${name}」并清除清单中的全部存储？`,
    danger: true,
  });
  if (!second) return;

  const busy = ui.busy('正在重置', '正在回滚工作区并清除存储。');
  btn.disabled = true;
  try {
    const out = await ctx.invoke<ResetResult>('rollback', [name]);
    const bad = out.results.filter((r) => !r.ok);
    setMsg(
      msg,
      `${out.ok ? '✓ ' : '部分失败: '}${out.persona};清理 ${out.results.length} 项`
      + (bad.length ? `(${bad.map((r) => r.key).join('、')} 失败)` : ''),
      bad.length > 0,
    );
    reload();
  } catch (err) {
    setMsg(msg, `重置失败: ${errText(err)}`, true);
  } finally {
    busy.dispose();
    btn.disabled = false;
  }
}

function createCard(ctx: ConsolePanelContext, reload: () => void): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '新建存档点',
    en: 'tag',
    desc: '先提交工作区当前的改动，再创建存档点。',
  });
  const name = ui.input({ placeholder: '名字(字母数字、下划线、点、连字符或中文)', cls: 'mono' });
  const note = ui.input({ placeholder: '说明(可空)' });
  const msg = ui.msgline('');
  const create = ui.button('创建', {
    variant: 'primary',
    onClick: () => {
      const n = name.value.trim();
      if (!n) { setMsg(msg, '给存档点起个名', true); return; }
      const busy = ui.disable(create, name, note);
      void ctx.invoke<Applied<CheckpointsState>>('create', [n, note.value.trim()])
        .then(
          (out) => {
            setMsg(msg, out.result);
            name.value = '';
            note.value = '';
            reload();
          },
          (err: unknown) => { setMsg(msg, `创建失败: ${errText(err)}`, true); },
        )
        .finally(() => { busy.dispose(); });
    },
  });
  const bar = ui.actions();
  bar.append(msg, ui.h('span', 'grow'), create);
  card.body.append(ui.field('名字', name), ui.field('说明', note), bar);
  return card.el;
}
