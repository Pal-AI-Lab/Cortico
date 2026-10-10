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

const DESC =
  '本地托管:本 World 启停服务器目录里的 server.jar,bot 随之连接。'
  + '外部服务器:只连接、断开 bot,不启停对方的服务器。'
  + '观察者客户端与玩家客户端可选,连同一个地址和端口:观察者客户端以观察者模式跟着 bot,'
  + '画面(含光影/模组)换成它;玩家客户端以普通玩家身份进服,进服时传送到 bot 旁边。';

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
function settle(lane: Lane, name: string, st: LaneState): string | null {
  const srv = st as MinecraftServerState;
  if (lane === 'server' && srv.mode === 'external') {
    if (srv.link.phase === 'online') return 'bot 已进入世界';
    if (srv.link.failure) return `[失败] ${srv.link.failure}`;
    if (srv.link.phase === 'stopped') return '[失败] 连接没有开启';
    return null;
  }
  if (st.phase === 'starting') return null;
  return isUp(st) ? `${name}就绪` : `[失败] ${name} ${st.detail || st.phase}`;
}

const LINK_WORDS: Record<string, string> = {
  stopped: '未连接',
  connecting: '连接中',
  online: '已进入世界',
  retrying: '等待重连',
};

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

function laneView(ctx: ConsolePanelContext, name: string): LaneView {
  const row = mountRow(ctx, name);
  const stop = ctx.ui.button('停止', { size: 'sm', variant: 'danger' });
  const start = ctx.ui.button('启动', { size: 'sm', variant: 'primary' });
  row.acts.append(stop, start);
  return { row, start, stop };
}

/** 两行共用的渲染:reachable 时不管托管 phase 一律亮绿(外部起的也算就绪)。 */
function renderMount<T extends LaneState>(
  view: LaneView,
  st: T | null,
  extra: (st: T) => string,
): void {
  if (!st) {
    view.row.set('plain', '不可用', '');
    view.start.disabled = true;
    view.stop.disabled = true;
    return;
  }
  let tone: Tone;
  let word: string;
  if (isUp(st)) {
    tone = 'on';
    word = st.pid ? '运行中' : '运行中(外部)';
  } else {
    tone = st.phase === 'starting' ? 'warn' : 'off';
    word = ({ starting: '启动中', error: '异常', stopped: '未启动' } as Record<string, string>)[st.phase]
      ?? st.phase;
  }
  view.row.set(tone, word, extra(st));
  view.start.disabled = st.phase === 'starting' || isUp(st);
  view.stop.disabled = st.pid === null && !['starting', 'running'].includes(st.phase);
}

/** 服务器行下面的明细:目标、端口与 bot 的连接各占一行,失败原因与待采用的目标有才出现。 */
function linkRows(ctx: ConsolePanelContext, st: MinecraftServerState): ConsoleKvRow[] {
  const { ui } = ctx;
  const external = st.mode === 'external';
  const link = st.link;
  const rows: ConsoleKvRow[] = [];
  if (external) {
    rows.push(
      { k: '目标', v: `${link.username}@${link.target}(${link.version})` },
      { k: '端口', v: ui.pill(st.reachable ? '可连接' : '连不上', st.reachable ? 'on' : 'off') },
    );
  }
  const word = link.phase === 'retrying' && link.attempt > 0
    ? `等待重连(已连续失败 ${link.attempt} 次)`
    : LINK_WORDS[link.phase] ?? link.phase;
  rows.push({ k: 'bot', v: ui.pill(word, link.phase === 'online' ? 'on' : link.phase === 'stopped' ? 'plain' : 'off') });
  if (link.failure) rows.push({ k: '原因', v: link.failure });
  if (st.pending) {
    rows.push({
      k: '待采用',
      v: `${st.pending};${external ? '点「重连」后采用' : '停止并重新启动服务器后采用'}`,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------

export const mountPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const { ui, root } = ctx;
    const card = ui.sheet({ title: '挂载', en: 'bring-up', desc: DESC });

    const msg = msgLine(ctx, 'grow');
    const btnAll = ui.button('⏻ 一键挂载', { variant: 'primary' });
    const btnRefresh = ui.button('刷新', { size: 'sm' });
    const bar = ui.rowbar();
    bar.append(btnAll, msg.el, btnRefresh);
    card.body.appendChild(bar);

    const modeSeg = ui.segmented(
      [{ value: 'local', label: '本地托管' }, { value: 'external', label: '外部服务器' }],
      { size: 'sm', onSelect: (v) => { void chooseMode(v); } },
    );
    const modeNote = ui.h('span', 'grow');
    const modeBar = ui.rowbar();
    modeBar.append(ui.h('span', null, '连接方式'), modeSeg.el, modeNote);

    const srv = laneView(ctx, '游戏服务器');
    const cli = laneView(ctx, '观察者客户端');
    const ply = laneView(ctx, '玩家客户端');
    const pickServer = ui.button('选择目录…', { size: 'sm' });
    const pickClient = ui.button('选择目录…', { size: 'sm' });
    const pickPlayer = ui.button('选择目录…', { size: 'sm' });
    srv.row.acts.prepend(pickServer);
    cli.row.acts.prepend(pickClient);
    ply.row.acts.prepend(pickPlayer);
    // 外部服务器那套按钮与本地托管的启停共处一行,按连接方式只显示一套
    const extStop = ui.button('断开', { size: 'sm', variant: 'danger' });
    const extRelink = ui.button('重连', { size: 'sm' });
    const extStart = ui.button('连接', { size: 'sm', variant: 'primary' });
    srv.row.acts.append(extStop, extRelink, extStart);
    const linkBox = ui.h('div');
    // 传送是这一行独有的动作:自动那次挂在"进服"那一刻上,中途死了、退回主菜单
    // 再进都够不着它
    const btnTp = ui.button('传送到她旁边', { size: 'sm' });
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
      srv.row.name.textContent = external ? '外部服务器' : '游戏服务器';
    };

    const renderExternal = (st: MinecraftServerState): void => {
      const l = st.link;
      const tone: Tone = !st.wanted ? 'off' : l.phase === 'online' ? 'on' : l.phase === 'stopped' ? 'plain' : 'warn';
      const word = !st.wanted ? '已断开' : l.phase === 'stopped' ? '未启动' : LINK_WORDS[l.phase] ?? l.phase;
      srv.row.set(tone, word, `${l.username}@${l.target}`);
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
      modeNote.textContent = st?.modeInferred ? '按是否填了本地服务器目录推定' : '';
      linkBox.replaceChildren(...(st ? [ui.kv(linkRows(ctx, st))] : []));
      if (st && external) { renderExternal(st); return; }
      if (st && !st.configured && st.phase === 'stopped' && !st.reachable) {
        srv.row.set('warn', '未配置', '在本 World 配置里填 worlds.minecraft.local.serverDir(含 server.jar 的目录)');
        srv.start.disabled = false;
        srv.stop.disabled = true;
        return;
      }
      renderMount(srv, st, (s) =>
        [s.pid ? `pid ${s.pid}` : null, s.address, s.wanted ? null : 'bot 未连接', s.detail]
          .filter(Boolean).join(' · '));
      // 端口可连而 bot 不以它为目标时(外部起的服务器),启动只让 bot 连上去
      if (st && !st.wanted && st.phase !== 'starting') srv.start.disabled = false;
    };

    /** 客户端没有可探的端口,判据是"窗口出来了没"。 */
    const renderCli = (st: MinecraftClientState | null): void => {
      if (!alive()) return;
      clientState = st;
      if (!st) { renderMount<LaneState>(cli, null, () => ''); return; }
      if (!st.configured) {
        cli.row.set('warn', '未配置', st.detail || '在配置里填 worlds.minecraft.client.gameDir');
        cli.start.disabled = true;
        cli.stop.disabled = st.pid === null;
        return;
      }
      // 客户端那条的就绪判据是窗口,补一个 reachable 让三行走同一份渲染
      const merged: MinecraftClientState & { reachable: boolean } = { ...st, reachable: st.windowReady };
      renderMount(cli, merged, (c) => [
        c.pid ? `pid ${c.pid}` : null,
        c.versionId,
        c.username,
        c.enabled ? null : '配置未启用(可手动启停)',
        c.detail,
      ].filter(Boolean).join(' · '));
    };

    /** 玩家那条与摄像机同一套判据(窗口出来了没)。 */
    const renderPly = (st: MinecraftClientState | null): void => {
      if (!alive()) return;
      playerState = st;
      if (!st) { renderMount<LaneState>(ply, null, () => ''); btnTp.disabled = true; return; }
      btnTp.disabled = !st.windowReady;
      if (!st.configured) {
        ply.row.set('warn', '未配置', st.detail || '在配置里填 worlds.minecraft.player.gameDir(或先配好观察者客户端那份)');
        ply.start.disabled = true;
        ply.stop.disabled = st.pid === null;
        return;
      }
      const merged: MinecraftClientState & { reachable: boolean } = { ...st, reachable: st.windowReady };
      renderMount(ply, merged, (c) => [
        c.pid ? `pid ${c.pid}` : null,
        c.versionId,
        c.username,
        c.enabled ? null : '配置未启用(可手动启停)',
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
      if (needsRestart) msg.say('路径已保存；停止并重新启动游戏服务器后采用新目录');
    };
    const refreshClientAfterPath = async (
      state: MinecraftClientState | null,
      fetchState: () => Promise<MinecraftClientState | null>,
      name: string,
    ): Promise<void> => {
      const needsRestart = state !== null && (state.pid !== null || state.windowReady);
      await fetchState();
      if (needsRestart) msg.say(`路径已保存；停止并重新启动${name}后采用新目录`);
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
          title: '切换连接方式',
          body: `bot 会断开当前连接${st.pid !== null ? ',本 World 托管的服务器会停止' : ''}。切换后在这里重新启动或连接。`,
          danger: true,
        });
        if (!alive()) return;
        if (!ok) { modeSeg.setValue(st.mode); return; }
      }
      try {
        await ctx.setConfig('world:minecraft', { 'worlds.minecraft.serverMode': mode });
        msg.say(mode === 'external' ? '已切换为外部服务器' : '已切换为本地托管');
      } catch (err) {
        if (alive()) msg.say(`切换失败: ${errText(err)}`, true);
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
        msg.say(`已保存: ${path}`);
        await after();
      } catch (err) {
        if (alive()) msg.say(`路径保存失败: ${errText(err)}`, true);
      } finally {
        lock.dispose();
      }
    };

    pickServer.addEventListener('click', () => {
      void choose(pickServer, {
        kind: 'directory', title: '选择 Minecraft 服务器目录',
        ...(serverState?.serverDir ? { currentPath: serverState.serverDir } : {}),
        recommendedDir: '../Cortico-Resources/minecraft/server',
      }, 'world:minecraft', 'worlds.minecraft.local.serverDir', refreshServerAfterPath);
    }, { signal: ctx.signal });
    pickClient.addEventListener('click', () => {
      void choose(pickClient, {
        kind: 'directory', title: '选择观察者 Minecraft 客户端目录',
        ...(clientState?.gameDir ? { currentPath: clientState.gameDir } : {}),
        recommendedDir: '../Cortico-Resources/minecraft/client',
      }, 'world:minecraft:client', 'worlds.minecraft.client.gameDir',
      () => refreshClientAfterPath(clientState, fetchCli, '观察者客户端'));
    }, { signal: ctx.signal });
    pickPlayer.addEventListener('click', () => {
      void choose(pickPlayer, {
        kind: 'directory', title: '选择玩家 Minecraft 客户端目录',
        ...(playerState?.gameDir ? { currentPath: playerState.gameDir } : {}),
        recommendedDir: '../Cortico-Resources/minecraft/client-player',
      }, 'world:minecraft:player', 'worlds.minecraft.player.gameDir',
      () => refreshClientAfterPath(playerState, fetchPly, '玩家客户端'));
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
          if (++ticks > READY_TICKS) { done(`[失败] ${name} 启动超时`); return; }
          probing = true;
          void ctx.invoke<LaneState>(`${lane}.state`).then(
            (st) => {
              render(lane, st);
              const note = settle(lane, name, st);
              if (note === null) { probing = false; return; }
              done(note);
            },
            (err: unknown) => { done(`[失败] ${name} ${errText(err)}`); },
          );
        }, READY_TICK_MS);
        ctx.signal.addEventListener('abort', () => resolve(`${name}等待已中断`), { once: true });
      });

    /** `method` 之后等这条链路收尾;`method` 是 start 或 reconnect。 */
    const runAndWait = async (lane: Lane, name: string, method: string, note: string): Promise<void> => {
      msg.say(note);
      try {
        const st = await ctx.invoke<LaneState>(`${lane}.${method}`);
        render(lane, st);
        if (st.phase === 'error') { msg.say(`[失败] ${name} ${st.detail || ''}`, true); return; }
        const result = await waitReady(lane, name);
        msg.say(result, result.startsWith('[失败]'));
      } catch (err) {
        if (alive()) msg.say(`启动失败: ${errText(err)}`, true);
      }
    };

    const runStop = async (lane: Lane, name: string, doneNote: string): Promise<void> => {
      msg.say('');
      try {
        render(lane, await ctx.invoke<LaneState>(`${lane}.stop`));
        msg.say(doneNote);
      } catch (err) {
        if (alive()) msg.say(`停止失败: ${errText(err)}`, true);
      }
    };

    const bindStartStop = (lane: Lane, name: string, view: LaneView, startNote: string): void => {
      view.start.addEventListener('click', () => { void runAndWait(lane, name, 'start', startNote); }, { signal: ctx.signal });
      view.stop.addEventListener('click', () => { void runStop(lane, name, `${name}已停止`); }, { signal: ctx.signal });
    };

    bindStartStop('server', '服务器', srv, '启动中…(要加载世界)');
    bindStartStop('client', '客户端', cli, '启动中…(真客户端,要加载资源与着色器)');
    bindStartStop('player', '玩家客户端', ply, '启动中…(真客户端,要加载资源与着色器)');
    extStart.addEventListener('click', () => { void runAndWait('server', '外部服务器', 'start', '连接中…'); },
      { signal: ctx.signal });
    extRelink.addEventListener('click', () => { void runAndWait('server', '外部服务器', 'reconnect', '重新连接中…'); },
      { signal: ctx.signal });
    extStop.addEventListener('click', () => { void runStop('server', '外部服务器', '已断开,不再自动重连'); },
      { signal: ctx.signal });

    btnTp.addEventListener('click', () => {
      void ctx.invoke<MinecraftClientState>('player.teleport').then(
        (st) => { msg.say(st.detail ?? ''); renderPly(st); },
        (err: unknown) => { if (alive()) msg.say(`传送失败: ${errText(err)}`, true); },
      );
    }, { signal: ctx.signal });

    btnRefresh.addEventListener('click', () => { msg.say(''); void refresh(); }, { signal: ctx.signal });
    btnAll.addEventListener('click', () => { void mountAll(ctx, msg, btnAll, render, refresh, waitReady); },
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
  msg: MinecraftMsgLine,
  btnAll: HTMLButtonElement,
  render: (lane: Lane, st: LaneState | null) => void,
  refresh: () => Promise<unknown>,
  waitReady: (lane: Lane, name: string) => Promise<string>,
): Promise<void> {
  const lock = ctx.ui.disable(btnAll);
  msg.say('挂载中…');
  try {
    const jobs: Array<Promise<string>> = [];
    const bring = async (lane: Lane, name: string, upNote: string | null): Promise<string> => {
      if (upNote) return upNote;
      const st = await ctx.invoke<LaneState>(`${lane}.start`);
      render(lane, st);
      if (st.phase === 'error') return `[失败] ${name} ${st.detail || ''}`;
      return waitReady(lane, name);
    };

    const srv = await ctx.invoke<MinecraftServerState>('server.state');
    if (srv.mode === 'external') {
      jobs.push(bring('server', '外部服务器', srv.link.phase === 'online' ? 'bot 已在世界里' : null));
    } else {
      jobs.push(bring('server', '服务器', srv.reachable && srv.wanted ? '服务器已在运行' : null));
    }
    const cli = await ctx.invoke<MinecraftClientState>('client.state').catch(() => null);
    if (cli && cli.enabled && cli.configured) {
      jobs.push(bring('client', '客户端', cli.windowReady ? '客户端已在运行' : null));
    }
    const ply = await ctx.invoke<MinecraftClientState>('player.state').catch(() => null);
    if (ply && ply.enabled && ply.configured) {
      jobs.push(bring('player', '玩家客户端', ply.windowReady ? '玩家客户端已在运行' : null));
    }

    const notes = await Promise.all(jobs);
    await refresh();
    if (!ctx.signal.aborted) msg.say(notes.join(' · '), notes.some((n) => n.startsWith('[失败]')));
  } catch (err) {
    if (!ctx.signal.aborted) msg.say(`挂载失败: ${errText(err)}`, true);
  } finally {
    lock.dispose();
  }
}
