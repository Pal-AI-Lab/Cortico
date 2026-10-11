/**
 * QQ World 的浏览器扩展 —— 接入门 / 监听名单 / 事件三个面板。
 *
 * 这个文件只做两件事:**装配**(把三个面板接到局部 id 上)与**共享 helper**
 * (三个面板都要的取数—渲染骨架、类型、错误措辞)。面板本体各在自己的文件里。
 *
 * 与外界的依赖只有一条:`client-panel.ts` 里的**类型**。没有 import 控制台内部
 * 模块,没有 `fetch`,没有 `document.body`,没有 `window.__*`——数据面一律走
 * `ctx.invoke`,DOM 一律用 `ctx.ui` 的原语,定时器一律走 `ctx.interval`。
 *
 * `style.css` 是本 provider 自己的样式:只放 `ctx.ui` 没有对应原语的那几块布局
 * (名单卡片的网格、字段标签),用 `qq-` 前缀避开控制台的通用 class,
 * 变量取自控制台的主题变量,所以浅深色两套皮都跟着走。
 */

import type {
  ConsoleClientBundle,
  ConsolePanelContext,
} from '../../../web/shared/client-panel.ts';
import './style.css';
import { gatePanel } from './gate.ts';
import { rosterPanel } from './roster.ts';
import { eventsPanel } from './events.ts';

// ---------------------------------------------------------------------------
// 共享类型:服务端 `QQWorld.invokePanel` 各方法的返回形状
// ---------------------------------------------------------------------------

/** `gate.state` */
export interface QQGateState {
  enabled: boolean;
  wsUrl: string;
  tokenSet: boolean;
  connected: boolean;
  selfId: number | null;
  nickname: string;
  groups: QQGroupName[];
  privates: QQPrivateName[];
}

interface QQGroupName {
  id: number;
  name: string;
  card: string;
}

interface QQPrivateName {
  id: number;
  name: string;
}

/** `roster.names` / `events.names`:号码 → 人看得懂的名字 */
export interface QQConvNames {
  groups: QQGroupName[];
  privates: QQPrivateName[];
}

/** `roster.get` 的一条。关掉的条目仍留在名单里,只是不进监听集合。 */
export interface QQRosterEntry {
  id: number;
  enabled: boolean;
}

export interface QQRoster {
  groups: QQRosterEntry[];
  privates: QQRosterEntry[];
}

// ---------------------------------------------------------------------------
// 共享 helper
// ---------------------------------------------------------------------------

/** 错误 → 一句人话。`ConsoleInvokeError` 带的是服务端按界面语言给的措辞。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface AutoloadOptions<T> {
  /** 取数期间铺的空态措辞 */
  loading: string;
  /** 取数失败时空态的前半句,后面接错误原文 */
  failed: string;
  load(): Promise<T>;
  /**
   * 画出来。`reload` 重跑一遍取数与渲染——面板改完自己的状态之后调它,
   * 而不是去重挂面板(那会连同定时器与滚动位置一起重来)。
   */
  render(data: T, reload: () => void): Node[];
}

/**
 * 三个面板共用的取数—渲染骨架：空态 → 取数 → 渲染或错误空态。
 * 请求代号防止晚到的旧响应覆盖新响应；unmount 后到达的异步拒绝不再写 DOM。
 */
export function autoload<T>(ctx: ConsolePanelContext, opts: AutoloadOptions<T>): void {
  const { ui, root } = ctx;
  let generation = 0;
  const run = (): void => {
    const gen = ++generation;
    root.replaceChildren(ui.placeholder(opts.loading));
    void opts.load().then(
      (data) => {
        if (gen !== generation || ctx.signal.aborted) return;
        root.replaceChildren(...opts.render(data, run));
      },
      (err: unknown) => {
        if (gen !== generation || ctx.signal.aborted) return;
        root.replaceChildren(ui.placeholder(`${opts.failed}: ${errText(err)}`));
      },
    );
  };
  run();
}

// ---------------------------------------------------------------------------

const bundle: ConsoleClientBundle = {
  // 键是**局部** panel id,与服务端 `console().panels[].id` 一一对应。
  panels: {
    gate: gatePanel,
    roster: rosterPanel,
    events: eventsPanel,
  },
};

export default bundle;
