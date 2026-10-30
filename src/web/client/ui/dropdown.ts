/**
 * Dropdown lists: one list for every select (`select.field`) and every text field with suggestions
 * (`<input list="…">` and its `<datalist>`). The system's own popups cannot be styled (their scrollbar
 * least of all), so they never open; the console's list does instead: a white rounded box under the
 * field, with the pages' thin scrollbar. A click opens it and a second click closes it; ↑/↓ move,
 * Enter picks (Space too on a select), Esc closes only the list. A select's list starts at its value;
 * a text field's shows every suggestion when opened and those containing the text while typing.
 * The page's own elements stay the source: options and datalists are read each time the list opens,
 * and a select's open list follows its options when the page replaces them (one fetched on press, say).
 * A row too long for the box ends in an ellipsis.
 */
const LIST_ATTR = 'data-combo-list';
const EDGE = 8;

type Field = HTMLInputElement | HTMLSelectElement;
interface Item { value: string; label: string; disabled: boolean }

export function mountDropdowns(doc: Document, signal: AbortSignal): void {
  const win = doc.defaultView!;
  const box = doc.createElement('div');
  box.className = 'combo-list';
  box.id = 'combo-list';
  box.setAttribute('role', 'listbox');
  box.hidden = true;
  doc.body.append(box);
  let field: Field | null = null;
  let items: Item[] = [];
  let active = -1;
  // Watches the open select's options; set up in open, dropped in close.
  const watch = typeof win.MutationObserver === 'function' ? new win.MutationObserver(() => { if (field && isSelect(field)) open(field); }) : undefined;

  const isSelect = (el: Field): el is HTMLSelectElement => el instanceof win.HTMLSelectElement;
  /** The field an event is about, if it is one this list serves; a text field's `list` (the system popup) is taken away. */
  const own = (target: EventTarget | null): Field | null => {
    if (target instanceof win.HTMLSelectElement) {
      return target.classList.contains('field') && !target.multiple && target.size <= 1 && !target.disabled ? target : null;
    }
    if (!(target instanceof win.HTMLInputElement)) return null;
    const list = target.getAttribute('list');
    if (list) { target.setAttribute(LIST_ATTR, list); target.removeAttribute('list'); }
    if (!target.hasAttribute(LIST_ATTR) || target.disabled || target.readOnly) return null;
    target.setAttribute('role', 'combobox');
    target.setAttribute('aria-autocomplete', 'list');
    target.setAttribute('aria-controls', box.id);
    return target;
  };
  const itemsOf = (el: Field): Item[] => {
    if (isSelect(el)) return [...el.options].map(option => ({ value: option.value, label: option.label || option.text, disabled: option.disabled }));
    const list = doc.getElementById(el.getAttribute(LIST_ATTR) ?? '');
    const values = list ? [...new Set([...list.querySelectorAll('option')].map(option => option.value).filter(Boolean))] : [];
    return values.map(value => ({ value, label: value, disabled: false }));
  };
  const rows = () => [...box.querySelectorAll<HTMLElement>('.combo-option')];

  const close = (): void => {
    if (field) { field.setAttribute('aria-expanded', 'false'); field.removeAttribute('aria-activedescendant'); }
    watch?.disconnect();
    field = null; items = []; active = -1; box.hidden = true; box.replaceChildren();
  };
  const place = (el: Field): void => {
    const rect = el.getBoundingClientRect();
    box.style.minWidth = `${rect.width}px`;
    box.style.left = `${Math.max(EDGE, Math.min(rect.left, win.innerWidth - box.offsetWidth - EDGE))}px`;
    const below = rect.bottom + 4;
    box.style.top = `${below + box.offsetHeight > win.innerHeight - EDGE && rect.top - 4 - box.offsetHeight > EDGE ? rect.top - 4 - box.offsetHeight : below}px`;
  };
  /** Highlights row `index` (none for -1) and keeps it in view. */
  const mark = (index: number): void => {
    const all = rows();
    active = all.length ? (index + all.length) % all.length : -1;
    all.forEach((row, i) => row.classList.toggle('is-active', i === active));
    const current = all[active];
    if (current && field) { field.setAttribute('aria-activedescendant', current.id); current.scrollIntoView?.({ block: 'nearest' }); }
  };
  /** Moves the highlight `by` rows, past disabled ones, wrapping round. */
  const step = (by: number): void => {
    for (let i = 1; i <= items.length; i++) {
      const next = ((active < 0 && by < 0 ? 0 : active) + by * i + items.length) % items.length;
      if (!items[next].disabled) { mark(next); return; }
    }
  };
  /** Opens the list for `el`; a text field's can show only the suggestions containing its text. */
  const open = (el: Field, filter = false): void => {
    const text = el.value.trim().toLowerCase();
    const shown = itemsOf(el).filter(item => !filter || !text || item.label.toLowerCase().includes(text));
    if (!shown.length || (filter && shown.length === 1 && shown[0].value === el.value)) { close(); return; }
    if (field && field !== el) close();
    field = el; items = shown; active = -1;
    box.replaceChildren(...shown.map((item, index) => {
      const row = doc.createElement('div');
      row.className = 'combo-option';
      row.id = `combo-option-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(item.value === el.value));
      if (item.disabled) row.setAttribute('aria-disabled', 'true');
      row.append(Object.assign(doc.createElement('span'), { className: 'combo-label', textContent: item.label }));
      return row;
    }));
    box.hidden = false;
    el.setAttribute('aria-expanded', 'true');
    place(el);
    if (isSelect(el)) {
      mark(shown.findIndex(item => item.value === el.value));
      watch?.disconnect();
      watch?.observe(el, { childList: true, subtree: true, characterData: true });
    }
  };
  const pick = (index: number): void => {
    const el = field, item = items[index];
    if (!el || !item || item.disabled) return;
    close();
    if (el.value === item.value && isSelect(el)) return;
    el.value = item.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const toggle = (el: Field): void => { if (field === el) close(); else open(el); };

  // A select is opened by the press itself, which also keeps the system's popup shut.
  doc.addEventListener('pointerdown', (event) => {
    const el = own(event.target);
    if (!el || !isSelect(el) || event.button !== 0) return;
    event.preventDefault();
    el.focus();
    toggle(el);
  }, { signal });
  doc.addEventListener('click', (event) => { const el = own(event.target); if (el && !isSelect(el)) toggle(el); }, { signal });
  doc.addEventListener('input', (event) => { const el = own(event.target); if (el && !isSelect(el)) open(el, true); }, { signal });
  doc.addEventListener('focusout', (event) => { if (event.target === field) close(); }, { signal });
  doc.addEventListener('keydown', (event) => {
    const el = own(event.target);
    if (!el) return;
    const opened = field === el;
    const select = isSelect(el);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // A closed select's arrows change its value, as always; Alt+arrow and a text field's arrows open the list.
      if (select && !opened && !event.altKey) return;
      event.preventDefault();
      if (!opened) open(el); else step(event.key === 'ArrowDown' ? 1 : -1);
      if (!opened && !select) step(1);
    } else if ((event.key === 'Enter' || (select && event.key === ' ')) && (opened || select)) {
      event.preventDefault();
      if (opened && active >= 0) pick(active); else if (!opened) open(el);
    } else if (event.key === 'Escape' && opened) {
      // Closes the list only, not a window the field sits in.
      event.preventDefault(); event.stopPropagation();
      close();
    } else if (event.key === 'Tab' && opened) close();
  }, { capture: true, signal });
  // A press on an option picks it before the field loses focus.
  box.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const row = (event.target as Element).closest<HTMLElement>('.combo-option');
    if (row) pick(rows().indexOf(row));
  }, { signal });
  box.addEventListener('pointermove', (event) => {
    const row = (event.target as Element).closest<HTMLElement>('.combo-option');
    if (row && row.getAttribute('aria-disabled') !== 'true') mark(rows().indexOf(row));
  }, { signal });
  doc.addEventListener('scroll', (event) => { if (field && !box.contains(event.target as Node)) close(); }, { capture: true, passive: true, signal });
  win.addEventListener('resize', close, { signal });
  win.addEventListener('blur', close, { signal });
  signal.addEventListener('abort', () => box.remove(), { once: true });
}
