/**
 * 运行中的工具名与事件 type 不在自描述(`WorldDefinition.describe`、`BotDefinition.describe`)里的记录。
 * 未声明的照常生效;每个(来源, 名字)第一次出现时记一条 warn,WebUI 在来源的页上列出。
 * 来源没写 describe 时不检查。
 */
import type { EventDescribe, Logger, ToolSchema } from './core/types.ts';

export interface UndeclaredView {
  tools: string[];
  events: string[];
}

export class UndeclaredNames {
  private readonly found = new Map<string, { tools: Set<string>; events: Set<string> }>();
  private readonly eventTypes = new WeakMap<readonly EventDescribe[], ReadonlySet<string>>();

  /** `logger(area)` 给来源的运行日志;`area` 同时是查询键,World 是 `worlds.<id>`,Persona 是 `persona`。 */
  constructor(private readonly logger: (area: string) => Logger) {}

  tools(area: string, declared: readonly ToolSchema[] | undefined, names: readonly string[]): void {
    if (!declared) return;
    const known = new Set(declared.map((tool) => tool.name));
    for (const name of names) {
      if (!known.has(name)) this.note(area, 'tools', name);
    }
  }

  event(area: string, declared: readonly EventDescribe[] | undefined, type: string): void {
    if (!declared) return;
    let known = this.eventTypes.get(declared);
    if (!known) {
      known = new Set(declared.map((event) => event.type));
      this.eventTypes.set(declared, known);
    }
    if (!known.has(type)) this.note(area, 'events', type);
  }

  /** 按首次出现的顺序;没有未声明项时为 undefined。 */
  of(area: string): UndeclaredView | undefined {
    const entry = this.found.get(area);
    if (!entry || (!entry.tools.size && !entry.events.size)) return undefined;
    return { tools: [...entry.tools], events: [...entry.events] };
  }

  private note(area: string, kind: 'tools' | 'events', name: string): void {
    let entry = this.found.get(area);
    if (!entry) {
      entry = { tools: new Set(), events: new Set() };
      this.found.set(area, entry);
    }
    if (entry[kind].has(name)) return;
    entry[kind].add(name);
    this.logger(area).warn(
      kind === 'tools' ? `工具不在 describe.tools 里,照常生效: ${name}` : `事件 type 不在 describe.events 里,照常推送: ${name}`,
      { [kind === 'tools' ? 'tool' : 'type']: name },
    );
  }
}
