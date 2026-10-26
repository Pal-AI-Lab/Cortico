/**
 * 按 ConfigGroup JSON Schema 渲染配置，供框架设置与贡献页使用。
 * 可编辑 integer、number、boolean、string（enum / x-options）和双数值数组；其余只读且不提交。
 * x-scale：显示值 = 存储值 / scale，提交时乘回；取整与范围校验由后端完成。
 * x-suffix 提供单位；x-hot=false 的 World 配置需重启 World，其余需重启进程。
 * x-options 动态获取候选；x-path 选择服务器本机路径；x-download 提供浏览器下载链接。
 */

import type { WebUi, Disposable } from '../../../shared/client-panel.ts';
import { get, pickPath, post } from '../../core/api.ts';
import type { Lifecycle } from '../../core/lifecycle.ts';
import { icon } from '../../ui/icons.ts';
import { S } from './strings.ts';

/** 连续输入的请求去抖间隔。 */
const SAVE_DEBOUNCE_MS = 400;

/** 一条属性的声明。字段与 `src/core/config-schema.ts` 的 `ConfigProperty` 同形。 */
export interface ConfigProperty {
  type?: string;
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  enum?: string[];
  items?: { type?: string; minimum?: number; maximum?: number };
  nullable?: boolean;
  'x-scale'?: number;
  'x-suffix'?: string;
  'x-hot'?: boolean;
  'x-warning'?: boolean;
  'x-options'?: string;
  'x-path'?: {
    kind: 'file' | 'directory';
    extensions?: string[];
    recommendedDir?: string;
  };
  'x-download'?: {
    href: string;
    label?: string;
  };
}

type OptionItem = { value: string; label: string };

/**
 * `/api/config/options/:kind` 给的整张表原样画;当前值不在表里也留下,避免写不回。
 * "系统默认 / 静音"这类固定项也由声明该 kind 的一方随表给出——WebUI 不认识任何 kind。
 */
function mergeOptionList(live: OptionItem[], current: string): OptionItem[] {
  const seen = new Set<string>();
  const out: OptionItem[] = [];
  const add = (value: string, label: string): void => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ value, label });
  };
  for (const item of live) add(item.value, item.label);
  if (!seen.has(current)) add(current, current || S.optionCurrent);
  return out;
}

function fillSelect(ui: WebUi, sel: HTMLSelectElement, items: OptionItem[], current: string): void {
  sel.replaceChildren();
  for (const item of items) {
    const opt = ui.h('option', null, item.label);
    opt.value = item.value;
    sel.appendChild(opt);
  }
  sel.value = current;
}

export interface ConfigGroup {
  id: string;
  owner: string;
  schema: {
    title?: string;
    description?: string;
    properties?: Record<string, ConfigProperty>;
  };
}

export type ConfigValue = number | boolean | string | null | [number, number];

export interface ConfigGroupEntry {
  group: ConfigGroup;
  values?: Record<string, ConfigValue>;
}

/**
 * 一个渲染好的字段：节点 + **存储单位**的取值器与赋值器。
 * `read` 为 `null` 表示这一项只读（不认识的 type），不参与提交，`write` 同为 `null`。
 * `write` 是程序赋值，不触发 onChange。
 */
export interface ConfigField {
  node: HTMLElement;
  read: (() => ConfigValue) | null;
  write: ((value: unknown) => void) | null;
}

/** 只翻译框架自己认识的 owner；`core` 与 `world:<id>` 这类原样显示。 */
const OWNER_LABEL: Record<string, string> = {
  'persona': S.ownerPersona,
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/**
 * `x-options` 下拉。页加载先探一次(原生 `<select>` 同步弹出,第一次打开用这份);
 * pointerdown/focus 再探,给下次打开用。探测失败只留当前值。
 */
function optionsField(
  ui: WebUi,
  kind: string,
  current: string,
  onChange: () => void,
  signal?: AbortSignal,
): ConfigField {
  const sel = ui.select({
    options: mergeOptionList([], current),
    value: current,
    onChange,
  });
  let seq = 0;
  let live: OptionItem[] = [];
  const refresh = (): void => {
    const n = ++seq;
    void get<{ options?: OptionItem[] }>(
      `/api/config/options/${encodeURIComponent(kind)}`,
      signal ? { signal } : undefined,
    ).then((d) => {
      if (n !== seq || signal?.aborted) return;
      live = Array.isArray(d.options) ? d.options : [];
      fillSelect(ui, sel, mergeOptionList(live, sel.value), sel.value);
    }).catch((err: unknown) => {
      if (isAbort(err) || signal?.aborted) return;
    });
  };
  const listenOpts = signal ? { signal } : undefined;
  sel.addEventListener('pointerdown', refresh, listenOpts);
  sel.addEventListener('focus', refresh, listenOpts);
  refresh();
  return {
    node: sel,
    read: () => sel.value,
    write: (value) => {
      const next = value == null ? '' : String(value);
      if (next !== sel.value) fillSelect(ui, sel, mergeOptionList(live, next), next);
    },
  };
}

function httpDownloadHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function pathField(
  ui: WebUi,
  prop: ConfigProperty,
  current: string,
  onChange: () => void,
  signal?: AbortSignal,
): ConfigField {
  const spec = prop['x-path']!;
  const input = ui.input({ type: 'text', value: current, onChange });
  const controls = ui.h('div', 'pathfield-controls');
  const choose = ui.button('', {
    size: 'sm',
    onClick: () => {
      choose.disabled = true;
      void pickPath({
        kind: spec.kind,
        title: prop.title,
        currentPath: input.value.trim() || undefined,
        recommendedDir: spec.recommendedDir,
        extensions: spec.extensions,
      }, signal ? { signal } : undefined).then((selected) => {
        if (!selected || signal?.aborted) return;
        input.value = selected;
        onChange();
      }).catch((err: unknown) => {
        if (isAbort(err) || signal?.aborted) return;
        ui.toast(errText(err), 'bad');
      }).finally(() => {
        choose.disabled = false;
      });
    },
  });
  choose.className += ' pathpick';
  choose.title = spec.kind === 'file' ? S.chooseFile : S.chooseDirectory;
  choose.setAttribute('aria-label', choose.title);
  choose.appendChild(icon(choose.ownerDocument, 'folder-open'));
  controls.append(input, choose);

  const field = ui.h('div', 'pathfield');
  field.appendChild(controls);
  const meta = ui.h('div', 'pathfield-meta');
  if (spec.recommendedDir) {
    const recommended = ui.h('span', 'pathrecommended', S.recommendedDir(spec.recommendedDir));
    recommended.title = spec.recommendedDir;
    meta.appendChild(recommended);
  }
  const download = prop['x-download'];
  const href = download ? httpDownloadHref(download.href) : null;
  if (download && href) {
    const link = ui.h('a', 'pathdownload');
    link.setAttribute('href', href);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    link.append(icon(link.ownerDocument, 'download'), ui.h('span', null, download.label || S.download));
    meta.appendChild(link);
  }
  if (meta.children.length) field.appendChild(meta);
  return {
    node: field,
    read: () => input.value,
    write: (value) => { input.value = value == null ? '' : String(value); },
  };
}

/** 渲染属性并返回存储单位的取值器；值变化经 onChange 提交。 */
export function configField(
  ui: WebUi,
  prop: ConfigProperty,
  val: unknown,
  onChange?: () => void,
  signal?: AbortSignal,
): ConfigField {
  const changed = (): void => onChange?.();
  const text = (v: unknown): string => (v == null ? '' : String(v));
  if (prop.type === 'boolean') {
    const box = ui.checkbox(S.on, { checked: !!val, onChange: changed });
    return { node: box.el, read: () => box.checked, write: (v) => box.setChecked(!!v) };
  }

  if (prop.type === 'string') {
    if (prop['x-options']) {
      return optionsField(ui, prop['x-options'], text(val), changed, signal);
    }
    if (Array.isArray(prop.enum)) {
      const first = prop.enum[0];
      const sel = ui.select({
        options: prop.enum,
        value: val == null ? first : String(val),
        onChange: changed,
      });
      return { node: sel, read: () => sel.value, write: (v) => { sel.value = v == null ? first : String(v); } };
    }
    if (prop['x-path']) {
      return pathField(ui, prop, text(val), changed, signal);
    }
    const inp = ui.input({ type: 'text', value: text(val), onChange: changed });
    return { node: inp, read: () => inp.value, write: (v) => { inp.value = text(v); } };
  }

  if (prop.type === 'integer' || prop.type === 'number') {
    const scale = prop['x-scale'] || 1;
    const inp = ui.input({ type: 'number', onChange: changed });
    if (prop.minimum != null) inp.min = String(prop.minimum / scale);
    if (prop.maximum != null) inp.max = String(prop.maximum / scale);
    if (prop.multipleOf != null) inp.step = String(prop.multipleOf / scale);
    if (prop.nullable) {
      // nullable 字段以空输入表示 null，0 保持为数值。
      const write = (v: unknown): void => { inp.value = v == null ? '' : String(Number(v) / scale); };
      write(val);
      inp.placeholder = S.leaveBlank;
      return {
        node: inp,
        read: () => (inp.value.trim() === '' ? null : Number(inp.value) * scale),
        write,
      };
    }
    const write = (v: unknown): void => { inp.value = String((Number(v) || 0) / scale); };
    write(val);
    return { node: inp, read: () => Number(inp.value) * scale, write };
  }

  // 仅两个 number/integer 的数组可编辑，其余数组只读。
  const itemType = prop.items?.type;
  if (prop.type === 'array' && (itemType === 'integer' || itemType === 'number')) {
    const scale = prop['x-scale'] || 1;
    const spec = prop.items || {};
    const mk = (): HTMLInputElement => {
      const inp = ui.input({ type: 'number', onChange: changed });
      if (spec.minimum != null) inp.min = String(spec.minimum / scale);
      if (spec.maximum != null) inp.max = String(spec.maximum / scale);
      return inp;
    };
    const a = mk();
    const b = mk();
    const write = (v: unknown): void => {
      const pair = Array.isArray(v) ? (v as unknown[]) : [0, 0];
      a.value = String((Number(pair[0]) || 0) / scale);
      b.value = String((Number(pair[1]) || 0) / scale);
    };
    write(val);
    const wrap = ui.h('div', 'pairfield');
    wrap.append(a, ui.h('span', 'pairsep', '–'), b);
    return {
      node: wrap,
      read: () => [Number(a.value) * scale, Number(b.value) * scale],
      write,
    };
  }

  // 不认识的 type：只读展示，不参与提交
  return { node: ui.h('span', 'tdesc', JSON.stringify(val)), read: null, write: null };
}

export interface ConfigViewDeps {
  ui: WebUi;
  lifecycle: Lifecycle;
  signal: AbortSignal;
  /**
   * 这一处要渲染哪些组。省略 = 全部。
   *
   * 判据是**归属**：provider 页只画自己认领的那几组，设置页只画没人认领的
   * （框架自己的）。取舍放在调用方，视图本身不认识任何一个 owner。
   */
  filter?(group: ConfigGroup): boolean;
  /** 一条也不剩时说什么。默认那句是给设置页的措辞。 */
  emptyText?: string;
  /** 是否显示组的 owner 标签。 */
  showOwner?: boolean;
}

export interface ConfigView {
  /** 视图根节点。调用方自己决定插到哪。 */
  el: HTMLElement;
  /** 取一次 `/api/config` 并重建。可反复调。 */
  load(): Promise<void>;
}

/** 修改自动保存到 config.json；热配置同时更新运行态。连续输入合并请求。 */
export function createConfigView(deps: ConfigViewDeps): ConfigView {
  const { ui, lifecycle, signal } = deps;
  const showOwner = deps.showOwner !== false;

  const el = ui.h('div', 'configview');
  const body = ui.h('div');
  const bar = ui.actions();
  const msg = ui.msgline();
  bar.append(msg, ui.h('span', 'grow'));
  el.append(body, bar);

  /**
   * 每次 load 重建本次页面的组、路径与取值器列表。
   * `saved` 是这一项最近一次载入或保存成功时的值；读数与它不同即改过未存。
   */
  let readers: Array<{
    groupId: string;
    path: string;
    read: () => ConfigValue;
    write: (value: unknown) => void;
    saved: ConfigValue;
  }> = [];
  /** 已发出、尚未回复的保存请求数。 */
  let saving = 0;
  let refreshSeq = 0;

  function setMsg(text: string, bad?: boolean): void {
    msg.textContent = text;
    msg.className = 'msgline' + (bad ? ' bad' : '');
  }

  /** 提交一组：`/api/config` 一次收一组（校验按那一组的 schema 走）。 */
  async function persist(groupId: string): Promise<void> {
    if(signal.aborted)return;
    saving++;
    try {
      const sent = readers.filter((r) => r.groupId === groupId);
      const values: Record<string, ConfigValue> = {};
      for (const r of sent) values[r.path] = r.read();
      setMsg(S.saving);
      const out = await post<{ result?: string }>(
        '/api/config',
        { group: groupId, values },
        { signal },
      );
      if (signal.aborted) return;
      for (const r of sent) r.saved = values[r.path];
      setMsg('✓ ' + (out.result || groupId));
      void refresh();
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      setMsg(S.saveFailed(errText(err)), true);
    } finally {
      saving--;
    }
  }

  /**
   * 保存成功后重取一次 `/api/config`，就地更新取值：服务端随这次保存改了的其他项显示新值，
   * 改过未存的项保持原样。不重建节点，焦点与滚动位置不变。
   */
  async function refresh(): Promise<void> {
    const n = ++refreshSeq;
    try {
      const d = await get<{ groups?: ConfigGroupEntry[] }>('/api/config', { signal });
      // 期间又发出的保存成功后会再取一次。
      if (n !== refreshSeq || saving > 0 || signal.aborted) return;
      const latest = new Map((d.groups ?? []).map((entry) => [entry.group.id, entry.values ?? {}]));
      for (const r of readers) {
        const values = latest.get(r.groupId);
        if (!values || !(r.path in values)) continue;
        const current = r.read();
        if (!sameValue(current, r.saved)) continue;
        if (!sameValue(current, values[r.path])) r.write(values[r.path]);
        r.saved = r.read();
      }
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      setMsg(S.loadFailed(errText(err)), true);
    }
  }

  const writes=new Map<string,Promise<void>>();
  function save(groupId:string):Promise<void>{
    const next=(writes.get(groupId) ?? Promise.resolve()).then(()=>persist(groupId));
    writes.set(groupId,next);
    void next.finally(()=>{if(writes.get(groupId)===next)writes.delete(groupId);});
    return next;
  }

  const pending = new Map<string, Disposable>();
  function queueSave(groupId: string): void {
    pending.get(groupId)?.dispose();
    pending.set(groupId, lifecycle.timeout(() => {
      pending.delete(groupId);
      void save(groupId);
    }, SAVE_DEBOUNCE_MS));
  }

  async function load(): Promise<void> {
    try {
      const d = await get<{ groups?: ConfigGroupEntry[] }>('/api/config', { signal });
      if (signal.aborted) return;
      const all = Array.isArray(d.groups) ? d.groups : [];
      const groups = deps.filter ? all.filter((entry) => deps.filter!(entry.group)) : all;
      readers = [];
      body.replaceChildren();
      if (!groups.length) {
        body.appendChild(ui.placeholder(
          all.length
            ? (deps.emptyText ?? S.emptyDefault)
            : S.noSchema,
        ));
        return;
      }
      for (const { group, values } of groups) {
        const sec = ui.h('div', 'tsection', group.schema.title || group.id);
        if (showOwner) sec.appendChild(ui.h('span', 'ttag', OWNER_LABEL[group.owner] || group.owner));
        body.appendChild(sec);
        if (group.schema.description) {
          body.appendChild(ui.h('div', 'tsecdesc', group.schema.description));
        }
        for (const [path, prop] of Object.entries(group.schema.properties || {})) {
          const row = ui.h('div', 'trow');
          const label = ui.h('span', prop['x-warning'] ? 'tlabel warning' : 'tlabel', prop.title || path);
          if (prop['x-hot'] === false) {
            // World 的配置在构造时读走:重启那个 World 即生效,不必重启进程。
            label.appendChild(ui.h('span', 'ttag', group.owner.startsWith('world:') ? S.restartWorld : S.restartProcess));
          }
          row.appendChild(label);
          const { node, read, write } = configField(ui, prop, (values || {})[path], () => queueSave(group.id), signal);
          const fieldWrap = ui.h('div', 'tfield');
          fieldWrap.appendChild(node);
          if (prop['x-suffix'] && prop.type !== 'boolean') {
            fieldWrap.appendChild(ui.h('span', 'tunit', prop['x-suffix']));
          }
          row.appendChild(fieldWrap);
          row.appendChild(ui.h('span', 'tdesc', prop.description || ''));
          body.appendChild(row);
          if (read && write) readers.push({ groupId: group.id, path, read, write, saved: read() });
        }
      }
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      body.replaceChildren(ui.placeholder(S.loadFailed(errText(err))));
    }
  }

  body.appendChild(ui.placeholder(S.loading));
  return { el, load };
}
