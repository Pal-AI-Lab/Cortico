import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CandidatePushSpec,
  DeferredEventSpec,
  EventEnvelope,
  WorldHost,
  PushOptions,
  TriggerMode,
} from '../../../src/core/types.ts';
import {
  BilibiliWorld,
  type BilibiliWorldOptions,
  type LiveHandlers,
} from '../../../src/worlds/bilibili/world.ts';
import type { LiveStatus } from '../../../src/worlds/bilibili/client.ts';
import { cloneOverlayConfig } from '../../../src/worlds/bilibili/overlay/model.ts';
import { PB_SMALL } from './gift-v2-frames.ts';
import { nullLogger } from '../../../src/core/util.ts';

type DeferredPush = {
  spec: Pick<DeferredEventSpec, 'type' | 'senderKey' | 'meta' | 'render'>;
  opts?: { trigger?: TriggerMode };
};

class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  archivedEvents: EventEnvelope[] = [];
  pushOpts: Array<PushOptions | undefined> = [];
  deferred: DeferredPush[] = [];
  logs: Array<{ level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }> = [];

  async pushEvent(e: Omit<EventEnvelope, 'cursor' | 'origin'>, opts?: PushOptions): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1, origin: 'external' } as EventEnvelope;
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }
  async pushCandidate(spec: CandidatePushSpec, opts?: { trigger?: TriggerMode }): Promise<readonly EventEnvelope[]> {
    const archived = spec.sourceEvents.map((source, index) => ({
      ...source,
      cursor: this.archivedEvents.length + index + 1,
      source: 'bilibili',
      origin: spec.origin ?? 'external',
      contextDelivery: 'archive-only' as const,
    }));
    this.archivedEvents.push(...archived);
    const projections = spec.project([{
      source: 'bilibili',
      origin: spec.origin ?? 'external',
      sourceEvents: archived,
      gateText: spec.gateText,
      value: spec.value,
      project: spec.project,
    }]);
    for (const projection of projections) {
      const full: EventEnvelope = {
        ...projection.event,
        cursor: 100_000 + this.events.length + 1,
        ts: archived[0].ts,
        source: 'bilibili',
        origin: spec.origin ?? 'external',
        contextDelivery: 'deliver',
        meta: {
          ...projection.event.meta,
          sourceCursors: projection.candidateIndexes.flatMap((index) =>
            index === 0 ? archived.map((event) => event.cursor) : []),
        },
      };
      this.events.push(full);
      this.pushOpts.push(opts);
    }
    return archived;
  }
  pushDeferred(spec: DeferredPush['spec'], opts?: { trigger?: TriggerMode }): void {
    this.deferred.push({ spec, opts });
  }
  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as WorldHost['store'];
  blob = (_handle: string): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log = {
    child: () => this.log,
    info: (msg: string, data?: unknown) => { this.logs.push({ level: 'info', msg, data }); },
    warn: (msg: string, data?: unknown) => { this.logs.push({ level: 'warn', msg, data }); },
    error: (msg: string, data?: unknown) => { this.logs.push({ level: 'error', msg, data }); },
    debug: () => {},
  } as unknown as WorldHost['log'];
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  reportUsage(): void {}
}

class DelayedFirstHost extends FakeHost {
  private readonly firstGate: Promise<void>;
  private releaseGate!: () => void;
  private first = true;

  constructor() {
    super();
    this.firstGate = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
  }

  releaseFirst(): void {
    this.releaseGate();
  }

  override async pushCandidate(
    spec: CandidatePushSpec,
    opts?: { trigger?: TriggerMode },
  ): Promise<readonly EventEnvelope[]> {
    if (this.first) {
      this.first = false;
      await this.firstGate;
    }
    return super.pushCandidate(spec, opts);
  }
}

class BatchCandidateHost extends FakeHost {
  private readonly pending: Array<{
    spec: CandidatePushSpec;
    opts?: { trigger?: TriggerMode };
    archived: EventEnvelope[];
  }> = [];

  override async pushCandidate(
    spec: CandidatePushSpec,
    opts?: { trigger?: TriggerMode },
  ): Promise<readonly EventEnvelope[]> {
    const archived = spec.sourceEvents.map((source, index) => ({
      ...source,
      cursor: this.archivedEvents.length + index + 1,
      source: 'bilibili',
      origin: spec.origin ?? 'external',
      contextDelivery: 'archive-only' as const,
    }));
    this.archivedEvents.push(...archived);
    this.pending.push({ spec, opts, archived });
    return archived;
  }

  projectBatch(): void {
    if (this.pending.length === 0) return;
    const project = this.pending[0].spec.project;
    expect(this.pending.every((entry) => entry.spec.project === project)).toBe(true);
    const sourceCandidates = this.pending.map(({ spec, archived }) => ({
      source: 'bilibili',
      origin: spec.origin ?? 'external',
      sourceEvents: archived,
      gateText: spec.gateText,
      value: spec.value,
      project,
    }));
    for (const projection of project(sourceCandidates)) {
      const sources = projection.candidateIndexes.flatMap((index) => this.pending[index].archived);
      const full: EventEnvelope = {
        ...projection.event,
        cursor: 100_000 + this.events.length + 1,
        ts: sources[0].ts,
        source: 'bilibili',
        origin: 'external',
        contextDelivery: 'deliver',
        meta: { ...projection.event.meta, sourceCursors: sources.map((event) => event.cursor) },
      };
      this.events.push(full);
      this.pushOpts.push(this.pending[projection.candidateIndexes[0]].opts);
    }
    this.pending.length = 0;
  }
}

const STATUS: LiveStatus = {
  phase: 'connected',
  roomId: 6,
  realRoomId: 7734200,
  title: '测试间',
  living: true,
  liveStartedAt: null,
  selfUid: 1039523363,
  lastError: null,
};

interface Mounted {
  module: BilibiliWorld;
  host: FakeHost;
  /** 把一条原始 cmd 喂进长连 */
  feed: (msg: Record<string, unknown>) => void;
  /** 把一份长连状态喂给 World(模拟轮询 patch 触发的 onStatus 回调) */
  setStatus: (status: LiveStatus) => void;
}

/** 起一个接了假长连的 World */
async function mount(
  opts: Partial<BilibiliWorldOptions> = {},
  host: FakeHost = new FakeHost(),
): Promise<Mounted> {
  let handlers: LiveHandlers | null = null;
  const module = new BilibiliWorld({
    ...opts,
    roomId: 6,
    source: (h) => {
      handlers = h;
      return {
        start: async () => h.onStatus(STATUS),
        stop: async () => {},
        current: () => STATUS,
      };
    },
  });
  await module.start(host);
  return {
    module,
    host,
    feed: (msg) => handlers?.onCmd(msg),
    setStatus: (status) => handlers?.onStatus(status),
  };
}

function danmaku(uid: number, uname: string, text: string): Record<string, unknown> {
  const info: unknown[] = [];
  info[1] = text;
  info[2] = [uid, uname];
  info[3] = [];
  info[7] = 0;
  return { cmd: 'DANMU_MSG', info };
}

describe('BilibiliWorld', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('只提供本机 Agent 公告工具，不向 B 站账号写入', async () => {
    const { module } = await mount();
    const tools = module.tools();
    expect(tools.map((tool) => tool.name)).toEqual(['bilibili_set_announcement']);
    expect(tools[0].tags).toEqual(['speak']);
    expect((tools[0].parameters.properties as Record<string, { maxLength: number }>).text.maxLength).toBe(200);
    await module.stop();
  });

  it('已挂载的自定义 source 未提供核验能力时保守记为 unknown', async () => {
    const { module } = await mount();
    await module.stop();
    expect(module.shutdownVerification('zh')).toEqual([expect.objectContaining({
      key: 'bilibili.live-source',
      status: 'unknown',
      manualAction: expect.stringContaining('人工确认'),
    })]);
  });

  it('停机期间与停机后的 source 回调不能写回已清空的直播状态', async () => {
    const sourceState: { handlers: LiveHandlers | null } = { handlers: null };
    const module = new BilibiliWorld({
      roomId: 6,
      source: (next) => {
        sourceState.handlers = next;
        return {
          start: async () => next.onStatus(STATUS),
          stop: async () => next.onStatus({ ...STATUS, phase: 'stopped' }),
          current: () => STATUS,
        };
      },
    });
    await module.start(new FakeHost());
    await module.stop();
    sourceState.handlers?.onStatus(STATUS);

    expect((module as unknown as { status: LiveStatus | null }).status).toBeNull();
    expect(module.webUi().badges?.[0]).toMatchObject({ value: '未接入', tone: 'off' });
  });

  it('只在 source.stop 完成后读取关机核验 hook', async () => {
    let stopped = false;
    let verificationCalls = 0;
    const module = new BilibiliWorld({
      roomId: 6,
      source: () => ({
        start: async () => {},
        stop: async () => { stopped = true; },
        current: () => STATUS,
        shutdownVerification: () => {
          verificationCalls += 1;
          if (!stopped) throw new Error('stop 前不可核验');
          return [{
            key: 'test.source',
            label: '测试直播源',
            status: 'verified-ended' as const,
            detail: 'stop 后已结束',
            manualAction: '',
          }];
        },
      }),
    });

    await expect(module.start(new FakeHost())).resolves.toBeUndefined();
    expect(verificationCalls).toBe(0);
    await module.stop();
    expect(verificationCalls).toBe(1);
    expect(module.shutdownVerification('zh')).toEqual([expect.objectContaining({
      key: 'test.source',
      status: 'verified-ended',
    })]);
  });

  it('source.stop 失败时仍停止 overlay、清理生命周期并保守核验', async () => {
    const overlayStop = vi.fn(async () => {});
    const module = new BilibiliWorld({
      roomId: 6,
      source: () => ({
        start: async () => {},
        stop: async () => { throw new Error('source stop failed'); },
        current: () => STATUS,
        shutdownVerification: () => [{
          key: 'stale', label: '不应读取', status: 'verified-ended' as const,
          detail: '过期缓存', manualAction: '',
        }],
      }),
    });
    await module.start(new FakeHost());
    (module as unknown as { overlayServer: { stop(): Promise<void> } | null }).overlayServer = {
      stop: overlayStop,
    };

    await expect(module.stop()).rejects.toThrow('B 站 World 停止不完整');
    expect(overlayStop).toHaveBeenCalledOnce();
    expect((module as unknown as { host: unknown }).host).toBeNull();
    expect((module as unknown as { status: unknown }).status).toBeNull();
    expect(module.shutdownVerification('zh')).toEqual([expect.objectContaining({
      key: 'bilibili.live-source',
      status: 'unknown',
      detail: expect.stringContaining('source stop failed'),
    })]);
  });

  it('source.stop 永不返回时也会立即发起 overlay.stop 并清理本地生命周期', async () => {
    const overlayStop = vi.fn(async () => {});
    const module = new BilibiliWorld({
      roomId: 6,
      source: () => ({
        start: async () => {},
        stop: () => new Promise<void>(() => {}),
        current: () => STATUS,
      }),
    });
    await module.start(new FakeHost());
    (module as unknown as { overlayServer: { stop(): Promise<void> } | null }).overlayServer = {
      stop: overlayStop,
    };

    void module.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(overlayStop).toHaveBeenCalledOnce();
    expect((module as unknown as { client: unknown }).client).toBeNull();
    expect((module as unknown as { overlayServer: unknown }).overlayServer).toBeNull();
    expect((module as unknown as { host: unknown }).host).toBeNull();
    expect((module as unknown as { status: unknown }).status).toBeNull();
    expect(module.shutdownVerification('zh')).toEqual([expect.objectContaining({ status: 'unknown' })]);
  });

  it('自定义 source 的核验 hook 返回空数组时保守记为 unknown', async () => {
    const module = new BilibiliWorld({
      roomId: 6,
      source: () => ({
        start: async () => {},
        stop: async () => {},
        current: () => STATUS,
        shutdownVerification: () => [],
      }),
    });
    await module.start(new FakeHost());
    await module.stop();

    expect(module.shutdownVerification('zh')).toEqual([expect.objectContaining({
      status: 'unknown',
      detail: expect.stringContaining('未返回任何检查项'),
    })]);
  });

  it('房间与 source 都未配置、实际没有启动直播源时不生成外部检查', async () => {
    const module = new BilibiliWorld({ roomId: 0 });
    const host = new FakeHost();
    await module.start(host);
    await module.stop();
    expect(module.shutdownVerification('zh')).toEqual([]);
  });

  it('弹幕按 debounce 推,礼物按金额分档', async () => {
    const { module, host, feed } = await mount();
    feed(danmaku(42, '阿明', '在吗'));
    feed({ cmd: 'SEND_GIFT', data: { uname: '阿明', giftName: '小花花', num: 1, coin_type: 'gold', total_coin: 100 } });
    feed({ cmd: 'SEND_GIFT', data: { uname: '阿明', giftName: '舰长票', num: 1, coin_type: 'gold', total_coin: 5000 } });
    await module.stop();

    expect(host.events.map((e) => e.type)).toEqual(['bilibili.danmaku', 'bilibili.gift', 'bilibili.gift']);
    expect(host.pushOpts.map((o) => o?.trigger)).toEqual(['debounce', 'debounce', 'flush']);
    expect(host.events[0].senderKey).toBe('42');
    expect(host.events[0].source).toBe('bilibili');
  });

  it('不同观众的同一句话不跨人合并，各自带着姓名分别投递', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount();
    feed(danmaku(41, '甲', '同一句'));
    await vi.advanceTimersByTimeAsync(250);
    feed(danmaku(42, '乙', '同一句'));
    feed(danmaku(43, '丙', '另一句'));

    await vi.advanceTimersByTimeAsync(49);
    expect(host.events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    // 归并 key 带身份维度:甲和乙各是一条,姓名一个都没掉。
    expect(host.events.map((event) => event.text)).toEqual([
      '[弹幕|甲] 同一句',
      '[弹幕|乙] 同一句',
      '[弹幕|丙] 另一句',
    ]);
    expect(host.events.map((event) => event.senderKey)).toEqual(['41', '42', '43']);
    expect(host.archivedEvents).toHaveLength(3);
    expect(host.archivedEvents.every((event) => event.contextDelivery === 'archive-only')).toBe(true);
    expect(host.events[2]).toMatchObject({
      text: '[弹幕|丙] 另一句',
      meta: { uname: '丙' },
    });
    await module.stop();
  });

  it('同一观众连续刷同款常规礼物时按人合并并保留姓名', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount();
    feed({ cmd: 'SEND_GIFT', data: { uid: 41, uname: '甲', giftName: '小花花', num: 1, coin_type: 'gold', total_coin: 100 } });
    feed({ cmd: 'SEND_GIFT', data: { uid: 41, uname: '甲', giftName: '小花花', num: 2, coin_type: 'gold', total_coin: 200 } });

    await vi.advanceTimersByTimeAsync(300);

    expect(host.events).toHaveLength(1);
    expect(host.events[0]).toMatchObject({
      type: 'bilibili.gift',
      text: '[礼物×2笔 ¥0.3|甲] 小花花×3',
      senderKey: '41',
      meta: {
        gift: '小花花',
        num: 3,
        yuan: 0.3,
        mergedCount: 2,
        senderKeys: ['41'],
        participants: [
          { senderKey: '41', uname: '甲', count: 2 },
        ],
        contributors: [
          { uname: '甲', count: 2 },
        ],
      },
    });
    await module.stop();
  });

  it('不同观众的同款礼物逐人投递，前一位再次送礼也不开跨人合并', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount();
    const gift = (uid: number, uname: string) => ({
      cmd: 'SEND_GIFT',
      data: { uid, uname, giftName: '小花花', num: 1, coin_type: 'gold', total_coin: 100 },
    });
    feed(gift(41, '甲'));
    feed(gift(42, '乙'));
    feed(gift(41, '甲'));
    await vi.advanceTimersByTimeAsync(300);

    expect(host.events.map((event) => event.text)).toEqual([
      '[礼物 ¥0.10|甲] 小花花×1',
      '[礼物 ¥0.10|乙] 小花花×1',
      '[礼物 ¥0.10|甲] 小花花×1',
    ]);
    expect(host.events.map((event) => event.senderKey)).toEqual(['41', '42', '41']);
    await module.stop();
  });

  it('免费礼物也会结束付费礼物连续段，但不提前冲刷固定窗', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount();
    const paid = {
      uid: 41,
      uname: '甲',
      giftName: '小花花',
      num: 1,
      coin_type: 'gold',
      total_coin: 100,
    };
    feed({ cmd: 'SEND_GIFT', data: paid });
    feed({
      cmd: 'SEND_GIFT',
      data: { uid: 42, uname: '乙', giftName: '小心心', num: 1, coin_type: 'silver' },
    });
    feed({ cmd: 'SEND_GIFT', data: paid });

    await vi.advanceTimersByTimeAsync(299);
    expect(host.events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.events.map((event) => event.text)).toEqual([
      '[礼物 ¥0.10|甲] 小花花×1',
      '[礼物 ¥0.10|甲] 小花花×1',
    ]);
    await module.stop();
  });

  it('没有稳定 UID 的礼物逐笔投递，不凭重名昵称猜成同一人', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount();
    const gift = { uname: '老***', giftName: '小花花', num: 1, coin_type: 'gold', total_coin: 100 };
    feed({ cmd: 'SEND_GIFT', data: gift });
    feed({ cmd: 'SEND_GIFT', data: gift });
    await vi.advanceTimersByTimeAsync(300);

    expect(host.events.map((event) => event.text)).toEqual([
      '[礼物 ¥0.10|老***] 小花花×1',
      '[礼物 ¥0.10|老***] 小花花×1',
    ]);
    expect(host.events.every((event) => event.senderKey === undefined)).toBe(true);
    await module.stop();
  });

  it('金额读不出的礼物照样成条,合并后也不写 ¥（不拿部分和冒充总额）', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount();
    const data = { uid: 41, uname: '甲', giftName: '小花花', num: 1, coin_type: 'gold' };
    feed({ cmd: 'SEND_GIFT', data });
    feed({ cmd: 'SEND_GIFT', data });
    await vi.advanceTimersByTimeAsync(300);

    expect(host.events.map((event) => event.text)).toEqual(['[礼物×2笔|甲] 小花花×2']);
    expect(host.events[0].meta?.yuan).toBeUndefined();
    await module.stop();
  });

  it('同一观众连发同一句话合并成一条，合并正文带昵称', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount();
    feed(danmaku(41, '甲', '复读'));
    feed(danmaku(41, '甲', '复读'));
    feed(danmaku(41, '甲', '复读'));

    await vi.advanceTimersByTimeAsync(300);

    // meta 是驱动层私有的,她只看得见 text——昵称必须在 text 里。
    expect(host.events).toHaveLength(1);
    expect(host.events[0]).toMatchObject({ text: '[弹幕×3|甲] 复读', senderKey: '41' });
    expect(host.events[0].meta).toMatchObject({
      uname: '甲',
      participants: [{ senderKey: '41', uname: '甲', count: 3 }],
    });
    await module.stop();
  });

  it('匿名接入(uid 抹成 0)没有身份键时仍按正文合并，正文里不编造昵称', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount();
    feed(danmaku(0, '老***', '同一句'));
    feed(danmaku(0, '老***', '同一句'));

    await vi.advanceTimersByTimeAsync(300);

    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toBe('[弹幕×2] 同一句');
    expect(host.events[0].senderKey).toBeUndefined();
    await module.stop();
  });

  it('flush 事件先冲刷更早的缓冲项并立即投递，旧 timer 不会重复输出', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount();
    feed(danmaku(41, '甲', '先到'));
    feed({
      cmd: 'SUPER_CHAT_MESSAGE',
      data: { id: 7, price: 30, message: '马上看', user_info: { uid: 42, uname: '乙' } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(host.events.map((event) => event.text)).toEqual([
      '[弹幕|甲] 先到',
      '[醒目留言 ¥30|乙] 马上看',
    ]);
    expect(host.pushOpts.map((opts) => opts?.trigger)).toEqual(['debounce', 'flush']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.events).toHaveLength(2);
    await module.stop();
  });

  it('归并池达到硬上限立即按首到顺序冲刷', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount({ coalesceMaxItems: () => 3 });
    feed(danmaku(41, '甲', '一'));
    feed(danmaku(42, '乙', '二'));
    feed(danmaku(43, '丙', '三'));
    await module.stop();

    expect(host.events.map((event) => event.text)).toEqual([
      '[弹幕|甲] 一',
      '[弹幕|乙] 二',
      '[弹幕|丙] 三',
    ]);
    const state = await module.webUi().invoke?.('log', 'state', []) as {
      coalescing: { capacityFlushes: number; pendingItems: number };
    };
    expect(state.coalescing).toMatchObject({ capacityFlushes: 1, pendingItems: 0 });
  });

  it('stop 在 host 仍有效时冲刷既有项并取消 timer', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount();
    feed(danmaku(41, '甲', '收尾'));
    feed(danmaku(41, '甲', '收尾'));

    await module.stop();
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toBe('[弹幕×2|甲] 收尾');
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.events).toHaveLength(1);
  });

  it('异步宿主仍按缓冲组和屏障顺序写入，stop 等尾项落完', async () => {
    const host = new DelayedFirstHost();
    const { module, feed } = await mount({ coalesceWindowMs: () => 0 }, host);
    feed(danmaku(41, '甲', '先到'));
    feed({
      cmd: 'SUPER_CHAT_MESSAGE',
      data: { id: 7, price: 30, message: '随后', user_info: { uid: 42, uname: '乙' } },
    });

    const stopping = module.stop();
    await Promise.resolve();
    expect(host.events).toHaveLength(0);
    host.releaseFirst();
    await stopping;

    expect(host.events.map((event) => event.text)).toEqual([
      '[弹幕|甲] 先到',
      '[醒目留言 ¥30|乙] 随后',
    ]);
  });

  it('近期高能榜峰值下即使批负荷超线也严格全量通过', async () => {
    const host = new BatchCandidateHost();
    const { module, feed } = await mount({ coalesceWindowMs: () => 0 }, host);
    feed({ cmd: 'ONLINE_RANK_COUNT', data: { count: 153 } });
    for (let index = 0; index < 115; index++) {
      feed(danmaku(10_000 + index, `观众${index}`, `正常流量${index}`));
    }
    await module.stop();
    host.projectBatch();

    expect(host.archivedEvents).toHaveLength(115);
    expect(host.events).toHaveLength(115);
    expect(host.events.every((event) =>
      (event.meta?.audienceAdmission as Record<string, unknown>).limitingActive === false)).toBe(true);
  });

  it('高能榜与批负荷同时越线后保留关键事件并优先重要观众', async () => {
    const host = new BatchCandidateHost();
    const { module, feed } = await mount({
      coalesceWindowMs: () => 0,
      audienceOnlineRankOn: () => 2,
      audienceOnlineRankOff: () => 1,
      audienceEventLineBudget: () => 2,
      audienceEventTokenBudget: () => 100,
    }, host);
    feed({ cmd: 'ONLINE_RANK_COUNT', data: { count: 2 } });
    feed({
      cmd: 'GUARD_BUY',
      data: { username: '甲', gift_name: '舰长', num: 1, guard_level: 3, uid: 41 },
    });
    feed(danmaku(41, '甲', '重要观众的弹幕'));
    feed(danmaku(42, '乙', '普通弹幕一'));
    feed(danmaku(43, '丙', '普通弹幕二'));
    await module.stop();
    host.projectBatch();

    expect(host.archivedEvents).toHaveLength(4);
    expect(host.events.map((event) => event.text)).toEqual([
      '[上舰|甲] 开通了 舰长×1',
      '[弹幕|甲] 重要观众的弹幕',
    ]);
    expect(host.events[1].meta?.audienceAdmission).toMatchObject({
      limitingActive: true,
      lane: 'important',
      importantParticipants: [{ senderKey: '41', uname: '甲', reasons: ['guard'] }],
    });
  });

  it('人流读数不成事件:布置一条待成文的,发车刻才渲染,而且只布置一条', async () => {
    const { module, host, feed } = await mount();
    feed({ cmd: 'INTERACT_WORD_V2', data: {} });
    feed({ cmd: 'INTERACT_WORD_V2', data: {} });
    feed({ cmd: 'WATCHED_CHANGE', data: { num: 288429 } });
    feed({ cmd: 'LIKE_INFO_V3_CLICK', data: {} });

    expect(host.events).toHaveLength(0); // 一条都不叫醒她
    expect(host.deferred).toHaveLength(1);
    expect(host.deferred[0].opts?.trigger).toBe('piggyback');
    expect(host.deferred[0].spec.type).toBe('bilibili.audience');

    // 发车刻渲染:带的是这一刻的读数
    const line = await host.deferred[0].spec.render();
    expect(line).toBe('[直播间] 刚才 2 人进场、1 次点赞;看过 288429');

    // 渲染完清空:再渲染一次什么都没有,整条蒸发
    expect(await host.deferred[0].spec.render()).toBeNull();

    // 清空后新来的读数会重新布置一条
    feed({ cmd: 'INTERACT_WORD_V2', data: {} });
    expect(host.deferred).toHaveLength(2);
    await module.stop();
  });

  it('挂单被丢掉没渲染:陈旧窗口一过就能重挂,不会永久哑掉', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T15:37:00+08:00'));
    const { module, host, feed } = await mount();

    feed({ cmd: 'INTERACT_WORD_V2', data: {} });
    expect(host.deferred).toHaveLength(1);

    // WebUI「清空待投递」把挂单抽走了,render 一次都没跑 —— 复位点随之消失
    host.deferred.length = 0;

    // 窗口内不重挂:安静期不该堆一叠陈旧观察
    vi.setSystemTime(Date.now() + 299_000);
    feed({ cmd: 'INTERACT_WORD_V2', data: {} });
    expect(host.deferred).toHaveLength(0);

    // 过了陈旧窗口视为失踪,允许重挂 —— 这一条在布尔闩版本里永远拿不到
    vi.setSystemTime(Date.now() + 2_000);
    feed({ cmd: 'WATCHED_CHANGE', data: { num: 288429 } });
    expect(host.deferred).toHaveLength(1);
    expect(host.deferred[0].spec.type).toBe('bilibili.audience');

    // 丢单期间攒下的读数一条没丢,发车刻一并带出去
    expect(await host.deferred[0].spec.render()).toBe('[直播间] 刚才 2 人进场;看过 288429');
    await module.stop();
  });

  it('久等没发车而重挂出的双份:发车刻只出一条,余下的蒸发', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T15:37:00+08:00'));
    const { module, host, feed } = await mount();

    feed({ cmd: 'INTERACT_WORD_V2', data: {} });
    vi.setSystemTime(Date.now() + 301_000); // 一直没发车,窗口到期
    feed({ cmd: 'INTERACT_WORD_V2', data: {} });
    expect(host.deferred).toHaveLength(2);

    // 第一条把攒下的读数整个带走,第二条渲染出空正文 → 整条蒸发
    expect(await host.deferred[0].spec.render()).toBe('[直播间] 刚才 2 人进场');
    expect(await host.deferred[1].spec.render()).toBeNull();
    await module.stop();
  });

  it('渲染过后立刻能重挂,不必等陈旧窗口', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T15:37:00+08:00'));
    const { module, host, feed } = await mount();

    feed({ cmd: 'INTERACT_WORD_V2', data: {} });
    await host.deferred[0].spec.render();

    feed({ cmd: 'INTERACT_WORD_V2', data: {} });
    expect(host.deferred).toHaveLength(2);
    await module.stop();
  });

  it('最近一窗弹幕全无 uid 时,WebUI 把脱敏标出来', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount();
    feed(danmaku(42, '阿明', '有身份'));
    expect(badge(module, '身份')).toBe('可认人');
    for (let i = 0; i < 20; i++) feed(danmaku(0, '老***', `第 ${i} 条`));
    expect(badge(module, '身份')).toContain('缺少观众 uid');
    await vi.advanceTimersByTimeAsync(300);
    expect(host.events).toHaveLength(21);
    await module.stop();
  });

  it('配了 sessdata 却拿到匿名登录态时报 error，并把「当前为匿名」写进面板状态', async () => {
    const host = new FakeHost();
    const anonymous: LiveStatus = { ...STATUS, selfUid: 0 };
    const module = new BilibiliWorld({
      roomId: 6,
      sessdata: 'SESSDATA-已过期',
      source: () => ({
        start: async () => {},
        stop: async () => {},
        current: () => anonymous,
      }),
    });
    await module.start(host);

    const errors = host.logs.filter((entry) => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toContain('匿名');
    expect(errors[0].msg).toContain('sessdata');
    await module.stop();
  });

  it('服务端认得登录态时不报匿名告警', async () => {
    const host = new FakeHost();
    const module = new BilibiliWorld({
      roomId: 6,
      sessdata: 'SESSDATA-有效',
      source: () => ({
        start: async () => {},
        stop: async () => {},
        current: () => STATUS,
      }),
    });
    await module.start(host);
    expect(host.logs.filter((entry) => entry.level === 'error')).toHaveLength(0);
    await module.stop();
  });

  it('归并折叠按分钟汇总落一条日志，收尾时把不满一分钟的那段也落下来', async () => {
    vi.useFakeTimers();
    const { module, host, feed } = await mount();
    feed(danmaku(41, '甲', '复读'));
    feed(danmaku(41, '甲', '复读'));
    await vi.advanceTimersByTimeAsync(300);
    // 一分钟没到,先不落。
    expect(host.logs.filter((entry) => entry.msg === '直播间归并折叠')).toHaveLength(0);

    await module.stop();
    const folds = host.logs.filter((entry) => entry.msg === '直播间归并折叠');
    expect(folds).toHaveLength(1);
    expect(folds[0].data).toMatchObject({ folds: 1, sourceItems: 2 });
  });

  it('准入筛除逐批落一条 warn，报清筛掉几条', async () => {
    const host = new BatchCandidateHost();
    const { module, feed } = await mount({
      coalesceWindowMs: () => 0,
      audienceOnlineRankOn: () => 2,
      audienceOnlineRankOff: () => 1,
      audienceEventLineBudget: () => 1,
      audienceEventTokenBudget: () => 20,
    }, host);
    feed({ cmd: 'ONLINE_RANK_COUNT', data: { count: 5 } });
    feed(danmaku(41, '甲', '普通弹幕一'));
    feed(danmaku(42, '乙', '普通弹幕二'));
    feed(danmaku(43, '丙', '普通弹幕三'));
    // 投影发生在发车刻,World 那时还挂着——所以不能先 stop 再 projectBatch。
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.projectBatch();
    await module.stop();

    const drops = host.logs.filter((entry) => entry.msg === '直播间准入筛除');
    expect(drops).toHaveLength(1);
    expect(drops[0].level).toBe('warn');
    expect(drops[0].data).toMatchObject({ candidates: 3, limitingActive: true });
    expect((drops[0].data as { dropped: number }).dropped).toBeGreaterThan(0);
  });

  it('WebUI 面板给最近事件与 cmd 计数(没见过的 cmd 也在)', async () => {
    const { module, feed } = await mount();
    feed(danmaku(42, '阿明', '你好'));
    feed({ cmd: 'SOME_NEW_CMD_2030', data: {} });
    const decl = module.webUi();
    const state = (await decl.invoke?.('log', 'state', [])) as {
      recent: string[];
      counts: Array<[string, number]>;
      status: LiveStatus;
    };
    expect(state.recent[0]).toBe('[弹幕|阿明] 你好');
    expect(Object.fromEntries(state.counts)).toMatchObject({ DANMU_MSG: 1, SOME_NEW_CMD_2030: 1 });
    expect(state.status.realRoomId).toBe(7734200);
    await module.stop();
  });

  it('Overlay 编辑 API 经 onOverlayConfig 持久化，保存后状态立即生效', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bilibili-module-overlay-'));
    let persisted = cloneOverlayConfig();
    persisted.enabled = true;
    persisted.port = 0;
    const module = new BilibiliWorld({
      roomId: 0,
      overlay: persisted,
      overlayAssetDir: join(root, 'assets'),
      onOverlayConfig: (next) => { persisted = next; },
    });
    await module.start(new FakeHost());
    try {
      const links = module.webUi().links ?? [];
      const editorLink = links.find((link) => link.label.includes('编辑器'));
      const editorUrl = editorLink?.href;
      expect(editorLink?.inheritTheme).toBe(true);
      expect(links.find((link) => link.label.includes('OBS'))?.inheritTheme).toBeUndefined();
      expect(editorUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/editor\?lang=zh$/);
      const baseUrl = new URL(editorUrl!).origin;
      const state = await (await fetch(`${baseUrl}/api/editor/state`)).json() as {
        design: typeof persisted.design;
        designRevision: number;
        agentAnnouncement: { text: string; revision: number };
      };
      const design = structuredClone(state.design);
      design.canvas.width = 2560;
      const response = await fetch(`${baseUrl}/api/editor/design`, {
        method: 'PUT',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ design, baseRevision: state.designRevision }),
      });
      expect(response.status).toBe(200);
      const saved = await response.json() as { design: typeof design; designRevision: number; message: string };
      expect(saved.design.canvas.width).toBe(2560);
      expect(saved.designRevision).toBe(state.designRevision + 1);
      expect(saved.message).toContain('已保存');
      expect(persisted.design.canvas.width).toBe(2560);

      const staleDesign = structuredClone(state.design);
      staleDesign.canvas.width = 1440;
      const stale = await fetch(`${baseUrl}/api/editor/design`, {
        method: 'PUT',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ design: staleDesign, baseRevision: state.designRevision }),
      });
      expect(stale.status).toBe(409);
      expect(persisted.design.canvas.width).toBe(2560);

      const firstAnnouncement = await fetch(`${baseUrl}/api/editor/announcement`, {
        method: 'PUT',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '第一版公告', expectedRevision: state.agentAnnouncement.revision }),
      });
      expect(firstAnnouncement.status).toBe(200);
      expect(await firstAnnouncement.json()).toMatchObject({ text: '第一版公告', revision: 1 });
      const staleAnnouncement = await fetch(`${baseUrl}/api/editor/announcement`, {
        method: 'PUT',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '陈旧公告', expectedRevision: state.agentAnnouncement.revision }),
      });
      expect(staleAnnouncement.status).toBe(409);
      expect(await (await fetch(`${baseUrl}/api/editor/state`)).json()).toMatchObject({
        agentAnnouncement: { text: '第一版公告', revision: 1 },
      });

      const broken = structuredClone(saved.design);
      broken.styles.push({
        id: 'broken', name: '坏素材', background: '#000000ff', borderColor: '#000000ff', borderWidth: 0,
        radius: 0, padding: 0,
        username: { fontFamily: '', fontSize: 20, fontWeight: 400, color: '#ffffffff', strokeColor: '#000000ff', strokeWidth: 0 },
        body: { fontFamily: '', fontSize: 20, fontWeight: 400, color: '#ffffffff', strokeColor: '#000000ff', strokeWidth: 0 },
        nineSlice: {
          assetId: 'missing.png',
          slice: { top: 1, right: 1, bottom: 1, left: 1 },
          width: { top: 1, right: 1, bottom: 1, left: 1 },
          fill: true,
          repeat: 'stretch',
        },
      });
      const rejected = await fetch(`${baseUrl}/api/editor/design`, {
        method: 'PUT',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ design: broken, baseRevision: saved.designRevision }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('素材不存在') });
    } finally {
      await module.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Overlay 保存在途时素材删除排队，不会留下悬空引用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bilibili-module-overlay-race-'));
    let persisted = cloneOverlayConfig();
    persisted.enabled = true;
    persisted.port = 0;
    let persistenceEntered!: () => void;
    const entered = new Promise<void>((resolve) => { persistenceEntered = resolve; });
    let releasePersistence!: () => void;
    const release = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const module = new BilibiliWorld({
      roomId: 0,
      overlay: persisted,
      overlayAssetDir: join(root, 'assets'),
      onOverlayConfig: async (next) => {
        persistenceEntered();
        await release;
        persisted = next;
      },
    });
    await module.start(new FakeHost());
    try {
      const editorUrl = module.webUi().links?.find((link) => link.label.includes('编辑器'))?.href;
      const baseUrl = new URL(editorUrl!).origin;
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64');
      const upload = await fetch(`${baseUrl}/api/editor/assets`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64: png }),
      });
      expect(upload.status).toBe(200);
      const asset = await upload.json() as { asset: { id: string } };
      const state = await (await fetch(`${baseUrl}/api/editor/state`)).json() as {
        design: typeof persisted.design;
        designRevision: number;
      };
      const design = structuredClone(state.design);
      design.styles.push({
        id: 'referenced-nine',
        name: '正在保存的九宫格',
        background: '#00000000',
        borderColor: '#00000000',
        borderWidth: 0,
        radius: 0,
        padding: 8,
        username: { fontFamily: 'sans-serif', fontSize: 20, fontWeight: 700, color: '#ffffffff', strokeColor: '#000000ff', strokeWidth: 0 },
        body: { fontFamily: 'sans-serif', fontSize: 20, fontWeight: 400, color: '#ffffffff', strokeColor: '#000000ff', strokeWidth: 0 },
        nineSlice: {
          assetId: asset.asset.id,
          slice: { top: 1, right: 1, bottom: 1, left: 1 },
          width: { top: 8, right: 8, bottom: 8, left: 8 },
          fill: true,
          repeat: 'stretch',
        },
      });

      const saving = fetch(`${baseUrl}/api/editor/design`, {
        method: 'PUT',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ design, baseRevision: state.designRevision }),
      });
      await entered;
      const deleting = fetch(`${baseUrl}/api/editor/assets/${encodeURIComponent(asset.asset.id)}`, {
        method: 'DELETE',
        headers: { Origin: baseUrl },
      });
      const early = await Promise.race([
        deleting.then(() => 'settled' as const),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      expect(early).toBe('pending');

      releasePersistence();
      const saved = await saving;
      expect(saved.status).toBe(200);
      const deleted = await deleting;
      expect(deleted.status).toBe(400);
      expect(await deleted.json()).toMatchObject({ error: expect.stringContaining('仍被样式') });
      expect((await fetch(`${baseUrl}/assets/${asset.asset.id}`)).status).toBe(200);
      expect(persisted.design.styles).toContainEqual(expect.objectContaining({
        id: 'referenced-nine',
        nineSlice: expect.objectContaining({ assetId: asset.asset.id }),
      }));
    } finally {
      releasePersistence();
      await module.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('total 数的是记过的总条数,被上限挤掉的也算在内', async () => {
    const { module, feed } = await mount();
    const state = async (): Promise<{ recent: string[]; total: number }> =>
      (await module.webUi().invoke!('log', 'state', [])) as { recent: string[]; total: number };

    for (let i = 0; i < 250; i++) feed(danmaku(42, '阿明', `第 ${i} 条`));
    const st = await state();
    // WebUI 按 total 的差值补新行,所以它不能跟着 recent 一起被上限截住
    expect(st.total).toBe(250);
    expect(st.recent).toHaveLength(200);
    expect(st.recent[0]).toBe('[弹幕|阿明] 第 249 条');

    feed(danmaku(42, '阿明', '再一条'));
    expect((await state()).total).toBe(251);
    await module.stop();
  });

  it('一次上舰只进一条:GUARD_BUY 先到即发,窗内同 uid 的 TOAST 双双吞掉', async () => {
    const { module, host, feed } = await mount();
    feed({
      cmd: 'GUARD_BUY',
      data: { username: '甲', gift_name: '舰长', num: 1, guard_level: 3, uid: 41, price: 138000 },
    });
    feed({
      cmd: 'USER_TOAST_MSG',
      data: { uid: 41, username: '甲', role_name: '舰长', guard_level: 3, toast_msg: '甲 开通了舰长' },
    });
    feed({ cmd: 'USER_TOAST_MSG_V2', data: { sender_uinfo: { uid: 41, base: { name: '甲' } } } });
    // 窗外另一位观众独立到达的 TOAST 不受影响
    feed({
      cmd: 'USER_TOAST_MSG',
      data: { uid: 77, username: '乙', role_name: '提督', guard_level: 2, toast_msg: '乙 自动续费了提督' },
    });
    await module.stop();

    expect(host.events.map((event) => event.text)).toEqual([
      '[上舰 ¥138|甲] 开通了 舰长×1',
      '[续费|乙] 续费了 提督',
    ]);
    expect(host.logs.filter((log) => log.msg.includes('已过滤重复的大航海 TOAST'))).toHaveLength(2);
  });

  it('原始帧采样:名单内 cmd 与首见礼物名原样落盘,普通弹幕绝不采', async () => {
    const { readFileSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'bilibili-raw-samples-'));
    const file = join(root, 'bilibili-raw-samples.jsonl');
    try {
      const { module, feed } = await mount({ rawSampleFile: file });
      feed({
        cmd: 'GUARD_BUY',
        data: { username: '甲', gift_name: '舰长', num: 1, guard_level: 3, uid: 41, price: 138000 },
      });
      feed(danmaku(42, '阿明', '这条不许采'));
      const gift = {
        cmd: 'SEND_GIFT',
        data: { uname: '乙', giftName: '干杯之旅', num: 1, coin_type: 'gold', total_coin: 10000, uid: 7 },
      };
      feed(gift);
      feed(gift); // 同名第二次不再采
      await module.stop();

      const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.map((line) => line.cmd)).toEqual(['GUARD_BUY', 'SEND_GIFT']);
      // 原样落盘:字段一个不裁,后续「照着猜字段」的修复以它为回归依据
      expect(lines[0].msg.data.price).toBe(138000);
      expect(lines[1].msg.data.giftName).toBe('干杯之旅');
      expect(lines.every((line) => typeof line.ts === 'string')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('原始帧采样:V2 的礼物名按解过 pb 的形状去重,读不出名字的封顶留样', async () => {
    const { readFileSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'bilibili-raw-samples-v2-'));
    const file = join(root, 'bilibili-raw-samples.jsonl');
    try {
      const { module, feed } = await mount({ rawSampleFile: file });
      const frame = { cmd: 'SEND_GIFT_V2', data: { dmscore: 1, pb: PB_SMALL } };
      feed(frame);
      feed(frame); // 名字读得出且已见过:不再采。照旧读 data.giftName 的话这里会条条留样
      for (let i = 0; i < 20; i += 1) feed({ cmd: 'SEND_GIFT_V2', data: { pb: '解不动' } });
      await module.stop();

      const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(1 + 16); // 首见的粉丝团灯牌 + 读不出名字的 16 帧封顶
      expect(lines[0].msg.data.pb).toBe(PB_SMALL); // 原样落盘,不做任何字段裁剪
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stop 之后不再推事件', async () => {
    const { module, host, feed } = await mount();
    await module.stop();
    feed(danmaku(42, '阿明', '还在吗'));
    expect(host.events).toHaveLength(0);
  });

  // 空串和纯空白拒绝执行，公告板内容不变。
  describe('公告板空串拒绝', () => {
    const toolCtx = { role: 'main', log: nullLogger() };

    it('空串被拒绝执行:公告板保持原样,回执否定形并点名入参,warn 告警口径保留', async () => {
      const { module, host } = await mount();
      const tool = module.tools()[0];
      await tool.handler({ text: '今晚八点开播' }, toolCtx);
      const receipt = await tool.handler({ text: '' }, toolCtx);

      expect(String(receipt)).toContain('[not executed]');
      expect(String(receipt)).toContain('text');
      expect(String(receipt)).not.toContain('cleared');
      // 公告板一字不动
      expect(module.envPromptVars()['bilibili.agentAnnouncement']).toBe('今晚八点开播');
      // 告警口径保留:runlog 里数得出来
      expect(host.logs.some((log) => log.level === 'warn' && log.msg.includes('拒绝空白 text'))).toBe(true);
      await module.stop();
    });

    it('纯空白同样被拒绝,原公告不受影响', async () => {
      const { module } = await mount();
      const tool = module.tools()[0];
      await tool.handler({ text: '固定公告' }, toolCtx);
      const receipt = await tool.handler({ text: '   \n\t' }, toolCtx);
      expect(String(receipt)).toContain('[not executed]');
      expect(module.envPromptVars()['bilibili.agentAnnouncement']).toBe('固定公告');
      await module.stop();
    });
  });

  describe('直播状态沿:转沿成文与双源去重', () => {
    it('轮询状态变为下播时投递事件并记录 error', async () => {
      const { module, host, setStatus } = await mount();
      setStatus({ ...STATUS, living: false });
      await module.stop();

      const room = host.events.filter((e) => e.type === 'bilibili.room');
      expect(room).toHaveLength(1);
      expect(room[0].text).toContain('平台确认已下播');
      expect(room[0].text).toContain('live_status=0');
      expect(room[0].text).toContain('看不到直播画面');
      // 留场弹幕的反向证据要提前说破
      expect(room[0].text).toContain('不代表直播还在');

      const errors = host.logs.filter((log) => log.level === 'error');
      expect(errors).toHaveLength(1);

      expect(errors[0].msg).toContain('直播间未开播');

    });

    it('关播后轮询读到 living false→true:成文再开播事件,不再是 error', async () => {
      const { module, host, setStatus } = await mount();
      setStatus({ ...STATUS, living: false });
      // 让去重窗过期,模拟真实的隔窗再开播
      const edge = (module as unknown as { lastRoomEdge: { living: boolean; at: number } | null }).lastRoomEdge;
      if (edge) edge.at -= 200_000;
      setStatus({ ...STATUS, living: true });
      await module.stop();

      const room = host.events.filter((e) => e.type === 'bilibili.room');
      expect(room.map((e) => e.text)).toEqual([
        expect.stringContaining('平台确认已下播'),
        expect.stringContaining('平台确认已开播'),
      ]);
      expect(host.logs.filter((log) => log.level === 'error')).toHaveLength(1);
      expect(host.logs.some((log) => log.level === 'warn' && log.msg.includes('已开播'))).toBe(true);
    });

    it('WS PREPARING 先到:轮询随后的同状态沿在短窗内不双报', async () => {
      const { module, host, feed, setStatus } = await mount();
      feed({ cmd: 'PREPARING' });
      setStatus({ ...STATUS, living: false });
      await module.stop();

      const room = host.events.filter((e) => e.type === 'bilibili.room');
      expect(room).toHaveLength(1);

      expect(room[0].text).toContain('平台已推送下播指令');
      expect(room[0].text).toContain('不代表直播还在');

      expect(host.logs.filter((log) => log.level === 'error' && log.msg.includes('直播间未开播'))).toHaveLength(1);
    });

    it('轮询先发现:WS 迟到的 PREPARING 在短窗内同样被吞', async () => {
      const { module, host, feed, setStatus } = await mount();
      setStatus({ ...STATUS, living: false });
      feed({ cmd: 'PREPARING' });
      await module.stop();

      const room = host.events.filter((e) => e.type === 'bilibili.room');
      expect(room).toHaveLength(1);
      expect(room[0].text).toContain('平台确认已下播');
      expect(host.logs.filter((log) => log.level === 'error')).toHaveLength(1);

      expect(host.logs.some((log) => log.msg.includes('已过滤重复的直播状态通知'))).toBe(true);
    });

    it('首个状态观察只定基线:开播中启动不冒充"刚开播"', async () => {
      const { module, host } = await mount();
      await module.stop();
      expect(host.events.filter((e) => e.type === 'bilibili.room')).toHaveLength(0);
      expect(host.logs.filter((log) => log.level === 'error')).toHaveLength(0);
    });

    it('living 未变的状态刷新(如轮询补 liveStartedAt)不成文', async () => {
      const { module, host, setStatus } = await mount();
      setStatus({ ...STATUS, liveStartedAt: Date.now() });
      setStatus({ ...STATUS, title: '换了标题' });
      await module.stop();
      expect(host.events.filter((e) => e.type === 'bilibili.room')).toHaveLength(0);
    });
  });

  // phase 离开 connected 超过 60 秒才成文一次、告警并亮红灯；恢复事件带中断时长，60 秒内抖动不推送。
  describe('弹幕接入中断成文', () => {
    const feedEvents = (host: FakeHost) => host.events.filter((e) => e.type === 'bilibili.feed');
    const lamp = (module: BilibiliWorld) => module.webUi().lamps?.find((l) => l.label === '接入');

    it('中断超过 60 秒成文一次(flush)+ warn + 灯转红;往复重连不重复推;恢复补一条带中断时长', async () => {
      vi.useFakeTimers();
      const { module, host, setStatus } = await mount();
      setStatus({ ...STATUS, phase: 'retrying', lastError: '长连断开' });
      setStatus({ ...STATUS, phase: 'connecting', lastError: null });
      expect(lamp(module)?.state).toBe('loading');

      await vi.advanceTimersByTimeAsync(59_000);
      expect(feedEvents(host)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(feedEvents(host)).toHaveLength(1);
      expect(feedEvents(host)[0].text).toMatch(/^\[直播间\] 弹幕接入中断 \d+ 秒,重连中,这段的弹幕收不到$/);
      expect(host.pushOpts[host.events.indexOf(feedEvents(host)[0])]?.trigger).toBe('flush');
      const warns = host.logs.filter((log) => log.level === 'warn' && log.msg.includes('弹幕接入中断'));
      expect(warns).toHaveLength(1);
      expect(warns[0].data).toMatchObject({ outageSec: 60, phase: 'connecting' });
      expect(lamp(module)).toMatchObject({ state: 'error', hint: expect.stringContaining('弹幕接入中断') });
      // WebUI 面板也收到这一条
      const state = await module.webUi().invoke?.('log', 'state', []) as { recent: string[] };
      expect(state.recent[0]).toContain('弹幕接入中断');

      // 继续在 connecting/retrying 之间往复,再等多久都只有那一条
      setStatus({ ...STATUS, phase: 'retrying', lastError: '重连看门狗:握手/重连 100 秒无结果' });
      setStatus({ ...STATUS, phase: 'connecting', lastError: null });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(feedEvents(host)).toHaveLength(1);

      setStatus({ ...STATUS, phase: 'connected' });
      expect(feedEvents(host)).toHaveLength(2);
      expect(feedEvents(host)[1].text).toBe('[直播间] 弹幕接入已恢复,中断 181 秒');
      expect(host.pushOpts[host.events.indexOf(feedEvents(host)[1])]?.trigger).toBe('debounce');
      expect(host.logs.some((log) => log.level === 'warn' && log.msg.includes('弹幕接入已恢复'))).toBe(true);
      expect(lamp(module)?.state).toBe('online');
      await module.stop();
    });

    it('60 秒内的抖动不成文,恢复也不补恢复事件', async () => {
      vi.useFakeTimers();
      const { module, host, setStatus } = await mount();
      setStatus({ ...STATUS, phase: 'retrying', lastError: '长连断开' });
      await vi.advanceTimersByTimeAsync(30_000);
      setStatus({ ...STATUS, phase: 'connected' });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(feedEvents(host)).toHaveLength(0);
      expect(host.logs.some((log) => log.msg.includes('弹幕接入'))).toBe(false);
      expect(lamp(module)?.state).toBe('online');
      await module.stop();
    });

    it('stop 撤掉中断计时器,停机后不再成文', async () => {
      vi.useFakeTimers();
      const { module, host, setStatus } = await mount();
      setStatus({ ...STATUS, phase: 'retrying', lastError: '长连断开' });
      await module.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(feedEvents(host)).toHaveLength(0);
    });
  });
});

function badge(module: BilibiliWorld, label: string): string {
  const found = module.webUi().badges?.find((b) => b.label === label);
  return String(found?.value ?? '');
}
