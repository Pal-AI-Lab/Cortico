import { describe, it, expect } from 'vitest';
import {
  renderIncoming,
  renderSegmentsPlain,
  type RenderContext,
  type Segment,
} from '../../../src/worlds/qq/normalize.ts';
import type { OneBotGroupMessage } from '../../../src/worlds/qq/normalize.ts';

function seg(type: string, data: Record<string, unknown> = {}): Segment {
  return { type, data };
}

function msg(segments: Segment[]): OneBotGroupMessage {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    user_id: 100,
    message_id: 42,
    time: 1700000000,
    sender: { nickname: '小明' },
    message: segments,
  };
}

function ctx(over: Partial<RenderContext> = {}): RenderContext {
  return {
    selfId: 999,
    selfName: '我',
    timezone: 'Asia/Shanghai',
    convLabel: '群「测试」',
    knowsMessage: () => true,
    nameOf: () => undefined,
    ...over,
  };
}

describe('video 段 · renderSegmentsPlain', () => {
  it('默认输出 [视频]（不再落到 default 的 [video]）', () => {
    expect(renderSegmentsPlain([seg('video', { file: 'x.mp4' })])).toBe('[视频]');
  });
  it('和其他段拼接时空格正常', () => {
    expect(renderSegmentsPlain([seg('text', { text: '看这个' }), seg('video')])).toBe('看这个 [视频]');
  });
});

describe('video 段 · renderIncoming', () => {
  it('没有 renderVideo 时降级 [视频]', () => {
    const out = renderIncoming(msg([seg('video', { url: 'https://x/v.mp4' })]), ctx());
    expect(out.text).toContain('[视频]');
    expect(out.text).not.toContain('[video]');
  });

  it('给了 renderVideo 就用它的输出', () => {
    const out = renderIncoming(
      msg([seg('video', { url: 'https://x/v.mp4' })]),
      ctx({ renderVideo: () => '[视频 正在落盘中...]' }),
    );
    expect(out.text).toContain('[视频 正在落盘中...]');
  });

  it('落盘成功的绝对路径能进正文', () => {
    const out = renderIncoming(
      msg([seg('video', { file: 'C:/cache/clip.mp4' })]),
      ctx({ renderVideo: (d) => `[video] 已存本地：${String(d.file ?? '')}` }),
    );
    expect(out.text).toContain('[video] 已存本地：C:/cache/clip.mp4');
  });

  it('video 与 text / image 混排不乱', () => {
    const out = renderIncoming(
      msg([seg('text', { text: '开头' }), seg('video', { url: 'https://x/v.mp4' }), seg('text', { text: '结尾' })]),
      ctx({ renderVideo: () => '[视频]', renderImage: () => '[图片]' }),
    );
    expect(out.text).toContain('开头');
    expect(out.text).toContain('[视频]');
    expect(out.text).toContain('结尾');
  });

  it('video 段不影响 @ 自己的判定', () => {
    const out = renderIncoming(
      msg([seg('at', { qq: '999' }), seg('video', { url: 'https://x/v.mp4' })]),
      ctx({ renderVideo: () => '[视频]' }),
    );
    expect(out.mentionedSelf).toBe(true);
  });
});
