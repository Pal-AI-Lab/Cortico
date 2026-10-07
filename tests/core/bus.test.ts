import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WakeBus } from '../../src/core/bus.ts';
import type { WakeItem } from '../../src/core/types.ts';
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function evt(n: number): WakeItem {
  return {
    event: { cursor: n, type: 't', ts: '2026-07-17T10:00:00+08:00', source: 'qq', origin: 'external', text: `e${n}` },
  };
}

function internal(text = 'tick'): WakeItem {
  return { event: { cursor: 0, type: 'tick', ts: '2026-07-17T10:00:00+08:00', source: 'persona', origin: 'internal', text } };
}

/** 正文在投递时生成的延迟渲染项。 */
function deferred(type = 'bilibili.audience', render: () => string | null = () => '读数'): WakeItem {
  return { deferred: { type, source: 'bilibili', origin: 'external', render } };
}

const projectNone = () => [];

function candidate(n: number, text = `c${n}`): WakeItem {
  return {
    candidate: {
      source: 'bilibili',
      origin: 'external',
      sourceEvents: [{
        cursor: n,
        type: 'bilibili.danmaku',
        ts: '2026-07-17T10:00:00+08:00',
        source: 'bilibili',
        origin: 'external',
        contextDelivery: 'archive-only',
        text,
      }],
      gateText: text,
      value: { n },
      project: projectNone,
    },
  };
}

describe('WakeBus 投递时刻:四条判据', () => {
  it("minBatchAge 将间隔超过 quietGap 的事件合并投递", async () => {
    // 事件间隔超过 quietGap；minBatchAge 仍应阻止逐条投递。
    const bus = new WakeBus({ quietGapMs: 20, minBatchAgeMs: 150, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    const delivered = vi.fn();
    const p = bus.nextBatch();
    void p.then(delivered);
    bus.push(evt(1));
    await vi.advanceTimersByTimeAsync(30);
    bus.push(evt(2));
    await vi.advanceTimersByTimeAsync(30);
    bus.push(evt(3));
    await vi.advanceTimersByTimeAsync(89);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveBeenCalledTimes(1);
    const batch = await p;
    expect(batch.map((b) => (b.event?.origin === 'external' ? b.event!.cursor : -1))).toEqual([1, 2, 3]);
  });

  it("minBatchAge 从首项到达起算，quietGap 到期不提前投递", async () => {
    const bus = new WakeBus({ quietGapMs: 10, minBatchAgeMs: 200, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    const delivered = vi.fn();
    const p = bus.nextBatch();
    void p.then(delivered);
    bus.push(evt(1));
    await vi.advanceTimersByTimeAsync(199);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(await p).toEqual([evt(1)]);
  });

  it("minBatchAge 到期后仍等待 quietGap", async () => {
    const bus = new WakeBus({ quietGapMs: 120, minBatchAgeMs: 50, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    const delivered = vi.fn();
    const p = bus.nextBatch();
    void p.then(delivered);
    const t0 = Date.now();
    bus.push(evt(1));
    await vi.advanceTimersByTimeAsync(80); // 已超过 minBatchAge。
    bus.push(evt(2));
    await vi.advanceTimersByTimeAsync(119);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(await p).toEqual([evt(1), evt(2)]);
    expect(Date.now() - t0).toBe(200);
  });

  it('上限封顶:说个不停也到点强制投递', async () => {
    const bus = new WakeBus({ quietGapMs: 60, minBatchAgeMs: 0, maxBatchAgeMs: 150, maxBatchSize: 100 });
    const delivered = vi.fn();
    const p = bus.nextBatch();
    void p.then(delivered);
    bus.push(evt(1));
    for (let cursor = 2; cursor <= 8; cursor++) {
      await vi.advanceTimersByTimeAsync(20);
      bus.push(evt(cursor));
      expect(delivered).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(9);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(await p).toEqual(Array.from({ length: 8 }, (_, i) => evt(i + 1)));
  });

  it('单批上限:攒够条数立刻投,不等钟', async () => {
    const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 10_000, maxBatchAgeMs: 60_000, maxBatchSize: 3 });
    const delivered = vi.fn();
    const p = bus.nextBatch();
    void p.then(delivered);
    bus.push(evt(1));
    bus.push(evt(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).not.toHaveBeenCalled();
    bus.push(evt(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(await p).toEqual([evt(1), evt(2), evt(3)]);
  });

  it('候选票据按已发生的外部动静参与计时和条数上限', async () => {
    const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 10_000, maxBatchAgeMs: 60_000, maxBatchSize: 2 });
    const delivered = vi.fn();
    const batch = bus.nextBatch();
    void batch.then(delivered);
    bus.push(candidate(1));
    expect(bus.pendingImmediate()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).not.toHaveBeenCalled();
    bus.push(candidate(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(await batch).toEqual([candidate(1), candidate(2)]);
  });

  it("piggyback 随下一批投递，不启动或延后计时器", async () => {
    const bus = new WakeBus({ quietGapMs: 40, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    const delivered = vi.fn();
    const p = bus.nextBatch();
    void p.then(delivered);
    bus.push(evt(1), { trigger: 'piggyback' });
    bus.push(evt(2), { trigger: 'piggyback' });
    // 仅有 piggyback 时不启动计时。
    await vi.advanceTimersByTimeAsync(150);
    expect(delivered).not.toHaveBeenCalled();
    expect(bus.pending()).toBe(2);
    const t0 = Date.now();
    bus.push(evt(3)); // 其他事件触发投递时包含 piggyback。
    await vi.advanceTimersByTimeAsync(39);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveBeenCalledTimes(1);
    const batch = await p;
    expect(Date.now() - t0).toBe(40);
    expect(batch.map((b) => (b.event?.origin === 'external' ? b.event!.cursor : -1))).toEqual([1, 2, 3]);
  });

  it("flush 触发时包含队列中的 piggyback", async () => {
    const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 10_000, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
    const p = bus.nextBatch();
    bus.push(evt(1), { trigger: 'piggyback' });
    bus.push(internal()); // 内部事件默认 flush。
    const batch = await p;
    expect(batch).toHaveLength(2);
  });

  it("piggyback 不计入批次大小上限", async () => {
    const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 10_000, maxBatchAgeMs: 60_000, maxBatchSize: 3 });
    const delivered = vi.fn();
    const p = bus.nextBatch();
    void p.then(delivered);
    bus.push(evt(1), { trigger: 'piggyback' });
    bus.push(evt(2), { trigger: 'piggyback' });
    bus.push(evt(3), { trigger: 'piggyback' });
    bus.push(evt(4)); // 四项中只有一个外部非 piggyback 事件参与计数。
    await vi.advanceTimersByTimeAsync(150);
    expect(delivered).not.toHaveBeenCalled();
    expect(bus.pending()).toBe(4);
  });

  it("空闲判定不计 piggyback 项", () => {
    const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
    bus.push(evt(1), { trigger: 'piggyback' });
    bus.push(deferred(), { trigger: 'piggyback' });
    expect(bus.pending()).toBe(2);
    expect(bus.pendingImmediate()).toBe(0);
    bus.push(evt(2));
    expect(bus.pendingImmediate()).toBe(1);
  });

  it("投递后 minBatchAge 和 maxBatchAge 从下一项重新计时", async () => {
    const bus = new WakeBus({ quietGapMs: 10, minBatchAgeMs: 100, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    const delivered = vi.fn();
    const first = bus.nextBatch();
    void first.then(delivered);
    bus.push(evt(1));
    await vi.advanceTimersByTimeAsync(99);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(await first).toEqual([evt(1)]);
    const second = bus.nextBatch();
    void second.then(delivered);
    bus.push(evt(2));
    await vi.advanceTimersByTimeAsync(99);
    expect(delivered).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveBeenCalledTimes(2);
    expect(await second).toEqual([evt(2)]);
  });
});

describe('WakeBus', () => {
  it('安静窗口合批:连发多条,安静quietGapMs后一次性投递', async () => {
    const bus = new WakeBus({ quietGapMs: 30, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    const delivered = vi.fn();
    const p = bus.nextBatch();
    void p.then(delivered);
    bus.push(evt(1));
    await vi.advanceTimersByTimeAsync(10);
    bus.push(evt(2)); // 重置窗口
    await vi.advanceTimersByTimeAsync(10);
    bus.push(evt(3));
    await vi.advanceTimersByTimeAsync(29);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveBeenCalledTimes(1);
    const batch = await p;
    expect(batch.map((b) => (b.event?.origin === 'external' ? b.event!.cursor : -1))).toEqual([1, 2, 3]);
    expect(bus.pending()).toBe(0);
  });

  it('opts是活引用:构造后就地改quietMs,下一次push即用新值(web热改路径)', async () => {
    // 修改共享配置对象，保持同一个 bus 实例。
    const opts = { quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 };
    const bus = new WakeBus(opts);
    const delivered = vi.fn();
    const p = bus.nextBatch();
    void p.then(delivered);
    opts.quietGapMs = 20;
    bus.push(evt(1)); // 用新值排定20ms定时器
    await vi.advanceTimersByTimeAsync(19);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(await p).toEqual([evt(1)]);
  });

  it('flush 立即投递，不等安静窗口', async () => {
    const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
    const delivered = vi.fn();
    const p = bus.nextBatch();
    void p.then(delivered);
    bus.push(evt(1));
    bus.push(evt(2), { trigger: 'flush' });
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(await p).toEqual([evt(1), evt(2)]);
  });

  it('preempt 保持整批 FIFO，并在可投递时通知主循环', async () => {
    const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
    let preempts = 0;
    bus.setPreemptHandler(() => { preempts++; });
    const batch = bus.nextBatch();
    bus.push(evt(1));
    bus.push(evt(2), { trigger: 'preempt' });
    expect(await batch).toEqual([evt(1), evt(2)]);
    expect(preempts).toBe(1);
  });

  it('promote 把排队中的 piggyback 项改为 interrupt:立即投递并通知主循环，已取走的项返回 false', async () => {
    const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
    const notified: string[] = [];
    bus.setPreemptHandler((trigger) => { notified.push(trigger); });
    bus.push(evt(1), { trigger: 'piggyback' });
    expect(bus.promote((it) => it.event?.cursor === 1, 'interrupt')).toBe(true);
    expect(notified).toEqual(['interrupt']);
    expect(await bus.nextBatch()).toEqual([evt(1)]);
    expect(bus.promote((it) => it.event?.cursor === 1, 'interrupt')).toBe(false);
  });

  it('preempt 被关键词闸门放行后通知主循环，整批顺序不变', async () => {
    const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
    let preempts = 0;
    bus.setPreemptHandler(() => { preempts++; });
    bus.setDeliveryGate({
      id: 'keyword',
      keyword: 'e2',
      overflowLimit: 100,
      onKeyword: () => {
        bus.clearDeliveryGate('keyword', false);
        bus.push(internal('关键词放行'));
      },
      onOverflow: () => {},
    });
    const batch = bus.nextBatch();
    bus.push(evt(1));
    expect(preempts).toBe(0);
    bus.push(evt(2), { trigger: 'preempt' });
    expect(await batch).toEqual([evt(1), evt(2), internal('关键词放行')]);
    expect(preempts).toBe(1);
  });

  it('候选票据用 gateText 命中关键词，不需要预先生成投递正文', async () => {
    const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
    bus.setDeliveryGate({
      id: 'candidate-keyword',
      keyword: '救命',
      overflowLimit: 100,
      onKeyword: () => { bus.clearDeliveryGate('candidate-keyword', false); },
      onOverflow: () => {},
    });
    const batch = bus.nextBatch();
    bus.push(candidate(1, '普通弹幕'));
    bus.push(candidate(2, '救命'));
    expect(await batch).toEqual([candidate(1, '普通弹幕'), candidate(2, '救命')]);
  });

  it('preempt 触发闸门溢出放行时只通知一次', async () => {
    const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
    let preempts = 0;
    bus.setPreemptHandler(() => { preempts++; });
    bus.setDeliveryGate({
      id: 'overflow',
      overflowLimit: 1,
      onKeyword: () => {},
      onOverflow: () => bus.push(internal('溢出放行')),
    });
    const batch = bus.nextBatch();
    bus.push(evt(1));
    bus.push(evt(2), { trigger: 'preempt' });
    expect(await batch).toEqual([evt(1), evt(2), internal('溢出放行')]);
    expect(preempts).toBe(1);
  });

  it('内部事件默认使用 flush', async () => {
    const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
    const delivered = vi.fn();
    const p = bus.nextBatch();
    void p.then(delivered);
    bus.push(internal());
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(await p).toEqual([internal()]);
  });

  it('maxHold强制投递:消息流不断也不无限扣留', async () => {
    const bus = new WakeBus({ quietGapMs: 50, minBatchAgeMs: 0, maxBatchAgeMs: 120, maxBatchSize: 100 });
    const delivered = vi.fn();
    const p = bus.nextBatch();
    void p.then(delivered);
    bus.push(evt(1));
    for (let cursor = 2; cursor <= 6; cursor++) {
      await vi.advanceTimersByTimeAsync(20);
      bus.push(evt(cursor));
    }
    await vi.advanceTimersByTimeAsync(19);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(await p).toEqual(Array.from({ length: 6 }, (_, i) => evt(i + 1)));
  });

  it('paused期间积压不投递,resume后立即投递', async () => {
    const bus = new WakeBus({ quietGapMs: 20, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    bus.setPaused(true);
    expect(bus.isPaused()).toBe(true);
    bus.push(evt(1));
    bus.push(internal('暂停期间的tick'));
    const delivered = vi.fn();
    const waiting = bus.nextBatch();
    void waiting.then(delivered);
    await vi.advanceTimersByTimeAsync(60);
    expect(delivered).not.toHaveBeenCalled();
    bus.setPaused(false);
    const batch = await waiting;
    expect(batch).toEqual([evt(1), internal('暂停期间的tick')]);
    expect(bus.pending()).toBe(0); // 积压已投递给挂起中的消费者
  });

  it('闸门扣一切唤醒项(含flush事件与internal),解闸后整批按到达序投递', async () => {
    const bus = new WakeBus({ quietGapMs: 20, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    bus.setDeliveryGate({
      id: 'gate-1',
      overflowLimit: 100,
      onKeyword: () => {},
      onOverflow: () => {},
    });
    const delivered = vi.fn();
    const waiting = bus.nextBatch();
    void waiting.then(delivered);
    bus.push(evt(1));
    bus.push(evt(2), { trigger: 'flush' });
    bus.push(internal('阻断期间的通知'));
    bus.push(evt(3), { trigger: 'flush' });

    await vi.advanceTimersByTimeAsync(60);
    expect(delivered).not.toHaveBeenCalled();
    expect(bus.isDeliveryBlocked()).toBe(true);
    expect(bus.clearDeliveryGate('gate-1')).toBe(true);
    expect(await waiting).toEqual([evt(1), evt(2), internal('阻断期间的通知'), evt(3)]);
    expect(bus.isDeliveryBlocked()).toBe(false);
  });

  it('闸门按字面关键词回调持有方;持有方解闸后通知与积压同批投递', async () => {
    const bus = new WakeBus({ quietGapMs: 20, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    let matches = 0;
    bus.setDeliveryGate({
      id: 'gate-keyword',
      keyword: 'e2',
      overflowLimit: 100,
      onKeyword: () => {
        matches++;
        bus.clearDeliveryGate('gate-keyword', false);
        bus.push(internal('关键词提前唤醒'));
      },
      onOverflow: () => {},
    });
    const waiting = bus.nextBatch();
    bus.push(evt(1));
    await vi.advanceTimersByTimeAsync(30);
    expect(matches).toBe(0);
    bus.push(evt(2));

    const batch = await waiting;
    expect(matches).toBe(1);
    expect(batch).toEqual([evt(1), evt(2), internal('关键词提前唤醒')]);
  });

  it('被扣事件超过上限时放行当前一批(含回调注入的通知),闸门继续有效', async () => {
    const bus = new WakeBus({ quietGapMs: 20, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    let overflows = 0;
    bus.setDeliveryGate({
      id: 'gate-overflow',
      overflowLimit: 2,
      onKeyword: () => {},
      onOverflow: () => {
        overflows++;
        bus.push(internal('溢出放行'));
      },
    });
    const delivered = vi.fn();
    const first = bus.nextBatch();
    void first.then(delivered);
    bus.push(evt(1));
    bus.push(evt(2));
    await vi.advanceTimersByTimeAsync(50);
    expect(delivered).not.toHaveBeenCalled();
    bus.push(evt(3));
    const batch = await first;
    expect(batch.filter((item) => item.event?.origin === 'external')).toHaveLength(3);
    expect(batch).toContainEqual(internal('溢出放行'));
    expect(overflows).toBe(1);
    expect(bus.isDeliveryBlocked()).toBe(true);

    // 放行只此一批:后续普通事件继续被扣
    const secondDelivered = vi.fn();
    const second = bus.nextBatch();
    void second.then(secondDelivered);
    bus.push(evt(4));
    await vi.advanceTimersByTimeAsync(50);
    expect(secondDelivered).not.toHaveBeenCalled();
    bus.clearDeliveryGate('gate-overflow');
    expect(await second).toEqual([evt(4)]);
  });

  it("piggyback 不参与 gate 关键词或溢出判定", async () => {
    const bus = new WakeBus({ quietGapMs: 20, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    let matches = 0;
    let overflows = 0;
    bus.setDeliveryGate({
      id: 'gate-piggyback',
      keyword: 'e2',
      overflowLimit: 2,
      onKeyword: () => { matches++; },
      onOverflow: () => { overflows++; },
    });
    const delivered = vi.fn();
    const waiting = bus.nextBatch();
    void waiting.then(delivered);
    bus.push(evt(2), { trigger: 'piggyback' }); // piggyback 不参与关键词匹配。
    bus.push(evt(3), { trigger: 'piggyback' });
    bus.push(evt(4), { trigger: 'piggyback' });
    await vi.advanceTimersByTimeAsync(60);
    expect(delivered).not.toHaveBeenCalled();
    expect(matches).toBe(0);
    expect(overflows).toBe(0);
    expect(bus.isDeliveryBlocked()).toBe(true);

    // 解除 gate 不单独投递 piggyback，后续事件触发时仍按 FIFO 顺序投递。
    bus.clearDeliveryGate('gate-piggyback');
    bus.push(evt(5));
    await vi.advanceTimersByTimeAsync(19);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(await waiting).toEqual([evt(2), evt(3), evt(4), evt(5)]);
  });

  it("解除 gate 后仅剩 piggyback 时等待其他项触发投递", async () => {
    const bus = new WakeBus({ quietGapMs: 20, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    bus.setDeliveryGate({ id: 'g', overflowLimit: 100, onKeyword: () => {}, onOverflow: () => {} });
    const delivered = vi.fn();
    const waiting = bus.nextBatch();
    void waiting.then(delivered);
    bus.push(evt(1), { trigger: 'piggyback' });
    bus.clearDeliveryGate('g');
    await vi.advanceTimersByTimeAsync(80);
    expect(delivered).not.toHaveBeenCalled();
    expect(bus.pending()).toBe(1);

    bus.push(evt(2));
    await vi.advanceTimersByTimeAsync(19);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(await waiting).toEqual([evt(1), evt(2)]);
  });

  it("恢复投递后仅剩 piggyback 时继续等待", async () => {
    const bus = new WakeBus({ quietGapMs: 20, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    bus.setPaused(true);
    bus.push(evt(1), { trigger: 'piggyback' });
    const delivered = vi.fn();
    const waiting = bus.nextBatch();
    void waiting.then(delivered);
    bus.setPaused(false);
    await vi.advanceTimersByTimeAsync(80);
    expect(delivered).not.toHaveBeenCalled();
    expect(bus.takeIfReady()).toBeNull();

    bus.push(internal('心跳'));
    expect(await waiting).toEqual([evt(1), internal('心跳')]);
  });

  it('没货时nextBatch挂起,有货先到先取', async () => {
    const bus = new WakeBus({ quietGapMs: 10, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
    bus.push(evt(1));
    await vi.advanceTimersByTimeAsync(9);
    expect(bus.takeIfReady()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const batch = await bus.nextBatch();
    expect(batch.length).toBe(1);
  });

  describe('drainPending', () => {
    it('只抽走命中项并按原序返回', () => {
      const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
      bus.push(evt(1));
      bus.push(evt(2));
      bus.push(evt(3));
      const drained = bus.drainPending((it) => it.event?.origin === 'external' && it.event!.cursor !== 2);
      expect(drained.map((b) => (b.event?.origin === 'external' ? b.event!.cursor : -1))).toEqual([1, 3]);
    });

    it('未命中项留在队列中(经nextBatch验证)', async () => {
      const bus = new WakeBus({ quietGapMs: 5, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
      bus.push(evt(1));
      bus.push(evt(2));
      bus.push(evt(3));
      const drained = bus.drainPending((it) => it.event?.origin === 'external' && it.event!.cursor === 2);
      expect(drained.map((b) => (b.event?.origin === 'external' ? b.event!.cursor : -1))).toEqual([2]);
      expect(bus.pending()).toBe(2);
      await vi.advanceTimersByTimeAsync(4);
      expect(bus.takeIfReady()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      const batch = await bus.nextBatch();
      expect(batch.map((b) => (b.event?.origin === 'external' ? b.event!.cursor : -1))).toEqual([1, 3]);
    });

    it('无命中时返回空数组且队列不变', () => {
      const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
      bus.push(evt(1));
      bus.push(evt(2));
      const drained = bus.drainPending((it) => it.event?.origin === 'internal');
      expect(drained).toEqual([]);
      expect(bus.pending()).toBe(2);
    });

    it('空队列返回空数组', () => {
      const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
      expect(bus.drainPending(() => true)).toEqual([]);
      expect(bus.pending()).toBe(0);
    });

    /** 控制台清空待投递事件使用此方法。 */
    it("暂停时清空待投递事件，恢复后不投递已清除项", async () => {
      const bus = new WakeBus({ quietGapMs: 20, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
      bus.setPaused(true);
      bus.push(evt(1));
      bus.push(evt(2));
      bus.push(internal('暂停期间的tick'));
      expect(bus.pending()).toBe(3);

      expect(bus.drainPending(() => true)).toHaveLength(3);
      expect(bus.pending()).toBe(0);

      const delivered = vi.fn();
      const waiting = bus.nextBatch();
      void waiting.then(delivered);
      bus.setPaused(false);
      // 清空后队列、ready 和合批计时器均应重置。
      await vi.advanceTimersByTimeAsync(80);
      expect(delivered).not.toHaveBeenCalled();

      // 清空积压不影响后续事件的正常投递
      bus.push(evt(3));
      await vi.advanceTimersByTimeAsync(19);
      expect(delivered).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(delivered).toHaveBeenCalledTimes(1);
      expect(await waiting).toEqual([evt(3)]);
    });

    /** 延迟 render 同时重置 World 的待渲染标志；清空即时事件时需保留它。 */
    it('挂单不随控制台清空被抽走:只丢已成文的积压', () => {
      const bus = new WakeBus({ quietGapMs: 10_000, minBatchAgeMs: 0, maxBatchAgeMs: 60_000, maxBatchSize: 100 });
      bus.push(evt(1));
      bus.push(deferred(), { trigger: 'piggyback' });
      bus.push(internal('暂停期间的tick'));

      const dropped = bus.drainPending((it) => it.event !== undefined);
      expect(dropped).toHaveLength(2);
      expect(dropped.every((it) => it.event !== undefined)).toBe(true);

      // 延迟项仍在队列，render 尚未调用。
      const left = bus.drainPending(() => true);
      expect(left.map((it) => it.deferred?.type)).toEqual(['bilibili.audience']);
    });

    /** 仅剩 piggyback 时需重置 ready 与计时器，不能触发独立投递。 */
    it('只剩挂单时同样复位 ready 与计时器', async () => {
      const bus = new WakeBus({ quietGapMs: 20, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
      bus.push(evt(1));
      bus.push(deferred(), { trigger: 'piggyback' });
      await vi.advanceTimersByTimeAsync(20);

      expect(bus.drainPending((it) => it.event !== undefined)).toHaveLength(1);
      expect(bus.pending()).toBe(1);
      expect(bus.takeIfReady()).toBeNull(); // piggyback 不能独立投递。

      // 后续事件触发整批投递。
      bus.push(evt(2));
      await vi.advanceTimersByTimeAsync(20);
      const batch = await bus.nextBatch();
      expect(batch).toHaveLength(2);
      expect(batch.some((it) => it.deferred?.type === 'bilibili.audience')).toBe(true);
    });

    /** 已生成正文的 piggyback 也不单独投递，队列状态同样重置。 */
    it("仅剩即时 piggyback 事件时重置投递状态", async () => {
      const bus = new WakeBus({ quietGapMs: 20, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });
      bus.push(evt(1));
      bus.push(evt(2), { trigger: 'piggyback' });
      await vi.advanceTimersByTimeAsync(20);

      expect(bus.drainPending((it) => it.event?.cursor === 1)).toHaveLength(1);
      expect(bus.pending()).toBe(1);
      expect(bus.takeIfReady()).toBeNull();
    });
  });
});
