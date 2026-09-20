/**
 * normalize.ts 纯函数单测:各segment类型渲染、@自己判定、reply映射、
 * 图片能力协商降级、出站编译。
 */
import { describe, expect, it } from 'vitest';
import {
  buildOutgoing,
  makeImagePolicy,
  parseJsonCard,
  renderIncoming,
  renderSegmentsPlain,
  type OneBotGroupMessage,
  type RenderContext,
} from '../../../src/worlds/qq/normalize.ts';

const TZ = 'Asia/Shanghai';
// 2026-01-01T13:32:00Z = 北京时间 21:32
const TIME = Math.floor(Date.UTC(2026, 0, 1, 13, 32, 0) / 1000);

function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    selfId: 5000,
    selfName: 'bot',
    timezone: TZ,
    convLabel: '群「测试群」',
    knowsMessage: () => false,
    ...overrides,
  };
}

function msg(
  message: OneBotGroupMessage['message'],
  overrides: Partial<OneBotGroupMessage> = {},
): OneBotGroupMessage {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: 10001,
    user_id: 1001,
    message_id: 900,
    time: TIME,
    sender: { nickname: '阿明' },
    message,
    ...overrides,
  };
}

describe('renderIncoming', () => {
  it('纯文本:[HH:MM] 显示名(QQ号): 正文', () => {
    const r = renderIncoming(
      msg([{ type: 'text', data: { text: 'bot在吗' } }]),
      ctx(),
    );
    expect(r.text).toBe('#900 [群「测试群」 21:32] 阿明(1001): bot在吗');
    expect(r.mentionedSelf).toBe(false);
  });

  it('显示名优先用card(群昵称);QQ号仍随行', () => {
    const r = renderIncoming(
      msg([{ type: 'text', data: { text: '早' } }], {
        sender: { nickname: '阿明', card: '明哥' },
      }),
      ctx(),
    );
    expect(r.text).toBe('#900 [群「测试群」 21:32] 明哥(1001): 早');
  });

  it('sender缺失时显示名退回QQ号(与随行QQ号重复,不去重)', () => {
    const r = renderIncoming(
      msg([{ type: 'text', data: { text: 'hi' } }], { sender: undefined }),
      ctx(),
    );
    expect(r.text).toBe('#900 [群「测试群」 21:32] 1001(1001): hi');
  });

  it('@自己 → @bot(你) 且 mentionedSelf=true', () => {
    const r = renderIncoming(
      msg([
        { type: 'at', data: { qq: '5000' } },
        { type: 'text', data: { text: '在吗' } },
      ]),
      ctx(),
    );
    expect(r.text).toBe('#900 [群「测试群」 21:32] 阿明(1001): @bot(你) 在吗');
    expect(r.mentionedSelf).toBe(true);
  });

  it('@别人:已知称呼用称呼,未知用QQ号', () => {
    const known = renderIncoming(
      msg([{ type: 'at', data: { qq: '2002' } }]),
      ctx({ nameOf: (qq) => (qq === '2002' ? '阿强' : undefined) }),
    );
    expect(known.text).toBe('#900 [群「测试群」 21:32] 阿明(1001): @阿强');
    expect(known.mentionedSelf).toBe(false);

    const unknown = renderIncoming(
      msg([{ type: 'at', data: { qq: '3003' } }]),
      ctx(),
    );
    expect(unknown.text).toBe('#900 [群「测试群」 21:32] 阿明(1001): @3003');
  });

  it('@全体成员不算@自己', () => {
    const r = renderIncoming(
      msg([
        { type: 'at', data: { qq: 'all' } },
        { type: 'text', data: { text: ' 开会了' } },
      ]),
      ctx(),
    );
    expect(r.text).toBe('#900 [群「测试群」 21:32] 阿明(1001): @全体成员 开会了');
    expect(r.mentionedSelf).toBe(false);
  });

  it('reply段:已记录的消息 → [回复#<message_id>]', () => {
    const r = renderIncoming(
      msg([
        { type: 'reply', data: { id: '888' } },
        { type: 'text', data: { text: '好啊' } },
      ]),
      ctx({ knowsMessage: (id) => String(id) === '888' }),
    );
    expect(r.text).toBe('#900 [群「测试群」 21:32] 阿明(1001): [回复#888] 好啊');
  });

  it('reply段:映射未命中(未捕获) → 提示正在查询原文', () => {
    const r = renderIncoming(
      msg([
        { type: 'reply', data: { id: '777' } },
        { type: 'text', data: { text: '哈哈' } },
      ]),
      ctx(),
    );
    expect(r.text).toBe(
      '#900 [群「测试群」 21:32] 阿明(1001): [回复某条未被记录的消息,原文正在查询中...] 哈哈',
    );
  });

  it('forward段 → 占位提示正在展开', () => {
    const r = renderIncoming(
      msg([{ type: 'forward', data: { id: 'res-1' } }]),
      ctx(),
    );
    expect(r.text).toBe('#900 [群「测试群」 21:32] 阿明(1001): [转发的聊天记录,正在展开中...]');
  });

  it('image段默认降级 [图片]', () => {
    const r = renderIncoming(
      msg([{ type: 'image', data: { url: 'https://x/1.png' } }]),
      ctx(),
    );
    expect(r.text).toBe('#900 [群「测试群」 21:32] 阿明(1001): [图片]');
  });

  it('json段:无renderJsonCard时使用prompt,解析失败或无prompt则为[json]', () => {
    const withPrompt = renderIncoming(
      msg([
        {
          type: 'json',
          data: { data: JSON.stringify({ prompt: '[分享]《怪物猎人荒野》宣传片' }) },
        },
      ]),
      ctx(),
    );
    expect(withPrompt.text).toBe(
      '#900 [群「测试群」 21:32] 阿明(1001): [分享:[分享]《怪物猎人荒野》宣传片]',
    );

    const brokenJson = renderIncoming(
      msg([{ type: 'json', data: { data: '不是合法json' } }]),
      ctx(),
    );
    expect(brokenJson.text).toBe('#900 [群「测试群」 21:32] 阿明(1001): [json]');

    const noData = renderIncoming(msg([{ type: 'json', data: {} }]), ctx());
    expect(noData.text).toBe('#900 [群「测试群」 21:32] 阿明(1001): [json]');
  });

  it('json段:renderJsonCard接管时,ctx回调收到解析出的prompt/previewUrl', () => {
    const r = renderIncoming(
      msg([
        {
          type: 'json',
          data: {
            data: JSON.stringify({
              prompt: '[分享]标题',
              meta: { detail_1: { preview: '//i0.hdslb.com/cover.jpg' } },
            }),
          },
        },
      ]),
      ctx({
        renderJsonCard: (info) => `[卡片:${info.prompt}|${info.previewUrl}]`,
      }),
    );
    expect(r.text).toBe(
      '#900 [群「测试群」 21:32] 阿明(1001): [卡片:[分享]标题|https://i0.hdslb.com/cover.jpg]',
    );
  });

  it('face段:已知id → [表情:实际名字];未知id → [QQ表情];未知段 → [类型名]', () => {
    const r = renderIncoming(
      msg([
        { type: 'face', data: { id: '14' } },
        { type: 'face', data: { id: '348' } },
        { type: 'face', data: { id: '999999' } },
        { type: 'dice', data: {} },
      ]),
      ctx(),
    );
    expect(r.text).toBe('#900 [群「测试群」 21:32] 阿明(1001): [表情:微笑] [表情:福萝卜] [QQ表情] [dice]');
  });
});

describe('renderSegmentsPlain(取回原文/展开转发节点复用)', () => {
  it('纯文本原样拼接', () => {
    expect(renderSegmentsPlain([{ type: 'text', data: { text: '晚上八点见' } }])).toBe(
      '晚上八点见',
    );
  });

  it('at/face/image/reply/forward/node/未知类型都有占位,不抛错', () => {
    const out = renderSegmentsPlain([
      { type: 'at', data: { qq: '2002' } },
      { type: 'at', data: { qq: 'all' } },
      { type: 'face', data: { id: '14' } },
      { type: 'face', data: { id: '999999' } },
      { type: 'image', data: { url: 'https://x/1.png' } },
      { type: 'reply', data: { id: '1' } },
      { type: 'forward', data: { id: 'res-2' } },
      { type: 'node', data: {} },
      { type: 'xml', data: {} },
      { type: 'json', data: { data: JSON.stringify({ prompt: '[分享]链接' }) } },
    ]);
    expect(out).toBe(
      '@2002 @全体成员 [表情:微笑] [QQ表情] [图片] [回复某条消息] [转发消息] [嵌套转发消息] [xml] [分享:[分享]链接]',
    );
  });

  it('空数组 → 空字符串', () => {
    expect(renderSegmentsPlain([])).toBe('');
  });
});

describe('parseJsonCard(json段的通用字段解析)', () => {
  it('取顶层prompt + meta.<动态key>.preview,协议相对路径补https:', () => {
    const info = parseJsonCard({
      data: JSON.stringify({
        prompt: '[分享]《怪物猎人荒野》宣传片',
        meta: { news: { preview: '//i0.hdslb.com/cover.jpg', title: '标题' } },
      }),
    });
    expect(info).toEqual({
      prompt: '[分享]《怪物猎人荒野》宣传片',
      previewUrl: 'https://i0.hdslb.com/cover.jpg',
    });
  });

  it('preview已带协议头则原样保留', () => {
    const info = parseJsonCard({
      data: JSON.stringify({ prompt: 'p', meta: { x: { preview: 'http://a/b.jpg' } } }),
    });
    expect(info.previewUrl).toBe('http://a/b.jpg');
  });

  it('data不是字符串/不是合法json/无prompt字段 → 空对象,不抛错', () => {
    expect(parseJsonCard({})).toEqual({});
    expect(parseJsonCard({ data: 123 })).toEqual({});
    expect(parseJsonCard({ data: '{不合法' })).toEqual({});
    expect(parseJsonCard({ data: 'null' })).toEqual({});
    expect(parseJsonCard({ data: JSON.stringify({ desc: '没有prompt字段' }) })).toEqual({});
  });

  it('meta里没有preview字段 → previewUrl缺省', () => {
    const info = parseJsonCard({
      data: JSON.stringify({ prompt: 'p', meta: { x: { title: 't' } } }),
    });
    expect(info).toEqual({ prompt: 'p' });
  });
});

describe('makeImagePolicy(取图有没有意义)', () => {
  it('取不到图的意义 → 降级[图片]', () => {
    const policy = makeImagePolicy(false);
    expect(policy({ url: 'https://x/1.png' })).toBe('[图片]');
  });

  it('能用图 → 带URL标记(留好口子)', () => {
    const policy = makeImagePolicy(true);
    expect(policy({ url: 'https://x/1.png' })).toBe('[图片 https://x/1.png]');
    expect(policy({})).toBe('[图片]');
  });

  it('能用图 → file 字段同样带标记', () => {
    const policy = makeImagePolicy(true);
    expect(policy({ file: 'abc.png' })).toBe('[图片 abc.png]');
  });
});

describe('语音条', () => {
  it('入站 record 段渲染成 [语音];独立渲染也一样', () => {
    const r = renderIncoming(msg([{ type: 'record', data: { file: '1.silk' } }]), ctx());
    expect(r.text).toBe('#900 [群「测试群」 21:32] 阿明(1001): [语音]');
    expect(renderSegmentsPlain([{ type: 'record', data: { file: '1.silk' } }])).toBe('[语音]');
  });

  it('出站给了语音就只发 record 段,引用与正文都不随行', () => {
    expect(buildOutgoing({ text: '顺便说一句', reply_to_message_id: 888, record_base64: 'QUJD' })).toEqual([
      { type: 'record', data: { file: 'base64://QUJD' } },
    ]);
  });
});

describe('buildOutgoing', () => {
  it('纯文本 → 单text段', () => {
    expect(buildOutgoing({ text: '大家好' })).toEqual([
      { type: 'text', data: { text: '大家好' } },
    ]);
  });

  it('带引用 → reply段在前+text段', () => {
    expect(
      buildOutgoing({ text: '好啊', reply_to_message_id: 888 }),
    ).toEqual([
      { type: 'reply', data: { id: '888' } },
      { type: 'text', data: { text: '好啊' } },
    ]);
  });

  it('@某人按纯文本发送', () => {
    expect(buildOutgoing({ text: '@阿明 收到' })).toEqual([
      { type: 'text', data: { text: '@阿明 收到' } },
    ]);
  });
});
