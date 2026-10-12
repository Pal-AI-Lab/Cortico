/** 用于验证 World 面板的自动发现、调用、徽标更新与资源释放；未列入默认 World 列表。 */

import { fileURLToPath } from 'node:url';
import type { World, WorldConsoleDecl, ToolDef } from '../../core/types.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

interface ConsoleFixtureOptions {
  id?: string;
  label?: string;
}

export class ConsoleFixtureWorld implements World {
  readonly id: string;
  private readonly label: string;
  private pings = 0;

  constructor(opts: ConsoleFixtureOptions = {}) {
    this.id = opts.id ?? 'console-fixture';
    this.label = opts.label ?? '控制台验收件';
  }

  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [];
  }

  console(): WorldConsoleDecl {
    return {
      lamps: [{
        label: '握手',
        state: 'online',
        ...(this.pings > 0 ? { hint: `${this.pings} 次` } : {}),
      }],
      badges: [{ label: '握手', value: this.pings, tone: this.pings > 0 ? 'on' : 'plain' }],
      panels: [
        { id: 'hello', title: '握手', description: '调用后更新握手次数。' },
        { id: 'echo', title: '回声', description: '原样返回参数。' },
      ],
      invoke: async (panel, method, args) => {
        if (panel === 'hello' && method === 'ping') {
          this.pings++;
          return { ok: true, pings: this.pings, at: new Date().toISOString() };
        }
        if (panel === 'echo' && method === 'echo') {
          return { echoed: args };
        }
        throw new Error(`未知面板方法: ${panel}.${method}`);
      },
      promptDocs: [
        {
          key: `worlds.${this.id}.envPrompt`,
          title: `${this.label} · 环境提示词`,
          description: '验收环境说明。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
    };
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}
