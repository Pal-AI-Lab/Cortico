/** 可编辑提示词模板的共享视图。统一管理页、core 与 provider 归属页复用同一实现。 */

import type { WebUi, Disposable } from '../../../shared/client-panel.ts';
import { get, post } from '../../core/api.ts';
import type { Lifecycle } from '../../core/lifecycle.ts';
import { S } from './strings.ts';
import type { EnvPromptOrigin } from '../../../../core/prefix.ts';

/** 一个占位符:声明 + 此刻的实际展开值。 */
export interface PromptVar {
  name: string;
  description: string;
  multiline?: boolean;
  /** 缺席 = 没人报这个值(模板里用了它就会原样留在前缀里) */
  value?: string;
}

export interface PromptDoc {
  key: string;
  title: string;
  scope?: string;
  description?: string;
  content: string;
  revision?: string;
  role?: 'envPrompt' | 'prefix';
  /** 当前模板来源：部署覆盖、bot 包覆盖或 World 默认。 */
  origin?: EnvPromptOrigin;
  vars?: PromptVar[];
}

export interface PromptsViewDeps {
  ui: WebUi;
  lifecycle: Lifecycle;
  signal: AbortSignal;
  addLeaveGuard(fn: () => string | null): Disposable;
  onError(err: unknown): void;
  /** 只展示这些源；省略时展示全部。 */
  keys?: readonly string[];
}

export interface PromptsView {
  el: HTMLElement;
  load(): Promise<void>;
}

/** 模板里用到的占位符名(与后端 templateVarNames 同一套语法)。 */
export function usedVarNames(template: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*([\w.]+)\s*(?:\|[^}]*)?\}\}/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); names.push(m[1]); }
  }
  return names;
}

/**
 * 模板与声明对不上的地方。**警告不阻止保存**——改坏了自己负责,是这套编辑器的
 * 明确取舍;框架只把事实摆出来。
 */
export function varWarnings(template: string, vars: readonly PromptVar[]): string[] {
  const declared = new Set(vars.map((v) => v.name));
  const used = new Set(usedVarNames(template));
  const out: string[] = [];
  const unknown = [...used].filter((n) => !declared.has(n));
  if (unknown.length) out.push(S.warnUnknownVars(unknown.map((n) => `{{${n}}}`).join(S.listSep)));
  const unused = vars.filter((v) => !used.has(v.name)).map((v) => v.name);
  if (unused.length) out.push(S.warnUnusedVars(unused.join(S.listSep)));
  return out;
}

/** 占位符旁注:名字 + 说明 + **此刻会填进去的东西**(比说明直观)。 */
function renderVarPanel(ui: WebUi, vars: readonly PromptVar[], onInsert?: (name: string) => void): HTMLElement {
  const box = ui.h('div', 'prompt-vars');
  box.appendChild(ui.h('b', null, S.varPanelTitle));
  for (const v of vars) {
    const row = ui.h('div', 'prompt-var');
    const head = ui.h('div', 'prompt-var-head');
    const name = ui.button(`{{${v.name}}}`, {
      size: 'sm',
      onClick: () => onInsert?.(v.name),
    });
    name.className += ' prompt-var-name';
    head.appendChild(name);
    if (v.multiline) head.appendChild(ui.chip(S.multiline, 'plain'));
    row.appendChild(head);
    row.appendChild(ui.h('div', 'prompt-var-desc', v.description));
    const now = ui.h('pre', 'mono prompt-var-value');
    now.textContent = v.value === undefined
      ? S.varUnreportedShort
      : v.value === ''
        ? S.varEmptyShort
        : v.value;
    row.appendChild(now);
    box.appendChild(row);
  }
  return box;
}

export function createPromptsView(deps: PromptsViewDeps): PromptsView {
  const { ui } = deps;
  const el = ui.h('div', 'prompt-library');
  const dirty = new Map<string, boolean>();
  const wanted = deps.keys ? new Set(deps.keys) : null;

  deps.lifecycle.own(
    deps.addLeaveGuard(() => {
      const names = [...dirty.entries()].filter(([, changed]) => changed).map(([name]) => name);
      return names.length ? S.leaveUnsavedNamed(names.join(S.listSep)) : null;
    }),
  );

  const card = (doc: PromptDoc): HTMLElement => {
    const sheet = ui.sheet({
      title: doc.title,
      en: S.editableTemplate,
      desc: doc.description || S.cardDescDefault,
    });
    sheet.el.className += ' prompt-card';
    let revision = doc.revision;
    /** World 的环境提示词多说一句此刻读的是哪一层:保存永远落到部署层,包与 World 那两份不动。 */
    const loadedText = (): string => doc.origin === 'deployment'
      ? S.loadedFromDeployment
      : doc.origin === 'package'
        ? S.loadedFromPackage
        : doc.origin === 'module'
          ? S.loadedFromWorld
          : S.loadedFromSource;
    const state = ui.msgline(loadedText());
    state.className += ' prompt-state';
    const warn = ui.msgline('');
    warn.className += ' prompt-warn';
    const area = ui.textarea({
      value: doc.content,
      rows: 16,
      cls: 'mono',
      onInput: () => {
        const changed = area.value !== doc.content;
        dirty.set(doc.title, changed);
        state.textContent = changed ? S.unsaved : loadedText();
        refreshWarn();
      },
      onCommit: () => void save(),
    });
    const saveBtn = ui.button(S.saveToFile, { variant: 'primary', onClick: () => void save() });
    const resetBtn = ui.button(S.resetToWorld, { onClick: () => void reset() });
    resetBtn.hidden = doc.origin !== 'deployment';

    function refreshWarn(): void {
      const msgs = varWarnings(area.value, doc.vars ?? []);
      warn.textContent = msgs.join(S.warnSep);
      warn.className = msgs.length ? 'msgline prompt-warn bad' : 'msgline prompt-warn';
    }

    async function save(): Promise<void> {
      const off = ui.disable(saveBtn, area);
      state.textContent = S.saving;
      try {
        const out = await post<{ error?: string; result?: string; revision?: string }>(
          '/api/prompts',
          { key: doc.key, content: area.value, baseRevision: revision },
          { signal: deps.signal },
        );
        if (out?.error) throw new Error(out.error);
        doc.content = area.value;
        revision = out?.revision;
        // 保存永远写部署层,所以存过一次之后这份就来自部署层了。
        if (doc.origin && doc.origin !== 'deployment') {
          doc.origin = 'deployment';
          resetBtn.hidden = false;
        }
        dirty.set(doc.title, false);
        state.textContent = S.savedResult(out?.result ?? S.saved);
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') return;
        deps.onError(err);
        state.textContent = S.saveFailed(String((err as Error)?.message ?? err));
        ui.toast(S.saveFailedToast, 'bad');
      } finally {
        off.dispose();
      }
    }

    /** 删掉 bot 侧覆盖文件,整页重载:这份模板回到 World 自带的版本。 */
    async function reset(): Promise<void> {
      const yes = await ui.confirm({
        title: S.resetTitle(doc.title),
        body: S.resetBody,
        danger: true,
      });
      if (!yes) return;
      const off = ui.disable(saveBtn, resetBtn, area);
      state.textContent = S.resetting;
      try {
        const out = await post<{ error?: string; result?: string }>(
          '/api/prompts/reset',
          { key: doc.key },
          { signal: deps.signal },
        );
        if (out?.error) throw new Error(out.error);
        dirty.set(doc.title, false);
        ui.toast(out?.result ?? S.resetDone, 'ok');
        await load();
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') return;
        deps.onError(err);
        state.textContent = S.resetFailed(String((err as Error)?.message ?? err));
        ui.toast(S.resetFailedToast, 'bad');
      } finally {
        off.dispose();
      }
    }

    const bar = ui.actions();
    bar.append(state, ui.h('span', 'grow'), resetBtn, saveBtn);
    sheet.body.append(area, warn, bar);
    if (doc.vars?.length) {
      sheet.body.appendChild(renderVarPanel(ui, doc.vars, (name) => {
        insertAtCursor(area, `{{${name}}}`);
        dirty.set(doc.title, true);
        state.textContent = S.unsaved;
        refreshWarn();
      }));
    }
    refreshWarn();
    return sheet.el;
  };

  async function load(): Promise<void> {
    el.replaceChildren();
    dirty.clear();
    try {
      const data = await get<{ prompts?: PromptDoc[] }>('/api/prompts', { signal: deps.signal });
      const docs = (data?.prompts ?? []).filter((doc) => !wanted || wanted.has(doc.key));
      if (!docs.length) {
        el.appendChild(ui.placeholder(wanted ? S.noTemplatesScoped : S.noTemplates));
        return;
      }
      for (const doc of docs) el.appendChild(card(doc));
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      deps.onError(err);
      el.appendChild(ui.placeholder(S.templatesLoadFailed(String((err as Error)?.message ?? err))));
    }
  }

  return { el, load };
}

/** 在光标处插入文本(没有选区就追加到末尾)。 */
function insertAtCursor(area: HTMLTextAreaElement, text: string): void {
  const start = area.selectionStart ?? area.value.length;
  const end = area.selectionEnd ?? start;
  area.value = area.value.slice(0, start) + text + area.value.slice(end);
  area.selectionStart = area.selectionEnd = start + text.length;
  area.focus();
}
