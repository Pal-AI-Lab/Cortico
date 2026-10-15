/**
 * 模板语法：
 * {{name}}：已声明变量为空时展开为空串。
 * {{name | 缺省文案}}：已声明变量为空时使用缺省文案。
 * 未在值表声明的占位符原样保留。
 */

/** `{{名字}}` 或 `{{名字 | 缺省文案}}`。名字限 `[\w.]`,缺省文案吃到 `}}` 为止。 */
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g;

/** 模板里出现过的占位符名(按出现序,去重)。编辑器用它标"已用/未使用"。 */
export function templateVarNames(template: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1];
    if (!seen.has(name)) { seen.add(name); names.push(name); }
  }
  return names;
}

/**
 * 渲染模板，vars 中缺席的占位符原样保留，默认值与空串规则见文件头。
 */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (whole, name: string, fallback?: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return whole;
    const value = vars[name] ?? '';
    if (value !== '') return value;
    return fallback === undefined ? '' : fallback.trim();
  });
}

/** 未在值表声明的占位符；WebUI 据此提示，仍允许保存。 */
export function unknownVarNames(
  template: string,
  declared: readonly string[],
): string[] {
  const known = new Set(declared);
  return templateVarNames(template).filter((name) => !known.has(name));
}

/** 顶层模板切出来的一段:`name` 是那个占位符,`text` 是它连同前面的字面文本。 */
export interface RenderedSection {
  name: string;
  text: string;
}

/**
 * 按占位符切分，满足 sections.map(s => s.text).join('') === text。
 * 每段包含占位符前的字面文本，末尾文本归最后一段。
 * 没有占位符时返回一段完整文本，name 为空串。
 */
export function renderSections(
  template: string,
  vars: Readonly<Record<string, string>>,
): { text: string; sections: RenderedSection[] } {
  const sections: RenderedSection[] = [];
  let cursor = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    const start = m.index ?? 0;
    sections.push({
      name: m[1],
      text: template.slice(cursor, start) + renderTemplate(m[0], vars),
    });
    cursor = start + m[0].length;
  }
  const tail = template.slice(cursor);
  if (sections.length === 0) return { text: tail, sections: [{ name: '', text: tail }] };
  if (tail) sections[sections.length - 1].text += tail;
  return { text: sections.map((s) => s.text).join(''), sections };
}
