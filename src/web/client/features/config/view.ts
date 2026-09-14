/**
 * 可调参数的共享视图 —— 框架设置页与各 provider 归属页复用同一实现。
 *
 * 这个视图**只是消费者**。每一组旋钮都由**拥有那些参数的人自己声明**（JSON Schema，
 * `src/core/config-schema.ts`），声明方是 core / Persona / 各 World 三方；
 * 控制台按声明通用渲染，所以装上新 World，它的旋钮会自己出现——出现在**它自己那一页**，
 * 而不是堆进一张把三方混在一起的总表（`filter` 就是这件事的执行点）。
 *
 * **不做前端代码扩展**。控制台不规定语言，只说明自己认识哪个子集：
 *
 * ```
 * integer / number / boolean / string（含 enum / x-options）/ 2 元数组
 * ```
 *
 * 其余一律降级成**只读文本**并且不参与提交——永远不阻塞任何人。降级而不是报错，
 * 是因为声明方比控制台先演进：它加了一个控制台还不认识的形状，那一项该照样看得见，
 * 只是暂时改不了。
 *
 * 六个 `x-` 扩展（标准 JSON Schema 没有位置放）：
 *
 * | 扩展         | 含义                                                       |
 * | ------------ | ---------------------------------------------------------- |
 * | `x-scale`    | 显示换算：显示 = 存储 / scale，回传 = 输入 × scale          |
 * | `x-suffix`   | 单位后缀                                                    |
 * | `x-hot`      | `false` = 这一项构造时读走： World 参数重启 World 生效，其余重启进程   |
 * | `x-options`  | 动态下拉：页加载与打开前向 `/api/config/options/:kind` 探测 |
 * | `x-path`     | 打开 WebApp 主机上的本机文件或目录选择器                   |
 * | `x-download` | 与路径字段配套的浏览器下载链接                              |
 *
 * `x-scale` 只是显示换算，**存储单位与校验都由后端定**：这里不做任何取整、不做范围
 * 裁剪，只把数字乘回去。整数由后端 coerce，前端取整会毁掉比例类小数。
 */

import type { ConsoleUi, Disposable } from '../../../shared/client-panel.ts';
import { get, pickPath, post } from '../../core/api.ts';
import type { Lifecycle } from '../../core/lifecycle.ts';
import { icon } from '../../ui/icons.ts';
import { S } from './strings.ts';

/** 连打字合并成一次请求的窗口。够短，手停下来就落盘；够长，不会一个字一次。 */
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
 * "系统默认 / 静音"这类固定项也由声明该 kind 的一方随表给出——控制台不认识任何 kind。
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

function fillSelect(ui: ConsoleUi, sel: HTMLSelectElement, items: OptionItem[], current: string): void {
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
 * 一个渲染好的字段：节点 + **存储单位**的取值器。
 * `read` 为 `null` 表示这一项只读（不认识的 type），不参与提交。
 */
export interface ConfigField {
  node: HTMLElement;
  read: (() => ConfigValue) | null;
}

/** 只翻译框架自己认识的 owner；`core` 与 `world:<id>` 这类原样显示。 */
const OWNER_LABEL: Record<string, string> = {
  'persona': S.ownerPersona,
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/**
 * `x-options` 下拉。页加载先探一次(原生 `<select>` 同步弹出,第一次打开用这份);
 * pointerdown/focus 再探,给下次打开用。探测失败只留当前值。
 */
function optionsField(
  ui: ConsoleUi,
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
  const refresh = (): void => {
    const n = ++seq;
    void get<{ options?: OptionItem[] }>(
      `/api/config/options/${encodeURIComponent(kind)}`,
      signal ? { signal } : undefined,
    ).then((d) => {
      if (n !== seq || signal?.aborted) return;
      const live = Array.isArray(d.options) ? d.options : [];
      fillSelect(ui, sel, mergeOptionList(live, sel.value), sel.value);
    }).catch((err: unknown) => {
      if (isAbort(err) || signal?.aborted) return;
    });
  };
  const listenOpts = signal ? { signal } : undefined;
  sel.addEventListener('pointerdown', refresh, listenOpts);
  sel.addEventListener('focus', refresh, listenOpts);
  refresh();
  return { node: sel, read: () => sel.value };
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
  ui: ConsoleUi,
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
  return { node: field, read: () => input.value };
}

/**
 * 属性 → 行内控件 + 取值器。
 *
 * `read()` 给的一律是**存储单位**（已经乘回 `x-scale`），所以调用方拿到什么就提交
 * 什么，不必在提交处再想一遍换算——那正是换算这类逻辑最容易漏掉一处的地方。
 *
 * `onChange` 是**立刻落盘**那条路的触发点：控件一变就报上去，没有"改完再点应用"
 * 这一步（见 `createConfigView` 的说明）。
 */
export function configField(
  ui: ConsoleUi,
  prop: ConfigProperty,
  val: unknown,
  onChange?: () => void,
  signal?: AbortSignal,
): ConfigField {
  const changed = (): void => onChange?.();
  if (prop.type === 'boolean') {
    const box = ui.checkbox(S.on, { checked: !!val, onChange: changed });
    return { node: box.el, read: () => box.checked };
  }

  if (prop.type === 'string') {
    if (prop['x-options']) {
      return optionsField(ui, prop['x-options'], val == null ? '' : String(val), changed, signal);
    }
    if (Array.isArray(prop.enum)) {
      const sel = ui.select({
        options: prop.enum,
        value: val == null ? prop.enum[0] : String(val),
        onChange: changed,
      });
      return { node: sel, read: () => sel.value };
    }
    if (prop['x-path']) {
      return pathField(ui, prop, val == null ? '' : String(val), changed, signal);
    }
    const inp = ui.input({ type: 'text', value: val == null ? '' : String(val), onChange: changed });
    return { node: inp, read: () => inp.value };
  }

  if (prop.type === 'integer' || prop.type === 'number') {
    const scale = prop['x-scale'] || 1;
    const inp = ui.input({ type: 'number', onChange: changed });
    if (prop.minimum != null) inp.min = String(prop.minimum / scale);
    if (prop.maximum != null) inp.max = String(prop.maximum / scale);
    if (prop.multipleOf != null) inp.step = String(prop.multipleOf / scale);
    if (prop.nullable) {
      // nullable 的项：null ↔ 输入框留空。声明说"留空＝关掉"，就得真能留空——
      // 不能拿 0 当 null 的代号，那会让 0 和「不设」永远撞在一起。
      inp.value = val == null ? '' : String(Number(val) / scale);
      inp.placeholder = S.leaveBlank;
      return {
        node: inp,
        read: () => (inp.value.trim() === '' ? null : Number(inp.value) * scale),
      };
    }
    inp.value = String((Number(val) || 0) / scale);
    return { node: inp, read: () => Number(inp.value) * scale };
  }

  // 数组只认一种可编辑形态:两个数的区间(items 是 number/integer)。别的数组
  // (World id 列表一类)只读展示——曾经把一份字符串名单画成一对数字框,
  // 一保存就写回 [0,0],把部署里的名单静默毁掉。
  const itemType = prop.items?.type;
  if (prop.type === 'array' && (itemType === 'integer' || itemType === 'number')) {
    const scale = prop['x-scale'] || 1;
    const spec = prop.items || {};
    const mk = (v: unknown): HTMLInputElement => {
      const inp = ui.input({ type: 'number', value: String((Number(v) || 0) / scale), onChange: changed });
      if (spec.minimum != null) inp.min = String(spec.minimum / scale);
      if (spec.maximum != null) inp.max = String(spec.maximum / scale);
      return inp;
    };
    const pair = Array.isArray(val) ? (val as unknown[]) : [0, 0];
    const a = mk(pair[0]);
    const b = mk(pair[1]);
    const wrap = ui.h('div', 'pairfield');
    wrap.append(a, ui.h('span', 'pairsep', '–'), b);
    return {
      node: wrap,
      read: () => [Number(a.value) * scale, Number(b.value) * scale],
    };
  }

  // 不认识的 type：只读展示，不参与提交
  return { node: ui.h('span', 'tdesc', JSON.stringify(val)), read: null };
}

export interface ConfigViewDeps {
  ui: ConsoleUi;
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
  /** 组标题旁的 owner 小标要不要印。归属页上它是废话（整页都是同一个 owner）。 */
  showOwner?: boolean;
}

export interface ConfigView {
  /** 视图根节点。调用方自己决定插到哪。 */
  el: HTMLElement;
  /** 取一次 `/api/config` 并重建。可反复调。 */
  load(): Promise<void>;
}

/**
 * 参数视图。**改一下存一下**：没有"应用"按钮，也没有"要不要写回 config.json"的勾选——
 * 一次改动落两处（运行态热生效 + 写回 config.json）是同一件事的两半，拆成两步
 * 只会让人对着一个已经改了的输入框猜"这到底生效了没有"。
 *
 * 连打字合并成一次请求：输入框每敲一下都发，既吵又会把中间态写进文件。
 */
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
   * 提交面：`[{ groupId, path, read }]`。每次 `load` **整份重建**——
   * 让它跨页常驻的话，离开这一页之后还留着一批指向已消失 DOM 的闭包。
   */
  let readers: Array<{ groupId: string; path: string; read: () => ConfigValue }> = [];

  function setMsg(text: string, bad?: boolean): void {
    msg.textContent = text;
    msg.className = 'msgline' + (bad ? ' bad' : '');
  }

  /** 提交一组：`/api/config` 一次收一组（校验按那一组的 schema 走）。 */
  async function persist(groupId: string): Promise<void> {
    if(signal.aborted)return;
    try {
      const values: Record<string, ConfigValue> = {};
      for (const r of readers) if (r.groupId === groupId) values[r.path] = r.read();
      setMsg(S.saving);
      const out = await post<{ result?: string }>(
        '/api/config',
        { group: groupId, values },
        { signal },
      );
      if (signal.aborted) return;
      setMsg('✓ ' + (out.result || groupId));
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      setMsg(S.saveFailed(errText(err)), true);
    }
  }

  const writes=new Map<string,Promise<void>>();
  function save(groupId:string):Promise<void>{
    // 吞掉前一次 persist 的 rejection,避免 unhandledRejection 并防止下一次 save 被跳过。
    const next=(writes.get(groupId) ?? Promise.resolve()).catch(() => {}).then(()=>persist(groupId));
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
          const label = ui.h('span', 'tlabel', prop.title || path);
          if (prop['x-hot'] === false) {
            // World 的参数在构造时读走:重启那个 World 即生效,不必重启进程。
            label.appendChild(ui.h('span', 'ttag', group.owner.startsWith('world:') ? S.restartWorld : S.restartProcess));
          }
          row.appendChild(label);
          const { node, read } = configField(ui, prop, (values || {})[path], () => queueSave(group.id), signal);
          const fieldWrap = ui.h('div', 'tfield');
          fieldWrap.appendChild(node);
          if (prop['x-suffix'] && prop.type !== 'boolean') {
            fieldWrap.appendChild(ui.h('span', 'tunit', prop['x-suffix']));
          }
          row.appendChild(fieldWrap);
          row.appendChild(ui.h('span', 'tdesc', prop.description || ''));
          body.appendChild(row);
          if (read) readers.push({ groupId: group.id, path, read });
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
