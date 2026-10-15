/** 操作期间禁用控件，以及复制文本并报告结果。 */

import type {
  WebUiCopyOptions,
  WebUiDisablable,
  Disposable,
} from '../../shared/client-panel.ts';
import { toDisposable } from '../../shared/client-panel.ts';
import { h } from './dom.ts';
import { button } from './sheet.ts';
import type { OverlayEnv } from './overlay.ts';
import { drawer } from './overlay.ts';
import { S } from './strings.ts';

/** 临时禁用控件；dispose 恢复各自原值。重复控件只记录第一次的值。 */
export function disable(els: readonly WebUiDisablable[]): Disposable {
  const saved: { el: { disabled: boolean }; was: boolean }[] = [];
  const seen = new Set<object>();
  for (const el of els) {
    if (!el || seen.has(el)) continue;
    seen.add(el);
    saved.push({ el, was: el.disabled });
    el.disabled = true;
  }
  // toDisposable 自带幂等标志,重复 dispose 不会二次写回
  return toDisposable(() => {
    for (const s of saved) s.el.disabled = s.was;
  });
}

/**
 * 剪贴板从哪儿取。
 *
 * 先问文档自己的 `defaultView`、再退到全局：这个模块不许在顶层引用 `window`
 * （测试跑在 node 里，未来还可能是离屏文档 / iframe——那时候 `globalThis` 上的
 * 那个根本不是这份文档的窗口）。
 */
function navigatorOf(doc: Document): Navigator | null {
  return doc.defaultView?.navigator ?? (globalThis as { navigator?: Navigator }).navigator ?? null;
}

/** Clipboard API 不可用或失败时，使用可聚焦的离屏 textarea 与 execCommand 复制。 */
function execCopy(env: OverlayEnv, value: string): boolean {
  const doc = env.doc as Document & { execCommand?: (cmd: string) => boolean };
  if (typeof doc.execCommand !== 'function') return false;
  const ta = h(doc, 'textarea');
  ta.value = value;
  // 必须真的在 DOM 里、且可聚焦,才选得中;挪到屏外并透明化是为了不闪一下
  ta.setAttribute('style', 'position:fixed;top:0;left:-9999px;opacity:0');
  env.host.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** 两条路依次试。都不通给 false，由调用方去出声。 */
async function writeClipboard(env: OverlayEnv, value: string): Promise<boolean> {
  const nav = navigatorOf(env.doc);
  const clip = nav?.clipboard as Clipboard | undefined;
  if (typeof clip?.writeText === 'function') {
    try {
      await clip.writeText(value);
      return true;
    } catch {
      // 权限被拒 / 文档没聚焦:掉到降级路线,别在这儿就放弃
    }
  }
  return execCopy(env, value);
}

/** 函数形式的文本在点击时读取；show 使用所属 UI 实例的单条 toast。 */
export function copyButton(
  env: OverlayEnv,
  show: (text: string, tone?: 'ok' | 'bad') => void,
  text: string | (() => string),
  opts?: WebUiCopyOptions,
): HTMLButtonElement {
  const o = opts ?? {};
  const label = o.label ?? S.copy;
  const run = async (): Promise<void> => {
    let value: string;
    try {
      value = typeof text === 'function' ? text() : text;
    } catch {
      // 惰性取值自己炸了(那串值背后的对象已经没了):照样出声,别静默
      show(S.copyNothing, 'bad');
      return;
    }
    if (await writeClipboard(env, value)) {
      show(o.okText ?? S.copied, 'ok');
      return;
    }
    // 两种复制方式均失败时展示文本，供手动选取。
    show(S.copyFailed, 'bad');
    drawer(env, label, value);
  };

  return button(env.doc, env.signal, label, {
    size: o.size ?? 'sm',
    variant: o.variant,
    onClick: () => void run(),
  });
}
