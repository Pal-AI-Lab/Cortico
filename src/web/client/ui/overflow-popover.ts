/** Align an overflow popup to its trigger, within the owning content row. */
export function placeOverflowPopover(pop: HTMLElement, anchor: HTMLElement, content: Element): void {
  const view = pop.ownerDocument.defaultView!;
  const bounds = content.getBoundingClientRect();
  const trigger = anchor.getBoundingClientRect();
  const left = Math.max(8, bounds.left);
  const right = Math.min(view.innerWidth - 8, bounds.right);
  pop.style.maxWidth = Math.min(360, Math.max(0, right - left)) + 'px';
  const below = Math.max(0, view.innerHeight - trigger.bottom - 14);
  const above = Math.max(0, trigger.top - 14);
  pop.style.maxHeight = Math.max(below, above) + 'px';
  const placeAbove = pop.scrollHeight > below && above > below;
  pop.style.maxHeight = (placeAbove ? above : below) + 'px';
  const rect = pop.getBoundingClientRect();
  pop.style.left = Math.max(left, Math.min(trigger.right, right) - rect.width) + 'px';
  pop.style.top = Math.max(8, placeAbove ? trigger.top - rect.height - 6 : trigger.bottom + 6) + 'px';
}

export interface OverflowPopover {
  show(): void;
  hide(): void;
  /**
   * Runs `rebuild`, which refills the trigger's row and the popup and returns whether anything overflows; the popup
   * then ends open or closed as before, at the same scroll position. `refocus` puts focus back in between, while an
   * open popup's contents can take it (focusing the trigger opens the popup).
   */
  refill(rebuild: () => boolean, refocus: (overflow: boolean) => void): void;
}

/**
 * Opens `pop` on hover, focus or a click on `trigger`, and closes it 180 ms after the pointer leaves `parts` with focus
 * outside them, when focus leaves them, on a press outside them and on Escape. `parts` are the elements pointer and
 * focus move between without closing it; `content` is the row it stays within.
 */
export function overflowPopover(opts: {
  trigger: HTMLElement;
  pop: HTMLElement;
  parts: readonly HTMLElement[];
  content: () => Element;
  signal: AbortSignal;
}): OverflowPopover {
  const { trigger, pop, parts, signal } = opts;
  const doc = pop.ownerDocument;
  const inside = (node: Node | null): boolean => parts.some(part => part.contains(node));
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const hide = (): void => {
    clearTimeout(hideTimer);
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };
  const show = (): void => {
    clearTimeout(hideTimer);
    pop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    placeOverflowPopover(pop, trigger, opts.content());
  };
  const hideSoon = (): void => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!inside(doc.activeElement)) hide(); }, 180);
  };
  for (const part of parts) {
    part.addEventListener('mouseenter', show, { signal });
    part.addEventListener('mouseleave', hideSoon, { signal });
    part.addEventListener('focusin', show, { signal });
    part.addEventListener('focusout', event => { if (!inside(event.relatedTarget as Node | null)) hide(); }, { signal });
  }
  trigger.addEventListener('click', show, { signal });
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || pop.hidden) return;
    if (inside(doc.activeElement)) trigger.focus({ preventScroll: true });
    hide();
  }, { signal });
  doc.addEventListener('pointerdown', event => { if (!inside(event.target as Node)) hide(); }, { signal });
  doc.defaultView!.addEventListener('resize', () => { if (!pop.hidden) show(); }, { signal });
  signal.addEventListener('abort', () => clearTimeout(hideTimer), { once: true });
  return {
    show,
    hide,
    refill(rebuild, refocus) {
      const wasOpen = !pop.hidden;
      const scrollTop = pop.scrollTop;
      const overflow = rebuild();
      if (wasOpen && overflow) show();
      refocus(overflow);
      if (!wasOpen || !overflow) hide();
      pop.scrollTop = scrollTop;
    },
  };
}
