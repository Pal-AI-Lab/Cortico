/**
 * Page tabs switch between the views of one page; a choice among options inside a view stays `ui.segmented`.
 *
 * The line is the bar's `::after`, placed through `--tab-x` / `--tab-y` / `--tab-w`; the bar carries `data-line` while a
 * current label is laid out. `ready` slides within a row; `appear` reveals the line after a row change.
 * A page may append its own controls (a status line, a button) to `el` after the tabs.
 */

export interface PageTabItem {
  value: string;
  label: string;
}

export interface PageTabs {
  el: HTMLElement;
  setValue(value: string): void;
}

export function pageTabs(
  doc: Document,
  signal: AbortSignal,
  items: readonly PageTabItem[],
  opts: { value?: string; onSelect?(value: string): void } = {},
): PageTabs {
  const el = doc.createElement('nav');
  el.className = 'pagetabs';
  const tabs: Array<{ value: string; btn: HTMLButtonElement; text: HTMLSpanElement }> = [];
  let current = opts.value ?? '';
  for (const item of items) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'pagetab';
    // the label at its current-tab size and weight, invisible, holds the width: a switch does not shift the bar
    btn.dataset.label = item.label;
    const text = doc.createElement('span');
    text.textContent = item.label;
    btn.appendChild(text);
    // the caller moves the highlight with setValue once the switch went through: a leave guard may refuse it
    btn.addEventListener('click', () => {
      if (current !== item.value) opts.onSelect?.(item.value);
    }, { signal });
    el.appendChild(btn);
    tabs.push({ value: item.value, btn, text });
  }

  let line: { x: number; y: number; width: number } | undefined;
  let frame = 0;
  const place = (): void => {
    const text = tabs.find((t) => t.value === current)?.text;
    if (!text?.offsetWidth) {
      el.removeAttribute('data-line');
      line = undefined;
      return;
    }
    const next = { x: text.offsetLeft, y: text.offsetTop + text.offsetHeight + 6, width: text.offsetWidth };
    if (line && next.x === line.x && next.y === line.y && next.width === line.width) return;
    const changesRow = line && Math.abs(next.y - line.y) > 1;
    if (changesRow) {
      el.setAttribute('data-line', '');
      // Flush the previous animation so consecutive row changes each reveal a new line.
      void el.offsetWidth;
    } else if (line) {
      el.setAttribute('data-line', 'ready');
    }
    el.style.setProperty('--tab-x', next.x + 'px');
    el.style.setProperty('--tab-w', next.width + 'px');
    el.style.setProperty('--tab-y', next.y + 'px');
    if (changesRow) {
      el.setAttribute('data-line', 'appear');
    } else if (!line) {
      el.setAttribute('data-line', '');
      frame = doc.defaultView?.requestAnimationFrame(() => {
        if (el.getAttribute('data-line') === '') el.setAttribute('data-line', 'ready');
      }) ?? 0;
    }
    line = next;
  };
  const paint = (): void => {
    for (const t of tabs) {
      const on = t.value === current;
      t.btn.classList.toggle('active', on);
      if (on) t.btn.setAttribute('aria-current', 'page');
      else t.btn.removeAttribute('aria-current');
    }
    place();
  };
  // laid out later, re-wrapped or resized: the line follows
  const view = doc.defaultView;
  if (view?.ResizeObserver) {
    const size = new view.ResizeObserver(place);
    size.observe(el);
    for (const tab of tabs) size.observe(tab.text);
    signal.addEventListener('abort', () => size.disconnect(), { once: true });
  }
  signal.addEventListener('abort', () => view?.cancelAnimationFrame(frame), { once: true });
  paint();

  return {
    el,
    setValue(value: string): void {
      current = value;
      paint();
    },
  };
}
