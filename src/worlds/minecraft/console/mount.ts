/**
 * 挂载面板聚合游戏服务器、观察者客户端和玩家客户端的独立控制面。
 * 方法前缀标识控制面；就绪轮询随面板卸载结束。服务器那一行按连接方式分两套按钮:
 * 本地托管启停受管服务器并连带 bot 连接;外部服务器只连接、断开、重连 bot。
 */

import type {
  ConsoleKvRow,
  ConsolePanelContext,
  ConsolePanel,
} from '../../../web/shared/client-panel.ts';
import {
  errText,
  msgLine,
  type MinecraftClientState,
  type MinecraftMsgLine,
  type MinecraftServerState,
} from './client.ts';
import { text, type MinecraftPanelText } from './strings.ts';

type Text = MinecraftPanelText;

/** 世界生成 / 权重加载 / 客户端起窗口要几十秒到几分钟,轮到不再是 starting 为止。 */
const READY_TICKS = 90;
const READY_TICK_MS = 2000;
/** 外部服务器的连接状态会自己变(进入世界、被踢、重连),面板开着时按这个间隔刷新。 */
const LINK_POLL_MS = 5000;

/** 三条链路在服务端的方法前缀。 */
type Lane = 'server' | 'client' | 'player';

/** 启停两颗钮认得的最小状态形状;`reachable` 与 `windowReady` 各链路只有一个。 */
interface LaneState {
  phase: string;
  detail: string | null;
  pid: number | null;
  reachable?: boolean;
  windowReady?: boolean;
}

/** 就绪判据:有端口的看端口,没端口的(客户端)看窗口。 */
function isUp(st: LaneState): boolean {
  return st.reachable !== undefined ? st.reachable : st.windowReady === true;
}

/**
 * 等待收尾的判据,null = 还要等。外部服务器只认 bot 进入世界;第一次失败就带着原因
 * 收尾,不陪自动重连等下去。
 */
function settle(T: Text, lane: Lane, name: string, st: LaneState): string | null {
  const srv = st as MinecraftServerState;
  if (lane === 'server' && srv.mode === 'external') {
    if (srv.link.phase === 'online') return T.mount.botInWorld;
    // 新一次尝试开始后上一次的原因还留着,只有等待重连时它才是这一次的结果
    if (srv.link.phase === 'retrying' && srv.link.failure) return `${T.failed} ${srv.link.failure}`;
    if (srv.link.phase === 'stopped') return `${T.failed} ${T.mount.linkNotOpen}`;
    return null;
  }
  if (st.phase === 'starting') return null;
  return isUp(st) ? T.mount.ready(name) : `${T.failed} ${name} ${st.detail || st.phase}`;
}

// ---------------------------------------------------------------------------
// 挂载行
// ---------------------------------------------------------------------------

type Tone = 'on' | 'warn' | 'off' | 'plain';

interface MountRow {
  el: HTMLDivElement;
  name: HTMLSpanElement;
  /** 右侧动作区,启停两颗钮塞这儿 */
  acts: HTMLSpanElement;
  set(tone: Tone, word: string, note?: string | null): void;
}

/** 一条链路一行（.mountrow：圆点、名字、状态词、细节、动作区）。 */
function mountRow(ctx: ConsolePanelContext, label: string): MountRow {
  const { ui } = ctx;
  const el = ui.h('div', 'mountrow');
  const dot = ui.h('span', 'navdot');
  const name = ui.h('span', 'mname', label);
  const state = ui.h('span', 'mstate', '—');
  const detail = ui.h('span', 'mdetail');
  const acts = ui.h('span', 'macts');
  el.append(dot, name, state, detail, acts);
  return {
    el,
    name,
    acts,
    set(tone, word, note) {
      dot.className = `navdot${tone === 'on' ? ' on' : tone === 'warn' ? ' warn' : tone === 'off' ? ' bad' : ''}`;
      state.className = `mstate mc-${tone}`;
      state.textContent = word;
      detail.textContent = note ?? '';
      detail.title = note ?? '';
    },
  };
}

/** 一条链路的三件套:行 + 启 + 停。 */
interface LaneView {
  row: MountRow;
  start: HTMLButtonElement;
  stop: HTMLButtonElement;
}

function laneView(ctx: ConsolePanelContext, T: Text, name: string): LaneView {
  const row = mountRow(ctx, name);
  const stop = ctx.ui.button(T.mount.stop, { size: 'sm', variant: 'danger' });
  const start = ctx.ui.button(T.mount.start, { size: 'sm', variant: 'primary' });
  row.acts.append(stop, start);
  return { row, start, stop };
}

/** 两行共用的渲染:reachable 时不管托管 phase 一律亮绿(外部起的也算就绪)。 */
function renderMount<S extends LaneState>(
  T: Text,
  view: LaneView,
  st: S | null,
  extra: (st: S) => string,
): void {
  if (!st) {
    view.row.set('plain', T.mount.unavailable, '');
    view.start.disabled = true;
    view.stop.disabled = true;
    return;
  }
  let tone: Tone;
  let word: string;
  if (isUp(st)) {
    tone = 'on';
    word = st.pid ? T.mount.running : T.mount.runningExternal;
  } else {
    tone = st.phase === 'starting' ? 'warn' : 'off';
    word = T.mount.phases[st.phase] ?? st.phase;
  }
  view.row.set(tone, word, extra(st));
  view.start.disabled = st.phase === 'starting' || isUp(st);
  view.stop.disabled = st.pid === null && !['starting', 'running'].includes(st.phase);
}

/** 服务器行下面的明细:目标、端口与 bot 的连接各占一行,失败原因与待采用的目标有才出现。 */
function linkRows(ctx: ConsolePanelContext, T: Text, st: MinecraftServerState): ConsoleKvRow[] {
  const { ui } = ctx;
  const M = T.mount;
  const external = st.mode === 'external';
  const link = st.link;
  const rows: ConsoleKvRow[] = [];
  if (external) {
    rows.push(
      { k: M.target, v: `${link.username}@${link.target}(${link.version})` },
      { k: M.port, v: ui.pill(st.reachable ? M.reachable : M.unreachable, st.reachable ? 'on' : 'off') },
    );
  }
  const word = link.phase === 'retrying' && link.attempt > 0
    ? M.retryingN(link.attempt)
    : M.linkWords[link.phase] ?? link.phase;
  rows.push({ k: 'bot', v: ui.pill(word, link.phase === 'online' ? 'on' : link.phase === 'stopped' ? 'plain' : 'off') });
  if (link.failure) rows.push({ k: M.reason, v: link.failure });
  if (st.pending) rows.push({ k: M.pending, v: M.pendingValue(st.pending, external) });
  return rows;
}

// ---------------------------------------------------------------------------

export const mountPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const { ui, root } = ctx;
    const T = text(ctx.language);
    const M = T.mount;
    const card = ui.sheet({ title: M.title, en: 'bring-up', desc: M.desc });

    const msg = msgLine(ctx, 'grow');
    const btnAll = ui.button(M.mountAll, { variant: 'primary' });
    const btnRefresh = ui.button(M.refresh, { size: 'sm' });
    const bar = ui.rowbar();
    bar.append(btnAll, msg.el, btnRefresh);
    card.body.appendChild(bar);

    const modeSeg = ui.segmented(
      [{ value: 'local', label: M.modeLocal }, { value: 'external', label: M.modeExternal }],
      { size: 'sm', onSelect: (v) => { void chooseMode(v); } },
    );
    const modeNote = ui.h('span', 'grow');
    const modeBar = ui.rowbar();
    modeBar.append(ui.h('span', null, M.mode), modeSeg.el, modeNote);

    const srv = laneView(ctx, T, M.gameServer);
    const cli = laneView(ctx, T, M.spectatorClient);
    const ply = laneView(ctx, T, M.playerClient);
    const pickServer = ui.button(M.chooseDir, { size: 'sm' });
    const pickClient = ui.button(M.chooseDir, { size: 'sm' });
    const pickPlayer = ui.button(M.chooseDir, { size: 'sm' });
    srv.row.acts.prepend(pickServer);
    cli.row.acts.prepend(pickClient);
    ply.row.acts.prepend(pickPlayer);
    // 外部服务器那套按钮与本地托管的启停共处一行,按连接方式只显示一套
    const extStop = ui.button(M.disconnect, { size: 'sm', variant: 'danger' });
    const extRelink = ui.button(M.reconnect, { size: 'sm' });
    const extStart = ui.button(M.connect, { size: 'sm', variant: 'primary' });
    srv.row.acts.append(extStop, extRelink, extStart);
    const linkBox = ui.h('div');
    // 传送是这一行独有的动作:自动那次挂在"进服"那一刻上,中途死了、退回主菜单
    // 再进都够不着它
    const btnTp = ui.button(M.teleport, { size: 'sm' });
    ply.row.acts.prepend(btnTp);
    card.body.append(modeBar, srv.row.el, linkBox, cli.row.el, ply.row.el);
    root.appendChild(card.el);

    const alive = (): boolean => !ctx.signal.aborted;
    let serverState: MinecraftServerState | null = null;
    let clientState: MinecraftClientState | null = null;
    let playerState: MinecraftClientState | null = null;

    // ---- 三条链路各自的渲染 ----

    const showFor = (external: boolean): void => {
      for (const b of [srv.start, srv.stop, pickServer]) b.style.display = external ? 'none' : '';
      for (const b of [extStart, extStop, extRelink]) b.style.display = external ? '' : 'none';
      srv.row.name.textContent = external ? M.externalServer : M.gameServer;
    };

    const renderExternal = (st: MinecraftServerState): void => {
      const l = st.link;
      const tone: Tone = !st.wanted ? 'off' : l.phase === 'online' ? 'on' : l.phase === 'stopped' ? 'plain' : 'warn';
      const word = !st.wanted ? M.disconnected : l.phase === 'stopped' ? M.notStarted : M.linkWords[l.phase] ?? l.phase;
      srv.row.set(tone, word, null);
      extStart.disabled = st.wanted && l.phase !== 'stopped';
      extStop.disabled = !st.wanted;
      extRelink.disabled = false;
    };

    const renderSrv = (st: MinecraftServerState | null): void => {
      if (!alive()) return;
      serverState = st;
      const external = st?.mode === 'external';
      showFor(external);
      if (st) modeSeg.setValue(st.mode);
      modeNote.textContent = st?.modeInferred ? M.modeInferred : '';
      linkBox.replaceChildren(...(st ? [ui.kv(linkRows(ctx, T, st))] : []));
      if (st && external) { renderExternal(st); return; }
      if (st && !st.configured && st.phase === 'stopped' && !st.reachable) {
        srv.row.set('warn', M.unconfigured, M.serverUnconfigured);
        srv.start.disabled = false;
        srv.stop.disabled = true;
        return;
      }
      renderMount(T, srv, st, (s) =>
        [s.pid ? `pid ${s.pid}` : null, s.address, s.wanted ? null : M.botNotConnected, s.detail]
          .filter(Boolean).join(' · '));
      // 端口可连而 bot 不以它为目标时(外部起的服务器),启动只让 bot 连上去
      if (st && !st.wanted && st.phase !== 'starting') srv.start.disabled = false;
    };

    /** 客户端没有可探的端口,判据是"窗口出来了没"。 */
    const renderCli = (st: MinecraftClientState | null): void => {
      if (!alive()) return;
      clientState = st;
      if (!st) { renderMount<LaneState>(T, cli, null, () => ''); return; }
      if (!st.configured) {
        cli.row.set('warn', M.unconfigured, st.detail || M.clientUnconfigured);
        cli.start.disabled = true;
        cli.stop.disabled = st.pid === null;
        return;
      }
      // 客户端那条的就绪判据是窗口,补一个 reachable 让三行走同一份渲染
      const merged: MinecraftClientState & { reachable: boolean } = { ...st, reachable: st.windowReady };
      renderMount(T, cli, merged, (c) => [
        c.pid ? `pid ${c.pid}` : null,
        c.versionId,
        c.username,
        c.enabled ? null : M.disabledManual,
        c.detail,
      ].filter(Boolean).join(' · '));
    };

    /** 玩家那条与摄像机同一套判据(窗口出来了没)。 */
    const renderPly = (st: MinecraftClientState | null): void => {
      if (!alive()) return;
      playerState = st;
      if (!st) { renderMount<LaneState>(T, ply, null, () => ''); btnTp.disabled = true; return; }
      btnTp.disabled = !st.windowReady;
      if (!st.configured) {
        ply.row.set('warn', M.unconfigured, st.detail || M.playerUnconfigured);
        ply.start.disabled = true;
        ply.stop.disabled = st.pid === null;
        return;
      }
      const merged: MinecraftClientState & { reachable: boolean } = { ...st, reachable: st.windowReady };
      renderMount(T, ply, merged, (c) => [
        c.pid ? `pid ${c.pid}` : null,
        c.versionId,
        c.username,
        c.enabled ? null : M.disabledManual,
        c.detail,
      ].filter(Boolean).join(' · '));
    };

    // ---- 取数 ----

    const fetchSrv = (): Promise<MinecraftServerState | null> =>
      ctx.invoke<MinecraftServerState>('server.state').then(
        (st) => { renderSrv(st); return st; },
        () => { renderSrv(null); return null; },
      );
    const fetchCli = (): Promise<MinecraftClientState | null> =>
      ctx.invoke<MinecraftClientState>('client.state').then(
        (st) => { renderCli(st); return st; },
        () => { renderCli(null); return null; },
      );
    const fetchPly = (): Promise<MinecraftClientState | null> =>
      ctx.invoke<MinecraftClientState>('player.state').then(
        (st) => { renderPly(st); return st; },
        () => { renderPly(null); return null; },
      );
    const refresh = (): Promise<unknown> =>
      Promise.all([fetchSrv(), fetchCli(), fetchPly()]);
    const refreshServerAfterPath = async (): Promise<void> => {
      const needsRestart = serverState !== null && (serverState.pid !== null || serverState.reachable);
      await fetchSrv();
      if (needsRestart) msg.say(M.serverPathSaved);
    };
    const refreshClientAfterPath = async (
      state: MinecraftClientState | null,
      fetchState: () => Promise<MinecraftClientState | null>,
      name: string,
    ): Promise<void> => {
      const needsRestart = state !== null && (state.pid !== null || state.windowReady);
      await fetchState();
      if (needsRestart) msg.say(M.clientPathSaved(name));
    };

    let polling = false;
    ctx.interval(() => {
      if (polling || serverState?.mode !== 'external') return;
      polling = true;
      void fetchSrv().finally(() => { polling = false; });
    }, LINK_POLL_MS);

    /** 切换连接方式:bot 断开当前连接,托管着的服务器停下,之后由操作员重新启动或连接。 */
    async function chooseMode(mode: string): Promise<void> {
      const st = serverState;
      if (st && (st.wanted || st.pid !== null)) {
        const ok = await ui.confirm({
          title: M.switchTitle,
          body: M.switchBody(st.pid !== null),
          danger: true,
        });
        if (!alive()) return;
        if (!ok) { modeSeg.setValue(st.mode); return; }
      }
      try {
        await ctx.setConfig('world:minecraft', { 'worlds.minecraft.serverMode': mode });
        msg.say(mode === 'external' ? M.switchedExternal : M.switchedLocal);
      } catch (err) {
        if (alive()) msg.say(M.switchFailed(errText(err)), true);
      }
      await fetchSrv();
    }

    const choose = async (
      button: HTMLButtonElement,
      options: Parameters<ConsolePanelContext['pickPath']>[0],
      groupId: string,
      key: string,
      after: () => Promise<unknown>,
    ): Promise<void> => {
      const lock = ui.disable(button);
      try {
        const path = await ctx.pickPath(options);
        if (!path || !alive()) return;
        await ctx.setConfig(groupId, { [key]: path });
        msg.say(M.saved(path));
        await after();
      } catch (err) {
        if (alive()) msg.say(M.pathSaveFailed(errText(err)), true);
      } finally {
        lock.dispose();
      }
    };

    pickServer.addEventListener('click', () => {
      void choose(pickServer, {
        kind: 'directory', title: M.pickServer,
        ...(serverState?.serverDir ? { currentPath: serverState.serverDir } : {}),
        recommendedDir: '../Cortico-Resources/minecraft/server',
      }, 'world:minecraft', 'worlds.minecraft.local.serverDir', refreshServerAfterPath);
    }, { signal: ctx.signal });
    pickClient.addEventListener('click', () => {
      void choose(pickClient, {
        kind: 'directory', title: M.pickClient,
        ...(clientState?.gameDir ? { currentPath: clientState.gameDir } : {}),
        recommendedDir: '../Cortico-Resources/minecraft/client',
      }, 'world:minecraft:client', 'worlds.minecraft.client.gameDir',
      () => refreshClientAfterPath(clientState, fetchCli, M.spectatorClient));
    }, { signal: ctx.signal });
    pickPlayer.addEventListener('click', () => {
      void choose(pickPlayer, {
        kind: 'directory', title: M.pickPlayer,
        ...(playerState?.gameDir ? { currentPath: playerState.gameDir } : {}),
        recommendedDir: '../Cortico-Resources/minecraft/client-player',
      }, 'world:minecraft:player', 'worlds.minecraft.player.gameDir',
      () => refreshClientAfterPath(playerState, fetchPly, M.playerClient));
    }, { signal: ctx.signal });

    // ---- 启停 ----

    const render = (lane: Lane, st: LaneState | null): void => {
      if (lane === 'server') renderSrv(st as MinecraftServerState | null);
      else if (lane === 'player') renderPly(st as MinecraftClientState | null);
      else renderCli(st as MinecraftClientState | null);
    };

    /**
     * 等一条链路收尾(见 `settle`)。轮询走 `ctx.interval`,面板一卸载就停;
     * 等待的 promise 由 `signal` 一并收束,不会永挂在那儿。
     */
    const waitReady = (lane: Lane, name: string): Promise<string> =>
      new Promise<string>((resolve) => {
        let ticks = 0;
        let probing = false;
        const done = (note: string): void => { timer.dispose(); resolve(note); };
        const timer = ctx.interval(() => {
          if (probing) return;
          if (++ticks > READY_TICKS) { done(`${T.failed} ${M.startTimedOut(name)}`); return; }
          probing = true;
          void ctx.invoke<LaneState>(`${lane}.state`).then(
            (st) => {
              render(lane, st);
              const note = settle(T, lane, name, st);
              if (note === null) { probing = false; return; }
              done(note);
            },
            (err: unknown) => { done(`${T.failed} ${name} ${errText(err)}`); },
          );
        }, READY_TICK_MS);
        ctx.signal.addEventListener('abort', () => resolve(M.waitAborted(name)), { once: true });
      });

    /** `method` 之后等这条链路收尾;`method` 是 start 或 reconnect。 */
    const runAndWait = async (lane: Lane, name: string, method: string, note: string): Promise<void> => {
      msg.say(note);
      try {
        const st = await ctx.invoke<LaneState>(`${lane}.${method}`);
        render(lane, st);
        if (st.phase === 'error') { msg.say(`${T.failed} ${name} ${st.detail || ''}`, true); return; }
        const result = await waitReady(lane, name);
        msg.say(result, result.startsWith(T.failed));
      } catch (err) {
        if (alive()) msg.say(M.startFailed(errText(err)), true);
      }
    };

    const runStop = async (lane: Lane, name: string, doneNote: string): Promise<void> => {
      msg.say('');
      try {
        render(lane, await ctx.invoke<LaneState>(`${lane}.stop`));
        msg.say(doneNote);
      } catch (err) {
        if (alive()) msg.say(M.stopFailed(errText(err)), true);
      }
    };

    const bindStartStop = (lane: Lane, name: string, view: LaneView, startNote: string): void => {
      view.start.addEventListener('click', () => { void runAndWait(lane, name, 'start', startNote); }, { signal: ctx.signal });
      view.stop.addEventListener('click', () => { void runStop(lane, name, M.laneStopped(name)); }, { signal: ctx.signal });
    };

    bindStartStop('server', M.serverName, srv, M.startingServer);
    bindStartStop('client', M.clientName, cli, M.startingClient);
    bindStartStop('player', M.playerClient, ply, M.startingClient);
    extStart.addEventListener('click', () => { void runAndWait('server', M.externalServer, 'start', M.connecting); },
      { signal: ctx.signal });
    extRelink.addEventListener('click', () => { void runAndWait('server', M.externalServer, 'reconnect', M.reconnecting); },
      { signal: ctx.signal });
    extStop.addEventListener('click', () => { void runStop('server', M.externalServer, M.disconnectedNoRetry); },
      { signal: ctx.signal });

    btnTp.addEventListener('click', () => {
      void ctx.invoke<MinecraftClientState>('player.teleport').then(
        (st) => { msg.say(st.detail ?? ''); renderPly(st); },
        (err: unknown) => { if (alive()) msg.say(M.teleportFailed(errText(err)), true); },
      );
    }, { signal: ctx.signal });

    btnRefresh.addEventListener('click', () => { msg.say(''); void refresh(); }, { signal: ctx.signal });
    btnAll.addEventListener('click', () => { void mountAll(ctx, T, msg, btnAll, render, refresh, waitReady); },
      { signal: ctx.signal });

    void refresh();
  },
};

// ---------------------------------------------------------------------------
// 一键挂载
// ---------------------------------------------------------------------------

/**
 * 三条链路一起带起来。已经在跑的不重复启动;**两份客户端都很重,配置里没开就
 * 不替人做主**,只带起已声明要用的那几条。
 */
async function mountAll(
  ctx: ConsolePanelContext,
  T: Text,
  msg: MinecraftMsgLine,
  btnAll: HTMLButtonElement,
  render: (lane: Lane, st: LaneState | null) => void,
  refresh: () => Promise<unknown>,
  waitReady: (lane: Lane, name: string) => Promise<string>,
): Promise<void> {
  const M = T.mount;
  const lock = ctx.ui.disable(btnAll);
  msg.say(M.mounting);
  try {
    const jobs: Array<Promise<string>> = [];
    const bring = async (lane: Lane, name: string, upNote: string | null): Promise<string> => {
      if (upNote) return upNote;
      const st = await ctx.invoke<LaneState>(`${lane}.start`);
      render(lane, st);
      if (st.phase === 'error') return `${T.failed} ${name} ${st.detail || ''}`;
      return waitReady(lane, name);
    };

    const srv = await ctx.invoke<MinecraftServerState>('server.state');
    if (srv.mode === 'external') {
      jobs.push(bring('server', M.externalServer, srv.link.phase === 'online' ? M.botInWorld : null));
    } else {
      jobs.push(bring('server', M.serverName, srv.reachable && srv.wanted ? M.serverRunning : null));
    }
    const cli = await ctx.invoke<MinecraftClientState>('client.state').catch(() => null);
    if (cli && cli.enabled && cli.configured) {
      jobs.push(bring('client', M.clientName, cli.windowReady ? M.clientRunning : null));
    }
    const ply = await ctx.invoke<MinecraftClientState>('player.state').catch(() => null);
    if (ply && ply.enabled && ply.configured) {
      jobs.push(bring('player', M.playerClient, ply.windowReady ? M.playerRunning : null));
    }

    const notes = await Promise.all(jobs);
    await refresh();
    if (!ctx.signal.aborted) msg.say(notes.join(' · '), notes.some((n) => n.startsWith(T.failed)));
  } catch (err) {
    if (!ctx.signal.aborted) msg.say(M.mountFailed(errText(err)), true);
  } finally {
    lock.dispose();
  }
}
