/** 通过装配层、Core、QQ World 与 MockOneBot 验证:只发一条语音,转写结果到达时单独唤醒一次。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, type AssembledBot } from '../../bots/corti-soulmate/assemble.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, sleep } from '../core/helpers.ts';

const GROUP = 424242;
const MAX_BATCH_AGE_MS = 400;

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('QQ 语音转写集成', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;
  let bot: AssembledBot;
  let llm: FakeLLM;

  beforeAll(async () => {
    mock = new MockOneBot({ port: 0, groupId: GROUP, groupName: '测试群' });
    const port = await mock.start();

    const memoryDir = join(tmp.dir, 'persona');
    mkdirSync(join(memoryDir, 'note'), { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');

    const cfg = makeCfg();
    cfg.worlds.qq = {
      ...cfg.worlds.qq,
      enabled: true,
      wsUrl: `ws://127.0.0.1:${port}`,
      groups: [{ id: GROUP, enabled: true }],
      privates: [],
      token: '',
    };
    cfg.worlds.terminal.enabled = false;
    cfg.batching.quietGapMs = 40;
    cfg.batching.maxBatchAgeMs = MAX_BATCH_AGE_MS;
    cfg.tick.dayIntervalMinutes = [999, 999];
    cfg.tick.nightIntervalMinutes = null;
    cfg.web.port = 0;

    llm = new FakeLLM();
    bot = assembleBot(
      makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir: join(tmp.dir, 'data') }),
      { llm },
    );
    await bot.start();
    await bot.qqWorld!.waitReady(5000);
    // 等待 bootstrap 轮结束,避免它吞掉后面的事件。
    await waitFor(() => llm.calls.length >= 1);
  }, 15000);

  afterAll(async () => {
    await bot.stop();
    await mock.close();
  });

  it('语音占位不单独唤醒;转写结果到达时唤醒一次,占位与转写同轮可见', async () => {
    let release!: () => void;
    mock.setActionHandler('fetch_ptt_text', () =>
      new Promise((resolve) => { release = () => resolve({ data: { text: '今晚吃什么' } }); }),
    );
    const callsBefore = llm.calls.length;
    mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', segments: [{ type: 'record', data: { file: 'voice.amr' } }] });
    await waitFor(() => mock.received.some((call) => call.action === 'fetch_ptt_text'));
    // 超过合批的最长等待,占位这条仍没有唤醒
    await sleep(MAX_BATCH_AGE_MS * 2);
    expect(llm.calls.length).toBe(callsBefore);

    release();
    await waitFor(() => llm.calls.length > callsBefore);
    const turn = JSON.stringify(llm.calls[callsBefore].messages);
    expect(turn).toContain('[语音,正在转写中...]');
    expect(turn).toContain('[QQ语音转写] 今晚吃什么');
  });
});
