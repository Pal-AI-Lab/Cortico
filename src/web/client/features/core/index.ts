/**
 * core 的运行态、会话统计、事件流、日志、数据与配置页，不持有或显示人格前缀。
 * 工具表不在这里:那是 Persona 页的框架页签。
 * 子页状态由路由表达；未挂载的能力不显示页签。仅当前子页运行轮询，状态保存在挂载闭包，由调试帧或一次性 GET 填充。
 */

import type { Disposable } from '../../../shared/client-panel.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { pageIntro } from '../../ui/page.ts';
import { get } from '../../core/api.ts';
import { browserSocketEnv, openFrameworkSocket, type SocketEnv } from '../../core/websocket.ts';
import {
  arr,
  str,
  type SessionStat,
  type StatusSnapshot,
} from '../live/protocol.ts';
import { createEventsView } from './events.ts';
import { createRunlogView } from './runlog.ts';
import { createRunView } from './run.ts';
import { createSessionTable } from './sessions.ts';
import { S } from './strings.ts';
import { createConfigView } from '../config/view.ts';
import { createStorageView } from '../storage/view.ts';

const CORE_ROUTE = 'core';
const DEBUG_WS_PATH = '/ws/debug';

/** 一个子页签。`need` 是它依赖的 capability(null = 永远有)。 */
interface SubDef {
  id: string;
  label: string;
  need: string | null;
}

const CORE_SUBS: readonly SubDef[] = [
  { id: 'run', label: S.subRun, need: null },
  { id: 'sessions', label: S.subSessions, need: 'sessions' },
  { id: 'events', label: S.subEvents, need: null },
  { id: 'runlog', label: S.subRunlog, need: null },
  { id: 'data', label: S.subData, need: 'storage' },
  { id: 'config', label: S.subConfig, need: 'config' },
];

export interface CoreFeatureOptions {
  env?: SocketEnv;
}

export function createCoreFeature(opts: CoreFeatureOptions = {}): FrameworkFeature {
  return {
    route: CORE_ROUTE,
    label: S.navLabel,
    icon: 'activity',
    navGroup: S.navGroup,
    // 事件流与运行日志不依赖任何可选表面,所以这一页永远有意义。
    mount(ctx) {
      return mountHarness(ctx, opts.env ?? browserSocketEnv(window));
    },
  };
}

export const coreFeature: FrameworkFeature = createCoreFeature();

function mountHarness(ctx: FeatureContext, env: SocketEnv): Disposable | void {
  const { ui } = ctx;

  const state = {
    status: null as StatusSnapshot | null,
    sessions: [] as SessionStat[],
  };

  const subs = CORE_SUBS.filter((s) => s.need === null || ctx.capabilities[s.need] === true);
  const wanted = str(ctx.route.segments[1]);
  let current = subs.some((s) => s.id === wanted) ? wanted : (subs[0]?.id ?? 'run');

  // ── 页头 ─────────────────────────────────────────────────────────
  const view = ui.h('div', 'coreview');
  const head = pageIntro(ui, S.pageTitle);
  head.className = 'featureintro pagehead';
  const tabs = ui.segmented(
    subs.map((s) => ({ value: s.id, label: s.label })),
    { value: current, onSelect: (v) => show(v, true) },
  );
  const tabBar = ui.h('div', 'subtabs');
  tabBar.appendChild(tabs.el);
  const net = ui.msgline('');
  tabBar.appendChild(net);
  const scroll = ui.h('div', 'scroll');
  const measure = ui.h('div', 'measure');
  scroll.appendChild(measure);
  view.append(head, tabBar, scroll);
  ctx.root.appendChild(view);

  const setNet = (online: boolean): void => {
    net.className = online ? 'msgline' : 'msgline bad';
    net.textContent = online ? '' : S.netOffline;
  };

  // ── 六个子页 ─────────────────────────────────────────────────────
  const run = createRunView({ ui });
  const sessions = createSessionTable(ui);
  const events = createEventsView({
    ui,
    lifecycle: ctx.lifecycle,
    signal: ctx.signal,
    onNet: setNet,
    onError: (err) => ctx.onError(err),
  });
  const runlog = createRunlogView({
    ui,
    signal: ctx.signal,
    onNet: setNet,
    onError: (err) => ctx.onError(err),
  });
  // Core 自己的存储项与配置组:按 owner 取,World / Persona / Memory 的各在自己页上。
  const data = createStorageView({ ui, signal: ctx.signal, filter: (p) => p.owner === 'core', clearAll: true });
  const dataSheet = ui.sheet({ title: S.dataTitle, en: 'core storage', desc: S.dataDesc });
  dataSheet.body.appendChild(data.el);
  const config = createConfigView({
    ui,
    lifecycle: ctx.lifecycle,
    signal: ctx.signal,
    filter: (group) => group.owner === 'core',
    showOwner: false,
    emptyText: S.configEmpty,
  });
  const configSheet = ui.sheet({ title: S.configTitle, en: 'core config', desc: S.configDesc });
  configSheet.body.appendChild(config.el);

  const panes: Record<string, HTMLElement> = {
    run: run.el,
    sessions: sessions.el,
    events: events.el,
    runlog: runlog.el,
    data: dataSheet.el,
    config: configSheet.el,
  };

  /** 每次进入某个子页要做的事。进来才拉数据——没打开的页不该占网络。 */
  const enter: Record<string, () => void> = {
    run: () => {
      run.render(state.status);
      if (!hasDebug) void refreshStatus();
    },
    sessions: () => {
      sessions.render(state.sessions);
      if (!hasDebug) void refreshSessions();
    },
    events: () => {
      void events.init();
      events.setPolling(!hasDebug);
    },
    runlog: () => {
      void runlog.refresh();
    },
    data: () => {
      void data.load();
    },
    config: () => {
      void config.load();
    },
  };

  function show(sub: string, navigate: boolean): void {
    const next = subs.some((s) => s.id === sub) ? sub : (subs[0]?.id ?? 'run');
    if (next !== current) {
      // 离开事件流就停它的轮询:一个看不见的表不该继续问服务端要数据。
      if (current === 'events') events.setPolling(false);
      current = next;
    }
    tabs.setValue(current);
    while (measure.children.length) measure.children[0].remove();
    const pane = panes[current];
    if (pane) measure.appendChild(pane);
    enter[current]?.();
    if (navigate) ctx.router.navigate([CORE_ROUTE, current]);
  }

  // 地址栏被别处改了(后退键、别的页跳过来)时跟上,不重建整页。
  ctx.lifecycle.own(
    ctx.router.onChange((route) => {
      if (route.segments[0] !== CORE_ROUTE) return;
      const sub = str(route.segments[1]) || (subs[0]?.id ?? 'run');
      if (sub !== current) show(sub, false);
    }),
  );

  // ── 数据 ─────────────────────────────────────────────────────────
  async function refreshStatus(): Promise<void> {
    try {
      const st = await get<StatusSnapshot>('/api/status', { signal: ctx.signal });
      state.status = st;
      setNet(true);
      if (current === 'run') run.render(st);
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      setNet(false);
      ctx.onError(err);
    }
  }

  async function refreshSessions(): Promise<void> {
    try {
      const d = await get<{ sessions?: SessionStat[] }>('/api/sessions', { signal: ctx.signal });
      state.sessions = d?.sessions ?? [];
      if (current === 'sessions') sessions.render(state.sessions);
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      ctx.onError(err);
    }
  }

  const hasDebug = ctx.capabilities.debug === true;
  if (hasDebug) {
    openFrameworkSocket({
      path: DEBUG_WS_PATH,
      lifecycle: ctx.lifecycle,
      env,
      onNet: setNet,
      onError: (err) => ctx.onError(err),
      onFrame: (f) => {
        switch (f.t) {
          case 'hello':
            state.sessions = arr<SessionStat>(f.sessions);
            state.status = (f.status as StatusSnapshot | null) ?? null;
            if (current === 'run') run.render(state.status);
            if (current === 'sessions') sessions.render(state.sessions);
            break;
          case 'status':
            state.status = (f.status as StatusSnapshot | null) ?? null;
            if (current === 'run') run.render(state.status);
            break;
          case 'sessions':
            state.sessions = arr<SessionStat>(f.sessions);
            if (current === 'sessions') sessions.render(state.sessions);
            break;
          // 有推送就不必轮询:到了才追一次。
          case 'event':
            if (current === 'events') void events.poll();
            break;
          case 'runlog':
            if (current === 'runlog') void runlog.refresh();
            break;
          default:
            break;
        }
      },
    });
  } else {
    void refreshStatus();
  }

  show(current, false);
}
