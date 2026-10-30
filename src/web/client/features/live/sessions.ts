/**
 * session 卡条 —— 控制台页顶上那一排"主意识 + 各 fork"。
 *
 * 一张卡就是一个可点的入口:点谁,时间线就切去看谁。数据来自 `/ws/debug` 的
 * `sessions` 帧;调试通道没挂时由 `/ws/sessions` 顶上(见 `index.ts`)。
 *
 * 排法:`main` 固定在最左;其后是进行中的临时会话,新开的在前;已结束的排在最后,
 * 刚结束的在最末。卡条只占一行、不滚动:放不下的已结束会话直接不画(先舍结束得最早的);
 * 进行中的放不下时,行尾一张「+N」卡,悬停或聚焦时浮出其余几张。卡换位置时滑过去。
 * World 自己上报的用量项(`worlds.<id>`)不在这里画,各 World 在自己的页面交代。
 *
 * 卡面上的 `r-<role>` 是**服务端给的角色字符串**,不是前端认识的名单——各角色的
 * 圆点配色写在 `styles.css` 里,前端这边一个角色名都不写死。
 */

import type { WebUi } from '../../../shared/client-panel.ts';
import type { SessionStat } from './protocol.ts';
import { S } from './strings.ts';
import { overflowPopover } from '../../ui/overflow-popover.ts';
import { prefersStill } from '../../core/motion.ts';

export interface SessionBandDeps {
  ui: WebUi;
  /**
   * 本次挂载的 signal，统一管理卡片监听，unmount 后解除。
   */
  signal: AbortSignal;
  /** 点了某张卡。切不切、怎么切由调用方决定。 */
  onPick(id: string, label: string): void;
}

export interface SessionBand {
  el: HTMLElement;
  /** 重画。`currentId` 决定哪张卡带选中框。 */
  render(sessions: readonly SessionStat[], currentId: string): void;
}

const MAIN_ID = 'main';
/** World 上报用量时 Core 记的仪表项前缀。 */
const WORLD_USAGE_PREFIX = 'worlds.';
/** 与 `.sesscards` 的 gap 一致。 */
const GAP = 6;

const time = (iso: string | null | undefined): number => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : 0;
};

/** main 在前;进行中的按开始时间新的在前;已结束的按结束时间早的在前(刚结束的在最末)。 */
function ordered(sessions: readonly SessionStat[]): SessionStat[] {
  const shown = sessions.filter((s) => !s.id.startsWith(WORLD_USAGE_PREFIX));
  const main = shown.filter((s) => s.id === MAIN_ID);
  const running = shown
    .filter((s) => s.id !== MAIN_ID && s.endedAt == null)
    .sort((a, b) => time(b.startedAt) - time(a.startedAt));
  const ended = shown
    .filter((s) => s.id !== MAIN_ID && s.endedAt != null)
    .sort((a, b) => time(a.endedAt) - time(b.endedAt));
  return [...main, ...running, ...ended];
}

export function createSessionBand(deps: SessionBandDeps): SessionBand {
  const { ui, signal } = deps;
  const el = ui.h('div', 'sesscards');
  el.title = S.sessionBandTitle;
  const doc = el.ownerDocument;
  const view = doc.defaultView;

  /** 卡按 id 复用:同一张卡换位置时才能滑过去。 */
  const cards = new Map<string, HTMLButtonElement>();
  // 「+N」:一张卡样的按钮,浮窗与它并排挂在同一个外框里(卡都是按钮,不能套进按钮)
  const more = ui.h('span', 'sessmore');
  const moreBtn = ui.h('button', 'sesscard sessmore-btn');
  moreBtn.type = 'button';
  moreBtn.setAttribute('aria-haspopup', 'true');
  moreBtn.setAttribute('aria-expanded', 'false');
  const pop = ui.h('div', 'sesspop');
  pop.hidden = true;
  more.append(moreBtn, pop);
  // ── 「+N」的浮窗:悬停或聚焦时出现,离开一会儿后收起 ──
  const popover = overflowPopover({ trigger: moreBtn, pop, parts: [more], content: () => el.closest('.live-sessions') ?? el, signal });
  const setMore = (n: number): void => {
    moreBtn.textContent = `+${n}`;
    moreBtn.setAttribute('aria-label', S.moreSessions(n));
  };

  let list: SessionStat[] = [];
  let currentId = MAIN_ID;

  const fill = (card: HTMLButtonElement, s: SessionStat): void => {
    const running = s.endedAt == null;
    card.className = ['sesscard', running ? 'running' : '', `r-${s.role}`, s.id === currentId ? 'sel' : '']
      .filter((c) => c !== '')
      .join(' ');
    // main 的累计输入与缓存命中率写在顶栏,卡上只留名字;其余会话写缓存命中率与累计输入
    const info = ui.h('span');
    info.appendChild(ui.h('b', null, s.label));
    if (s.id !== MAIN_ID) {
      const cache = s.cacheHitRate == null ? '-' : ui.fmt.percent(s.cacheHitRate);
      info.appendChild(ui.h('span', 'shr', ` ${S.sessionStats(cache, ui.fmt.count(s.promptTokens))}`));
    }
    card.replaceChildren(ui.h('span', 'sdot'), info);
    card.title = S.sessionCardTitle(
      s.label,
      s.id,
      running,
      running ? '' : ui.fmt.clock(s.endedAt),
      s.promptTokens,
      s.completionTokens,
      s.cacheHitTokens,
    );
  };

  const cardOf = (s: SessionStat): HTMLButtonElement => {
    let card = cards.get(s.id);
    if (!card) {
      card = ui.h('button', 'sesscard');
      card.type = 'button';
      const id = s.id;
      card.addEventListener('click', () => {
        const cur = list.find((x) => x.id === id);
        if (cur) deps.onPick(cur.id, cur.label);
        popover.hide();
      }, { signal });
      cards.set(s.id, card);
    }
    fill(card, s);
    return card;
  };

  const reduced = (): boolean => prefersStill(view);

  /** 量出放得下几张,摆好;`animate` 时已在场的卡从旧位置滑到新位置,新来的淡入。 */
  const layout = (animate: boolean): void => {
    const focused = el.contains(doc.activeElement) ? doc.activeElement as HTMLElement : null;
    const before = new Map<string, number>();
    // 只记行里的卡:浮窗里的卡没有可比的位置,从浮窗回到行里的卡按新来的淡入
    if (animate) for (const [id, card] of cards) if (card.parentElement === el) before.set(id, card.getBoundingClientRect().left);

    const all = list.map((s) => ({ s, card: cardOf(s) }));
    let shown: typeof all = [];
    popover.refill(() => {
      // 全部先放进来量宽度
      el.replaceChildren(...all.map((x) => x.card));
      const width = el.clientWidth;
      const w = new Map(all.map((x) => [x.s.id, x.card.offsetWidth]));
      const sum = (items: typeof all): number => items.reduce((n, x) => n + w.get(x.s.id)! + GAP, 0) - (items.length ? GAP : 0);

      const pinned = all.filter((x) => x.s.id === MAIN_ID || x.s.endedAt == null);
      const ended = all.filter((x) => x.s.id !== MAIN_ID && x.s.endedAt != null);
      let hidden: typeof all = [];
      if (sum(pinned) <= width) {
        // 进行中的都放得下:已结束的从刚结束的往前补,补到放不下为止
        const keep: typeof all = [];
        for (let i = ended.length - 1; i >= 0; i--) {
          if (sum([...pinned, ended[i], ...keep]) > width) break;
          keep.unshift(ended[i]);
        }
        shown = [...pinned, ...keep];
      } else {
        // 进行中的放不下:留出「+N」的位置,其余收进浮窗;已结束的一张不画
        setMore(pinned.length);
        el.appendChild(more);
        const moreW = more.offsetWidth + GAP;
        shown = [];
        for (const x of pinned) {
          if (sum([...shown, x]) + moreW > width && shown.length > 0) break;
          shown.push(x);
        }
        hidden = pinned.slice(shown.length);
      }

      el.replaceChildren(...shown.map((x) => x.card));
      if (hidden.length) {
        setMore(hidden.length);
        pop.replaceChildren(...hidden.map((x) => x.card));
        el.appendChild(more);
      } else pop.replaceChildren();
      return hidden.length > 0;
    }, (overflow) => {
      if (focused?.isConnected) focused.focus({ preventScroll: true });
      else if (focused) (overflow ? moreBtn : shown[0]?.card)?.focus({ preventScroll: true });
    });

    // 不再出现的卡丢掉,免得 Map 越积越多
    const live = new Set(list.map((s) => s.id));
    for (const id of [...cards.keys()]) if (!live.has(id)) cards.delete(id);

    if (!animate || reduced()) return;
    for (const x of shown) {
      const from = before.get(x.s.id);
      const to = x.card.getBoundingClientRect().left;
      if (from === undefined) {
        x.card.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      } else if (Math.abs(from - to) > 0.5) {
        x.card.animate?.(
          [{ transform: `translateX(${from - to}px)` }, { transform: 'none' }],
          { duration: 260, easing: 'cubic-bezier(.3, .7, .2, 1)' },
        );
      }
    }
  };

  if (view?.ResizeObserver) {
    let lastWidth = -1;
    const size = new view.ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      layout(false);
    });
    size.observe(el);
    signal.addEventListener('abort', () => size.disconnect(), { once: true });
  }

  return {
    el,
    render(sessions, id) {
      list = ordered(sessions);
      currentId = id;
      layout(true);
    },
  };
}
