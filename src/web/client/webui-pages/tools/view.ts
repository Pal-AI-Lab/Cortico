/**
 * 只读工具表与完整 JSON Schema，由 Persona 页的框架页签承载。
 * 按后端 owner 分组并保留装配顺序，前端不维护具体 World 名单；复制由 ui.copyButton 处理。
 */

import type { WebUi } from '../../../shared/client-panel.ts';
import type { ToolSchemaDoc } from '../../features/live/protocol.ts';
import { S } from './strings.ts';

/** schema 节点的类型名。联合/枚举/组合都给一个能读的词,不返回空。 */
export function schemaTypeLabel(node: unknown): string {
  if (!node || typeof node !== 'object') return '—';
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.type)) return n.type.join(' | ');
  if (n.type) return String(n.type);
  if (n.enum) return 'enum';
  if (n.oneOf) return 'oneOf';
  if (n.anyOf) return 'anyOf';
  if (n.allOf) return 'allOf';
  return 'schema';
}

export interface SchemaParamRow {
  path: string;
  type: string;
  required: boolean;
  description: string;
}

/** 参数表:递归展开 `properties`,数组元素记成 `x[]`。 */
export function schemaParameterRows(parameters: unknown): SchemaParamRow[] {
  const rows: SchemaParamRow[] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    const props = n.properties as Record<string, unknown> | undefined;
    if (!props) return;
    const required = new Set(Array.isArray(n.required) ? (n.required as string[]) : []);
    for (const [name, child] of Object.entries(props)) {
      const path = prefix ? `${prefix}.${name}` : name;
      const c = (child ?? {}) as Record<string, unknown>;
      rows.push({
        path,
        type: schemaTypeLabel(child),
        required: required.has(name),
        description: typeof c.description === 'string' ? c.description : '',
      });
      walk(child, path);
      if (c.items && typeof c.items === 'object') walk(c.items, `${path}[]`);
    }
  };
  walk(parameters ?? {}, '');
  return rows;
}

/** 按 owner 分栏。返回顺序固定:原生动作、Persona、各 World(按出场顺序)。 */
export function groupTools(
  schemas: readonly ToolSchemaDoc[],
): Array<[string, ToolSchemaDoc[]]> {
  const core: ToolSchemaDoc[] = [];
  const persona: ToolSchemaDoc[] = [];
  const worlds = new Map<string, ToolSchemaDoc[]>();
  for (const t of schemas) {
    const owner = t.owner ?? ((t.tags ?? []).includes('flow') ? { kind: 'core' } : { kind: 'persona' });
    if (owner.kind === 'core') {
      core.push(t);
      continue;
    }
    if (owner.kind !== 'world') {
      persona.push(t);
      continue;
    }
    const name = S.ioGroup(owner.label || owner.id);
    const bucket = worlds.get(name);
    if (bucket) bucket.push(t);
    else worlds.set(name, [t]);
  }
  return [
    [S.groupCore, core],
    [S.groupPersona, persona],
    ...worlds.entries(),
  ];
}

/** 卡片与它的可搜文本(筛选时按这一串比对)。 */
interface CardEntry {
  el: HTMLElement;
  haystack: string;
}

function toolSchemaCard(ui: WebUi, schema: ToolSchemaDoc): CardEntry {
  const card = ui.h('details', 'tool-schema-card');
  const summary = ui.h('summary', 'tool-schema-summary');
  const rows = schemaParameterRows(schema.parameters);
  summary.append(
    ui.h('span', 'tool-schema-title', schema.name),
    ui.h('span', 'tool-schema-short', schema.description || S.noDescription),
    ui.pill(S.paramCount(rows.length)),
  );
  card.appendChild(summary);

  const body = ui.h('div', 'tool-schema-body');
  const rootDesc = (schema.parameters as { description?: unknown } | null)?.description;
  if (typeof rootDesc === 'string' && rootDesc !== '') {
    body.appendChild(ui.h('div', 'schema-root-description', rootDesc));
  }

  if (rows.length) {
    const wrap = ui.h('div', 'schema-param-wrap');
    const table = ui.h('table', 'schema-param-table');
    const thead = ui.h('thead');
    const htr = ui.h('tr');
    for (const t of [S.paramHeadPath, S.paramHeadType, S.paramHeadConstraint, S.paramHeadDesc]) {
      htr.appendChild(ui.h('th', null, t));
    }
    thead.appendChild(htr);
    const tbody = ui.h('tbody');
    for (const row of rows) {
      const tr = ui.h('tr');
      tr.append(
        ui.h('td', 'schema-param-path', row.path),
        ui.h('td', 'schema-param-type', row.type),
        ui.h('td', 'schema-param-required', row.required ? S.required : S.optional),
        ui.h('td', 'schema-param-description', row.description || '—'),
      );
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    body.appendChild(wrap);
  } else {
    body.appendChild(ui.h('div', 'placeholder schema-empty-params', S.noParams));
  }

  const raw = ui.h('details', 'schema-raw');
  const rawText = JSON.stringify(schema, null, 2);
  const tools = ui.h('div', 'schema-raw-tools');
  tools.appendChild(ui.copyButton(() => rawText, { label: S.copySchema }));
  raw.append(ui.h('summary', null, S.fullSchema), tools, ui.h('pre', 'mono', rawText));
  body.appendChild(raw);
  card.appendChild(body);

  const haystack = `${schema.name} ${schema.description || ''} ${rows
    .map((r) => `${r.path} ${r.description}`)
    .join(' ')}`.toLocaleLowerCase();
  return { el: card, haystack };
}

export interface ToolsView {
  el: HTMLElement;
  render(schemas: readonly ToolSchemaDoc[]): void;
  /** 拉不到完整工具表时的说明(仍然把当前主循环的那份画出来) */
  note(text: string): void;
}

export function createToolsView(ui: WebUi): ToolsView {
  const sheet = ui.sheet({
    title: S.toolsTitle,
    desc: S.toolsDesc,
  });
  const bar = ui.rowbar();
  bar.classList.add('schema-toolbar');
  const search = ui.input({
    type: 'search',
    placeholder: S.toolsFilter,
    onInput: (v) => applyFilter(v),
  });
  bar.append(search);
  const groups = ui.h('div', 'schema-groups');
  const noteLine = ui.msgline('');
  sheet.body.append(bar, noteLine, groups);

  /** 分栏与卡片,筛选时按这两张表逐个开关,不重建 DOM;分栏标题旁的数目随筛选变。 */
  let sections: Array<{ el: HTMLElement; count: HTMLElement; cards: CardEntry[] }> = [];

  function applyFilter(raw: string): void {
    const q = raw.trim().toLocaleLowerCase();
    for (const sec of sections) {
      let shown = 0;
      for (const card of sec.cards) {
        const hit = !q || card.haystack.includes(q);
        card.el.classList.toggle('hidden', !hit);
        if (hit) shown++;
      }
      sec.el.classList.toggle('hidden', shown === 0);
      sec.count.textContent = S.toolCount(shown);
    }
  }

  return {
    el: sheet.el,
    render(schemas) {
      while (groups.children.length) groups.children[0].remove();
      sections = [];
      if (!schemas.length) {
        groups.appendChild(ui.placeholder(S.toolsEmpty));
        return;
      }
      for (const [name, tools] of groupTools(schemas)) {
        if (!tools.length) continue;
        // 分栏标题可点:收起或展开这一栏的全部工具,右侧 + / − 表示当前状态。
        const section = ui.h('section', 'toolgroup schema-group');
        const head = ui.h('button', 'toolgroup-head');
        head.type = 'button';
        head.setAttribute('aria-expanded', 'true');
        const count = ui.h('span', 'toolgroup-count', S.toolCount(tools.length));
        head.append(ui.h('span', 'gt', name), count, ui.h('span', 'grow'), ui.h('span', 'toolgroup-sign'));
        const list = ui.h('div', 'toolgroup-list');
        head.addEventListener('click', () => {
          const open = head.getAttribute('aria-expanded') !== 'true';
          head.setAttribute('aria-expanded', String(open));
          section.classList.toggle('is-collapsed', !open);
        });
        const cards = tools.map((t) => toolSchemaCard(ui, t));
        for (const c of cards) list.appendChild(c.el);
        section.append(head, list);
        groups.appendChild(section);
        sections.push({ el: section, count, cards });
      }
      applyFilter(search.value);
    },
    note(text) {
      noteLine.textContent = text;
    },
  };
}
