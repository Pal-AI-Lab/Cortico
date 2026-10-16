/** Persona 示例：PREFIX.md 渲染前缀，MEMORY.md 全文与 World 环境段进入前缀；memory_write 追加笔记，blobs/ 保存附件，session 声明收集 World 工具。 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BlobStore,
  CoreApi,
  Persona,
  PrefixSegment,
  RoundCaps,
  SessionDecl,
  SessionOpeningReason,
  SystemPrefixContext,
  ToolDef,
  World,
} from 'cortico/core/types.ts';
import { renderTemplate } from 'cortico/core/template.ts';
import { FileBlobStore } from './blobs.ts';

export const MEMORY_FILE = 'MEMORY.md';
const MAIN = 'main';

export interface ExamplePersonaOptions {
  memoryDir: string;
  /** 包目录:`persona/PREFIX.md` 与 `persona/MEMORY.seed.md` 在它下面。 */
  packageDir: string;
  /** 活的挂载表,用时再读:激活 / 停用一个 World 就地增删。 */
  worlds: readonly World[];
  rounds: () => RoundCaps;
}

const MEMORY_WRITE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'memory_write',
  description: 'Append one line to MEMORY.md, your only persistent memory. It is shown in full at the top of every context.',
  tags: ['write'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: 'One line to remember.' },
    },
    required: ['text'],
  },
};

const END_TURN_DECL: Omit<ToolDef, 'handler'> = {
  name: 'end_turn',
  description:
    'End this turn: nothing more you want to say or do right now. '
    + 'New events will wake you again. This is the normal way to finish a turn.',
  tags: ['flow'],
  barrierAfter: true,
  endsTurn: true,
  parameters: { type: 'object', properties: {}, required: [] },
};

/** 自有工具的声明;`index.ts` 的 describe 与 `ownToolNames()` 都取它。 */
export const EXAMPLE_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [MEMORY_WRITE_DECL, END_TURN_DECL];

export class ExamplePersona implements Persona {
  readonly memoryDir: string;
  readonly blobs: BlobStore;
  private core: CoreApi | null = null;

  constructor(private readonly opts: ExamplePersonaOptions) {
    this.memoryDir = opts.memoryDir;
    mkdirSync(this.memoryDir, { recursive: true });
    const memory = join(this.memoryDir, MEMORY_FILE);
    if (!existsSync(memory)) {
      writeFileSync(memory, readFileSync(join(opts.packageDir, 'persona', 'MEMORY.seed.md'), 'utf8'), 'utf8');
    }
    this.blobs = new FileBlobStore(this.memoryDir);
  }

  attach(core: CoreApi): void {
    this.core = core;
  }

  /** 前缀 = 一份模板渲染出的一段;记忆整份进去,每个 World 的环境提示词各占一节。 */
  async systemSegments(ctx: SystemPrefixContext): Promise<PrefixSegment[]> {
    const template = readFileSync(join(this.opts.packageDir, 'persona', 'PREFIX.md'), 'utf8');
    const envPrompts = ctx.worlds
      .filter((w) => w.envPrompt.trim())
      .map((w) => `## ${w.id}\n${w.envPrompt.trim()}`)
      .join('\n\n');
    return [
      {
        title: 'PREFIX',
        text: renderTemplate(template, {
          'persona.memory': readFileSync(join(this.memoryDir, MEMORY_FILE), 'utf8').trim(),
          'worlds.envPrompts': envPrompts,
        }),
      },
    ];
  }

  onOpening({ reason }: { reason: SessionOpeningReason }): void {
    this.core?.injectInternal(`[session ${reason}] 上面是你的记忆与环境。按你的判断行动,或直接结束本轮。`);
  }

  declareSessions(): SessionDecl[] {
    return [
      {
        id: MAIN,
        label: MAIN,
        rounds: this.opts.rounds,
        persistent: true,
        receivesEvents: true,
        // World 的工具在前、自有工具在后:工具表顺序影响请求前缀的缓存命中。
        tools: () => [...this.opts.worlds.flatMap((w) => w.tools()), memoryWriteTool(this.memoryDir), endTurnTool()],
      },
    ];
  }

  /** 自有工具名;装配层据此拒绝与之撞名的 World。 */
  ownToolNames(): string[] {
    return EXAMPLE_TOOL_DECLS.map((decl) => decl.name);
  }
}

/** 向 MEMORY.md 追加一行。 */
export function memoryWriteTool(memoryDir: string): ToolDef {
  return {
    ...MEMORY_WRITE_DECL,
    handler: async (args) => {
      const text = String(args.text ?? '').trim();
      if (!text) return '[write failed] text 不能为空';
      appendFileSync(join(memoryDir, MEMORY_FILE), `${text}\n`, 'utf8');
      return '[written]';
    },
  };
}

/** 结束本轮的工具。Core 只认 `endsTurn`;名字与措辞归 Persona。 */
export function endTurnTool(): ToolDef {
  return {
    ...END_TURN_DECL,
    handler: async () => '[turn ended]',
  };
}
