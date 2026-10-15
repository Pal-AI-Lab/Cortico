/**
 * 面板 `access` —— 权限与作弊。
 *
 * 专用服务器没有单人存档里那个「开作弊」勾选框。同一件事在这里是两半:**谁在
 * ops.json 里**(能不能下 /tp、/gamemode、/spectate 这类指令),以及
 * `op-permission-level`(op 拿到第几级,4 才够全部指令)。所以这一屏的主体是一份
 * 名单,而不是一个开关。
 *
 * 吃这份名单的是 **bot 与人在游戏里打的命令**:mc_escape 的 /tp、把玩家传送到她
 * 旁边、摄像机附身——服务器由 World 托管时它们走服务器控制台 stdin(天生 4 级,不看名单),
 * 外部起的服务器上就只剩这条退路。
 *
 * 时机与「存档与玩法」同一条规则,只是这里有两份都只在启动时读的文件:停机时改
 * 文件;跑着且是托管的,名单能走服务器控制台 op/deop 当场生效(服务端自己写回文件),
 * server.properties 那几项一概要停机;外部起的跑着时什么都改不了。
 */

import type {
  WebUiPanelContext,
  WebUiPanel,
} from '../../../web/shared/client-panel.ts';
import {
  errText,
  msgLine,
  type MinecraftAccessMember,
  type MinecraftAccessState,
} from './client.ts';
import { text } from './strings.ts';

export const accessPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const T = text(ctx.language);
    const A = T.access;

    // -----------------------------------------------------------------------
    // 卡一:管理员名单
    // -----------------------------------------------------------------------
    const card = ui.sheet({ title: A.title, en: 'cheats & permissions', desc: A.desc });
    const s = card.body;
    root.appendChild(card.el);

    const msg = msgLine(ctx);
    s.appendChild(msg.el);

    const stateBox = ui.h('div');
    s.append(ui.section(A.current), stateBox);

    const list = ui.table({ head: [A.name, A.role, A.cheats, ''] });
    s.append(ui.section(A.opList, A.opListNote), list.el);

    const addName = ui.input({ placeholder: A.gameName });
    const btnAdd = ui.button(A.grant, { size: 'sm' });
    const addBar = ui.actions();
    addBar.append(ui.field(A.grantAnother, addName), ui.h('span', 'grow'), btnAdd);
    s.append(addBar);

    // -----------------------------------------------------------------------
    // 卡二:服务器权限项(server.properties)
    // -----------------------------------------------------------------------
    const propCard = ui.sheet({
      title: A.propTitle,
      en: 'permission properties',
      desc: A.propDesc,
    });
    const p = propCard.body;
    root.appendChild(propCard.el);

    const levelSel = ui.select({ options: A.levels.map((label, i) => ({ value: String(i + 1), label })) });
    const cmdBlockIn = ui.checkbox(A.commandBlock);
    const flightIn = ui.checkbox(A.allowFlight);
    const onlineIn = ui.checkbox(A.onlineMode);
    const whiteIn = ui.checkbox(A.whiteList);
    const btnApply = ui.button(T.apply, { size: 'sm', variant: 'primary' });
    const propForm = ui.h('div', 'mc-form');
    propForm.append(ui.field(A.opLevel, levelSel));
    const propBar = ui.actions();
    propBar.append(cmdBlockIn.el, flightIn.el, onlineIn.el, whiteIn.el, ui.h('span', 'grow'), btnApply);
    const propNote = ui.h('div', 'pagedesc', A.propNote);
    p.append(propForm, propBar, propNote);

    // -----------------------------------------------------------------------

    let cur: MinecraftAccessState | null = null;

    function memberRow(m: MinecraftAccessMember, st: MinecraftAccessState): void {
      const role = A.roles[m.role];
      const who = ui.h('span', null, role.label);
      who.title = role.note;
      const btn = ui.button(m.op ? A.revoke : A.grant, { size: 'sm', variant: m.op ? 'plain' : 'primary' });
      btn.disabled = !st.configured || (st.live && !st.hosted);
      btn.addEventListener('click', () => {
        void act(() => ctx.invoke<MinecraftAccessState>('setOp', [m.name, !m.op]), m.op ? A.revoking : A.granting);
      }, { signal: ctx.signal });
      list.addRow([
        { text: m.name, cls: 'mono' },
        who,
        m.op ? ui.pill(A.hasLevel(m.level), 'on') : ui.pill(A.none, 'off'),
        btn,
      ]);
    }

    function render(st: MinecraftAccessState | null): void {
      if (ctx.signal.aborted) return;
      cur = st;
      if (!st) {
        msg.say(A.unavailable, true);
        stateBox.replaceChildren(ui.placeholder(A.noOps));
        list.clear('—');
        return;
      }
      stateBox.replaceChildren(ui.kv([
        {
          k: T.server,
          v: ui.pill(
            st.live ? (st.hosted ? T.runningHosted : T.runningExternal) : T.stopped,
            st.live ? 'on' : 'plain',
          ),
        },
        {
          k: A.autoOp,
          v: st.autoOp
            ? ui.pill(A.autoOpOn, 'on')
            : ui.pill(A.autoOpOff, 'off'),
        },
        { k: T.serverDir, v: st.serverDir || T.notConfigured },
      ]));

      list.clear();
      if (!st.members.length) list.clear(A.emptyList);
      else for (const m of st.members) memberRow(m, st);

      levelSel.value = String(st.settings.opPermissionLevel);
      cmdBlockIn.setChecked(st.settings.enableCommandBlock);
      flightIn.setChecked(st.settings.allowFlight);
      onlineIn.setChecked(st.settings.onlineMode);
      whiteIn.setChecked(st.settings.whiteList);

      const stopped = !st.live;
      const off = !st.configured;
      addName.disabled = btnAdd.disabled = off || (st.live && !st.hosted);
      levelSel.disabled = cmdBlockIn.input.disabled = off || !stopped;
      flightIn.input.disabled = onlineIn.input.disabled = off || !stopped;
      whiteIn.input.disabled = btnApply.disabled = off || !stopped;

      msg.say(st.detail || (st.live && !st.hosted
        ? A.liveExternal
        : st.live
          ? A.liveHosted
          : ''));
    }

    const refresh = (): Promise<void> =>
      ctx.invoke<MinecraftAccessState>('state').then(render, () => render(null));

    /** 一次动作:置灰两颗钮 → 调服务端 → 拿回来的新状态重画(先解锁再重画)。 */
    async function act(fn: () => Promise<MinecraftAccessState>, working: string): Promise<void> {
      msg.say(working);
      const lock = ui.disable(btnAdd, btnApply);
      let next: MinecraftAccessState | null = null;
      try {
        next = await fn();
      } catch (err) {
        if (!ctx.signal.aborted) msg.say(T.opFailed(errText(err)), true);
      } finally {
        lock.dispose();
      }
      if (next) render(next);
    }

    btnAdd.addEventListener('click', () => {
      const name = addName.value.trim();
      if (!name) {
        msg.say(A.needName, true);
        return;
      }
      void act(async () => {
        const next = await ctx.invoke<MinecraftAccessState>('setOp', [name, true]);
        addName.value = '';
        return next;
      }, A.granting);
    }, { signal: ctx.signal });

    btnApply.addEventListener('click', () => {
      if (cur?.live) {
        msg.say(A.stopFirst, true);
        return;
      }
      void act(() => ctx.invoke<MinecraftAccessState>('apply', [{
        opPermissionLevel: Number(levelSel.value),
        enableCommandBlock: cmdBlockIn.checked,
        allowFlight: flightIn.checked,
        onlineMode: onlineIn.checked,
        whiteList: whiteIn.checked,
      }]), T.applying);
    }, { signal: ctx.signal });

    void refresh();
  },
};
