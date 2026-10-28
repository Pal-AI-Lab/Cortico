import { describe, expect, it } from 'vitest';
import type { EventEnvelope, EventRangeQuery, EventStoreReader } from '../../../src/core/types.ts';
import { LiveBoard, renderPollResult } from '../../../src/worlds/bilibili/live-status.ts';
import type { LiveStatusState, OverlayToast } from '../../../src/worlds/bilibili/overlay/types.ts';

class MemStore implements EventStoreReader {
  events: EventEnvelope[] = [];
  add(source: string, meta: Record<string, unknown> | undefined, text = ''): void {
    this.events.push({
      cursor: this.events.length + 1, ts: '2026-10-28T10:00:00+08:00', source, type: `${source}.x`, text,
      origin: 'external', contextDelivery: 'deliver', ...(meta ? { meta } : {}),
    } as EventEnvelope);
  }
  get(cursor: number) { return this.events[cursor - 1]; }
  latestCursor() { return this.events.length; }
  range(q: EventRangeQuery) {
    return this.events.filter((e) => (q.source === undefined || e.source === q.source)
      && (q.fromCursor === undefined || e.cursor >= q.fromCursor)
      && (q.toCursor === undefined || e.cursor <= q.toCursor));
  }
  around() { return []; }
  grep() { return []; }
}

function board() {
  const changes: LiveStatusState[] = [];
  const toasts: OverlayToast[] = [];
  const b = new LiveBoard({ changed: (s) => changes.push(s), toast: (t) => toasts.push(t) });
  return { b, changes, toasts };
}

describe('LiveBoard 战况', () => {
  it('启动时回看事件库捡回最近的死亡与目标,之后只认新到的事件', () => {
    const store = new MemStore();
    store.add('minecraft', { event: 'death', today: 3, total: 20, cause: '摔死' });
    store.add('minecraft', { event: 'goals', goals: [{ slot: 1, text: '进下界', progress: null, milestones: { done: 1, total: 4 }, next: '攒黑曜石' }] });
    store.add('bilibili', { event: 'death', today: 99, total: 99 }); // 别的来源不认
    const { b, toasts } = board();
    b.attach(store);
    expect(b.current.deaths).toEqual({ today: 3, total: 20, lastCause: '摔死' });
    expect(b.current.goals[0]).toMatchObject({ slot: 1, text: '进下界', next: '攒黑曜石' });
    expect(toasts).toHaveLength(0); // 回看的旧死亡不弹窗

    store.add('minecraft', undefined, '[Minecraft] 你死了'); // 没有 meta 的正文不解析
    store.add('minecraft', { event: 'death', today: 4, total: 21, cause: '掉进岩浆' });
    b.poll(store);
    expect(b.current.deaths?.today).toBe(4);
    expect(toasts).toEqual([{ kind: 'death', title: '羽书阵亡 · 今日第 4 次', body: '死因:掉进岩浆' }]);
    b.poll(store); // 没新事件不重复弹
    expect(toasts).toHaveLength(1);
  });
});

describe('LiveBoard 投票', () => {
  it('一人一票、改票以最后一次为准,只认整条弹幕是选项号', () => {
    const { b } = board();
    const t0 = 1_000_000;
    b.openPoll({ question: '下一步先干什么', options: ['去挖铁', '继续舀岩浆'], durationSec: 60 }, t0);
    expect(b.vote('1', '1', t0 + 1)).toBe(true);
    expect(b.vote('2', '２', t0 + 2)).toBe(true); // 全角
    expect(b.vote('3', '选2', t0 + 3)).toBe(true);
    expect(b.vote('1', '2', t0 + 4)).toBe(true); // 1 号改票
    expect(b.vote('4', '我觉得 1 比较好', t0 + 5)).toBe(false); // 聊天里的数字不算
    expect(b.vote('5', '3', t0 + 6)).toBe(false); // 没有 3 号选项
    expect(b.current.poll?.options.map((o) => o.votes)).toEqual([0, 3]);
    expect(b.current.poll?.voters).toBe(3);
  });

  it('到点结束、平票与无人投票都如实报', () => {
    const { b, toasts } = board();
    const t0 = 1_000_000;
    b.openPoll({ question: 'Q', options: ['A', 'B'], durationSec: 15 }, t0);
    b.vote('1', '1', t0);
    b.vote('2', '2', t0);
    expect(b.pollDue(t0 + 14_999)).toBe(false);
    expect(b.pollDue(t0 + 15_000)).toBe(true);
    expect(b.vote('3', '1', t0 + 15_000)).toBe(false); // 截止后不再计票
    const tie = b.closePoll(t0 + 15_000)!;
    expect(tie.winners).toEqual(['A', 'B']);
    expect(renderPollResult(tie)).toBe('[投票结束] Q:1.A 1 票、2.B 1 票(2 人投票),平票:A / B,你来定');
    expect(toasts.at(-1)).toMatchObject({ kind: 'poll', body: '「Q」:A / B 胜出' });
    expect(b.closePoll(t0 + 16_000)).toBeNull(); // 已结束不重复结束

    // 结果展示期过后撤下
    b.expirePoll(15_000, t0 + 29_999);
    expect(b.current.poll).not.toBeNull();
    b.expirePoll(15_000, t0 + 30_000);
    expect(b.current.poll).toBeNull();

    b.openPoll({ question: 'Q2', options: ['A', 'B'], durationSec: 15 }, t0);
    expect(renderPollResult(b.closePoll(t0 + 1)!)).toContain('没人投票,按你自己的判断来');
  });

  it('参数校验:同时只有一个投票,选项 2~6 个,时长 15~600 秒', () => {
    const { b } = board();
    expect(() => b.openPoll({ question: 'Q', options: ['A'], durationSec: 60 })).toThrow('2 到 6');
    expect(() => b.openPoll({ question: 'Q', options: ['A', 'B'], durationSec: 5 })).toThrow('15 到 600');
    expect(() => b.openPoll({ question: ' ', options: ['A', 'B'], durationSec: 60 })).toThrow('question');
    b.openPoll({ question: 'Q', options: ['A', 'B'], durationSec: 60 });
    expect(() => b.openPoll({ question: 'Q', options: ['A', 'B'], durationSec: 60 })).toThrow('还没结束');
  });
});
