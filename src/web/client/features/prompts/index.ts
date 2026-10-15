/** Templates are edited in place; runtime services supply variable values and generated sections. */
import { fetchManifest, get, post } from '../../core/api.ts';
import { pageIntro } from '../../ui/page.ts';
import { estTok } from '../live/context.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { createPrefixEditor, references, VARIABLE_DRAG_TYPE } from './editor.ts';
import { S } from './strings.ts';
import type { PromptDoc, PromptVar } from './view.ts';

interface PrefixSegment { title: string; text: string; sourceKey?: string }
interface Section {
  segment: PrefixSegment;
  label: HTMLElement;
  toggle: HTMLButtonElement;
  cell: HTMLElement;
  note: HTMLElement;
  badge: HTMLElement;
  origin?: HTMLElement;
  divider: HTMLElement;
  collapsed: boolean;
  updateVariables(): void;
}
const colWidth = { flags: 158, rail: 190 };
const FOLDS_KEY = 'cortico.prompt-folds';
let folds = new Map<string, boolean>();

function description(segment: PrefixSegment, doc?: PromptDoc): { title: string; detail: string } {
  return { title: doc?.title || segment.title, detail: doc ? doc.description ?? '' : segment.sourceKey ? S.sourceMissing(segment.sourceKey) : S.fromCode };
}

export async function mountPrompts(ctx: FeatureContext): Promise<void> {
  const { ui, root, signal } = ctx;
  try { folds = new Map(JSON.parse(sessionStorage.getItem(FOLDS_KEY) ?? '[]')); } catch { /* Keep this window's in-memory state if storage is unavailable. */ }
  const docs = new Map<string, PromptDoc>();
  const dirty = new Map<string, string>();
  const sections: Section[] = [];
  const previews = new Set<string>();
  let segments: PrefixSegment[] = [];
  let pendingApply = false;
  let savePromise: Promise<boolean> | null = null;
  let changingSession = false;
  const toolbar = ui.h('div', 'prompt-toolbar');
  const actions = ui.h('div', 'prompt-actions');
  const status = ui.msgline('');
  status.setAttribute('role', 'status');
  const stage = ui.h('div', 'prefix-stage');
  const flags = ui.h('div', 'prefix-flags');
  const host = ui.h('div', 'prefix-host');
  const rail = ui.h('div', 'prefix-rail');
  const gripL = ui.h('div', 'prefix-grip');
  const gripR = ui.h('div', 'prefix-grip');
  const dividers = ui.h('div', 'prefix-dividers');
  stage.append(flags, gripL, host, gripR, rail, dividers);
  const intro = pageIntro(ui, S.title, S.introDesc);
  const full = ui.h('pre', 'mono prefix-full');
  const preview = ui.foldSheet('full-prompt', { title: S.fullPreview });
  preview.body.append(full);
  root.append(intro, toolbar, stage, preview.el);

  function say(text: string, bad = false): void {
    status.className = bad ? 'msgline bad prompt-status' : 'msgline prompt-status';
    status.textContent = text;
  }
  function controls(): void {
    for (const button of actions.querySelectorAll<HTMLButtonElement>('button')) button.disabled = changingSession;
    save.disabled = restore.disabled = changingSession || dirty.size === 0 || !!savePromise;
    undoStep.disabled = changingSession || !editor.canUndo();
  }
  function state(): void {
    controls();
    say(dirty.size ? S.dirtyCount(dirty.size) : pendingApply ? S.pendingReload : S.prefixStats(segments.length, estTok(segments.map((s) => s.text).join('')).toLocaleString()));
    for (const section of sections) {
      const key = section.segment.sourceKey;
      const doc = key ? docs.get(key) : undefined;
      const changed = key && dirty.has(key);
      section.badge.textContent = changed ? S.unsaved : doc ? S.editableTemplate : S.flagReadonly;
      if (doc && !segments.some((s) => s.sourceKey === key)) section.badge.textContent += ` · ${S.outsidePrefix}`;
      section.badge.classList.toggle('is-dirty', !!changed);
      section.toggle.title = doc?.origin === 'deployment' ? S.loadedFromDeployment : doc?.origin === 'package' ? S.loadedFromPackage : doc?.origin === 'module' ? S.loadedFromWorld : doc ? S.loadedFromSource : S.flagReadonly;
      if (section.origin) section.origin.textContent = doc!.origin === 'deployment' ? S.originDeployment : doc!.origin === 'package' ? S.originPackage : S.originWorld;
    }
  }
  function open(section: Section, expanded: boolean): void {
    if (section.collapsed === !expanded) return;
    const index = sections.indexOf(section);
    editor.setCollapsed(index, !expanded);
  }
  function animateSection(section: Section, index: number): void {
    if (section.collapsed || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const targets = host.querySelectorAll(`[data-prompt-section="${index}"]`);
    for (const target of [...targets, section.note]) {
      target.getAnimations().forEach((animation) => animation.cancel());
      target.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    }
  }
  const expand = ui.button(S.expandAll, { size: 'sm', onClick: () => {
    const expanded = sections.some((s) => s.collapsed);
    for (const section of sections) open(section, expanded);
  } });
  const undoStep = ui.button(S.undo, { size: 'sm', onClick: () => editor.undo() });
  undoStep.title = 'Ctrl / ⌘ + Z';
  undoStep.disabled = true;
  const restore = ui.button(S.undoAll, { size: 'sm', onClick: () => {
    closePopup();
    editor.restore(new Map([...dirty.keys()].map((key) => [key, docs.get(key)!.content])));
  } });
  restore.title = S.undoAllHint;
  restore.disabled = true;
  const save = ui.button(S.saveToFile, { size: 'sm', onClick: () => { void saveAll(); } });
  save.title = 'Ctrl / ⌘ + S';
  actions.append(expand, undoStep, restore, save);
  toolbar.append(status, actions);

  /** Reads the rendered prefix into `segments` and the full preview; on failure `segments` keeps its value. */
  async function fetchPrefix(): Promise<boolean> {
    try {
      segments = (await get<{ segments: PrefixSegment[] }>('/api/prompts/prefix', { signal })).segments;
      full.textContent = segments.length ? segments.map((s) => s.text).join('') : S.prefixEmpty;
      return true;
    } catch (error) {
      if (!signal.aborted) { full.textContent = S.prefixUnavailable; ctx.onError(error); }
      return false;
    }
  }
  /** Rebuilds the sections from the server. Templates with unsaved edits keep their text, revision and undo history. */
  async function load(): Promise<boolean> {
    try {
      const [sources, prefix] = await Promise.all([get<{ prompts: PromptDoc[] }>('/api/prompts', { signal }), fetchPrefix()]);
      for (const doc of sources.prompts) {
        const old = docs.get(doc.key);
        doc.content = editor.view.state.toText(doc.content).toString();
        docs.set(doc.key, old && dirty.has(doc.key) ? { ...doc, content: old.content, revision: old.revision, origin: old.origin } : doc);
      }
      if (!prefix) segments = [];
      closePopup();
      for (const section of sections) {
        observer.unobserve(section.note);
        if (section.origin) observer.unobserve(section.origin);
      }
      sections.length = 0;
      flags.replaceChildren();
      rail.replaceChildren();
      dividers.replaceChildren();
      segments.forEach(addSection);
      for (const doc of docs.values()) {
        if (doc.role === 'envPrompt' && !segments.some((s) => s.sourceKey === doc.key)) addSection({ title: doc.title, sourceKey: doc.key, text: '' });
      }
      editor.setBlocks(sections.map(({ segment, collapsed }) => {
        const doc = docs.get(segment.sourceKey!);
        return {
          title: segment.title, description: description(segment, doc).detail, sourceKey: doc?.key,
          tone: doc ? doc.key.startsWith('worlds.') ? 'world' : 'persona' : 'derived',
          text: doc ? dirty.get(doc.key) ?? doc.content : segment.text, vars: doc?.vars, collapsed, preview: !!doc && previews.has(doc.key),
        };
      }));
      editor.restore(new Map([...docs.values()].filter((doc) => !dirty.has(doc.key)).map((doc) => [doc.key, doc.content])));
      expand.textContent = sections.every((s) => !s.collapsed) ? S.collapseAll : S.expandAll;
      for (const section of sections) section.updateVariables();
      state();
      if (!prefix) say(S.prefixUnavailable, true);
      else if (!segments.length) say(S.prefixEmpty);
      void addSettings();
      return true;
    } catch (error) {
      if (!signal.aborted) { ctx.onError(error); say(S.loadFailed(String(error)), true); }
      return false;
    }
  }
  async function persist(): Promise<boolean> {
    for (const [key, content] of [...dirty]) {
      const doc = docs.get(key)!;
      try {
        const out = await post<{ revision: string }>('/api/prompts', { key, content, baseRevision: doc.revision }, { signal });
        doc.content = content;
        doc.revision = out.revision;
        if (doc.origin) doc.origin = 'deployment';
        const current = editor.text(key);
        if (current === content) dirty.delete(key); else dirty.set(key, current);
        pendingApply = true;
      } catch (error) {
        if (!signal.aborted) {
          ctx.onError(error);
          state();
          say(S.saveFailedFor(doc.title, String(error)), true);
        }
        return false;
      }
    }
    await fetchPrefix();
    state();
    return dirty.size === 0;
  }
  function saveAll(): Promise<boolean> {
    if (savePromise) return savePromise;
    if (!dirty.size) return Promise.resolve(true);
    say(S.saving);
    editor.setSaveState('saving');
    save.disabled = restore.disabled = true;
    savePromise = persist().finally(() => {
      savePromise = null;
      controls();
      editor.setSaveState(dirty.size ? 'dirty' : 'saved');
    });
    return savePromise;
  }
  if (ctx.capabilities.sessionControl) {
    const reload = ui.button(S.reloadSession, { size: 'sm', onClick: () => { void reloadPrefix(reload); } });
    actions.append(reload);
  }
  async function reloadPrefix(button: HTMLButtonElement): Promise<void> {
    changingSession = true;
    controls();
    try {
      if (!await saveAll()) return;
      say(S.reloading);
      const out = await post<{ result?: string }>('/api/session/reload-prefix', undefined, { signal });
      pendingApply = false;
      if (await load() && !dirty.size) say(out.result || S.prefixReloaded);
    } catch (error) {
      if (!signal.aborted) { ctx.onError(error); say(String(error), true); }
    } finally {
      changingSession = false;
      controls();
      button.focus({ preventScroll: true });
    }
  }
  ctx.lifecycle.own(ctx.router.addLeaveGuard(() => dirty.size || savePromise ? S.leaveUnsaved : null));
  window.addEventListener('beforeunload', (event) => {
    if (dirty.size || savePromise) event.preventDefault();
  }, { signal });
  root.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.defaultPrevented) return;
    const key = event.key.toLowerCase();
    if (key === 's') { event.preventDefault(); if (!changingSession) void saveAll(); }
    else if (!(event.target as Element).closest('.cm-editor')) {
      if (key === 'z') { event.preventDefault(); event.shiftKey ? editor.redo() : editor.undo(); }
      if (key === 'y') { event.preventDefault(); editor.redo(); }
    }
  }, { signal });

  let geometryFrame = 0;
  const editor = createPrefixEditor({
    parent: host,
    onChange(changes) {
      for (const { sourceKey, text } of changes) {
        const doc = docs.get(sourceKey)!;
        if (text === doc.content) dirty.delete(sourceKey); else dirty.set(sourceKey, text);
      }
      state();
      for (const section of sections) section.updateVariables();
      queueMicrotask(() => editor.setSaveState(savePromise ? 'saving' : dirty.size ? 'dirty' : 'idle'));
    },
    onSave: () => { if (!changingSession) void saveAll(); },
    onHistory: controls,
    onGeometry: scheduleGeometry,
    onFold(index, collapsed) {
      const section = sections[index];
      section.collapsed = collapsed;
      folds.set(section.segment.sourceKey ?? section.segment.title, collapsed);
      try { sessionStorage.setItem(FOLDS_KEY, JSON.stringify([...folds])); } catch { /* Kept in memory. */ }
      section.toggle.setAttribute('aria-expanded', String(!collapsed));
      section.cell.hidden = collapsed;
      if (section.origin) section.origin.hidden = collapsed;
      closePopup();
      expand.textContent = sections.every((s) => !s.collapsed) ? S.collapseAll : S.expandAll;
      queueMicrotask(() => animateSection(section, index));
      scheduleGeometry();
    },
  });
  ctx.lifecycle.own(editor);
  function scheduleGeometry(): void {
    if (!geometryFrame) geometryFrame = requestAnimationFrame(() => { geometryFrame = 0; positionSides(); });
  }
  function positionSides(): void {
    root.style.setProperty('--prompt-rail-top', `${toolbar.offsetHeight + 12}px`);
    const geometry = editor.blockGeometry();
    const offset = editor.contentTop() - stage.getBoundingClientRect().top;
    const spacing = geometry.map((g, index) => {
      const section = sections[index];
      const top = `${g.top + offset}px`;
      section.label.style.top = top;
      section.cell.style.top = top;
      section.cell.style.height = `${g.height}px`;
      section.divider.style.top = top;
      section.divider.style.left = `${flags.offsetWidth}px`;
      const flagHeight = section.toggle.offsetHeight;
      section.label.style.setProperty('--prompt-flag-height', `${flagHeight}px`);
      const minHeight = Math.ceil(Math.max(50, section.note.offsetHeight + 12, section.origin && !g.collapsed ? flagHeight / 2 + section.origin.offsetHeight + 32 : 0));
      return { minHeight, padding: g.collapsed ? 0 : Math.max(0, Math.ceil(minHeight - (g.height - g.padding))) };
    });
    flags.style.height = rail.style.height = `${host.offsetHeight}px`;
    editor.setSpacing(spacing);
  }
  function applyWidths(): void {
    flags.style.flexBasis = `${colWidth.flags}px`;
    rail.style.flexBasis = `${colWidth.rail}px`;
    scheduleGeometry();
  }
  function bindGrip(grip: HTMLElement, side: 'flags' | 'rail'): void {
    grip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const start = colWidth[side];
      const move = (e: PointerEvent) => {
        colWidth[side] = Math.max(96, Math.min(460, start + (e.clientX - startX) * (side === 'flags' ? 1 : -1)));
        applyWidths();
      };
      const end = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('lostpointercapture', end);
      };
      grip.addEventListener('pointermove', move, { signal });
      grip.addEventListener('lostpointercapture', end, { signal });
    }, { signal });
  }
  bindGrip(gripL, 'flags');
  bindGrip(gripR, 'rail');
  applyWidths();
  const observer = new ResizeObserver(scheduleGeometry);
  observer.observe(stage);
  observer.observe(toolbar);
  observer.observe(flags);
  observer.observe(rail);
  ctx.lifecycle.own({ dispose() { observer.disconnect(); cancelAnimationFrame(geometryFrame); } });

  let popup: HTMLElement | null = null;
  let popupChip: HTMLElement | null = null;
  function closePopup(): void {
    popup?.remove(); popup = null;
    popupChip?.setAttribute('aria-expanded', 'false'); popupChip = null;
  }
  document.addEventListener('click', (event) => {
    if (!popup?.contains(event.target as Node) && !popupChip?.contains(event.target as Node)) closePopup();
  }, { signal });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePopup(); }, { signal });
  document.addEventListener('scroll', (event) => {
    if (popup && !popup.contains(event.target as Node)) closePopup();
  }, { signal, capture: true, passive: true });
  ctx.lifecycle.own({ dispose: closePopup });

  function varPopup(v: PromptVar): HTMLElement {
    const pop = ui.h('div', 'varpop');
    pop.appendChild(ui.h('div', 'varpop-name mono', `{{${v.name}}}`));
    pop.appendChild(ui.h('div', 'varpop-desc', v.description));
    pop.appendChild(ui.h('div', 'varpop-label', v.multiline ? S.fillNowMultiline : S.fillNow));
    const val = ui.h('pre', 'mono varpop-value');
    val.textContent = v.value === undefined ? S.varUnreported : v.value === '' ? S.varEmpty : v.value;
    pop.appendChild(val);
    return pop;
  }

  function addSection(segment: PrefixSegment): void {
    const doc = segment.sourceKey ? docs.get(segment.sourceKey) : undefined;
    const info = description(segment, doc);
    const collapsed = folds.get(segment.sourceKey ?? segment.title) ?? false;
    const tone = segment.sourceKey?.startsWith('worlds.') ? 'world' : doc ? 'persona' : 'derived';
    const label = ui.h('div', `prefix-label tone-${tone}`);
    label.dataset.source = segment.sourceKey || segment.title;
    const toggle = ui.button('', { onClick: () => open(section, section.collapsed) });
    toggle.className = 'prefix-flag';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const title = ui.h('span', 'prefix-flag-title', info.title);
    const key = segment.sourceKey;
    const meta = ui.h('span', 'prefix-flag-meta');
    const badge = ui.h('span', 'prompt-section-badge');
    if (key) meta.append(ui.h('span', 'prefix-flag-key mono', key));
    meta.append(badge);
    toggle.append(title, meta);
    label.append(toggle);
    const cell = ui.h('div', `prefix-railcell tone-${tone}`);
    const note = ui.h('div', 'prefix-railcontent');
    cell.append(note);
    cell.hidden = collapsed;
    const divider = ui.h('div', `prefix-divider tone-${tone}`);
    flags.append(label);
    rail.append(cell);
    dividers.append(divider);
    observer.observe(note);
    const section: Section = { segment, label, toggle, cell, note, badge, divider, collapsed, updateVariables() {} };
    sections.push(section);
    if (!doc) return;
    const chips = new Map<string, HTMLButtonElement>();
    const warning = ui.h('div', 'prompt-railwarn');
    if (doc.origin) {
      section.origin = ui.h('p', 'prompt-help prefix-origin');
      section.origin.hidden = collapsed;
      label.append(section.origin);
      observer.observe(section.origin);
    }
    if (doc.vars?.length) {
      note.append(ui.h('div', 'prompt-rail-heading', S.variablesTitle), ui.h('p', 'prompt-help', S.insertHint));
      const preview = ui.button(previews.has(doc.key) ? S.showVariableNames : S.previewVariables, { size: 'sm', onClick: () => {
        closePopup();
        const previewing = !previews.has(doc.key);
        if (previewing) previews.add(doc.key); else previews.delete(doc.key);
        editor.setPreview(doc.key, previewing);
        preview.textContent = previewing ? S.showVariableNames : S.previewVariables;
        preview.setAttribute('aria-pressed', String(previewing));
        if (previewing) void refreshVariables(section, doc);
      } });
      preview.classList.add('prompt-preview-toggle');
      preview.setAttribute('aria-pressed', String(previews.has(doc.key)));
      const list = ui.h('div', 'prompt-variable-list');
      note.append(list, preview);
      for (const variable of doc.vars) {
        let insertPosition = 0;
        const chip = ui.button(variable.name, { size: 'sm', onClick: () => {
          if (popupChip === chip) { closePopup(); return; }
          closePopup();
          const current = doc.vars!.find((v) => v.name === variable.name)!;
          popup = varPopup(current);
          root.ownerDocument.body.append(popup);
          popupChip = chip;
          chip.setAttribute('aria-expanded', 'true');
          const rect = chip.getBoundingClientRect();
          popup.style.left = `${Math.max(8, rect.left - popup.offsetWidth - 10)}px`;
          popup.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - popup.offsetHeight - 8))}px`;
        } });
        chip.className += ' varchip mono';
        chip.draggable = true;
        chip.setAttribute('aria-expanded', 'false');
        chip.addEventListener('mousedown', (event) => { if (event.detail === 1) insertPosition = editor.view.state.selection.main.head; }, { signal });
        chip.addEventListener('dblclick', () => { closePopup(); editor.insert(doc.key, variable.name, insertPosition); }, { signal });
        chip.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); closePopup(); editor.insert(doc.key, variable.name); }
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            const buttons = [...chips.values()];
            const next = buttons[buttons.indexOf(chip) + (event.key === 'ArrowDown' ? 1 : -1)];
            if (next) {
              next.focus({ preventScroll: true });
              if (popupChip !== next) next.click();
            }
          }
        }, { signal });
        chip.addEventListener('dragstart', (event) => {
          closePopup();
          event.dataTransfer!.setData(VARIABLE_DRAG_TYPE, JSON.stringify({ key: doc.key, name: variable.name }));
          event.dataTransfer!.effectAllowed = 'copy';
        }, { signal });
        chips.set(variable.name, chip);
        list.append(chip);
      }
    }
    note.append(warning);
    section.updateVariables = () => {
      const used = new Set(references(editor.text(doc.key)).map((r) => r.name));
      for (const [name, chip] of chips) chip.classList.toggle('varchip-unused', !used.has(name));
      const unknown = [...used].filter((name) => doc.vars?.find((v) => v.name === name)?.value === undefined);
      warning.textContent = unknown.length ? S.warnUnknownVars(unknown.join(S.listSep)) : '';
    };
  }

  async function addSettings(): Promise<void> {
    try {
      const manifest = await fetchManifest({ signal });
      for (const section of sections) {
        const page = manifest.providers.find((p) => p.kind === 'world' && p.prompts?.some((p) => p.key === section.segment.sourceKey));
        if (!page) continue;
        section.toggle.querySelector('.prefix-flag-title')!.textContent = page.label;
        if (manifest.framework.capabilities.config === false || !page.configGroups?.length) continue;
        const settings = ui.button(S.worldSettings, { size: 'sm', variant: 'primary', onClick: () => {
          ctx.router.navigate(['provider', page.id, '~config']);
        } });
        settings.classList.add('prompt-settings-link');
        section.note.insertBefore(settings, section.note.querySelector('.prompt-railwarn'));
        scheduleGeometry();
      }
    } catch (error) { if (!signal.aborted) ctx.onError(error); }
  }
  async function refreshVariables(section: Section, doc: PromptDoc): Promise<void> {
    try {
      const data = await get<{ prompts: PromptDoc[] }>('/api/prompts', { signal });
      doc.vars = data.prompts.find((source) => source.key === doc.key)?.vars;
      editor.updateVariables(doc.key, doc.vars ?? []);
      section.updateVariables();
    } catch (error) { if (!signal.aborted) say(S.loadFailed(String(error)), true); }
  }
  await load();
}

export const promptsFeature: FrameworkFeature = {
  route: 'prompts', label: S.title, icon: 'text', navMode: 'persona', needsAny: ['prompts'], mount: mountPrompts,
};
