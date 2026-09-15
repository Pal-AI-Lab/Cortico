/**
 * 交接笔记渲染:speak 只进最近段,flow 不进笔记,状态读数与逐字重复只留最后一次,
 * 时间按分钟分段,单条折叠随年龄衰减,整份按预算从新往旧装,出线切成两段。
 */
import { describe, it, expect } from 'vitest';
import {
  HANDOFF_NOTE_TYPE,
  foldToBudget,
  handoffNoteStamp,
  renderHandoffNote,
} from "./fixture-handoff.ts";
import type { ChatMessage } from '../core/fixture-types.ts';
import type { EventTag, FrameEventRef } from '../../src/core/types.ts';
import { estimateTokens } from '../../src/core/util.ts';

const speech = new Set(['vtuber_act', 'bilibili_set_announcement']);
const now = new Date('2026-09-03T06:24:42.123Z');
const call = (id: string, name: string, args: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  ...extra,
});
const result = (id: string, content: string): ChatMessage => ({ role: 'tool', content, tool_call_id: id });

/** 一条帧消息:items 里每条事件各占一个 sidecar 位 */
function frameMsg(
  id: string,
  items: Array<{ text: string; type?: string; source?: string; ts?: string; tags?: readonly EventTag[] }>,
): ChatMessage[] {
  const header = `[${items.length} new event${items.length === 1 ? '' : 's'}]`;
  let start = header.length + 1;
  const events: FrameEventRef[] = items.map((it, i) => {
    const ref: FrameEventRef = {
      cursor: i + 1,
      ts: it.ts ?? '2026-09-03T14:24:00+08:00',
      type: it.type ?? 'bilibili.danmaku',
      source: it.source ?? 'bilibili',
      start,
      chars: it.text.length,
      ...(it.tags ? { tags: it.tags } : {}),
    };
    start += it.text.length + 1;
    return ref;
  });
  return [
    call(id, 'external_event_frame', '{}'),
    { role: 'tool', tool_call_id: id, content: [header, ...items.map((it) => it.text)].join('\n'), frame: { events } },
  ];
}

const oneNote = (snapshot: ChatMessage[], opts: Partial<Parameters<typeof renderHandoffNote>[1]> = {}) =>
  renderHandoffNote(snapshot, { speechTools: speech, now, ...opts });

describe('renderHandoffNote', () => {
  it('台词结果按事件标签保留最近段，原调用已离开上下文时仍可独立收录', () => {
    const snapshot = frameMsg('results', [
      { type: 'playback.outcome', text: '旧台词结果 call_id=old', tags: ['speak'], ts: '2026-09-03T14:00:00+08:00' },
      { type: 'playback.outcome', text: '新台词结果 call_id=new', tags: ['speak'], ts: '2026-09-03T14:24:00+08:00' },
      { type: 'playback.outcome', text: '另一条结果 call_id=other', tags: ['speak'], ts: '2026-09-03T14:25:00+08:00' },
    ]);
    const note = oneNote(snapshot, { splitAtMs: Date.parse('2026-09-03T14:20:00+08:00') });
    expect(note.text).not.toContain('call_id=old');
    expect(note.text).toContain('call_id=new');
    expect(note.text).toContain('call_id=other');
  });
  it('无分界时 speak 入参与实际回执进入最近段,与事件和其他调用保持原序', () => {
    const snapshot: ChatMessage[] = [
      { role: 'system', content: '前缀正文' },
      { role: 'user', content: '[system] session 已开始。' },
      ...frameMsg('evf_1', [{ text: '[弹幕|老王] 三只猫都还好' }]),
      call('a1', 'vtuber_act', '{"script":"老王你那三只猫还好吗"}'), result('a1', '已开演(流式)。'),
      call('m1', 'mc_do', '{"steps":[{"skill":"goto"}]}'), result('m1', '[06:24:49] 任务#19 收下了'),
      call('b1', 'bilibili_set_announcement', '{"text":"今晚八点"}'), result('b1', '公告已更新'),
      ...frameMsg('evf_2', [{ text: '[弹幕|四方无我] 搭高' }]),
    ];
    const note = oneNote(snapshot);
    expect(note.text).toContain('# 交接笔记 · 最近的一段');
    expect(note.text).not.toContain('前缀正文');
    expect(note.text).toContain('[调用] vtuber_act {"script":"老王你那三只猫还好吗"}\n[回执] 已开演(流式)。');
    expect(note.text).toContain('[调用] bilibili_set_announcement {"text":"今晚八点"}\n[回执] 公告已更新');
    expect(note.text).not.toContain('external_event_frame');
    const order = ['session 已开始', '三只猫都还好', '[调用] vtuber_act', '[调用] mc_do {"steps":[{"skill":"goto"}]}', '[回执] [06:24:49] 任务#19 收下了', '[调用] bilibili_set_announcement', '搭高']
      .map((s) => note.text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(note.entries).toBe(6);
    expect(note.dropped).toBe(0);
  });

  it('assistant 正文与思维链不进笔记,同一消息中 speak 与其他调用分别配对', () => {
    const snapshot: ChatMessage[] = [
      {
        role: 'assistant',
        content: '(心里话)',
        reasoning_content: '我该说点什么',
        tool_calls: [
          { id: 'a1', type: 'function', function: { name: 'vtuber_act', arguments: '{"script":"一"}' } },
          { id: 'm1', type: 'function', function: { name: 'mc_bag', arguments: '{}' } },
        ],
      },
      result('a1', '已开演'),
      result('m1', '[背包] 空'),
    ];
    const note = oneNote(snapshot);
    expect(note.text).not.toContain('心里话');
    expect(note.text).not.toContain('我该说点什么');
    expect(note.text).toContain('[调用] vtuber_act {"script":"一"}\n[回执] 已开演');
    expect(note.text).toContain('[调用] mc_bag\n[回执] [背包] 空');
  });

  it('还没回来的回执写明;合成开头与自消解项跳过', () => {
    const snapshot: ChatMessage[] = [
      { role: 'user', content: '合成首轮', head: true } as ChatMessage,
      { role: 'user', content: '自消解', ephemeral: true },
      call('m1', 'mc_queue', '{}'),
    ];
    const note = oneNote(snapshot);
    expect(note.text).not.toContain('合成首轮');
    expect(note.text).not.toContain('自消解');
    expect(note.text).toContain('[调用] mc_queue\n[回执] (还没回来)');
  });

  it('时间按分钟分段,不逐条盖戳', () => {
    const snapshot: ChatMessage[] = [
      ...frameMsg('evf_1', [
        { text: '[弹幕|甲] 一', ts: '2026-09-03T14:24:01+08:00' },
        { text: '[弹幕|乙] 二', ts: '2026-09-03T14:24:59+08:00' },
        { text: '[弹幕|丙] 三', ts: '2026-09-03T14:25:03+08:00' },
      ]),
    ];
    const note = oneNote(snapshot);
    expect(note.text).toContain('## 14:24');
    expect(note.text).toContain('## 14:25');
    expect(note.text.match(/## /g)).toHaveLength(2);
    expect(note.text).not.toMatch(/\[14:24:01\]/);
    expect(note.text.indexOf('## 14:24')).toBeLessThan(note.text.indexOf('[弹幕|甲]'));
    expect(note.text.indexOf('[弹幕|乙]')).toBeLessThan(note.text.indexOf('## 14:25'));
  });

  it('带 snapshot tag 的事件按 source/type 只留最后一条;工具按名只留最后一次', () => {
    const snapshot: ChatMessage[] = [
      ...frameMsg('evf_1', [
        { text: '[世界] 第一次快照', type: 'minecraft.world.snapshot', source: 'minecraft', tags: ['snapshot'] },
        { text: '[直播间] 3 人进场', type: 'bilibili.audience', source: 'bilibili', tags: ['snapshot'] },
        { text: '[弹幕|老王] 你好' },
      ]),
      call('q1', 'mc_queue', '{}'), result('q1', '[队列] 任务#1 第 1 步'),
      ...frameMsg('evf_2', [
        { text: '[世界] 第二次快照', type: 'minecraft.world.snapshot', source: 'minecraft', tags: ['snapshot'] },
        { text: '[直播间] 5 人进场', type: 'bilibili.audience', source: 'bilibili', tags: ['snapshot'] },
      ]),
      call('q2', 'mc_queue', '{}'), result('q2', '[队列] 任务#2 第 1 步'),
    ];
    const note = oneNote(snapshot, { snapshotTools: new Set(['mc_queue']) });
    expect(note.text).not.toContain('第一次快照');
    expect(note.text).not.toContain('3 人进场');
    expect(note.text).not.toContain('任务#1 第 1 步');
    expect(note.text).toContain('第二次快照');
    expect(note.text).toContain('5 人进场');
    expect(note.text).toContain('任务#2 第 1 步');
    expect(note.text).toContain('[弹幕|老王] 你好');
  });

  it('flow 类调用整类不进;上一份交接笔记不进(否则一份套一份)', () => {
    const snapshot: ChatMessage[] = [
      ...frameMsg('evf_1', [
        { text: '# 交接笔记 · 最近的一段\n上一窗的整份笔记', type: HANDOFF_NOTE_TYPE, source: 'persona' },
        { text: '[弹幕|甲] 一' },
      ]),
      call('e1', 'end_turn', '{}'), result('e1', '[turn ended]'),
    ];
    const note = oneNote(snapshot, { flowTools: new Set(['end_turn']) });
    expect(note.text).not.toContain('上一窗的整份笔记');
    expect(note.text).not.toContain('end_turn');
    expect(note.text).toContain('[弹幕|甲] 一');
    expect(note.entries).toBe(1);
  });

  it('逐字相同的条目只留最后一次,并注明重复了几次', () => {
    const snapshot: ChatMessage[] = [
      ...frameMsg('evf_1', [
        { text: '[MC] Server: Saved the game' },
        { text: '[弹幕|甲] 一' },
        { text: '[MC] Server: Saved the game' },
        { text: '[MC] Server: Saved the game' },
      ]),
    ];
    const note = oneNote(snapshot);
    expect(note.text.match(/Saved the game/g)).toHaveLength(1);
    expect(note.text).toContain('同样的一条重复了 3 次');
    expect(note.entries).toBe(2);
  });

  it('单条折叠随年龄衰减:最新的按 foldTokens,更早的越来越短', () => {
    const long = '话'.repeat(4000);
    const items = Array.from({ length: 12 }, (_, i) => ({ text: `第${i}条 ${long}` }));
    const note = oneNote(frameMsg('evf_1', items), { foldTokens: 1024, budgetTokens: 100000 });
    const size = (i: number) => {
      const at = note.text.indexOf(`第${i}条`);
      const end = note.text.indexOf('\n\n', at);
      return estimateTokens(note.text.slice(at, end < 0 ? undefined : end));
    };
    expect(size(11)).toBeGreaterThan(900);
    expect(size(11)).toBeLessThanOrEqual(1100);
    expect(size(6)).toBeLessThan(400);
    expect(size(0)).toBeLessThan(120);
  });

  it('整份预算从最近一条往前装,装不下的更早条目只留计数;最新一条再大也留', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ text: `[弹幕|观众${i}] ${'话'.repeat(100)}` }));
    const note = oneNote(frameMsg('evf_1', items), { budgetTokens: 700 });
    expect(note.dropped).toBeGreaterThan(0);
    expect(note.entries + note.dropped).toBe(20);
    expect(note.text).toContain(`更早的 ${note.dropped} 条没进这份笔记。`);
    expect(note.text).toContain('观众19');
    expect(note.text).not.toContain('观众0]');
    expect(estimateTokens(note.text)).toBeLessThanOrEqual(900);

    const single = oneNote(frameMsg('evf_2', items.slice(-1)), { budgetTokens: 10 });
    expect(single.entries).toBe(1);
    expect(single.text).toContain('观众19');
  });

  it('按软阈值切两段:之前的是更早的历史,之后的是当前语境,各带时间范围', () => {
    const snapshot: ChatMessage[] = [
      ...frameMsg('evf_1', [
        { text: '[弹幕|甲] 很早以前', ts: '2026-09-03T14:10:00+08:00' },
        { text: '[弹幕|乙] 还是以前', ts: '2026-09-03T14:12:00+08:00' },
      ]),
      ...frameMsg('evf_2', [
        { text: '[弹幕|丙] 刚刚', ts: '2026-09-03T14:20:00+08:00' },
        { text: '[弹幕|丁] 就在刚才', ts: '2026-09-03T14:22:00+08:00' },
      ]),
    ];
    const note = renderHandoffNote(snapshot, {
      speechTools: speech,
      now: new Date('2026-09-03T14:23:00+08:00'),
      splitAtMs: Date.parse('2026-09-03T14:15:00+08:00'),
    });
    expect(note.parts).toHaveLength(2);
    const [history, current] = note.parts;
    expect(history.text).toContain('# 交接笔记 · 更早的一段(14:10–14:12)');
    expect(history.text).toContain('已经过去了');
    expect(history.text).toContain('很早以前');
    expect(history.text).not.toContain('就在刚才');
    expect(current.text).toContain('# 交接笔记 · 最近的一段(14:20–14:22)');
    expect(current.text).toContain('最后一条是 14:22 的事');
    expect(current.text).toContain('就在刚才');
    expect(current.text).not.toContain('很早以前');
    // 存档全文按顺序含两段
    expect(note.text.indexOf('更早的一段')).toBeLessThan(note.text.indexOf('最近的一段'));
    expect(note.entries).toBe(4);
  });

  it('只有早段或只有最近段时只投递该段,无分界则算最近段', () => {
    const snapshot = frameMsg('evf_1', [{ text: '[弹幕|甲] 一', ts: '2026-09-03T14:10:00+08:00' }]);
    expect(oneNote(snapshot).parts).toHaveLength(1);
    expect(oneNote(snapshot, { splitAtMs: Date.parse('2026-09-03T14:30:00+08:00') }).parts).toHaveLength(1);
    expect(oneNote(snapshot, { splitAtMs: Date.parse('2026-09-03T14:00:00+08:00') }).parts).toHaveLength(1);
    expect(oneNote(snapshot).parts[0].text).toContain('# 交接笔记 · 最近的一段');
    expect(oneNote(snapshot, { splitAtMs: Date.parse('2026-09-03T14:30:00+08:00') }).parts[0].text)
      .toContain('# 交接笔记 · 更早的一段');
  });

  it('按调用时间筛除早段 speak,分界时刻的调用与迟到的早期事件各归其段', () => {
    const splitAtMs = Date.parse('2026-09-03T14:20:00+08:00');
    const snapshot: ChatMessage[] = [
      ...frameMsg('f1', [{ text: '早段事件', ts: '2026-09-03T14:10:00+08:00' }]),
      call('old', 'vtuber_act', '{"script":"旧台词"}', { ts: '2026-09-03T14:19:59+08:00' }),
      { ...result('old', '旧调用迟到的实际回执'), ts: '2026-09-03T14:21:00+08:00' },
      call('new', 'vtuber_act', '{"script":"当下的下一步"}', { ts: '2026-09-03T06:20:00Z' }),
      result('new', '已受理,尚未播放'),
      ...frameMsg('f2', [{ text: '迟到的早期事件', ts: '2026-09-03T14:11:00+08:00' }]),
    ];
    const note = oneNote(snapshot, { splitAtMs });
    expect(note.parts).toHaveLength(2);
    const [history, current] = note.parts;
    expect(history.text).toContain('早段事件');
    expect(history.text).toContain('迟到的早期事件');
    expect(history.text).not.toContain('[调用] vtuber_act');
    expect(note.text).not.toContain('{"script":"旧台词"}');
    expect(note.text).not.toContain('旧调用迟到的实际回执');
    expect(current.text).toContain('[调用] vtuber_act {"script":"当下的下一步"}\n[回执] 已受理,尚未播放');
    expect(current.text).not.toContain('早期事件');
    expect(current.entries).toBe(1);
  });

  it.each([undefined, null])('split=%s 时无时间的 speak 原文进入唯一最近段', (splitAtMs) => {
    const note = oneNote([
      call('s', 'vtuber_act', '{"script":"接着把这一段讲完"}'), result('s', '尚未播放'),
    ], { splitAtMs });
    expect(note.parts).toHaveLength(1);
    expect(note.text).toContain('[调用] vtuber_act {"script":"接着把这一段讲完"}\n[回执] 尚未播放');
  });

  it('有分界时无时间或时间无效的 speak 不冒充最近段,也不把空最近段改成早段台词', () => {
    const snapshot: ChatMessage[] = [
      { role: 'user', content: '无时间的事件' },
      call('missing', 'vtuber_act', '{"script":"无时间台词"}'), result('missing', '无时间回执'),
      call('bad', 'vtuber_act', '{"script":"坏时间台词"}', { ts: 'invalid' }), result('bad', '坏时间回执'),
      call('old', 'vtuber_act', '{"script":"早段台词"}', { ts: '2026-09-03T14:00:00+08:00' }),
      result('old', '早段回执'),
    ];
    const note = oneNote(snapshot, { splitAtMs: Date.parse('2026-09-03T14:20:00+08:00') });
    expect(note.parts).toHaveLength(1);
    expect(note.text).toContain('# 交接笔记 · 更早的一段');
    expect(note.text).toContain('无时间的事件');
    expect(note.text).not.toContain('[调用]');
    expect(note.entries).toBe(1);
    const empty = oneNote(snapshot.slice(1), { splitAtMs: Date.parse('2026-09-03T14:20:00+08:00') });
    expect(empty.entries).toBe(0);
    expect(empty.parts).toHaveLength(1);
    expect(empty.text).toContain('# 交接笔记 · 最近的一段');
    expect(empty.text).not.toContain('[回执]');
  });

  it('speak 修订、空台词、坏入参与缺失回执按原记录保留,不按工具名覆盖或改写快照', () => {
    const snapshot: ChatMessage[] = [
      call('a', 'vtuber_act', '{"script":"先往左走","revision":1}'), result('a', '已受理,尚未播放'),
      call('b', 'vtuber_act', '{"script":"改成往右走","revision":2}'), result('b', '修订已受理,上一版已取消'),
      call('c', 'vtuber_act', '{"script":"改成往右走","revision":2}'), result('c', '[未播出] 合成失败'),
      call('silent', 'vtuber_act', '{"script":""}'), result('silent', '本轮沉默'),
      call('bad', 'vtuber_act', '{"script":"没写完'), result('bad', '[拒绝] 无效入参'),
      call('pending', 'vtuber_act', '{"script":"还在等待"}'),
    ];
    const before = structuredClone(snapshot);
    const note = oneNote(snapshot, { snapshotTools: speech, budgetTokens: 10000 });
    expect(note.entries).toBe(6);
    for (let i = 0; i < snapshot.length; i += 2) {
      const args = snapshot[i].tool_calls![0].function.arguments;
      const receipt = snapshot[i + 1]?.content ?? '(还没回来)';
      expect(note.text).toContain(`[调用] vtuber_act ${args}\n[回执] ${receipt}`);
    }
    expect(snapshot).toEqual(before);
  });

  it('只有入参与回执都相同的 speak 才合并,合并项保留最后位置与重复次数', () => {
    const note = oneNote([
      call('a', 'vtuber_act', '{"script":"等一下"}'), result('a', '[未播出] 合成失败'),
      { role: 'user', content: '重试间隔的事件' },
      call('b', 'vtuber_act', '{"script":"等一下"}'), result('b', '[未播出] 合成失败'),
      call('c', 'vtuber_act', '{"script":"等一下"}'), result('c', '已开演'),
    ]);
    expect(note.entries).toBe(3);
    expect(note.text.match(/\[调用\] vtuber_act/g)).toHaveLength(2);
    expect(note.text).toContain('同样的一条重复了 2 次');
    expect(note.text.indexOf('重试间隔的事件')).toBeLessThan(note.text.indexOf('[调用]'));
    expect(note.text).toContain('[回执] [未播出] 合成失败');
    expect(note.text).toContain('[回执] 已开演');
  });

  it('最近段 speak 不随其他条目数量缩短,早段 speak 不占预算', () => {
    const ts = '2026-09-03T14:20:00+08:00';
    const script = '把眼下这件事完整讲完。'.repeat(35);
    const current = [
      call('new', 'vtuber_act', JSON.stringify({ script }), { ts }), result('new', '已受理,尚未播放'),
      ...frameMsg('events', Array.from({ length: 8 }, (_, i) => ({ text: `后续事件${i}`, ts }))),
    ];
    const options = { splitAtMs: Date.parse(ts), foldTokens: 1024, budgetTokens: 2000 };
    const note = oneNote(current, options);
    expect(note.text).toContain(JSON.stringify({ script }));
    const old = Array.from({ length: 10 }, (_, i) => [
      call(`old${i}`, 'vtuber_act', JSON.stringify({ script: `早段${i}${script}` }), { ts: '2026-09-03T14:00:00+08:00' }),
      result(`old${i}`, '早段回执'),
    ]).flat();
    expect(oneNote([...old, ...current], options)).toEqual(note);
    expect(note.parts).toHaveLength(1);
  });

  it.each([1, 2, 3])('只有 %i 条记录时最新一条仍使用完整单条预算', (count) => {
    const text = '最近事件'.repeat(100);
    const note = oneNote(frameMsg('f', Array.from({ length: count }, (_, i) => ({ text: `${i}:${text}` }))), {
      foldTokens: 1024, budgetTokens: 10000,
    });
    expect(note.text).toContain(`${count - 1}:${text}`);
  });

  it('预算只容最近一次 speak 时调用与实际回执一起保留,长入参标明折叠', () => {
    const snapshot = Array.from({ length: 12 }, (_, i) => [
      call(`s${i}`, 'vtuber_act', JSON.stringify({ script: `第${i}次:${'长台词'.repeat(2000)}` })),
      result(`s${i}`, `第${i}次尚未播放`),
    ]).flat();
    const note = oneNote(snapshot, { budgetTokens: 700, foldTokens: 128 });
    expect(note.dropped).toBeGreaterThan(0);
    expect(note.entries + note.dropped).toBe(12);
    expect(note.text).toContain('第11次:');
    expect(note.text).toContain('[回执] 第11次尚未播放');
    expect(note.text).toContain('token 已折叠');
    expect(estimateTokens(note.text)).toBeLessThanOrEqual(900);
    const tiny = oneNote(snapshot, { budgetTokens: 0, foldTokens: 128 });
    expect(tiny.entries).toBe(1);
    expect(tiny.dropped).toBe(11);
    expect(tiny.text).toContain('[回执] 第11次尚未播放');
    expect(tiny.text).not.toContain('第10次:');
  });

  it('预算裁掉整个早段后只投递最近段,分界前的 speak 不复活', () => {
    const ts = '2026-09-03T14:20:00+08:00';
    const note = oneNote([
      { role: 'user', content: '早段经历', ts: '2026-09-03T14:00:00+08:00' },
      call('old', 'vtuber_act', '{"script":"早段口播原文"}', { ts: '2026-09-03T14:10:00+08:00' }),
      result('old', '早段开演回执'),
      call('new', 'vtuber_act', '{"script":"接着当前动作"}', { ts }), result('new', '等待播放'),
    ], { splitAtMs: Date.parse(ts), budgetTokens: 10 });
    expect(note.parts).toHaveLength(1);
    expect(note.text).toContain('# 交接笔记 · 最近的一段');
    expect(note.text).toContain('[调用] vtuber_act {"script":"接着当前动作"}\n[回执] 等待播放');
    expect(note.text).not.toContain('早段口播原文');
    expect(note.entries).toBe(1);
    expect(note.dropped).toBe(1);
  });

  it.each(['tool', 'user'] as const)('连续交接跳过 %s 帧中的上一份两段笔记,不再次携带旧 speak', (role) => {
    const ts = '2026-09-03T14:20:00+08:00';
    let note = oneNote([
      { role: 'user', content: '最早事件', ts: '2026-09-03T14:00:00+08:00' },
      call('a', 'vtuber_act', '{"script":"第一窗旧台词"}', { ts }), result('a', '第一窗未播出'),
    ], { splitAtMs: Date.parse(ts) });
    expect(note.parts).toHaveLength(2);
    for (let round = 2; round <= 4; round++) {
      const frame = frameMsg(`f${round}`, [
        ...note.parts.map((part) => ({ text: part.text, type: HANDOFF_NOTE_TYPE, source: 'persona' })),
        { text: `第${round}窗当前事件` },
      ]);
      const offset = frame[1].frame!.events[0].start;
      const delivery: ChatMessage[] = role === 'tool' ? frame : [{
        role: 'user', content: frame[1].content.slice(offset),
        frame: { events: frame[1].frame!.events.map((ref) => ({ ...ref, start: ref.start - offset })) },
      }];
      const script = `第${round}窗的新台词,自然接着眼下的事情说完。`.repeat(20);
      note = oneNote([
        ...delivery,
        call(`s${round}`, 'vtuber_act', JSON.stringify({ script })), result(`s${round}`, `第${round}窗已受理`),
      ]);
      expect(note.entries).toBe(2);
      expect(note.text).toContain(JSON.stringify({ script }));
      expect(note.text).toContain(`第${round}窗当前事件`);
      expect(note.text).not.toContain('最早事件');
      expect(note.text).not.toContain('第一窗');
      if (round > 2) expect(note.text).not.toContain(`第${round - 1}窗`);
      expect(note.text.match(/# 交接笔记 ·/g)).toHaveLength(1);
      const fresh = [
        ...frameMsg('fresh', [{ text: `第${round}窗当前事件` }]),
        call(`s${round}`, 'vtuber_act', JSON.stringify({ script })), result(`s${round}`, `第${round}窗已受理`),
      ];
      expect(note).toEqual(oneNote(fresh));
    }
    const onlyPrevious = frameMsg('last', note.parts.map((part) => ({
      text: part.text, type: HANDOFF_NOTE_TYPE, source: 'persona',
    })));
    expect(oneNote(onlyPrevious)).toEqual(oneNote([]));
  });

  it('没有 ts、没有 sidecar 的旧记录照常进:不分段、整帧算一条、去掉表头', () => {
    const id = 'evf_9';
    const snapshot: ChatMessage[] = [
      call(id, 'external_event_frame', '{}'),
      { role: 'tool', tool_call_id: id, content: '[2 new events]\n[弹幕|甲] 一\n[弹幕|乙] 二' },
      call('m1', 'mc_bag', '{}'), result('m1', '[背包] 空'),
    ];
    const note = oneNote(snapshot, { snapshotTools: new Set(['mc_bag']) });
    expect(note.text).toContain('[弹幕|甲] 一\n[弹幕|乙] 二');
    expect(note.text).not.toContain('new events');
    expect(note.text).not.toMatch(/^## /m);
    expect(note.entries).toBe(2);
  });

  it('短内容在预算内不折叠', () => {
    expect(foldToBudget('短', 1024)).toBe('短');
  });

  it('文件名时间戳是 UTC,不含冒号', () => {
    expect(handoffNoteStamp(now)).toBe('2026-09-03T06-24-42Z');
  });
});
