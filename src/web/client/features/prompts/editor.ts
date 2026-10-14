/** Templates remain ranges in one document; folds and variable values only affect presentation. */
import { EditorState, StateEffect, StateField, Transaction, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, lineNumbers, dropCursor, type DecorationSet } from '@codemirror/view';
import { history, historyKeymap, isolateHistory, undo, redo, undoDepth } from '@codemirror/commands';
import type { PromptVar } from './view.ts';
import { S } from './strings.ts';

export interface PrefixBlock {
  title: string;
  description?: string;
  sourceKey?: string;
  tone: 'persona' | 'world' | 'derived';
  /** Ignored for a template block already in the editor, which keeps its text and undo history; restore() replaces it. */
  text: string;
  vars?: readonly PromptVar[];
  collapsed?: boolean;
  preview?: boolean;
}
interface BlockRange { block: PrefixBlock; from: number; to: number; collapsed: boolean; preview: boolean; minHeight: number; padding: number }
const setBlocks = StateEffect.define<BlockRange[]>();
const setCollapsed = StateEffect.define<{ index: number; collapsed: boolean }>();
const setVariables = StateEffect.define<{ key: string; values: readonly PromptVar[] }>();
const setSpacing = StateEffect.define<Array<{ minHeight: number; padding: number }>>();
const setPreview = StateEffect.define<{ key: string; preview: boolean }>();
const restoreSources = StateEffect.define<null>();
const setHover = StateEffect.define<number>();
const hoverField = StateField.define<number>({
  create: () => -1,
  update: (value, tr) => tr.effects.find((e) => e.is(setHover))?.value ?? value,
});
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved';
const setSaveState = StateEffect.define<SaveState>();
const saveField = StateField.define<{ state: SaveState; at: number }>({
  create: () => ({ state: 'idle', at: 0 }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSaveState)) return { state: e.value, at: tr.state.selection.main.head };
      if (e.is(setBlocks)) return { state: 'idle', at: 0 };
    }
    return tr.docChanged ? { state: 'dirty', at: tr.state.selection.main.head } : value;
  },
});
const blockField = StateField.define<BlockRange[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setBlocks)) return effect.value;
    return value.map((range, index) => {
      let next = tr.docChanged ? { ...range, from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) } : range;
      for (const effect of tr.effects) {
        if (effect.is(setCollapsed) && effect.value.index === index) next = { ...next, collapsed: effect.value.collapsed };
        if (effect.is(setPreview) && effect.value.key === next.block.sourceKey) next = { ...next, preview: effect.value.preview };
        if (effect.is(setVariables) && effect.value.key === next.block.sourceKey) next = { ...next, block: { ...next.block, vars: effect.value.values } };
        if (effect.is(setSpacing)) next = { ...next, ...effect.value[index] };
      }
      return next;
    });
  },
});
export const VARIABLE_DRAG_TYPE = 'application/x-cortico-prompt-variable';

export function references(text: string): Array<{ name: string; from: number; to: number; token: string; fallback?: string }> {
  return [...text.matchAll(/\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g)].map((m) => ({
    name: m[1], from: m.index!, to: m.index! + m[0].length, token: m[0], fallback: m[2]?.trim(),
  }));
}

function valueOf(variable: PromptVar, fallback?: string): string {
  return variable.value || fallback || S.emptyValue;
}

class VariableWidget extends WidgetType {
  constructor(readonly variable: PromptVar, readonly token: string, readonly preview: boolean, readonly fallback?: string) { super(); }
  eq(other: VariableWidget): boolean {
    return this.token === other.token && this.preview === other.preview && this.variable.value === other.variable.value
      && this.variable.description === other.variable.description && this.variable.multiline === other.variable.multiline;
  }
  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const root = doc.createElement('span');
    root.className = `prompt-reference${this.preview ? ' is-preview' : ''}`;
    root.dataset.variable = this.variable.name;
    root.contentEditable = 'false';
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'prompt-reference-label';
    button.draggable = true;
    button.textContent = this.preview ? this.variable.value === undefined ? this.token : valueOf(this.variable, this.fallback) : this.variable.name;
    button.title = `${this.variable.name}: ${this.variable.description}`;
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'prompt-reference-remove';
    remove.textContent = '×';
    remove.title = S.removeReference;
    remove.setAttribute('aria-label', `${S.removeReference}: ${this.variable.name}`);
    const range = () => {
      const at = view.posAtDOM(root);
      return references(view.state.doc.toString()).find((r) => r.from === at);
    };
    remove.addEventListener('click', () => {
      const r = range();
      if (r) {
        // Undo returns to the edited reference, even when focus was in another section.
        view.dispatch({ selection: { anchor: r.from }, annotations: Transaction.addToHistory.of(false) });
        view.dispatch({ changes: { from: r.from, to: r.to }, selection: { anchor: r.from }, userEvent: 'delete', annotations: isolateHistory.of('full') });
      }
      view.focus();
    });
    button.addEventListener('dragstart', (event) => {
      const r = range();
      if (!r) return;
      event.dataTransfer!.setData(VARIABLE_DRAG_TYPE, JSON.stringify({
        key: view.state.field(blockField).find((b) => r.from >= b.from && r.to <= b.to)?.block.sourceKey, name: r.name, from: r.from, to: r.to, token: r.token,
      }));
      event.dataTransfer!.effectAllowed = 'move';
    });
    root.append(button, remove);
    return root;
  }
  ignoreEvent(): boolean { return true; }
}


class SectionHeader extends WidgetType {
  constructor(readonly index: number, readonly description: string, readonly collapsed: boolean, readonly height = 0) { super(); }
  eq(other: SectionHeader): boolean { return this.index === other.index && this.description === other.description && this.collapsed === other.collapsed && this.height === other.height; }
  toDOM(view: EditorView): HTMLElement {
    const el = view.dom.ownerDocument.createElement('div');
    el.className = 'prefix-comment';
    el.dataset.block = String(this.index);
    if (this.collapsed) el.style.height = `${this.height}px`;
    const text = view.dom.ownerDocument.createElement('span');
    text.className = 'prefix-comment-text';
    text.textContent = this.description;
    text.title = this.description;
    const status = view.dom.ownerDocument.createElement('button');
    status.type = 'button';
    status.className = `prefix-fold-status ${this.collapsed ? 'is-collapsed' : 'is-expanded'}`;
    status.textContent = this.collapsed ? '+' : '−';
    status.setAttribute('aria-label', this.collapsed ? S.collapsed : S.expanded);
    status.setAttribute('aria-expanded', String(!this.collapsed));
    status.title = this.collapsed ? S.collapsed : S.expanded;
    status.addEventListener('click', () => {
      view.dispatch({ effects: setCollapsed.of({ index: this.index, collapsed: !this.collapsed }) });
      view.contentDOM.querySelector<HTMLButtonElement>(`.prefix-comment[data-block="${this.index}"] button`)?.focus({ preventScroll: true });
    });
    el.append(text, status);
    return el;
  }
}

function decorate(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  state.field(blockField).forEach((range, index) => {
    const { block, from, to } = range;
    if (range.collapsed) {
      decorations.push(Decoration.replace({ widget: new SectionHeader(index, block.description ?? '', true, range.minHeight), block: true }).range(from, to));
      return;
    }
    decorations.push(Decoration.widget({ widget: new SectionHeader(index, block.description ?? '', false), block: true, side: -1 }).range(from));
    for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) {
      const line = state.doc.line(n);
      decorations.push(Decoration.line({
        class: `cm-block cm-block-${block.tone}${line.from === from ? ' cm-block-first' : ''}`,
        attributes: {
          'data-prompt-section': String(index),
          ...(n === state.doc.lineAt(to).number ? { style: `padding-bottom:${range.padding}px` } : {}),
        },
      }).range(line.from));
    }
    const declared = new Map(block.vars?.map((v) => [v.name, v]));
    for (const ref of references(state.doc.sliceString(from, to))) {
      const variable = declared.get(ref.name);
      if (variable) decorations.push(Decoration.replace({ widget: new VariableWidget(variable, ref.token, range.preview, ref.fallback) }).range(from + ref.from, from + ref.to));
    }
  });
  return Decoration.set(decorations, true);
}
const decorations = StateField.define<DecorationSet>({
  create: decorate,
  update: (value, tr) => tr.docChanged || tr.effects.some((e) => e.is(setBlocks) || e.is(setCollapsed) || e.is(setVariables) || e.is(setSpacing) || e.is(setPreview)) ? decorate(tr.state) : value,
  provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field))],
});
const interactionDecorations = EditorView.decorations.compute(
  [blockField, hoverField, saveField, 'selection', 'doc'],
  (state) => {
    const ranges: Range<Decoration>[] = [];
    const caret = state.selection.main.head;
    state.field(blockField).forEach((r, index) => {
      if (r.collapsed) return;
      const active = r.block.sourceKey && caret >= r.from && caret <= r.to;
      const hovered = state.field(hoverField) === index;
      if (!active && !hovered) return;
      for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
        ranges.push(Decoration.line({ class: `${active ? 'cm-block-active' : ''} ${hovered ? 'cm-block-hover' : ''}` }).range(state.doc.line(n).from));
      }
    });
    const save = state.field(saveField);
    const line = state.doc.lineAt(caret);
    const label = { idle: '', dirty: S.saveHintDirty, saving: S.saving, saved: S.saved }[save.state];
    if (label && (save.state !== 'saved' || state.doc.lineAt(Math.min(save.at, state.doc.length)).number === line.number)) {
      ranges.push(Decoration.line({ class: `cm-save-${save.state}`, attributes: { 'data-save-hint': label } }).range(line.from));
    }
    return Decoration.set(ranges, true);
  },
);

const sourceGuard = EditorState.changeFilter.of((tr) => {
  if (tr.effects.some((e) => e.is(setBlocks) || e.is(restoreSources))) return true;
  const blocks = tr.startState.field(blockField);
  let allowed = true;
  tr.changes.iterChangedRanges((from, to) => {
    if (!blocks.some((r) => r.block.sourceKey && (!r.collapsed || tr.isUserEvent('undo') || tr.isUserEvent('redo')) && from >= r.from && to <= r.to)) allowed = false;
  });
  return allowed;
});

export function createPrefixEditor(options: {
  parent: HTMLElement;
  onChange(changes: Array<{ sourceKey: string; text: string }>): void;
  onSave?(): void;
  onGeometry?(): void;
  onFold?(index: number, collapsed: boolean): void;
  onHistory?(): void;
}) {
  let last = new Map<string, string>();
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({ extensions: [
      blockField, hoverField, saveField, decorations, interactionDecorations, sourceGuard, history(), lineNumbers(), dropCursor(), EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': S.title, spellcheck: 'false' }),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { options.onSave?.(); return true; } },
        { key: 'Mod-Shift-z', preventDefault: true, run: redo },
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const changes: Array<{ sourceKey: string; text: string }> = [];
          for (const range of update.state.field(blockField)) {
            const key = range.block.sourceKey;
            if (!key) continue;
            const text = update.state.doc.sliceString(range.from, range.to);
            if (last.get(key) !== text) { last.set(key, text); changes.push({ sourceKey: key, text }); }
          }
          if (changes.length) options.onChange(changes);
        }
        for (const transaction of update.transactions) for (const effect of transaction.effects) {
          if (effect.is(setCollapsed)) options.onFold?.(effect.value.index, effect.value.collapsed);
        }
        if (update.docChanged) options.onHistory?.();
        if (update.docChanged || update.geometryChanged || update.viewportChanged || update.transactions.some((t) => t.effects.length)) options.onGeometry?.();
      }),
      EditorView.domEventHandlers({
        mousemove(event) {
          const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
          const index = at == null ? -1 : view.state.field(blockField).findIndex((r) => !r.collapsed && at >= r.from && at <= r.to);
          if (index !== view.state.field(hoverField)) view.dispatch({ effects: setHover.of(index) });
          return false;
        },
        mouseleave() {
          if (view.state.field(hoverField) !== -1) view.dispatch({ effects: setHover.of(-1) });
          return false;
        },
        dragover(event) {
          if (!event.dataTransfer?.types.includes(VARIABLE_DRAG_TYPE)) return false;
          event.preventDefault();
          return false;
        },
        drop(event) {
          const raw = event.dataTransfer?.getData(VARIABLE_DRAG_TYPE);
          if (!raw) return false;
          event.preventDefault();
          const data: { key: string; name: string; from?: number; to?: number; token?: string } = JSON.parse(raw);
          const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
          const range = view.state.field(blockField).find((r) => r.block.sourceKey === data.key && !r.collapsed && at != null && at >= r.from && at <= r.to);
          if (!range) return true;
          const pos = outsideReference(at!);
          const moving = references(view.state.doc.toString()).find((r) => r.from === data.from && r.to === data.to && r.token === data.token && r.from >= range.from && r.to <= range.to);
          if (moving) {
            if (pos >= moving.from && pos <= moving.to) return true;
            const anchor = pos > moving.to ? pos : pos + moving.token.length;
            view.dispatch({ selection: { anchor: moving.from }, annotations: Transaction.addToHistory.of(false) });
            view.dispatch({ changes: [{ from: moving.from, to: moving.to }, { from: pos, insert: moving.token }], selection: { anchor }, userEvent: 'move.drop', annotations: isolateHistory.of('full') });
            view.focus();
          } else insert(data.key, data.name, pos);
          return true;
        },
      }),
    ] }),
  });
  function outsideReference(position: number): number {
    const ref = references(view.state.doc.toString()).find((r) => r.from < position && r.to > position);
    return ref?.to ?? position;
  }
  function insert(key: string, name: string, position = view.state.selection.main.head): void {
    const range = view.state.field(blockField).find((r) => r.block.sourceKey === key)!;
    const at = outsideReference(position >= range.from && position <= range.to ? position : range.to);
    const token = `{{${name}}}`;
    view.dispatch({ selection: { anchor: at }, annotations: Transaction.addToHistory.of(false) });
    view.dispatch({ changes: { from: at, insert: token }, selection: { anchor: at + token.length }, scrollIntoView: true, userEvent: 'input', annotations: isolateHistory.of('full') });
    view.focus();
    requestAnimationFrame(() => {
      for (const node of view.dom.querySelectorAll<HTMLElement>('.prompt-reference')) if (view.posAtDOM(node) === at) {
        node.classList.remove('reference-arrive');
        void node.offsetWidth;
        node.classList.add('reference-arrive');
      }
    });
  }
  return {
    view, insert,
    undo() { undo(view); view.focus(); },
    redo() { redo(view); view.focus(); },
    canUndo: () => undoDepth(view.state) > 0,
    restore(sources: ReadonlyMap<string, string>) {
      const changes = view.state.field(blockField).flatMap((r) => {
        const text = r.block.sourceKey && sources.get(r.block.sourceKey);
        return typeof text === 'string' && text !== view.state.doc.sliceString(r.from, r.to) ? [{ from: r.from, to: r.to, insert: text }] : [];
      });
      if (changes.length) view.dispatch({ changes, effects: restoreSources.of(null), userEvent: 'input.restore', annotations: isolateHistory.of('full') });
    },
    setPreview(key: string, preview: boolean) { view.dispatch({ effects: setPreview.of({ key, preview }) }); },
    setSaveState(state: SaveState) { view.dispatch({ effects: setSaveState.of(state) }); },
    /**
     * Matches blocks to the current ones by sourceKey, or by title for generated text, along their longest common
     * subsequence. Text outside matched unchanged blocks is rewritten without entering the undo history.
     */
    setBlocks(blocks: PrefixBlock[]) {
      const current = view.state.field(blockField);
      const id = (block: PrefixBlock) => block.sourceKey ?? `title:${block.title}`;
      const common = Array.from({ length: current.length + 1 }, () => new Array<number>(blocks.length + 1).fill(0));
      for (let i = current.length - 1; i >= 0; i--) for (let j = blocks.length - 1; j >= 0; j--) {
        common[i][j] = id(current[i].block) === id(blocks[j]) ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
      }
      const matched = new Map<number, BlockRange>();
      for (let i = 0, j = 0; i < current.length && j < blocks.length;) {
        if (id(current[i].block) === id(blocks[j])) matched.set(j++, current[i++]);
        else if (common[i + 1][j] >= common[i][j + 1]) i++;
        else j++;
      }
      let doc = '';
      const kept: Array<{ old: BlockRange; from: number; to: number }> = [];
      const ranges = blocks.map((block, index) => {
        const old = matched.get(index);
        const oldText = old && view.state.doc.sliceString(old.from, old.to);
        const text = old && block.sourceKey ? oldText! : view.state.toText(block.text).toString();
        const from = doc.length;
        doc += text;
        if (old && text === oldText) kept.push({ old, from, to: doc.length });
        const range = { block: { ...block, text }, from, to: doc.length, collapsed: block.collapsed ?? false, preview: block.preview ?? false, minHeight: 50, padding: 0 };
        doc += '\n';
        return range;
      });
      doc = doc.slice(0, -1);
      const changes: Array<{ from: number; to: number; insert: string }> = [];
      let oldAt = 0, newAt = 0;
      for (const { old, from, to } of kept) {
        const insert = doc.slice(newAt, from);
        if (view.state.doc.sliceString(oldAt, old.from) !== insert) changes.push({ from: oldAt, to: old.from, insert });
        oldAt = old.to; newAt = to;
      }
      if (view.state.doc.sliceString(oldAt) !== doc.slice(newAt)) changes.push({ from: oldAt, to: view.state.doc.length, insert: doc.slice(newAt) });
      last = new Map(ranges.filter((r) => r.block.sourceKey).map((r) => [r.block.sourceKey!, r.block.text]));
      view.dispatch({ changes, effects: setBlocks.of(ranges), annotations: Transaction.addToHistory.of(false) });
    },
    setCollapsed(index: number, collapsed: boolean) { view.dispatch({ effects: setCollapsed.of({ index, collapsed }) }); },
    text(key: string): string {
      const range = view.state.field(blockField).find((r) => r.block.sourceKey === key)!;
      return view.state.doc.sliceString(range.from, range.to);
    },
    updateVariables(key: string, values: readonly PromptVar[]) { view.dispatch({ effects: setVariables.of({ key, values }) }); },
    setSpacing(spacing: Array<{ minHeight: number; padding: number }>) {
      if (view.state.field(blockField).some((r, i) => Math.abs(r.minHeight - spacing[i].minHeight) > 1 || Math.abs(r.padding - spacing[i].padding) > 1)) {
        view.dispatch({ effects: setSpacing.of(spacing) });
      }
    },
    blockGeometry() {
      const base = view.contentDOM.getBoundingClientRect().top;
      const blocks = view.state.field(blockField);
      const tops = blocks.map((r, index) => {
        const el = view.contentDOM.querySelector(`[data-block="${index}"]`);
        return el ? el.getBoundingClientRect().top - base : view.lineBlockAt(r.from).top;
      });
      return blocks.map((r, index) => ({ top: tops[index], height: (tops[index + 1] ?? view.contentDOM.getBoundingClientRect().height) - tops[index], collapsed: r.collapsed, padding: r.padding }));
    },
    contentTop: () => view.contentDOM.getBoundingClientRect().top,
    dispose: () => view.destroy(),
  };
}
