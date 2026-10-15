/** 有行数上限的滚动日志；超出时删除最早行。仅在贴底时随新增内容滚动，上翻后暂停，返回底部后恢复。 */

import type {
  WebUiLog,
  WebUiLogOptions,
  WebUiLogTone,
} from '../../shared/client-panel.ts';
import { h } from './dom.ts';

/** 缺省上限。四百行足够翻一阵子，又不至于让布局开始喘。 */
const LOG_MAX_LINES = 400;

/** 缺省的粘滞容差（像素）。 */
export const LOG_STICK_PX = 24;

/** 缺省高度。给了限高才会滚，粘滞也才有意义。 */
const LOG_MAX_HEIGHT = '240px';

/** scrollTop 可能含小数，使用容差判断是否贴底。未溢出或缺少有效读数时返回 true；负容差按 0 处理。 */
export function shouldStick(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = LOG_STICK_PX,
): boolean {
  const rest = scrollHeight - clientHeight - scrollTop;
  if (!Number.isFinite(rest)) return true;
  return rest <= Math.max(0, threshold);
}

/** tone → class。`plain` 与不给一样落中性 `.logline`。 */
function lineClass(tone?: WebUiLogTone): string {
  return tone && tone !== 'plain' ? 'logline ' + tone : 'logline';
}

export function log(doc: Document, signal: AbortSignal, opts?: WebUiLogOptions): WebUiLog {
  const o = opts ?? {};
  const max = Math.max(1, Math.floor(o.max ?? LOG_MAX_LINES));
  const threshold = o.stickThreshold ?? LOG_STICK_PX;
  const el = h(doc, 'div', o.variant === 'conversation' ? 'logview conversation' : 'logview');
  el.setAttribute('style', 'max-height:' + (o.maxHeight ?? LOG_MAX_HEIGHT));

  // 空态是一个独立节点、且在第一行进来时就摘掉:留着它当孩子的话,环形裁剪
  // 从头摘的第一个就是它,行数从此少算一行。
  let empty: HTMLElement | null = null;
  const showEmpty = (): void => {
    if (!o.empty || empty) return;
    empty = h(doc, 'div', 'placeholder', o.empty);
    el.appendChild(empty);
  };
  const hideEmpty = (): void => {
    empty?.remove();
    empty = null;
  };
  showEmpty();

  // 初值 true:刚建出来的日志本来就在底部,第一批行必须跟着走
  let stuck = true;
  const scrollToEnd = (): void => {
    el.scrollTop = el.scrollHeight;
    stuck = true;
  };
  // 唯一的一条监听,随面板 signal 摘。程序化地设 scrollTop 也会派发 scroll,
  // 那一发照样走这里重算——算出来仍是"贴着底",所以不必特意去屏蔽它。
  el.addEventListener(
    'scroll',
    () => {
      stuck = shouldStick(el.scrollTop, el.scrollHeight, el.clientHeight, threshold);
    },
    { signal },
  );

  return {
    el,
    append(line, tone) {
      hideEmpty();
      const row = h(doc, 'div', lineClass(tone), line);
      el.appendChild(row);
      while (el.children.length > max) el.children[0].remove();
      if (stuck) scrollToEnd();
      return row;
    },
    clear() {
      while (el.children.length) el.children[0].remove();
      empty = null;
      showEmpty();
      // 清空之后重新粘住:一个空的日志框谈不上"用户正在往上翻"
      stuck = true;
    },
    get count(): number {
      return empty ? 0 : el.children.length;
    },
    get stuck(): boolean {
      return stuck;
    },
    scrollToEnd,
  };
}
