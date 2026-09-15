/**
 * 控制台外壳管理左栏导航和品牌区域；host 与 feature 管理右侧内容。
 * 框架页来自 FrameworkFeature[]，贡献方的页来自 manifest；只展示可用 feature 与 availability 为 active 的页，不内置具体 World 或 bot 名称。
 * 外壳不探测整站可达性，单个接口失败不代表整站状态。DOM 复用 ConsoleUi 与现存样式，窄屏折叠交给 CSS。
 */

import { get, post } from '../core/api.ts';
import { buildHash, type Route, type Router } from '../core/router.ts';
import { featureAvailable, type FrameworkFeature } from '../features/feature.ts';
import { PROVIDER_ROUTE } from '../console-pages/host.ts';
import { icon, type ConsoleIconName } from '../ui/icons.ts';
import { lampRow, paintLamps } from '../ui/lamp.ts';
import type { ConsoleUi } from '../../shared/client-panel.ts';
import type { ConsoleLamp, ConsolePageManifest } from '../../shared/console-protocol.ts';
import { createAvatarControl } from './avatar.ts';
import { S } from './strings.ts';

const DEFAULT_BRAND = 'bot';
const FRAMEWORK_NAME = 'Cortico';
const FRAMEWORK_TAGLINE = S.tagline;

const GROUP_PERSONAS = S.groupPersonas;
const GROUP_WORLDS = S.groupWorlds;


export interface ShellDeps {
  doc: Document;
  /** UI 原语。DOM 只经它造，外壳不手搓 class。 */
  ui: ConsoleUi;
  /** 跳转经它——`location.hash` 只有 router 能写。 */
  router: Router;
  /** 控制台自己的页面。顺序即左栏顺序。 */
  features?: readonly FrameworkFeature[];
  /** 框架级表面的挂载情况。晚到就先传空，之后 `setCapabilities` 补。 */
  capabilities?: Record<string, boolean>;
  /** 控制台页清单（`/api/console/manifest`）。晚到就之后 `setPages` 补。 */
  pages?: readonly ConsolePageManifest[];
  /** 外壳的生命周期。abort 等同于 `dispose()`。 */
  signal?: AbortSignal;
  onError?(err: unknown): void;
}

export interface ConsoleShell {
  /** 整个左栏（`#rail`）。调用方把它插进 `body` 的最前面。 */
  readonly el: HTMLElement;
  /** 当前路由变了。驱动高亮，不做别的。 */
  setRoute(route: Route): void;
  /** 展示名。空值退回中性缺省。 */
  setBrand(name: string | null | undefined): void;
  /** 能力清单到齐/变了，重排框架页那一段。 */
  setCapabilities(capabilities: Record<string, boolean>): void;
  /** manifest 到齐/变了，重排贡献方那一段。 */
  setPages(pages: readonly ConsolePageManifest[]): void;
  /**
   * 灯的新读数（`/api/console/lamps` 的一拍）。只改灯，不碰导航结构——
   * 这是每秒两次的调用，重排一次 DOM 就是每秒两次重排。
   */
  setLamps(lamps: Record<string, ConsoleLamp[]>): void;
  dispose(): void;
}

/**
 * 一条导航项。`segments` 既用来跳转，也用来判高亮；`lamp` 是那颗灯的节点
 * （灯变了只改它的 class 与 title，不重建导航——那是每秒两次的操作）。
 */
interface NavEntry {
  el: HTMLElement;
  segments: readonly string[];
  /** 贡献方那一行才有：灯按这个 id 对号入座。 */
  pageId?: string;
  /** 那一排灯的容器（灯变了只改它，不重建导航）。 */
  lamps?: HTMLSpanElement;
}

/**
 * 这一项是不是当前所在处。判据是**前缀匹配**：框架页只有一段（`['usage']`），
 * 贡献方的页有两段（`['provider','world:sample']`），同一条规则两边都成立，
 * 而且页内子页签（第三段）变了不会让高亮掉下来。
 */
function matches(entry: NavEntry, route: Route | null): boolean {
  if (!route) return false;
  return entry.segments.every((s, i) => route.segments[i] === s);
}

export function createShell(deps: ShellDeps): ConsoleShell {
  const { doc, ui, router } = deps;

  /** 外壳自己的账本。`dispose()` 与传进来的 signal 都收敛到这里。 */
  const life = new AbortController();
  const signal = life.signal;
  if (deps.signal) {
    if (deps.signal.aborted) life.abort();
    else deps.signal.addEventListener('abort', () => life.abort(), { once: true, signal });
  }

  const onError = deps.onError ?? ((): void => {});

  const features: readonly FrameworkFeature[] = deps.features ?? [];
  let capabilities: Record<string, boolean> = deps.capabilities ?? {};
  let consolePages: readonly ConsolePageManifest[] = deps.pages ?? [];
  let route: Route | null = null;
  let entries: NavEntry[] = [];
  /**
   * 灯的当茬读数。`setLamps` 写它，导航重排时再照它把灯补回去——否则一次
   * `setPages` 会让所有灯退回 manifest 那一帧的旧值。
   */
  let lamps: Record<string, ConsoleLamp[]> = {};
  /**
   * 每次重排换一茬监听。挂在外壳总 signal 上的话，反复 `setPages` 会在
   * 已经摘掉的节点上攒下一堆永不触发、也永不回收的监听。
   */
  let navLife: AbortController | null = null;
  // 外壳一停,当茬导航的监听跟着停(`dispose()` 之外,传进来的 signal 也走这条路)。
  signal.addEventListener('abort', () => navLife?.abort(), { once: true });

  // ---- 骨架 -------------------------------------------------------------

  const el = ui.h('div');
  el.id = 'rail';

  const brand = ui.h('div', 'brand');
  const who = ui.h('div', 'who');
  const brandName = ui.h('span', 'name', DEFAULT_BRAND);
  who.append(brandName, ui.h('span', 'kind', FRAMEWORK_NAME));
  brand.append(who, ui.h('div', 'sub', FRAMEWORK_TAGLINE));

  const nav = ui.h('nav', 'stack');
  nav.setAttribute('aria-label', S.navAria);

  const foot = ui.h('div', 'railfoot');
  const avatar = createAvatarControl({ doc, ui, signal, onError });
  const footActions = ui.h('div', 'rail-actions');
  const runButton = ui.h('button', 'rail-action rail-run');
  runButton.type = 'button';
  const shutdownButton = ui.h('button', 'rail-action rail-shutdown');
  shutdownButton.type = 'button';
  shutdownButton.appendChild(icon(doc, 'power'));
  // 重启 = 同一套收尾 + 退出前落重启标志,启动器循环把进程拉起来。
  const restartButton = ui.h('button', 'rail-action rail-restart');
  restartButton.type = 'button';
  restartButton.appendChild(icon(doc, 'refresh'));
  footActions.append(runButton, restartButton, shutdownButton);
  foot.append(avatar.el, footActions);

  let paused = false;
  let runPending = false;
  const renderRun = (): void => {
    const available = capabilities.run === true;
    runButton.disabled = !available || runPending;
    runButton.replaceChildren(icon(doc, paused ? 'play' : 'pause'));
    runButton.setAttribute('aria-label', paused ? S.runResume : S.runPause);
    runButton.title = available ? (paused ? S.runResume : S.runPause) : S.runUnavailable;
    runButton.classList.toggle('paused', paused);
  };
  renderRun();

  /** 关机和重启共用请求锁，等待请求完成后释放。 */
  let shuttingDown = false;
  const renderPower = (): void => {
    const canShutdown = capabilities.shutdown === true;
    shutdownButton.hidden = !canShutdown;
    shutdownButton.disabled = !canShutdown || shuttingDown;
    shutdownButton.setAttribute('aria-label', S.shutdownAria);
    shutdownButton.title = shuttingDown ? S.finishing : S.shutdownTitle;
    const canRestart = capabilities.restart === true;
    restartButton.hidden = !canRestart;
    restartButton.disabled = !canRestart || shuttingDown;
    restartButton.setAttribute('aria-label', S.restartAria);
    restartButton.title = shuttingDown
      ? S.finishing
      : capabilities.supervised === true
        ? S.restartTitleSupervised
        : S.restartTitleUnsupervised;
  };
  renderPower();

  const powerAction = async (kind: 'shutdown' | 'restart'): Promise<void> => {
    if (shuttingDown) return;
    if (kind === 'shutdown' ? capabilities.shutdown !== true : capabilities.restart !== true) return;
    const supervised = capabilities.supervised === true;
    const first = await ui.confirm(kind === 'shutdown'
      ? {
          title: S.confirmShutdownTitle,
          body: S.shutdownBody,
          danger: true,
        }
      : {
          title: S.confirmRestartTitle,
          body: supervised ? S.restartSupervisedNote : S.restartUnsupervisedNote,
          danger: true,
        });
    if (!first || signal.aborted) return;
    const second = await ui.confirm(kind === 'shutdown'
      ? {
          title: S.confirmShutdownAgainTitle,
          body: S.confirmShutdownAgainBody,
          danger: true,
        }
      : {
          title: S.confirmRestartAgainTitle,
          body: supervised ? S.confirmRestartAgainSupervised : S.confirmRestartAgainUnsupervised,
          danger: true,
        });
    if (!second || signal.aborted) return;
    shuttingDown = true;
    renderPower();
    const hold = ui.toast(S.finishingToast);
    try {
      const out = await post<{
        ok?: boolean; localComplete?: boolean; result?: string; error?: string;
        steps?: Array<{ label: string; ok: boolean; ms: number; detail?: string }>;
        externalChecks?: Array<{ status: 'verified-ended' | 'still-live' | 'unknown' }>;
      }>(kind === 'shutdown' ? '/api/run/shutdown' : '/api/run/restart', undefined, { signal });
      if (out?.error) throw new Error(out.error);
      const steps = out?.steps ?? [];
      const localComplete = out?.localComplete ?? steps.every((step) => step.ok);
      const externalUnverified = (out?.externalChecks ?? [])
        .some((check) => check.status !== 'verified-ended');
      const lines = steps.map((s) =>
        `${s.ok ? '✓' : '✗'} ${s.label} · ${(s.ms / 1000).toFixed(1)}s${s.ok ? '' : ` — ${s.detail ?? S.stepIncomplete}`}`);
      const done = kind === 'shutdown' ? S.doneShutdown : supervised ? S.doneRestartSupervised : S.doneRestart;
      void ui.confirm({
        title: !localComplete
          ? S.resultLocalIncomplete
          : externalUnverified
            ? S.resultExternalUnverified
            : out?.ok === false ? S.resultUnverified : done,
        body: [out?.result ?? S.resultDefault, '', ...lines].join('\n'),
      });
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      // 连接在收尾途中断了是**预期之一**:进程退出得比回执快时就会这样。
      // 所以不说"失败",只说不知道 —— 逐步明细在 runlog 的 shutdown 条目里。
      onError(err);
      ui.toast(S.noReceipt(String((err as Error)?.message ?? err)), 'bad');
    } finally {
      hold.dispose();
      shuttingDown = false;
      renderPower();
    }
  };
  shutdownButton.addEventListener('click', () => { void powerAction('shutdown'); }, { signal });
  restartButton.addEventListener('click', () => { void powerAction('restart'); }, { signal });

  runButton.addEventListener('click', () => {
    if (runPending || capabilities.run !== true) return;
    runPending = true;
    renderRun();
    void post<{ paused?: boolean; result?: string }>(
      paused ? '/api/run/resume' : '/api/run/pause',
      undefined,
      { signal },
    ).then((out) => {
      paused = out.paused === true;
      if (out.result) ui.toast(out.result);
    }).catch((err: unknown) => {
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      onError(err);
      ui.toast(err instanceof Error ? err.message : String(err), 'bad');
    }).finally(() => {
      runPending = false;
      renderRun();
    });
  }, { signal });
  el.append(brand, nav, foot);

  // ---- 导航 -------------------------------------------------------------

  /** 某一页此刻该点哪盏灯。轮询的读数优先于 manifest 那一帧。 */
  const lampsFor = (pageId: string): readonly ConsoleLamp[] =>
    lamps[pageId] ?? consolePages.find((p) => p.id === pageId)?.lamps ?? [];

  const addItem = (
    parent: HTMLElement,
    opts: {
      label: string;
      icon?: ConsoleIconName;
      /** 带灯的行（贡献方的页）。给了就画灯，`null` 是"还没报"的空位。 */
      pageId?: string;
      segments: readonly string[];
    },
    itemSignal: AbortSignal,
  ): NavEntry => {
    const href = buildHash(opts.segments);
    const item = ui.h('a', 'navitem');
    item.href = href;
    if (opts.icon) item.appendChild(icon(doc, opts.icon, 'navicon'));
    const label = ui.h('span', 'lbl', opts.label);
    // 名字给灯让位后可能被截断,悬停仍读得到全名(灯自己的说明挂在各自那颗上)。
    if (opts.pageId) label.title = opts.label;
    item.appendChild(label);
    const lampHost = opts.pageId ? lampRow(doc, lampsFor(opts.pageId)) : undefined;
    if (lampHost) item.appendChild(lampHost);
    // 修饰键与中键保留浏览器默认行为；普通左键经 router 导航。
    item.addEventListener('click', (ev) => {
      if (ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      try {
        router.navigate(opts.segments);
      } catch (err) {
        onError(err);
      }
    }, { signal: itemSignal });
    parent.appendChild(item);
    const entry: NavEntry = {
      el: item,
      segments: opts.segments,
      ...(opts.pageId && lampHost ? { pageId: opts.pageId, lamps: lampHost } : {}),
    };
    entries.push(entry);
    return entry;
  };

  const addGroup = (label: string, kind: 'framework' | 'persona'): HTMLDivElement => {
    // CSS class 仍写 `navgroup-provider`:样式表与构建产物同步,不随类型改名。
    const pageClass = kind === 'framework' ? '' : ' navgroup-provider';
    const group = ui.h('div', `navgroup navgroup-${kind}${pageClass}`);
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    group.appendChild(ui.h('div', 'stacklabel', label));
    nav.appendChild(group);
    return group;
  };

  const addPrimary = (label: string): HTMLDivElement => {
    const group = ui.h('div', 'navgroup navgroup-framework navgroup-primary');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    nav.appendChild(group);
    return group;
  };

  const renderNav = (): void => {
    navLife?.abort();
    if (signal.aborted) return;
    navLife = new AbortController();
    const itemSignal = navLife.signal;

    entries = [];
    nav.replaceChildren();

    const pages = features.filter((f) => featureAvailable(f, capabilities));
    const worldRoots = pages.filter((f) => f.navMode === 'world-root');
    const personaTail = pages.filter((f) => f.navMode === 'persona');
    const groups = new Map<string, HTMLElement>();
    for (const f of pages) {
      if (f.navMode === undefined || f.navMode === 'group') {
        const label = f.navGroup;
        let group = groups.get(label);
        if (!group) {
          group = addGroup(label, 'framework');
          groups.set(label, group);
        }
        addItem(group, {
          label: f.label,
          icon: f.icon,
          ...(f.lampId ? { pageId: f.lampId } : {}),
          segments: [f.route],
        }, itemSignal);
      } else if (f.navMode === 'primary') {
        addItem(addPrimary(f.label), {
          label: f.label,
          icon: f.icon,
          ...(f.lampId ? { pageId: f.lampId } : {}),
          segments: [f.route],
        }, itemSignal);
      }
    }

    // 只列已装配的:左栏是"能去的地方",不是全量清单。未装配的仍由各自的
    // 总览页负责露面(那里才有"为什么没装上"的位置)。供应模块(kind `llm`)不在
    // 这里逐个列出:它们的入口是框架的「语言模型」页,模块清单是那一页里的次级菜单。
    const listed = consolePages.filter((p) => p.availability === 'active');
    // Persona 页在前,它的 Memory 页跟在后面,再是归这一组的框架页(系统提示词),同一组。
    const personas = [
      ...listed.filter((page) => page.kind === 'persona'),
      ...listed.filter((page) => page.kind === 'memory'),
    ];
    if (personas.length || personaTail.length) {
      const group = addGroup(GROUP_PERSONAS, 'persona');
      for (const p of personas) {
        addItem(group, {
          label: p.label || p.id,
          icon: p.kind === 'memory' ? 'folder-open' : 'bot',
          pageId: p.id,
          segments: [PROVIDER_ROUTE, p.id],
        }, itemSignal);
      }
      for (const f of personaTail) {
        addItem(group, { label: f.label, icon: f.icon, segments: [f.route] }, itemSignal);
      }
    }

    const worlds = listed.filter((page) => page.kind === 'world');
    if (worldRoots.length || worlds.length) {
      const group = ui.h('div', 'navgroup navgroup-world-tree');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', GROUP_WORLDS);
      group.appendChild(ui.h('div', 'stacklabel', GROUP_WORLDS));
      nav.appendChild(group);
      for (const f of worldRoots) {
        addItem(group, {
          label: f.label,
          icon: f.icon,
          segments: [f.route],
        }, itemSignal);
      }
      if (worlds.length) {
        const list = ui.h('div', 'navmodule-list');
        list.setAttribute('role', 'group');
        list.setAttribute('aria-label', S.moduleInstancesAria);
        group.appendChild(list);
        for (const p of worlds) {
          addItem(list, {
            label: p.label || p.id,
            pageId: p.id,
            segments: [PROVIDER_ROUTE, p.id],
          }, itemSignal);
        }
      }
    }

    applyRoute();
  };

  const applyRoute = (): void => {
    for (const entry of entries) {
      const on = matches(entry, route);
      entry.el.classList.toggle('active', on);
      if (on) entry.el.setAttribute('aria-current', 'page');
      else entry.el.removeAttribute('aria-current');
    }
  };

  // ---- 品牌名 -----------------------------------------------------------

  const setBrand = (name: string | null | undefined): void => {
    const shown = typeof name === 'string' && name.trim() !== '' ? name.trim() : DEFAULT_BRAND;
    brandName.textContent = shown;
    avatar.setLabel(shown);
    doc.title = S.docTitle(shown);
  };

  /**
   * 展示名来自部署配置。**取不到只影响这一个字**：不改状态灯、不报错卡——
   * 外壳没有"整站是否可达"的判据，一个接口的失败也不该被当成那个判据。
   */
  void (async () => {
    try {
      const st = await get<{
        displayName?: unknown;
        loop?: { paused?: unknown };
      } | null>('/api/status', { signal });
      if (signal.aborted) return;
      const name = st?.displayName;
      if (typeof name === 'string' && name.trim() !== '') setBrand(name);
      paused = st?.loop?.paused === true;
      renderRun();
    } catch { /* 留中性缺省 */ }
  })();

  renderNav();

  return {
    el,
    setRoute(next: Route): void {
      route = next;
      applyRoute();
    },
    setBrand,
    setCapabilities(next: Record<string, boolean>): void {
      capabilities = next;
      renderRun();
      renderPower();
      renderNav();
    },
    setPages(next: readonly ConsolePageManifest[]): void {
      consolePages = next;
      renderNav();
    },
    setLamps(next: Record<string, ConsoleLamp[]>): void {
      lamps = next;
      for (const entry of entries) {
        if (entry.lamps && entry.pageId) paintLamps(entry.lamps, lampsFor(entry.pageId));
      }
    },
    dispose(): void {
      navLife?.abort();
      life.abort();
      el.remove();
    },
  };
}
