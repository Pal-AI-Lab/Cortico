/** 渲染贡献方自报的四态灯；导航、World 总览与页头共用非重叠轮询，隐藏页面跳过取数。 */

import { get } from '../core/api.ts';
import { toDisposable, type Disposable } from '../../shared/client-panel.ts';
import {
  WEBUI_LAMPS_ROUTE,
  type WebUiLamp,
  type WebUiLampsResponse,
} from '../../shared/webui-protocol.ts';
import { h } from './dom.ts';
import { S } from './strings.ts';

/** 灯多久重取一次。它标的是"这一刻"，慢一拍就成了另一个时刻的事实。 */
const LAMP_POLL_MS = 500;

/** state → class。`offline` 不加修饰，就是 `.navdot` 本体那个灰。 */
const LAMP_CLASS: Record<WebUiLamp['state'], string> = {
  online: 'navdot on',
  loading: 'navdot warn',
  error: 'navdot bad',
  offline: 'navdot',
};

/** 悬停时的状态词。 */
const LAMP_WORD: Record<WebUiLamp['state'], string> = {
  online: S.lamp.online,
  loading: S.lamp.loading,
  error: S.lamp.error,
  offline: S.lamp.offline,
};

/**
 * 一颗灯的悬停说明：链路名在最前面。
 *
 * 导航上只有这一处读得到 `label`，所以它必须先回答"这是谁"，再回答"它怎么了"
 * ——一排七个同样大小的点，颜色说得清严重程度，说不清是哪条链路。
 */
function lampTitle(lamp: WebUiLamp): string {
  const head = `${lamp.label} ${LAMP_WORD[lamp.state]}`;
  return lamp.hint ? `${head} · ${lamp.hint}` : head;
}

function paintDot(el: HTMLElement, lamp: WebUiLamp): void {
  el.className = LAMP_CLASS[lamp.state];
  el.title = lampTitle(lamp);
  el.setAttribute('aria-label', el.title);
}

function makeDot(doc: Document, lamp: WebUiLamp): HTMLSpanElement {
  const el = h(doc, 'span', 'navdot');
  el.setAttribute('role', 'img');
  paintDot(el, lamp);
  return el;
}

/**
 * 把一排灯画进既有容器。**空数组就是藏起来的空容器**，不画占位灰点：灰是"这条
 * 链路关着"，拿它当"没报灯"讲，等于替 provider 说了一句它没说过的话。
 *
 * 数目没变就地改颜色，变了才重排子节点——这是每半秒一次的操作，没必要每次重建。
 */
export function paintLamps(host: HTMLElement, lamps: readonly WebUiLamp[]): void {
  const dots = [...host.children] as HTMLElement[];
  if (dots.length === lamps.length) {
    lamps.forEach((lamp, i) => paintDot(dots[i], lamp));
  } else {
    host.replaceChildren(...lamps.map((lamp) => makeDot(host.ownerDocument, lamp)));
  }
  host.hidden = lamps.length === 0;
}

/** 新造一排灯。给不出灯就得到一个藏起来的空容器（之后轮询可以点亮它）。 */
export function lampRow(doc: Document, lamps: readonly WebUiLamp[]): HTMLSpanElement {
  const host = h(doc, 'span', 'navlamps');
  paintLamps(host, lamps);
  return host;
}

// ---------------------------------------------------------------------------
// 取数
// ---------------------------------------------------------------------------

type LampListener = (lamps: Record<string, WebUiLamp[]>) => void;

const listeners = new Set<LampListener>();
let timer: ReturnType<typeof setInterval> | null = null;
let doc: Document | null = null;
/** 是否有尚未完成的轮询请求。 */
let pending = false;

function tick(): void {
  if (pending || doc?.hidden !== false) return; // 后台标签页里没人看那排灯
  pending = true;
  void get<WebUiLampsResponse>(WEBUI_LAMPS_ROUTE)
    .then(
      (out) => {
        const lamps = out?.lamps ?? {};
        for (const cb of [...listeners]) cb(lamps);
      },
      () => { /* 取不到灯不等于灯灭了：留上一拍的读数 */ },
    )
    .finally(() => { pending = false; });
}

/**
 * 订阅状态灯。第一个订阅者把轮询打开，最后一个走掉时关掉——WebUI 整页没有一颗
 * 灯在看的时候，不该还有一个定时器在敲后端。
 *
 * `ownerDoc` 只用来问"页面还看得见吗"，第一个订阅者带进来的那份作数。
 */
export function subscribeLamps(ownerDoc: Document, cb: LampListener): Disposable {
  listeners.add(cb);
  if (timer === null) {
    doc = ownerDoc;
    timer = setInterval(tick, LAMP_POLL_MS);
  }
  return toDisposable(() => {
    listeners.delete(cb);
    if (listeners.size > 0 || timer === null) return;
    clearInterval(timer);
    timer = null;
    doc = null;
    pending = false;
  });
}
