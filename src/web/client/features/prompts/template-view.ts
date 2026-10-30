/**
 * A World's templates on its own page, each in the 系统提示词 editor without block headers, its
 * variables beside it. Saving writes the deployment's copy, as on 系统提示词; 「恢复默认版本」 removes
 * that copy. A page with more than one template titles each.
 */
import type { WebUi, Disposable } from '../../../shared/client-panel.ts';
import { get, post } from '../../core/api.ts';
import type { Lifecycle } from '../../core/lifecycle.ts';
import { icon, type WebUiIconName } from '../../ui/icons.ts';
import { createPrefixEditor, references, VARIABLE_DRAG_TYPE } from './editor.ts';
import { S } from './strings.ts';
import { fitVariableChips, variablePopup } from './variables.ts';
import type { PromptDoc, PromptVar, PromptsView } from './view.ts';

export interface TemplateViewDeps {
  ui: WebUi;
  lifecycle: Lifecycle;
  signal: AbortSignal;
  addLeaveGuard(fn: () => string | null): Disposable;
  onError(err: unknown): void;
  /** The templates of this page. */
  keys: readonly string[];
  /** Opens this page's 配置; absent when the page has none. */
  openConfig?: () => void;
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

export function createTemplateView(deps: TemplateViewDeps): PromptsView {
  const { ui, signal } = deps;
  const el = ui.h('div', 'template-library');
  const doc = el.ownerDocument;
  const wanted = new Set(deps.keys);
  /** Titles of the templates with unsaved edits. */
  const dirty = new Set<string>();
  let editors: Disposable[] = [];

  deps.lifecycle.own(deps.addLeaveGuard(() => (dirty.size ? S.leaveUnsavedNamed([...dirty].join(S.listSep)) : null)));
  deps.lifecycle.own({ dispose: () => { for (const e of editors) e.dispose(); editors = []; } });

  let popup: HTMLElement | null = null;
  let popupChip: HTMLElement | null = null;
  const closePopup = (): void => {
    popup?.remove(); popup = null;
    popupChip?.setAttribute('aria-expanded', 'false'); popupChip = null;
  };
  doc.addEventListener('click', (event) => {
    if (!popup?.contains(event.target as Node) && !popupChip?.contains(event.target as Node)) closePopup();
  }, { signal });
  doc.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePopup(); }, { signal });
  doc.addEventListener('scroll', (event) => {
    if (popup && !popup.contains(event.target as Node)) closePopup();
  }, { signal, capture: true, passive: true });
  deps.lifecycle.own({ dispose: closePopup });

  const toolButton = (name: WebUiIconName, text: string, onClick: () => void): HTMLButtonElement => {
    const button = ui.button('', { size: 'sm', onClick });
    button.classList.add('btn-ico', 'prompt-vars-tool');
    button.title = text;
    button.setAttribute('aria-label', text);
    button.append(icon(doc, name));
    return button;
  };

  function editorFor(source: PromptDoc, titled: boolean): { el: HTMLElement; dispose(): void } {
    const wrap = ui.h('div', 'template-edit');
    if (titled) wrap.append(ui.section(source.title));
    const toolbar = ui.h('div', 'prompt-toolbar');
    const status = ui.msgline('');
    status.className += ' prompt-status';
    status.setAttribute('role', 'status');
    const actions = ui.h('div', 'prompt-actions');
    toolbar.append(status, actions);
    const stage = ui.h('div', 'prefix-stage template-stage');
    const side = ui.h('div', 'template-side tone-world');
    const vars = ui.h('div', 'prefix-vars');
    side.append(vars);
    const host = ui.h('div', 'prefix-host');
    stage.append(side, host);
    wrap.append(toolbar, stage);

    let revision = source.revision;
    let text = source.content;
    let saving = false;
    const loadedText = (): string => source.origin === 'deployment'
      ? S.loadedFromDeployment
      : source.origin === 'package'
        ? S.loadedFromPackage
        : source.origin === 'module'
          ? S.loadedFromWorld
          : S.loadedFromSource;
    const changed = (): boolean => text !== source.content;

    const undoStep = ui.button(S.undo, { size: 'sm', onClick: () => editor.undo() });
    undoStep.title = 'Ctrl / ⌘ + Z';
    const reset = ui.button(S.resetToWorld, { size: 'sm', onClick: () => void restoreDefault() });
    const save = ui.button(S.saveToFile, { size: 'sm', variant: 'primary', onClick: () => void persist() });
    save.title = 'Ctrl / ⌘ + S';
    actions.append(undoStep, reset, save);

    function controls(): void {
      undoStep.disabled = saving || !editor.canUndo();
      save.disabled = saving || !changed();
      reset.hidden = source.origin !== 'deployment';
      if (changed()) dirty.add(source.title); else dirty.delete(source.title);
    }
    function say(line: string, bad = false): void {
      status.className = bad ? 'msgline bad prompt-status' : 'msgline prompt-status';
      status.textContent = line;
    }

    const chips = new Map<string, HTMLButtonElement>();
    const list = ui.h('div', 'prompt-variable-list');
    const warning = ui.h('div', 'prompt-varwarn');
    const heading = ui.h('div', 'prompt-vars-heading');
    const tools = ui.h('span', 'prompt-vars-tools');
    heading.append(ui.h('span', 'prompt-vars-title', S.variablesTitle), tools);
    const declared = (): readonly PromptVar[] => source.vars ?? [];
    if (declared().length) {
      let previewing = false;
      const preview = toolButton('eye', S.previewVariables, () => {
        closePopup();
        previewing = !previewing;
        editor.setPreview(source.key, previewing);
        const label = previewing ? S.showVariableNames : S.previewVariables;
        preview.title = label;
        preview.setAttribute('aria-label', label);
        preview.setAttribute('aria-pressed', String(previewing));
        if (previewing) void refreshVariables();
      });
      preview.setAttribute('aria-pressed', 'false');
      tools.append(preview);
    }
    if (deps.openConfig) tools.append(toolButton('settings', S.worldSettings, deps.openConfig));
    for (const variable of declared()) {
      let insertAt = 0;
      const chip = ui.button(variable.name, { size: 'sm', onClick: () => {
        if (popupChip === chip) { closePopup(); return; }
        closePopup();
        popup = variablePopup(ui, declared().find((v) => v.name === variable.name) ?? variable);
        doc.body.append(popup);
        popupChip = chip;
        chip.setAttribute('aria-expanded', 'true');
        const rect = chip.getBoundingClientRect();
        const win = doc.defaultView!;
        popup.style.left = `${Math.max(8, Math.min(rect.right + 10, win.innerWidth - popup.offsetWidth - 8))}px`;
        popup.style.top = `${Math.max(8, Math.min(rect.top, win.innerHeight - popup.offsetHeight - 8))}px`;
      } });
      chip.className += ' varchip mono';
      chip.title = variable.name;
      chip.replaceChildren(ui.h('span', 'varchip-name', variable.name));
      chip.draggable = true;
      chip.setAttribute('aria-expanded', 'false');
      chip.addEventListener('mousedown', (event) => { if (event.detail === 1) insertAt = editor.view.state.selection.main.head; }, { signal });
      chip.addEventListener('dblclick', () => { closePopup(); editor.insert(source.key, variable.name, insertAt); }, { signal });
      chip.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); closePopup(); editor.insert(source.key, variable.name); }
      }, { signal });
      chip.addEventListener('dragstart', (event) => {
        closePopup();
        event.dataTransfer!.setData(VARIABLE_DRAG_TYPE, JSON.stringify({ key: source.key, name: variable.name }));
        event.dataTransfer!.effectAllowed = 'copy';
      }, { signal });
      chips.set(variable.name, chip);
      list.append(chip);
    }
    if (tools.childElementCount || chips.size) vars.append(heading, list, warning);
    else side.hidden = true;

    const updateVariables = (): void => {
      const used = new Set(references(text).map((r) => r.name));
      for (const [name, chip] of chips) chip.classList.toggle('varchip-unused', !used.has(name));
      const unknown = [...used].filter((name) => declared().find((v) => v.name === name)?.value === undefined);
      warning.textContent = unknown.length ? S.warnUnknownVars(unknown.join(S.listSep)) : '';
    };

    let frame = 0;
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; position(); });
    };
    const editor = createPrefixEditor({
      parent: host,
      headers: false,
      onChange(changes) {
        for (const change of changes) if (change.sourceKey === source.key) text = change.text;
        controls();
        say(changed() ? S.unsaved : loadedText());
        updateVariables();
        queueMicrotask(() => { if (!signal.aborted) editor.setSaveState(saving ? 'saving' : changed() ? 'dirty' : 'idle'); });
      },
      onSave: () => void persist(),
      onHistory: controls,
      onGeometry: schedule,
      onFold() { /* one template, never folded */ },
    });
    /** The text is at least as tall as the variable column beside it. */
    function position(): void {
      wrap.style.setProperty('--prompt-sticky-top', `${toolbar.offsetHeight + 12}px`);
      if (side.hidden) return;
      fitVariableChips(list, chips);
      const [g] = editor.blockGeometry();
      if (!g) return;
      const minHeight = Math.ceil(vars.offsetHeight + 16);
      editor.setSpacing([{ minHeight, padding: Math.max(0, Math.ceil(minHeight - (g.height - g.padding))) }]);
    }
    editor.setBlocks([{
      title: source.title, description: '', sourceKey: source.key, tone: 'world', text, vars: source.vars, collapsed: false,
    }]);
    const observer = new ResizeObserver(schedule);
    observer.observe(stage);
    observer.observe(vars);

    async function persist(): Promise<void> {
      if (saving || !changed()) return;
      saving = true;
      controls();
      say(S.saving);
      editor.setSaveState('saving');
      const content = text;
      try {
        const out = await post<{ error?: string; result?: string; revision?: string }>(
          '/api/prompts',
          { key: source.key, content, baseRevision: revision },
          { signal },
        );
        if (out?.error) throw new Error(out.error);
        source.content = content;
        revision = out?.revision;
        source.origin = 'deployment';
        say(S.savedResult(out?.result ?? S.saved));
      } catch (err) {
        if (isAbort(err)) return;
        deps.onError(err);
        say(S.saveFailed(String((err as Error)?.message ?? err)), true);
        ui.toast(S.saveFailedToast, 'bad');
      } finally {
        saving = false;
        if (!signal.aborted) {
          controls();
          editor.setSaveState(changed() ? 'dirty' : 'saved');
        }
      }
    }

    /** Deletes the deployment's copy and loads the template again: the World's own version comes back. */
    async function restoreDefault(): Promise<void> {
      if (!await ui.confirm({ title: S.resetTitle(source.title), body: S.resetBody, danger: true })) return;
      say(S.resetting);
      try {
        const out = await post<{ error?: string; result?: string }>('/api/prompts/reset', { key: source.key }, { signal });
        if (out?.error) throw new Error(out.error);
        dirty.delete(source.title);
        ui.toast(out?.result ?? S.resetDone, 'ok');
        await load();
      } catch (err) {
        if (isAbort(err)) return;
        deps.onError(err);
        say(S.resetFailed(String((err as Error)?.message ?? err)), true);
        ui.toast(S.resetFailedToast, 'bad');
      }
    }

    async function refreshVariables(): Promise<void> {
      try {
        const data = await get<{ prompts?: PromptDoc[] }>('/api/prompts', { signal });
        const current = data?.prompts?.find((p) => p.key === source.key);
        if (!current) return;
        closePopup();
        source.vars = current.vars;
        editor.updateVariables(source.key, current.vars ?? []);
        updateVariables();
      } catch (err) {
        if (!isAbort(err)) say(S.templatesLoadFailed(String((err as Error)?.message ?? err)), true);
      }
    }

    controls();
    say(loadedText());
    updateVariables();
    return {
      el: wrap,
      dispose() { observer.disconnect(); cancelAnimationFrame(frame); editor.dispose(); },
    };
  }

  async function load(): Promise<void> {
    for (const e of editors) e.dispose();
    editors = [];
    el.replaceChildren();
    dirty.clear();
    closePopup();
    try {
      const data = await get<{ prompts?: PromptDoc[] }>('/api/prompts', { signal });
      if (signal.aborted) return;
      const docs = (data?.prompts ?? []).filter((p) => wanted.has(p.key));
      if (!docs.length) { el.appendChild(ui.placeholder(S.noTemplatesScoped)); return; }
      for (const source of docs) {
        const editor = editorFor(source, docs.length > 1);
        editors.push(editor);
        el.appendChild(editor.el);
      }
    } catch (err) {
      if (isAbort(err)) return;
      deps.onError(err);
      el.appendChild(ui.placeholder(S.templatesLoadFailed(String((err as Error)?.message ?? err))));
    }
  }

  return { el, load };
}
