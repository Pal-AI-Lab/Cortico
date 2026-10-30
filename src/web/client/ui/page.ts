import type { WebUi } from '../../shared/client-panel.ts';

/** A page's heading: the title, the description under it when there is one, and the page's own controls at the right of the title row. */
export function pageIntro(ui: Pick<WebUi, 'h'>, title: string, description?: string, actions?: readonly HTMLElement[]): HTMLElement {
  const intro = ui.h('header', 'featureintro');
  intro.appendChild(ui.h('h1', 'pagetitle', title));
  if (description) intro.appendChild(ui.h('p', 'pagedesc', description));
  if (actions?.length) {
    const acts = ui.h('div', 'introacts');
    acts.append(...actions);
    intro.appendChild(acts);
  }
  return intro;
}

/** Keep native scroll tracks and focused content below the slot's sticky controls. */
export function watchPageScrollInset(slot: HTMLElement, signal: AbortSignal): void {
  const view = slot.ownerDocument.defaultView;
  if (!view?.ResizeObserver) return;
  let controls: Element[] = [];
  const place = (): void => {
    const top = slot.getBoundingClientRect().top;
    const inset = Math.max(0, ...controls.map(control => control.getBoundingClientRect().bottom - top));
    const value = inset + 'px';
    if (slot.style.getPropertyValue('--page-scroll-inset') !== value) slot.style.setProperty('--page-scroll-inset', value);
  };
  const size = new view.ResizeObserver(place);
  const refresh = (): void => {
    size.disconnect();
    controls = Array.from(slot.children).filter(child => view.getComputedStyle(child).position === 'sticky');
    for (const child of slot.children) size.observe(child);
    place();
  };
  const children = new view.MutationObserver(refresh);
  children.observe(slot, { childList: true });
  slot.addEventListener('scroll', place, { passive: true, signal });
  refresh();
  signal.addEventListener('abort', () => {
    children.disconnect();
    size.disconnect();
    slot.style.removeProperty('--page-scroll-inset');
  }, { once: true });
}
