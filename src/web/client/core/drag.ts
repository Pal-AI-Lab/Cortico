/**
 * Reordering a list by dragging, with the pointer rather than the browser's drag and drop, which always
 * shows its cursor and a faint snapshot of the element and does not scroll the list. The pressed
 * element lifts out as a copy that follows the pointer up and down with the pointer itself hidden, and
 * stays behind as an empty place the list moves to where it would land (see moveGap). Near the list's
 * top or bottom the list scrolls. Esc, a cancelled pointer or the window losing focus cancels; a drag
 * the page is left in the middle of just ends, so the pointer shows again. The list decides where things
 * land and what a drop means.
 */
import { prefersStill } from './motion.ts';

export interface DragListOptions {
  /** The element a press on `target` lifts, or null when this press does not drag (a control, a filtered view). */
  pick(target: HTMLElement): HTMLElement | null;
  /** Called once the press has moved far enough to be a drag. */
  lifted?(el: HTMLElement): void;
  /** Where a drop at viewport `y` would land: called on every move and every scroll step. */
  locate(y: number): void;
  /** The drop. The copy is gone by now; `copyTop` is where it showed, to slide the element in from. */
  drop(el: HTMLElement, copyTop: number): void;
  /** A drag that ended without a drop (Esc, a cancelled pointer, the window losing focus). */
  cancel(): void;
  /** The positioned box the copy is laid in; the copy stays inside its content, so the list cannot grow under it. */
  layer: HTMLElement;
  /** The list that scrolls while the pointer is near its top or bottom. Give it overflow-anchor: none, or moving the gap scrolls it. */
  scroller: HTMLElement;
  /** The copy's class, for its look. */
  copyClass: string;
}

const DRAG_SLOP = 4, SCROLL_EDGE = 56, SCROLL_MAX = 18;

export function dragList(root: HTMLElement, opts: DragListOptions, signal: AbortSignal): void {
  const doc = root.ownerDocument, win = doc.defaultView!;
  let press: { id: number; x: number; y: number; source: HTMLElement; el: HTMLElement } | undefined;
  let lift: { el: HTMLElement; copy: HTMLElement; offset: number; limit: number; y: number; frame?: number } | undefined;
  root.addEventListener('pointerdown', event => {
    if (event.button !== 0 || lift) return;
    const source = event.target as HTMLElement, el = opts.pick(source);
    if (el) press = { id: event.pointerId, x: event.clientX, y: event.clientY, source, el };
  }, { signal });
  // An image inside would start the browser's own drag, which cancels this one.
  root.addEventListener('dragstart', event => { if (press) event.preventDefault(); }, { signal });
  function start(event: PointerEvent) {
    const { el, source } = press!, box = el.getBoundingClientRect();
    const copy = el.cloneNode(true) as HTMLElement;
    copy.classList.add(opts.copyClass); copy.inert = true; copy.setAttribute('aria-hidden', 'true');
    copy.style.width = `${box.width}px`; copy.style.height = `${box.height}px`;
    // The layer's content as it is now: a copy below it would lengthen it, and the list would scroll on.
    const limit = opts.layer.scrollHeight;
    opts.layer.append(copy);
    lift = { el, copy, offset: press!.y - box.top, limit, y: event.clientY };
    el.classList.add('is-dragging'); doc.documentElement.classList.add('is-list-dragging');
    win.getSelection()?.removeAllRanges();
    opts.lifted?.(el);
    // Keeps the moves coming when the pointer leaves the window; a pointer the browser no longer tracks cannot be captured.
    try { source.setPointerCapture?.(event.pointerId); } catch { /* The drag goes on without capture. */ }
  }
  /** Keeps the copy under the pointer, the list scrolled or not, inside the layer's content. */
  function place() {
    if (!lift) return;
    const top = lift.y - lift.offset - opts.layer.getBoundingClientRect().top + opts.layer.scrollTop;
    lift.copy.style.top = `${Math.max(0, Math.min(top, lift.limit - lift.copy.offsetHeight))}px`;
  }
  /** Scrolls the list while the pointer is near its top or bottom, faster the nearer it is. */
  function scroll() {
    if (!lift) return;
    lift.frame = undefined;
    const box = opts.scroller.getBoundingClientRect(), y = lift.y;
    const depth = y < box.top + SCROLL_EDGE ? y - box.top - SCROLL_EDGE : y > box.bottom - SCROLL_EDGE ? y - box.bottom + SCROLL_EDGE : 0;
    if (!depth) return;
    const was = opts.scroller.scrollTop;
    opts.scroller.scrollTop += Math.sign(depth) * Math.max(1, Math.min(SCROLL_MAX, Math.abs(depth) / SCROLL_EDGE * SCROLL_MAX));
    if (opts.scroller.scrollTop === was) return;
    opts.locate(y); place();
    lift.frame = win.requestAnimationFrame(scroll);
  }
  win.addEventListener('pointermove', event => {
    if (!press || event.pointerId !== press.id) return;
    if (!lift) { if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_SLOP) return; start(event); }
    event.preventDefault();
    // Placed after the list has moved its gap, which may have shifted what it scrolls over.
    lift!.y = event.clientY; opts.locate(event.clientY); place();
    if (lift!.frame === undefined) lift!.frame = win.requestAnimationFrame(scroll);
  }, { signal });
  win.addEventListener('pointerup', event => {
    if (!press || event.pointerId !== press.id) return;
    press = undefined;
    if (!lift) return;
    // The click that follows a drag, in the same turn, is the drop, not a click on the element.
    const swallow = (stop: Event) => { stop.stopPropagation(); stop.preventDefault(); };
    win.addEventListener('click', swallow, { capture: true, once: true, signal });
    win.setTimeout(() => win.removeEventListener('click', swallow, { capture: true }), 0);
    const { el, copy } = lift, top = copy.getBoundingClientRect().top;
    end(); opts.drop(el, top);
  }, { signal });
  const abandon = () => { press = undefined; if (lift) { end(); opts.cancel(); } };
  win.addEventListener('pointercancel', event => { if (press && event.pointerId === press.id) abandon(); }, { signal });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && lift) abandon(); }, { signal });
  win.addEventListener('blur', abandon, { signal });
  signal.addEventListener('abort', () => { press = undefined; end(); }, { once: true });
  function end() {
    if (!lift) return;
    if (lift.frame !== undefined) win.cancelAnimationFrame(lift.frame);
    lift.copy.remove(); lift.el.classList.remove('is-dragging'); lift = undefined;
    doc.documentElement.classList.remove('is-list-dragging');
  }
}

/** An element's box without the slide it may be in the middle of, so a drop target does not chase the animation. */
export function settledBox(el: HTMLElement): { top: number; bottom: number; height: number } {
  const win = el.ownerDocument.defaultView!, box = el.getBoundingClientRect(), transform = win.getComputedStyle(el).transform;
  const shift = transform && transform !== 'none' && win.DOMMatrixReadOnly ? new win.DOMMatrixReadOnly(transform).m42 : 0;
  return { top: box.top - shift, bottom: box.bottom - shift, height: box.height };
}

/** Moves the dragged element's empty place to `next` in `parent`; the `moving` elements it passes slide aside. */
export function moveGap(gap: HTMLElement, parent: HTMLElement, next: Element | null, moving: readonly HTMLElement[]): void {
  if (next === gap || (gap.parentElement === parent && gap.nextElementSibling === next)) return;
  const others = moving.filter(el => !gap.contains(el));
  // Each starts from where it shows now, mid-slide or not.
  const from = new Map(others.map(el => [el, el.getBoundingClientRect().top]));
  for (const el of others) for (const running of el.getAnimations?.() ?? []) if (running.id === 'drag-shift') running.cancel();
  parent.insertBefore(gap, next);
  if (prefersStill(gap.ownerDocument.defaultView)) return;
  for (const [el, top] of from) {
    const delta = top - el.getBoundingClientRect().top;
    if (Math.abs(delta) > .5) el.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { id: 'drag-shift', duration: 180, easing: 'cubic-bezier(.32,.72,0,1)' });
  }
}
