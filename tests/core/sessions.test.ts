import { records } from './fixture-protocol.ts';
/**
 * SessionTracker测试:注册/usage累计/命中率/消息引用/保留策略/变化通知。
 */
import { describe, expect, it } from 'vitest';
import type { LLMUsage } from '../../src/core/types.ts';
import { SessionTracker } from '../../src/core/sessions.ts';

const usage = (p: number, c: number, hit = 0, miss = 0, r = 0): LLMUsage => ({
  promptTokens: p,
  completionTokens: c,
  cacheHitTokens: hit,
  cacheMissTokens: miss,
  reasoningTokens: r,
});

describe('SessionTracker', () => {
  it('open→record累计usage,命中率=hit/(hit+miss)', () => {
    const t = new SessionTracker('Asia/Shanghai');
    const h = t.open('main', '主意识', { id: 'main' });
    h.record(usage(1000, 50, 900, 100, 10));
    h.record(usage(1100, 60, 1080, 20, 5));

    const [s] = t.list();
    expect(s.id).toBe('main');
    expect(s.label).toBe('主意识');
    expect(s.calls).toBe(2);
    expect(s.promptTokens).toBe(2100);
    expect(s.completionTokens).toBe(110);
    expect(s.cacheHitTokens).toBe(1980);
    expect(s.cacheMissTokens).toBe(120);
    expect(s.reasoningTokens).toBe(15);
    expect(s.cacheHitRate).toBeCloseTo(1980 / 2100, 5);
    expect(s.endedAt).toBeNull();
  });

  it('无缓存数据→命中率 null', () => {
    const t = new SessionTracker('Asia/Shanghai');
    const h = t.open('association', '联想fork');
    h.record(usage(10, 5)); // FakeLLM风格:全0缓存字段
    expect(t.list()[0].cacheHitRate).toBeNull();
  });

  it('消息引用实时读:messageCount与messages()跟随数组增长', () => {
    const t = new SessionTracker('Asia/Shanghai');
    const msgs = records([{ role: 'system', content: 'sys' }]);
    const h = t.open('association', '联想fork');
    h.record(usage(1, 1), msgs);
    expect(t.list()[0].messageCount).toBe(1);

    msgs.push(...records([{ role: 'assistant', content: '想到了' }]));
    expect(t.list()[0].messageCount).toBe(2);
    expect(t.messages(t.list()[0].id)).toHaveLength(2);
  });

  it('close幂等;进行中排在已结束前面', async () => {
    const t = new SessionTracker('Asia/Shanghai');
    const a = t.open('association', '联想fork');
    a.close();
    a.close();
    t.open('main', '主意识', { id: 'main' });

    const list = t.list();
    expect(list[0].id).toBe('main');
    expect(list[0].endedAt).toBeNull();
    expect(list[1].endedAt).not.toBeNull();
  });

  it('已结束session只保留最近8个(main永不清)', () => {
    const t = new SessionTracker('Asia/Shanghai');
    t.open('main', '主意识', { id: 'main' });
    for (let i = 0; i < 12; i++) {
      t.open('association', `联想${i}`).close();
    }
    const list = t.list();
    const closed = list.filter((s) => s.endedAt !== null);
    expect(closed).toHaveLength(8);
    expect(list.some((s) => s.id === 'main')).toBe(true);
  });

  it('reset:进行中的条目统计归零(句柄仍有效),已结束的移除', () => {
    const t = new SessionTracker('Asia/Shanghai');
    const main = t.open('main', '主意识', { id: 'main' });
    main.record(usage(1000, 50, 900, 100));
    t.open('association', '联想fork').close();

    t.reset();
    const list = t.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('main');
    expect(list[0].calls).toBe(0);
    expect(list[0].promptTokens).toBe(0);
    expect(list[0].cacheHitRate).toBeNull();

    // 句柄继续有效:reset后record照常累计
    main.record(usage(10, 5));
    expect(t.list()[0].promptTokens).toBe(10);
  });

  it('onChange在open/record/close时都触发;未知id的messages()→null', () => {
    const t = new SessionTracker('Asia/Shanghai');
    let n = 0;
    t.onChange(() => n++);
    const h = t.open('dream', '梦');
    h.record(usage(1, 1));
    h.close();
    expect(n).toBe(3);
    expect(t.messages('不存在')).toBeNull();
    expect(t.messages(t.list()[0].id)).toBeNull();
  });

  it('close后的迟到record被忽略', () => {
    let persisted = 0;
    const t = new SessionTracker('Asia/Shanghai', () => {
      persisted++;
    });
    const h = t.open('dream', '梦');

    h.record(usage(10, 5));
    expect(t.list()[0].calls).toBe(1);
    expect(persisted).toBe(1);

    h.close();
    h.record(usage(100, 50));
    expect(t.list()[0].calls).toBe(1);
    expect(t.list()[0].promptTokens).toBe(10);
    expect(persisted).toBe(1);
  });
});
