/**
 * Framework Feature 是随控制台内核打包的页面，可调用框架端点。
 * 控制台页扩展经 manifest 动态加载，使用仅开放本面板能力的 ConsolePanelContext。
 * 两种上下文共享挂载生命周期：mount 创建 Lifecycle，离开时 abort 并 dispose。
 */

import type { ConsoleUi, Disposable } from '../../shared/client-panel.ts';
import type { Lifecycle } from '../core/lifecycle.ts';
import type { Route, Router } from '../core/router.ts';
import type { ConsolePageHost } from '../console-pages/host.ts';
import type { ConsoleIconName } from '../ui/icons.ts';

/** 嵌在框架页里的控制台页宿主:manifest 与面板加载都由它管,页面只给容器与路由前缀。 */
export type EmbeddedConsolePageHost = Pick<ConsolePageHost, 'load' | 'show' | 'unmount' | 'pages' | 'find'>;

export interface FeatureContext {
  /** 本页面的 DOM 根。离开时由 host 清空。 */
  readonly root: HTMLElement;
  /** 本次挂载的资源账本。`signal` / `interval` / `frame` / `own` 都从它拿。 */
  readonly lifecycle: Lifecycle;
  /** 等价于 `lifecycle.signal`，因为绝大多数用法只要这一个。 */
  readonly signal: AbortSignal;
  /** UI 原语，已绑本次挂载的 signal。 */
  readonly ui: ConsoleUi;
  /** 路由。跳转与离开拦截都经它，feature 不碰 `location.hash`。 */
  readonly router: Router;
  /** 进入本页时的路由（子页签靠 `segments[1]` 之类区分）。 */
  readonly route: Route;
  /**
   * /api/capabilities 提供的框架能力挂载情况；未挂载能力不渲染。
   */
  readonly capabilities: Record<string, boolean>;
  /** 出错上报。feature 不自己 `console.error`。 */
  onError(err: unknown): void;
  /**
   * 在本页的某个容器里挂另一页的面板。`route` 给出面板页签该指向的路由,
   * 所以页签切换留在本页内。只有内核装配的页面拿得到;缺席时页面只能给出入口链接。
   */
  consolePageHost?(opts: {
    root: HTMLElement;
    route(pageId: string, panelId: string): readonly string[];
  }): EmbeddedConsolePageHost;
  /**
   * 重取控制台页清单并重排左栏，不动当前页。激活/停用 World 这类会改清单的
   * 操作成功后调用。缺席时左栏保持旧清单。
   */
  refreshNav?(): Promise<void>;
}

export type FrameworkFeature = {
  /**
   * 路由第一段。`provider` **是保留字**（那一段归控制台页宿主），
   * 其余由各 feature 认领，不得重复。
   */
  readonly route: string;
  /** 左栏显示名。 */
  readonly label: string;
  /** 左栏图标。 World 那一页不走此字段。 */
  readonly icon?: ConsoleIconName;
  /** 这一行那盏灯在灯表里的键。省略就不点灯。 */
  readonly lampId?: string;
  /** 列出的 capability 任一已挂载即显示导航项；省略或为空时始终显示。 */
  readonly needsAny?: readonly string[];
  /**
   * 渲染。返回的 `Disposable` 在离开时被调用；用 `ctx.lifecycle` 登记过的
   * 不必再返回。抛错只让这一页变成错误卡，不波及框架其余部分。
   */
  mount(ctx: FeatureContext): void | Disposable | Promise<void | Disposable>;
} & (
  | {
      /** 带标题的常规分组；省略 navMode 时同样按分组显示。 */
      readonly navMode?: 'group';
      /** 相同值的页面共享一个导航区。 */
      readonly navGroup: string;
    }
  | {
      /**
       * primary 是独立一级入口；world-root 是 World 实例树入口；persona 排进 Persona & Memory 组,
       * 在贡献的页之后；hidden 只保留路由。
       */
      readonly navMode: 'primary' | 'world-root' | 'persona' | 'hidden';
      readonly navGroup?: string;
    }
);

/** `needsAny` 里任一 capability 已挂载,或根本没有要求。 */
export function featureAvailable(
  feature: FrameworkFeature,
  capabilities: Record<string, boolean>,
): boolean {
  const wanted = feature.needsAny ?? [];
  return wanted.length === 0 || wanted.some((k) => capabilities[k] === true);
}
