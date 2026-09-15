import { messages as legacyMessages } from '../core/fixture-protocol.ts';
/**
 * 真实 CortiV / WebApp / 事件总线，只替换模型与 B 站长连。
 * 同一进程串起弹幕合批、付费插队、控制台输入、工作区写入、热配置与关机。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import cortiv, { type CortiVConfig } from '../../bots/cortiv/index.ts';
import { withWorlds } from '../../src/world.ts';
import { BUILTIN_WORLDS } from '../../src/worlds/index.ts';
import { createBot, type Bot } from '../../src/bot.ts';
import type { LoadedConfig } from '../../src/core/config.ts';
import { BilibiliWorld, type LiveHandlers } from '../../src/worlds/bilibili/world.ts';
import type { LiveStatus } from '../../src/worlds/bilibili/client.ts';
import { panelStreamRoute } from '../../src/web/shared/console-protocol.ts';
import { FakeLLM, makeTmpDir, sleep, toolReply } from '../core/helpers.ts';


const definition = withWorlds(cortiv, BUILTIN_WORLDS);

async function waitFor(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor 超时');
    await sleep(20);
  }
}

function danmaku(uid: number, uname: string, text: string): Record<string, unknown> {
  const info: unknown[] = [];
  info[1] = text;
  info[2] = [uid, uname];
  info[3] = [];
  info[7] = 0;
  return { cmd: 'DANMU_MSG', info };
}

const LIVE_STATUS: LiveStatus = {
  phase: 'connected',
  roomId: 6,
  realRoomId: 7734200,
  title: 'CortiV 集成',
  living: true,
  liveStartedAt: null,
  selfUid: 1039523363,
  lastError: null,
};

describe.sequential('CortiV 集成测试', () => {
  const tmp = makeTmpDir();
  const llm = new FakeLLM();
  let bot: Bot<CortiVConfig>;
  let feedBilibili: (message: Record<string, unknown>) => void;
  let port = 0;
  let ws: WebSocket;
  const terminalMessages: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    const config = structuredClone(definition.defaults());
    config.web.port = 0;
    config.batching.quietGapMs = 40;
    config.batching.maxBatchAgeMs = 300;
    config.tick.intervalMinutes = null;
    config.worlds.terminal.enabled = true;
    config.worlds.bilibili.enabled = true;
    config.worlds.bilibili.roomId = 6;
    config.worlds.minecraft.enabled = false;

    const memoryDir = join(tmp.dir, 'workspace');
    const dataDir = join(tmp.dir, 'data');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(tmp.dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const loaded: LoadedConfig<CortiVConfig> = {
      config,
      rootDir: tmp.dir,
      memoryDir,
      dataDir,
      secret: () => 'fake-key',
    };
    const fakeBilibili = new BilibiliWorld({
      roomId: 6,
      giftFlushYuan: () => config.worlds.bilibili.giftFlushYuan,
      timezone: config.timezone,
      source: (handlers: LiveHandlers) => {
        feedBilibili = handlers.onCmd;
        return {
          start: async () => handlers.onStatus(LIVE_STATUS),
          stop: async () => {},
          current: () => LIVE_STATUS,
          shutdownVerification: () => [{
            key: 'mock.bilibili',
            label: 'B 站测试源',
            status: 'verified-ended' as const,
            detail: '测试替身已确认结束',
            manualAction: '',
          }],
        };
      },
    });

    bot = createBot(loaded, {
      ...definition,

      worlds: (definition.worlds ?? []).map((def) =>
        def.id === 'bilibili' ? { ...def, create: () => fakeBilibili } : def),
      build: (deployment, worlds) => ({ ...definition.build(deployment, worlds), llm }),
    });
    port = (await bot.start()).port as number;
    await waitFor(() => llm.calls.length > 0 && legacyMessages(bot.core.session.records).length >= 3);

    ws = new WebSocket(`ws://127.0.0.1:${port}${panelStreamRoute('world:terminal', 'chat')}`);
    ws.on('message', (data) => terminalMessages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'hello', name: 'phantivia' }));
  }, 20_000);

  afterAll(async () => {
    try { ws?.close(); } catch { /* already closed */ }
    if (bot) await bot.stop();
    tmp.cleanup();
  });

  it('把弹幕突发、人流读数和高价值礼物接进同一条真实投递链', async () => {
    const callsBefore = llm.calls.length;
    feedBilibili({ cmd: 'INTERACT_WORD_V2', data: {} });
    feedBilibili({ cmd: 'INTERACT_WORD_V2', data: {} });
    feedBilibili({ cmd: 'WATCHED_CHANGE', data: { num: 288429 } });
    feedBilibili(danmaku(42, '阿明', '刷怪塔要记得照明外圈'));
    feedBilibili(danmaku(84, '小羽', '农场旁边留红石检修道'));
    feedBilibili({
      cmd: 'SEND_GIFT',
      data: { uname: '阿明', giftName: '舰长票', num: 1, coin_type: 'gold', total_coin: 5000 },
    });

    await waitFor(() => llm.calls.length > callsBefore);
    await waitFor(() => bot.core.store.range({}).some((event) =>
      event.type === 'bilibili.audience' && event.text.includes('2 人进场')));
    await waitFor(() => legacyMessages(bot.core.session.records).some((message) =>
      message.role === 'tool' && message.content.includes('刷怪塔要记得照明外圈')));

    const events = bot.core.store.range({});
    const danmakuEvents = events.filter((event) => event.type === 'bilibili.danmaku');
    expect(danmakuEvents
      .filter((event) => event.contextDelivery !== 'archive-only')
      .map((event) => event.senderKey))
      .toEqual(['42', '84']);
    expect(danmakuEvents
      .filter((event) => event.contextDelivery === 'archive-only')
      .map((event) => event.senderKey))
      .toEqual(['42', '84']);
    expect(events.some((event) => event.type === 'bilibili.gift' && event.text.includes('舰长票'))).toBe(true);
    expect(events.some((event) => event.type === 'bilibili.audience'
      && event.text.includes('看过 288429'))).toBe(true);
  });

  it('控制台输入能即时唤醒、调用发送工具并回到同一个 WebSocket', async () => {
    llm.script(toolReply([
      { name: 'terminal_send', args: { text: '我收到了，试播控制台链路正常。' } },
    ]));
    ws.send(JSON.stringify({ type: 'msg', text: '试播检查：现在能看到控制台吗？' }));

    await waitFor(() => terminalMessages.some((message) =>
      message.type === 'msg' && String(message.text).includes('我收到了')));
    expect(bot.core.store.range({}).some((event) =>
      event.type === 'terminal.message' && event.text.includes('试播检查'))).toBe(true);
    expect(bot.core.store.range({}).some((event) =>
      event.type === 'terminal.self' && event.text.includes('试播控制台链路正常'))).toBe(true);
  });

  it('真实工作区覆写会保留历史，并把异常缩短警告回给主 session', async () => {
    const file = join(tmp.dir, 'workspace', 'minecraft', '试播记录.md');
    const longText = `# 试播记录\n${'第八场压测内容。'.repeat(500)}`;
    llm.script(toolReply([
      { name: 'write_file', args: { path: 'minecraft/试播记录.md', content: longText } },
    ]));
    ws.send(JSON.stringify({ type: 'msg', text: '先写一份较长的试播记录。' }));
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').length === longText.length);

    llm.script(toolReply([
      { name: 'write_file', args: { path: 'minecraft/试播记录.md', content: '# 试播记录\n只剩结论。' } },
    ]));
    ws.send(JSON.stringify({ type: 'msg', text: '把试播记录意外缩成一句，检查警告。' }));
    await waitFor(() => readFileSync(file, 'utf8').includes('只剩结论'));
    await waitFor(() => legacyMessages(bot.core.session.records).some((message) =>
      message.role === 'tool' && /缩水提示/.test(message.content)));

    const history = await fetch(
      `http://127.0.0.1:${port}/api/console/providers/memory%3Acortiv/panels/workspace/history`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: ['minecraft/试播记录.md'] }),
      },
    );
    expect(history.status).toBe(200);
    expect(await history.text()).toContain('试播记录.md');
  });

  it('上下文与认知配置可热改并保存', async () => {
    const groups = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json() as {
      groups: Array<{ group: { id: string } }>;
    };
    expect(groups.groups.map((entry) => entry.group.id)).toEqual(expect.arrayContaining([
      'cortiv', 'cortiv-cognition', 'world:bilibili', 'world:terminal',
    ]));

    const set = (group: string, values: Record<string, unknown>) => fetch(
      `http://127.0.0.1:${port}/api/config`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group, values }),
      },
    );
    expect((await set('cortiv', { 'context.maxTokens': 96000 })).status).toBe(200);
    expect((await set('cortiv-cognition', { 'cognition.enabled': false })).status).toBe(200);
    expect(bot.core.config.context.maxTokens).toBe(96000);
    expect(bot.core.config.cognition.enabled).toBe(false);

    const onDisk = JSON.parse(readFileSync(join(tmp.dir, 'config.json'), 'utf8')) as CortiVConfig;
    expect(onDisk.context.maxTokens).toBe(96000);
    expect(onDisk.cognition.enabled).toBe(false);
  });

  it('关机按序执行并返回各步骤结果', async () => {
    ws.close();
    const report = await bot.shutdown('集成测试完成');
    expect(report.complete).toBe(true);
    expect(report.steps.map((step) => step.key)).toEqual(['pause', 'worlds', 'core', 'llm', 'flush', 'web']);
    expect(report.steps.every((step) => step.ok)).toBe(true);
  }, 35_000);
});
