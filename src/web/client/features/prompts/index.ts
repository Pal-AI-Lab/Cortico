/**
 * Each section edits its source template; previews and generated sections come from Core.
 * The full prompt is the sections' text joined in order, as Core joins them for the model, rendered
 * from the current files.
 */
import { fetchManifest, get, post } from '../../core/api.ts';
import { icon, type WebUiIconName } from '../../ui/icons.ts';
import { pageIntro } from '../../ui/page.ts';
import { estTok } from '../live/context.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { createPrefixEditor, references, VARIABLE_DRAG_TYPE, type PrefixBlock } from './editor.ts';
import { S } from './strings.ts';
import { sharedTemplate } from './titles.ts';
import { fitVariableChips, variablePopup } from './variables.ts';
import type { PromptDoc } from './view.ts';
import { prefersStill } from '../../core/motion.ts';

interface PrefixSegment { title: string; text: string; sourceKey?: string }
interface Section {
  segment: PrefixSegment;
  /** The template this section edits; absent for generated text and for a source Core names but does not list. */
  doc?: PromptDoc;
  tone: PrefixBlock['tone'];
  label: HTMLElement;
  toggle: HTMLButtonElement;
  badge: HTMLElement;
  /** Spans the section's height in the label column so the variable list stays in view while it scrolls. */
  cell: HTMLElement;
  vars: HTMLElement;
  /** The variables heading; in `vars` once it has variables or a button to show. */
  heading: HTMLElement;
  /** The heading's buttons: the preview toggle and the World configuration shortcut. */
  tools: HTMLElement;
  divider: HTMLElement;
  collapsed: boolean;
  updateVariables(): void;
  /** Sizes each variable box to its name at the current column width. */
  fitVariables(): void;
}
let labelWidth = 190;
const FOLDS_KEY = 'cortico.prompt-folds';
let folds = new Map<string, boolean>();

/** Names the sections of Cortico's persona; any other section shows its template's own title and description. */
function description(segment: PrefixSegment, doc?: PromptDoc): { title: string; detail: string } {
  const shared = sharedTemplate(segment.sourceKey ?? segment.title);
  if (shared) return shared;
  switch (segment.sourceKey ?? segment.title) {
    case 'WORKSPACE': return { title: S.workspaceTitle, detail: S.workspaceDesc };
    case 'MEMORY': case 'memoryNote': return { title: S.memoryTitle, detail: doc?.description || S.memoryDesc };
    case 'PARTNER': return { title: S.partnerTitle, detail: doc?.description || S.partnerDesc };
    default: return { title: doc?.title || segment.title, detail: doc?.description ?? (segment.sourceKey ? '' : S.generatedDesc) };
  }
}

export async function mountPrompts(ctx: FeatureContext): Promise<void> {
  const { ui, root, signal } = ctx;
  try { folds = new Map(JSON.parse(sessionStorage.getItem(FOLDS_KEY) ?? '[]')); } catch { /* Keep this window's in-memory state if storage is unavailable. */ }
  const docs = new Map<string, PromptDoc>();
  const dirty = new Map<string, string>();
  const sections: Section[] = [];
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
  const grip = ui.h('div', 'prefix-grip');
  const dividers = ui.h('div', 'prefix-dividers');
  stage.append(flags, grip, host, dividers);
  const full = ui.h('pre', 'mono prefix-full');
  // Folded like the palette on 开始: a rule above, the prompt in a white box once opened.
  const preview = ui.foldSheet('full-prompt', { title: S.fullPreview });
  preview.el.classList.add('fold-plain', 'prefix-preview');
  preview.body.append(full);
  root.append(pageIntro(ui, S.title, S.introDesc), toolbar, stage, preview.el);

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
    say(dirty.size ? S.dirtyCount(dirty.size) : pendingApply ? S.pendingApply : S.prefixStats(segments.length, estTok(segments.map((s) => s.text).join('')).toLocaleString()));
    for (const { doc, toggle, badge } of sections) {
      const changed = !!doc && dirty.has(doc.key);
      badge.textContent = changed ? S.unsaved : doc ? S.editable : S.readOnly;
      if (doc && !segments.some((s) => s.sourceKey === doc.key)) badge.textContent += ` · ${S.outsidePrefix}`;
      badge.classList.toggle('is-dirty', changed);
      // a narrow label column cuts the title, key and badge short; the tooltip carries them whole
      toggle.title = [...toggle.querySelectorAll('.prefix-flag-title, .prefix-flag-key, .prompt-section-badge')].map((part) => part.textContent).join('\n');
    }
  }
  function open(section: Section, expanded: boolean): void {
    if (section.collapsed === !expanded) return;
    const index = sections.indexOf(section);
    editor.setCollapsed(index, !expanded);
  }
  function animateSection(section: Section, index: number): void {
    if (section.collapsed || prefersStill(window)) return;
    const targets = host.querySelectorAll(`[data-prompt-section="${index}"]`);
    for (const target of [...targets, section.vars]) {
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

  /**
   * Reloads the templates and the rendered prefix. A template without unsaved edits takes the listed
   * content, revision and origin; one with unsaved edits keeps its text, its undo history and the
   * revision it was loaded at.
   */
  async function refreshPreview(): Promise<boolean> {
    try {
      const [data, sources] = await Promise.all([
        get<{ segments: PrefixSegment[] }>('/api/prompts/prefix', { signal }),
        get<{ prompts: PromptDoc[] }>('/api/prompts', { signal }),
      ]);
      if (signal.aborted) return false;
      const listed = new Set(sources.prompts.map((doc) => doc.key));
      for (const key of docs.keys()) if (!listed.has(key) && !dirty.has(key)) docs.delete(key);
      for (const fresh of sources.prompts) {
        fresh.content = editor.view.state.toText(fresh.content).toString();
        const doc = docs.get(fresh.key);
        if (!doc) docs.set(fresh.key, fresh);
        else Object.assign(doc, fresh, dirty.has(doc.key) ? { content: doc.content, revision: doc.revision } : {});
      }
      segments = data.segments;
      layout();
      state();
      return true;
    } catch (error) {
      if (!signal.aborted) say(S.loadFailed(String(error)), true);
      return false;
    }
  }
  async function persist(): Promise<boolean> {
    for (const [key, content] of [...dirty]) {
      const doc = docs.get(key)!;
      try {
        const out = await post<{ revision: string }>('/api/prompts', { key, content, baseRevision: doc.revision }, { signal });
        if (signal.aborted) return false;
        doc.content = content;
        doc.revision = out.revision;
        const current = editor.text(key);
        if (current === content) dirty.delete(key); else dirty.set(key, current);
        pendingApply = true;
      } catch (error) {
        if (!signal.aborted) {
          state();
          say(S.saveFailedFor(doc.title, String(error)), true);
        }
        return false;
      }
    }
    return await refreshPreview() && dirty.size === 0;
  }
  function saveAll(): Promise<boolean> {
    if (savePromise) return savePromise;
    if (!dirty.size) return Promise.resolve(true);
    say(S.saving);
    editor.setSaveState('saving');
    save.disabled = restore.disabled = true;
    savePromise = persist().finally(() => {
      savePromise = null;
      if (signal.aborted) return;
      controls();
      editor.setSaveState(dirty.size ? 'dirty' : 'saved');
    });
    return savePromise;
  }
  if (ctx.capabilities.storage) {
    const restart = ui.button(S.restartSession, { size: 'sm', variant: 'danger', onClick: () => { void runSession(restart, true); } });
    restart.title = S.restartBody;
    actions.append(restart);
  }
  if (ctx.capabilities.sessionControl) {
    const apply = ui.button(S.reloadSession, { size: 'sm', variant: 'primary', onClick: () => { void runSession(apply, false); } });
    apply.title = S.applyHint;
    actions.append(apply);
  }
  async function runSession(button: HTMLButtonElement, restart: boolean): Promise<void> {
    changingSession = true;
    controls();
    try {
      if (restart && !await ui.confirm({ title: S.restartTitle, body: S.restartBody, danger: true })) return;
      if (signal.aborted || !await saveAll()) return;
      say(restart ? S.restartClearing : S.reloading);
      await post(restart ? '/api/storage/clear?owner=core&key=session' : '/api/session/reload-prefix', undefined, { signal });
      if (signal.aborted) return;
      pendingApply = false;
      if (await refreshPreview() && !dirty.size) say(restart ? S.restartCleared : S.prefixReloaded);
    } catch (error) {
      if (!signal.aborted) say(String(error), true);
    } finally {
      changingSession = false;
      if (!signal.aborted) controls();
      button.focus({ preventScroll: true });
    }
  }
  /** Set once the person has already accepted losing unsaved edits for the navigation under way. */
  ctx.lifecycle.own(ctx.router.addLeaveGuard(() => (dirty.size || savePromise) ? S.leaveUnsaved : null));
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
      queueMicrotask(() => {
        if (!signal.aborted) editor.setSaveState(savePromise ? 'saving' : dirty.size ? 'dirty' : 'idle');
      });
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
      closePopup();
      expand.textContent = sections.every((s) => !s.collapsed) ? S.collapseAll : S.expandAll;
      queueMicrotask(() => { if (!signal.aborted) animateSection(section, index); });
      scheduleGeometry();
    },
  });
  ctx.lifecycle.own(editor);
  function scheduleGeometry(): void {
    if (!geometryFrame) geometryFrame = requestAnimationFrame(() => { geometryFrame = 0; positionLabels(); });
  }
  function positionLabels(): void {
    root.style.setProperty('--prompt-sticky-top', `${toolbar.offsetHeight + 12}px`);
    const geometry = editor.blockGeometry();
    const offset = editor.contentTop() - stage.getBoundingClientRect().top;
    const spacing = geometry.map((g, index) => {
      const section = sections[index];
      if (!g.collapsed) section.fitVariables();
      const top = g.top + offset;
      // Flags are centred on section edges; the variables keep clear of this flag and the next one.
      const clearance = section.toggle.offsetHeight / 2 + 8;
      section.label.style.top = section.divider.style.top = `${top}px`;
      section.cell.style.top = `${clearance}px`;
      section.cell.style.height = `${Math.max(0, g.height - 2 * clearance)}px`;
      section.divider.style.left = `${flags.offsetWidth}px`;
      const minHeight = Math.ceil(Math.max(50, g.collapsed ? 0 : 2 * clearance + section.vars.offsetHeight));
      return { minHeight, padding: g.collapsed ? 0 : Math.max(0, Math.ceil(minHeight - (g.height - g.padding))) };
    });
    flags.style.height = `${host.offsetHeight}px`;
    editor.setSpacing(spacing);
  }
  function applyWidth(): void {
    flags.style.flexBasis = `${labelWidth}px`;
    scheduleGeometry();
  }
  grip.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const start = labelWidth;
    const move = (e: PointerEvent) => {
      labelWidth = Math.max(120, Math.min(320, start + e.clientX - startX));
      applyWidth();
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('lostpointercapture', end);
    };
    grip.addEventListener('pointermove', move, { signal });
    grip.addEventListener('lostpointercapture', end, { signal });
  }, { signal });
  applyWidth();
  const observer = new ResizeObserver(scheduleGeometry);
  observer.observe(stage);
  observer.observe(toolbar);
  observer.observe(flags);
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

  function toolButton(name: WebUiIconName, text: string, onClick: () => void): HTMLButtonElement {
    const button = ui.button('', { size: 'sm', onClick });
    button.classList.add('btn-ico', 'prompt-vars-tool');
    button.title = text;
    button.setAttribute('aria-label', text);
    button.append(icon(root.ownerDocument, name));
    return button;
  }

  function createSection(segment: PrefixSegment): Section {
    const doc = segment.sourceKey ? docs.get(segment.sourceKey) : undefined;
    const info = description(segment, doc);
    const collapsed = folds.get(segment.sourceKey ?? segment.title) ?? segment.sourceKey !== 'constitution';
    const tone = segment.sourceKey?.startsWith('worlds.') ? 'world' : doc ? 'persona' : 'derived';
    const label = ui.h('div', `prefix-label tone-${tone}`);
    label.dataset.source = segment.sourceKey || segment.title;
    const toggle = ui.button('', { onClick: () => open(section, section.collapsed) });
    toggle.className = 'prefix-flag';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const key = segment.sourceKey?.startsWith('worlds.') ? segment.sourceKey : segment.title;
    const meta = ui.h('span', 'prefix-flag-meta');
    const badge = ui.h('span', 'prompt-section-badge');
    meta.append(ui.h('span', 'prefix-flag-key mono', key), badge);
    toggle.append(ui.h('span', 'prefix-flag-title', info.title), meta);
    const cell = ui.h('div', 'prefix-varcell');
    const vars = ui.h('div', 'prefix-vars');
    cell.append(vars);
    cell.hidden = collapsed;
    label.append(toggle, cell);
    const divider = ui.h('div', `prefix-divider tone-${tone}`);
    observer.observe(vars);
    const tools = ui.h('span', 'prompt-vars-tools');
    const heading = ui.h('div', 'prompt-vars-heading');
    const title = ui.h('span', 'prompt-vars-title', S.variablesTitle);
    title.title = S.variablesTitle;
    heading.append(title, tools);
    const section: Section = { segment, doc, tone, label, toggle, badge, cell, vars, heading, tools, divider, collapsed, updateVariables() {}, fitVariables() {} };
    if (!doc) return section;
    const chips = new Map<string, HTMLButtonElement>();
    const warning = ui.h('div', 'prompt-varwarn');
    if (doc.vars?.length) {
      let previewing = false;
      const preview = toolButton('eye', S.previewVariables, () => {
        closePopup();
        previewing = !previewing;
        editor.setPreview(doc.key, previewing);
        const text = previewing ? S.showVariableNames : S.previewVariables;
        preview.title = text;
        preview.setAttribute('aria-label', text);
        preview.setAttribute('aria-pressed', String(previewing));
        if (previewing) void refreshVariables(doc.key);
      });
      preview.classList.add('prompt-preview-toggle');
      preview.setAttribute('aria-pressed', 'false');
      tools.append(preview);
      const list = ui.h('div', 'prompt-variable-list');
      vars.append(heading, ui.h('p', 'prompt-help', S.insertHint), list);
      for (const variable of doc.vars) {
        let insertPosition = 0;
        const chip = ui.button(variable.name, { size: 'sm', onClick: () => {
          if (popupChip === chip) { closePopup(); return; }
          closePopup();
          popup = variablePopup(ui, doc.vars?.find((v) => v.name === variable.name) ?? variable);
          root.ownerDocument.body.append(popup);
          popupChip = chip;
          chip.setAttribute('aria-expanded', 'true');
          const rect = chip.getBoundingClientRect();
          popup.style.left = `${Math.max(8, Math.min(rect.right + 10, window.innerWidth - popup.offsetWidth - 8))}px`;
          popup.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - popup.offsetHeight - 8))}px`;
        } });
        chip.className += ' varchip mono';
        chip.title = variable.name;
        chip.replaceChildren(ui.h('span', 'varchip-name', variable.name));
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
      section.fitVariables = () => fitVariableChips(list, chips);
    }
    vars.append(warning);
    section.updateVariables = () => {
      const used = new Set(references(editor.text(doc.key)).map((r) => r.name));
      for (const [name, chip] of chips) chip.classList.toggle('varchip-unused', !used.has(name));
      const unknown = [...used].filter((name) => doc.vars?.find((v) => v.name === name)?.value === undefined);
      warning.textContent = unknown.length ? S.warnUnknownVars(unknown.join(S.listSep)) : '';
    };
    return section;
  }

  /**
   * Matches the sections to the current prefix plus the templates it omits. A section whose source and
   * template presence are unchanged is reused with its fold, preview and variable list.
   */
  function layout(): void {
    closePopup();
    const omitted = [...docs.values()].filter((doc) => doc.role && !segments.some((s) => s.sourceKey === doc.key));
    const wanted = [...segments, ...omitted.map((doc) => ({ title: doc.title, sourceKey: doc.key, text: '' }))];
    const id = (segment: PrefixSegment) => segment.sourceKey ? `${docs.has(segment.sourceKey)}:${segment.sourceKey}` : segment.title;
    const previous = [...sections];
    const created: Section[] = [];
    sections.splice(0, sections.length, ...wanted.map((segment) => {
      const at = previous.findIndex((section) => id(section.segment) === id(segment));
      if (at < 0) {
        const section = createSection(segment);
        created.push(section);
        return section;
      }
      const [section] = previous.splice(at, 1);
      section.segment = segment;
      return section;
    }));
    for (const gone of previous) {
      gone.label.remove(); gone.divider.remove();
      observer.unobserve(gone.vars);
    }
    for (const section of sections) {
      flags.append(section.label);
      dividers.append(section.divider);
    }
    editor.setBlocks(sections.map(({ segment, doc, tone, collapsed }): PrefixBlock => ({
      title: segment.title, description: description(segment, doc).detail, sourceKey: doc?.key, tone,
      text: doc ? dirty.get(doc.key) ?? doc.content : segment.text, vars: doc?.vars, collapsed,
    })));
    full.textContent = segments.length ? segments.map((s) => s.text).join('') : S.prefixEmpty;
    expand.textContent = sections.every((s) => !s.collapsed) ? S.collapseAll : S.expandAll;
    for (const section of sections) section.updateVariables();
    if (created.length) void addSettings(created);
  }

  function openWorldConfig(pageId: string): void {
    ctx.router.navigate(['provider', pageId, '~config']);
  }

  async function addSettings(targets: Section[]): Promise<void> {
    try {
      const manifest = await fetchManifest();
      if (signal.aborted) return;
      for (const section of targets) {
        const page = manifest.providers.find((p) => p.kind === 'world' && p.prompts?.some((p) => p.key === section.segment.sourceKey));
        if (!page) continue;
        section.toggle.querySelector('.prefix-flag-title')!.textContent = page.label;
        if (manifest.framework?.capabilities?.config === false || !page.configGroups?.length) continue;
        const settings = toolButton('settings', S.worldSettings, () => openWorldConfig(page.id));
        settings.classList.add('prompt-settings-link');
        section.tools.append(settings);
        if (!section.heading.isConnected) section.vars.prepend(section.heading);
        scheduleGeometry();
      }
      state();
    } catch (error) { if (!signal.aborted) ctx.onError(error); }
  }
  async function refreshVariables(key: string): Promise<void> {
    try {
      const data = await get<{ prompts: PromptDoc[] }>('/api/prompts', { signal });
      if (signal.aborted) return;
      const section = sections.find((s) => s.doc?.key === key);
      const current = data.prompts.find((source) => source.key === key);
      if (!section || !current) return;
      closePopup();
      section.doc!.vars = current.vars;
      editor.updateVariables(key, current.vars ?? []);
      section.updateVariables();
    } catch (error) { if (!signal.aborted) say(S.loadFailed(String(error)), true); }
  }
  if (await refreshPreview() && !segments.length) say(S.prefixEmpty);
}

export const promptsFeature: FrameworkFeature = {
  route: 'prompts', label: S.title, icon: 'text', navMode: 'primary', needsAny: ['prompts'], mount: mountPrompts,
};
