/**
 * An operation's error, shown in a popover beside the control that started it until dismissed:
 * the control shakes and the popover follows it while the page scrolls. Long messages scroll
 * inside it. One popover per page; a new error replaces the last.
 */
import { icon } from './icons.ts';
import { S as UI } from './strings.ts';

export interface ProblemPopover { show(anchor: Element, text: string): void; hide(): void }

/** The nearest ancestor that scrolls vertically. */
export function scrollerOf(el: Element | null): HTMLElement | null {
  const win = el?.ownerDocument.defaultView;
  for (let node = el?.parentElement ?? null; node && win; node = node.parentElement) {
    const overflow = win.getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** A wheel event's vertical distance in pixels. */
export function wheelDelta(event: WheelEvent): number {
  return event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (event.view?.innerHeight ?? 800) : 1);
}

export function problemPopover(doc: Document, signal: AbortSignal): ProblemPopover {
  const win = doc.defaultView!;
  const box = doc.createElement('div'); box.className = 'u-tip extension-problem hidden'; box.setAttribute('role', 'alert');
  doc.body.append(box);
  signal.addEventListener('abort', () => box.remove(), { once: true });
  let anchor: Element | null = null;
  const hide = () => { box.classList.add('hidden'); anchor = null; };
  const place = () => {
    if (!anchor?.isConnected) { hide(); return; }
    const target = anchor.getBoundingClientRect(), tip = box.getBoundingClientRect(), view = doc.documentElement;
    const below = target.bottom + 10, above = target.top - tip.height - 10;
    const flip = below + tip.height > view.clientHeight - 8 && above > 8;
    const left = Math.max(8, Math.min(target.right - tip.width + 12, view.clientWidth - tip.width - 8));
    box.classList.toggle('is-above', flip);
    box.style.top = `${Math.max(8, Math.min(flip ? above : below, view.clientHeight - tip.height - 8))}px`; box.style.left = `${left}px`;
    box.style.setProperty('--problem-arrow', `${Math.max(14, Math.min(tip.width - 14, target.left + target.width / 2 - left))}px`);
  };
  box.addEventListener('wheel', event => {
    const message = (event.target as Element).closest('.extension-problem-text');
    if (message && message.scrollHeight > message.clientHeight) return;
    const target = scrollerOf(anchor);
    if (target) { event.preventDefault(); target.scrollBy({ top: wheelDelta(event) }); }
  }, { passive: false, signal });
  doc.addEventListener('pointerdown', event => { if (anchor && !box.contains(event.target as Node) && !anchor.contains(event.target as Node)) hide(); }, { signal });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); }, { signal });
  doc.addEventListener('scroll', () => { if (anchor) place(); }, { capture: true, passive: true, signal });
  win.addEventListener('resize', () => { if (anchor) place(); }, { signal });
  return {
    hide,
    show(target, text) {
      const close = doc.createElement('button'); close.type = 'button'; close.className = 'extension-problem-close';
      close.setAttribute('aria-label', UI.close); close.append(icon(doc, 'close'));
      close.addEventListener('click', hide, { signal });
      const message = doc.createElement('span'); message.className = 'extension-problem-text'; message.textContent = text;
      box.replaceChildren(icon(doc, 'alert', 'icon extension-problem-mark'), message, close);
      anchor = target; box.classList.remove('hidden'); place();
      box.animate?.([{ opacity: 0, transform: 'translateY(-4px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 130, easing: 'ease-out' });
      target.animate?.([0, -5, 5, -3, 2, 0].map(x => ({ transform: `translateX(${x}px)` })), { duration: 290, easing: 'ease-out' });
    },
  };
}
