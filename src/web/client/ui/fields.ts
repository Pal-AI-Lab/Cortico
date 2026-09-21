/** 表单控件与标签；事件监听绑定 UI 实例的 signal。 */

import type {
  ConsoleCheckbox,
  ConsoleCheckboxOptions,
  ConsoleFieldOptions,
  ConsoleInputOptions,
  ConsoleSegmented,
  ConsoleSegmentedOptions,
  ConsoleSelectOptions,
  ConsoleTextareaOptions,
} from '../../shared/client-panel.ts';
import { h } from './dom.ts';

/** `field` + 调用方追加的 class（如 `mono` / `grow`） */
function fieldClass(extra?: string): string {
  return extra ? 'field ' + extra : 'field';
}

/** 初始化值、禁用状态与回调。onInput 监听输入（select 使用 change），onChange 监听 change，onCommit 监听提交键。 */
function wire(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  signal: AbortSignal,
  opts: ConsoleFieldOptions,
  event: 'input' | 'change',
): void {
  if (opts.value != null) el.value = opts.value;
  if (opts.disabled) el.disabled = true;
  const onInput = opts.onInput;
  if (onInput) el.addEventListener(event, () => onInput(el.value), { signal });
  const onChange = opts.onChange;
  if (onChange) el.addEventListener('change', () => onChange(el.value), { signal });
  const onCommit = opts.onCommit;
  if (onCommit) {
    // 形参写成 `Event` 再收窄:`el` 是三种控件的联合类型,它的 `addEventListener`
    // 只剩下不带事件名类型推导的那条通用重载(TS 对联合方法取的是签名的交集),
    // 直接写 `(ev: KeyboardEvent)` 会被判成不兼容。
    el.addEventListener(
      'keydown',
      (ev: Event) => {
        if (isCommitKey(el, ev as KeyboardEvent)) onCommit(el.value);
      },
      { signal },
    );
  }
}

/**
 * 判断 Enter 是否提交：IME composition 期间只选词；textarea 裸 Enter 换行，Ctrl/⌘+Enter 提交。
 */
function isCommitKey(el: { tagName: string }, ev: KeyboardEvent): boolean {
  if (ev.key !== 'Enter' || ev.isComposing) return false;
  if (el.tagName.toLowerCase() !== 'textarea') return true;
  return ev.ctrlKey || ev.metaKey;
}

/** 单行输入。缺省 `type=text`。 */
export function input(
  doc: Document,
  signal: AbortSignal,
  opts?: ConsoleInputOptions,
): HTMLInputElement {
  const o = opts ?? {};
  const el = h(doc, 'input', fieldClass(o.cls));
  el.type = o.type ?? 'text';
  if (o.placeholder != null) el.placeholder = o.placeholder;
  wire(el, signal, o, 'input');
  return el;
}

/** 下拉选项先创建，再设置选中值；字符串选项同时作为 value 与 label。 */
export function select(
  doc: Document,
  signal: AbortSignal,
  opts?: ConsoleSelectOptions,
): HTMLSelectElement {
  const o = opts ?? {};
  const el = h(doc, 'select', fieldClass(o.cls));
  for (const raw of o.options ?? []) {
    const item = typeof raw === 'string' ? { value: raw, label: raw } : raw;
    const opt = h(doc, 'option', null, item.label ?? item.value);
    opt.value = item.value;
    el.appendChild(opt);
  }
  wire(el, signal, o, 'change');
  return el;
}

/** 多行输入。`rows` 缺省交给 CSS 的 `min-height`。 */
export function textarea(
  doc: Document,
  signal: AbortSignal,
  opts?: ConsoleTextareaOptions,
): HTMLTextAreaElement {
  const o = opts ?? {};
  const el = h(doc, 'textarea', fieldClass(o.cls));
  if (o.rows != null) el.rows = o.rows;
  if (o.placeholder != null) el.placeholder = o.placeholder;
  wire(el, signal, o, 'input');
  return el;
}

/**
 * 勾选框采用 label.check > input[type=checkbox] + span。文本单独放入 span，使 inline-flex 的 gap 在控件与整段文本之间一致生效。
 */
export function checkbox(
  doc: Document,
  signal: AbortSignal,
  label: string,
  opts?: ConsoleCheckboxOptions,
): ConsoleCheckbox {
  const o = opts ?? {};
  const el = h(doc, 'label', 'check');
  const box = h(doc, 'input');
  box.type = 'checkbox';
  if (o.checked) box.checked = true;
  if (o.disabled) box.disabled = true;
  if (o.title) el.title = o.title;
  el.append(box, h(doc, 'span', null, label));
  const cb = o.onChange;
  if (cb) box.addEventListener('change', () => cb(box.checked), { signal });
  return {
    el,
    input: box,
    get checked(): boolean {
      return box.checked;
    },
    // 程序设置值不触发用户 change 回调。
    setChecked(v: boolean): void {
      box.checked = v;
    },
  };
}

/**
 * 字段标签 + 控件。控件嵌在 `<label>` 里，点标签即聚焦控件（不必配 `for`/`id`，
 * 扩展也就不必发明一套全局唯一的 id）。
 */
export function field(doc: Document, label: string, control: HTMLElement): HTMLLabelElement {
  const el = h(doc, 'label', 'fieldrow');
  const caption = h(doc, 'span', 'fieldlabel', label.replace(/\s*\*$/, ''));
  if (/\*$/.test(label)) caption.append(h(doc, 'span', 'required-mark', ' *'));
  el.append(caption, control);
  return el;
}

/** 分段选择器保留全部重复 value 选项，并统一更新它们的选中态。 */
export function segmented(
  doc: Document,
  signal: AbortSignal,
  items: readonly (string | { value: string; label?: string })[],
  opts?: ConsoleSegmentedOptions,
): ConsoleSegmented {
  const o = opts ?? {};
  const el = h(doc, 'div', o.size === 'sm' ? 'segwrap sm' : 'segwrap');
  const keys: { value: string; btn: HTMLButtonElement }[] = [];
  let current = o.value ?? '';
  const paint = (): void => {
    for (const k of keys) k.btn.className = k.value === current ? 'seg active' : 'seg';
  };

  for (const raw of items) {
    const item = typeof raw === 'string' ? { value: raw, label: raw } : raw;
    const btn = h(doc, 'button', 'seg', item.label ?? item.value);
    btn.type = 'button';
    keys.push({ value: item.value, btn });
    btn.addEventListener(
      'click',
      () => {
        // 点已经选中的那颗:不回调。onSelect 后面挂的常是一次重新取数,
        // 白刷一遍不只是浪费,还会把用户刚滚到的位置弹回去。
        if (current === item.value) return;
        current = item.value;
        paint();
        o.onSelect?.(item.value);
      },
      { signal },
    );
    el.appendChild(btn);
  }
  paint();

  return {
    el,
    get value(): string {
      return current;
    },
    setValue(v: string): void {
      current = v;
      paint();
    },
  };
}
