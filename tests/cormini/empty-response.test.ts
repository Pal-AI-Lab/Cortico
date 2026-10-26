import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Cormini } from '../../bots/cormini/persona/persona.ts';
import { CortiSoulmate } from '../../bots/corti-soulmate/persona/index.ts';
import { Core } from '../core/fixture-core.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, textReply, toolReply } from '../core/helpers.ts';

it.each(['cormini', 'corti-soulmate'])('%s 默认补救空响应，完成行动后明确结束', async kind => {
  const tmp = makeTmpDir();
  const memoryDir = join(tmp.dir, 'memory');
  const cfg = makeCfg();
  const persona = kind === 'cormini'
    ? new Cormini({ memoryDir })
    : new CortiSoulmate({ memoryDir, cfg });
  const llm = new FakeLLM();
  llm.script(textReply(''), toolReply([
    { name: 'write_file', id: 'write', args: { path: 'recovered.md', content: 'done' } },
    { name: 'end_turn', id: 'end' },
  ]));
  const core = new Core(makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir: join(tmp.dir, 'data') }),
    { persona, worlds: [], llm });
  try {
    await core.start();
    await vi.waitFor(() => expect(core.session.messages.some(m => m.tool_call_id === 'end')).toBe(true));
    expect(readFileSync(join(memoryDir, 'recovered.md'), 'utf8')).toBe('done');
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].messages).toContainEqual(expect.objectContaining({ role: 'user', content: persona.onEmptyResponse() }));
  } finally {
    await core.stop();
    tmp.cleanup();
  }
});
