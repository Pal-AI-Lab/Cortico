/**
 * Persona自报的 MEMORY 0–4 分层视图与写权限矩阵。服务端逐角色、区域和操作调用 checkAccess 生成矩阵。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import { autoload, dimLine } from '../../cormini/console/shared.ts';
import type { FileOp, MemoryState } from './client.ts';

const ROLE_LABELS: Record<string, string> = {
  main: '主意识 main',
  dream: '梦 dream',
};

const OP_LABELS: Record<FileOp, string> = {
  read: '读',
  write: '写',
  append: '追加',
  rename: '改名',
  delete: '删除',
};

export const memoryPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    autoload<MemoryState>(ctx, {
      loading: '读取记忆分层…',
      failed: 'Memory 视图不可用',
      load: () => ctx.invoke<MemoryState>('state'),
      render: (st) => [tiersCard(ctx, st), memoCard(ctx, st), matrixCard(ctx, st)],
    });
  },
};

// ---------------------------------------------------------------------------

function tiersCard(ctx: ConsolePanelContext, st: MemoryState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: 'MEMORY 分层',
    en: 'MEMORY 0–4',
  });
  const table = ui.table({ head: ['层', '装的是什么', '此刻'] });
  for (const t of st.tiers) {
    table.addRow([
      { text: `${t.id}·${t.title}`, cls: 'mono' },
      { text: t.detail, cls: 'txt' },
      { text: t.live, cls: 'mono' },
    ]);
  }
  card.body.appendChild(table.el);
  return card.el;
}

function memoCard(ctx: ConsolePanelContext, st: MemoryState): HTMLElement {
  const { ui } = ctx;
  const { memo } = st;
  const card = ui.sheet({
    title: 'memo 三级',
    en: 'resident / active / archived',
    desc: '前缀包含常驻区全文、active 文件名和 archived 文件数。容量已满时工具拒绝新增文件。',
  });

  card.body.appendChild(ui.statgrid([
    { k: '常驻 memo/', v: memo.resident.length, unit: `/ ${memo.residentCap}`, accent: true },
    { k: 'active/', v: memo.active.length, unit: `/ ${memo.activeCap}` },
    { k: 'archived/', v: memo.archived, unit: '条' },
  ]));

  card.body.appendChild(ui.section('常驻区(全文进前缀,时间序:最旧在前)'));
  card.body.appendChild(fileList(ctx, memo.resident, '常驻区是空的'));
  card.body.appendChild(ui.section('active/(前缀里只出现文件名)'));
  card.body.appendChild(fileList(ctx, memo.active, 'active/ 目前是空的'));
  card.body.appendChild(dimLine(
    ctx,
    memo.archived > 0
      ? `archived/ 里还有 ${memo.archived} 条归档,前缀里只报数量,正文由 agent 主动翻。`
      : 'archived/ 目前是空的。',
  ));
  return card.el;
}

function fileList(ctx: ConsolePanelContext, names: string[], empty: string): HTMLElement {
  const { ui } = ctx;
  if (!names.length) return ui.placeholder(empty);
  const box = ui.h('div', 'ct-chips');
  for (const n of names) box.appendChild(ui.chip(n));
  return box;
}

// ---------------------------------------------------------------------------

function matrixCard(ctx: ConsolePanelContext, st: MemoryState): HTMLElement {
  const { ui } = ctx;
  const { matrix } = st;
  const card = ui.sheet({
    title: '写权限矩阵',
    en: 'permissions',
    desc: '工具拒绝超出权限的操作并返回原因。所有角色均可读取这些区域。',
  });

  const table = ui.table({
    head: ['区域', ...matrix.roles.map((r) => ROLE_LABELS[r] ?? r)],
  });
  for (const row of matrix.rows) {
    table.addRow([
      { text: row.label, cls: 'txt' },
      ...row.cells.map((cell) => ({ el: cellNode(ctx, cell) })),
    ]);
  }
  card.body.appendChild(table.el);
  return card.el;
}

/** 悬停说明使用工具返回的拒绝原因。 */
function cellNode(ctx: ConsolePanelContext, cell: { allowed: FileOp[]; denied: Array<{ op: FileOp; reason: string }> }): HTMLElement {
  const { ui } = ctx;
  const box = ui.h('div', 'ct-cellops');
  const writable = cell.allowed.filter((op) => op !== 'read');
  if (!writable.length) {
    box.appendChild(ui.pill('只读', 'off'));
  } else {
    for (const op of writable) box.appendChild(ui.pill(OP_LABELS[op], 'on'));
  }
  if (cell.denied.length) {
    box.title = cell.denied.map((d) => `${OP_LABELS[d.op]}:${d.reason}`).join('\n');
  }
  return box;
}
