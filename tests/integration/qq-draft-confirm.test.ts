import { messages as legacyMessages } from '../core/fixture-protocol.ts';
/** 通过装配层、Core、QQ World 与 MockOneBot 验证草稿确认发送和未确认草稿失效。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, type AssembledBot } from '../../bots/corti-soulmate/assemble.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, textReply, toolReply, sleep } from '../core/helpers.ts';

const GROUP = 424242;
const SELF = 5000;

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('QQ 草稿确认集成', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;
  let bot: AssembledBot;
  let llm: FakeLLM;

  beforeAll(async () => {
    mock = new MockOneBot({
      port: 0,
      groupId: GROUP,
      selfId: SELF,
      selfNickname: 'bot',
      selfCard: 'botcard',
      groupName: '测试群',
    });
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
    cfg.batching.maxBatchAgeMs = 400;
    cfg.tick.dayIntervalMinutes = [999, 999];
    cfg.tick.nightIntervalMinutes = null;
    cfg.web.port = 0;

    const loaded = makeLoaded({
      config: cfg,
      rootDir: tmp.dir,
      memoryDir,
      dataDir: join(tmp.dir, 'data'),
    });

    llm = new FakeLLM();
    bot = assembleBot(loaded, { llm });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);
    // 等待 bootstrap 轮结束,避免测试脚本被该轮消费。
    await waitFor(() => llm.calls.length >= 1);
  }, 15000);

  afterAll(async () => {
    await bot.stop();
    await mock.close();
  });

  it('draft→confirm(send):通过 Core 向 MockOneBot 发送消息', async () => {
    // 一次唤醒内:round1 起草并触发屏障,round2 复核后确认发送
    llm.script(toolReply([{ name: 'qq_draft', args: { to: `group:${GROUP}`, text: '大家好呀' } }]));
    llm.script(toolReply([{ name: 'qq_confirm', args: { decision: 'send' } }]));

    mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: 'bot在吗' });

    await waitFor(() => mock.outbox.some((o) => o.action === 'send_group_msg'));
    const sent = mock.outbox.find((o) => o.action === 'send_group_msg')!;
    expect(sent.params.group_id).toBe(GROUP);
    expect(sent.params.message).toEqual([{ type: 'text', data: { text: '大家好呀' } }]);

    // 自己的话回录进事件库(qq.self, deliver:false)
    await waitFor(() => bot.core.store.range({}).some((e) => e.type === 'qq.self'));
    const self = bot.core.store.range({}).find((e) => e.type === 'qq.self')!;
    expect(self.text).toContain('你: 大家好呀');
  });

  it('未确认草稿在自然结束时作废，下一批不能误确认', async () => {
    const outboxBefore = mock.outbox.length;
    const callsBefore = llm.calls.length;

    // 唤醒1:起草后复核响应不confirm，自然结束时清掉草稿
    llm.script(
      toolReply([{ name: 'qq_draft', args: { to: `group:${GROUP}`, text: '这条不该发出去' } }]),
      textReply('先不发'),
    );
    mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: '先说一句' });
    await waitFor(() => llm.calls.length > callsBefore);

    // 唤醒2:confirm应找不到上一轮草稿
    llm.script(toolReply([{ name: 'qq_confirm', args: { decision: 'send' } }]));
    mock.emitGroupMessage({ user_id: 2002, nickname: '阿强', text: '又一句' });

    await waitFor(() =>
      legacyMessages(bot.core.session.records).some(
        (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('no draft to confirm'),
      ),
    );
    await sleep(60);
    expect(mock.outbox.length).toBe(outboxBefore);
    expect(mock.outbox.some((o) => JSON.stringify(o.params).includes('这条不该发出去'))).toBe(false);
  });
});
