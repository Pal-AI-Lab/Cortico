/**
 * Console Page Host 根据 manifest 渲染导航与面板，并管理挂载和卸载；不依赖具体页的名称。扩展加载、mount 或面板解析失败仅将对应面板替换为错误卡，不影响其他页与框架。
 */

import {
  CONSOLE_PROTOCOL_VERSION,
  type ConsoleManifest,
  type ConsolePageManifest,
  type ConsolePanelManifest,
} from '../../shared/console-protocol.ts';
import type { ConsoleMemo, ConsolePanel, Disposable } from '../../shared/client-panel.ts';
import { get, post } from '../core/api.ts';
import { Lifecycle } from '../core/lifecycle.ts';
import type { Router } from '../core/router.ts';
import type { SocketLike } from '../core/stream.ts';
import { createConsoleUi } from '../ui/index.ts';
import { lampRow } from '../ui/lamp.ts';
import { createConfigView } from '../features/config/view.ts';
import type { ToolSchemaDoc } from '../features/live/protocol.ts';
import { createPromptsView } from '../features/prompts/view.ts';
import { createStorageView } from '../features/storage/view.ts';
import { S as TOOLS } from './tools/strings.ts';
import { createToolsView } from './tools/view.ts';
import { resolveConsoleLinkHref } from '../theme/handoff.ts';
import type { BuiltinPanels } from './builtins.ts';
import { createPanelContext, namespacedMemo } from './context.ts';
import { ConsolePageLoader } from './loader.ts';
import { S } from './strings.ts';

/** 控制台页路由的首段，与框架页路由分开。 */
export const PROVIDER_ROUTE = 'provider';
/** 框架页签由 promptDocs、config 与 storage 声明生成；~ 前缀不在合法 panel id 字符集中。 */
const PROVIDER_PROMPTS_ROUTE = '~prompts';
const PROVIDER_CONFIG_ROUTE = '~config';
const PROVIDER_STORAGE_ROUTE = '~storage';
/** 工具表不来自页面声明:装配好的那一份整个属于 Persona,所以只挂在 Persona 页上。 */
const PROVIDER_TOOLS_ROUTE = '~tools';

function asArray<T>(v: readonly T[] | undefined): readonly T[] {
  return Array.isArray(v) ? v : [];
}

/** 页签只给独立面板；带 slot 的由宿主面板挂。 */
function tabbed(page: ConsolePageManifest): readonly ConsolePanelManifest[] {
  return asArray(page.panels).filter((p) => p.slot === undefined);
}

export interface ConsolePageHostDeps {
  doc: Document;
  /** 页面内容渲染到这里。host 自己清空/重建它。 */
  root: HTMLElement;
  /** 浮层宿主，页面级容器；绝不能是 `root`。 */
  overlayHost: HTMLElement;
  loader: ConsolePageLoader;
  /** 内核自带的面板实现，键即 `panel.builtin`。 */
  builtins: BuiltinPanels;
  router: Router;
  fetchManifest(): Promise<ConsoleManifest>;
  memo: ConsoleMemo;
  createSocket(url: string): SocketLike;
  wsUrl(path: string): string;
  onError(err: unknown): void;
  /**
   * 面板页签指向的路由。缺省是 `#/provider/<id>/<panel>`;嵌在别的框架页里的宿主
   * 给自己那一页的前缀,页签切换才不会跳出那一页。
   */
  route?(pageId: string, panelId: string): readonly string[];
}

interface MountedPanel {
  pageId: string;
  panelId: string;
  lifecycle: Lifecycle;
}

/** 页头与面板使用独立容器，刷新页头不重挂面板。 */
interface Panes {
  chrome: HTMLElement;
  slot: HTMLElement;
}

export class ConsolePageHost {
  private readonly deps: ConsolePageHostDeps;
  private snapshot: ConsoleManifest | null = null;
  private mounted: MountedPanel | null = null;
  private panes: Panes | null = null;
  /**
   * 挂载代号。异步 mount 期间用户可能已经走了；回来时对不上号就整个丢弃，
   * 免得把一个已经不该存在的面板贴进 DOM。
   */
  private generation = 0;
  private readonly navListeners = new Set<() => void>();

  constructor(deps: ConsolePageHostDeps) {
    this.deps = deps;
  }

  get pages(): ConsolePageManifest[] {
    return this.snapshot?.providers ?? [];
  }

  /** 取一次 manifest。失败时保留上一份（一次网络抖动不该让导航整个消失）。 */
  async load(): Promise<void> {
    try {
      const next = await this.deps.fetchManifest();
      // 拒绝不支持的协议版本。
      if (next && next.protocolVersion !== CONSOLE_PROTOCOL_VERSION) {
        throw new Error(S.protocolMismatch(String(next.protocolVersion), String(CONSOLE_PROTOCOL_VERSION)));
      }
      this.snapshot = next;
    } catch (err) {
      this.deps.onError(err);
      if (!this.snapshot) {
        this.snapshot = {
          protocolVersion: CONSOLE_PROTOCOL_VERSION,
          providers: [],
          framework: { capabilities: {} },
        };
      }
    }
    this.emitNav();
  }

  /** 重取 manifest 并刷新导航与当前页头，**不重挂面板**。 */
  async refresh(): Promise<void> {
    await this.load();
    const cur = this.mounted;
    if (cur) this.renderChrome(cur.pageId, cur.panelId);
  }

  onNavChange(cb: () => void): Disposable {
    this.navListeners.add(cb);
    return { dispose: () => this.navListeners.delete(cb) };
  }

  private emitNav(): void {
    for (const cb of [...this.navListeners]) {
      try {
        cb();
      } catch (err) {
        this.deps.onError(err);
      }
    }
  }

  find(pageId: string): ConsolePageManifest | undefined {
    return this.pages.find((p) => p.id === pageId);
  }

  private routeOf(pageId: string, panelId: string): readonly string[] {
    return this.deps.route ? this.deps.route(pageId, panelId) : [PROVIDER_ROUTE, pageId, panelId];
  }

  /** 卸载当前面板：abort → dispose → 清空 root。顺序见 client-panel.ts 的说明。 */
  unmount(): void {
    const cur = this.mounted;
    this.mounted = null;
    this.panes = null;
    this.generation++;
    if (cur) cur.lifecycle.dispose();
    this.deps.root.replaceChildren();
  }

  /** 建（或复用）页头与面板槽两个容器。 */
  private ensurePanes(): Panes {
    if (this.panes) return this.panes;
    const doc = this.deps.doc;
    const chrome = doc.createElement('div');
    chrome.className = 'providerchrome';
    const slot = doc.createElement('div');
    slot.className = 'panelslot';
    this.deps.root.replaceChildren(chrome, slot);
    this.panes = { chrome, slot };
    return this.panes;
  }

  /**
   * 显示指定页的面板，省略 panelId 时选择第一个面板。每次调用先卸载上一面板，以重建完整生命周期。
   * 页头渲染、面板解析及 mount 均处于异常隔离范围，失败时显示该面板的错误卡，不使 show() 的错误扩散为路由空白。
   */
  async show(pageId: string, panelId?: string): Promise<void> {
    try {
      await this.showInner(pageId, panelId);
    } catch (err) {
      this.deps.onError(err);
      try {
        this.renderError(S.pageFailed(pageId), err instanceof Error ? err.message : String(err));
      } catch { /* 连错误卡都画不出来:那是 ui 层的事,不再往上抛 */ }
    }
  }

  private async showInner(pageId: string, panelId?: string): Promise<void> {
    this.unmount();
    const gen = this.generation;

    const page = this.find(pageId);
    if (!page) {
      this.renderError(S.noPage(pageId), S.noPageHint);
      return;
    }
    const panels = tabbed(page);
    const prompts = asArray(page.prompts);
    const configGroups = this.configGroupsOf(page);
    const storageKeys = this.storageKeysOf(page);
    const tools = this.toolsTabOf(page);
    const wanted = panelId ?? panels[0]?.id
      ?? (configGroups.length ? PROVIDER_CONFIG_ROUTE : undefined)
      ?? (prompts.length ? PROVIDER_PROMPTS_ROUTE : undefined)
      ?? (storageKeys.length ? PROVIDER_STORAGE_ROUTE : undefined)
      ?? (tools ? PROVIDER_TOOLS_ROUTE : undefined);
    if (wanted === PROVIDER_CONFIG_ROUTE && configGroups.length) {
      this.renderChrome(pageId, PROVIDER_CONFIG_ROUTE);
      await this.showConfig(pageId, configGroups, gen);
      return;
    }
    if (wanted === PROVIDER_PROMPTS_ROUTE && prompts.length) {
      this.renderChrome(pageId, PROVIDER_PROMPTS_ROUTE);
      await this.showPrompts(pageId, prompts.map((doc) => doc.key), gen);
      return;
    }
    if (wanted === PROVIDER_STORAGE_ROUTE && storageKeys.length) {
      this.renderChrome(pageId, PROVIDER_STORAGE_ROUTE);
      await this.showStorage(pageId, storageKeys, gen);
      return;
    }
    if (wanted === PROVIDER_TOOLS_ROUTE && tools) {
      this.renderChrome(pageId, PROVIDER_TOOLS_ROUTE);
      await this.showTools(pageId, gen);
      return;
    }
    const panel = wanted ? panels.find((p) => p.id === wanted) : undefined;
    if (!panel) {
      this.renderChrome(pageId, wanted);
      if (panels.length === 0 && prompts.length === 0 && configGroups.length === 0
        && storageKeys.length === 0 && !tools) {
        this.appendNote(S.noPanels(page.label));
      } else {
        this.renderError(
          S.noSuchPanel(page.label, wanted ?? ''),
          S.provides([
            ...panels.map((p) => p.id),
            ...(configGroups.length ? [PROVIDER_CONFIG_ROUTE] : []),
            ...(prompts.length ? [PROVIDER_PROMPTS_ROUTE] : []),
            ...(storageKeys.length ? [PROVIDER_STORAGE_ROUTE] : []),
            ...(tools ? [PROVIDER_TOOLS_ROUTE] : []),
          ].join(' / ')),
        );
      }
      return;
    }

    this.renderChrome(pageId, panel.id);
    const { slot } = this.ensurePanes();

    const lifecycle = new Lifecycle(this.deps.onError);
    this.mounted = { pageId, panelId: panel.id, lifecycle };

    try {
      const impl = panel.builtin !== undefined
        ? this.builtinPanel(panel.builtin)
        : await this.deps.loader.resolvePanel(pageId, panel.id, page.client);
      if (gen !== this.generation) return; // 等 import 的工夫用户已经走了

      const out = await impl.mount(
        this.panelContext(pageId, panel.id, slot, lifecycle, gen, {}),
      );
      if (gen !== this.generation) {
        // mount 返回时已卸载，立即释放其 Disposable。
        if (out && typeof out.dispose === 'function') out.dispose();
        return;
      }
      if (out && typeof out.dispose === 'function') lifecycle.own(out);
    } catch (err) {
      if (gen !== this.generation) return;
      this.deps.onError(err);
      lifecycle.dispose();
      slot.replaceChildren();
      this.renderErrorInto(
        slot,
        S.panelFailed(panel.title),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** 面板上下文。插槽里的面板与页签面板走同一条路，区别只在 root、生命周期与 scope。 */
  private panelContext(
    pageId: string,
    panelId: string,
    root: HTMLElement,
    lifecycle: Lifecycle,
    gen: number,
    scope: Readonly<Record<string, string>>,
  ) {
    return createPanelContext({
      pageId,
      panelId,
      root,
      lifecycle,
      scope,
      mountSlot: (name, host, childScope) =>
        this.mountSlot(pageId, gen, lifecycle, name, host, childScope),
      overlayHost: this.deps.overlayHost,
      refresh: () => this.refresh(),
      addLeaveGuard: (fn) => this.deps.router.addLeaveGuard(fn),
      memo: namespacedMemo(this.deps.memo, pageId, panelId),
      createSocket: this.deps.createSocket,
      wsUrl: this.deps.wsUrl,
      onError: this.deps.onError,
      doc: this.deps.doc,
    });
  }

  /**
   * 把声明到该插槽的面板按声明顺序挂进 host。整组共用一个生命周期，返回的句柄结束它们；
   * 单块面板挂不上只把该块换成错误卡。
   */
  private async mountSlot(
    pageId: string,
    gen: number,
    parent: Lifecycle,
    slot: string,
    host: HTMLElement,
    scope: Readonly<Record<string, string>>,
  ): Promise<Disposable> {
    const lifecycle = parent.own(new Lifecycle(this.deps.onError));
    const page = this.find(pageId);
    for (const decl of asArray(page?.panels).filter((p) => p.slot === slot)) {
      const box = this.deps.doc.createElement('div');
      host.appendChild(box);
      try {
        const impl = decl.builtin !== undefined
          ? this.builtinPanel(decl.builtin)
          : await this.deps.loader.resolvePanel(pageId, decl.id, page?.client);
        if (gen !== this.generation || lifecycle.disposed) break;
        const out = await impl.mount(
          this.panelContext(pageId, decl.id, box, lifecycle, gen, scope),
        );
        if (out && typeof out.dispose === 'function') {
          if (gen !== this.generation || lifecycle.disposed) out.dispose();
          else lifecycle.own(out);
        }
      } catch (err) {
        this.deps.onError(err);
        box.replaceChildren();
        this.renderErrorInto(
          box,
          S.panelFailed(decl.title),
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return lifecycle;
  }

  /**
   * 取一块内核自带的面板。声明了一个内核不认识的名字 → 明确报错,由 `showInner`
   * 的 catch 收成这一格的错误卡:同一页的其他面板与整个框架不受影响。
   *
   * 内置面板整条路不碰 loader,所以一页的面板全是内置时,它没有浏览器产物也正常。
   */
  private builtinPanel(name: string): ConsolePanel {
    const builtins = this.deps.builtins;
    const impl = builtins[name];
    if (!impl) throw new Error(S.noBuiltinPanel(name, Object.keys(builtins).join(' / ') || S.none));
    return impl;
  }

  /** 仅返回当前页认领且部署支持 config 能力的配置组。 */
  private configGroupsOf(page: ConsolePageManifest): readonly string[] {
    if (this.snapshot?.framework?.capabilities?.config === false) return [];
    return asArray(page.configGroups);
  }

  /** 仅返回当前页声明且部署支持 storage 能力的存储项 key。 */
  private storageKeysOf(page: ConsolePageManifest): readonly string[] {
    if (this.snapshot?.framework?.capabilities?.storage === false) return [];
    return asArray(page.storageKeys);
  }

  /** Persona 页才有工具表页签,且要部署挂着 /api/tool-schemas。 */
  private toolsTabOf(page: ConsolePageManifest): boolean {
    if (page.kind !== 'persona' || page.availability !== 'active') return false;
    return this.snapshot?.framework?.capabilities?.toolSchemas !== false;
  }

  /** 工具表是整份装配结果,不按页筛:模型看见的那一张表就是这一张。 */
  private async showTools(pageId: string, gen: number): Promise<void> {
    const { slot } = this.ensurePanes();
    const lifecycle = new Lifecycle(this.deps.onError);
    this.mounted = { pageId, panelId: PROVIDER_TOOLS_ROUTE, lifecycle };
    const ui = createConsoleUi({
      memo: namespacedMemo(this.deps.memo, pageId, PROVIDER_TOOLS_ROUTE),
      overlayHost: this.deps.overlayHost,
      signal: lifecycle.signal,
      doc: this.deps.doc,
    });
    const view = createToolsView(ui);
    slot.appendChild(view.el);
    try {
      const out = await get<{ tools?: ToolSchemaDoc[] }>('/api/tool-schemas', { signal: lifecycle.signal });
      view.render(out?.tools ?? []);
    } catch (err) {
      if ((err as { name?: string } | null)?.name !== 'AbortError') {
        this.deps.onError(err);
        view.render([]);
        view.note(TOOLS.loadFailed(err instanceof Error ? err.message : String(err)));
      }
    }
    if (gen !== this.generation) lifecycle.dispose();
  }

  /** 这一页声明的存储项走同一张 /api/storage 清单;这里只按 key 挑出自己的。 */
  private async showStorage(pageId: string, keys: readonly string[], gen: number): Promise<void> {
    const { slot } = this.ensurePanes();
    const lifecycle = new Lifecycle(this.deps.onError);
    this.mounted = { pageId, panelId: PROVIDER_STORAGE_ROUTE, lifecycle };
    const ui = createConsoleUi({
      memo: namespacedMemo(this.deps.memo, pageId, PROVIDER_STORAGE_ROUTE),
      overlayHost: this.deps.overlayHost,
      signal: lifecycle.signal,
      doc: this.deps.doc,
    });
    const wanted = new Set(keys);
    const view = createStorageView({ ui, signal: lifecycle.signal, filter: (part) => wanted.has(part.key) });
    const sheet = ui.sheet({ title: S.storageTitle, en: 'storage', desc: S.storageDesc });
    sheet.body.appendChild(view.el);
    slot.appendChild(sheet.el);
    await view.load();
    if (gen !== this.generation) lifecycle.dispose();
  }

  /** manifest 提供组 id，schema 与当前值取自 /api/config；页内省略重复 owner 标签。 */
  private async showConfig(pageId: string, groupIds: readonly string[], gen: number): Promise<void> {
    const { slot } = this.ensurePanes();
    const lifecycle = new Lifecycle(this.deps.onError);
    this.mounted = { pageId, panelId: PROVIDER_CONFIG_ROUTE, lifecycle };
    const ui = createConsoleUi({
      memo: namespacedMemo(this.deps.memo, pageId, PROVIDER_CONFIG_ROUTE),
      overlayHost: this.deps.overlayHost,
      signal: lifecycle.signal,
      doc: this.deps.doc,
    });
    const wanted = new Set(groupIds);
    const view = createConfigView({
      ui,
      lifecycle,
      signal: lifecycle.signal,
      filter: (group) => wanted.has(group.id),
      showOwner: false,
      emptyText: S.configEmpty,
    });
    const sheet = ui.sheet({
      title: S.configTitle,
      en: 'config',
      desc: S.configDesc,
    });
    sheet.body.appendChild(view.el);
    slot.appendChild(sheet.el);
    await view.load();
    if (gen !== this.generation) lifecycle.dispose();
  }

  /** 这一页声明的提示词模板仍由框架通用编辑器承载，扩展无需重复文件读写 UI。 */
  private async showPrompts(pageId: string, keys: readonly string[], gen: number): Promise<void> {
    const { slot } = this.ensurePanes();
    const lifecycle = new Lifecycle(this.deps.onError);
    this.mounted = { pageId, panelId: PROVIDER_PROMPTS_ROUTE, lifecycle };
    const ui = createConsoleUi({
      memo: namespacedMemo(this.deps.memo, pageId, PROVIDER_PROMPTS_ROUTE),
      overlayHost: this.deps.overlayHost,
      signal: lifecycle.signal,
      doc: this.deps.doc,
    });
    const view = createPromptsView({
      ui,
      lifecycle,
      signal: lifecycle.signal,
      addLeaveGuard: (fn) => this.deps.router.addLeaveGuard(fn),
      onError: this.deps.onError,
      keys,
    });
    slot.appendChild(view.el);
    await view.load();
    if (gen !== this.generation) lifecycle.dispose();
  }

  // -------------------------------------------------------------------------
  // 页头与错误卡。都只吃 manifest 的通用字段。
  // -------------------------------------------------------------------------

  private ui(): ReturnType<typeof createConsoleUi> {
    // 页头是 host 自己的 DOM，生命周期跟 host 走，不绑任何面板。
    return createConsoleUi({
      memo: this.deps.memo,
      overlayHost: this.deps.overlayHost,
      signal: new AbortController().signal,
      doc: this.deps.doc,
    });
  }

  private renderChrome(pageId: string, activePanel?: string): void {
    const page = this.find(pageId);
    const { chrome } = this.ensurePanes();
    chrome.replaceChildren();
    if (!page) return;

    const ui = this.ui();
    const head = ui.h('header', 'featureintro providerintro');
    const title = ui.h('h1', 'pagetitle', page.label);
    // 未激活页的状态由框架提供。
    title.appendChild(lampRow(
      this.deps.doc,
      page.availability === 'active'
        ? page.lamps ?? []
        : [{ label: S.assembly, state: 'offline', hint: page.availability === 'missing' ? S.notInstalled : S.notActivated }],
    ));
    head.append(title, ui.h('p', 'pagedesc', page.id));
    const bar = ui.rowbar();

    for (const badge of asArray(page.badges)) {
      bar.appendChild(ui.pill(`${badge.label} ${badge.value}`, badge.tone));
    }
    if (page.availability !== 'active') {
      bar.appendChild(ui.pill(page.availability === 'missing' ? S.notInstalled : S.notActivated, 'off'));
    }
    if (page.agentVisible === false) bar.appendChild(ui.pill(S.hidden, 'off'));
    if (page.prefixDrifted) {
      bar.appendChild(ui.button(S.reloadPrefix, {
        size: 'sm',
        onClick: () => { void this.reloadPrefix(ui); },
      }));
    }
    bar.appendChild(ui.h('span', 'grow'));

    for (const link of asArray(page.links)) {
      const open = ui.button(link.label || S.open, {
        variant: 'primary',
        size: 'sm',
        onClick: () => {
          this.deps.doc.defaultView?.open(
            resolveConsoleLinkHref(this.deps.doc, link),
            '_blank',
            'noopener',
          );
        },
      });
      bar.appendChild(open);
    }
    head.appendChild(bar);
    if (page.reason) head.appendChild(ui.msgline(page.reason, true));
    chrome.appendChild(head);

    const panels = tabbed(page);
    const prompts = asArray(page.prompts);
    const configGroups = this.configGroupsOf(page);
    const storageKeys = this.storageKeysOf(page);
    const tools = this.toolsTabOf(page);
    if (panels.length + (configGroups.length ? 1 : 0) + (prompts.length ? 1 : 0)
      + (storageKeys.length ? 1 : 0) + (tools ? 1 : 0) > 1) {
      const tabs = ui.rowbar();
      const go = (panelId: string): void => this.deps.router.navigate(this.routeOf(page.id, panelId));
      for (const p of panels) {
        const btn = ui.button(p.title || p.id, {
          size: 'sm',
          variant: p.id === activePanel ? 'primary' : 'plain',
          onClick: () => go(p.id),
        });
        tabs.appendChild(btn);
      }
      if (configGroups.length) {
        tabs.appendChild(ui.button(S.configTab, {
          size: 'sm',
          variant: activePanel === PROVIDER_CONFIG_ROUTE ? 'primary' : 'plain',
          onClick: () => go(PROVIDER_CONFIG_ROUTE),
        }));
      }
      if (prompts.length) {
        tabs.appendChild(ui.button(prompts.length === 1 ? prompts[0]!.title : S.promptsTab, {
          size: 'sm',
          variant: activePanel === PROVIDER_PROMPTS_ROUTE ? 'primary' : 'plain',
          onClick: () => go(PROVIDER_PROMPTS_ROUTE),
        }));
      }
      if (storageKeys.length) {
        tabs.appendChild(ui.button(S.storageTab, {
          size: 'sm',
          variant: activePanel === PROVIDER_STORAGE_ROUTE ? 'primary' : 'plain',
          onClick: () => go(PROVIDER_STORAGE_ROUTE),
        }));
      }
      if (tools) {
        tabs.appendChild(ui.button(S.toolsTab, {
          size: 'sm',
          variant: activePanel === PROVIDER_TOOLS_ROUTE ? 'primary' : 'plain',
          onClick: () => go(PROVIDER_TOOLS_ROUTE),
        }));
      }
      chrome.appendChild(tabs);
    }
  }

  /** 重载前缀后重新读取 manifest 中的漂移状态。 */
  private async reloadPrefix(ui: ReturnType<typeof createConsoleUi>): Promise<void> {
    const ok = await ui.confirm({
      title: S.reloadTitle,
      body: S.reloadBody,
    });
    if (!ok) return;
    try {
      const out = await post<{ result?: string }>('/api/session/reload-prefix');
      ui.toast(out?.result || S.prefixReloaded, 'ok');
      await this.refresh();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), 'bad');
    }
  }

  private appendNote(text: string): void {
    this.ensurePanes().slot.appendChild(this.ui().placeholder(text));
  }

  private renderError(title: string, detail: string): void {
    this.renderErrorInto(this.ensurePanes().slot, title, detail);
  }

  private renderErrorInto(target: HTMLElement, title: string, detail: string): void {
    const ui = this.ui();
    const card = ui.sheet({ title, en: 'panel error' });
    card.body.appendChild(ui.msgline(detail, true));
    target.appendChild(card.el);
  }
}
