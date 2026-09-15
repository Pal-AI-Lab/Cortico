/**
 * Core、Persona 和 World 用 JSON Schema 声明配置，控制台读取声明生成表单。
 * 支持 integer、number、boolean、string（含 enum / x-options）与二元数组
 * （prefixItems，或 items + minItems=maxItems=2）；其他类型只读。
 * 扩展属性：
 * x-scale：显示值 = 存储值 / scale，提交时乘回 scale。
 * x-suffix：显示单位；x-hot=false：修改后需重启。
 * x-options：从 /api/config/options/:kind 获取当前选项，配置仍存字符串。
 * x-path：选择本机路径；x-download：该路径对应的浏览器下载链接。
 */
import type { CoreConfig } from './types.ts';
import { pick, type Language } from './language.ts';

export interface ConfigProperty {
  type: 'integer' | 'number' | 'boolean' | 'string' | 'array';
  title: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  enum?: string[];
  /** 2 元数组的元素声明 */
  items?: { type: 'integer' | 'number'; minimum?: number; maximum?: number };
  minItems?: number;
  maxItems?: number;
  /** 允许写 null(用于"留空＝关掉"这类项) */
  nullable?: boolean;
  'x-scale'?: number;
  'x-suffix'?: string;
  'x-hot'?: boolean;
  /** 动态下拉的选项源 id;控制台打开下拉前现探 */
  'x-options'?: string;
  /** 字符串路径的本机选择器。推荐目录只作部署提示与对话框起始位置。 */
  'x-path'?: {
    kind: 'file' | 'directory';
    extensions?: string[];
    recommendedDir?: string;
  };
  /** 由声明方提供的可信下载地址。 */
  'x-download'?: {
    href: string;
    label?: string;
  };
}

export interface ConfigGroupSchema {
  type: 'object';
  title: string;
  description?: string;
  /** 键是 cfg 中的点分路径。 */
  properties: Record<string, ConfigProperty>;
}

export interface ConfigGroup {
  /** 配置组的稳定 id，用于提交寻址；由所有者定义，可包含具体 Persona 名称。 */
  id: string;
  /** 所有者角色，不含具体实现名称；不同 Persona 的 owner 均为 persona。 */
  owner: 'core' | 'persona' | `world:${string}` | `provider:${string}`;
  schema: ConfigGroupSchema;
}

export type ConfigValue = number | boolean | string | null | [number, number];
export type ConfigValues = Record<string, ConfigValue>;


export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 仅替换叶子属性，保留父对象引用供配置热更新使用。 */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  const leaf = segs.pop()!;
  let cur: Record<string, unknown> = obj;
  for (const seg of segs) {
    const next = cur[seg];
    if (next == null || typeof next !== 'object') cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[leaf] = value;
}

/** 一组配置项的当前值(按 schema 的键从活配置里读) */
export function readGroupValues(cfg: CoreConfig, group: ConfigGroup, read?: (path:string)=>unknown): ConfigValues {
  const root = cfg as unknown as Record<string, unknown>;
  const out: ConfigValues = {};
  for (const [path, prop] of Object.entries(group.schema.properties)) {
    const raw = read ? read(path) : getByPath(root, path);
    if (prop.type === 'boolean') out[path] = raw === true;
    else if (prop.type === 'array') {
      const pair = Array.isArray(raw) ? raw : [0, 0];
      out[path] = [Number(pair[0]) || 0, Number(pair[1]) || 0];
    } else if (prop.type === 'string') out[path] = raw == null ? '' : String(raw);
    else if (raw == null) out[path] = prop.nullable ? null : 0;
    else out[path] = Number(raw);
  }
  return out;
}


/** 校验回执的措辞。`label` 是声明方给的 title,已经是当前语言。 */
const VALIDATION_TEXT = {
  zh: {
    notNumber: (label: string) => `${label} 必须是数值`,
    below: (label: string, min: number) => `${label} 不能小于 ${min}`,
    above: (label: string, max: number) => `${label} 不能大于 ${max}`,
    notInEnum: (label: string, options: string) => `${label} 只能是 ${options}`,
    needsPair: (label: string) => `${label} 需要两个数`,
    first: (label: string) => `${label} 第一项`,
    second: (label: string) => `${label} 第二项`,
    pairOrder: (label: string) => `${label} 的第一项不能大于第二项`,
    empty: (label: string) => `${label} 不能为空`,
  },
  en: {
    notNumber: (label: string) => `${label} must be a number`,
    below: (label: string, min: number) => `${label} cannot be less than ${min}`,
    above: (label: string, max: number) => `${label} cannot be greater than ${max}`,
    notInEnum: (label: string, options: string) => `${label} must be one of ${options}`,
    needsPair: (label: string) => `${label} needs two numbers`,
    first: (label: string) => `${label} (first)`,
    second: (label: string) => `${label} (second)`,
    pairOrder: (label: string) => `${label}: the first value cannot exceed the second`,
    empty: (label: string) => `${label} cannot be empty`,
  },
};
const validationText = (language: Language) => pick(language, VALIDATION_TEXT);
type ValidationText = ReturnType<typeof validationText>;

const numberIn = (
  raw: unknown,
  prop: ConfigProperty | NonNullable<ConfigProperty['items']>,
  label: string,
  integer: boolean,
  text: ValidationText,
): number | { error: string } => {
  let n = Number(raw);
  if (!Number.isFinite(n)) return { error: text.notNumber(label) };
  if (integer) n = Math.floor(n);
  if (prop.minimum != null && n < prop.minimum) return { error: text.below(label, prop.minimum) };
  if (prop.maximum != null && n > prop.maximum) return { error: text.above(label, prop.maximum) };
  return n;
};

/** 按声明校验提交值；忽略未知字段。回执采用请求语言，默认中文。 */
export function coerceGroupValues(
  group: ConfigGroup,
  body: Record<string, unknown>,
  language: Language = 'zh',
): { values: ConfigValues } | { error: string } {
  const text = validationText(language);
  const out: ConfigValues = {};
  for (const [path, prop] of Object.entries(group.schema.properties)) {
    if (!(path in body)) continue;
    const raw = body[path];
    const label = prop.title;

    if (prop.type === 'boolean') {
      out[path] = raw === true;
      continue;
    }
    if (prop.type === 'string') {
      const s = String(raw ?? '');
      if (prop.enum && !prop.enum.includes(s)) {
        return { error: text.notInEnum(label, prop.enum.join(' / ')) };
      }
      out[path] = s;
      continue;
    }
    if (prop.type === 'array') {
      if (!Array.isArray(raw) || raw.length !== 2) return { error: text.needsPair(label) };
      const spec = prop.items ?? { type: 'number' as const };
      const integer = spec.type === 'integer';
      const first = numberIn(raw[0], spec, text.first(label), integer, text);
      if (typeof first !== 'number') return first;
      const second = numberIn(raw[1], spec, text.second(label), integer, text);
      if (typeof second !== 'number') return second;
      if (first > second) return { error: text.pairOrder(label) };
      out[path] = [first, second];
      continue;
    }
    if (prop.type === 'integer' || prop.type === 'number') {
      if (raw === null) {
        // 必须在数值转换前处理 null;Number(null) 会将清空请求转换为 0。
        if (!prop.nullable) return { error: text.empty(label) };
        out[path] = null;
        continue;
      }
      const n = numberIn(raw, prop, label, prop.type === 'integer', text);
      if (typeof n !== 'number') return n;
      out[path] = n;
      continue;
    }
    // 未支持的类型只读，不写回。
  }
  return { values: out };
}
