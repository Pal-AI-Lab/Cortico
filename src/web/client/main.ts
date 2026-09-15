/** 控制台入口：贡献页路由交给 ConsolePageHost，框架路由交给对应 feature；空路由默认打开终端。 */

import { fetchManifest, get } from './core/api.ts';
import { pick, withLanguage } from './core/language.ts';
import { Lifecycle } from './core/lifecycle.ts';
import { Router, type Route } from './core/router.ts';
import type { SocketLike } from './core/stream.ts';
import { wsUrlOf } from './core/websocket.ts';
import { BUILTIN_PANELS } from './console-pages/builtins.ts';
import { ConsolePageHost, PROVIDER_ROUTE } from './console-pages/host.ts';
import { ConsolePageLoader } from './console-pages/loader.ts';
import { createConsoleUi } from './ui/index.ts';
import { subscribeLamps } from './ui/lamp.ts';
import { applyStoredTheme } from './theme/studio.ts';
import { createShell } from './shell/index.ts';
import { featureAvailable, type FeatureContext, type FrameworkFeature } from './features/feature.ts';
import { liveFeature } from './features/live/index.ts';
import { coreFeature } from './features/core/index.ts';
import { usageFeature } from './features/usage/index.ts';
import { providersFeature } from './features/providers/index.ts';
import { configFeature } from './features/config/index.ts';
import { storageFeature } from './features/storage/index.ts';
import { worldsFeature } from './features/worlds/index.ts';
import { extensionsFeature } from './features/extensions/index.ts';
import { appearanceFeature } from './features/appearance/index.ts';
import { promptsFeature } from './features/prompts/index.ts';
import { settingsFeature } from './features/settings/index.ts';
import type { ConsoleMemo } from '../shared/client-panel.ts';

/**
 * 控制台自己的页面。与贡献方的页无关——那一路完全由 manifest 驱动。
 *
 * 顺序即左栏顺序。`hidden` 的页面(运行参数、存储、外观)不进左栏,
 * 但仍要在这张表里:路由分派只认这张表,设置页里嵌着它们的同时,直达链接也要能开。
 */
export const FEATURES: readonly FrameworkFeature[] = [
  liveFeature, coreFeature, usageFeature, providersFeature,
  worldsFeature, extensionsFeature, promptsFeature, configFeature, storageFeature, appearanceFeature,
  settingsFeature,
];

/** feature 挂载抛错时那张错误卡的标题。 */
const featureLoadFailed = pick({
  zh: (label: string) => `「${label}」没能加载`,
  en: (label: string) => `"${label}" failed to load`,
});

/** localStorage 后端；无痕模式下静默降级成内存，不抛。 */
function createMemo(prefix: string): ConsoleMemo {
  const fallback = new Map<string, unknown>();
  return {
    get<T>(key: string, dflt: T): T {
      const k = prefix + key;
      try {
        const raw = localStorage.getItem(k);
        if (raw === null) return fallback.has(k) ? (fallback.get(k) as T) : dflt;
        return JSON.parse(raw) as T;
      } catch {
        return fallback.has(k) ? (fallback.get(k) as T) : dflt;
      }
    },
    set(key: string, value: unknown): void {
      const k = prefix + key;
      fallback.set(k, value);
      try {
        localStorage.setItem(k, JSON.stringify(value));
      } catch { /* 无痕/配额满:这轮只留在内存里 */ }
    },
  };
}

export function boot(doc: Document = document): { dispose(): void } {
  // 首次渲染前应用主题。
  try {
    applyStoredTheme(doc);
  } catch { /* 主题读坏了不该拦住整个控制台 */ }

  // 首屏提示已经完成使命——内核跑起来了。摘不掉它才说明脚本没起来。
  doc.getElementById('boot-note')?.remove();

  let root = doc.getElementById('kernel-root');
  if (!root) {
    root = doc.createElement('div');
    root.id = 'kernel-root';
    doc.body.appendChild(root);
  }
  /**
   * 贡献方的页与 framework feature 各自拥有独立根容器。ConsolePageHost.unmount() 清空其根节点时，不得影响 feature 的 DOM。
   */
  const pageRoot = doc.createElement('div');
  const featureRoot = doc.createElement('div');
  root.replaceChildren(pageRoot, featureRoot);

  const onError = (err: unknown): void => {
    console.error('[console]', err);
  };

  const loader = new ConsolePageLoader({
    importModule: (url) => import(/* @vite-ignore */ url),
    styleHost: doc.head,
    createLink: () => doc.createElement('link'),
    log: (msg, detail) => console.warn('[console]', msg, detail ?? ''),
  });

  const router = new Router({
    win: window,
    confirmLeave: async (message) => window.confirm(message),
    onError,
  });

  const memo = createMemo('cortico.panel.');

  const hostDeps = {
    doc,
    overlayHost: doc.body,
    loader,
    builtins: BUILTIN_PANELS,
    router,
    fetchManifest: () => fetchManifest(),
    memo,
    createSocket: (url: string) => new WebSocket(url) as unknown as SocketLike,
    wsUrl: (path: string) => wsUrlOf(location, withLanguage(path)),
    onError,
  };
  const host = new ConsolePageHost({ ...hostDeps, root: pageRoot });
  /** 框架页里嵌别的页的面板用的宿主:同一套加载器与 memo,只换容器与路由前缀。 */
  const consolePageHost: NonNullable<FeatureContext['consolePageHost']> = (opts) =>
    new ConsolePageHost({ ...hostDeps, root: opts.root, route: opts.route });

  /**
   * 左栏外壳。它自己不探活、不认识任何具体 World:框架页那段由 FEATURES 按
   * capability 过滤,贡献方那段完全由 manifest 驱动。
   */
  const shellLife = new Lifecycle(onError);
  const shell = createShell({
    doc,
    ui: createConsoleUi({ memo, overlayHost: doc.body, signal: shellLife.signal, doc }),
    router,
    features: FEATURES,
    onError,
  });
  doc.body.insertBefore(shell.el, doc.body.firstChild);
  const offNav = host.onNavChange(() => shell.setPages(host.pages));

  /**
   * 状态灯的活数据。manifest 只在开页与显式刷新时取，而灯要跟得上"引擎起来了没"，
   * 所以走那条只回灯的轻端点（节拍与不叠发都归 `subscribeLamps`）。
   */
  shellLife.own(subscribeLamps(doc, (lamps) => shell.setLamps(lamps)));

  /** 框架能力清单；获取失败时不启用可选能力。 */
  let capabilities: Record<string, boolean> = {};
  /** capabilities 与 manifest 都到齐了吗。到齐之前不渲染任何一页。 */
  let ready = false;

  /** 当前挂着的 framework feature（贡献方那边由 host 自己管）。 */
  let mounted: { route: string; lifecycle: Lifecycle } | null = null;
  let generation = 0;

  const unmountFeature = (): void => {
    const cur = mounted;
    mounted = null;
    generation++;
    if (cur) cur.lifecycle.dispose();
    featureRoot.replaceChildren();
  };

  const findFeature = (name: string | undefined): FrameworkFeature | undefined =>
    name === undefined ? undefined : FEATURES.find((f) => f.route === name);

  const mountFeature = (feature: FrameworkFeature, route: Route): void => {
    unmountFeature();
    const gen = generation;
    const lifecycle = new Lifecycle(onError);
    mounted = { route: feature.route, lifecycle };

    const slot = doc.createElement('div');
    slot.className = `featureslot featureslot-${feature.route}`;
    featureRoot.appendChild(slot);

    const ui = createConsoleUi({ memo, overlayHost: doc.body, signal: lifecycle.signal, doc });
    void (async () => {
      try {
        const out = await feature.mount({
          root: slot, lifecycle, signal: lifecycle.signal, ui, router, route,
          capabilities, onError, consolePageHost,
          refreshNav: () => host.refresh(),
        });
        if (gen !== generation) {
          if (out && typeof out.dispose === 'function') out.dispose();
          return;
        }
        if (out && typeof out.dispose === 'function') lifecycle.own(out);
      } catch (err) {
        if (gen !== generation) return;
        onError(err);
        lifecycle.dispose();
        slot.replaceChildren();
        const card = ui.sheet({ title: featureLoadFailed(feature.label), en: 'feature error' });
        card.body.appendChild(ui.msgline(err instanceof Error ? err.message : String(err), true));
        slot.appendChild(card.el);
      }
    })();
  };

  const apply = (route: Route): void => {
    shell.setRoute(route);
    // 页面加载依赖完整的 capabilities；就绪后重新应用当前路由。
    if (!ready) return;
    // 空路由替换为终端页，不增加历史条目。
    if (route.segments.length === 0) {
      router.replace(['live']);
      return;
    }
    const head = route.segments[0];

    if (head === PROVIDER_ROUTE) {
      unmountFeature();
      const pageId = route.segments[1];
      if (!pageId) { host.unmount(); return; }
      void host.show(pageId, route.segments[2]);
      return;
    }

    const feature = findFeature(head);
    if (feature && featureAvailable(feature, capabilities)) {
      host.unmount();
      // 同一个 feature 内部换子页签(segments[1] 变)由它自己处理，不重挂。
      if (mounted?.route === feature.route) return;
      mountFeature(feature, route);
      return;
    }

    // 没人认领:清空台面。左栏仍在,导航照常可用。
    host.unmount();
    unmountFeature();
  };

  const offRoute = router.onChange(apply);
  const stopRouter = router.start();

  // capabilities 与 manifest 就绪后按当前路由渲染。
  void Promise.allSettled([
    get<{ capabilities?: Record<string, boolean> }>('/api/capabilities')
      .then((r) => { capabilities = r?.capabilities ?? {}; }),
    host.load(),
  ]).then(() => {
    ready = true;
    shell.setCapabilities(capabilities);
    shell.setPages(host.pages);
    apply(router.route);
  });

  return {
    dispose(): void {
      offNav.dispose();
      shell.dispose();
      shellLife.dispose();
      offRoute.dispose();
      stopRouter.dispose();
      unmountFeature();
      host.unmount();
    },
  };
}

// 作为 bundle 入口被加载时自动启动;被测试 import 时(没有真 DOM)不自动跑。
if (typeof document !== 'undefined' && document.body) {
  boot();
}
