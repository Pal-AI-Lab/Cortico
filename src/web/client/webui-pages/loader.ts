/**
 * 按 manifest URL 懒加载扩展；进行中的加载去重，成功模块缓存，失败允许重试。
 * 浏览器仍可能缓存失败的 ESM URL；重新构建后的内容 hash URL 可避开该缓存。
 * JS 与 CSS URL 均校验清单规定的路径和字符。
 */

import {
  isWebUiClientBundle,
  type WebUiClientBundle,
  type WebUiPanel,
} from '../../shared/client-panel.ts';
import { isSafeAssetUrl, type WebUiAssetEntry } from '../../shared/webui-protocol.ts';
import { S } from './strings.ts';

export interface StyleLink {
  rel: string;
  href: string;
  dataset: { [key: string]: string | undefined };
}

export interface LoaderDeps {
  importModule(url: string): Promise<unknown>;
  /** 注入 `<link rel=stylesheet>` 的宿主（一般是 document.head）。 */
  styleHost: { appendChild(node: unknown): void };
  createLink(): StyleLink;
  log?(message: string, detail?: Record<string, unknown>): void;
}

export class PanelBundleError extends Error {
  readonly pageId: string;
  constructor(pageId: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'PanelBundleError';
    this.pageId = pageId;
    if (cause !== undefined) this.cause = cause;
  }
}

export class WebUiPageLoader {
  private readonly deps: LoaderDeps;
  private readonly loaded = new Map<string, WebUiClientBundle>();
  private readonly inFlight = new Map<string, Promise<WebUiClientBundle>>();
  private readonly styled = new Set<string>();

  constructor(deps: LoaderDeps) {
    this.deps = deps;
  }

  /** 已加载的扩展集合，供核对懒加载行为。 */
  get loadedPages(): string[] {
    return [...this.loaded.keys()];
  }

  async load(pageId: string, asset: WebUiAssetEntry | undefined): Promise<WebUiClientBundle> {
    const cached = this.loaded.get(pageId);
    if (cached) return cached;

    const pending = this.inFlight.get(pageId);
    if (pending) return pending;

    const task = this.loadOnce(pageId, asset);
    this.inFlight.set(pageId, task);
    try {
      const bundle = await task;
      this.loaded.set(pageId, bundle);
      return bundle;
    } finally {
      // 成功与否都要摘掉:失败不缓存,下次可以重来。
      this.inFlight.delete(pageId);
    }
  }

  private async loadOnce(
    pageId: string,
    asset: WebUiAssetEntry | undefined,
  ): Promise<WebUiClientBundle> {
    if (!asset) {
      throw new PanelBundleError(pageId, S.noBundle(pageId));
    }
    if (!isSafeAssetUrl(asset.js)) {
      throw new PanelBundleError(pageId, S.badBundleUrl(pageId));
    }
    let mod: unknown;
    try {
      mod = await this.deps.importModule(asset.js);
    } catch (err) {
      throw new PanelBundleError(pageId, S.bundleLoadFailed(pageId, String(err)), err);
    }

    const candidate = (mod as { default?: unknown } | null)?.default;
    if (!isWebUiClientBundle(candidate)) {
      throw new PanelBundleError(pageId, S.badDefaultExport(pageId));
    }
    // 样式在 js 装成之后再注入:装不上的页不该在页面里留下一个 404 的 link。
    this.injectStyle(pageId, asset);
    return candidate;
  }

  /** 每页样式只注入一次，面板卸载时保留。 */
  private injectStyle(pageId: string, asset: WebUiAssetEntry): void {
    if (!asset.css || this.styled.has(pageId)) return;
    if (!isSafeAssetUrl(asset.css)) {
      this.deps.log?.(`「${pageId}」的样式地址不合法，已跳过`, { href: String(asset.css) });
      return;
    }
    this.styled.add(pageId);
    const link = this.deps.createLink();
    link.rel = 'stylesheet';
    link.href = asset.css;
    link.dataset.provider = pageId;
    this.deps.styleHost.appendChild(link);
  }

  /** 获取声明的面板实现；缺失时错误列出扩展提供的面板键。 */
  async resolvePanel(
    pageId: string,
    panelId: string,
    asset: WebUiAssetEntry | undefined,
  ): Promise<WebUiPanel> {
    const bundle = await this.load(pageId, asset);
    const panel = bundle.panels[panelId];
    // 分别报告键缺失与实现不合法。
    if (!(panelId in bundle.panels)) {
      const known = Object.keys(bundle.panels).join(' / ') || S.none;
      throw new PanelBundleError(pageId, S.noSuchBundlePanel(pageId, panelId, known));
    }
    if (!panel || typeof panel.mount !== 'function') {
      throw new PanelBundleError(pageId, S.badPanelImpl(pageId, panelId));
    }
    return panel;
  }
}
