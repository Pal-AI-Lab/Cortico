import type { ContextRecord } from '../../../../protocol/open-responses/context.ts';
/**
 * 页面状态由 /ws/debug 推送，保存在挂载闭包中，随 Lifecycle 释放。
 * 调试通道不可用时改用 /ws/sessions，只接收 session 列表。
 */

import type {
  ConsoleStreamHandle,
  Disposable,
} from '../../../shared/client-panel.ts';
import { PROVIDERS_LAMP_ID, panelStreamRoute } from '../../../shared/console-protocol.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { get, post } from '../../core/api.ts';
import { openStream } from '../../core/stream.ts';
import { browserSocketEnv, openFrameworkSocket, type SocketEnv } from '../../core/websocket.ts';
import { buildCtxPanel, computeCtx, type ContextBreakdown } from './context.ts';
import { createForkView, MAIN_ID, MAIN_LABEL } from './fork.ts';
import {
  arr,
  str,
  type SessionStat,
  type StatusSnapshot,
  type ToolSchemaDoc,
} from './protocol.ts';
import { subscribeLamps } from '../../ui/lamp.ts';
import { createOnboarding, type OnboardingView } from './onboarding.ts';
import { createSessionBand } from './sessions.ts';
import { applyDisplayName, createStatusBand } from './status.ts';
import { S } from './strings.ts';
import { createTimeline } from './timeline.ts';

const DEBUG_WS_PATH = '/ws/debug';
const SESSIONS_WS_PATH = '/ws/sessions';

/** 测试注入点:不传就是真浏览器那一套。 */
export interface LiveFeatureOptions {
  env?: SocketEnv;
}

export function createLiveFeature(opts: LiveFeatureOptions = {}): FrameworkFeature {
  return {
    route: 'live',
    label: S.navLabel,
    icon: 'terminal',
    navMode: 'primary',
    // 两条通道任一挂着这一页就有意义;都没有的话导航里根本不出现它。
    needsAny: ['debug', 'sessions'],
    mount(ctx) {
      return mountLive(ctx, opts.env ?? browserSocketEnv(window));
    },
  };
}

/** 缺省实例。host 直接用这个。 */
export const liveFeature: FrameworkFeature = createLiveFeature();

function ctxRingStyle(d: ContextBreakdown | null): string {
  if (!d || !d.total || d.maxTokens === null) return '--ctx-ring:conic-gradient(var(--border) 0 100%)';
  const stops: string[] = [];
  let cursor = 0;
  for (const cat of d.cats) {
    if (cat.tok <= 0) continue;
    const next = Math.min(100, cursor + cat.tok / d.maxTokens * 100);
    if (next > cursor) stops.push(`${cat.color} ${cursor.toFixed(2)}% ${next.toFixed(2)}%`);
    cursor = next;
  }
  stops.push(`var(--border) ${cursor.toFixed(2)}% 100%`);
  return `--ctx-ring:conic-gradient(${stops.join(',')})`;
}

function mountLive(ctx: FeatureContext, env: SocketEnv): Disposable | void {
  const { ui } = ctx;
  const doc = ctx.root.ownerDocument;

  // ── 这一页的全部活数据 ────────────────────────────────────────────
  const state = {
    messages: [] as ContextRecord[],
    /** 合成开头，不写入 session 记录。 */
    head: [] as ContextRecord[],
    toolSchemas: [] as ToolSchemaDoc[],
    status: null as StatusSnapshot | null,
    sessions: [] as SessionStat[],
    displayName: '',
  };

  const view = ui.h('div', 'liveview');
  const band = ui.h('div', 'liveband');
  view.appendChild(band);
  ctx.root.appendChild(view);

  // ── 顶栏 ──────────────────────────────────────────────────────────
  const status = createStatusBand(ui);
  status.render(null);

  const timeline = createTimeline({ ui, lifecycle: ctx.lifecycle, signal: ctx.signal });

  const sessionBand = createSessionBand({
    ui,
    signal: ctx.signal,
    onPick: (id, label) => fork.switchTo(id, label),
  });

  const ctxAnchor = ui.h('span', 'ctxanchor');
  const ctxOpen = ui.h('button', 'ctxdonut');
  ctxOpen.type = 'button';
  ctxOpen.setAttribute('aria-haspopup', 'dialog');
  ctxOpen.setAttribute('aria-expanded', 'false');
  ctxOpen.setAttribute('aria-label', S.ctxOpenAria);
  const ctxPct = ui.h('span', 'ctxpct', '—');
  ctxOpen.appendChild(ctxPct);
  ctxAnchor.appendChild(ctxOpen);

  let ctxPanel: HTMLElement | null = null;
  const closeCtx = (): void => {
    ctxPanel?.remove();
    ctxPanel = null;
    ctxOpen.setAttribute('aria-expanded', 'false');
  };
  ctxOpen.addEventListener('click', () => {
    if (ctxPanel) {
      closeCtx();
      return;
    }
    ctxPanel = buildCtxPanel(
      ui,
      computeCtx({
        messages: state.messages,
        head: state.head,
        toolSchemas: state.toolSchemas,
        status: state.status,
      }),
    );
    ctxPanel.setAttribute('role', 'dialog');
    ctxPanel.setAttribute('aria-label', S.ctxPanelAria);
    ctxAnchor.appendChild(ctxPanel);
    ctxOpen.setAttribute('aria-expanded', 'true');
  }, { signal: ctx.signal });
  doc.addEventListener('pointerdown', (event) => {
    if (ctxPanel && !ctxAnchor.contains(event.target as Node)) closeCtx();
  }, { signal: ctx.signal });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCtx();
  }, { signal: ctx.signal });

  let netEl: HTMLElement = ui.pill(S.netConnecting, 'plain');
  const setNet = (online: boolean): void => {
    const next = ui.pill(online ? S.netOnline : S.netOffline, online ? 'on' : 'off');
    netEl.replaceWith(next);
    netEl = next;
  };

  const summary = ui.h('div', 'live-summary');
  summary.append(status.el, ui.h('span', 'grow'), netEl);
  band.append(summary, sessionBand.el);

  const composer = ui.promptInput({
    label: S.composerLabel,
    placeholder: S.composerPlaceholder,
    hint: S.composerHint,
    tools: ctxAnchor,
    images: { max: 8 },
    onSubmit: (text, images) => {
      if (!chatStream?.open) ui.toast(S.composerQueued);
      // 首启时运行是停着的（见 launcher）；发话与按下那颗按钮同样是让它开始跑。
      if (onboarding) {
        void resumeRun();
        spoke = true;
        syncOnboarding();
      }
      const attached = images.map((i) => ({ mime: i.mime, base64: i.base64, name: i.name }));
      chatStream?.send(JSON.stringify({ type: 'msg', text, ...(attached.length ? { images: attached } : {}) }));
      return true;
    },
  });
  view.append(timeline.el, composer.el);
  timeline.rebuild([], { empty: S.emptyConnecting });

  // 没有可用端点时说清楚要去哪儿,而不是让操作员发出一条得不到回复的消息。
  let providerReady = false;
  let providerHint = '';
  ctx.lifecycle.own(subscribeLamps(ctx.root.ownerDocument, (lamps) => {
    const lamp = lamps[PROVIDERS_LAMP_ID]?.[0];
    composer.setPlaceholder(lamp && lamp.state !== 'online' ? S.composerNoProvider : null);
    providerReady = lamp?.state === 'online';
    providerHint = lamp?.hint ?? '';
    onboarding?.setProvider(providerReady, providerHint);
  }));

  const resumeRun = (): Promise<unknown> => post('/api/run/resume', {}, { signal: ctx.signal });

  /**
   * 开场引导只在这份部署什么都还没发生时出现：事件库没有分配过游标。session 不能当判据——
   * 全新部署起来就有一条系统前缀，而上下文交接后它反倒是空的。第一条终端消息、第一次
   * terminal_send 与那颗按钮投的事件都会让游标动，这一块随之收起。
   * 调试通道没挂载时这一页只剩状态读数，引导也不出现。
   */
  let onboarding: OnboardingView | null = null;
  /** 操作员在这一页发过话就不再引导；事件计数要等下一帧状态才更新，那之前不该还挂着。 */
  let spoke = false;
  const syncOnboarding = (): void => {
    const fresh = ctx.capabilities.debug === true
      && !spoke
      && state.status !== null
      && (state.status.eventCount ?? 0) === 0;
    if (fresh && !onboarding) {
      onboarding = createOnboarding({
        ui,
        doc,
        signal: ctx.signal,
        go: (segments) => ctx.router.navigate(segments),
        start: (label) => {
          void resumeRun().then(
            () => chatStream?.send(JSON.stringify({ type: 'greet', label })),
            (err) => ctx.onError(err),
          );
        },
      });
      onboarding.setProvider(providerReady, providerHint);
      view.insertBefore(onboarding.el, timeline.el);
      return;
    }
    if (!fresh && onboarding) {
      onboarding.el.remove();
      onboarding = null;
    }
  };

  const hello = JSON.stringify({ type: 'hello', name: '控制台' });
  let chatStream: ConsoleStreamHandle | null = null;

  // ── fork 视图 ─────────────────────────────────────────────────────
  const fork = createForkView({
    ui,
    lifecycle: ctx.lifecycle,
    signal: ctx.signal,
    timeline,
    mainMessages: () => state.messages,
    mainHead: () => state.head,
    sessions: () => state.sessions,
    onChange: () => sessionBand.render(state.sessions, fork.id),
    onError: (err) => ctx.onError(err),
  });

  const updateCtx = (): void => {
    const d = computeCtx({
      messages: state.messages,
      head: state.head,
      toolSchemas: state.toolSchemas,
      status: state.status,
    });
    ctxOpen.setAttribute('style', ctxRingStyle(d));
    const known = d !== null && d.maxTokens !== null && d.maxTokens > 0;
    const ratio = known ? d.total / d.maxTokens! : 0;
    // 分母未知(Persona没报预算、Provider 也没报窗口)时圈里只写计数,不编百分比
    ctxPct.textContent = d ? (known ? ui.fmt.percent(ratio) : ui.fmt.count(d.total)) : '—';
    ctxOpen.className = `ctxdonut${ratio >= 1 ? ' danger' : d && d.softRatio !== null && ratio >= d.softRatio ? ' warn' : ''}`;
    ctxOpen.title = d
      ? S.ctxTitle(ui.fmt.count(d.total), known ? ui.fmt.count(d.maxTokens!) : null)
      : S.ctxWaiting;
  };

  const setStatus = (st: StatusSnapshot | null): void => {
    state.status = st;
    status.render(st);
    if (st && applyDisplayName(doc, st.displayName, state.displayName)) {
      state.displayName = str(st.displayName);
    }
    if (st) timeline.setSpeaker(str(st.displayName));
    updateCtx();
  };

  const setSessions = (list: SessionStat[]): void => {
    state.sessions = list;
    sessionBand.render(list, fork.id);
    fork.noteSessions();
  };

  // ── 调试帧 ────────────────────────────────────────────────────────
  const onFrame = (f: Readonly<Record<string, unknown>>): void => {
    switch (f.t) {
      case 'hello': {
        state.toolSchemas = arr<ToolSchemaDoc>(f.toolSchemas);
        state.messages = arr<ContextRecord>(f.session);
        state.head = arr<ContextRecord>(f.head);
        // 重连即回到主视图:那个 fork 的轮询若还开着,这里连它一起收。
        fork.switchTo(MAIN_ID, MAIN_LABEL);
        // 先记说话人再铺时间线:头像占位圆的首字在画气泡时就定了。
        setStatus((f.status as StatusSnapshot | null) ?? null);
        timeline.rebuild(state.messages, { head: state.head });
        setSessions(arr<SessionStat>(f.sessions));
        break;
      }
      case 'session.append': {
        const index = f.index;
        if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
          if (index < state.messages.length) break;
          if (index === state.messages.length) {
            const message = f.message as ContextRecord;
            state.messages.push(message);
            if (fork.isMain()) timeline.append(message, index, true);
            break;
          }
        }
        // 缺失、非法或跳跃的索引需要重新获取完整会话。
        socket?.dispose();
        reopenDebug();
        break;
      }
      case 'session.reset':
        state.messages = arr<ContextRecord>(f.messages);
        if (f.head !== undefined) state.head = arr<ContextRecord>(f.head);
        if (fork.isMain()) {
          timeline.rebuild(state.messages, { note: S.sessionResetNote, head: state.head });
        }
        break;
      case 'status':
        setStatus((f.status as StatusSnapshot | null) ?? null);
        break;
      case 'sessions':
        setSessions(arr<SessionStat>(f.sessions));
        break;
      case 'sys':
        // 服务端明说通道不可用:别再画"连接中",也别让 fork 轮询留着。
        fork.switchTo(MAIN_ID, MAIN_LABEL);
        state.messages = [];
        timeline.rebuild([], { empty: str(f.text) || S.debugUnavailable });
        break;
      default:
        break; // 认不出的帧忽略:服务端以后加帧型不该让这一页炸
    }
    updateCtx();
    syncOnboarding();
  };

  let socket: Disposable | null = null;
  const reopenDebug = (): void => {
    socket = openFrameworkSocket({
      path: DEBUG_WS_PATH,
      lifecycle: ctx.lifecycle,
      env,
      onFrame,
      onNet: setNet,
      onError: (err) => ctx.onError(err),
    });
  };

  if (ctx.capabilities.debug) {
    reopenDebug();
  } else {
    timeline.rebuild([], { empty: S.debugNotMounted });
    // 状态读数仍然有:`/api/status` 是框架端点,不随调试通道走。
    void get<StatusSnapshot>('/api/status', { signal: ctx.signal }).then(
      (st) => {
        setStatus(st);
        setNet(true);
        syncOnboarding();
      },
      (err) => {
        if ((err as { name?: string } | null)?.name === 'AbortError') return;
        setNet(false);
        ctx.onError(err);
      },
    );
    if (ctx.capabilities.sessions) {
      openFrameworkSocket({
        path: SESSIONS_WS_PATH,
        lifecycle: ctx.lifecycle,
        env,
        onFrame: (f) => {
          if (f.t === 'sessions') setSessions(arr<SessionStat>(f.sessions));
        },
        onNet: setNet,
        onError: (err) => ctx.onError(err),
      });
    }
  }

  chatStream = ctx.lifecycle.own(openStream({
    url: env.wsUrl(panelStreamRoute('world:terminal', 'chat')),
    signal: ctx.signal,
    createSocket: env.createSocket,
    setTimer: env.setTimer,
    clearTimer: env.clearTimer,
    onError: (err) => ctx.onError(err),
    handlers: {
      message: () => {},
      close: (willRetry) => {
        if (willRetry) chatStream?.send(hello);
      },
    },
  }));
  chatStream.send(hello);
}
