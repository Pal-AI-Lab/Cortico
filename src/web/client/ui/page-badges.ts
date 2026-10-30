/** One line of page badges; overflow remains available on hover, focus and click. */
import { overflowPopover } from './overflow-popover.ts';

export function pageBadges(doc: Document, overlayHost: HTMLElement, signal: AbortSignal, badges: readonly HTMLElement[]): HTMLElement {
  const view = doc.defaultView!;
  const row = doc.createElement('div');
  row.className = 'pagedesc page-badge-row';
  row.tabIndex = -1;
  const more = doc.createElement('button');
  more.type = 'button';
  more.className = 'pill page-badge-more';
  more.setAttribute('aria-expanded', 'false');
  const pop = doc.createElement('div');
  pop.className = 'page-badge-pop';
  // one page header at a time
  pop.id = 'page-badges-pop';
  pop.setAttribute('role', 'tooltip');
  pop.tabIndex = -1;
  pop.hidden = true;
  more.setAttribute('aria-describedby', pop.id);
  overlayHost.append(pop);
  const popover = overflowPopover({ trigger: more, pop, parts: [more, pop], content: () => row, signal });
  more.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); popover.show(); pop.focus({ preventScroll: true }); }
  }, { signal });
  doc.addEventListener('scroll', () => { if (!pop.hidden) popover.show(); }, { capture: true, signal });

  const layout = (): void => {
    if (!row.isConnected) return;
    const focused = doc.activeElement === more || pop.contains(doc.activeElement) ? doc.activeElement as HTMLElement : null;
    popover.refill(() => {
      row.replaceChildren(...badges);
      pop.replaceChildren();
      const width = row.clientWidth;
      const gap = parseFloat(view.getComputedStyle(row).columnGap) || 0;
      const widths = badges.map(b => b.getBoundingClientRect().width);
      let used = widths.reduce((sum, w) => sum + w, 0) + Math.max(0, badges.length - 1) * gap;
      if (used <= width) return false;
      row.append(more);
      let count = badges.length;
      do {
        count--;
        used -= widths[count] + (count ? gap : 0);
        more.textContent = `+${badges.length - count}`;
      } while (count > 0 && used + gap + more.getBoundingClientRect().width > width);
      row.replaceChildren(...badges.slice(0, count), more);
      pop.replaceChildren(...badges.slice(count));
      return true;
    }, overflow => (overflow ? focused : focused && row)?.focus({ preventScroll: true }));
  };
  row.append(...badges);
  // the observer's first callback lays the row out; a web font arriving later changes the badges' widths but not the row's
  const resize = view.ResizeObserver ? new view.ResizeObserver(layout) : null;
  resize?.observe(row);
  void doc.fonts?.ready.then(() => { if (!signal.aborted) layout(); });
  signal.addEventListener('abort', () => {
    resize?.disconnect();
    pop.remove();
  }, { once: true });
  return row;
}
