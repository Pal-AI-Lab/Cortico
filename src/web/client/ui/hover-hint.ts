/**
 * Hover hints. A plain `title` would bring up the system's own tooltip; instead the hint moves to
 * `data-tip` the first time the pointer reaches it and shows a moment later in the console's box
 * (`.u-tip`): under the element, or above it when there is no room below. A title set again later
 * replaces the hint the next time.
 */
const DELAY_MS = 450;
const EDGE = 8;

/** Moves the element's title into `data-tip`, keeping what it told a screen reader; returns the hint. */
function takeTitle(el: HTMLElement): string {
  const title = el.getAttribute('title');
  if (title !== null) {
    el.removeAttribute('title');
    if (title) {
      el.dataset.tip = title;
      // A title named an element with nothing else to name it, and described one that had.
      if (!el.hasAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title);
      else if (!el.hasAttribute('aria-description') && el.getAttribute('aria-label') !== title) el.setAttribute('aria-description', title);
    } else delete el.dataset.tip;
  }
  return el.dataset.tip ?? '';
}

export function mountHoverHints(doc: Document, signal: AbortSignal): void {
  const win = doc.defaultView!;
  const box = doc.createElement('div');
  box.className = 'u-tip hover-hint hidden';
  box.setAttribute('aria-hidden', 'true');
  doc.body.append(box);
  let current: HTMLElement | null = null;
  let timer = 0;

  const hide = (): void => { win.clearTimeout(timer); current = null; box.classList.add('hidden'); };
  const show = (el: HTMLElement, text: string): void => {
    if (!el.isConnected) return;
    box.textContent = text;
    box.classList.remove('hidden');
    const rect = el.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = box;
    const below = rect.bottom + 6;
    box.style.top = `${below + height > win.innerHeight - EDGE ? Math.max(EDGE, rect.top - 6 - height) : below}px`;
    box.style.left = `${Math.max(EDGE, Math.min(win.innerWidth - width - EDGE, rect.left + rect.width / 2 - width / 2))}px`;
  };

  doc.addEventListener('pointerover', (event) => {
    const el = (event.target as Element).closest?.<HTMLElement>('[title], [data-tip]');
    if (el === current) return;
    hide();
    if (!el || el instanceof HTMLIFrameElement) return;
    const text = takeTitle(el);
    if (!text) return;
    current = el;
    timer = win.setTimeout(() => show(el, text), DELAY_MS);
  }, { signal });
  doc.addEventListener('pointerout', (event) => {
    if (current && !current.contains(event.relatedTarget as Node | null)) hide();
  }, { signal });
  for (const type of ['pointerdown', 'keydown', 'wheel'] as const) doc.addEventListener(type, hide, { capture: true, signal });
  doc.addEventListener('scroll', hide, { capture: true, passive: true, signal });
  win.addEventListener('blur', hide, { signal });
  signal.addEventListener('abort', () => { win.clearTimeout(timer); box.remove(); }, { once: true });
}
