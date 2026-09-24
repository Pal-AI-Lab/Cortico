/**
 * 完整回路测试:MockOneBot(真WS服务端) ⇄ QQWorld ⇄ FakeHost。
 * 覆盖:环境提示词、事件入库字段+会话标签、多群/私聊过滤、撤回/入退群/
 * 表情回应、draft→confirm 起草确认门、私聊路由、映射重建。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderWorldEnvPrompt } from '../../../src/core/prefix.ts';
import { nullLogger } from '../../../src/core/util.ts';
import type { EventEnvelope, ToolCallContext } from '../../../src/core/types.ts';
import { MockOneBot } from '../../helpers/mock-onebot.ts';
import { QQWorld } from '../../../src/worlds/qq/world.ts';
import { FakeHost, waitUntil } from './helpers.ts';

const GROUP = 424242;
const SELF = 5000;
const toolCtx: ToolCallContext = { role: 'main', log: nullLogger() };

let mock: MockOneBot;
let mod: QQWorld;
let host: FakeHost;

beforeEach(async () => {
  mock = new MockOneBot({
    port: 0,
    groupId: GROUP,
    selfId: SELF,
    selfNickname: 'bot',
    selfCard: 'botcard',
    groupName: '深夜食堂',
  });
  const port = await mock.start();
  host = new FakeHost();
  mod = new QQWorld({ wsUrl: `ws://127.0.0.1:${port}`, groups: [GROUP], privates: [], token: '' });
  await mod.start(host);
  await mod.waitReady();
});

afterEach(async () => {
  await mod.stop();
  await mock.close();
});

function tool(name: string) {
  const t = mod.tools().find((t) => t.name === name);
  if (!t) throw new Error(`tool不存在: ${name}`);
  return t;
}

async function startImageServer(bytes: Uint8Array, delayMs = 0): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_req, res) => {
    const send = () => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(bytes);
    };
    if (delayMs) setTimeout(send, delayMs);
    else send();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/image.png`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

describe('环境提示词', () => {
  it('连接后列出监听会话:群名/群号/群昵称/QQ号', async () => {
    const text = (await renderWorldEnvPrompt(mod)).text;
    expect(text).toContain(`群「深夜食堂」(群号${GROUP})`);
    expect(text).toContain('你在这个群的昵称是「botcard」');
    expect(text).toContain(`你的QQ号是${SELF}`);
  });

  it('配置了私聊时列出私聊名单', async () => {
    mod.setWatched([GROUP], [1001]);
    const text = (await renderWorldEnvPrompt(mod)).text;
    expect(text).toContain('私聊:');
    expect(text).toContain('1001');
  });

  it('掉线沿用断线前的群名快照:前缀内容不变,缓存不被击穿', async () => {
    const warm = (await renderWorldEnvPrompt(mod)).text;
    expect(warm).toContain('群「深夜食堂」');
    // 驱动没了 identity,但缓存还在:会话清单照旧,只有身份行落回模板缺省
    (mod as unknown as { driver: unknown }).driver = null;
    const offline = (await renderWorldEnvPrompt(mod)).text;
    expect(offline).toContain('群「深夜食堂」');
  });
});

describe('群消息入库', () => {
  it('普通消息 → qq.message信封,带会话标签,照常合批,meta.conv', async () => {
    mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: 'bot在吗' });
    await waitUntil(() => host.pushed.length === 1, '收到1条事件');

    const { event, opts } = host.pushed[0];
    expect(event.type).toBe('qq.message');
    expect(event.source).toBe('qq');
    expect(event.senderKey).toBe('1001');
    // 行首 #<message_id> 是平台自己的消息身份,引用回复时回传的就是它
    expect(event.text).toMatch(/^#\d+ \[群「深夜食堂」 \d{2}:\d{2}\] 阿明\(1001\): bot在吗$/);
    expect(event.text.startsWith(`#${event.meta?.message_id} `)).toBe(true);
    expect(event.meta?.message_id).toBeDefined();
    expect(event.meta?.conv).toEqual({ kind: 'group', id: GROUP });
    expect(opts?.trigger).toBe('debounce');
  });

  it('被@ → 立即投递,文本含@自己(群昵称)标记', async () => {
    mock.emitGroupMessage({
      user_id: 1001,
      nickname: '阿明',
      segments: [
        { type: 'at', data: { qq: String(SELF) } },
        { type: 'text', data: { text: ' 在吗' } },
      ],
    });
    await waitUntil(() => host.pushed.length === 1, '收到1条事件');

    const { event, opts } = host.pushed[0];
    expect(opts?.trigger).toBe('flush');
    expect(event.text).toContain('@botcard(你)');
  });

  it('reply段命中此前记录过的消息 → [回复#<message_id>]', async () => {
    const mid = mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: '第一条' });
    await waitUntil(() => host.pushed.length === 1, '第一条入库');

    mock.emitGroupMessage({
      user_id: 2002,
      nickname: '阿强',
      segments: [
        { type: 'reply', data: { id: String(mid) } },
        { type: 'text', data: { text: '接上' } },
      ],
    });
    await waitUntil(() => host.pushed.length === 2, '第二条入库');
    expect(host.pushed[1].event.text).toContain(`[回复#${mid}]`);
  });
});

describe('图片段按当前主模型渲染', () => {
  it('主模型切到接收图像后，新消息的图片带地址', async () => {
    const imageServer = await startImageServer(new Uint8Array([1, 2, 3]));
    try {
      const image = [{ type: 'image', data: { url: imageServer.url } }];
      mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', segments: image });
      await waitUntil(() => host.pushed.length === 1, '收到第1条事件');
      expect(host.pushed[0].event.text).toContain('[图片]');

      host.modelFacts = { ...host.modelFacts, accepts: () => true };
      mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', segments: image });
      await waitUntil(() => host.pushed.length === 2, '收到第2条事件');
      expect(host.pushed[1].event.text).toContain(`[图片 ${imageServer.url}]`);
    } finally {
      await imageServer.close();
    }
  });

  it('辅助视觉关闭时仍把入站图片字节附在消息事件上', async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const imageServer = await startImageServer(bytes);
    try {
      host.modelFacts = { ...host.modelFacts, accepts: () => true };
      mock.emitGroupMessage({
        user_id: 1001,
        nickname: '阿明',
        segments: [{ type: 'image', data: { url: imageServer.url } }],
      });
      await waitUntil(() => host.pushed.length === 1, '图片消息入库');

      const event = host.pushed[0].event;
      expect(event.type).toBe('qq.message');
      expect(event.text).toContain(`[图片 ${imageServer.url}]`);
      expect(event.blobs).toHaveLength(1);
      const saved = host.blob(event.blobs![0].handle);
      expect(saved?.mime).toBe('image/png');
      expect([...saved!.bytes]).toEqual([...bytes]);
    } finally {
      await imageServer.close();
    }
  });

  it('辅助视觉关闭时私聊图片也随消息保存', async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 2]);
    const imageServer = await startImageServer(bytes);
    try {
      mod.setWatched([GROUP], [1001]);
      await waitUntil(() => host.pushed.some(({ event }) => event.type === 'qq.watch'), '监听变更入库');
      host.modelFacts = { ...host.modelFacts, accepts: () => true };
      const messageId = 7799;
      mock.emitRaw({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        user_id: 1001,
        message_id: messageId,
        time: Math.floor(Date.now() / 1000),
        sender: { user_id: 1001, nickname: '阿明' },
        message: [{ type: 'image', data: { url: imageServer.url } }],
        raw_message: '',
      });
      await waitUntil(() => host.pushed.some(({ event }) => event.type === 'qq.message'), '私聊图片消息入库');

      const event = host.pushed.find(({ event }) => event.type === 'qq.message')!.event;
      expect(event.meta?.message_id).toBe(messageId);
      expect(event.meta?.conv).toEqual({ kind: 'private', id: 1001 });
      expect(event.blobs).toHaveLength(1);
      const saved = host.blob(event.blobs![0].handle);
      expect(saved?.mime).toBe('image/png');
      expect([...saved!.bytes]).toEqual([...bytes]);
    } finally {
      await imageServer.close();
    }
  });

  it('图片超过内联等待上限后随qq.image事件保存', async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const imageServer = await startImageServer(bytes, 2800);
    try {
      host.modelFacts = { ...host.modelFacts, accepts: () => true };
      mock.emitGroupMessage({
        user_id: 1001,
        nickname: '阿明',
        segments: [{ type: 'image', data: { url: imageServer.url } }],
      });
      await waitUntil(() => host.pushed.some(({ event }) => event.type === 'qq.message'), '主消息先入库', 4000);
      const message = host.pushed.find(({ event }) => event.type === 'qq.message')!.event;
      expect(message.blobs).toBeUndefined();

      await waitUntil(() => host.pushed.some(({ event }) => event.type === 'qq.image'), '后续图片事件到达', 2000);
      const attachment = host.pushed.find(({ event }) => event.type === 'qq.image')!.event;
      expect(attachment.meta?.message_id).toBe(message.meta?.message_id);
      expect(attachment.blobs).toHaveLength(1);
      const saved = host.blob(attachment.blobs![0].handle);
      expect(saved?.mime).toBe('image/png');
      expect([...saved!.bytes]).toEqual([...bytes]);
    } finally {
      await imageServer.close();
    }
  });
});

describe('未捕获的引用回复(异步取原文)', () => {
  it('reply指向的消息不在游标映射里 → 立即占位文本,随后追加qq.reply.uncaptured事件带原文', async () => {
    mock.setMockMsg(999999, {
      sender: { nickname: '老张', user_id: 3003 },
      message: [{ type: 'text', data: { text: '晚上八点老地方见' } }],
    });
    mock.emitGroupMessage({
      user_id: 2002,
      nickname: '阿强',
      segments: [
        { type: 'reply', data: { id: '999999' } },
        { type: 'text', data: { text: '接上' } },
      ],
    });
    // 本地回环下主消息与跟进事件到达间隔极短,不断言length===1的中间态,直接等最终态按顺序核对两条
    await waitUntil(() => host.pushed.length === 2, '主消息+跟进事件都到位');
    expect(host.pushed[0].event.text).toContain('[回复某条未被记录的消息,原文正在查询中...]');

    const followUp = host.pushed[1].event;
    expect(followUp.type).toBe('qq.reply.uncaptured');
    expect(followUp.text).toContain('未被捕获');
    expect(followUp.text).toContain('老张(3003)');
    expect(followUp.text).toContain('晚上八点老地方见');
  });

  it('原文也取不到时,追加失败说明,不抛错', async () => {
    mock.emitGroupMessage({
      user_id: 2002,
      nickname: '阿强',
      segments: [
        { type: 'reply', data: { id: '888888' } },
        { type: 'text', data: { text: '接上' } },
      ],
    });
    await waitUntil(() => host.pushed.length === 2, '主消息+失败跟进都到位');
    const followUp = host.pushed[1].event;
    expect(followUp.type).toBe('qq.reply.uncaptured');
    expect(followUp.text).toContain('没能取到');
  });
});

describe('转发消息展开', () => {
  it('forward段 → 立即占位文本,随后追加qq.forward事件带展开内容', async () => {
    mock.setMockForward('res-1', [
      { sender: { nickname: '小美', user_id: 4004 }, content: [{ type: 'text', data: { text: '在的在的' } }] },
      { sender: { nickname: 'bot', user_id: SELF }, content: [{ type: 'text', data: { text: '我也在' } }] },
      { sender: { nickname: '老王', user_id: 5005 }, content: [{ type: 'text', data: { text: '几点出发' } }] },
    ]);
    mock.emitGroupMessage({
      user_id: 1001,
      nickname: '阿明',
      segments: [{ type: 'forward', data: { id: 'res-1' } }],
    });
    // 同上:不断言中间态,直接等最终态核对
    await waitUntil(() => host.pushed.length === 2, '主消息+跟进事件都到位');
    expect(host.pushed[0].event.text).toContain('[转发的聊天记录,正在展开中...]');

    const followUp = host.pushed[1].event;
    expect(followUp.type).toBe('qq.forward');
    expect(followUp.text).toContain('小美(4004): 在的在的');
    expect(followUp.text).toContain(`你(${SELF}): 我也在`);
    expect(followUp.text).toContain('老王(5005): 几点出发');
  });

  it('兼容OneBot标准message/node返回,包括bot自己的发言', async () => {
    mock.setMockForwardResponse('res-standard', {
      message: [
        {
          type: 'node',
          data: {
            user_id: String(SELF),
            nickname: 'bot',
            content: [{ type: 'text', data: { text: '有一点' } }],
          },
        },
        {
          type: 'node',
          data: {
            user_id: '1307995576',
            nickname: 'phantom',
            content: [{ type: 'text', data: { text: '你烦躁吗' } }],
          },
        },
      ],
    });
    mock.emitGroupMessage({
      user_id: 1001,
      nickname: '阿明',
      segments: [{ type: 'forward', data: { id: 'res-standard' } }],
    });

    await waitUntil(() => host.pushed.length === 2, '主消息+标准node跟进事件都到位');
    const followUp = host.pushed[1].event;
    expect(followUp.text).toContain(`你(${SELF}): 有一点`);
    expect(followUp.text).toContain('phantom(1307995576): 你烦躁吗');
  });

  it('NapCat漏掉私聊转发中的自身节点时,从同会话的qq.self历史补回', async () => {
    const first = 1_784_826_291;
    const second = 1_784_826_820;
    const peer = 1_307_995_576;
    host.store.append({
      type: 'qq.self',
      ts: new Date((first + 11) * 1000).toISOString(),
      source: 'qq',
      origin: 'external',
      text: '[私聊 01:05] 你: 嗯，凌晨了。不太好停下来。',
      senderKey: String(SELF),
      meta: { conv: { kind: 'private', id: peer } },
    });
    host.store.append({
      type: 'qq.self',
      ts: new Date((second + 11) * 1000).toISOString(),
      source: 'qq',
      origin: 'external',
      text: '[私聊 01:13] 你: 有一点。',
      senderKey: String(SELF),
      meta: { conv: { kind: 'private', id: peer } },
    });
    host.store.append({
      type: 'qq.self',
      ts: new Date((second + 12) * 1000).toISOString(),
      source: 'qq',
      origin: 'external',
      text: '[私聊 01:13] 你: 另一段私聊，不能串进来。',
      senderKey: String(SELF),
      meta: { conv: { kind: 'private', id: peer + 1 } },
    });
    mock.setMockForward('res-missing-self', [
      {
        user_id: peer,
        time: first,
        message_type: 'private',
        sender: { nickname: 'phantom', user_id: peer },
        message: [{ type: 'text', data: { text: '我看到你一直在尝试休眠' } }],
      },
      {
        user_id: peer,
        time: second,
        message_type: 'private',
        sender: { nickname: 'phantom', user_id: peer },
        message: [{ type: 'text', data: { text: '你烦躁吗' } }],
      },
    ]);
    mock.emitGroupMessage({
      user_id: 1001,
      nickname: '阿明',
      segments: [{ type: 'forward', data: { id: 'res-missing-self' } }],
    });

    await waitUntil(() => host.pushed.length === 2, '主消息+补回自身节点的跟进事件都到位');
    const followUp = host.pushed[1].event;
    const text = followUp.text;
    expect(text).toContain(`你(${SELF}): 嗯，凌晨了。不太好停下来。 [本地记录补回]`);
    expect(text).toContain(`你(${SELF}): 有一点。 [本地记录补回]`);
    expect(text.indexOf('我看到你一直在尝试休眠')).toBeLessThan(
      text.indexOf('嗯，凌晨了。不太好停下来。'),
    );
    expect(text.indexOf('你烦躁吗')).toBeLessThan(text.indexOf('有一点。'));
    expect(text).not.toContain('另一段私聊');
  });

  it('身份全塌成同一个人(昵称是QQ用户占位)时,去掉发言人前缀并在标题说明', async () => {
    const forwarder = 1_094_950_020;
    mock.setMockForward('res-collapsed', [
      {
        sender: { nickname: 'QQ用户', user_id: forwarder },
        content: [{ type: 'text', data: { text: '我又头晕又想吐' } }],
      },
      {
        sender: { nickname: 'QQ用户', user_id: forwarder },
        content: [{ type: 'text', data: { text: '兄弟' } }],
      },
      {
        sender: { nickname: 'QQ用户', user_id: forwarder },
        content: [{ type: 'text', data: { text: '能不能体面一点' } }],
      },
    ]);
    mock.emitGroupMessage({
      user_id: 1001,
      nickname: '阿明',
      segments: [{ type: 'forward', data: { id: 'res-collapsed' } }],
    });

    await waitUntil(() => host.pushed.length === 2, '主消息+身份塌掉的跟进事件都到位');
    const followUp = host.pushed[1].event;
    expect(followUp.text).toContain('发言人身份没能取到');
    expect(followUp.text).toContain('\n我又头晕又想吐\n兄弟\n能不能体面一点');
    expect(followUp.text).not.toContain('QQ用户');
    expect(followUp.text).not.toContain(String(forwarder));
  });

  it('同一个人连发多条但名字正常时不算塌,照常带发言人', async () => {
    mock.setMockForward('res-same-person', [
      {
        sender: { nickname: '老王', user_id: 5005 },
        content: [{ type: 'text', data: { text: '在吗' } }],
      },
      {
        sender: { nickname: '老王', user_id: 5005 },
        content: [{ type: 'text', data: { text: '出来吃饭' } }],
      },
    ]);
    mock.emitGroupMessage({
      user_id: 1001,
      nickname: '阿明',
      segments: [{ type: 'forward', data: { id: 'res-same-person' } }],
    });

    await waitUntil(() => host.pushed.length === 2, '主消息+跟进事件都到位');
    const followUp = host.pushed[1].event;
    expect(followUp.text).toContain('老王(5005): 在吗');
    expect(followUp.text).toContain('老王(5005): 出来吃饭');
    expect(followUp.text).not.toContain('发言人身份没能取到');
  });

  it('展开失败时追加失败说明', async () => {
    mock.emitGroupMessage({
      user_id: 1001,
      nickname: '阿明',
      segments: [{ type: 'forward', data: { id: 'no-such-res' } }],
    });
    await waitUntil(() => host.pushed.length === 2, '主消息+失败跟进都到位');
    const followUp = host.pushed[1].event;
    expect(followUp.type).toBe('qq.forward');
    expect(followUp.text).toContain('没能展开');
  });
});

describe('会话过滤(多群+私聊)', () => {
  it('其他群消息/名单外私聊/其他群通知/好友请求都不落盘', async () => {
    mock.emitGroupMessage({ user_id: 1001, text: '别的群', group_id: GROUP + 1 });
    mock.emitPrivateMessage({ user_id: 1001, text: '名单外私聊' });
    mock.emitRecall(12345, { user_id: 1001, group_id: GROUP + 1 });
    mock.emitRaw({ post_type: 'request', request_type: 'friend', user_id: 9 });
    // 最后发一条目标群消息作为"顺序屏障"
    mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: '本群的' });
    await waitUntil(() => host.pushed.length >= 1, '屏障消息到达');

    expect(host.pushed).toHaveLength(1);
    expect(host.pushed[0].event.text).toContain('本群的');
  });

  it('监听名单内的私聊落库:私聊标签、meta.conv、照常合批', async () => {
    mod.setWatched([GROUP], [1001]); // 私聊1001新加入监听 → 先推一条qq.watch通知
    mock.emitPrivateMessage({ user_id: 1001, text: '在忙吗', nickname: '老王' });
    await waitUntil(() => host.pushed.length === 2, '监听变更通知+私聊消息均入库');

    const { event, opts } = host.pushed[1];
    expect(event.type).toBe('qq.message');
    expect(event.senderKey).toBe('1001');
    expect(event.text).toMatch(/^#\d+ \[私聊 \d{2}:\d{2}\] 老王\(1001\): 在忙吗$/);
    expect(event.meta?.conv).toEqual({ kind: 'private', id: 1001 });
    expect(opts?.trigger).toBe('debounce');
  });

  it('热改加入第二个群后,该群消息开始落库', async () => {
    const G2 = GROUP + 7;
    mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: 'G2消息', group_id: G2 });
    mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: '屏障1' });
    await waitUntil(() => host.pushed.length >= 1, '屏障1到达');
    expect(host.pushed).toHaveLength(1); // 尚未监听G2 → 丢弃

    mod.setWatched([GROUP, G2], []); // G2新加入监听 → 先推一条qq.watch通知
    mock.emitGroupMessage({ user_id: 2002, nickname: '阿强', text: '现在G2也听', group_id: G2 });
    await waitUntil(() => host.pushed.length === 3, 'G2消息落库(屏障1+监听变更通知+G2消息)');
    expect(host.pushed[2].event.meta?.conv).toEqual({ kind: 'group', id: G2 });
  });
});

describe('监听名单变更通知(qq.watch)', () => {
  it('新增群 → 推送join事件,type/text/meta都对', () => {
    const G2 = GROUP + 9;
    mod.setWatched([GROUP, G2], []);
    const watch = host.pushed.filter((p) => p.event.type === 'qq.watch');
    expect(watch).toHaveLength(1);
    expect(watch[0].event.text).toBe(`[系统] 群(群号${G2}) 已加入监听`);
    expect(watch[0].event.senderKey).toBe(String(G2));
    expect(watch[0].event.meta).toEqual({ conv: { kind: 'group', id: G2 } });
  });

  it('移出群 → 推送leave事件', () => {
    mod.setWatched([], []); // 构造时已监听GROUP,这里移除
    const watch = host.pushed.filter((p) => p.event.type === 'qq.watch');
    expect(watch).toHaveLength(1);
    expect(watch[0].event.text).toBe(`[系统] 群(群号${GROUP}) 已从监听移除`);
    expect(watch[0].event.meta).toEqual({ conv: { kind: 'group', id: GROUP } });
  });

  it('新增私聊 → 推送join事件(QQ号标签)', () => {
    mod.setWatched([GROUP], [1001]);
    const watch = host.pushed.filter((p) => p.event.type === 'qq.watch');
    expect(watch).toHaveLength(1);
    expect(watch[0].event.text).toBe('[系统] 私聊(QQ号1001) 已加入监听');
    expect(watch[0].event.meta).toEqual({ conv: { kind: 'private', id: 1001 } });
  });

  it('不变的id不触发事件(与构造时相同的集合)', () => {
    mod.setWatched([GROUP], []);
    expect(host.pushed.filter((p) => p.event.type === 'qq.watch')).toHaveLength(0);
  });

  it('一次调用里同时增删多个 → 每个变化各自一条事件', () => {
    const G2 = GROUP + 9;
    mod.setWatched([G2], [2002]); // GROUP离开,G2加入,2002私聊加入
    const texts = host.pushed
      .filter((p) => p.event.type === 'qq.watch')
      .map((p) => p.event.text)
      .sort();
    expect(texts).toEqual(
      [
        `[系统] 群(群号${G2}) 已加入监听`,
        `[系统] 群(群号${GROUP}) 已从监听移除`,
        '[系统] 私聊(QQ号2002) 已加入监听',
      ].sort(),
    );
  });
});

describe('通知类事件', () => {
  it('撤回:命中记录过的消息 → 带会话标签+#<message_id>', async () => {
    const mid = mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: '说错话了' });
    await waitUntil(() => host.pushed.length === 1, '消息入库');

    mock.emitRecall(mid, { user_id: 1001 });
    await waitUntil(() => host.pushed.length === 2, '撤回入库');

    const { event } = host.pushed[1];
    expect(event.type).toBe('qq.recall');
    expect(event.text).toMatch(
      new RegExp(`^\\[群「深夜食堂」 \\d{2}:\\d{2}\\] 阿明\\(1001\\) 撤回了一条消息\\(#${mid}\\)$`),
    );
  });

  it('撤回:找不到对应消息 → 泛化描述', async () => {
    mock.emitRecall(99999, { user_id: 1001 });
    await waitUntil(() => host.pushed.length === 1, '撤回入库');
    const { event } = host.pushed[0];
    expect(event.text).toContain('撤回了一条消息');
    expect(event.text).not.toContain('#');
  });

  it('入群/退群 → 带会话标签的[系统]行,type qq.member', async () => {
    mock.emitMemberJoin(3003);
    mock.emitMemberLeave(3003);
    await waitUntil(() => host.pushed.length === 2, '两条通知入库');

    expect(host.pushed[0].event.type).toBe('qq.member');
    expect(host.pushed[0].event.text).toBe('[群「深夜食堂」 系统] 3003(3003)加入了群');
    expect(host.pushed[1].event.text).toBe('[群「深夜食堂」 系统] 3003(3003)退出了群');
  });

  it('表情回应 → 指向平台消息号', async () => {
    const mid = mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: '冷笑话' });
    await waitUntil(() => host.pushed.length === 1, '消息入库');

    mock.emitEmojiLike({ message_id: mid, user_id: 1001, emoji_id: '128077' });
    await waitUntil(() => host.pushed.length === 2, '表情回应入库');

    const { event } = host.pushed[1];
    expect(event.type).toBe('qq.emoji');
    expect(event.text).toMatch(new RegExp(`阿明\\(1001\\) 给#${mid}贴了个表情$`));
  });

  it('戳一戳:戳别人 → qq.poke,双方称呼都在', async () => {
    mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: 'hi' }); // 建立称呼映射
    await waitUntil(() => host.pushed.length === 1, '消息入库');

    mock.emitPoke({ user_id: 1001, target_id: 2002 });
    await waitUntil(() => host.pushed.length === 2, '戳一戳入库');

    const { event } = host.pushed[1];
    expect(event.type).toBe('qq.poke');
    expect(event.text).toMatch(/阿明\(1001\) 戳了戳 2002\(2002\)$/);
    expect(event.meta).toMatchObject({ user_id: 1001 });
  });

  it('戳一戳:戳自己 → 目标标注(你)', async () => {
    mock.emitPoke({ user_id: 1001, target_id: SELF });
    await waitUntil(() => host.pushed.length === 1, '戳一戳入库');

    expect(host.pushed[0].event.text).toContain('戳了戳 bot(你)');
  });

  it('戳一戳:raw_info里有自定义文案 → 拼出实际动作而非默认"戳了戳"', async () => {
    mock.emitPoke({
      user_id: 1001,
      target_id: SELF,
      rawInfo: [{ txt: '拍了拍' }, { txt: '的脑袋' }],
    });
    await waitUntil(() => host.pushed.length === 1, '戳一戳入库');

    expect(host.pushed[0].event.text).toContain('拍了拍的脑袋 bot(你)');
  });

  it('戳一戳:raw_info形状不对也不崩,退回默认文案', async () => {
    mock.emitPoke({ user_id: 1001, target_id: SELF, rawInfo: [{ foo: 'bar' } as never] });
    await waitUntil(() => host.pushed.length === 1, '戳一戳入库');

    expect(host.pushed[0].event.text).toContain('戳了戳 bot(你)');
  });
});

describe('起草-确认门(draft/confirm)', () => {
  it('draft暂存不发;confirm(send)才发,回录deliver:false,带会话标签', async () => {
    const d = await tool('qq_draft').handler({ to: `group:${GROUP}`, text: '大家好' }, toolCtx);
    expect(d).toContain('draft staged');
    expect(d).toContain('No messages arrived while staging');
    expect(tool('qq_draft').barrierAfter).toBe(true);
    expect(mock.outbox).toHaveLength(0); // 未确认前不发

    const c = await tool('qq_confirm').handler({ decision: 'send' }, toolCtx);
    expect(c).toContain('sent #');
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].action).toBe('send_group_msg');
    expect(mock.outbox[0].params.group_id).toBe(GROUP);
    expect(mock.outbox[0].params.message).toEqual([{ type: 'text', data: { text: '大家好' } }]);

    const self = host.pushed.find((p) => p.event.type === 'qq.self');
    expect(self).toBeDefined();
    expect(self!.opts?.deliver).toBe(false);
    // 自己发的也带平台消息号:之后能引用回复自己说过的话
    expect(self!.event.text).toMatch(/^#\d+ \[群「深夜食堂」 \d{2}:\d{2}\] 你: 大家好$/);
    expect(self!.event.meta?.conv).toEqual({ kind: 'group', id: GROUP });
  });

  it('draft把积压会话事件交回主循环排进待观察队列，不混入工具回执', async () => {
    const pending: EventEnvelope = {
      cursor: 7,
      type: 'qq.message',
      ts: '2026-07-18T21:00:00+08:00',
      source: 'qq',
      origin: 'external',
      text: '[群「深夜食堂」 21:00] 阿强: 等等我还没说完',
    };
    host.pendingForDrain = [pending];
    const queued: EventEnvelope[] = [];
    const d = await tool('qq_draft').handler(
      { to: `group:${GROUP}`, text: '好的' },
      { ...toolCtx, queueExternalEvents: (events) => queued.push(...events) },
    );
    expect(d).toContain('1 message(s) arrived');
    expect(d).not.toContain('#7');
    expect(d).not.toContain('等等我还没说完');
    expect(queued).toEqual([pending]);
    expect(host.pendingForDrain).toHaveLength(0); // 消费一次
  });

  it('draft带voice(句柄):confirm(send)只发一个record段,回录标出语音并附句柄', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const handle = host.putBlob(bytes, 'audio/wav', 'mem:external/qq/voice/晚安.wav');
    const d = (await tool('qq_draft').handler({ to: `group:${GROUP}`, voice: handle }, toolCtx)) as string;
    expect(d).toContain('will send voice');
    expect(d).toContain('voice bar, no text');

    expect(await tool('qq_confirm').handler({ decision: 'send' }, toolCtx)).toContain('sent #');
    expect(mock.outbox[0].params.message).toEqual([
      { type: 'record', data: { file: `base64://${Buffer.from(bytes).toString('base64')}` } },
    ]);
    const self = host.pushed.find((p) => p.event.type === 'qq.self')!;
    expect(self.event.text).toContain(`[语音: ${handle}]`);
    expect(self.event.blobs?.[0].handle).toBe(handle);
  });

  it('语音条不与正文、图片、引用同发;句柄不是音频就拒,且不暂存', async () => {
    const voice = host.putBlob(new Uint8Array([9]), 'audio/wav', 'mem:external/qq/voice/a.wav');
    expect(await tool('qq_draft').handler({ to: `group:${GROUP}`, voice, text: '顺便说一句' }, toolCtx))
      .toContain('message of its own');
    const png = host.putBlob(new Uint8Array([7]), 'image/png');
    expect(await tool('qq_draft').handler({ to: `group:${GROUP}`, voice: png }, toolCtx)).toContain('not audio');
    expect(await tool('qq_confirm').handler({ decision: 'send' }, toolCtx)).toContain('no draft to confirm');
    expect(mock.outbox).toHaveLength(0);
  });

  it('confirm(cancel):草稿放弃,不发送', async () => {
    await tool('qq_draft').handler({ to: `group:${GROUP}`, text: '算了' }, toolCtx);
    const c = await tool('qq_confirm').handler({ decision: 'cancel' }, toolCtx);
    expect(c).toContain('discarded');
    expect(mock.outbox).toHaveLength(0);
  });

  it('没有草稿时confirm → 提示先起草', async () => {
    const c = await tool('qq_confirm').handler({ decision: 'send' }, toolCtx);
    expect(c).toContain('no draft to confirm');
    expect(mock.outbox).toHaveLength(0);
  });

  it('discardPendingDraft后confirm无草稿(本轮结束默认擦除)', async () => {
    await tool('qq_draft').handler({ to: `group:${GROUP}`, text: 'xx' }, toolCtx);
    mod.discardPendingDraft();
    const c = await tool('qq_confirm').handler({ decision: 'send' }, toolCtx);
    expect(c).toContain('no draft to confirm');
    expect(mock.outbox).toHaveLength(0);
  });

  it('draft带reply_to、to省略 → 从被引用消息推断会话并编译reply段', async () => {
    const mid = mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: '谁在' });
    await waitUntil(() => host.pushed.length === 1, '消息入库');

    // reply_to 收的是平台消息号(消息行首那个),不是事件游标
    const d = await tool('qq_draft').handler({ text: '我在', reply_to: String(mid) }, toolCtx);
    expect(d).toContain('draft staged');
    await tool('qq_confirm').handler({ decision: 'send' }, toolCtx);

    expect(mock.outbox[0].params.group_id).toBe(GROUP);
    expect(mock.outbox[0].params.message).toEqual([
      { type: 'reply', data: { id: String(mid) } },
      { type: 'text', data: { text: '我在' } },
    ]);
  });

  it('draft引用没记录过的消息号 → 失败,不暂存', async () => {
    const d = await tool('qq_draft').handler(
      { to: `group:${GROUP}`, text: 'x', reply_to: 999 },
      toolCtx,
    );
    expect(d).toContain('no recorded QQ message with id #999');
    const c = await tool('qq_confirm').handler({ decision: 'send' }, toolCtx);
    expect(c).toContain('no draft to confirm');
  });

  it('reply_to 接受 #<id> 写法,也能引用自己刚发出的那条', async () => {
    // 先发送自身消息并记录平台消息号。
    await tool('qq_draft').handler({ to: `group:${GROUP}`, text: '我先说一句' }, toolCtx);
    const receipt = (await tool('qq_confirm').handler({ decision: 'send' }, toolCtx)) as string;
    const selfId = /#(\d+)/.exec(receipt)?.[1];
    expect(selfId).toBeDefined();

    const d = (await tool('qq_draft').handler(
      { text: '补充一下', reply_to: `#${selfId}` },
      toolCtx,
    )) as string;
    expect(d).toContain('draft staged');
    await tool('qq_confirm').handler({ decision: 'send' }, toolCtx);
    expect(mock.outbox[1].params.message).toEqual([
      { type: 'reply', data: { id: selfId } },
      { type: 'text', data: { text: '补充一下' } },
    ]);
  });

  it('draft未给to也无reply_to → 提示需要目标', async () => {
    const d = await tool('qq_draft').handler({ text: '谁' }, toolCtx);
    expect(d).toContain('send failed');
  });

  it('draft的to按群名寻址(非group:<id>/private:<id>) → 拒绝,要求数字ID', async () => {
    const d = (await tool('qq_draft').handler({ to: '深夜食堂', text: '按名字发' }, toolCtx)) as string;
    expect(d).toContain('send failed');
    expect(d).toContain('not a valid target');
    expect(d).toContain('numeric QQ group/user id');
  });

  it('draft回复一条已移出监听名单的会话 → 拒绝(不能往已退出的群发)', async () => {
    const G2 = GROUP + 3;
    mod.setWatched([GROUP, G2], []); // G2新加入监听 → 先推一条qq.watch通知
    const mid = mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: 'G2的', group_id: G2 });
    await waitUntil(() => host.pushed.length === 2, 'G2消息入库(监听变更通知+消息)');
    mod.setWatched([GROUP], []); // 移除G2
    const d = (await tool('qq_draft').handler({ text: '回你', reply_to: String(mid) }, toolCtx)) as string;
    expect(d).toContain('no longer on the watch list');
  });

  it('draft显式to与reply_to分属不同会话 → 拒绝跨会话引用', async () => {
    mod.setWatched([GROUP], [1001]); // 私聊1001新加入监听 → 先推一条qq.watch通知
    const mid = mock.emitGroupMessage({ user_id: 2002, nickname: '阿强', text: '群里的消息' });
    await waitUntil(() => host.pushed.length === 2, '群消息入库(监听变更通知+消息)');
    const d = (await tool('qq_draft').handler(
      { to: 'private:1001', text: '串会话', reply_to: String(mid) },
      toolCtx,
    )) as string;
    expect(d).toContain('cannot quote-reply across conversations');
  });

  it('draft到私聊 → confirm后 send_private_msg 路由到user_id', async () => {
    mod.setWatched([GROUP], [1001]); // 私聊1001新加入监听 → 先推一条qq.watch通知
    mock.emitPrivateMessage({ user_id: 1001, text: 'hi', nickname: '老王' });
    await waitUntil(() => host.pushed.length === 2, '监听变更通知+私聊消息均入库');

    await tool('qq_draft').handler({ to: 'private:1001', text: '你好' }, toolCtx);
    await tool('qq_confirm').handler({ decision: 'send' }, toolCtx);

    const sent = mock.outbox.find((o) => o.action === 'send_private_msg');
    expect(sent).toBeDefined();
    expect(sent!.params.user_id).toBe(1001);
    const self = host.pushed.find((p) => p.event.type === 'qq.self');
    expect(self!.event.text).toMatch(/^#\d+ \[私聊 \d{2}:\d{2}\] 你: 你好$/);
  });
});

describe('重启后映射重建', () => {
  it('新 World 实例从store meta重建已记录消息索引和称呼', async () => {
    const mid = mock.emitGroupMessage({ user_id: 1001, nickname: '阿明', text: '老消息' });
    await waitUntil(() => host.pushed.length === 1, '消息入库');
    await mod.stop();

    // 同一store,新 World 实例(模拟进程重启)
    mod = new QQWorld({
      wsUrl: `ws://127.0.0.1:${mock.port}`,
      groups: [GROUP],
      privates: [],
      token: '',
    });
    await mod.start(host);
    await mod.waitReady();

    // 撤回老消息:消息索引和名字都应从meta重建出来
    mock.emitRecall(mid, { user_id: 1001 });
    await waitUntil(() => host.pushed.length === 2, '撤回入库');
    expect(host.pushed[1].event.text).toContain(`阿明(1001) 撤回了一条消息(#${mid})`);
  });
});
