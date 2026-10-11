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
import { qqPanelText } from './strings.ts';

type Text = ReturnType<typeof qqPanelText>;

/** WS 地址的形状。与服务端 `invokeGate` 那条校验同一个判据,先在本地拦一次。 */
const WS_URL_RE = /^wss?:\/\/.+/i;

export const gatePanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const T = qqPanelText(ctx.language);
    autoload<QQGateState>(ctx, {
      loading: T.gateLoading,
      failed: T.gateFailed,
      load: () => ctx.invoke<QQGateState>('state'),
      render: (st) => [enableSheet(ctx, st, T), connSheet(ctx, st, T), endpointSheet(ctx, st, T)],
    });
  },
};

// ---------------------------------------------------------------------------
// 接入开关
// ---------------------------------------------------------------------------

function enableSheet(ctx: ConsolePanelContext, st: QQGateState, T: Text): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: T.enableTitle,
    en: 'enabled',
    desc: T.enableDesc,
  });

  const status = ui.rowbar();
  const btn = ui.button(st.enabled ? T.turnOff : T.turnOn, {
    variant: st.enabled ? 'danger' : 'primary',
    onClick: () => { void toggleEnabled(ctx, st, btn, T); },
  });
  status.append(
    st.enabled
      ? ui.pill(st.connected ? T.enabledConnected : T.enabledDisconnected, st.connected ? 'on' : 'off')
      : ui.pill(T.notEnabled, 'plain'),
    ui.h('span', 'grow'),
  );
  card.body.appendChild(status);
  if (st.enabled && !st.connected) {
    card.body.appendChild(ui.msgline(T.endpointDown, true));
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
  T: Text,
): Promise<void> {
  const next = !st.enabled;
  const ok = await ctx.ui.confirm({
    title: T.toggleConfirmTitle(next ? T.verbOn : T.verbOff),
    body: T.restartsProcess,
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await ctx.invoke('setEnabled', [next]);
    restartWatch(ctx, next ? T.restartingOn : T.restartingOff, T);
  } catch (err) {
    ctx.ui.toast(T.actionFailed(errText(err)), 'bad');
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 连接状态
// ---------------------------------------------------------------------------

function connSheet(ctx: ConsolePanelContext, st: QQGateState, T: Text): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({ title: T.connTitle, en: 'OneBot ⇄ core' });

  const conn = !st.enabled
    ? T.notEnabled
    : st.connected
      ? T.connected
      : T.disconnected;
  const self = st.selfId != null
    ? `${st.selfId}${st.nickname ? ` · ${st.nickname}` : ''}`
    : '—';
  const groups = st.groups.length
    ? st.groups
      .map((g) => `${g.name}(${g.id})${g.card ? T.myGroupCard(g.card) : ''}`)
      .join('\n')
    : T.notConfigured;
  const privates = st.privates.length
    ? st.privates.map((p) => (p.name ? `${p.name}(${p.id})` : String(p.id))).join(T.listSep)
    : T.notConfigured;

  const table = ui.table();
  table.addRow([T.rowConn, { el: ui.pill(conn, !st.enabled ? 'plain' : st.connected ? 'on' : 'off') }]);
  table.addRow([T.rowSelf, { text: self, cls: 'txt' }]);
  table.addRow([T.rowGroups, { text: groups, cls: 'txt' }]);
  table.addRow([T.rowPrivates, { text: privates, cls: 'txt' }]);
  card.body.appendChild(table.el);
  card.body.appendChild(ui.msgline(T.rosterHint));
  return card.el;
}

// ---------------------------------------------------------------------------
// OneBot 协议端连接
// ---------------------------------------------------------------------------

function endpointSheet(ctx: ConsolePanelContext, st: QQGateState, T: Text): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: T.endpointTitle,
    en: T.endpointEn,
    desc: T.endpointDesc,
  });

  const ws = ui.input({ value: st.wsUrl || '', placeholder: 'ws://127.0.0.1:3001' });
  const token = ui.input({
    type: 'password',
    placeholder: st.tokenSet ? T.tokenSet : T.tokenUnset,
  });
  const msg = ui.msgline('');
  const save = ui.button(T.saveRestart, {
    variant: 'primary',
    onClick: () => { void saveConnection(ctx, ws, token, msg, save, T); },
  });

  const bar = ui.actions();
  bar.append(msg, ui.h('span', 'grow'), save);
  card.body.append(
    ui.field(T.fieldWsUrl, ws),
    ui.field(T.fieldToken, token),
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
  T: Text,
): Promise<void> {
  const fail = (text: string): void => {
    msg.textContent = text;
    msg.classList.add('bad');
  };
  const wsUrl = ws.value.trim();
  if (!WS_URL_RE.test(wsUrl)) {
    fail(T.badWsUrl);
    return;
  }
  msg.textContent = '';
  msg.classList.remove('bad');
  const ok = await ctx.ui.confirm({
    title: T.saveConfirmTitle,
    body: T.saveConfirmBody,
  });
  if (!ok) return;
  save.disabled = true;
  try {
    await ctx.invoke('setConnection', [wsUrl, token.value]);
    restartWatch(ctx, T.restartingSave, T);
  } catch (err) {
    fail(T.saveFailed(errText(err)));
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
function restartWatch(ctx: ConsolePanelContext, title: string, T: Text): void {
  const { ui } = ctx;
  const view = ctx.root.ownerDocument?.defaultView ?? null;
  let notice = ui.drawer(title, T.restartingBody);

  let ticks = 0;
  let probing = false;
  const timer = ctx.interval(() => {
    ticks++;
    if (ticks <= SETTLE_TICKS) return;
    if (ticks > MAX_TICKS) {
      timer.dispose();
      notice.dispose();
      notice = ui.drawer(T.restartSlowTitle, T.restartSlowBody);
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
