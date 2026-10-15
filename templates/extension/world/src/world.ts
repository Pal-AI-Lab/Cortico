/** World 示例：挂载事件、echo 工具与环境模板。状态和回执仅描述 World 可确认的事实。 */
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { EXAMPLE_CONFIG_GROUP, type ExampleConfigSection } from './config.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export interface ExampleWorldOptions {
  /** `worlds.example` 的活引用。 */
  cfg: ExampleConfigSection;
  timezone: string;
}

export class ExampleWorld implements World {
  readonly id = 'example';

  constructor(private readonly opts: ExampleWorldOptions) {}

  /** 只报值;前缀文本一律来自 ENV_PROMPT.md 模板。 */
  envPromptVars(): Record<string, string> {
    return { 'example.greeting': this.opts.cfg.greeting };
  }

  tools(): ToolDef[] {
    return [this.echoTool()];
  }

  webUi(): WorldWebUiDecl {
    return {
      config: [EXAMPLE_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.example.envPrompt',
          title: 'Example · 环境提示词',
          description: '示例 World 进 system 前缀的那一段。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'example.greeting', description: '配置里的回执开头,此刻的值。' }],
        },
      ],
    };
  }

  /** 挂载时投递状态事件；origin: internal 表示 World 的内部机制事件。 */
  async start(host: WorldHost): Promise<void> {
    await host.pushEvent({
      type: 'example.started',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: 'Example World 已挂载,example_echo 可用。',
    });
  }

  async stop(): Promise<void> {}

  private echoTool(): ToolDef {
    return {
      name: 'example_echo',
      description: 'Echo the given text back, prefixed with the configured greeting.',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'Text to echo.' },
        },
        required: ['text'],
      },
      handler: async (args) => `${this.opts.cfg.greeting} ${String(args.text ?? '')}`,
    };
  }
}
