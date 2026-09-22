/**
 * 面板 `gate` —— 接入门:接入开关 + 连接状态 + OneBot 协议端连接。
 *
 * 三张卡靠同一份 `gate.state`,一次取数。改开关或改连接都会**真重启进程**,
 * 所以这里还带着重启期间的等待与回来后的自动刷新(`restartWatch`)。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from '../../../web/shared/client-panel.ts';
import { autoload, errText, type QQGateState } from './client.ts';

/** WS 地址的形状。与服务端 `invokeGate` 那条校验同一个判据,先在本地拦一次。 */
const WS_URL_RE = /^wss?:\/\/.+/i;

export const gatePanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    autoload<QQGateState>(ctx, {
      loading: '加载 QQ 接入状态…',
      failed: 'QQ 接入状态不可用',
      load: () => ctx.invoke<QQGateState>('state'),
      render: (st) => [enableSheet(ctx, st), connSheet(ctx, st), endpointSheet(ctx, st)],
    });
  },
};

// ---------------------------------------------------------------------------
// 接入开关
// ---------------------------------------------------------------------------

function enableSheet(ctx: ConsolePanelContext, st: QQGateState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '接入开关',
    en: 'enabled',
    desc: '开启或关闭 QQ 接入会重启进程。',
  });

  const status = ui.rowbar();
  const btn = ui.button(st.enabled ? '关闭 QQ 接入' : '开启 QQ 接入', {
    variant: st.enabled ? 'danger' : 'primary',
    onClick: () => { void toggleEnabled(ctx, st, btn); },
  });
  status.append(
    st.enabled
      ? ui.pill(st.connected ? '已启用 · 已连接' : '已启用 · 未连接', st.connected ? 'on' : 'off')
      : ui.pill('未启用', 'plain'),
    ui.h('span', 'grow'),
  );
  card.body.appendChild(status);
  if (st.enabled && !st.connected) {
    card.body.appendChild(ui.msgline('协议端未连接。', true));
  }
  const actions = ui.actions();
  actions.append(ui.h('span', 'grow'), btn);
  card.body.appendChild(actions);
  return card.el;
}

async function toggleEnabled(
  ctx: ConsolePanelContext,
  st: QQGateState,
  btn: HTMLButtonElement,
): Promise<void> {
  const next = !st.enabled;
  const verb = next ? '开启' : '关闭';
  const ok = await ctx.ui.confirm({
    title: `${verb} QQ 接入?`,
    body: '此操作会重启进程。',
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await ctx.invoke('setEnabled', [next]);
    restartWatch(ctx, verb);
  } catch (err) {
    ctx.ui.toast(`操作失败: ${errText(err)}`, 'bad');
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 连接状态
// ---------------------------------------------------------------------------

function connSheet(ctx: ConsolePanelContext, st: QQGateState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({ title: '连接状态', en: 'OneBot ⇄ core' });

  const conn = !st.enabled
    ? '未启用'
    : st.connected
      ? '已连接'
      : '未连接';
  const self = st.selfId != null
    ? `${st.selfId}${st.nickname ? ` · ${st.nickname}` : ''}`
    : '—';
  const groups = st.groups.length
    ? st.groups
      .map((g) => `${g.name}(${g.id})${g.card ? ` · 我的群昵称「${g.card}」` : ''}`)
      .join('\n')
    : '(未配置)';
  const privates = st.privates.length
    ? st.privates.map((p) => (p.name ? `${p.name}(${p.id})` : String(p.id))).join('、')
    : '(未配置)';

  const table = ui.table();
  table.addRow(['连接', { el: ui.pill(conn, !st.enabled ? 'plain' : st.connected ? 'on' : 'off') }]);
  table.addRow(['自身 QQ', { text: self, cls: 'txt' }]);
  table.addRow(['监听群', { text: groups, cls: 'txt' }]);
  table.addRow(['监听私聊', { text: privates, cls: 'txt' }]);
  card.body.appendChild(table.el);
  card.body.appendChild(ui.msgline('监听名单在「监听名单」面板里热改(无需重启)。'));
  return card.el;
}

// ---------------------------------------------------------------------------
// OneBot 协议端连接
// ---------------------------------------------------------------------------

function endpointSheet(ctx: ConsolePanelContext, st: QQGateState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: 'OneBot 协议端',
    en: '正向 WS + token',
    desc: '推荐 SnowLuma,NapCat 等 OneBot v11 实现同样可用。协议端需保持运行、登录 QQ 并开启正向 WebSocket;'
      + 'SnowLuma 的 token 在它的 config/onebot_<QQ号>.json 里。保存连接配置后重启进程。',
  });

  const ws = ui.input({ value: st.wsUrl || '', placeholder: 'ws://127.0.0.1:3001' });
  const token = ui.input({
    type: 'password',
    placeholder: st.tokenSet ? '已配置(留空＝不改动)' : '(未配置)',
  });
  const msg = ui.msgline('');
  const save = ui.button('保存并重启', {
    variant: 'primary',
    onClick: () => { void saveConnection(ctx, ws, token, msg, save); },
  });

  const bar = ui.actions();
  bar.append(msg, ui.h('span', 'grow'), save);
  card.body.append(
    ui.field('WS 地址', ws),
    ui.field('Access Token(可空)', token),
    bar,
  );
  return card.el;
}

async function saveConnection(
  ctx: ConsolePanelContext,
  ws: HTMLInputElement,
  token: HTMLInputElement,
  msg: HTMLDivElement,
  save: HTMLButtonElement,
): Promise<void> {
  const fail = (text: string): void => {
    msg.textContent = text;
    msg.classList.add('bad');
  };
  const wsUrl = ws.value.trim();
  if (!WS_URL_RE.test(wsUrl)) {
    fail('WS 地址必须以 ws:// 或 wss:// 开头');
    return;
  }
  msg.textContent = '';
  msg.classList.remove('bad');
  const ok = await ctx.ui.confirm({
    title: '保存协议端连接并重启?',
    body: '保存连接配置后重启进程。',
  });
  if (!ok) return;
  save.disabled = true;
  try {
    await ctx.invoke('setConnection', [wsUrl, token.value]);
    restartWatch(ctx, '保存连接');
  } catch (err) {
    fail(`保存失败: ${errText(err)}`);
    save.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 重启等待
// ---------------------------------------------------------------------------

/** 探活前先让旧进程走完退出窗口(约 350ms),这几拍不问。 */
const SETTLE_TICKS = 3;
/** 探活总拍数。超了就换一句"要不要手动看看"的措辞,不再空转。 */
const MAX_TICKS = 90;
const TICK_MS = 1000;

/**
 * 重启期间显示等待状态，以 ctx.interval 轮询 ctx.invoke("state")，确认本面板服务恢复后整页重载。轮询和请求均随 ctx.signal 取消，离开面板后停止。
 */
function restartWatch(ctx: ConsolePanelContext, verb: string): void {
  const { ui } = ctx;
  const view = ctx.root.ownerDocument?.defaultView ?? null;
  let notice = ui.drawer(
    `${verb}中`,
    '正在重启，完成后自动刷新页面。',
  );

  let ticks = 0;
  let probing = false;
  const timer = ctx.interval(() => {
    ticks++;
    if (ticks <= SETTLE_TICKS) return;
    if (ticks > MAX_TICKS) {
      timer.dispose();
      notice.dispose();
      notice = ui.drawer(
        '重启耗时偏长',
        '请手动刷新页面,或检查启动器是否还在运行'
        + '(没用启动器起的进程,退出后不会有人把它拉起来)。',
      );
      return;
    }
    if (probing) return; // 上一拍的探活还没回来,不叠着发
    probing = true;
    void ctx.invoke('state').then(
      () => {
        timer.dispose();
        notice.dispose();
        view?.location.reload();
      },
      () => { probing = false; }, // 还没回来,下一拍再问
    );
  }, TICK_MS);
}
