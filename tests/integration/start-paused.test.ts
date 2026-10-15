import { messages as legacyMessages } from '../core/fixture-protocol.ts';
/** 验证 launcher.ts 的启动暂停顺序:boot 事件排队,继续后才调用模型。 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, type AssembledBot } from '../../bots/corti-soulmate/assemble.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, sleep } from '../core/helpers.ts';

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('启动即暂停', () => {
  const tmp = makeTmpDir();
  let bot: AssembledBot | undefined;

  afterEach(async () => {
    try { await bot?.stop(); } catch { /* ignore */ }
    tmp.cleanup();
  });

  it('start 前 setPaused(true):零 LLM 调用;resume 后才处理 boot 批', async () => {
    const memoryDir = join(tmp.dir, 'persona');
    mkdirSync(join(memoryDir, 'note'), { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');
    const cfg = makeCfg();
    cfg.batching.quietGapMs = 20;
    cfg.batching.maxBatchAgeMs = 200;
    cfg.worlds.qq.enabled = false;
    cfg.worlds.console.enabled = true;
    cfg.web.port = 0;
    const loaded = makeLoaded({
      config: cfg, rootDir: tmp.dir, memoryDir, dataDir: join(tmp.dir, 'data'),
    });
    const llm = new FakeLLM();
    bot = assembleBot(loaded, { llm });


    bot.core.bus.setPaused(true);
    await bot.start();

    // boot 已入队(session 只有 system 前缀),但未投递:没有 LLM 调用
    await waitFor(() => legacyMessages(bot!.core.session.records).length >= 1);
    await sleep(300);
    expect(bot.core.bus.isPaused()).toBe(true);
    expect(llm.calls.length).toBe(0);
    expect((bot.core.loop.getStatus() as { paused?: boolean }).paused).toBe(true);
    expect(bot.core.bus.pending()).toBeGreaterThan(0);

    bot.core.bus.setPaused(false);
    await waitFor(() => llm.calls.length > 0);
    expect(bot.core.bus.isPaused()).toBe(false);
  }, 10000);
});
